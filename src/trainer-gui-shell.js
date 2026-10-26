import { createDoubleRequest } from "./double.js";
import { encodeDoubleComparisonId } from "./double-route.js";

// The server checks these after the exact receipt lookup, so they prove this action was not saved.
const NOT_SAVED = new Set(["INVALID_REQUEST", "INVALID_ID", "ACTION_CONFLICT", "READ_ONLY", "FORBIDDEN", "NOT_FOUND", "METHOD_NOT_ALLOWED",
  "STALE_ATTEMPT", "INVALID_TRANSITION", "DISCONNECTED"]);
export const trainerGuiRoute = (sessionId) => `/api/double/modes/trainer/sessions/${encodeDoubleComparisonId(sessionId)}`;

/**
 * Trainer panel inside the shared GUI. Pi prepares the dataset; the private Trainer page then renders here in a
 * same-origin frame with its own page credential. This module shows status and dispatches End, Retry and Send pending requests.
 * Reload never resubmits.
 */
export function mountTrainerGui({ window: win, token, fetch: fetchImpl, base = "", storage, key, canGenerate = () => true, onChange }) {
  const doc = win.document, $ = (id) => doc.getElementById(id);
  const request = createDoubleRequest({ token, fetch: fetchImpl });
  const pendingKey = `${key}:trainer-pending`;
  let view = null, busy = false, error = "", closed = false;
  let pending = JSON.parse(storage.getItem(pendingKey) ?? "null");
  const actionId = () => win.crypto.randomUUID();

  function status() {
    if (!view) return "";
    if (pending) return "Request not confirmed. Resolve the identical saved request; do not send a new one.";
    const reconnect = "Reconnect the same chat to Retry. End stays available.";
    if (view.status === "preparing") {
      if (view.recoveryRequired) return `The chat connection was interrupted while Pi prepared the dataset. Retry asks Pi again with the saved brief, or End.${view.guiConnection ? "" : ` ${reconnect}`}`;
      return view.guiConnection ? "Pi is preparing the dataset and the grouping plan. The Trainer page appears here when Pi submits them. End stays available."
        : "Disconnected. Reconnect the same chat; Pi cannot submit the dataset while disconnected. End stays available.";
    }
    if (view.status === "failed") return `Pi could not prepare the dataset: ${view.request.failure} Retry asks Pi again with the saved brief, or End.${view.guiConnection ? "" : ` ${reconnect}`}`;
    if (view.status === "ended") return "Ended. Every saved vote stays in the dataset record. No new plan review or vote is accepted.";
    const dataset = view.dataset;
    if (dataset?.error) return `The linked dataset cannot be read (${dataset.error.code}). Saved votes stay in its record. End stays available.`;
    const chat = !view.guiConnection ? " The chat is disconnected: votes still save. After you reconnect the same chat, Send pending requests sends change and analysis requests to Pi."
      : view.heldRequests ? " Requests saved before this connection wait: select Send pending requests to send them to Pi once." : "";
    if (dataset.status === "plan-review") return `Review the grouping plan below.${chat}`;
    if (dataset.status === "changes-requested") return `Changes requested. Waiting for a revised plan from Pi.${chat}`;
    if (dataset.status === "ranking") return `Rank each group below. Each Save and Next is final and stays saved even if analysis fails.${chat}`;
    return `All groups are saved. Another review can start now; analysis continues separately and never changes a vote. End closes this session.${chat}`;
  }
  function render() {
    if (closed) return;
    $("trainerGui").hidden = !view;
    if (!view) { $("trainerGuiFrame").removeAttribute("src"); return; }
    $("trainerGuiStatus").textContent = error || status();
    const dataset = view.dataset;
    $("trainerGuiDataset").textContent = dataset && !dataset.error
      ? `Dataset ${dataset.repo} · ${dataset.sessionId}: ${dataset.progress.saved} of ${dataset.progress.groups} groups saved, ${dataset.progress.leftovers} unranked leftovers, ${dataset.progress.analysisComplete} analyses complete.`
      : "";
    $("trainerGuiEnd").hidden = view.status === "ended";
    $("trainerGuiEnd").disabled = busy || Boolean(pending);
    $("trainerGuiRetry").hidden = !(view.status === "failed" || view.status === "preparing" && view.recoveryRequired);
    $("trainerGuiRetry").disabled = busy || Boolean(pending) || !view.guiConnection || !canGenerate();
    $("trainerGuiSendPending").hidden = !(view.status === "linked" && view.guiConnection && view.heldRequests);
    $("trainerGuiSendPending").disabled = busy || Boolean(pending) || !canGenerate();
    $("trainerGuiResolve").hidden = !pending;
    $("trainerGuiResolve").disabled = busy;
    const frame = $("trainerGuiFrame"), url = view.pagePath ? base + view.pagePath : "";
    frame.hidden = !url;
    if (frame.getAttribute("src") !== url) { if (url) frame.setAttribute("src", url); else frame.removeAttribute("src"); }
  }
  async function send(item) {
    if (busy || closed) return;
    pending = item;
    storage.setItem(pendingKey, JSON.stringify(item));
    busy = true; error = ""; render();
    try {
      const answer = await request(base + item.route, "POST", item.body);
      if (answer.result?.actionId !== item.body.actionId || answer.result.kind !== item.kind || answer.view?.sessionId !== item.sessionId) {
        throw new Error("The exact action receipt is missing.");
      }
      pending = null; storage.removeItem(pendingKey);
      view = answer.view;
    } catch (e) {
      error = e.message;
      if (NOT_SAVED.has(e.code)) { pending = null; storage.removeItem(pendingKey); }
    } finally { busy = false; render(); onChange?.(); }
  }
  const handlers = [
    ["trainerGuiEnd", () => {
      if (!view || busy || pending || view.status === "ended") return;
      void send({ sessionId: view.sessionId, kind: "end", route: `${trainerGuiRoute(view.sessionId)}/end`, body: { actionId: actionId() } });
    }],
    ["trainerGuiRetry", () => {
      if (!view || busy || pending || !canGenerate()) return;
      void send({ sessionId: view.sessionId, kind: "retry", route: `${trainerGuiRoute(view.sessionId)}/retry`,
        body: { actionId: actionId(), requestId: view.request.id, attemptId: view.request.attemptId } });
    }],
    ["trainerGuiSendPending", () => {
      if (!view || busy || pending || !canGenerate()) return;
      void send({ sessionId: view.sessionId, kind: "send-pending", route: `${trainerGuiRoute(view.sessionId)}/send-pending`, body: { actionId: actionId() } });
    }],
    ["trainerGuiResolve", () => { if (pending) void send(pending); }],
  ];
  for (const [id, fn] of handlers) $(id).addEventListener("click", fn);
  return {
    get pending() { return pending; },
    get view() { return view; },
    update(next) { if (!busy) view = next; render(); },
    close() {
      if (closed) return;
      closed = true;
      for (const [id, fn] of handlers) $(id).removeEventListener("click", fn);
    },
  };
}
