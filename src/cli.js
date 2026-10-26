#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalTarget, ensureStateDir, SERVER_PROTOCOL, serverPath, statePath, targetKey } from "./paths.js";
import { commandArg, installSkills, reviewInvocation } from "./setup.js";
import { runDouble } from "./double-cli.js";
import { runTrainer } from "./trainer-cli.js";
import { BATCH_ID, carriedIds, normalizeRecord } from "./batch-id.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const HELP = `Walkr Core ${pkg.version}

Modes: walkr-core, walkr-double, walkr-coinflip, walkr-trainer.
walkr-core runs the original review commands below; walkr and human-review remain compatible.
walkr-double --help explains local commands and explicit originating-chat connection.
Coinflip runs in the local shared GUI (walkr-coinflip --help).
walkr-trainer --help explains local Trainer dataset ranking.

  human-review <file-or-localhost-url> Open a file or localhost page for review
  human-review poll <target>          Block until the user hits Send, then print the batch as JSON
      --ack <batch_id>             Acknowledge the batch you applied, then wait for the next
                                   (bare --ack works only while one collected batch waits)
      --timeout <secs>             Give up with {"status":"timeout"} after this long (default: wait for Send)
  human-review status <target>        Report whether feedback is waiting, without blocking
  human-review connect <target> --pi-session-id <id> --pi-session-file <file>
                                   Bind the Pi chat that wakes on Send (the Pi extension runs this)
  human-review disconnect <target> --pi-session-id <id> --pi-session-file <file> | --force
                                   --force works only after the bound chat's watcher lease expired
  human-review claim-wake <target> --batch-id <batch_id> --pi-session-id <id> --pi-session-file <file>
                                   Claim the one wake for a batch (the Pi extension runs this)
  human-review double --help          Private two-copy trial commands (explicit archive and state)
  human-review trainer --help         Local Trainer dataset commands (same as walkr-trainer)
  walkr-core setup                   Install five Walkr skills and project Pi prompt aliases
  walkr-core setup --global          Install global skills; Pi prompts require the explicit API

Setup replaces recognized legacy human-review skills; executable aliases remain.
After approved installation, use /walkr or /skill:walkr-core, not /human-review.
For dry-run and an explicit Pi profile, use installSkills in src/setup.js; see docs/modes.md.
Managed host wrappers refuse setup. Setup does not load extensions or connect a chat.

Everything runs locally. No account, no cloud, no database.
`;

// --------------------------------------------------------------- server glue

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

function request(server, options, body) {
  const port = typeof server === "number" ? server : server.port;
  const token = typeof server === "number" ? "" : server.token || "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        ...options,
        headers: { ...(token ? { "x-human-review-token": token } : {}), ...(options.headers || {}) },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error("timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function alive(port) {
  try {
    const res = await request(port, { method: "GET", path: "/health", timeout: 1200 });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureServer() {
  ensureStateDir();
  const saved = readServerRecord();
  if (saved?.protocol === SERVER_PROTOCOL && saved.port && (await alive(saved.port))) return saved;
  if (process.env.HUMAN_REVIEW_HOSTED === "1") {
    throw new Error("The managed review server is unavailable. Check docker compose ps; do not start another server.");
  }

  const child = spawn(process.execPath, [path.join(here, "server-entry.js")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const record = readServerRecord();
    // Same protocol gate as above: a still-running server from an older
    // version answers /health too, and must not be adopted here.
    if (record?.protocol === SERVER_PROTOCOL && record.port && (await alive(record.port))) return record;
  }
  throw new Error("Could not start the local human-review server.");
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  // A missing opener (headless Linux without xdg-open) surfaces as an async
  // 'error' event, not a throw. Printing the URL below is the fallback.
  child.on("error", () => {});
  child.unref();
}

// ------------------------------------------------------------------ commands

async function openCommand(input) {
  const target = canonicalTarget(input);
  if (target.kind === "file" && !fs.existsSync(target.value)) {
    console.error(`File not found: ${target.value}`);
    process.exit(1);
  }
  const server = await ensureServer();
  const res = await request(server, { method: "POST", path: "/api/session", headers: { "content-type": "application/json" } }, { target: target.value });
  const body = JSON.parse(res.raw);
  if (res.status !== 200) {
    console.error(body.error || "Could not open that file.");
    process.exit(1);
  }
  const url = `${process.env.HUMAN_REVIEW_PUBLIC_URL || `http://127.0.0.1:${server.port}`}${body.path}`;
  if (process.env.HUMAN_REVIEW_NO_BROWSER !== "1") openBrowser(url);
  console.log(`Reviewing ${target.kind === "url" ? target.value : path.basename(target.value)}`);
  console.log(url);
  const command = reviewInvocation();
  const quoted = commandArg(target.value);
  console.log(
    `\nNext, in this same turn, wait for feedback with a bounded foreground poll:\n  ${command} poll ${quoted} --timeout 240\n` +
      `Run it again on a timeout. Before you end the turn, run: ${command} status ${quoted}`
  );
}

/**
 * One long-poll attempt. Resolves { kind: "data", raw } when the server
 * answers, or { kind: "timeout" } when the caller's deadline passes first.
 */
function pollOnce(server, target, ack, timeoutMs) {
  const query = `target=${encodeURIComponent(target)}${ack ? `&ack=${encodeURIComponent(ack === true ? "1" : ack)}` : ""}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: `/api/poll?${query}`,
        headers: { "x-human-review-token": server.token || "" },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => settle(resolve, { kind: "data", raw: raw.trim() }));
        res.on("error", (err) => settle(reject, err));
        // The server went away mid-wait: the socket closes without an 'end'.
        // Left unhandled, the promise never settles and Node exits the
        // process as soon as the loop drains — with the agent still asleep.
        res.on("close", () => settle(reject, new Error("server connection closed")));
      }
    );
    const timer = timeoutMs
      ? setTimeout(() => {
          settle(resolve, { kind: "timeout" });
          req.destroy();
        }, timeoutMs)
      : null;
    req.on("error", (err) => settle(reject, err));
    req.end();
  });
}

