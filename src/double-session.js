import { isDeepStrictEqual as equal } from "node:util";
import { DoubleArchive, hash, fail, id, capture, requireShape, contains, absolute } from "./double-archive.js";
import { prepareComparison, validateComparison, initialComparison, applyComparison, comparisonView, separateComparison } from "./double-store.js";
import { capturePair, validateMaterial, finalPage } from "./double-final.js";
import { steerProblem } from "./steer-limits.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

const clone = structuredClone;
const identity = (kind, ...parts) => `${kind}-${hash(JSON.stringify(parts))}`;
const time = () => new Date().toISOString();
const validTime = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s));
const current = (doc) => doc.rounds.at(-1);

function initial(input, comparison, material, at) {
  return { schemaVersion: 1, sessionId: input.sessionId, brief: input.brief, createdAt: at,
    revision: 0, status: "editing", rounds: [{ comparison, material, outcome: null }],
    requests: [], events: [], acknowledgments: [], final: null, receipts: [] };
}

function initialRequest(input, at) {
  const doc = { schemaVersion: 1, sessionId: input.sessionId, brief: input.brief, createdAt: at,
    revision: 0, status: "generating", rounds: [], requests: [], events: [], acknowledgments: [], final: null, receipts: [],
    gui: { origin: input.origin, initialActionId: input.initialActionId } };
  const generation = { id: identity("request", input.sessionId, input.initialActionId), comparisonId: null, batch: null,
    attempts: [{ id: identity("attempt", input.sessionId, input.initialActionId), status: "running", failure: null }] };
  doc.requests.push(generation);
  generationEvent(doc, generation, generation.attempts[0], at);
  return doc;
}

function view(doc) {
  const latest = doc.requests.at(-1);
  return clone({ sessionId: doc.sessionId, brief: doc.brief, revision: doc.revision, status: doc.status,
    currentComparisonId: current(doc)?.comparison.comparisonId ?? null, comparison: current(doc) ? comparisonView(current(doc).comparison) : null,
    ...(doc.gui ? { gui: doc.gui, delivery: doc.events.some((e) => e.kind === "final")
      ? (doc.acknowledgments.some((a) => a.eventId === doc.events.at(-1).id) ? "received" : "pending") : null } : {}),
    rounds: doc.rounds.map((round, index) => ({ index, comparisonId: round.comparison.comparisonId, outcome: round.outcome })),
    generation: latest ? { requestId: latest.id, comparisonId: latest.comparisonId, attempt: latest.attempts.at(-1) } : null,
    final: doc.final ? { comparisonId: doc.final.comparisonId, pane: doc.final.pane, deletedComponentIds: doc.final.deletedComponentIds } : null,
  });
}

function expected(doc, request) {
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) fail("INVALID_REQUEST", "expectedRevision must be a nonnegative safe integer.");
  if (request.expectedRevision !== doc.revision) fail("STALE_REVISION", "Read the session before starting a new action.");
}

function outstanding(doc, request) {
  id(request.requestId); id(request.attemptId);
  if (["ended", "stopped"].includes(doc.status)) fail("READ_ONLY", "The session has ended or stopped.");
  const generation = doc.requests.at(-1);
  const attempt = generation?.attempts.at(-1);
  if (!generation || generation.id !== request.requestId || attempt.id !== request.attemptId) {
    fail("STALE_ATTEMPT", "This is not the current generation request and attempt.");
  }
  return { generation, attempt };
}

function event(doc, kind, payload, at) {
  const value = { id: identity("event", doc.sessionId, doc.revision + 1, ...(doc.gui ? [doc.events.length] : [])), kind, sessionId: doc.sessionId, at, payload: clone(payload) };
  doc.events.push(value);
  return value.id;
}

// Saved prompt-box instructions, in order. Records without any keep their earlier event shape.
const steers = (doc) => doc.requests.filter((r) => r.instruction !== undefined)
  .map((r) => ({ requestId: r.id, comparisonId: r.comparisonId, text: r.instruction }));
const withSteers = (doc, payload) => steers(doc).length ? { ...payload, steers: steers(doc) } : payload;

function generationEvent(doc, generation, attempt, at) {
  return event(doc, "generation", withSteers(doc, { requestId: generation.id, attemptId: attempt.id, comparisonId: generation.comparisonId,
    brief: doc.brief, batch: generation.batch,
    ...(generation.instruction !== undefined ? { steer: { text: generation.instruction } } : {}),
    history: doc.rounds.filter((r) => r.comparison.delivery.batch).map((r) => r.comparison.delivery.batch) }), at);
}

