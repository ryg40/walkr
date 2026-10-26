import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForObserved(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}

export async function acknowledgedGenerationView(api, root, event, comparisonId) {
  assert.equal(event.kind, "generation");
  await waitForObserved(async () => {
    const answer = await api(root + "/events");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.events.find((entry) => entry.id === event.id), event);
    return answer.json.acknowledgments.some((entry) => entry.eventId === event.id) &&
      !answer.json.pending.includes(event.id);
  }, `Generation acknowledgment not observed: ${event.id}`);
  // This read starts after the exact acknowledgment, not after dispatch or attach.
  const answer = await api(root);
  assert.equal(answer.status, 200);
  const view = answer.json.view;
  assert.equal(view.sessionId, event.sessionId);
  assert.equal(view.currentComparisonId, comparisonId);
  assert.equal(view.generation.requestId, event.payload.requestId);
  assert.equal(view.generation.attempt.id, event.payload.attemptId);
  return view;
}

export function guiShowsAcknowledgedView(shell, authoritative) {
  const state = shell.pair?.controller.getState();
  const matches = (view) => view?.sessionId === authoritative.sessionId &&
    view.currentComparisonId === authoritative.currentComparisonId && view.revision === authoritative.revision;
  return shell.state?.currentSessionId === authoritative.sessionId && shell.pair?.sessionId === authoritative.sessionId &&
    matches(shell.state.view) && matches(state?.view) && state.status === "ready" &&
    state.canEnd && !state.pending && !state.unresolved;
}

export async function waitForGuiAcknowledgedView(shell, authoritative) {
  await waitForObserved(() => guiShowsAcknowledgedView(shell, authoritative),
    `GUI did not show acknowledged revision ${authoritative.revision} for ${authoritative.sessionId}`);
  return shell.pair.controller.getState().view;
}
