import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { JSDOM } from "jsdom";
import { fixture, listen, request } from "./double-fixtures.js";
import { initTheme, THEMES } from "../src/theme.js";

const modes = ["core", "double", "coinflip", "trainer"];
function checkShell(html, active) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:1234" });
  const doc = dom.window.document;
  const nav = doc.querySelector('nav[aria-label="Walkr modes"]');
  assert.ok(nav);
  assert.equal(doc.querySelectorAll(".mode-nav").length, 1);
  const links = [...nav.querySelectorAll("a")];
  assert.deepEqual(links.map((a) => a.textContent), ["Core", "Double", "Coinflip", "Trainer"]);
  assert.deepEqual(links.map((a) => a.getAttribute("href")), modes.map((mode) => `/_walkr/modes/${mode}`));
  assert.deepEqual(links.map((a) => a.title), modes.map((mode) => `walkr-${mode}`));
  assert.ok(links.every((a) => a.getAttribute("referrerpolicy") === "no-referrer"));
  assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
  assert.equal(nav.querySelector('[aria-current="page"]').title, `walkr-${active}`);
  assert.ok(doc.querySelector('link[href="/_walkr/modes.css"]'));
  const picker = doc.querySelector("[data-theme-picker]");
  assert.deepEqual([...picker.options].map((o) => ({ value: o.value, label: o.textContent })), THEMES);
  const dispose = initTheme(dom.window);
  for (const { value } of THEMES) {
    picker.value = value;
    picker.dispatchEvent(new dom.window.Event("change"));
    assert.equal(doc.documentElement.dataset.theme, value);
    assert.equal(nav.querySelector('[aria-current="page"]').title, `walkr-${active}`);
  }
  dispose();
  dom.window.close();
}

test("every application shell retains navigation and all seven themes without inserting menus into frames", async () => {
  for (const [file, active] of [["hosted-home.html", "core"], ["chrome.html", "core"], ["double.html", "double"], ["double-session-shell.html", "double"]]) {
    checkShell(await fs.readFile(new URL(`../src/${file}`, import.meta.url), "utf8"), active);
  }
});

