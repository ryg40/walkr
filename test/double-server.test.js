import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { JSDOM } from "jsdom";
import { fixture, listen, request, digest } from "./double-fixtures.js";
import { createFetchTransport } from "../src/double.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { DoubleStore } from "../src/double-store.js";
import { createDoubleHandler } from "../src/double-server.js";

const route = (id, suffix = "") => `/api/double/${encodeDoubleComparisonId(id)}${suffix}`;
async function opened(s, f) {
  const response = await s.api("/api/double", { method: "POST", body: f.manifest });
  assert.equal(response.status, 200);
  return response.json;
}

test("accepted IDs retain exact identity through real HTTP fetch, actions, Send and receipt", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  for (const comparisonId of [".", "..", "%2e", "%2E%2E", "%2F", ".%2e", "~", "~~", "~trial", "a/b", "a\\b", "a?b#c", "capabilities", "reopen", "\u65e5\u672c\u8a9e", "x".repeat(201)]) {
    const created = await s.api("/api/double", { method: "POST", body: { ...f.manifest, comparisonId } });
    assert.equal(created.status, 200);
    const transport = createFetchTransport({ comparisonId, token: s.token, base: `http://127.0.0.1:${s.port}` });
    assert.equal((await transport.load()).view.comparisonId, comparisonId);
    const action = { actionId: "probe", expectedRevision: 0, kind: "keeper", pane: "left", componentId: "hero", selected: true };
    assert.equal((await transport.act(action)).result.actionId, action.actionId);
    const sent = await transport.send({ actionId: "send", expectedRevision: 1 });
    assert.equal(sent.view.comparisonId, comparisonId);
    const polled = await s.api(route(comparisonId, "/poll"));
    assert.equal(polled.json.batch.comparisonId, comparisonId);
    const ack = await s.api(route(comparisonId, "/ack"), { method: "POST", body: { actionId: "ack", batchId: sent.result.batchId } });
    assert.equal(ack.status, 200);
  }
  await f.unchanged(assert);
});