// Receipts replay the same transitions on load. Prepared pair evidence is the only external input.
function apply(doc, operation, request, at, prepared = null) {
  id(request?.actionId);
  if (doc.receipts.some((r) => r.request.actionId === request.actionId)) fail("ACTION_CONFLICT", "The action ID is already saved.");
  if (!Number.isSafeInteger(doc.revision + 1)) fail("READ_ONLY", "The session revision limit is reached.");
  const result = { actionId: request.actionId, kind: operation, revision: doc.revision + 1 };
  const round = current(doc);
  if (["act", "next", "steer", "end", "retry", "stop"].includes(operation)) expected(doc, request);
  if (["act", "next", "steer", "end"].includes(operation) && !round) fail("INVALID_TRANSITION", "The initial pair is not available.");
  if (operation === "stop") {
    requireShape(request, ["actionId", "expectedRevision"]);
    if (round || doc.status === "stopped") fail("READ_ONLY", "Stop is only available before the first pair.");
    doc.status = "stopped";
    const attempt = doc.requests.at(-1).attempts.at(-1);
    if (attempt.status === "running") attempt.status = "cancelled";
  } else if (operation === "act") {
    requireShape(request, ["actionId", "expectedRevision", "comparisonId", "action"]);
    if (request.comparisonId !== round.comparison.comparisonId) fail("STALE_COMPARISON", "Only the displayed comparison accepts actions.");
    if (doc.status !== "editing") fail("READ_ONLY", "The displayed pair is read-only.");
    if (!request.action || typeof request.action !== "object" || Array.isArray(request.action) ||
        Object.hasOwn(request.action, "actionId") || Object.hasOwn(request.action, "expectedRevision")) {
      fail("INVALID_REQUEST", "action contains only comparison action fields, without revision or action ID.");
    }
    applyComparison(round.comparison, "act", { ...request.action,
      actionId: identity("owner", request.actionId), expectedRevision: round.comparison.revision }, at);
  } else if (operation === "next" || operation === "steer" || operation === "end") {
    // Steer is Next with a saved prompt-box instruction: the same frozen batch of keepers, deletions and feedback.
    requireShape(request, ["actionId", "expectedRevision", "comparisonId", ...(operation === "end" ? ["pane"] : operation === "steer" ? ["instruction"] : [])]);
    if (operation === "steer") {
      if (!doc.gui) fail("INVALID_TRANSITION", "Prompt steering is available only for shared-GUI sessions.");
      // The size limits apply to new requests only (see mutate), so saved receipts replay under any later limit.
      if (typeof request.instruction !== "string" || !request.instruction.trim()) fail("INVALID_REQUEST", "Supply a nonblank instruction.");
    }
    if (request.comparisonId !== round.comparison.comparisonId) fail("STALE_COMPARISON", "Choose from the last displayed comparison.");
    if (doc.status === "ended" || operation !== "end" && doc.status !== "editing") fail("READ_ONLY", "No new comparison can start in this state.");
    if (operation === "end" && !["left", "right"].includes(request.pane)) fail("INVALID_REQUEST", "Select left or right explicitly.");
    if (round.comparison.delivery.status === "editing") {
      applyComparison(round.comparison, "send", { actionId: identity("submit", request.actionId), expectedRevision: round.comparison.revision }, at);
      round.outcome = { kind: operation, batchId: round.comparison.delivery.batch.id, ...(operation === "steer" ? { instruction: request.instruction } : {}) };
    }
    if (operation !== "end") {
      const generation = { id: identity("request", doc.sessionId, request.actionId), comparisonId: request.comparisonId,
        batch: clone(round.comparison.delivery.batch), attempts: [{ id: identity("attempt", doc.sessionId, request.actionId), status: "running", failure: null }],
        ...(operation === "steer" ? { instruction: request.instruction } : {}) };
      doc.requests.push(generation);
      doc.status = "generating";
      result.requestId = generation.id;
      result.attemptId = generation.attempts[0].id;
      result.eventId = generationEvent(doc, generation, generation.attempts[0], at);
    } else {
      doc.final = finalPage(round.comparison, round.material, request.pane);
      doc.status = "ended";
      const attempt = doc.requests.at(-1)?.attempts.at(-1);
      if (attempt?.status === "running") attempt.status = "cancelled";
      result.eventId = event(doc, "final", withSteers(doc, { selection: { comparisonId: request.comparisonId, pane: request.pane },
        history: doc.rounds.map((r) => r.comparison.delivery.batch) }), at);
    }
  } else if (operation === "ack") {
    requireShape(request, ["actionId", "eventId"]); id(request.eventId);
    if (!doc.events.some((e) => e.id === request.eventId)) fail("UNKNOWN_EVENT", "No event has that identity in this session.");
    if (!doc.acknowledgments.some((a) => a.eventId === request.eventId)) doc.acknowledgments.push({ eventId: request.eventId, at });
    result.eventId = request.eventId;
  } else if (operation === "fail" || operation === "retry" || operation === "attach") {
    requireShape(request, ["actionId", "requestId", "attemptId", ...(operation === "fail" ? ["message"] : operation === "retry" ? ["expectedRevision"] : ["manifest"])]);
    const { generation, attempt } = outstanding(doc, request);
    if (operation === "retry") {
      if (attempt.status !== "failed") fail("INVALID_TRANSITION", "Explicitly report a failed or lost attempt before retrying.");
      const next = { id: identity("attempt", doc.sessionId, request.actionId), status: "running", failure: null };
      generation.attempts.push(next);
      doc.status = "generating";
      result.requestId = generation.id; result.attemptId = next.id;
      result.eventId = generationEvent(doc, generation, next, at);
    } else {
      if (attempt.status !== "running" || doc.status !== "generating") fail("STALE_ATTEMPT", "This generation attempt no longer accepts a result.");
      if (operation === "fail") {
        if (typeof request.message !== "string" || !request.message.trim()) fail("INVALID_REQUEST", "Supply a nonblank failure message.");
        attempt.status = "failed"; attempt.failure = request.message; doc.status = "failed";
      } else {
        if (!prepared || !equal(prepared.comparison.manifest, request.manifest)) fail("INVALID_INPUT", "A complete checked prepared pair is required.");
        if (doc.rounds.some((r) => r.comparison.comparisonId === prepared.comparison.comparisonId)) fail("COMPARISON_EXISTS", "Each round needs a distinct comparison identity.");
        if (prepared.comparison.comparisonId === doc.sessionId) fail("INVALID_ID", "Session and comparison identities must differ.");
        doc.rounds.push({ ...clone(prepared), outcome: null });
        attempt.status = "attached"; doc.status = "editing";
        result.comparisonId = prepared.comparison.comparisonId;
      }
    }
  } else fail("INVALID_REQUEST", "Unknown session operation.");
  doc.revision++;
  doc.receipts.push({ operation, request: clone(request), result, at });
  return result;
}

