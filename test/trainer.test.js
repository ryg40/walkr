import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { listen, request } from "./double-fixtures.js";
import { toggleRank } from "../src/trainer-rank.js";
import { tmpRoot } from "./tmp-root.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const API = "/_walkr/trainer/api";
const PERMUTATIONS = [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]];

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-trainer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  return { dir, stateDir, archiveDir: path.join(dir, "archive"), root: path.join(dir, "walkr", "trainer") };
}

async function serve(t, f, root = f.root) {
  const s = await listen(t, f, { HUMAN_REVIEW_TRAINER_ROOT: root });
  return { ...s, agent: (route, options) => s.api(`${API}/${route}`, options) };
}

function dataset(count) {
  return Array.from({ length: count }, (_, i) => ({
    sourceId: `STORY-${String(i + 1).padStart(3, "0")}`,
    format: i % 2 ? "markdown" : "text",
    title: `Story ${i + 1}`,
    content: i === 0 ? '<img src=x onerror="window.injected=1"><script>window.injected=2</script>' : `As a user I want feature ${i + 1}.\n\n- detail ${i}`,
  }));
}

function planFor(items) {
  const groups = [];
  for (let i = 0; i + 3 <= items.length; i += 3) {
    groups.push({ groupId: `g${String(i / 3 + 1).padStart(3, "0")}`, sourceIds: items.slice(i, i + 3).map((item) => item.sourceId), explanation: "Similar scope" });
  }
  return { explanation: "Grouped by product area.", groups, leftovers: items.slice(groups.length * 3).map((item) => item.sourceId) };
}

function createBody(items, actionId = "create-1", repo = "example-app") {
  return { actionId, repo: { name: repo, revision: "3bc9b6c" }, task: "Rank the stories by clarity of acceptance criteria.", items, plan: planFor(items) };
}

async function owner(s, pagePath) {
  const page = await request(s.port, pagePath);
  assert.equal(page.status, 200);
  const token = page.text.match(/data-token="([a-f0-9]{64})"/)[1];
  return { page, token, call: (route, options = {}) => request(s.port, `${API}/${route}`, { token, ...options }) };
}

function recordPath(f, view) {
  return path.join(f.root, view.repo.name, "dataset", view.sessionId, "dataset.json");
}

async function approved(t, f, count = 6) {
  const s = await serve(t, f);
  const items = dataset(count);
  const created = await s.agent("sessions", { method: "POST", body: createBody(items) });
  assert.equal(created.status, 200, created.text);
  const view = created.json.view;
  const session = `sessions/${view.repo.name}/${view.sessionId}`;
  const browser = await owner(s, created.json.path);
  const review = await browser.call(`${session}/review`, { method: "POST", body: { actionId: "review-1", revision: 1, decision: "approve" } });
  assert.equal(review.status, 200, review.text);
  return { s, items, view: review.json.view, session, browser };
}

function ranksFor(group, permutation) {
  return Object.fromEntries(group.candidates.map((candidate, i) => [candidate.candidateId, permutation[i]]));
}

