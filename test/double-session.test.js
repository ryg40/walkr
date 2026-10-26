import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { JSDOM } from "jsdom";
import { fixture, listen, request, digest } from "./double-fixtures.js";
import { DoubleSessionStore } from "../src/double-session.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { SERVER_PROTOCOL } from "../src/paths.js";

const route = (id = "session", suffix = "") => `/api/double/sessions/${encodeDoubleComparisonId(id)}${suffix}`;
const input = (f, sessionId = "session") => ({ sessionId, brief: "Keep the selected designs. Make a new challenger.", manifest: f.manifest });
const core = (f) => new DoubleSessionStore(f);
const post = (s, suffix, body, token = s.token, sessionId = "session") => s.api(route(sessionId, suffix), { method: "POST", body, token });
/** The session shell's escaped browser token; the page carries no view or other authority. */
async function shellToken(s, shellPath) {
  const shell = await request(s.port, shellPath);
  assert.equal(shell.status, 200);
  const dom = new JSDOM(shell.text);
  const token = dom.window.document.body.dataset.token;
  dom.window.close();
  return token;
}
async function create(s, f, sessionId = "session") {
  const response = await s.api("/api/double/sessions", { method: "POST", body: input(f, sessionId) });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return { ...response.json, browser: await shellToken(s, response.json.path) };
}
function cli(f, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "double", "session", ...args], { env: {
      ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir, HUMAN_REVIEW_HOSTED: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; }); child.stderr.on("data", (b) => { stderr += b; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// One scenario covers HTTP, frozen context, agent attempts, persistent material and CLI recovery.
test("session lifecycle preserves rounds, deletion history, checked assets and exact receipts across restart", async (t) => {
  const f = await fixture(t, "round-1");
  const next = await fixture(t, "round-2");
  let s = await listen(t, f);
  const opened = await create(s, f);
  const owner = async (suffix, body) => {
    const r = await post(s, suffix, body, opened.browser);
    assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
  };
  await owner("/actions", { actionId: "keep", expectedRevision: 0, comparisonId: "round-1", action: { kind: "keeper", pane: "left", componentId: "hero", selected: true } });
  await owner("/actions", { actionId: "delete", expectedRevision: 1, comparisonId: "round-1", action: { kind: "feedback-delete", pane: "right", componentId: "hero", feedback: " Earlier evidence \n" } });
  await owner("/actions", { actionId: "undo", expectedRevision: 2, comparisonId: "round-1", action: { kind: "undo", deletionActionId: (await core(f).read("session")).comparison.history[0].id } });
  const submit = { actionId: "next", expectedRevision: 3, comparisonId: "round-1" };
  const sent = await owner("/next", submit);
  assert.equal(sent.view.status, "generating"); assert.equal(sent.view.comparison.status, "sent");
  assert.deepEqual((await owner("/next", submit)).result, sent.result);
  const event = (await s.api(route("session", "/events"))).json.events[0];
  assert.equal(event.payload.batch.payload.keepers.length, 1);
  assert.equal(event.payload.batch.payload.historicalFeedback.length, 1);
  assert.equal(event.payload.batch.payload.feedback[0].comment, " Earlier evidence \n");
  const prior = (await core(f).snapshot("session")).rounds[0];
  const ack = { actionId: "ack", eventId: event.id };
  const receipt = await post(s, "/ack", ack);
  assert.equal(receipt.json.view.status, "generating");
  assert.equal((await s.api(route("session", "/events"))).json.pending.length, 0);
  const attach = { actionId: "attach", requestId: sent.result.requestId, attemptId: sent.result.attemptId, manifest: next.manifest };
  const attached = await post(s, "/attach", attach);
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  assert.equal(attached.json.view.currentComparisonId, "round-2");
  assert.equal(attached.json.view.comparison.panes.left.components.some((c) => c.keeper), false);
  assert.notEqual(attached.json.view.comparison.panes.left.frameUrl, opened.view.comparison.panes.left.frameUrl);
  assert.equal(await shellToken(s, opened.path), opened.browser);
  const sameShell = await s.api(route(), { token: opened.browser });
  assert.equal(sameShell.json.view.currentComparisonId, "round-2");
  const frame = await request(s.port, sameShell.json.view.comparison.panes.left.frameUrl);
  assert.equal(frame.status, 200); assert.match(frame.text, /data-comparison-id="round-2"/);
  assert.match(frame.headers["content-security-policy"], /sandbox allow-scripts/);
  assert.ok(!frame.text.includes(opened.browser));
  await owner("/actions", { actionId: "final-delete", expectedRevision: 6, comparisonId: "round-2", action: { kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "Remove this hero" } });
  const end = { actionId: "end", expectedRevision: 7, comparisonId: "round-2", pane: "left" };
  const rename = fs.rename;
  fs.rename = async (...args) => { await rename(...args); throw Object.assign(new Error("lost End response"), { code: "EIO" }); };
  try {
    assert.equal((await post(s, "/end", end, opened.browser)).json.error.code, "COMMIT_UNCERTAIN");
  } finally { fs.rename = rename; }
  const ended = await owner("/end", end);
  assert.equal(ended.view.status, "ended");
  const output = (await s.api(route("session", "/output"))).json;
  assert.equal(output.history.length, 2);
  assert.equal(output.page.pane, "left");
  assert.equal(output.page.deletionMode, "static-display-none");
  assert.deepEqual(output.page.deletedComponentIds, ["hero"]);
  const html = Buffer.from(output.page.files[0].base64, "base64").toString();
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector("section").style.getPropertyValue("display"), "none");
  assert.equal(dom.window.document.querySelector("section").style.getPropertyPriority("display"), "important");
  assert.equal(dom.window.document.querySelector("footer").textContent, "End");
  assert.equal(dom.window.document.scripts.length, 0); dom.window.close();
  for (const file of output.page.files.slice(1)) assert.equal(digest(Buffer.from(file.base64, "base64")), next.hashes.get(path.join(next.manifest.panes.left.copy.root, file.path)));
  assert.deepEqual((await core(f).snapshot("session")).rounds[0], prior);
  await f.unchanged(assert); await next.unchanged(assert);
  await s.close();
  // Archived output and exact retries cannot depend on lost sources or copied assets.
  for (const tree of [f, next]) for (const file of tree.hashes.keys()) await fs.unlink(file);
  s = await listen(t, f);
  assert.equal((await request(s.port, opened.path)).status, 404);
  assert.equal((await s.api(route(), { token: opened.browser })).status, 401);
  assert.deepEqual((await post(s, "/end", end)).json.result, ended.result);
  assert.deepEqual((await post(s, "/attach", attach)).json.result, attached.json.result);
  assert.deepEqual((await post(s, "/ack", ack)).json.result, receipt.json.result);
  assert.deepEqual((await s.api(route("session", "/output"))).json, output);
  const events = (await s.api(route("session", "/events"))).json;
  assert.deepEqual(events.events[0], event);
  assert.deepEqual(events.pending, [ended.result.eventId]);
  assert.equal((await post(s, "/reopen", {})).json.error.code, "FILE_CHANGED");
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ port: s.port, token: s.token, pid: process.pid, protocol: SERVER_PROTOCOL }), { mode: 0o600 });
  const fromCli = await cli(f, ["output", "session"]);
  assert.equal(fromCli.code, 0, fromCli.stderr); assert.deepEqual(JSON.parse(fromCli.stdout), output);
});

