import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DoubleStore } from "../src/double-store.js";
import { tmpRoot } from "./tmp-root.js";

const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const region = (id = "hero", label = "Hero", text = "Hello &amp; world") =>
  `<section data-double-id="${id}" data-container="${label}"><h1>${text}</h1></section>`;
const page = (body = region() + region("footer", "Footer", "Bottom")) =>
  `<!doctype html><html><head><link rel="stylesheet" href="site.css"></head><body>${body}</body></html>`;
const ioError = () => Object.assign(new Error("Injected storage failure"), { code: "EIO" });
const rejects = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, error.stack);
  assert.ok(error.message);
  return true;
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpRoot, "double-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archiveDir = path.join(root, "archive");
  const input = { comparisonId: options.comparisonId || "trial:1", label: "Two proposals", panes: {} };
  for (const pane of ["left", "right"]) {
    const originalRoot = path.join(root, `original-${pane}`);
    const copyRoot = path.join(root, pane);
    await fs.mkdir(originalRoot);
    await fs.mkdir(copyRoot);
    const original = { entry: path.join(originalRoot, "index.html"), files: [] };
    for (const [file, bytes] of Object.entries({ "index.html": page(), "site.css": "h1{color:red}" })) {
      await fs.writeFile(path.join(originalRoot, file), bytes);
      await fs.writeFile(path.join(copyRoot, file), file === "index.html" ? (options.html || page()).replace("Hello &amp; world", `${pane} &amp; copy`) : bytes);
      original.files.push({ path: path.join(originalRoot, file), sha256: hash(bytes) });
    }
    input.panes[pane] = { label: `${pane} proposal`, original, copy: { root: copyRoot, entry: "index.html", assets: ["site.css"] } };
  }
  const inputFiles = Object.values(input.panes).flatMap(({ original, copy }) => [
    ...original.files.map(({ path: file }) => file), ...[copy.entry, ...copy.assets].map((file) => path.join(copy.root, file)),
  ]);
  const originalHashes = await Promise.all(inputFiles.map(async (file) => [file, hash(await fs.readFile(file))]));
  const store = new DoubleStore({ archiveDir });
  const f = {
    root, archiveDir, input, store, comparisonId: input.comparisonId,
    file: path.join(archiveDir, `double-${hash(input.comparisonId)}.json`),
    async verifyInputs() {
      assert.deepEqual(await Promise.all(inputFiles.map(async (file) => [file, hash(await fs.readFile(file))])), originalHashes);
    },
    async act(kind, fields = {}, actionId) {
      const { revision } = await store.read(input.comparisonId);
      actionId ??= `action-${revision + 1}`;
      return store.act(input.comparisonId, { actionId, expectedRevision: revision, kind, ...fields });
    },
    async send(actionId = "send") {
      return store.send(input.comparisonId, { actionId, expectedRevision: (await store.read(input.comparisonId)).revision });
    },
  };
  if (options.create !== false) await store.create(input);
  return f;
}

const left = (view, index = 0) => view.panes.left.components[index];
const target = { pane: "left", componentId: "hero" };
const keeperRequest = (actionId = "keep", expectedRevision = 0) => ({ actionId, expectedRevision, kind: "keeper", ...target, selected: true });
const feedbackRequest = (actionId = "feedback", expectedRevision = 0) => ({ actionId, expectedRevision, kind: "feedback-delete", ...target, feedback: "  Too tall.\nKeep the wording.  " });

function mockHandles(t, intercept) {
  const open = fs.open.bind(fs);
  return t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    return new Proxy(handle, {
      get(object, property) {
        const value = object[property];
        if (typeof value !== "function") return value;
        return (...params) => intercept(args[0], property, () => value.apply(object, params), args[1]);
      },
    });
  });
}

async function tamper(f, change, reseal = false) {
  const doc = JSON.parse(await fs.readFile(f.file, "utf8"));
  change(doc);
  if (reseal) {
    const { checksum, ...body } = doc;
    doc.checksum = hash(JSON.stringify(body));
  }
  await fs.writeFile(f.file, JSON.stringify(doc));
}

test("comment-only actions replay without changing selection and make a comment-only batch nonempty", async (t) => {
  const f = await fixture(t);
  const comment = { actionId: "comment-1", expectedRevision: 0, kind: "comment", ...target, feedback: "  Retain this\nshorten it.  " };
  const first = await f.store.act(f.comparisonId, comment);
  assert.equal(left(first.view).deleted, false);
  assert.equal(left(first.view).keeper, false);
  await f.act("round-comment", { feedback: "Use four items." });
  const restarted = new DoubleStore({ archiveDir: f.archiveDir });
  assert.deepEqual((await restarted.act(f.comparisonId, comment)).result, first.result);
  await rejects(restarted.act(f.comparisonId, { ...comment, feedback: "Changed" }), "ACTION_CONFLICT");
  await f.send();
  const sent = await restarted.poll(f.comparisonId);
  assert.equal(sent.payload.empty, false);
  assert.equal(sent.payload.keepers.length, 0);
  assert.equal(sent.payload.feedbackDeletions.length, 0);
  assert.deepEqual(sent.payload.feedback.map((entry) => entry.comment), [comment.feedback, "Use four items."]);
  assert.equal(sent.payload.feedback[1].scope, "round");
  assert.equal((await restarted.read(f.comparisonId)).comments.length, 2);
  await f.verifyInputs();
});

test("comments on a discarded keeper survive restart and Undo restores the selection", async (t) => {
  const f = await fixture(t);
  await f.act("keeper", { ...target, selected: true });
  const discarded = await f.act("delete", target);
  await f.act("comment", { ...target, feedback: "Replace this part with a shorter version." });
  const restarted = new DoubleStore({ archiveDir: f.archiveDir });
  const view = await restarted.read(f.comparisonId);
  assert.equal(left(view).deleted, true);
  assert.equal(left(view).keeper, false);
  assert.equal(view.comments.length, 1);
  const restored = await restarted.act(f.comparisonId, { actionId: "restore", expectedRevision: view.revision, kind: "undo", deletionActionId: discarded.result.actionId });
  assert.equal(left(restored.view).deleted, false);
  assert.equal(left(restored.view).keeper, true);
  assert.deepEqual(restored.view.comments, view.comments);
  await f.verifyInputs();
});