test("Double HTTP lifecycle preserves evidence, receipts and source/copy bytes through recovery", async (t) => {
  const f = await fixture(t);
  let s = await listen(t, f);
  const initial = await opened(s, f);
  assert.equal(initial.view.revision, 0);
  const oldPath = initial.path;
  const shell = await request(s.port, initial.path);
  const dom = new JSDOM(shell.text);
  const browserToken = dom.window.document.body.dataset.token;
  assert.ok(browserToken && browserToken !== s.token, "shell credentials are scoped, not the agent token");
  dom.window.close();
  let revision = 0;
  const act = async (data) => {
    const body = { actionId: `action-${revision}`, expectedRevision: revision, ...data };
    const reply = await s.api(route(f.manifest.comparisonId, "/actions"), { method: "POST", body, token: browserToken });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.result.actionId, body.actionId);
    revision++;
    await f.unchanged(assert);
    return reply.json;
  };
  assert.equal((await s.api(route("trial", "/poll"))).json.batch, null);
  await act({ kind: "keeper", pane: "left", componentId: "hero", selected: true });
  await act({ kind: "keeper", pane: "left", componentId: "hero", selected: false });
  await act({ kind: "keeper", pane: "left", componentId: "hero", selected: true });
  await act({ kind: "delete", pane: "left", componentId: "hero" });
  await act({ kind: "undo", deletionActionId: "action-3" });
  const first = await act({ kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "First correction" });
  assert.equal(first.view.panes.right.components[0].deleted, false);
  const beforeUndo = JSON.parse(await fs.readFile(f.record, "utf8")).feedback[0];
  await act({ kind: "undo", deletionActionId: "action-5" });
  await act({ kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "Final correction" });
  await act({ kind: "delete", pane: "right", componentId: "footer" });
  await act({ kind: "keeper", pane: "right", componentId: "hero", selected: true });
  assert.deepEqual((await s.api(route("trial"))).json.view.history.map((r) => r.undone), [true, true, false, false]);
  const sentRequest = { actionId: "send-once", expectedRevision: revision };
  const sent = await s.api(route("trial", "/send"), { method: "POST", body: sentRequest });
  assert.equal(sent.status, 200);
  const batch = (await s.api(route("trial", "/poll"))).json.batch;
  assert.equal(batch.id, sent.json.result.batchId);
  assert.equal(batch.payload.keepers[0].identity.pane, "right");
  assert.equal(batch.payload.feedbackDeletions[0].identity.pane, "left");
  assert.match(batch.payload.feedback[0].html, /left copy/);
  assert.deepEqual(batch.payload.feedback[0], beforeUndo);
  assert.equal(batch.payload.historicalFeedback[0].undone, true);
  assert.deepEqual((await s.api(route("trial", "/send"), { method: "POST", body: sentRequest })).json.result, sent.json.result);
  await f.unchanged(assert);
  await s.close();
  // Restoration never needs access to writable originals.
  for (const file of f.manifest.panes.left.original.files) await fs.chmod(file.path, 0o400);
  s = await listen(t, f);
  assert.equal((await request(s.port, oldPath)).status, 404);
  const restored = await s.api(route("trial", "/reopen"), { method: "POST", body: {} });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.view.status, "sent");
  assert.notEqual(restored.json.path, oldPath);
  assert.deepEqual((await s.api(route("trial", "/poll"))).json.batch, batch);
  assert.deepEqual((await s.api(route("trial", "/poll"))).json.batch, batch);
  assert.equal((await s.api(route("trial", "/actions"), { method: "POST", body: { actionId: "late", expectedRevision: revision + 1, kind: "undo", deletionActionId: "action-7" } })).json.error.code, "READ_ONLY");
  const ack = { actionId: "receipt", batchId: batch.id };
  const received = await s.api(route("trial", "/ack"), { method: "POST", body: ack });
  assert.equal(received.status, 200);
  assert.deepEqual((await s.api(route("trial", "/ack"), { method: "POST", body: ack })).json.result, received.json.result);
  assert.equal((await s.api(route("trial", "/poll"))).json.batch, null);
  await s.close();
  s = await listen(t, f);
  assert.equal((await s.api(route("trial", "/poll"))).json.batch, null);
  assert.equal((await s.api(route("trial", "/status"))).json.status, "sent");
  const saved = JSON.parse(await fs.readFile(f.record, "utf8"));
  assert.deepEqual(saved.delivery.batch, batch);
  assert.deepEqual(saved.feedback[0], beforeUndo);
  assert.deepEqual(s.store.data.pages, {});
  assert.ok(!JSON.stringify(saved).includes(browserToken), "credentials never enter archive evidence");
  await f.unchanged(assert);
});

test("Double rejects unauthenticated APIs, guessed shells, mixed authority and hostile Host", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  const value = await opened(s, f);
  const shell = await request(s.port, value.path);
  const dom = new JSDOM(shell.text);
  const token = dom.window.document.body.dataset.token;
  assert.equal(dom.window.document.querySelector("iframe").getAttribute("sandbox"), "allow-scripts");
  dom.window.close();
  for (const endpoint of ["/api/double", "/api/double/capabilities", route("trial"), ...["actions", "send", "reopen", "status", "poll", "ack"].map((p) => route("trial", `/${p}`))]) {
    assert.equal((await request(s.port, endpoint)).status, 401);
    assert.equal((await request(s.port, endpoint, { token: "wrong" })).status, 401);
    assert.equal((await s.api(endpoint, { headers: { host: "evil.example" } })).status, 403);
  }
  assert.equal((await request(s.port, `/double/trial`)).status, 404);
  assert.equal((await request(s.port, `/double/${s.token}`)).status, 404);
  for (const suffix of ["/ack", "/poll", "/status", "/reopen"]) {
    assert.equal((await s.api(route("trial", suffix), { token })).status, 403);
  }
  assert.equal((await s.api("/api/session", { token, method: "POST", body: { file: f.manifest.panes.left.original.entry } })).status, 401);
  assert.equal((await request(s.port, value.path, { headers: { host: "evil.example" } })).status, 403);
  for (const pane of ["left", "right"]) {
    const frame = await request(s.port, value.view.panes[pane].frameUrl);
    assert.equal(frame.status, 200);
    assert.ok(!frame.text.includes(token) && !frame.text.includes(s.token));
    const document = new JSDOM(frame.text).window.document;
    const scripts = [...document.scripts];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].getAttribute("src"), "/double-sdk.js");
    assert.equal(scripts[0].dataset.pane, pane);
    assert.equal(scripts[0].dataset.comparisonId, "trial");
    document.defaultView.close();
    assert.equal(frame.headers["x-content-type-options"], "nosniff");
    assert.equal(frame.headers["cache-control"], "no-store");
    assert.equal(frame.headers["referrer-policy"], "no-referrer");
    assert.match(frame.headers["content-security-policy"], /sandbox allow-scripts/);
    assert.ok(!frame.headers["content-security-policy"].includes("allow-same-origin"));
  }
  for (const file of ["/double.js", "/double-route.js", "/double-selection.js", "/double.css", "/double-sdk.js", "/theme.js", "/theme.css"]) {
    assert.equal((await request(s.port, file)).status, 200);
  }
  assert.match((await request(s.port, "/double.js")).text, /import "\.\/theme.js"/);
  await f.unchanged(assert);
});


