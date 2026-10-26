import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { installCoreWakeChat, WAKE_MESSAGE } from "../src/core-wake-chat.js";

const TARGET = "/reviews/r.html";
const OWN = ["--pi-session-id", "chat-x", "--pi-session-file", "/sessions/x.jsonl"];
const BATCH = "batch-0123456789abcdef";
const idle = { code: 0, json: { status: "idle", batch_id: null, wake: { bound_to_caller: true } } };

async function until(check, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await delay(5); }
  assert.fail(`timed out: ${label}`);
}

/** A fake Pi chat and a fake walkr-core command; `answer(verb, args)` gives each command's reply. */
async function fakeChat(answer, { timeoutSeconds = 600 } = {}) {
  const handlers = {}, sent = [], entries = [], calls = [];
  const pi = {
    on: (name, handler) => { (handlers[name] ||= []).push(handler); },
    registerTool() {},
    registerCommand() {},
    sendMessage: (message, options) => sent.push({ message, options }),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "chat-x", getSessionFile: () => "/sessions/x.jsonl", getEntries: () => entries } };
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "connect") return { code: 0, json: { wake: { bound_to_caller: true } } };
    if (args[0] === "disconnect") return { code: 0, json: {} };
    return answer(args[0], args);
  };
  const chat = installCoreWakeChat(pi, {}, { pollMs: 5, command: ["walkr-core"], run });
  const emit = async (name) => { for (const handler of handlers[name] || []) await handler({}, ctx); };
  await emit("session_start");
  const connected = await chat.execute({ action: "connect", target: TARGET, timeoutSeconds }, ctx);
  assert.equal(connected.active, true);
  const releases = () => calls.filter((args) => args[0] === "disconnect");
  const wakes = () => sent.filter((s) => s.message.customType === WAKE_MESSAGE);
  return { chat, ctx, emit, calls, sent, releases, wakes };
}

for (const [path, setup, trigger] of [
  ["the lifetime ends", { timeoutSeconds: 0.05 }, async () => {}],
  ["status reads fail five times", { fail: true }, async () => {}],
  ["Pi shuts down", {}, (c) => c.emit("session_shutdown")],
  ["the session navigates", {}, (c) => c.emit("session_before_switch")],
  ["the chat disconnects", {}, (c) => c.chat.execute({ action: "disconnect" }, c.ctx)],
]) {
  test(`a stopped watcher releases its own server binding when ${path}`, async () => {
    const c = await fakeChat(() => (setup.fail ? { code: 1, json: null, stderr: "down" } : idle), setup);
    await trigger(c);
    await until(() => c.releases().length > 0, "the release");
    await delay(30);
    assert.deepEqual(c.releases(), [["disconnect", TARGET, ...OWN]], "one non-force disconnect with the chat's own identity");
  });
}

for (const [path, event] of [["navigates", "session_before_switch"], ["shuts down", "session_shutdown"]]) {
  test(`a connect that binds after the session ${path} releases that binding and leaves no watcher`, async () => {
    const handlers = {}, calls = [];
    let bind;
    const pi = { on: (name, handler) => { (handlers[name] ||= []).push(handler); }, registerTool() {}, registerCommand() {}, sendMessage() {}, appendEntry() {} };
    const ctx = { mode: "tui", sessionManager: { getSessionId: () => "chat-x", getSessionFile: () => "/sessions/x.jsonl", getEntries: () => [] } };
    const run = async (_command, args) => {
      calls.push(args);
      if (args[0] === "connect") return new Promise((resolve) => { bind = resolve; });
      return { code: 0, json: {} };
    };
    const chat = installCoreWakeChat(pi, {}, { pollMs: 5, command: ["walkr-core"], run });
    for (const handler of handlers.session_start || []) await handler({}, ctx);
    const connecting = chat.execute({ action: "connect", target: TARGET }, ctx);
    await until(() => bind, "the connect");
    const navigated = Promise.all((handlers[event] || []).map((handler) => handler({}, ctx)));
    bind({ code: 0, json: { wake: { bound_to_caller: true } } });
    await assert.rejects(connecting, /session changed/);
    await navigated;
    assert.deepEqual(calls.filter((args) => args[0] !== "connect"), [["disconnect", TARGET, ...OWN]], "the late binding is released, and no watcher reads status");
    assert.equal((await chat.execute({ action: "status" }, ctx)).active, false);
  });
}

// The event runs `ticks` microtasks after the connect resolves: on each side of the stale check and of the publication.
for (const [path, event] of [["navigates", "session_before_switch"], ["shuts down", "session_shutdown"]]) {
  test(`a session that ${path} in the microtasks after the connect resolves leaves one release and no watcher`, async () => {
    for (let ticks = 0; ticks <= 8; ticks++) {
      const handlers = {}, calls = [];
      let bind;
      const pi = { on: (name, handler) => { (handlers[name] ||= []).push(handler); }, registerTool() {}, registerCommand() {}, sendMessage() {}, appendEntry() {} };
      const ctx = { mode: "tui", sessionManager: { getSessionId: () => "chat-x", getSessionFile: () => "/sessions/x.jsonl", getEntries: () => [] } };
      const run = async (_command, args) => {
        calls.push(args);
        if (args[0] === "connect") return new Promise((resolve) => { bind = resolve; });
        return args[0] === "status" ? idle : { code: 0, json: {} };
      };
      const chat = installCoreWakeChat(pi, {}, { pollMs: 1000, command: ["walkr-core"], run });
      for (const handler of handlers.session_start || []) await handler({}, ctx);
      const connecting = chat.execute({ action: "connect", target: TARGET }, ctx).catch((error) => error);
      await until(() => bind, "the connect");
      let navigated;
      let fire = () => { navigated = Promise.all((handlers[event] || []).map((handler) => handler({}, ctx))); };
      for (let i = 0; i < ticks; i++) { const next = fire; fire = () => queueMicrotask(next); }
      bind({ code: 0, json: { wake: { bound_to_caller: true } } });
      queueMicrotask(fire);
      try {
        await connecting;
        await until(() => navigated, "the event");
        await navigated;
        await delay(10);
        assert.deepEqual(calls.filter((args) => args[0] === "disconnect"), [["disconnect", TARGET, ...OWN]], `one release after ${ticks} microtasks`);
        assert.equal((await chat.execute({ action: "status" }, ctx)).active, false, `no watcher after ${ticks} microtasks`);
      } finally { chat.stop(); }
    }
  });
}

