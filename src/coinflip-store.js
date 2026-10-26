import { isDeepStrictEqual as equal } from "node:util";
import { DoubleArchive, hash, fail, id, capture, requireShape, contains, absolute } from "./double-archive.js";
import { validateDoubleInput } from "./double-input.js";
import { checkedCopies } from "./double-copies.js";
import { steerProblem } from "./steer-limits.js";

// Coinflip terms: a candidate is one whole standalone component; the winner is the
// candidate the owner explicitly chose. Neither is a Double keeper or composition.
const SIDES = ["left", "right"];
const clone = structuredClone;
const identity = (kind, ...parts) => `${kind}-${hash(JSON.stringify(parts))}`;
const time = () => new Date().toISOString();
const validTime = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s));
// The checked entry and file bytes of one candidate, for an exact-repeat check only.
const fingerprint = (entry, files) => [entry, ...files.map((f) => `${f.path}\0${f.sha256}`).sort()].join("\n");
const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
export const COINFLIP_RECORD = (sessionId) => `coinflip-session-${hash(sessionId)}.json`;
export const CHALLENGER_INSTRUCTION = "Take a new design direction relative to the rejected candidate. Change at least one major design choice " +
  "(layout, structure, visual language, or interaction pattern), not only minor styling. Keep addressing the original brief and every saved note. " +
  "Record the intended difference. The retained winner stays byte-identical on its side; only the rejected side is replaced. " +
  "Validation proves the static input subset and the unchanged winner, not aesthetic contrast.";
// Appended only when the record has instructions, so earlier events keep their exact text.
export const STEERS_STILL_APPLY = " Every saved prompt-box instruction in payload.steers still applies.";
export const STEER_CHALLENGER_INSTRUCTION = "The owner sent a new instruction from the prompt box. Keep the retained winner byte-identical on its side. " +
  "Replace only the displayed challenger on payload.replaceSide with one new candidate that follows payload.steer.text, the original brief, and every saved note and instruction. " +
  "The replaced challenger was not rejected by a choice; it is history. Record the intended difference. Validation proves the unchanged winner, not aesthetic contrast.";
export const STEER_PAIR_INSTRUCTION = "The owner sent a new instruction from the prompt box before choosing any winner. Prepare two new distinct candidates, one per side, " +
  "that follow payload.steer.text, the original brief, and every saved instruction. The replaced pair stays in history. No winner or rejection exists; do not infer one.";

function initialDoc(input, at) {
  const doc = { schemaVersion: 1, mode: "coinflip", sessionId: input.sessionId, brief: input.brief, createdAt: at,
    gui: { origin: input.origin, initialActionId: input.initialActionId }, revision: 0, status: "generating",
    candidates: [], pairs: [], choices: [], requests: [], events: [], acknowledgments: [], result: null, final: null, receipts: [] };
  const request = { id: identity("request", input.sessionId, input.initialActionId), kind: "initial", choiceIndex: null,
    attempts: [{ id: identity("attempt", input.sessionId, input.initialActionId), status: "running", failure: null }] };
  doc.requests.push(request);
  generationEvent(doc, request, request.attempts[0], at);
  return doc;
}

const candidate = (doc, candidateId) => doc.candidates.find((c) => c.candidateId === candidateId);
// A private reference to archived bytes. It names the record and hashes, never a path or the bytes.
const archiveRef = (doc, c) => ({ record: COINFLIP_RECORD(doc.sessionId), sessionId: doc.sessionId, candidateId: c.candidateId,
  entry: c.entry, files: c.files.map(({ path, sha256 }) => ({ path, sha256 })) });
const summary = (doc, c) => ({ candidateId: c.candidateId, side: c.side, description: c.description,
  intendedDifference: c.intendedDifference, archiveRef: archiveRef(doc, c) });
// A steer is a prompt-box instruction. It replaces the displayed challenger, or the whole pair before any winner, without a vote.
const steerRecord = (r) => ({ index: r.steerIndex, requestId: r.id, pairIndex: r.pairIndex, text: r.instruction,
  winner: r.choiceIndex === null ? null : r.winner, replaced: clone(r.replaced) });
