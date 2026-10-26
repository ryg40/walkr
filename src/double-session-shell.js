/**
 * Double session shell: the iterative comparison page.
 *
 * Three layers beside the one-shot shell in double.js:
 *   - createSessionTransport: the only code that calls the session API. It
 *     knows view, actions, next, steer, end, and retry, and nothing else.
 *   - createSessionController: the saved session state, exact requests, and
 *     the background refresh while a new pair is generated.
 *   - mountSessionShell: Next, Retry, and End controls. The displayed pair
 *     reuses mountDoubleShell from double.js through a comparison facade, so
 *     keepers, deletions, Undo, drafts, and the frame bridge are unchanged.
 *
 * A new currentComparisonId replaces both frames and the pair's bridge
 * together. Frames never receive the token or the session identity.
 */
import {
  PANES,
  PANE_NAMES,
  DoubleRequestError,
  canUndoRow,
  createDoubleRequest,
  findComponent,
  isRecord,
  mountDoubleShell,
  outcomeUnknown,
  validId,
  validateView,
} from "./double.js";
import { encodeDoubleComparisonId } from "./double-route.js";
import { controllingGroup } from "./double-selection.js";

const STATUSES = new Set(["editing", "generating", "failed", "ended"]);
const ATTEMPTS = new Set(["running", "failed", "attached", "cancelled"]);
/** Session codes that prove the exact request was not saved; the server matches a repeated action ID first. */
const SESSION_NOT_SAVED = new Set(["STALE_COMPARISON", "STALE_ATTEMPT", "UNSUPPORTED_FINAL", "UNKNOWN_EVENT"]);
const RECEIPT_EXTRA = { act: [], next: ["requestId", "attemptId", "eventId"], steer: ["requestId", "attemptId", "eventId"], retry: ["requestId", "attemptId", "eventId"], end: ["eventId"] };
export const OP_LABEL = Object.freeze({ act: "Save", next: "Next Round", steer: "Send instruction", end: "Done", retry: "Retry generation" });

function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function defaultNewId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- view

/** Check the public session view shape. A malformed view is never shown as saved. */
export function validateSessionView(view, sessionId) {
  if (!isRecord(view)) return "The session view is not an object.";
  if (view.sessionId !== sessionId) return "The view belongs to another session.";
  if (!Number.isSafeInteger(view.revision) || view.revision < 0) return "The session revision is invalid.";
  if (!STATUSES.has(view.status)) return "The session status is invalid.";
  if (!validId(view.currentComparisonId)) return "The current comparison ID is invalid.";
  const problem = validateView(view.comparison, view.currentComparisonId);
  if (problem) return problem;
  if (!Array.isArray(view.rounds) || view.rounds.at(-1)?.comparisonId !== view.currentComparisonId) return "The session rounds are invalid.";
  const g = view.generation;
  if (g !== null && (!isRecord(g) || !validId(g.requestId) || !isRecord(g.attempt) || !validId(g.attempt.id) ||
      !ATTEMPTS.has(g.attempt.status) || (g.attempt.failure !== null && typeof g.attempt.failure !== "string"))) {
    return "The generation state is invalid.";
  }
  if (view.status === "failed" && g?.attempt.status !== "failed") return "A failed session has no failed attempt.";
  if ((view.status === "ended") !== (view.final !== null)) return "The final selection does not match the status.";
  if (view.final !== null && (!isRecord(view.final) || !validId(view.final.comparisonId) || !PANES.includes(view.final.pane))) {
    return "The final selection is invalid.";
  }
  return null;
}

/**
 * Check that a success answer carries the complete session receipt of this
 * exact request. The view may be newer: a replayed request returns its
 * original receipt with the latest saved view.
 */
function receiptProblem(result, view, op, wire) {
  const extra = RECEIPT_EXTRA[op];
  if (!isRecord(result) || !hasExactKeys(result, ["actionId", "kind", "revision", ...extra])) return "The receipt is incomplete.";
  if (result.actionId !== wire.actionId) return "The receipt belongs to another request.";
  if (result.kind !== op) return "The receipt kind does not match the request.";
  if (result.revision !== wire.expectedRevision + 1) return "The receipt revision does not match the request.";
  if (view.revision < result.revision) return "The view is older than the receipt.";
  if (!extra.every((key) => validId(result[key]))) return "The receipt identities are invalid.";
  // End is terminal, so the latest view always shows the selection it saved.
  if (op === "end" && (view.final?.comparisonId !== wire.comparisonId || view.final?.pane !== wire.pane)) return "The view does not show this End selection.";
  return null;
}

