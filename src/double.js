/**
 * Double owner shell: two opaque-origin artifact frames, a trusted delete
 * popup, the deleted-items history, and Send.
 *
 * Three layers, each testable alone:
 *   - createFetchTransport: the only code that talks to the server.
 *   - createDoubleController: saved-state machine over any transport.
 *   - mountDoubleShell: DOM rendering and the frame message bridge.
 *
 * The shell applies component state only from server responses. Frames send
 * intentions; they never receive the API token and never call the API.
 * Each pane also has trusted component controls in the shell itself, built
 * from the saved view, so every component stays reachable even when the
 * reviewed document hides or disables the in-frame controls.
 */
import "./theme.js";
import { encodeDoubleComparisonId } from "./double-route.js";
import { controllingGroup } from "./double-selection.js";

export const CHANNEL = "human-review-double";
export const PANES = Object.freeze(["left", "right"]);
export const PANE_NAMES = Object.freeze({ left: "Left", right: "Right" });

const ID_FORBIDDEN = /[\s\p{C}]/u;

export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// The input validator's identity contract: nonempty, no whitespace, no Unicode category C.
export const validId = (value) => typeof value === "string" && value.length > 0 && !ID_FORBIDDEN.test(value);

function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// ---------------------------------------------------------------- errors

/** A failed request. `uncertain` means the server may have saved it anyway. */
export class DoubleRequestError extends Error {
  constructor({ code, message, status = null, view = null, uncertain = false }) {
    super(message);
    this.name = "DoubleRequestError";
    this.code = code;
    this.status = status;
    this.view = view;
    this.uncertain = uncertain;
  }
}

/**
 * Archive codes that prove the exact request was not saved. The archive
 * matches a repeated action ID before these checks, so they also settle an
 * earlier uncertain attempt of the same request.
 */
const NOT_SAVED_CODES = new Set([
  "INVALID_REQUEST", "INVALID_ID", "UNKNOWN_COMPONENT", "UNKNOWN_DELETION", "INVALID_TRANSITION",
  "STALE_REVISION", "ACTION_CONFLICT", "READ_ONLY", "WRITE_FAILED",
]);
/** Codes that leave the saved outcome unknown, however a transport wraps them. */
const UNKNOWN_OUTCOME_CODES = new Set(["COMMIT_UNCERTAIN", "RECOVERY_REQUIRED", "NETWORK", "BAD_RESPONSE", "BAD_VIEW", "BAD_RESULT"]);

/**
 * Whether a failed mutation may have been saved. A request that was already
 * uncertain stays uncertain until an answer proves its outcome.
 */
export function outcomeUnknown(error, wasUncertain) {
  const code = error?.code;
  if (NOT_SAVED_CODES.has(code)) return false;
  if (wasUncertain) return true;
  return typeof code !== "string" || UNKNOWN_OUTCOME_CODES.has(code) || error.uncertain === true;
}

/**
 * Check that a success answer carries the complete DoubleStore receipt of
 * this exact request, consistent with its view. Returns a problem or null.
 * The view may be newer than the receipt: a retried request returns its
 * original receipt with the latest saved view.
 */
function receiptProblem(result, view, op, request) {
  const keys = op === "send" ? ["actionId", "kind", "revision", "batchId"] : ["actionId", "kind", "revision"];
  if (!isRecord(result) || !hasExactKeys(result, keys)) return "The receipt is incomplete.";
  if (result.actionId !== request.actionId) return "The receipt belongs to another request.";
  if (result.kind !== (op === "send" ? "send" : request.kind)) return "The receipt kind does not match the request.";
  const expected = request.expectedRevision + 1;
  if (!Number.isSafeInteger(expected) || result.revision !== expected) return "The receipt revision does not match the request.";
  if (view.revision < result.revision) return "The view is older than the receipt.";
  if (op === "send") {
    if (!validId(result.batchId)) return "The Send receipt has no valid batch ID.";
    if (view.status !== "sent" || !isRecord(view.delivery) || view.delivery.batchId !== result.batchId) return "The view does not show the sent batch.";
  }
  return null;
}

// ---------------------------------------------------------------- view

/**
 * Check the public view shape the shell depends on. A malformed view is
 * never shown as saved state.
 */
export function validateView(view, comparisonId) {
  if (!isRecord(view)) return "The view is not an object.";
  if (view.comparisonId !== comparisonId) return "The view belongs to another comparison.";
  if (typeof view.label !== "string") return "The view label is missing.";
  if (!Number.isSafeInteger(view.revision) || view.revision < 0) return "The view revision is invalid.";
  if (view.status !== "editing" && view.status !== "sent") return "The view status is invalid.";
  if (!isRecord(view.panes)) return "The view panes are missing.";
  for (const pane of PANES) {
    const p = view.panes[pane];
    if (!isRecord(p) || p.id !== pane || typeof p.label !== "string" || !Array.isArray(p.components)) return `The ${pane} pane is invalid.`;
    if (p.frameUrl !== undefined && p.frameUrl !== null && typeof p.frameUrl !== "string") return `The ${pane} frame URL is invalid.`;
    const seen = new Set();
    for (const c of p.components) {
      if (!isRecord(c) || !validId(c.id) || seen.has(c.id)) return `A ${pane} component is invalid or repeated.`;
      if (typeof c.label !== "string" || typeof c.keeper !== "boolean" || typeof c.deleted !== "boolean") return `The ${pane} component ${c.id} is invalid.`;
      seen.add(c.id);
    }
  }
  if (!Array.isArray(view.history)) return "The deletion history is missing.";
  for (const row of view.history) {
    if (!isRecord(row) || typeof row.id !== "string" || !PANES.includes(row.pane) || typeof row.componentId !== "string") return "A deletion history row is invalid.";
    if (row.kind !== "delete" && row.kind !== "feedback-delete") return "A deletion history row has an unknown kind.";
  }
  if (view.comments !== undefined) {
    if (!Array.isArray(view.comments)) return "The comments are invalid.";
    for (const comment of view.comments) {
      if (!isRecord(comment) || !validId(comment.id) || typeof comment.comment !== "string" || !comment.comment.trim()) return "A comment is invalid.";
      if (comment.scope === "round") {
        if (!hasExactKeys(comment, ["id", "scope", "comment"])) return "The overall comment is invalid.";
      } else {
        if (!hasExactKeys(comment, ["id", "identity", "label", "comment"]) || !isRecord(comment.identity) ||
            comment.identity.comparisonId !== comparisonId || !PANES.includes(comment.identity.pane) ||
            typeof comment.label !== "string" || !view.panes[comment.identity.pane].components.some((c) => c.id === comment.identity.componentId)) return "The comment target is invalid.";
      }
    }
  }
  return null;
}

