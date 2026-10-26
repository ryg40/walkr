import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { codeSpan, handoffPrompt, handoffText } from "../src/chrome-session.js";
import { commandArg, reviewInvocation, shellQuote } from "../src/setup.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request(server, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: route,
        headers: { "x-human-review-token": server.token || "", ...(body ? { "content-type": "application/json" } : {}) },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function cli(stateDir, args) {
  // Always the checkout CLI: the page's pollCommand can name an installed wrapper of the live service.
  const child = spawn(process.execPath, ["src/cli.js", ...args], {
    cwd: project,
    env: { ...process.env, HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_NO_BROWSER: "1", HUMAN_REVIEW_HOSTED: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function disposableServer(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walkr-core-handoff-"));
  const stateDir = path.join(tmp, "state");
  const child = spawn(process.execPath, ["src/server-entry.js"], {
    cwd: project,
    env: { ...process.env, HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_HOSTED: "" },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "server.json"), "utf8"));
      const health = await request(saved, "GET", "/health");
      if (health.status === 200) return { tmp, stateDir, server: saved, child };
    } catch {
      // The child has not announced its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("review server did not start");
}

/** The agent state that the page's event stream reports first. */
function agentState(server, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: `/events/${sessionId}`, headers: { "x-human-review-token": server.token } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        const found = raw.match(/event: agent\ndata: (.*)\n\n/);
        if (!found) return;
        req.destroy();
        resolve(JSON.parse(found[1]).state);
      });
    });
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
  });
}