test("failure and explicit retry keep the same batch; stale work and End cannot replace the displayed pair", async (t) => {
  const f = await fixture(t, "first"); const second = await fixture(t, "second");
  let s = await listen(t, f); const opened = await create(s, f);
  let browser = opened.browser;
  const sent = await post(s, "/next", { actionId: "next", expectedRevision: 0, comparisonId: "first" }, browser);
  const attempt = { requestId: sent.json.result.requestId, attemptId: sent.json.result.attemptId };
  const frozen = (await core(f).snapshot("session")).rounds[0];
  assert.equal((await post(s, "/next", { actionId: "overlap", expectedRevision: 1, comparisonId: "first" })).json.error.code, "READ_ONLY");
  const bad = structuredClone(second.manifest); bad.panes.right.copy.assets.push("missing.png");
  assert.equal((await post(s, "/attach", { actionId: "bad", ...attempt, manifest: bad })).json.error.code, "INVALID_INPUT");
  assert.equal((await core(f).read("session")).revision, 1);
  assert.equal((await post(s, "/retry", { actionId: "premature", expectedRevision: 1, ...attempt }, browser)).json.error.code, "INVALID_TRANSITION");
  const failure = { actionId: "failure", ...attempt, message: "Agent stopped; explicit recovery required." };
  assert.equal((await post(s, "/fail", failure)).json.view.status, "failed");
  const retry = { actionId: "retry", expectedRevision: 2, ...attempt };
  for (const [body, code] of [
    [{ actionId: "retry", ...attempt }, "INVALID_REQUEST"],
    [{ ...retry, expectedRevision: 1 }, "STALE_REVISION"],
    [{ ...retry, attemptId: "obsolete" }, "STALE_ATTEMPT"],
    [{ ...retry, requestId: "unrelated" }, "STALE_ATTEMPT"],
    [{ ...retry, outputDir: f.root }, "INVALID_REQUEST"],
  ]) assert.equal((await post(s, "/retry", body, browser)).json.error.code, code);
  const retried = await post(s, "/retry", retry, browser);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.view.status, "generating");
  assert.notEqual(retried.json.result.attemptId, attempt.attemptId);
  assert.notEqual(retried.json.result.eventId, sent.json.result.eventId);
  assert.equal(retried.json.result.requestId, attempt.requestId);
  assert.deepEqual((await post(s, "/retry", retry, browser)).json.result, retried.json.result);
  assert.equal((await post(s, "/retry", { ...retry, expectedRevision: 3 }, browser)).json.error.code, "ACTION_CONFLICT");
  assert.equal((await post(s, "/retry", { ...retry, actionId: "stale-retry", expectedRevision: 3 }, browser)).json.error.code, "STALE_ATTEMPT");
  assert.equal((await post(s, "/retry", { ...retry, actionId: "overlap-retry", expectedRevision: 3, attemptId: retried.json.result.attemptId }, browser)).json.error.code, "INVALID_TRANSITION");
  const [retryAgain, lateResult] = await Promise.all([
    post(s, "/retry", retry, browser),
    post(s, "/attach", { actionId: "raced-old-result", ...attempt, manifest: second.manifest }),
  ]);
  assert.deepEqual(retryAgain.json.result, retried.json.result);
  assert.equal(lateResult.json.error.code, "STALE_ATTEMPT");
  const events = (await s.api(route("session", "/events"))).json;
  assert.deepEqual(events.events[0].payload.batch, events.events[1].payload.batch);
  assert.deepEqual(events.pending, events.events.map((e) => e.id));
  await s.close(); s = await listen(t, f);
  assert.equal((await post(s, "/retry", retry, browser)).status, 401);
  const reopened = await post(s, "/reopen", {});
  assert.equal(reopened.status, 200);
  browser = await shellToken(s, reopened.json.path);
  assert.deepEqual((await post(s, "/retry", retry, browser)).json.result, retried.json.result);
  assert.deepEqual((await post(s, "/retry", retry)).json.result, retried.json.result);
  assert.deepEqual((await s.api(route("session", "/events"))).json, events);
  assert.equal((await post(s, "/attach", { actionId: "late", ...attempt, manifest: null })).json.error.code, "STALE_ATTEMPT");
  assert.equal((await post(s, "/fail", { actionId: "late-failure", ...attempt, message: "Late" })).json.error.code, "STALE_ATTEMPT");
  const end = { actionId: "end", expectedRevision: 3, comparisonId: "first", pane: "right" };
  const [ended, lateAttach] = await Promise.all([
    post(s, "/end", end, browser),
    post(s, "/attach", { actionId: "late-new", requestId: attempt.requestId, attemptId: retried.json.result.attemptId, manifest: second.manifest }),
  ]);
  // The store serializes whichever request reaches it first. End never selects a replaced pair.
  if (ended.status === 200) {
    assert.equal(ended.json.view.status, "ended");
    assert.equal(lateAttach.json.error.code, "READ_ONLY");
  } else {
    assert.equal(ended.json.error.code, "STALE_REVISION");
    assert.equal(lateAttach.status, 200);
    assert.equal(lateAttach.json.view.currentComparisonId, "second");
    const freshEnd = await post(s, "/end", { ...end, actionId: "end-current", expectedRevision: 4, comparisonId: "second" }, browser);
    assert.equal(freshEnd.json.view.status, "ended");
  }
  const terminal = await core(f).snapshot("session");
  assert.equal((await post(s, "/retry", { ...retry, actionId: "after-end", expectedRevision: terminal.revision, attemptId: retried.json.result.attemptId }, browser)).json.error.code, "READ_ONLY");
  assert.deepEqual((await post(s, "/retry", retry, browser)).json.result, retried.json.result);
  assert.deepEqual(await core(f).snapshot("session"), terminal);
  assert.deepEqual((await core(f).snapshot("session")).rounds[0], frozen);
  assert.equal((await s.api(route("session", "/output"))).json.page.pane, "right");
  await f.unchanged(assert); await second.unchanged(assert);
});

