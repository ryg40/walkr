import fs from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { SERVER_PROTOCOL } from "./paths.js";
import { privatePath, serverRecord } from "./double-client.js";
import { canonicalRoot, repoName, sessionName, trainerRoot } from "./trainer-store.js";
import { encodeDoubleComparisonId } from "./double-route.js";

const HELP = `walkr-trainer (compatibility: walkr trainer)
  serve                                        Run a foreground loopback server on an ephemeral port
  create <absolute-request.json>               Submit { actionId, repo, task, items, plan }; print JSON and a private URL
  list <repo>                                  List saved sessions of a repository
  view <repo> <session-id>                     Print the saved record and progress as JSON
  open <repo> <session-id>                     Print a new private page URL for this server run
  review <repo> <session-id>                   Print the current plan revision and the owner's review
  plan <repo> <session-id> <absolute-request.json>
                                               Submit { actionId, plan } after the owner requests changes
  wait <repo> <session-id> --for review|analysis [--timeout <seconds>]
                                               Wait for a plan review or a pending analysis (default 240, max 3600)
  analysis pending <repo> <session-id>         Print saved votes that need model analysis
  analysis submit <repo> <session-id> <absolute-request.json>
                                               { actionId, groupId, voteSha256, model, preferred, lowest }
  analysis fail <repo> <session-id> <absolute-request.json>
                                               { actionId, groupId, voteSha256, error, model? }; retry later
  gui view <gui-session-id>                    Print a shared-GUI Trainer start: status, preparation request, linked dataset
  gui fail <gui-session-id> <absolute-request.json>
                                               { actionId, requestId, attemptId, message }; the owner selects Retry or End

Requires an explicit absolute HUMAN_REVIEW_STATE_DIR. Datasets are saved under
HUMAN_REVIEW_TRAINER_ROOT, default ~/.local/.walkr/trainer, as
<root>/<repo-name>/dataset/<timestamped-session-id>/dataset.json.
Only the owner's private page records plan reviews and votes. Agent commands cannot call
review or save. Relay the page URL to the owner; never open it or vote.
Retry an uncertain request with the exact same file and action ID.
A shared-GUI start names its link in the woken chat's packet: add it unchanged as the gui field
of the create request. The GUI then shows the page; do not relay the URL. The gui commands need
the shared GUI server (walkr double serve) with the same dataset root.
Client commands never start or replace a server. Trainer is local-only; hosted Trainer is not available.
No Jira access, upload, or model training happens here. No browser opens automatically.
Modes: walkr-core, walkr-double, walkr-coinflip, walkr-trainer.
`;
const fail = (message) => { throw new Error(message); };
const stdout = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const json = (value) => stdout(`${JSON.stringify(value)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function configuration(env = process.env) {
  if (env.HUMAN_REVIEW_HOSTED === "1") fail("Trainer is not available in hosted mode.");
  const stateDir = env.HUMAN_REVIEW_STATE_DIR;
  try { canonicalRoot(stateDir); } catch { fail("Trainer requires an explicit canonical absolute HUMAN_REVIEW_STATE_DIR."); }
  const root = trainerRoot(env);
  try { canonicalRoot(root); } catch { fail("HUMAN_REVIEW_TRAINER_ROOT must be a canonical absolute directory."); }
  if (stateDir === root || stateDir.startsWith(`${root}/`) || root.startsWith(`${stateDir}/`)) {
    fail("Trainer state and dataset root must be separate, not nested.");
  }
  return { stateDir, root };
}

function parse(args) {
  const [command, ...rest] = args;
  const pair = (a, b) => [repoName(a), sessionName(b)];
  const file = (value) => { if (!path.isAbsolute(value || "")) fail("Supply an absolute JSON request file."); return value; };
  if (command === "serve" && !rest.length) return { command };
  if (command === "create" && rest.length === 1) return { command, input: file(rest[0]) };
  if (command === "list" && rest.length === 1) return { command, repo: repoName(rest[0]) };
  if (["view", "open", "review"].includes(command) && rest.length === 2) return { command, ids: pair(...rest) };
  if (command === "plan" && rest.length === 3) return { command, ids: pair(rest[0], rest[1]), input: file(rest[2]) };
  if (command === "wait" && [4, 6].includes(rest.length) && rest[2] === "--for" && ["review", "analysis"].includes(rest[3]) &&
      (rest.length === 4 || rest[4] === "--timeout")) {
    const seconds = rest.length === 4 ? 240 : Number(rest[5]);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) fail("--timeout requires seconds greater than zero and at most 3600.");
    return { command, ids: pair(rest[0], rest[1]), wait: rest[3], seconds };
  }
  if (command === "analysis" && rest[0] === "pending" && rest.length === 3) return { command, operation: "pending", ids: pair(rest[1], rest[2]) };
  if (command === "analysis" && ["submit", "fail"].includes(rest[0]) && rest.length === 4) {
    return { command, operation: rest[0], ids: pair(rest[1], rest[2]), input: file(rest[3]) };
  }
  if (command === "gui" && (rest[0] === "view" && rest.length === 2 || rest[0] === "fail" && rest.length === 3)) {
    if (!/^trainer-[a-f0-9]{64}$/.test(rest[1])) fail("Supply a shared-GUI Trainer session ID (trainer-<64 hex>).");
    return { command, operation: rest[0], gui: rest[1], ...(rest[0] === "fail" ? { input: file(rest[2]) } : {}) };
  }
  fail("Invalid Trainer arguments. Use walkr-trainer --help.");
}

function request(server, route, { method = "GET", body, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    // An absolute route is a shared-GUI Trainer route; others are Trainer API routes.
    const req = http.request({ host: "127.0.0.1", port: server.port, path: route.startsWith("/") ? route : `/_walkr/trainer/api/${route}`, method,
      headers: { "x-human-review-token": server.token, "content-type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", () => reject(new Error("Trainer response ended early. Retry mutations with the exact original request.")));
      res.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new Error("The server did not return a compatible Trainer JSON response.")); }
        if (res.statusCode !== 200) {
          const code = /^[A-Z_]+$/.test(value?.error?.code) ? value.error.code : `HTTP_${res.statusCode}`;
          const message = typeof value?.error?.message === "string" ? ` ${value.error.message.slice(0, 300)}` : "";
          return reject(new Error(`Trainer ${code}.${message}`));
        }
        resolve(value);
      });
    });
    const timer = setTimeout(() => req.destroy(), timeout);
    req.once("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("The Trainer server is unavailable. No service was started or replaced. Retry mutations with the exact original request.")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { fail("Cannot read the JSON request. Supply an absolute readable file path."); }
}

async function serve({ stateDir }) {
  try { await fs.mkdir(stateDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") fail("Cannot create the Trainer state directory."); }
  await privatePath(stateDir, true);
  if ((await fs.readdir(stateDir)).length) fail("Trainer serve requires an empty state directory. Existing files stay untouched.");
  const lock = path.join(stateDir, "server.lock");
  const recordPath = path.join(stateDir, "server.json");
  let handle;
  try { handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail("A server lock already exists or is unavailable. Trainer serve never replaces it."); }
  let service, record;
  try {
    await handle.writeFile(String(process.pid));
    await handle.close();
    handle = null;
    const { createServer } = await import("./server.js");
    service = createServer();
    await new Promise((resolve, reject) => {
      service.server.once("error", reject);
      service.server.listen(0, "127.0.0.1", resolve);
    });
    record = JSON.stringify({ port: service.server.address().port, pid: process.pid, token: service.token, protocol: SERVER_PROTOCOL });
    await fs.writeFile(recordPath, record, { flag: "wx", mode: 0o600 });
    await json({ status: "listening", port: service.server.address().port });
    await new Promise((resolve) => {
      const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
      service.server.once("close", done);
    });
  } finally {
    await handle?.close();
    if (service) { service.dispose(); service.server.closeAllConnections(); }
    // Remove only the credentials and lock of this foreground run. Datasets are never touched.
    if (record && await fs.readFile(recordPath, "utf8").catch(() => null) === record) await fs.unlink(recordPath);
    if (await fs.readFile(lock, "utf8").catch(() => null) === String(process.pid)) await fs.unlink(lock);
  }
}

export async function runTrainer(args) {
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return stdout(HELP);
  const config = configuration();
  const options = parse(args);
  if (options.command === "serve") return serve(config);
  let server;
  try { server = await serverRecord(config.stateDir); }
  catch { fail("No compatible private server record. Run walkr-trainer serve in an unused state directory; do not replace a running service."); }
  const capability = await request(server, "capabilities");
  if (capability.trainer !== 1 || capability.rootId !== createHash("sha256").update(config.root).digest("hex")) {
    fail("The existing server has no compatible Trainer support or uses a different dataset root. It was not replaced.");
  }
  const url = (route) => `http://127.0.0.1:${server.port}${route}`;
  const session = options.ids && `sessions/${options.ids.map(encodeURIComponent).join("/")}`;
  if (options.command === "create") {
    const answer = await request(server, "sessions", { method: "POST", body: await readJson(options.input) });
    return json({ ...answer.result, status: answer.view.status, progress: answer.view.progress, url: url(answer.path) });
  }
  if (options.command === "list") return json(await request(server, `repos/${encodeURIComponent(options.repo)}`));
  if (options.command === "view") return json((await request(server, session)).view);
  if (options.command === "open") return stdout(`${url((await request(server, `${session}/open`, { method: "POST", body: {} })).path)}\n`);
  if (options.command === "review") {
    const { view } = await request(server, session);
    const plan = view.plans.at(-1);
    return json({ status: view.status, revision: plan.revision, review: plan.review });
  }
  if (options.command === "plan") {
    const answer = await request(server, `${session}/plan`, { method: "POST", body: await readJson(options.input) });
    return json({ ...answer.result, status: answer.view.status });
  }
  if (options.command === "gui") {
    const route = `/api/double/modes/trainer/sessions/${encodeDoubleComparisonId(options.gui)}`;
    if (options.operation === "view") return json((await request(server, route)).view);
    return json((await request(server, `${route}/fail`, { method: "POST", body: await readJson(options.input) })).result);
  }
  if (options.command === "analysis") {
    if (options.operation === "pending") return json(await request(server, `${session}/analysis`));
    const answer = await request(server, `${session}/analysis/${options.operation}`, { method: "POST", body: await readJson(options.input) });
    return json(answer.result);
  }
  const deadline = Date.now() + options.seconds * 1000;
  for (;;) {
    if (options.wait === "review") {
      const { view } = await request(server, session);
      const plan = view.plans.at(-1);
      if (plan.review) return json({ status: "ready", sessionStatus: view.status, revision: plan.revision, review: plan.review });
    } else {
      const pending = await request(server, `${session}/analysis`);
      if (pending.requests.length) return json({ status: "ready", requests: pending.requests.length });
      const { view } = await request(server, session);
      if (["complete", "ended"].includes(view.status)) return json({ status: view.status, requests: 0 });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return json({ status: "timeout" });
    await pause(Math.min(500, remaining));
  }
}
