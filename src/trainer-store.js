import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { capture, fail, hash, id, inspect, readBytes } from "./double-archive.js";
import { completeRanking } from "./trainer-rank.js";
import { isCanonicalAbsolute } from "./canonical-path.js";
import { POSIX_ONLY_CODE, posixOnlyRefusal } from "./posix-only.js";

export const SCHEMA = "walkr-trainer-dataset";
export const VERSION = 1;
const RECORD = "dataset.json";
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SESSION = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const FORMATS = new Set(["text", "markdown"]);
const LIMITS = { items: 3000, content: 256 * 1024, text: 8000, short: 200 };
const queues = new Map();
const ENDED = "The owner ended this Trainer session. Saved votes stay; no new plan, review, or vote is accepted.";

/** The configured dataset root, by default ~/.local/.walkr/trainer. Tests and trials set HUMAN_REVIEW_TRAINER_ROOT to a disposable directory. */
export function trainerRoot(env = process.env, home = os.homedir()) {
  return env.HUMAN_REVIEW_TRAINER_ROOT || path.join(home, ".local", ".walkr", "trainer");
}

export function canonicalRoot(value) {
  if (!isCanonicalAbsolute(value)) {
    fail("UNSAFE_PATH", "The Trainer root must be a canonical absolute directory without traversal or a trailing slash.");
  }
  return value;
}

export function repoName(value) {
  if (typeof value !== "string" || !REPO.test(value)) {
    fail("UNSAFE_REPO", "A repository name uses 1-100 letters, digits, dots, underscores, or hyphens, and starts with a letter or digit.");
  }
  return value;
}

export function sessionName(value) {
  if (typeof value !== "string" || !SESSION.test(value)) fail("INVALID_ID", "Unknown Trainer session ID format.");
  return value;
}

/** Stable JSON for request and content identity; object key order never changes a hash. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function shape(value, required, optional = []) {
  const ok = value !== null && typeof value === "object" && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  if (!ok) fail("INVALID_REQUEST", `Expected fields ${required.join(", ")}${optional.length ? ` and optional ${optional.join(", ")}` : ""}.`);
  return value;
}

function text(value, name, { max = LIMITS.text, optional = false, empty = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) {
    fail("INVALID_REQUEST", `${name} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters.`);
  }
  return value;
}

function itemId(value, name) {
  id(value);
  if (value.length > LIMITS.short) fail("INVALID_ID", `${name} must be at most ${LIMITS.short} characters.`);
  return value;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.[0-9]{3}Z$/, "Z");
}

const now = () => new Date().toISOString();

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > LIMITS.items) {
    fail("INVALID_REQUEST", `Supply 1-${LIMITS.items} prepared items.`);
  }
  const seen = new Set();
  return items.map((item) => {
    shape(item, ["sourceId", "format", "content"], ["title", "uri"]);
    itemId(item.sourceId, "sourceId");
    if (seen.has(item.sourceId)) fail("DUPLICATE_SOURCE", "Each prepared item needs a unique sourceId.");
    seen.add(item.sourceId);
    if (!FORMATS.has(item.format)) fail("INVALID_REQUEST", "Item format must be text or markdown.");
    text(item.content, "Item content", { max: LIMITS.content, empty: true });
    const out = { sourceId: item.sourceId, format: item.format, content: item.content, contentSha256: hash(item.content) };
    if (item.title !== undefined) out.title = text(item.title, "Item title", { max: LIMITS.short * 2 });
    if (item.uri !== undefined) out.uri = text(item.uri, "Item uri", { max: 2000 });
    return out;
  });
}

/** Every source ID appears exactly once: in one complete group of three, or in the remainder leftovers. */
function normalizePlan(plan, items) {
  shape(plan, ["explanation", "groups", "leftovers"]);
  const explanation = text(plan.explanation, "Plan explanation");
  if (!Array.isArray(plan.groups) || !Array.isArray(plan.leftovers)) fail("INVALID_PLAN", "Plan groups and leftovers must be arrays.");
  const known = new Set(items.map((item) => item.sourceId));
  const used = new Set();
  const take = (sourceId) => {
    itemId(sourceId, "sourceId");
    if (!known.has(sourceId)) fail("INVALID_PLAN", "The plan names a source ID that is not in the dataset.");
    if (used.has(sourceId)) fail("INVALID_PLAN", "The plan uses a source ID more than once.");
    used.add(sourceId);
    return sourceId;
  };
  const groupIds = new Set();
  const groups = plan.groups.map((group) => {
    shape(group, ["groupId", "sourceIds"], ["explanation"]);
    itemId(group.groupId, "groupId");
    if (groupIds.has(group.groupId)) fail("INVALID_PLAN", "Each group needs a unique groupId.");
    groupIds.add(group.groupId);
    if (!Array.isArray(group.sourceIds) || group.sourceIds.length !== 3) fail("INVALID_PLAN", "Each group has exactly three source IDs.");
    const out = { groupId: group.groupId, sourceIds: group.sourceIds.map(take) };
    if (group.explanation !== undefined) out.explanation = text(group.explanation, "Group explanation");
    return out;
  });
  const leftovers = plan.leftovers.map(take);
  if (used.size !== known.size) fail("INVALID_PLAN", "The plan must place every source ID in a group or the leftovers.");
  if (leftovers.length !== items.length % 3 || groups.length !== Math.floor(items.length / 3)) {
    fail("INVALID_PLAN", "Use only complete groups of three; list exactly the one or two remaining source IDs as leftovers.");
  }
  return { explanation, groups, leftovers };
}

