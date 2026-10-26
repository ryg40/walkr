import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, listen, digest } from "./double-fixtures.js";
import { SERVER_PROTOCOL } from "../src/paths.js";
import { SESSION_MESSAGE } from "../src/double-session-chat.js";
import { acknowledgedGenerationView } from "./acknowledged-view-fixture.js";

const exec = promisify(execFile);
const piPackage = process.env.HUMAN_REVIEW_TEST_PI_PACKAGE;
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail("Timed out at the installed Pi session boundary");
}

test("installed Pi: idle Next, agent attach, next round failure, owner Retry, and End queued behind stale generation", {
  skip: piPackage ? false : "Set HUMAN_REVIEW_TEST_PI_PACKAGE for the offline installed-Pi boundary check.",
}, async (t) => {
  const host = await import(pathToFileURL(path.join(piPackage, "dist/index.js")));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(piPackage, "node_modules/@earendil-works/pi-ai/dist/index.js")));
  const f = await fixture(t), s = await listen(t, f);
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ protocol: SERVER_PROTOCOL, port: s.port, token: s.token }), { mode: 0o600 });
  const env = { HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir, HUMAN_REVIEW_HOSTED: "0" };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const root = "/api/double/sessions/~design";
  assert.equal((await s.api("/api/double/sessions", { method: "POST", body: { sessionId: "design", brief: "  Saved design brief.  ", manifest: f.manifest } })).status, 200);
  const view = async () => (await s.api(root)).json.view;
  const events = async () => (await s.api(root + "/events")).json;
  const mutate = async (op, body) => {
    const answer = await s.api(root + "/" + op, { method: "POST", body });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    return answer.json;
  };
  const agentDir = path.join(f.root, "pi-agent");
  await fs.mkdir(agentDir);
  const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const modelRuntime = await host.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-cache"), allowModelNetwork: false, refreshOnCreate: false });
  const requests = [], pending = [], handled = new Set(), work = [], generatedHashes = new Map();
  modelRuntime.registerProvider("double-session-test", {
    api: "double-session-test-api", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fake", name: "Offline fixture agent", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 200 }],
    streamSimple(model, context, options) {
      requests.push(structuredClone(context.messages));
      const texts = context.messages.flatMap((m) => typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text));
      const text = texts.filter((value) => value.startsWith("Trusted Double ")).at(-1);
      const packet = text ? JSON.parse(text.split("\n").at(-1)) : null;
      const generate = packet?.event.kind === "generation" && !handled.has(packet.event.id);
      if (generate) handled.add(packet.event.id);
      const stream = createAssistantMessageEventStream();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        options?.signal?.removeEventListener("abort", finish);
        const content = generate ? [{ type: "toolCall", id: `call-${packet.event.id}`, name: "fixture_generate", arguments: { eventId: packet.event.id } }] : [];
        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: generate ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      };
      pending.push(finish);
      options?.signal?.addEventListener("abort", finish, { once: true });
      if (options?.signal?.aborted) finish();
      return stream;
    },
  });
  let failNext = false;
  const fixtureTool = { name: "fixture_generate", label: "Offline generation fixture", description: "Offline test only",
    parameters: { type: "object", properties: { eventId: { type: "string" } }, required: ["eventId"] },
    async execute(_id, { eventId }) {
      const event = (await events()).events.find((e) => e.id === eventId), current = await view();
      work.push(event);
      if (current.status !== "generating" || current.generation.attempt.id !== event.payload.attemptId) {
        return { content: [{ type: "text", text: "Obsolete event; no generation or submission." }], details: { obsolete: true } };
      }
      let op, body;
      if (failNext) {
        failNext = false;
        op = "fail";
        body = { actionId: `fail-${eventId}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId, message: "Offline fixture generation error" };
      } else {
        const manifest = structuredClone(f.manifest);
        manifest.comparisonId = "generated-2";
        for (const pane of ["left", "right"]) {
          const copy = path.join(f.root, `generated-${pane}`);
          await fs.cp(manifest.panes[pane].copy.root, copy, { recursive: true });
          const entry = path.join(copy, "index.html");
          await fs.writeFile(entry, (await fs.readFile(entry, "utf8")).replace(`${pane} copy`, `${pane} generated fixture`));
          manifest.panes[pane].copy.root = copy;
          for (const name of ["index.html", ...manifest.panes[pane].copy.assets]) generatedHashes.set(path.join(copy, name), digest(await fs.readFile(path.join(copy, name))));
        }
        op = "attach";
        body = { actionId: `attach-${eventId}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId, manifest };
      }
      // The trusted agent saves one full request, then uses the existing CLI. Replaying
      // an uncertain successful attach uses the same file, not another generation.
      const requestFile = path.join(f.root, `${op}-${eventId}.json`);
      await fs.writeFile(requestFile, JSON.stringify(body));
      const args = [path.resolve("src/cli.js"), "double", "session", op, "design", requestFile];
      const first = JSON.parse((await exec(process.execPath, args, { env: { ...process.env, ...env }, timeout: 15000 })).stdout);
      const replay = JSON.parse((await exec(process.execPath, args, { env: { ...process.env, ...env }, timeout: 15000 })).stdout);
      assert.deepEqual(replay.result, first.result);
      return { content: [{ type: "text", text: JSON.stringify(first.result) }], details: first.result };
    },
  };
  const loader = new host.DefaultResourceLoader({ cwd: f.root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.resolve("integrations/pi/double-session-chat.ts")],
    systemPromptOverride: () => "Offline fixture agent. Use only fixture_generate once per new generation event.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = host.SessionManager.create(f.root, path.join(f.root, "pi-sessions"));
  const { session } = await host.createAgentSession({ cwd: f.root, agentDir, settingsManager, modelRuntime,
    model: modelRuntime.getModel("double-session-test", "fake"), resourceLoader: loader, sessionManager,
    tools: ["fixture_generate"], customTools: [fixtureTool], thinkingLevel: "off" });
  const errors = [];
  const packets = () => sessionManager.getBranch().filter((e) => e.customType === SESSION_MESSAGE);
  async function finishRequest(index) { await until(() => pending.length > index); pending[index](); }
  async function observeWithoutModelWork() {
    const before = requests.length;
    let viewFinishedAt, observedMs = 0;
    // No test HTTP reads run here. A later event read proves the listener consumed
    // the preceding view; keep observing real cycles over a quiet interval.
    const onRequest = (req, res) => {
      if (req.method !== "GET") return;
      if (req.url === root) res.once("finish", () => {
        if (res.statusCode === 200) viewFinishedAt ??= Date.now();
      });
      if (req.url === root + "/events" && viewFinishedAt !== undefined) observedMs = Date.now() - viewFinishedAt;
    };
    s.server.on("request", onRequest);
    try {
      await until(() => observedMs >= 750);
      assert.equal(requests.length, before, "observed background reads do not start model polling turns");
      assert.equal(session.isStreaming, false);
      assert.deepEqual(session.agent.peekQueuedMessages(), []);
    } finally {
      s.server.off("request", onRequest);
    }
  }
  try {
    await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error) });
    await session.prompt('/double-session-chat {"action":"start","doubleSessionId":"design","timeoutSeconds":25}');
    const armed = JSON.parse(sessionManager.getEntries().find((e) => e.customType === "double-session-chat-command-v1").content);
    assert.equal(armed.status, "waiting");
    assert.equal(armed.doubleSessionId, "design");
    assert.equal(armed.piSessionId, sessionManager.getSessionId());
    assert.equal(requests.length, 0);
    await mutate("actions", { actionId: "keep", expectedRevision: 0, comparisonId: "trial",
      action: { kind: "keeper", pane: "left", componentId: "hero", selected: true } });
    await observeWithoutModelWork();
    assert.equal(requests.length, 0, "ordinary edits do not request model work");
    const first = await mutate("next", { actionId: "next-1", expectedRevision: 1, comparisonId: "trial" });
    await until(() => requests.length === 1);
    assert.equal(packets().length, 1);
    assert.deepEqual(JSON.parse(packets()[0].content.split("\n").at(-1)).event, (await events()).events[0]);
    assert.deepEqual((await events()).pending, [first.result.eventId]);
    await assert.rejects(fs.stat(sessionManager.getSessionFile()), { code: "ENOENT" });
    await finishRequest(0);
    await finishRequest(1);
    await session.waitForIdle();
    await until(async () => (await events()).pending.length === 0);
    assert.equal((await view()).currentComparisonId, "generated-2", JSON.stringify(session.messages.filter((m) => m.role === "toolResult")));

    let v = await view();
    await mutate("actions", { actionId: "delete", expectedRevision: v.revision, comparisonId: v.currentComparisonId,
      action: { kind: "feedback-delete", pane: "right", componentId: "hero", feedback: "  Exact <script>untrusted</script> feedback.  " } });
    failNext = true;
    v = await view();
    const second = await mutate("next", { actionId: "next-2", expectedRevision: v.revision, comparisonId: v.currentComparisonId });
    await finishRequest(2);
    await finishRequest(3);
    await session.waitForIdle();
    await until(async () => (await events()).pending.length === 0);
    v = await view();
    assert.equal(v.status, "failed");
    assert.equal(work.length, 2);
    const retried = await mutate("retry", { actionId: "owner-retry", expectedRevision: v.revision,
      requestId: second.result.requestId, attemptId: second.result.attemptId });
    await until(() => requests.length === 5);
    assert.equal(session.isStreaming, true);
    assert.deepEqual((await events()).events[2].payload.history, (await events()).events[1].payload.history);
    const heldRequest = requests.at(-1);
    const retriedEvent = (await events()).events.find((event) => event.id === retried.result.eventId);
    v = await acknowledgedGenerationView(s.api, root, retriedEvent, "generated-2");
    assert.equal(v.status, "generating");
    assert.equal(v.generation.attempt.status, "running");
    assert.equal(session.isStreaming, true);
    assert.equal(requests.at(-1), heldRequest, "acknowledgment does not release held generation");
    const ended = await mutate("end", { actionId: "end", expectedRevision: v.revision, comparisonId: v.currentComparisonId, pane: "right" });
    // The session's getFollowUpMessages() only exposes user text. The public
    // agent preview includes custom packets and does not consume the real queue.
    const queuedFinal = () => session.agent.peekQueuedMessages().find((message) =>
      message.customType === SESSION_MESSAGE && message.details?.eventId === ended.result.eventId);
    await until(queuedFinal);
    const queued = structuredClone(queuedFinal());
    assert.equal(session.isStreaming, true, "final dispatch reaches Pi while generation is still held");
    assert.equal(requests.at(-1), heldRequest, "the held generation request has not advanced");
    assert.ok((await events()).pending.includes(ended.result.eventId), "queued follow-up is not a persisted receipt");
    assert.equal(packets().length, 3);
    await finishRequest(4); // Stale agent tool rechecks before any work.
    await finishRequest(5); // Finish the running tool loop.
    await finishRequest(6); // Final follow-up starts without another user prompt.
    await session.waitForIdle();
    await until(async () => (await events()).pending.length === 0);
    await observeWithoutModelWork();
    assert.equal(work.length, 3);
    assert.deepEqual(packets().map((entry) => JSON.parse(entry.content.split("\n").at(-1)).event),
      (await events()).events, "each event reaches the chat exactly once, without duplicate wake packets");
    assert.equal(packets().at(-1).content, queued.content);
    assert.deepEqual(packets().at(-1).details, queued.details);
    const final = JSON.parse(packets().at(-1).content.split("\n").at(-1));
    assert.deepEqual(final.output, (await s.api(root + "/output")).json);
    assert.deepEqual(final.event, (await events()).events.at(-1));
    assert.deepEqual(final.output.page.deletedComponentIds, ["hero"]);
    assert.equal((await view()).generation.attempt.id, retried.result.attemptId);
    assert.equal((await view()).generation.attempt.status, "cancelled");
    for (const entry of packets()) {
      assert.ok(requests.some((messages) => messages.some((m) => m.content === entry.content ||
        Array.isArray(m.content) && m.content.some((b) => b.text === entry.content))), "the provider receives each complete packet");
    }
    assert.ok(!JSON.stringify(requests).includes(s.token));
    const saved = (await fs.readFile(sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(saved.filter((e) => e.customType === SESSION_MESSAGE), packets());
    assert.deepEqual(errors, []);
    await f.unchanged(assert);
    for (const [file, before] of generatedHashes) assert.equal(digest(await fs.readFile(file)), before);
  } finally {
    await session.prompt('/double-session-chat {"action":"cancel","doubleSessionId":"design"}').catch(() => {});
    for (const finish of pending) finish();
    await session.abort();
    session.dispose();
  }
});