test("Double transport rejects malformed routes and never treats IDs as paths", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  await opened(s, f);
  for (const segment of ["~", "~%", "~%GG", "~%2e", "~%7Etrial", "~%20", "~%00", "~%E2%80%8B"]) {
    const response = await s.api(`/api/double/${segment}`);
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "INVALID_SEGMENT");
  }
  for (const raw of ["/api/double/trial", "/api/double/.", "/api/double/..", "/api/double/%2e", "/api/double/~trial/../status", "/api/double/~trial/snapshot"]) {
    assert.equal((await s.api(raw)).status, 404);
  }
  assert.equal((await s.api(route("trial") + "?token=wrong")).status, 400);
  assert.equal((await s.api(route("trial"), { method: "POST", body: {} })).status, 405);
  assert.equal((await s.api(route("trial", "/actions"), { method: "POST", rawBody: "{" })).json.error.code, "INVALID_REQUEST");
  await f.unchanged(assert);
});

test("Double artifact authority is pane-specific and serves only declared checked assets", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  const value = await opened(s, f);
  const left = value.view.panes.left.frameUrl;
  const prefix = left.slice(0, -"index.html".length);
  const capability = left.split("/")[2];
  for (const tail of ["../index.html", "%2e%2e/index.html", "assets/../../index.html", "%69ndex.html", "assets/%2Fsite.css", "sibling.html", "server.json", "state.json", path.basename(f.record), f.manifest.panes.left.original.entry, "index.html/extra"]) {
    assert.equal((await request(s.port, prefix + tail)).status, 404);
  }
  assert.equal((await request(s.port, left.replace("/left/", "/right/"))).status, 404);
  assert.equal((await request(s.port, left.replace(capability, "0".repeat(64)))).status, 404);
  assert.equal((await request(s.port, `/double/${capability}`)).status, 404);
  assert.equal((await s.api(route("trial"), { token: capability })).status, 401);
  const shellCapability = value.path.split("/").at(-1);
  assert.equal((await request(s.port, left.replace(capability, shellCapability))).status, 404);
  for (const [name, type] of [["assets/site.css", "text/css; charset=utf-8"], ["assets/image.png", "image/png"]]) {
    const response = await request(s.port, prefix + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], type);
    assert.equal(digest(response.bytes), f.hashes.get(path.join(f.manifest.panes.left.copy.root, name)));
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
  }
  const second = await s.api("/api/double", { method: "POST", body: { ...f.manifest, comparisonId: "second" } });
  const dom = new JSDOM((await request(s.port, value.path)).text);
  const token = dom.window.document.body.dataset.token;
  dom.window.close();
  assert.equal((await s.api(route("second"), { token })).status, 403);
  assert.equal(second.status, 200);
  await f.unchanged(assert);
});

