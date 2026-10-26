import crypto from "node:crypto";

/** A batch identity: `batch-` and 16 hex digits. */
export const BATCH_ID = /^batch-[0-9a-f]{16}$/;

export const newBatchId = () => `batch-${crypto.randomBytes(8).toString("hex")}`;

/**
 * A batch saved before batch identities gets one from its target and send
 * time, so every server and every status read derives the same identity.
 */
export const legacyBatchId = (entryKey, sentAt) =>
  `batch-${crypto.createHash("sha256").update(`${entryKey}\0${sentAt}`).digest("hex").slice(0, 16)}`;

/**
 * One pending batch in memory: the batch with its identity, its own cleanup,
 * whether a poll collected it, and the delivered, unacked batches it carries.
 * Each carried group names the batch ids its cleanup belongs to. A record
 * saved before batch ids holds one flat `priorCleanup`: it becomes one group
 * for all its earlier batches, which only the ack of the current batch clears.
 */
export function normalizeRecord(entryKey, record) {
  if (!record || !record.batch) return null;
  const batch = record.batch;
  if (!batch.batch_id) batch.batch_id = legacyBatchId(entryKey, batch.sent_at);
  for (const earlier of batch.earlier_batches || []) {
    if (!earlier.batch_id) earlier.batch_id = legacyBatchId(entryKey, earlier.sent_at);
  }
  let carried = Array.isArray(record.carried) ? record.carried : null;
  if (!carried) {
    const legacy = record.priorCleanup || [];
    const earlierIds = (batch.earlier_batches || []).map((earlier) => earlier.batch_id);
    carried = legacy.length || earlierIds.length ? [{ batch_ids: earlierIds, cleanup: legacy }] : [];
  }
  return { batch, cleanup: record.cleanup || [], delivered: !!record.delivered, carried };
}

export const carriedIds = (record) => record.carried.flatMap((group) => group.batch_ids);
