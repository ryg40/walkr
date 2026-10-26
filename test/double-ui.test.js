import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { DoubleStore } from "../src/double-store.js";
import { decodeDoubleComparisonId } from "../src/double-route.js";
import { THEMES } from "../src/theme.js";
import {
  CHANNEL,
  bootDouble,
  createDoubleController,
  createFetchTransport,
  mountDoubleShell,
  parseFrameMessage,
  safeFrameUrl,
  validateView,
} from "../src/double.js";

const HTML = fs.readFileSync(new URL("../src/double.html", import.meta.url), "utf8");
const CSS = fs.readFileSync(new URL("../src/double.css", import.meta.url), "utf8");
const SDK = fs.readFileSync(new URL("../src/double-sdk.js", import.meta.url), "utf8");
const ID = "trial-1";
const ID_DEFAULT = ID;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------ fixtures

function baseView() {
  return {
    comparisonId: ID,
    label: "Landing proposals",
    revision: 1,
    status: "editing",
    panes: {
      left: {
        id: "left",
        label: "Proposal A",
        frameUrl: "/double-artifact/cap/left/index.html",
        components: [
          { id: "hero", label: "Hero", keeper: false, deleted: false, deletionActionId: null },
          { id: "nav", label: "Navigation", keeper: false, deleted: false, deletionActionId: null },
        ],
      },
      right: {
        id: "right",
        label: "Proposal B",
        frameUrl: "/double-artifact/cap/right/index.html",
        components: [{ id: "hero", label: "Hero", keeper: false, deleted: false, deletionActionId: null }],
      },
    },
    history: [],
    delivery: { batchId: null, acknowledged: false },
  };
}

/** A small archive stand-in that applies requests the way the contract says. */
function fakeArchive(view = baseView()) {
  let current = structuredClone(view);
  const prior = new Map();
  const results = new Map();
  const find = (pane, id) => current.panes[pane].components.find((c) => c.id === id);
  function act(req) {
    if (results.has(req.actionId)) return { view: structuredClone(current), result: results.get(req.actionId) };
    if (req.expectedRevision !== current.revision) {
      const error = new Error("The comparison changed.");
      Object.assign(error, { code: "STALE_REVISION", view: structuredClone(current) });
      throw error;
    }
    if (req.kind === "keeper") find(req.pane, req.componentId).keeper = req.selected;
    if (req.kind === "delete" || req.kind === "feedback-delete") {
      const c = find(req.pane, req.componentId);
      prior.set(req.actionId, c.keeper);
      Object.assign(c, { keeper: false, deleted: true, deletionActionId: req.actionId });
      const row = { id: req.actionId, kind: req.kind, pane: req.pane, componentId: c.id, label: c.label, undone: false };
      if (req.kind === "feedback-delete") row.feedback = req.feedback;
      current.history.push(row);
    }
    if (req.kind === "undo") {
      const row = current.history.find((r) => r.id === req.deletionActionId);
      row.undone = true;
      Object.assign(find(row.pane, row.componentId), { deleted: false, deletionActionId: null, keeper: prior.get(row.id) });
    }
    if (req.kind === undefined) {
      current.status = "sent";
      current.delivery.batchId = `batch-${req.actionId}`;
    }
    current.revision += 1;
    // The complete receipt that DoubleStore returns.
    const result = { actionId: req.actionId, kind: req.kind ?? "send", revision: current.revision };
    if (req.kind === undefined) result.batchId = current.delivery.batchId;
    results.set(req.actionId, result);
    return { view: structuredClone(current), result };
  }
  return { act, get view() { return structuredClone(current); } };
}

/** Transport whose calls stay pending until the test settles them. */
function manualTransport(archive) {
  const calls = [];
  const call = (op) => (request) => new Promise((resolve, reject) => {
    calls.push({
      op,
      request,
      ok: () => resolve(op === "load" ? { view: archive.view } : archive.act(request)),
      fail: (error) => reject(error),
    });
  });
  return { calls, load: call("load"), act: call("act"), send: call("send") };
}

/** Transport that answers immediately from the archive. */
function autoTransport(archive, { failNext = [] } = {}) {
  const calls = [];
  const take = (op, request) => {
    calls.push({ op, request });
    const failure = failNext.shift();
    if (failure) return Promise.reject(failure);
    return Promise.resolve(op === "load" ? { view: archive.view } : archive.act(request));
  };
  return { calls, load: () => take("load"), act: (r) => take("act", r), send: (r) => take("send", r) };
}

function ids() {
  let n = 0;
  return () => `action-${++n}`;
}

async function mount({ transport, archive = fakeArchive(), load = true, comparisonId: ID = ID_DEFAULT } = {}) {
  const dom = new JSDOM(HTML, { url: "https://review.test/double/cap/" });
  const win = dom.window;
  const t = transport || autoTransport(archive);
  const controller = createDoubleController({ comparisonId: ID, transport: t, newId: ids() });
  const shell = mountDoubleShell({ window: win, controller, comparisonId: ID });
  const posts = { left: [], right: [] };
  if (load) {
    const loading = controller.load();
    if (t.calls && t.calls.at(-1)?.op === "load" && t.calls.at(-1).ok) t.calls.at(-1).ok();
    await loading;
  }
  // jsdom swaps the frame window when src changes, so capture after load.
  for (const pane of ["left", "right"]) {
    const frame = win.document.getElementById(`frame-${pane}`);
    frame.contentWindow.postMessage = (message, targetOrigin) => posts[pane].push({ message: structuredClone(message), targetOrigin });
  }
  const doc = win.document;
  const frameWindow = (pane) => doc.getElementById(`frame-${pane}`).contentWindow;
  const instances = { left: "a1a1a1a1a1a1", right: "b2b2b2b2b2b2" };
  const fromFrame = (pane, data, { source = frameWindow(pane), origin = "null" } = {}) =>
    win.dispatchEvent(new win.MessageEvent("message", { data, origin, source }));
  const msg = (pane, extra) => ({ channel: CHANNEL, comparisonId: ID, pane, instance: instances[pane], ...extra });
  const ready = (pane, instance = instances[pane]) => {
    instances[pane] = instance;
    fromFrame(pane, msg(pane, { type: "ready" }));
  };
  const intent = (pane, intentName, componentId) => fromFrame(pane, msg(pane, { type: "intent", intent: intentName, componentId }));
  const lastState = (pane) => posts[pane].at(-1)?.message;
  const component = (pane, id) => lastState(pane).components.find((c) => c.id === id);
  const $ = (id) => doc.getElementById(id);
  return { dom, win, doc, $, controller, shell, transport: t, archive, posts, fromFrame, msg, ready, intent, lastState, component, comparisonId: ID };
}

// ------------------------------------------------------------ structure

test("shell markup keeps the theme choices, opaque frames, and persistent pane labels", () => {
  const dom = new JSDOM(HTML);
  const doc = dom.window.document;
  const picker = doc.querySelector("[data-theme-picker]");
  assert.ok(picker.closest("label"));
  assert.deepEqual([...picker.options].map((o) => ({ value: o.value, label: o.textContent })), THEMES);
  assert.ok(doc.querySelector('link[href="/theme.css"]'));
  assert.ok(doc.querySelector('link[href="/double.css"]'));
  assert.ok(doc.querySelector('script[type="module"][src="/double.js"]'));
  assert.equal(doc.body.dataset.comparison, "__DOUBLE_COMPARISON_ID__");
  assert.equal(doc.body.dataset.token, "__TOKEN__");
  const panes = [...doc.querySelectorAll(".pane")];
  assert.deepEqual(panes.map((p) => p.dataset.pane), ["left", "right"], "Left comes before Right in DOM order");
  assert.deepEqual(panes.map((p) => p.querySelector(".pane-side").textContent), ["Left", "Right"]);
  for (const pane of panes) {
    assert.equal(doc.getElementById(pane.getAttribute("aria-labelledby")).closest(".pane"), pane);
    const frame = pane.querySelector("iframe");
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "no allow-same-origin");
    assert.ok(frame.title);
  }
  assert.equal(doc.getElementById("status").getAttribute("role"), "status");
  assert.equal(doc.getElementById("alert").getAttribute("role"), "alert");
  assert.doesNotMatch(HTML, /<script(?![^>]*src=)/, "no inline scripts");
});