test("session commits recover interrupted replacement, lost replies and pending events without partial records", async (t) => {
  const f = await fixture(t, "first"); const next = await fixture(t, "second");
  let store = core(f); await store.create(input(f));
  const file = path.join(f.archiveDir, `double-session-${digest("session")}.json`);
  const before = await fs.readFile(file);
  const originalOpen = fs.open;
  const submit = { actionId: "next", expectedRevision: 0, comparisonId: "first" };
  fs.open = async (name, ...args) => {
    if (String(name).endsWith(".tmp")) throw Object.assign(new Error("fault"), { code: "EIO" });
    return originalOpen(name, ...args);
  };
  try { await assert.rejects(store.mutate("session", "next", submit), { code: "WRITE_FAILED" }); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await store.events("session")).events, []);
  const originalRename = fs.rename;
  fs.rename = async (...args) => { await originalRename(...args); throw Object.assign(new Error("lost"), { code: "EIO" }); };
  try { await assert.rejects(store.mutate("session", "next", submit), { code: "COMMIT_UNCERTAIN" }); }
  finally { fs.rename = originalRename; }
  store = core(f);
  const saved = await store.mutate("session", "next", submit);
  assert.equal(saved.view.revision, 1); assert.equal((await store.events("session")).pending.length, 1);
  await assert.rejects(store.mutate("session", "next", { ...submit, expectedRevision: 1 }), { code: "ACTION_CONFLICT" });
  const attach = { actionId: "attach", requestId: saved.result.requestId, attemptId: saved.result.attemptId, manifest: next.manifest };
  fs.rename = async (...args) => { throw Object.assign(new Error("before replace"), { code: "EIO" }); };
  try { await assert.rejects(store.mutate("session", "attach", attach), { code: "COMMIT_UNCERTAIN" }); }
  finally { fs.rename = originalRename; }
  assert.equal((await core(f).read("session")).currentComparisonId, "first");
  fs.rename = async (...args) => { await originalRename(...args); throw Object.assign(new Error("lost"), { code: "EIO" }); };
  try { await assert.rejects(store.mutate("session", "attach", attach), { code: "COMMIT_UNCERTAIN" }); }
  finally { fs.rename = originalRename; }
  store = core(f);
  assert.equal((await store.mutate("session", "attach", attach)).view.currentComparisonId, "second");
  assert.equal((await store.events("session")).pending.length, 1, "attachment does not acknowledge receipt");
  await f.unchanged(assert); await next.unchanged(assert);
  await fs.appendFile(file, "broken"); const corrupt = await fs.readFile(file);
  await assert.rejects(core(f).read("session"), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(core(f).create(input(f)), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await fs.readFile(file), corrupt);
});

