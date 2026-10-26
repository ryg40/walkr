import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fixture, listen, request } from "./double-fixtures.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { SERVER_PROTOCOL } from "../src/paths.js";

function cli(f, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "double", ...args], { env: {
      ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir,
      HUMAN_REVIEW_NO_BROWSER: "1", HUMAN_REVIEW_HOSTED: "0", ...env,
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => { stdout += s; });
    child.stderr.on("data", (s) => { stderr += s; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function record(f, s, extra = {}) {
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ port: s.port, token: s.token, pid: process.pid, protocol: SERVER_PROTOCOL, ...extra }), { mode: 0o600 });
}

test("Double CLI creates, reopens, polls, reports status and acknowledges exact batches", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  await record(f, s);
  const created = await cli(f, ["create", f.manifestPath]);
  assert.equal(created.code, 0, "create exits successfully");
  assert.match(created.stdout, /^http:\/\/127\.0\.0\.1:\d+\/double\/[a-f0-9]+\n$/);
  const reopened = await cli(f, ["reopen", "trial"]);
  assert.equal(reopened.code, 0);
  const status = await cli(f, ["status", "trial"]);
  assert.equal(JSON.parse(status.stdout).status, "editing");
  const timeout = await cli(f, ["poll", "trial", "--timeout", "0.05"]);
  assert.equal(timeout.code, 0);
  assert.equal(JSON.parse(timeout.stdout).status, "timeout");
  const sent = await s.api("/api/double/~trial/send", { method: "POST", body: { actionId: "send", expectedRevision: 0 } });
  assert.equal(sent.status, 200);
  const first = JSON.parse((await cli(f, ["poll", "trial", "--timeout", "1"])).stdout);
  assert.equal(first.payload.empty, true);
  const again = JSON.parse((await cli(f, ["poll", "trial"])).stdout);
  assert.deepEqual(again, first);
  const bad = await cli(f, ["ack", "trial", "wrong-batch", "--action-id", "ack"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /UNKNOWN_BATCH/);
  const ack = await cli(f, ["ack", "trial", first.id, "--action-id", "ack"]);
  assert.equal(ack.code, 0);
  assert.equal(JSON.parse(ack.stdout).result.batchId, first.id);
  assert.equal((await cli(f, ["ack", "trial", first.id, "--action-id", "ack"])).code, 0);
  assert.equal(JSON.parse((await cli(f, ["status", "trial"])).stdout).acknowledged, true);
  assert.equal(JSON.parse((await cli(f, ["poll", "trial", "--timeout", "0.05"])).stdout).status, "timeout");
  await f.unchanged(assert);
});

test("Double CLI fails closed for hosted, invalid arguments, absent config and incompatible services", async (t) => {
  const f = await fixture(t);
  const hosted = await cli(f, ["create", "/unreadable/manifest.json"], { HUMAN_REVIEW_HOSTED: "1" });
  assert.equal(hosted.code, 1);
  assert.match(hosted.stderr, /hosted/i);
  assert.ok(!hosted.stderr.includes("ENOENT"));
  for (const args of [["poll", "trial", "--timeout", "0"], ["poll", "trial", "--timeout", "NaN"], ["ack", "trial", "batch"], ["status", "trial", "extra"], ["create"], ["create", "https://example.test"], ["unknown"]]) {
    assert.equal((await cli(f, args)).code, 1);
  }
  assert.equal((await cli(f, ["status", "trial"], { HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: "" })).code, 1);
  assert.equal((await cli(f, ["status", "trial"], { HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: "relative" })).code, 1);
  const missing = await cli(f, ["status", "trial"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /serve|server/i);
  const s = await listen(t, f, { HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: "" });
  await record(f, s);
  const incompatible = await cli(f, ["create", f.manifestPath]);
  assert.equal(incompatible.code, 1);
  assert.match(incompatible.stderr, /Double|compatible/);
  assert.equal((await s.api("/health")).status, 200, "an incompatible server is never replaced");
  assert.equal((await cli(f, ["serve"])).code, 1);
  assert.equal((await s.api("/health")).status, 200);
  await f.unchanged(assert);
});


test("Double CLI uses the shared segment codec for exact public identities", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  await record(f, s);
  for (const comparisonId of [".", "..", "%2e", "%2F", "~", "~trial", "a/b", "a\\b", "a?b#c", "capabilities", "reopen", "日本語"]) {
    await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, comparisonId }));
    const created = await cli(f, ["create", f.manifestPath]);
    assert.equal(created.code, 0);
    assert.equal((await request(s.port, new URL(created.stdout.trim()).pathname)).status, 200);
    assert.equal((await cli(f, ["reopen", comparisonId])).code, 0);
    const view = await cli(f, ["view", comparisonId]);
    assert.equal(JSON.parse(view.stdout).view.comparisonId, comparisonId);
    const root = `/api/double/${encodeDoubleComparisonId(comparisonId)}`;
    assert.equal((await s.api(`${root}/send`, { method: "POST", body: { actionId: "send", expectedRevision: 0 } })).status, 200);
    const polled = await cli(f, ["poll", comparisonId, "--timeout", "1"]);
    assert.equal(polled.code, 0);
    const batch = JSON.parse(polled.stdout);
    assert.equal(batch.comparisonId, comparisonId);
    assert.equal((await cli(f, ["ack", comparisonId, batch.id, "--action-id", "ack"])).code, 0);
    assert.equal(JSON.parse((await cli(f, ["status", comparisonId])).stdout).acknowledged, true);
  }
  await f.unchanged(assert);
});