test("stylesheet lays panes side by side on desktop and stacks Left above Right when narrow", () => {
  assert.match(CSS, /\.double-panes \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  const narrow = CSS.slice(CSS.indexOf("@media (max-width: 720px)"));
  assert.match(narrow, /\.double-panes \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(CSS, /\.pane-label \{[^}]*position: sticky;/);
  assert.match(CSS, /min-height: 32px/);
  // Only shared theme tokens supply colors, so all five themes apply.
  for (const theme of ["plum", "night", "day"]) assert.match(CSS, new RegExp(`data-theme="${theme}"`));
  assert.doesNotMatch(CSS, /@import|url\(/);
});

test("safe frame addresses are same-origin paths only", () => {
  assert.equal(safeFrameUrl("/double-artifact/x/left/index.html"), "/double-artifact/x/left/index.html");
  for (const bad of ["//evil.test/x", "javascript:alert(1)", "https://evil.test/", "/\\evil", "/a b", null, 5]) assert.equal(safeFrameUrl(bad), null);
});

// ------------------------------------------------------------ load and frames

test("loading renders saved labels and frame addresses; state waits for frame readiness", async () => {
  const s = await mount();
  assert.equal(s.$("title").textContent, "Landing proposals");
  assert.equal(s.$("pane-name-left").textContent, "Proposal A");
  assert.equal(s.$("pane-name-right").textContent, "Proposal B");
  assert.equal(s.$("frame-left").getAttribute("src"), "/double-artifact/cap/left/index.html");
  assert.equal(s.$("frame-left").title, "Left pane: Proposal A");
  assert.equal(s.$("statusText").textContent, "Saved");
  assert.equal(s.posts.left.length, 0, "no state before ready");
  s.ready("left");
  assert.equal(s.posts.left.length, 1);
  assert.equal(s.posts.left[0].targetOrigin, "*");
  assert.deepEqual(s.lastState("left"), {
    channel: CHANNEL, type: "state", comparisonId: ID, pane: "left",
    components: [{ id: "hero", label: "Hero", keeper: false, deleted: false }, { id: "nav", label: "Navigation", keeper: false, deleted: false }],
    busy: false, readOnly: false,
  });
  assert.equal(s.posts.right.length, 0);
  assert.doesNotMatch(JSON.stringify(s.posts), /token/i);
});

test("duplicate ready is ignored; a reload during a pending save gets the saved state and busy flag", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  s.ready("left");
  assert.equal(s.posts.left.length, 1, "duplicate ready does not repost");
  s.intent("left", "keeper", "hero");
  assert.equal(transport.calls.at(-1).op, "act");
  assert.equal(s.lastState("left").busy, true);
  const before = s.posts.left.length;
  s.ready("left", "c3c3c3c3c3c3"); // the iframe reloaded
  assert.equal(s.posts.left.length, before + 1);
  assert.equal(s.lastState("left").busy, true);
  assert.equal(s.component("left", "hero").keeper, false, "unsaved keeper is not shown");
  transport.calls.at(-1).ok();
  await flush();
  assert.equal(s.lastState("left").busy, false);
  assert.equal(s.component("left", "hero").keeper, true);
});

test("forged, malformed, wrong-pane, and unknown-component messages are ignored", async () => {
  const s = await mount();
  s.ready("left");
  s.ready("right");
  const start = s.transport.calls.length;
  const good = s.msg("left", { type: "intent", intent: "keeper", componentId: "hero" });
  const other = new JSDOM("").window;
  s.fromFrame("left", good, { origin: "https://evil.test" });
  s.fromFrame("left", good, { source: s.win });
  s.fromFrame("left", good, { source: other });
  s.fromFrame("left", good, { source: s.$("frame-right").contentWindow }); // right frame claiming left
  s.fromFrame("left", { ...good, comparisonId: "trial-2" });
  s.fromFrame("left", { ...good, channel: "human-review" });
  s.fromFrame("left", { ...good, componentId: "ghost" });
  s.fromFrame("left", { ...good, componentId: "bad id" });
  s.fromFrame("left", { ...good, intent: "feedback-delete", feedback: "x" });
  s.fromFrame("left", { ...good, intent: "send" });
  s.fromFrame("left", { ...good, selected: true });
  s.fromFrame("left", { ...good, instance: "dddddddddddd" }); // not the ready instance
  s.fromFrame("left", { ...good, instance: "<x>" });
  s.fromFrame("left", "keeper hero");
  s.fromFrame("left", null);
  s.fromFrame("right", s.msg("right", { type: "intent", intent: "keeper", componentId: "nav" })); // nav exists only on the left
  assert.equal(s.transport.calls.length, start);
  assert.equal(s.shell.popup, null);
  s.fromFrame("left", good);
  await flush();
  assert.equal(s.transport.calls.length, start + 1);
});

test("intents before ready are ignored", async () => {
  const s = await mount();
  s.intent("left", "keeper", "hero");
  s.intent("left", "delete", "hero");
  assert.equal(s.transport.calls.length, 1, "only the load call");
  assert.equal(s.shell.popup, null);
});

// ------------------------------------------------------------ keeper

test("keeper toggles select then clear, only after each save, and pause both panes", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  s.ready("right");
  s.intent("left", "keeper", "hero");
  const first = transport.calls.at(-1);
  assert.deepEqual(first.request, { actionId: "action-1", expectedRevision: 1, kind: "keeper", pane: "left", componentId: "hero", selected: true });
  assert.ok(Object.isFrozen(first.request));
  // Saving: both panes paused, nothing committed, viewing intact.
  assert.equal(s.$("statusText").textContent, "Saving…");
  assert.equal(s.lastState("left").busy, true);
  assert.equal(s.lastState("right").busy, true);
  assert.equal(s.component("left", "hero").keeper, false);
  assert.equal(s.$("send").disabled, true);
  assert.equal(s.doc.body.getAttribute("aria-busy"), "true");
  s.intent("right", "keeper", "hero");
  s.intent("left", "delete", "nav");
  assert.equal(transport.calls.length, 2, "no second mutation while saving");
  assert.equal(s.shell.popup, null);
  first.ok();
  await flush();
  assert.equal(s.component("left", "hero").keeper, true);
  assert.equal(s.component("right", "hero").keeper, false, "opposite pane same ID untouched");
  assert.equal(s.component("left", "nav").keeper, false);
  assert.equal(s.lastState("right").busy, false);
  s.intent("left", "keeper", "hero");
  const second = transport.calls.at(-1);
  assert.equal(second.request.selected, false);
  assert.equal(second.request.expectedRevision, 2);
  second.ok();
  await flush();
  assert.equal(s.component("left", "hero").keeper, false);
});

test("opposite-pane duplicate IDs keep separate requests and drafts", async () => {
  const s = await mount();
  s.ready("left");
  s.ready("right");
  s.intent("right", "keeper", "hero");
  await flush();
  assert.equal(s.transport.calls.at(-1).request.pane, "right");
  assert.equal(s.component("right", "hero").keeper, true);
  assert.equal(s.component("left", "hero").keeper, false);
  s.intent("left", "delete", "hero");
  s.shell.popup.textarea.value = "Left draft";
  s.shell.popup.textarea.dispatchEvent(new s.win.Event("input"));
  s.shell.popup.cancel.click();
  s.intent("right", "delete", "hero");
  assert.equal(s.shell.popup.pane, "right");
  assert.equal(s.shell.popup.textarea.value, "");
  assert.ok(s.$("stage-right").contains(s.shell.popup.node));
  s.shell.popup.cancel.click();
  s.intent("left", "delete", "hero");
  assert.equal(s.shell.popup.textarea.value, "Left draft");
});

// ------------------------------------------------------------ popup

test("delete popup: second X first, feedback below, Cancel and Escape change nothing, drafts survive", async () => {
  const s = await mount();
  s.ready("left");
  const calls = s.transport.calls.length;
  s.intent("left", "delete", "hero");
  const popup = s.shell.popup;
  assert.ok(popup);
  assert.equal(popup.node.getAttribute("role"), "dialog");
  assert.equal(s.doc.getElementById(popup.node.getAttribute("aria-labelledby")).textContent, "Delete from LeftHero");
  const nodes = [...popup.node.children];
  assert.ok(nodes.indexOf(popup.plain) < nodes.indexOf(popup.textarea), "second X precedes the textbox");
  assert.ok(nodes.indexOf(popup.textarea) < nodes.indexOf(popup.withFeedback), "feedback action is below the textbox");
  assert.equal(popup.plain.getAttribute("aria-label"), "Delete Hero without feedback");
  assert.equal(s.doc.querySelector(`label[for="${popup.textarea.id}"]`).textContent, "Or delete with feedback");
  assert.equal(s.doc.activeElement, popup.plain);
  // Blank and whitespace feedback cannot confirm.
  assert.equal(popup.withFeedback.disabled, true);
  popup.textarea.value = "   \n\t";
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  assert.equal(popup.withFeedback.disabled, true);
  popup.withFeedback.disabled = false;
  popup.withFeedback.click();
  assert.equal(s.transport.calls.length, calls, "controller also refuses blank feedback");
  popup.textarea.value = "Too tall.";
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  assert.equal(popup.withFeedback.disabled, false);
  // Escape closes without a change.
  popup.node.dispatchEvent(new s.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(s.shell.popup, null);
  assert.equal(s.transport.calls.length, calls);
  s.intent("left", "delete", "hero");
  assert.equal(s.shell.popup.textarea.value, "Too tall.");
  assert.equal(s.doc.activeElement, s.shell.popup.textarea);
  // Cancel closes without a change, too; a document-level Escape as well.
  s.shell.popup.cancel.click();
  assert.equal(s.shell.popup, null);
  s.intent("left", "delete", "hero");
  s.doc.dispatchEvent(new s.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(s.shell.popup, null);
  assert.equal(s.transport.calls.length, calls);
  assert.equal(s.component("left", "hero").deleted, false);
});

test("plain delete clears a keeper; Undo restores the exact prior keeper from the returned view", async () => {
  const s = await mount();
  s.ready("left");
  s.intent("left", "keeper", "hero");
  await flush();
  s.intent("left", "delete", "hero");
  s.shell.popup.plain.click();
  await flush();
  const del = s.transport.calls.at(-1).request;
  assert.deepEqual(del, { actionId: "action-2", expectedRevision: 2, kind: "delete", pane: "left", componentId: "hero" });
  assert.equal(s.shell.popup, null);
  assert.deepEqual(s.component("left", "hero"), { id: "hero", label: "Hero", keeper: false, deleted: true });
  const rows = s.doc.querySelectorAll(".history-row");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector(".history-kind").textContent, "Plain delete");
  assert.equal(rows[0].querySelector(".history-feedback"), null);
  const undo = rows[0].querySelector(".row-undo");
  assert.equal(undo.getAttribute("aria-label"), "Undo deletion of Hero in Left pane");
  undo.click();
  await flush();
  assert.deepEqual(s.transport.calls.at(-1).request, { actionId: "action-3", expectedRevision: 3, kind: "undo", deletionActionId: "action-2" });
  assert.deepEqual(s.component("left", "hero"), { id: "hero", label: "Hero", keeper: true, deleted: false });
  const after = s.doc.querySelectorAll(".history-row");
  assert.equal(after.length, 1, "Undo keeps the history row");
  assert.ok(after[0].classList.contains("undone"));
  assert.equal(after[0].querySelector(".badge").textContent, "Undone");
  assert.equal(after[0].querySelector(".row-undo"), null);
});

test("feedback delete failure keeps state and draft; Retry reuses the exact request", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  s.intent("left", "delete", "hero");
  const popup = s.shell.popup;
  popup.textarea.value = "Too tall.";
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  popup.withFeedback.click();
  const first = transport.calls.at(-1);
  assert.deepEqual(first.request, { actionId: "action-1", expectedRevision: 1, kind: "feedback-delete", pane: "left", componentId: "hero", feedback: "Too tall." });
  assert.equal(popup.status.textContent, "Saving…");
  assert.equal(popup.plain.disabled, true);
  assert.equal(popup.withFeedback.disabled, true);
  assert.equal(s.component("left", "hero").deleted, false, "not removed before success");
  first.fail(Object.assign(new Error("Disk full."), { code: "WRITE_FAILED" }));
  await flush();
  assert.equal(s.shell.popup, popup, "popup stays open after failure");
  assert.equal(popup.textarea.value, "Too tall.");
  assert.equal(popup.plain.disabled, false, "editing controls restored");
  assert.equal(popup.retry.hidden, false);
  assert.match(popup.status.textContent, /Save failed: Disk full\. The saved state is unchanged\. Retry sends the same request\. Your feedback text is kept\./);
  assert.equal(s.component("left", "hero").deleted, false);
  assert.equal(s.$("alert").hidden, false);
  assert.match(s.$("alertText").textContent, /Disk full/);
  assert.equal(s.$("statusText").textContent, "Save failed");
  // Close and reopen: the draft survives the failed save.
  popup.cancel.click();
  s.intent("left", "delete", "hero");
  assert.equal(s.shell.popup.textarea.value, "Too tall.");
  s.$("alertRetry").click();
  const second = transport.calls.at(-1);
  assert.notEqual(second, first);
  assert.equal(second.request, first.request, "the identical frozen request object");
  second.ok();
  await flush();
  assert.equal(s.shell.popup, null);
  assert.equal(s.component("left", "hero").deleted, true);
  assert.equal(s.$("alert").hidden, true);
  const row = s.doc.querySelector(".history-row");
  assert.equal(row.querySelector(".history-kind").textContent, "Feedback delete");
  assert.equal(row.querySelector(".history-feedback").textContent, "Too tall.");
  // Undo, then reopen: a successful save cleared the draft.
  row.querySelector(".row-undo").click();
  transport.calls.at(-1).ok();
  await flush();
  s.intent("left", "delete", "hero");
  assert.equal(s.shell.popup.textarea.value, "");
});

test("an uncertain failure says it may be saved, and a lost response retried returns one result", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  s.intent("left", "keeper", "hero");
  const first = transport.calls.at(-1);
  archive.act(first.request); // the server committed, but the answer was lost
  first.fail(Object.assign(new Error("The server did not answer."), { code: "NETWORK", uncertain: true }));
  await flush();
  assert.match(s.$("alertText").textContent, /It may already be saved\. Retry sends the same request/);
  assert.equal(s.component("left", "hero").keeper, false, "the uncertain result is not claimed");
  s.$("alertRetry").click();
  transport.calls.at(-1).ok();
  await flush();
  assert.equal(transport.calls.at(-1).request.actionId, "action-1");
  assert.equal(s.component("left", "hero").keeper, true);
  assert.equal(archive.view.revision, 2, "only one saved action");
});

test("a stale error refreshes from its view, keeps the draft, and blocks no viewing", async () => {
  const archive = fakeArchive();
  const s = await mount({ archive });
  s.ready("left");
  // Another tab saved a keeper meanwhile.
  archive.act({ actionId: "other-tab", expectedRevision: 1, kind: "keeper", pane: "left", componentId: "nav", selected: true });
  s.intent("left", "delete", "hero");
  s.shell.popup.textarea.value = "Wrong color.";
  s.shell.popup.textarea.dispatchEvent(new s.win.Event("input"));
  s.shell.popup.withFeedback.click();
  await flush();
  assert.equal(s.controller.getState().failure.code, "STALE_REVISION");
  assert.equal(s.component("left", "nav").keeper, true, "the error view refreshed saved state");
  assert.equal(s.component("left", "hero").deleted, false);
  assert.equal(s.shell.popup.textarea.value, "Wrong color.");
  assert.match(s.$("alertText").textContent, /The comparison changed\. The latest saved state is now shown\. Check it, then try again\. Your feedback text is kept\./);
  // A fresh attempt uses the refreshed revision and saves.
  s.shell.popup.withFeedback.click();
  await flush();
  assert.equal(s.transport.calls.at(-1).request.expectedRevision, 2);
  assert.equal(s.component("left", "hero").deleted, true);
  assert.equal(archive.view.history.length, 1);
});

test("a malformed server view is never shown as saved", async () => {
  const archive = fakeArchive();
  const transport = autoTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  transport.act = (request) => {
    transport.calls.push({ op: "act", request });
    return Promise.resolve({ view: { comparisonId: "other" }, result: {} });
  };
  s.intent("left", "keeper", "hero");
  await flush();
  assert.equal(s.component("left", "hero").keeper, false);
  assert.equal(s.controller.getState().failure.code, "BAD_VIEW");
  assert.equal(s.controller.getState().failure.uncertain, true);
});

// ------------------------------------------------------------ send

test("an empty result can Send; Sending pauses everything; success is read-only, also after reload", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  s.ready("right");
  assert.match(s.$("summary").textContent, /Sending an empty result is allowed/);
  assert.equal(s.$("send").disabled, false);
  s.$("send").click();
  const send = transport.calls.at(-1);
  assert.equal(send.op, "send");
  assert.deepEqual(send.request, { actionId: "action-1", expectedRevision: 1 });
  assert.equal(s.$("statusText").textContent, "Sending…");
  assert.equal(s.$("send").textContent, "Sending…");
  assert.equal(s.lastState("left").busy, true);
  assert.equal(s.lastState("right").busy, true);
  s.intent("left", "keeper", "hero");
  assert.equal(transport.calls.length, 2, "no mutation while sending");
  send.ok();
  await flush();
  assert.equal(s.$("statusText").textContent, "Sent · read-only");
  assert.equal(s.$("send").disabled, true);
  assert.equal(s.$("send").textContent, "Sent");
  assert.equal(s.$("sentNote").hidden, false);
  assert.equal(s.lastState("left").readOnly, true);
  assert.equal(s.lastState("right").readOnly, true);
  s.intent("left", "keeper", "hero");
  s.intent("left", "delete", "hero");
  assert.equal(transport.calls.length, 2);
  assert.equal(s.shell.popup, null);

  // Reload: a fresh shell over the sent archive stays read-only.
  const again = await mount({ archive });
  again.ready("left");
  assert.equal(again.lastState("left").readOnly, true);
  assert.equal(again.$("send").disabled, true);
  assert.equal(again.$("send").textContent, "Sent");
  assert.equal((await again.controller.send()).refused, "read-only");
  assert.equal((await again.controller.toggleKeeper("left", "hero")).refused, "read-only");
});