export function findComponent(view, pane, componentId) {
  if (!view || !PANES.includes(pane)) return null;
  return view.panes[pane].components.find((c) => c.id === componentId) || null;
}

/** An Undo is available for the deletion that currently hides its component. */
export function canUndoRow(view, row) {
  if (!view || row.undone) return false;
  const c = findComponent(view, row.pane, row.componentId);
  return Boolean(c && c.deleted && (c.deletionActionId == null || c.deletionActionId === row.id));
}

// ---------------------------------------------------------------- transport

/**
 * One JSON API request with the token in the header. Shared by the one-shot
 * and session transports, so both keep the same error and certainty rules.
 * `signal` only cancels a read.
 */
export function createDoubleRequest({ token, fetch: fetchImpl = globalThis.fetch, allowEmptyView = false }) {
  return async function request(path, method, body, signal) {
    let res;
    try {
      res = await fetchImpl(path, {
        method,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-human-review-token": token },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new DoubleRequestError({
        code: "NETWORK",
        message: "The server did not answer.",
        uncertain: method !== "GET",
      });
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      throw new DoubleRequestError({
        code: typeof error.code === "string" ? error.code : `HTTP_${res.status}`,
        message: typeof error.message === "string" && error.message ? error.message : `Request failed (${res.status}).`,
        status: res.status,
        view: isRecord(payload) && isRecord(payload.view) ? payload.view : null,
        uncertain: method !== "GET" && res.status >= 500,
      });
    }
    if (!isRecord(payload) || !(isRecord(payload.view) || allowEmptyView && payload.view === null)) {
      throw new DoubleRequestError({
        code: "BAD_RESPONSE",
        message: "The server answer had no comparison view.",
        status: res.status,
        uncertain: method !== "GET",
      });
    }
    return payload;
  };
}

/**
 * Real HTTP transport. The token goes only into the request header, never a
 * query string or a frame message. The comparison ID is encoded only in the
 * path segment; an invalid ID throws before any request.
 */
export function createFetchTransport({ comparisonId, token, fetch: fetchImpl = globalThis.fetch, base = "" }) {
  const root = `${base}/api/double/${encodeDoubleComparisonId(comparisonId)}`;
  const request = createDoubleRequest({ token, fetch: fetchImpl });

  return {
    load: () => request(root, "GET"),
    act: (actionRequest) => request(`${root}/actions`, "POST", actionRequest),
    send: (sendRequest) => request(`${root}/send`, "POST", sendRequest),
  };
}

// ---------------------------------------------------------------- controller

function defaultNewId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const draftKey = (pane, componentId) => `${pane}\u0000${componentId}`;

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * Saved-state machine. Status is one of:
 *   loading | load-failed | ready | saving | sending
 * `failure` holds the last failed mutation and its exact request for Retry.
 * An uncertain failure blocks every fresh mutation until Retry of that same
 * request returns its receipt or an answer that proves it was not saved.
 * Reload and Dismiss never clear it.
 */
