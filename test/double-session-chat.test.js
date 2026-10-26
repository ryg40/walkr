import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, listen, digest } from "./double-fixtures.js";
import { SERVER_PROTOCOL } from "../src/paths.js";
import { createDoubleSessionChatClient } from "../src/double-session-chat-client.js";
import { installDoubleSessionChat, SESSION_MESSAGE } from "../src/double-session-chat.js";
import { ReceiptLimitError } from "../src/double-chat-receipt.js";

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for Double session chat");
}

async function setup(t, largeFinal = false) {
  let closeChat;
  t.after(() => closeChat?.()); // Stop the writer before fixture directory cleanup, including failed assertions.
  const f = await fixture(t), s = await listen(t, f);
  f.setChatCleanup = (callback) => { closeChat = callback; };
  if (largeFinal) {
    const file = path.join(f.manifest.panes.left.copy.root, "assets/image.png");
    const bytes = Buffer.alloc(220000, 42);
    await fs.writeFile(file, bytes); // Opaque supported asset; no original changes.
    f.hashes.set(file, digest(bytes));
  }
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ protocol: SERVER_PROTOCOL, port: s.port, token: s.token }), { mode: 0o600 });
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir, HUMAN_REVIEW_HOSTED: "0" };
  const root = "/api/double/sessions/~design";
  assert.equal((await s.api("/api/double/sessions", { method: "POST", body: { sessionId: "design", brief: "  Keep useful designs.  ", manifest: f.manifest } })).status, 200);
  const client = createDoubleSessionChatClient(env);
  const view = async () => (await s.api(root)).json.view;
  const events = async () => (await s.api(root + "/events")).json;
  let seq = 0;
  const mutate = async (op, body = {}) => {
    const v = await view();
    const request = { actionId: `test-${seq++}`, ...(["next", "actions", "end"].includes(op)
      ? { expectedRevision: v.revision, comparisonId: v.currentComparisonId } : {}), ...body };
    const answer = await s.api(root + "/" + op, { method: "POST", body: request });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    return { ...answer.json, request };
  };
  return { f, s, env, client, view, events, mutate, root };
}

