import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { POSIX_ONLY_CODE, POSIX_ONLY_MESSAGE, posixOnlyRefusal } from "../src/posix-only.js";
import { createDoubleHandler } from "../src/double-server.js";
import { createTrainerHandler } from "../src/trainer-server.js";
import { configuration, connectDoubleClient } from "../src/double-client.js";
import { installSharedGuiChat } from "../src/shared-gui-chat.js";
import { installDoubleChat } from "../src/double-chat-subscription.js";
import { DoubleArchive } from "../src/double-archive.js";
import { DoubleSessionStore } from "../src/double-session.js";
import { CoinflipStore } from "../src/coinflip-store.js";
import { TrainerStore } from "../src/trainer-store.js";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
// Runs on every platform: the platform is injected, so Linux and macOS prove the Windows refusal.
const asWindows = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})';

async function call(handle, url, headers = {}) {
  const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  assert.equal(await handle({ url, method: "GET", headers }, res), true);
  return { status: res.status, body: JSON.parse(res.body) };
}

test("the POSIX-only guard refuses only win32", () => {
  assert.equal(posixOnlyRefusal("win32"), POSIX_ONLY_MESSAGE);
  for (const platform of ["linux", "darwin", "freebsd"]) assert.equal(posixOnlyRefusal(platform), null);
});

test("the Double and Trainer handlers refuse on win32 before any path access", async () => {
  const token = "a".repeat(32);
  // No archive directory and no Trainer root: a refusal that reached a path check would name the path instead.
  const double = createDoubleHandler({ token, archiveDir: undefined, stateDir: undefined, hosted: false, platform: "win32" });
  const answer = await call(double, "/api/double/capabilities", { "x-human-review-token": token });
  assert.deepEqual(answer, { status: 501, body: { error: { code: POSIX_ONLY_CODE, message: POSIX_ONLY_MESSAGE } } });
  assert.throws(() => double.trainerGui.link({}, {}), { code: POSIX_ONLY_CODE });
  const trainer = createTrainerHandler({ token, root: undefined, hosted: false, platform: "win32" });
  assert.deepEqual(await call(trainer, "/_walkr/trainer/capabilities"),
    { status: 501, body: { error: { code: POSIX_ONLY_CODE, message: POSIX_ONLY_MESSAGE } } });
  const hosted = createDoubleHandler({ token, hosted: true, platform: "win32" });
  assert.equal((await call(hosted, "/api/double/capabilities", { "x-human-review-token": token })).body.error.code, "HOSTED_UNSUPPORTED");
});

test("the Double, Coinflip and Trainer commands refuse on win32 and keep help", () => {
  const env = { ...process.env, HUMAN_REVIEW_HOSTED: "1" }; // The platform refusal precedes the hosted one.
  for (const bin of ["walkr-double.js", "walkr-coinflip.js", "walkr-trainer.js"]) {
    const run = (...args) => spawnSync(process.execPath, ["--import", asWindows, path.join(src, bin), ...args], { encoding: "utf8", env });
    const refused = run("serve");
    assert.equal(refused.status, 1, bin);
    assert.equal(refused.stderr.trim(), POSIX_ONLY_MESSAGE, bin);
    const help = run("--help");
    assert.equal(help.status, 0, bin);
    assert.match(help.stdout, /walkr-/, bin);
  }
});

test("the Pi clients refuse on win32 before any configuration access", async () => {
  const refused = { code: POSIX_ONLY_CODE, message: POSIX_ONLY_MESSAGE };
  // Any read of this environment would throw a different error.
  const trap = new Proxy({}, { get() { throw new Error("configuration accessed"); }, ownKeys() { throw new Error("configuration accessed"); } });
  assert.throws(() => configuration(trap, "win32"), refused);
  await assert.rejects(connectDoubleClient(trap, { platform: "win32" }), refused);
  const tools = new Map();
  const pi = { on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, sendMessage() {}, appendEntry() {} };
  installSharedGuiChat(pi, {}, { platform: "win32" });
  installDoubleChat(pi, {}, { platform: "win32" });
  assert.ok(tools.size > 0);
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => "pi", getSessionFile: () => "/pi.jsonl" } };
  // "status" is a valid action of every tool.
  for (const tool of tools.values()) {
    await assert.rejects(tool.execute("call", { action: "status", sessionId: "s", doubleSessionId: "s", comparisonId: "c" }, undefined, undefined, ctx), refused, tool.name);
  }
});

test("the Trainer, Coinflip, Double session and Double archive stores refuse on win32 before any path check", () => {
  const refused = { code: POSIX_ONLY_CODE, message: POSIX_ONLY_MESSAGE };
  // Relative paths: a path check would refuse them with UNSAFE_PATH instead.
  assert.throws(() => new TrainerStore({ root: "relative", platform: "win32" }), refused);
  assert.throws(() => new CoinflipStore({ archiveDir: "relative", platform: "win32" }), refused);
  assert.throws(() => new DoubleSessionStore({ archiveDir: "relative", platform: "win32" }), refused);
  assert.throws(() => new DoubleArchive({ archiveDir: "relative", prefix: "double", platform: "win32" }), refused);
  const trainer = createTrainerHandler({ token: "a".repeat(32), root: "relative", hosted: false, platform: "win32" });
  assert.throws(() => trainer.service.store(), refused);
});
