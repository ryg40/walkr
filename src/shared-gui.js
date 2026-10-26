import { isDeepStrictEqual as equal } from "node:util";
import { DoubleArchive, hash, fail, id, capture, requireShape } from "./double-archive.js";

const KEY = "shared-gui";
// Double keeps its original session identity so schema-1 records decode unchanged.
export const doubleGuiSessionId = (actionId) => `gui-${hash(actionId)}`;
const terminal = (view) => ["ended", "stopped"].includes(view.status);

// A shared-GUI mode supplies { sessionId(actionId), createInitial(input), read(sessionId), terminal?(view) }.
// Start records name their mode; an unregistered mode makes the record require recovery, never a guess.
const decoder = (modes) => function decode(bytes) {
  try {
    const { checksum, ...doc } = JSON.parse(bytes);
    if (checksum !== hash(JSON.stringify(doc)) || doc.schemaVersion !== 1 || doc.guiId !== KEY ||
        !Array.isArray(doc.starts) || !Array.isArray(doc.drafts) || !doc.origin || Object.keys(doc.origin).sort().join() !== "piSessionFile,piSessionId") throw new Error();
    for (const draft of doc.drafts) { requireShape(draft, ["actionId", "text"]); id(draft.actionId); if (typeof draft.text !== "string") throw new Error(); }
    for (const start of doc.starts) {
      requireShape(start, ["request", "sessionId", "leaseId"]);
      requireShape(start.request, ["actionId", "brief", "mode"]);
      id(start.request.actionId);
      const mode = Object.hasOwn(modes, start.request.mode) ? modes[start.request.mode] : null;
      if (!mode || typeof start.request.brief !== "string" || !start.request.brief.trim() ||
          start.sessionId !== mode.sessionId(start.request.actionId)) throw new Error();
    }
    if (new Set(doc.starts.map((s) => s.sessionId)).size !== doc.starts.length) throw new Error();
    return doc;
  } catch { fail("RECOVERY_REQUIRED", "Preserve the invalid shared GUI record before recovery."); }
};

// The reservation commits before session creation. Reads complete only that idempotent
// storage step, never dispatch or generation. A lost start response reuses its receipt.
export class SharedGuiStore {
  constructor({ archiveDir, sessions, modes }) {
    this.modes = modes ?? { double: { sessionId: doubleGuiSessionId, createInitial: (input) => sessions.createInitial(input),
      read: (sessionId) => sessions.read(sessionId) } };
    this.archive = new DoubleArchive({ archiveDir, prefix: "shared-gui", identity: "guiId", decode: decoder(this.modes), separate() {} });
  }
  active(item) { return !(this.modes[item.mode].terminal ?? terminal)(item); }
  async bind(origin) {
    origin = capture(origin);
    requireShape(origin, ["piSessionId", "piSessionFile"]);
    id(origin.piSessionId);
    if (typeof origin.piSessionFile !== "string" || !origin.piSessionFile.startsWith("/")) fail("INVALID_REQUEST", "A persistent Pi file is required.");
    await this.archive.run(async () => {
      let saved;
      try { saved = await this.archive.load(KEY); } catch (e) { if (e.code !== "NOT_FOUND") throw e; }
      if (saved) {
        if (!equal(saved.doc.origin, origin)) fail("FORBIDDEN", "Reconnect the same Pi conversation and session file.");
      } else await this.archive.commit({ schemaVersion: 1, guiId: KEY, origin, starts: [], drafts: [] });
    });
    return this.read();
  }
  async read() {
    const { doc } = await this.archive.run(() => this.archive.load(KEY));
    const history = [];
    for (const start of doc.starts) {
      const view = await this.modes[start.request.mode].createInitial({ sessionId: start.sessionId, brief: start.request.brief,
        origin: doc.origin, initialActionId: start.request.actionId });
      const item = { sessionId: start.sessionId, mode: start.request.mode, brief: view.brief, status: view.status, leaseId: start.leaseId,
        settled: Boolean(this.modes[start.request.mode].settled?.(view)) };
      history.push({ ...item, active: this.active({ ...view, mode: item.mode }) });
    }
    return { origin: doc.origin, history, draft: doc.drafts.at(-1)?.text ?? "",
      currentSessionId: history.at(-1)?.sessionId ?? null, currentMode: history.at(-1)?.mode ?? null };
  }
  async draft(request) {
    request = capture(request);
    requireShape(request, ["actionId", "text"]); id(request.actionId);
    if (typeof request.text !== "string") fail("INVALID_REQUEST", "Draft text must be a string.");
    await this.archive.run(async () => {
      const saved = await this.archive.load(KEY);
      const prior = saved.doc.drafts.find((d) => d.actionId === request.actionId);
      if (prior) {
        if (!equal(prior, request)) fail("ACTION_CONFLICT", "This draft action already contains another text.");
        return;
      }
      saved.doc.drafts.push(request);
      await this.archive.commit(saved.doc, saved.bytes);
    });
    return { actionId: request.actionId, kind: "draft" };
  }
  async start(request, leaseId, connected) {
    request = capture(request);
    const saved = await this.archive.run(() => this.archive.load(KEY));
    const prior = saved.doc.starts.find((s) => s.request.actionId === request.actionId);
    if (prior) {
      if (!equal(prior.request, request)) fail("ACTION_CONFLICT", "This action ID already names another complete start request.");
      await this.read();
      return { actionId: request.actionId, kind: "start", sessionId: prior.sessionId };
    }
    requireShape(request, ["actionId", "brief", "mode"]); id(request.actionId);
    if (typeof request.mode !== "string" || !Object.hasOwn(this.modes, request.mode) || typeof request.brief !== "string" || !request.brief.trim()) {
      fail("INVALID_REQUEST", "Select an available mode and enter a nonblank brief.");
    }
    if (!connected) fail("DISCONNECTED", "Explicitly reconnect the bound Pi chat before generation.");
    const state = await this.read();
    if (state.history.some((s) => s.active)) fail("ACTIVE_SESSION", "Finish or stop the active session first.");
    const sessionId = this.modes[request.mode].sessionId(request.actionId);
    saved.doc.starts.push({ request, sessionId, leaseId });
    await this.archive.run(() => this.archive.commit(saved.doc, saved.bytes));
    await this.read();
    return { actionId: request.actionId, kind: "start", sessionId };
  }
}