test("a 100-item dataset accounts for every source ID once, keeps exact votes across restart, and refuses lossy plans", async (t) => {
  const f = await setup(t);
  let s = await serve(t, f);
  const items = dataset(100);
  const lossy = [
    (plan) => { plan.leftovers = []; },
    (plan) => { plan.groups[1].sourceIds[0] = plan.groups[0].sourceIds[0]; },
    (plan) => { plan.groups[0].sourceIds[0] = "INVENTED-1"; },
    (plan) => { plan.leftovers.push(...plan.groups.pop().sourceIds); },
    (plan) => { plan.leftovers.push(plan.groups[0].sourceIds.pop()); },
  ];
  for (const change of lossy) {
    const body = createBody(items, `lossy-${lossy.indexOf(change)}`);
    change(body.plan);
    const refused = await s.agent("sessions", { method: "POST", body });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, "INVALID_PLAN");
  }
  assert.deepEqual((await s.agent("repos/example-app")).json.sessions, []);

  const created = await s.agent("sessions", { method: "POST", body: createBody(items) });
  assert.equal(created.status, 200, created.text);
  const { sessionId } = created.json.view;
  const session = `sessions/example-app/${sessionId}`;
  assert.match(sessionId, /^\d{8}T\d{6}Z-[a-f0-9]{12}$/);
  assert.equal((await s.agent(`${session}/review`, { method: "POST", body: { actionId: "agent-review", revision: 1, decision: "approve" } })).status, 403);
  let browser = await owner(s, created.json.path);
  const review = await browser.call(`${session}/review`, { method: "POST", body: { actionId: "review-1", revision: 1, decision: "approve" } });
  assert.equal(review.json.view.status, "ranking");
  const groups = review.json.view.groups;
  assert.equal(groups.length, 33);
  const expected = new Map();
  const save = async (call, group, index) => {
    const ranks = ranksFor(group, PERMUTATIONS[index % PERMUTATIONS.length]);
    expected.set(group.groupId, ranks);
    const saved = await call(`${session}/save`, { method: "POST", body: { actionId: `save-${group.groupId}`, groupId: group.groupId, ranks } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.result.outcome, "saved");
  };
  assert.equal((await s.agent(`${session}/save`, { method: "POST", body: { actionId: "agent-vote", groupId: groups[0].groupId, ranks: ranksFor(groups[0], [1, 2, 3]) } })).status, 403);
  for (const [index, group] of groups.slice(0, 10).entries()) await save(browser.call, group, index);

  await s.close();
  s = await serve(t, f);
  assert.equal((await request(s.port, `${API}/${session}`, { token: browser.token })).status, 401);
  const reopened = await s.agent(`${session}/open`, { method: "POST", body: {} });
  assert.equal(reopened.json.view.progress.saved, 10);
  browser = await owner(s, reopened.json.path);
  for (const [index, group] of groups.entries()) if (index >= 10) await save(browser.call, group, index);
  const leftover = await browser.call(`${session}/save`, { method: "POST", body: { actionId: "leftover", groupId: "STORY-100", ranks: {} } });
  assert.equal(leftover.status, 404);
  // A page credential reaches only its own session.
  const other = await s.agent("sessions", { method: "POST", body: createBody(dataset(3), "create-other") });
  const otherSession = `sessions/example-app/${other.json.view.sessionId}`;
  await (await owner(s, other.json.path)).call(`${otherSession}/review`, { method: "POST", body: { actionId: "review-other", revision: 1, decision: "approve" } });
  const otherBefore = await fs.readFile(recordPath(f, other.json.view));
  assert.equal((await browser.call(otherSession)).status, 403);
  const otherGroup = (await s.agent(otherSession)).json.view.groups[0];
  const crossed = await browser.call(`${otherSession}/save`, { method: "POST", body: { actionId: "cross", groupId: otherGroup.groupId, ranks: ranksFor(otherGroup, [1, 2, 3]) } });
  assert.equal(crossed.status, 403);
  assert.deepEqual(await fs.readFile(recordPath(f, other.json.view)), otherBefore);

  const record = JSON.parse(await fs.readFile(recordPath(f, created.json.view), "utf8"));
  assert.equal(record.status, "complete");
  assert.equal(record.schema, "walkr-trainer-dataset");
  assert.equal(record.version, 1);
  const placed = [...record.groups.flatMap((group) => group.candidates.map((candidate) => candidate.sourceId)), ...record.leftovers.map((item) => item.sourceId)];
  assert.deepEqual([...placed].sort(), items.map((item) => item.sourceId).sort());
  assert.equal(new Set(placed).size, 100);
  assert.deepEqual(record.leftovers, [{ sourceId: "STORY-100", state: "unranked", contentSha256: sha(items[99].content) }]);
  for (const group of record.groups) {
    assert.deepEqual(group.vote.ranks, expected.get(group.groupId));
    assert.deepEqual([...group.displayOrder].sort(), group.candidates.map((candidate) => candidate.candidateId).sort());
  }
  assert.equal(record.groups.filter((group) => group.vote).length, expected.size);
  for (const [index, item] of record.items.entries()) {
    assert.equal(item.content, items[index].content);
    assert.equal(item.contentSha256, sha(items[index].content));
  }
});

