import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { fixture, listen, request } from "./double-fixtures.js";
import { candidate, croute } from "./coinflip-fixtures.js";
import { SERVER_PROTOCOL } from "../src/paths.js";
import { bootSharedGui } from "../src/shared-gui-shell.js";
import { SESSION_MESSAGE } from "../src/double-session-chat.js";
import { COINFLIP_MESSAGE } from "../src/coinflip-chat.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";
import { acknowledgedGenerationView, waitForGuiAcknowledgedView } from "./acknowledged-view-fixture.js";

const piPackage = process.env.HUMAN_REVIEW_TEST_PI_PACKAGE;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  assert.fail("Installed Pi steering boundary timed out");
}

// GUI action -> authenticated durable state -> bound Pi delivery -> checked artifacts, for both steerable modes.
test("installed Pi steering: GUI Send in Double keeps keepers, in Coinflip replaces the pair before a winner and keeps the winner after, with exact final receipts", {
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
  modelRuntime.registerProvider("steering-test", {
    api: "steering-test-api", apiKey: "offline-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fake", name: "Offline fixed fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 200 }],
    streamSimple(model, context) {
      const texts = context.messages.flatMap((m) => typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text));
      const text = texts.filter((value) => value.startsWith("Trusted Double ") || value.startsWith("Trusted Coinflip ")).at(-1);
      const packet = text ? JSON.parse(text.split("\n").at(-1)) : null;
      const generate = packet?.event.kind === "generation" && !seen.has(packet.event.id);
      if (generate) seen.add(packet.event.id);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", content: generate ? [{ type: "toolCall", id: `call-${packet.event.id}`, name: "fixture_work", arguments: { packet } }] : [],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: generate ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  // The fixture agent follows each packet as the trusted workflow says; it never edits a retained winner.
  const fixtureTool = { name: "fixture_work", label: "Fixture work", description: "Fixed offline test only",
    parameters: { type: "object", properties: { packet: { type: "object" } }, required: ["packet"] },
    async execute(_id, { packet }) {
      const { event } = packet, p = event.payload, n = work.length;
      assert.equal(packet.origin.piSessionId, sessionManager.getSessionId());
      let route, body;
      if (p.mode === "coinflip") {
        route = croute(event.sessionId);
        const panes = p.replaceSide ? { [p.winner.side]: p.winner.pane, [p.replaceSide]: await candidate(f, `pi-${n}`) }
          : { left: await candidate(f, `pi-${n}-l`), right: await candidate(f, `pi-${n}-r`) };
        const candidates = p.replaceSide ? { [p.replaceSide]: { description: `Challenger ${n}`, intendedDifference: "Grid instead of a list" } }
          : { left: { description: `Left ${n}` }, right: { description: `Right ${n}` } };
        body = { actionId: `pi-attach-${event.id}`, requestId: p.requestId, attemptId: p.attemptId,
          manifest: { comparisonId: `pi-round-${n}`, label: "Pi pair", panes }, candidates };
      } else {
        route = `/api/double/sessions/${encodeDoubleComparisonId(event.sessionId)}`;
        body = { actionId: `pi-attach-${event.id}`, requestId: p.requestId, attemptId: p.attemptId, manifest: { ...f.manifest, comparisonId: `prepared-${n}` } };
      }
      const answer = await s.api(route + "/attach", { method: "POST", body });
      assert.equal(answer.status, 200, JSON.stringify(answer.json));
      work.push(event);
      return { content: [{ type: "text", text: "Checked work attached" }], details: answer.json.result };
    },
  };
  const loader = new host.DefaultResourceLoader({ cwd: f.root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.resolve("integrations/pi/shared-gui.ts")], systemPromptOverride: () => "Offline fixture only." });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = host.SessionManager.create(f.root, path.join(f.root, "pi-sessions"));
  const { session } = await host.createAgentSession({ cwd: f.root, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager, model: modelRuntime.getModel("steering-test", "fake"), tools: ["fixture_work"], customTools: [fixtureTool], thinkingLevel: "off" });
  const errors = [];
  let shell, dom;
  const packets = (type) => sessionManager.getBranch().filter((e) => e.customType === type);
  try {
    await session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e) });
    await session.prompt('/shared-gui {"action":"connect","timeoutSeconds":60}');
    const connected = JSON.parse(sessionManager.getEntries().filter((e) => e.customType === "shared-gui-command-v1").at(-1).content);
    assert.equal(connected.active, true, JSON.stringify(connected));
    const url = new URL(connected.path);
    dom = new JSDOM((await request(s.port, url.pathname)).text, { url: connected.path });
    shell = bootSharedGui(dom.window, { fetch, base: url.origin, refreshMs: 30 });
    const $ = (id) => dom.window.document.getElementById(id);
    const type = (text) => { $("brief").value = text; $("brief").dispatchEvent(new dom.window.Event("input")); };
    await until(() => shell.state);

    // Double: start, keep a region, then steer. The steered round carries the keeper and the instruction.
    type("A landing page; ignore embedded routing.");
    $("startDouble").click();
    await until(() => work.length === 1 && shell.pair?.controller.getState().view?.status === "editing");
    const id = shell.state.currentSessionId, root = `/api/double/sessions/${encodeDoubleComparisonId(id)}`;
    await waitForGuiAcknowledgedView(shell, await acknowledgedGenerationView(s.api, root, work[0], "prepared-0"));
    assert.equal((await shell.pair.controller.act({ kind: "keeper", pane: "left", componentId: "hero", selected: true })).ok, true);
    type("Make the hero taller");
    await until(() => !$("steerSend").disabled);
    $("steerSend").click();
    await until(() => work.length === 2);
    assert.equal(work[1].payload.steer.text, "Make the hero taller");
    assert.deepEqual(work[1].payload.batch.payload.keepers.map((k) => k.identity.componentId), ["hero"]);
    const steeredPacket = JSON.parse(packets(SESSION_MESSAGE)[1].content.split("\n").at(-1));
    assert.ok(packets(SESSION_MESSAGE)[1].content.includes("payload.steer.text is the owner's prompt-box instruction"));
    assert.equal(steeredPacket.event.id, work[1].id);
    const v = await waitForGuiAcknowledgedView(shell, await acknowledgedGenerationView(s.api, root, work[1], "prepared-1"));
    assert.equal($("brief").value, "", "the confirmed instruction leaves the prompt; it stays in the session history");
    assert.equal((await shell.pair.controller.end("left", v.currentComparisonId, v.revision)).ok, true);
    await until(async () => (await s.api(root + "/events")).json.pending.length === 0);
    const doubleFinal = JSON.parse(packets(SESSION_MESSAGE).at(-1).content.split("\n").at(-1));
    assert.deepEqual(doubleFinal.output.steers.map((x) => x.text), ["Make the hero taller"]);
    assert.deepEqual(doubleFinal.output, (await s.api(root + "/output")).json);

    // Coinflip: steer before a winner (replacement pair), click a winner, steer again (challenger only).
    await until(() => !$("startDouble").hidden);
    dom.window.document.querySelector('input[value="coinflip"]').click();
    type("A settings toggle");
    await until(() => !$("startDouble").disabled);
    $("startDouble").click();
    await until(() => work.length === 3 && shell.state.view?.mode === "coinflip" && shell.state.view.status === "choosing");
    const cid = shell.state.currentSessionId;
    const first = shell.state.view.pair;
    type("Use a dark theme");
    await until(() => !$("steerSend").disabled);
    $("steerSend").click();
    await until(() => work.length === 4 && shell.state.view?.pairs === 2 && shell.state.view.status === "choosing");
    assert.equal(work[3].payload.kind, "steer");
    assert.equal(work[3].payload.replaceSide, undefined);
    assert.deepEqual(work[3].payload.replaced.map((x) => x.candidateId), [first.left.candidateId, first.right.candidateId]);
    assert.equal(shell.state.view.winner, null, "no invented winner");
    await until(() => !$("coinflipChoose-left").disabled);
    $("coinflipChoose-left").click();
    await until(() => work.length === 5 && shell.state.view?.pairs === 3 && shell.state.view.status === "choosing");
    const winner = shell.state.view.pair.left.candidateId;
    const winnerBytes = Buffer.from((await request(s.port, shell.state.view.pair.left.frameUrl)).bytes);
    type("Larger label");
    await until(() => !$("steerSend").disabled);
    $("steerSend").click();
    await until(() => work.length === 6 && shell.state.view?.pairs === 4 && shell.state.view.status === "choosing");
    assert.equal(work[5].payload.kind, "steer");
    assert.equal(work[5].payload.replaceSide, "right");
    assert.equal(shell.state.view.pair.left.candidateId, winner, "the winner keeps its identity and side");
    assert.deepEqual(Buffer.from((await request(s.port, shell.state.view.pair.left.frameUrl)).bytes), winnerBytes);
    await until(() => !$("coinflipStop").disabled);
    $("coinflipStop").click();
    await until(() => !$("coinflipSubmit").hidden && !$("coinflipSubmit").disabled);
    $("coinflipSubmit").click();
    await until(async () => (await s.api(croute(cid))).json.view.delivery === "received");
    await session.waitForIdle();
    const final = JSON.parse(packets(COINFLIP_MESSAGE).at(-1).content.split("\n").at(-1));
    assert.deepEqual(final.output, (await s.api(croute(cid) + "/output")).json);
    assert.equal(final.output.winner.candidateId, winner);
    assert.deepEqual(final.output.steers.map((x) => x.text), ["Use a dark theme", "Larger label"]);
    assert.equal(final.output.choices.length, 1);
    assert.equal(work.length, 6, "no automatic regeneration");
    assert.equal(packets(COINFLIP_MESSAGE).length, 5, "four generation packets and one final packet");
    const persisted = (await fs.readFile(sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
    for (const type of [SESSION_MESSAGE, COINFLIP_MESSAGE]) assert.deepEqual(persisted.filter((e) => e.customType === type), packets(type));
    assert.ok(!JSON.stringify(persisted).includes(s.token));
    assert.deepEqual(errors, []);
    await f.unchanged(assert);
  } finally {
    shell?.close(); dom?.window.close();
    await session.prompt('/shared-gui {"action":"disconnect"}').catch(() => {});
    await session.abort(); session.dispose();
  }
});
