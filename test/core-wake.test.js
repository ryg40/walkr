import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentEvent, cli, disposableServer, openReview, request } from "./core-fixtures.js";
import { BATCH_ID, legacyBatchId } from "../src/batch-id.js";
import { agentLineText, handoffPrompt, handoffText } from "../src/chrome-session.js";
import { targetKey } from "../src/paths.js";

const chatX = ["--pi-session-id", "chat-x", "--pi-session-file", "/sessions/x.jsonl"];
const chatY = ["--pi-session-id", "chat-y", "--pi-session-file", "/sessions/y.jsonl"];
const poll = async (f, target, ...extra) => (await cli(f.stateDir, ["poll", target, "--timeout", "30", ...extra])).json;
const status = async (f, target, ...extra) => (await cli(f.stateDir, ["status", target, ...extra])).json;

test("each Send gets a stable batch id that poll, status and the next step carry", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  await r.comment("Shorter.");
  await r.send("One pass.");

  const waiting = await status(f, r.target);
  assert.match(waiting.batch_id, BATCH_ID);
  assert.equal(waiting.collected, false, "no poll collected it yet");
  assert.deepEqual(waiting.carried_batch_ids, []);
  const saved = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(saved.batches)[0].batch.batch_id, waiting.batch_id, "the id is saved with the batch");

  const batch = await poll(f, r.target);
  assert.equal(batch.batch_id, waiting.batch_id);
  assert.ok(batch.next_step.endsWith(`run the same poll command again with \`--ack ${batch.batch_id}\` to clear this batch and wait for more.`), batch.next_step);
  const collected = await status(f, r.target);
  assert.equal(collected.batch_id, batch.batch_id);
  assert.equal(collected.collected, true, "status reports that a poll collected the current batch");
  assert.equal((await poll(f, r.target)).batch_id, batch.batch_id, "a re-poll returns the same identity");

  await f.restart();
  assert.equal((await status(f, r.target)).batch_id, batch.batch_id, "the id survives a server restart");
  await f.stop();
  const offline = await status(f, r.target);
  assert.deepEqual([offline.server_running, offline.batch_id, offline.collected], [false, batch.batch_id, true], "status without a server reads the same id");
});

test("an ack for a batch id that is not current or carried is refused and clears nothing", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  await r.comment("Shorter.");
  await r.send("");

  const early = await cli(f.stateDir, ["poll", r.target, "--ack", (await status(f, r.target)).batch_id, "--timeout", "2"]);
  assert.equal(early.code, 1);
  assert.equal(early.json.status, "ack-refused");
  assert.match(early.json.reason, /No poll collected this batch yet/);
  assert.equal((await status(f, r.target)).collected, false, "a refused ack does not collect the batch either");

  const batch = await poll(f, r.target);
  const stale = await cli(f.stateDir, ["poll", r.target, "--ack", "batch-0000000000000000", "--timeout", "2"]);
  assert.equal(stale.code, 1);
  assert.deepEqual(
    (({ status, batch_id, current_batch_id, collected, carried_batch_ids }) => ({ status, batch_id, current_batch_id, collected, carried_batch_ids }))(stale.json),
    { status: "ack-refused", batch_id: "batch-0000000000000000", current_batch_id: batch.batch_id, collected: true, carried_batch_ids: [] }
  );
  assert.match(stale.json.next_step, /^Nothing was cleared\./);
  assert.deepEqual(await r.feedback(), ["Shorter."], "the refused ack left the feedback in place");
  assert.equal((await status(f, r.target)).status, "feedback-waiting");

  const malformed = await cli(f.stateDir, ["poll", r.target, "--ack=batch-1", "--timeout", "2"]);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /--ack wants a batch id/);
  const raw = await request(f.server, "GET", `/api/poll?target=${encodeURIComponent(r.target)}&ack=nope`);
  assert.equal(raw.status, 400, "the route refuses a malformed id before it touches the batch");

  const acked = await cli(f.stateDir, ["poll", r.target, "--ack", batch.batch_id, "--timeout", "2"]);
  assert.equal(acked.json.status, "timeout");
  assert.deepEqual(await r.feedback(), []);
  const again = await cli(f.stateDir, ["poll", r.target, "--ack", batch.batch_id, "--timeout", "2"]);
  assert.equal(again.json.status, "ack-refused", "a repeated ack of a cleared batch is refused");
  assert.match(again.json.reason, /No batch waits/);
});

