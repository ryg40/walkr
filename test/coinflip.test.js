import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { fixture, listen, request, digest } from "./double-fixtures.js";
import { candidate, coinflip, croute } from "./coinflip-fixtures.js";
import { bootSharedGui } from "../src/shared-gui-shell.js";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SERVER_PROTOCOL } from "../src/paths.js";

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail("Coinflip state did not settle");
}

const bytesOf = (output, path) => Buffer.from(output.winner.files.find((f) => f.path === path).base64, "base64");

// Checked returned artifacts through authenticated HTTP and the durable archive.
test("Coinflip keeps the exact winner on both sides through repeated rounds and refuses a changed or moved winner", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  const id = await c.start();
  const panes = { left: await candidate(f, "a"), right: await candidate(f, "b") };
  assert.equal((await c.attach(id, panes)).status, 200);
  let v = await c.view(id);
  const a = v.pair.left, b = v.pair.right;
  const aBytes = Buffer.from((await request(s.port, v.pair.left.frameUrl)).bytes);

  // Left wins; the challenger request carries the full context and replaces only the right side.
  assert.equal((await c.choose(id, v, "left", "Keep the bold heading")).status, 200);
  let event = await c.generation(id);
  assert.equal(event.payload.kind, "challenger");
  assert.equal(event.payload.brief, v.brief);
  assert.equal(event.payload.winner.candidateId, a.candidateId);
  assert.deepEqual(event.payload.winner.pane, panes.left);
  assert.equal(event.payload.rejected.candidateId, b.candidateId);
  assert.equal(event.payload.rejected.description, "Right direction");
  assert.ok(event.payload.rejected.archiveRef.files.length);
  assert.equal(event.payload.replaceSide, "right");
  assert.equal(event.payload.note, "Keep the bold heading");
  assert.equal((await c.view(id)).winner.side, "left");
  assert.equal((await c.choose(id, v, "right")).status, 409, "choices are disabled during generation");

  assert.equal((await c.attach(id, { left: panes.left, right: await candidate(f, "c") }, { event })).status, 200);
  v = await c.view(id);
  assert.equal(v.status, "choosing");
  assert.equal(v.pair.left.candidateId, a.candidateId);
  assert.notEqual(v.pair.right.candidateId, b.candidateId);
  const cId = v.pair.right.candidateId;
  assert.deepEqual(Buffer.from((await request(s.port, v.pair.left.frameUrl)).bytes), aBytes);

  // The challenger on the right wins; it stays on the right while the left side is replaced.
  assert.equal((await c.choose(id, v, "right", null)).status, 200);
  event = await c.generation(id);
  assert.equal(event.payload.replaceSide, "left");
  assert.equal(event.payload.choices.length, 2);
  const cPane = event.payload.winner.pane;

  // A changed winner copy fails the attempt; the prior pair and winner stay.
  const cImage = path.join(cPane.copy.root, "assets/image.png"), original = await fs.readFile(cImage);
  await fs.writeFile(cImage, Buffer.concat([original, Buffer.from("changed")]));
  const changed = await c.attach(id, { left: await candidate(f, "d"), right: cPane }, { event });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.view.status, "failed");
  assert.match(changed.json.view.generation.attempt.failure, /WINNER_CHANGED/);
  assert.equal(changed.json.view.pair.right.candidateId, cId);
  assert.equal(changed.json.view.winner.candidateId, cId);
  await fs.writeFile(cImage, original);

  // Retry repeats the saved request; a winner moved to the other side is refused as well.
  const retry = await c.owner(croute(id) + "/retry", { actionId: "retry-1", requestId: event.payload.requestId, attemptId: event.payload.attemptId });
  assert.equal(retry.status, 200);
  const again = await c.generation(id);
  assert.notEqual(again.payload.attemptId, event.payload.attemptId);
  assert.equal(again.payload.requestId, event.payload.requestId);
  const { attemptId: _a, ...samePayload } = again.payload, { attemptId: _b, ...savedPayload } = event.payload;
  assert.deepEqual(samePayload, savedPayload, "Retry reuses the saved request");
  const moved = await c.attach(id, { left: cPane, right: await candidate(f, "e") }, { event: again });
  assert.equal(moved.json.view.status, "failed");
  assert.equal(moved.json.view.pair.right.candidateId, cId);
  await c.owner(croute(id) + "/retry", { actionId: "retry-2", requestId: again.payload.requestId, attemptId: again.payload.attemptId });
  const third = await c.generation(id);
  assert.equal((await c.attach(id, { left: await candidate(f, "f"), right: cPane }, { event: third })).status, 200);
  v = await c.view(id);
  assert.equal(v.pair.right.candidateId, cId);
  assert.equal(v.pairs, 3, "failed attempts never add a pair");

  assert.equal((await c.owner(croute(id) + "/stop", { actionId: "stop" })).json.view.result.candidateId, cId);
  const submit = await c.owner(croute(id) + "/submit", { actionId: "submit" });
  assert.equal(submit.status, 200);
  const output = (await s.api(croute(id) + "/output")).json;
  assert.equal(output.winner.candidateId, cId);
  assert.equal(output.winner.side, "right");
  assert.deepEqual(bytesOf(output, "assets/image.png"), original);
  assert.equal(output.choices.length, 2);
  assert.equal(output.choices[0].note, "Keep the bold heading");
  assert.equal(output.choices[0].rejected.candidateId, b.candidateId);
  for (const item of output.candidates.filter((x) => x.role !== "winner")) {
    assert.equal(item.files, undefined, "rejected candidates are references, not bytes");
    assert.ok(item.archiveRef.record.startsWith("coinflip-session-"));
  }
});