/** Every code span of a Markdown line, read the CommonMark way: a fence closes only on a run of its own length. */
function codeSpans(text) {
  const spans = [];
  let at = 0;
  while ((at = text.indexOf("`", at)) !== -1) {
    const fence = text.slice(at).match(/^`+/)[0];
    let close = at + fence.length;
    for (;;) {
      close = text.indexOf(fence, close);
      assert.notEqual(close, -1, `unclosed code span in ${text}`);
      if (text[close + fence.length] !== "`" && text[close - 1] !== "`") break;
      close += 1;
    }
    let body = text.slice(at + fence.length, close);
    if (body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
    spans.push(body);
    at = close + fence.length;
  }
  return spans;
}

/** The arguments that bash gives a command line, with the program swapped out so nothing runs. */
function bashArgs(command, program) {
  assert.ok(command.startsWith(`${program} `), command);
  const shown = spawnSync("bash", ["-c", `printf '%s\\0' ${command.slice(program.length + 1)}`], { encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  return shown.stdout.split("\0").slice(0, -1);
}

test("the handoff message names the waiting batch, and gives nothing without a poll command", () => {
  const poll = "walkr-core poll /tmp/r.html", status = "walkr-core status /tmp/r.html";
  assert.ok(codeSpans(handoffPrompt(poll, status, "batch-0123456789abcdef")).includes("batch-0123456789abcdef"));
  assert.equal(codeSpans(handoffPrompt(poll, status)).some((span) => span.startsWith("batch-")), false, "without a waiting batch the message names none");
  assert.doesNotMatch(handoffPrompt(poll, status), /human-review/, "the retired skill name is never offered");
  assert.equal(handoffPrompt("", status), "");
  assert.equal(handoffPrompt(undefined, undefined), "");
  assert.equal(codeSpan("a `b` c"), "``a `b` c``");
  assert.equal(codeSpan("`edge"), "`` `edge ``");
});

test("command arguments stay literal in bash, and the managed host names walkr-core", () => {
  for (const value of ["/tmp/plain.html", "/tmp/a $HOME b.html", "/tmp/`id`.html", '/tmp/say "hi".html', "/tmp/it's.html", "/tmp/$(id)"]) {
    assert.deepEqual(bashArgs(`x ${commandArg(value)}`, "x"), [value]);
  }
  assert.equal(commandArg("/tmp/a b.html", "win32"), shellQuote("/tmp/a b.html"), "cmd and PowerShell keep double quotes");
  assert.equal(reviewInvocation({ HUMAN_REVIEW_HOSTED: "1" }), "walkr-core");
  assert.equal(reviewInvocation({}, () => ({ status: 0, stdout: "/usr/local/bin/human-review\n" })), "human-review");
});

test("the handoff box shows for every state that has no poll waiting, and never says the agent stopped", () => {
  assert.equal(handoffText("idle"), null);
  assert.equal(handoffText("listening"), null);
  for (const state of ["stranded", "working", "queued"]) assert.ok(handoffText(state)?.title && handoffText(state).body, state);
  for (const state of ["working", "queued"]) assert.doesNotMatch(handoffText(state).title, /stopped|not listening|no agent/i);
});

test("every poll and status command in the Core skill is one the CLI accepts", () => {
  const skill = fs.readFileSync(path.join(project, "skills", "walkr-core", "SKILL.md"), "utf8");
  const commands = skill.split("\n").flatMap((line) => (line.includes("`") ? codeSpans(line) : [])).filter((span) => /^walkr-core (poll|status) /.test(span));
  assert.ok(commands.some((span) => span.includes(" --ack <batch_id> ")), "the skill acknowledges by batch id");
  for (const span of commands) {
    const [verb, target, ...flags] = bashArgs(span.replace("<batch_id>", "batch-0123456789abcdef"), "walkr-core");
    assert.ok(target.startsWith("/"), span);
    if (verb === "status") assert.deepEqual(flags, [], span);
    else assert.match(flags.join(" "), /^(--ack batch-[0-9a-f]{16} )?--timeout [1-9][0-9]*$/, span);
  }
});

test("a Send with no poller stays saved, and the handoff collects the exact batch once before the ack", async (t) => {
  const { tmp, stateDir, server } = await disposableServer(t);
  const file = path.join(tmp, "review.html");
  fs.writeFileSync(file, "<p>Original</p>");
  const opened = await request(server, "POST", "/api/session", { file });
  assert.equal(opened.status, 200);
  const page = await request(server, "GET", `/api/session/${opened.body.sessionId}/page`);
  const target = fs.realpathSync(file);
  assert.ok(page.body.page.pollCommand.endsWith(` poll ${commandArg(target)}`), page.body.page.pollCommand);
  assert.ok(page.body.page.statusCommand.endsWith(` status ${commandArg(target)}`), page.body.page.statusCommand);

  await request(server, "POST", `/api/page/${opened.body.key}/comment`, { kind: "selection", quote: "Original", feedback: "Shorter." });
  const sent = await request(server, "POST", `/api/page/${opened.body.key}/send`, { sessionId: opened.body.sessionId, note: "One pass." });
  assert.equal(sent.status, 200);

  const waiting = await cli(stateDir, ["status", target]);
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.deepEqual(
    (({ status, agent_listening, review_open }) => ({ status, agent_listening, review_open }))(JSON.parse(waiting.stdout)),
    { status: "feedback-waiting", agent_listening: false, review_open: true }
  );

  // The handoff's poll: the persisted batch, unchanged.
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const persisted = Object.values(saved.batches)[0].batch;
  const first = await cli(stateDir, ["poll", target, "--timeout", "30"]);
  assert.equal(first.code, 0, first.stderr);
  const batch = JSON.parse(first.stdout);
  assert.deepEqual(batch, persisted);
  assert.equal(batch.pages[0].comments[0].feedback, "Shorter.");
  assert.equal(batch.overall_note, "One pass.");

  // A re-poll before the ack (the status check before a turn ends) returns the same batch, not a new one.
  const again = await cli(stateDir, ["poll", target, "--timeout", "30"]);
  assert.deepEqual(JSON.parse(again.stdout), batch);
  assert.equal(JSON.parse((await cli(stateDir, ["status", target])).stdout).status, "feedback-waiting", "only the ack clears it");

  const acked = await cli(stateDir, ["poll", target, "--ack", "--timeout", "2"]);
  assert.equal(acked.code, 0, acked.stderr);
  assert.equal(JSON.parse(acked.stdout).status, "timeout", "the ack never returns the applied batch again");
  assert.equal(JSON.parse((await cli(stateDir, ["status", target])).stdout).status, "idle");
});

test("a handoff for a path with $, a backtick and a double quote runs the exact target in bash", async (t) => {
  const { tmp, stateDir, server } = await disposableServer(t);
  const dir = path.join(tmp, 'a $HOME `id` "q"');
  fs.mkdirSync(dir);
  const file = path.join(dir, "review.html");
  fs.writeFileSync(file, "<p>Original</p>");
  const target = fs.realpathSync(file);
  const opened = await request(server, "POST", "/api/session", { file });
  const { pollCommand, statusCommand } = (await request(server, "GET", `/api/session/${opened.body.sessionId}/page`)).body.page;
  const program = pollCommand.slice(0, pollCommand.indexOf(" poll "));
  const spans = codeSpans(handoffPrompt(pollCommand, statusCommand)).filter((span) => span !== "batch_id");
  assert.equal(spans.length, 3, "poll, ack and status each sit in one intact code span");
  assert.deepEqual(bashArgs(spans[0], program), ["poll", target, "--timeout", "30"]);
  // The agent puts the batch id of its poll output in place of the placeholder.
  assert.ok(spans[1].includes(" --ack <batch_id> "), spans[1]);
  assert.deepEqual(bashArgs(spans[1].replace("<batch_id>", "batch-0123456789abcdef"), program), ["poll", target, "--ack", "batch-0123456789abcdef", "--timeout", "2"]);
  assert.deepEqual(bashArgs(spans[2], program), ["status", target]);

  const shown = await cli(stateDir, [file]);
  assert.equal(shown.code, 0, shown.stderr);
  const hint = shown.stdout.split("\n");
  const command = reviewInvocation({});
  const pollLine = hint.find((line) => line.startsWith(`  ${command} poll `)).trim();
  assert.deepEqual(bashArgs(pollLine, command), ["poll", target, "--timeout", "240"]);
  const statusLine = hint.find((line) => line.includes("Before you end the turn, run: ")).split("Before you end the turn, run: ")[1];
  assert.deepEqual(bashArgs(statusLine, command), ["status", target]);
});

async function reviewWithComment(t, feedback) {
  const fixture = await disposableServer(t);
  const file = path.join(fixture.tmp, "review.html");
  fs.writeFileSync(file, "<p>Original words here</p>");
  const opened = await request(fixture.server, "POST", "/api/session", { file });
  await request(fixture.server, "POST", `/api/page/${opened.body.key}/comment`, { kind: "selection", quote: "Original", feedback });
  return { ...fixture, opened: opened.body, target: fs.realpathSync(file) };
}

const send = (f, note) => request(f.server, "POST", `/api/page/${f.opened.key}/send`, { sessionId: f.opened.sessionId, note });
const comment = (f, feedback) => request(f.server, "POST", `/api/page/${f.opened.key}/comment`, { kind: "selection", quote: "words", feedback });
const feedbackOnPage = async (f) =>
  (await request(f.server, "GET", `/api/page/${f.opened.key}?session=${f.opened.sessionId}`)).body.comments.map((c) => c.feedback);

test("a Send after a collected, unacked batch still gives a fresh agent the earlier items, and the page offers the handoff", async (t) => {
  const f = await reviewWithComment(t, "Shorter.");
  assert.equal((await send(f, "First pass.")).status, 200);
  const first = JSON.parse((await cli(f.stateDir, ["poll", f.target, "--timeout", "30"])).stdout);
  assert.equal(first.pages[0].comments[0].feedback, "Shorter.");
  // The agent's turn ends here without --ack: nothing polls and nothing acknowledges.
  assert.equal(await agentState(f.server, f.opened.sessionId), "working");
  assert.ok(handoffText("working"), "the page offers the handoff for a delivered, unacked batch");

  await comment(f, "Warmer.");
  assert.equal((await send(f, "Second pass.")).status, 200);
  assert.equal(await agentState(f.server, f.opened.sessionId), "queued");
  assert.ok(handoffText("queued"), "the page offers the handoff for a queued batch");

  // A fresh agent session follows the handoff.
  const next = JSON.parse((await cli(f.stateDir, ["poll", f.target, "--timeout", "30"])).stdout);
  assert.deepEqual(next.pages[0].comments.map((c) => c.feedback), ["Warmer."], "pages hold only the new items");
  assert.equal(next.overall_note, "Second pass.");
  assert.notEqual(next.sent_at, first.sent_at);
  assert.deepEqual(next.earlier_batches, [{ batch_id: first.batch_id, sent_at: first.sent_at, overall_note: "First pass.", pages: first.pages }]);
  assert.match(next.next_step, /^`earlier_batches` holds feedback that was delivered before and never acknowledged/);
  assert.equal(await agentState(f.server, f.opened.sessionId), "working");
  const again = JSON.parse((await cli(f.stateDir, ["poll", f.target, "--timeout", "30"])).stdout);
  assert.deepEqual(again, next, "a re-poll before the ack returns the same batch");

  assert.deepEqual(await feedbackOnPage(f), ["Shorter.", "Warmer."]);
  // The fresh agent names the batch it applied: a bare --ack could also come from the agent that still holds the first batch.
  const bare = await cli(f.stateDir, ["poll", f.target, "--ack", "--timeout", "2"]);
  assert.equal(JSON.parse(bare.stdout).status, "ack-refused");
  assert.deepEqual(await feedbackOnPage(f), ["Shorter.", "Warmer."], "the refused ack cleared nothing");
  const acked = await cli(f.stateDir, ["poll", f.target, "--ack", next.batch_id, "--timeout", "2"]);
  assert.equal(JSON.parse(acked.stdout).status, "timeout");
  assert.deepEqual(await feedbackOnPage(f), [], "one ack clears the earlier and the newer items");
  assert.equal(JSON.parse((await cli(f.stateDir, ["status", f.target])).stdout).status, "idle");
});

test("the agent that holds the earlier batch acks it with the old bare form, and the queued batch then goes out without it", async (t) => {
  const f = await reviewWithComment(t, "Shorter.");
  await send(f, "First pass.");
  const first = JSON.parse((await cli(f.stateDir, ["poll", f.target, "--timeout", "30"])).stdout);
  await comment(f, "Warmer.");
  await send(f, "");

  const acked = JSON.parse((await cli(f.stateDir, ["poll", f.target, "--ack", "--timeout", "2"])).stdout);
  assert.equal(acked.status, "feedback");
  assert.notEqual(acked.sent_at, first.sent_at);
  assert.deepEqual(acked.pages[0].comments.map((c) => c.feedback), ["Warmer."]);
  assert.equal(acked.earlier_batches, undefined, "the acknowledged batch is not served again");
  assert.match(acked.next_step, /^Apply this feedback\./);
  assert.deepEqual(await feedbackOnPage(f), ["Warmer."], "the ack cleared only the earlier batch");
  const saved = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(saved.batches)[0].batch.earlier_batches, undefined, "the stored batch drops its copy too");

  await cli(f.stateDir, ["poll", f.target, "--ack", "--timeout", "2"]);
  assert.deepEqual(await feedbackOnPage(f), []);
});

test("status with the review server down still reports the waiting batch and no open review", async (t) => {
  const f = await reviewWithComment(t, "Shorter.");
  await send(f, "One pass.");
  f.child.kill();
  await once(f.child, "exit");
  const shown = await cli(f.stateDir, ["status", f.target]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(
    (({ status, agent_listening, review_open, server_running }) => ({ status, agent_listening, review_open, server_running }))(JSON.parse(shown.stdout)),
    { status: "feedback-waiting", agent_listening: false, review_open: false, server_running: false }
  );
});
