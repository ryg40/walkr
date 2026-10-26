import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { readReceipt, RECEIPT_LIMITS, ReceiptLimitError } from "./double-chat-receipt.js";

const scanners = new WeakMap();

// Shared by one-shot and iterative delivery. No in-memory success authorizes ack.
export function createReceiptVerifier({ runtime, live, deliveryTimeoutMs = 30000, acceptanceCheckMs = 100, receiptIO }) {
  let scanner = scanners.get(runtime);
  if (!scanner) scanners.set(runtime, scanner = { busy: false });
  function receiptWork(record) {
    return { deadline: Date.now() + deliveryTimeoutMs,
      signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(deliveryTimeoutMs)]) };
  }
  function checkWork(record, work, leaf) {
    if (!live(record) || work.signal.aborted || Date.now() >= work.deadline ||
        (leaf !== undefined && record.ctx.sessionManager.getLeafId() !== leaf)) throw new Error("Receipt check expired or changed.");
  }
  function branchFor(record) {
    const manager = record.ctx.sessionManager;
    const branch = [], seen = new Set();
    let id = manager.getLeafId();
    while (id !== null) {
      if (branch.length >= RECEIPT_LIMITS.entries) throw new ReceiptLimitError("Session branch exceeds receipt entry limit.");
      if (seen.has(id)) throw new Error("Invalid session branch.");
      seen.add(id);
      const entry = manager.getEntry(id);
      if (!entry || entry.id !== id) throw new Error("Missing session ancestor.");
      branch.push(entry);
      id = entry.parentId;
    }
    return branch.reverse();
  }
  function receiptIndex(record, branch) {
    const expected = record.message;
    return branch.findIndex((entry) => entry.type === "custom_message" &&
      entry.customType === expected.customType && entry.content === expected.content && isDeepStrictEqual(entry.details, expected.details));
  }
  async function accepted(record, work) {
    // One scanner per runtime, including cancelled operations and different comparisons.
    if (scanner.busy) return false;
    scanner.busy = true;
    try {
      checkWork(record, work);
      const branch = branchFor(record), leaf = record.ctx.sessionManager.getLeafId();
      const index = receiptIndex(record, branch);
      if (index < 0) return false;
      const check = () => checkWork(record, work, leaf);
      const found = await readReceipt(record, branch, index, { signal: work.signal, check, io: receiptIO });
      check();
      return found ? { leaf } : false;
    } catch (error) {
      if (error instanceof ReceiptLimitError) record.receiptLimit = true;
      return false; // Missing, partial, changed, or unsupported evidence never authorizes ack.
    } finally {
      scanner.busy = false;
    }
  }
  async function confirmReceipt(record, work) {
    while (live(record) && !work.signal.aborted && Date.now() < work.deadline) {
      const proof = await accepted(record, work);
      try { checkWork(record, work, proof ? proof.leaf : undefined); } catch { return false; }
      if (proof) return proof;
      if (record.receiptLimit) break;
      await delay(acceptanceCheckMs, undefined, { signal: work.signal }).catch(() => {});
    }
    return false;
  }
  return { receiptWork, checkWork, branchFor, receiptIndex, confirmReceipt };
}