function displayOrder(sessionId, groupId) {
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  return orders[Number.parseInt(hash(`${sessionId}\0${groupId}`).slice(0, 8), 16) % orders.length];
}

function receipt(prior, requestSha256, op) {
  if (prior.requestSha256 !== requestSha256 || (op && prior.op !== op)) {
    fail("ACTION_CONFLICT", "A different request already owns this action ID.");
  }
}

function currentPlan(doc) { return doc.plans.at(-1); }

export function voteDigest(groupId, ranks) { return hash(canonical({ groupId, ranks })); }

/**
 * Durable repository-scoped Trainer datasets. One server process owns a root.
 * Records are replaced atomically and never deleted by this store.
 */
export class TrainerStore {
  #root;

  constructor({ root, platform = process.platform }) {
    const refusal = posixOnlyRefusal(platform);
    if (refusal) fail(POSIX_ONLY_CODE, refusal);
    this.#root = canonicalRoot(root);
  }

  get root() { return this.#root; }

  run(work) {
    const prior = queues.get(this.#root) || Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    queues.set(this.#root, next);
    const release = () => { if (queues.get(this.#root) === next) queues.delete(this.#root); };
    next.then(release, release);
    return next;
  }

  async #ensureRoot(create) {
    const missing = [];
    let current = this.#root;
    for (;;) {
      try { await fs.lstat(current); break; }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) fail("NOT_FOUND", "The Trainer root does not exist yet.");
        missing.unshift(current);
        current = path.dirname(current);
      }
    }
    await inspect(current, true);
    for (const dir of missing) await fs.mkdir(dir, { mode: 0o700 });
    const stat = await inspect(this.#root, true);
    if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n)) {
      fail("UNSAFE_PATH", "The Trainer root must belong to the current user and must not be group or world writable.");
    }
  }

  async #privateDir(dir, create) {
    try { await inspect(dir, true, true); return; }
    catch (error) { if (error.code !== "ENOENT" || !create) throw error; }
    await fs.mkdir(dir, { mode: 0o700 });
    await inspect(dir, true, true);
  }

  #datasetDir(repo) { return path.join(this.#root, repoName(repo), "dataset"); }
  #sessionDir(repo, sessionId) { return path.join(this.#datasetDir(repo), sessionName(sessionId)); }