test("Double CLI never replaces a live old-protocol server or reads a manifest before compatibility", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  await record(f, s, { protocol: SERVER_PROTOCOL - 1 });
  const before = await fs.readFile(path.join(f.stateDir, "server.json"));
  const response = await cli(f, ["create", "/missing/manifest.json"]);
  assert.equal(response.code, 1);
  assert.match(response.stderr, /compatible/);
  assert.ok(!response.stderr.includes("manifest"));
  assert.equal((await s.api("/health")).status, 200);
  assert.equal((await cli(f, ["serve"])).code, 1);
  assert.deepEqual(await fs.readFile(path.join(f.stateDir, "server.json")), before);
  await record(f, s);
  const mismatched = await cli(f, ["create", "/missing/manifest.json"], { HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: path.join(f.root, "different-archive") });
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.stderr, /different archive/);
  assert.equal((await s.api("/health")).status, 200);
  await f.unchanged(assert);
});

async function foreground(t, f) {
  const child = spawn(process.execPath, ["src/cli.js", "double", "serve"], { env: {
    ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir,
    HUMAN_REVIEW_HOSTED: "0", HUMAN_REVIEW_NO_BROWSER: "1", HUMAN_REVIEW_IDLE_MS: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const ended = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const stop = async () => { if (child.exitCode === null) child.kill("SIGTERM"); return ended; };
  t.after(stop);
  const value = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
      if (output.includes("\n")) {
        try { resolve(JSON.parse(output.split("\n")[0])); } catch { reject(new Error("Invalid foreground readiness JSON")); }
      }
    });
    child.once("error", reject);
    child.once("close", () => reject(new Error("Disposable foreground server exited before readiness")));
  });
  assert.equal(value.status, "listening");
  assert.equal(stderr, "");
  return { port: value.port, stop };
}

test("Double foreground CLI is isolated, cleans its own credentials and recovers sent state after process restart", async (t) => {
  const f = await fixture(t);
  let server = await foreground(t, f);
  const first = await cli(f, ["create", f.manifestPath]);
  assert.equal(first.code, 0);
  const oldPath = new URL(first.stdout.trim()).pathname;
  let saved = JSON.parse(await fs.readFile(path.join(f.stateDir, "server.json"), "utf8"));
  const sent = await request(server.port, "/api/double/~trial/send", { token: saved.token, method: "POST", body: { actionId: "s", expectedRevision: 0 } });
  assert.equal(sent.status, 200);
  const before = JSON.parse((await cli(f, ["poll", "trial"])).stdout);
  assert.equal(before.payload.empty, true);
  assert.equal((await cli(f, ["serve"])).code, 1);
  assert.equal((await request(server.port, "/health")).status, 200);
  assert.equal(await server.stop(), 0);
  assert.equal(await fs.stat(path.join(f.stateDir, "server.json")).catch(() => null), null);
  server = await foreground(t, f);
  assert.equal((await request(server.port, oldPath)).status, 404);
  const reopened = await cli(f, ["reopen", "trial"]);
  assert.equal(reopened.code, 0);
  assert.equal((await request(server.port, new URL(reopened.stdout.trim()).pathname)).status, 200);
  assert.deepEqual(JSON.parse((await cli(f, ["poll", "trial"])).stdout), before);
  assert.equal((await cli(f, ["ack", "trial", before.id, "--action-id", "received"])).code, 0);
  assert.equal(await server.stop(), 0);
  server = await foreground(t, f);
  assert.equal(JSON.parse((await cli(f, ["status", "trial"])).stdout).acknowledged, true);
  assert.equal(JSON.parse((await cli(f, ["poll", "trial", "--timeout", "0.05"])).stdout).status, "timeout");
  saved = JSON.parse(await fs.readFile(f.record, "utf8"));
  assert.equal(saved.delivery.status, "sent");
  assert.deepEqual(saved.delivery.batch, before);
  await server.stop();
  await f.unchanged(assert);
});


test("Double serve refuses unrelated state without pruning or overwriting it", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.stateDir, "state.json");
  const bytes = '{"pages":{"old":{"updatedAt":1}},"batches":{}}';
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const result = await cli(f, ["serve"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /empty disposable/);
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  assert.equal(await fs.stat(path.join(f.stateDir, "server.lock")).catch(() => null), null);
});