for (const change of ["changed-asset", "changed-entry", "file-symlink", "parent-symlink", "hardlink", "file-replacement", "directory-replacement"]) {
  test(`Double copy checks fail closed after ${change}`, async (t) => {
    const f = await fixture(t);
    const s = await listen(t, f);
    const value = await opened(s, f);
    const root = f.manifest.panes.left.copy.root;
    const file = path.join(root, "assets/site.css");
    const old = path.join(f.root, "prior");
    if (change === "changed-asset") await fs.appendFile(file, " body { color: red; }");
    if (change === "changed-entry") await fs.appendFile(path.join(root, "index.html"), "changed");
    if (change === "file-symlink") {
      await fs.rename(file, old);
      await fs.symlink(f.manifest.panes.left.original.files[1].path, file);
    }
    if (change === "parent-symlink") {
      await fs.rename(path.join(root, "assets"), old);
      await fs.symlink(old, path.join(root, "assets"));
    }
    if (change === "hardlink") await fs.link(file, old);
    if (change === "file-replacement") {
      const bytes = await fs.readFile(file);
      await fs.rename(file, old);
      await fs.writeFile(file, bytes);
    }
    if (change === "directory-replacement") {
      await fs.rename(root, old);
      await fs.mkdir(root);
      for (const entry of ["index.html", "assets"]) await fs.rename(path.join(old, entry), path.join(root, entry));
    }
    for (const pane of ["left", "right"]) {
      const response = await request(s.port, value.view.panes[pane].frameUrl);
      assert.equal(response.status, 409);
      assert.equal(response.json.error.code, "FILE_CHANGED");
      assert.ok(!response.text.includes(root));
    }
    assert.equal((await s.api(route("trial", "/reopen"), { method: "POST", body: {} })).status, 409);
    for (const pane of ["left", "right"]) for (const file of f.manifest.panes[pane].original.files) {
      assert.equal(digest(await fs.readFile(file.path)), file.sha256);
    }
  });
}

test("Double serves captured bytes, not a second unchecked file stream", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  const value = await opened(s, f);
  const frame = value.view.panes.left.frameUrl;
  const target = path.join(f.manifest.panes.left.copy.root, "assets/site.css");
  const before = await fs.readFile(target);
  const writeHead = http.ServerResponse.prototype.writeHead;
  let changed = false;
  const mock = t.mock.method(http.ServerResponse.prototype, "writeHead", function (...args) {
    if (!changed && args[1]?.["content-type"] === "text/css; charset=utf-8") {
      changed = true;
      writeFileSync(target, "body { color: red; }");
    }
    return writeHead.apply(this, args);
  });
  // Count reads on the target. The response must be the one checked buffer.
  const open = fs.open.bind(fs);
  let reads = 0;
  const readMock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === target) reads++;
    return open(file, ...args);
  });
  const response = await request(s.port, frame.replace("index.html", "assets/site.css"));
  mock.mock.restore();
  readMock.mock.restore();
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, before);
  assert.equal(reads, 1);
  assert.equal(changed, true);
  assert.equal((await request(s.port, frame)).json.error.code, "FILE_CHANGED");
  await fs.writeFile(target, before);
  await f.unchanged(assert);
});

test("Double malformed and hosted inputs fail without file reads or a partial comparison", async (t) => {
  const f = await fixture(t);
  const hosted = await listen(t, f, { HUMAN_REVIEW_HOSTED: "1" });
  const open = fs.open.bind(fs);
  let reads = 0;
  const mock = t.mock.method(fs, "open", async (...args) => { reads++; return open(...args); });
  const rejected = await hosted.api("/api/double", { method: "POST", body: f.manifest });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.json.error.code, "HOSTED_UNSUPPORTED");
  for (const route of ["/api/double/gui", "/api/double/gui/connect", "/api/double/gui/start"]) {
    const response = await hosted.api(route, route.endsWith("/gui") ? {} : { method: "POST", body: {} });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "HOSTED_UNSUPPORTED");
  }
  assert.equal((await request(hosted.port, "/double-gui/not-a-capability")).json.error.code, "HOSTED_UNSUPPORTED");
  assert.equal(reads, 0);
  const s = await listen(t, f);
  for (const input of [null, {}, { ...f.manifest, comparisonId: "bad id" }, { ...f.manifest, extra: true }]) {
    assert.equal((await s.api("/api/double", { method: "POST", body: input })).json.error.code, "INVALID_INPUT");
  }
  assert.equal(reads, 0);
  mock.mock.restore();
  await fs.appendFile(path.join(f.manifest.panes.right.copy.root, "index.html"), '<script src="https://example.test/a.js"></script>');
  const invalid = await s.api("/api/double", { method: "POST", body: f.manifest });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.diagnostics[0].pane, "right");
  assert.equal((await s.api(route("trial"))).status, 404);
  assert.equal((await fs.readdir(f.archiveDir).catch(() => [])).length, 0);
  const disabled = await listen(t, f, { HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: "" });
  assert.equal((await disabled.api("/api/double/capabilities")).json.error.code, "DOUBLE_DISABLED");
});