test("sent views hide Undo and keep history readable", async () => {
  const archive = fakeArchive();
  const s = await mount({ archive });
  s.ready("left");
  s.intent("left", "delete", "hero");
  s.shell.popup.plain.click();
  await flush();
  assert.ok(s.doc.querySelector(".row-undo"));
  s.$("send").click();
  await flush();
  assert.equal(s.doc.querySelectorAll(".history-row").length, 1);
  assert.equal(s.doc.querySelector(".row-undo"), null);
  assert.match(s.$("summary").textContent, /1 deletion/);
});

test("a failed Send keeps the comparison editable and Retry reuses its request", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  s.$("send").click();
  const first = transport.calls.at(-1);
  first.fail(Object.assign(new Error("Archive unavailable."), { code: "ARCHIVE_UNREADABLE" }));
  await flush();
  assert.equal(s.$("statusText").textContent, "Send failed");
  assert.match(s.$("alertText").textContent, /^Send failed: Archive unavailable\./);
  assert.equal(s.lastState("left").readOnly, false);
  assert.equal(s.lastState("left").busy, false);
  assert.equal(s.$("send").disabled, false);
  s.$("alertRetry").click();
  assert.equal(transport.calls.at(-1).request, first.request);
  transport.calls.at(-1).ok();
  await flush();
  assert.equal(s.lastState("left").readOnly, true);
});

// ------------------------------------------------------------ load errors and escaping

test("a load failure shows a recovery error and never an empty comparison", async () => {
  const archive = fakeArchive();
  const failure = Object.assign(new Error("The archive is corrupt."), { code: "ARCHIVE_INVALID" });
  const transport = autoTransport(archive, { failNext: [failure] });
  const s = await mount({ transport, archive });
  assert.equal(s.controller.getState().status, "load-failed");
  assert.equal(s.$("alert").hidden, false);
  assert.match(s.$("alertText").textContent, /could not be loaded: The archive is corrupt\. Nothing is shown as saved\./);
  assert.equal(s.$("alertRetry").hidden, true);
  assert.equal(s.$("send").disabled, true);
  assert.equal(s.$("frame-left").getAttribute("src"), null);
  assert.equal(s.$("statusText").textContent, "Not loaded");
  s.$("alertReload").click();
  await flush();
  assert.equal(s.controller.getState().status, "ready");
  assert.equal(s.$("alert").hidden, true);
  assert.equal(s.$("pane-name-left").textContent, "Proposal A");
});

test("labels and feedback render as text, never markup", async () => {
  const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>`;
  const view = baseView();
  view.label = evil;
  view.panes.left.label = evil;
  view.panes.left.components[0].label = evil;
  const archive = fakeArchive(view);
  const s = await mount({ archive });
  s.ready("left");
  s.intent("left", "delete", "hero");
  assert.equal(s.shell.popup.node.querySelector(".popup-name").textContent, evil);
  s.shell.popup.textarea.value = evil;
  s.shell.popup.textarea.dispatchEvent(new s.win.Event("input"));
  s.shell.popup.withFeedback.click();
  await flush();
  assert.equal(s.$("title").textContent, evil);
  assert.equal(s.$("pane-name-left").textContent, evil);
  assert.equal(s.doc.querySelector(".history-label").textContent, evil);
  assert.equal(s.doc.querySelector(".history-feedback").textContent, evil);
  assert.equal(s.doc.querySelectorAll("img").length, 0);
  assert.equal(s.doc.querySelectorAll("script:not([src])").length, 0);
  assert.equal(s.win.pwned, undefined);
  assert.equal(s.component("left", "hero").label, evil);
});

// ------------------------------------------------------------ transport and boot

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError("no json");
        return next.body;
      },
    };
  };
  return { fn, calls };
}

test("fetch transport uses the seam endpoints and keeps the token in a header", async () => {
  const view = baseView();
  const f = fakeFetch([
    { status: 200, body: { view } },
    { status: 200, body: { view, result: { ok: 1 } } },
    { status: 200, body: { view, result: { batchId: "b" } } },
  ]);
  const t = createFetchTransport({ comparisonId: "trial/1?x#y", token: "secret-token", fetch: f.fn });
  await t.load();
  await t.act({ actionId: "a", expectedRevision: 1, kind: "keeper", pane: "left", componentId: "hero", selected: true });
  await t.send({ actionId: "b", expectedRevision: 2 });
  assert.deepEqual(f.calls.map((c) => [c.init.method, c.url]), [
    ["GET", "/api/double/~trial%2F1%3Fx%23y"],
    ["POST", "/api/double/~trial%2F1%3Fx%23y/actions"],
    ["POST", "/api/double/~trial%2F1%3Fx%23y/send"],
  ]);
  for (const call of f.calls) {
    assert.equal(call.init.headers["x-human-review-token"], "secret-token");
    assert.doesNotMatch(call.url, /secret/);
  }
  assert.equal(f.calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(f.calls[2].init.body), { actionId: "b", expectedRevision: 2 });
});

test("fetch transport refuses an invalid comparison ID before any request", () => {
  for (const comparisonId of ["", "trial 1", "a\u0007b", undefined]) {
    assert.throws(
      () => createFetchTransport({ comparisonId, token: "t", fetch: () => assert.fail("no request") }),
      (e) => e.name === "DoubleRouteError" && e.code === "INVALID_ID",
      JSON.stringify(comparisonId),
    );
  }
});

// Accepted identities that URL parsing, escapes, or route words could confuse.
const ROUTE_IDS = [
  ".", "..", "...", "%2e", "%2E%2E", "%2F", ".%2e", "%",
  "~", "~~", "~trial", "a/b", "../x", "a\\b", "a?b=1", "a#b",
  "capabilities", "actions", "send", "é", "日本語", "😀", `c${"x".repeat(3000)}`,
];

/** Loopback archive server on port 0. It routes on the raw path segment, as the server contract says. */
async function loopbackArchive(t) {
  const archives = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, token: req.headers["x-human-review-token"], body });
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const match = /^\/api\/double\/(~[^/?#]*)(\/actions|\/send)?$/.exec(req.url);
      if (!match) return reply(404, { error: { code: "NOT_FOUND", message: req.url } });
      let comparisonId;
      try {
        comparisonId = decodeDoubleComparisonId(match[1]);
      } catch {
        return reply(404, { error: { code: "NOT_FOUND", message: req.url } });
      }
      const archive = archives.get(comparisonId);
      if (!archive || req.headers["x-human-review-token"] !== "tok") return reply(404, { error: { code: "NOT_FOUND", message: req.url } });
      if (!match[2]) return reply(200, { view: archive.view });
      try {
        return reply(200, archive.act(JSON.parse(body)));
      } catch (error) {
        return reply(409, { error: { code: error.code, message: error.message }, view: error.view });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const add = (comparisonId) => archives.set(comparisonId, fakeArchive({ ...baseView(), comparisonId }));
  return { base, add, requests };
}

test("real fetch keeps every comparison segment exact for load, actions, and Send", async (t) => {
  const server = await loopbackArchive(t);
  for (const comparisonId of ROUTE_IDS) server.add(comparisonId);
  for (const comparisonId of ROUTE_IDS) {
    const label = JSON.stringify(comparisonId.slice(0, 20));
    const segment = `~${encodeURIComponent(comparisonId)}`;
    const transport = createFetchTransport({ comparisonId, token: "tok", fetch: globalThis.fetch, base: server.base });
    const from = server.requests.length;
    const s = await mount({ transport, comparisonId });
    assert.equal(s.controller.getState().status, "ready", `${label} loads`);
    assert.equal(s.controller.getState().view.comparisonId, comparisonId);
    s.ready("left");
    assert.equal(s.lastState("left").comparisonId, comparisonId, `${label} frame state keeps the raw ID`);
    await s.controller.toggleKeeper("left", "hero");
    await s.controller.send();
    assert.equal(s.controller.getState().status, "ready", `${label} saves`);
    assert.equal(s.controller.getState().view.status, "sent", `${label} sends`);
    const mine = server.requests.slice(from);
    assert.deepEqual(mine.map((r) => [r.method, r.url]), [
      ["GET", `/api/double/${segment}`],
      ["POST", `/api/double/${segment}/actions`],
      ["POST", `/api/double/${segment}/send`],
    ], label);
    for (const r of mine) {
      assert.equal(r.token, "tok");
      assert.equal(decodeDoubleComparisonId(r.url.split("/")[3]), comparisonId);
    }
    assert.equal(mine[0].body, "");
    assert.deepEqual(JSON.parse(mine[1].body), { actionId: "action-1", expectedRevision: 1, kind: "keeper", pane: "left", componentId: "hero", selected: true });
    assert.deepEqual(JSON.parse(mine[2].body), { actionId: "action-2", expectedRevision: 2 });
    s.shell.close();
  }
});

test("real fetch errors keep their code, view, and certainty through the prefixed route", async (t) => {
  const server = await loopbackArchive(t);
  server.add("..");
  const transport = createFetchTransport({ comparisonId: "..", token: "tok", fetch: globalThis.fetch, base: server.base });
  const stale = { actionId: "a", expectedRevision: 9, kind: "keeper", pane: "left", componentId: "hero", selected: true };
  await assert.rejects(transport.act(stale), (e) => e.code === "STALE_REVISION" && e.status === 409 && e.view.comparisonId === ".." && e.uncertain === false);
  const wrongToken = createFetchTransport({ comparisonId: "..", token: "other", fetch: globalThis.fetch, base: server.base });
  await assert.rejects(wrongToken.load(), (e) => e.code === "NOT_FOUND" && e.status === 404 && e.uncertain === false);
  assert.deepEqual(server.requests.map((r) => r.url), ["/api/double/~../actions", "/api/double/~.."]);
});

test("fetch transport errors keep code, message, optional view, and certainty", async () => {
  const view = baseView();
  const f = fakeFetch([
    { status: 409, body: { error: { code: "STALE_REVISION", message: "Changed." }, view } },
    { status: 500, body: { error: { code: "WRITE_FAILED", message: "Disk." } } },
    new TypeError("offline"),
    { status: 200 },
    { status: 404 },
    new TypeError("offline"),
  ]);
  const t = createFetchTransport({ comparisonId: ID, token: "t", fetch: f.fn });
  const req = { actionId: "a", expectedRevision: 1 };
  await assert.rejects(t.act(req), (e) => e.code === "STALE_REVISION" && e.message === "Changed." && e.status === 409 && e.view.comparisonId === ID && e.uncertain === false);
  await assert.rejects(t.send(req), (e) => e.code === "WRITE_FAILED" && e.uncertain === true);
  await assert.rejects(t.act(req), (e) => e.code === "NETWORK" && e.uncertain === true);
  await assert.rejects(t.act(req), (e) => e.code === "BAD_RESPONSE" && e.uncertain === true);
  await assert.rejects(t.load(), (e) => e.code === "HTTP_404" && e.uncertain === false);
  await assert.rejects(t.load(), (e) => e.code === "NETWORK" && e.uncertain === false);
});

test("boot refuses unfilled placeholders and otherwise loads through fetch", async () => {
  const unfilled = new JSDOM(HTML, { url: "https://review.test/" });
  bootDouble(unfilled.window, { fetch: () => assert.fail("no request without configuration") });
  await flush();
  assert.match(unfilled.window.document.getElementById("alertText").textContent, /no comparison or token/);

  const filled = new JSDOM(HTML.replace("__DOUBLE_COMPARISON_ID__", ID).replace("__TOKEN__", "tok"), { url: "https://review.test/" });
  const f = fakeFetch([{ status: 200, body: { view: baseView() } }]);
  const shell = bootDouble(filled.window, { fetch: f.fn });
  await flush();
  await flush();
  assert.equal(f.calls[0].url, `/api/double/~${ID}`);
  assert.equal(f.calls[0].init.headers["x-human-review-token"], "tok");
  assert.equal(filled.window.document.getElementById("pane-name-right").textContent, "Proposal B");
  shell.close();
});

// ------------------------------------------------------------ end to end with the real SDK

/**
 * Run the real SDK in one jsdom document per pane and bridge it to the shell.
 * `pages` maps a pane to its full review-copy HTML without the SDK script.
 * `reload(pane)` loads the same page again, as an iframe reload does.
 */
async function connectSdk(s, pages, { inHead = false } = {}) {
  const frames = {};
  const load = async (pane) => {
    const roots = [];
    const tag = `<script data-comparison-id="${s.comparisonId}" data-pane="${pane}">${SDK}</script>`;
    const html = inHead ? pages[pane].replace("</head>", `${tag}</head>`)
      : pages[pane].includes("</body>") ? pages[pane].replace("</body>", `${tag}</body>`) : pages[pane] + tag;
    const dom = new JSDOM(html, {
      url: `https://artifact.test/double-artifact/cap/${pane}/index.html`,
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: s.win, configurable: true });
        const attach = window.Element.prototype.attachShadow;
        window.Element.prototype.attachShadow = function (init) {
          const root = attach.call(this, init);
          roots.push(root);
          return root;
        };
      },
    });
    frames[pane].dom = dom;
    frames[pane].roots = roots;
    if (dom.window.document.readyState === "loading") await new Promise((r) => dom.window.document.addEventListener("DOMContentLoaded", r, { once: true }));
    await flush();
  };
  for (const pane of ["left", "right"]) {
    const iframeWindow = s.$(`frame-${pane}`).contentWindow;
    frames[pane] = { iframeWindow };
    // Route parent -> frame through the iframe window, frame -> parent with that iframe as source.
    iframeWindow.postMessage = (data) => {
      const w = frames[pane].dom.window;
      w.dispatchEvent(new w.MessageEvent("message", { data: structuredClone(data), source: s.win, origin: "https://review.test" }));
    };
  }
  s.win.postMessage = (data) => {
    const source = frames[data.pane].iframeWindow;
    s.win.dispatchEvent(new s.win.MessageEvent("message", { data: structuredClone(data), source, origin: "null" }));
  };
  for (const pane of ["left", "right"]) await load(pane);
  await flush();
  const shadow = (pane) => frames[pane].roots[0];
  const button = (pane, id, cls) => [...shadow(pane).querySelectorAll(".cluster")].find((c) => c.dataset.componentId === id)?.querySelector(`.${cls}`) ?? null;
  const element = (pane, id) => [...frames[pane].dom.window.document.querySelectorAll("[data-double-id]")].find((e) => e.getAttribute("data-double-id") === id);
  return { frames, shadow, button, element, reload: load };
}