const steers = (doc) => doc.requests.filter((r) => r.kind === "steer").map(steerRecord);
const choiceRecord = (doc, c) => ({ index: c.index, pairIndex: c.pairIndex, note: c.note, at: c.at,
  winner: summary(doc, candidate(doc, c.winner)), rejected: summary(doc, candidate(doc, c.rejected)) });

function event(doc, kind, payload, at) {
  const value = { id: identity("event", doc.sessionId, doc.events.length), kind, sessionId: doc.sessionId, at, payload: clone(payload) };
  doc.events.push(value);
  return value.id;
}

// Every request carries the complete context; a Retry repeats it with a new attempt identity.
function generationEvent(doc, request, attempt, at) {
  const payload = { mode: "coinflip", kind: request.kind, requestId: request.id, attemptId: attempt.id, brief: doc.brief,
    choices: doc.choices.map((c) => choiceRecord(doc, c)), candidates: doc.candidates.map((c) => summary(doc, c)) };
  if (request.kind === "challenger") {
    const choice = doc.choices[request.choiceIndex];
    const winner = candidate(doc, choice.winner), rejected = candidate(doc, choice.rejected);
    payload.pairIndex = choice.pairIndex;
    payload.note = choice.note;
    payload.winner = { ...summary(doc, winner), pane: clone(winner.pane) };
    payload.rejected = summary(doc, rejected);
    payload.replaceSide = rejected.side;
    payload.instruction = CHALLENGER_INSTRUCTION + (steers(doc).length ? STEERS_STILL_APPLY : "");
  } else if (request.kind === "steer") {
    payload.pairIndex = request.pairIndex;
    payload.steer = steerRecord(request);
    payload.replaced = request.replaced.map((candidateId) => summary(doc, candidate(doc, candidateId)));
    if (request.choiceIndex !== null) {
      const winner = candidate(doc, request.winner);
      payload.winner = { ...summary(doc, winner), pane: clone(winner.pane) };
      payload.replaceSide = request.replaceSide;
      payload.instruction = STEER_CHALLENGER_INSTRUCTION;
    } else payload.instruction = STEER_PAIR_INSTRUCTION;
  } else {
    payload.instruction = "Prepare two distinct standalone candidates for the brief, one per side.";
  }
  // Records without a steer keep their earlier event shape, so their receipts replay unchanged.
  if (steers(doc).length) payload.steers = steers(doc);
  return event(doc, "generation", payload, at);
}

export function coinflipOutput(doc) {
  const winner = candidate(doc, doc.result.candidateId);
  return clone({ mode: "coinflip", sessionId: doc.sessionId, brief: doc.brief, stoppedAt: doc.result.at,
    winner: { candidateId: winner.candidateId, side: winner.side, description: winner.description,
      intendedDifference: winner.intendedDifference, entry: winner.entry, files: winner.files },
    choices: doc.choices.map((c) => choiceRecord(doc, c)),
    candidates: doc.candidates.map((c) => ({ ...summary(doc, c),
      role: c.candidateId === winner.candidateId ? "winner" : doc.choices.some((x) => x.rejected === c.candidateId) ? "rejected"
        : steers(doc).some((x) => x.replaced.includes(c.candidateId)) ? "replaced" : "unchosen" })),
    pairs: doc.pairs.map(({ index, left, right }) => ({ index, left, right })),
    ...(steers(doc).length ? { steers: steers(doc) } : {}) });
}

