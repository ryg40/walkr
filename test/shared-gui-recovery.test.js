import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { fixture, listen, request } from "./double-fixtures.js";
import { bootSharedGui } from "../src/shared-gui-shell.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";

const post = (s, route, body) => s.api(route, { method: "POST", body });
const root = (id) => `/api/double/sessions/${encodeDoubleComparisonId(id)}`;
async function until(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail("Shared GUI recovery did not settle");
}
async function setup(t) {
  const f = await fixture(t), s = await listen(t, f);
  const origin = { piSessionId: "recovery-origin", piSessionFile: f.root + "/pi.jsonl" };
  const bound = await post(s, "/api/double/gui/connect", origin);
  assert.equal(bound.status, 200);
  return { f, s, origin, bound: bound.json };
}
async function page(t, s, shellPath, { storage = [], intercept = (_url, _init, next) => next() } = {}) {
  const base = `http://127.0.0.1:${s.port}`;
  const response = await request(s.port, shellPath);
  assert.equal(response.status, 200);
  const dom = new JSDOM(response.text, { url: base + shellPath });
  for (const [key, value] of storage) dom.window.localStorage.setItem(key, value);
  const calls = [];
  const shell = bootSharedGui(dom.window, { base, refreshMs: 60_000, fetch: async (url, init) => {
    const call = { url, ...init }; calls.push(call);
    const answer = await intercept(url, init, () => fetch(url, init));
    call.status = answer.status;
    if (init.method === "POST") call.answer = await answer.clone().json().catch(() => null);
    return answer;
  } });
  let closed = false;
  const close = () => { if (!closed) { closed = true; shell.close(); dom.window.close(); } };
  t.after(close);
  await until(() => shell.state);
  const $ = (id) => dom.window.document.getElementById(id);
  const key = `shared-gui:${dom.window.document.body.dataset.archive}:pending`;
  return { shell, calls, $, win: dom.window, close,
    pending: () => JSON.parse(dom.window.localStorage.getItem(key) ?? "null"),
    storage: () => Object.keys(dom.window.localStorage).map((key) => [key, dom.window.localStorage.getItem(key)]),
    draft(text) { $("brief").value = text; $("brief").dispatchEvent(new dom.window.Event("input")); },
    async settled() { await until(() => !$("startRetry").disabled); },
  };
}
const starts = (p) => p.calls.filter((c) => c.url.endsWith("/gui/start"));
async function stop(p) {
  assert.equal(p.$("initialStop").hidden, false);
  assert.equal(p.$("initialStop").disabled, false);
  p.$("initialStop").click(); await p.settled();
  assert.equal(p.shell.state.view.status, "stopped");
}

test("stale idle tab rejects start without trapping Stop, draft, history, or a later explicit start", async (t) => {
  const { f, s, bound } = await setup(t);
  const a = await page(t, s, bound.path), b = await page(t, s, bound.path);
  a.draft("First tab brief"); a.$("startDouble").click(); await a.settled();
  assert.equal(b.shell.state.history.length, 0, "second tab still reads idle");
  b.draft("Second tab draft"); b.$("startDouble").click(); await b.settled();
  assert.equal(starts(b)[0].answer.error.code, "ACTIVE_SESSION");
  assert.equal(b.pending(), null, "a definitive rejected start must not remain pending");
  assert.equal(b.$("brief").value, "Second tab draft");
  assert.equal(b.shell.state.history.length, 1);
  await stop(b);
  const storage = b.storage(); b.close();
  const reloaded = await page(t, s, bound.path, { storage });
  assert.equal(reloaded.$("brief").value, "Second tab draft");
  assert.equal(reloaded.calls.some((c) => c.method === "POST"), false);
  reloaded.$("startDouble").click(); await reloaded.settled();
  assert.equal(reloaded.shell.state.history.length, 2);
  assert.equal(reloaded.shell.state.history[0].status, "stopped");
  assert.equal(reloaded.shell.state.view.brief, "Second tab draft");
  assert.notEqual(JSON.parse(starts(reloaded)[0].body).actionId, JSON.parse(starts(b)[0].body).actionId);
  await f.unchanged(assert);
});