const sdkPage = (body, htmlAttrs = "", bodyAttrs = "") => `<!doctype html><html${htmlAttrs}><head></head><body${bodyAttrs}>${body}</body></html>`;

/** True when the node or any flat-tree ancestor, across shadow roots, carries inert. */
function inertInFlatTree(node) {
  for (let n = node; n; n = n.parentNode || n.host) {
    if (n.nodeType === 1 && n.hasAttribute("inert")) return true;
  }
  return false;
}

test("the real SDK and the shell complete keeper and delete flows over the message bridge", async () => {
  const archive = fakeArchive();
  const s = await mount({ archive });
  const sdk = await connectSdk(s, {
    left: sdkPage('<section data-double-id="hero" data-container="Hero">A</section><nav data-double-id="nav" data-container="Navigation">N</nav>'),
    right: sdkPage('<section data-double-id="hero" data-container="Hero">B</section>'),
  });
  const { button } = sdk;
  assert.ok(button("left", "hero", "keep"), "left controls rendered from parent state");
  button("left", "hero", "keep").click();
  await flush();
  assert.equal(button("left", "hero", "keep").getAttribute("aria-pressed"), "true");
  assert.equal(button("right", "hero", "keep").getAttribute("aria-pressed"), "false");
  button("right", "hero", "delete").click();
  assert.equal(s.shell.popup.pane, "right");
  s.shell.popup.plain.click();
  await flush();
  const rightHero = sdk.element("right", "hero");
  assert.equal(rightHero.style.display, "none");
  assert.equal(sdk.element("left", "hero").style.display, "");
  s.doc.querySelector(".row-undo").click();
  await flush();
  assert.equal(rightHero.style.display, "");
});

// ------------------------------------------------------------ real archive

const sha = (value) => createHash("sha256").update(value).digest("hex");
const region = (id, label, text = label) => `<section data-double-id="${id}" data-container="${label}"><p>${text}</p></section>`;

/** A real DoubleStore over disposable original and copy folders. */
async function storeFixture(t, {
  comparisonId = ID,
  left = region("hero", "Hero", "A") + region("nav", "Navigation", "N"),
  right = region("hero", "Hero", "B"),
  htmlAttrs = "",
  headAttrs = "",
  head = "",
} = {}) {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "double-ui-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const input = { comparisonId, label: "Landing proposals", panes: {} };
  const pages = {};
  for (const [pane, body] of Object.entries({ left, right })) {
    const html = `<!doctype html><html${htmlAttrs}><head${pane === "left" ? headAttrs : ""}><title>${pane}</title>${head}</head><body>${body}</body></html>`;
    pages[pane] = html;
    const originalDir = path.join(root, `original-${pane}`);
    const copyDir = path.join(root, `copy-${pane}`);
    await fsp.mkdir(originalDir);
    await fsp.mkdir(copyDir);
    const entry = path.join(originalDir, "index.html");
    await fsp.writeFile(entry, html);
    await fsp.writeFile(path.join(copyDir, "index.html"), html);
    input.panes[pane] = {
      label: pane === "left" ? "Proposal A" : "Proposal B",
      original: { entry, files: [{ path: entry, sha256: sha(html) }] },
      copy: { root: copyDir, entry: "index.html", assets: [] },
    };
  }
  const store = new DoubleStore({ archiveDir: path.join(root, "archive") });
  await store.create(input);
  return { store, comparisonId, pages };
}

/**
 * Transport over a real DoubleStore. Each queued fault applies to one call:
 *   { before }        throw before the archive sees the request
 *   { after }         let the archive commit, then lose the answer
 *   { reply(p) }      let the archive commit, then answer with reply(p)
 * Archive errors pass through unchanged, as a wrapping adapter might.
 */
function storeTransport({ store, comparisonId }) {
  const calls = [];
  const faults = [];
  const decorate = (view) => {
    const copy = structuredClone(view);
    for (const pane of ["left", "right"]) copy.panes[pane].frameUrl = `/double-artifact/cap/${pane}/index.html`;
    return copy;
  };
  async function call(op, request) {
    calls.push({ op, request });
    const fault = faults.shift() || {};
    if (fault.before) throw fault.before;
    const payload = op === "load" ? { view: await store.read(comparisonId) } : await store[op](comparisonId, request);
    if (fault.after) throw fault.after;
    if (fault.reply) return fault.reply({ ...payload, view: decorate(payload.view) });
    return { ...payload, view: decorate(payload.view) };
  }
  return { calls, faults, load: () => call("load"), act: (r) => call("act", r), send: (r) => call("send", r) };
}

/** Wait until the controller has no request or load in flight; real archive I/O spans many ticks. */
async function settle(s) {
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const { status } = s.controller.getState();
    if (status !== "saving" && status !== "sending" && status !== "loading") return;
  }
  assert.fail("the controller did not settle");
}

const lost = () => Object.assign(new Error("The server did not answer."), { code: "NETWORK", uncertain: true });
const mutations = (transport) => transport.calls.filter((c) => c.op !== "load");

async function typeFeedback(s, pane, componentId, text) {
  s.intent(pane, "delete", componentId);
  const popup = s.shell.popup;
  popup.textarea.value = text;
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  return popup;
}

/** Try every fresh mutation path; none may reach the transport. */
async function tryFreshActions(s) {
  s.intent("right", "keeper", "hero");
  s.intent("left", "keeper", "nav");
  s.intent("right", "delete", "hero");
  s.$("send").disabled = false;
  s.$("send").click();
  assert.ok((await s.controller.toggleKeeper("right", "hero")).refused);
  assert.ok((await s.controller.plainDelete("left", "nav")).refused);
  assert.ok((await s.controller.send()).refused);
  for (const undo of s.doc.querySelectorAll(".row-undo")) {
    undo.disabled = false;
    undo.click();
  }
  await settle(s);
}

test("a committed feedback deletion whose answer is lost stays unresolved until Retry reconciles it", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  s.ready("right");
  const popup = await typeFeedback(s, "left", "hero", "Too tall.");
  transport.faults.push({ after: lost() });
  popup.withFeedback.click();
  await settle(s);
  const original = s.controller.getState().failure.request;
  assert.equal((await f.store.read(f.comparisonId)).revision, 1, "the archive committed");
  assert.equal(s.controller.getState().failure.uncertain, true);
  assert.equal(s.controller.getState().canMutate, false, "fresh actions wait for the outcome");
  assert.equal(s.lastState("left").busy, true);
  assert.equal(s.lastState("right").busy, true, "both panes pause");
  assert.equal(s.$("alertDismiss").hidden, true, "an unknown outcome cannot be dismissed");
  assert.equal(s.$("alertRetry").hidden, false);
  assert.equal(s.$("alertRetry").disabled, false);
  assert.equal(s.$("send").disabled, true);
  assert.equal(s.shell.popup, popup, "the popup and its draft stay");
  assert.equal(popup.textarea.value, "Too tall.");
  assert.equal(popup.textarea.disabled, false, "the draft stays editable");
  assert.equal(popup.plain.disabled, true);
  assert.equal(popup.withFeedback.disabled, true);
  assert.equal(popup.retry.hidden, false);
  const before = mutations(transport).length;
  // The original action again, another component, Send, Undo, Dismiss, and Reload.
  popup.withFeedback.disabled = false;
  popup.withFeedback.click();
  popup.plain.disabled = false;
  popup.plain.click();
  await tryFreshActions(s);
  s.$("alertDismiss").hidden = false;
  s.$("alertDismiss").click();
  s.controller.dismissFailure();
  assert.equal(mutations(transport).length, before, "no fresh mutation before resolution");
  assert.equal(s.controller.getState().failure.request, original, "the pending identity survives");
  s.$("alertReload").click();
  await settle(s);
  const reloaded = s.controller.getState();
  assert.equal(reloaded.view.panes.left.components[0].deleted, true, "the reloaded view shows the commit");
  assert.equal(reloaded.failure.request, original, "a view alone is not a receipt");
  assert.equal(reloaded.failure.uncertain, true);
  assert.equal(reloaded.canMutate, false);
  assert.equal(s.controller.getDraft("left", "hero"), "Too tall.", "the draft survives the closed popup");
  await tryFreshActions(s);
  assert.equal(mutations(transport).length, before);
  s.$("alertRetry").click();
  await settle(s);
  const retried = mutations(transport).at(-1);
  assert.equal(retried.request, original, "Retry sends the identical request");
  const after = s.controller.getState();
  assert.equal(after.failure, null);
  assert.equal(after.canMutate, true);
  assert.equal(s.$("alert").hidden, true);
  assert.equal(s.controller.getDraft("left", "hero"), "", "a confirmed save clears its draft");
  const snap = await f.store.snapshot(f.comparisonId);
  assert.equal(snap.feedback.length, 1);
  assert.equal(snap.receipts.length, 1, "one saved action");
  assert.equal(s.lastState("right").busy, false);
});

test("repeated failed recovery keeps the original request, its uncertainty, and the draft", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  const popup = await typeFeedback(s, "left", "hero", "Wrong color.");
  transport.faults.push({ after: lost() });
  popup.withFeedback.click();
  await settle(s);
  const original = s.controller.getState().failure.request;
  // Retry is lost again, then answered by an error that proves nothing.
  transport.faults.push({ before: lost() });
  s.$("alertRetry").click();
  await settle(s);
  transport.faults.push({ before: Object.assign(new Error("Session expired."), { code: "HTTP_401", status: 401, uncertain: false }) });
  s.$("alertRetry").click();
  await settle(s);
  transport.faults.push({ before: Object.assign(new Error("Bad gateway."), { code: "HTTP_502", status: 502, uncertain: true, view: (await f.store.read(f.comparisonId)) }) });
  s.$("alertRetry").click();
  await settle(s);
  // A failed refresh keeps the unresolved request on screen.
  transport.faults.push({ before: Object.assign(new Error("Archive offline."), { code: "NETWORK" }) });
  s.$("alertReload").click();
  await settle(s);
  const state = s.controller.getState();
  assert.equal(state.failure.request, original);
  assert.equal(state.failure.uncertain, true);
  assert.equal(state.canMutate, false);
  assert.ok(state.loadError);
  assert.match(s.$("alertText").textContent, /Refresh failed: Archive offline\./);
  assert.match(s.$("alertText").textContent, /It may already be saved/);
  assert.equal(s.$("alertRetry").hidden, false);
  assert.equal(s.$("alertDismiss").hidden, true);
  assert.equal(s.controller.getDraft("left", "hero"), "Wrong color.");
  assert.ok(mutations(transport).every((c) => c.request === original), "every attempt reuses the original request");
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(s.controller.getState().failure, null);
  assert.equal((await f.store.snapshot(f.comparisonId)).feedback.length, 1);
});

