import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import path from "node:path";
import { JSDOM } from "jsdom";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, listen, request } from "./double-fixtures.js";
import { candidate, coinflip, croute } from "./coinflip-fixtures.js";
import { bootSharedGui } from "../src/shared-gui-shell.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import fs from "node:fs/promises";
import { mountCoinflip } from "../src/coinflip-shell.js";
import { COINFLIP_GENERATION_WORKFLOW } from "../src/coinflip-chat.js";
import { GENERATION_WORKFLOW } from "../src/double-session-chat.js";
import { CHALLENGER_INSTRUCTION, STEERS_STILL_APPLY } from "../src/coinflip-store.js";
import { STEER_TOTAL_BYTES, steerProblem } from "../src/steer-limits.js";
import { CoinflipStore } from "../src/coinflip-store.js";
import { DoubleSessionStore } from "../src/double-session.js";

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail("Steering state did not settle");
}
// The real shared shell in jsdom against the authenticated server; `lose` drops the answer of one saved POST.
async function page(t, s, shellPath, { storage = [], lose = null } = {}) {
  const base = `http://127.0.0.1:${s.port}`;
  const dom = new JSDOM((await request(s.port, shellPath)).text, { url: base + shellPath });
  for (const [key, value] of storage) dom.window.localStorage.setItem(key, value);
  const posts = [];
  const shell = bootSharedGui(dom.window, { base, refreshMs: 30, fetch: async (url, init) => {
    if (init.method === "POST") posts.push(url.split("/").at(-1));
    const answer = await fetch(url, init);
    if (lose && url.endsWith(`/${lose}`)) { lose = null; await answer.arrayBuffer(); throw new TypeError("Lost response"); }
    return answer;
  } });
  const close = () => { shell.close(); dom.window.close(); };
  t.after(close);
  await until(() => shell.state);
  const $ = (id) => dom.window.document.getElementById(id);
  const type = (text) => { $("brief").value = text; $("brief").dispatchEvent(new dom.window.Event("input")); };
  return { shell, posts, close, $, type, win: dom.window,
    storage: () => Object.keys(dom.window.localStorage).map((key) => [key, dom.window.localStorage.getItem(key)]) };
}
const root = (id) => `/api/double/sessions/${encodeDoubleComparisonId(id)}`;
const generations = async (s, route) => (await s.api(route + "/events")).json.events.filter((e) => e.kind === "generation");
const origin = (f) => ({ piSessionId: "steer-origin", piSessionFile: path.join(f.root, "pi.jsonl") });