test("stale idle start rejection leaves the active pair editable and End accessible", async (t) => {
  const { f, s, bound } = await setup(t);
  const p = await page(t, s, bound.path);
  const active = await post(s, "/api/double/gui/start", { actionId: "other-tab", mode: "double", brief: "Other tab" });
  const v = active.json.view;
  assert.equal((await post(s, root(v.sessionId) + "/attach", { actionId: "pair", requestId: v.generation.requestId,
    attemptId: v.generation.attempt.id, manifest: f.manifest })).status, 200);
  p.draft("Keep this later draft"); p.$("startDouble").click(); await p.settled();
  await until(() => p.shell.pair?.controller.getState().view?.comparison);
  assert.equal(p.pending(), null);
  assert.equal(p.$("endOpen").disabled, false);
  assert.equal((await p.shell.pair.controller.act({ kind: "feedback-delete", pane: "right", componentId: "hero", feedback: "Saved note" })).ok, true);
  p.$("endOpen").click();
  const choice = p.win.document.querySelector('input[name="endPane"][value="right"]');
  choice.checked = true; choice.dispatchEvent(new p.win.Event("change")); p.$("endConfirm").click();
  await until(() => p.shell.pair.controller.getState().view.status === "ended");
  const output = (await s.api(root(v.sessionId) + "/output")).json;
  assert.deepEqual(output.page.deletedComponentIds, ["hero"]);
  assert.equal(output.history.length, 1);
  assert.equal(p.$("brief").value, "Keep this later draft");
  await f.unchanged(assert);
});

for (const lostBeforeSave of [false, true]) test(`disconnected start settles ${lostBeforeSave ? "earlier network uncertainty after reload" : "a fresh connection race"}`, async (t) => {
  const { s, bound, origin } = await setup(t);
  let lose = lostBeforeSave;
  let p = await page(t, s, bound.path, { intercept: (url, _init, next) => {
    if (lose && url.endsWith("/gui/start")) { lose = false; throw new TypeError("Lost before dispatch"); }
    return next();
  } });
  p.draft("Disconnected draft");
  if (!lostBeforeSave) await post(s, "/api/double/gui/disconnect", { leaseId: bound.leaseId });
  p.$("startDouble").click(); await p.settled();
  const original = JSON.parse(starts(p)[0].body);
  if (lostBeforeSave) {
    assert.deepEqual(p.pending().body, original);
    await post(s, "/api/double/gui/disconnect", { leaseId: bound.leaseId });
    const storage = p.storage(); p.close(); p = await page(t, s, bound.path, { storage });
    assert.equal(starts(p).length, 0);
    p.$("startRetry").click(); await p.settled();
    assert.deepEqual(JSON.parse(starts(p)[0].body), original);
  }
  assert.equal(starts(p).at(-1).answer.error.code, "DISCONNECTED");
  assert.equal(p.pending(), null);
  assert.equal(p.shell.state.history.length, 0);
  assert.equal(p.$("brief").value, "Disconnected draft");
  assert.equal(p.$("startDouble").disabled, true);
  assert.equal((await post(s, "/api/double/gui/connect", origin)).status, 200);
  await p.shell.load();
  assert.equal(p.shell.state.history.length, 0, "reconnect must not resubmit");
  p.$("startDouble").click(); await p.settled();
  assert.equal(p.shell.state.history.length, 1);
  assert.notEqual(JSON.parse(starts(p).at(-1).body).actionId, original.actionId);
});

test("lost-before-save start settles through ACTIVE_SESSION on exact retry after reload", async (t) => {
  const { s, bound } = await setup(t);
  let p = await page(t, s, bound.path, { intercept: (url, _init, next) => {
    if (url.endsWith("/gui/start")) throw new TypeError("Lost before dispatch");
    return next();
  } });
  p.draft("Uncertain draft"); p.$("startDouble").click(); await p.settled();
  const original = p.pending();
  await post(s, "/api/double/gui/start", { actionId: "winner", mode: "double", brief: "Another tab won" });
  const storage = p.storage(); p.close(); p = await page(t, s, bound.path, { storage });
  assert.deepEqual(p.pending(), original);
  assert.equal(p.$("initialStop").disabled, true);
  assert.equal(starts(p).length, 0);
  p.$("startRetry").click(); await p.settled();
  assert.equal(starts(p)[0].answer.error.code, "ACTIVE_SESSION");
  assert.deepEqual(JSON.parse(starts(p)[0].body), original.body);
  assert.equal(p.pending(), null);
  assert.equal(p.$("brief").value, original.body.brief);
  await stop(p);
});