test("storage COMMIT_UNCERTAIN from the real archive blocks fresh actions without an uncertain flag", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  s.ready("right");
  const rename = fsp.rename.bind(fsp);
  const mock = t.mock.method(fsp, "rename", async (...args) => {
    await rename(...args);
    throw Object.assign(new Error("Injected storage failure"), { code: "EIO" });
  });
  s.intent("left", "keeper", "hero");
  await settle(s);
  mock.mock.restore();
  const state = s.controller.getState();
  assert.equal(state.failure.code, "COMMIT_UNCERTAIN");
  assert.equal(state.failure.uncertain, true);
  assert.equal(state.canMutate, false);
  const before = mutations(transport).length;
  await tryFreshActions(s);
  assert.equal(mutations(transport).length, before);
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(s.controller.getState().failure, null);
  assert.equal(s.component("left", "hero").keeper, true);
  assert.equal((await f.store.snapshot(f.comparisonId)).receipts.length, 1);
});

test("an HTTP COMMIT_UNCERTAIN answer below 500 is still treated as unresolved", async () => {
  const view = baseView();
  const responses = [
    { status: 200, body: { view } },
    { status: 409, body: { error: { code: "COMMIT_UNCERTAIN", message: "The replace may have committed." } } },
  ];
  const fetch = async () => {
    const next = responses.shift();
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  const transport = createFetchTransport({ comparisonId: ID, token: "t", fetch });
  const controller = createDoubleController({ comparisonId: ID, transport, newId: ids() });
  await controller.load();
  await controller.toggleKeeper("left", "hero");
  const state = controller.getState();
  assert.equal(state.failure.code, "COMMIT_UNCERTAIN");
  assert.equal(state.failure.uncertain, true);
  assert.equal(state.canMutate, false);
  controller.dismissFailure();
  assert.equal(controller.getState().failure.request.actionId, "action-1");
});

test("an uncertain Send blocks other actions; a sent reload locks; Retry confirms one batch", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  s.ready("right");
  transport.faults.push({ after: lost() });
  s.$("send").click();
  await settle(s);
  const original = s.controller.getState().failure.request;
  assert.equal(s.controller.getState().failure.op, "send");
  assert.equal(s.controller.getState().failure.uncertain, true);
  assert.equal(s.controller.getState().readOnly, false, "nothing is claimed yet");
  const before = mutations(transport).length;
  await tryFreshActions(s);
  assert.equal(mutations(transport).length, before);
  s.$("alertReload").click();
  await settle(s);
  assert.equal(s.controller.getState().readOnly, true, "a valid sent view locks");
  assert.equal(s.lastState("left").readOnly, true);
  assert.equal(s.controller.getState().failure.request, original, "the Send receipt is still unconfirmed");
  assert.equal(s.$("alertRetry").hidden, false);
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(mutations(transport).at(-1).request, original);
  assert.equal(s.controller.getState().failure, null);
  assert.equal(s.$("statusText").textContent, "Sent · read-only");
  const batch = await f.store.poll(f.comparisonId);
  assert.ok(batch);
  assert.equal((await f.store.snapshot(f.comparisonId)).receipts.length, 1, "one Send");
});

test("a success answer without its receipt is unresolved even when its view is valid", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  transport.faults.push({ reply: (payload) => ({ view: payload.view }) });
  s.intent("left", "keeper", "hero");
  await settle(s);
  let state = s.controller.getState();
  assert.equal(state.failure.uncertain, true);
  assert.equal(state.canMutate, false);
  const original = state.failure.request;
  transport.faults.push({ reply: (payload) => ({ view: payload.view, result: { actionId: "someone-else", revision: 1 } }) });
  s.$("alertRetry").click();
  await settle(s);
  state = s.controller.getState();
  assert.equal(state.failure.request, original, "a mismatched receipt proves nothing");
  assert.equal(state.failure.uncertain, true);
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(s.controller.getState().failure, null);
  assert.equal(s.component("left", "hero").keeper, true);
});

test("a proven rejection on Retry resolves as not saved; the refreshed stale state permits a new action", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  const popup = await typeFeedback(s, "left", "hero", "Too dark.");
  // The request never reached the archive, but the client cannot know that.
  transport.faults.push({ before: lost() });
  popup.withFeedback.click();
  await settle(s);
  assert.equal(s.controller.getState().failure.uncertain, true);
  // Another tab saves meanwhile, so Retry is now stale; the store proves it never saved the original.
  await f.store.act(f.comparisonId, { actionId: "other-tab", expectedRevision: 0, kind: "keeper", pane: "left", componentId: "nav", selected: true });
  const wrap = (error) => Object.assign(new Error(error.message), { code: error.code, view: null });
  transport.act = async (request) => {
    transport.calls.push({ op: "act", request });
    try {
      const payload = await f.store.act(f.comparisonId, request);
      return payload;
    } catch (error) {
      const view = structuredClone(await f.store.read(f.comparisonId));
      throw Object.assign(wrap(error), { view });
    }
  };
  s.$("alertRetry").click();
  await settle(s);
  const state = s.controller.getState();
  assert.equal(state.failure.code, "STALE_REVISION");
  assert.equal(state.failure.uncertain, false, "the outcome is now known: not saved");
  assert.equal(state.canMutate, true, "editing returns");
  assert.equal(s.component("left", "nav").keeper, true, "the refreshed view is shown");
  assert.equal(s.shell.popup.textarea.value, "Too dark.", "the draft is kept");
  assert.match(s.$("alertText").textContent, /not saved/i);
  assert.equal(s.$("alertDismiss").hidden, false);
  s.shell.popup.withFeedback.click();
  await settle(s);
  assert.equal(s.controller.getState().failure, null);
  const snap = await f.store.snapshot(f.comparisonId);
  assert.equal(snap.feedback.length, 1);
  assert.equal(snap.feedback[0].comment, "Too dark.");
});

test("unsaved feedback on a comparison sent elsewhere is reported with its text, not dropped", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  const popup = await typeFeedback(s, "left", "hero", "Keep the old heading.");
  transport.faults.push({ before: lost() });
  popup.withFeedback.click();
  await settle(s);
  await f.store.send(f.comparisonId, { actionId: "other-send", expectedRevision: 0 });
  s.$("alertReload").click();
  await settle(s);
  assert.equal(s.controller.getState().readOnly, true);
  assert.equal(s.controller.getState().failure.uncertain, true, "the sent view does not resolve it");
  assert.equal(s.$("alertRetry").hidden, false);
  s.$("alertRetry").click();
  await settle(s);
  const state = s.controller.getState();
  assert.equal(state.failure.code, "STALE_REVISION", "the archive proves the original was not saved");
  assert.equal(state.failure.uncertain, false);
  assert.equal(state.failure.notSaved, true);
  assert.equal(s.$("alertRetry").hidden, true, "nothing to retry on a sent comparison");
  assert.equal(s.$("alert").hidden, false, "the unsaved feedback is reported");
  assert.match(s.$("alertText").textContent, /Keep the old heading\./);
  assert.equal(s.controller.getDraft("left", "hero"), "Keep the old heading.");
  assert.equal((await f.store.snapshot(f.comparisonId)).feedback.length, 0);
});

// ------------------------------------------------------------ accepted identities and roots

test("201-character comparison and component IDs boot, render controls, and save", async (t) => {
  const longComparison = `c${"x".repeat(200)}`;
  const longComponent = `h${"y".repeat(200)}`;
  const f = await storeFixture(t, {
    comparisonId: longComparison,
    left: region(longComponent, "Long hero"),
    right: region(longComponent, "Long hero"),
  });
  const view = structuredClone(await f.store.read(longComparison));
  const filled = new JSDOM(HTML.replace("__DOUBLE_COMPARISON_ID__", longComparison).replace("__TOKEN__", "tok"), { url: "https://review.test/" });
  const calls = [];
  const booted = bootDouble(filled.window, { fetch: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ view }) }; } });
  await settle(booted);
  assert.equal(calls[0], `/api/double/~${longComparison}`);
  assert.equal(filled.window.document.getElementById("pane-name-left").textContent, "Proposal A");
  booted.close();

  const transport = storeTransport(f);
  const s = await mount({ transport, comparisonId: longComparison });
  const sdk = await connectSdk(s, f.pages);
  assert.ok(sdk.button("left", longComponent, "keep"), "controls render for the long ID");
  sdk.button("left", longComponent, "keep").click();
  await settle(s);
  assert.equal(sdk.button("left", longComponent, "keep").getAttribute("aria-pressed"), "true");
  assert.equal(sdk.button("right", longComponent, "keep").getAttribute("aria-pressed"), "false");
  assert.equal((await f.store.read(longComparison)).panes.left.components[0].keeper, true);
});

// ------------------------------------------------------------ complete receipts

/**
 * Malformed success answers to a keeper request with expectedRevision 0.
 * The real archive commits first; each reply then rewrites its answer.
 */
const BAD_ACT_REPLIES = [
  ["an actionId alone", (p) => ({ view: p.view, result: { actionId: p.result.actionId } })],
  ["a wrong actionId", (p) => ({ view: p.view, result: { ...p.result, actionId: "someone-else" } })],
  ["a wrong kind", (p) => ({ view: p.view, result: { ...p.result, kind: "delete" } })],
  ["a Send kind", (p) => ({ view: p.view, result: { ...p.result, kind: "send" } })],
  ["a missing revision", (p) => ({ view: p.view, result: { actionId: p.result.actionId, kind: p.result.kind } })],
  ["a negative revision", (p) => ({ view: p.view, result: { ...p.result, revision: -1 } })],
  ["a fractional revision", (p) => ({ view: p.view, result: { ...p.result, revision: 1.5 } })],
  ["an unsafe revision", (p) => ({ view: p.view, result: { ...p.result, revision: 2 ** 53 } })],
  ["a string revision", (p) => ({ view: p.view, result: { ...p.result, revision: "1" } })],
  ["a wrong revision", (p) => ({ view: { ...p.view, revision: 2 }, result: { ...p.result, revision: 2 } })],
  ["a receipt newer than its view", (p) => ({ view: { ...p.view, revision: 0 }, result: p.result })],
  ["an unexpected batch ID", (p) => ({ view: p.view, result: { ...p.result, batchId: "batch-x" } })],
];

/** Assert that the original request stays unresolved, retryable, and blocks fresh actions. */
async function assertUnresolved(s, transport, original, name) {
  const state = s.controller.getState();
  assert.equal(state.failure?.request, original, `${name}: the original request stays`);
  assert.equal(state.failure.uncertain, true, `${name}: the outcome stays unknown`);
  assert.match(state.failure.code, /^BAD_(RESULT|VIEW)$/, name);
  assert.equal(state.canMutate, false, name);
  assert.equal(s.lastState("left").busy, true, name);
  assert.equal(s.lastState("right").busy, true, name);
  assert.match(s.$("statusText").textContent, /not confirmed/, `${name}: never claims Saved`);
  assert.equal(s.$("alertRetry").hidden, false, name);
  assert.equal(s.$("alertDismiss").hidden, true, name);
  const before = mutations(transport).length;
  await tryFreshActions(s);
  assert.equal(mutations(transport).length, before, `${name}: no fresh mutation`);
}

for (const [name, reply] of BAD_ACT_REPLIES) {
  test(`a keeper success with ${name} is unresolved, also on repeated malformed Retry`, async (t) => {
    const f = await storeFixture(t);
    const transport = storeTransport(f);
    const s = await mount({ transport });
    s.ready("left");
    s.ready("right");
    transport.faults.push({ reply });
    s.intent("left", "keeper", "hero");
    await settle(s);
    const original = s.controller.getState().failure?.request;
    assert.ok(original, `${name}: the first answer is not a save`);
    assert.equal(original.kind, "keeper");
    await assertUnresolved(s, transport, original, name);
    transport.faults.push({ reply });
    s.$("alertRetry").click();
    await settle(s);
    await assertUnresolved(s, transport, original, `${name} (repeated)`);
    s.$("alertRetry").click();
    await settle(s);
    assert.equal(s.controller.getState().failure, null, "the complete receipt resolves it");
    assert.equal(s.component("left", "hero").keeper, true);
    assert.equal((await f.store.snapshot(f.comparisonId)).receipts.length, 1, "one saved action");
  });
}

test("a lost keeper answer retried with incomplete receipts stays unresolved", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  s.ready("right");
  transport.faults.push({ after: lost() });
  s.intent("left", "keeper", "hero");
  await settle(s);
  const original = s.controller.getState().failure.request;
  for (const [name, reply] of [BAD_ACT_REPLIES[0], BAD_ACT_REPLIES[10], BAD_ACT_REPLIES[0]]) {
    transport.faults.push({ reply });
    s.$("alertRetry").click();
    await settle(s);
    await assertUnresolved(s, transport, original, name);
  }
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(s.controller.getState().failure, null);
  assert.equal(s.component("left", "hero").keeper, true);
  assert.equal((await f.store.snapshot(f.comparisonId)).receipts.length, 1);
});