test("creates private authoritative state and trusted evidence with opposite-pane IDs", async (t) => {
  const f = await fixture(t);
  const view = await f.store.read(f.comparisonId);
  assert.deepEqual(Object.keys(view).sort(), ["comparisonId", "label", "revision", "status", "panes", "history", "delivery"].sort());
  assert.equal(view.revision, 0);
  assert.equal(view.status, "editing");
  assert.deepEqual(view.delivery, { batchId: null, acknowledged: false });
  assert.deepEqual(left(view), { id: "hero", label: "Hero", keeper: false, deleted: false, deletionActionId: null });
  assert.equal(view.panes.right.components[0].id, "hero");
  assert.equal(Object.hasOwn(view.panes.left, "frameUrl"), false);
  assert.equal(JSON.stringify(view).includes(f.root), false);
  const snapshot = await f.store.snapshot(f.comparisonId);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.baselines.left[0].html, region("hero", "Hero", "left &amp; copy"));
  assert.equal(snapshot.baselines.left[0].text, "left & copy");
  assert.equal(snapshot.baselines.right[0].text, "right & copy");
  assert.notEqual(snapshot.provenance.panes.left.copy.files[0].sha256, snapshot.provenance.panes.left.original.files[0].baselineSha256);
  assert.equal((await fs.stat(f.archiveDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.file)).nlink, 1);
  assert.equal((await fs.stat(f.file)).uid, process.getuid());
  assert.deepEqual(await fs.readdir(f.archiveDir), [path.basename(f.file)]);
  assert.equal(await f.store.poll(f.comparisonId), null);
  await f.verifyInputs();
});

test("persists both keeper transitions without collisions or mutable returned state", async (t) => {
  const f = await fixture(t);
  const first = await f.store.act(f.comparisonId, keeperRequest());
  assert.equal(left(first.view).keeper, true);
  assert.equal(first.view.panes.right.components[0].keeper, false);
  assert.equal(left(first.view, 1).keeper, false);
  first.view.panes.left.components[0].keeper = false;
  first.result.revision = 100;
  const snapshot = await f.store.snapshot(f.comparisonId);
  snapshot.manifest.label = "mutated";
  snapshot.state.left[0].keeper = false;
  assert.equal(left(await f.store.read(f.comparisonId)).keeper, true);
  const cleared = await f.act("keeper", { ...target, selected: false });
  assert.equal(left(cleared.view).keeper, false);
  assert.equal(left(cleared.view).deleted, false);
  const right = await f.act("keeper", { pane: "right", componentId: "hero", selected: true });
  assert.equal(right.view.panes.right.components[0].keeper, true);
  assert.equal(left(right.view).keeper, false);
  assert.equal((await f.store.snapshot(f.comparisonId)).actions.length, 3);
  await f.verifyInputs();
});

for (const kind of ["delete", "feedback-delete"]) {
  for (const selected of [false, true]) {
    test(`${kind} clears keeper=${selected}; Undo restores exactly and keeps feedback unchanged`, async (t) => {
      const f = await fixture(t);
      if (selected) await f.act("keeper", { ...target, selected });
      const before = await f.store.snapshot(f.comparisonId);
      const deleted = await f.act(kind, { ...target, ...(kind === "feedback-delete" && { feedback: "  Keep this exact text.\n " }) }, "deletion");
      assert.equal(left(deleted.view).keeper, false);
      assert.equal(left(deleted.view).deleted, true);
      assert.equal(left(deleted.view).deletionActionId, "deletion");
      const saved = await f.store.snapshot(f.comparisonId);
      assert.equal(saved.feedback.length, kind === "feedback-delete" ? 1 : 0);
      if (saved.feedback.length) {
        const feedback = saved.feedback[0];
        assert.equal(feedback.comment, "  Keep this exact text.\n ");
        assert.equal(feedback.html, before.baselines.left[0].html);
        assert.equal(feedback.text, before.baselines.left[0].text);
        assert.deepEqual(feedback.identity, { comparisonId: f.comparisonId, pane: "left", componentId: "hero" });
        assert.equal(feedback.label, "Hero");
        assert.equal(feedback.paneLabel, "left proposal");
        assert.equal(feedback.comparisonLabel, f.input.label);
        assert.deepEqual(feedback.original, before.provenance.panes.left.original);
        assert.deepEqual(feedback.copy, before.provenance.panes.left.copy);
        assert.match(feedback.at, /^\d{4}-/);
      }
      assert.equal(await f.store.poll(f.comparisonId), null);
      const undone = await f.act("undo", { deletionActionId: "deletion" });
      assert.equal(left(undone.view).keeper, selected);
      assert.equal(left(undone.view).deleted, false);
      assert.equal(left(undone.view).deletionActionId, null);
      assert.deepEqual((await f.store.snapshot(f.comparisonId)).state.left[0], before.state.left[0]);
      assert.equal(undone.view.history.length, 1);
      assert.equal(undone.view.history[0].undone, true);
      assert.deepEqual((await f.store.snapshot(f.comparisonId)).feedback, saved.feedback);
      await f.verifyInputs();
    });
  }
}

test("repeat correction and Undo cycles append history without editing earlier feedback", async (t) => {
  const f = await fixture(t);
  const history = [];
  for (let index = 0; index < 4; index++) {
    await f.act("keeper", { ...target, selected: index % 2 === 0 });
    await f.act("feedback-delete", { ...target, feedback: `Correction ${index}` }, `delete-${index}`);
    const snapshot = await f.store.snapshot(f.comparisonId);
    history.push(snapshot.feedback.at(-1));
    await f.act("undo", { deletionActionId: `delete-${index}` });
    assert.deepEqual((await f.store.snapshot(f.comparisonId)).feedback, history);
    assert.equal(left(await f.store.read(f.comparisonId)).keeper, index % 2 === 0);
  }
  const view = await f.store.read(f.comparisonId);
  assert.deepEqual(view.history.map(({ undone }) => undone), [true, true, true, true]);
  assert.deepEqual(view.history.map(({ id }) => id), ["delete-0", "delete-1", "delete-2", "delete-3"]);
  await f.verifyInputs();
});