function view(doc) {
  const latest = doc.requests.at(-1), pair = doc.pairs.at(-1), choice = doc.choices.at(-1);
  const finalEvent = doc.final && doc.events.find((e) => e.id === doc.final.eventId);
  return clone({ mode: "coinflip", sessionId: doc.sessionId, brief: doc.brief, revision: doc.revision, status: doc.status, gui: doc.gui,
    pair: pair ? { index: pair.index, left: summary(doc, candidate(doc, pair.left)), right: summary(doc, candidate(doc, pair.right)) } : null,
    winner: choice ? { candidateId: choice.winner, side: choice.winnerSide, pairIndex: choice.pairIndex } : null,
    choices: doc.choices.map((c) => ({ index: c.index, pairIndex: c.pairIndex, winner: c.winner, rejected: c.rejected, winnerSide: c.winnerSide, note: c.note })),
    steers: steers(doc),
    pairs: doc.pairs.length,
    generation: latest ? { requestId: latest.id, kind: latest.kind, attempt: latest.attempts.at(-1) } : null,
    result: doc.result ? { candidateId: doc.result.candidateId, side: candidate(doc, doc.result.candidateId).side } : null,
    submitted: Boolean(doc.final), finalEventId: doc.final?.eventId ?? null,
    delivery: finalEvent ? (doc.acknowledgments.some((a) => a.eventId === finalEvent.id) ? "received" : "pending") : null });
}

// The choice whose winner a request keeps: a challenger's own choice, or the latest choice before a steer.
const retained = (doc, generation) => generation.kind === "challenger" ? doc.choices[generation.choiceIndex]
  : generation.kind === "steer" && generation.choiceIndex !== null ? doc.choices[generation.choiceIndex] : null;

function outstanding(doc, request) {
  id(request.requestId); id(request.attemptId);
  if (doc.status === "stopped") fail("READ_ONLY", "The session is stopped. Late work cannot add rounds or replace the result.");
  const generation = doc.requests.at(-1), attempt = generation?.attempts.at(-1);
  if (!generation || generation.id !== request.requestId || attempt.id !== request.attemptId) {
    fail("STALE_ATTEMPT", "This is not the current generation request and attempt.");
  }
  return { generation, attempt };
}