test("start WRITE_FAILED after reservation keeps the complete request until saved replay, even disconnected", async (t) => {
  const { f, s, bound } = await setup(t);
  const p = await page(t, s, bound.path);
  const open = fs.open;
  const fault = t.mock.method(fs, "open", async (file, ...args) => {
    if (String(file).includes("/.double-session-")) throw Object.assign(new Error("Session write failed"), { code: "EIO" });
    return open(file, ...args);
  });
  p.draft("Reserved before failure"); p.$("startDouble").click(); await p.settled();
  fault.mock.restore();
  assert.equal(starts(p)[0].answer.error.code, "WRITE_FAILED");
  const original = JSON.parse(starts(p)[0].body);
  assert.deepEqual(p.pending()?.body, original, "WRITE_FAILED may follow a committed start reservation");
  const record = JSON.parse(await fs.readFile(f.archiveDir + "/" + (await fs.readdir(f.archiveDir)).find((name) => name.startsWith("shared-gui-")), "utf8"));
  assert.deepEqual(record.starts[0].request, original);
  await post(s, "/api/double/gui/disconnect", { leaseId: bound.leaseId });
  const storage = p.storage(); p.close();
  const q = await page(t, s, bound.path, { storage });
  assert.equal(starts(q).length, 0);
  q.$("startRetry").click(); await q.settled();
  assert.equal(q.pending(), null);
  assert.deepEqual(JSON.parse(starts(q)[0].body), original);
  assert.equal(starts(q)[0].answer.result.actionId, original.actionId);
  assert.equal(q.shell.state.history.length, 1);
  assert.equal((await s.api(root(q.shell.state.currentSessionId) + "/events")).json.events.length, 1);
  await stop(q);
});

// Faults occur around real authenticated HTTP, not a replacement controller/store.
for (const fault of ["network", "malformed-success", "wrong-receipt", "unknown-error", "authorization", "transport", "recovery-required"]) {
  test(`saved start retains its exact request across reload and ${fault}, then replays even with another active session`, async (t) => {
    const { f, s, bound } = await setup(t);
    const p = await page(t, s, bound.path, { intercept: async (url, _init, next) => {
      const answer = await next();
      if (url.endsWith("/gui/start")) { await answer.arrayBuffer(); throw new TypeError("Lost saved response"); }
      return answer;
    } });
    p.draft("Original uncertain brief"); p.$("startDouble").click(); await p.settled();
    const original = p.pending();
    assert.ok(original);
    const state = (await s.api("/api/double/gui")).json;
    await post(s, root(state.currentSessionId) + "/stop", { actionId: "stop-elsewhere", expectedRevision: state.view.revision });
    await post(s, "/api/double/gui/start", { actionId: "new-elsewhere", mode: "double", brief: "Another active session" });
    await post(s, "/api/double/gui/disconnect", { leaseId: bound.leaseId });
    const storage = p.storage(); p.close();
    const q = await page(t, s, bound.path, { storage, intercept: async (url, init, next) => {
      if (!url.endsWith("/gui/start")) return next();
      if (fault === "network") throw new TypeError("Transport did not answer");
      if (fault === "authorization") return fetch(url, { ...init, headers: { ...init.headers, "x-human-review-token": "expired" } });
      if (fault === "recovery-required") {
        const open = fs.open;
        const mock = t.mock.method(fs, "open", async (file, ...args) => {
          if (String(file).startsWith(f.archiveDir + "/shared-gui-")) throw Object.assign(new Error("Read unavailable"), { code: "EIO" });
          return open(file, ...args);
        });
        try {
          const answer = await next();
          assert.equal((await answer.clone().json()).error.code, "RECOVERY_REQUIRED");
          return answer;
        } finally { mock.mock.restore(); }
      }
      const answer = await next(), payload = await answer.json();
      assert.equal(payload.result.actionId, original.body.actionId, "store returns saved receipt before current-state rejection");
      if (fault === "malformed-success") return new Response("not JSON", { status: 200 });
      if (fault === "wrong-receipt") { delete payload.result.sessionId; return Response.json(payload); }
      return Response.json({ error: { code: fault === "transport" ? "HTTP_408" : "NEW_UNKNOWN_ERROR", message: "Unsettled" } }, { status: fault === "transport" ? 408 : 409 });
    } });
    assert.deepEqual(q.pending(), original);
    assert.equal(starts(q).length, 0);
    q.$("startRetry").click(); await q.settled();
    assert.deepEqual(q.pending(), original, `${fault} cannot settle an earlier unknown outcome`);
    assert.equal(q.$("initialStop").disabled, true);
    assert.deepEqual(JSON.parse(starts(q)[0].body), original.body);
    const againStorage = q.storage(); q.close();
    const r = await page(t, s, bound.path, { storage: againStorage });
    assert.deepEqual(r.pending(), original);
    assert.equal(starts(r).length, 0);
    r.$("startRetry").click(); await r.settled();
    assert.equal(r.pending(), null);
    assert.deepEqual(JSON.parse(starts(r)[0].body), original.body);
    assert.equal(starts(r)[0].answer.result.sessionId, state.currentSessionId);
    assert.equal(r.shell.state.history.length, 2);
    assert.equal((await s.api(root(state.currentSessionId) + "/events")).json.events.length, 1);
    assert.equal(r.$("brief").value, original.body.brief);
    await stop(r);
  });
}