test("rank removal closes the gap, the page saves only a complete ranking, and the server refuses incomplete ones", async (t) => {
  let ranks = {};
  for (const id of ["a", "b", "c"]) ranks = toggleRank(ranks, id);
  assert.deepEqual(ranks, { a: 1, b: 2, c: 3 });
  ranks = toggleRank(ranks, "a");
  assert.deepEqual(ranks, { b: 1, c: 2 });
  ranks = toggleRank(ranks, "a");
  assert.deepEqual(ranks, { b: 1, c: 2, a: 3 });
  assert.deepEqual(toggleRank(toggleRank(ranks, "c"), "d"), { b: 1, a: 2, d: 3 });
  assert.deepEqual(toggleRank(ranks, "d"), ranks);

  const f = await setup(t);
  const { s, view, session, browser, items } = await approved(t, f);
  const file = recordPath(f, view);
  const before = await fs.readFile(file);
  const [group] = view.groups;
  const [a, b, c] = group.candidates.map((candidate) => candidate.candidateId);
  for (const bad of [{ [a]: 1, [b]: 2 }, { [a]: 1, [b]: 1, [c]: 2 }, { [a]: 1, [b]: 2, [c]: 4 }, { [a]: 0, [b]: 1, [c]: 2 },
    { [a]: 1, [b]: 2, [c]: 3, extra: 4 }, { [a]: "1", [b]: 2, [c]: 3 }]) {
    const refused = await browser.call(`${session}/save`, { method: "POST", body: { actionId: `bad-${JSON.stringify(bad)}`, groupId: group.groupId, ranks: bad } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, "INCOMPLETE_RANKING");
  }
  assert.deepEqual(await fs.readFile(file), before);

  // The real page module in jsdom against the authenticated server.
  const dom = new JSDOM(browser.page.text, { url: `http://127.0.0.1:${s.port}/` });
  const { bootTrainer } = await import("../src/trainer.js");
  const fetchImpl = (url, options) => fetch(new URL(url, `http://127.0.0.1:${s.port}`), options);
  const app = bootTrainer(dom.window, { fetch: fetchImpl, refreshMs: 60000 });
  t.after(() => { app.close(); dom.window.close(); });
  await app.ready;
  const doc = dom.window.document;
  const card = (id) => doc.querySelector(`[data-candidate="${id}"]`);
  const rank = (id) => card(id).dataset.rank;
  assert.equal(dom.window.injected, undefined);
  assert.equal(doc.querySelectorAll("[data-candidate] img, [data-candidate] script").length, 0);
  assert.ok([...doc.querySelectorAll("[data-candidate]")].some((node) => node.textContent.includes(items[0].content)));
  card(a).click(); card(b).click(); card(c).click();
  assert.deepEqual([rank(a), rank(b), rank(c)], ["1", "2", "3"]);
  card(a).click();
  assert.deepEqual([rank(b), rank(c)], ["1", "2"]);
  assert.equal(doc.getElementById("save").disabled, true);
  card(a).click();
  assert.equal(rank(a), "3");
  doc.getElementById("save").click();
  let saved = null;
  for (let i = 0; i < 250 && !saved; i += 1) {
    saved = JSON.parse(await fs.readFile(file, "utf8")).groups[0].vote;
    if (!saved) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(saved, "Save and Next did not reach the record");
  assert.deepEqual(saved.ranks, { [b]: 1, [c]: 2, [a]: 3 });
  assert.deepEqual(saved.ranking, [b, c, a]);
});

test("duplicate or uncertain Save and Next and duplicate creates resolve to the first saved result", async (t) => {
  const f = await setup(t);
  const { s, view, session, browser, items } = await approved(t, f);
  const file = recordPath(f, view);
  const [group] = view.groups;
  const body = { actionId: "save-1", groupId: group.groupId, ranks: ranksFor(group, [2, 1, 3]), comment: "Clear criteria." };
  const before = await fs.readFile(file);
  for (const bad of [{ groupId: group.groupId, ranks: body.ranks }, { ...body, actionId: 7 }, null]) {
    const refused = await browser.call(`${session}/save`, { method: "POST", body: bad });
    assert.equal(refused.status, 400, refused.text);
  }
  assert.deepEqual(await fs.readFile(file), before);
  const first = await browser.call(`${session}/save`, { method: "POST", body });
  assert.equal(first.json.result.replay, false);
  const after = await fs.readFile(file);
  const again = await browser.call(`${session}/save`, { method: "POST", body });
  assert.equal(again.status, 200);
  assert.equal(again.json.result.replay, true);
  assert.deepEqual(again.json.result.vote, first.json.result.vote);
  const otherTab = await browser.call(`${session}/save`, { method: "POST", body: { ...body, actionId: "save-2", ranks: ranksFor(group, [3, 2, 1]) } });
  assert.equal(otherTab.json.result.outcome, "already-saved");
  assert.deepEqual(otherTab.json.result.vote.ranks, body.ranks);
  const conflict = await browser.call(`${session}/save`, { method: "POST", body: { ...body, ranks: ranksFor(group, [1, 2, 3]) } });
  assert.equal(conflict.json.error.code, "ACTION_CONFLICT");
  assert.deepEqual(await fs.readFile(file), after);

  const duplicate = await s.agent("sessions", { method: "POST", body: createBody(items) });
  assert.equal(duplicate.json.view.sessionId, view.sessionId);
  assert.equal(duplicate.json.result.replay, true);
  const changed = await s.agent("sessions", { method: "POST", body: { ...createBody(items), task: "Other task" } });
  assert.equal(changed.json.error.code, "ACTION_CONFLICT");
  assert.equal((await fs.readdir(path.join(f.root, "example-app", "dataset"))).length, 1);
  assert.deepEqual(await fs.readFile(file), after);
});

test("votes persist when analysis fails, and a retry adds analysis without changing votes", async (t) => {
  const f = await setup(t);
  const { s, view, session, browser } = await approved(t, f);
  const [group] = view.groups;
  const saved = await browser.call(`${session}/save`, { method: "POST", body: { actionId: "save-1", groupId: group.groupId, ranks: ranksFor(group, [3, 1, 2]) } });
  const vote = saved.json.result.vote;
  let pending = (await s.agent(`${session}/analysis`)).json;
  assert.deepEqual(pending.requests.map((item) => item.groupId), [group.groupId]);
  assert.deepEqual(pending.requests[0].ranking.map((item) => item.rank), [1, 2, 3]);
  assert.equal((await browser.call(`${session}/analysis/submit`, { method: "POST", body: {} })).status, 403);

  const failed = await s.agent(`${session}/analysis/fail`, { method: "POST", body: { actionId: "analysis-1", groupId: group.groupId, voteSha256: vote.voteSha256, error: "Model timeout", model: { id: "offline-fixture" } } });
  assert.equal(failed.status, 200, failed.text);
  const record = JSON.parse(await fs.readFile(recordPath(f, view), "utf8"));
  assert.deepEqual(record.groups[0].vote, vote);
  pending = (await s.agent(`${session}/analysis`)).json;
  assert.equal(pending.requests[0].lastError, "Model timeout");

  const analysis = { actionId: "analysis-2", groupId: group.groupId, voteSha256: vote.voteSha256, model: { id: "offline-fixture", provider: "test" },
    preferred: "Concrete acceptance criteria.", lowest: "Vague scope." };
  assert.equal((await s.agent(`${session}/analysis/submit`, { method: "POST", body: { ...analysis, voteSha256: "0".repeat(64) } })).json.error.code, "STALE_VOTE");
  const done = await s.agent(`${session}/analysis/submit`, { method: "POST", body: analysis });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json.result.analysis.preferred.candidateIds, vote.ranking.slice(0, 2));
  assert.equal(done.json.result.analysis.lowest.candidateId, vote.ranking[2]);
  assert.deepEqual(done.json.view.groups[0].vote, vote);
  assert.equal((await s.agent(`${session}/analysis/submit`, { method: "POST", body: { ...analysis, actionId: "analysis-3" } })).json.error.code, "ANALYSIS_EXISTS");
  const final = JSON.parse(await fs.readFile(recordPath(f, view), "utf8"));
  assert.deepEqual(final.groups[0].vote, vote);
  assert.deepEqual(final.analyses.map((item) => [item.status, item.model.id]), [["failed", "offline-fixture"], ["complete", "offline-fixture"]]);
  assert.deepEqual((await s.agent(`${session}/analysis`)).json.requests, []);
});

async function files(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(full)); else if (entry.isFile()) out.push(full);
  }
  return out;
}

