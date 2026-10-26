import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { cli, disposableServer, openReview, project } from "./core-fixtures.js";
import { INTERVAL, LIFETIME, WAKE_MESSAGE, WAKE_RECORD } from "../src/core-wake-chat.js";

const piPackage = process.env.HUMAN_REVIEW_TEST_PI_PACKAGE;
async function until(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  assert.fail(`Installed Pi Core wake-up timed out: ${label}`);
}

test("installed Pi Core wake-up: one follow-up turn per uncollected batch id, none for a collected batch, none again after Pi or server restarts", {
  skip: piPackage ? false : "Set HUMAN_REVIEW_TEST_PI_PACKAGE for the offline installed-Pi boundary.",
  timeout: 240000,
}, async (t) => {
  const host = await import(pathToFileURL(path.join(piPackage, "dist/index.js")));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(piPackage, "node_modules/@earendil-works/pi-ai/dist/index.js")));
  const f = await disposableServer(t);
  let r = await openReview(f);
  // The extension reaches the server only through this command, the way the managed wrapper runs the CLI in the container.
  const env = { HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_NO_BROWSER: "1", HUMAN_REVIEW_HOSTED: "",
    HUMAN_REVIEW_CORE_COMMAND: JSON.stringify([process.execPath, path.join(project, "src/cli.js")]) };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  const agentDir = path.join(f.tmp, "pi-agent"); await fs.mkdir(agentDir);
  const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const modelRuntime = await host.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(agentDir, "model-cache"), allowModelNetwork: false, refreshOnCreate: false });
  // The offline model reads each turn and answers with nothing: it never polls or acks, so every batch stays uncollected.
  const turns = [];
  modelRuntime.registerProvider("core-wake-test", {
    api: "core-wake-test-api", apiKey: "offline-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fake", name: "Offline fixed fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 200 }],
    streamSimple(model, context) {
      const texts = context.messages.flatMap((m) => typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text));
      const wake = texts.filter((value) => value.startsWith("Walkr Core wake-up")).at(-1);
      turns.push(wake ? JSON.parse(wake.split("\n").at(-1)) : null);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", content: [{ type: "text", text: "Noted." }], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
  const sessionDir = path.join(f.tmp, "pi-sessions");
  async function startPi(sessionManager) {
    const loader = new host.DefaultResourceLoader({ cwd: f.tmp, agentDir, settingsManager, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [path.join(project, "integrations/pi/core-wake.ts")], systemPromptOverride: () => "Offline fixture only." });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await host.createAgentSession({ cwd: f.tmp, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
      sessionManager, model: modelRuntime.getModel("core-wake-test", "fake"), tools: [], thinkingLevel: "off" });
    const errors = [];
    await session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e) });
    return { session, sessionManager, errors };
  }
  // A Pi quit emits session_shutdown before it disposes the session, as the Pi runtime does; a crash only disposes it.
  const quit = async (pi) => { await pi.session.abort(); await pi.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); pi.session.dispose(); };
  const commandResult = (pi) => JSON.parse(pi.sessionManager.getEntries().filter((e) => e.customType === "walkr-core-wake-command-v1").at(-1).content);
  const wakes = (pi) => pi.sessionManager.getEntries().filter((e) => e.customType === WAKE_MESSAGE);
  const records = (pi) => pi.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === WAKE_RECORD);
  const status = async () => (await cli(f.stateDir, ["status", r.target])).json;
  const connect = (pi) => pi.session.prompt(`/walkr-core-wake ${JSON.stringify({ action: "connect", target: r.target, intervalSeconds: 1, timeoutSeconds: 600 })}`);
  // A few watcher intervals: long enough for a duplicate wake to show up if one could.
  const settle = () => delay(3500);

  let pi = await startPi(host.SessionManager.create(f.tmp, sessionDir));
  try {
    // The registered tool schema accepts exactly the intervals and lifetimes that the runtime accepts.
    const schema = pi.session.extensionRunner.getToolDefinition("walkr_core_wake").parameters.properties;
    assert.deepEqual([schema.intervalSeconds.minimum, schema.intervalSeconds.maximum, schema.timeoutSeconds.maximum], [INTERVAL.min, INTERVAL.max, LIFETIME.max]);
    // Loading registers interfaces only: no binding until the explicit connect.
    assert.equal((await status()).wake.bound, false);
    await pi.session.prompt('/walkr-core-wake {"action":"connect"}');
    assert.equal(commandResult(pi).status, "command_failed", "connect needs the exact target");
    await connect(pi);
    const connected = commandResult(pi);
    assert.equal(connected.active, true, JSON.stringify(connected));
    assert.equal(connected.piSessionId, pi.sessionManager.getSessionId());
    const bound = (await cli(f.stateDir, ["status", r.target, "--pi-session-id", pi.sessionManager.getSessionId(),
      "--pi-session-file", pi.sessionManager.getSessionFile()])).json;
    assert.deepEqual(bound.wake, { bound: true, watching: true, lease_expired: false, bound_to_caller: true });
    assert.equal(JSON.stringify(await status()).includes(pi.sessionManager.getSessionId()), false, "status never names the bound chat");

    // A Send that a waiting poll collects needs no wake.
    const waiter = spawn(process.execPath, ["src/cli.js", "poll", r.target, "--timeout", "30"], { cwd: project, env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    let polled = ""; waiter.stdout.on("data", (chunk) => { polled += chunk; });
    await until(async () => (await status()).agent_listening, "the waiting poll");
    await r.comment("Collected item.");
    await r.send("Collected.");
    await new Promise((resolve) => waiter.on("exit", resolve));
    const collected = JSON.parse(polled);
    await settle();
    assert.equal(wakes(pi).length, 0, "a collected batch never wakes the chat");
    assert.equal((await cli(f.stateDir, ["poll", r.target, "--ack", collected.batch_id, "--timeout", "1"])).json.status, "timeout");

    // A Send that no poll collects wakes the bound chat exactly once.
    await r.comment("Stranded item.");
    await r.send("Stranded.");
    const stranded = (await status()).batch_id;
    await until(() => wakes(pi).length === 1, "the first wake");
    await pi.session.waitForIdle();
    const wake = wakes(pi)[0];
    const data = JSON.parse(wake.content.split("\n").at(-1));
    assert.deepEqual([wake.details.batchId, data.batch_id, data.target], [stranded, stranded, r.target]);
    assert.match(data.poll, / poll .* --timeout 30$/);
    assert.ok(wake.content.startsWith("Walkr Core wake-up"));
    assert.deepEqual(records(pi).map((e) => e.data.batchId), [stranded], "the wake is recorded before the message");
    await settle();
    assert.equal(wakes(pi).length, 1, "one batch id wakes once, though it stays uncollected");
    assert.deepEqual(turns.filter(Boolean).map((x) => x.batch_id), [stranded], "one follow-up turn saw the wake");
    const after = await status();
    assert.deepEqual([after.batch_id, after.collected], [stranded, false], "the extension never polls or acks");

    // The server restarts with the batch still waiting: the same id, no second wake.
    await f.restart();
    await settle();
    assert.equal((await status()).batch_id, stranded);
    assert.equal(wakes(pi).length, 1, "a server restart replays no wake");
    assert.equal(commandResult(pi).active, true);
    // The browser session ended with the old server; the owner reopens the review.
    r = await openReview(f);

    // Pi restarts on the same session file and reconnects explicitly: the saved wake record prevents a replay.
    const sessionFile = pi.sessionManager.getSessionFile();
    await quit(pi);
    assert.equal((await status()).wake.bound, false, "a Pi quit releases the chat's own binding");
    pi = await startPi(host.SessionManager.open(sessionFile, sessionDir));
    await connect(pi);
    assert.equal(commandResult(pi).active, true, JSON.stringify(commandResult(pi)));
    await settle();
    assert.equal(wakes(pi).length, 1, "a Pi restart replays no wake for the same batch id");
    assert.deepEqual(commandResult(pi).woken, [stranded], "the reconnect read the saved wake record");

    // A new batch id wakes once more.
    await r.comment("Next item.");
    await r.send("Next.");
    const next = (await status()).batch_id;
    assert.notEqual(next, stranded);
    await until(() => wakes(pi).length === 2, "the second wake");
    await pi.session.waitForIdle();
    await settle();
    assert.deepEqual(wakes(pi).map((e) => e.details.batchId), [stranded, next]);

    // Disconnect stops the watcher and releases the binding; a later Send wakes nothing.
    await pi.session.prompt('/walkr-core-wake {"action":"disconnect"}');
    assert.deepEqual([commandResult(pi).active, commandResult(pi).released], [false, true]);
    assert.equal((await status()).wake.bound, false);
    await r.comment("Unwatched item.");
    await r.send("Unwatched.");
    await settle();
    assert.equal(wakes(pi).length, 2, "no wake after disconnect");
    assert.deepEqual(pi.errors, []);

    // After a Pi crash (no shutdown event), the same chat can still release its binding by target.
    await connect(pi);
    assert.equal((await status()).wake.bound, true);
    const file = pi.sessionManager.getSessionFile();
    await pi.session.abort(); pi.session.dispose();
    pi = await startPi(host.SessionManager.open(file, sessionDir));
    await pi.session.prompt(`/walkr-core-wake ${JSON.stringify({ action: "disconnect", target: r.target })}`);
    assert.deepEqual([commandResult(pi).active, commandResult(pi).released], [false, true]);
    assert.equal((await status()).wake.bound, false);
    // The crashed instance still runs in this test process; its next read finds the binding gone and stops.
    await settle();

    // Two Pi processes on the same session file: the server grants one wake per batch id per binding.
    const twin = await startPi(host.SessionManager.open(pi.sessionManager.getSessionFile(), sessionDir));
    try {
      await connect(pi);
      await connect(twin);
      assert.deepEqual([commandResult(pi).active, commandResult(twin).active], [true, true]);
      await r.comment("Twin item.");
      await r.send("Twin.");
      const twinBatch = (await status()).batch_id;
      const woke = () => [...wakes(pi), ...wakes(twin)].filter((e) => e.details.batchId === twinBatch).length;
      await until(() => woke() > 0, "the twin wake");
      await pi.session.waitForIdle(); await twin.session.waitForIdle();
      await settle();
      assert.equal(woke(), 1, "two Pi processes on one session file wake once for one batch id");
      assert.deepEqual([...pi.errors, ...twin.errors], []);
    } finally {
      await twin.session.prompt('/walkr-core-wake {"action":"disconnect"}').catch(() => {});
      await twin.session.abort(); twin.session.dispose();
    }
  } finally {
    await pi.session.prompt('/walkr-core-wake {"action":"disconnect"}').catch(() => {});
    await pi.session.abort(); pi.session.dispose();
  }
});
