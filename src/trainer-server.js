import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DoubleStoreError, hash } from "./double-archive.js";
import { escapeHtml } from "./hosted.js";
import { TrainerStore, repoName, sessionName } from "./trainer-store.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = "/_walkr/trainer/";
const STATIC = {
  "/_walkr/trainer/app.js": ["trainer.js", "text/javascript; charset=utf-8"],
  "/_walkr/trainer/trainer-rank.js": ["trainer-rank.js", "text/javascript; charset=utf-8"],
  "/_walkr/trainer/trainer.css": ["trainer.css", "text/css; charset=utf-8"],
};
// The shared GUI frames the page from the same origin; no other origin can frame it.
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const STATUS = {
  INVALID_REQUEST: 400, INVALID_ID: 400, INVALID_PLAN: 400, DUPLICATE_SOURCE: 400, INCOMPLETE_RANKING: 400,
  UNSAFE_REPO: 400, UNSAFE_PATH: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  ACTION_CONFLICT: 409, INVALID_TRANSITION: 409, STALE_REVISION: 409, STALE_VOTE: 409, ANALYSIS_EXISTS: 409, FILE_CHANGED: 409,
  DISCONNECTED: 409, STALE_ATTEMPT: 409, READ_ONLY: 409, INVALID_SEGMENT: 400,
  UNAUTHORIZED: 401, FORBIDDEN: 403, HOSTED_UNSUPPORTED: 403, [POSIX_ONLY_CODE]: 501,
  WRITE_FAILED: 503, COMMIT_UNCERTAIN: 503, RECOVERY_REQUIRED: 503, DOUBLE_DISABLED: 503,
};
const fail = (code, message) => { throw new DoubleStoreError(code, message); };
const secret = () => randomBytes(32).toString("hex");

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

/**
 * Local-only Trainer routes under /_walkr/trainer/.
 * The agent credential submits datasets, plans, and analysis. It cannot call review or save directly;
 * only the private page credential can. The agent relays the page URL to the owner and can therefore
 * reach that credential, so this split guards against mistakes, not against a hostile or steered agent.
 * `notify` receives committed events. The shared GUI does not use it: it derives its wake-up events from the
 * durable records, so a crash between a commit and a notification cannot lose one.
 * `gui` is the shared-GUI bridge: `link(reference, create)` links a create request to the GUI start that it names,
 * and `connected()` reports the bound Pi chat. Without it, a create request that names a GUI start is refused.
 */
