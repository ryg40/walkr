import { createDoubleRequest } from "./double.js";
import { encodeDoubleComparisonId } from "./double-route.js";

const SIDES = ["left", "right"];
// The server checks these after the exact receipt lookup, so they prove this action was not saved.
const NOT_SAVED = new Set(["INVALID_REQUEST", "INVALID_ID", "ACTION_CONFLICT", "DISCONNECTED", "STALE_COMPARISON",
  "STALE_ATTEMPT", "READ_ONLY", "INVALID_TRANSITION", "FORBIDDEN", "NOT_FOUND", "METHOD_NOT_ALLOWED"]);
export const coinflipRoute = (sessionId) => `/api/double/modes/coinflip/sessions/${encodeDoubleComparisonId(sessionId)}`;

/**
 * Coinflip panel inside the shared GUI. The shared shell supplies each saved view; this
 * module only renders it and dispatches complete, persisted actions. Reload never resubmits.
 */
export function mountCoinflip({ window: win, token, fetch: fetchImpl, base = "", storage, key, canGenerate, onChange }) {
  const doc = win.document, $ = (id) => doc.getElementById(id);
  const request = createDoubleRequest({ token, fetch: fetchImpl });
  const pendingKey = `${key}:coinflip-pending`;
  let view = null, busy = false, error = "", closed = false;
  let pending = JSON.parse(storage.getItem(pendingKey) ?? "null");
  const noteKey = () => `${key}:coinflip-note:${view?.sessionId}`;
  const actionId = () => win.crypto.randomUUID();

  function badge(side) {
    const c = view?.pair?.[side];
    if (!c) return "";
    if (view.result?.candidateId === c.candidateId) return "Final winner";
    return view.winner?.candidateId === c.candidateId ? "Winner" : "";
  }
  function status() {
    if (!view) return "";
    if (pending) return "Request not confirmed. Resolve the identical saved request; do not send a new one.";
    if (view.status === "generating") {
      if (view.recoveryRequired) return "Interrupted generation needs explicit recovery: mark it failed, then Retry or Stop.";
      if (view.generation.kind === "steer" && !view.winner) return "Generating a replacement pair for your instruction. No winner or rejection is recorded. The prior pair stays visible; Stop remains available.";
      return view.generation.kind === "initial" ? "Generating the initial pair. Stop remains available."
        : `Generating one challenger for the ${view.winner.side === "left" ? "right" : "left"} side. The winner stays unchanged; choices are disabled. Stop remains available.`;
    }
    if (view.status === "failed") return `Generation failed: ${view.generation.attempt.failure} The last valid pair and winner stay. Retry or Stop.`;
    if (view.status === "choosing") return view.guiConnection ? "Choose the winner. Your optional note is saved with the choice. Send instruction steers this pair without a choice." : "Disconnected. Choices and Send instruction are disabled until you explicitly reconnect the same chat. Drafts and saved work stay.";
    if (!view.result) return "Stopped without a result. The brief and history remain saved. Submit is unavailable.";
    if (!view.submitted) return "Stopped. The winner is frozen. Submit returns it to the chat; there is no Resume.";
    return `Submitted. Chat delivery: ${view.delivery}. Repeated Submit returns the same saved result.`;
  }
  function render() {
    if (closed) return;
    $("coinflip").hidden = !view;
    if (!view) return;
    const choosing = view.status === "choosing" && canGenerate() && view.guiConnection && !busy && !pending;
    for (const side of SIDES) {
      const c = view.pair?.[side];
      const frame = $(`coinflipFrame-${side}`);
      const url = c ? base + c.frameUrl : "";
      if (frame.getAttribute("src") !== url) { if (url) frame.setAttribute("src", url); else frame.removeAttribute("src"); }
      $(`coinflipDescription-${side}`).textContent = c ? c.description : "No candidate yet.";
      const text = badge(side);
      $(`coinflipBadge-${side}`).textContent = text;
      $(`coinflipBadge-${side}`).hidden = !text;
      $(`coinflipChoose-${side}`).hidden = !c;
      $(`coinflipChoose-${side}`).disabled = !choosing;
    }
    $("coinflipStatus").textContent = error || status();
    $("coinflipNote").disabled = view.status === "stopped";
    $("coinflipStop").hidden = view.status === "stopped";
    $("coinflipStop").disabled = busy || Boolean(pending);
    $("coinflipSubmit").hidden = !(view.status === "stopped" && view.result);
    $("coinflipSubmit").disabled = busy || Boolean(pending);
    $("coinflipRetry").hidden = view.status !== "failed";
    $("coinflipRetry").disabled = busy || Boolean(pending) || !canGenerate() || !view.guiConnection;
    $("coinflipRecover").hidden = view.status !== "generating";
    $("coinflipRecover").disabled = busy || Boolean(pending);
    $("coinflipResolve").hidden = !pending;
    $("coinflipResolve").disabled = busy;
    // Choices and prompt-box instructions in the order of the pairs they answered.
    const entries = [...view.choices.map((c) => [c.pairIndex, 0, `Pair ${c.pairIndex + 1}: ${c.winnerSide} won${c.note ? ` — ${c.note}` : ""}`]),
      ...(view.steers ?? []).map((x) => [x.pairIndex, 1, `Pair ${x.pairIndex + 1}: ${x.winner ? "challenger replaced" : "pair replaced, no winner"} by instruction — ${x.text}`])];
    $("coinflipChoices").replaceChildren(...entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , text]) => {
      const li = doc.createElement("li");
      li.textContent = text;
      return li;
    }));
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
      if (item.kind === "choose") { $("coinflipNote").value = ""; storage.removeItem(`${key}:coinflip-note:${item.sessionId}`); }
      // A late answer never replaces another session on screen or a newer saved revision.
      if (view?.sessionId === item.sessionId && answer.view.revision >= view.revision) view = answer.view;
      return { ok: true, result: answer.result };
    } catch (e) {
      error = e.message;
      if (NOT_SAVED.has(e.code)) { pending = null; storage.removeItem(pendingKey); }
      return { ok: false, error: e };
    } finally { busy = false; render(); onChange?.(); }
  }
  function act(op, extra = {}) {
    if (!view || busy || pending) return Promise.resolve({ ok: false, refused: "busy" });
    return send({ sessionId: view.sessionId, kind: op === "recover" ? "fail" : op, route: `${coinflipRoute(view.sessionId)}/${op}`,
      body: { actionId: actionId(), ...extra } });
  }
  const generation = () => ({ requestId: view.generation.requestId, attemptId: view.generation.attempt.id });
  // Send from the shared prompt box: the same gates as a choice. No queue while a request runs.
  const canSteer = () => Boolean(view?.status === "choosing" && view.pair && canGenerate() && view.guiConnection && !busy && !pending);
  const handlers = [
    ...SIDES.map((side) => [`coinflipChoose-${side}`, () => {
      if (view?.status !== "choosing" || !canGenerate() || !view.guiConnection) return;
      const note = $("coinflipNote").value;
      act("choose", { pairIndex: view.pair.index, winner: view.pair[side].candidateId, note: note.trim() ? note : null });
    }]),
    ["coinflipStop", () => act("stop")],
    ["coinflipSubmit", () => act("submit")],
    ["coinflipRetry", () => { if (view?.status === "failed" && canGenerate()) act("retry", generation()); }],
    ["coinflipRecover", () => { if (view?.status === "generating") act("recover", generation()); }],
    ["coinflipResolve", () => { if (pending) void send(pending); }],
    ["coinflipNote", () => { if (view) storage.setItem(noteKey(), $("coinflipNote").value); }],
  ];
  for (const [id, fn] of handlers) $(id).addEventListener(id === "coinflipNote" ? "input" : "click", fn);
  return {
    get pending() { return pending; },
    get view() { return view; },
    canSteer,
    steer(instruction) {
      if (!canSteer() || typeof instruction !== "string" || !instruction.trim()) return Promise.resolve({ ok: false, refused: "busy" });
      return act("steer", { pairIndex: view.pair.index, instruction });
    },
    update(next) {
      const changed = next?.sessionId !== view?.sessionId;
      if (!busy) view = next;
      if (changed && view) $("coinflipNote").value = storage.getItem(noteKey()) ?? "";
      render();
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [id, fn] of handlers) $(id).removeEventListener(id === "coinflipNote" ? "input" : "click", fn);
    },
  };
}