test("session, one-shot, agent and pane capabilities stay separate; routes never accept destination paths", async (t) => {
  const f = await fixture(t); const s = await listen(t, f);
  const opened = await create(s, f, "../sessions");
  const second = await create(s, f, "..");
  assert.equal((await request(s.port, route("../sessions"))).status, 401);
  assert.equal((await s.api(route("../sessions"), { token: opened.browser, headers: { host: "evil.test" } })).status, 403);
  assert.equal((await s.api(route(".."), { token: opened.browser })).status, 403);
  assert.equal((await s.api("/api/double/~trial", { token: opened.browser })).status, 403);
  assert.equal((await s.api("/api/session", { token: opened.browser, method: "POST", body: { file: f.manifest.panes.left.original.entry } })).status, 401);
  const retry = { actionId: "retry", expectedRevision: 0, requestId: "request", attemptId: "attempt" };
  assert.equal((await post(s, "/retry", retry, opened.browser, "..")).status, 403);
  assert.equal((await post(s, "/retry", retry, second.browser, "../sessions")).status, 403);
  for (const op of ["reopen", "events", "ack", "fail", "attach", "output"]) {
    assert.equal((await post(s, `/${op}`, { file: "/unreadable" }, opened.browser, "../sessions")).status, 403, op);
  }
  assert.equal((await s.api("/api/double", { token: opened.browser, method: "POST", body: f.manifest })).status, 403);
  assert.equal((await s.api("/api/double/sessions", { token: opened.browser, method: "POST", body: input(f) })).status, 403);
  const one = await s.api("/api/double", { method: "POST", body: f.manifest });
  const dom = new JSDOM((await request(s.port, one.json.path)).text);
  assert.equal((await s.api(route("../sessions"), { token: dom.window.document.body.dataset.token })).status, 403);
  assert.equal((await post(s, "/retry", retry, dom.window.document.body.dataset.token, "../sessions")).status, 403); dom.window.close();
  const frameUrl = opened.view.comparison.panes.left.frameUrl;
  assert.equal((await request(s.port, frameUrl.replace("/left/", "/right/"))).status, 404);
  assert.equal((await s.api(route("../sessions"), { token: frameUrl.split("/")[2] })).status, 401);
  assert.equal((await post(s, "/retry", retry, frameUrl.split("/")[2], "../sessions")).status, 401);
  assert.equal((await request(s.port, frameUrl.replace("index.html", "../../server.json"))).status, 404);
  for (const segment of ["~%2e", "~%7Etrial", "~%", "~%20"]) assert.equal((await s.api(`/api/double/sessions/${segment}`)).json.error.code, "INVALID_SEGMENT");
  assert.equal((await s.api(route("..") + "?path=/tmp/output")).status, 400);
  const rejected = await post(s, "/end", { actionId: "end", expectedRevision: 0, comparisonId: "trial", pane: "left", outputDir: f.root }, second.browser, "..");
  assert.equal(rejected.json.error.code, "INVALID_REQUEST");
  assert.equal((await s.api(route("..", "/output"), { method: "POST", body: { outputDir: f.root } })).status, 405);
  assert.equal((await core(f).read("..")).revision, 0);
  const beforeOneShot = await fs.readFile(f.record);
  const oldFrame = await request(s.port, frameUrl);
  assert.equal(oldFrame.status, 200);
  await fs.appendFile(path.join(f.manifest.panes.right.copy.root, "assets/site.css"), " body {color:red}");
  assert.equal((await request(s.port, frameUrl)).json.error.code, "FILE_CHANGED", "session transport checks the complete pair");
  assert.equal((await post(s, "/next", { actionId: "next-no-copies", expectedRevision: 0, comparisonId: "trial" }, opened.browser, "../sessions")).status, 200);
  assert.equal((await core(f).read("../sessions")).status, "generating");
  assert.deepEqual(await fs.readFile(f.record), beforeOneShot, "session operations never modify a matching one-shot archive");
});