test("Double Send instruction carries keepers, deletions and saved feedback, keeps the prior pair and End during generation, and keeps drafts while disconnected", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const post = (route, body) => s.api(route, { method: "POST", body });
  const bound = (await post("/api/double/gui/connect", origin(f))).json;
  const p = await page(t, s, bound.path);
  p.type("A landing page");
  p.$("startDouble").click();
  await until(() => p.shell.state.view?.status === "generating");
  await until(() => !p.$("steerSend").hidden);
  assert.equal(p.$("steerSend").disabled, true, "Send is disabled before the first pair");
  const id = p.shell.state.currentSessionId, r = root(id);
  const attach = async (comparisonId) => {
    const event = (await generations(s, r)).at(-1);
    const answer = await post(r + "/attach", { actionId: `attach-${comparisonId}`, requestId: event.payload.requestId,
      attemptId: event.payload.attemptId, manifest: { ...f.manifest, comparisonId } });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    return event;
  };
  await attach("round-1");
  await until(() => p.shell.pair?.controller.getState().view?.status === "editing");
  const c = p.shell.pair.controller;
  assert.equal((await c.act({ kind: "keeper", pane: "left", componentId: "hero", selected: true })).ok, true);
  assert.equal((await c.act({ kind: "delete", pane: "right", componentId: "footer" })).ok, true);
  assert.equal((await c.act({ kind: "round-comment", feedback: "Warmer colours" })).ok, true);
  assert.equal(p.$("briefLabel").textContent, "Instruction for the next pair");

  // Unsaved feedback text blocks Send, as it blocks Next Round.
  c.setDraft("round-1", "", "", "Not saved yet");
  p.type("Make the hero taller");
  await until(() => p.$("steerSend").disabled);
  c.setDraft("round-1", "", "", "");
  await until(() => !p.$("steerSend").disabled);

  // The agent and a stale view cannot steer; one click saves the instruction and requests the round.
  const v = c.getState().view;
  assert.equal((await post(r + "/steer", { actionId: "agent", expectedRevision: v.revision, comparisonId: v.currentComparisonId, instruction: "x" })).json.error.code, "FORBIDDEN");
  p.$("steerSend").click();
  await until(() => p.shell.state.view?.status === "generating" && p.$("brief").value === "");
  assert.deepEqual(p.posts.filter((op) => !["draft", "actions"].includes(op)), ["start", "steer"]);
  const [, steered] = await generations(s, r);
  assert.equal(steered.payload.steer.text, "Make the hero taller");
  assert.deepEqual(steered.payload.steers.map((x) => x.text), ["Make the hero taller"]);
  assert.equal(steered.payload.comparisonId, "round-1");
  assert.deepEqual(steered.payload.batch.payload.keepers.map((k) => [k.identity.pane, k.identity.componentId]), [["left", "hero"]]);
  assert.deepEqual(steered.payload.batch.payload.plainDeletions.map((k) => [k.identity.pane, k.identity.componentId]), [["right", "footer"]]);
  assert.deepEqual(steered.payload.batch.payload.feedback.map((x) => x.comment), ["Warmer colours"]);
  assert.equal(steered.payload.history.length, 1);
  const view = (await s.api(r)).json.view;
  assert.deepEqual(view.rounds[0].outcome, { kind: "steer", batchId: steered.payload.batch.id, instruction: "Make the hero taller" });
  const stale = await request(s.port, r + "/steer", { token: /data-token="([0-9a-f]{64})"/.exec((await request(s.port, bound.path)).text)[1],
    method: "POST", body: { actionId: "stale", expectedRevision: v.revision, comparisonId: v.currentComparisonId, instruction: "Again" } });
  assert.equal(stale.json.error.code, "STALE_REVISION", "no queued second instruction");

  // During generation the prompt stays editable, Send is disabled, the prior pair stays, and Done stays available.
  p.type("Next idea, typed while generating");
  await delay(80);
  assert.equal(p.$("brief").disabled, false);
  assert.equal(p.$("steerSend").disabled, true);
  assert.equal(p.$("endOpen").hidden, false);
  assert.equal(p.$("endOpen").disabled, false);
  assert.equal(p.shell.pair.controller.getState().view.currentComparisonId, "round-1");
  await until(async () => (await s.api("/api/double/gui")).json.draft === "Next idea, typed while generating");

  // Disconnected: the draft and saved work stay readable, Send stays refused, and reload submits nothing.
  await post("/api/double/gui/disconnect", { leaseId: bound.leaseId });
  const late = await post(r + "/attach", { actionId: "late", requestId: steered.payload.requestId, attemptId: steered.payload.attemptId,
    manifest: { ...f.manifest, comparisonId: "late" } });
  assert.equal(late.json.error.code, "DISCONNECTED", "no attachment while disconnected");
  const kept = p.storage();
  p.close();
  const q = await page(t, s, bound.path, { storage: kept });
  await until(() => q.shell.pair?.controller.getState().view?.status === "generating" && !q.shell.state.connection.connected);
  assert.equal(q.$("brief").value, "Next idea, typed while generating");
  assert.match(q.$("guiStatus").textContent, /Disconnected/);
  assert.equal(q.$("steerSend").disabled, true);
  await delay(100);
  assert.deepEqual(q.posts, [], "reload never resubmits");

  // Explicit reconnection to the same chat; the interrupted attempt needs recovery and Retry of the saved instruction.
  const again = (await post("/api/double/gui/connect", origin(f))).json;
  assert.equal(again.connection.origin.piSessionId, "steer-origin");
  const keptAgain = q.storage();
  q.close();
  const w = await page(t, s, again.path, { storage: keptAgain });
  await until(() => w.shell.state.recoveryRequired && !w.$("recoverGeneration").hidden);
  w.$("recoverGeneration").click();
  await until(() => !w.$("retryGeneration").hidden && !w.$("retryGeneration").disabled);
  assert.equal(w.$("steerSend").disabled, true, "a failed steer offers Retry or Done, not a new Send");
  w.$("retryGeneration").click();
  await until(async () => (await generations(s, r)).length === 3);
  const retried = (await generations(s, r)).at(-1);
  assert.equal(retried.payload.requestId, steered.payload.requestId);
  assert.equal(retried.payload.steer.text, "Make the hero taller");
  await attach("round-2");
  await until(() => w.shell.pair?.controller.getState().view?.currentComparisonId === "round-2" && !w.$("steerSend").disabled);

  // End keeps the explicit Done choice; the final output and event carry every instruction.
  const last = w.shell.pair.controller.getState().view;
  assert.equal((await w.shell.pair.controller.end("left", last.currentComparisonId, last.revision)).ok, true);
  const output = (await s.api(r + "/output")).json;
  assert.deepEqual(output.steers.map((x) => x.text), ["Make the hero taller"]);
  assert.equal(output.history.length, 2);
  await until(() => w.$("steerSend").hidden);
  await f.unchanged(assert);
});