test("public guidance routes create no private Double authority or archive and retain hosted guard precedence", async (t) => {
  const f = await fixture(t), s = await listen(t, f, { HUMAN_REVIEW_HOSTED: "1" });
  const previous = process.env.HUMAN_REVIEW_HOSTED;
  process.env.HUMAN_REVIEW_HOSTED = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.HUMAN_REVIEW_HOSTED;
    else process.env.HUMAN_REVIEW_HOSTED = previous;
  });
  const home = await request(s.port, "/");
  assert.equal(home.status, 200);
  checkShell(home.text, "core");
  assert.ok(!home.text.includes(s.token));
  for (const mode of modes) {
    const response = await request(s.port, `/_walkr/modes/${mode}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    checkShell(response.text, mode);
    assert.ok(!response.text.includes(s.token));
    assert.doesNotMatch(response.text, /data-token|data-archive|\/double-gui\/|\/double-artifact\/|\/artifact\/|\/s\/[a-f0-9]/);
    assert.doesNotMatch(response.text, /<iframe|<button|<textarea|<form/);
    assert.equal((await request(s.port, `/_walkr/modes/${mode}`, { method: "POST" })).status, 405);
  }
  assert.equal((await request(s.port, "/_walkr/modes.css")).status, 200);
  const foreign = await request(s.port, "/_walkr/modes/double", { headers: { Host: "foreign.example" } });
  assert.equal(foreign.status, 403);
  for (const route of ["/api/double/gui", "/api/double/gui/connect", "/api/double/unknown?bad=1"]) {
    const unauthenticated = await request(s.port, route);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.json.error.code, "UNAUTHORIZED");
    const authenticated = await s.api(route);
    assert.equal(authenticated.status, 403);
    assert.equal(authenticated.json.error.code, "HOSTED_UNSUPPORTED");
  }
  assert.equal((await request(s.port, "/double-gui/unknown")).json.error.code, "HOSTED_UNSUPPORTED");
  assert.equal(await fs.stat(f.archiveDir).catch(() => null), null);
  await f.unchanged(assert);
});

test("Double private shells retain active menu, explicit chat binding, isolated artifacts, and no public recovery", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const created = await s.api("/api/double", { method: "POST", body: f.manifest });
  assert.equal(created.status, 200);
  const oneShot = await request(s.port, created.json.path);
  checkShell(oneShot.text, "double");
  const session = await s.api("/api/double/sessions", { method: "POST", body: { sessionId: "rounds", brief: "Offline menu check", manifest: { ...f.manifest, comparisonId: "round-pair" } } });
  assert.equal(session.status, 200);
  const sessionShell = await request(s.port, session.json.path);
  checkShell(sessionShell.text, "double");
  const origin = { piSessionId: "menu-origin", piSessionFile: f.root + "/pi.jsonl" };
  const connected = await s.api("/api/double/gui/connect", { method: "POST", body: origin });
  assert.equal(connected.status, 200);
  const guiShell = await request(s.port, connected.json.path);
  checkShell(guiShell.text, "double");
  const dom = new JSDOM(guiShell.text);
  const browserToken = dom.window.document.body.dataset.token;
  assert.notEqual(browserToken, s.token);
  assert.doesNotMatch(guiShell.text, new RegExp(s.token));
  dom.window.close();
  const before = (await s.api("/api/double/gui")).json;
  const guidance = await request(s.port, "/_walkr/modes/double");
  checkShell(guidance.text, "double");
  for (const secret of [s.token, browserToken, connected.json.path, origin.piSessionId, origin.piSessionFile, created.json.path]) assert.ok(!guidance.text.includes(secret));
  assert.doesNotMatch(guidance.text, /data-token|data-shared-gui|\/api\/double/);
  const after = (await s.api("/api/double/gui")).json;
  assert.deepEqual(after, before, "guidance does not bind, reconnect, or mutate GUI state");
  assert.equal((await request(s.port, "/api/double/gui/connect")).status, 401);
  assert.equal((await request(s.port, "/api/double/gui/connect", { token: browserToken, method: "POST", body: origin })).status, 403);
  const shellDom = new JSDOM(oneShot.text);
  const paneToken = shellDom.window.document.body.dataset.token;
  shellDom.window.close();
  const view = await request(s.port, "/api/double/~trial", { token: paneToken });
  const frame = await request(s.port, view.json.view.panes.left.frameUrl);
  assert.equal(frame.status, 200);
  assert.doesNotMatch(frame.text, /mode-nav|_walkr\/modes|data-token/);
  for (const secret of [s.token, browserToken, paneToken]) assert.ok(!frame.text.includes(secret));
  await f.unchanged(assert);
});

test("mode routes preserve Core shells and arbitrary local-app proxy paths without listing local capabilities", async (t) => {
  const app = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<p>App ${req.url}</p>`); });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const f = await fixture(t), s = await listen(t, f);
  const opened = await s.api("/api/session", { method: "POST", body: { target: `http://127.0.0.1:${app.address().port}/app` } });
  assert.equal(opened.status, 200);
  const coreShell = await request(s.port, opened.json.path);
  checkShell(coreShell.text, "core");
  const artifact = await request(s.port, `/artifact/${opened.json.artifactToken}/${opened.json.key}/index.html`);
  assert.equal(artifact.status, 200);
  assert.doesNotMatch(artifact.text, /mode-nav|_walkr\/modes/);
  for (const route of ["/", "/core", "/coinflip", "/trainer", "/modes/double", "/_walkr/modes/custom", "/_walkr/modes/core/child", "/_walkr/modes/double?app=1"]) {
    const proxied = await request(s.port, route);
    assert.equal(proxied.status, 200);
    assert.equal(proxied.text, `<p>App ${route}</p>`);
  }
  for (const mode of modes) {
    const entry = await request(s.port, `/_walkr/modes/${mode}`);
    checkShell(entry.text, mode);
    for (const secret of [s.token, opened.json.path, opened.json.artifactToken]) assert.ok(!entry.text.includes(secret));
  }
});
