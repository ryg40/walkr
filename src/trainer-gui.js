import { isDeepStrictEqual as equal } from "node:util";
import { DoubleArchive, hash, fail, id, capture, requireShape } from "./double-archive.js";
import { decodeDoubleComparisonId } from "./double-route.js";

const API = "/api/double/modes/trainer/sessions/";
// The owner's End, Retry and Send pending need the GUI browser credential; preparation failure and delivery need the agent credential.
// The agent relays the private GUI URL, so this split guards against mistakes, not against a hostile or steered agent.
const OWNER_OPS = new Set(["end", "retry", "send-pending"]);
const STATUSES = new Set(["preparing", "failed", "linked", "ended"]);
const clone = structuredClone;
const identity = (kind, ...parts) => `${kind}-${hash(JSON.stringify(parts))}`;
const time = () => new Date().toISOString();
const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
export const TRAINER_PREPARE_INSTRUCTION = "Prepare the dataset that the brief describes, with stable source IDs and exact text or Markdown content, " +
  "and propose complete groups of three with a short explanation. Submit it with walkr-trainer create and put payload.link, unchanged, in its gui field.";

function initialDoc(input, at) {
  return { schemaVersion: 1, mode: "trainer", sessionId: input.sessionId, brief: input.brief, createdAt: at,
    gui: { origin: input.origin, initialActionId: input.initialActionId }, revision: 0, status: "preparing",
    request: { id: identity("request", input.sessionId, input.initialActionId), attemptId: identity("attempt", input.sessionId, input.initialActionId),
      status: "running", failure: null },
    previous: [], link: null, ended: null, releases: [], acknowledgments: [], receipts: [] };
}
// A Retry gives the same saved request a new attempt; its identity comes from the Retry action.
const retryAttempt = (sessionId, actionId) => identity("attempt", sessionId, actionId);

function decode(bytes, sessionId) {
  try {
    const { checksum, ...doc } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (checksum !== hash(JSON.stringify(doc)) || doc.schemaVersion !== 1 || doc.mode !== "trainer" || doc.sessionId !== sessionId ||
        typeof doc.brief !== "string" || !doc.brief.trim() || !STATUSES.has(doc.status) || !Number.isSafeInteger(doc.revision) ||
        !Array.isArray(doc.acknowledgments) || !Array.isArray(doc.receipts)) throw new Error();
    requireShape(doc.gui, ["origin", "initialActionId"]);
    requireShape(doc.request, ["id", "attemptId", "status", "failure"]);
    doc.previous ??= []; doc.releases ??= [];
    if (!Array.isArray(doc.previous) || !Array.isArray(doc.releases)) throw new Error();
    for (const attempt of doc.previous) requireShape(attempt, ["attemptId", "status", "failure"]);
    for (const release of doc.releases) { requireShape(release, ["actionId", "eventIds", "at"]); if (!Array.isArray(release.eventIds)) throw new Error(); }
    const initial = initialDoc({ sessionId, brief: doc.brief, ...doc.gui }, doc.createdAt);
    const attempts = [initial.request.attemptId, ...doc.receipts.filter((r) => r.operation === "retry").map((r) => retryAttempt(sessionId, r.request.actionId))];
    if (doc.request.id !== initial.request.id || !equal([...doc.previous.map((a) => a.attemptId), doc.request.attemptId], attempts)) throw new Error();
    if (doc.link) requireShape(doc.link, ["repo", "datasetSessionId", "createActionId", "requestId", "attemptId", "at"]);
    if (doc.status === "linked" && !doc.link || doc.status === "ended" && !doc.ended) throw new Error();
    return doc;
  } catch { fail("RECOVERY_REQUIRED", "The Trainer GUI record is invalid or corrupt. Preserve it before recovery."); }
}

function baseView(doc) {
  return clone({ mode: "trainer", sessionId: doc.sessionId, brief: doc.brief, createdAt: doc.createdAt, revision: doc.revision,
    status: doc.status, gui: doc.gui, request: doc.request, previous: doc.previous, link: doc.link, ended: doc.ended });
}

/**
 * Trainer registration for the shared GUI. A start saves one record per GUI session; Pi then creates the dataset with
 * `walkr-trainer create` and names this start in its `gui` field. Plan change requests and saved votes become wake-up
 * events that are derived from the durable dataset record, so no event depends on an in-memory notification.
 * `trainer` is the Trainer handler's service: its dataset store and its private page grants of this server run.
 */
