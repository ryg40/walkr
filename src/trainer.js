import { completeRanking, toggleRank } from "./trainer-rank.js";

// These codes prove that the server did not save the request. Anything else stays unresolved.
const NOT_SAVED = new Set(["INVALID_REQUEST", "INVALID_ID", "INCOMPLETE_RANKING", "ACTION_CONFLICT", "INVALID_TRANSITION",
  "STALE_REVISION", "NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "WRITE_FAILED", "DISCONNECTED"]);

export function bootTrainer(win, { fetch: fetchImpl = win.fetch.bind(win), refreshMs = 2000 } = {}) {
  const doc = win.document, $ = (id) => doc.getElementById(id), body = doc.body.dataset;
  const api = `/_walkr/trainer/api/sessions/${encodeURIComponent(body.repo)}/${encodeURIComponent(body.session)}`;
  const pendingKey = `walkr-trainer:${body.repo}/${body.session}:pending`;
  let view = null, ranks = {}, rankGroup = null, selected = null, busy = false, error = "", closed = false, timer;
  let pending = null;
  try { pending = JSON.parse(win.localStorage.getItem(pendingKey) ?? "null"); } catch {}

  const newId = () => win.crypto?.randomUUID ? win.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const items = () => new Map((view?.items ?? []).map((item) => [item.sourceId, item]));
  const currentPlan = () => view?.plans.at(-1);
  const currentGroup = () => view?.groups.find((group) => group.groupId === selected) ?? view?.groups.find((group) => !group.vote) ?? null;

  async function call(route, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${api}${route}`, { ...options, headers: { "x-human-review-token": body.token, "content-type": "application/json" } });
    } catch { throw Object.assign(new Error("The private server did not answer."), { code: "NETWORK" }); }
    let value;
    try { value = await response.json(); } catch { throw Object.assign(new Error("The server answer was not readable."), { code: "MALFORMED" }); }
    if (!response.ok) throw Object.assign(new Error(value?.error?.message || `HTTP ${response.status}`), { code: value?.error?.code || `HTTP_${response.status}` });
    return value;
  }

  function setPending(value) {
    pending = value;
    try { value ? win.localStorage.setItem(pendingKey, JSON.stringify(value)) : win.localStorage.removeItem(pendingKey); } catch {}
  }

  async function submit(item) {
    setPending(item);
    busy = true; error = ""; render();
    try {
      const answer = await call(`/${item.op}`, { method: "POST", body: JSON.stringify(item.body) });
      setPending(null);
      view = answer.view;
      if (item.op === "save") {
        ranks = {}; rankGroup = null; selected = null; $("comment").value = "";
        if (answer.result.outcome === "already-saved") error = `Group ${answer.result.groupId} was already saved. The first saved ranking is kept.`;
      }
    } catch (failure) {
      if (NOT_SAVED.has(failure.code)) setPending(null);
      error = NOT_SAVED.has(failure.code) ? failure.message : `Not confirmed: ${failure.message} Retry the same request; do not start a new one.`;
    } finally { busy = false; render(); }
  }

  async function load() {
    if (busy || closed) return;
    try { view = (await call("")).view; if (!pending) error = ""; }
    catch (failure) { error = `Could not read saved state: ${failure.message}`; }
    render();
  }

  function candidateCard(group, candidateId, known) {
    const candidate = group.candidates.find((item) => item.candidateId === candidateId);
    const item = known.get(candidate.sourceId);
    const rank = group.vote ? group.vote.ranks[candidateId] : ranks[candidateId];
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "candidate";
    button.dataset.candidate = candidateId;
    button.dataset.rank = rank ? String(rank) : "";
    button.setAttribute("aria-pressed", String(Boolean(rank)));
    button.disabled = Boolean(group.vote) || busy || Boolean(pending);
    const badge = doc.createElement("span");
    badge.className = "rank-badge";
    badge.textContent = rank ? String(rank) : "–";
    badge.setAttribute("aria-label", rank ? `Rank ${rank}` : "Unranked");
    const heading = doc.createElement("span");
    heading.className = "candidate-head";
    heading.textContent = item.title ? `${item.title} (${item.sourceId})` : item.sourceId;
    // Dataset content is untrusted: text and Markdown both render as plain text, never as HTML.
    const content = doc.createElement("pre");
    content.className = `candidate-content format-${item.format}`;
    content.textContent = item.content;
    button.append(badge, heading, content);
    button.addEventListener("click", () => {
      if (rankGroup !== group.groupId) { ranks = {}; rankGroup = group.groupId; }
      ranks = toggleRank(ranks, candidateId);
      render();
    });
    return button;
  }

  function render() {
    if (closed) return;
    const status = view?.status;
    const plan = currentPlan();
    const known = items();
    const p = view?.progress;
    $("sessionLabel").textContent = view ? `${view.repo.name} · ${view.sessionId}` : "";
    $("task").textContent = view ? `Task: ${view.task}` : "";
    $("progressBar").max = Math.max(1, p?.groups ?? 1);
    $("progressBar").value = p?.saved ?? 0;
    $("progressText").textContent = !view ? "Loading…" :
      `${p.saved} of ${p.groups} groups saved · ${p.leftovers} unranked leftover${p.leftovers === 1 ? "" : "s"} · ${p.analysisComplete} analyses complete`;
    $("alert").hidden = !error && !pending;
    $("alertText").textContent = error || (pending ? "A request is not confirmed. Retry the same request." : "");
    $("resolve").hidden = !pending;
    $("resolve").disabled = busy;

    const reviewing = status === "plan-review" || status === "changes-requested";
    $("plan").hidden = !reviewing;
    if (reviewing && plan) {
      $("planTitle").textContent = `Review the grouping plan (revision ${plan.revision})`;
      $("planExplanation").textContent = plan.explanation;
      $("planGroups").replaceChildren(...plan.groups.map((group) => {
        const li = doc.createElement("li");
        const names = group.sourceIds.map((id) => known.get(id)?.title ? `${known.get(id).title} (${id})` : id).join(" · ");
        li.textContent = `${group.groupId}: ${names}${group.explanation ? ` — ${group.explanation}` : ""}`;
        return li;
      }));
      $("planLeftovers").textContent = plan.leftovers.length ? `Unranked leftovers: ${plan.leftovers.join(", ")}` : "No leftovers.";
      const waiting = status === "changes-requested";
      $("planWaiting").hidden = !waiting;
      $("planWaiting").textContent = waiting ? `Changes requested: ${plan.review.note}. Waiting for a revised plan from the agent.` : "";
      $("planActions").hidden = waiting;
      for (const id of ["approve", "requestChanges"]) $(id).disabled = busy || Boolean(pending);
      // A change request wakes the bound Pi chat of a GUI-started session; approving needs no chat.
      if (view.guiConnection === false) {
        $("requestChanges").disabled = true;
        $("planWaiting").hidden = false;
        $("planWaiting").textContent += `${waiting ? " " : ""}The bound chat is disconnected. Reconnect it in the shared GUI so that Pi receives change requests.`;
      }
    }

    const group = status === "ranking" || status === "complete" ? currentGroup() : null;
    $("rank").hidden = !group;
    $("done").hidden = !(status === "complete" && !selected);
    $("ended").hidden = status !== "ended";
    if (group) {
      if (rankGroup !== group.groupId) { ranks = {}; rankGroup = group.groupId; }
      const index = view.groups.indexOf(group) + 1;
      $("groupTitle").textContent = `Group ${index} of ${view.groups.length}: ${group.groupId}`;
      $("groupExplanation").textContent = group.explanation ?? "";
      $("candidates").replaceChildren(...group.displayOrder.map((candidateId) => candidateCard(group, candidateId, known)));
      $("comment").disabled = Boolean(group.vote);
      if (group.vote) $("comment").value = group.vote.comment ?? "";
      const ready = completeRanking(ranks, group.candidates.map((item) => item.candidateId));
      $("save").hidden = Boolean(group.vote);
      $("save").disabled = busy || Boolean(pending) || !ready;
      $("groupState").textContent = group.vote ? `Saved. Analysis: ${group.analysis.status}.` :
        ready ? "All three ranked. Correct any rank, then Save and Next." : `${Object.keys(ranks).length} of 3 ranked.`;
    }
    $("groupList").replaceChildren(...(view?.groups ?? []).map((item) => {
      const li = doc.createElement("li"), button = doc.createElement("button");
      button.type = "button";
      button.textContent = `${item.groupId}: ${item.vote ? "saved" : "not ranked"} · analysis ${item.analysis.status}`;
      if (item === group) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => { selected = item.groupId; render(); });
      li.append(button);
      return li;
    }));
    const leftovers = view?.leftovers.length ? view.leftovers.map((item) => item.sourceId) : plan?.leftovers ?? [];
    $("leftovers").replaceChildren(...leftovers.map((sourceId) => {
      const li = doc.createElement("li");
      li.textContent = `${sourceId} (unranked)`;
      return li;
    }));
  }

  const handlers = [
    ["approve", () => submit({ op: "review", body: { actionId: newId(), revision: currentPlan().revision, decision: "approve" } })],
    ["requestChanges", () => {
      const note = $("planNote").value.trim();
      if (!note) { error = "Write a change request first."; render(); return; }
      void submit({ op: "review", body: { actionId: newId(), revision: currentPlan().revision, decision: "request-changes", note } });
    }],
    ["save", () => {
      const group = currentGroup();
      const comment = $("comment").value.trim();
      void submit({ op: "save", body: { actionId: newId(), groupId: group.groupId, ranks: { ...ranks }, ...(comment ? { comment } : {}) } });
    }],
    ["resolve", () => { if (pending) void submit(pending); }],
    ["reload", () => { if (!pending) error = ""; void load(); }],
  ];
  for (const [id, fn] of handlers) $(id).addEventListener("click", fn);
  const tick = async () => { await load(); if (!closed) timer = win.setTimeout(tick, refreshMs); };
  const ready = tick();
  return { ready, load, close() {
    closed = true; win.clearTimeout(timer);
    for (const [id, fn] of handlers) $(id).removeEventListener("click", fn);
  } };
}

if (typeof window !== "undefined" && window.document?.body?.dataset.trainer !== undefined) bootTrainer(window);