// Receipts replay the same transitions on load. Prepared candidates are the only external input.
function apply(doc, operation, request, at, prepared = null) {
  id(request?.actionId);
  if (doc.receipts.some((r) => r.request.actionId === request.actionId)) fail("ACTION_CONFLICT", "The action ID is already saved.");
  if (!Number.isSafeInteger(doc.revision + 1)) fail("READ_ONLY", "The session revision limit is reached.");
  const result = { actionId: request.actionId, kind: operation, revision: doc.revision + 1 };
  if (operation === "choose") {
    requireShape(request, ["actionId", "pairIndex", "winner", "note"]);
    const pair = doc.pairs.at(-1);
    if (doc.status !== "choosing" || !pair) fail("READ_ONLY", "Choices are disabled during generation, after failure, and after Stop.");
    if (request.pairIndex !== pair.index) fail("STALE_COMPARISON", "Choose only from the displayed pair.");
    const winnerSide = SIDES.find((side) => pair[side] === request.winner);
    if (!winnerSide) fail("INVALID_REQUEST", "Choose a displayed candidate by its identity.");
    if (request.note !== null && !(typeof request.note === "string" && request.note.length <= 4000)) fail("INVALID_REQUEST", "A note is optional text of at most 4000 characters.");
    const rejectedSide = winnerSide === "left" ? "right" : "left";
    const choice = { index: doc.choices.length, actionId: request.actionId, pairIndex: pair.index, winner: request.winner,
      winnerSide, rejected: pair[rejectedSide], note: request.note, at };
    doc.choices.push(choice);
    const generation = { id: identity("request", doc.sessionId, request.actionId), kind: "challenger", choiceIndex: choice.index,
      attempts: [{ id: identity("attempt", doc.sessionId, request.actionId), status: "running", failure: null }] };
    doc.requests.push(generation);
    doc.status = "generating";
    result.requestId = generation.id; result.attemptId = generation.attempts[0].id;
    result.eventId = generationEvent(doc, generation, generation.attempts[0], at);
  } else if (operation === "steer") {
    requireShape(request, ["actionId", "pairIndex", "instruction"]);
    const pair = doc.pairs.at(-1);
    if (doc.status !== "choosing" || !pair) fail("READ_ONLY", "Send is disabled during generation, after failure, and after Stop.");
    if (request.pairIndex !== pair.index) fail("STALE_COMPARISON", "Steer only the displayed pair.");
    // The size limits apply to new requests only (see mutate), so saved receipts replay under any later limit.
    if (typeof request.instruction !== "string" || !request.instruction.trim()) fail("INVALID_REQUEST", "Supply a nonblank instruction.");
    // After a winner: keep it on its side and replace only the displayed challenger. Before: replace both, with no vote.
    const choice = doc.choices.at(-1) ?? null;
    if (choice && pair[choice.winnerSide] !== choice.winner) fail("INVALID_TRANSITION", "The displayed pair does not hold the latest winner. Preserve the record before recovery.");
    const replaceSide = choice ? (choice.winnerSide === "left" ? "right" : "left") : null;
    const generation = { id: identity("request", doc.sessionId, request.actionId), kind: "steer", choiceIndex: choice?.index ?? null,
      steerIndex: steers(doc).length, pairIndex: pair.index, instruction: request.instruction,
      winner: choice?.winner ?? null, replaceSide, replaced: choice ? [pair[replaceSide]] : SIDES.map((side) => pair[side]),
      attempts: [{ id: identity("attempt", doc.sessionId, request.actionId), status: "running", failure: null }] };
    doc.requests.push(generation);
    doc.status = "generating";
    result.requestId = generation.id; result.attemptId = generation.attempts[0].id;
    result.eventId = generationEvent(doc, generation, generation.attempts[0], at);
  } else if (operation === "attach") {
    requireShape(request, ["actionId", "requestId", "attemptId", "manifest", "candidates"]);
    const { generation, attempt } = outstanding(doc, request);
    if (attempt.status !== "running" || doc.status !== "generating") fail("STALE_ATTEMPT", "This generation attempt no longer accepts a result.");
    const choice = retained(doc, generation);
    const sides = generation.kind === "steer" ? (generation.replaceSide ? [generation.replaceSide] : SIDES)
      : choice ? [candidate(doc, choice.rejected).side] : SIDES;
    if (!prepared || !equal(prepared.map((c) => c.side), sides) || prepared.some((c, i) =>
      c.candidateId !== identity("candidate", doc.sessionId, attempt.id, sides[i]) || c.requestId !== generation.id || c.attemptId !== attempt.id)) {
      fail("INVALID_INPUT", "A complete checked candidate set is required.");
    }
    doc.candidates.push(...clone(prepared));
    const pair = { index: doc.pairs.length, requestId: generation.id, attemptId: attempt.id, retained: choice?.winner ?? null };
    if (generation.kind === "steer") pair.steer = generation.steerIndex;
    for (const c of prepared) pair[c.side] = c.candidateId;
    if (choice) pair[choice.winnerSide] = choice.winner;
    doc.pairs.push(pair);
    attempt.status = "attached"; doc.status = "choosing";
    result.pairIndex = pair.index;
  } else if (operation === "fail" || operation === "retry") {
    requireShape(request, ["actionId", "requestId", "attemptId", ...(operation === "fail" ? ["message"] : [])]);
    const { generation, attempt } = outstanding(doc, request);
    if (operation === "retry") {
      if (attempt.status !== "failed") fail("INVALID_TRANSITION", "Explicitly report a failed or interrupted attempt before Retry.");
      const next = { id: identity("attempt", doc.sessionId, request.actionId), status: "running", failure: null };
      generation.attempts.push(next);
      doc.status = "generating";
      result.requestId = generation.id; result.attemptId = next.id;
      result.eventId = generationEvent(doc, generation, next, at);
    } else {
      if (attempt.status !== "running" || doc.status !== "generating") fail("STALE_ATTEMPT", "This generation attempt no longer accepts a result.");
      if (!text(request.message, 8000)) fail("INVALID_REQUEST", "Supply a nonblank failure message.");
      attempt.status = "failed"; attempt.failure = request.message; doc.status = "failed";
    }
  } else if (operation === "stop") {
    requireShape(request, ["actionId"]);
    if (doc.status === "stopped") fail("READ_ONLY", "The session is already stopped. There is no Resume.");
    const attempt = doc.requests.at(-1).attempts.at(-1);
    if (attempt.status === "running") attempt.status = "cancelled";
    doc.status = "stopped";
    // Freeze the latest explicit choice, never a displayed challenger. No choice gives no result.
    const choice = doc.choices.at(-1);
    doc.result = choice ? { candidateId: choice.winner, choiceIndex: choice.index, at } : null;
    result.result = doc.result ? doc.result.candidateId : null;
  } else if (operation === "submit") {
    requireShape(request, ["actionId"]);
    if (doc.status !== "stopped" || !doc.result) fail("INVALID_TRANSITION", "Submit requires Stop after an explicitly selected winner.");
    if (!doc.final) {
      const outputHash = hash(JSON.stringify(coinflipOutput(doc)));
      const eventId = event(doc, "final", { mode: "coinflip", winner: doc.result.candidateId, outputHash }, at);
      doc.final = { eventId, outputHash, at };
    }
    result.eventId = doc.final.eventId;
  } else if (operation === "ack") {
    requireShape(request, ["actionId", "eventId"]); id(request.eventId);
    if (!doc.events.some((e) => e.id === request.eventId)) fail("UNKNOWN_EVENT", "No event has that identity in this session.");
    if (!doc.acknowledgments.some((a) => a.eventId === request.eventId)) doc.acknowledgments.push({ eventId: request.eventId, at });
    result.eventId = request.eventId;
  } else fail("INVALID_REQUEST", "Unknown Coinflip operation.");
  doc.revision++;
  doc.receipts.push({ operation, request: clone(request), result, at });
  return result;
}