test("Double escaping preserves raw malicious IDs and labels without adding bootstrap markup", async (t) => {
  const id = '</script><script>__TOKEN__&"\'~%2F';
  const f = await fixture(t, id);
  f.manifest.label = '<img src=x onerror="bad()">';
  f.manifest.panes.left.label = '<script>bad()</script>';
  const s = await listen(t, f);
  const value = await opened(s, f);
  const shell = await request(s.port, value.path);
  const dom = new JSDOM(shell.text);
  assert.equal(dom.window.document.body.dataset.comparison, id);
  assert.equal(dom.window.document.scripts.length, 1);
  assert.equal(dom.window.document.querySelectorAll("[onerror]").length, 0);
  const token = dom.window.document.body.dataset.token;
  dom.window.close();
  for (const pane of ["left", "right"]) {
    const response = await request(s.port, value.view.panes[pane].frameUrl);
    const frame = new JSDOM(response.text);
    assert.equal(frame.window.document.scripts.length, 1);
    assert.equal(frame.window.document.scripts[0].dataset.comparisonId, id);
    assert.equal(frame.window.document.scripts[0].dataset.pane, pane);
    assert.ok(!response.text.includes(token) && !response.text.includes(s.token));
    assert.match(response.headers["content-security-policy"], /default-src 'none'/);
    frame.window.close();
  }
  assert.equal(value.view.label, f.manifest.label);
  const saved = await fs.readFile(f.record, "utf8");
  assert.ok(!saved.includes(token) && !saved.includes(s.token));
  await f.unchanged(assert);
});

test("Double failed writes, uncertain commits and lost responses keep exact retry identities", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  await opened(s, f);
  const transport = createFetchTransport({ comparisonId: "trial", token: s.token, base: `http://127.0.0.1:${s.port}` });
  const action = { actionId: "feedback-once", expectedRevision: 0, kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "Exact saved evidence" };
  const open = fs.open.bind(fs);
  let mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file.endsWith(".tmp")) throw Object.assign(new Error("private path must not leak"), { code: "EIO" });
    return open(file, ...args);
  });
  await assert.rejects(transport.act(action), { code: "WRITE_FAILED" });
  mock.mock.restore();
  assert.equal((await transport.load()).view.revision, 0);
  const rename = fs.rename.bind(fs);
  mock = t.mock.method(fs, "rename", async (...args) => { await rename(...args); throw Object.assign(new Error("lost completion"), { code: "EIO" }); });
  await assert.rejects(transport.act(action), { code: "COMMIT_UNCERTAIN" });
  mock.mock.restore();
  assert.equal((await transport.load()).view.revision, 1);
  const retried = await transport.act(action);
  assert.deepEqual(retried.result, { actionId: action.actionId, kind: action.kind, revision: 1 });
  await assert.rejects(transport.act({ ...action, feedback: "changed" }), { code: "ACTION_CONFLICT" });
  await assert.rejects(transport.act({ ...action, actionId: "stale" }), { code: "STALE_REVISION" });
  const sent = { actionId: "send-once", expectedRevision: 1 };
  mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file.endsWith(".tmp")) throw Object.assign(new Error("write failed"), { code: "EIO" });
    return open(file, ...args);
  });
  await assert.rejects(transport.send(sent), { code: "WRITE_FAILED" });
  mock.mock.restore();
  assert.equal((await transport.load()).view.status, "editing");
  const lossy = createFetchTransport({ comparisonId: "trial", token: s.token, base: `http://127.0.0.1:${s.port}`,
    fetch: async (...args) => { await fetch(...args); throw new Error("lost response"); } });
  await assert.rejects(lossy.send(sent), { code: "NETWORK" });
  const result = await transport.send(sent);
  assert.equal(result.result.actionId, sent.actionId);
  assert.equal(result.view.revision, 2);
  const saved = JSON.parse(await fs.readFile(f.record, "utf8"));
  assert.equal(saved.feedback.length, 1);
  assert.equal(saved.receipts.length, 2);
  assert.deepEqual(saved.receipts.map((r) => r.request), [action, sent]);
  await f.unchanged(assert);
});