test("chain case: an old ack from chat X clears only the batch X holds, not the batch Y collected", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  await r.comment("A item.");
  await r.send("A");
  const a = await poll(f, r.target); // X holds A.

  await r.comment("B item.");
  await r.send("B");
  const b = await poll(f, r.target); // Y polls B, which carries A, and stops.
  assert.deepEqual(b.earlier_batches.map((x) => x.batch_id), [a.batch_id]);

  await r.comment("C item.");
  await r.send("C"); // Nobody polls C. It carries A and B.
  const waiting = await status(f, r.target);
  assert.deepEqual([waiting.collected, waiting.carried_batch_ids], [false, [a.batch_id, b.batch_id]]);

  const bare = await cli(f.stateDir, ["poll", r.target, "--ack", "--timeout", "2"]);
  assert.equal(bare.code, 1);
  assert.equal(bare.json.status, "ack-refused", "a bare ack is ambiguous here");
  assert.deepEqual(await r.feedback(), ["A item.", "B item.", "C item."]);

  // X acks A. Only A clears; the poll then hands X the waiting C, which still carries B.
  const xAck = await cli(f.stateDir, ["poll", r.target, "--ack", a.batch_id, "--timeout", "2"]);
  assert.equal(xAck.code, 0, xAck.stderr);
  const c = xAck.json;
  assert.equal(c.overall_note, "C");
  assert.deepEqual(c.earlier_batches.map((x) => [x.batch_id, x.overall_note]), [[b.batch_id, "B"]]);
  assert.deepEqual(await r.feedback(), ["B item.", "C item."], "B survives the old ack");
  assert.deepEqual((await status(f, r.target)).carried_batch_ids, [b.batch_id]);

  const done = await cli(f.stateDir, ["poll", r.target, "--ack", c.batch_id, "--timeout", "2"]);
  assert.equal(done.json.status, "timeout");
  assert.deepEqual(await r.feedback(), [], "the ack of C clears C and the B it carried");
});

test("the holder of a carried batch acks it while the newer batch stays collected by another poll", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  await r.comment("A item.");
  await r.send("A");
  const a = await poll(f, r.target);
  await r.comment("B item.");
  await r.send("B");
  const b = await poll(f, r.target);

  const bare = await cli(f.stateDir, ["poll", r.target, "--ack", "--timeout", "2"]);
  assert.equal(bare.json.status, "ack-refused", "B is collected and carries A: a bare ack could mean either");

  const xAck = await cli(f.stateDir, ["poll", r.target, "--ack", a.batch_id, "--timeout", "2"]);
  const again = xAck.json;
  assert.equal(again.batch_id, b.batch_id, "the poll returns the collected B again");
  assert.equal(again.earlier_batches, undefined, "without the acknowledged A");
  assert.match(again.next_step, /^Apply this feedback\./);
  assert.deepEqual(await r.feedback(), ["B item."]);
  assert.deepEqual([(await status(f, r.target)).collected, (await status(f, r.target)).carried_batch_ids], [true, []]);
});

