import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoinflipStore } from "./coinflip-store.js";
import { DoubleStoreError, hash } from "./double-archive.js";
import { decodeDoubleComparisonId } from "./double-route.js";

const fail = (code, message) => { throw new DoubleStoreError(code, message); };
const secret = () => randomBytes(32).toString("hex");
const API = "/api/double/modes/coinflip/sessions/";
const FRAME = "/walkr-mode/coinflip/artifact/";
// The owner's decisions need the GUI browser credential; generation work and delivery need the agent credential.
// The agent relays the private GUI URL, so this split guards against mistakes, not against a hostile or steered agent.
const OWNER_OPS = new Set(["choose", "steer", "retry", "stop", "submit", "recover"]);
const GENERATING_OPS = new Set(["choose", "steer", "retry", "attach"]);
const MIME = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" };

/** Coinflip registration for the shared GUI. Browser, agent and frame authority stay separate. */
export function createCoinflipMode({ archiveDir, stateDir }) {
  const store = new CoinflipStore({ archiveDir, stateDir });
  const frames = new Map(), grants = new Map();
  function frameUrl(sessionId, candidateId) {
    const key = `${sessionId}/${candidateId}`;
    if (!grants.has(key)) {
      const capability = secret();
      grants.set(key, capability);
      frames.set(capability, { sessionId, candidateId });
    }
    return `${FRAME}${grants.get(key)}/`;
  }
  const running = (view) => view.status === "generating" ? `${view.sessionId}/${view.generation.attempt.id}` : null;
  async function guiView(sessionId, { connected, recovery }) {
    const view = await store.read(sessionId);
    view.guiConnection = connected();
    view.recoveryRequired = Boolean(running(view) && recovery.has(running(view)));
    if (view.pair) for (const side of ["left", "right"]) {
      const c = view.pair[side];
      c.frameUrl = frameUrl(sessionId, c.candidateId) + c.archiveRef.entry;
    }
    return view;
  }

  async function route(raw, req, res, context) {
    if (raw.startsWith(FRAME)) {
      const match = raw.slice(FRAME.length).match(/^([a-f0-9]{64})\/(.+)$/);
      const grant = match && frames.get(match[1]);
      if (!grant) fail("NOT_FOUND", "Unknown candidate frame.");
      if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for candidates.");
      const { files } = await store.candidateFiles(grant.sessionId, grant.candidateId);
      const file = files.find((f) => f.path === match[2]);
      if (!file) fail("NOT_FOUND", "Unknown declared asset.");
      const origin = `http://${req.headers.host}`, prefix = `${origin}${FRAME}${match[1]}/`;
      // Archived checked bytes only. Candidates are read-only and run no scripts.
      const csp = `default-src 'none'; sandbox; style-src 'unsafe-inline' ${prefix}; img-src ${prefix}; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
      context.send(res, 200, Buffer.from(file.base64, "base64"), MIME[path.extname(file.path).toLowerCase()], { "content-security-policy": csp });
      return true;
    }
    if (!raw.startsWith(API)) return false;
    const match = raw.slice(API.length).match(/^(~[^/]*)(?:\/(choose|steer|retry|stop|submit|recover|events|output|winner|ack|fail|attach))?$/);
    if (!match) fail("NOT_FOUND", "Unknown Coinflip session route.");
    const id = decodeDoubleComparisonId(match[1]);
    const operation = match[2] || "view";
    const allowed = operation === "view" ? context.agent || context.guiBrowser : OWNER_OPS.has(operation) ? context.guiBrowser : context.agent;
    if (!allowed) fail("FORBIDDEN", "This credential does not authorize that Coinflip operation.");
    const method = ["view", "events", "output", "winner"].includes(operation) ? "GET" : "POST";
    if (req.method !== method) fail("METHOD_NOT_ALLOWED", `Use ${method} for this operation.`);
    if (operation === "view") return context.send(res, 200, { view: await guiView(id, context) }), true;
    if (operation === "events") return context.send(res, 200, await store.events(id)), true;
    if (operation === "output") return context.send(res, 200, await store.output(id)), true;
    if (operation === "winner") return context.send(res, 200, await store.winner(id)), true;
    const body = await context.readBody(req);
    const answer = await context.serial(async () => {
      const prior = await store.saved(id, body?.actionId);
      if (!prior && GENERATING_OPS.has(operation)) {
        if (!context.connected()) fail("DISCONNECTED", "Reconnect the bound Pi chat before generation.");
        const key = running(await store.read(id));
        if (operation === "attach" && key && context.recovery.has(key)) fail("STALE_ATTEMPT", "Interrupted work requires explicit recovery, not late attachment.");
      }
      if (operation === "recover") {
        if (!body || typeof body !== "object" || Object.keys(body).sort().join() !== "actionId,attemptId,requestId") fail("INVALID_REQUEST", "Recovery requires exact action, request, and attempt IDs.");
        return store.mutate(id, "fail", { ...body, message: "Interrupted generation. Explicit Retry or Stop is required." });
      }
      return store.mutate(id, operation, body);
    });
    context.send(res, 200, { result: answer.result, view: await guiView(id, context) });
    return true;
  }

  return {
    name: "coinflip", label: "Coinflip",
    sessionId: (actionId) => `coinflip-${hash(actionId)}`,
    createInitial: (input) => store.createInitial(input),
    read: (id) => store.read(id),
    terminal: (view) => view.status === "stopped",
    // Stopped without a result, or stopped with the final packet received: nothing is left to deliver.
    settled: (view) => view.status === "stopped" && (!view.result || view.delivery === "received"),
    running, view: guiView, route, store,
  };
}