test("COMMIT_UNCERTAIN from the real start reservation keeps the original action across reload", async (t) => {
  const { s, bound } = await setup(t);
  const p = await page(t, s, bound.path);
  const rename = fs.rename;
  const mock = t.mock.method(fs, "rename", async (...args) => {
    await rename(...args);
    if (String(args[1]).includes("/shared-gui-")) throw Object.assign(new Error("Lost sync"), { code: "EIO" });
  });
  p.draft("Uncertain reservation"); p.$("startDouble").click(); await p.settled(); mock.mock.restore();
  assert.equal(starts(p)[0].answer.error.code, "COMMIT_UNCERTAIN");
  const original = p.pending();
  assert.deepEqual(original.body, JSON.parse(starts(p)[0].body));
  const storage = p.storage(); p.close();
  const q = await page(t, s, bound.path, { storage });
  assert.equal(starts(q).length, 0);
  q.$("startRetry").click(); await q.settled();
  assert.equal(q.pending(), null);
  assert.deepEqual(JSON.parse(starts(q)[0].body), original.body);
  assert.equal(q.shell.state.history.length, 1);
  assert.equal((await s.api(root(q.shell.state.currentSessionId) + "/events")).json.events.length, 1);
});

for (const fault of ["malformed-success", "unknown-error", "authorization"]) test(`fresh ${fault} never guesses a start outcome`, async (t) => {
  const { s, bound } = await setup(t);
  const p = await page(t, s, bound.path, { intercept: async (url, init, next) => {
    if (!url.endsWith("/gui/start")) return next();
    if (fault === "authorization") return fetch(url, { ...init, headers: { ...init.headers, "x-human-review-token": "invalid" } });
    const answer = await next(); await answer.arrayBuffer();
    return fault === "malformed-success" ? new Response("bad JSON", { status: 200 }) :
      Response.json({ error: { code: "UNKNOWN", message: "Unknown outcome" } }, { status: 409 });
  } });
  p.draft("Fresh unknown"); p.$("startDouble").click(); await p.settled();
  const original = p.pending();
  assert.deepEqual(original.body, JSON.parse(starts(p)[0].body));
  const storage = p.storage(); p.close();
  const q = await page(t, s, bound.path, { storage });
  assert.deepEqual(q.pending(), original);
  assert.equal(starts(q).length, 0);
  q.$("startRetry").click(); await q.settled();
  assert.equal(q.pending(), null);
  assert.deepEqual(JSON.parse(starts(q)[0].body), original.body);
  assert.equal(q.shell.state.history.length, 1);
});

test("initial Retry connection race releases Stop without creating another attempt", async (t) => {
  const { s, bound } = await setup(t);
  const p = await page(t, s, bound.path);
  p.draft("Retry race"); p.$("startDouble").click(); await p.settled();
  p.$("recoverGeneration").click(); await p.settled();
  const failed = p.shell.state.view;
  assert.equal(failed.status, "failed");
  await post(s, "/api/double/gui/disconnect", { leaseId: bound.leaseId });
  p.$("initialRetry").click(); await p.settled();
  assert.equal(p.calls.find((c) => c.url.endsWith("/retry")).answer.error.code, "DISCONNECTED");
  assert.equal(p.pending(), null);
  assert.deepEqual(p.shell.state.view.generation, failed.generation);
  await stop(p);
});

test("lost initial recovery settles a stale attempt rejection without hiding Stop", async (t) => {
  const { s, bound } = await setup(t);
  let lose = true;
  const p = await page(t, s, bound.path, { intercept: (url, _init, next) => {
    if (lose && url.endsWith("/recover")) { lose = false; throw new TypeError("Lost before save"); }
    return next();
  } });
  p.draft("Recovery race"); p.$("startDouble").click(); await p.settled();
  const v = p.shell.state.view;
  p.$("recoverGeneration").click(); await p.settled();
  const original = p.pending();
  assert.equal(original.op, "recover");
  assert.equal((await post(s, root(v.sessionId) + "/recover", { ...original.body, actionId: "other-recovery" })).status, 200);
  const storage = p.storage(); p.close();
  const q = await page(t, s, bound.path, { storage });
  assert.equal(q.calls.some((c) => c.method === "POST"), false);
  q.$("startRetry").click(); await q.settled();
  const retry = q.calls.find((c) => c.url.endsWith("/recover"));
  assert.deepEqual(JSON.parse(retry.body), original.body);
  assert.equal(retry.answer.error.code, "STALE_ATTEMPT");
  assert.equal(q.pending(), null);
  await stop(q);
});
