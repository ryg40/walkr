import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fixture, listen } from "./double-fixtures.js";
import { SERVER_PROTOCOL } from "../src/paths.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { createDoubleSessionChatClient } from "../src/double-session-chat-client.js";
import { SESSION_MESSAGE } from "../src/double-session-chat.js";
import { installSharedGuiChat } from "../src/shared-gui-chat.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Hold a real authenticated client result. Ignoring abort until release exercises
// late success/failure as well as immediate cancellation of the arming record.
function gate(client, method, { fail = false } = {}) {
  const entered = deferred(), released = deferred(), aborted = deferred();
  const original = client[method];
  let pending = true;
  client[method] = async (...args) => {
    const answer = await original(...args);
    if (pending) {
      pending = false;
      const signal = args.at(-1);
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await released.promise;
      if (fail) throw new Error("Delayed client failure");
    }
    return answer;
  };
  return { entered: entered.promise, aborted: aborted.promise, release: released.resolve };
}

async function setup(t, options = {}) {
  const gates = [], tasks = [];
  let gui, emit;
  t.after(async () => {
    for (const hold of gates) hold.release();
    await gui?.stop();
    await emit?.("session_shutdown");
    await Promise.allSettled(tasks);
  });
  const f = await fixture(t), s = await listen(t, f);
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ protocol: SERVER_PROTOCOL, port: s.port, token: s.token }), { mode: 0o600 });
  const env = { HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir, HUMAN_REVIEW_HOSTED: "0" };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const handlers = new Map(), tools = new Map(), entries = [], sent = [];
  const sessionFile = path.join(f.root, "pi-origin.jsonl"), sessionId = "pi-origin";
  const ctx = { mode: "tui", sessionManager: {
    getSessionId: () => sessionId, getSessionFile: () => sessionFile,
    getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null,
    getEntry: (id) => entries.find((entry) => entry.id === id),
  } };
  function append(entry) {
    entries.push({ id: `pi-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), ...structuredClone(entry) });
    writeFileSync(sessionFile, [{ type: "session", version: 3, id: sessionId }, ...entries].map(JSON.stringify).join("\n") + "\n");
  }
  const delivered = deferred(), acknowledged = deferred();
  const pi = {
    on(name, callback) { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    sendMessage(message) {
      append({ type: "custom_message", ...message });
      if (message.customType === SESSION_MESSAGE) { sent.push(message); delivered.resolve(); }
    },
  };
  emit = async (name) => { await Promise.all((handlers.get(name) ?? []).map((fn) => fn({}, ctx))); };
  let nextGate;
  gui = installSharedGuiChat(pi, {}, { pollMs: 20, acceptanceCheckMs: 5, ...options,
    clientFactory: () => {
      const client = createDoubleSessionChatClient(env);
      const ack = client.acknowledge;
      client.acknowledge = async (...args) => { const result = await ack(...args); acknowledged.resolve(); return result; };
      if (nextGate) { nextGate(client); nextGate = null; }
      return client;
    },
  });
  await emit("session_start");
  const post = async (route, body) => {
    const answer = await s.api(route, { method: "POST", body });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    return answer.json;
  };
  const origin = { piSessionId: sessionId, piSessionFile: sessionFile };
  let sequence = 0;
  async function savedSession({ ended = true } = {}) {
    const start = await post("/api/double/gui/start", { actionId: `start-${sequence++}`, mode: "double", brief: "Disposable race fixture" });
    const id = start.view.sessionId, root = `/api/double/sessions/${encodeDoubleComparisonId(id)}`;
    if (ended) {
      const attached = await post(root + "/attach", { actionId: `attach-${sequence++}`, requestId: start.view.generation.requestId,
        attemptId: start.view.generation.attempt.id, manifest: { ...f.manifest, comparisonId: `pair-${sequence++}` } });
      await post(root + "/end", { actionId: `end-${sequence++}`, expectedRevision: attached.view.revision,
        comparisonId: attached.view.currentComparisonId, pane: "left" });
    }
    return { id, root };
  }
  const execute = (params) => gui.execute(params, ctx);
  return { f, s, origin, post, savedSession, sent, emit, execute, delivered: delivered.promise, acknowledged: acknowledged.promise,
    connect(seconds = 30) {
      const task = execute({ action: "connect", timeoutSeconds: seconds });
      tasks.push(task); task.catch(() => {});
      return task;
    },
    hold(method, options) {
      const ready = deferred();
      nextGate = (client) => { const hold = gate(client, method, options); gates.push(hold); ready.resolve(hold); };
      return ready.promise;
    },
    startListener(id) {
      const task = tools.get("double_session_chat").execute("start", { action: "start", doubleSessionId: id }, null, null, ctx)
        .then((result) => result.details);
      tasks.push(task); task.catch(() => {});
      return task;
    },
    async cancelListener(id) {
      return (await tools.get("double_session_chat").execute("cancel", { action: "cancel", doubleSessionId: id }, null, null, ctx)).details;
    },
    async listener(id) {
      return (await tools.get("double_session_chat").execute("status", { action: "status", doubleSessionId: id }, null, null, ctx)).details;
    },
  };
}

async function seedFinal(h) {
  const lease = await h.post("/api/double/gui/connect", h.origin);
  const saved = await h.savedSession();
  await h.post("/api/double/gui/disconnect", { leaseId: lease.leaseId });
  return saved;
}

for (const method of ["connect", "events", "view"]) {
  test(`disconnect cancels real listener startup during ${method}; explicit same-chat reconnect delivers the saved final`, { timeout: 10000 }, async (t) => {
    const h = await setup(t), saved = await seedFinal(h);
    const holding = h.hold(method), starting = h.connect(), hold = await holding;
    await hold.entered;
    await h.execute({ action: "disconnect" });
    assert.equal((await h.listener(saved.id)).active, false, "disconnect must cancel the arming adapter immediately");
    hold.release();
    const old = await starting;
    assert.equal(old.active, false);
    assert.equal((await h.listener(saved.id)).active, false);
    assert.equal(h.sent.length, 0, "cancelled startup must not dispatch the pending final");
    assert.equal((await h.s.api(saved.root + "/events")).json.pending.length, 2);
    const reconnected = await h.connect();
    assert.equal(reconnected.active, true);
    assert.deepEqual(reconnected.origin, h.origin);
    await h.acknowledged;
    assert.equal(h.sent.length, 1, "only the final is delivered; historical generation is not replayed");
    const packet = JSON.parse(h.sent[0].content.split("\n").at(-1));
    assert.deepEqual(packet.output, (await h.s.api(saved.root + "/output")).json);
    await h.f.unchanged(assert);
  });
}

for (const fail of [false, true]) {
  test(`old startup ${fail ? "failure" : "completion"} cannot stop a newer connection or listener`, { timeout: 10000 }, async (t) => {
    const h = await setup(t), saved = await seedFinal(h);
    const holding = h.hold("events", { fail }), starting = h.connect(), hold = await holding;
    await hold.entered;
    await h.execute({ action: "disconnect" });
    const newer = await h.connect();
    assert.equal(newer.active, true);
    await h.acknowledged;
    hold.release();
    assert.equal((await starting).active, false, "old connect must not report the new connection as its own success");
    assert.equal((await h.execute({ action: "status" })).active, true);
    assert.equal((await h.listener(saved.id)).active, true);
    assert.equal((await h.s.api("/api/double/gui")).json.connection.connected, true);
    assert.equal(h.sent.length, 1);
  });
}

for (const termination of ["expiry", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree"]) {
  test(`${termination} cancels pending listener startup without final dispatch`, { timeout: 10000 }, async (t) => {
    const h = await setup(t), saved = await seedFinal(h);
    const holding = h.hold("view"), starting = h.connect(termination === "expiry" ? 0.5 : 30), hold = await holding;
    await hold.entered;
    if (termination === "expiry") await hold.aborted; else await h.emit(termination);
    hold.release();
    await starting;
    assert.equal((await h.execute({ action: "status" })).active, false);
    assert.equal(h.sent.length, 0);
    // Shutdown clears the adapter context; session_start permits status inspection only.
    if (termination === "session_shutdown") await h.emit("session_start");
    assert.equal((await h.listener(saved.id)).active, false);
  });
}

test("failed fresh startup disconnects and explicit reconnect requires recovery instead of historical generation", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  await h.connect();
  const holding = h.hold("events", { fail: true });
  const saved = await h.savedSession({ ended: false }), hold = await holding;
  await hold.entered;
  const disconnected = deferred();
  h.s.server.on("request", (req) => { if (req.url === "/api/double/gui/disconnect") disconnected.resolve(); });
  hold.release();
  await disconnected.promise;
  assert.equal((await h.execute({ action: "status" })).active, false, "startup failure stops its owning GUI connection");
  assert.equal((await h.listener(saved.id)).active, false);
  assert.equal((await h.connect()).active, true);
  assert.ok((await h.listener(saved.id)).recoveryRequired);
  assert.equal(h.sent.length, 0);
});

test("status cannot report a connection that disconnects during its awaited listener read", { timeout: 10000 }, async (t) => {
  const h = await setup(t), saved = await seedFinal(h);
  await h.connect();
  await h.acknowledged;
  const reading = h.execute({ action: "status" });
  const stopping = h.execute({ action: "disconnect" });
  assert.equal((await reading).active, false);
  await stopping;
  assert.equal((await h.listener(saved.id)).active, false);
});

test("ownership: rejected GUI start preserves an independently armed listener", { timeout: 10000 }, async (t) => {
  const h = await setup(t), saved = await seedFinal(h);
  assert.equal((await h.startListener(saved.id)).active, true);
  await h.acknowledged;
  await assert.rejects(h.connect(), /GUI listener failed/);
  assert.equal((await h.listener(saved.id)).active, true, "GUI failure must not cancel a preexisting listener");
  assert.equal(h.sent.length, 1);
});

test("ownership: rejected GUI start preserves an independently arming listener", { timeout: 10000 }, async (t) => {
  const h = await setup(t), saved = await seedFinal(h);
  const holding = h.hold("events"), starting = h.startListener(saved.id), hold = await holding;
  await hold.entered;
  await assert.rejects(h.connect(), /GUI listener failed/);
  const arming = await h.listener(saved.id);
  assert.equal(arming.active, true, "GUI failure must not cancel another caller's startup");
  assert.equal(arming.status, "arming");
  hold.release();
  assert.equal((await starting).active, true);
  await h.acknowledged;
  assert.equal(h.sent.length, 1);
});

for (const termination of ["disconnect", "startup-failure"]) {
  test(`ownership: ${termination} preserves an independent replacement during GUI startup`, { timeout: 10000 }, async (t) => {
    const h = await setup(t), saved = await seedFinal(h);
    const holding = h.hold("events", { fail: termination === "startup-failure" });
    const starting = h.connect(), hold = await holding;
    await hold.entered;
    assert.equal((await h.cancelListener(saved.id)).active, false);
    assert.equal((await h.startListener(saved.id)).active, true);
    await h.acknowledged;
    if (termination === "disconnect") await h.execute({ action: "disconnect" });
    hold.release();
    if (termination === "disconnect") assert.equal((await starting).active, false);
    else await assert.rejects(starting, /GUI listener failed/);
    assert.equal((await h.listener(saved.id)).active, true, "cleanup must target the acquired record, not its session ID");
    assert.equal(h.sent.length, 1, "only the independent replacement delivers the saved final");
  });
}

test("ownership: independently rearmed fresh GUI work requires recovery, never historical generation", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  await h.connect();
  const holding = h.hold("events");
  const saved = await h.savedSession({ ended: false }), hold = await holding;
  await hold.entered;
  await h.cancelListener(saved.id);
  const replacement = await h.startListener(saved.id);
  assert.equal(replacement.active, true);
  assert.ok(replacement.recoveryRequired, "freshness belongs to the GUI's acquired record, not a session ID");
  await h.execute({ action: "disconnect" });
  hold.release();
  assert.equal((await h.listener(saved.id)).active, true);
  assert.equal(h.sent.length, 0);
  await h.cancelListener(saved.id);
  assert.equal((await h.connect()).active, true);
  assert.ok((await h.listener(saved.id)).recoveryRequired);
  assert.equal(h.sent.length, 0, "explicit reconnect does not replay interrupted generation");
});

test("ownership: GUI disconnect preserves an independent replacement of its waiting listener", { timeout: 10000 }, async (t) => {
  const h = await setup(t), saved = await seedFinal(h);
  await h.connect();
  await h.acknowledged;
  await h.cancelListener(saved.id);
  const holding = h.hold("events"), replacement = h.startListener(saved.id), hold = await holding;
  await hold.entered;
  await h.execute({ action: "disconnect" });
  assert.equal((await h.listener(saved.id)).active, true);
  hold.release();
  assert.equal((await replacement).active, true);
  assert.equal(h.sent.length, 1, "an already acknowledged final is not replayed");
});