test("a lost feedback deletion retried with malformed successes keeps its draft and stays unresolved", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  s.ready("right");
  const zeroView = structuredClone(s.controller.getState().view);
  const popup = await typeFeedback(s, "left", "hero", "Too tall.");
  transport.faults.push({ after: lost() });
  popup.withFeedback.click();
  await settle(s);
  const original = s.controller.getState().failure.request;
  const replies = [
    // The coordinator reproduction: an actionId alone with the revision-zero view.
    ["an actionId alone with a revision-zero view", () => ({ view: structuredClone(zeroView), result: { actionId: original.actionId } })],
    ["a wrong kind", (p) => ({ view: p.view, result: { ...p.result, kind: "delete" } })],
    ["a receipt newer than its view", (p) => ({ view: structuredClone(zeroView), result: p.result })],
    ["an actionId alone again", () => ({ view: structuredClone(zeroView), result: { actionId: original.actionId } })],
  ];
  for (const [name, reply] of replies) {
    transport.faults.push({ reply });
    s.$("alertRetry").click();
    await settle(s);
    assert.equal(s.controller.getDraft("left", "hero"), "Too tall.", `${name}: the draft stays`);
    assert.equal(s.shell.popup?.textarea.value, "Too tall.", `${name}: the popup keeps the text`);
    await assertUnresolved(s, transport, original, name);
  }
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(s.controller.getState().failure, null);
  assert.equal(s.controller.getDraft("left", "hero"), "", "the confirmed save clears the draft");
  const snap = await f.store.snapshot(f.comparisonId);
  assert.equal(snap.feedback.length, 1);
  assert.equal(snap.receipts.length, 1);
});

const BAD_SEND_REPLIES = [
  ["no batch ID", (p) => ({ view: p.view, result: { actionId: p.result.actionId, kind: "send", revision: p.result.revision } })],
  ["an empty batch ID", (p) => ({ view: p.view, result: { ...p.result, batchId: "" } })],
  ["a batch ID with a space", (p) => ({ view: p.view, result: { ...p.result, batchId: "batch x" } })],
  ["a batch ID other than the view's", (p) => ({ view: p.view, result: { ...p.result, batchId: "batch-other" } })],
  ["a view with another batch", (p) => ({ view: { ...p.view, delivery: { ...p.view.delivery, batchId: "batch-other" } }, result: p.result })],
  ["a view without delivery", (p) => { const { delivery, ...view } = p.view; return { view, result: p.result }; }],
  ["an editing view", (p) => ({ view: { ...p.view, status: "editing", delivery: { batchId: null, acknowledged: false } }, result: p.result })],
  ["a keeper kind", (p) => ({ view: p.view, result: { ...p.result, kind: "keeper" } })],
  ["an actionId alone", (p) => ({ view: p.view, result: { actionId: p.result.actionId } })],
];

for (const [name, reply] of BAD_SEND_REPLIES) {
  test(`a Send success with ${name} is unresolved, also on repeated malformed Retry`, async (t) => {
    const f = await storeFixture(t);
    const transport = storeTransport(f);
    const s = await mount({ transport });
    s.ready("left");
    s.ready("right");
    transport.faults.push({ reply });
    s.$("send").click();
    await settle(s);
    const original = s.controller.getState().failure?.request;
    assert.ok(original, `${name}: the first answer is not a Send`);
    assert.equal(s.controller.getState().failure.op, "send");
    assert.equal(s.controller.getState().failure.uncertain, true, name);
    assert.equal(s.$("statusText").textContent, "Send not confirmed", name);
    assert.equal(s.$("alertRetry").hidden, false);
    transport.faults.push({ reply });
    s.$("alertRetry").click();
    await settle(s);
    assert.equal(s.controller.getState().failure?.request, original, `${name} (repeated)`);
    assert.equal(s.controller.getState().failure.uncertain, true);
    assert.equal(s.$("statusText").textContent, "Send not confirmed");
    s.$("alertRetry").click();
    await settle(s);
    assert.equal(s.controller.getState().failure, null);
    assert.equal(s.$("statusText").textContent, "Sent · read-only");
    assert.equal((await f.store.snapshot(f.comparisonId)).receipts.length, 1, "one Send");
  });
}

test("Retry accepts the original receipt with a newer authoritative view", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  s.ready("right");
  transport.faults.push({ after: lost() });
  s.intent("left", "keeper", "hero");
  await settle(s);
  // Another tab saves after the lost answer, so the latest view is newer than the receipt.
  await f.store.act(f.comparisonId, { actionId: "other-tab", expectedRevision: 1, kind: "keeper", pane: "left", componentId: "nav", selected: true });
  s.$("alertRetry").click();
  await settle(s);
  const state = s.controller.getState();
  assert.equal(state.failure, null);
  assert.equal(state.canMutate, true);
  assert.equal(state.view.revision, 2);
  assert.equal(s.component("left", "hero").keeper, true);
  assert.equal(s.component("left", "nav").keeper, true);
  assert.equal(s.$("statusText").textContent, "Saved");
});

test("a lost Send answer retried after acknowledgment accepts the original receipt and the newer view", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  s.ready("left");
  transport.faults.push({ after: lost() });
  s.$("send").click();
  await settle(s);
  const batch = await f.store.poll(f.comparisonId);
  await f.store.acknowledge(f.comparisonId, { actionId: "agent-ack", batchId: batch.id });
  s.$("alertRetry").click();
  await settle(s);
  const state = s.controller.getState();
  assert.equal(state.failure, null);
  assert.equal(state.readOnly, true);
  assert.equal(state.view.revision, 2);
  assert.equal(state.view.delivery.batchId, batch.id);
  assert.equal(s.$("statusText").textContent, "Sent · read-only");
});

// ------------------------------------------------------------ Unicode identity

// The input validator's rule: nonempty, no whitespace, no Unicode category C.
const UNICODE_IDS = ["é", "日本語", "✓-mark", "😀", "Ωmega_1", "ß", "a~b"];
const CATEGORY_C_IDS = ["a\u0085b", "a​b", "a\ud800", "\udc00a", "a­b", "ab", "a͸b", "a\u0007b", "a b", ""];

test("Unicode identities follow the validator in views and frame intents", () => {
  const withComponent = (id) => {
    const view = baseView();
    view.panes.left.components[0].id = id;
    return view;
  };
  for (const id of UNICODE_IDS) {
    assert.equal(/[\s\p{C}]/u.test(id), false);
    assert.equal(validateView(withComponent(id), ID), null, `${JSON.stringify(id)} is a valid component ID`);
    const parsed = parseFrameMessage({ channel: CHANNEL, type: "intent", comparisonId: ID, pane: "left", instance: "a1a1a1a1", intent: "keeper", componentId: id }, ID, "left");
    assert.equal(parsed?.componentId, id);
  }
  for (const id of CATEGORY_C_IDS) {
    assert.notEqual(validateView(withComponent(id), ID), null, `${JSON.stringify(id)} is rejected`);
    const parsed = parseFrameMessage({ channel: CHANNEL, type: "intent", comparisonId: ID, pane: "left", instance: "a1a1a1a1", intent: "keeper", componentId: id }, ID, "left");
    assert.equal(parsed, null, `${JSON.stringify(id)} intent is rejected`);
  }
});

test("bootstrap accepts Unicode comparison IDs and refuses category C", async () => {
  for (const id of UNICODE_IDS) {
    const dom = new JSDOM(HTML, { url: "https://review.test/" });
    dom.window.document.body.dataset.comparison = id;
    dom.window.document.body.dataset.token = "tok";
    const view = { ...baseView(), comparisonId: id };
    const calls = [];
    const shell = bootDouble(dom.window, { fetch: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ view }) }; } });
    await settle(shell);
    assert.equal(calls[0], `/api/double/~${encodeURIComponent(id)}`, `${JSON.stringify(id)} boots`);
    assert.equal(dom.window.document.getElementById("pane-name-left").textContent, "Proposal A");
    shell.close();
  }
  for (const id of CATEGORY_C_IDS) {
    const dom = new JSDOM(HTML, { url: "https://review.test/" });
    dom.window.document.body.dataset.comparison = id;
    dom.window.document.body.dataset.token = "tok";
    bootDouble(dom.window, { fetch: () => assert.fail(`no request for ${JSON.stringify(id)}`) });
    await flush();
    assert.match(dom.window.document.getElementById("alertText").textContent, /no comparison or token/);
  }
});

test("Unicode component IDs render controls and save through the real SDK", async (t) => {
  const f = await storeFixture(t, { comparisonId: "über-✓", left: region("日本語", "Japanese"), right: region("😀", "Smile") });
  const transport = storeTransport(f);
  const s = await mount({ transport, comparisonId: "über-✓" });
  const sdk = await connectSdk(s, f.pages);
  assert.ok(sdk.button("left", "日本語", "keep"));
  assert.ok(sdk.button("right", "😀", "delete"));
  sdk.button("left", "日本語", "keep").click();
  await settle(s);
  assert.equal(sdk.button("left", "日本語", "keep").getAttribute("aria-pressed"), "true");
  assert.equal((await f.store.read("über-✓")).panes.left.components[0].keeper, true);
});

// ------------------------------------------------------------ trusted parent component controls

/** The parent-shell component controls of one pane. They never read frame DOM. */
function parentControls(s, pane) {
  const list = s.$(`controls-list-${pane}`);
  const row = (id) => [...list.querySelectorAll(".control-row")].find((r) => r.dataset.componentId === id) ?? null;
  return {
    details: s.$(`controls-${pane}`),
    list,
    row,
    ids: () => [...list.querySelectorAll(".control-row")].map((r) => r.dataset.componentId),
    keep: (id) => row(id)?.querySelector(".control-keep") ?? null,
    del: (id) => row(id)?.querySelector(".control-delete") ?? null,
    buttons: () => [...list.querySelectorAll("button")],
  };
}

const allParentButtons = (s) => ["left", "right"].flatMap((pane) => parentControls(s, pane).buttons());

