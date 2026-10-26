import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { assertHostedTarget, escapeHtml } from "../src/hosted.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-hosted-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
process.env.HUMAN_REVIEW_HOSTED = "1";
process.env.HUMAN_REVIEW_PUBLIC_URL = "https://review.example.test";
process.env.HUMAN_REVIEW_ROOTS = JSON.stringify([path.join(tmp, "project")]);
fs.mkdirSync(path.join(tmp, "project"));
const file = path.join(tmp, "project", "page.html");
fs.writeFileSync(file, "<p>Original</p>");
fs.writeFileSync(path.join(tmp, "secret.html"), "outside");
fs.writeFileSync(path.join(tmp, "project", ".env"), "secret");
fs.symlinkSync(path.join(tmp, "secret.html"), path.join(tmp, "project", "escape.html"));

test("hosted targets require exact approved roots and file types", () => {
  assert.doesNotThrow(() => assertHostedTarget({ kind: "file", value: file }));
  for (const value of [path.join(tmp, "secret.html"), path.join(tmp, "project", "escape.html"), path.join(tmp, "project", ".env")]) {
    assert.throws(() => assertHostedTarget({ kind: "file", value }), /approved project mount/);
  }
  assert.throws(() => assertHostedTarget({ kind: "url", value: "http://localhost:80" }), /not localhost/);
  assert.equal(escapeHtml('<x "&">'), "&lt;x &quot;&amp;&quot;&gt;");
});

test("hosted API retains tokens, denies URLs, and exposes a session index", async (t) => {
  const { start } = await import("../src/server.js");
  const { port, token, dispose } = await start();
  t.after(dispose);
  const base = `http://127.0.0.1:${port}`;
  const post = (target, authenticated = true) => fetch(`${base}/api/session`, {
    method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-human-review-token": token } : {}) },
    body: JSON.stringify({ target }),
  });
  assert.equal((await post(file, false)).status, 401);
  const rejected = await new Promise((resolve, reject) => {
    http.get(`${base}/health`, { headers: { Host: "foreign.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(rejected, 403);
  const opened = await post(file);
  assert.equal(opened.status, 200);
  const session = await opened.json();
  const home = await (await fetch(base)).text();
  assert.ok(home.includes(session.path));
  assert.ok(home.includes('<title>Walkr</title>'));
  assert.ok(home.includes('<h1>Walkr</h1>'));
  assert.ok(home.includes('/srv/walkr/workspace'));
  assert.ok(home.includes('page.html'));
  assert.ok(!home.includes(token));
  assert.ok(home.includes('data-theme-picker'));
  for (const route of ['/theme.css', '/theme.js', '/home.css']) {
    const asset = await fetch(base + route);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'no-store');
    assert.ok(!(await asset.text()).includes(token));
  }
  const chrome = await (await fetch(base + session.path)).text();
  assert.ok(chrome.includes('<title>Walkr</title>'));
  assert.ok(chrome.includes('Original Light'));
  assert.ok(chrome.includes('Original Dark'));
  assert.ok(chrome.includes('sandbox="allow-scripts allow-forms allow-modals"'));
  assert.notEqual((await post("http://127.0.0.1:80")).status, 200);
  assert.notEqual((await post(path.join(tmp, "secret.html"))).status, 200);
  assert.notEqual((await post(path.join(tmp, "project", "escape.html"))).status, 200);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
