import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { encodeDoubleComparisonId } from "./double-route.js";
import { SERVER_PROTOCOL } from "./paths.js";
import { configuration, privatePath, connectDoubleClient, request } from "./double-client.js";
import { posixOnlyRefusal } from "./posix-only.js";

const HELP = `walkr-double (compatibility: human-review double)
  serve                                      Run a foreground loopback trial server on an ephemeral port
  create <absolute-manifest.json>             Validate both copies and print a private shell URL
  reopen <comparison-id>                      Recover a private shell URL from the archive
  view <comparison-id>                        Print the saved public view as JSON
  status <comparison-id>                      Print revision and receipt status as JSON
  poll <comparison-id> [--timeout <seconds>]   Print a final batch, or a timeout (default 240, maximum 3600)
  ack <comparison-id> <batch-id> --action-id <id>
                                             Record receipt, not application; reuse the exact ID on retry
  gui view                                   Read bound chat, connection, and saved GUI sessions
  session create <absolute-request.json>      Create from { sessionId, brief, manifest }; print JSON
  session <view|reopen|events|output> <session-id>
                                             Read state, recover bootstrap, receive events or final bytes
  session <actions|next|end|ack|fail|retry|attach> <session-id> <absolute-request.json>
                                             Submit the exact saved request; never generate IDs on retry

Requires explicit absolute HUMAN_REVIEW_STATE_DIR and HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR.
Double never starts, replaces, or restarts a service from a client command.
Serve refuses existing records and locks. After a crash, use a fresh state directory with the same archive.
No browser is opened automatically. Keep private URLs private.
Hosted operations remain disabled. Managed host walkr-double refuses execution;
use node /absolute/checkout/src/walkr-double.js for approved local operations.
Launching this CLI does not launch a chat, load an extension, or request inference.
For the shared GUI, separately approve and load integrations/pi/shared-gui.ts in the
originating persistent Pi chat, then explicitly run /shared-gui {"action":"connect"}.
Use only the returned private URL. A menu page cannot inspect or restore that connection.
Reconnect explicitly in that same chat; there is no automatic reconnect.
Modes: walkr-core, walkr-double, walkr-coinflip, walkr-trainer.
Coinflip runs in the local shared GUI (walkr-coinflip --help).
walkr-trainer --help explains local Trainer dataset ranking; Training also starts from the shared GUI.
`;
const fail = (message) => { throw new Error(message); };
const stdout = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const json = (value) => stdout(`${JSON.stringify(value)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(args) {
  const [command, ...rest] = args;
  if (command === "gui" && rest.length === 1 && rest[0] === "view") return { command };
  if (command === "session") {
    const [operation, ...parts] = rest;
    if (operation === "create" && parts.length === 1 && path.isAbsolute(parts[0])) return { command, operation, input: parts[0] };
    if (["view", "reopen", "events", "output"].includes(operation) && parts.length === 1) {
      return { command, operation, segment: encodeDoubleComparisonId(parts[0]) };
    }
    if (["actions", "next", "end", "ack", "fail", "retry", "attach", "stop", "recover"].includes(operation) && parts.length === 2 && path.isAbsolute(parts[1])) {
      return { command, operation, segment: encodeDoubleComparisonId(parts[0]), input: parts[1] };
    }
    fail("Invalid Double session arguments. Use human-review double --help.");
  }
  if (command === "serve" && rest.length === 0) return { command };
  if (command === "create" && rest.length === 1 && path.isAbsolute(rest[0])) return { command, manifest: rest[0] };
  if (["reopen", "view", "status"].includes(command) && rest.length === 1) {
    return { command, segment: encodeDoubleComparisonId(rest[0]) };
  }
  if (command === "poll" && (rest.length === 1 || rest.length === 3 && rest[1] === "--timeout")) {
    const seconds = rest.length === 1 ? 240 : Number(rest[2]);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) fail("--timeout requires seconds greater than zero and at most 3600.");
    return { command, segment: encodeDoubleComparisonId(rest[0]), seconds };
  }
  if (command === "ack" && rest.length === 4 && rest[2] === "--action-id") {
    encodeDoubleComparisonId(rest[1]);
    encodeDoubleComparisonId(rest[3]);
    return { command, segment: encodeDoubleComparisonId(rest[0]), batchId: rest[1], actionId: rest[3] };
  }
  fail("Invalid Double arguments. Use human-review double --help. Ack requires an exact batch ID and --action-id.");
}

async function serve({ stateDir }) {
  // Never call legacy start(): its old-protocol replacement is not authorized here.
  try { await fs.mkdir(stateDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") fail("Cannot create the disposable Double state directory."); }
  await privatePath(stateDir, true);
  const lock = path.join(stateDir, "server.lock");
  const recordPath = path.join(stateDir, "server.json");
  try { await fs.lstat(recordPath); fail("A server record already exists. Double serve never replaces it; use an unused state directory."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if ((await fs.readdir(stateDir)).length) fail("Double serve requires an empty disposable state directory. Existing feedback and files stay untouched.");
  let handle;
  try { handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail("A server lock already exists or is unavailable. Double serve never replaces it."); }
  let service;
  let record;
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
    // Remove only credentials and the lock created by this foreground invocation.
    if (record && await fs.readFile(recordPath, "utf8").catch(() => null) === record) await fs.unlink(recordPath);
    if (await fs.readFile(lock, "utf8").catch(() => null) === String(process.pid)) await fs.unlink(lock);
  }
}

export async function runDouble(args) {
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return stdout(HELP);
  const refusal = posixOnlyRefusal(); // Before hosted, argument and path checks; help stays available.
  if (refusal) fail(refusal);
  const config = configuration(); // Hosted rejection precedes even manifest argument/path access.
  const options = parse(args);
  if (options.command === "serve") return serve(config);
  const { server } = await connectDoubleClient(config, { sessions: options.command === "session" });
  if (options.command === "gui") return json(await request(server, "/api/double/gui"));
  if (options.command === "session") {
    let body;
    if (options.input) {
      try { body = JSON.parse(await fs.readFile(options.input, "utf8")); }
      catch { fail("Cannot read the JSON session request. Supply an absolute readable file path."); }
    }
    const root = "/api/double/sessions";
    const operation = options.operation;
    const route = operation === "create" ? root : `${root}/${options.segment}${operation === "view" ? "" : `/${operation}`}`;
    return json(await request(server, route, { method: ["view", "events", "output"].includes(operation) ? "GET" : "POST",
      body: operation === "reopen" ? {} : body }));
  }
  const root = `/api/double/${options.segment}`;
  if (options.command === "create" || options.command === "reopen") {
    let body = {};
    if (options.command === "create") {
      try { body = JSON.parse(await fs.readFile(options.manifest, "utf8")); }
      catch { fail("Cannot read the JSON input manifest. Supply an absolute readable file path."); }
    }
    const answer = await request(server, options.command === "create" ? "/api/double" : `${root}/reopen`, { method: "POST", body });
    if (!/^\/double\/[a-f0-9]{64}$/.test(answer.path)) fail("The server returned no valid private Double URL.");
    return stdout(`http://127.0.0.1:${server.port}${answer.path}\n`);
  }
  if (options.command === "view") return json(await request(server, root));
  if (options.command === "status") return json(await request(server, `${root}/status`));
  if (options.command === "ack") return json(await request(server, `${root}/ack`, {
    method: "POST", body: { actionId: options.actionId, batchId: options.batchId },
  }));
  const deadline = Date.now() + options.seconds * 1000;
  do {
    let answer;
    try {
      answer = await request(server, `${root}/poll`, { timeout: Math.max(1, Math.min(10000, deadline - Date.now())) });
    } catch (error) {
      if (Date.now() >= deadline) break;
      throw error;
    }
    if (answer.batch) return json(answer.batch);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await pause(Math.min(250, remaining));
  } while (Date.now() < deadline);
  return json({ status: "timeout" });
}