test("each pane has a labeled native details section for its component controls, outside the frame stage", () => {
  const doc = new JSDOM(HTML).window.document;
  for (const pane of ["left", "right"]) {
    const details = doc.getElementById(`controls-${pane}`);
    assert.equal(details.localName, "details");
    assert.equal(details.open, false, "collapsed by default, so ordinary review stays uncluttered");
    assert.equal(details.closest(".pane").dataset.pane, pane);
    assert.equal(details.closest(".pane-stage"), null, "not covered by the frame");
    const summary = details.querySelector(":scope > summary");
    assert.match(summary.textContent, /Component controls/);
    const list = doc.getElementById(`controls-list-${pane}`);
    assert.equal(list.getAttribute("aria-label"), `${pane === "left" ? "Left" : "Right"} pane components`);
  }
  assert.match(CSS, /\.pane-controls/);
  assert.doesNotMatch(CSS, /@import|url\(/);
});

test("parent controls keep, clear, and delete without any frame ready message", async () => {
  const s = await mount();
  const L = parentControls(s, "left");
  const R = parentControls(s, "right");
  assert.deepEqual(L.ids(), ["hero", "nav"]);
  assert.deepEqual(R.ids(), ["hero"]);
  assert.equal(s.posts.left.length + s.posts.right.length, 0, "no frame is ready");
  assert.equal(L.keep("hero").getAttribute("aria-label"), "Keep: Hero");
  assert.equal(L.keep("hero").getAttribute("aria-pressed"), "false");
  assert.equal(L.del("hero").getAttribute("aria-label"), "Delete: Hero");
  assert.equal(L.del("hero").getAttribute("aria-haspopup"), "dialog");
  assert.match(s.$("controls-count-left").textContent, /2/);

  L.keep("hero").click();
  await flush();
  assert.deepEqual(s.transport.calls.at(-1).request, { actionId: "action-1", expectedRevision: 1, kind: "keeper", pane: "left", componentId: "hero", selected: true });
  assert.equal(L.keep("hero").getAttribute("aria-pressed"), "true");
  assert.equal(L.keep("hero").getAttribute("aria-label"), "Keeper: Hero");
  assert.equal(R.keep("hero").getAttribute("aria-pressed"), "false", "the same ID in the opposite pane stays");
  L.keep("hero").click();
  await flush();
  assert.equal(s.transport.calls.at(-1).request.selected, false, "a second click clears the keeper");
  assert.equal(L.keep("hero").getAttribute("aria-pressed"), "false");
  R.keep("hero").click();
  await flush();
  assert.equal(s.transport.calls.at(-1).request.pane, "right");
  assert.equal(R.keep("hero").getAttribute("aria-pressed"), "true");
  assert.equal(L.keep("hero").getAttribute("aria-pressed"), "false");

  // The same trusted popup opens over the pane.
  const calls = s.transport.calls.length;
  L.del("hero").click();
  const popup = s.shell.popup;
  assert.equal(popup.pane, "left");
  assert.equal(popup.componentId, "hero");
  assert.ok(s.$("stage-left").contains(popup.node));
  assert.equal(s.doc.activeElement, popup.plain);
  popup.textarea.value = "Left draft";
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  popup.node.dispatchEvent(new s.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(s.shell.popup, null);
  assert.equal(s.doc.activeElement, L.del("hero"), "focus returns to the parent control");
  R.del("hero").click();
  assert.equal(s.shell.popup.pane, "right");
  assert.equal(s.shell.popup.textarea.value, "", "the opposite pane has its own draft");
  assert.ok(s.$("stage-right").contains(s.shell.popup.node));
  s.shell.popup.cancel.click();
  assert.equal(s.doc.activeElement, R.del("hero"));
  L.del("hero").click();
  assert.equal(s.shell.popup.textarea.value, "Left draft", "Cancel and Escape keep the draft");
  assert.equal(s.doc.activeElement, s.shell.popup.textarea);
  assert.equal(s.transport.calls.length, calls, "Cancel and Escape change nothing");
  s.shell.popup.plain.click();
  await flush();
  assert.deepEqual(s.transport.calls.at(-1).request, { actionId: "action-4", expectedRevision: 4, kind: "delete", pane: "left", componentId: "hero" });
  assert.equal(s.shell.popup, null);
  assert.equal(L.keep("hero"), null, "a deleted component has no keeper or delete control");
  assert.equal(L.del("hero"), null);
  assert.match(L.row("hero").textContent, /Deleted/);
  assert.ok(R.del("hero"), "the opposite pane keeps its component");
  s.doc.querySelector(".row-undo").click();
  await flush();
  assert.equal(s.transport.calls.at(-1).request.kind, "undo");
  assert.ok(L.del("hero"), "Undo returns the controls");

  L.del("nav").click();
  s.shell.popup.textarea.value = "Too wide.";
  s.shell.popup.textarea.dispatchEvent(new s.win.Event("input"));
  s.shell.popup.withFeedback.click();
  await flush();
  assert.deepEqual(s.transport.calls.at(-1).request, { actionId: "action-6", expectedRevision: 6, kind: "feedback-delete", pane: "left", componentId: "nav", feedback: "Too wide." });
  assert.equal(s.doc.querySelector(".history-feedback").textContent, "Too wide.");
  assert.equal(s.controller.getDraft("left", "nav"), "");
});

test("parent controls pause in both panes while a request saves", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive });
  const L = parentControls(s, "left");
  const R = parentControls(s, "right");
  assert.ok(allParentButtons(s).every((b) => !b.disabled));
  L.keep("hero").click();
  assert.equal(transport.calls.at(-1).op, "act");
  assert.ok(allParentButtons(s).every((b) => b.disabled), "every parent control waits");
  for (const button of allParentButtons(s)) {
    button.disabled = false;
    button.click();
  }
  assert.equal(transport.calls.length, 2, "no second mutation while saving");
  assert.equal(s.shell.popup, null);
  transport.calls.at(-1).ok();
  await flush();
  assert.ok(allParentButtons(s).every((b) => !b.disabled));
  assert.equal(L.keep("hero").getAttribute("aria-pressed"), "true");
  assert.equal(R.keep("hero").getAttribute("aria-pressed"), "false");
});

test("parent controls stay paused while an outcome is unresolved; Retry sends the same request", async (t) => {
  const f = await storeFixture(t);
  const transport = storeTransport(f);
  const s = await mount({ transport });
  const L = parentControls(s, "left");
  L.del("hero").click();
  const popup = s.shell.popup;
  popup.textarea.value = "Too tall.";
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  transport.faults.push({ after: lost() });
  popup.withFeedback.click();
  await settle(s);
  const original = s.controller.getState().failure.request;
  assert.equal(s.controller.getState().unresolved, true);
  assert.ok(allParentButtons(s).every((b) => b.disabled), "parent controls wait for the outcome");
  assert.equal(s.shell.popup, popup, "the popup and its draft stay");
  assert.equal(popup.textarea.value, "Too tall.");
  const before = mutations(transport).length;
  for (const button of allParentButtons(s)) {
    button.disabled = false;
    button.click();
  }
  await settle(s);
  assert.equal(mutations(transport).length, before, "no fresh action bypasses the unresolved request");
  assert.equal(s.shell.popup?.componentId, "hero", "a parent delete click does not replace the popup");
  s.$("alertReload").click();
  await settle(s);
  assert.ok(allParentButtons(s).every((b) => b.disabled), "a reloaded view is not a receipt");
  assert.equal(parentControls(s, "left").keep("hero"), null, "the reloaded view shows the commit");
  s.$("alertRetry").click();
  await settle(s);
  assert.equal(mutations(transport).at(-1).request, original, "Retry sends the identical request");
  assert.equal(s.controller.getState().failure, null);
  assert.ok(allParentButtons(s).every((b) => !b.disabled));
  assert.equal((await f.store.snapshot(f.comparisonId)).feedback.length, 1);
});

test("a failed parent feedback deletion keeps the popup and draft; Retry reuses the exact request", async () => {
  const archive = fakeArchive();
  const failure = Object.assign(new Error("Disk full."), { code: "WRITE_FAILED" });
  const failNext = [];
  const transport = autoTransport(archive, { failNext });
  const s = await mount({ transport, archive });
  const L = parentControls(s, "left");
  L.del("nav").click();
  const popup = s.shell.popup;
  popup.textarea.value = "Wrong order.";
  popup.textarea.dispatchEvent(new s.win.Event("input"));
  failNext.push(failure);
  popup.withFeedback.click();
  await flush();
  assert.equal(s.shell.popup, popup);
  assert.match(popup.status.textContent, /Save failed: Disk full\./);
  assert.equal(popup.retry.hidden, false);
  assert.equal(s.controller.getDraft("left", "nav"), "Wrong order.");
  assert.ok(allParentButtons(s).every((b) => !b.disabled), "a confirmed failure returns editing");
  popup.retry.click();
  await flush();
  const acts = transport.calls.filter((c) => c.op === "act");
  assert.equal(acts.length, 2);
  assert.equal(acts[1].request, acts[0].request, "Retry reuses the request object");
  assert.equal(s.shell.popup, null);
  assert.equal(parentControls(s, "left").del("nav"), null);
});

test("parent controls follow an empty Send into read-only, also after reload", async () => {
  const archive = fakeArchive();
  const s = await mount({ archive });
  s.$("send").click();
  await flush();
  for (const shell of [s, await mount({ archive })]) {
    for (const pane of ["left", "right"]) {
      const c = parentControls(shell, pane);
      assert.ok(c.ids().length > 0, "viewing continues");
      assert.equal(c.list.querySelectorAll(".control-delete").length, 0, "read-only removes deletion");
      assert.ok(c.buttons().every((b) => b.disabled));
    }
    const keep = parentControls(shell, "left").keep("hero");
    keep.disabled = false;
    keep.click();
    await flush();
    assert.equal(shell.transport.calls.filter((c) => c.op !== "load").length, shell === s ? 1 : 0, "no mutation after Send");
  }
});

test("parent controls wait for a saved view and never list invalid or unknown components", async () => {
  const archive = fakeArchive();
  const transport = manualTransport(archive);
  const s = await mount({ transport, archive, load: false });
  const loading = s.controller.load();
  assert.equal(parentControls(s, "left").ids().length, 0);
  assert.match(s.$("controls-note-left").textContent, /saved state/i);
  transport.calls.at(-1).ok();
  await loading;
  assert.deepEqual(parentControls(s, "left").ids(), ["hero", "nav"]);

  const bad = baseView();
  bad.panes.left.components.push({ id: "bad id", label: "Bad", keeper: false, deleted: false, deletionActionId: null });
  const b = await mount({ archive: fakeArchive(bad) });
  assert.equal(b.controller.getState().status, "load-failed");
  assert.equal(parentControls(b, "left").ids().length, 0, "a view with an invalid ID shows no controls");
  assert.equal(parentControls(b, "right").ids().length, 0);
});

test("parent control labels render as text, never markup", async () => {
  const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>`;
  const view = baseView();
  view.panes.left.components[0].label = evil;
  view.panes.right.components[0].id = `"><img/src=x>`;
  const s = await mount({ archive: fakeArchive(view) });
  const L = parentControls(s, "left");
  assert.equal(L.row("hero").querySelector(".control-name").textContent, evil);
  assert.equal(L.keep("hero").getAttribute("aria-label"), `Keep: ${evil}`);
  assert.deepEqual(parentControls(s, "right").ids(), [`"><img/src=x>`]);
  assert.equal(s.doc.querySelectorAll("img, .pane-controls script").length, 0);
  assert.equal(s.win.pwned, undefined);
  L.del("hero").click();
  assert.equal(s.shell.popup.node.querySelector(".popup-name").textContent, evil);
});

// ------------------------------------------------------------ reviewed roots with the real SDK

/** Attributes of html, head, and body and their jsdom computed display. */
function rootShape(doc) {
  const view = doc.defaultView;
  return [doc.documentElement, doc.head, doc.body].map((e) => [
    e.localName,
    ...[...e.attributes].map((a) => `${a.name}=${a.name === "style" ? e.style.cssText : a.value}`),
    view.getComputedStyle(e).display,
  ]);
}

const rootPage = ({ htmlAttrs = "", head = "" }, body) => `<!doctype html><html${htmlAttrs}><head>${head}</head><body>${body}</body></html>`;

const ROOT_CASES = [
  ["html hidden", { htmlAttrs: " hidden" }],
  ["html hidden=until-found", { htmlAttrs: ' hidden="until-found"' }],
  ["inline display:none", { htmlAttrs: ' style="display: none"' }],
  ["stylesheet display:none !important", { head: "<style>:root { display: none !important }</style>" }],
  ["hidden and inert", { htmlAttrs: " hidden inert" }],
  ["html inert", { htmlAttrs: " inert" }],
  ["hidden overridden visible by CSS", { htmlAttrs: " hidden", head: "<style>html[hidden] { display: block !important }</style>" }],
  ["visible root pseudo-element content", { head: '<style>html::before { content: "Root text" }</style>' }],
  ["hidden root pseudo-element content", { htmlAttrs: " hidden", head: '<style>html::after { content: "Root text"; display: block }</style>' }],
  ["a colored root background", { htmlAttrs: ' hidden style="background: #c00"', head: "<style>html { background: red } body { background: green }</style>" }],
];

for (const [name, options] of ROOT_CASES) {
  test(`a root with ${name} stays unchanged; parent controls act through the same controller`, async () => {
    const archive = fakeArchive();
    const s = await mount({ archive });
    const pages = {
      left: rootPage(options, '<section data-double-id="hero" data-container="Hero">A</section><nav data-double-id="nav" data-container="Navigation" style="color: blue">N</nav><p data-double-id="ghost" data-container="Ghost">G</p>'),
      right: rootPage(options, '<section data-double-id="hero" data-container="Hero">B</section>'),
    };
    const original = { left: rootShape(new JSDOM(pages.left).window.document), right: rootShape(new JSDOM(pages.right).window.document) };
    const sdk = await connectSdk(s, pages);
    const doc = (pane) => sdk.frames[pane].dom.window.document;
    const unchanged = (when) => {
      for (const pane of ["left", "right"]) assert.deepEqual(rootShape(doc(pane)), original[pane], `${pane} root ${when}`);
    };
    unchanged("at boot");
    const L = parentControls(s, "left");
    const R = parentControls(s, "right");
    assert.deepEqual(L.ids(), ["hero", "nav"], "a marker unknown to the saved view gets no parent control");
    assert.ok(sdk.button("left", "hero", "keep"), "the in-frame bubble still renders");
    L.keep("hero").click();
    await flush();
    assert.equal(L.keep("hero").getAttribute("aria-pressed"), "true");
    assert.equal(sdk.button("left", "hero", "keep").getAttribute("aria-pressed"), "true", "the frame receives the saved state");
    assert.equal(R.keep("hero").getAttribute("aria-pressed"), "false");
    L.del("nav").click();
    s.shell.popup.plain.click();
    await flush();
    assert.equal(sdk.element("left", "nav").style.getPropertyValue("display"), "none");
    unchanged("after a deletion");
    s.doc.querySelector(".row-undo").click();
    await flush();
    assert.equal(sdk.element("left", "nav").getAttribute("style"), "color: blue;", "Undo restores the exact prior style");
    unchanged("after Undo");
    await sdk.reload("left");
    await flush();
    unchanged("after a frame reload");
    R.del("hero").click();
    assert.equal(s.shell.popup.pane, "right");
    s.shell.popup.plain.click();
    await flush();
    assert.equal(sdk.element("right", "hero").style.getPropertyValue("display"), "none");
    assert.equal(sdk.element("left", "hero").style.getPropertyValue("display"), "");
  });
}