test("a batch saved before batch ids gets a derived id; its legacy group clears only with the current batch", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  await r.comment("Old item.");
  await f.stop();
  const statePath = path.join(f.stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const key = targetKey(r.target);
  const comment = state.pages[key].comments[0];
  const page = { kind: "file", file: r.target, edits_saved: true, comments: [{ id: comment.id, quote: comment.quote, feedback: comment.feedback }], edits: [] };
  state.batches[key] = {
    batch: { status: "feedback", pages: [], overall_note: "Second", sent_at: "2026-10-25T09:00:02.000Z", next_step: "Apply this feedback.",
      earlier_batches: [
        { sent_at: "2026-10-25T09:00:00.000Z", overall_note: "First", pages: [] },
        { sent_at: "2026-10-25T09:00:01.000Z", overall_note: "Between", pages: [page] },
      ] },
    cleanup: [],
    delivered: false,
    priorCleanup: [{ key, ids: [comment.id], staged: [], sentAt: Date.now() }],
    updatedAt: Date.now(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  await f.restart();

  const shown = await status(f, r.target);
  assert.equal(shown.batch_id, legacyBatchId(key, "2026-10-25T09:00:02.000Z"));
  assert.deepEqual(shown.carried_batch_ids, ["2026-10-25T09:00:00.000Z", "2026-10-25T09:00:01.000Z"].map((at) => legacyBatchId(key, at)));
  const alone = await cli(f.stateDir, ["poll", r.target, "--ack", shown.carried_batch_ids[1], "--timeout", "2"]);
  assert.equal(alone.json.status, "ack-refused", "one flat legacy cleanup for two batches cannot clear one of them alone");
  assert.match(alone.json.reason, /saved before batch ids/);
  assert.deepEqual(await r.feedback(), ["Old item."]);

  const batch = await poll(f, r.target);
  assert.equal(batch.batch_id, shown.batch_id);
  assert.deepEqual(batch.earlier_batches.map((x) => x.batch_id), shown.carried_batch_ids);
  await cli(f.stateDir, ["poll", r.target, "--ack", batch.batch_id, "--timeout", "2"]);
  assert.equal((await status(f, r.target)).status, "idle");
  assert.deepEqual(await r.feedback(), [], "the ack of the current batch clears the legacy group too");
});

test("only an explicit connect binds a Pi chat; another chat is refused, and status from the bound chat renews the watcher", async (t) => {
  // Two CLI starts must fit in one lease; a Windows process start takes several hundred ms.
  const lease = process.platform === "win32" ? 3000 : 600;
  const f = await disposableServer(t, { HUMAN_REVIEW_WAKE_LEASE_MS: String(lease) });
  const r = await openReview(f);
  const before = await status(f, r.target);
  assert.deepEqual(before.wake, { bound: false, watching: false, lease_expired: false });

  const connected = await cli(f.stateDir, ["connect", r.target, ...chatX]);
  assert.equal(connected.code, 0, connected.stderr);
  assert.deepEqual(connected.json.wake, { bound: true, watching: true, lease_expired: false, bound_to_caller: true });
  assert.deepEqual(await agentEvent(f.server, r.sessionId), { state: "idle", batch_id: null, wake: true, bound: true });

  const other = await cli(f.stateDir, ["connect", r.target, ...chatY]);
  assert.equal(other.code, 1);
  assert.match(other.json.error, /Another Pi chat is connected/);
  assert.equal(other.stdout.includes("chat-x"), false, "a refused connect does not name the bound chat");
  assert.deepEqual((await status(f, r.target, ...chatY)).wake, { bound: true, watching: true, lease_expired: false, bound_to_caller: false },
    "a refused connect changes nothing");

  await new Promise((resolve) => setTimeout(resolve, lease + 200));
  assert.equal((await status(f, r.target)).wake.watching, false, "the watcher lapses without status reads from the bound chat");
  assert.equal((await status(f, r.target, ...chatY)).wake.watching, false, "another chat's reads do not renew it");
  assert.equal((await status(f, r.target, ...chatX)).wake.watching, true, "the bound chat's read renews it");

  await f.restart();
  const restarted = await status(f, r.target, ...chatX);
  assert.deepEqual([restarted.wake.bound, restarted.wake.bound_to_caller], [true, true], "the binding survives a server restart");

  assert.equal((await cli(f.stateDir, ["disconnect", r.target, ...chatY])).code, 1, "another chat cannot release it");
  assert.equal((await cli(f.stateDir, ["disconnect", r.target])).code, 1, "disconnect needs an identity or --force");
  const released = await cli(f.stateDir, ["disconnect", r.target, ...chatX]);
  assert.equal(released.code, 0, released.stderr);
  assert.equal(released.json.wake.bound, false);
  assert.equal((await cli(f.stateDir, ["connect", r.target, ...chatY])).code, 0, "after the release another chat can connect");

  const invalid = await request(f.server, "POST", "/api/core/connect", { target: r.target, piSessionId: "z", piSessionFile: "relative.jsonl" });
  assert.equal(invalid.status, 400, "a session file must be absolute");
  assert.equal((await request(f.server, "GET", `/api/status?target=${encodeURIComponent(r.target)}&pi_session_id=z`)).status, 400);
  assert.equal((await request(f.server, "POST", "/api/status", { target: r.target, piSessionId: "z" })).status, 400);
});

test("the page names the waiting batch and says when a connected chat wakes on Send", () => {
  assert.equal(agentLineText("idle", true), "Agent connected; it wakes on Send");
  assert.equal(agentLineText("listening", true), "Agent connected; it wakes on Send");
  assert.equal(agentLineText("idle", false), null);
  assert.equal(agentLineText("working", true), "Feedback delivered — page reloads when fixes land");
  assert.match(handoffText("stranded", true).title, /The connected Pi chat wakes to collect it\./);
  assert.match(handoffText("stranded", false).title, /No agent is collecting it\./);
  const prompt = handoffPrompt("walkr-core poll /tmp/r.html", "walkr-core status /tmp/r.html", "batch-0123456789abcdef");
  assert.match(prompt, /It returns batch `batch-0123456789abcdef` or a newer one\./);
  assert.match(prompt, /`walkr-core poll \/tmp\/r\.html --ack <batch_id> --timeout 2` with the `batch_id` of that poll output\./);
});

test("an --ack value that is not a batch id is refused before it reaches the server, and clears nothing", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  await r.comment("X must apply this.");
  await r.send("");
  const a = await poll(f, r.target); // Chat X collects A.

  // Chat Y with a mistyped, truncated or placeholder id: before the fix each one became the bare ack and cleared A.
  for (const args of [["--ack", "batch-ABCDEF0123456789"], ["--ack", "batch-abcdef"], ["--ack", "<batch_id>"], ["--ack=batch-ABCDEF0123456789"], ["--ack=<batch_id>"]]) {
    const refused = await cli(f.stateDir, ["poll", r.target, ...args, "--timeout", "2"]);
    assert.equal(refused.code, 1, `${args.join(" ")} must fail`);
    assert.match(refused.stderr, /--ack wants a batch id .*Nothing was acknowledged\./, args.join(" "));
    assert.equal(refused.json, null, "no poll ran");
    assert.deepEqual(await r.feedback(), ["X must apply this."], `${args.join(" ")} cleared nothing`);
    const after = await status(f, r.target);
    assert.deepEqual([after.batch_id, after.collected], [a.batch_id, true]);
  }

  // The bare form stays where it is unambiguous: before another flag and at the end.
  const bare = await cli(f.stateDir, ["poll", r.target, "--timeout", "2", "--ack"]);
  assert.equal(bare.json.status, "timeout", bare.stderr);
  assert.deepEqual(await r.feedback(), []);
});

test("status never names the bound chat, an agent forces only an expired lease, and the owner releases a live binding from the page", async (t) => {
  // Long enough that a loaded host still runs a few CLI calls inside one lease.
  const lease = 3000;
  const lapse = () => new Promise((resolve) => setTimeout(resolve, lease + 300));
  const f = await disposableServer(t, { HUMAN_REVIEW_WAKE_LEASE_MS: String(lease) });
  const r = await openReview(f);
  assert.equal((await cli(f.stateDir, ["connect", r.target, ...chatX])).code, 0);
  const named = (text) => text.includes("chat-x") || text.includes("/sessions/x.jsonl");
  for (const read of [await cli(f.stateDir, ["status", r.target]), await cli(f.stateDir, ["status", r.target, ...chatY]),
    await cli(f.stateDir, ["connect", r.target, ...chatY]), await cli(f.stateDir, ["disconnect", r.target, ...chatY])]) {
    assert.equal(named(read.stdout), false, read.stdout);
  }
  await status(f, r.target, ...chatX); // The bound chat renews its lease.
  assert.deepEqual((await status(f, r.target, ...chatY)).wake, { bound: true, watching: true, lease_expired: false, bound_to_caller: false });

  const live = await cli(f.stateDir, ["disconnect", r.target, "--force"]);
  assert.equal(live.code, 1);
  assert.match(live.json.error, /--force works only after the lease expires/);
  assert.equal((await status(f, r.target, ...chatX)).wake.bound_to_caller, true, "a refused force changes nothing");

  // The owner's page action: the page token, its session, and the browser Origin of this server.
  const origin = { origin: `http://127.0.0.1:${f.server.port}` };
  const route = `/api/session/${r.sessionId}/wake-release`;
  assert.equal((await request(f.server, "POST", route)).status, 403, "the CLI token alone is not the page");
  assert.equal((await request(f.server, "POST", route, null, { origin: "http://evil.example" })).status, 403);
  assert.equal((await request(f.server, "POST", `/api/session/sunknown/wake-release`, null, origin)).status, 404);
  const owner = await request(f.server, "POST", route, null, origin);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal((await status(f, r.target)).wake.bound, false, "the owner released a live binding");
  assert.deepEqual(await agentEvent(f.server, r.sessionId), { state: "idle", batch_id: null, wake: false, bound: false });

  // A dead chat: no renewal for longer than the lease. Another connect replaces it without --force.
  assert.equal((await cli(f.stateDir, ["connect", r.target, ...chatX])).code, 0);
  await lapse();
  assert.equal((await status(f, r.target)).wake.lease_expired, true);
  const replaced = await cli(f.stateDir, ["connect", r.target, ...chatY]);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.equal((await status(f, r.target, ...chatX)).wake.bound_to_caller, false, "the expired binding counts as released");

  // --force works on an expired lease. A server start counts as a renewal, so a restart grants no force at once.
  await f.restart();
  assert.equal((await cli(f.stateDir, ["disconnect", r.target, "--force"])).code, 1, "a restart is not an expired lease");
  await lapse();
  const forced = await cli(f.stateDir, ["disconnect", r.target, "--force"]);
  assert.equal(forced.code, 0, forced.stdout);
  assert.equal(forced.json.wake.bound, false);
});

test("the server grants one wake per batch id per binding, only for an uncollected batch with no attached poll", async (t) => {
  const f = await disposableServer(t);
  const r = await openReview(f);
  assert.equal((await cli(f.stateDir, ["connect", r.target, ...chatX])).code, 0);
  await r.comment("Wake item.");
  await r.send("");
  const id = (await status(f, r.target)).batch_id;
  const claim = (...who) => cli(f.stateDir, ["claim-wake", r.target, "--batch-id", id, ...who]);

  assert.equal((await claim(...chatY)).json.reason, "not_bound");
  const first = await claim(...chatX);
  assert.deepEqual([first.code, first.json.claimed], [0, true], first.stdout);
  const second = await claim(...chatX);
  assert.deepEqual([second.code, second.json.claimed, second.json.reason], [1, false, "already_woken"], "a second process on the same session file is refused");
  await f.restart();
  assert.equal((await claim(...chatX)).json.reason, "already_woken", "the claim survives a server restart");
  await openReview(f);
  await poll(f, r.target);
  assert.equal((await claim(...chatX)).json.reason, "not_waiting", "a collected batch wakes nothing");
  assert.equal((await cli(f.stateDir, ["claim-wake", r.target, "--batch-id", "batch-ABC", ...chatX])).code, 1, "a malformed id is refused");
});