function decode(bytes, sessionId) {
  try {
    const { checksum, ...doc } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (checksum !== hash(JSON.stringify(doc)) || doc.schemaVersion !== 1 || doc.sessionId !== sessionId ||
        !validTime(doc.createdAt) || typeof doc.brief !== "string" || !doc.brief.trim() || (!doc.gui && !doc.rounds.length)) throw new Error();
    id(sessionId);
    const prepared = doc.rounds.map((round) => {
      requireShape(round, ["comparison", "material", "outcome"]);
      const comparison = validateComparison(round.comparison);
      validateMaterial(comparison, round.material);
      return { comparison: initialComparison(comparison.manifest, comparison.provenance, comparison.baselines, comparison.createdAt), material: round.material };
    });
    if (prepared[0]?.comparison.comparisonId === sessionId) throw new Error();
    const replay = doc.gui ? initialRequest({ sessionId, brief: doc.brief, ...doc.gui }, doc.createdAt)
      : initial({ sessionId, brief: doc.brief }, prepared[0].comparison, prepared[0].material, doc.createdAt);
    let next = doc.gui ? 0 : 1;
    for (const receipt of doc.receipts) {
      requireShape(receipt, ["operation", "request", "result", "at", ...(receipt.attachRequest ? ["attachRequest"] : [])]);
      if (!validTime(receipt.at)) throw new Error();
      apply(replay, receipt.operation, receipt.request, receipt.at, receipt.operation === "attach" ? prepared[next++] : null);
      if (receipt.attachRequest) {
        if (receipt.operation !== "fail" || receipt.attachRequest.actionId !== receipt.request.actionId ||
            receipt.attachRequest.requestId !== receipt.request.requestId || receipt.attachRequest.attemptId !== receipt.request.attemptId) throw new Error();
        replay.receipts.at(-1).attachRequest = receipt.attachRequest;
      }
    }
    if (!equal(replay, doc)) throw new Error();
    return doc;
  } catch { fail("RECOVERY_REQUIRED", "The session record is invalid or corrupt. Preserve it before recovery."); }
}

