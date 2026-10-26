import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { hash } from "./double-archive.js";
import { configuration, connectDoubleClient, request } from "./double-client.js";
import { createReceiptVerifier } from "./double-chat-delivery.js";
import { RECEIPT_LIMITS } from "./double-chat-receipt.js";
import { encodeDoubleComparisonId } from "./double-route.js";

export { hash };
const same = isDeepStrictEqual;
const identity = (ctx) => ({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });

/**
 * The agent client of a shared-GUI mode: view, events and acknowledge, plus the extra GET routes in `gets`
 * (method name to route suffix), on /api/double/modes/<mode>/sessions/<id>.
 */
export function createModeChatClient(mode, label, gets = {}, env = process.env) {
  const config = configuration({ ...env });
  let server;
  function call(id, suffix, signal, body) {
    if (!server) throw new Error(`${label} client is not connected.`);
    return request(server, `/api/double/modes/${mode}/sessions/${encodeDoubleComparisonId(id)}${suffix}`, {
      signal, ...(body === undefined ? {} : { method: "POST", body }) });
  }
  const client = {
    archiveId: hash(config.archiveDir), stateId: hash(config.stateDir),
    async connect(signal) { ({ server } = await connectDoubleClient(config, { signal, sessions: true })); },
    view: (id, signal) => call(id, "", signal),
    events: (id, signal) => call(id, "/events", signal),
    acknowledge: (id, body, signal) => call(id, "/ack", signal, body),
  };
  for (const [name, suffix] of Object.entries(gets)) client[name] = (id, signal) => call(id, suffix, signal);
  return client;
}

/**
 * Per-session event listener for a shared-GUI mode other than Double. It registers no tool:
 * shared_gui_chat owns connection, status and retry-ack. Receipt rules match Double sessions.
 *
 * The mode supplies:
 *   mode, label, messageType, attemptType, statusType, receiptKey, actionPrefix
 *   statuses                  saved view statuses that the listener accepts
 *   kinds                     event kinds that the listener accepts
 *   recoveryKinds             attempt-bound kinds: a historical one that was never sent needs explicit recovery
 *   holdKinds                 optional: a historical one that was never sent is held until the owner releases it;
 *                             the envelope's `releases` name the released event IDs, and each release sends a held event once
 *   running(view)             { requestId, attemptId } of the running attempt, or null
 *   recoveryMessage           status text for a running attempt that an earlier connection owned
 *   activeEvent(event, view)  true while the event still asks for work or delivery now
 *   prepare(record, packet)   optional: complete the packet (for example a final output) before the receipt
 *   message(packet, receipt)  the custom message that carries the packet
 */
