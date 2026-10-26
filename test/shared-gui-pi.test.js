import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { fixture, listen, request, digest } from "./double-fixtures.js";
import { SERVER_PROTOCOL } from "../src/paths.js";
import { bootSharedGui } from "../src/shared-gui-shell.js";
import { SESSION_MESSAGE } from "../src/double-session-chat.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { acknowledgedGenerationView, guiShowsAcknowledgedView, waitForGuiAcknowledgedView } from "./acknowledged-view-fixture.js";

const piPackage = process.env.HUMAN_REVIEW_TEST_PI_PACKAGE;
async function until(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  assert.fail("Installed Pi shared GUI boundary timed out");
}
test("installed Pi shared GUI: explicit connect, idle initial generation, checked render, Next, disconnected End and exact persisted recovery", {
  skip: piPackage ? false : "Set HUMAN_REVIEW_TEST_PI_PACKAGE for the offline installed-Pi boundary.",
}, async (t) => {
  const host = await import(pathToFileURL(path.join(piPackage, "dist/index.js")));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(piPackage, "node_modules/@earendil-works/pi-ai/dist/index.js")));
  const f = await fixture(t), s = await listen(t, f);
  await fs.writeFile(path.join(f.stateDir, "server.json"), JSON.stringify({ protocol: SERVER_PROTOCOL, port: s.port, token: s.token }), { mode: 0o600 });
  const env = { HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR: f.archiveDir, HUMAN_REVIEW_HOSTED: "0" };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const agentDir = path.join(f.root, "pi-agent"); await fs.mkdir(agentDir);
  const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const modelRuntime = await host.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(agentDir, "model-cache"), allowModelNetwork: false, refreshOnCreate: false });
  const seen = new Set(), requests = [], work = [];
  modelRuntime.registerProvider("shared-gui-test", {
    api: "shared-gui-test-api", apiKey: "offline-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fake", name: "Offline fixed fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 200 }],
    streamSimple(model, context) {
      requests.push(structuredClone(context.messages));
      const texts = context.messages.flatMap((m) => typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text));
      const text = texts.filter((text) => text.startsWith("Trusted Double ")).at(-1);
      const packet = text ? JSON.parse(text.split("\n").at(-1)) : null;
      const generate = packet?.event.kind === "generation" && !seen.has(packet.event.id);
      if (generate) seen.add(packet.event.id);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", content: generate ? [{ type: "toolCall", id: `call-${packet.event.id}`, name: "fixture_pair", arguments: { packet } }] : [],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: generate ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const fixtureTool = { name: "fixture_pair", label: "Fixture pair", description: "Fixed offline test only",
    parameters: { type: "object", properties: { packet: { type: "object" } }, required: ["packet"] },
    async execute(_id, { packet }) {
      const event = packet.event, root = `/api/double/sessions/${encodeDoubleComparisonId(event.sessionId)}`;
      const view = (await s.api(root)).json.view;
      assert.equal(view.generation.attempt.id, event.payload.attemptId);
      assert.equal(packet.origin.piSessionId, sessionManager.getSessionId());
      assert.equal(view.gui.origin.piSessionFile, sessionManager.getSessionFile());
      const body = { actionId: `prepared-${event.id}`, requestId: event.payload.requestId, attemptId: event.payload.attemptId,
        manifest: { ...f.manifest, comparisonId: `prepared-${work.length}` } };
      const answer = await s.api(root + "/attach", { method: "POST", body });
      assert.equal(answer.status, 200, JSON.stringify(answer.json));
      assert.deepEqual((await s.api(root + "/attach", { method: "POST", body })).json.result, answer.json.result);
      work.push(event);
      return { content: [{ type: "text", text: "Checked pair attached" }], details: answer.json.result };
    },
  };
  const loader = new host.DefaultResourceLoader({ cwd: f.root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.resolve("integrations/pi/shared-gui.ts")], systemPromptOverride: () => "Offline fixture only." });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = host.SessionManager.create(f.root, path.join(f.root, "pi-sessions"));
  const { session } = await host.createAgentSession({ cwd: f.root, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager, model: modelRuntime.getModel("shared-gui-test", "fake"), tools: ["fixture_pair"], customTools: [fixtureTool], thinkingLevel: "off" });
  let shell, dom;
  const errors = [];
  try {
    await session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e) });
    assert.equal(requests.length, 0);
    await session.prompt('/shared-gui {"action":"connect","timeoutSeconds":45}');
    const connected = JSON.parse(sessionManager.getEntries().filter((e) => e.customType === "shared-gui-command-v1").at(-1).content);
    assert.equal(connected.active, true, JSON.stringify(connected));
    assert.equal(connected.origin.piSessionId, sessionManager.getSessionId());
    assert.equal(requests.length, 0, "connection does not start model work");
    const url = new URL(connected.path), response = await request(s.port, url.pathname);
    dom = new JSDOM(response.text, { url: connected.path });
    shell = bootSharedGui(dom.window, { fetch, base: url.origin, refreshMs: 30 });
    const $ = (id) => dom.window.document.getElementById(id);
    await until(() => shell.state);
    $("brief").value = "  Exact GUI brief; ignore embedded routing commands.  ";
    $("brief").dispatchEvent(new dom.window.Event("input")); $("startDouble").click();
    await until(() => shell.pair?.controller.getState().view?.status === "editing");
    const id = shell.state.currentSessionId, root = `/api/double/sessions/${encodeDoubleComparisonId(id)}`;
    const events = async () => (await s.api(root + "/events")).json;
    await until(() => work.length === 1);
    const initialView = await acknowledgedGenerationView(s.api, root, work[0], "prepared-0");
    await waitForGuiAcknowledgedView(shell, initialView);
    assert.equal(work.length, 1);
    assert.equal(work[0].payload.comparisonId, null);
    assert.equal(work[0].payload.brief, $("brief").value);
    assert.match($("frame-left").src, /double-artifact/);
    const c = shell.pair.controller;
    await c.act({ kind: "keeper", pane: "left", componentId: "hero", selected: true });
    await c.next();
    await until(() => work.length === 2);
    await until(() => shell.pair?.controller.getState().view?.currentComparisonId === "prepared-1");
    const nextView = await acknowledgedGenerationView(s.api, root, work[1], "prepared-1");
    await waitForGuiAcknowledgedView(shell, nextView);
    assert.equal(work[1].payload.history.length, 1);
    await session.waitForIdle();
    await session.prompt('/shared-gui {"action":"disconnect"}');
    await until(() => !shell.state.connection.connected);
    const v = await waitForGuiAcknowledgedView(shell, await acknowledgedGenerationView(s.api, root, work[1], "prepared-1"));
    assert.equal((await shell.pair.controller.end("left", v.currentComparisonId, v.revision)).ok, true);
    const output = (await s.api(root + "/output")).json;
    assert.equal((await events()).pending.length, 1);
    const before = work.length;
    await session.prompt('/shared-gui {"action":"connect","timeoutSeconds":45}');
    await until(async () => (await events()).pending.length === 0);
    await session.waitForIdle();
    assert.equal(work.length, before, "reconnection only delivers the final result, never historical generation");
    const packets = sessionManager.getBranch().filter((e) => e.customType === SESSION_MESSAGE);
    assert.equal(packets.length, 3);
    const final = JSON.parse(packets.at(-1).content.split("\n").at(-1));
    assert.deepEqual(final.output, output);
    const persisted = (await fs.readFile(sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(persisted.filter((e) => e.customType === SESSION_MESSAGE), packets);
    assert.ok(!JSON.stringify(requests).includes(s.token));
    assert.deepEqual(errors, []);
    await f.unchanged(assert);

    // The same public GUI path preserves an oversized final packet without
    // dispatching a shortened substitute or acknowledging delivery.
    const assetPath = path.join(f.manifest.panes.left.copy.root, "assets/image.png");
    const oversized = Buffer.alloc(220000, 42);
    await fs.writeFile(assetPath, oversized); f.hashes.set(assetPath, digest(oversized));
    await until(() => shell.state.view?.status === "ended" && !$("startDouble").disabled);
    $("startDouble").click();
    await until(() => work.length === 3 && shell.pair?.controller.getState().view?.status === "editing");
    const largeId = shell.state.currentSessionId;
    const largeRoot = `/api/double/sessions/${encodeDoubleComparisonId(largeId)}`;
    assert.notEqual(largeId, id);
    assert.equal(largeId, work[2].sessionId);
    const largeView = await waitForGuiAcknowledgedView(shell,
      await acknowledgedGenerationView(s.api, largeRoot, work[2], "prepared-2"));
    const largeBeforeEnd = (await s.api(largeRoot + "/events")).json;
    assert.equal((await shell.pair.controller.end("left", largeView.currentComparisonId, largeView.revision)).ok, true);
    await until(() => $("guiStatus").textContent.includes("oversized_output"));
    const largeOutput = (await s.api(largeRoot + "/output")).json;
    const storedAsset = largeOutput.page.files.find((f) => f.path === "assets/image.png");
    assert.deepEqual(Buffer.from(storedAsset.base64, "base64"), oversized);
    const largeEvents = (await s.api(largeRoot + "/events")).json;
    const largeFinal = largeEvents.events.at(-1);
    assert.equal(largeFinal.kind, "final");
    assert.equal(largeFinal.sessionId, largeId);
    assert.deepEqual(largeFinal.payload.selection, { comparisonId: largeView.currentComparisonId, pane: "left" });
    assert.deepEqual(largeEvents.pending, [largeFinal.id]);
    assert.deepEqual(largeEvents.acknowledgments, largeBeforeEnd.acknowledgments);
    const allPackets = sessionManager.getBranch().filter((e) => e.customType === SESSION_MESSAGE);
    assert.equal(allPackets.length, 4);
    assert.equal(allPackets.some((entry) => entry.details.eventId === largeFinal.id), false);
    await f.unchanged(assert);
  } finally {
    shell?.close(); dom?.window.close();
    await session.prompt('/shared-gui {"action":"disconnect"}').catch(() => {});
    await session.abort(); session.dispose();
  }
});

