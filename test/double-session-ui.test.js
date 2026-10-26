import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fixture, listen, request } from "./double-fixtures.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { CHANNEL } from "../src/double.js";
import { bootDoubleSession } from "../src/double-session-shell.js";

const route = (id = "session", suffix = "") => `/api/double/sessions/${encodeDoubleComparisonId(id)}${suffix}`;
const BROWSER_ROUTE = /^\/api\/double\/sessions\/~[^/]+(?:\/(?:actions|next|end|retry))?$/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSession(s, f, sessionId = "session") {
  const created = await s.api("/api/double/sessions", { method: "POST", body: { sessionId, brief: "Keep the keepers. Try a new challenger.", manifest: f.manifest } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  return created.json;
}

/**
 * Boot the real session shell from the server's page against the real
 * loopback API. Refresh timers run only on tick(). A fault can fail a request
 * before it reaches the server, or lose the answer after the server saved it.
 */
async function boot(t, s, shellPath) {
  const base = `http://127.0.0.1:${s.port}`;
  const page = await request(s.port, shellPath);
  assert.equal(page.status, 200);
  const dom = new JSDOM(page.text, { url: base + shellPath });
  const win = dom.window;
  const calls = [];
  const faults = [];
  let inflight = 0;
  const fetchImpl = async (url, init) => {
    const call = { path: url.slice(base.length), method: init.method, body: init.body };
    calls.push(call);
    const index = faults.findIndex((fault) => fault.match(call));
    const fault = index >= 0 ? faults.splice(index, 1)[0] : null;
    inflight += 1;
    try {
      if (fault?.mode === "before") throw new TypeError("offline");
      const res = await fetch(url, init);
      if (fault?.mode === "after") {
        await res.arrayBuffer();
        throw new TypeError("connection lost after the answer");
      }
      return res;
    } finally {
      inflight -= 1;
    }
  };
  let pending = [];
  const timers = {
    setTimeout(fn) { const id = Symbol("timer"); pending.push({ id, fn }); return id; },
    clearTimeout(id) { pending = pending.filter((entry) => entry.id !== id); },
  };
  const shell = bootDoubleSession(win, { fetch: fetchImpl, base, timers });
  t.after(() => { shell.close(); win.close(); });
  const $ = (id) => win.document.getElementById(id);
  async function settle() {
    for (let i = 0; i < 600; i++) {
      await wait(3);
      const { status } = shell.controller.getState();
      if (inflight === 0 && !["loading", "saving", "submitting"].includes(status)) return;
    }
    assert.fail("the session page did not settle");
  }
  const row = (pane, id) => [...$(`controls-list-${pane}`).querySelectorAll(".control-row")].find((r) => r.dataset.componentId === id);
  const api = {
    win, $, shell, calls, faults, settle,
    get controller() { return shell.controller; },
    get timerCount() { return pending.length; },
    async tick() {
      const due = pending;
      pending = [];
      for (const entry of due) entry.fn();
      await settle();
    },
    keep: (pane, id) => row(pane, id).querySelector(".control-keep"),
    del: (pane, id) => row(pane, id).querySelector(".control-delete"),
    choose(pane) {
      const input = win.document.querySelector(`input[name="endPane"][value="${pane}"]`);
      input.checked = true;
      input.dispatchEvent(new win.Event("change"));
    },
    frame: (pane) => $(`frame-${pane}`),
    fromFrame(pane, data, source = $(`frame-${pane}`).contentWindow) {
      win.dispatchEvent(new win.MessageEvent("message", { data: { channel: CHANNEL, pane, instance: "a1a1a1a1", ...data }, origin: "null", source }));
    },
    posts: (op) => calls.filter((c) => c.method === "POST" && c.path.endsWith(`/${op}`)),
  };
  await settle();
  return api;
}

const saved = async (s, id = "session") => (await s.api(route(id))).json.view;

test("three frame clicks keep, discard, and clear exactly once through lost-response retry", async (t) => {
  const f = await fixture(t, "cycle-round");
  const s = await listen(t, f);
  const created = await createSession(s, f);
  const page = await boot(t, s, created.path);
  page.fromFrame("left", { type: "ready", comparisonId: "cycle-round" });
  // A session frame cannot use the one-shot keeper and delete intents.
  for (const intent of ["keeper", "delete"]) page.fromFrame("left", { type: "intent", comparisonId: "cycle-round", intent, componentId: "hero" });
  await page.settle();
  assert.equal(page.posts("actions").length, 0);
  assert.equal(page.win.document.querySelector(".double-popup"), null);
  const click = () => page.fromFrame("left", { type: "intent", comparisonId: "cycle-round", intent: "cycle", componentId: "hero" });
  click(); await page.settle();
  assert.equal((await saved(s)).comparison.panes.left.components[0].keeper, true);
  click(); await page.settle();
  assert.equal((await saved(s)).comparison.panes.left.components[0].deleted, true);
  page.faults.push({ match: (c) => c.path.endsWith("/actions"), mode: "after" });
  click(); await page.settle();
  const wire = page.posts("actions").at(-1).body;
  assert.equal(JSON.parse(wire).action.kind, "clear");
  click(); await page.settle();
  assert.equal(page.posts("actions").at(-1).body, wire, "an unresolved click cannot start another cycle");
  page.$("alertRetry").click(); await page.settle();
  assert.equal(page.posts("actions").at(-1).body, wire);
  const component = (await saved(s)).comparison.panes.left.components[0];
  assert.equal(component.deleted, false);
  assert.equal(component.keeper, false, "third click clears instead of restoring the earlier keeper");
  await f.unchanged(assert);
});

test("hover passes only from the ready frame of its pane, and hover-end goes only to the frame that holds it", async (t) => {
  const f = await fixture(t, "hover-round");
  const s = await listen(t, f);
  const created = await createSession(s, f);
  const page = await boot(t, s, created.path);
  const ended = { left: 0, right: 0 };
  for (const pane of ["left", "right"]) {
    const frameWindow = page.frame(pane).contentWindow;
    const post = frameWindow.postMessage.bind(frameWindow);
    frameWindow.postMessage = (data, ...rest) => (data?.type === "hover-end" ? ended[pane] += 1 : post(data, ...rest));
    page.fromFrame(pane, { type: "ready", comparisonId: "hover-round" });
  }
  const hover = (pane, extra = {}, source) => page.fromFrame(pane, { type: "hover", comparisonId: "hover-round", ...extra }, source);
  const shellMove = () => page.$("summary").dispatchEvent(new page.win.MouseEvent("mousemove", { bubbles: true }));
  hover("left", {}, page.frame("right").contentWindow);
  hover("left", { instance: "b2b2b2b2" });
  hover("left", { componentId: "hero" });
  shellMove();
  assert.deepEqual(ended, { left: 0, right: 0 }, "a hover from the other pane, a stale instance, or with extra keys is ignored");
  hover("left");
  shellMove();
  shellMove();
  assert.deepEqual(ended, { left: 1, right: 0 }, "hover-end goes once, only to the frame that holds the hover");
  hover("right");
  hover("left");
  assert.deepEqual(ended, { left: 1, right: 1 }, "a hover in one frame ends the hover of the other");
  shellMove();
  assert.deepEqual(ended, { left: 2, right: 1 });
  assert.equal(page.posts("actions").length, 0, "hover saves nothing");
});

test("component and overall comments preserve keepers, survive lost receipts, and reach Next Round and Done", async (t) => {
  const f = await fixture(t, "comment-round");
  const s = await listen(t, f);
  const created = await createSession(s, f);
  const page = await boot(t, s, created.path);
  page.keep("left", "hero").click();
  await page.settle();
  const row = page.$("controls-list-left").querySelector('[data-component-id="hero"]');
  const details = row.querySelector(".component-comment");
  assert.ok(details.closest(".double-rail"), "every component editor lives in the right column");
  details.open = true;
  const textarea = details.querySelector("textarea");
  textarea.value = "Keep the wording; make this shorter.";
  textarea.dispatchEvent(new page.win.Event("input"));
  details.open = false;
  assert.equal(page.$("next").disabled, true, "folding does not discard a draft");
  details.open = true;
  page.faults.push({ match: (c) => c.path.endsWith("/actions"), mode: "after" });
  details.querySelector(".comment-save").click();
  await page.settle();
  assert.equal(page.controller.getState().unresolved, true);
  const first = page.posts("actions").at(-1).body;
  page.$("alertRetry").click();
  await page.settle();
  assert.equal(page.posts("actions").at(-1).body, first, "uncertain receipt retries the identical comment action");
  let view = await saved(s);
  assert.equal(view.comparison.panes.left.components[0].keeper, true);
  assert.equal(view.comparison.panes.left.components[0].deleted, false);
  assert.equal(view.comparison.comments.length, 1);
  assert.equal(page.controller.getState().unsavedDrafts.length, 0);
  assert.equal(textarea.value, "", "exact retry clears the saved draft");
  assert.equal(details.open, true, "saving preserves the owner's fold state");
  page.del("left", "hero").click();
  await page.settle();
  assert.equal(row.dataset.selection, "discard");
  assert.equal(details.open, true, "discarding does not replace the comment field");
  page.del("left", "hero").click();
  await page.settle();
  assert.equal(row.dataset.selection, "keep", "Undo restores the previous keeper");
  const overall = page.$("overallComment");
  overall.value = "Use Next instead of Open.";
  overall.dispatchEvent(new page.win.Event("input"));
  assert.equal(page.$("next").disabled, true, "unsubmitted draft cannot silently disappear");
  assert.equal(page.$("endOpen").disabled, true);
  page.$("saveOverallComment").click();
  await page.settle();
  assert.equal(overall.value, "");
  assert.equal(page.$("next").disabled, false);
  assert.match(page.$("history").textContent, /Use Next instead of Open/);
  page.$("next").click();
  await page.settle();
  const events = (await s.api(route("session", "/events"))).json;
  assert.deepEqual(events.events[0].payload.batch.payload.feedback.map((entry) => entry.comment), [
    "Keep the wording; make this shorter.", "Use Next instead of Open.",
  ]);
  page.$("endOpen").click();
  page.choose("left");
  page.$("endConfirm").click();
  await page.settle();
  const output = (await s.api(route("session", "/output"))).json;
  assert.equal(output.page.pane, "left");
  assert.deepEqual(output.page.deletedComponentIds, []);
  assert.deepEqual(output.history[0].payload.feedback, events.events[0].payload.batch.payload.feedback);
  await f.unchanged(assert);
});

test("Next freezes the pair; a refreshed new pair replaces both frames and bridges, and old frames cannot write", async (t) => {
  const f = await fixture(t, "round-1");
  const next = await fixture(t, "round-2");
  const s = await listen(t, f);
  const created = await createSession(s, f);
  const page = await boot(t, s, created.path);
  const { $ } = page;
  const shellUrl = page.win.location.href;
  assert.equal($("title").textContent, "Two proposals");
  assert.match($("sessionState").textContent, /Round 1 · Editing/);
  assert.equal(page.timerCount, 0, "no refresh while editing");

  page.keep("left", "hero").click();
  await page.settle();
  assert.equal(page.keep("left", "hero").getAttribute("aria-pressed"), "true");

  // Typed but unsaved feedback blocks submission at once instead of being dropped; clearing it releases Next.
  const comments = page.$("controls-list-right").querySelector('[data-component-id="footer"] .component-comment');
  comments.open = true;
  const textarea = comments.querySelector("textarea");
  const type = (text) => {
    textarea.value = text;
    textarea.dispatchEvent(new page.win.Event("input"));
  };
  textarea.focus();
  type("Footer is too loud");
  assert.equal($("draftNote").hidden, false);
  assert.match($("draftNote").textContent, /Right · Footer/);
  assert.equal($("next").disabled, true);
  assert.equal($("endOpen").disabled, true);
  assert.equal(page.win.document.activeElement, textarea, "typing keeps the field and its focus");
  type("");
  assert.equal($("draftNote").hidden, true);
  assert.equal($("next").disabled, false);
  assert.equal($("endOpen").disabled, false);
  type("Footer is too loud");
  comments.open = false;
  assert.equal($("next").disabled, true);
  assert.deepEqual(await page.controller.next(), { ok: false, refused: "unsaved-feedback" });
  page.keep("left", "footer").click();
  await page.settle();
  page.del("right", "footer").click();
  await page.settle();
  assert.equal($("next").disabled, true, "discarding a component keeps its unsaved comment barrier");
  comments.open = true;
  assert.equal(textarea.value, "Footer is too loud");
  comments.querySelector(".comment-save").click();
  await page.settle();
  assert.equal((await saved(s)).comparison.panes.right.components.find((c) => c.id === "footer").deleted, true, "commenting on a discarded item preserves the discard");
  assert.equal($("draftNote").hidden, true);
  assert.equal($("next").disabled, false);

  $("next").click();
  await page.settle();
  let view = await saved(s);
  assert.equal(view.status, "generating");
  assert.equal(view.comparison.status, "sent");
  assert.equal(page.posts("next").length, 1);
  const batch = (await s.api(route("session", "/events"))).json.events[0].payload.batch.payload;
  assert.equal(batch.keepers.length, 2);
  assert.equal(batch.feedback[0].comment, "Footer is too loud");
  assert.equal($("next").hidden, true);
  assert.equal(page.keep("left", "hero").disabled, true, "the submitted pair stays read-only");
  assert.match($("sessionNote").textContent, /cannot confirm that the chat received/);

  // A failed background read keeps the pair and its state on screen.
  const oldLeft = page.frame("left");
  const oldWindows = { left: oldLeft.contentWindow, right: page.frame("right").contentWindow };
  const oldSrc = oldLeft.getAttribute("src");
  const oldFacade = page.shell.pair.facade;
  page.faults.push({ match: (c) => c.method === "GET", mode: "before" });
  await page.tick();
  assert.match($("alertText").textContent, /Refresh failed/);
  assert.equal(page.frame("left"), oldLeft);
  assert.equal(page.keep("left", "hero").getAttribute("aria-pressed"), "true");
  assert.equal(page.timerCount, 1, "the refresh continues after a failure");

  // Reload restores the saved state and the same submitted pair.
  const reloaded = await boot(t, s, created.path);
  assert.equal(reloaded.shell.pair.comparisonId, "round-1");
  assert.match(reloaded.$("sessionState").textContent, /Generating/);
  reloaded.shell.close();

  const sent = (await s.api(route("session", "/events"))).json.events[0].payload;
  const attached = await s.api(route("session", "/attach"), { method: "POST", body: { actionId: "attach-2", requestId: sent.requestId, attemptId: sent.attemptId, manifest: next.manifest } });
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  await page.tick();
  assert.equal(page.shell.pair.comparisonId, "round-2");
  assert.equal(page.win.location.href, shellUrl, "the shell URL stays the same");
  assert.equal($("alert").hidden, true);
  assert.notEqual(page.frame("left"), oldLeft);
  assert.notEqual(page.frame("left").getAttribute("src"), oldSrc);
  assert.equal(page.frame("left").getAttribute("src"), attached.json.view.comparison.panes.left.frameUrl);
  assert.equal(page.keep("left", "hero").getAttribute("aria-pressed"), "false", "a new pair starts without keepers");
  assert.equal(page.keep("left", "hero").disabled, false);
  assert.equal(page.timerCount, 0, "refresh stops once the pair is editable");

  // Retired frames and the retired facade cannot change the new round.
  const before = page.calls.length;
  for (const comparisonId of ["round-1", "round-2"]) {
    page.fromFrame("left", { type: "ready", comparisonId }, oldWindows.left);
    page.fromFrame("left", { type: "intent", comparisonId, intent: "cycle", componentId: "hero" }, oldWindows.left);
  }
  assert.deepEqual(await oldFacade.toggleKeeper("left", "hero"), { ok: false, refused: "unknown" });
  await page.settle();
  assert.equal(page.calls.length, before);
  // The new frame's bridge works with the raw new comparison ID.
  page.fromFrame("left", { type: "ready", comparisonId: "round-2" });
  page.fromFrame("left", { type: "intent", comparisonId: "round-2", intent: "cycle", componentId: "hero" });
  await page.settle();
  const act = JSON.parse(page.posts("actions").at(-1).body);
  assert.equal(act.comparisonId, "round-2");
  view = await saved(s);
  assert.equal(view.comparison.panes.left.components.find((c) => c.id === "hero").keeper, true);
  assert.ok(page.calls.every((c) => BROWSER_ROUTE.test(c.path)), "the page uses only browser session routes");

  // An idle editing page closes; its retained Delete control opens no popup and saves nothing.
  const idle = await boot(t, s, created.path);
  const idleDelete = idle.del("left", "footer");
  assert.equal(idleDelete.disabled, false);
  idle.shell.close();
  idleDelete.click();
  await idle.settle();
  assert.equal(idle.win.document.querySelector(".double-popup"), null);
  assert.equal((await saved(s)).revision, view.revision);

  // A request sent before close still commits on the server, but its answer revives nothing.
  const retained = page.shell.pair.facade;
  page.keep("left", "footer").click();
  page.shell.close();
  page.shell.close();
  await page.settle();
  view = await saved(s);
  assert.equal(view.comparison.panes.left.components.find((c) => c.id === "footer").keeper, true);
  assert.equal(page.keep("left", "footer").getAttribute("aria-pressed"), "false", "the closed page is not updated");
  assert.equal(page.timerCount, 0);
  // Retained facades, controller calls, and controls cannot operate the session after close.
  for (const outcome of await Promise.all([
    retained.toggleKeeper("left", "hero"), retained.load(), oldFacade.load(),
    page.controller.next(), page.controller.act({ kind: "delete", pane: "right", componentId: "hero" }),
  ])) assert.ok(!outcome || outcome.ok === false);
  for (const id of ["next", "endOpen", "alertReload", "alertRetry"]) $(id).click();
  page.keep("left", "hero").click();
  page.fromFrame("left", { type: "intent", comparisonId: "round-2", intent: "cycle", componentId: "hero" });
  await page.settle();
  assert.equal((await saved(s)).revision, view.revision);
  await f.unchanged(assert);
  await next.unchanged(assert);
});

test("failed generation offers browser Retry; End during generation refuses an unseen pair and stays terminal", async (t) => {
  const f = await fixture(t, "round-1");
  const next = await fixture(t, "round-2");
  const s = await listen(t, f);
  const created = await createSession(s, f);
  const page = await boot(t, s, created.path);
  const { $ } = page;
  $("next").click();
  await page.settle();
  let view = await saved(s);
  const failed = await s.api(route("session", "/fail"), { method: "POST", body: { actionId: "fail-1", requestId: view.generation.requestId, attemptId: view.generation.attempt.id, message: "<b>Worker stopped</b>" } });
  assert.equal(failed.status, 200);
  await page.tick();
  assert.match($("sessionState").textContent, /Generation failed/);
  assert.match($("sessionNote").textContent, /<b>Worker stopped<\/b>/, "failure text is shown as text");
  assert.equal($("sessionNote").querySelector("b"), null);
  assert.equal($("retryGeneration").hidden, false);
  assert.equal(page.timerCount, 0, "no refresh while the owner decides");

  $("retryGeneration").click();
  await page.settle();
  const retry = JSON.parse(page.posts("retry")[0].body);
  view = failed.json.view;
  assert.deepEqual({ ...retry, actionId: "x" }, { actionId: "x", expectedRevision: view.revision, requestId: view.generation.requestId, attemptId: view.generation.attempt.id });
  view = await saved(s);
  assert.equal(view.status, "generating");
  assert.equal(view.generation.attempt.status, "running");

  // End needs an explicit side; nothing is preselected.
  $("endOpen").click();
  assert.equal($("endPanel").hidden, false);
  assert.equal($("endConfirm").disabled, true);
  assert.ok([...page.win.document.querySelectorAll('input[name="endPane"]')].every((input) => !input.checked));
  page.choose("right");
  assert.equal($("endConfirm").disabled, false);

  // A new pair arrives before the confirmation reaches the server.
  const attached = await s.api(route("session", "/attach"), { method: "POST", body: { actionId: "attach", requestId: view.generation.requestId, attemptId: view.generation.attempt.id, manifest: next.manifest } });
  assert.equal(attached.status, 200);
  $("endConfirm").click();
  await page.settle();
  view = await saved(s);
  assert.equal(view.status, "editing", "the unseen pair is never chosen");
  assert.equal(page.shell.pair.comparisonId, "round-2");
  assert.equal($("endNotice").hidden, false);
  assert.ok([...page.win.document.querySelectorAll('input[name="endPane"]')].every((input) => !input.checked));
  assert.equal($("endConfirm").disabled, true);
  assert.equal(page.controller.getState().failure?.op, "end");

  // Another authorized tab changes the same pair. A read clears the choice instead of moving it to the new revision.
  const token = page.win.document.body.dataset.token;
  const otherTab = async (actionId, action) => {
    const current = await saved(s);
    const res = await s.api(route("session", "/actions"), { method: "POST", token, body: { actionId, expectedRevision: current.revision, comparisonId: "round-2", action } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  };
  page.choose("left");
  await otherTab("other-1", { kind: "keeper", pane: "right", componentId: "hero", selected: true });
  await page.controller.load();
  assert.ok([...page.win.document.querySelectorAll('input[name="endPane"]')].every((input) => !input.checked));
  assert.equal($("endConfirm").disabled, true);

  // A change the page has not read: End refuses the changed same-ID pair and asks for a new choice.
  page.choose("left");
  await otherTab("other-2", { kind: "delete", pane: "left", componentId: "hero" });
  $("endConfirm").click();
  await page.settle();
  assert.equal((await saved(s)).status, "editing", "changed content is never chosen unseen");
  assert.ok([...page.win.document.querySelectorAll('input[name="endPane"]')].every((input) => !input.checked));
  assert.equal($("endConfirm").disabled, true);
  $("endConfirm").click();
  await page.settle();
  assert.equal((await saved(s)).status, "editing");

  page.choose("left");
  $("endConfirm").click();
  await page.settle();
  view = await saved(s);
  assert.deepEqual(view.final, { comparisonId: "round-2", pane: "left", deletedComponentIds: ["hero"] });
  assert.match($("sessionState").textContent, /Ended/);
  assert.match($("sessionNote").textContent, /Left page \(Proposal left\)/);
  assert.equal($("endPanel").hidden, true);
  assert.equal($("endOpen").hidden, true);
  assert.equal($("next").hidden, true);
  assert.equal(page.keep("left", "footer").disabled, true);
  assert.equal($("sessionAlert").hidden, true);

  // Late agent work cannot replace the terminal result.
  const late = await s.api(route("session", "/fail"), { method: "POST", body: { actionId: "late", requestId: view.generation.requestId, attemptId: view.generation.attempt.id, message: "late" } });
  assert.equal(late.status, 409);
  await page.controller.load();
  assert.match($("sessionState").textContent, /Ended/);
  assert.equal(page.shell.pair.comparisonId, "round-2");
  await f.unchanged(assert);
  await next.unchanged(assert);
});

test("a lost End answer stays unresolved after a refresh until the exact request returns its receipt", async (t) => {
  const f = await fixture(t, "round-1");
  const s = await listen(t, f);
  const created = await createSession(s, f);
  const page = await boot(t, s, created.path);
  const { $ } = page;
  page.keep("right", "hero").click();
  await page.settle();
  $("endOpen").click();
  page.choose("right");
  page.faults.push({ match: (c) => c.path.endsWith("/end"), mode: "after" });
  $("endConfirm").click();
  await page.settle();
  assert.equal((await saved(s)).status, "ended", "the server saved End");
  let state = page.controller.getState();
  assert.equal(state.unresolved, true);
  assert.equal($("sessionRetry").hidden, false);
  assert.equal($("sessionDismiss").hidden, true);

  // The saved view alone is not the receipt.
  await page.controller.load();
  state = page.controller.getState();
  assert.equal(state.view.status, "ended");
  assert.equal(state.unresolved, true);
  assert.equal($("sessionAlert").hidden, false);

  $("sessionRetry").click();
  await page.settle();
  const ends = page.posts("end");
  assert.equal(ends.length, 2);
  assert.equal(ends[1].body, ends[0].body, "Retry resends the exact request");
  assert.equal(page.controller.getState().unresolved, false);
  assert.equal($("sessionAlert").hidden, true);
  const events = (await s.api(route("session", "/events"))).json.events;
  assert.equal(events.filter((e) => e.kind === "final").length, 1);
  await f.unchanged(assert);
});

test("the session page is an escaped shell without inline script, view data, or frame authority", async (t) => {
  const f = await fixture(t, "pair");
  const s = await listen(t, f);
  const sessionId = `x"><script>alert(1)</script>&'`;
  const created = await createSession(s, f, sessionId);
  const page = await request(s.port, created.path);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.match(page.headers["content-security-policy"], /script-src 'self';/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.ok(!page.text.includes("<script>alert"));
  assert.ok(!page.text.includes("currentComparisonId"));
  assert.doesNotMatch(page.headers["content-security-policy"], /script-src[^;]*unsafe-inline/);
  const dom = new JSDOM(page.text);
  // No executable inline bootstrap: every script is an external module that the server serves.
  const scripts = [...dom.window.document.querySelectorAll("script")];
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.equal(script.textContent.trim(), "");
    assert.equal(script.getAttribute("type"), "module");
    const loaded = await request(s.port, new URL(script.getAttribute("src"), `http://127.0.0.1:${s.port}${created.path}`).pathname);
    assert.equal(loaded.status, 200);
    assert.match(loaded.headers["content-type"], /javascript/);
  }
  assert.ok([...dom.window.document.querySelectorAll("*")].every((node) => ![...node.attributes].some((a) => /^on/i.test(a.name))), "no inline event handlers");
  assert.equal(dom.window.document.body.dataset.session, sessionId);
  const token = dom.window.document.body.dataset.token;
  assert.notEqual(token, s.token);
  for (const frame of dom.window.document.querySelectorAll("iframe")) assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  dom.window.close();
  assert.equal((await request(s.port, created.path, { method: "POST" })).status, 405);

  const booted = await boot(t, s, created.path);
  assert.equal(booted.$("pane-name-left").textContent, "Proposal left");
  assert.equal(booted.calls[0].path, route(sessionId));
  const frame = await request(s.port, booted.frame("left").getAttribute("src"));
  assert.equal(frame.status, 200);
  assert.ok(!frame.text.includes(token), "frames never receive the browser token");
  assert.ok(!frame.text.includes(encodeDoubleComparisonId(sessionId)), "frames never receive the session identity");
  // The browser token reaches no agent-only session operation.
  for (const op of ["events", "output"]) assert.equal((await s.api(route(sessionId, `/${op}`), { token })).status, 403);
  await f.unchanged(assert);
});