  async #syncDir(dir) {
    const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #load(repo, sessionId) {
    const dir = this.#sessionDir(repo, sessionId);
    let bytes;
    try {
      await this.#ensureRoot(false);
      for (const part of [path.join(this.#root, repo), this.#datasetDir(repo), dir]) await inspect(part, true, true);
      bytes = await readBytes(path.join(dir, RECORD), true);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "NOT_FOUND") fail("NOT_FOUND", "The Trainer session does not exist.");
      throw error;
    }
    let doc;
    try {
      const { checksum, ...rest } = JSON.parse(bytes.toString("utf8"));
      if (checksum !== hash(JSON.stringify(rest))) throw new Error();
      doc = rest;
    } catch { fail("RECOVERY_REQUIRED", "The Trainer record failed its checksum. Preserve it before recovery."); }
    if (doc.schema !== SCHEMA || doc.version !== VERSION || doc.sessionId !== sessionId || doc.repo?.name !== repo) {
      fail("RECOVERY_REQUIRED", "The Trainer record has an unknown schema or identity. Preserve it before recovery.");
    }
    return { doc, bytes, dir };
  }

  async #commit(dir, doc, previous) {
    const file = path.join(dir, RECORD);
    const temporary = path.join(dir, `.dataset-${randomUUID()}.tmp`);
    let owned = false, replacing = false, handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = true;
      await handle.writeFile(`${JSON.stringify({ ...doc, checksum: hash(JSON.stringify(doc)) })}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await inspect(temporary, false, true);
      await inspect(dir, true, true);
      let current = null;
      try { current = await readBytes(file, true); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previous === null ? current !== null : current === null || !current.equals(previous)) {
        fail("RECOVERY_REQUIRED", "The Trainer record changed outside this writer. Preserve it before recovery.");
      }
      replacing = true;
      await fs.rename(temporary, file);
      owned = false;
      await this.#syncDir(dir);
    } catch (error) {
      if (replacing) fail("COMMIT_UNCERTAIN", "The save may have committed. Retry the exact original request and action ID.", { reason: error.code || "UNKNOWN" });
      if (error.name === "DoubleStoreError") throw error;
      fail("WRITE_FAILED", "The Trainer record was not replaced. Retry the exact original request.", { fsCode: error.code || "UNKNOWN" });
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Only this call's uncommitted temporary file is removed. Records are never pruned.
      if (owned) await fs.unlink(temporary).catch(() => {});
    }
  }

  async #mutate(repo, sessionId, change) {
    return this.run(async () => {
      const { doc, bytes, dir } = await this.#load(repo, sessionId);
      const next = structuredClone(doc);
      const result = change(next);
      if (result.replay) return { result: result.value, view: view(doc), events: [] };
      next.revision += 1;
      next.updatedAt = now();
      await this.#commit(dir, next, bytes);
      return { result: result.value, view: view(next), events: result.events || [] };
    });
  }

  async #sessions(repo) {
    const datasetDir = this.#datasetDir(repo);
    let names;
    try {
      await this.#ensureRoot(false);
      await inspect(path.join(this.#root, repo), true, true);
      await inspect(datasetDir, true, true);
      names = await fs.readdir(datasetDir);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "NOT_FOUND") return [];
      throw error;
    }
    const docs = [];
    for (const name of names.filter((entry) => SESSION.test(entry)).sort()) {
      try { docs.push((await this.#load(repo, name)).doc); }
      // A directory without a record is an interrupted create. It is kept, never deleted, and holds no votes.
      catch (error) { if (error.code !== "NOT_FOUND") throw error; }
    }
    return docs;
  }

  async #guiStarts() {
    let names;
    try { await this.#ensureRoot(false); names = (await fs.readdir(this.#root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch (error) { if (error.code === "ENOENT" || error.code === "NOT_FOUND") return new Set(); throw error; }
    const starts = new Set();
    for (const name of names.filter((entry) => REPO.test(entry)).sort()) {
      for (const doc of await this.#sessions(name)) if (doc.gui) starts.add(doc.gui.sessionId);
    }
    return starts;
  }

  async list(repo) {
    repoName(repo);
    return (await this.run(() => this.#sessions(repo))).map((doc) => ({
      sessionId: doc.sessionId, status: doc.status, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      task: doc.task.slice(0, 200), progress: progress(doc),
    }));
  }

  async create(input) {
    const body = capture(input);
    shape(body, ["actionId", "repo", "task", "items", "plan"], ["gui"]);
    itemId(body.actionId, "actionId");
    shape(body.repo, ["name"], ["remote", "revision"]);
    repoName(body.repo.name);
    // A shared-GUI start reference. The request hash covers it, so one create action links one start only.
    if (body.gui !== undefined) {
      shape(body.gui, ["sessionId", "requestId", "attemptId"]);
      for (const key of ["sessionId", "requestId", "attemptId"]) itemId(body.gui[key], `gui.${key}`);
    }
    const requestSha256 = hash(canonical(body));
    return this.run(async () => {
      for (const doc of await this.#sessions(body.repo.name)) {
        if (doc.createAction.actionId === body.actionId) {
          receipt(doc.createAction, requestSha256);
          return { result: { sessionId: doc.sessionId, replay: true }, view: view(doc), events: [] };
        }
      }
      // One dataset per shared-GUI start, in any repository: a new action ID cannot add a second one.
      if (body.gui && (await this.#guiStarts()).has(body.gui.sessionId)) {
        fail("STALE_ATTEMPT", "A dataset for this shared-GUI start already exists. Replay its identical create request.");
      }
      const repo = { name: body.repo.name };
      if (body.repo.remote !== undefined) repo.remote = text(body.repo.remote, "Repository remote", { max: 2000 });
      if (body.repo.revision !== undefined) repo.revision = text(body.repo.revision, "Repository revision", { max: LIMITS.short });
      const task = text(body.task, "Task or rubric");
      const items = normalizeItems(body.items);
      const plan = normalizePlan(body.plan, items);
      await this.#ensureRoot(true);
      await this.#privateDir(path.join(this.#root, repo.name), true);
      await this.#privateDir(this.#datasetDir(repo.name), true);
      let sessionId, dir;
      for (let attempt = 0; !dir; attempt += 1) {
        sessionId = `${stamp()}-${randomBytes(6).toString("hex")}`;
        try {
          await fs.mkdir(this.#sessionDir(repo.name, sessionId), { mode: 0o700 });
          dir = this.#sessionDir(repo.name, sessionId);
        } catch (error) {
          if (error.code !== "EEXIST" || attempt >= 8) fail("WRITE_FAILED", "Could not reserve a unique Trainer session directory.", { fsCode: error.code });
        }
      }
      await inspect(dir, true, true);
      await this.#syncDir(this.#datasetDir(repo.name));
      const createdAt = now();
      const doc = {
        schema: SCHEMA, version: VERSION, sessionId, repo, createdAt, updatedAt: createdAt, revision: 1,
        task, status: "plan-review",
        createAction: { actionId: body.actionId, requestSha256, at: createdAt },
        ...(body.gui ? { gui: { sessionId: body.gui.sessionId, requestId: body.gui.requestId, attemptId: body.gui.attemptId } } : {}),
        datasetSha256: hash(canonical(items.map(({ sourceId, format, contentSha256 }) => ({ sourceId, format, contentSha256 })))),
        items,
        plans: [{ revision: 1, ...plan, actionId: body.actionId, requestSha256, submittedAt: createdAt, review: null }],
        groups: [], leftovers: [], analyses: [],
      };
      await this.#commit(dir, doc, null);
      return { result: { sessionId, replay: false }, view: view(doc), events: [{ type: "plan-review-requested", repo: repo.name, sessionId, revision: 1 }] };
    });
  }

  async read(repo, sessionId) {
    repoName(repo);
    sessionName(sessionId);
    return view((await this.run(() => this.#load(repo, sessionId))).doc);
  }

  /** Agent: a revised plan after the owner requested changes. */
  revisePlan(repo, sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "plan"]);
    itemId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(repo, sessionId, (doc) => {
      const prior = doc.plans.find((plan) => plan.actionId === body.actionId);
      if (prior) { receipt(prior, requestSha256); return { replay: true, value: { revision: prior.revision, replay: true } }; }
      if (doc.status === "ended") fail("INVALID_TRANSITION", ENDED);
      if (doc.status !== "changes-requested") fail("INVALID_TRANSITION", "A revised plan is accepted only after the owner requests changes.");
      const plan = normalizePlan(body.plan, doc.items);
      const revision = currentPlan(doc).revision + 1;
      doc.plans.push({ revision, ...plan, actionId: body.actionId, requestSha256, submittedAt: now(), review: null });
      doc.status = "plan-review";
      return { value: { revision, replay: false }, events: [{ type: "plan-review-requested", repo, sessionId, revision }] };
    });
  }

  /** Owner: approve the current plan or request changes with a note. */
  reviewPlan(repo, sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId", "revision", "decision"], ["note"]);
    itemId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(repo, sessionId, (doc) => {
      const prior = doc.plans.find((plan) => plan.review?.actionId === body.actionId);
      if (prior) { receipt(prior.review, requestSha256); return { replay: true, value: { decision: prior.review.decision, replay: true } }; }
      if (!["approve", "request-changes"].includes(body.decision)) fail("INVALID_REQUEST", "Decision must be approve or request-changes.");
      const note = text(body.note, "Review note", { optional: body.decision === "approve" });
      const plan = currentPlan(doc);
      if (doc.status === "ended") fail("INVALID_TRANSITION", ENDED);
      if (doc.status !== "plan-review") fail("INVALID_TRANSITION", "The grouping plan is not awaiting review.");
      if (body.revision !== plan.revision) fail("STALE_REVISION", "Review the current plan revision.");
      const at = now();
      plan.review = { decision: body.decision, ...(note === undefined ? {} : { note }), actionId: body.actionId, requestSha256, at };
      if (body.decision === "request-changes") {
        doc.status = "changes-requested";
        return { value: { decision: body.decision, replay: false }, events: [{ type: "plan-changes-requested", repo, sessionId, revision: plan.revision }] };
      }
      const items = new Map(doc.items.map((item) => [item.sourceId, item]));
      doc.groups = plan.groups.map((group) => {
        const candidates = group.sourceIds.map((sourceId, index) => ({
          candidateId: `${group.groupId}/c${index + 1}`, sourceId, contentSha256: items.get(sourceId).contentSha256,
        }));
        return {
          groupId: group.groupId, ...(group.explanation === undefined ? {} : { explanation: group.explanation }), planRevision: plan.revision,
          candidates, displayOrder: displayOrder(sessionId, group.groupId).map((index) => candidates[index].candidateId),
          vote: null, analysis: { status: "not-requested", attempts: 0 },
        };
      });
      doc.leftovers = plan.leftovers.map((sourceId) => ({ sourceId, state: "unranked", contentSha256: items.get(sourceId).contentSha256 }));
      doc.status = doc.groups.length ? "ranking" : "complete";
      return { value: { decision: body.decision, replay: false }, events: [{ type: "plan-approved", repo, sessionId, revision: plan.revision }] };
    });
  }

  /** Owner: Save and Next. The first saved vote for a group is final. */
  saveVote(repo, sessionId, input) {
    const body = capture(input);
    // Check the shape before the replay lookup: a missing actionId must not match an unvoted group.
    shape(body, ["actionId", "groupId", "ranks"], ["comment"]);
    itemId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(repo, sessionId, (doc) => {
      const prior = doc.groups.find((group) => group.vote?.actionId === body.actionId);
      if (prior) {
        receipt(prior.vote, requestSha256);
        return { replay: true, value: { outcome: "saved", replay: true, groupId: prior.groupId, vote: prior.vote } };
      }
      const group = doc.groups.find((item) => item.groupId === body.groupId);
      if (!group) fail("NOT_FOUND", "Unknown group in this session.");
      // A duplicate or uncertain Save and Next from another action resolves to the first saved result.
      if (group.vote) return { replay: true, value: { outcome: "already-saved", replay: true, groupId: group.groupId, vote: group.vote } };
      if (doc.status === "ended") fail("INVALID_TRANSITION", ENDED);
      if (doc.status !== "ranking") fail("INVALID_TRANSITION", "Ranking starts after the owner approves the grouping plan.");
      const candidateIds = group.candidates.map((candidate) => candidate.candidateId);
      if (!completeRanking(body.ranks, candidateIds)) fail("INCOMPLETE_RANKING", "Rank all three candidates 1, 2, and 3 before Save and Next.");
      const comment = text(body.comment, "Comment", { optional: true, empty: true });
      const ranks = Object.fromEntries(candidateIds.map((candidateId) => [candidateId, body.ranks[candidateId]]));
      const at = now();
      group.vote = {
        actionId: body.actionId, requestSha256, ranks,
        ranking: [...candidateIds].sort((a, b) => ranks[a] - ranks[b]),
        ...(comment ? { comment } : {}), submittedAt: at, voteSha256: voteDigest(group.groupId, ranks),
      };
      group.analysis = { status: "pending", attempts: 0, requestedAt: at };
      if (doc.groups.every((item) => item.vote)) doc.status = "complete";
      return { value: { outcome: "saved", replay: false, groupId: group.groupId, vote: group.vote },
        events: [{ type: "analysis-requested", repo, sessionId, groupId: group.groupId }] };
    });
  }

  /**
   * Owner: end the session. Every saved vote and analysis stays; later plans, reviews and votes are refused.
   * Analysis of saved votes stays possible. Ending an ended session returns the first end.
   */
  end(repo, sessionId, input) {
    const body = capture(input);
    shape(body, ["actionId"]);
    itemId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(repo, sessionId, (doc) => {
      if (doc.ended?.actionId === body.actionId) { receipt(doc.ended, requestSha256); return { replay: true, value: { outcome: "ended", replay: true, ended: doc.ended } }; }
      if (doc.ended) return { replay: true, value: { outcome: "already-ended", replay: true, ended: doc.ended } };
      doc.ended = { actionId: body.actionId, requestSha256, at: now(), fromStatus: doc.status };
      doc.status = "ended";
      return { value: { outcome: "ended", replay: false, ended: doc.ended } };
    });
  }

  /** Agent: groups with saved votes and no complete analysis. */
  async pendingAnalysis(repo, sessionId) {
    const doc = (await this.run(() => this.#load(repo, sessionId))).doc;
    const items = new Map(doc.items.map((item) => [item.sourceId, item]));
    return {
      sessionId, repo: doc.repo, task: doc.task,
      requests: doc.groups.filter((group) => group.vote && group.analysis.status !== "complete").map((group) => {
        const last = doc.analyses.filter((analysis) => analysis.groupId === group.groupId).at(-1);
        return {
          groupId: group.groupId, voteSha256: group.vote.voteSha256, attempts: group.analysis.attempts,
          ...(last?.status === "failed" ? { lastError: last.error } : {}),
          ranking: group.vote.ranking.map((candidateId) => {
            const candidate = group.candidates.find((item) => item.candidateId === candidateId);
            const item = items.get(candidate.sourceId);
            return { rank: group.vote.ranks[candidateId], candidateId, sourceId: item.sourceId, format: item.format,
              ...(item.title === undefined ? {} : { title: item.title }), content: item.content, contentSha256: item.contentSha256 };
          }),
          ...(group.vote.comment ? { comment: group.vote.comment } : {}),
        };
      }),
    };
  }

  submitAnalysis(repo, sessionId, input) { return this.#analysis(repo, sessionId, input, "complete"); }
  failAnalysis(repo, sessionId, input) { return this.#analysis(repo, sessionId, input, "failed"); }

  #analysis(repo, sessionId, input, status) {
    const body = capture(input);
    if (body && typeof body === "object" && typeof body.actionId === "string") itemId(body.actionId, "actionId");
    const requestSha256 = hash(canonical(body));
    return this.#mutate(repo, sessionId, (doc) => {
      const prior = doc.analyses.find((analysis) => analysis.actionId === body?.actionId);
      if (prior) { receipt(prior, requestSha256, status); return { replay: true, value: { analysis: prior, replay: true } }; }
      if (status === "complete") shape(body, ["actionId", "groupId", "voteSha256", "model", "preferred", "lowest"]);
      else shape(body, ["actionId", "groupId", "voteSha256", "error"], ["model"]);
      itemId(body.actionId, "actionId");
      let model;
      if (body.model !== undefined) {
        shape(body.model, ["id"], ["provider", "version"]);
        model = { id: text(body.model.id, "Model id", { max: LIMITS.short }) };
        if (body.model.provider !== undefined) model.provider = text(body.model.provider, "Model provider", { max: LIMITS.short });
        if (body.model.version !== undefined) model.version = text(body.model.version, "Model version", { max: LIMITS.short });
      }
      const group = doc.groups.find((item) => item.groupId === body.groupId);
      if (!group) fail("NOT_FOUND", "Unknown group in this session.");
      if (!group.vote) fail("INVALID_TRANSITION", "Analysis follows a saved human vote.");
      if (body.voteSha256 !== group.vote.voteSha256) fail("STALE_VOTE", "The analysis names a different vote.");
      if (group.analysis.status === "complete") fail("ANALYSIS_EXISTS", "This group already has a complete analysis.");
      const at = now();
      const record = {
        analysisId: `${group.groupId}/a${group.analysis.attempts + 1}`, groupId: group.groupId, voteSha256: group.vote.voteSha256,
        op: status, status, kind: "inferred-interpretation", ...(model ? { model } : {}),
        actionId: body.actionId, requestSha256, submittedAt: at,
      };
      if (status === "complete") {
        record.preferred = { candidateIds: group.vote.ranking.slice(0, 2), observations: text(body.preferred, "Preferred observations") };
        record.lowest = { candidateId: group.vote.ranking[2], observations: text(body.lowest, "Lowest observations") };
      } else record.error = text(body.error, "Analysis error", { max: 2000 });
      doc.analyses.push(record);
      group.analysis = { status, attempts: group.analysis.attempts + 1, requestedAt: group.analysis.requestedAt, lastAnalysisId: record.analysisId, updatedAt: at };
      return { value: { analysis: record, replay: false }, events: [] };
    });
  }
}

function progress(doc) {
  return {
    groups: doc.groups.length || currentPlan(doc).groups.length,
    saved: doc.groups.filter((group) => group.vote).length,
    leftovers: (doc.leftovers.length ? doc.leftovers : currentPlan(doc).leftovers).length,
    analysisComplete: doc.groups.filter((group) => group.analysis.status === "complete").length,
  };
}

function view(doc) {
  return { ...structuredClone(doc), progress: progress(doc) };
}