test("a watcher whose binding moved to another chat stops without releasing that chat's binding", async () => {
  const c = await fakeChat(() => ({ code: 0, json: { status: "idle", batch_id: null, wake: { bound_to_caller: false } } }));
  await until(() => c.sent.some((s) => JSON.parse(s.message.content).status === "binding_lost"), "binding_lost");
  await delay(30);
  assert.deepEqual(c.releases(), []);
});

test("no wake while a poll is attached; a later read wakes once, after the server grants the claim", async () => {
  let listening = true;
  const waiting = () => ({ code: 0, json: { status: "feedback-waiting", batch_id: BATCH, collected: false, agent_listening: listening, wake: { bound_to_caller: true } } });
  const c = await fakeChat((verb) => (verb === "claim-wake" ? { code: 0, json: { claimed: true, batch_id: BATCH } } : waiting()));
  await delay(60);
  assert.deepEqual([c.wakes().length, c.calls.filter((a) => a[0] === "claim-wake").length], [0, 0], "an attached poll collects the batch itself");
  listening = false;
  await until(() => c.wakes().length === 1, "the wake");
  await delay(60);
  assert.equal(c.wakes().length, 1);
  assert.deepEqual(c.calls.filter((a) => a[0] === "claim-wake"), [["claim-wake", TARGET, "--batch-id", BATCH, ...OWN]]);
  await c.emit("session_shutdown");
});

test("a claim that the server refuses as already woken never wakes this process", async () => {
  const c = await fakeChat((verb) => (verb === "claim-wake"
    ? { code: 1, json: { claimed: false, batch_id: BATCH, reason: "already_woken" } }
    : { code: 0, json: { status: "feedback-waiting", batch_id: BATCH, collected: false, agent_listening: false, wake: { bound_to_caller: true } } }));
  await until(() => c.calls.some((a) => a[0] === "claim-wake"), "the claim");
  await delay(60);
  assert.equal(c.wakes().length, 0);
  assert.equal(c.sent.some((s) => s.message.content && JSON.parse(s.message.content).status === "failed"), false, "the watcher keeps running");
  await c.emit("session_shutdown");
});

test("claims that keep failing with no JSON stop the watcher, with no wake, and release the binding", async () => {
  const waiting = { code: 0, json: { status: "feedback-waiting", batch_id: BATCH, collected: false, agent_listening: false, wake: { bound_to_caller: true } } };
  const c = await fakeChat((verb) => (verb === "claim-wake" ? { code: 1, json: null, stderr: "unknown command claim-wake" } : waiting));
  await until(() => c.sent.some((s) => s.message.content && JSON.parse(s.message.content).status === "failed"), "the failed stop");
  assert.equal(c.wakes().length, 0);
  assert.deepEqual(c.releases(), [["disconnect", TARGET, ...OWN]]);
});

test("the interval stays well inside the 120-second lease", async () => {
  const handlers = {};
  const pi = { on: (name, handler) => { (handlers[name] ||= []).push(handler); }, registerTool() {}, registerCommand() {}, sendMessage() {}, appendEntry() {} };
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "chat-x", getSessionFile: () => "/sessions/x.jsonl", getEntries: () => [] } };
  const chat = installCoreWakeChat(pi, {}, { command: ["walkr-core"], run: async () => ({ code: 0, json: { wake: { bound_to_caller: true } } }) });
  for (const handler of handlers.session_start || []) await handler({}, ctx);
  await assert.rejects(chat.execute({ action: "connect", target: TARGET, intervalSeconds: 11 }, ctx), /from 1 to 10/);
});

test("normal claim races never stop a healthy watcher; they reset the no-JSON count", async () => {
  let n = 0;
  const waiting = () => ({ code: 0, json: { status: "feedback-waiting", batch_id: `batch-${String(n).padStart(16, "0")}`, collected: false, agent_listening: false, wake: { bound_to_caller: true } } });
  // Four stalled claims, then a JSON race refusal, then four more stalled claims: never five in a row.
  const answers = [null, null, null, null, "not_waiting", null, null, null, null, "poll_attached", "not_waiting"];
  const c = await fakeChat((verb) => {
    if (verb !== "claim-wake") return waiting();
    const reason = answers[n++] ?? "poll_attached";
    return reason ? { code: 1, json: { claimed: false, reason } } : { code: 1, json: null, stderr: "timed out" };
  });
  await until(() => n >= answers.length + 3, "the claims");
  assert.equal(c.sent.some((s) => s.message.content && JSON.parse(s.message.content).status === "failed"), false);
  assert.equal(c.wakes().length, 0);
  await c.emit("session_shutdown");
});