for (const [name, request, code] of [
  ["missing request", undefined, "INVALID_REQUEST"],
  ["null request", null, "INVALID_ID"],
  ["missing action ID", { ...keeperRequest(), actionId: undefined }, "INVALID_REQUEST"],
  ["absent action ID", { expectedRevision: 0, kind: "delete", ...target }, "INVALID_ID"],
  ["blank action ID", { ...keeperRequest(), actionId: "" }, "INVALID_ID"],
  ["whitespace action ID", { ...keeperRequest(), actionId: "a b" }, "INVALID_ID"],
  ["control action ID", { ...keeperRequest(), actionId: "a\u200b" }, "INVALID_ID"],
  ["missing component ID", { actionId: "a", expectedRevision: 0, kind: "delete", pane: "left" }, "INVALID_REQUEST"],
  ["blank component ID", { ...keeperRequest(), componentId: "" }, "INVALID_ID"],
  ["unknown component", { ...keeperRequest(), componentId: "unknown" }, "UNKNOWN_COMPONENT"],
  ["unknown pane", { ...keeperRequest(), pane: "middle" }, "INVALID_REQUEST"],
  ["missing selected", { actionId: "a", expectedRevision: 0, kind: "keeper", ...target }, "INVALID_REQUEST"],
  ["nonboolean selected", { ...keeperRequest(), selected: 1 }, "INVALID_REQUEST"],
  ["unexpected HTML evidence", { ...feedbackRequest(), html: "<b>injected</b>" }, "INVALID_REQUEST"],
  ["unexpected comment alias", { ...feedbackRequest(), comment: "different" }, "INVALID_REQUEST"],
  ["empty feedback", { ...feedbackRequest(), feedback: "" }, "INVALID_REQUEST"],
  ["whitespace feedback", { ...feedbackRequest(), feedback: " \n\t\u00a0" }, "INVALID_REQUEST"],
  ["null feedback", { ...feedbackRequest(), feedback: null }, "INVALID_REQUEST"],
  ["unknown kind", { ...keeperRequest(), kind: "reset" }, "INVALID_REQUEST"],
  ["array kind", { ...keeperRequest(), kind: ["keeper"] }, "INVALID_REQUEST"],
  ["prototype kind", { ...keeperRequest(), kind: "__proto__" }, "INVALID_REQUEST"],
  ["negative revision", { ...keeperRequest(), expectedRevision: -1 }, "INVALID_REQUEST"],
  ["fractional revision", { ...keeperRequest(), expectedRevision: 0.5 }, "INVALID_REQUEST"],
  ["string revision", { ...keeperRequest(), expectedRevision: "0" }, "INVALID_REQUEST"],
  ["unsafe revision", { ...keeperRequest(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, "INVALID_REQUEST"],
  ["NaN revision", { ...keeperRequest(), expectedRevision: NaN }, "INVALID_REQUEST"],
  ["negative zero revision", { ...keeperRequest(), expectedRevision: -0 }, "INVALID_REQUEST"],
  ["unknown Undo", { actionId: "undo", expectedRevision: 0, kind: "undo", deletionActionId: "absent" }, "UNKNOWN_DELETION"],
  ["blank Undo ID", { actionId: "undo", expectedRevision: 0, kind: "undo", deletionActionId: "" }, "INVALID_ID"],
]) {
  test(`rejects ${name} without writing`, async (t) => {
    const f = await fixture(t);
    const before = await fs.readFile(f.file);
    await rejects(f.store.act(f.comparisonId, request), code);
    assert.deepEqual(await fs.readFile(f.file), before);
    await f.verifyInputs();
  });
}

test("rejects invalid transitions and Undo of keepers, repeated or older deletions", async (t) => {
  const f = await fixture(t);
  await f.store.act(f.comparisonId, keeperRequest());
  await rejects(f.act("undo", { deletionActionId: "keep" }), "UNKNOWN_DELETION");
  await f.act("delete", target, "first-delete");
  for (const [kind, fields] of [["keeper", { selected: false }], ["delete", {}], ["feedback-delete", { feedback: "text" }]]) {
    await rejects(f.act(kind, { ...target, ...fields }), "INVALID_TRANSITION");
  }
  await f.act("undo", { deletionActionId: "first-delete" });
  await rejects(f.act("undo", { deletionActionId: "first-delete" }), "INVALID_TRANSITION");
  await f.act("feedback-delete", { ...target, feedback: "new" }, "second-delete");
  await rejects(f.act("undo", { deletionActionId: "first-delete" }), "INVALID_TRANSITION");
  await f.act("undo", { deletionActionId: "second-delete" });
  await f.verifyInputs();
});

test("identical lost-response retry returns original result and latest view before stale/read-only checks", async (t) => {
  const f = await fixture(t);
  const request = feedbackRequest();
  const result = (await f.store.act(f.comparisonId, request)).result;
  await f.act("undo", { deletionActionId: request.actionId }, "undo");
  await f.act("keeper", { ...target, selected: true });
  await f.send();
  const bytes = await fs.readFile(f.file);
  const retry = await new DoubleStore({ archiveDir: f.archiveDir }).act(f.comparisonId, request);
  assert.deepEqual(retry.result, result);
  assert.equal(retry.view.revision, 4);
  assert.equal(retry.view.status, "sent");
  assert.deepEqual(await fs.readFile(f.file), bytes);
  for (const changed of [
    { ...request, feedback: "changed" }, { ...request, expectedRevision: 4 }, { ...request, extra: "unexpected" },
    { ...request, pane: "right" }, { ...request, feedback: "" }, { actionId: request.actionId },
  ]) await rejects(f.store.act(f.comparisonId, changed), "ACTION_CONFLICT");
  await rejects(f.store.send(f.comparisonId, { actionId: request.actionId, expectedRevision: 4 }), "ACTION_CONFLICT");
  assert.equal((await f.store.snapshot(f.comparisonId)).feedback.length, 1);
  await f.verifyInputs();
});

test("stale new actions reject; serialized same-revision asynchronous calls do not lose updates", async (t) => {
  const f = await fixture(t);
  const other = new DoubleStore({ archiveDir: f.archiveDir });
  const results = await Promise.allSettled([
    f.store.act(f.comparisonId, keeperRequest("left")),
    other.act(f.comparisonId, { ...keeperRequest("right"), pane: "right" }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "STALE_REVISION");
  await rejects(f.store.send(f.comparisonId, { actionId: "send", expectedRevision: 0 }), "STALE_REVISION");
  await other.act(f.comparisonId, { ...keeperRequest("right", 1), pane: "right" });
  assert.equal((await f.store.snapshot(f.comparisonId)).actions.length, 2);
  await f.verifyInputs();
});

test("concurrent same-ID retries save once and caller mutation cannot change a queued request", async (t) => {
  const f = await fixture(t);
  const request = feedbackRequest();
  const first = f.store.act(f.comparisonId, request);
  const second = f.store.act(f.comparisonId, structuredClone(request));
  request.feedback = "Mutated after starting";
  request.pane = "right";
  assert.deepEqual(await first, await second);
  const doc = await f.store.snapshot(f.comparisonId);
  assert.equal(doc.receipts.length, 1);
  assert.equal(doc.feedback[0].comment, feedbackRequest().feedback);
  assert.equal(doc.feedback[0].identity.pane, "left");
});

test("Send freezes explicit current decisions, all feedback, history, and stable poll payloads", async (t) => {
  const f = await fixture(t);
  await f.act("keeper", { ...target, selected: true });
  await f.act("feedback-delete", { pane: "right", componentId: "hero", feedback: "Old" }, "old-feedback");
  await f.act("undo", { deletionActionId: "old-feedback" });
  await f.act("feedback-delete", { pane: "right", componentId: "hero", feedback: "New" }, "new-feedback");
  await f.act("delete", { pane: "right", componentId: "footer" }, "plain");
  const send = { actionId: "send", expectedRevision: 5 };
  const sent = await f.store.send(f.comparisonId, send);
  assert.equal(sent.view.status, "sent");
  const batch = await f.store.poll(f.comparisonId);
  assert.equal(batch.id, sent.result.batchId);
  assert.equal(batch.payload.empty, false);
  assert.deepEqual(batch.payload.keepers.map(({ identity }) => identity), [{ comparisonId: f.comparisonId, pane: "left", componentId: "hero" }]);
  assert.deepEqual(batch.payload.plainDeletions.map(({ deletionActionId }) => deletionActionId), ["plain"]);
  assert.deepEqual(batch.payload.feedbackDeletions.map(({ feedbackId }) => feedbackId), ["new-feedback"]);
  assert.deepEqual(batch.payload.historicalFeedback, [{ feedbackId: "old-feedback", actionId: "old-feedback", undone: true }]);
  assert.deepEqual(batch.payload.feedback, (await f.store.snapshot(f.comparisonId)).feedback);
  assert.equal(batch.payload.actions.length, 5);
  assert.deepEqual(await f.store.poll(f.comparisonId), batch);
  assert.deepEqual(await new DoubleStore({ archiveDir: f.archiveDir }).poll(f.comparisonId), batch);
  const polluted = await f.store.poll(f.comparisonId);
  polluted.payload.feedback[0].comment = "mutated";
  assert.deepEqual(await f.store.poll(f.comparisonId), batch);
  assert.deepEqual((await f.store.send(f.comparisonId, send)).result, sent.result);
  await rejects(f.store.send(f.comparisonId, { ...send, actionId: "new-send", expectedRevision: 6 }), "READ_ONLY");
  for (const [kind, fields] of [
    ["keeper", { ...target, selected: false }], ["delete", target],
    ["feedback-delete", { ...target, feedback: "Too late" }], ["undo", { deletionActionId: "plain" }],
  ]) await rejects(f.act(kind, fields), "READ_ONLY");
  await f.verifyInputs();
});

for (const withHistory of [false, true]) {
  test(`empty Send locks with explicit no-change payload, historical feedback=${withHistory}`, async (t) => {
    const f = await fixture(t);
    if (withHistory) {
      await f.act("feedback-delete", { ...target, feedback: "Not current" }, "historical");
      await f.act("undo", { deletionActionId: "historical" });
      await f.act("keeper", { ...target, selected: true });
      await f.act("keeper", { ...target, selected: false });
    }
    await f.send();
    const { payload } = await f.store.poll(f.comparisonId);
    assert.equal(payload.empty, true);
    assert.deepEqual(payload.keepers, []);
    assert.deepEqual(payload.plainDeletions, []);
    assert.deepEqual(payload.feedbackDeletions, []);
    assert.equal(payload.feedback.length, withHistory ? 1 : 0);
    assert.equal(payload.historicalFeedback.length, withHistory ? 1 : 0);
    assert.equal((await f.store.read(f.comparisonId)).status, "sent");
  });
}

test("acknowledgment means receipt, stops redelivery, keeps frozen bytes and lock through restart", async (t) => {
  const f = await fixture(t);
  await rejects(f.store.acknowledge(f.comparisonId, { actionId: "ack", batchId: "absent" }), "UNKNOWN_BATCH");
  await f.store.act(f.comparisonId, feedbackRequest());
  const sendRequest = { actionId: "send", expectedRevision: 1 };
  const sent = await f.store.send(f.comparisonId, sendRequest);
  const frozen = JSON.stringify(await f.store.poll(f.comparisonId));
  await rejects(f.store.acknowledge(f.comparisonId, { actionId: "ack", batchId: "wrong" }), "UNKNOWN_BATCH");
  const request = { actionId: "ack", batchId: sent.result.batchId };
  const ack = await f.store.acknowledge(f.comparisonId, request);
  assert.equal(ack.view.delivery.acknowledged, true);
  const saved = await fs.readFile(f.file);
  assert.equal(await f.store.poll(f.comparisonId), null);
  const restarted = new DoubleStore({ archiveDir: f.archiveDir });
  assert.equal(await restarted.poll(f.comparisonId), null);
  assert.deepEqual((await restarted.acknowledge(f.comparisonId, request)).result, ack.result);
  assert.deepEqual(await fs.readFile(f.file), saved);
  await rejects(restarted.acknowledge(f.comparisonId, { ...request, batchId: "wrong" }), "ACTION_CONFLICT");
  await rejects(restarted.acknowledge(f.comparisonId, { ...request, extra: true }), "ACTION_CONFLICT");
  await rejects(restarted.acknowledge(f.comparisonId, { actionId: "second", batchId: "wrong" }), "UNKNOWN_BATCH");
  const before = await restarted.snapshot(f.comparisonId);
  await restarted.acknowledge(f.comparisonId, { actionId: "second", batchId: request.batchId });
  const after = await restarted.snapshot(f.comparisonId);
  assert.equal(after.delivery.acknowledgedAt, before.delivery.acknowledgedAt);
  assert.equal(JSON.stringify(after.delivery.batch), frozen);
  assert.deepEqual(after.feedback, before.feedback);
  assert.deepEqual(after.actions, before.actions);
  assert.equal(after.delivery.status, "sent");
  assert.equal(await restarted.poll(f.comparisonId), null);
  assert.deepEqual((await restarted.send(f.comparisonId, sendRequest)).result, sent.result);
  await rejects(restarted.act(f.comparisonId, keeperRequest("late", after.revision)), "READ_ONLY");
  await f.verifyInputs();
});

test("a changed frozen batch fails replay validation without deleting the corrupt record", async (t) => {
  const f = await fixture(t);
  await f.store.act(f.comparisonId, keeperRequest());
  await f.send();
  await tamper(f, (doc) => { doc.delivery.batch.payload.keepers = []; }, true);
  const bytes = await fs.readFile(f.file);
  await rejects(f.store.poll(f.comparisonId), "RECOVERY_REQUIRED");
  await rejects(f.store.acknowledge(f.comparisonId, { actionId: "ack", batchId: "batch" }), "RECOVERY_REQUIRED");
  assert.deepEqual(await fs.readFile(f.file), bytes);
});

test("concurrent creates serialize across stores without overwriting the first manifest", async (t) => {
  const f = await fixture(t, { create: false });
  const other = new DoubleStore({ archiveDir: f.archiveDir });
  const values = await Promise.all([f.store.create(f.input), other.create(f.input)]);
  assert.deepEqual(values[0], values[1]);
  assert.equal((await fs.readdir(f.archiveDir)).length, 1);
  await rejects(other.create({ ...f.input, label: "different" }), "COMPARISON_EXISTS");
  assert.equal((await f.store.snapshot(f.comparisonId)).revision, 0);
});

test("new Node processes recover state, lost-response actions, Send, and acknowledgment", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../src/double-store.js", import.meta.url).href;
  async function child(operation, request) {
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", `
      import { DoubleStore } from ${JSON.stringify(moduleUrl)};
      const store = new DoubleStore({ archiveDir: process.argv[1] });
      const result = await store[process.argv[3]](process.argv[2], JSON.parse(process.argv[4]));
      process.stdout.write(JSON.stringify(result));
    `, f.archiveDir, f.comparisonId, operation, JSON.stringify(request ?? null)]);
    return JSON.parse(stdout);
  }
  const kept = await child("act", keeperRequest());
  assert.deepEqual((await child("act", keeperRequest())).result, kept.result);
  await child("act", feedbackRequest("delete", 1));
  await child("act", { actionId: "undo", expectedRevision: 2, kind: "undo", deletionActionId: "delete" });
  const view = await child("read");
  assert.equal(left(view).keeper, true);
  assert.equal(view.history[0].undone, true);
  const send = { actionId: "send", expectedRevision: 3 };
  const sent = await child("send", send);
  const firstPoll = await child("poll");
  assert.deepEqual(await child("poll"), firstPoll);
  assert.deepEqual((await child("send", send)).result, sent.result);
  const ack = { actionId: "ack", batchId: sent.result.batchId };
  assert.deepEqual(await child("acknowledge", ack), await child("acknowledge", ack));
  assert.equal(await child("poll"), null);
  assert.equal((await child("read")).status, "sent");
  await f.verifyInputs();
});

for (const stage of ["writeFile", "sync", "rename"]) {
  test(`injected ${stage} failure cannot publish unsaved state; exact retry saves once`, async (t) => {
    const f = await fixture(t);
    const before = await fs.readFile(f.file);
    const beforeView = await f.store.read(f.comparisonId);
    const request = feedbackRequest();
    let mock;
    if (stage === "rename") mock = t.mock.method(fs, "rename", async () => { throw ioError(); });
    else mock = mockHandles(t, (file, method, run) => {
      if (file.endsWith(".tmp") && method === stage) throw ioError();
      return run();
    });
    await rejects(f.store.act(f.comparisonId, request), stage === "rename" ? "COMMIT_UNCERTAIN" : "WRITE_FAILED");
    mock.mock.restore();
    assert.deepEqual(await fs.readFile(f.file), before);
    assert.deepEqual(await f.store.read(f.comparisonId), beforeView);
    assert.deepEqual(await fs.readdir(f.archiveDir), [path.basename(f.file)]);
    await f.store.act(f.comparisonId, request);
    await f.store.act(f.comparisonId, request);
    assert.equal((await f.store.snapshot(f.comparisonId)).feedback.length, 1);
    await f.verifyInputs();
  });
}

test("replacement with a lost response recovers the committed action rather than retrying fresh", async (t) => {
  const f = await fixture(t);
  const rename = fs.rename.bind(fs);
  const mock = t.mock.method(fs, "rename", async (...args) => { await rename(...args); throw ioError(); });
  const request = feedbackRequest();
  await rejects(f.store.act(f.comparisonId, request), "COMMIT_UNCERTAIN");
  mock.mock.restore();
  const current = await f.store.read(f.comparisonId);
  assert.equal(current.revision, 1);
  assert.equal(left(current).deleted, true);
  const retry = await f.store.act(f.comparisonId, request);
  assert.equal(retry.result.revision, 1);
  assert.equal((await f.store.snapshot(f.comparisonId)).actions.length, 1);
});

test("directory sync uncertainty blocks reads until persistence recovers, then deduplicates", async (t) => {
  const f = await fixture(t);
  let replaced = false;
  const rename = fs.rename.bind(fs);
  const renameMock = t.mock.method(fs, "rename", async (...args) => { await rename(...args); replaced = true; });
  const syncMock = mockHandles(t, (file, method, run) => {
    if (replaced && file === f.archiveDir && method === "sync") throw ioError();
    return run();
  });
  const request = feedbackRequest();
  await rejects(f.store.act(f.comparisonId, request), "COMMIT_UNCERTAIN");
  await rejects(f.store.read(f.comparisonId), "RECOVERY_REQUIRED");
  await rejects(f.store.act(f.comparisonId, request), "RECOVERY_REQUIRED");
  renameMock.mock.restore();
  syncMock.mock.restore();
  const recovered = await new DoubleStore({ archiveDir: f.archiveDir }).act(f.comparisonId, request);
  assert.equal(recovered.result.revision, 1);
  assert.equal(recovered.view.revision, 1);
  assert.equal((await f.store.snapshot(f.comparisonId)).feedback.length, 1);
});

test("failed Send and acknowledgment preserve prior state and accept exact Retry", async (t) => {
  const f = await fixture(t);
  const send = { actionId: "send", expectedRevision: 0 };
  let mock = mockHandles(t, (file, method, run) => {
    if (file.endsWith(".tmp") && method === "writeFile") throw ioError();
    return run();
  });
  await rejects(f.store.send(f.comparisonId, send), "WRITE_FAILED");
  mock.mock.restore();
  assert.equal((await f.store.read(f.comparisonId)).status, "editing");
  assert.equal(await f.store.poll(f.comparisonId), null);
  const sent = await f.store.send(f.comparisonId, send);
  const batch = await f.store.poll(f.comparisonId);
  const ack = { actionId: "ack", batchId: sent.result.batchId };
  mock = mockHandles(t, (file, method, run) => {
    if (file.endsWith(".tmp") && method === "sync") throw ioError();
    return run();
  });
  await rejects(f.store.acknowledge(f.comparisonId, ack), "WRITE_FAILED");
  mock.mock.restore();
  assert.deepEqual(await f.store.poll(f.comparisonId), batch);
  await f.store.acknowledge(f.comparisonId, ack);
  assert.equal(await f.store.poll(f.comparisonId), null);
});

for (const operation of ["send", "acknowledge"]) {
  test(`uncertain ${operation} recovers one stable result after restart`, async (t) => {
    const f = await fixture(t);
    let request = { actionId: "send", expectedRevision: 0 };
    if (operation === "acknowledge") {
      const sent = await f.store.send(f.comparisonId, request);
      request = { actionId: "ack", batchId: sent.result.batchId };
    }
    const before = await f.store.snapshot(f.comparisonId);
    const rename = fs.rename.bind(fs);
    const mock = t.mock.method(fs, "rename", async (...args) => { await rename(...args); throw ioError(); });
    await rejects(f.store[operation](f.comparisonId, request), "COMMIT_UNCERTAIN");
    mock.mock.restore();
    const store = new DoubleStore({ archiveDir: f.archiveDir });
    const recovered = await store[operation](f.comparisonId, request);
    assert.equal(recovered.result.revision, before.revision + 1);
    assert.equal((await store.snapshot(f.comparisonId)).receipts.length, before.receipts.length + 1);
    assert.deepEqual(await store[operation](f.comparisonId, request), recovered);
    if (operation === "acknowledge") assert.equal(await store.poll(f.comparisonId), null);
    else assert.equal((await store.poll(f.comparisonId)).id, recovered.result.batchId);
  });
}

test("fsync covers temporary content, replacement directory, and new archive parent before success", async (t) => {
  const f = await fixture(t, { create: false });
  const events = [];
  mockHandles(t, (file, method, run) => { if (method === "sync") events.push(["sync", file]); return run(); });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (...args) => { events.push(["rename", args[1]]); return rename(...args); });
  await f.store.create(f.input);
  const replace = events.findIndex(([operation]) => operation === "rename");
  assert.ok(events.slice(0, replace).some(([operation, file]) => operation === "sync" && file.endsWith(".tmp")));
  assert.ok(events.slice(0, replace).some(([operation, file]) => operation === "sync" && file === f.root));
  assert.deepEqual(events[replace + 1], ["sync", f.archiveDir]);
});

for (const [name, change, reseal] of [
  ["checksum mismatch", (doc) => { doc.state.left[0].keeper = true; }, false],
  ["unknown version", (doc) => { doc.schemaVersion = 7; }, true],
  ["mismatched identity", (doc) => { doc.comparisonId = "elsewhere"; }, true],
  ["missing state", (doc) => { delete doc.state; }, true],
  ["missing provenance", (doc) => { delete doc.provenance.panes.left; }, true],
  ["missing baseline", (doc) => { doc.baselines.left = []; }, true],
  ["unsafe provenance path", (doc) => { doc.manifest.panes.left.original.entry = "../original"; }, true],
  ["invalid baseline hash", (doc) => { doc.provenance.panes.left.copy.files[0].sha256 = "bad"; }, true],
  ["invented current state", (doc) => { doc.state.left[0].deleted = false; }, true],
  ["altered feedback", (doc) => { doc.feedback[0].comment = "revised"; }, true],
  ["altered action", (doc) => { doc.actions[0].priorState.keeper = true; }, true],
  ["altered result", (doc) => { doc.receipts[0].result.revision = 50; }, true],
  ["invalid receipt time", (doc) => { doc.receipts[0].at = "tomorrow"; }, true],
  ["unexpected field", (doc) => { doc.extra = true; }, true],
  ["inconsistent delivery", (doc) => { doc.delivery.status = "sent"; }, true],
]) {
  test(`preserves corrupt archive: ${name}`, async (t) => {
    const f = await fixture(t);
    await f.store.act(f.comparisonId, feedbackRequest());
    await tamper(f, change, reseal);
    const bytes = await fs.readFile(f.file);
    const store = new DoubleStore({ archiveDir: f.archiveDir });
    await rejects(store.read(f.comparisonId), "RECOVERY_REQUIRED");
    await rejects(store.create(f.input), "RECOVERY_REQUIRED");
    await rejects(store.act(f.comparisonId, feedbackRequest()), "RECOVERY_REQUIRED");
    await rejects(store.send(f.comparisonId, { actionId: "send", expectedRevision: 1 }), "RECOVERY_REQUIRED");
    await rejects(store.poll(f.comparisonId), "RECOVERY_REQUIRED");
    await rejects(store.acknowledge(f.comparisonId, { actionId: "ack", batchId: "batch" }), "RECOVERY_REQUIRED");
    assert.deepEqual(await fs.readFile(f.file), bytes);
    await f.verifyInputs();
  });
}

for (const invalid of ["{broken", "", "null", "[]", "{}", Buffer.from([0xff])]) {
  test(`invalid JSON archive never becomes empty state: ${String(invalid)}`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.file, invalid);
    const bytes = await fs.readFile(f.file);
    await rejects(f.store.read(f.comparisonId), "RECOVERY_REQUIRED");
    await rejects(f.store.create(f.input), "RECOVERY_REQUIRED");
    assert.deepEqual(await fs.readFile(f.file), bytes);
  });
}

test("missing, unreadable, and externally changed records block without overwrite", async (t) => {
  const f = await fixture(t);
  await rejects(f.store.read("missing"), "NOT_FOUND");
  const open = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.file) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return open(file, ...args);
  });
  await rejects(f.store.create(f.input), "RECOVERY_REQUIRED");
  mock.mock.restore();
  const external = "external corrupt data";
  const replacement = mockHandles(t, async (file, method, run) => {
    const result = await run();
    if (file.endsWith(".tmp") && method === "sync") await fs.writeFile(f.file, external);
    return result;
  });
  await rejects(f.store.act(f.comparisonId, keeperRequest()), "RECOVERY_REQUIRED");
  replacement.mock.restore();
  assert.equal(await fs.readFile(f.file, "utf8"), external);
});

test("identical reopen uses archive after copies disappear; different manifest never overwrites", async (t) => {
  const f = await fixture(t);
  await f.store.act(f.comparisonId, keeperRequest());
  const before = await fs.readFile(f.file);
  await rejects(f.store.create({ ...f.input, label: "changed" }), "COMPARISON_EXISTS");
  assert.deepEqual(await fs.readFile(f.file), before);
  await f.verifyInputs();
  for (const pane of ["left", "right"]) await fs.rm(f.input.panes[pane].copy.root, { recursive: true });
  const reopened = await new DoubleStore({ archiveDir: f.archiveDir }).create(f.input);
  assert.equal(left(reopened).keeper, true);
  await f.act("feedback-delete", { ...target, feedback: "Works without copies" });
  assert.equal((await f.store.snapshot(f.comparisonId)).feedback[0].text, "left & copy");
  await f.send();
  assert.ok((await f.store.poll(f.comparisonId)).payload.feedbackDeletions[0].html.includes("left &amp; copy"));
});

for (const [name, mutate] of [
  ["missing input fields", (input) => { delete input.label; }],
  ["unknown fields", (input) => { input.evidence = "untrusted"; }],
  ["missing ID", (input) => { delete input.comparisonId; }],
  ["empty ID", (input) => { input.comparisonId = ""; }],
  ["whitespace ID", (input) => { input.comparisonId = "bad id"; }],
  ["changed original hash", (input) => { input.panes.left.original.files[0].sha256 = "0".repeat(64); }],
  ["missing original", (input) => { input.panes.left.original.files.push({ path: path.join(path.dirname(input.panes.left.original.entry), "missing.html"), sha256: "0".repeat(64) }); }],
]) {
  test(`create preserves validateDoubleInput diagnostics: ${name}`, async (t) => {
    const f = await fixture(t, { create: false });
    mutate(f.input);
    await assert.rejects(f.store.create(f.input), (error) => error.code === "INVALID_INPUT" && error.diagnostics.length === 1);
    await assert.rejects(fs.stat(f.archiveDir), { code: "ENOENT" });
    await f.verifyInputs();
  });
}

test("baseline reread detects copy changes after input validation without saving evidence", async (t) => {
  const f = await fixture(t, { create: false });
  const file = path.join(f.input.panes.left.copy.root, "index.html");
  let reads = 0;
  const mock = mockHandles(t, (name, method, run) => {
    if (name === file && method === "readFile" && ++reads === 1) return Buffer.from(page(region("hero", "Hero", "changed")));
    return run();
  });
  await rejects(f.store.create(f.input), "FILE_CHANGED");
  mock.mock.restore();
  // The input validator holds its named open import; this mock sees the store's reread only.
  assert.equal(reads, 1);
  await assert.rejects(fs.stat(f.archiveDir), { code: "ENOENT" });
  await f.verifyInputs();
});

for (const name of ["original", "asset"]) {
  test(`baseline reread verifies ${name} bytes before archive creation`, async (t) => {
    const f = await fixture(t, { create: false });
    const file = name === "original" ? f.input.panes.left.original.entry : path.join(f.input.panes.left.copy.root, "site.css");
    let reads = 0;
    mockHandles(t, (name, method, run) => {
      if (name === file && method === "readFile" && ++reads === 1) return Buffer.from("changed");
      return run();
    });
    await rejects(f.store.create(f.input), "FILE_CHANGED");
    assert.equal(reads, 1);
    await assert.rejects(fs.stat(f.archiveDir), { code: "ENOENT" });
  });
}

for (const [name, html, expected] of [
  ["html", '<!doctype html><html data-double-id="root" data-container="Root"><head><title>Title</title></head><body>Text</body></html>', ["root"]],
  ["head", '<!doctype html><html><head data-double-id="head" data-container="Head"><title>Title</title></head><body>Text</body></html>', ["head"]],
  ["body", '<!doctype html><html><head></head><body data-double-id="body" data-container="Body">Text</body></html>', ["body"]],
  ["table", '<table><tr><td data-double-id="cell" data-container="Cell">Text</td></tr></table>', ["cell"]],
  ["optional ends", '<ul><li data-double-id="first" data-container="First">One<li data-double-id="second" data-container="Second">Two</ul>', ["first", "second"]],
  ["void", '<hr data-double-id="rule" data-container="Rule">', ["rule"]],
]) {
  test(`extracts accepted ${name} markers through parse5`, async (t) => {
    const f = await fixture(t, { html });
    const doc = await f.store.snapshot(f.comparisonId);
    assert.deepEqual(doc.baselines.left.map(({ id }) => id), expected);
    for (const region of doc.baselines.left) {
      assert.ok(region.html.includes(`data-double-id="${region.id}"`));
      assert.equal(typeof region.text, "string");
    }
    await f.verifyInputs();
  });
}

for (const malicious of ["../../escape", "/absolute", "__proto__", "constructor", "a/b", "a\\b", "%2e%2e%2foutside", "emoji-\u2603"]) {
  test(`path-like comparison/component/action IDs stay data: ${malicious}`, async (t) => {
    const f = await fixture(t, { comparisonId: malicious, html: page(region(malicious)) });
    const req = { actionId: malicious, expectedRevision: 0, kind: "feedback-delete", pane: "left", componentId: malicious, feedback: "Safe" };
    await f.store.act(f.comparisonId, req);
    const view = await f.store.read(f.comparisonId);
    assert.equal(left(view).deleted, true);
    assert.equal(view.panes.right.components[0].deleted, false);
    assert.deepEqual(await fs.readdir(f.archiveDir), [path.basename(f.file)]);
    assert.match(path.basename(f.file), /^double-[a-f0-9]{64}\.json$/);
    assert.deepEqual((await f.store.act(f.comparisonId, req)).result.actionId, malicious);
    await f.verifyInputs();
  });
}

test("parsed baseline HTML excludes text foster-parented outside a marked table", async (t) => {
  const html = '<table data-double-id="table" data-container="Table">Outside<tr><td>Inside</td></tr></table>';
  const f = await fixture(t, { html });
  const doc = await f.store.snapshot(f.comparisonId);
  assert.equal(doc.baselines.left[0].html, '<table data-double-id="table" data-container="Table"><tbody><tr><td>Inside</td></tr></tbody></table>');
  assert.equal(doc.baselines.left[0].text, "Inside");
  await f.verifyInputs();
});

test("snapshot includes the complete authoritative document with its checksum", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.snapshot(f.comparisonId), JSON.parse(await fs.readFile(f.file, "utf8")));
});

test("reordered JSON object keys are an identical request, not a second action", async (t) => {
  const f = await fixture(t);
  const request = keeperRequest();
  const saved = await f.store.act(f.comparisonId, request);
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.deepEqual(await f.store.act(f.comparisonId, reordered), saved);
  assert.equal((await f.store.snapshot(f.comparisonId)).receipts.length, 1);
});

for (const [operation, request] of [
  ["send", { actionId: "send", expectedRevision: 0, extra: true }],
  ["send", { actionId: "send" }],
  ["acknowledge", { actionId: "ack", batchId: "batch", extra: true }],
  ["acknowledge", { actionId: "ack" }],
  ["acknowledge", { actionId: "ack", batchId: "" }],
]) {
  test(`${operation} validates its exact request shape: ${JSON.stringify(request)}`, async (t) => {
    const f = await fixture(t);
    const before = await fs.readFile(f.file);
    await assert.rejects(f.store[operation](f.comparisonId, request), (error) => ["INVALID_REQUEST", "INVALID_ID"].includes(error.code));
    assert.deepEqual(await fs.readFile(f.file), before);
  });
}

test("failed create can retry, and uncertain create reopens its committed original", async (t) => {
  const f = await fixture(t, { create: false });
  const writeMock = mockHandles(t, (file, method, run) => {
    if (file.endsWith(".tmp") && method === "writeFile") throw ioError();
    return run();
  });
  await rejects(f.store.create(f.input), "WRITE_FAILED");
  writeMock.mock.restore();
  assert.deepEqual(await fs.readdir(f.archiveDir), []);
  const rename = fs.rename.bind(fs);
  const renameMock = t.mock.method(fs, "rename", async (...args) => { await rename(...args); throw ioError(); });
  await rejects(f.store.create(f.input), "COMMIT_UNCERTAIN");
  renameMock.mock.restore();
  const saved = await fs.readFile(f.file);
  assert.equal((await new DoubleStore({ archiveDir: f.archiveDir }).create(f.input)).revision, 0);
  assert.deepEqual(await fs.readFile(f.file), saved);
  await f.verifyInputs();
});

test("missing authoritative record blocks existing store actions without reconstructing memory", async (t) => {
  const f = await fixture(t);
  await f.store.act(f.comparisonId, keeperRequest());
  await fs.rename(f.file, path.join(f.archiveDir, "saved-for-test.json"));
  await rejects(f.store.read(f.comparisonId), "NOT_FOUND");
  await rejects(f.store.act(f.comparisonId, keeperRequest()), "NOT_FOUND");
  assert.deepEqual(await fs.readdir(f.archiveDir), ["saved-for-test.json"]);
});

test("distinct comparison IDs create distinct documents even with shared component/action IDs", async (t) => {
  const f = await fixture(t);
  await f.store.create({ ...f.input, comparisonId: "trial/1" });
  await f.store.act(f.comparisonId, keeperRequest());
  assert.equal(left(await f.store.read("trial/1")).keeper, false);
  await f.store.act("trial/1", keeperRequest());
  assert.equal((await fs.readdir(f.archiveDir)).length, 2);
});

for (const options of [undefined, {}, { archiveDir: "relative" }, { archiveDir: "/" }, { archiveDir: "/tmp/x/../a" }, { archiveDir: "/tmp/x/" }, { archiveDir: "/tmp/x", extra: true }]) {
  test(`requires explicit canonical archive options: ${JSON.stringify(options)}`, () => {
    assert.throws(() => new DoubleStore(options), (error) => ["INVALID_REQUEST", "UNSAFE_PATH"].includes(error.code));
  });
}

for (const name of ["copy root", "copy descendant", "original directory", "input ancestor"]) {
  test(`archive cannot overlap ${name}`, async (t) => {
    const f = await fixture(t, { create: false });
    const archiveDir = {
      "copy root": f.input.panes.left.copy.root,
      "copy descendant": path.join(f.input.panes.left.copy.root, "archive"),
      "original directory": path.dirname(f.input.panes.left.original.entry),
      "input ancestor": f.root,
    }[name];
    await assert.rejects(new DoubleStore({ archiveDir }).create(f.input), (error) => ["UNSAFE_PATH", "RECOVERY_REQUIRED"].includes(error.code));
    await f.verifyInputs();
  });
}

for (const name of ["archive symlink", "parent symlink", "record symlink", "record hardlink", "record directory", "record public mode", "directory public mode"]) {
  test(`rejects unsafe private paths: ${name}`, async (t) => {
    const f = await fixture(t);
    let archiveDir = f.archiveDir;
    if (name === "archive symlink") {
      archiveDir = path.join(f.root, "linked");
      await fs.symlink(f.archiveDir, archiveDir);
    } else if (name === "parent symlink") {
      const alias = path.join(f.root, "parent-link");
      await fs.symlink(f.root, alias);
      archiveDir = path.join(alias, "archive");
    } else if (name === "record symlink") {
      await fs.rm(f.file);
      await fs.symlink(f.input.panes.left.original.entry, f.file);
    } else if (name === "record hardlink") {
      await fs.rm(f.file);
      await fs.link(f.input.panes.left.original.entry, f.file);
    } else if (name === "record directory") {
      await fs.rm(f.file);
      await fs.mkdir(f.file);
    } else if (name === "record public mode") await fs.chmod(f.file, 0o644);
    else await fs.chmod(f.archiveDir, 0o755);
    const store = new DoubleStore({ archiveDir });
    await rejects(store.read(f.comparisonId), "RECOVERY_REQUIRED");
    await rejects(store.create(f.input), "RECOVERY_REQUIRED");
    await f.verifyInputs();
  });
}

test("new archive never follows an existing symlink parent or creates missing parent chains", async (t) => {
  const f = await fixture(t, { create: false });
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.root, alias);
  await rejects(new DoubleStore({ archiveDir: path.join(alias, "archive") }).create(f.input), "RECOVERY_REQUIRED");
  await rejects(new DoubleStore({ archiveDir: path.join(f.root, "missing", "archive") }).create(f.input), "WRITE_FAILED");
  await assert.rejects(fs.stat(path.join(f.root, "missing")), { code: "ENOENT" });
  await f.verifyInputs();
});

test("no retention cleanup removes unrelated records or earlier crash temporary files", async (t) => {
  const f = await fixture(t);
  const legacy = path.join(f.archiveDir, "unrelated-feedback.json");
  const orphan = path.join(f.archiveDir, ".double-old-crash.tmp");
  await fs.writeFile(legacy, "keep legacy data");
  await fs.writeFile(orphan, "keep uncertain data");
  await f.send();
  const batch = await f.store.poll(f.comparisonId);
  await f.store.acknowledge(f.comparisonId, { actionId: "ack", batchId: batch.id });
  assert.equal(await fs.readFile(legacy, "utf8"), "keep legacy data");
  assert.equal(await fs.readFile(orphan, "utf8"), "keep uncertain data");
  assert.equal((await fs.readdir(f.archiveDir)).length, 3);
});

test("rejects non-JSON request fields instead of silently dropping them", async (t) => {
  const f = await fixture(t);
  const cyclic = keeperRequest();
  cyclic.extra = cyclic;
  const accessor = keeperRequest();
  Object.defineProperty(accessor, "selected", { enumerable: true, get() { throw new Error("must not run"); } });
  const symbol = keeperRequest();
  symbol[Symbol("hidden")] = "bad";
  const hidden = keeperRequest();
  Object.defineProperty(hidden, "hidden", { value: "bad" });
  for (const request of [cyclic, accessor, symbol, hidden, { ...keeperRequest(), extra: () => {} }, { ...keeperRequest(), extra: new Date() }]) {
    await rejects(f.store.act(f.comparisonId, request), "INVALID_REQUEST");
  }
  assert.equal((await f.store.read(f.comparisonId)).revision, 0);
});