// ---------------------------------------------------------------- transport

/**
 * Session HTTP transport. Browser authority covers exactly these six
 * routes; creation, reopen, events, acknowledgment, failure reporting,
 * attachment, and final output stay with the agent.
 */
export function createSessionTransport({ sessionId, token, fetch: fetchImpl = globalThis.fetch, base = "" }) {
  const root = `${base}/api/double/sessions/${encodeDoubleComparisonId(sessionId)}`;
  const request = createDoubleRequest({ token, fetch: fetchImpl });
  return {
    load: ({ signal } = {}) => request(root, "GET", undefined, signal),
    act: (wire) => request(`${root}/actions`, "POST", wire),
    next: (wire) => request(`${root}/next`, "POST", wire),
    // Shared GUI only: the server refuses steering for a standalone session page.
    steer: (wire) => request(`${root}/steer`, "POST", wire),
    end: (wire) => request(`${root}/end`, "POST", wire),
    retry: (wire) => request(`${root}/retry`, "POST", wire),
  };
}

// ---------------------------------------------------------------- controller

const draftKey = (comparisonId, pane, componentId) => `${comparisonId}\u0000${pane}\u0000${componentId}`;

/**
 * Saved session state. Status is one of:
 *   loading | load-failed | ready | saving | submitting
 * `failure` holds the last failed request for Retry: `wire` is the exact
 * request, `request` is the flat component action for the pair shell.
 * An uncertain failure blocks every fresh request until Retry of the same
 * request returns its receipt or an answer that proves it was not saved.
 * A refreshed view alone never settles it.
 *
 * While the session generates, a cancellable timer reads the view; failures
 * back off up to `maxRefreshMs`. Nothing else polls.
 *
 * close() is terminal for new work: every later call refuses, and a request
 * already sent completes on the server but publishes nothing.
 */