export function createTrainerHandler({ token, root, hosted, notify = () => {}, gui = null, platform = process.platform }) {
  let store;
  const opened = () => store ??= new TrainerStore({ root, platform });
  const bySession = new Map();
  const shells = new Map();
  const browsers = new Map();
  const key = (repo, sessionId) => `${repo}/${sessionId}`;

  function grant(repo, sessionId) {
    const existing = bySession.get(key(repo, sessionId));
    if (existing) return existing;
    const value = { repo, sessionId, shell: secret(), token: secret() };
    bySession.set(key(repo, sessionId), value);
    shells.set(value.shell, value);
    browsers.set(value.token, value);
    return value;
  }

  function emit(events) {
    for (const event of events) {
      try { notify(event); } catch {} // Delivery is advisory; the record is already durable.
    }
  }

  // A GUI-started session shows the bound chat connection, so the page can disable change requests while disconnected.
  function withConnection(view) {
    if (view.gui) view.guiConnection = Boolean(gui?.connected());
    return view;
  }

  async function handle(req, res) {
    const raw = req.url.split("?")[0];
    if (!raw.startsWith(PREFIX)) return false;
    try {
      if (hosted) fail("HOSTED_UNSUPPORTED", "Trainer is local-only. Hosted Trainer is not available.");
      const refusal = posixOnlyRefusal(platform);
      if (refusal) fail(POSIX_ONLY_CODE, refusal);
      if (req.url.includes("?") || raw.includes("#")) fail("INVALID_REQUEST", "Trainer routes do not accept query parameters or fragments.");
      opened();
      if (STATIC[raw]) {
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for static resources.");
        send(res, 200, await fs.readFile(path.join(here, STATIC[raw][0])), STATIC[raw][1]);
        return true;
      }
      if (raw.startsWith(`${PREFIX}s/`)) {
        const value = shells.get(raw.slice(`${PREFIX}s/`.length));
        if (!value) {
          fail("NOT_FOUND", "This private Trainer URL is unavailable. Use walkr-trainer open for a new one.");
        }
        if (req.method !== "GET") fail("METHOD_NOT_ALLOWED", "Use GET for the Trainer page.");
        await store.read(value.repo, value.sessionId);
        const shell = await fs.readFile(path.join(here, "trainer.html"), "utf8");
        const html = shell.replace(/__TOKEN__|__REPO__|__SESSION__/g, (placeholder) => escapeHtml(
          placeholder === "__TOKEN__" ? value.token : placeholder === "__REPO__" ? value.repo : value.sessionId));
        send(res, 200, html, "text/html; charset=utf-8", { "content-security-policy": SHELL_CSP });
        return true;
      }
      if (!raw.startsWith(`${PREFIX}api/`)) fail("NOT_FOUND", "Unknown Trainer route.");
      const provided = req.headers["x-human-review-token"];
      const agent = matches(provided, token);
      const browser = browsers.get(String(provided || ""));
      if (!agent && !browser) fail("UNAUTHORIZED", "A valid x-human-review-token header is required.");
      const route = raw.slice(`${PREFIX}api/`.length);
      const method = (expected) => { if (req.method !== expected) fail("METHOD_NOT_ALLOWED", `Use ${expected} for this operation.`); };
      const agentOnly = () => { if (!agent) fail("FORBIDDEN", "This operation requires the local agent credential."); };

      if (route === "capabilities") {
        agentOnly(); method("GET");
        send(res, 200, { trainer: 1, rootId: hash(store.root), schema: "walkr-trainer-dataset", version: 1 });
        return true;
      }
      if (route === "sessions") {
        agentOnly(); method("POST");
        const body = await readBody(req);
        let answer;
        if (body && typeof body === "object" && Object.hasOwn(body, "gui")) {
          if (!gui) fail("DOUBLE_DISABLED", "This server has no shared GUI. Create without a gui reference.");
          answer = await gui.link(body, () => store.create(body));
        } else answer = await store.create(body);
        emit(answer.events);
        const page = grant(answer.view.repo.name, answer.view.sessionId);
        send(res, 200, { result: answer.result, view: answer.view, path: `${PREFIX}s/${page.shell}` });
        return true;
      }
      const repos = route.match(/^repos\/([^/]+)$/);
      if (repos) {
        agentOnly(); method("GET");
        send(res, 200, { repo: repoName(repos[1]), sessions: await store.list(repos[1]) });
        return true;
      }
      const match = route.match(/^sessions\/([^/]+)\/([^/]+)(?:\/(open|plan|review|save|analysis|analysis\/submit|analysis\/fail))?$/);
      if (!match) fail("NOT_FOUND", "Unknown Trainer API route.");
      const repo = repoName(match[1]);
      const sessionId = sessionName(match[2]);
      const operation = match[3] || "view";
      if (browser && (browser.repo !== repo || browser.sessionId !== sessionId)) fail("FORBIDDEN", "This page credential belongs to another session.");
      const ownerOnly = ["review", "save"].includes(operation);
      if (ownerOnly && !browser) fail("FORBIDDEN", "Plan review and votes come only from the private Trainer page of the user.");
      if (!ownerOnly && operation !== "view") agentOnly();
      if (operation === "view") { method("GET"); send(res, 200, { view: withConnection(await store.read(repo, sessionId)) }); return true; }
      if (operation === "analysis") { method("GET"); send(res, 200, await store.pendingAnalysis(repo, sessionId)); return true; }
      method("POST");
      const body = await readBody(req);
      if (operation === "open") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) fail("INVALID_REQUEST", "Open expects an empty JSON object.");
        const view = await store.read(repo, sessionId);
        send(res, 200, { view, path: `${PREFIX}s/${grant(repo, sessionId).shell}` });
        return true;
      }
      if (operation === "review" && body?.decision === "request-changes") {
        // A change request wakes the bound chat, so a GUI-started session needs the connection, after the exact replay lookup.
        const saved = await store.read(repo, sessionId);
        if (saved.gui && !saved.plans.some((plan) => plan.review?.actionId === body.actionId) && !gui?.connected()) {
          fail("DISCONNECTED", "Reconnect the bound Pi chat before you request plan changes. Approving and ranking stay available.");
        }
      }
      const call = { plan: "revisePlan", review: "reviewPlan", save: "saveVote", "analysis/submit": "submitAnalysis", "analysis/fail": "failAnalysis" }[operation];
      const answer = await store[call](repo, sessionId, body);
      emit(answer.events);
      send(res, 200, { result: answer.result, view: withConnection(answer.view) });
    } catch (error) {
      const known = error instanceof DoubleStoreError;
      const code = known ? error.code : "INTERNAL_ERROR";
      const message = known ? error.message : "Trainer could not complete this request. Retry the unchanged request after checking the private server.";
      send(res, STATUS[code] || 500, { error: { code, message } });
    }
    return true;
  }
  // The shared GUI reads datasets and private page paths of this server run through the same store and grants.
  handle.service = { store: opened, page: (repo, sessionId) => `${PREFIX}s/${grant(repoName(repo), sessionName(sessionId)).shell}` };
  return handle;
}
