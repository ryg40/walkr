import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DoubleStore, DoubleStoreError } from "./double-store.js";
import { DoubleSessionStore } from "./double-session.js";
import { SharedGuiStore } from "./shared-gui.js";
import { createSharedGuiModes, SHARED_GUI_MODE_ASSETS, SHARED_GUI_MODE_PANELS } from "./shared-gui-modes.js";
import { decodeDoubleComparisonId } from "./double-route.js";
import { checkedCopies, injectDouble } from "./double-copies.js";
import { escapeHtml } from "./hosted.js";
import { overlaps } from "./canonical-path.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PANES = ["left", "right"];
const STATIC = new Set(["/double.js", "/double-route.js", "/double-selection.js", "/double.css", "/double-sdk.js", "/double-session-shell.js", "/shared-gui-shell.js"]);
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
};
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const STATUS = {
  INVALID_INPUT: 400, INVALID_REQUEST: 400, INVALID_ID: 400, INVALID_SEGMENT: 400,
  UNKNOWN_COMPONENT: 400, UNKNOWN_DELETION: 400, UNKNOWN_BATCH: 409,
  INVALID_TRANSITION: 409, STALE_REVISION: 409, ACTION_CONFLICT: 409, COMPARISON_EXISTS: 409,
  READ_ONLY: 409, UNSAFE_PATH: 400, FILE_CHANGED: 409, NOT_FOUND: 404,
  DISCONNECTED: 409, ACTIVE_SESSION: 409, SESSION_EXISTS: 409, STALE_COMPARISON: 409, STALE_ATTEMPT: 409, UNKNOWN_EVENT: 409, UNSUPPORTED_FINAL: 409,
  WRITE_FAILED: 503, COMMIT_UNCERTAIN: 503, RECOVERY_REQUIRED: 503,
  UNAUTHORIZED: 401, FORBIDDEN: 403, HOSTED_UNSUPPORTED: 403, DOUBLE_DISABLED: 503, METHOD_NOT_ALLOWED: 405,
  [POSIX_ONLY_CODE]: 501,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const fail = (code, message) => { throw new DoubleStoreError(code, message); };
function matches(provided, expected) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { ...HEADERS, "content-type": type, ...headers });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) fail("INVALID_REQUEST", "The JSON request exceeds 24 MiB.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_REQUEST", "Supply a JSON request body."); }
}