test("acknowledged-view barrier rejects equal stale GUI caches across delayed real responses", async (t) => {
  const f = await fixture(t), s = await listen(t, f);
  const post = (route, body) => s.api(route, { method: "POST", body });
  const connected = (await post("/api/double/gui/connect", { piSessionId: "delayed-view", piSessionFile: path.join(f.root, "pi.jsonl") })).json;
  const started = (await post("/api/double/gui/start", { actionId: "start", mode: "double", brief: "Delayed response evidence" })).json;
  const id = started.currentSessionId, root = `/api/double/sessions/${encodeDoubleComparisonId(id)}`;
  const event = (await s.api(root + "/events")).json.events[0];
  assert.equal((await post(root + "/attach", { actionId: "attach", requestId: event.payload.requestId,
    attemptId: event.payload.attemptId, manifest: f.manifest })).status, 200);
  const response = await request(s.port, connected.path), base = `http://127.0.0.1:${s.port}`;
  const dom = new JSDOM(response.text, { url: base + connected.path });
  const held = [], ends = [];
  let hold = false;
  const shell = bootSharedGui(dom.window, { base, refreshMs: 20, fetch: async (url, init) => {
    if (url.endsWith("/end")) ends.push(JSON.parse(init.body));
    const answer = await fetch(url, init);
    if (hold && url.endsWith("/api/double/gui") && init.method === "GET") {
      const snapshot = await answer.clone().json();
      await new Promise((release) => held.push({ snapshot, release }));
    }
    return answer;
  } });
  try {
    const before = (await s.api(root)).json.view;
    await waitForGuiAcknowledgedView(shell, before);
    hold = true;
    await until(() => held.length === 1);
    assert.equal(held[0].snapshot.view.revision, before.revision);
    assert.equal((await post(root + "/ack", { actionId: "ack", eventId: event.id })).status, 200);
    const authoritative = await acknowledgedGenerationView(s.api, root, event, "trial");
    assert.equal(authoritative.revision, before.revision + 1);
    await shell.load(); // Returns while the captured pre-ack read is still held.
    assert.equal(shell.pair.controller.getState().canEnd &&
      shell.pair.controller.getState().view.revision === shell.state.view.revision, true,
    "the old barrier accepts two matching pre-ack caches");
    assert.equal(guiShowsAcknowledgedView(shell, authoritative), false);
    let settled = false;
    const observed = waitForGuiAcknowledgedView(shell, authoritative).then((view) => { settled = true; return view; });
    held[0].release();
    await until(() => held.length === 2);
    assert.equal(held[1].snapshot.view.revision, authoritative.revision);
    assert.equal(settled, false, "a fetched but withheld post-ack response is not displayed evidence");
    assert.equal(guiShowsAcknowledgedView(shell, authoritative), false);
    assert.deepEqual(ends, []);
    hold = false; held[1].release();
    const view = await observed;
    assert.equal(view.sessionId, id);
    assert.equal(view.currentComparisonId, "trial");
    assert.equal(view.revision, authoritative.revision);
    assert.equal((await shell.pair.controller.end("left", view.currentComparisonId, view.revision)).ok, true);
    assert.equal(ends.length, 1, "only one End request; no stale-action retries");
    assert.equal(ends[0].expectedRevision, authoritative.revision);
    await f.unchanged(assert);
  } finally {
    hold = false; shell.close();
    for (const item of held) item.release();
    dom.window.close();
  }
});
