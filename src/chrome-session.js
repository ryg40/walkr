export function pageUrl(key, sessionId) {
  return `/api/page/${key}?session=${encodeURIComponent(sessionId)}`;
}

export function replacePage(state, page) {
  state.page = page;
  state.others = page.others || [];
}

/**
 * A Markdown code span that survives backticks in a path: the fence is one
 * backtick longer than the longest run inside, padded when the text touches it.
 */
export function codeSpan(text) {
  const value = String(text);
  const longest = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * The handoff box for an agent state, or null. A batch that is stranded found
 * no poll. A delivered or queued batch has no poll attached either (a poll
 * returns a waiting batch at once), and the server cannot tell whether the
 * agent still works on it, so the box offers the message without saying that
 * the agent stopped. With `wake`, a connected Pi chat watches the review and
 * starts a turn to collect a stranded batch; the box stays as the fallback.
 */
export function handoffText(agentState, wake = false) {
  const body = "If the agent stopped before it finished, paste this into the Pi chat that started the review:";
  if (agentState === "stranded" && wake) {
    return { title: "Sent and saved. The connected Pi chat wakes to collect it.", body: "If no turn starts there, paste this into that Pi chat:" };
  }
  if (agentState === "stranded") {
    return { title: "Sent and saved. No agent is collecting it.", body: "Paste this into the Pi chat that started the review:" };
  }
  if (agentState === "working") return { title: "Delivered and saved until the agent acknowledges it.", body };
  if (agentState === "queued") return { title: "Saved. It goes with the agent's next poll.", body };
  return null;
}

/** The line under Send while no handoff is needed, or null. */
export function agentLineText(agentState, wake = false) {
  if (agentState === "queued") return "Agent is still on your last batch — this one ships with its next poll";
  if (agentState === "working") return "Feedback delivered — page reloads when fixes land";
  if (wake && (agentState === "idle" || agentState === "listening")) return "Agent connected; it wakes on Send";
  return null;
}

/**
 * The message the owner pastes when no agent is collecting a Send. It names the
 * skill, the exact bounded poll, the acknowledgment of the batch id that the
 * poll returns, and the status check before the turn ends.
 */
export function handoffPrompt(pollCommand, statusCommand, batchId = null) {
  const poll = String(pollCommand || "").trim();
  const status = String(statusCommand || "").trim();
  if (!poll || !status) return "";
  return (
    `Use the walkr-core skill to collect the Walkr feedback that I sent. Run ${codeSpan(`${poll} --timeout 30`)}. ` +
    (batchId ? `It returns batch ${codeSpan(batchId)} or a newer one. ` : "") +
    "Apply every page. If you already applied a batch with the same `batch_id`, verify the source and do not apply it twice. " +
    `Then run ${codeSpan(`${poll} --ack <batch_id> --timeout 2`)} with the \`batch_id\` of that poll output. ` +
    `Before you end the turn, run ${codeSpan(status)}.`
  );
}