function checkCandidate(c) {
  requireShape(c, ["candidateId", "side", "description", "intendedDifference", "requestId", "attemptId", "pane", "entry", "files"]);
  if (!SIDES.includes(c.side) || !text(c.description, 2000) || (c.intendedDifference !== null && !text(c.intendedDifference, 2000)) ||
      !Array.isArray(c.files) || !c.files.some((f) => f.path === c.entry)) throw new Error();
  for (const file of c.files) {
    requireShape(file, ["path", "sha256", "base64"]);
    const bytes = Buffer.from(file.base64, "base64");
    if (bytes.toString("base64") !== file.base64 || hash(bytes) !== file.sha256) throw new Error();
  }
}

function decode(bytes, sessionId) {
  try {
    const { checksum, ...doc } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (checksum !== hash(JSON.stringify(doc)) || doc.schemaVersion !== 1 || doc.mode !== "coinflip" || doc.sessionId !== sessionId ||
        !validTime(doc.createdAt) || typeof doc.brief !== "string" || !doc.brief.trim() || !Array.isArray(doc.candidates)) throw new Error();
    requireShape(doc.gui, ["origin", "initialActionId"]);
    doc.candidates.forEach(checkCandidate);
    const replay = initialDoc({ sessionId, brief: doc.brief, ...doc.gui }, doc.createdAt);
    for (const receipt of doc.receipts) {
      requireShape(receipt, ["operation", "request", "result", "at", ...(receipt.attachRequest ? ["attachRequest"] : [])]);
      if (!validTime(receipt.at)) throw new Error();
      apply(replay, receipt.operation, receipt.request, receipt.at,
        receipt.operation === "attach" ? doc.candidates.filter((c) => c.attemptId === receipt.request.attemptId) : null);
      if (receipt.attachRequest) {
        if (receipt.operation !== "fail" || ["actionId", "requestId", "attemptId"].some((k) => receipt.attachRequest[k] !== receipt.request[k])) throw new Error();
        replay.receipts.at(-1).attachRequest = receipt.attachRequest;
      }
    }
    if (!equal(replay, doc)) throw new Error();
    return doc;
  } catch { fail("RECOVERY_REQUIRED", "The Coinflip record is invalid or corrupt. Preserve it before recovery."); }
}