/**
 * The consumer is an agent reading a pipe. process.exit() does not wait for
 * pending stdout writes, so a large payload could arrive truncated — always
 * wait for the write to hand off before returning.
 */
function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

/** An open-ended wait still ends eventually: a forgotten tab must not pin a process for days. */
const MAX_OPEN_WAIT_MS = 12 * 60 * 60 * 1000;

function printTimeout(waitedSecs, { capped = false } = {}) {
  const status = `\`${reviewInvocation()} status <target>\``;
  const payload = {
    status: "timeout",
    waited_seconds: waitedSecs,
    next_step: capped
      ? `Nothing arrived in 12 hours. Run ${status}: if the review is still open, start the same background poll again; otherwise stop.`
      : `No feedback yet. Run the same poll command again to keep waiting, or ${status} to check without blocking.`,
  };
  return writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Without --timeout this is an open-ended wait: the agent parks this process
 * in the background and is woken only when it exits, which should happen
 * when the user hits Send or closes the review — never because the detached
 * server went away underneath it (a newer CLI replaced it, or the machine
 * slept). So a lost connection reconnects, restarting the server if needed,
 * instead of giving up. A poll with a deadline keeps the old bounded retries.
 */
async function pollCommand(input, { ack = false, timeoutSecs = 0 } = {}) {
  const target = canonicalTarget(input).value;
  let server = await ensureServer();

  const label = /^https?:\/\//i.test(target) ? target : path.basename(target);
  process.stderr.write(`Waiting for feedback on ${label} — comment in the browser, then hit Send.\n`);

  const bounded = timeoutSecs > 0;
  const started = Date.now();
  const deadline = bounded ? started + timeoutSecs * 1000 : started + MAX_OPEN_WAIT_MS;
  const timedOut = () => printTimeout(bounded ? timeoutSecs : Math.round((Date.now() - started) / 1000), { capped: !bounded });
  // The ack rides on the first request that actually reaches the server.
  let ackPending = ack;
  let failures = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return timedOut();
    let result;
    try {
      result = await pollOnce(server, target, ackPending, remaining);
    } catch (err) {
      failures += 1;
      if (bounded && failures >= 3) break;
      process.stderr.write(`Lost the connection (${err.message}); reconnecting.\n`);
      // Long enough for a replacement server to announce itself first, so
      // this does not race it by spawning a second one.
      await sleep(Math.min(3000 * failures, 10000));
      server = await ensureServer();
      continue;
    }
    ackPending = false;
    if (result.kind === "timeout") return timedOut();
    if (result.raw) {
      let batch;
      try {
        batch = JSON.parse(result.raw);
      } catch {
        batch = null;
      }
      if (batch) {
        await writeStdout(`${JSON.stringify(batch, null, 2)}\n`);
        // A refused ack cleared nothing; the agent must not read it as a batch.
        if (batch.status === "ack-refused" || batch.error) process.exit(1);
        return;
      }
      process.stderr.write("Unexpected response from the human-review server; retrying.\n");
    }
    // An empty or garbled answer means the server closed the request without
    // a batch; wait a beat so a misbehaving server cannot spin this loop.
    failures += 1;
    if (bounded && failures >= 3) break;
    await sleep(500);
  }
  process.stderr.write("Gave up waiting for feedback.\n");
  process.exit(1);
}