export function installModeChat(pi, spec, {
  clientFactory, pollMs = 250, deliveryTimeoutMs = 30000, acceptanceCheckMs = 100, receiptIO,
} = {}) {
  let current, epoch = 0;
  const records = new Map();
  function live(record) {
    const owner = record.owner ?? record;
    return current && records.get(owner.sessionId) === owner && owner.epoch === epoch &&
      !record.controller.signal.aborted && !owner.controller.signal.aborted &&
      same(identity(current), owner.origin) && same(identity(owner.ctx), owner.origin);
  }
  const verifier = createReceiptVerifier({ runtime: pi, live, deliveryTimeoutMs, acceptanceCheckMs, receiptIO });
  function stop(record, status) {
    record.status = status;
    record.controller.abort();
    clearTimeout(record.timer);
  }
  function stopAll() {
    for (const record of records.values()) stop(record, "disconnected");
    current = undefined;
    epoch++;
  }
  pi.on("session_start", (_event, ctx) => { stopAll(); records.clear(); current = ctx; });
  pi.on("session_shutdown", stopAll);
  for (const name of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
    pi.on(name, () => { for (const record of records.values()) stop(record, "disconnected"); });
  }
  function status(record) {
    return { mode: spec.mode, sessionId: record.sessionId, piSessionId: record.origin.sessionId, piSessionFile: record.origin.sessionFile,
      archiveId: record.client.archiveId, stateId: record.client.stateId,
      status: live(record) ? (record.recoveryRequired ? "recovery_required" : record.status) : record.status === "waiting" ? "disconnected" : record.status,
      active: Boolean(live(record)), recoveryRequired: record.recoveryRequired ?? null,
      events: [...record.deliveries.values()].map((item) => ({ eventId: item.event.id, kind: item.event.kind,
        requestId: item.event.payload.requestId ?? null, attemptId: item.event.payload.attemptId ?? null,
        status: item.status, actionId: item.receipt?.actionId ?? null,
        delivery: item.accepted ? "persisted-session-entry-observed" : "not-confirmed",
        acknowledgment: item.acknowledgment ?? "not-attempted" })) };
  }
  function notice(record) {
    if (!live(record)) return;
    try { pi.sendMessage({ customType: spec.statusType, display: true, content: JSON.stringify(status(record)) }, { triggerTurn: false }); }
    catch { /* Explicit status stays available; notices never request generation. */ }
  }
  async function readView(record) {
    const view = (await record.client.view(record.sessionId, record.controller.signal))?.view;
    if (!live(record)) throw new Error("Listener cancelled.");
    if (view?.sessionId !== record.sessionId || view.mode !== spec.mode || !spec.statuses.includes(view.status)) {
      throw new Error(`Invalid ${spec.label} view.`);
    }
    if (!same(view.gui?.origin, { piSessionId: record.origin.sessionId, piSessionFile: record.origin.sessionFile })) {
      throw new Error("The shared GUI belongs to another Pi conversation.");
    }
    return view;
  }
  async function prepare(record, event) {
    const packet = { origin: { piSessionId: record.origin.sessionId, piSessionFile: record.origin.sessionFile,
      archiveId: record.client.archiveId, stateId: record.client.stateId }, event };
    await spec.prepare?.(record, packet);
    if (!live(record)) throw new Error("Listener cancelled.");
    const item = { owner: record, event, ctx: record.ctx, origin: record.origin, controller: record.controller, status: "delivering", accepted: false };
    item.receipt = { ...record.origin, [spec.receiptKey]: record.sessionId, eventId: event.id, archiveId: record.client.archiveId,
      stateId: record.client.stateId, packetHash: hash(JSON.stringify(packet)),
      actionId: spec.actionPrefix + hash(JSON.stringify([record.origin, record.client.archiveId, record.client.stateId, record.sessionId, event.id])) };
    item.message = spec.message(packet, item.receipt);
    return item;
  }
  async function confirmAndAck(item, work) {
    const proof = await verifier.confirmReceipt(item, work);
    if (!live(item)) return;
    if (!proof) { item.status = "failed_delivery"; notice(item.owner); return; }
    try { verifier.checkWork(item, work, proof.leaf); }
    catch { item.status = "failed_delivery"; notice(item.owner); return; }
    try {
      item.accepted = true; item.status = "acknowledging"; item.acknowledgment = "pending";
      const answer = await item.owner.client.acknowledge(item.owner.sessionId, { actionId: item.receipt.actionId, eventId: item.event.id }, item.controller.signal);
      if (!live(item)) return;
      if (answer?.result?.kind !== "ack" || answer.result.eventId !== item.event.id || answer.result.actionId !== item.receipt.actionId ||
          answer.view?.sessionId !== item.owner.sessionId) throw new Error("Invalid receipt answer.");
      item.status = "received"; item.acknowledgment = "confirmed";
    } catch {
      if (!live(item)) return;
      item.status = "ack_pending"; item.acknowledgment = "uncertain-retry-same-action";
      notice(item.owner);
    }
  }
  async function deliver(record, event, historical) {
    // Reserve the event before output reads or receipt work. Later events are independent.
    const placeholder = { event, status: "preparing", accepted: false };
    record.deliveries.set(event.id, placeholder);
    let item = placeholder;
    try {
      item = await prepare(record, event);
      if (!live(record)) return;
      record.deliveries.set(event.id, item);
      const work = verifier.receiptWork(item);
      const entries = record.ctx.sessionManager.getEntries();
      if (entries.length > RECEIPT_LIMITS.entries) throw new Error("Session exceeds receipt limits.");
      const known = verifier.receiptIndex(item, verifier.branchFor(item)) >= 0;
      const attempted = entries.some((entry) => entry.type === "custom" && entry.customType === spec.attemptType && entry.data?.actionId === item.receipt.actionId);
      if (historical && spec.recoveryKinds.includes(event.kind) && !known && !attempted) { item.status = "recovery_required"; return; }
      // Never queued across a reconnection: a request that was never sent waits for the owner's explicit release.
      if (historical && spec.holdKinds?.includes(event.kind) && !known && !attempted) { item.status = "held"; return; }
      if (!known && !attempted) {
        const view = await readView(record);
        verifier.checkWork(item, work);
        if (!spec.activeEvent(event, view)) { item.status = "obsolete"; return; }
        // The complete packet stays archived; an oversized one is never shortened or acknowledged.
        if (Buffer.byteLength(JSON.stringify(item.message)) + 1024 > RECEIPT_LIMITS.lineBytes) {
          item.status = "oversized_output";
          notice(record);
          return;
        }
        pi.appendEntry(spec.attemptType, item.receipt);
        pi.sendMessage(item.message, { triggerTurn: true, deliverAs: "followUp" });
      }
      await confirmAndAck(item, work);
    } catch {
      if (!live(record)) return;
      item.status = "failed_delivery";
      notice(record);
    }
  }
  async function observe(record, envelope, historical = false) {
    if (!Array.isArray(envelope?.events) || !Array.isArray(envelope.acknowledgments)) throw new Error("Invalid event envelope.");
    const view = await readView(record);
    const acknowledged = new Set(envelope.acknowledgments.map((entry) => entry.eventId));
    const running = spec.running(view);
    if (record.recoveryRequired && running?.attemptId !== record.recoveryRequired.attemptId) record.recoveryRequired = null;
    if (historical && running) record.recoveryRequired = { eventId: null, ...running, message: spec.recoveryMessage };
    // Releases saved before this listener started never send anything. A later release frees the held events that it names.
    const releases = Array.isArray(envelope.releases) ? envelope.releases : [];
    if (!record.released) record.released = new Set(releases.map((release) => release.actionId));
    for (const release of releases) {
      if (record.released.has(release.actionId)) continue;
      record.released.add(release.actionId);
      for (const eventId of release.eventIds ?? []) if (record.deliveries.get(eventId)?.status === "held") record.deliveries.delete(eventId);
    }
    for (const event of envelope.events) {
      if (!live(record)) return;
      if (event?.sessionId !== record.sessionId || !spec.kinds.includes(event.kind) || !event.payload) throw new Error("Invalid session event.");
      encodeDoubleComparisonId(event.id);
      const active = spec.activeEvent(event, view);
      const recovering = spec.recoveryKinds.includes(event.kind) && record.recoveryRequired?.attemptId === event.payload.attemptId;
      if (recovering) record.recoveryRequired.eventId = event.id;
      if (record.deliveries.has(event.id)) continue;
      if (acknowledged.has(event.id)) {
        record.deliveries.set(event.id, { event, status: "already_acknowledged", accepted: false, acknowledgment: "preexisting-not-proof-of-this-pi-session" });
        continue;
      }
      // Old events can recover exact receipts, but never start historical generation.
      if (active || historical) void deliver(record, event, historical || recovering || !active);
    }
  }
  async function run(record) {
    try {
      while (live(record)) {
        await delay(pollMs, undefined, { signal: record.controller.signal });
        const envelope = await record.client.events(record.sessionId, record.controller.signal);
        if (live(record)) await observe(record, envelope);
      }
    } catch {
      if (live(record)) { notice(record); stop(record, "disconnected"); }
    }
  }
  async function start(params, ctx, ownership) {
    if (!current || !same(identity(ctx), identity(current)) || !["tui", "rpc"].includes(ctx.mode) || !identity(ctx).sessionFile) {
      throw new Error(`${spec.label} requires the active persistent TUI or RPC Pi session.`);
    }
    const { sessionId } = params;
    encodeDoubleComparisonId(sessionId);
    const prior = records.get(sessionId);
    if (prior && live(prior)) throw new Error(`A ${spec.label} session listener is already active.`);
    const seconds = params.timeoutSeconds ?? 240;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("timeoutSeconds must be greater than zero and at most 3600.");
    const record = { sessionId, origin: identity(ctx), ctx, epoch, client: clientFactory(), controller: new AbortController(), status: "arming", deliveries: new Map() };
    records.set(sessionId, record);
    record.timer = setTimeout(() => { record.status = "timeout"; notice(record); stop(record, "timeout"); }, seconds * 1000);
    try {
      // Publish only the acquired record, synchronously before startup can yield.
      ownership?.acquired({ cancel() { if (records.get(sessionId) === record) stop(record, "cancelled"); }, status: () => status(record) });
      await record.client.connect(record.controller.signal);
      if (!live(record)) return status(record);
      const envelope = await record.client.events(sessionId, record.controller.signal);
      if (!live(record)) return status(record);
      await observe(record, envelope, !ownership?.fresh);
      if (!live(record)) return status(record);
      record.status = "waiting";
      record.task = run(record);
    } catch {
      if (live(record)) stop(record, "disconnected");
    }
    return status(record);
  }
  async function retryAck(sessionId, eventId) {
    const prior = records.get(sessionId), item = prior?.deliveries.get(eventId);
    if (!prior || !live(prior) || !item?.receipt || !["failed_delivery", "ack_pending", "received"].includes(item.status)) {
      throw new Error("Reconnect if needed, then retry-ack the exact recoverable event. Never resend it.");
    }
    item.status = "delivering"; item.accepted = false; item.receiptLimit = false; item.missingEvidence = undefined;
    await confirmAndAck(item, verifier.receiptWork(item));
    return status(prior);
  }
  return {
    startOwned(params, ctx, acquired, fresh = false) {
      return start({ sessionId: params.sessionId ?? params.doubleSessionId, timeoutSeconds: params.timeoutSeconds }, ctx, { acquired, fresh });
    },
    retryAck,
  };
}
