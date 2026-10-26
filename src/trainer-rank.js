// Shared by the Trainer page and the server. Rank 1 is the best candidate.

/** Assign the next free rank, or remove an assigned rank and close the gap. */
export function toggleRank(ranks, candidateId, size = 3) {
  const next = { ...ranks };
  const current = next[candidateId];
  if (current) {
    delete next[candidateId];
    for (const [key, rank] of Object.entries(next)) if (rank > current) next[key] = rank - 1;
    return next;
  }
  const used = Object.keys(next).length;
  if (used < size) next[candidateId] = used + 1;
  return next;
}

/** True only when every candidate has exactly one distinct rank from 1 to the group size. */
export function completeRanking(ranks, candidateIds) {
  if (!ranks || typeof ranks !== "object" || Array.isArray(ranks)) return false;
  const keys = Object.keys(ranks);
  if (keys.length !== candidateIds.length || !candidateIds.every((id) => Object.hasOwn(ranks, id))) return false;
  const values = keys.map((key) => ranks[key]);
  return values.every((rank) => Number.isInteger(rank) && rank >= 1 && rank <= candidateIds.length) &&
    new Set(values).size === values.length;
}