test("Double restart preserves corrupt and unreadable archives without resetting or exposing artifacts", async (t) => {
  const f = await fixture(t);
  let s = await listen(t, f);
  const initial = await opened(s, f);
  const bytes = await fs.readFile(f.record);
  await s.close();
  const broken = Buffer.from("not an archive");
  await fs.writeFile(f.record, broken);
  s = await listen(t, f);
  for (const endpoint of [route("trial"), route("trial", "/poll"), route("trial", "/status")]) {
    assert.equal((await s.api(endpoint)).json.error.code, "RECOVERY_REQUIRED");
  }
  for (const [endpoint, body] of [["/api/double", f.manifest], [route("trial", "/reopen"), {}], [route("trial", "/send"), { actionId: "s", expectedRevision: 0 }]]) {
    assert.equal((await s.api(endpoint, { method: "POST", body })).json.error.code, "RECOVERY_REQUIRED");
  }
  assert.equal((await request(s.port, initial.path)).status, 404);
  assert.deepEqual(await fs.readFile(f.record), broken);
  await fs.writeFile(f.record, bytes);
  const open = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.record) throw Object.assign(new Error("private failure"), { code: "EACCES" });
    return open(file, ...args);
  });
  assert.equal((await s.api(route("trial"))).json.error.code, "RECOVERY_REQUIRED");
  mock.mock.restore();
  assert.deepEqual(await fs.readFile(f.record), bytes);
  await f.unchanged(assert);
});


test("Double editing recovery does not reread originals and keeps correction evidence intact", async (t) => {
  const f = await fixture(t);
  let s = await listen(t, f);
  await opened(s, f);
  const actions = [
    { kind: "keeper", pane: "left", componentId: "hero", selected: true },
    { kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "Before recovery" },
    { kind: "undo", deletionActionId: "a1" },
  ];
  for (const [index, data] of actions.entries()) {
    assert.equal((await s.api(route("trial", "/actions"), { method: "POST", body: { actionId: `a${index}`, expectedRevision: index, ...data } })).status, 200);
  }
  const before = JSON.parse(await fs.readFile(f.record, "utf8"));
  await s.close();
  for (const pane of ["left", "right"]) for (const file of f.manifest.panes[pane].original.files) await fs.chmod(file.path, 0o400);
  s = await listen(t, f);
  const open = fs.open.bind(fs);
  let originalReads = 0;
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file.includes("original-")) { originalReads++; throw Object.assign(new Error("No source access"), { code: "EACCES" }); }
    return open(file, ...args);
  });
  const reopened = await s.api(route("trial", "/reopen"), { method: "POST", body: {} });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.view.status, "editing");
  assert.equal(reopened.json.view.panes.left.components[0].keeper, true);
  assert.equal(reopened.json.view.history[0].undone, true);
  assert.equal((await s.api("/api/double", { method: "POST", body: f.manifest })).json.view.revision, 3);
  assert.equal((await request(s.port, reopened.json.view.panes.left.frameUrl)).status, 200);
  const correction = { actionId: "a3", expectedRevision: 3, kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "After recovery" };
  assert.equal((await s.api(route("trial", "/actions"), { method: "POST", body: correction })).status, 200);
  mock.mock.restore();
  assert.equal(originalReads, 0);
  const saved = JSON.parse(await fs.readFile(f.record, "utf8"));
  assert.deepEqual(saved.feedback[0], before.feedback[0]);
  assert.equal(saved.feedback.length, 2);
  await f.unchanged(assert);
});

test("Double ack failures and lost receipt replies never delete the batch or unlock the comparison", async (t) => {
  const f = await fixture(t);
  const s = await listen(t, f);
  await opened(s, f);
  const sent = await s.api(route("trial", "/send"), { method: "POST", body: { actionId: "s", expectedRevision: 0 } });
  const batch = (await s.api(route("trial", "/poll"))).json.batch;
  const ack = { actionId: "receipt", batchId: sent.json.result.batchId };
  const open = fs.open.bind(fs);
  let mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file.endsWith(".tmp")) throw Object.assign(new Error("cannot write"), { code: "EIO" });
    return open(file, ...args);
  });
  assert.equal((await s.api(route("trial", "/ack"), { method: "POST", body: ack })).json.error.code, "WRITE_FAILED");
  mock.mock.restore();
  assert.deepEqual((await s.api(route("trial", "/poll"))).json.batch, batch);
  const rename = fs.rename.bind(fs);
  mock = t.mock.method(fs, "rename", async (...args) => { await rename(...args); throw Object.assign(new Error("uncertain ack"), { code: "EIO" }); });
  assert.equal((await s.api(route("trial", "/ack"), { method: "POST", body: ack })).json.error.code, "COMMIT_UNCERTAIN");
  mock.mock.restore();
  const receipt = await s.api(route("trial", "/ack"), { method: "POST", body: ack });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.view.revision, 2);
  assert.equal((await s.api(route("trial", "/poll"))).json.batch, null);
  const saved = JSON.parse(await fs.readFile(f.record, "utf8"));
  assert.deepEqual(saved.delivery.batch, batch);
  assert.equal(saved.receipts.length, 2);
  const again = await s.api(route("trial", "/ack"), { method: "POST", body: { ...ack, actionId: "receipt-again" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.view.status, "sent");
  assert.equal(JSON.parse(await fs.readFile(f.record, "utf8")).delivery.acknowledgedAt, saved.delivery.acknowledgedAt);
  const late = await s.api(route("trial", "/actions"), { method: "POST", body: { actionId: "late", expectedRevision: 3, kind: "keeper", pane: "left", componentId: "hero", selected: true } });
  assert.equal(late.json.error.code, "READ_ONLY");
  await f.unchanged(assert);
});