export function createDoubleController({ comparisonId, transport, newId = defaultNewId }) {
  const listeners = new Set();
  const drafts = new Map();
  const state = {
    status: "loading",
    view: null,
    pending: null, // { op: "act"|"send", request }
    failure: null, // { op, request, code, message, uncertain, refreshed, notSaved }
    loadError: null, // { code, message }
    notice: null,
  };
  // Identifies the latest load() call.
  let loadTicket = 0;

  const snapshot = () => ({
    status: state.status,
    view: state.view,
    pending: state.pending,
    failure: state.failure,
    loadError: state.loadError,
    notice: state.notice,
    busy: state.status === "saving" || state.status === "sending",
    readOnly: state.view?.status === "sent",
    unresolved: unresolved(),
    canMutate: canMutate(),
  });

  function emit() {
    const snap = snapshot();
    for (const listener of listeners) listener(snap);
  }

  function unresolved() {
    return Boolean(state.failure?.uncertain);
  }

  function canMutate() {
    return state.status === "ready" && state.view !== null && state.view.status === "editing" && !unresolved();
  }

  /**
   * A sent comparison has nothing left to retry, except an unresolved request
   * and unsaved feedback text, which stay reported.
   */
  function settleSent() {
    const f = state.failure;
    if (state.view?.status === "sent" && f && !f.uncertain && f.request.kind !== "feedback-delete") state.failure = null;
  }

  /**
   * Why a valid server view cannot replace the current one, or null. An older
   * revision never replaces a newer one, and a known sent comparison never
   * becomes editable again: acknowledgment never unlocks.
   */
  function staleProblem(view) {
    if (!state.view) return null;
    if (view.revision < state.view.revision) {
      return `The server answered with saved revision ${view.revision}, older than revision ${state.view.revision} on screen.`;
    }
    if (state.view.status === "sent" && view.status !== "sent") {
      return `The server answered with an editing view, but revision ${state.view.revision} on screen is already sent.`;
    }
    return null;
  }

  /** Apply a server view if it is valid and not stale. */
  function applyView(view) {
    if (validateView(view, comparisonId) !== null) return false;
    if (staleProblem(view) !== null) return false;
    state.view = deepFreeze(structuredClone(view));
    return true;
  }

  /**
   * GET the saved view. Only the latest load decides: an earlier answer that
   * arrives late is ignored, so it can neither replace a newer view nor end a
   * later load or save. A stale answer keeps the current view and is reported
   * as a failed refresh, never as the latest saved state.
   */
  async function load() {
    if (state.status === "saving" || state.status === "sending") return false;
    const ticket = ++loadTicket;
    state.status = "loading";
    state.loadError = null;
    emit();
    try {
      const payload = await transport.load();
      if (ticket !== loadTicket) return false;
      const problem = validateView(payload?.view, comparisonId);
      if (problem) throw new DoubleRequestError({ code: "BAD_VIEW", message: problem });
      const stale = staleProblem(payload.view);
      if (stale) throw new DoubleRequestError({ code: "STALE_VIEW", message: `${stale} The answer was not applied.` });
      applyView(payload.view);
      state.status = "ready";
      settleSent();
    } catch (error) {
      if (ticket !== loadTicket) return false;
      state.loadError = { code: error.code || "LOAD_FAILED", message: error.message || "The comparison could not be loaded." };
      state.status = state.view ? "ready" : "load-failed";
    }
    emit();
    return state.status === "ready" && !state.loadError;
  }

  async function run(op, request) {
    const wasUncertain = Boolean(state.failure?.uncertain && state.failure.request === request);
    state.status = op === "send" ? "sending" : "saving";
    state.pending = { op, request };
    state.notice = null;
    emit();
    let outcome;
    try {
      const payload = op === "send" ? await transport.send(request) : await transport.act(request);
      const problem = validateView(payload?.view, comparisonId);
      if (problem) {
        throw new DoubleRequestError({ code: "BAD_VIEW", message: `The saved result could not be shown: ${problem}`, uncertain: true });
      }
      // An answer that is not the receipt of this request proves nothing, so its view is not shown either.
      const receipt = receiptProblem(payload.result, payload.view, op, request);
      if (receipt) {
        throw new DoubleRequestError({ code: "BAD_RESULT", message: `The server answer is not the receipt of this request. ${receipt}`, uncertain: true });
      }
      applyView(payload.view);
      state.failure = null;
      state.loadError = null;
      if (request.kind === "feedback-delete") {
        const key = draftKey(request.pane, request.componentId);
        // A draft edited after the failed attempt stays for the owner.
        if (drafts.get(key) === request.feedback) drafts.delete(key);
      }
      outcome = { ok: true, result: payload.result ?? null };
    } catch (error) {
      const refreshed = Boolean(error && error.view) && applyView(error.view);
      const uncertain = outcomeUnknown(error, wasUncertain);
      state.failure = {
        op,
        request,
        code: error?.code || "FAILED",
        message: error?.message || "The request failed.",
        uncertain,
        refreshed,
        // An earlier unknown outcome is now known: the request was not saved.
        notSaved: wasUncertain && !uncertain,
      };
      outcome = { ok: false, error: state.failure };
    }
    state.pending = null;
    state.status = "ready";
    settleSent();
    emit();
    return outcome;
  }

  function refuse(reason) {
    return Promise.resolve({ ok: false, refused: reason });
  }

  function mutate(fields) {
    if (!canMutate()) return refuse(state.view?.status === "sent" ? "read-only" : "busy");
    const request = deepFreeze({ actionId: newId(), expectedRevision: state.view.revision, ...fields });
    return run("act", request);
  }

  function editable(pane, componentId) {
    const c = findComponent(state.view, pane, componentId);
    return c && !c.deleted ? c : null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    getState: snapshot,
    load,
    toggleKeeper(pane, componentId) {
      const c = editable(pane, componentId);
      if (!c) return refuse("unknown");
      return mutate({ kind: "keeper", pane, componentId, selected: !c.keeper });
    },
    plainDelete(pane, componentId) {
      if (!editable(pane, componentId)) return refuse("unknown");
      return mutate({ kind: "delete", pane, componentId });
    },
    feedbackDelete(pane, componentId, feedback) {
      if (!editable(pane, componentId)) return refuse("unknown");
      if (typeof feedback !== "string" || feedback.trim() === "") return refuse("blank");
      if (!canMutate()) return refuse(state.view?.status === "sent" ? "read-only" : "busy");
      drafts.set(draftKey(pane, componentId), feedback);
      return mutate({ kind: "feedback-delete", pane, componentId, feedback });
    },
    undo(deletionActionId) {
      const row = state.view?.history.find((r) => r.id === deletionActionId);
      if (!row || !canUndoRow(state.view, row)) return refuse("unknown");
      return mutate({ kind: "undo", deletionActionId });
    },
    send() {
      if (!canMutate()) return refuse(state.view?.status === "sent" ? "read-only" : "busy");
      return run("send", deepFreeze({ actionId: newId(), expectedRevision: state.view.revision }));
    },
    /**
     * Resend the exact failed request, with its original actionId. An
     * uncertain request can be retried on a sent comparison, because the
     * archive returns its receipt if it was saved.
     */
    retry() {
      const f = state.failure;
      if (state.status !== "ready" || !f) return refuse("nothing");
      if (!f.uncertain && state.view?.status === "sent") return refuse("read-only");
      return run(f.op, f.request);
    },
    /** Only a confirmed failure can be dismissed; an unknown outcome stays. */
    dismissFailure() {
      if (unresolved()) return false;
      state.failure = null;
      emit();
      return true;
    },
    getDraft: (pane, componentId) => drafts.get(draftKey(pane, componentId)) ?? "",
    setDraft(pane, componentId, text) {
      if (text) drafts.set(draftKey(pane, componentId), text);
      else drafts.delete(draftKey(pane, componentId));
    },
  };
}