for (const tag of ["html", "head", "body", "td"]) {
  test(`final deletion of accepted ${tag} markers keeps safe static material and connected CSS`, async (t) => {
    const f = await fixture(t);
    const snippets = {
      html: '<html data-double-id="root" data-container="Root" hidden="until-found" inert style="background:red"><head><style>html::before{content:"root"}</style></head><body>Remove</body></html>',
      head: '<html><head data-double-id="root" data-container="Head" style="display:block!important"><style>head{display:block}head::before{content:"head"}body{color:red}</style></head><body>Keep</body></html>',
      body: '<html><head><style>body{background:red}</style></head><body data-double-id="root" data-container="Body" inert style="display:block!important">Remove</body></html>',
      td: '<table><tr><td data-double-id="root" data-container="Cell">Remove</td><td>Keep</td></tr></table>',
    };
    const file = path.join(f.manifest.panes.left.copy.root, "index.html");
    await fs.writeFile(file, `<!doctype html>${snippets[tag]}`);
    const before = await fs.readFile(file);
    const store = core(f); await store.create(input(f));
    await store.mutate("session", "act", { actionId: "delete", expectedRevision: 0, comparisonId: "trial", action: { kind: "delete", pane: "left", componentId: "root" } });
    await store.mutate("session", "end", { actionId: "end", expectedRevision: 1, comparisonId: "trial", pane: "left" });
    const output = await store.output("session");
    const dom = new JSDOM(Buffer.from(output.page.files[0].base64, "base64").toString());
    const element = dom.window.document.querySelector(tag);
    assert.equal(element.style.display, "none"); assert.equal(element.style.getPropertyPriority("display"), "important");
    if (tag === "head") assert.equal(dom.window.getComputedStyle(dom.window.document.body).color, "rgb(255, 0, 0)");
    if (tag === "html") { assert.ok(element.hasAttribute("inert")); assert.equal(element.getAttribute("hidden"), "until-found"); }
    dom.window.close(); assert.deepEqual(await fs.readFile(file), before);
  });
}