function harness(t, f, client, options = {}) {
  const handlers = new Map(), sent = [], entries = [];
  let sessionId = "pi-origin", sessionFile = path.join(f.root, "pi-origin.jsonl");
  let persistEnabled = true, drop = false;
  const ctx = { mode: "tui", sessionManager: {
    getSessionId: () => sessionId, getSessionFile: () => sessionFile,
    getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null,
    getEntry: (id) => entries.find((entry) => entry.id === id),
  } };
  function persist() {
    writeFileSync(sessionFile, [{ type: "session", version: 3, id: sessionId }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  function append(entry) {
    entries.push({ id: `pi-${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...structuredClone(entry) });
    if (persistEnabled) persist();
  }
  const pi = {
    on: (name, callback) => handlers.set(name, callback), registerTool() {}, registerCommand() {},
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    sendMessage(message, opts) {
      if (message.customType === SESSION_MESSAGE) {
        sent.push({ message, opts, sessionId });
        if (drop) return;
      }
      append({ type: "custom_message", ...message });
    },
  };
  let installed;
  function load() {
    handlers.get("session_shutdown")?.({}, ctx);
    handlers.clear();
    // Successful full-disk scans use the runtime's existing receipt budget.
    // Only deliberate failure fixtures below opt into the 150 ms deadline.
    installed = installDoubleSessionChat(pi, {}, { clientFactory: () => client, pollMs: 10,
      acceptanceCheckMs: 5, ...options });
    handlers.get("session_start")({}, ctx);
  }
  load();
  f.setChatCleanup(() => handlers.get("session_shutdown")({}, ctx));
  const execute = (params) => installed.execute({ doubleSessionId: "design", ...params }, ctx);
  return { ctx, sent, entries, load, persist, handlers, execute,
    start: () => execute({ action: "start", timeoutSeconds: 10 }), status: () => execute({ action: "status" }),
    setPersistence: (value) => { persistEnabled = value; }, setDrop: (value) => { drop = value; },
    switchIdentity() { sessionId = "another-pi"; sessionFile = path.join(f.root, "another-pi.jsonl"); },
  };
}
const eventPacket = (sent) => JSON.parse(sent.message.content.split("\n").at(-1));
const eventStatus = async (h, id) => (await h.status()).events.find((e) => e.eventId === id);

test("pending persistence and uncertain ack do not suppress later Retry/final; exact receipts recover without redelivery", async (t) => {
  const { f, s, client, view, events, mutate, root } = await setup(t);
  const ack = client.acknowledge, requests = [];
  let loseAck = false;
  client.acknowledge = async (...args) => {
    requests.push(structuredClone(args[1]));
    const answer = await ack(...args);
    if (loseAck) { loseAck = false; throw new Error("Lost response after commit"); }
    return answer;
  };
  let finalScan = false, delayedScan;
  const h = harness(t, f, client, { receiptIO: {
    async stat(...args) {
      const result = await fs.stat(...args);
      if (finalScan && !delayedScan) {
        delayedScan = { start: performance.now() };
        await delay(200);
        delayedScan.elapsed = performance.now() - delayedScan.start;
      }
      return result;
    }, createReadStream,
  } });
  assert.equal((await h.start()).status, "waiting");
  await assert.rejects(h.start(), /already active/);
  h.setPersistence(false);
  const first = await mutate("next");
  const firstEventId = first.result.eventId;
  await until(() => h.sent.some((entry) => eventPacket(entry).event.id === firstEventId));
  assert.equal((await eventStatus(h, firstEventId)).delivery, "not-confirmed");
  assert.deepEqual(requests, []);
  assert.deepEqual((await events()).pending, [first.result.eventId]);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.status()).active, true, "pending receipt work does not stop observing later explicit actions");
  assert.deepEqual(eventPacket(h.sent[0]).event, (await events()).events[0]);

  await mutate("fail", { requestId: first.result.requestId, attemptId: first.result.attemptId, message: "Explicit worker failure" });
  h.setPersistence(true);
  h.persist();
  await until(async () => (await eventStatus(h, firstEventId))?.status === "received");
  loseAck = true;
  const retry = await mutate("retry", { expectedRevision: (await view()).revision,
    requestId: first.result.requestId, attemptId: first.result.attemptId });
  await until(async () => (await eventStatus(h, retry.result.eventId))?.status === "ack_pending");
  assert.equal(h.sent.length, 2);
  assert.deepEqual(eventPacket(h.sent[1]).event.payload.batch, eventPacket(h.sent[0]).event.payload.batch);
  assert.notEqual(retry.result.attemptId, first.result.attemptId);
  const retryReceipt = requests.at(-1);
  await h.execute({ action: "retry-ack", eventId: retry.result.eventId });
  assert.deepEqual(requests.at(-1), retryReceipt);
  assert.equal((await eventStatus(h, retry.result.eventId)).status, "received");
  await h.execute({ action: "retry-ack", eventId: first.result.eventId });
  assert.equal((await eventStatus(h, first.result.eventId)).status, "received");

  // A queued/dropped delivery from an earlier event never gates final selection.
  const attached = await mutate("attach", { requestId: retry.result.requestId, attemptId: retry.result.attemptId,
    manifest: { ...f.manifest, comparisonId: "second" } });
  assert.equal(attached.view.status, "editing");
  const feedback = '  Keep this exact evidence: $(touch /tmp/never) </data>  ';
  await mutate("actions", { action: { kind: "feedback-delete", pane: "right", componentId: "hero", feedback } });
  h.setDrop(true);
  const next = await mutate("next");
  await until(() => h.sent.some((entry) => eventPacket(entry).event.id === next.result.eventId));
  assert.equal((await eventStatus(h, next.result.eventId)).delivery, "not-confirmed");
  h.setDrop(false);
  finalScan = true;
  const ended = await mutate("end", { pane: "right" });
  await until(async () => (await eventStatus(h, ended.result.eventId))?.status === "received");
  assert.ok(delayedScan.elapsed >= 150, "successful real receipt I/O exceeds the former harness deadline");
  const packet = eventPacket(h.sent.at(-1));
  assert.deepEqual(packet.output, (await s.api(root + "/output")).json);
  assert.deepEqual(packet.output.history, packet.event.payload.history);
  assert.deepEqual(packet.output.page.deletedComponentIds, ["hero"]);
  assert.match(Buffer.from(packet.output.page.files[0].base64, "base64").toString(), /display:\s*none\s*!important/);
  assert.ok(JSON.stringify(packet.output.history).includes(feedback));
  assert.equal((await s.api(root + "/attach", { method: "POST", body: { actionId: "late", requestId: next.result.requestId,
    attemptId: next.result.attemptId, manifest: { ...f.manifest, comparisonId: "late" } } })).status, 409);
  assert.deepEqual((await events()).pending, [next.result.eventId]);
  assert.equal((await view()).final.pane, "right");
  assert.equal(h.sent.length, 4, "duplicate observations cannot generate another packet");
  const persisted = (await fs.readFile(h.ctx.sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
  const finalMessage = h.sent.at(-1).message;
  const finalEntry = persisted.find((entry) => entry.customType === SESSION_MESSAGE && entry.details.eventId === ended.result.eventId);
  assert.equal(finalEntry.content, finalMessage.content);
  assert.deepEqual(finalEntry.details, finalMessage.details);
  assert.equal(persisted.some((entry) => entry.customType === SESSION_MESSAGE && entry.details.eventId === next.result.eventId), false);
  assert.equal(requests.some((receipt) => receipt.eventId === next.result.eventId), false);
  assert.deepEqual(requests.at(-1), { actionId: finalMessage.details.actionId, eventId: ended.result.eventId });
  assert.equal(h.sent.filter((entry) => eventPacket(entry).event.id === next.result.eventId).length, 1);
  assert.ok(!JSON.stringify(h.sent).includes(s.token));
  await f.unchanged(assert);
});

test("short failure-only receipt budget preserves missing and dropped events and rejects delayed real disk proof", async (t) => {
  for (const mode of ["missing persistence", "dropped message", "delayed final scan"]) {
    await t.test(mode, async (t) => {
      const { f, s, client, events, mutate, root } = await setup(t);
      const ack = client.acknowledge, readEvents = client.events, acknowledgments = [];
      let observations = 0;
      client.acknowledge = async (...args) => { acknowledgments.push(args[1]); return ack(...args); };
      client.events = async (...args) => { const result = await readEvents(...args); observations++; return result; };
      let release, heldAt;
      const h = harness(t, f, client, { deliveryTimeoutMs: 150, receiptIO: {
        async stat(...args) {
          const result = await fs.stat(...args);
          if (mode === "delayed final scan" && !release) {
            heldAt = performance.now();
            await new Promise((resolve) => { release = resolve; });
          }
          return result;
        }, createReadStream,
      } });
      try {
        await h.start();
        h.setPersistence(mode !== "missing persistence");
        h.setDrop(mode === "dropped message");
        const result = await mutate(mode === "delayed final scan" ? "end" : "next", mode === "delayed final scan" ? { pane: "left" } : {});
        const eventId = result.result.eventId;
        if (mode === "delayed final scan") {
          await until(() => release);
          await delay(200);
        }
        await until(async () => (await eventStatus(h, eventId))?.status === "failed_delivery");
        const state = await eventStatus(h, eventId);
        assert.equal(state.delivery, "not-confirmed");
        assert.equal(state.acknowledgment, "not-attempted");
        assert.deepEqual(acknowledgments, []);
        assert.deepEqual((await events()).pending, [eventId]);
        assert.equal(h.sent.length, 1);
        assert.deepEqual(eventPacket(h.sent[0]).event, (await events()).events[0]);
        if (mode === "missing persistence") {
          await assert.rejects(fs.stat(h.ctx.sessionManager.getSessionFile()), { code: "ENOENT" });
        } else {
          const persisted = (await fs.readFile(h.ctx.sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
          const entry = persisted.find((entry) => entry.customType === SESSION_MESSAGE && entry.details.eventId === eventId);
          if (mode === "dropped message") {
            assert.equal(entry, undefined);
          } else {
            assert.ok(release, "real stat completed but its result remains withheld");
            assert.ok(performance.now() - heldAt >= 150, "real receipt I/O exceeds the short deadline");
            assert.equal(entry.content, h.sent[0].message.content);
            assert.deepEqual(entry.details, h.sent[0].message.details);
            assert.deepEqual(eventPacket(h.sent[0]).output, (await s.api(root + "/output")).json);
          }
        }
        release?.();
        const before = observations;
        await until(() => observations >= before + 3);
        assert.equal((await eventStatus(h, eventId)).status, "failed_delivery");
        assert.equal(h.sent.length, 1, "later observations never redeliver a failed event");
        assert.deepEqual(acknowledgments, []);
        assert.deepEqual((await events()).pending, [eventId]);
        await f.unchanged(assert);
      } finally { release?.(); await h.execute({ action: "cancel" }); }
    });
  }
});

function refuseOneReceipt() {
  let refused = false;
  return { get refused() { return refused; }, io: {
    async stat(...args) {
      // A terminal receipt I/O refusal, not a short deadline for later successful scans.
      if (!refused) { refused = true; throw new ReceiptLimitError("Injected receipt I/O refusal"); }
      return fs.stat(...args);
    }, createReadStream,
  } };
}

async function assertPersistedPacket(h, sent) {
  const persisted = (await fs.readFile(h.ctx.sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(persisted[0], { type: "session", version: 3, id: h.ctx.sessionManager.getSessionId() });
  let id = h.ctx.sessionManager.getLeafId();
  const ancestors = [];
  while (id !== null) {
    assert.ok(!ancestors.some((entry) => entry.id === id), "persisted ancestry has no cycle");
    const entry = persisted.slice(1).find((entry) => entry.id === id);
    assert.ok(entry, "each live ancestor exists in the real JSONL file");
    assert.deepEqual(entry, h.ctx.sessionManager.getEntry(id));
    ancestors.push(entry);
    id = entry.parentId;
  }
  const entry = ancestors.find((entry) => entry.customType === SESSION_MESSAGE && entry.details.eventId === sent.message.details.eventId);
  assert.ok(entry, "exact receipt belongs to the persisted current branch");
  assert.equal(entry.content, sent.message.content);
  assert.deepEqual(entry.details, sent.message.details);
  assert.equal(entry.details.packetHash, digest(JSON.stringify(eventPacket(sent))));
}

test("terminal failed_delivery does not block owner Retry or final delivery on the same live listener", async (t) => {
  const { f, s, client, view, events, mutate, root } = await setup(t);
  const ack = client.acknowledge, requests = [], results = [], failure = refuseOneReceipt();
  client.acknowledge = async (...args) => {
    requests.push(structuredClone(args[1]));
    const answer = await ack(...args);
    results.push(answer.result);
    return answer;
  };
  const h = harness(t, f, client, { receiptIO: failure.io });
  await h.start();
  const first = await mutate("next"), firstId = first.result.eventId;
  await until(async () => (await eventStatus(h, firstId))?.status === "failed_delivery");
  assert.equal(failure.refused, true);
  const failedState = await eventStatus(h, firstId);
  assert.equal(failedState.delivery, "not-confirmed");
  assert.equal(failedState.acknowledgment, "not-attempted");
  assert.equal((await h.status()).active, true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(requests, []);
  assert.deepEqual((await events()).pending, [firstId]);
  assert.deepEqual(eventPacket(h.sent[0]).event, (await events()).events[0]);
  await assertPersistedPacket(h, h.sent[0]);

  await mutate("fail", { requestId: first.result.requestId, attemptId: first.result.attemptId, message: "Explicit worker failure" });
  const retry = await mutate("retry", { expectedRevision: (await view()).revision,
    requestId: first.result.requestId, attemptId: first.result.attemptId });
  await until(async () => (await eventStatus(h, retry.result.eventId))?.status === "received");
  assert.equal((await h.status()).active, true);
  assert.deepEqual(await eventStatus(h, firstId), failedState);
  assert.equal(h.sent.length, 2);
  assert.notEqual(retry.result.attemptId, first.result.attemptId);
  assert.deepEqual(eventPacket(h.sent[1]).event, (await events()).events[1]);
  assert.deepEqual(eventPacket(h.sent[1]).event.payload.batch, eventPacket(h.sent[0]).event.payload.batch);
  await assertPersistedPacket(h, h.sent[1]);
  const retryAck = { actionId: h.sent[1].message.details.actionId, eventId: retry.result.eventId };
  assert.deepEqual(requests, [retryAck]);
  assert.deepEqual((await events()).pending, [firstId]);

  await mutate("attach", { requestId: retry.result.requestId, attemptId: retry.result.attemptId,
    manifest: { ...f.manifest, comparisonId: "after-failed-delivery" } });
  const feedback = "  Preserve exact failure-recovery feedback.  ";
  await mutate("actions", { action: { kind: "feedback-delete", pane: "right", componentId: "hero", feedback } });
  const ended = await mutate("end", { pane: "right" });
  await until(async () => (await eventStatus(h, ended.result.eventId))?.status === "received");
  assert.equal((await h.status()).active, true);
  assert.deepEqual(await eventStatus(h, firstId), failedState);
  assert.equal(h.sent.length, 3, "each event dispatches exactly once, including the failed event");
  const final = h.sent[2], packet = eventPacket(final), envelope = await events();
  assert.deepEqual(packet.event, envelope.events[2]);
  assert.deepEqual(packet.output, (await s.api(root + "/output")).json);
  assert.deepEqual(packet.output.history, packet.event.payload.history);
  assert.ok(JSON.stringify(packet.output.history).includes(feedback));
  assert.deepEqual(packet.output.page.deletedComponentIds, ["hero"]);
  for (const file of packet.output.page.files) {
    const bytes = Buffer.from(file.base64, "base64");
    assert.equal(digest(bytes), file.sha256);
    if (file.path === "index.html") assert.match(bytes.toString(), /display:\s*none\s*!important/);
    else assert.deepEqual(bytes, await fs.readFile(path.join(f.manifest.panes.right.copy.root, file.path)));
  }
  await assertPersistedPacket(h, final);
  const finalAck = { actionId: final.message.details.actionId, eventId: ended.result.eventId };
  assert.deepEqual(requests, [retryAck, finalAck]);
  assert.deepEqual(results.map(({ kind, actionId, eventId }) => ({ kind, actionId, eventId })),
    [{ kind: "ack", ...retryAck }, { kind: "ack", ...finalAck }]);
  assert.deepEqual(envelope.acknowledgments.map(({ eventId }) => eventId), [retry.result.eventId, ended.result.eventId]);
  assert.deepEqual(envelope.pending, [firstId]);
  assert.deepEqual(h.sent.map((sent) => eventPacket(sent).event.id), [firstId, retry.result.eventId, ended.result.eventId]);
  assert.ok(!JSON.stringify(h.sent).includes(s.token));
  await f.unchanged(assert);
});

test("retry-ack recovers failed_delivery only after exact persistence returns without another message", async (t) => {
  const { f, client, events, mutate } = await setup(t);
  const ack = client.acknowledge, readEvents = client.events, requests = [], results = [], failure = refuseOneReceipt();
  let observations = 0, scans = 0;
  client.acknowledge = async (...args) => {
    requests.push(structuredClone(args[1]));
    const answer = await ack(...args);
    results.push(answer.result);
    return answer;
  };
  client.events = async (...args) => { const result = await readEvents(...args); observations++; return result; };
  const h = harness(t, f, client, { receiptIO: { ...failure.io,
    createReadStream(...args) { scans++; return createReadStream(...args); },
  } });
  await h.start();
  h.setPersistence(false);
  const first = await mutate("next"), eventId = first.result.eventId;
  await until(async () => (await eventStatus(h, eventId))?.status === "failed_delivery");
  assert.equal(failure.refused, true);
  const failedState = await eventStatus(h, eventId);
  assert.equal(failedState.delivery, "not-confirmed");
  assert.equal(failedState.acknowledgment, "not-attempted");
  assert.equal((await h.status()).active, true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(eventPacket(h.sent[0]).event, (await events()).events[0]);
  assert.deepEqual(requests, []);
  assert.deepEqual((await events()).pending, [eventId]);
  await assert.rejects(fs.stat(h.ctx.sessionManager.getSessionFile()), { code: "ENOENT" });

  // Restore the actual captured entries only after terminal failure, without reloading the listener.
  h.setPersistence(true);
  h.persist();
  await assertPersistedPacket(h, h.sent[0]);
  const before = observations;
  await until(() => observations >= before + 3);
  assert.deepEqual(await eventStatus(h, eventId), failedState);
  assert.equal((await h.status()).active, true);
  assert.equal(h.sent.length, 1, "persistence recovery cannot automatically resend");
  assert.deepEqual(requests, [], "persistence recovery cannot automatically acknowledge");
  assert.deepEqual((await events()).acknowledgments, []);
  assert.deepEqual((await events()).pending, [eventId]);
  assert.equal(scans, 0);

  const recovered = await h.execute({ action: "retry-ack", eventId });
  const state = recovered.events.find((entry) => entry.eventId === eventId);
  assert.equal(recovered.active, true);
  assert.equal(state.status, "received");
  assert.equal(state.delivery, "persisted-session-entry-observed");
  assert.equal(state.acknowledgment, "confirmed");
  assert.equal(state.actionId, failedState.actionId);
  assert.ok(scans > 0, "explicit retry performs a fresh real disk scan");
  const receipt = { actionId: h.sent[0].message.details.actionId, eventId };
  assert.deepEqual(requests, [receipt]);
  const envelope = await events();
  assert.deepEqual(results.map(({ kind, actionId, eventId }) => ({ kind, actionId, eventId })), [{ kind: "ack", ...receipt }]);
  assert.deepEqual(envelope.acknowledgments.map(({ eventId }) => eventId), [eventId]);
  assert.deepEqual(envelope.pending, []);
  const after = observations;
  await until(() => observations >= after + 3);
  assert.equal(h.sent.length, 1, "explicit acknowledgment recovery never sends a second event message");
  assert.deepEqual(requests, [receipt]);
  assert.equal((await eventStatus(h, eventId)).status, "received");
  await assertPersistedPacket(h, h.sent[0]);
  await f.unchanged(assert);
});

test("reload over unknown attempts requires fail then owner Retry; saved receipts recover only in the originating destination", async (t) => {
  const { f, client, view, events, mutate } = await setup(t);
  let original;
  const initialEvents = client.events;
  client.events = async (...args) => {
    const envelope = await initialEvents(...args);
    if (!original) original = await mutate("next"); // Next races readiness between events and view.
    return envelope;
  };
  const h = harness(t, f, client);
  let state = await h.start();
  assert.equal(state.recoveryRequired.attemptId, original.result.attemptId);
  await until(async () => (await eventStatus(h, original.result.eventId))?.status === "recovery_required");
  assert.equal(h.sent.length, 0);
  const failed = await mutate("fail", { requestId: original.result.requestId, attemptId: original.result.attemptId, message: "Worker lost" });
  const retry = await mutate("retry", { expectedRevision: failed.view.revision, requestId: original.result.requestId, attemptId: original.result.attemptId });
  const ack = client.acknowledge;
  client.acknowledge = async () => { throw new Error("Before commit"); };
  await until(async () => (await eventStatus(h, retry.result.eventId))?.status === "ack_pending");
  assert.equal(h.sent.length, 1);
  h.load();
  client.acknowledge = ack;
  state = await h.start();
  assert.equal(state.recoveryRequired.attemptId, retry.result.attemptId);
  await until(async () => (await eventStatus(h, retry.result.eventId))?.status === "received");
  assert.equal(h.sent.length, 1, "reloading recovers acknowledgment, never generation");
  assert.equal((await view()).generation.attempt.status, "running");
  assert.deepEqual((await events()).pending, [original.result.eventId]);

  // A pending response belongs to the old context, even when navigation is cancelled.
  let release;
  const originalEvents = client.events;
  client.events = async (...args) => {
    const envelope = await originalEvents(...args);
    await new Promise((resolve) => { release = resolve; });
    return envelope;
  };
  await until(() => release);
  h.handlers.get("session_before_tree")({}, h.ctx);
  h.switchIdentity();
  release();
  await delay(40);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.status()).active, false);
  await f.unchanged(assert);
});

test("oversized checked final remains recoverable; incompatible configuration and lifetime cancellation fail closed", async (t) => {
  const { f, client, env, events, mutate } = await setup(t, true);
  const h = harness(t, f, client);
  await h.start();
  const ended = await mutate("end", { pane: "left" });
  await until(async () => (await eventStatus(h, ended.result.eventId))?.status === "oversized_output");
  assert.equal(h.sent.length, 0);
  assert.deepEqual((await events()).pending, [ended.result.eventId]);
  await h.execute({ action: "cancel" });
  await h.start();
  await until(async () => (await eventStatus(h, ended.result.eventId))?.status === "oversized_output");
  assert.equal(h.sent.length, 0);
  const saved = await client.output("design");
  const asset = saved.page.files.find((file) => file.path === "assets/image.png");
  assert.equal(digest(Buffer.from(asset.base64, "base64")), asset.sha256);
  assert.deepEqual((await events()).pending, [ended.result.eventId], "the full checked output remains available for explicit recovery");
  await h.execute({ action: "cancel" });
  assert.equal((await h.status()).active, false);
  const wrong = createDoubleSessionChatClient({ ...env, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: path.join(f.root, "different-archive") });
  await assert.rejects(wrong.connect(), /different archive/);
  await assert.rejects(h.execute({ action: "start", timeoutSeconds: 0 }), /timeoutSeconds/);
  await h.execute({ action: "start", timeoutSeconds: 0.06 });
  await until(async () => (await h.status()).status === "timeout");
  assert.equal((await h.status()).active, false);
  await f.unchanged(assert);
});

test("a final packet whose output instructions differ from the final event is never delivered", async (t) => {
  const { f, client, events, mutate } = await setup(t);
  const output = client.output;
  // The output endpoint answers with an instruction that the saved final event does not name.
  client.output = async (...args) => ({ ...(await output(...args)), steers: [{ requestId: "request-x", comparisonId: "trial", text: "Forged" }] });
  const h = harness(t, f, client);
  await h.start();
  const ended = await mutate("end", { pane: "left" });
  assert.equal((await events()).events.at(-1).payload.steers, undefined);
  await until(async () => (await eventStatus(h, ended.result.eventId))?.status === "failed_delivery");
  assert.equal(h.sent.length, 0);
  assert.deepEqual((await events()).pending, [ended.result.eventId]);
});