test("an uncertain Send resolves to its saved request once: Double Retry and Coinflip Resolve after a reload", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const post = (route, body) => s.api(route, { method: "POST", body });
  const bound = (await post("/api/double/gui/connect", origin(f))).json;
  const start = (await post("/api/double/gui/start", { actionId: "double-start", mode: "double", brief: "Lost steer" })).json;
  const id = start.result.sessionId, r = root(id);
  const first = (await generations(s, r))[0];
  await post(r + "/attach", { actionId: "a1", requestId: first.payload.requestId, attemptId: first.payload.attemptId, manifest: { ...f.manifest, comparisonId: "round-1" } });

  const p = await page(t, s, bound.path, { lose: "steer" });
  await until(() => p.shell.pair?.controller.getState().view?.status === "editing");
  p.type("Bigger buttons");
  await until(() => !p.$("steerSend").disabled);
  p.$("steerSend").click();
  await until(() => !p.$("sessionAlert").hidden && !p.$("sessionRetry").hidden);
  assert.match(p.$("sessionAlertText").textContent, /Send instruction failed/);
  assert.equal(p.$("brief").value, "Bigger buttons", "an unconfirmed instruction stays in the prompt");
  assert.equal(p.$("startDouble").hidden, true);
  assert.equal(p.$("steerSend").disabled, true);
  const kept = p.storage();
  p.close();
  const q = await page(t, s, bound.path, { storage: kept });
  await until(() => !q.$("sessionRetry").hidden);
  await delay(100);
  assert.deepEqual(q.posts, [], "reload never resubmits");
  q.$("sessionRetry").click();
  await until(() => q.$("sessionAlert").hidden);
  assert.deepEqual(q.posts, ["steer"]);
  assert.equal((await generations(s, r)).length, 2, "one steered round only");
  const v = (await s.api(r)).json.view;
  await post(`${r}/fail`, { actionId: "f1", requestId: v.generation.requestId, attemptId: v.generation.attempt.id, message: "Model stopped" });
  await until(() => q.shell.state.view?.status === "failed");
  const latest = (await s.api(r)).json.view;
  const token = /data-token="([0-9a-f]{64})"/.exec((await request(s.port, bound.path)).text)[1];
  await request(s.port, r + "/end", { token, method: "POST", body: { actionId: "end", expectedRevision: latest.revision, comparisonId: "round-1", pane: "right" } });
  q.close();

  // Coinflip: the same rule through the panel's saved request.
  await post("/api/double/gui/disconnect", { leaseId: bound.leaseId });
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const cid = await c.start("A toggle switch");
  await c.attach(cid, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  const w = await page(t, s, c.connected.path, { lose: "steer" });
  await until(() => w.shell.mode("coinflip")?.view?.status === "choosing");
  assert.equal(w.$("steerSend").hidden, false);
  w.type("Try a pill shape");
  await until(() => !w.$("steerSend").disabled);
  w.$("steerSend").click();
  await until(() => !w.$("coinflipResolve").hidden && !w.$("coinflipResolve").disabled);
  assert.equal(w.$("steerSend").disabled, true);
  const keptCoinflip = w.storage();
  w.close();
  const x = await page(t, s, c.connected.path, { storage: keptCoinflip });
  await until(() => x.shell.state.view?.status === "generating" && !x.$("coinflipResolve").hidden);
  assert.equal(x.$("coinflipChoose-left").disabled, true);
  await delay(100);
  assert.deepEqual(x.posts, []);
  x.$("coinflipResolve").click();
  await until(() => x.$("coinflipResolve").hidden);
  assert.deepEqual(x.posts, ["steer"]);
  assert.match(x.$("coinflipStatus").textContent, /replacement pair/);
  const events = (await c.events(cid)).events.filter((e) => e.kind === "generation");
  assert.deepEqual(events.map((e) => e.payload.kind), ["initial", "steer"]);
  assert.equal((await c.view(cid)).choices.length, 0);

  // A Send for one mode never lands on a session of another mode.
  const guiToken = /data-token="([0-9a-f]{64})"/.exec((await request(s.port, c.connected.path)).text)[1];
  const cross = (route, body) => request(s.port, route, { token: guiToken, method: "POST", body });
  assert.equal((await cross(croute(id) + "/steer", { actionId: "cross-1", pairIndex: 0, instruction: "x" })).json.error.code, "NOT_FOUND");
  assert.equal((await cross(root(cid) + "/steer", { actionId: "cross-2", expectedRevision: 0, comparisonId: "round-1", instruction: "x" })).json.error.code, "NOT_FOUND");
});