test("session CLI uses exact JSON requests, returns recoverable events, and reopens after a server restart", async (t) => {
  const f = await fixture(t); let s = await listen(t, f);
  const record = async () => fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ port: s.port, token: s.token, pid: process.pid, protocol: SERVER_PROTOCOL }), { mode: 0o600 });
  await record();
  const file = path.join(f.root, "request.json");
  const run = async (args, body) => {
    if (body) await fs.writeFile(file, JSON.stringify(body));
    const r = await cli(f, [...args, ...(body ? [file] : [])]);
    assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const opened = await run(["create"], input(f, "."));
  const sent = await run(["next", "."], { actionId: "next", expectedRevision: 0, comparisonId: "trial" });
  const events = await run(["events", "."]);
  assert.equal(events.pending[0], sent.result.eventId);
  await s.close(); s = await listen(t, f); await record();
  assert.equal((await request(s.port, opened.path)).status, 404);
  const reopened = await run(["reopen", "."]);
  assert.notEqual(reopened.path, opened.path);
  assert.equal(reopened.view.status, "generating");
  assert.deepEqual(await run(["events", "."]), events);
  const fail = { actionId: "fail", requestId: sent.result.requestId, attemptId: sent.result.attemptId, message: "Lost worker" };
  const failed = await run(["fail", "."], fail);
  assert.equal(failed.view.status, "failed");
  assert.deepEqual((await run(["fail", "."], fail)).result, failed.result);
  const retry = { actionId: "retry", expectedRevision: 2, requestId: fail.requestId, attemptId: fail.attemptId };
  const retried = await run(["retry", "."], retry);
  assert.equal(retried.view.status, "generating");
  assert.deepEqual((await run(["retry", "."], retry)).result, retried.result);
  assert.equal((await run(["fail", "."], { ...fail, actionId: "fail-retry", attemptId: retried.result.attemptId })).view.status, "failed");
  const ended = await run(["end", "."], { actionId: "end", expectedRevision: 4, comparisonId: "trial", pane: "right" });
  await run(["ack", "."], { actionId: "ack-next", eventId: sent.result.eventId });
  assert.deepEqual((await run(["events", "."])).pending, [retried.result.eventId, ended.result.eventId]);
  const output = await run(["output", "."]);
  assert.equal(output.page.files[0].sha256, f.hashes.get(path.join(f.manifest.panes.right.copy.root, "index.html")));
  const invalid = await cli(f, ["attach", ".", "/missing.json", "extra"]); assert.equal(invalid.code, 1);
  await f.unchanged(assert);
});