export function createSessionController({
  sessionId, transport, newId = defaultNewId, refreshMs = 4000, maxRefreshMs = 30000, timers = globalThis,
  canGenerate = () => true, canMutate = () => true, storage = null,
}) {
  const listeners = new Set();
  const storageKey = `double-session-pending:${sessionId}`;
  const draftStorageKey = `double-session-drafts:${sessionId}`;
  const drafts = new Map(JSON.parse(storage?.getItem(draftStorageKey) ?? "[]"));
  const restored = JSON.parse(storage?.getItem(storageKey) ?? "null");
  const state = { status: "loading", view: null, pending: null, failure: restored ? { ...restored,
    uncertain: true, code: "INTERRUPTED", message: "Resolve the saved request after reload." } : null, loadError: null };
  let loadTicket = 0;
  let abort = null;
  let timer = null;
  let delay = refreshMs;
  let closed = false;

  const unresolved = () => Boolean(state.failure?.uncertain);
  const editing = () => state.status === "ready" && state.view?.status === "editing" && state.view.comparison.status === "editing" && !unresolved() && canMutate();

  function unsavedDrafts() {
    const view = state.view;
    if (!view) return [];
    const found = [];
    for (const pane of PANES) {
      for (const c of view.comparison.panes[pane].components) {
        const text = drafts.get(draftKey(view.currentComparisonId, pane, c.id));
        if (typeof text === "string" && text.trim() !== "") found.push({ pane, componentId: c.id, label: c.label });
      }
    }
    const overall = drafts.get(draftKey(view.currentComparisonId, "", ""));
    if (typeof overall === "string" && overall.trim()) found.push({ pane: null, componentId: null, label: "Overall comment" });
    return found;
  }

  function canEnd() {
    const view = state.view;
    if (state.status !== "ready" || !view || view.status === "ended" || unresolved() || !canMutate()) return false;
    return view.status !== "editing" || unsavedDrafts().length === 0;
  }

  const canRetryGeneration = () => state.status === "ready" && state.view?.status === "failed" &&
    state.view.generation?.attempt.status === "failed" && !unresolved() && canGenerate() && canMutate();

  const snapshot = () => ({
    status: state.status,
    view: state.view,
    pending: state.pending,
    failure: state.failure,
    loadError: state.loadError,
    busy: state.status === "saving" || state.status === "submitting",
    unresolved: unresolved(),
    canAct: editing(),
    canNext: editing() && unsavedDrafts().length === 0 && canGenerate(),
    canEnd: canEnd(),
    canRetryGeneration: canRetryGeneration(),
    unsavedDrafts: unsavedDrafts(),
  });

  function schedule() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (closed || state.pending || state.view?.status !== "generating") return;
    timer = timers.setTimeout(() => {
      timer = null;
      load({ background: true });
    }, delay);
  }

  function emit() {
    const snap = snapshot();
    for (const listener of listeners) listener(snap);
    schedule();
  }

  /** An older revision never replaces a newer one, and an ended session never reopens on screen. */
  function staleProblem(view) {
    if (!state.view) return null;
    if (view.revision < state.view.revision) return `The server answered with saved revision ${view.revision}, older than revision ${state.view.revision} on screen.`;
    if (state.view.status === "ended" && view.status !== "ended") return "The server answered with an open session, but this session has already ended on screen.";
    return null;
  }

  function applyView(view) {
    if (validateSessionView(view, sessionId) !== null || staleProblem(view) !== null) return false;
    state.view = deepFreeze(structuredClone(view));
    return true;
  }

  /**
   * A submitted pair has nothing left to save, except an unresolved request
   * and unsaved feedback text, which stay reported.
   */
  function settle() {
    const f = state.failure;
    if (!f || f.uncertain || !state.view) return;
    if (f.op === "act" && state.view.status !== "editing" && !["feedback-delete", "comment", "round-comment"].includes(f.request.kind)) state.failure = null;
    else if (f.op !== "act" && state.view.status === "ended") state.failure = null;
  }

  /**
   * GET the session. Only the latest load or request decides; a late answer
   * is ignored. A background read keeps the screen as it is until it answers,
   * and a failed read keeps the last saved pair on screen.
   */
  async function load({ background = false } = {}) {
    if (closed || state.pending) return false;
    const ticket = ++loadTicket;
    abort?.abort();
    const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
    abort = controller;
    if (!background) {
      state.status = "loading";
      state.loadError = null;
      emit();
    }
    try {
      const payload = await transport.load({ signal: controller?.signal });
      if (ticket !== loadTicket) return false;
      const problem = validateSessionView(payload?.view, sessionId);
      if (problem) throw new DoubleRequestError({ code: "BAD_VIEW", message: problem });
      const stale = staleProblem(payload.view);
      if (stale) throw new DoubleRequestError({ code: "STALE_VIEW", message: `${stale} The answer was not applied.` });
      applyView(payload.view);
      state.loadError = null;
      delay = refreshMs;
    } catch (error) {
      if (ticket !== loadTicket) return false;
      state.loadError = { code: error.code || "LOAD_FAILED", message: error.message || "The session could not be loaded." };
      if (background) delay = Math.min(delay * 2, maxRefreshMs);
    }
    if (abort === controller) abort = null;
    state.status = state.view ? "ready" : "load-failed";
    settle();
    emit();
    return !state.loadError;
  }

  async function run(op, wire, flat = null) {
    const wasUncertain = Boolean(state.failure?.uncertain && state.failure.wire === wire);
    // A request supersedes any read in flight; its late answer is ignored.
    loadTicket += 1;
    abort?.abort();
    abort = null;
    state.status = op === "act" ? "saving" : "submitting";
    state.pending = { op, wire, request: flat ?? wire };
    storage?.setItem(storageKey, JSON.stringify(state.pending));
    emit();
    let outcome;
    let failure = null;
    try {
      const payload = await transport[op](wire);
      const problem = validateSessionView(payload?.view, sessionId);
      if (problem) throw new DoubleRequestError({ code: "BAD_VIEW", message: `The saved result could not be shown: ${problem}`, uncertain: true });
      const receipt = receiptProblem(payload.result, payload.view, op, wire);
      if (receipt) throw new DoubleRequestError({ code: "BAD_RESULT", message: `The server answer is not the receipt of this request. ${receipt}`, uncertain: true });
      applyView(payload.view);
      state.failure = null;
      state.loadError = null;
      if (["feedback-delete", "comment", "round-comment"].includes(flat?.kind)) {
        const key = draftKey(wire.comparisonId, flat.pane ?? "", flat.componentId ?? "");
        // A draft edited after the failed attempt stays for the owner.
        if (drafts.get(key) === flat.feedback) drafts.delete(key);
        storage?.setItem(draftStorageKey, JSON.stringify([...drafts]));
      }
      outcome = { ok: true, result: payload.result };
    } catch (error) {
      const uncertain = SESSION_NOT_SAVED.has(error?.code) ? false : outcomeUnknown(error, wasUncertain);
      failure = {
        op, wire, request: flat ?? wire,
        code: error?.code || "FAILED",
        message: error?.message || "The request failed.",
        uncertain,
        refreshed: false,
        notSaved: wasUncertain && !uncertain,
      };
      state.failure = failure;
      outcome = { ok: false, error: failure };
    }
    if (!failure?.uncertain) storage?.removeItem(storageKey);
    state.pending = null;
    state.status = "ready";
    settle();
    emit();
    // A proven rejection usually means the session moved on: read it, so a new pair is shown and chosen from.
    if (failure && !failure.uncertain) {
      const before = state.view?.revision;
      if (await load({ background: true }) && state.failure === failure && state.view?.revision !== before) {
        failure.refreshed = true;
        emit();
      }
    }
    return outcome;
  }

  const refuse = (reason) => Promise.resolve({ ok: false, refused: reason });
  const reason = () => (closed ? "closed" : state.view && state.view.status !== "editing" ? "read-only" : "busy");

  function act(fields) {
    if (closed || !editing()) return refuse(reason());
    const view = state.view;
    const wire = deepFreeze({ actionId: newId(), expectedRevision: view.revision, comparisonId: view.currentComparisonId, action: { ...fields } });
    return run("act", wire, deepFreeze({ ...fields }));
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    getState: snapshot,
    refreshControls: emit,
    load,
    act,
    next() {
      if (closed || !editing() || !canGenerate()) return refuse(reason());
      if (unsavedDrafts().length) return refuse("unsaved-feedback");
      const view = state.view;
      return run("next", deepFreeze({ actionId: newId(), expectedRevision: view.revision, comparisonId: view.currentComparisonId }));
    },
    /**
     * Next with a prompt-box instruction: the same saved keepers, deletions and feedback, and the same gates.
     * The instruction is saved with the round; an uncertain answer keeps the exact request for Retry.
     */
    steer(instruction) {
      if (closed || !editing() || !canGenerate()) return refuse(reason());
      if (unsavedDrafts().length) return refuse("unsaved-feedback");
      if (typeof instruction !== "string" || !instruction.trim()) return refuse("no-instruction");
      const view = state.view;
      return run("steer", deepFreeze({ actionId: newId(), expectedRevision: view.revision, comparisonId: view.currentComparisonId, instruction }));
    },
    /**
     * End with an explicit pane of the displayed pair at the session revision
     * the owner chose from. The request carries that revision, never the latest
     * one, so the server refuses a choice made on content that changed since.
     */
    end(pane, comparisonId, revision) {
      if (closed) return refuse("closed");
      if (!PANES.includes(pane)) return refuse("no-choice");
      if (!canEnd()) return refuse(unsavedDrafts().length ? "unsaved-feedback" : "busy");
      const view = state.view;
      if (comparisonId !== view.currentComparisonId) return refuse("stale-choice");
      return run("end", deepFreeze({ actionId: newId(), expectedRevision: revision, comparisonId, pane }));
    },
    retryGeneration() {
      if (closed) return refuse("closed");
      if (!canRetryGeneration()) return refuse("busy");
      const { revision, generation } = state.view;
      return run("retry", deepFreeze({ actionId: newId(), expectedRevision: revision, requestId: generation.requestId, attemptId: generation.attempt.id }));
    },
    /**
     * Resend the exact failed request with its original action ID. A
     * component action that is proven unsaved cannot retry on a submitted pair.
     */
    retry() {
      const f = state.failure;
      if (closed) return refuse("closed");
      if (state.status !== "ready" || !f) return refuse("nothing");
      if (!f.uncertain && (f.op !== "act" || state.view?.status !== "editing")) return refuse("read-only");
      return run(f.op, f.wire, f.op === "act" ? f.request : null);
    },
    dismissFailure() {
      if (closed || unresolved()) return false;
      state.failure = null;
      emit();
      return true;
    },
    getDraft: (comparisonId, pane, componentId) => drafts.get(draftKey(comparisonId, pane, componentId)) ?? "",
    /** A draft decides whether Next and End are allowed, so a change publishes state. */
    setDraft(comparisonId, pane, componentId, text) {
      const key = draftKey(comparisonId, pane, componentId);
      if ((drafts.get(key) ?? "") === (text || "")) return;
      if (text) drafts.set(key, text);
      else drafts.delete(key);
      storage?.setItem(draftStorageKey, JSON.stringify([...drafts]));
      emit();
    },
    /**
     * Stop the refresh timer, cancel a read in flight, and refuse all later
     * work. A request already sent cannot be withdrawn; its answer is dropped.
     */
    close() {
      closed = true;
      listeners.clear();
      loadTicket += 1;
      abort?.abort();
      abort = null;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

// ---------------------------------------------------------------- comparison facade

/**
 * The controller interface of double.js for one displayed pair. It reads the
 * session state and refuses every action once its comparison is replaced, so
 * a retired pair can never write to a new round. The host calls publish(),
 * and retire() when the pair leaves the screen: a retired facade forwards
 * nothing, including Reload, Retry, and Dismiss.
 */
export function comparisonFacade(controller, comparisonId) {
  const listeners = new Set();
  let retired = false;
  const current = () => !retired && controller.getState().view?.currentComparisonId === comparisonId;

  function map(s) {
    const view = s.view?.currentComparisonId === comparisonId ? s.view.comparison : null;
    return {
      status: s.status === "submitting" ? "sending" : s.status,
      view,
      session: s.view,
      pending: s.pending && { op: s.pending.op, request: s.pending.request },
      // Next, End, and Retry failures belong to the session controls.
      failure: s.failure?.op === "act" ? s.failure : null,
      loadError: s.loadError,
      busy: s.busy,
      readOnly: Boolean(view) && (s.view.status !== "editing" || view.status === "sent"),
      unresolved: s.unresolved,
      canMutate: Boolean(view) && s.canAct,
    };
  }

  const refuse = (reason) => Promise.resolve({ ok: false, refused: reason });
  function editable(pane, componentId) {
    if (!current()) return null;
    const c = findComponent(controller.getState().view.comparison, pane, componentId);
    return c && !c.deleted ? c : null;
  }
  // A selected ancestor group decides for the component, so its own choice cannot change.
  function overridden(pane, componentId) {
    const components = controller.getState().view.comparison.panes[pane]?.components;
    return Boolean(components && controllingGroup(components, componentId));
  }

  return {
    comparisonId,
    subscribe(listener) {
      listeners.add(listener);
      listener(map(controller.getState()));
      return () => listeners.delete(listener);
    },
    publish(s) {
      if (retired) return;
      const snap = map(s);
      for (const listener of listeners) listener(snap);
    },
    retire() {
      retired = true;
      listeners.clear();
    },
    getState: () => map(controller.getState()),
    load: () => (retired ? refuse("retired") : controller.load()),
    cycleSelection(pane, componentId) {
      if (!current()) return refuse("unknown");
      const components = controller.getState().view.comparison.panes[pane]?.components;
      const c = components?.find((item) => item.id === componentId);
      if (!c || controllingGroup(components, componentId)) return refuse("overridden");
      if (c.deleted) return controller.act({ kind: "clear", deletionActionId: c.deletionActionId });
      if (c.keeper) return controller.act({ kind: "delete", pane, componentId });
      return controller.act({ kind: "keeper", pane, componentId, selected: true });
    },
    toggleKeeper(pane, componentId) {
      const c = editable(pane, componentId);
      if (!c) return refuse("unknown");
      if (overridden(pane, componentId)) return refuse("overridden");
      return controller.act({ kind: "keeper", pane, componentId, selected: !c.keeper });
    },
    plainDelete(pane, componentId) {
      if (!editable(pane, componentId)) return refuse("unknown");
      if (overridden(pane, componentId)) return refuse("overridden");
      return controller.act({ kind: "delete", pane, componentId });
    },
    feedbackDelete(pane, componentId, feedback) {
      if (!editable(pane, componentId)) return refuse("unknown");
      if (overridden(pane, componentId)) return refuse("overridden");
      if (typeof feedback !== "string" || feedback.trim() === "") return refuse("blank");
      if (!controller.getState().canAct) return refuse("busy");
      controller.setDraft(comparisonId, pane, componentId, feedback);
      return controller.act({ kind: "feedback-delete", pane, componentId, feedback });
    },
    saveComment(pane, componentId, feedback) {
      if (!current() || !findComponent(controller.getState().view.comparison, pane, componentId)) return refuse("unknown");
      if (typeof feedback !== "string" || !feedback.trim()) return refuse("blank");
      return controller.act({ kind: "comment", pane, componentId, feedback });
    },
    undo(deletionActionId) {
      if (!current()) return refuse("unknown");
      const view = controller.getState().view.comparison;
      const row = view.history.find((r) => r.id === deletionActionId);
      if (!row || !canUndoRow(view, row)) return refuse("unknown");
      return controller.act({ kind: "undo", deletionActionId });
    },
    send: () => refuse("unsupported"),
    retry() {
      return !retired && controller.getState().failure?.op === "act" ? controller.retry() : refuse("nothing");
    },
    dismissFailure: () => !retired && controller.dismissFailure(),
    getDraft: (pane, componentId) => controller.getDraft(comparisonId, pane, componentId),
    setDraft(pane, componentId, text) {
      if (!retired) controller.setDraft(comparisonId, pane, componentId, text);
    },
  };
}

/** The save line of the session page. It never claims chat receipt or generation. */
export function sessionStatusLabel(snap) {
  const f = snap.failure ?? null;
  const session = snap.session;
  if (snap.status === "loading") return ["Loading…", "saving"];
  if (snap.status === "load-failed") return ["Not loaded", "failed"];
  if (snap.status === "saving") return ["Saving…", "saving"];
  if (snap.status === "sending") return [`${OP_LABEL[snap.pending?.op] ?? "Saving"}…`, "saving"];
  if (snap.unresolved) return ["Not confirmed", "failed"];
  if (f) return ["Save failed", "failed"];
  if (session?.status === "ended") return ["Ended · read-only", "sent"];
  if (session?.status === "generating") return ["Submitted · read-only", "saving"];
  if (session?.status === "failed") return ["Generation failed · read-only", "failed"];
  return ["Saved", ""];
}

// ---------------------------------------------------------------- shell

/**
 * Render the session page. Returns a handle for tests:
 * { controller, pair, close() }, where pair is { comparisonId, facade, shell }.
 */
export function mountSessionShell({ window: win, controller }) {
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  let pair = null;
  let closed = false;
  // The End choice belongs to one displayed pair at one session revision; any change clears it.
  const NO_CHOICE = { open: false, comparisonId: null, revision: null, pane: null, notice: "" };
  let choice = NO_CHOICE;

  function retireFrames() {
    for (const pane of PANES) {
      // A new element gets a new window, so the old window's messages fail the source check.
      const old = $(`frame-${pane}`);
      const fresh = old.cloneNode(false);
      fresh.removeAttribute("src");
      old.replaceWith(fresh);
      $(`controls-list-${pane}`).replaceChildren();
    }
  }

  function mountPair(comparisonId) {
    if (pair) {
      pair.shell.close();
      pair.facade.retire();
      retireFrames();
    }
    const facade = comparisonFacade(controller, comparisonId);
    pair = { comparisonId, facade, shell: mountDoubleShell({ window: win, controller: facade, comparisonId, statusLabel: sessionStatusLabel }) };
  }

  function setChoice(pane) {
    choice.pane = pane;
    for (const input of doc.querySelectorAll('input[name="endPane"]')) input.checked = input.value === pane;
  }

  function renderSession(s) {
    const view = s.view;
    const status = view?.status;
    const round = view ? view.rounds.length : 0;
    $("sessionState").textContent = view ? `Round ${round} · ${{ editing: "Editing", generating: "Generating", failed: "Generation failed", ended: "Ended" }[status]}` : "";
    $("sessionState").dataset.state = status || "";

    if (view && choice.open && (choice.comparisonId !== view.currentComparisonId || choice.revision !== view.revision)) {
      const notice = choice.comparisonId !== view.currentComparisonId
        ? "A new pair replaced the one you were choosing from. Choose again from the pair now shown."
        : "The saved session changed while you were choosing. Check the pair shown and choose again.";
      choice = { open: status !== "ended", comparisonId: view.currentComparisonId, revision: view.revision, pane: null, notice };
      setChoice(null);
    }

    let note = "";
    if (!view) note = "";
    else if (status === "editing") note = "Next Round sends saved feedback and requests another pair. Done returns your final choice to the chat.";
    else if (status === "generating") note = `Round ${round} is submitted. The next pair appears here when the agent attaches it. This page reads the saved session every few seconds; it cannot confirm that the chat received the round.`;
    else if (status === "failed") note = `Generation failed: ${view.generation.attempt.failure ?? "no message"}. The pair and your feedback stay saved. Retry generation asks again for the same submitted round. Done chooses from this pair.`;
    else {
      const final = view.final;
      const label = view.comparison.comparisonId === final.comparisonId ? view.comparison.panes[final.pane].label : final.comparisonId;
      note = `Session ended. You chose the ${PANE_NAMES[final.pane]} page (${label}). The agent can now read that page with discarded components removed, and the feedback history of every round. This page does not confirm that the chat received it.`;
    }
    $("sessionNote").textContent = note;
    const overall = $("overallComment");
    if (overall) {
      const text = view ? controller.getDraft(view.currentComparisonId, "", "") : "";
      if (overall.value !== text) overall.value = text;
      overall.disabled = !s.canAct;
      $("saveOverallComment").disabled = !s.canAct || !text.trim();
      $("overallCommentPanel").hidden = status !== "editing";
    }

    const drafts = status === "editing" ? s.unsavedDrafts : [];
    $("draftNote").hidden = drafts.length === 0;
    $("draftNote").textContent = drafts.length
      ? `Unsaved feedback text for ${drafts.map((d) => d.pane ? `${PANE_NAMES[d.pane]} · ${d.label}` : d.label).join(", ")}. Save the comment or clear its text before Next Round or Done.`
      : "";

    let keepers = 0;
    let deletions = 0;
    for (const pane of PANES) for (const c of view ? view.comparison.panes[pane].components : []) {
      // A selected group decides for its descendants, as in the batch.
      if (controllingGroup(view.comparison.panes[pane].components, c.id)) continue;
      if (c.deleted) deletions += 1;
      else if (c.keeper) keepers += 1;
    }
    $("summary").textContent = view ? `${keepers} keeper${keepers === 1 ? "" : "s"} · ${deletions} discard${deletions === 1 ? "" : "s"}` : "";

    const next = $("next");
    next.hidden = status !== "editing";
    next.disabled = !s.canNext;
    next.textContent = s.status === "submitting" && s.pending?.op === "next" ? "Submitting…" : "Next Round";
    const retry = $("retryGeneration");
    retry.hidden = status !== "failed";
    retry.disabled = !s.canRetryGeneration;

    const ended = !view || status === "ended";
    $("endOpen").hidden = ended || choice.open;
    $("endOpen").disabled = !s.canEnd;
    const panel = $("endPanel");
    panel.hidden = ended || !choice.open;
    if (!panel.hidden) {
      for (const pane of PANES) $(`endLabel-${pane}`).textContent = view.comparison.panes[pane].label;
      for (const input of doc.querySelectorAll('input[name="endPane"]')) input.disabled = !s.canEnd;
      $("endConfirm").disabled = !s.canEnd || !choice.pane;
      $("endNotice").textContent = choice.notice;
      $("endNotice").hidden = !choice.notice;
    }
    if (ended) choice = NO_CHOICE;

    // Failures of Next, End, and Retry. Component failures use the pair alert.
    const f = s.failure && s.failure.op !== "act" ? s.failure : null;
    const box = $("sessionAlert");
    box.hidden = !f;
    if (f) {
      const what = `${OP_LABEL[f.op]} failed: ${f.message}`;
      const notSaved = f.notSaved ? " The earlier attempt was not saved." : "";
      $("sessionAlertText").textContent = f.uncertain
        ? `${what} It may already be saved. Retry sends the same request; the server returns the saved result if it already committed. Other changes stay paused until then.`
        : `${what}${notSaved} ${f.refreshed ? "The latest saved session is now shown." : "The saved session is unchanged."}${f.op === "end" ? " Choose again from the pair shown." : ""}`;
      $("sessionRetry").hidden = !f.uncertain;
      $("sessionRetry").disabled = s.status !== "ready";
      $("sessionDismiss").hidden = f.uncertain;
    }
  }

  function render(s) {
    if (s.view && s.view.currentComparisonId !== pair?.comparisonId) mountPair(s.view.currentComparisonId);
    pair.facade.publish(s);
    renderSession(s);
  }

  async function confirmEnd() {
    const outcome = await controller.end(choice.pane, choice.comparisonId, choice.revision);
    // A proven refusal never leaves a choice to send again: the owner chooses anew.
    if (closed || outcome.ok || outcome.error?.uncertain || !choice.open) return;
    choice = { ...choice, pane: null };
    setChoice(null);
    renderSession(controller.getState());
  }

  // Named handlers, so close() removes exactly what this mount added.
  const handlers = [
    ["saveOverallComment", () => {
      const text = $("overallComment").value;
      if (text.trim()) controller.act({ kind: "round-comment", feedback: text });
    }],
    ["next", () => controller.next()],
    ["retryGeneration", () => controller.retryGeneration()],
    ["endOpen", () => {
      const s = controller.getState();
      if (!s.view || !s.canEnd) return;
      choice = { open: true, comparisonId: s.view.currentComparisonId, revision: s.view.revision, pane: null, notice: "" };
      setChoice(null);
      renderSession(s);
      doc.querySelector('input[name="endPane"]')?.focus();
    }],
    ["endCancel", () => {
      choice = NO_CHOICE;
      setChoice(null);
      renderSession(controller.getState());
      $("endOpen").focus();
    }],
    ["endConfirm", confirmEnd],
    ["sessionRetry", () => controller.retry()],
    ["sessionDismiss", () => controller.dismissFailure()],
  ];
  function onChoice(event) {
    if (event.target.checked) choice.pane = event.target.value;
    renderSession(controller.getState());
  }

  function overallInput() {
    const view = controller.getState().view;
    if (view) controller.setDraft(view.currentComparisonId, "", "", $("overallComment").value);
  }
  mountPair("");
  $("overallComment")?.addEventListener("input", overallInput);
  for (const [id, handler] of handlers) $(id)?.addEventListener("click", handler);
  for (const input of doc.querySelectorAll('input[name="endPane"]')) input.addEventListener("change", onChoice);
  const unsubscribe = controller.subscribe(render);

  return {
    controller,
    get pair() {
      return pair;
    },
    /** Idempotent. Retires the pair, the controls, and the controller. */
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      $("overallComment")?.removeEventListener("input", overallInput);
      for (const [id, handler] of handlers) $(id)?.removeEventListener("click", handler);
      for (const input of doc.querySelectorAll('input[name="endPane"]')) input.removeEventListener("change", onChoice);
      controller.close();
      pair.shell.close();
      pair.facade.retire();
    },
  };
}

// ---------------------------------------------------------------- bootstrap

/** Boot from the server-filled data attributes on <body>. */
export function bootDoubleSession(win, { fetch: fetchImpl = win.fetch?.bind(win), base = "", timers = win } = {}) {
  const body = win.document.body;
  const sessionId = body.dataset.session;
  const token = body.dataset.token;
  const configured = validId(sessionId) && sessionId !== "__DOUBLE_SESSION_ID__" && typeof token === "string" && token !== "" && token !== "__TOKEN__";
  const transport = configured
    ? createSessionTransport({ sessionId, token, fetch: fetchImpl, base })
    : { load: () => Promise.reject(new DoubleRequestError({ code: "NOT_CONFIGURED", message: "The page has no session or token." })) };
  const controller = createSessionController({ sessionId: configured ? sessionId : "", transport, timers });
  const shell = mountSessionShell({ window: win, controller });
  controller.load();
  return shell;
}

if (typeof window !== "undefined" && window.document?.body?.dataset.doubleSessionShell !== undefined) {
  bootDoubleSession(window);
}