// ---------------------------------------------------------------- frame messages

/** Validate a frame message. Returns the parsed message or null. */
export function parseFrameMessage(data, comparisonId, pane) {
  if (!isRecord(data) || data.channel !== CHANNEL) return null;
  if (data.comparisonId !== comparisonId || data.pane !== pane) return null;
  if (typeof data.instance !== "string" || !/^[0-9a-f]{8,64}$/.test(data.instance)) return null;
  if (["ready", "hover"].includes(data.type) && hasExactKeys(data, ["channel", "type", "comparisonId", "pane", "instance"])) {
    return { type: data.type, instance: data.instance };
  }
  if (data.type === "intent" && hasExactKeys(data, ["channel", "type", "comparisonId", "pane", "instance", "intent", "componentId"])) {
    if (!["keeper", "delete", "cycle"].includes(data.intent)) return null;
    if (!validId(data.componentId)) return null;
    return { type: "intent", instance: data.instance, intent: data.intent, componentId: data.componentId };
  }
  return null;
}

export function frameState(snap, comparisonId, pane) {
  const components = snap.view
    ? snap.view.panes[pane].components.map(({ id, label, keeper, deleted, scope, parentId }) => ({ id, label, keeper, deleted, ...(scope && { scope }), ...(parentId && { parentId }) }))
    : [];
  return {
    channel: CHANNEL,
    type: "state",
    comparisonId,
    pane,
    components,
    busy: snap.busy || snap.status !== "ready" || snap.unresolved,
    readOnly: snap.readOnly,
    ...(snap.session ? { controls: "shell", showDiscards: snap.session.status !== "ended" } : {}),
  };
}

/** Only a same-origin path may become a frame address. */
export function safeFrameUrl(value) {
  return typeof value === "string" && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : null;
}

// ---------------------------------------------------------------- shell

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "className") node.className = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

const KIND_LABEL = { delete: "Plain delete", "feedback-delete": "Feedback delete" };

/**
 * Render the shell into `doc` and bridge both frames. Returns a handle for
 * tests: { controller, frames, close() }. A shell without a `#send` button
 * leaves submission to its host page. `statusLabel(snap)` can return the
 * `[label, kind]` of the save line instead of the one-shot labels.
 */