test("Double does not issue frame authority when changed copies prevent a complete pair", async (t) => {
  const f = await fixture(t);
  let s = await listen(t, f);
  await opened(s, f);
  await s.close();
  await fs.appendFile(path.join(f.manifest.panes.right.copy.root, "assets/site.css"), "changed");
  s = await listen(t, f);
  const before = await fs.readFile(f.record);
  const reopened = await s.api(route("trial", "/reopen"), { method: "POST", body: {} });
  assert.equal(reopened.json.error.code, "FILE_CHANGED");
  assert.equal(reopened.json.path, undefined);
  const view = await s.api(route("trial"));
  assert.equal(view.status, 200);
  assert.equal(view.json.view.panes.left.frameUrl, undefined);
  assert.equal(view.json.view.panes.right.frameUrl, undefined);
  assert.deepEqual(await fs.readFile(f.record), before);
});


test("Double shell imports, nested assets and head-less injection resolve without changing copies", async (t) => {
  const f = await fixture(t);
  for (const pane of ["left", "right"]) {
    const copy = f.manifest.panes[pane].copy;
    const source = '<!-- </head> --><section data-double-id="hero" data-container="Hero"><img src="assets/image.png" alt="Preview"></section>';
    await fs.writeFile(path.join(copy.root, "index.html"), source);
    f.hashes.set(path.join(copy.root, "index.html"), digest(source));
  }
  const s = await listen(t, f);
  const value = await opened(s, f);
  const html = (await request(s.port, value.path)).text;
  const shell = new JSDOM(html);
  const resources = [...shell.window.document.querySelectorAll("script[src],link[href]")].map((node) => node.getAttribute("src") || node.getAttribute("href"));
  for (const resource of resources) assert.equal((await request(s.port, resource)).status, 200);
  for (const name of ["double.js", "theme.js", "double-route.js"]) {
    const response = await request(s.port, `/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  }
  shell.window.close();
  for (const pane of ["left", "right"]) {
    const response = await request(s.port, value.view.panes[pane].frameUrl);
    const frame = new JSDOM(response.text);
    assert.equal(frame.window.document.scripts.length, 1);
    assert.equal(frame.window.document.querySelectorAll("[data-double-id]").length, 1);
    assert.equal(frame.window.document.scripts[0].getAttribute("src"), "/double-sdk.js");
    frame.window.close();
  }
  await f.unchanged(assert);
});

test("Double separates runtime state from copy and archive roots before issuing capabilities", async (t) => {
  const f = await fixture(t);
  const store = new DoubleStore({ archiveDir: f.archiveDir });
  await store.create(f.manifest);
  const token = "temporary-test-credential";
  const handler = createDoubleHandler({ token, archiveDir: f.archiveDir, stateDir: f.manifest.panes.left.copy.root, hosted: false });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const port = server.address().port;
  for (const [endpoint, body] of [["/api/double", f.manifest], [route("trial", "/reopen"), {}]]) {
    assert.equal((await request(port, endpoint, { token, method: "POST", body })).json.error.code, "UNSAFE_PATH");
  }
  const s = await listen(t, f, { HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.stateDir });
  assert.equal((await s.api("/api/double/capabilities")).json.error.code, "UNSAFE_PATH");
  await f.unchanged(assert);
});