test("Coinflip Send instruction from the prompt box: replacement pair, then a challenger beside the clicked winner; Training shows no steering", async (t) => {
  const f = await fixture(t), root = path.join(f.root, "trainer-root");
  const previous = process.env.HUMAN_REVIEW_TRAINER_ROOT;
  t.after(() => { if (previous === undefined) delete process.env.HUMAN_REVIEW_TRAINER_ROOT; else process.env.HUMAN_REVIEW_TRAINER_ROOT = previous; });
  const s = await listen(t, f, { HUMAN_REVIEW_TRAINER_ROOT: root });
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const p = await page(t, s, c.connected.path);
  p.win.document.querySelector('input[value="coinflip"]').click();
  p.type("A pricing card");
  p.$("startDouble").click();
  await until(() => p.shell.state.view?.mode === "coinflip");
  const id = p.shell.state.currentSessionId;
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  await until(() => !p.$("coinflipChoose-left").disabled);
  const old = p.shell.state.view.pair;
  assert.match(p.$("guiStatus").textContent, /Type a new instruction/, "the start brief is not an instruction");
  p.type("Use a dark theme");
  await until(() => !p.$("steerSend").disabled && /replaces both candidates/.test(p.$("guiStatus").textContent));
  p.$("steerSend").click();
  await until(() => p.shell.state.view?.status === "generating" && p.$("brief").value === "");
  assert.equal(p.$("coinflipChoose-left").disabled, true, "selection is disabled during generation");
  assert.equal(p.$("coinflipStop").disabled, false, "Stop stays available");
  assert.equal(p.shell.state.view.pair.left.candidateId, old.left.candidateId, "the prior pair stays visible");
  await c.attach(id, { left: await candidate(f, "c"), right: await candidate(f, "d") });
  await until(() => p.shell.state.view?.pairs === 2 && !p.$("coinflipChoose-right").disabled);
  assert.match(p.$("coinflipChoices").textContent, /pair replaced, no winner by instruction — Use a dark theme/);

  p.$("coinflipChoose-right").click();
  await until(() => p.shell.state.view?.status === "generating");
  const winner = (await c.generation(id)).payload.winner;
  await c.attach(id, { left: await candidate(f, "e"), right: winner.pane });
  await until(() => p.shell.state.view?.pairs === 3 && p.shell.state.view.status === "choosing");
  assert.match(p.$("guiStatus").textContent, /keeps the winner unchanged/);
  p.type("Larger price");
  await until(() => !p.$("steerSend").disabled);
  p.$("steerSend").click();
  await until(() => p.shell.state.view?.status === "generating");
  const event = await c.generation(id);
  assert.equal(event.payload.replaceSide, "left");
  assert.equal(event.payload.winner.candidateId, winner.candidateId);
  assert.match(p.$("coinflipStatus").textContent, /one challenger for the left side/);
  await c.attach(id, { left: await candidate(f, "g"), right: winner.pane }, { event });
  await until(() => p.shell.state.view?.pairs === 4 && p.shell.state.view.status === "choosing");
  assert.equal(p.shell.state.view.pair.right.candidateId, winner.candidateId);
  assert.equal(p.$("coinflipBadge-right").textContent, "Winner");
  p.$("coinflipStop").click();
  await until(() => p.shell.state.view?.status === "stopped" && p.$("steerSend").hidden);
  assert.equal(p.shell.state.view.result.candidateId, winner.candidateId);
  assert.deepEqual(p.posts.filter((op) => op !== "draft"), ["start", "steer", "choose", "steer", "stop"]);

  // Training starts from the same GUI, but its review page has no prompt steering.
  p.win.document.querySelector('input[value="trainer"]').click();
  p.type("Rank the stories");
  await until(() => !p.$("startDouble").disabled);
  p.$("startDouble").click();
  await until(() => p.shell.state.view?.mode === "trainer");
  assert.equal(p.$("steerSend").hidden, true);
  await until(() => /Prompt steering is not available for Training/.test(p.$("guiStatus").textContent));
  assert.equal((await request(s.port, croute(id) + "/steer", { token: s.token, method: "POST", body: { actionId: "x", pairIndex: 3, instruction: "x" } })).json.error.code, "FORBIDDEN");
});