export function mountDoubleShell({ window: win, controller, comparisonId, statusLabel = null }) {
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const frames = {};
  let snap = controller.getState();
  let popup = null; // { pane, componentId, node, textarea, returnFocus, ... }
  // Set by close(). Retained parent controls then cannot keep or open a popup.
  let closed = false;
  // Parent component control rows per pane, keyed by component ID.
  const controlRows = { left: new Map(), right: new Map() };

  for (const pane of PANES) {
    const iframe = $(`frame-${pane}`);
    // A frame announces its hover once; the parent ends it once. The flag keeps
    // shell pointer moves from posting a message on every move.
    const clearHover = () => {
      if (closed || !snap.session || !frames[pane].ready || !frames[pane].hovered) return;
      frames[pane].hovered = false;
      iframe.contentWindow?.postMessage({ channel: CHANNEL, type: "hover-end", comparisonId, pane }, "*");
    };
    frames[pane] = { iframe, ready: false, instance: null, src: null, hovered: false, clearHover };
    iframe.addEventListener("mouseleave", clearHover);
  }

  function postState(pane) {
    const frame = frames[pane];
    if (!frame.ready || !frame.iframe.contentWindow) return;
    // Opaque frame origins cannot be named; window identity is checked on receipt.
    frame.iframe.contentWindow.postMessage(frameState(snap, comparisonId, pane), "*");
  }

  function onMessage(event) {
    const pane = PANES.find((p) => frames[p].iframe.contentWindow && event.source === frames[p].iframe.contentWindow);
    if (!pane || event.origin !== "null") return;
    const message = parseFrameMessage(event.data, comparisonId, pane);
    if (!message) return;
    const frame = frames[pane];
    if (message.type === "ready") {
      // A new instance means the frame loaded again; a repeated one is ignored.
      if (frame.ready && frame.instance === message.instance) return;
      frame.ready = true;
      frame.instance = message.instance;
      frame.hovered = false;
      postState(pane);
      return;
    }
    if (!frame.ready || frame.instance !== message.instance) return;
    if (message.type === "hover") {
      frame.hovered = true;
      for (const other of PANES) if (other !== pane) frames[other].clearHover();
      return;
    }
    handleIntent(pane, message.intent, message.componentId, null);
  }

  /**
   * One path for keeper and delete intents from a frame or from the parent
   * controls. `returnFocus` names the element that gets focus when the popup
   * closes; without it, focus returns to the frame.
   */
  function handleIntent(pane, intent, componentId, returnFocus) {
    const component = findComponent(snap.view, pane, componentId);
    if (closed || !component || !snap.canMutate) return;
    // A session frame only cycles; the legacy intents belong to one-shot shells.
    if (snap.session) {
      if (intent === "cycle") controller.cycleSelection(pane, componentId);
      return;
    }
    if (component.deleted || intent === "cycle") return;
    if (intent === "keeper") controller.toggleKeeper(pane, componentId);
    else openPopup(pane, componentId, returnFocus);
  }

  // ------------------------------------------------------------ popup

  function openPopup(pane, componentId, returnFocus) {
    if (popup && popup.pane === pane && popup.componentId === componentId) {
      popup.textarea.focus();
      return;
    }
    closePopup(false);
    const component = findComponent(snap.view, pane, componentId);
    if (!component) return;
    const titleId = `popup-title-${pane}`;
    const node = el(doc, "div", { className: "double-popup", role: "dialog", "aria-modal": "false", "aria-labelledby": titleId, "data-pane": pane });
    const head = el(doc, "div", { className: "popup-head" });
    const title = el(doc, "p", { className: "popup-title", id: titleId });
    title.append(el(doc, "span", { className: "popup-kicker" }, `Delete from ${PANE_NAMES[pane]}`), el(doc, "span", { className: "popup-name" }, component.label));
    const cancel = el(doc, "button", { type: "button", className: "btn-ghost popup-cancel", "aria-label": `Cancel deleting ${component.label}` }, "Cancel");
    head.append(title, cancel);

    const plain = el(doc, "button", { type: "button", className: "btn-danger popup-plain", "aria-label": `Delete ${component.label} without feedback` });
    plain.append(el(doc, "span", { className: "popup-x", "aria-hidden": "true" }, "✕"), doc.createTextNode(" Delete"));

    const fieldId = `popup-feedback-${pane}`;
    const label = el(doc, "label", { className: "popup-label", for: fieldId }, "Or delete with feedback");
    const textarea = el(doc, "textarea", { id: fieldId, rows: 3, placeholder: "What is wrong with this component?", "aria-describedby": `popup-status-${pane}` });
    textarea.value = controller.getDraft(pane, componentId);
    const withFeedback = el(doc, "button", { type: "button", className: "btn-primary popup-feedback" }, "Delete with feedback");
    const status = el(doc, "p", { className: "popup-status", id: `popup-status-${pane}`, role: "status", "aria-live": "polite" });
    const retry = el(doc, "button", { type: "button", className: "btn-ghost popup-retry", hidden: true }, "Retry");
    const foot = el(doc, "div", { className: "popup-foot" });
    foot.append(status, retry);
    node.append(head, plain, label, textarea, withFeedback, foot);

    popup = { pane, componentId, node, textarea, plain, withFeedback, status, retry, cancel, returnFocus };
    textarea.addEventListener("input", () => {
      controller.setDraft(pane, componentId, textarea.value);
      updatePopup();
    });
    cancel.addEventListener("click", () => closePopup(true));
    plain.addEventListener("click", () => {
      controller.plainDelete(pane, componentId);
    });
    withFeedback.addEventListener("click", () => {
      controller.feedbackDelete(pane, componentId, textarea.value);
    });
    retry.addEventListener("click", () => controller.retry());
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopup(true);
      }
    });
    $(`stage-${pane}`).append(node);
    updatePopup();
    (textarea.value ? textarea : plain).focus();
  }

  function closePopup(restoreFocus) {
    if (!popup) return;
    // The draft is already stored on every input event.
    const { pane, node, returnFocus } = popup;
    node.remove();
    popup = null;
    if (!restoreFocus) return;
    const target = returnFocus?.();
    if (target) target.focus();
    else frames[pane].iframe.focus();
  }

  function popupFailure() {
    const f = snap.failure;
    if (!popup || !f || f.op !== "act") return null;
    const r = f.request;
    return (r.kind === "delete" || r.kind === "feedback-delete") && r.pane === popup.pane && r.componentId === popup.componentId ? f : null;
  }

  function updatePopup() {
    if (!popup) return;
    const component = findComponent(snap.view, popup.pane, popup.componentId);
    if (!component || component.deleted || snap.readOnly) {
      // Saved: the component is gone, so the popup closes.
      closePopup(component?.deleted || snap.readOnly);
      return;
    }
    const busy = !snap.canMutate;
    popup.plain.disabled = busy;
    popup.withFeedback.disabled = busy || popup.textarea.value.trim() === "";
    const failure = popupFailure();
    popup.retry.hidden = !failure || snap.status !== "ready";
    if (snap.status === "saving" && snap.pending?.request.pane === popup.pane && snap.pending?.request.componentId === popup.componentId) {
      popup.status.textContent = "Saving…";
      popup.status.className = "popup-status saving";
    } else if (failure) {
      popup.status.textContent = failureText(failure);
      popup.status.className = "popup-status failed";
    } else if (snap.unresolved) {
      popup.status.textContent = "Paused until the earlier change is confirmed. Your text is kept.";
      popup.status.className = "popup-status failed";
    } else if (busy) {
      popup.status.textContent = snap.status === "sending" ? "Sending…" : "Saving…";
      popup.status.className = "popup-status saving";
    } else if (popup.textarea.value.trim() === "") {
      popup.status.textContent = "Feedback needs text.";
      popup.status.className = "popup-status";
    } else {
      popup.status.textContent = "";
      popup.status.className = "popup-status";
    }
  }

  // ------------------------------------------------------------ render

  function failureText(f) {
    const what = f.op === "send" ? "Send" : "Save";
    const base = `${what} failed: ${f.message}`;
    let draft = "";
    if (["feedback-delete", "comment", "round-comment"].includes(f.request.kind)) {
      // No popup can show the text on a sent comparison, so the alert does.
      draft = snap.readOnly ? ` Your feedback text is kept: “${f.request.feedback}”` : " Your feedback text is kept.";
    }
    if (f.uncertain) return `${base} It may already be saved. Retry sends the same request; the server returns the saved result if it already committed. Other changes stay paused until then.${draft}`;
    const notSaved = f.notSaved ? " The earlier attempt was not saved." : "";
    if (snap.readOnly) return `${base}${notSaved} The comparison is sent, so this change cannot be saved.${draft}`;
    if (f.refreshed) return `${base}${notSaved} The latest saved state is now shown. Check it, then try again.${draft}`;
    return `${base}${notSaved} The saved state is unchanged. Retry sends the same request.${draft}`;
  }

  function renderStatus() {
    const line = $("status");
    const text = $("statusText");
    let label = "";
    let kind = "";
    const custom = statusLabel?.(snap);
    if (custom) [label, kind] = custom;
    else if (snap.status === "loading") [label, kind] = ["Loading…", "saving"];
    else if (snap.status === "load-failed") [label, kind] = ["Not loaded", "failed"];
    else if (snap.status === "saving") [label, kind] = ["Saving…", "saving"];
    else if (snap.status === "sending") [label, kind] = ["Sending…", "saving"];
    else if (snap.readOnly) [label, kind] = ["Sent · read-only", "sent"];
    else if (snap.unresolved) [label, kind] = [snap.failure.op === "send" ? "Send not confirmed" : "Save not confirmed", "failed"];
    else if (snap.failure) [label, kind] = [snap.failure.op === "send" ? "Send failed" : "Save failed", "failed"];
    else [label, kind] = ["Saved", ""];
    text.textContent = label;
    line.className = `save-line ${kind}`.trim();
    doc.body.classList.toggle("is-busy", snap.busy);
    doc.body.classList.toggle("is-read-only", snap.readOnly);
    doc.body.setAttribute("aria-busy", snap.busy || snap.status === "loading" ? "true" : "false");
  }

  function renderAlert() {
    const box = $("alert");
    const text = $("alertText");
    const retry = $("alertRetry");
    const reload = $("alertReload");
    const dismiss = $("alertDismiss");
    const parts = [];
    if (snap.loadError) {
      parts.push(snap.view
        ? `Refresh failed: ${snap.loadError.message} The last saved state stays on screen.`
        : `This comparison could not be loaded: ${snap.loadError.message} Nothing is shown as saved.`);
    }
    // A failed refresh never hides an earlier failed or unconfirmed request.
    if (snap.failure) parts.push(failureText(snap.failure));
    box.hidden = parts.length === 0;
    text.textContent = parts.join(" ");
    const f = snap.failure;
    retry.hidden = !f || (snap.readOnly && !f.uncertain);
    retry.disabled = snap.status !== "ready";
    dismiss.hidden = !f || f.uncertain;
    reload.hidden = false;
    reload.disabled = snap.busy || snap.status === "loading";
  }

  function renderPanes() {
    const view = snap.view;
    for (const pane of PANES) {
      const name = $(`pane-name-${pane}`);
      const frame = frames[pane];
      const p = view?.panes[pane];
      name.textContent = p ? p.label : "";
      frame.iframe.title = p ? `${PANE_NAMES[pane]} pane: ${p.label}` : `${PANE_NAMES[pane]} pane`;
      const url = safeFrameUrl(p?.frameUrl);
      const missing = $(`missing-${pane}`);
      missing.hidden = Boolean(url) || !view;
      if (url && url !== frame.src) {
        frame.src = url;
        frame.ready = false;
        frame.instance = null;
        frame.iframe.src = url;
      }
      // A selected group decides for its descendants, as in the batch.
      const effective = p ? p.components.filter((c) => !controllingGroup(p.components, c.id)) : [];
      const keepers = effective.filter((c) => c.keeper && !c.deleted).length;
      const deleted = effective.filter((c) => c.deleted).length;
      $(`pane-count-${pane}`).textContent = p ? `${keepers} kept · ${deleted} ${snap.session ? "discarded" : "deleted"}` : "";
    }
  }

  /**
   * Trusted component controls per pane. They read only the saved view, never
   * frame DOM, and use the same intents, controller, and popup as the frames.
   * Rows are kept by component ID, so focus survives a busy re-render.
   */
  function renderControls() {
    const view = snap.view;
    for (const pane of PANES) {
      const list = $(`controls-list-${pane}`);
      const note = $(`controls-note-${pane}`);
      const rows = controlRows[pane];
      const components = view ? view.panes[pane].components : [];
      $(`controls-count-${pane}`).textContent = view ? String(components.length) : "";
      if (!view) note.textContent = snap.status === "load-failed" ? "No saved state is loaded, so no controls are shown." : "Controls appear after the saved state loads.";
      else note.textContent = "This pane has no components.";
      note.hidden = Boolean(view) && components.length > 0;
      const wanted = new Set(components.map((c) => c.id));
      for (const [id, entry] of rows) {
        if (!wanted.has(id)) {
          entry.row.remove();
          rows.delete(id);
        }
      }
      let previous = null;
      for (const c of components) {
        let entry = rows.get(c.id);
        if (!entry) {
          entry = { row: el(doc, "li", { className: "control-row" }), mode: null };
          entry.row.dataset.componentId = c.id;
          rows.set(c.id, entry);
        }
        updateControlRow(pane, c, entry);
        // Move a row only when its order is wrong; moving a node drops its focus.
        const expected = previous ? previous.nextSibling : list.firstChild;
        if (expected !== entry.row) list.insertBefore(entry.row, expected);
        previous = entry.row;
      }
    }
  }

  function updateSessionControlRow(pane, c, entry) {
    if (!entry.details) {
      entry.name = el(doc, "span", { className: "control-name" });
      entry.state = el(doc, "span", { className: "selection-state" });
      const heading = el(doc, "div", { className: "control-heading" });
      heading.append(entry.name, entry.state);
      entry.keep = el(doc, "button", { type: "button", className: "control-keep" }, "Keep");
      entry.del = el(doc, "button", { type: "button", className: "control-delete" });
      entry.keep.addEventListener("click", () => {
        if (!closed) controller.toggleKeeper(pane, c.id);
      });
      entry.del.addEventListener("click", () => {
        if (closed) return;
        const current = findComponent(snap.view, pane, c.id);
        if (current?.deleted) controller.undo(current.deletionActionId);
        else controller.plainDelete(pane, c.id);
      });
      const actions = el(doc, "div", { className: "control-actions" });
      actions.append(entry.keep, entry.del);
      entry.details = el(doc, "details", { className: "component-comment" });
      entry.summary = el(doc, "summary", {});
      entry.textarea = el(doc, "textarea", { rows: 3, placeholder: "What should stay or change?" });
      entry.save = el(doc, "button", { type: "button", className: "btn-primary comment-save" }, "Save comment");
      entry.details.append(entry.summary, entry.textarea, entry.save);
      entry.row.append(heading, actions, entry.details);
      entry.textarea.addEventListener("input", () => {
        if (!closed) controller.setDraft(pane, c.id, entry.textarea.value);
      });
      entry.save.addEventListener("click", () => {
        if (!closed) controller.saveComment(pane, c.id, entry.textarea.value);
      });
    }
    const draft = controller.getDraft(pane, c.id);
    if (entry.textarea.value !== draft) entry.textarea.value = draft;
    const override = controllingGroup(snap.view.panes[pane].components, c.id);
    entry.row.dataset.selection = c.deleted ? "discard" : c.keeper ? "keep" : "none";
    entry.name.textContent = c.label;
    entry.state.textContent = override ? `Overridden by ${override.label}` : c.deleted ? "Discarded" : c.keeper ? "Kept" : "Not selected";
    entry.keep.setAttribute("aria-pressed", c.keeper ? "true" : "false");
    entry.keep.setAttribute("aria-label", `Keep: ${c.label}`);
    entry.keep.disabled = !snap.canMutate || c.deleted || Boolean(override);
    entry.del.textContent = c.deleted ? "Undo discard" : "Discard";
    entry.del.setAttribute("aria-pressed", c.deleted ? "true" : "false");
    entry.del.setAttribute("aria-label", `${c.deleted ? "Undo discard" : "Discard"}: ${c.label}`);
    entry.del.disabled = !snap.canMutate || Boolean(override);
    entry.summary.textContent = draft.trim() ? "Comment (unsaved)" : "Comment";
    entry.summary.setAttribute("aria-label", `Comment: ${PANE_NAMES[pane]} ${c.label}`);
    entry.textarea.setAttribute("aria-label", `Comment: ${PANE_NAMES[pane]} ${c.label}`);
    entry.textarea.disabled = !snap.canMutate;
    entry.save.disabled = !snap.canMutate || !draft.trim();
  }

  function updateControlRow(pane, c, entry) {
    if (snap.session) return updateSessionControlRow(pane, c, entry);
    const mode = c.deleted ? "deleted" : snap.readOnly ? "read-only" : "edit";
    if (entry.mode !== mode || entry.label !== c.label) {
      entry.mode = mode;
      entry.label = c.label;
      const name = el(doc, "span", { className: "control-name" }, c.label);
      entry.keep = null;
      entry.del = null;
      if (mode === "deleted") {
        entry.row.replaceChildren(name, el(doc, "span", { className: "badge" }, "Deleted"));
      } else {
        entry.keep = el(doc, "button", { type: "button", className: "control-keep" }, "✓ Keep");
        entry.keep.addEventListener("click", () => handleIntent(pane, "keeper", c.id, null));
        entry.row.replaceChildren(name, entry.keep);
        if (mode === "edit") {
          entry.del = el(doc, "button", { type: "button", className: "control-delete", "aria-label": `Delete: ${c.label}`, "aria-haspopup": "dialog" }, "✕ Delete");
          entry.del.addEventListener("click", () => handleIntent(pane, "delete", c.id, () => controlRows[pane].get(c.id)?.del || $(`controls-${pane}`).querySelector("summary")));
          entry.row.append(entry.del);
        }
      }
    }
    if (entry.keep) {
      entry.keep.setAttribute("aria-pressed", c.keeper ? "true" : "false");
      entry.keep.setAttribute("aria-label", `${c.keeper ? "Keeper" : "Keep"}: ${c.label}`);
      entry.keep.disabled = !snap.canMutate;
    }
    if (entry.del) entry.del.disabled = !snap.canMutate;
  }

  function renderHistory() {
    const list = $("history");
    const empty = $("historyEmpty");
    const rows = snap.view ? snap.view.history : [];
    const comments = snap.view?.comments ?? [];
    $("historyCount").textContent = String(rows.length + comments.length);
    list.textContent = "";
    empty.hidden = rows.length + comments.length > 0;
    for (const comment of comments) {
      const item = el(doc, "li", { className: "history-row comment-row" });
      const target = comment.scope === "round" ? "Overall comment" : `${PANE_NAMES[comment.identity.pane]}: ${comment.label}`;
      item.append(el(doc, "strong", {}, target), el(doc, "p", { className: "history-feedback" }, comment.comment));
      list.append(item);
    }
    for (const row of rows) {
      const item = el(doc, "li", { className: `history-row${row.undone ? " undone" : ""}`, "data-action-id": row.id });
      const head = el(doc, "div", { className: "history-head" });
      head.append(
        el(doc, "span", { className: "chip" }, PANE_NAMES[row.pane]),
        el(doc, "span", { className: "history-label" }, typeof row.label === "string" && row.label ? row.label : row.componentId),
        el(doc, "span", { className: "history-kind" }, KIND_LABEL[row.kind]),
      );
      if (row.undone) head.append(el(doc, "span", { className: "badge" }, "Undone"));
      item.append(head);
      if (row.kind === "feedback-delete" && typeof row.feedback === "string") {
        item.append(el(doc, "p", { className: "history-feedback" }, row.feedback));
      }
      if (!snap.readOnly && canUndoRow(snap.view, row)) {
        const label = typeof row.label === "string" && row.label ? row.label : row.componentId;
        const undo = el(doc, "button", { type: "button", className: "row-undo", "aria-label": `Undo deletion of ${label} in ${PANE_NAMES[row.pane]} pane` }, "Undo");
        undo.disabled = !snap.canMutate;
        undo.addEventListener("click", () => controller.undo(row.id));
        item.append(undo);
      }
      list.append(item);
    }
  }

  function renderSummary() {
    const view = snap.view;
    const send = $("send");
    const summary = $("summary");
    if (!send) return;
    if (!view) {
      summary.textContent = "";
      send.disabled = true;
      send.textContent = "Send";
      return;
    }
    let keepers = 0;
    let deletions = 0;
    for (const pane of PANES) {
      for (const c of view.panes[pane].components) {
        if (c.deleted) deletions += 1;
        else if (c.keeper) keepers += 1;
      }
    }
    summary.textContent = keepers + deletions === 0
      ? "No current changes. Sending an empty result is allowed."
      : `${keepers} keeper${keepers === 1 ? "" : "s"} · ${deletions} deletion${deletions === 1 ? "" : "s"}`;
    if (snap.readOnly) {
      send.disabled = true;
      send.textContent = "Sent";
    } else {
      send.disabled = !snap.canMutate;
      send.textContent = snap.status === "sending" ? "Sending…" : "Send to agent";
    }
    $("sentNote").hidden = !snap.readOnly;
  }

  function render(next) {
    snap = next;
    if (snap.view) {
      $("title").textContent = snap.view.label;
      doc.title = `${snap.view.label} · Double`;
    }
    renderStatus();
    renderAlert();
    renderPanes();
    renderControls();
    renderHistory();
    renderSummary();
    updatePopup();
    for (const pane of PANES) postState(pane);
  }

  // Opaque frames do not consistently emit leave events when the pointer
  // jumps into shell chrome. Shell pointer events clear both frame hovers.
  // The iframe element itself can get a mouseover when the pointer enters it;
  // that frame keeps its own hover. Chromium sends no mouseover when the
  // pointer returns to the shell element it left, so mousemove also clears.
  function clearFrameHover(event) {
    for (const frame of Object.values(frames)) if (event?.target !== frame.iframe) frame.clearHover();
  }

  function onKeydown(event) {
    if (event.key === "Escape" && popup) {
      event.preventDefault();
      closePopup(true);
    }
  }

  // Named handlers, so close() removes exactly what this mount added.
  const buttons = [
    ["send", () => controller.send()],
    ["alertRetry", () => controller.retry()],
    ["alertDismiss", () => controller.dismissFailure()],
    ["alertReload", () => controller.load()],
  ];
  for (const [id, handler] of buttons) $(id)?.addEventListener("click", handler);
  win.addEventListener("message", onMessage);
  doc.addEventListener("keydown", onKeydown);
  doc.addEventListener("mouseover", clearFrameHover);
  doc.addEventListener("mousemove", clearFrameHover);
  win.addEventListener("blur", clearFrameHover);
  const unsubscribe = controller.subscribe(render);

  return {
    controller,
    frames,
    get popup() {
      return popup;
    },
    close() {
      closed = true;
      closePopup(false);
      unsubscribe();
      for (const [id, handler] of buttons) $(id)?.removeEventListener("click", handler);
      win.removeEventListener("message", onMessage);
      for (const frame of Object.values(frames)) frame.iframe.removeEventListener("mouseleave", frame.clearHover);
      doc.removeEventListener("keydown", onKeydown);
      doc.removeEventListener("mouseover", clearFrameHover);
      doc.removeEventListener("mousemove", clearFrameHover);
      win.removeEventListener("blur", clearFrameHover);
    },
  };
}

// ---------------------------------------------------------------- bootstrap

/** Boot from the server-filled data attributes on <body>. */
export function bootDouble(win, { fetch: fetchImpl = win.fetch?.bind(win) } = {}) {
  const body = win.document.body;
  const comparisonId = body.dataset.comparison;
  const token = body.dataset.token;
  const configured = validId(comparisonId) && comparisonId !== "__DOUBLE_COMPARISON_ID__" && typeof token === "string" && token !== "" && token !== "__TOKEN__";
  const transport = configured
    ? createFetchTransport({ comparisonId, token, fetch: fetchImpl })
    : { load: () => Promise.reject(new DoubleRequestError({ code: "NOT_CONFIGURED", message: "The page has no comparison or token." })) };
  const controller = createDoubleController({ comparisonId: configured ? comparisonId : "", transport });
  const shell = mountDoubleShell({ window: win, controller, comparisonId: configured ? comparisonId : "" });
  controller.load();
  return shell;
}

if (typeof window !== "undefined" && window.document?.body?.dataset.doubleShell !== undefined) {
  bootDouble(window);
}
