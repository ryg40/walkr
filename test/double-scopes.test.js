import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import * as css from "css-tree";
import { fixture } from "./double-fixtures.js";
import { validateDoubleInput } from "../src/double-input.js";
import { DoubleSessionStore } from "../src/double-session.js";

const PAGE = '<!doctype html><html><head></head><body><section data-double-id="whole" data-double-scope="group" data-container="Whole report"><div data-double-id="frame" data-double-scope="frame" data-container="Frame only" style="padding:12px;border:2px solid red;background:white"><p data-double-id="item" data-container="Item">Keep my text</p></div></section></body></html>';

async function setup(t) {
  const f = await fixture(t, "scoped");
  await fs.writeFile(path.join(f.manifest.panes.left.copy.root, "index.html"), PAGE);
  const store = new DoubleSessionStore({ archiveDir: f.archiveDir, stateDir: f.stateDir });
  await store.create({ sessionId: "scopes", brief: "Test independent targets", manifest: f.manifest });
  let id = 0;
  const act = async (action) => {
    const view = await store.read("scopes");
    return store.mutate("scopes", "act", { actionId: `act-${++id}`, expectedRevision: view.revision, comparisonId: "scoped", action });
  };
  const end = async () => {
    const view = await store.read("scopes");
    await store.mutate("scopes", "end", { actionId: "end", expectedRevision: view.revision, comparisonId: "scoped", pane: "left" });
    const output = await store.output("scopes");
    const html = Buffer.from(output.page.files.find((file) => file.path === output.page.entry).base64, "base64").toString();
    return { output, doc: new JSDOM(html).window.document };
  };
  return { f, store, act, end };
}

test("explicit group and frame scopes validate while ordinary nested regions still reject", async (t) => {
  const { f } = await setup(t);
  const result = await validateDoubleInput(f.manifest);
  assert.equal(result.ok, true);
  const components = result.comparison.panes.left.components;
  assert.deepEqual(components.map((c) => [c.id, c.scope ?? null, c.parentId ?? null]), [["whole", "group", null], ["frame", "frame", "whole"], ["item", null, "frame"]]);
  await fs.writeFile(path.join(f.manifest.panes.left.copy.root, "index.html"), PAGE.replace('data-double-scope="frame"', 'data-double-scope="arbitrary"'));
  assert.equal((await validateDoubleInput(f.manifest)).diagnostics[0].code, "INVALID_SCOPE");
});

test("frame deletion removes decoration but retains contents in final output", async (t) => {
  const { act, end } = await setup(t);
  await act({ kind: "keeper", pane: "left", componentId: "item", selected: true });
  await act({ kind: "delete", pane: "left", componentId: "frame" });
  const { output, doc } = await end();
  assert.deepEqual(output.page.deletedComponentIds, ["frame"]);
  const frame = doc.querySelector("[data-double-id=frame]");
  // jsdom drops this background from its style object, so read the declarations semantically.
  const declared = Object.fromEntries(css.toPlainObject(css.parse(frame.getAttribute("style"), { context: "declarationList" })).children
    .map((d) => [d.property, [css.generate(d.value), d.important]]));
  for (const property of ["background", "border", "padding"]) assert.equal(declared[property][1], true, property);
  assert.deepEqual(["background", "padding"].map((p) => declared[p][0]), ["transparent", "0"]);
  assert.notEqual(frame.style.display, "none");
  assert.equal(doc.querySelector("[data-double-id=item]").textContent, "Keep my text");
  assert.deepEqual(output.history[0].payload.keepers.map((e) => e.identity.componentId), ["item"]);
  assert.equal(output.history[0].payload.plainDeletions[0].scope, "frame");
});

for (const keep of [true, false]) {
  test(`whole ${keep ? "keep" : "discard"} overrides child decisions without changing their saved state`, async (t) => {
    const { act, end } = await setup(t);
    await act({ kind: "delete", pane: "left", componentId: "item" });
    await act(keep ? { kind: "keeper", pane: "left", componentId: "whole", selected: true } : { kind: "delete", pane: "left", componentId: "whole" });
    const { output, doc } = await end();
    assert.deepEqual(output.page.deletedComponentIds, keep ? [] : ["whole"]);
    assert.notEqual(doc.querySelector("[data-double-id=item]").style.display, "none", "child deletion is overridden");
    assert.equal(doc.querySelector("[data-double-id=whole]").style.display, keep ? "" : "none");
    assert.deepEqual(output.history[0].payload.plainDeletions.map((e) => e.identity.componentId), keep ? [] : ["whole"]);
    assert.deepEqual(output.history[0].payload.overridden.map((e) => [e.identity.componentId, e.deleted, e.controllingGroupId]), [["item", true, "whole"]]);
  });
}

test("clearing a group restores earlier child decisions across restart and keeps comment evidence", async (t) => {
  const { f, store, act, end } = await setup(t);
  await act({ kind: "keeper", pane: "left", componentId: "frame", selected: true });
  await act({ kind: "delete", pane: "left", componentId: "item" });
  await act({ kind: "comment", pane: "left", componentId: "item", feedback: "Replace this text." });
  await act({ kind: "keeper", pane: "left", componentId: "whole", selected: true });
  await act({ kind: "delete", pane: "left", componentId: "whole" });
  const view = await store.read("scopes");
  const deletion = view.comparison.panes.left.components[0].deletionActionId;
  const request = { actionId: "clear-group", expectedRevision: view.revision, comparisonId: "scoped", action: { kind: "clear", deletionActionId: deletion } };
  const first = await store.mutate("scopes", "act", request);
  const restarted = new DoubleSessionStore({ archiveDir: f.archiveDir, stateDir: f.stateDir });
  assert.deepEqual((await restarted.mutate("scopes", "act", request)).result, first.result);
  const cleared = await restarted.read("scopes");
  assert.equal(cleared.comparison.panes.left.components[0].keeper, false);
  assert.equal(cleared.comparison.panes.left.components[0].deleted, false);
  assert.equal(cleared.comparison.panes.left.components[1].keeper, true);
  assert.equal(cleared.comparison.panes.left.components[2].deleted, true);
  const { output } = await end();
  assert.deepEqual(output.page.deletedComponentIds, ["item"]);
  assert.deepEqual(output.history[0].payload.keepers.map((e) => e.identity.componentId), ["frame"]);
  assert.equal(output.history[0].payload.feedback[0].comment, "Replace this text.");
});