// Review findings 1 and 2: the box owns the instruction, so no click can save a text twice.
test("S1: the start brief stays in the box after Start, but Send instruction needs a new text", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const p = await page(t, s, c.connected.path);
  p.win.document.querySelector('input[value="coinflip"]').click();
  p.type("A pricing card");
  p.$("startDouble").click();
  await until(() => p.shell.state.view?.mode === "coinflip");
  const id = p.shell.state.currentSessionId;
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  await until(() => !p.$("coinflipChoose-left").disabled);
  assert.equal(p.$("brief").value, "A pricing card", "the start brief stays visible");
  assert.equal(p.$("steerSend").disabled, true);
  assert.match(p.$("guiStatus").textContent, /Type a new instruction/);
  p.$("steerSend").click();
  p.type("  A pricing card ");
  await delay(80);
  assert.equal(p.$("steerSend").disabled, true, "surrounding spaces do not make it new");
  assert.ok(!p.posts.includes("steer"), "the untouched brief is never saved as a steer");
  p.type("A pricing card, dark");
  await until(() => !p.$("steerSend").disabled);
  assert.equal((await c.events(id)).events.length, 1);
});

test("S2: Coinflip lost Send, reload, Resolve: the confirmed text leaves the box and a second click saves nothing", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const cid = await c.start("A toggle");
  await c.attach(cid, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  const w = await page(t, s, c.connected.path, { lose: "steer" });
  await until(() => w.shell.mode("coinflip")?.view?.status === "choosing");
  w.type("Try a pill shape");
  await until(() => !w.$("steerSend").disabled);
  w.$("steerSend").click();
  await until(() => !w.$("coinflipResolve").hidden && !w.$("coinflipResolve").disabled);
  assert.equal(w.$("brief").value, "Try a pill shape", "an unconfirmed instruction stays");
  const kept = w.storage();
  w.close();
  const x = await page(t, s, c.connected.path, { storage: kept });
  await until(() => !x.$("coinflipResolve").hidden);
  assert.equal(x.$("brief").value, "Try a pill shape");
  x.$("coinflipResolve").click();
  await until(() => x.$("coinflipResolve").hidden && x.$("brief").value === "");
  await c.attach(cid, { left: await candidate(f, "c"), right: await candidate(f, "d") });
  await until(() => x.shell.state.view?.pairs === 2 && x.shell.state.view.status === "choosing");
  assert.equal(x.$("steerSend").disabled, true);
  x.$("steerSend").click();
  await delay(80);
  assert.deepEqual(x.posts.filter((op) => op !== "draft"), ["steer"], "only the Resolve replay");
  assert.equal((await c.view(cid)).steers.length, 1);
  assert.equal((await s.api("/api/double/gui")).json.draft, "", "the cleared box is the saved draft");
});