/** An opt-in adapter; it never calls the legacy Store or writes source/copy files. */
export function createDoubleHandler({ token, archiveDir, stateDir, hosted, trainer, platform = process.platform }) {
  const shells = new Map();
  const browsers = new Map();
  const artifacts = new Map();
  const comparisons = new Map();
  const sessionShells = new Map();
  const sessionBrowsers = new Map();
  const sessions = new Map();
  let store;
  let sessionStore, guiStore, gui, modes;
  let lease = null;
  const recovery = new Set();
  let queue = Promise.resolve();
  function serial(work) {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  }
  const connected = () => Boolean(lease && lease.expires > Date.now());
  const attemptKey = (view) => `${view.sessionId}/${view.generation?.attempt.id}`;
  // `failures` are the delivery states that the connected listener last reported, including requests it holds.
  const modeState = { connected: () => connected(), recovery, failures: () => connected() ? lease.failures ?? [] : [] };
  async function guiView() {
    const state = await guiStore.read();
    const id = state.currentSessionId;
    const view = !id ? null : state.currentMode === "double" ? await sessionView(await sessionStore.read(id)) : await modes[state.currentMode].view(id, modeState);
    return { ...state, connection: { connected: connected(), origin: state.origin }, view,
      deliveryFailures: lease?.failures ?? [],
      recoveryRequired: Boolean(view?.status === "generating" && recovery.has(attemptKey(view))) };
  }
  function guiGrant() {
    gui ??= { shell: secret(), token: secret() };
    return `/double-gui/${gui.shell}`;
  }
  async function markInterrupted() {
    const state = await guiStore.read();
    for (const item of state.history) {
      const key = modes[item.mode].running(await modes[item.mode].read(item.sessionId));
      if (key) recovery.add(key);
    }
  }

  function enabled() {
    if (hosted) fail("HOSTED_UNSUPPORTED", "Double is not available in hosted mode.");
    const refusal = posixOnlyRefusal(platform);
    if (refusal) fail(POSIX_ONLY_CODE, refusal);
    if (!archiveDir) fail("DOUBLE_DISABLED", "Double requires an explicit absolute HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR.");
    if (overlaps(stateDir, archiveDir)) {
      fail("UNSAFE_PATH", "Double archive and runtime state must be separate, not nested.");
    }
    store ??= new DoubleStore({ archiveDir });
    sessionStore ??= new DoubleSessionStore({ archiveDir, stateDir });
    modes ??= createSharedGuiModes({ archiveDir, stateDir, doubleSessions: sessionStore, trainer });
    guiStore ??= new SharedGuiStore({ archiveDir, modes });
    return store;
  }

  function separateState(input) {
    for (const pane of PANES) {
      const root = input?.panes?.[pane]?.copy?.root;
      if (typeof root === "string" && overlaps(root, stateDir)) {
        fail("UNSAFE_PATH", "Review copies must be separate from runtime state.");
      }
    }
  }

  async function session(comparisonId) {
    if (comparisons.has(comparisonId)) {
      const value = comparisons.get(comparisonId);
      await checkedCopies(value.provenance, value.pins);
      return value;
    }
    const doc = await store.snapshot(comparisonId);
    separateState(doc.manifest);
    const pins = new Map();
    await checkedCopies(doc.provenance, pins);
    const value = { comparisonId, provenance: doc.provenance, pins, shell: secret(), token: secret(), frames: {} };
    for (const pane of PANES) {
      const capability = secret();
      value.frames[pane] = `/double-artifact/${capability}/${pane}/${doc.provenance.panes[pane].copy.entry}`;
      artifacts.set(capability, { session: value, pane });
    }
    shells.set(value.shell, value);
    browsers.set(value.token, value);
    comparisons.set(comparisonId, value);
    return value;
  }

  function withFrames(view, value = comparisons.get(view.comparisonId)) {
    if (value?.comparisonId === view.comparisonId) for (const pane of PANES) view.panes[pane].frameUrl = value.frames[pane];
    return view;
  }

  async function openSession(id) {
    const doc = await sessionStore.snapshot(id);
    const round = doc.rounds.at(-1)?.comparison;
    const existing = sessions.get(id);
    if (!round) {
      const value = existing || { sessionId: id, shell: secret(), token: secret() };
      sessions.set(id, value);
      sessionShells.set(value.shell, value);
      sessionBrowsers.set(value.token, value);
      return value;
    }
    if (existing?.pair?.comparisonId === round.comparisonId) {
      await checkedCopies(existing.pair.provenance, existing.pair.pins);
      return existing;
    }
    const pins = new Map();
    await checkedCopies(round.provenance, pins);
    const value = existing || { sessionId: id, shell: secret(), token: secret() };
    const pair = { comparisonId: round.comparisonId, sessionId: id, provenance: round.provenance, pins, frames: {} };
    for (const pane of PANES) {
      const capability = secret();
      pair.frames[pane] = `/double-artifact/${capability}/${pane}/${round.provenance.panes[pane].copy.entry}`;
      artifacts.set(capability, { session: pair, pane });
    }
    value.pair = pair;
    sessions.set(id, value);
    sessionShells.set(value.shell, value);
    sessionBrowsers.set(value.token, value);
    return value;
  }

  async function sessionView(view) {
    if (view.gui) {
      view.guiConnection = connected();
      view.recoveryRequired = recovery.has(attemptKey(view)) && view.status === "generating";
    }
    // Saving never depends on frame delivery. A checked-copy failure cannot undo an owner receipt.
    if (sessions.has(view.sessionId) && view.comparison) {
      try { withFrames(view.comparison, (await openSession(view.sessionId)).pair); }
      catch (error) { view.frameError = { code: error.code || "FILE_CHANGED", message: "Restore the checked copies, then explicitly reopen." }; }
    }
    return view;
  }

  async function handle(req, res) {
    // Never normalize or decode the path before matching the prefixed segment.
    const raw = req.url.split("?")[0];
    if (!/^\/(?:api\/double|double|double-session|double-artifact|double-gui|walkr-mode)(?:\/|$)/.test(raw) && !STATIC.has(raw) && !SHARED_GUI_MODE_ASSETS.has(raw)) return false;
    try {
      const isApi = raw === "/api/double" || raw.startsWith("/api/double/");
      const provided = req.headers["x-human-review-token"];
      const agent = matches(provided, token);
      const browser = browsers.get(String(provided || ""));
      const sessionBrowser = sessionBrowsers.get(String(provided || ""));
      const guiBrowser = gui && matches(provided, gui.token);
      if (isApi && !agent && !browser && !sessionBrowser && !guiBrowser) fail("UNAUTHORIZED", "A valid x-human-review-token header is required.");
      enabled();
      if (req.url.includes("?") || raw.includes("#")) fail("INVALID_REQUEST", "Double routes do not accept query parameters or fragments.");

      // Registered shared-GUI modes own their API, frame, and static routes; Double keeps the routes below.
      const modeContext = { ...modeState, agent, guiBrowser, serial, readBody, send };
      for (const mode of Object.values(modes)) if (mode.route && await mode.route(raw, req, res, modeContext)) return true;
      if (STATIC.has(raw) || SHARED_GUI_MODE_ASSETS.has(raw)) {
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for static resources.");
        send(res, 200, await fs.readFile(path.join(here, raw.slice(1))), MIME[path.extname(raw)]);
        return true;
      }
      if (raw.startsWith("/double-gui/")) {
        if (!gui || raw !== `/double-gui/${gui.shell}`) fail("NOT_FOUND", "Explicitly reconnect Pi to obtain a private GUI URL.");
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for the GUI.");
        const shell = await fs.readFile(path.join(here, "double-session-shell.html"), "utf8");
        const choices = Object.values(modes).map((mode, index) => `<label><input type="radio" name="guiMode" value="${mode.name}"${index ? "" : " checked"}> ${mode.label}</label>`).join("");
        const panels = (await Promise.all(SHARED_GUI_MODE_PANELS.map((file) => fs.readFile(path.join(here, file), "utf8")))).join("");
        const controls = `<section class="gui-entry" id="guiEntry"><h2 id="guiHeading">Start review</h2><p id="connectionState" role="status"></p><fieldset class="gui-mode" id="guiMode"><legend>Mode</legend>${choices}</fieldset><label for="brief" id="briefLabel">Design brief</label><textarea id="brief" rows="3"></textarea><button id="startDouble" class="btn-primary">Send to Double</button><button id="steerSend" class="btn-primary" hidden>Send instruction</button><button id="initialRetry" class="btn-primary" hidden>Retry initial generation</button><button id="initialStop" class="btn-ghost" hidden>Stop without a result</button><button id="recoverGeneration" class="btn-ghost" hidden>Mark interrupted attempt failed</button><button id="startRetry" class="btn-ghost" hidden>Resolve saved request</button><button id="guiReload" class="btn-ghost">Reload saved work</button><p id="guiStatus" role="status"></p><details><summary>Saved sessions</summary><ul id="guiHistory"></ul></details></section>${panels}`;
        const html = shell.replace('data-double-session-shell data-session="__DOUBLE_SESSION_ID__" data-token="__TOKEN__"',
          `data-shared-gui data-archive="${digest(archiveDir)}" data-token="${gui.token}"`)
          .replace('<main class="double-panes"', `${controls}<main class="double-panes"`)
          .replace('src="/double-session-shell.js"', 'src="/shared-gui-shell.js"')
          .replace('<link rel="stylesheet" href="/double.css">', `<link rel="stylesheet" href="/double.css">${[...SHARED_GUI_MODE_ASSETS].filter((file) => file.endsWith(".css")).map((file) => `<link rel="stylesheet" href="${file}">`).join("")}`);
        send(res, 200, html, MIME[".html"], { "content-security-policy": SHELL_CSP });
        return true;
      }
      if (raw === "/api/double/gui" || raw.startsWith("/api/double/gui/")) {
        const op = raw === "/api/double/gui" ? "view" : raw.slice("/api/double/gui/".length);
        if (!["view", "connect", "heartbeat", "disconnect", "start", "draft"].includes(op)) fail("NOT_FOUND", "Unknown GUI operation.");
        if (!agent && (!guiBrowser || !["view", "start", "draft"].includes(op))) fail("FORBIDDEN", "This operation requires the local agent credential.");
        if (req.method !== (op === "view" ? "GET" : "POST")) fail("METHOD_NOT_ALLOWED", "Wrong GUI request method.");
        const body = op === "view" ? null : await readBody(req);
        const answer = await serial(async () => {
          if (op === "connect") {
            const state = await guiStore.bind(body);
            if (connected()) fail("ACTIVE_SESSION", "Disconnect the existing listener before reconnecting.");
            await markInterrupted();
            lease = { id: secret(), expires: Date.now() + 5000 };
            for (const item of state.history) if (item.mode === "double") await openSession(item.sessionId).catch(() => {});
            return { ...(await guiView()), leaseId: lease.id, path: guiGrant() };
          }
          if (op === "heartbeat" || op === "disconnect") {
            if (!body || Object.keys(body).some((key) => !["leaseId", "failures"].includes(key)) || !connected() || body.leaseId !== lease.id) fail("DISCONNECTED", "The Pi connection expired. Explicitly reconnect.");
            if (op === "disconnect") { lease.expires = 0; await markInterrupted(); }
            else {
              lease.expires = Date.now() + 5000;
              lease.failures = Array.isArray(body.failures) ? body.failures.filter((item) => item && typeof item.sessionId === "string" &&
                ["oversized_output", "failed_delivery", "ack_pending", "held"].includes(item.status)).map(({ sessionId, status }) => ({ sessionId, status })) : [];
            }
          }
          if (op === "draft") {
            const result = await guiStore.draft(body);
            return { ...(await guiView()), result };
          }
          if (op === "start") {
            const result = await guiStore.start(body, lease?.id ?? null, connected());
            if (body?.mode === "double") await openSession(result.sessionId);
            return { ...(await guiView()), result };
          }
          return guiView();
        });
        send(res, 200, answer);
        return true;
      }
      if (raw.startsWith("/double-session/")) {
        const value = sessionShells.get(raw.slice("/double-session/".length));
        if (!value) fail("NOT_FOUND", "This session URL is unavailable. Use authenticated session reopen.");
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for the session shell.");
        await sessionStore.read(value.sessionId);
        // Escaped data attributes only; the shell module reads the view through the session API.
        const shell = await fs.readFile(path.join(here, "double-session-shell.html"), "utf8");
        const html = shell.replace(/__DOUBLE_SESSION_ID__|__TOKEN__/g,
          (placeholder) => escapeHtml(placeholder === "__TOKEN__" ? value.token : value.sessionId));
        send(res, 200, html, MIME[".html"], { "content-security-policy": SHELL_CSP });
        return true;
      }
      if (raw === "/api/double/sessions" || raw.startsWith("/api/double/sessions/")) {
        if (raw === "/api/double/sessions") {
          if (!agent) fail("FORBIDDEN", "Session creation requires the local agent credential.");
          if (req.method !== "POST") fail("METHOD_NOT_ALLOWED", "Use POST to create a session.");
          const input = await readBody(req);
          separateState(input?.manifest);
          const view = await sessionStore.create(input);
          const value = await openSession(view.sessionId);
          send(res, 200, { view: await sessionView(view), path: `/double-session/${value.shell}` });
          return true;
        }
        const match = raw.match(/^\/api\/double\/sessions\/(~[^/]*)(?:\/(actions|next|steer|end|reopen|events|ack|fail|retry|attach|output|stop|recover))?$/);
        if (!match) fail("NOT_FOUND", "Unknown Double session route.");
        const id = decodeDoubleComparisonId(match[1]);
        const operation = match[2] || "view";
        const savedView = await sessionStore.read(id);
        const sharedAuthority = guiBrowser && Boolean(savedView.gui);
        if (!agent && ((!sharedAuthority && sessionBrowser?.sessionId !== id) || !["view", "actions", "next", "steer", "end", "retry", "stop", "recover"].includes(operation))) {
          fail("FORBIDDEN", "This credential does not authorize that session operation.");
        }
        // The prompt box belongs to the shared GUI page: neither the agent nor a standalone session page steers.
        if (operation === "steer" && !sharedAuthority) fail("FORBIDDEN", "Prompt steering requires the shared GUI browser credential.");
        const method = ["view", "events", "output"].includes(operation) ? "GET" : "POST";
        if (req.method !== method) fail("METHOD_NOT_ALLOWED", `Use ${method} for this operation.`);
        if (operation === "view") send(res, 200, { view: await sessionView(await sessionStore.read(id)) });
        else if (operation === "events") send(res, 200, await sessionStore.events(id));
        else if (operation === "output") send(res, 200, await sessionStore.output(id));
        else if (operation === "reopen") {
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) fail("INVALID_REQUEST", "Reopen expects an empty JSON object.");
          const value = await openSession(id);
          send(res, 200, { view: await sessionView(await sessionStore.read(id)), path: `/double-session/${value.shell}` });
        } else {
          const body = await readBody(req);
          if (operation === "attach") separateState(body?.manifest);
          const answer = await serial(async () => {
            const doc = await sessionStore.snapshot(id);
            const prior = doc.receipts.some((r) => r.request.actionId === body?.actionId);
            if (doc.gui && !prior) {
              if (["next", "steer", "retry", "attach"].includes(operation) && !connected()) fail("DISCONNECTED", "Reconnect the bound Pi chat before generation.");
              if (operation === "attach" && recovery.has(attemptKey(await sessionStore.read(id)))) fail("STALE_ATTEMPT", "Interrupted work requires explicit recovery, not late attachment.");
            }
            if (operation === "recover") {
              if (!doc.gui || Object.keys(body).sort().join() !== "actionId,attemptId,requestId") fail("INVALID_REQUEST", "Recovery requires exact action, request, and attempt IDs.");
              return sessionStore.mutate(id, "fail", { ...body, message: "Interrupted generation. Explicit Retry or Stop/End is required." });
            }
            return sessionStore.mutate(id, operation === "actions" ? "act" : operation, body);
          });
          send(res, 200, { ...answer, view: await sessionView(answer.view) });
        }
        return true;
      }
      if (isApi && (sessionBrowser || guiBrowser) && !agent) fail("FORBIDDEN", "Session authority cannot access one-shot comparisons.");
      if (raw.startsWith("/double/")) {
        const value = shells.get(raw.slice("/double/".length));
        if (!value) fail("NOT_FOUND", "This private URL is unavailable. Use authenticated Double reopen after a restart.");
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for the shell.");
        await store.read(value.comparisonId);
        const shell = await fs.readFile(path.join(here, "double.html"), "utf8");
        const html = shell.replace(/__DOUBLE_COMPARISON_ID__|__TOKEN__/g,
          (placeholder) => escapeHtml(placeholder === "__TOKEN__" ? value.token : value.comparisonId));
        send(res, 200, html, MIME[".html"], { "content-security-policy": SHELL_CSP });
        return true;
      }
      if (raw.startsWith("/double-artifact/")) {
        const match = raw.match(/^\/double-artifact\/([a-f0-9]{64})\/(left|right)\/(.+)$/);
        const grant = match && artifacts.get(match[1]);
        if (!grant || grant.pane !== match[2]) fail("NOT_FOUND", "Unknown review copy.");
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for review copies.");
        const { session: value, pane } = grant;
        const copy = value.provenance.panes[pane].copy;
        if (!copy.files.some((file) => file.path === match[3])) fail("NOT_FOUND", "Unknown declared asset.");
        if (value.sessionId) await sessionStore.read(value.sessionId);
        else await store.read(value.comparisonId);
        const buffers = await checkedCopies(value.provenance, value.pins);
        const bytes = buffers.get(`${pane}/${match[3]}`);
        const origin = `http://${req.headers.host}`;
        const prefix = `${origin}/double-artifact/${match[1]}/${pane}/`;
        const csp = `default-src 'none'; sandbox allow-scripts; script-src ${origin}/double-sdk.js; style-src 'unsafe-inline' ${prefix}; img-src ${prefix}; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
        send(res, 200, match[3] === copy.entry ? injectDouble(bytes, value.comparisonId, pane) : bytes,
          MIME[path.extname(match[3]).toLowerCase()], { "content-security-policy": csp });
        return true;
      }
      if (raw === "/api/double/capabilities") {
        if (!agent) fail("FORBIDDEN", "This operation requires the local agent credential.");
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for capabilities.");
        send(res, 200, { double: 1, sessions: 1, sharedGui: 1, archiveId: digest(archiveDir), recovery: "authenticated-reopen" });
        return true;
      }
      if (raw === "/api/double") {
        if (!agent) fail("FORBIDDEN", "Creation requires the local agent credential.");
        if (req.method !== "POST") fail("METHOD_NOT_ALLOWED", "Use POST to create a comparison.");
        const input = await readBody(req);
        separateState(input);
        const view = await store.create(input);
        const value = await session(view.comparisonId);
        send(res, 200, { view: withFrames(view, value), path: `/double/${value.shell}` });
        return true;
      }
      const match = raw.match(/^\/api\/double\/(~[^/]*)(?:\/(actions|send|reopen|status|poll|ack))?$/);
      if (!match) fail("NOT_FOUND", "Unknown Double route.");
      const id = decodeDoubleComparisonId(match[1]);
      const operation = match[2] || "view";
      if (!agent && (browser.comparisonId !== id || !["view", "actions", "send"].includes(operation))) {
        fail("FORBIDDEN", "This credential does not authorize that operation or comparison.");
      }
      const method = ["view", "status", "poll"].includes(operation) ? "GET" : "POST";
      if (req.method !== method) fail("METHOD_NOT_ALLOWED", `Use ${method} for this operation.`);
      if (operation === "poll") send(res, 200, { batch: await store.poll(id) });
      else if (operation === "status") {
        const view = await store.read(id);
        send(res, 200, { comparisonId: id, revision: view.revision, status: view.status, ...view.delivery });
      } else if (operation === "view") send(res, 200, { view: withFrames(await store.read(id)) });
      else if (operation === "reopen") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) fail("INVALID_REQUEST", "Reopen expects an empty JSON object.");
        const view = await store.read(id);
        const value = await session(id);
        send(res, 200, { view: withFrames(view, value), path: `/double/${value.shell}` });
      } else {
        const methodName = { actions: "act", send: "send", ack: "acknowledge" }[operation];
        const answer = await store[methodName](id, await readBody(req));
        send(res, 200, { ...answer, view: withFrames(answer.view) });
      }
    } catch (error) {
      const known = error instanceof DoubleStoreError || error.name === "DoubleRouteError";
      const code = known ? error.code : "INTERNAL_ERROR";
      const message = known ? error.message : "Double could not complete this request. Retry the unchanged request after checking the private server.";
      send(res, STATUS[code] || 500, { error: { code, message,
        ...(error.code === "INVALID_INPUT" && error.diagnostics ? { diagnostics: error.diagnostics } : {}) } });
    }
    return true;
  }
  // The Trainer handler links GUI-started datasets here, serialized with the other shared-GUI mutations.
  handle.trainerGui = {
    link(body, create) {
      enabled();
      if (!modes.trainer) fail("DOUBLE_DISABLED", "This server has no Trainer GUI mode.");
      return serial(() => modes.trainer.link(body, create, modeState));
    },
    connected: () => connected(),
  };
  return handle;
}