for (const [name, htmlAttrs] of [["hidden", " hidden"], ["inline display:none !important", ' style="display: none !important"'], ["hidden and inert", " hidden inert"], ["inert", " inert"]]) {
  test(`an accepted ${name} document root stays unchanged and saves through parent controls`, async (t) => {
    const f = await storeFixture(t, { htmlAttrs });
    const original = { left: rootShape(new JSDOM(f.pages.left).window.document), right: rootShape(new JSDOM(f.pages.right).window.document) };
    const transport = storeTransport(f);
    const s = await mount({ transport });
    const sdk = await connectSdk(s, f.pages);
    const unchanged = () => {
      for (const pane of ["left", "right"]) assert.deepEqual(rootShape(sdk.frames[pane].dom.window.document), original[pane]);
    };
    unchanged();
    parentControls(s, "left").keep("hero").click();
    await settle(s);
    assert.equal((await f.store.read(f.comparisonId)).panes.left.components[0].keeper, true);
    parentControls(s, "left").del("nav").click();
    s.shell.popup.plain.click();
    await settle(s);
    assert.equal(sdk.element("left", "nav").style.display, "none");
    s.doc.querySelector(".row-undo").click();
    await settle(s);
    assert.equal(sdk.element("left", "nav").getAttribute("style"), null);
    unchanged();
    await sdk.reload("left");
    await flush();
    unchanged();
    assert.equal(parentControls(s, "left").keep("hero").getAttribute("aria-pressed"), "true");
  });
}

// ------------------------------------------------------------ head components with the real SDK and archive

const HEAD_CASES = [
  ["an ordinary head", ' data-double-id="meta" data-container="Metadata"', '<meta name="description" content="y">'],
  ["a head displayed inline with a pseudo-element", ' data-double-id="meta" data-container="Metadata" style="color: red; display: block !important"', '<style>head::before { content: "Visible head"; display: block }</style>'],
  ["a head displayed by CSS", ' data-double-id="meta" data-container="Metadata"', "<style>head { display: block } head::after { content: \"Tail\" }</style>"],
];

for (const [name, headAttrs, head] of HEAD_CASES) {
  test(`${name} is accepted, hides on a saved parent deletion, and Undo restores it exactly, with the SDK in head`, async (t) => {
    // DoubleStore.create validates through the reviewed input validator, so this copy is accepted input.
    const f = await storeFixture(t, { headAttrs, head });
    assert.deepEqual((await f.store.read(f.comparisonId)).panes.left.components.map((c) => c.id), ["meta", "hero", "nav"]);
    const transport = storeTransport(f);
    const s = await mount({ transport });
    const sdk = await connectSdk(s, f.pages, { inHead: true });
    const doc = sdk.frames.left.dom.window.document;
    const headEl = doc.head;
    const original = rootShape(new JSDOM(f.pages.left).window.document);
    const prior = { value: headEl.style.getPropertyValue("display"), priority: headEl.style.getPropertyPriority("display") };
    const children = [...headEl.children];
    assert.deepEqual(rootShape(doc), original, "boot changes nothing");
    const L = parentControls(s, "left");
    assert.deepEqual(L.ids(), ["meta", "hero", "nav"]);
    L.del("meta").click();
    assert.equal(s.shell.popup.pane, "left");
    s.shell.popup.plain.click();
    await settle(s);
    assert.equal((await f.store.read(f.comparisonId)).panes.left.components[0].deleted, true);
    assert.equal(doc.defaultView.getComputedStyle(headEl).display, "none", "the deleted head is not displayed");
    assert.equal(headEl.style.getPropertyPriority("display"), "important");
    assert.deepEqual([...headEl.children], children, "metadata, styles, and the SDK script stay connected");
    assert.ok(children.every((c) => c.isConnected));
    // The state channel continues: an in-frame keeper on another component saves and renders.
    sdk.button("left", "hero", "keep").click();
    await settle(s);
    assert.equal(sdk.button("left", "hero", "keep").getAttribute("aria-pressed"), "true");
    s.doc.querySelector(".row-undo").click();
    await settle(s);
    assert.equal(headEl.style.getPropertyValue("display"), prior.value);
    assert.equal(headEl.style.getPropertyPriority("display"), prior.priority);
    const after = rootShape(new JSDOM(f.pages.left).window.document);
    assert.deepEqual(rootShape(doc), after, "Undo restores the exact prior head attributes and display");
    assert.equal(sdk.element("right", "hero").style.display, "", "the opposite pane is untouched");
    await sdk.reload("left");
    await flush();
    assert.ok(sdk.button("left", "meta", "keep"), "a reloaded frame gets controls again");
    assert.deepEqual(rootShape(sdk.frames.left.dom.window.document), original);
  });
}

// ------------------------------------------------------------ stale reloads

/** Transport whose GETs answer with views the test chooses, in any order. */
function scriptedTransport(archive) {
  const calls = [];
  const transport = manualTransport(archive);
  return {
    calls: transport.calls,
    loads: calls,
    load: () => new Promise((resolve, reject) => {
      const entry = { resolve: (view) => resolve({ view: structuredClone(view) }), reject };
      calls.push(entry);
      transport.calls.push({ op: "load", ok: () => entry.resolve(archive.view), fail: reject });
    }),
    act: transport.act,
    send: transport.send,
  };
}

const viewAt = (revision, extra = {}) => ({ ...baseView(), revision, ...extra });

test("a successful but older reload never replaces a newer editing view and says so", async () => {
  const archive = fakeArchive(viewAt(3));
  const s = await mount({ archive });
  const older = viewAt(2);
  older.panes.left.components[0].keeper = true;
  s.transport.load = () => Promise.resolve({ view: older });
  assert.equal(await s.controller.load(), false, "a stale answer is not a successful refresh");
  const state = s.controller.getState();
  assert.equal(state.view.revision, 3);
  assert.equal(state.view.panes.left.components[0].keeper, false);
  assert.equal(state.loadError.code, "STALE_VIEW");
  assert.match(s.$("alertText").textContent, /^Refresh failed: .*revision 2, older than revision 3 on screen\. The answer was not applied\./);
  assert.equal(parentControls(s, "left").keep("hero").getAttribute("aria-pressed"), "false");
  // A current reload clears the report.
  s.transport.load = () => Promise.resolve({ view: viewAt(3) });
  assert.equal(await s.controller.load(), true);
  assert.equal(s.controller.getState().loadError, null);
  assert.equal(s.$("alert").hidden, true);
  // A newer reload is applied.
  const newer = viewAt(5);
  newer.panes.right.components[0].keeper = true;
  s.transport.load = () => Promise.resolve({ view: newer });
  assert.equal(await s.controller.load(), true);
  assert.equal(s.controller.getState().view.revision, 5);
  assert.equal(parentControls(s, "right").keep("hero").getAttribute("aria-pressed"), "true");
});

test("a successful Send stays read-only when a reload answers with an older or same-revision editing view", async () => {
  const archive = fakeArchive();
  const s = await mount({ archive });
  s.ready("left");
  s.ready("right");
  s.$("send").click();
  await flush();
  assert.equal(s.controller.getState().view.revision, 2);
  for (const stale of [viewAt(1), viewAt(2)]) {
    s.transport.load = () => Promise.resolve({ view: stale });
    assert.equal(await s.controller.load(), false);
    const state = s.controller.getState();
    assert.equal(state.view.status, "sent");
    assert.equal(state.readOnly, true);
    assert.equal(state.canMutate, false);
    assert.equal(state.loadError.code, "STALE_VIEW");
    assert.equal(s.$("statusText").textContent, "Sent · read-only");
    assert.equal(s.$("send").disabled, true);
    assert.equal(s.lastState("left").readOnly, true);
    assert.equal(s.lastState("right").readOnly, true);
    assert.ok(allParentButtons(s).every((b) => b.disabled));
    assert.equal(parentControls(s, "left").del("hero"), null);
    assert.equal((await s.controller.toggleKeeper("left", "hero")).refused, "read-only");
    assert.equal((await s.controller.send()).refused, "read-only");
    s.intent("left", "delete", "hero");
    assert.equal(s.shell.popup, null);
  }
  assert.equal(s.transport.calls.filter((c) => c.op !== "load").length, 1);
});

test("a stale reload after an editing state and before Send keeps the newer editing view", async () => {
  const archive = fakeArchive();
  const s = await mount({ archive });
  s.ready("left");
  await s.controller.toggleKeeper("left", "hero");
  assert.equal(s.controller.getState().view.revision, 2);
  s.transport.load = () => Promise.resolve({ view: viewAt(1) });
  await s.controller.load();
  assert.equal(s.controller.getState().view.revision, 2);
  assert.equal(s.lastState("left").components.find((c) => c.id === "hero").keeper, true);
  // The next action uses the newest known revision.
  await s.controller.toggleKeeper("left", "hero");
  assert.equal(s.transport.calls.at(-1).request.expectedRevision, 2);
  assert.equal(s.controller.getState().view.revision, 3);
});

test("overlapping reloads: a late older answer never replaces a newer one", async () => {
  const archive = fakeArchive(viewAt(3));
  const transport = scriptedTransport(archive);
  const s = await mount({ transport, archive });
  assert.equal(s.controller.getState().view.revision, 3);
  // Newer answer first, then the earlier request answers late with an older view.
  const first = s.controller.load();
  const second = s.controller.load();
  const [a, b] = transport.loads.slice(-2);
  b.resolve(viewAt(4));
  await second;
  a.resolve(viewAt(2));
  await first;
  let state = s.controller.getState();
  assert.equal(state.view.revision, 4);
  assert.equal(state.status, "ready");
  assert.equal(state.loadError, null, "a superseded answer is ignored, not reported");
  // Older answer last even though it was the first to be requested and the sent lock holds.
  const sent = viewAt(5, { status: "sent", delivery: { batchId: "batch-1", acknowledged: false } });
  const third = s.controller.load();
  const fourth = s.controller.load();
  const [c, d] = transport.loads.slice(-2);
  d.resolve(sent);
  await fourth;
  c.resolve(viewAt(4));
  await third;
  state = s.controller.getState();
  assert.equal(state.view.revision, 5);
  assert.equal(state.readOnly, true);
  assert.equal(state.canMutate, false);
});

test("a late reload answer cannot end a save that started after a newer reload", async () => {
  const archive = fakeArchive(viewAt(3));
  const transport = scriptedTransport(archive);
  const s = await mount({ transport, archive });
  const first = s.controller.load();
  const second = s.controller.load();
  const [a, b] = transport.loads.slice(-2);
  b.resolve(viewAt(3));
  await second;
  const saving = s.controller.toggleKeeper("left", "hero");
  assert.equal(s.controller.getState().status, "saving");
  const pending = s.controller.getState().pending;
  a.resolve(viewAt(3));
  await first;
  assert.equal(s.controller.getState().status, "saving", "the late load does not change the pending save");
  assert.equal(s.controller.getState().pending, pending);
  assert.equal(s.$("statusText").textContent, "Saving…");
  transport.calls.at(-1).ok();
  await saving;
  assert.equal(s.controller.getState().view.revision, 4);
  assert.equal(s.controller.getState().status, "ready");
});

test("a stale reload keeps an uncertain request, its draft, and Retry identity", async () => {
  const archive = fakeArchive(viewAt(3));
  const transport = scriptedTransport(archive);
  const s = await mount({ transport, archive });
  s.ready("left");
  const popup = await typeFeedback(s, "left", "hero", "Too tall.");
  popup.withFeedback.click();
  const original = transport.calls.at(-1);
  assert.equal(original.op, "act");
  original.fail(lost());
  await flush();
  assert.equal(s.controller.getState().unresolved, true);
  // Reload answers with an older saved view.
  const reload = s.controller.load();
  transport.loads.at(-1).resolve(viewAt(2));
  await reload;
  const state = s.controller.getState();
  assert.equal(state.view.revision, 3);
  assert.equal(state.unresolved, true);
  assert.equal(state.failure.request, original.request);
  assert.equal(state.loadError.code, "STALE_VIEW");
  assert.equal(s.controller.getDraft("left", "hero"), "Too tall.");
  assert.equal(s.$("alertRetry").hidden, false);
  assert.match(s.$("alertText").textContent, /^Refresh failed: .*revision 2, older than revision 3 on screen\. The answer was not applied\. The last saved state stays on screen\. \S/, "both the stale refresh and the unconfirmed request are reported");
  assert.equal(s.$("statusText").textContent, "Save not confirmed");
  assert.equal((await s.controller.toggleKeeper("left", "nav")).refused, "busy");
  s.$("alertRetry").click();
  const retry = transport.calls.at(-1);
  assert.equal(retry.request, original.request, "Retry sends the identical request");
  retry.ok();
  await flush();
  assert.equal(s.controller.getState().unresolved, false);
  assert.equal(s.controller.getState().view.revision, 4);
});