test("S3: Double lost Send, then Retry: the confirmed text leaves the box and a second click saves nothing", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const post = (route, body) => s.api(route, { method: "POST", body });
  const bound = (await post("/api/double/gui/connect", origin(f))).json;
  const id = (await post("/api/double/gui/start", { actionId: "double-start", mode: "double", brief: "Lost steer" })).json.result.sessionId;
  const r = root(id);
  const attach = async (comparisonId) => {
    const event = (await generations(s, r)).at(-1);
    await post(r + "/attach", { actionId: `a-${comparisonId}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId, manifest: { ...f.manifest, comparisonId } });
  };
  await attach("round-1");
  const p = await page(t, s, bound.path, { lose: "steer" });
  await until(() => p.shell.pair?.controller.getState().view?.status === "editing");
  assert.equal(p.$("steerSend").disabled, true, "the restored start brief is not an instruction");
  p.type("Bigger buttons");
  await until(() => !p.$("steerSend").disabled);
  p.$("steerSend").click();
  await until(() => !p.$("sessionAlert").hidden && !p.$("sessionRetry").hidden && !p.$("sessionRetry").disabled);
  assert.equal(p.$("brief").value, "Bigger buttons");
  p.$("sessionRetry").click();
  await until(() => p.$("sessionAlert").hidden && p.$("brief").value === "");
  await attach("round-2");
  await until(() => p.shell.pair?.controller.getState().view?.currentComparisonId === "round-2");
  assert.equal(p.$("steerSend").disabled, true);
  p.$("steerSend").click();
  await delay(80);
  assert.deepEqual(p.posts.filter((op) => op === "steer"), ["steer", "steer"], "the lost Send and its Retry only");
  assert.equal((await generations(s, r)).length, 2);
  // Retyping the last saved instruction is not new either.
  p.type("Bigger buttons");
  await delay(80);
  assert.equal(p.$("steerSend").disabled, true);
});

test("the saved instructions of a session have a total size cap; the GUI and the server refuse Send at the cap", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const id = await c.start("Cap");
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  for (const [n, letter] of [[0, "x"], [1, "y"]]) {
    const answer = await c.steer(id, await c.view(id), letter.repeat(8000));
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    await c.attach(id, { left: await candidate(f, `l${n}`), right: await candidate(f, `r${n}`) });
  }
  const over = await c.steer(id, await c.view(id), "z".repeat(STEER_TOTAL_BYTES - 16000 + 1));
  assert.equal(over.json.error.code, "INVALID_REQUEST");
  assert.match(over.json.error.message, /16 KiB in total/);
  assert.equal((await c.view(id)).status, "choosing", "a refused Send changes nothing");
  const p = await page(t, s, c.connected.path);
  await until(() => p.shell.mode("coinflip")?.view?.status === "choosing");
  p.type("z".repeat(500));
  await until(() => /16 KiB in total/.test(p.$("guiStatus").textContent));
  assert.equal(p.$("steerSend").disabled, true);
  p.type("z".repeat(300));
  await until(() => !p.$("steerSend").disabled);
});

test("a Double steer with a selected group target carries the group and its overridden inner choices to the generation event", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const PAGE = '<!doctype html><html><head></head><body><section data-double-id="whole" data-double-scope="group" data-container="Whole report"><div data-double-id="frame" data-double-scope="frame" data-container="Frame only" style="padding:12px"><p data-double-id="item" data-container="Item">Keep my text</p></div></section></body></html>';
  await fs.writeFile(path.join(f.manifest.panes.left.copy.root, "index.html"), PAGE);
  const post = (route, body) => s.api(route, { method: "POST", body });
  const bound = (await post("/api/double/gui/connect", origin(f))).json;
  const id = (await post("/api/double/gui/start", { actionId: "start", mode: "double", brief: "Scoped" })).json.result.sessionId, r = root(id);
  const first = (await generations(s, r))[0];
  assert.equal((await post(r + "/attach", { actionId: "a1", requestId: first.payload.requestId, attemptId: first.payload.attemptId, manifest: { ...f.manifest, comparisonId: "scoped" } })).status, 200);
  const token = /data-token="([0-9a-f]{64})"/.exec((await request(s.port, bound.path)).text)[1];
  const owner = (route, body) => request(s.port, route, { token, method: "POST", body });
  let n = 0;
  const act = async (action) => {
    const v = (await s.api(r)).json.view;
    const answer = await owner(r + "/actions", { actionId: `act-${n++}`, expectedRevision: v.revision, comparisonId: "scoped", action });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
  };
  await act({ kind: "delete", pane: "left", componentId: "frame" });
  await act({ kind: "keeper", pane: "left", componentId: "whole", selected: true });
  const v = (await s.api(r)).json.view;
  assert.equal((await owner(r + "/steer", { actionId: "steer", expectedRevision: v.revision, comparisonId: "scoped", instruction: "Tighter spacing" })).status, 200);
  const event = (await generations(s, r)).at(-1);
  assert.equal(event.payload.steer.text, "Tighter spacing");
  const batch = event.payload.batch.payload;
  assert.deepEqual(batch.keepers.map((k) => [k.identity.componentId, k.scope]), [["whole", "group"]]);
  assert.deepEqual(batch.plainDeletions, [], "the selected group overrides the inner deletion");
  assert.deepEqual(batch.overridden.map((o) => [o.identity.componentId, o.deleted, o.controllingGroupId]), [["frame", true, "whole"]]);
});

test("the Coinflip panel never lets a late answer replace a newer saved revision or another session", async (t) => {
  const dom = new JSDOM((await fs.readFile(new URL("../src/coinflip-panel.html", import.meta.url), "utf8")), { url: "http://127.0.0.1/" });
  const candidateView = (id, side) => ({ candidateId: `${id}-${side}`, description: side, frameUrl: `/f/${side}`, archiveRef: { entry: "index.html" } });
  const view = (sessionId, revision, extra = {}) => ({ mode: "coinflip", sessionId, brief: "B", revision, status: "choosing", guiConnection: true,
    pair: { index: 0, left: candidateView(sessionId, "left"), right: candidateView(sessionId, "right") }, winner: null, choices: [], steers: [],
    generation: { requestId: "r", kind: "initial", attempt: { id: "a", status: "attached", failure: null } }, ...extra });
  let answer;
  const shell = mountCoinflip({ window: dom.window, token: "t", base: "", storage: dom.window.localStorage, key: "k", canGenerate: () => true,
    fetch: async (_url, init) => { const body = JSON.parse(init.body); return new Response(JSON.stringify(answer(body)), { status: 200, headers: { "content-type": "application/json" } }); } });
  t.after(() => { shell.close(); dom.window.close(); });
  shell.update(view("one", 5));
  // An exact receipt whose view is older than the one on screen: the receipt settles, the screen keeps revision 5.
  answer = (body) => ({ result: { actionId: body.actionId, kind: "steer", revision: 3 }, view: view("one", 3, { status: "generating" }) });
  assert.equal((await shell.steer("Darker")).ok, true);
  assert.equal(shell.view.revision, 5);
  assert.equal(shell.pending, null);
  // An answer for another session is not this action's receipt: it never replaces the view and stays unresolved.
  answer = (body) => ({ result: { actionId: body.actionId, kind: "steer", revision: 6 }, view: view("two", 6) });
  assert.equal((await shell.steer("Lighter")).ok, false);
  assert.equal(shell.view.sessionId, "one");
  assert.ok(shell.pending, "an unproven answer keeps the saved request for Resolve");
});

test("packet wording: every saved instruction still applies in later rounds of both modes; old challenger text is unchanged", async (t) => {
  assert.match(GENERATION_WORKFLOW, /Every saved payload\.steers instruction still applies in each later round, also a Next Round without payload\.steer/);
  assert.match(COINFLIP_GENERATION_WORKFLOW, /every payload\.steers instruction/);
  assert.match(COINFLIP_GENERATION_WORKFLOW, /Every saved payload\.steers instruction still applies in each later request/);
  const f = await fixture(t), s = await listen(t, f);
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const plain = await c.start("Plain");
  await c.attach(plain, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  await c.choose(plain, await c.view(plain), "left");
  assert.equal((await c.generation(plain)).payload.instruction, CHALLENGER_INSTRUCTION, "a record without steers keeps the exact earlier text");
  await c.owner(croute(plain) + "/stop", { actionId: "stop-plain" });
  const steered = await c.start("Steered");
  await c.attach(steered, { left: await candidate(f, "c"), right: await candidate(f, "d") });
  await c.steer(steered, await c.view(steered), "Dark theme");
  await c.attach(steered, { left: await candidate(f, "e"), right: await candidate(f, "g") });
  await c.choose(steered, await c.view(steered), "left");
  const event = await c.generation(steered);
  assert.equal(event.payload.kind, "challenger");
  assert.equal(event.payload.instruction, CHALLENGER_INSTRUCTION + STEERS_STILL_APPLY);
  assert.deepEqual(event.payload.steers.map((x) => x.text), ["Dark theme"]);
});

test("saved instructions replay under later limits: records written with raised limits load with the default stores and server", async (t) => {
  const f = await fixture(t);
  const raised = { text: 20000, total: 200000 }, long = (letter) => letter.repeat(9000);
  const gui = (sessionId) => ({ sessionId, brief: "Raised", origin: origin(f), initialActionId: `start-${sessionId}` });
  // Coinflip: three steers that pass both current limits, written by a store with raised limits.
  const cf = new CoinflipStore({ archiveDir: f.archiveDir, stateDir: f.stateDir, steerLimits: raised });
  await cf.createInitial(gui("cf"));
  const attachCf = async (n) => {
    const event = (await cf.events("cf")).events.at(-1);
    const panes = { left: await candidate(f, `cl${n}`), right: await candidate(f, `cr${n}`) };
    const answer = await cf.mutate("cf", "attach", { actionId: `attach-${n}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId,
      manifest: { comparisonId: `pair-${n}`, label: "Pair", panes }, candidates: { left: { description: "L" }, right: { description: "R" } } });
    assert.equal(answer.view.status, "choosing", JSON.stringify(answer.view.generation));
  };
  await attachCf(0);
  for (const [n, letter] of [[1, "a"], [2, "b"], [3, "c"]]) {
    await cf.mutate("cf", "steer", { actionId: `steer-${n}`, pairIndex: n - 1, instruction: long(letter) });
    await attachCf(n);
  }
  // Double: two steers of 9000 characters.
  const ds = new DoubleSessionStore({ archiveDir: f.archiveDir, stateDir: f.stateDir, steerLimits: raised });
  await ds.createInitial(gui("ds"));
  const attachDs = async (n) => {
    const event = (await ds.events("ds")).events.filter((e) => e.kind === "generation").at(-1);
    await ds.mutate("ds", "attach", { actionId: `attach-${n}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId, manifest: { ...f.manifest, comparisonId: `round-${n}` } });
  };
  await attachDs(0);
  for (const [n, letter] of [[1, "a"], [2, "b"]]) {
    const v = await ds.read("ds");
    await ds.mutate("ds", "steer", { actionId: `steer-${n}`, expectedRevision: v.revision, comparisonId: v.currentComparisonId, instruction: long(letter) });
    await attachDs(n);
  }
  // The default stores decode and replay both records, and an identical saved steer still returns its receipt.
  const cfDefault = new CoinflipStore({ archiveDir: f.archiveDir, stateDir: f.stateDir });
  assert.equal((await cfDefault.read("cf")).steers.length, 3);
  assert.equal((await cfDefault.mutate("cf", "steer", { actionId: "steer-1", pairIndex: 0, instruction: long("a") })).result.actionId, "steer-1");
  const dsDefault = new DoubleSessionStore({ archiveDir: f.archiveDir, stateDir: f.stateDir });
  assert.deepEqual((await dsDefault.read("ds")).rounds.filter((r) => r.outcome?.kind === "steer").map((r) => r.outcome.instruction.length), [9000, 9000]);
  // A new steer under the default limits is refused before any state change.
  const before = await cfDefault.read("cf");
  await assert.rejects(cfDefault.mutate("cf", "steer", { actionId: "steer-new", pairIndex: before.pair.index, instruction: "Short" }),
    (e) => e.code === "INVALID_REQUEST" && /16 KiB in total/.test(e.message));
  assert.equal((await cfDefault.read("cf")).revision, before.revision);
  const v = await dsDefault.read("ds");
  await assert.rejects(dsDefault.mutate("ds", "steer", { actionId: "steer-new", expectedRevision: v.revision, comparisonId: v.currentComparisonId, instruction: "x".repeat(8001) }),
    (e) => e.code === "INVALID_REQUEST" && /at most 8000 characters/.test(e.message));
  // The server's own stores read them too.
  const s = await listen(t, f);
  assert.equal((await s.api(croute("cf"))).json.view.steers.length, 3);
  assert.equal((await s.api(root("ds"))).status, 200);
});

test("one first instruction above the total gets its own message; the GUI and the server show it", async (t) => {
  const cjk = "\u6f22".repeat(8000);
  assert.match(steerProblem([], cjk), /This instruction alone is 24000 bytes of UTF-8, more than the 16 KiB/);
  assert.doesNotMatch(steerProblem([], cjk), /saved instructions/);
  assert.match(steerProblem(["x".repeat(10000)], "y".repeat(7000)), /saved instructions of this session would pass 16 KiB/);
  assert.equal(steerProblem([], "\u6f22".repeat(5000)), null);
  const f = await fixture(t), s = await listen(t, f);
  const c = await coinflip(t, s, f, { origin: origin(f) });
  const id = await c.start("CJK");
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  const refused = await c.steer(id, await c.view(id), cjk);
  assert.equal(refused.json.error.code, "INVALID_REQUEST");
  assert.match(refused.json.error.message, /This instruction alone is 24000 bytes/);
  const p = await page(t, s, c.connected.path);
  await until(() => p.shell.mode("coinflip")?.view?.status === "choosing");
  p.type(cjk);
  await until(() => /This instruction alone is 24000 bytes/.test(p.$("guiStatus").textContent));
  assert.equal(p.$("steerSend").disabled, true);
});
