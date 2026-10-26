import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, listen, request } from "./double-fixtures.js";
import { bootSharedGui } from "../src/shared-gui-shell.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { initTheme, THEMES, THEME_KEY } from "../src/theme.js";

export async function until(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail("Shared GUI state did not settle");
}
export async function page(t, s, shellPath, { storage, loseStart = false } = {}) {
  const base = `http://127.0.0.1:${s.port}`;
  const response = await request(s.port, shellPath);
  assert.equal(response.status, 200);
  const dom = new JSDOM(response.text, { url: base + shellPath });
  if (storage) for (const [key, value] of storage) dom.window.localStorage.setItem(key, value);
  const calls = [];
  const shell = bootSharedGui(dom.window, { base, refreshMs: 40, fetch: async (url, init) => {
    calls.push({ url, ...init });
    const answer = await fetch(url, init);
    if (loseStart && url.endsWith("/gui/start")) { loseStart = false; await answer.arrayBuffer(); throw new TypeError("Lost start response"); }
    return answer;
  } });
  const close = () => { shell.close(); dom.window.close(); };
  t.after(close);
  await until(() => shell.state);
  return { shell, calls, win: dom.window, $: (id) => dom.window.document.getElementById(id), close,
    storage: () => Object.keys(dom.window.localStorage).map((key) => [key, dom.window.localStorage.getItem(key)]) };
}
const post = (s, url, body, token) => s.api(url, { method: "POST", body, ...(token ? { token } : {}) });
const root = (id) => `/api/double/sessions/${encodeDoubleComparisonId(id)}`;

// Each scenario uses real shell actions, authenticated HTTP and the durable stores.
test("shared Walkr shell retains all seven themes and restores the saved Statue preference", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const bound = await post(s, "/api/double/gui/connect", { piSessionId: "theme-origin", piSessionFile: f.root + "/pi.jsonl" });
  const p = await page(t, s, bound.json.path, { storage: [[THEME_KEY, "statue-light"]] });
  const picker = p.win.document.querySelector("[data-theme-picker]");
  assert.equal(p.win.document.title, "Double · Walkr");
  assert.equal(p.win.document.querySelector(".double-brand").textContent, "Walkr");
  assert.ok(picker.closest("label"));
  assert.equal(THEMES.length, 7);
  assert.deepEqual([...picker.options].map((option) => ({ value: option.value, label: option.textContent })), THEMES);
  assert.ok(p.win.document.querySelector('link[href="/theme.css"]'));
  const dispose = initTheme(p.win);
  try {
    assert.equal(picker.value, "statue-light");
    for (const { value } of THEMES) {
      picker.value = value;
      picker.dispatchEvent(new p.win.Event("change"));
      assert.equal(p.win.document.documentElement.dataset.theme, value);
      assert.equal(p.win.localStorage.getItem(THEME_KEY), value);
    }
    picker.value = "statue-dark";
    picker.dispatchEvent(new p.win.Event("change"));
    const q = await page(t, s, bound.json.path, { storage: p.storage() });
    const disposeReload = initTheme(q.win);
    try { assert.equal(q.win.document.documentElement.dataset.theme, "statue-dark"); }
    finally { disposeReload(); q.close(); }
    assert.equal(p.calls.some((call) => call.method === "POST"), false, "theme changes never submit work");
  } finally { dispose(); p.close(); }
});

test("GUI uncertain initial start survives reload, retries once, validates atomically, and preserves End while disconnected", async (t) => {
  let cleanup = () => {};
  t.after(() => cleanup());
  const f = await fixture(t), s = await listen(t, f);
  const bound = await post(s, "/api/double/gui/connect", { piSessionId: "pi-origin", piSessionFile: f.root + "/pi.jsonl" });
  assert.equal(bound.status, 200);
  let p = await page(t, s, bound.json.path, { loseStart: true });
  cleanup = () => p.close();
  p.$("brief").value = "  Design <script>untrusted</script> without source writes.  ";
  p.$("brief").dispatchEvent(new p.win.Event("input"));
  const draft = p.$("brief").value;
  p.$("startDouble").click();
  assert.equal(p.$("title").textContent, "Double", "mode changes before HTTP completes");
  await until(() => !p.$("startRetry").hidden && !p.$("startRetry").disabled);
  const starts = p.calls.filter((c) => c.url.endsWith("/gui/start"));
  const firstBody = JSON.parse(starts[0].body);
  const state = (await s.api("/api/double/gui")).json;
  const id = state.currentSessionId;
  assert.equal(state.view.comparison, null);
  assert.equal(state.view.brief, draft);
  assert.equal(state.history.length, 1);
  assert.equal((await post(s, "/api/double/gui/start", { ...firstBody, actionId: "another" })).status, 409);
  assert.equal((await post(s, "/api/double/gui/start", { ...firstBody, brief: "changed" })).json.error.code, "ACTION_CONFLICT");
  const stored = p.storage(); p.close();
  p = await page(t, s, bound.json.path, { storage: stored });
  assert.equal(p.$("brief").value, draft);
  assert.equal(p.calls.some((c) => c.method === "POST"), false, "reload never auto-submits a pending action or draft");
  p.$("startRetry").click();
  await until(() => p.$("startRetry").hidden);
  assert.deepEqual(JSON.parse(p.calls.find((c) => c.url.endsWith("/gui/start")).body), firstBody);
  assert.equal((await s.api(root(id) + "/events")).json.events.length, 1);
  let v = (await s.api(root(id))).json.view;
  const bad = { actionId: "bad-pair", requestId: v.generation.requestId, attemptId: v.generation.attempt.id,
    manifest: { ...f.manifest, panes: {} } };
  const failure = await post(s, root(id) + "/attach", bad);
  assert.equal(failure.status, 200);
  assert.equal(failure.json.view.status, "failed");
  assert.equal(failure.json.view.comparison, null);
  assert.deepEqual((await post(s, root(id) + "/attach", bad)).json.result, failure.json.result);
  await until(() => !p.$("initialRetry").hidden);
  p.$("initialRetry").click();
  await until(async () => (await s.api(root(id))).json.view.status === "generating");
  v = (await s.api(root(id))).json.view;
  assert.notEqual(v.generation.attempt.id, bad.attemptId);
  assert.equal((await post(s, root(id) + "/attach", { ...bad, actionId: "stale", manifest: f.manifest })).status, 409);
  const attached = await post(s, root(id) + "/attach", { actionId: "pair", requestId: v.generation.requestId, attemptId: v.generation.attempt.id, manifest: f.manifest });
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  await until(() => p.shell.pair?.controller.getState().view?.comparison);
  assert.match(p.$("frame-left").src, /double-artifact/);
  assert.equal(p.$("frame-left").getAttribute("sandbox"), "allow-scripts");
  assert.ok(!p.$("frame-left").src.includes(p.win.document.body.dataset.token));
  let controller = p.shell.pair.controller;
  await controller.act({ kind: "feedback-delete", pane: "right", componentId: "hero", feedback: "Exact saved feedback" });
  await post(s, "/api/double/gui/disconnect", { leaseId: bound.json.leaseId });
  await until(() => !p.shell.state.connection.connected);
  assert.equal(p.$("next").disabled, true);
  assert.equal((await controller.next()).ok, false);
  v = controller.getState().view;
  const end = await controller.end("right", v.currentComparisonId, v.revision);
  assert.equal(end.ok, true, JSON.stringify(end));
  await until(() => p.$("guiStatus").textContent.includes("pending"));
  const output = (await s.api(root(id) + "/output")).json;
  assert.deepEqual(output.page.deletedComponentIds, ["hero"]);
  assert.equal(output.history.length, 1);
  const reconnect = await post(s, "/api/double/gui/connect", state.origin);
  assert.equal(reconnect.status, 200);
  assert.deepEqual((await s.api(root(id) + "/output")).json, output);
  assert.equal((await post(s, "/api/double/gui/connect", { ...state.origin, piSessionId: "wrong-chat" })).status, 403);
  await f.unchanged(assert);
});

