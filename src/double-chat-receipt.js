import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";

export const RECEIPT_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, entries: 4096, lineBytes: 256 * 1024 });
const CHUNK_BYTES = 64 * 1024;
export class ReceiptLimitError extends Error {}

// Refuse large live values before JSON.stringify can allocate their full encoding.
// Pi's JSON serialization omits undefined properties; direct object equality does not.
function serialized(entry) {
  let budget = RECEIPT_LIMITS.lineBytes * 16;
  const text = JSON.stringify(entry, (key, value) => {
    if (key.length > RECEIPT_LIMITS.lineBytes || (typeof value === "string" && value.length > RECEIPT_LIMITS.lineBytes)) {
      throw new ReceiptLimitError("Live session entry exceeds receipt limits.");
    }
    budget -= key.length + (typeof value === "string" ? value.length : 16);
    if (budget < 0) throw new ReceiptLimitError("Live session entry exceeds receipt limits.");
    return value;
  });
  if (Buffer.byteLength(text) > RECEIPT_LIMITS.lineBytes) throw new ReceiptLimitError("Session entry exceeds receipt limits.");
  return JSON.parse(text);
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const version = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");

/** Read only the explicit file. Never invoke Pi's repairing/migrating loader. */
export async function readReceipt(record, branch, receiptIndex, { signal, check, io = { stat, createReadStream } }) {
  let stream;
  try {
    check();
    const before = await abortable(io.stat(record.origin.sessionFile, { bigint: true }), signal);
    check();
    if (!before.isFile()) return false;
    if (before.size > RECEIPT_LIMITS.bytes) throw new ReceiptLimitError("Session exceeds receipt byte limit.");
    const signature = version(before);
    const leaf = branch.at(-1)?.id;
    if (record.missingEvidence?.version === signature && record.missingEvidence.leaf === leaf) return false;
    // Cache only negative evidence, including malformed/partial files. Success clears it.
    record.missingEvidence = { version: signature, leaf };

    // The inclusive end bounds even a file that grows after stat to cap + 1 bytes.
    stream = io.createReadStream(record.origin.sessionFile, {
      flags: "r", highWaterMark: CHUNK_BYTES, start: 0, end: RECEIPT_LIMITS.bytes, signal,
    });
    let pending = Buffer.alloc(0), bytes = 0, header;
    const entries = new Map();
    for await (const chunk of stream) {
      check();
      bytes += chunk.length;
      if (bytes > RECEIPT_LIMITS.bytes) throw new ReceiptLimitError("Session exceeds receipt byte limit.");
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        if (end - start > RECEIPT_LIMITS.lineBytes) throw new ReceiptLimitError("Session exceeds receipt line limit.");
        const entry = JSON.parse(data.toString("utf8", start, end));
        start = end + 1;
        if (!header) {
          if (entry?.type !== "session" || entry.version !== 3 || entry.id !== record.origin.sessionId) return false;
          header = entry;
        } else {
          if (entries.size >= RECEIPT_LIMITS.entries) throw new ReceiptLimitError("Session exceeds receipt entry limit.");
          if (!entry || typeof entry.id !== "string" || entries.has(entry.id)) return false;
          entries.set(entry.id, entry);
        }
      }
      pending = data.subarray(start);
      if (pending.length > RECEIPT_LIMITS.lineBytes) throw new ReceiptLimitError("Session exceeds receipt line limit.");
      await yieldTurn(undefined, { signal });
      check();
    }
    check();
    const after = await abortable(io.stat(record.origin.sessionFile, { bigint: true }), signal);
    check();
    if (after.size > RECEIPT_LIMITS.bytes) throw new ReceiptLimitError("Session exceeds receipt byte limit.");
    if (!after.isFile() || version(after) !== signature) return false;
    if (!header || pending.length || bytes !== Number(before.size)) return false;
    let parentId = null;
    for (let i = 0; i <= receiptIndex; i++) {
      const entry = branch[i];
      if (entry.parentId !== parentId || !isDeepStrictEqual(entries.get(entry.id), serialized(entry))) return false;
      parentId = entry.id;
      await yieldTurn(undefined, { signal });
      check();
    }
    record.missingEvidence = undefined;
    return true;
  } finally {
    if (stream) {
      stream.destroy();
      await finished(stream, { cleanup: true }).catch(() => {});
    }
  }
}