/** One authoritative record per Coinflip session: candidates with checked bytes, choices, events and receipts. */
export class CoinflipStore {
  #archive;
  #separate;
  #steerLimits;
  // `steerLimits` exists for tests that write records under other limits; the shell and the server use the defaults.
  constructor({ archiveDir, stateDir, steerLimits }) {
    this.#steerLimits = steerLimits;
    absolute(archiveDir);
    if (stateDir !== undefined) absolute(stateDir);
    const roots = [archiveDir, ...(stateDir ? [stateDir] : [])];
    this.#separate = (pane) => {
      for (const root of roots) {
        if (contains(root, pane.copy.root) || contains(pane.copy.root, root) ||
            pane.original.files.some((f) => contains(root, f.path) || contains(f.path, root))) {
          fail("UNSAFE_PATH", "Candidate copies and originals must be separate from the archive and runtime state.");
        }
      }
    };
    this.#archive = new DoubleArchive({ archiveDir, prefix: "coinflip-session", identity: "sessionId", decode,
      separate: (doc) => doc.candidates.forEach((c) => this.#separate(c.pane)) });
  }

  async createInitial(input) {
    input = capture(input);
    requireShape(input, ["sessionId", "brief", "origin", "initialActionId"]); id(input.sessionId); id(input.initialActionId);
    requireShape(input.origin, ["piSessionId", "piSessionFile"]);
    if (typeof input.brief !== "string" || !input.brief.trim()) fail("INVALID_REQUEST", "Supply a nonblank brief.");
    return this.#archive.run(async () => {
      let saved;
      try { saved = await this.#archive.load(input.sessionId); } catch (e) { if (e.code !== "NOT_FOUND") throw e; }
      if (saved) {
        if (saved.doc.brief !== input.brief || !equal(saved.doc.gui, { origin: input.origin, initialActionId: input.initialActionId })) fail("SESSION_EXISTS", "The initial request differs.");
        return view(saved.doc);
      }
      const doc = initialDoc(input, time());
      await this.#archive.commit(doc);
      return view(doc);
    });
  }

  read(sessionId) { return this.#archive.run(async () => view((await this.#archive.load(sessionId)).doc)); }
  events(sessionId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(sessionId);
      return clone({ events: doc.events, acknowledgments: doc.acknowledgments,
        pending: doc.events.filter((e) => !doc.acknowledgments.some((a) => a.eventId === e.id)).map((e) => e.id) });
    });
  }
  output(sessionId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(sessionId);
      if (!doc.final) fail("INVALID_TRANSITION", "Stop after a winner, then Submit, before reading final output.");
      return coinflipOutput(doc);
    });
  }
  saved(sessionId, actionId) {
    return this.#archive.run(async () => (await this.#archive.load(sessionId)).doc.receipts.some((r) => r.request.actionId === actionId));
  }
  // Serving reads archived bytes only; the disposable copy folders may change or disappear.
  candidateFiles(sessionId, candidateId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(sessionId);
      const c = candidate(doc, candidateId);
      if (!c) fail("NOT_FOUND", "Unknown candidate.");
      return clone({ entry: c.entry, files: c.files });
    });
  }

  // The latest explicit winner's archived bytes, so that an agent can rebuild a moved or deleted copy folder.
  winner(sessionId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(sessionId);
      const choice = doc.choices.at(-1);
      if (!choice) fail("INVALID_TRANSITION", "No winner is chosen yet.");
      const c = candidate(doc, choice.winner);
      return clone({ candidateId: c.candidateId, side: c.side, label: c.pane.label, entry: c.entry, files: c.files });
    });
  }

  // Validate a returned candidate set against the existing static subset and the archived winner.
  async #prepare(doc, request) {
    const generation = doc.requests.at(-1), attempt = generation.attempts.at(-1);
    const choice = retained(doc, generation);
    const winner = choice && candidate(doc, choice.winner);
    const steer = generation.kind === "steer";
    const sides = steer ? (generation.replaceSide ? [generation.replaceSide] : SIDES) : winner ? [candidate(doc, choice.rejected).side] : SIDES;
    // The candidates that this request replaces: the rejected one, the displayed challenger, or the whole pre-winner pair.
    const replaced = steer ? generation.replaced.map((candidateId) => candidate(doc, candidateId)) : winner ? [candidate(doc, choice.rejected)] : [];
    const fields = winner ? ["description", "intendedDifference"] : ["description"];
    requireShape(request.candidates, sides);
    for (const side of sides) {
      requireShape(request.candidates[side], fields);
      for (const field of fields) if (!text(request.candidates[side][field], 2000)) fail("INVALID_REQUEST", `Supply a nonblank ${field} of at most 2000 characters.`);
    }
    const validated = await validateDoubleInput(request.manifest);
    if (!validated.ok) fail("INVALID_INPUT", "The complete candidate pair failed validation.", { diagnostics: validated.diagnostics });
    for (const side of SIDES) this.#separate(request.manifest.panes[side]);
    const panes = validated.comparison.panes;
    const buffers = await checkedCopies({ panes }, new Map());
    const files = (side) => panes[side].copy.files.map((f) => ({ ...f, base64: buffers.get(`${side}/${f.path}`).toString("base64") }));
    if (winner) {
      // Exact checked bytes, entry and side. A changed or moved winner never becomes a new pair.
      if (panes[winner.side].copy.entry !== winner.entry || !equal(files(winner.side), winner.files)) {
        fail("WINNER_CHANGED", "The retained winner differs from its archived bytes, assets, entry, or side.");
      }
    }
    // A byte-identical repeat is refused. Different bytes do not prove a new design direction.
    const earlier = [...(winner ? [winner] : []), ...replaced].map((c) => fingerprint(c.entry, c.files));
    for (const side of sides) if (earlier.includes(fingerprint(panes[side].copy.entry, files(side)))) {
      fail("CANDIDATE_REPEATED", "A new candidate repeats the checked bytes of the winner or a replaced or rejected candidate.");
    }
    return sides.map((side) => ({ candidateId: identity("candidate", doc.sessionId, attempt.id, side), side,
      description: request.candidates[side].description, intendedDifference: winner ? request.candidates[side].intendedDifference : null,
      requestId: generation.id, attemptId: attempt.id, pane: clone(request.manifest.panes[side]), entry: panes[side].copy.entry, files: files(side) }));
  }

  async mutate(sessionId, operation, request) {
    request = capture(request);
    return this.#archive.run(async () => {
      const { doc, bytes } = await this.#archive.load(sessionId);
      id(request?.actionId);
      const saved = doc.receipts.find((r) => r.request.actionId === request.actionId);
      if (saved) {
        if (saved.attachRequest ? operation !== "attach" || !equal(saved.attachRequest, request)
          : saved.operation !== operation || !equal(saved.request, request)) fail("ACTION_CONFLICT", "The action ID has a different saved operation or complete request.");
        return { view: view(doc), result: clone(saved.result) };
      }
      if (operation === "steer") {
        const problem = steerProblem(steers(doc).map((x) => x.text), request.instruction, this.#steerLimits);
        if (problem) fail("INVALID_REQUEST", problem);
      }
      let prepared = null;
      if (operation === "attach") {
        // Refuse stale work before opening any caller-supplied path.
        requireShape(request, ["actionId", "requestId", "attemptId", "manifest", "candidates"]);
        const { attempt } = outstanding(doc, request);
        if (attempt.status !== "running" || doc.status !== "generating") fail("STALE_ATTEMPT", "This attempt no longer accepts a result.");
        try { prepared = await this.#prepare(doc, request); }
        catch (error) {
          if (!["INVALID_INPUT", "WINNER_CHANGED", "CANDIDATE_REPEATED", "UNSAFE_PATH", "FILE_CHANGED"].includes(error.code)) throw error;
          // A refused candidate set is an explicit failed attempt with a replayable receipt.
          // The last valid pair and winner stay; Retry is the owner's explicit choice.
          const failure = { actionId: request.actionId, requestId: request.requestId, attemptId: request.attemptId,
            message: `Candidate validation failed (${error.code}): ${error.message}` };
          const result = apply(doc, "fail", failure, time());
          doc.receipts.at(-1).attachRequest = request;
          await this.#archive.commit(doc, bytes);
          return { view: view(doc), result: clone(result) };
        }
      }
      const result = apply(doc, operation, request, time(), prepared);
      await this.#archive.commit(doc, bytes);
      return { view: view(doc), result: clone(result) };
    });
  }
}
