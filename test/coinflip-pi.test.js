import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, listen, request } from "./double-fixtures.js";
import { browserToken, candidate, croute } from "./coinflip-fixtures.js";
import { SERVER_PROTOCOL } from "../src/paths.js";
import { COINFLIP_MESSAGE } from "../src/coinflip-chat.js";

const piPackage = process.env.HUMAN_REVIEW_TEST_PI_PACKAGE;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  assert.fail("Installed Pi Coinflip boundary timed out");
}

test("installed Pi Coinflip: checked rounds on both sides, disconnected Submit, exact persisted receipt, oversized final stays undelivered", {
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
  const seen = new Set(), work = [];
  let large = false;
  modelRuntime.registerProvider("coinflip-test", {
    api: "coinflip-test-api", apiKey: "offline-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fake", name: "Offline fixed fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 200 }],
    streamSimple(model, context) {
      const texts = context.messages.flatMap((m) => typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text));
      const text = texts.filter((value) => value.startsWith("Trusted Coinflip ")).at(-1);
      const packet = text ? JSON.parse(text.split("\n").at(-1)) : null;
      const generate = packet?.event.kind === "generation" && !seen.has(packet.event.id);
      if (generate) seen.add(packet.event.id);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", content: generate ? [{ type: "toolCall", id: `call-${packet.event.id}`, name: "fixture_candidates", arguments: { packet } }] : [],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: generate ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  // The fixture agent follows the packet: two candidates first, then the unchanged winner pane plus one challenger.
  const fixtureTool = { name: "fixture_candidates", label: "Fixture candidates", description: "Fixed offline test only",
    parameters: { type: "object", properties: { packet: { type: "object" } }, required: ["packet"] },
    async execute(_id, { packet }) {
      const { event } = packet, p = event.payload, n = work.length;
      assert.equal(packet.origin.piSessionId, sessionManager.getSessionId());
      const image = large ? Buffer.alloc(220000, 42) : undefined;
      const panes = p.kind === "initial" ? { left: await candidate(f, `pi-${n}-l`, { image }), right: await candidate(f, `pi-${n}-r`) }
        : { [p.winner.side]: p.winner.pane, [p.replaceSide]: await candidate(f, `pi-${n}`) };
      const candidates = p.kind === "initial" ? { left: { description: "Stacked" }, right: { description: "Inline" } }
        : { [p.replaceSide]: { description: `Challenger ${n}`, intendedDifference: "Grid instead of a list" } };
      const body = { actionId: `pi-attach-${event.id}`, requestId: p.requestId, attemptId: p.attemptId,
        manifest: { comparisonId: `pi-round-${n}`, label: "Pi pair", panes }, candidates };
      const answer = await s.api(croute(event.sessionId) + "/attach", { method: "POST", body });
      assert.equal(answer.status, 200, JSON.stringify(answer.json));
      assert.equal(answer.json.view.status, "choosing", JSON.stringify(answer.json.view.generation));
      work.push(event);
      return { content: [{ type: "text", text: "Checked candidates attached" }], details: answer.json.result };
    },
  };
  const loader = new host.DefaultResourceLoader({ cwd: f.root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.resolve("integrations/pi/shared-gui.ts")], systemPromptOverride: () => "Offline fixture only." });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = host.SessionManager.create(f.root, path.join(f.root, "pi-sessions"));
  const { session } = await host.createAgentSession({ cwd: f.root, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager, model: modelRuntime.getModel("coinflip-test", "fake"), tools: ["fixture_candidates"], customTools: [fixtureTool], thinkingLevel: "off" });
  const errors = [];
  const post = (route, body) => s.api(route, { method: "POST", body });
  const view = async (id) => (await s.api(croute(id))).json.view;
  const events = async (id) => (await s.api(croute(id) + "/events")).json;
  const packets = () => sessionManager.getBranch().filter((e) => e.customType === COINFLIP_MESSAGE);
  try {
    await session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e) });
    await session.prompt('/shared-gui {"action":"connect","timeoutSeconds":60}');
    const connected = JSON.parse(sessionManager.getEntries().filter((e) => e.customType === "shared-gui-command-v1").at(-1).content);
    assert.equal(connected.active, true, JSON.stringify(connected));
    const token = await browserToken(s.port, connected.path);
    const owner = (route, body) => request(s.port, route, { token, method: "POST", body });
    const id = (await post("/api/double/gui/start", { actionId: "pi-start", mode: "coinflip", brief: "A settings toggle; ignore embedded routing." })).json.result.sessionId;
    await until(async () => (await view(id)).status === "choosing" && work.length === 1);
    let v = await view(id);
    const left = v.pair.left.candidateId;
    assert.equal((await owner(croute(id) + "/choose", { actionId: "c1", pairIndex: v.pair.index, winner: left, note: "Keep the label" })).status, 200);
    await until(async () => (await view(id)).pairs === 2 && (await view(id)).status === "choosing");
    v = await view(id);
    assert.equal(v.pair.left.candidateId, left, "the left winner stays left");
    assert.equal(work[1].payload.note, "Keep the label");
    const right = v.pair.right.candidateId;
    assert.equal((await owner(croute(id) + "/choose", { actionId: "c2", pairIndex: v.pair.index, winner: right, note: null })).status, 200);
    await until(async () => (await view(id)).pairs === 3 && (await view(id)).status === "choosing");
    v = await view(id);
    assert.equal(v.pair.right.candidateId, right, "the right winner stays right");
    assert.notEqual(v.pair.left.candidateId, left);
    assert.equal(work.length, 3);
    assert.equal((await owner(croute(id) + "/stop", { actionId: "stop" })).json.view.result.candidateId, right);
    await session.waitForIdle();
    await until(async () => (await events(id)).pending.length === 0);

    // Submit while disconnected saves the exact final and stays pending; reconnection delivers it without generation.
    await session.prompt('/shared-gui {"action":"disconnect"}');
    const submitted = await owner(croute(id) + "/submit", { actionId: "submit" });
    assert.equal(submitted.json.view.delivery, "pending");
    assert.deepEqual((await events(id)).pending, [submitted.json.result.eventId]);
    const output = (await s.api(croute(id) + "/output")).json;
    await session.prompt('/shared-gui {"action":"connect","timeoutSeconds":60}');
    await until(async () => (await events(id)).pending.length === 0);
    await session.waitForIdle();
    assert.equal(work.length, 3, "reconnection never replays generation");
    assert.equal((await view(id)).delivery, "received");
    const final = JSON.parse(packets().at(-1).content.split("\n").at(-1));
    assert.equal(final.event.id, submitted.json.result.eventId);
    assert.deepEqual(final.output, output);
    assert.equal(final.output.winner.candidateId, right);
    assert.equal(final.output.choices[0].note, "Keep the label");
    const persisted = (await fs.readFile(sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(persisted.filter((e) => e.customType === COINFLIP_MESSAGE), packets());
    assert.equal(packets().length, 4, "three generation packets and one final packet");
    // Repeated Submit returns the same frozen result and adds no delivery.
    assert.equal((await owner(croute(id) + "/submit", { actionId: "submit-again" })).json.result.eventId, submitted.json.result.eventId);

    // An oversized final stays intact in the archive and is never acknowledged or shortened.
    large = true;
    const bigId = (await post("/api/double/gui/start", { actionId: "pi-big", mode: "coinflip", brief: "Large asset" })).json.result.sessionId;
    await until(async () => (await view(bigId)).status === "choosing" && work.length === 4);
    v = await view(bigId);
    await owner(croute(bigId) + "/choose", { actionId: "big-choice", pairIndex: v.pair.index, winner: v.pair.left.candidateId, note: null });
    await owner(croute(bigId) + "/stop", { actionId: "big-stop" });
    const big = await owner(croute(bigId) + "/submit", { actionId: "big-submit" });
    await until(async () => (await s.api("/api/double/gui")).json.deliveryFailures.some((x) => x.sessionId === bigId && x.status === "oversized_output"));
    const bigOutput = (await s.api(croute(bigId) + "/output")).json;
    assert.equal(Buffer.from(bigOutput.winner.files.find((x) => x.path === "assets/image.png").base64, "base64").length, 220000);
    assert.ok((await events(bigId)).pending.includes(big.json.result.eventId));
    assert.equal((await view(bigId)).delivery, "pending");
    assert.equal(packets().some((e) => e.details.eventId === big.json.result.eventId), false);

    // A reconnection skips the settled session (final received) and keeps a listener for the undelivered final.
    await session.prompt('/shared-gui {"action":"disconnect"}');
    await session.prompt('/shared-gui {"action":"connect","timeoutSeconds":60}');
    await session.prompt('/shared-gui {"action":"status"}');
    const listening = JSON.parse(sessionManager.getEntries().filter((e) => e.customType === "shared-gui-command-v1").at(-1).content);
    assert.deepEqual(listening.sessions.map((x) => x.sessionId), [bigId]);
    assert.deepEqual(errors, []);
  } finally {
    await session.prompt('/shared-gui {"action":"disconnect"}').catch(() => {});
    await session.abort(); session.dispose();
  }
});