test("unsafe repo names, traversal, symlinked and writable roots are refused without writes outside the root", async (t) => {
  const f = await setup(t);
  const outside = path.join(f.dir, "outside");
  await fs.mkdir(outside, { mode: 0o700 });
  const items = dataset(3);
  let s = await serve(t, f);
  for (const [index, name] of ["..", ".", ".hidden", "a/b", "a b", "", "x".repeat(101), "../outside", "repo\u0000"].entries()) {
    const refused = await s.agent("sessions", { method: "POST", body: createBody(items, `bad-${index}`, name) });
    assert.equal(refused.status, 400, name);
    assert.equal(refused.json.error.code, "UNSAFE_REPO");
  }
  for (const route of ["repos/..", "repos/%2e%2e", "sessions/example-app/..", "sessions/..%2Foutside/20261024T000000Z-000000000000",
    "sessions/example-app/20261024T000000Z-000000000000%2F..", "sessions/example-app/../../outside"]) {
    const refused = await s.agent(route);
    assert.ok([400, 404].includes(refused.status), route);
  }
  await fs.mkdir(path.join(f.root), { recursive: true, mode: 0o700 });
  await fs.symlink(outside, path.join(f.root, "linked-repo"));
  assert.equal((await s.agent("sessions", { method: "POST", body: createBody(items, "linked", "linked-repo") })).json.error.code, "UNSAFE_PATH");
  const created = await s.agent("sessions", { method: "POST", body: createBody(items) });
  assert.equal(created.status, 200);
  const datasetDir = path.join(f.root, "example-app", "dataset");
  const fakeSession = "20261024T000000Z-000000000000";
  await fs.mkdir(path.join(outside, fakeSession), { mode: 0o700 });
  await fs.symlink(path.join(outside, fakeSession), path.join(datasetDir, fakeSession));
  assert.equal((await s.agent(`sessions/example-app/${fakeSession}`)).json.error.code, "UNSAFE_PATH");
  assert.equal((await s.agent("sessions", { method: "POST", body: createBody(items, "after-link") })).status, 400);
  await s.close();

  const linkedRoot = path.join(f.dir, "linked-root");
  await fs.symlink(outside, linkedRoot);
  s = await serve(t, f, linkedRoot);
  assert.equal((await s.agent("sessions", { method: "POST", body: createBody(items, "x") })).json.error.code, "UNSAFE_PATH");
  await s.close();
  s = await serve(t, f, path.join(linkedRoot, "nested", "trainer"));
  assert.equal((await s.agent("sessions", { method: "POST", body: createBody(items, "y") })).json.error.code, "UNSAFE_PATH");
  await s.close();
  const writable = path.join(f.dir, "writable");
  await fs.mkdir(writable);
  await fs.chmod(writable, 0o777);
  s = await serve(t, f, writable);
  assert.equal((await s.agent("sessions", { method: "POST", body: createBody(items, "z") })).json.error.code, "UNSAFE_PATH");
  await s.close();
  s = await serve(t, f, "relative/root");
  assert.equal((await s.agent("sessions", { method: "POST", body: createBody(items, "r") })).json.error.code, "UNSAFE_PATH");

  assert.deepEqual(await fs.readdir(path.join(outside, fakeSession)), []);
  assert.deepEqual((await fs.readdir(outside)).sort(), [fakeSession]);
  assert.deepEqual(await fs.readdir(writable), []);
  const written = (await files(f.dir)).filter((file) => !file.startsWith(`${f.root}${path.sep}`) && !file.startsWith(`${f.stateDir}${path.sep}`));
  assert.deepEqual(written, []);
});

