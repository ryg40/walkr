import { setTimeout as delay } from "node:timers/promises";
import { configuration, connectDoubleClient, request } from "./double-client.js";
import { installDoubleSessionChat } from "./double-session-chat.js";
import { installCoinflipChat } from "./coinflip-chat.js";
import { installTrainerChat } from "./trainer-chat.js";

export function installSharedGuiChat(pi, parameters, options = {}) {
  let current, connection, connecting = false, epoch = 0;
  const adapter = installDoubleSessionChat(pi, parameters, options);
  // Per-mode listeners. A saved session of a mode without a listener here is never delivered or guessed.
  const { pollMs, deliveryTimeoutMs, acceptanceCheckMs, receiptIO } = options;
  const listeners = { double: adapter, coinflip: installCoinflipChat(pi, { pollMs, deliveryTimeoutMs, acceptanceCheckMs, receiptIO, ...options.coinflip }),
    trainer: installTrainerChat(pi, { pollMs, deliveryTimeoutMs, acceptanceCheckMs, receiptIO, ...options.trainer }) };
  const origin = (ctx) => ({ piSessionId: ctx.sessionManager.getSessionId(), piSessionFile: ctx.sessionManager.getSessionFile() });
  async function stop(old = connection) {
    if (old !== connection) return;
    epoch++;
    connection = null;
    if (!old) return;
    old.controller.abort();
    clearTimeout(old.timer);
    // Cancel exact acquired records before yielding; a same-ID replacement is not ours.
    for (const listener of old.sessions.values()) listener.cancel();
    await request(old.server, "/api/double/gui/disconnect", { method: "POST", body: { leaseId: old.leaseId } }).catch(() => {});
  }
  pi.on("session_start", (_event, ctx) => { void stop(); current = ctx; });
  pi.on("session_shutdown", () => { current = null; return stop(); });
  for (const name of ["session_before_switch", "session_before_fork", "session_before_tree"]) pi.on(name, () => stop());
  function live(record) {
    return connection === record && !record.controller.signal.aborted && current &&
      JSON.stringify(origin(current)) === JSON.stringify(record.origin);
  }
  async function observe(record, state) {
    for (const item of state.history) {
      if (!live(record)) return;
      const mode = item.mode ?? "double";
      // A settled session needs no listener: a stopped Double session, a stopped Coinflip session with no result
      // or with its final packet received, or an ended Trainer session. A stopped Coinflip session can still owe its final packet.
      if (record.sessions.has(item.sessionId) || !Object.hasOwn(listeners, mode) || item.settled) continue;
      record.modes.set(item.sessionId, mode);
      const result = await listeners[mode].startOwned({ doubleSessionId: item.sessionId,
        timeoutSeconds: Math.max(0.001, (record.deadline - Date.now()) / 1000) }, record.ctx,
        (listener) => record.sessions.set(item.sessionId, listener), item.leaseId === record.leaseId);
      if (!live(record)) return;
      // The listener timeout is this connection's deadline. If it fires before the connection timer, the connection expired: cancel, not a failure.
      if (!result.active && result.status === "timeout") { await stop(record); return; }
      if (!result.active) throw new Error("Session listener could not start.");
    }
  }
  async function status(record = connection) {
    if (!record || !live(record)) return { active: false, status: "disconnected" };
    const sessions = [];
    for (const listener of record.sessions.values()) {
      sessions.push(await listener.status());
      if (!live(record)) return { active: false, status: "disconnected" };
    }
    return { active: true, status: "connected", origin: record.origin, path: record.path, sessions };
  }
  async function execute(params, ctx) {
    if (params.action === "status") return status();
    if (params.action === "disconnect") { const record = connection; await stop(record); return status(record); }
    if (params.action === "retry-ack") {
      if (!connection) throw new Error("Explicitly reconnect first.");
      const sessionId = params.sessionId ?? params.doubleSessionId;
      const mode = connection.modes.get(sessionId);
      if (mode && mode !== "double") return listeners[mode].retryAck(sessionId, params.eventId);
      return adapter.execute({ ...params, action: "retry-ack", doubleSessionId: sessionId }, ctx);
    }
    if (params.action !== "connect" || !current || !["tui", "rpc"].includes(ctx.mode) || !origin(ctx).piSessionFile ||
        JSON.stringify(origin(ctx)) !== JSON.stringify(origin(current))) throw new Error("Explicit connection requires the current persistent TUI or RPC chat.");
    if (connection || connecting) throw new Error("Disconnect before reconnecting.");
    const seconds = params.timeoutSeconds ?? 240;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("timeoutSeconds must be positive and at most 3600.");
    const config = configuration(), capturedOrigin = origin(ctx), capturedEpoch = epoch;
    connecting = true;
    let server, state;
    try {
      ({ server } = await connectDoubleClient(config, { sessions: true }));
      if (capturedEpoch !== epoch || !current || JSON.stringify(origin(current)) !== JSON.stringify(capturedOrigin)) throw new Error("Pi session changed before connection.");
      state = await request(server, "/api/double/gui/connect", { method: "POST", body: capturedOrigin });
      if (capturedEpoch !== epoch || !current || JSON.stringify(origin(current)) !== JSON.stringify(capturedOrigin)) {
        await request(server, "/api/double/gui/disconnect", { method: "POST", body: { leaseId: state.leaseId } }).catch(() => {});
        throw new Error("Pi session changed during connection. Explicitly reconnect.");
      }
    } finally { connecting = false; }
    const record = { ctx, origin: origin(ctx), server, leaseId: state.leaseId, path: `http://127.0.0.1:${server.port}${state.path}`,
      controller: new AbortController(), sessions: new Map(), modes: new Map(), deadline: Date.now() + seconds * 1000 };
    connection = record;
    record.timer = setTimeout(() => { void stop(record); }, seconds * 1000);
    try {
      await observe(record, state);
      if (!live(record)) { await stop(record); return status(record); }
      record.task = (async () => {
        try {
          while (live(record)) {
            await delay(options.pollMs ?? 1000, undefined, { signal: record.controller.signal });
            if (!live(record)) break;
            const report = await status(record);
            if (!live(record)) break;
            if (report.sessions?.some((s) => !s.active)) throw new Error("A session listener disconnected.");
            const failures = (report.sessions ?? []).flatMap((s) => s.events.filter((e) =>
              ["oversized_output", "failed_delivery", "ack_pending", "held"].includes(e.status)).map((e) => ({ sessionId: s.doubleSessionId ?? s.sessionId, status: e.status })));
            const state = await request(server, "/api/double/gui/heartbeat", { method: "POST", body: { leaseId: record.leaseId, failures }, signal: record.controller.signal });
            if (live(record)) await observe(record, state);
          }
        } catch { await stop(record); }
      })();
    } catch {
      const cancelled = !live(record);
      await stop(record);
      if (cancelled) return status(record);
      throw new Error("GUI listener failed. Explicitly reconnect and recover saved work.");
    }
    return status(record);
  }
  pi.registerTool({ name: "shared_gui_chat", label: "Shared review GUI",
    description: "Explicitly connect this persistent Pi chat to the private shared review GUI (Double, Coinflip, and Training), inspect connection, disconnect, or retry an exact event receipt. Never choose a destination from prompt content.", parameters,
    async execute(_id, params, _signal, _update, ctx) {
      const result = await execute(params, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    } });
  pi.registerCommand("shared-gui", { description: 'Explicit connection JSON: {"action":"connect|status|disconnect|retry-ack","timeoutSeconds":240,"sessionId":"...","eventId":"..."}',
    async handler(args, ctx) {
      let result;
      try { result = await execute(JSON.parse(args), ctx); }
      catch (error) { result = { active: false, status: "connection_failed", message: error.message }; }
      if (current === ctx || current && JSON.stringify(origin(current)) === JSON.stringify(origin(ctx))) {
        pi.sendMessage({ customType: "shared-gui-command-v1", content: JSON.stringify(result), display: true }, { triggerTurn: false });
      }
    } });
  return { execute, stop };
}