test("initial Stop rejects late work; restart preserves requests and requires explicit failure then Retry", async (t) => {
  let cleanup = () => {};
  t.after(() => cleanup());
  const f = await fixture(t), s = await listen(t, f);
  const origin = { piSessionId: "bound", piSessionFile: f.root + "/bound.jsonl" };
  const connected = (await post(s, "/api/double/gui/connect", origin)).json;
  const p = await page(t, s, connected.path);
  cleanup = () => p.close();
  p.$("brief").value = "Saved cancellation brief";
  p.$("brief").dispatchEvent(new p.win.Event("input")); p.$("startDouble").click();
  await until(() => p.shell.state.view?.status === "generating" && !p.$("initialStop").disabled);
  const cancelled = p.shell.state.view;
  p.$("initialStop").click();
  await until(() => p.shell.state.view?.status === "stopped").catch((e) => { e.message += `: ${p.$("guiStatus").textContent} ${JSON.stringify(p.shell.state)}`; throw e; });
  assert.equal((await s.api(root(cancelled.sessionId) + "/output")).status, 409);
  assert.equal((await post(s, root(cancelled.sessionId) + "/attach", { actionId: "late", requestId: cancelled.generation.requestId,
    attemptId: cancelled.generation.attempt.id, manifest: f.manifest })).status, 409);
  p.$("startDouble").click();
  await until(() => p.shell.state.view?.status === "generating");
  const interrupted = p.shell.state.view;
  p.close(); await s.close();
  const restarted = await listen(t, f);
  assert.equal((await request(restarted.port, connected.path)).status, 404);
  const restored = await post(restarted, "/api/double/gui/connect", origin);
  assert.equal(restored.status, 200);
  assert.equal(restored.json.recoveryRequired, true);
  assert.equal(restored.json.history.length, 2);
  const late = { actionId: "late-after-restart", requestId: interrupted.generation.requestId,
    attemptId: interrupted.generation.attempt.id, manifest: f.manifest };
  assert.equal((await post(restarted, root(interrupted.sessionId) + "/attach", late)).json.error.code, "STALE_ATTEMPT");
  const q = await page(t, restarted, restored.json.path);
  cleanup = () => { p.close(); q.close(); };
  q.$("brief").value = "Draft saved during recovery";
  q.$("brief").dispatchEvent(new q.win.Event("input"));
  await until(async () => (await restarted.api("/api/double/gui")).json.draft === q.$("brief").value);
  q.$("recoverGeneration").click();
  await until(() => q.shell.state.view.status === "failed");
  q.$("initialRetry").click();
  await until(() => q.shell.state.view.status === "generating" && !q.shell.state.recoveryRequired);
  const v = q.shell.state.view;
  assert.notEqual(v.generation.attempt.id, interrupted.generation.attempt.id);
  assert.equal((await post(restarted, root(v.sessionId) + "/attach", { ...late, actionId: "recovered-pair", attemptId: v.generation.attempt.id })).status, 200);
  await until(() => q.shell.pair?.controller.getState().view?.comparison);
  const browserToken = q.win.document.body.dataset.token;
  assert.equal((await post(restarted, root(v.sessionId) + "/ack", { actionId: "not-agent", eventId: "unknown" }, browserToken)).status, 403);
  assert.equal((await post(restarted, "/api/double/gui/connect", origin, browserToken)).status, 403);
  await f.unchanged(assert);
});