test("agent CLI submits a dataset, reads the review, and refuses hosted or missing configuration without writes", async (t) => {
  const { spawn, execFile } = await import("node:child_process");
  const f = await setup(t);
  const entry = path.join(import.meta.dirname, "..", "src", "walkr-trainer.js");
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_TRAINER_ROOT: f.root, HUMAN_REVIEW_HOSTED: "0", HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: "" };
  const run = (args, extra = {}) => new Promise((resolve) => execFile(process.execPath, [entry, ...args], { env: { ...env, ...extra }, timeout: 15000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  for (const extra of [{ HUMAN_REVIEW_HOSTED: "1" }, { HUMAN_REVIEW_STATE_DIR: "" }, { HUMAN_REVIEW_TRAINER_ROOT: "relative" }]) {
    const refused = await run(["list", "example-app"], extra);
    assert.equal(refused.code, 1);
  }
  assert.equal((await run(["--help"])).code, 0);
  const hosted = await listen(t, f, { HUMAN_REVIEW_TRAINER_ROOT: f.root, HUMAN_REVIEW_HOSTED: "1" });
  for (const [route, method, body] of [["capabilities", "GET"], ["sessions", "POST", createBody(dataset(3))], ["repos/example-app", "GET"]]) {
    const refused = await hosted.api(`${API}/${route}`, { method, body });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.code, "HOSTED_UNSUPPORTED");
  }
  await hosted.close();
  assert.equal(await fs.stat(f.root).catch(() => null), null);

  const server = spawn(process.execPath, [entry, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => server.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (bytes) => { if (String(bytes).includes("listening")) resolve(); });
    server.once("exit", () => reject(new Error("serve exited")));
  });
  const request = path.join(f.dir, "request.json");
  await fs.writeFile(request, JSON.stringify(createBody(dataset(7))));
  const created = await run(["create", request]);
  assert.equal(created.code, 0, created.stderr);
  const answer = JSON.parse(created.stdout);
  assert.match(answer.url, /^http:\/\/127\.0\.0\.1:\d+\/_walkr\/trainer\/s\/[a-f0-9]{64}$/);
  assert.equal(JSON.parse((await run(["create", request])).stdout).sessionId, answer.sessionId);
  const review = JSON.parse((await run(["review", "example-app", answer.sessionId])).stdout);
  assert.deepEqual([review.status, review.revision, review.review], ["plan-review", 1, null]);
  const waited = JSON.parse((await run(["wait", "example-app", answer.sessionId, "--for", "review", "--timeout", "0.3"])).stdout);
  assert.equal(waited.status, "timeout");
  assert.deepEqual(JSON.parse((await run(["analysis", "pending", "example-app", answer.sessionId])).stdout).requests, []);
  assert.equal((await run(["view", "../x", answer.sessionId])).code, 1);
  const listed = JSON.parse((await run(["list", "example-app"])).stdout);
  assert.deepEqual(listed.sessions.map((item) => item.sessionId), [answer.sessionId]);
});