test("Coinflip refuses a challenger that repeats the winner or the rejected candidate byte for byte", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  const id = await c.start();
  const winner = await candidate(f, "a");
  await c.attach(id, { left: winner, right: await candidate(f, "b") });
  const v = await c.view(id);
  await c.choose(id, v, "left");
  let event = await c.generation(id);
  for (const name of ["a", "b"]) {
    const repeat = await c.attach(id, { left: winner, right: await candidate(f, name, { folder: `${name}-repeat` }) }, { event });
    assert.equal(repeat.json.view.status, "failed");
    assert.match(repeat.json.view.generation.attempt.failure, /CANDIDATE_REPEATED/);
    assert.equal(repeat.json.view.pair.right.candidateId, v.pair.right.candidateId, "the pair stays");
    assert.equal(repeat.json.view.winner.candidateId, v.pair.left.candidateId, "the winner stays");
    await c.owner(croute(id) + "/retry", { actionId: `retry-${name}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId });
    event = await c.generation(id);
  }
  assert.equal((await c.attach(id, { left: winner, right: await candidate(f, "c") }, { event })).json.view.status, "choosing");
  assert.equal((await c.view(id)).pairs, 2);
});

test("Coinflip export-winner rebuilds a deleted winner folder from the archive so that the agent can attach again", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ protocol: SERVER_PROTOCOL, port: s.port, token: s.token }), { mode: 0o600 });
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir, HUMAN_REVIEW_HOSTED: "0" };
  const cli = (...args) => promisify(execFile)(process.execPath, ["src/walkr-coinflip.js", ...args], { env });
  const id = await c.start();
  const winner = await candidate(f, "a");
  await c.attach(id, { left: winner, right: await candidate(f, "b") });
  const v = await c.view(id);
  await c.choose(id, v, "left");
  let event = await c.generation(id);
  for (const file of [winner.copy.root, path.dirname(winner.original.entry)]) await fs.rm(file, { recursive: true });
  const stranded = await c.attach(id, { left: winner, right: await candidate(f, "c") }, { event });
  assert.equal(stranded.json.view.status, "failed", "a missing winner folder fails the attempt");
  await c.owner(croute(id) + "/retry", { actionId: "retry", requestId: event.payload.requestId, attemptId: event.payload.attemptId });
  event = await c.generation(id);

  const folder = path.join(f.root, "restored-winner");
  const exported = JSON.parse((await cli("session", "export-winner", id, folder)).stdout);
  assert.equal(exported.candidateId, v.pair.left.candidateId);
  assert.equal(exported.side, "left");
  await assert.rejects(cli("session", "export-winner", id, folder), /not empty/, "an existing non-empty folder is refused");
  await assert.rejects(cli("session", "export-winner", id, path.join(f.archiveDir, "x")), /outside the archive/);
  const attached = await c.attach(id, { left: exported.pane, right: await candidate(f, "c") }, { event });
  assert.equal(attached.json.view.status, "choosing", JSON.stringify(attached.json.view.generation));
  assert.equal(attached.json.view.pair.left.candidateId, v.pair.left.candidateId, "the archived winner keeps its identity");
});

test("Coinflip Stop freezes the latest choice, refuses late or duplicate work, and gives no result before a winner", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  // Before any pair or winner: no result, Submit unavailable, late candidates refused.
  const early = await c.start("Early stop");
  const initial = await c.generation(early);
  assert.equal((await c.owner(croute(early) + "/stop", { actionId: "stop-early" })).json.view.result, null);
  assert.equal((await c.owner(croute(early) + "/submit", { actionId: "submit-early" })).json.error.code, "INVALID_TRANSITION");
  assert.equal((await c.attach(early, { left: await candidate(f, "late-a"), right: await candidate(f, "late-b") }, { event: initial })).status, 409);
  assert.equal((await c.view(early)).pair, null);

  // In-flight Stop after a choice freezes that winner; the running challenger cannot land.
  const id = await c.start("In-flight stop");
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  let v = await c.view(id);
  // Owner decisions need the GUI browser credential; generation and delivery operations need the agent credential.
  const agentChoice = await c.post(croute(id) + "/choose", { actionId: "agent-choice", pairIndex: v.pair.index, winner: v.pair.right.candidateId, note: null });
  assert.equal(agentChoice.json.error.code, "FORBIDDEN");
  assert.equal((await c.owner(croute(id) + "/fail", { actionId: "browser-fail", requestId: "x", attemptId: "y", message: "no" })).json.error.code, "FORBIDDEN");
  const choice = await c.choose(id, v, "right", "Right is calmer", "choose-once");
  assert.equal(choice.status, 200);
  const replay = await c.choose(id, v, "right", "Right is calmer", "choose-once");
  assert.deepEqual(replay.json.result, choice.json.result, "duplicate action replays its receipt");
  assert.equal((await c.choose(id, v, "right", "Right is calmer", "choose-twice")).status, 409, "a second click cannot add a round");
  const event = await c.generation(id);
  const stopped = await c.owner(croute(id) + "/stop", { actionId: "stop" });
  assert.equal((await c.post(croute(id) + "/submit", { actionId: "agent-submit" })).json.error.code, "FORBIDDEN");
  assert.equal(stopped.json.view.result.candidateId, v.pair.right.candidateId);
  const before = await c.events(id);
  for (const late of [
    c.attach(id, { left: await candidate(f, "late"), right: event.payload.winner.pane }, { event }),
    c.owner(croute(id) + "/retry", { actionId: "late-retry", requestId: event.payload.requestId, attemptId: event.payload.attemptId }),
    c.choose(id, v, "left", null, "late-choice"),
    c.owner(croute(id) + "/stop", { actionId: "stop-again" }),
  ]) assert.equal((await late).status, 409);
  assert.deepEqual(await c.events(id), before);
  v = await c.view(id);
  assert.equal(v.pairs, 1);
  assert.equal(v.result.candidateId, v.pair.right.candidateId);

  // Submit is idempotent: a repeat or a new action resolves to the same saved final event.
  const first = await c.owner(croute(id) + "/submit", { actionId: "submit-1" });
  const second = await c.owner(croute(id) + "/submit", { actionId: "submit-2" });
  assert.equal(first.json.result.eventId, second.json.result.eventId);
  assert.deepEqual((await c.owner(croute(id) + "/submit", { actionId: "submit-1" })).json.result, first.json.result);
  assert.equal((await c.events(id)).events.filter((e) => e.kind === "final").length, 1);
  await s.close();

  // Restart decodes the saved record; the frozen state and result are unchanged.
  const restarted = await listen(t, f);
  const read = (await restarted.api(croute(id))).json.view;
  assert.equal(read.status, "stopped");
  assert.equal(read.result.candidateId, v.result.candidateId);
  assert.equal(read.delivery, "pending");
});

test("Coinflip generation gating: disconnected choices and Retry wait for explicit reconnection; interrupted work needs recovery", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  const id = await c.start();
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  const v = await c.view(id);
  await c.post("/api/double/gui/disconnect", { leaseId: c.connected.leaseId });
  assert.equal((await c.choose(id, v, "left")).json.error.code, "DISCONNECTED");
  const again = await c.post("/api/double/gui/connect", { piSessionId: "coinflip-origin", piSessionFile: f.root + "/pi.jsonl" });
  assert.equal((await c.choose(id, v, "left")).status, 200);
  const event = await c.generation(id);
  // Disconnection marks the running attempt interrupted. Late work is refused until explicit recovery.
  await c.post("/api/double/gui/disconnect", { leaseId: again.json.leaseId });
  await c.post("/api/double/gui/connect", { piSessionId: "coinflip-origin", piSessionFile: f.root + "/pi.jsonl" });
  assert.equal((await c.view(id)).recoveryRequired, true);
  assert.equal((await c.attach(id, { left: event.payload.winner.pane, right: await candidate(f, "late") }, { event })).json.error.code, "STALE_ATTEMPT");
  const recovered = await c.owner(croute(id) + "/recover", { actionId: "recover", requestId: event.payload.requestId, attemptId: event.payload.attemptId });
  assert.equal(recovered.json.view.status, "failed");
  assert.equal(recovered.json.view.pair.left.candidateId, v.pair.left.candidateId);
  assert.equal((await c.owner(croute(id) + "/retry", { actionId: "retry", requestId: event.payload.requestId, attemptId: event.payload.attemptId })).status, 200);
  assert.equal((await c.generation(id)).payload.requestId, event.payload.requestId);
});

test("old schema-1 shared-GUI Double records still decode, and Double and Coinflip share one active session", async (t) => {
  const f = await fixture(t);
  // The exact pre-Coinflip record format, written without the new code.
  const hash = (value) => digest(Buffer.from(value));
  const doc = { schemaVersion: 1, guiId: "shared-gui", origin: { piSessionId: "legacy", piSessionFile: f.root + "/pi.jsonl" },
    starts: [{ request: { actionId: "legacy-start", brief: "Legacy brief", mode: "double" }, sessionId: `gui-${hash("legacy-start")}`, leaseId: "old-lease" }],
    drafts: [{ actionId: "draft", text: "Legacy draft" }] };
  await fs.mkdir(f.archiveDir, { mode: 0o700 });
  await fs.writeFile(path.join(f.archiveDir, `shared-gui-${hash("shared-gui")}.json`),
    `${JSON.stringify({ ...doc, checksum: hash(JSON.stringify(doc)) })}\n`, { mode: 0o600 });
  const s = await listen(t, f);
  const state = (await s.api("/api/double/gui")).json;
  assert.equal(state.draft, "Legacy draft");
  assert.equal(state.history[0].mode, "double");
  assert.equal(state.view.sessionId, `gui-${hash("legacy-start")}`);
  assert.equal(state.view.status, "generating");
  const post = (route, body) => s.api(route, { method: "POST", body });
  await post("/api/double/gui/connect", doc.origin);
  assert.equal((await post("/api/double/gui/start", { actionId: "cf", mode: "coinflip", brief: "Blocked" })).json.error.code, "ACTIVE_SESSION");
  assert.equal((await post("/api/double/gui/start", { actionId: "tr", mode: "trainer", brief: "Blocked too" })).json.error.code, "ACTIVE_SESSION");
  const v = state.view;
  assert.equal((await post(`/api/double/sessions/~${encodeURIComponent(v.sessionId)}/stop`, { actionId: "stop", expectedRevision: v.revision })).status, 200);
  const started = await post("/api/double/gui/start", { actionId: "cf", mode: "coinflip", brief: "Now allowed" });
  assert.equal(started.status, 200);
  assert.equal(started.json.currentMode, "coinflip");
  assert.equal((await post("/api/double/gui/start", { actionId: "double-2", mode: "double", brief: "Blocked by Coinflip" })).json.error.code, "ACTIVE_SESSION");
});

test("Coinflip GUI: mode switch, read-only frames, click saves the winner with its note, Stop then Submit", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  const base = `http://127.0.0.1:${s.port}`, response = await request(s.port, c.connected.path);
  const dom = new JSDOM(response.text, { url: base + c.connected.path });
  const posts = [];
  const shell = bootSharedGui(dom.window, { base, refreshMs: 30, fetch: async (url, init) => { if (init.method === "POST") posts.push(url); return fetch(url, init); } });
  t.after(() => { shell.close(); dom.window.close(); });
  const $ = (id) => dom.window.document.getElementById(id);
  await until(() => shell.state);
  assert.equal(dom.window.document.querySelector('input[value="trainer"]').disabled, false, "Training is a mode choice");
  dom.window.document.querySelector('input[value="coinflip"]').click();
  $("brief").value = "A toggle switch"; $("brief").dispatchEvent(new dom.window.Event("input"));
  $("startDouble").click();
  assert.equal($("title").textContent, "Coinflip", "the page switches before generation");
  await until(() => shell.state.view?.mode === "coinflip" && !$("coinflip").hidden);
  assert.equal($("coinflipChoose-left").hidden, true);
  const id = shell.state.currentSessionId;
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  await until(() => !$("coinflipChoose-left").disabled);
  assert.equal($("coinflipFrame-left").getAttribute("sandbox"), "");
  const frame = await request(s.port, new URL($("coinflipFrame-left").src).pathname);
  assert.match(frame.headers["content-security-policy"], /sandbox;/);
  $("coinflipNote").value = "Rounder corners"; $("coinflipNote").dispatchEvent(new dom.window.Event("input"));
  const left = shell.state.view.pair.left.candidateId;
  $("coinflipChoose-left").click();
  await until(() => shell.state.view?.status === "generating" && $("coinflipBadge-left").textContent === "Winner");
  assert.equal($("coinflipChoose-right").disabled, true);
  assert.equal($("coinflipStop").disabled, false);
  assert.equal((await c.view(id)).choices[0].note, "Rounder corners");
  $("coinflipStop").click();
  await until(() => shell.state.view?.status === "stopped" && !$("coinflipSubmit").hidden);
  assert.equal(shell.state.view.result.candidateId, left);
  $("coinflipSubmit").click();
  await until(() => shell.state.view?.submitted === true);
  assert.equal((await s.api(croute(id) + "/output")).json.winner.candidateId, left);
  assert.deepEqual(posts.map((url) => url.split("/").at(-1)).filter((op) => op !== "draft"), ["start", "choose", "stop", "submit"]);
  await f.unchanged(assert);
});

test("Coinflip GUI reload keeps an unconfirmed choice and resolves it once, without a second round", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  const base = `http://127.0.0.1:${s.port}`;
  const id = await c.start("Reload with a lost response");
  await c.attach(id, { left: await candidate(f, "a"), right: await candidate(f, "b") });
  async function open(storage, { loseChoose = false } = {}) {
    const dom = new JSDOM((await request(s.port, c.connected.path)).text, { url: base + c.connected.path });
    for (const [key, value] of storage) dom.window.localStorage.setItem(key, value);
    const posts = [];
    const shell = bootSharedGui(dom.window, { base, refreshMs: 30, fetch: async (url, init) => {
      if (init.method === "POST") posts.push(url.split("/").at(-1));
      const answer = await fetch(url, init);
      // The server saves the choice; the browser never sees the answer.
      if (loseChoose && url.endsWith("/choose")) { loseChoose = false; await answer.arrayBuffer(); throw new TypeError("Lost choose response"); }
      return answer;
    } });
    const close = () => { shell.close(); dom.window.close(); };
    t.after(close);
    await until(() => shell.state?.view?.mode === "coinflip");
    return { shell, posts, close, $: (name) => dom.window.document.getElementById(name),
      storage: () => Object.keys(dom.window.localStorage).map((key) => [key, dom.window.localStorage.getItem(key)]) };
  }
  const first = await open([], { loseChoose: true });
  await until(() => !first.$("coinflipChoose-left").disabled);
  first.$("coinflipChoose-left").click();
  // Resolve is disabled while the request is in flight and enabled once its answer is lost.
  await until(() => !first.$("coinflipResolve").hidden && !first.$("coinflipResolve").disabled);
  const saved = first.storage();
  assert.ok(saved.some(([key, value]) => key.endsWith(":coinflip-pending") && value !== "null"));
  first.close();
  assert.equal((await c.view(id)).choices.length, 1, "the server saved the choice");

  // Reload: the pending action stays, choices stay disabled, and nothing is sent until Resolve.
  const second = await open(saved);
  await until(() => second.shell.state.view?.status === "generating" && !second.$("coinflipResolve").hidden);
  assert.match(second.$("coinflipStatus").textContent, /Request not confirmed/);
  assert.equal(second.$("coinflipChoose-right").disabled, true);
  await delay(150);
  assert.deepEqual(second.posts, [], "reload never resubmits");
  second.$("coinflipResolve").click();
  await until(() => second.$("coinflipResolve").hidden);
  assert.deepEqual(second.posts, ["choose"]);
  assert.match(second.$("coinflipStatus").textContent, /^Generating one challenger/, "the saved receipt resolves the action without an error");
  assert.ok(!second.storage().some(([key]) => key.endsWith(":coinflip-pending")), "the resolved action leaves storage");
  const v = await c.view(id);
  assert.equal(v.choices.length, 1);
  assert.equal(v.pairs, 1);
  assert.equal((await c.events(id)).events.filter((e) => e.kind === "generation").length, 2, "one initial and one challenger request");
});

// Prompt-box steering through authenticated HTTP, the durable record, and checked artifacts.
test("Coinflip steering replaces the pair before a winner without a vote, and after a winner keeps it exactly and replaces only the challenger", async (t) => {
  const f = await fixture(t), s = await listen(t, f), c = await coinflip(t, s, f);
  const id = await c.start("A compact pricing card");
  const panes = { left: await candidate(f, "a"), right: await candidate(f, "b") };
  await c.attach(id, panes);
  let v = await c.view(id);
  const [a, b] = [v.pair.left.candidateId, v.pair.right.candidateId];

  // Before any winner: Send saves the instruction and requests a replacement pair at once.
  assert.equal((await c.post(croute(id) + "/steer", { actionId: "agent-steer", pairIndex: v.pair.index, instruction: "x" })).json.error.code, "FORBIDDEN");
  assert.equal((await c.steer(id, v, "   ")).json.error.code, "INVALID_REQUEST");
  const steered = await c.steer(id, v, "Use a darker palette", "steer-1");
  assert.equal(steered.status, 200);
  assert.equal(steered.json.view.status, "generating");
  assert.deepEqual((await c.steer(id, v, "Use a darker palette", "steer-1")).json.result, steered.json.result, "a duplicate Send resolves to its saved request");
  assert.equal((await c.steer(id, v, "Another one", "steer-queued")).json.error.code, "READ_ONLY", "no queued instruction during generation");
  assert.equal((await c.choose(id, v, "left")).status, 409, "choices are disabled during generation");
  let event = await c.generation(id);
  assert.equal(event.id, steered.json.result.eventId);
  assert.equal(event.payload.kind, "steer");
  assert.equal(event.payload.steer.text, "Use a darker palette");
  assert.equal(event.payload.steer.winner, null);
  assert.equal(event.payload.replaceSide, undefined);
  assert.equal(event.payload.winner, undefined);
  assert.deepEqual(event.payload.replaced.map((x) => x.candidateId), [a, b]);
  assert.equal(event.payload.brief, "A compact pricing card");
  v = await c.view(id);
  assert.equal(v.pair.left.candidateId, a, "the prior pair stays visible during generation");
  assert.deepEqual([v.winner, v.choices], [null, []], "no winner or rejection vote is invented");

  // A repeated candidate is refused; the replacement pair then attaches as a new pair.
  const repeat = await c.attach(id, { left: await candidate(f, "a", { folder: "a-repeat" }), right: await candidate(f, "c") }, { event });
  assert.match(repeat.json.view.generation.attempt.failure, /CANDIDATE_REPEATED/);
  assert.equal(repeat.json.view.pair.left.candidateId, a, "a failed steer keeps the prior pair");
  await c.owner(croute(id) + "/retry", { actionId: "retry-steer", requestId: event.payload.requestId, attemptId: event.payload.attemptId });
  event = await c.generation(id);
  assert.equal(event.payload.steer.text, "Use a darker palette", "Retry reuses the saved instruction");
  assert.equal((await c.attach(id, { left: await candidate(f, "c"), right: await candidate(f, "d") }, { event })).json.view.status, "choosing");
  v = await c.view(id);
  assert.equal(v.pairs, 2);
  assert.equal(v.winner, null);
  assert.equal(v.steers.length, 1);

  // A stale pair index is refused. After a winner, Send keeps it on its side and requests only a challenger.
  assert.equal((await c.steer(id, { pair: { index: 0 } }, "Stale")).json.error.code, "STALE_COMPARISON");
  await c.choose(id, v, "left", "Keep the heading");
  const winnerId = v.pair.left.candidateId, winnerPane = (await c.generation(id)).payload.winner.pane;
  await c.attach(id, { left: winnerPane, right: await candidate(f, "e") });
  v = await c.view(id);
  const e = v.pair.right.candidateId;
  const second = await c.steer(id, v, "Make the price larger", "steer-2");
  assert.equal(second.status, 200);
  event = await c.generation(id);
  assert.equal(event.payload.kind, "steer");
  assert.equal(event.payload.replaceSide, "right");
  assert.equal(event.payload.winner.candidateId, winnerId);
  assert.deepEqual(event.payload.winner.pane, winnerPane);
  assert.deepEqual(event.payload.replaced.map((x) => x.candidateId), [e]);
  assert.deepEqual(event.payload.steers.map((x) => x.text), ["Use a darker palette", "Make the price larger"]);
  assert.equal(event.payload.choices.length, 1);

  // The same checked winner preservation as a choice-triggered round.
  const winnerImage = path.join(winnerPane.copy.root, "assets/image.png"), original = await fs.readFile(winnerImage);
  await fs.writeFile(winnerImage, Buffer.concat([original, Buffer.from("changed")]));
  const changed = await c.attach(id, { left: winnerPane, right: await candidate(f, "g") }, { event });
  assert.match(changed.json.view.generation.attempt.failure, /WINNER_CHANGED/);
  assert.equal(changed.json.view.pair.right.candidateId, e, "a failed steer keeps the prior challenger");
  await fs.writeFile(winnerImage, original);
  await c.owner(croute(id) + "/retry", { actionId: "retry-2", requestId: event.payload.requestId, attemptId: event.payload.attemptId });
  event = await c.generation(id);
  assert.equal((await c.attach(id, { left: winnerPane, right: await candidate(f, "g") }, { event })).json.view.status, "choosing");
  v = await c.view(id);
  assert.equal(v.pair.left.candidateId, winnerId);
  assert.equal(v.winner.candidateId, winnerId);
  assert.equal(v.choices.length, 1, "steering adds no choice");

  // Disconnected Send is refused; restart replays the saved record unchanged; Stop then refuses late Send.
  await c.post("/api/double/gui/disconnect", { leaseId: c.connected.leaseId });
  assert.equal((await c.steer(id, v, "While disconnected")).json.error.code, "DISCONNECTED");
  await s.close();
  const restarted = await listen(t, f);
  assert.deepEqual((await restarted.api(croute(id))).json.view.steers, v.steers);
  const again = await restarted.api("/api/double/gui/connect", { method: "POST", body: { piSessionId: "coinflip-origin", piSessionFile: f.root + "/pi.jsonl" } });
  const token = /data-token="([0-9a-f]{64})"/.exec((await request(restarted.port, again.json.path)).text)[1];
  const owner = (route, body) => request(restarted.port, route, { token, method: "POST", body });
  assert.equal((await owner(croute(id) + "/stop", { actionId: "stop" })).json.view.result.candidateId, winnerId);
  assert.equal((await owner(croute(id) + "/steer", { actionId: "late", pairIndex: v.pair.index, instruction: "Late" })).json.error.code, "READ_ONLY");
  await owner(croute(id) + "/submit", { actionId: "submit" });
  const output = (await restarted.api(croute(id) + "/output")).json;
  assert.equal(output.winner.candidateId, winnerId);
  assert.deepEqual(bytesOf(output, "assets/image.png"), original);
  assert.deepEqual(output.steers.map((x) => [x.text, x.winner, x.replaced]), [["Use a darker palette", null, [a, b]], ["Make the price larger", winnerId, [e]]]);
  assert.deepEqual(Object.fromEntries(output.candidates.map((x) => [x.candidateId, x.role]))[a], "replaced");
  assert.equal(output.candidates.find((x) => x.candidateId === e).role, "replaced");
  assert.equal(output.choices.length, 1);
  assert.equal(output.brief, "A compact pricing card");
});