export function createTrainerMode({ archiveDir, trainer }) {
  const archive = new DoubleArchive({ archiveDir, prefix: "trainer-gui", identity: "sessionId", decode, separate() {} });
  const running = (view) => view.status === "preparing" ? `${view.sessionId}/${view.request.attemptId}` : null;
  const load = (sessionId) => archive.run(() => archive.load(sessionId));
  const dataset = (doc) => trainer.store().read(doc.link.repo, doc.link.datasetSessionId);

  // Stable identities: each event names exactly one immutable preparation attempt, plan review, or saved vote.
  // An unreadable linked dataset gives only the preparation events and its error, so other sessions keep working.
  async function events(doc) {
    const { request } = doc;
    const started = new Map(doc.receipts.filter((r) => r.operation === "retry").map((r) => [retryAttempt(doc.sessionId, r.request.actionId), r.at]));
    const list = [...doc.previous.map((a) => a.attemptId), request.attemptId].map((attemptId) => ({
      id: identity("event", doc.sessionId, "prepare", attemptId), kind: "prepare", sessionId: doc.sessionId, at: started.get(attemptId) ?? doc.createdAt,
      payload: { mode: "trainer", kind: "prepare", requestId: request.id, attemptId, brief: doc.brief,
        link: { sessionId: doc.sessionId, requestId: request.id, attemptId }, instruction: TRAINER_PREPARE_INSTRUCTION } }));
    if (!doc.link) return { events: list, datasetError: null };
    let saved;
    try { saved = await dataset(doc); }
    catch (error) { return { events: list, datasetError: error.code || "INTERNAL_ERROR" }; }
    const where = { repo: doc.link.repo, datasetSessionId: doc.link.datasetSessionId };
    for (const plan of saved.plans) {
      if (plan.review?.decision !== "request-changes") continue;
      list.push({ id: identity("event", doc.sessionId, "plan", plan.revision), kind: "plan-changes", sessionId: doc.sessionId, at: plan.review.at,
        payload: { mode: "trainer", kind: "plan-changes", ...where, revision: plan.revision, note: plan.review.note } });
    }
    for (const group of saved.groups) {
      if (!group.vote) continue;
      list.push({ id: identity("event", doc.sessionId, "analysis", group.groupId, group.vote.voteSha256), kind: "analysis", sessionId: doc.sessionId,
        at: group.vote.submittedAt, payload: { mode: "trainer", kind: "analysis", ...where, groupId: group.groupId, voteSha256: group.vote.voteSha256 } });
    }
    return { events: list, datasetError: null };
  }

  // A dataset that cannot be read accepts no vote either, so End records it as unavailable instead of holding the slot forever.
  async function endDataset(doc, actionId) {
    try { await trainer.store().end(doc.link.repo, doc.link.datasetSessionId, { actionId }); return "ended"; }
    catch (error) { if (["NOT_FOUND", "RECOVERY_REQUIRED"].includes(error.code)) return "unavailable"; throw error; }
  }

  // The saved view plus the linked dataset status, for the single-active rule. An unreadable dataset counts as not finished.
  async function summary(doc) {
    const view = baseView(doc);
    view.datasetStatus = null;
    if (doc.link) try { view.datasetStatus = (await dataset(doc)).status; } catch {}
    return view;
  }

  async function guiView(sessionId, { connected, recovery, failures }) {
    const { doc } = await load(sessionId);
    const view = baseView(doc);
    view.guiConnection = connected();
    view.recoveryRequired = Boolean(running(view) && recovery.has(running(view)));
    // The listener holds requests that were never sent before this connection, until the owner selects Send pending requests.
    view.heldRequests = failures().some((item) => item.sessionId === sessionId && item.status === "held");
    if (doc.link) {
      const where = { repo: doc.link.repo, sessionId: doc.link.datasetSessionId };
      try {
        const saved = await dataset(doc);
        view.dataset = { ...where, status: saved.status, planRevision: saved.plans.at(-1).revision, progress: saved.progress,
          pendingAnalysis: saved.groups.filter((g) => g.vote && g.analysis.status !== "complete")
            .map((g) => ({ groupId: g.groupId, voteSha256: g.vote.voteSha256, status: g.analysis.status })) };
        // The private page of this server run. The agent can obtain the same path with walkr-trainer open.
        view.pagePath = trainer.page(where.repo, where.sessionId);
      } catch (error) {
        view.dataset = { ...where, error: { code: error.code || "INTERNAL_ERROR", message: "The linked dataset cannot be read. Saved votes stay in its record." } };
      }
    }
    return view;
  }

  async function mutate(sessionId, operation, request, { connected, recovery }) {
    request = capture(request);
    return archive.run(async () => {
      const { doc, bytes } = await archive.load(sessionId);
      id(request?.actionId);
      const saved = doc.receipts.find((r) => r.request.actionId === request.actionId);
      if (saved) {
        if (saved.operation !== operation || !equal(saved.request, request)) fail("ACTION_CONFLICT", "The action ID has a different saved operation or complete request.");
        return clone(saved.result);
      }
      const at = time(), result = { actionId: request.actionId, kind: operation, revision: doc.revision + 1 };
      if (operation === "fail" || operation === "retry") {
        requireShape(request, ["actionId", "requestId", "attemptId", ...(operation === "fail" ? ["message"] : [])]);
        if (doc.status === "ended") fail("READ_ONLY", "The owner ended this Trainer session.");
        if (request.requestId !== doc.request.id || request.attemptId !== doc.request.attemptId) fail("STALE_ATTEMPT", "This is not the current preparation request and attempt.");
        const interrupted = doc.status === "preparing" && recovery.has(running(baseView(doc)));
        if (operation === "fail") {
          if (doc.status !== "preparing") fail("STALE_ATTEMPT", "This is not the running preparation request and attempt.");
          if (!text(request.message, 8000)) fail("INVALID_REQUEST", "Supply a nonblank failure message.");
          doc.request.status = "failed"; doc.request.failure = request.message; doc.status = "failed";
        } else {
          // The owner's Retry: the same saved request and brief with a new attempt. Late work for the old attempt is refused.
          if (doc.status !== "failed" && !interrupted) fail("INVALID_TRANSITION", "Retry follows a failed or interrupted preparation only.");
          if (!connected()) fail("DISCONNECTED", "Reconnect the bound Pi chat before Retry.");
          doc.previous.push({ attemptId: doc.request.attemptId, status: interrupted ? "interrupted" : "failed", failure: doc.request.failure });
          doc.request = { id: doc.request.id, attemptId: retryAttempt(doc.sessionId, request.actionId), status: "running", failure: null };
          doc.status = "preparing";
          result.requestId = doc.request.id; result.attemptId = doc.request.attemptId;
        }
      } else if (operation === "send-pending") {
        // The owner's explicit send of change and analysis requests that the listener held after a reconnection.
        requireShape(request, ["actionId"]);
        if (doc.status !== "linked") fail("INVALID_TRANSITION", "Only a linked, open Trainer session has requests to send.");
        if (!connected()) fail("DISCONNECTED", "Reconnect the bound Pi chat before you send pending requests.");
        const acknowledged = new Set(doc.acknowledgments.map((a) => a.eventId));
        const eventIds = (await events(doc)).events.filter((e) => e.kind !== "prepare" && !acknowledged.has(e.id)).map((e) => e.id);
        if (!eventIds.length) fail("INVALID_TRANSITION", "No change or analysis request is waiting.");
        doc.releases.push({ actionId: request.actionId, eventIds, at });
        result.eventIds = eventIds;
      } else if (operation === "end") {
        requireShape(request, ["actionId"]);
        if (doc.status === "ended") fail("READ_ONLY", "The Trainer session is already ended.");
        // The dataset closes first, so a saved End always means that no vote is accepted. A failure keeps the slot held; the owner retries End.
        const datasetEnd = doc.link ? await endDataset(doc, request.actionId) : null;
        if (doc.request.status === "running") doc.request.status = "cancelled";
        doc.status = "ended";
        doc.ended = { actionId: request.actionId, at, dataset: datasetEnd };
      } else if (operation === "ack") {
        requireShape(request, ["actionId", "eventId"]); id(request.eventId);
        if (!(await events(doc)).events.some((e) => e.id === request.eventId)) fail("UNKNOWN_EVENT", "No event has that identity in this session.");
        if (!doc.acknowledgments.some((a) => a.eventId === request.eventId)) doc.acknowledgments.push({ eventId: request.eventId, at });
        result.eventId = request.eventId;
      } else fail("INVALID_REQUEST", "Unknown Trainer GUI operation.");
      doc.revision++;
      doc.receipts.push({ operation, request: clone(request), result, at });
      await archive.commit(doc, bytes);
      return result;
    });
  }

  async function route(raw, req, res, context) {
    if (!raw.startsWith(API)) return false;
    const match = raw.slice(API.length).match(/^(~[^/]*)(?:\/(end|retry|send-pending|events|ack|fail))?$/);
    if (!match) fail("NOT_FOUND", "Unknown Trainer GUI session route.");
    const sessionId = decodeDoubleComparisonId(match[1]);
    const operation = match[2] || "view";
    const allowed = operation === "view" ? context.agent || context.guiBrowser : OWNER_OPS.has(operation) ? context.guiBrowser : context.agent;
    if (!allowed) fail("FORBIDDEN", "This credential does not authorize that Trainer GUI operation.");
    const method = ["view", "events"].includes(operation) ? "GET" : "POST";
    if (req.method !== method) fail("METHOD_NOT_ALLOWED", `Use ${method} for this operation.`);
    if (operation === "view") return context.send(res, 200, { view: await guiView(sessionId, context) }), true;
    if (operation === "events") {
      const { doc } = await load(sessionId);
      const { events: list, datasetError } = await events(doc);
      return context.send(res, 200, { events: list, acknowledgments: clone(doc.acknowledgments), releases: clone(doc.releases), datasetError,
        pending: list.filter((e) => !doc.acknowledgments.some((a) => a.eventId === e.id)).map((e) => e.id) }), true;
    }
    const body = await context.readBody(req);
    const result = await context.serial(() => mutate(sessionId, operation, body, context));
    context.send(res, 200, { result, view: await guiView(sessionId, context) });
    return true;
  }

  // Link a dataset create request to the GUI start that its gui field names. The caller serializes this with GUI mutations.
  // An identical create replays to the same dataset; any other request, start, mode, or attempt is refused before creation.
  async function link(body, create, { connected, recovery }) {
    const reference = capture(body?.gui);
    requireShape(reference, ["sessionId", "requestId", "attemptId"]);
    for (const value of Object.values(reference)) id(value);
    if (!/^trainer-[a-f0-9]{64}$/.test(reference.sessionId)) fail("NOT_FOUND", "No Trainer GUI start has that session ID.");
    let saved;
    try { saved = await load(reference.sessionId); }
    catch (error) { if (error.code === "NOT_FOUND") fail("NOT_FOUND", "No Trainer GUI start has that session ID."); throw error; }
    const { doc, bytes } = saved;
    const same = reference.requestId === doc.request.id && reference.attemptId === doc.request.attemptId;
    if (doc.link) {
      if (!same || doc.link.createActionId !== body.actionId) fail("STALE_ATTEMPT", "This Trainer GUI start already links another dataset.");
      const answer = await create();
      if (answer.view.sessionId !== doc.link.datasetSessionId || answer.view.repo.name !== doc.link.repo) fail("STALE_ATTEMPT", "The replayed create names another dataset.");
      return answer;
    }
    if (doc.status === "ended") fail("READ_ONLY", "The owner ended this Trainer GUI session. Late work cannot create its dataset.");
    if (!same || doc.status !== "preparing" || doc.request.status !== "running") fail("STALE_ATTEMPT", "This is not the running preparation request and attempt.");
    if (recovery.has(running(baseView(doc)))) fail("STALE_ATTEMPT", "Interrupted preparation cannot link a dataset. The owner selects Retry or End.");
    if (!connected()) fail("DISCONNECTED", "Reconnect the bound Pi chat before you link a dataset.");
    const answer = await create();
    if (!equal(answer.view.gui, reference)) fail("STALE_ATTEMPT", "The created dataset names another GUI start.");
    doc.link = { repo: answer.view.repo.name, datasetSessionId: answer.view.sessionId, createActionId: body.actionId,
      requestId: reference.requestId, attemptId: reference.attemptId, at: time() };
    doc.request.status = "linked"; doc.status = "linked"; doc.revision++;
    await archive.run(() => archive.commit(doc, bytes));
    return answer;
  }

  return {
    name: "trainer", label: "Training",
    sessionId: (actionId) => `trainer-${hash(actionId)}`,
    async createInitial(input) {
      input = capture(input);
      requireShape(input, ["sessionId", "brief", "origin", "initialActionId"]); id(input.sessionId); id(input.initialActionId);
      requireShape(input.origin, ["piSessionId", "piSessionFile"]);
      if (typeof input.brief !== "string" || !input.brief.trim()) fail("INVALID_REQUEST", "Supply a nonblank brief.");
      return archive.run(async () => {
        let saved;
        try { saved = await archive.load(input.sessionId); } catch (e) { if (e.code !== "NOT_FOUND") throw e; }
        if (saved) {
          if (saved.doc.brief !== input.brief || !equal(saved.doc.gui, { origin: input.origin, initialActionId: input.initialActionId })) fail("SESSION_EXISTS", "The initial request differs.");
          return saved.doc;
        }
        const doc = initialDoc(input, time());
        await archive.commit(doc);
        return doc;
      }).then(summary);
    },
    read: async (sessionId) => summary((await load(sessionId)).doc),
    // A finished review (every group saved) frees the single-active slot; the listener stays for analysis until End (`settled`).
    terminal: (view) => view.status === "ended" || view.datasetStatus === "complete",
    settled: (view) => view.status === "ended",
    running, view: guiView, route, link,
  };
}