/** One authoritative session document embeds comparison records, checked bytes, events and receipts. */
export class DoubleSessionStore {
  #archive;
  #separate;
  #steerLimits;
  // `steerLimits` exists for tests that write records under other limits; the shell and the server use the defaults.
  constructor({ archiveDir, stateDir, steerLimits, platform = process.platform }) {
    const refusal = posixOnlyRefusal(platform); // Before the path checks below.
    if (refusal) fail(POSIX_ONLY_CODE, refusal);
    this.#steerLimits = steerLimits;
    absolute(archiveDir);
    if (stateDir !== undefined) {
      absolute(stateDir);
      if (contains(stateDir, archiveDir) || contains(archiveDir, stateDir)) fail("UNSAFE_PATH", "Archive and runtime state must be separate.");
    }
    this.#separate = (manifest) => {
      separateComparison(archiveDir, manifest);
      if (stateDir) for (const pane of ["left", "right"]) {
        const p = manifest.panes[pane];
        if (contains(stateDir, p.copy.root) || contains(p.copy.root, stateDir) ||
            p.original.files.some((f) => contains(stateDir, f.path) || contains(f.path, stateDir))) {
          fail("UNSAFE_PATH", "Session inputs must be separate from runtime state.");
        }
      }
    };
    this.#archive = new DoubleArchive({ archiveDir, prefix: "double-session", identity: "sessionId", decode, platform,
      separate: (doc) => doc.rounds.forEach((r) => this.#separate(r.comparison.manifest)) });
  }

  async create(input) {
    input = capture(input, "INVALID_INPUT");
    requireShape(input, ["sessionId", "brief", "manifest"]); id(input.sessionId);
    if (typeof input.brief !== "string" || !input.brief.trim()) fail("INVALID_REQUEST", "Supply a nonblank generation brief.");
    if (input.sessionId === input.manifest?.comparisonId) fail("INVALID_ID", "Session and comparison identities must differ.");
    return this.#archive.run(async () => {
      let saved;
      try { saved = await this.#archive.load(input.sessionId); } catch (e) { if (e.code !== "NOT_FOUND") throw e; }
      if (saved) {
        if (saved.doc.brief !== input.brief || !equal(saved.doc.rounds[0].comparison.manifest, input.manifest)) fail("SESSION_EXISTS", "Session identity already belongs to another creation request.");
        return view(saved.doc);
      }
      const comparison = await prepareComparison(input.manifest, this.#separate);
      const doc = initial(input, comparison, await capturePair(comparison), time());
      await this.#archive.commit(doc);
      return view(doc);
    });
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
      const doc = initialRequest(input, time());
      await this.#archive.commit(doc);
      return view(doc);
    });
  }

  async read(sessionId) { return this.#archive.run(async () => view((await this.#archive.load(sessionId)).doc)); }
  async snapshot(sessionId) { return this.#archive.run(async () => clone((await this.#archive.load(sessionId)).doc)); }
  async events(sessionId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(sessionId);
      return clone({ events: doc.events, acknowledgments: doc.acknowledgments,
        pending: doc.events.filter((e) => !doc.acknowledgments.some((a) => a.eventId === e.id)).map((e) => e.id) });
    });
  }
  async output(sessionId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(sessionId);
      if (!doc.final) fail("INVALID_TRANSITION", "End the session before obtaining final output.");
      return clone(withSteers(doc, { sessionId, page: doc.final, history: doc.rounds.map((r) => r.comparison.delivery.batch) }));
    });
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
        // Refuse stale work before opening any caller-supplied input path.
        requireShape(request, ["actionId", "requestId", "attemptId", "manifest"]);
        const { attempt } = outstanding(doc, request);
        if (attempt.status !== "running" || doc.status !== "generating") fail("STALE_ATTEMPT", "This attempt no longer accepts a result.");
        try {
          const comparison = await prepareComparison(request.manifest, this.#separate);
          prepared = { comparison, material: await capturePair(comparison) };
        } catch (error) {
          if (!doc.gui || doc.rounds.length || error.code !== "INVALID_INPUT") throw error;
          // Initial validation failure is an explicit failed attempt, with its own
          // replayable receipt. No partial pair is published and no retry is automatic.
          const failure = { actionId: request.actionId, requestId: request.requestId, attemptId: request.attemptId,
            message: `Initial validation failed: ${error.message}` };
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