/**
 * Instant answer, no blocking. Asks the running server when there is one;
 * otherwise reads the persisted state directly, so a dead server still
 * reports feedback that is waiting for a fresh poll.
 */
async function statusCommand(input, caller = null) {
  const target = canonicalTarget(input).value;
  const saved = readServerRecord();
  if (saved?.protocol === SERVER_PROTOCOL && saved.port && (await alive(saved.port))) {
    // The chat identity goes in the POST body, never in a URL.
    const res = caller
      ? await request(saved, { method: "POST", path: "/api/status", headers: { "content-type": "application/json" } }, { target, ...caller })
      : await request(saved, { method: "GET", path: `/api/status?target=${encodeURIComponent(target)}` });
    if (res.status === 200) {
      process.stdout.write(`${JSON.stringify(JSON.parse(res.raw), null, 2)}\n`);
      return;
    }
  }

  let data = { pages: {}, batches: {} };
  try {
    data = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    // No state yet: everything below reads as empty.
  }
  const key = targetKey(target);
  const pending = normalizeRecord(key, (data.batches || {})[key]);
  const page = (data.pages || {})[key];
  const binding = (data.bindings || {})[key];
  const payload = {
    status: pending ? "feedback-waiting" : "idle",
    feedback_waiting: !!pending,
    batch_id: pending ? pending.batch.batch_id : null,
    collected: pending ? pending.delivered : false,
    carried_batch_ids: pending ? carriedIds(pending) : [],
    agent_listening: false,
    // No server, no browser session: a review page cannot be open.
    review_open: false,
    server_running: false,
    unsent: {
      comments: page ? page.comments.length : 0,
      edits: page ? page.edits.length : 0,
    },
    // Nothing reads status for the bound chat without a server, so no watcher counts as live,
    // and the lease starts again with the next server. Status never names the bound chat.
    wake: {
      bound: !!binding,
      watching: false,
      lease_expired: null,
      ...(caller ? { bound_to_caller: !!binding && binding.piSessionId === caller.piSessionId && binding.piSessionFile === caller.piSessionFile } : {}),
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Bind or release the persistent Pi chat that wakes on a Send. The Pi
 * extension runs this from the chat that it names; the CLI never picks a chat.
 */
async function bindingCommand(action, input, caller, extra = {}) {
  const target = canonicalTarget(input).value;
  const server = await ensureServer();
  const body = { target, ...(caller || {}), ...extra };
  const res = await request(server, { method: "POST", path: `/api/core/${action}`, headers: { "content-type": "application/json" } }, body);
  let payload;
  try {
    payload = JSON.parse(res.raw);
  } catch {
    payload = { error: "Unexpected response from the human-review server." };
  }
  await writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  if (res.status !== 200) process.exit(1);
}

/** `--pi-session-id <id> --pi-session-file <file>`, both or neither. */
function parseIdentity(rest) {
  const value = (flag) => {
    const at = rest.indexOf(flag);
    if (at !== -1) return rest[at + 1];
    const inline = rest.find((arg) => arg.startsWith(`${flag}=`));
    return inline === undefined ? undefined : inline.slice(flag.length + 1);
  };
  const piSessionId = value("--pi-session-id");
  const piSessionFile = value("--pi-session-file");
  if (piSessionId === undefined && piSessionFile === undefined) return null;
  if (!piSessionId || !piSessionFile || !path.isAbsolute(piSessionFile)) {
    throw new Error("--pi-session-id and an absolute --pi-session-file go together.");
  }
  return { piSessionId, piSessionFile };
}

/** The target is the first argument that is neither a flag nor a flag's value. */
function positional(rest, valued = ["--pi-session-id", "--pi-session-file", "--batch-id"]) {
  for (let i = 0; i < rest.length; i += 1) {
    if (valued.includes(rest[i])) {
      i += 1;
      continue;
    }
    if (!rest[i].startsWith("-")) return rest[i];
  }
  return "";
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  console.log(HELP);
  process.exit(0);
}

if (argv[0] === "--version" || argv[0] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

if (argv[0] !== "double" && argv[0] !== "trainer") process.on("SIGINT", () => {
  process.stderr.write("\nStopped waiting. Your feedback is safe — run the same command again to pick it up.\n");
  process.exit(130);
});

function parsePollArgs(rest) {
  const parsed = { file: "", ack: false, timeoutSecs: 0 };
  let sawTimeout = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    // `--ack <batch_id>` names the applied batch; a bare `--ack` is the old form. A value that is not
    // a batch id (a typo, a truncated id, the `<batch_id>` placeholder) must fail, never fall back to the bare ack.
    if (arg === "--ack" || arg.startsWith("--ack=")) {
      const inline = arg !== "--ack";
      const next = rest[i + 1];
      const value = inline ? arg.slice("--ack=".length) : next !== undefined && !next.startsWith("-") ? next : null;
      if (value === null) parsed.ack = true;
      else if (!BATCH_ID.test(value)) {
        throw new Error(`--ack wants a batch id such as batch-0123456789abcdef, not ${JSON.stringify(value)}. Nothing was acknowledged.`);
      } else {
        parsed.ack = value;
        if (!inline) i += 1;
      }
    } else if (arg === "--timeout") {
      sawTimeout = true;
      parsed.timeoutSecs = Number(rest[(i += 1)]);
    } else if (arg.startsWith("--timeout=")) {
      sawTimeout = true;
      parsed.timeoutSecs = Number(arg.slice("--timeout=".length));
    } else if (!arg.startsWith("-") && !parsed.file) parsed.file = arg;
  }
  // A malformed value must fail loudly — NaN or 0 silently waiting forever is
  // the exact hang the flag exists to prevent.
  if (sawTimeout && (!Number.isFinite(parsed.timeoutSecs) || parsed.timeoutSecs <= 0)) {
    throw new Error("--timeout wants a number of seconds, e.g. --timeout 300");
  }
  return parsed;
}

try {
  if (argv[0] === "double") {
    await runDouble(argv.slice(1));
  } else if (argv[0] === "trainer") {
    await runTrainer(argv.slice(1));
  } else if (argv[0] === "poll") {
    const { file, ack, timeoutSecs } = parsePollArgs(argv.slice(1));
    if (!file) throw new Error("Usage: human-review poll <file-or-localhost-url> [--ack <batch_id>] [--timeout <secs>]");
    await pollCommand(file, { ack, timeoutSecs });
  } else if (argv[0] === "status") {
    const rest = argv.slice(1);
    const file = positional(rest);
    if (!file) throw new Error("Usage: human-review status <file-or-localhost-url> [--pi-session-id <id> --pi-session-file <file>]");
    await statusCommand(file, parseIdentity(rest));
  } else if (argv[0] === "connect" || argv[0] === "disconnect") {
    const rest = argv.slice(1);
    const file = positional(rest);
    const caller = parseIdentity(rest);
    const force = argv[0] === "disconnect" && rest.includes("--force");
    if (!file || (!caller && !force)) {
      throw new Error(`Usage: human-review ${argv[0]} <file-or-localhost-url> --pi-session-id <id> --pi-session-file <file>${argv[0] === "disconnect" ? " | --force" : ""}`);
    }
    await bindingCommand(argv[0], file, caller, force ? { force: true } : {});
  } else if (argv[0] === "claim-wake") {
    const rest = argv.slice(1);
    const file = positional(rest);
    const caller = parseIdentity(rest);
    const at = rest.indexOf("--batch-id");
    const batchId = at === -1 ? "" : rest[at + 1] || "";
    if (!file || !caller || !BATCH_ID.test(batchId)) {
      throw new Error("Usage: human-review claim-wake <file-or-localhost-url> --batch-id <batch_id> --pi-session-id <id> --pi-session-file <file>");
    }
    await bindingCommand("wake", file, caller, { batchId });
  } else if (argv[0] === "setup") {
    const isGlobal = argv.includes("--global") || argv.includes("-g");
    installSkills(process.cwd(), { global: isGlobal }).forEach((line) => console.log(line));
  } else {
    if (argv[0].startsWith("-")) throw new Error("Unknown option. Use walkr-core --help.");
    await openCommand(argv[0]);
  }
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}

// A finished command must never linger on stray handles (keep-alive sockets
// from health checks, for one) — on Windows that hangs the calling shell.
process.exit(0);
