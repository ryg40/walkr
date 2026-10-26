import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { FRAME_RESET, controllingGroup } from "../src/double-selection.js";

const SDK = fs.readFileSync(new URL("../src/double-sdk.js", import.meta.url), "utf8");
const CHANNEL = "human-review-double";

/**
 * Load a review copy with the injected SDK into a jsdom frame. The parent is
 * a second jsdom window whose postMessage records what the frame sends.
 * The closed shadow root is captured through attachShadow for inspection.
 */
async function bootFrame(body, { pane = "left", comparisonId = "trial-1", inHead = false, head = "", htmlAttrs = "", headAttrs = "", bodyAttrs = "" } = {}) {
  const parentDom = new JSDOM("<!doctype html><title>shell</title>", { url: "https://review.test/double/x" });
  const posts = [];
  parentDom.window.postMessage = (message, targetOrigin) => posts.push({ message: JSON.parse(JSON.stringify(message)), targetOrigin });
  const roots = [];
  const tag = `<script data-comparison-id="${comparisonId}" data-pane="${pane}">${SDK}</script>`;
  const html = `<!doctype html><html${htmlAttrs}><head${headAttrs}>${head}${inHead ? tag : ""}</head><body${bodyAttrs}>${body}${inHead ? "" : tag}</body></html>`;
  const dom = new JSDOM(html, {
    url: "https://artifact.test/double-artifact/cap/left/index.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "parent", { value: parentDom.window, configurable: true });
      const attach = window.Element.prototype.attachShadow;
      window.Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        roots.push(root);
        return root;
      };
    },
  });
  const { window } = dom;
  if (window.document.readyState === "loading") await new Promise((resolve) => window.document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  const ready = posts.find((p) => p.message.type === "ready");
  const send = (data, source = parentDom.window) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: "https://review.test", source }));
  const state = (components, extra = {}) => send({ channel: CHANNEL, type: "state", comparisonId, pane, components, busy: false, readOnly: false, ...extra });
  const shadow = () => roots[0];
  const clusters = () => [...shadow().querySelectorAll(".cluster")];
  const cluster = (id) => clusters().find((c) => c.dataset.componentId === id);
  const intents = () => posts.filter((p) => p.message.type === "intent").map((p) => p.message);
  return { html, dom, window, document: window.document, parentDom, posts, ready, send, state, shadow, clusters, cluster, intents };
}

const comp = (id, label, extra = {}) => ({ id, label, keeper: false, deleted: false, ...extra });

const PAGE = `
  <header data-double-id="nav" data-container="Navigation"><a href="#hero">Top</a></header>
  <section data-double-id="hero" data-container="Hero" style="color: red; display: grid !important"><h1>Hello</h1></section>
  <section data-double-id="extra" data-container="Not in state"><p>x</p></section>
  <section data-container="Label only"><p>y</p></section>`;

test("SDK posts one namespaced ready message with only nonsecret identity", async () => {
  const f = await bootFrame(PAGE);
  const readies = f.posts.filter((p) => p.message.type === "ready");
  assert.equal(readies.length, 1);
  assert.deepEqual(Object.keys(f.ready.message).sort(), ["channel", "comparisonId", "instance", "pane", "type"]);
  assert.equal(f.ready.message.channel, CHANNEL);
  assert.equal(f.ready.message.comparisonId, "trial-1");
  assert.equal(f.ready.message.pane, "left");
  assert.match(f.ready.message.instance, /^[0-9a-f]{24}$/);
  assert.equal(f.ready.targetOrigin, "*");
  assert.doesNotMatch(SDK, /fetch\(|XMLHttpRequest|x-human-review-token|innerHTML|insertAdjacentHTML/);
});

test("SDK in head waits for the document and still posts ready", async () => {
  const f = await bootFrame(PAGE, { inHead: true });
  assert.ok(f.ready);
  f.state([comp("hero", "Hero")]);
  assert.ok(f.cluster("hero"));
});

test("controls appear only for known components after saved state arrives", async () => {
  const f = await bootFrame(PAGE);
  assert.equal(f.clusters().length, 0, "no controls before parent state");
  f.state([comp("nav", "Navigation"), comp("hero", "Hero"), comp("missing", "Missing")]);
  assert.deepEqual(f.clusters().map((c) => c.dataset.componentId).sort(), ["hero", "nav"]);
  const hero = f.cluster("hero");
  assert.equal(hero.getAttribute("role"), "group");
  assert.equal(hero.getAttribute("aria-label"), "Left component: Hero");
  const [keep, del] = hero.querySelectorAll("button");
  assert.equal(keep.getAttribute("aria-label"), "Keep: Hero");
  assert.equal(keep.getAttribute("aria-pressed"), "false");
  assert.equal(del.getAttribute("aria-label"), "Delete: Hero");
  assert.equal(del.getAttribute("aria-haspopup"), "dialog");
  // The reviewed DOM gains only the host element; components are untouched.
  assert.equal(f.document.querySelector("section").getAttribute("style"), "color: red; display: grid !important");
  assert.equal(f.document.documentElement.lastElementChild.localName, "human-review-double");
});

test("clicks send intentions only and never change state optimistically", async () => {
  const f = await bootFrame(PAGE);
  f.state([comp("hero", "Hero")]);
  const [keep, del] = f.cluster("hero").querySelectorAll("button");
  keep.click();
  del.click();
  const sent = f.intents();
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["channel", "comparisonId", "componentId", "instance", "intent", "pane", "type"]);
  assert.deepEqual(sent.map((m) => [m.intent, m.componentId, m.instance]), [["keeper", "hero", f.ready.message.instance], ["delete", "hero", f.ready.message.instance]]);
  assert.equal(f.cluster("hero").querySelector(".keep").getAttribute("aria-pressed"), "false");
  assert.notEqual(f.document.querySelector("[data-double-id=hero]").style.display, "none");
  f.state([comp("hero", "Hero", { keeper: true })]);
  const keepNow = f.cluster("hero").querySelector(".keep");
  assert.equal(keepNow.getAttribute("aria-pressed"), "true");
  assert.equal(keepNow.getAttribute("aria-label"), "Keeper: Hero");
  assert.ok(f.shadow().querySelector('.outline.keeper[data-component-id="hero"]'));
});

test("session reticles show saved keep/discard selections without hiding review content", async () => {
  const f = await bootFrame(PAGE);
  const before = f.document.querySelector('[data-double-id="hero"]').outerHTML;
  const shell = { controls: "shell", showDiscards: true };
  f.state([comp("hero", "Hero", { keeper: true })], shell);
  assert.equal(f.clusters().length, 0, "no floating keeper/delete pill can cover component text");
  assert.equal(f.shadow().querySelectorAll("button").length, 0);
  assert.ok(f.shadow().querySelector('.outline.keeper[data-component-id="hero"]'));
  assert.equal(f.document.querySelector('[data-double-id="hero"]').outerHTML, before);
  const hero = f.document.querySelector('[data-double-id="hero"]');
  f.state([comp("hero", "Hero", { deleted: true })], shell);
  assert.equal(hero.outerHTML, before, "discard only annotates the review");
  assert.ok(f.shadow().querySelector('.reticle.discard'));
  assert.equal(f.shadow().querySelector('.reticle.keeper'), null);
  f.state([comp("hero", "Hero", { deleted: true })], { controls: "shell", showDiscards: false, readOnly: true });
  assert.equal(hero.style.display, "none", "the final page removes discarded content");
  assert.equal(f.shadow().querySelector('.reticle.discard'), null);
  f.state([comp("hero", "Hero")], shell);
  const restored = f.document.querySelector('[data-double-id="hero"]');
  assert.equal(restored.style.getPropertyValue("display"), "grid");
  assert.equal(restored.style.getPropertyPriority("display"), "important");
  assert.equal(restored.style.getPropertyValue("color"), "red");
  assert.equal(restored.textContent, "Hello");
  f.window.close();
  f.parentDom.window.close();
});

test("session reticles follow component hover and keyboard focus without changing saved state", async (t) => {
  const f = await bootFrame(PAGE);
  t.after(() => { f.window.close(); f.parentDom.window.close(); });
  f.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  const hero = f.document.querySelector('[data-double-id="hero"]');
  const nav = f.document.querySelector('[data-double-id="nav"]');
  for (const node of [hero, nav]) node.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 90 });
  const visible = () => [...f.shadow().querySelectorAll('.reticle')].filter((node) => node.style.display !== 'none');
  const shell = { controls: "shell", showDiscards: true };
  const hover = (node) => node.dispatchEvent(new f.window.MouseEvent("mouseover", { bubbles: true, clientX: 20, clientY: 30 }));
  f.state([comp("hero", "Hero"), comp("nav", "Navigation", { keeper: true })], shell);
  assert.equal(visible().length, 0, "no outlines cover the page at rest");
  hover(hero.querySelector("h1"));
  assert.equal(visible().length, 1);
  assert.equal(visible()[0].dataset.componentId, "hero");
  assert.ok(visible()[0].classList.contains("neutral"));
  assert.equal(f.intents().length, 0, "hover sends no mutation intent");
  f.state([comp("hero", "Hero", { keeper: true }), comp("nav", "Navigation")], shell);
  assert.ok(visible()[0].classList.contains("keeper"), "saved state changes the hovered reticle color");
  f.state([comp("hero", "Hero", { deleted: true }), comp("nav", "Navigation")], shell);
  assert.ok(visible()[0].classList.contains("discard"));
  hover(nav.querySelector("a"));
  assert.deepEqual(visible().map((node) => node.dataset.componentId), ["nav"]);
  hover(f.document.querySelector('[data-double-id="extra"]'));
  assert.equal(visible().length, 0, "unknown components never gain a reticle");
  hover(hero);
  f.document.dispatchEvent(new f.window.MouseEvent("mouseleave"));
  assert.equal(visible().length, 0, "leaving the iframe clears hover");
  const link = nav.querySelector("a");
  link.dispatchEvent(new f.window.FocusEvent("focusin", { bubbles: true }));
  assert.deepEqual(visible().map((node) => node.dataset.componentId), ["nav"]);
  link.dispatchEvent(new f.window.FocusEvent("focusout", { bubbles: true }));
  assert.equal(visible().length, 0);
  hover(hero);
  f.window.dispatchEvent(new f.window.Event("blur"));
  assert.equal(visible().length, 0);
  hover(hero);
  f.state([comp("hero", "Hero", { deleted: true })], { ...shell, showDiscards: false, readOnly: true });
  assert.equal(visible().length, 0, "final deletion has no hover target");
});

test("session hover re-hit-tests after scroll or resize and clears removed targets", async (t) => {
  const f = await bootFrame(PAGE);
  t.after(() => { f.window.close(); f.parentDom.window.close(); });
  f.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  const hero = f.document.querySelector('[data-double-id="hero"]');
  const nav = f.document.querySelector('[data-double-id="nav"]');
  for (const node of [hero, nav]) node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 });
  let hit = hero;
  f.document.elementFromPoint = () => hit;
  const shell = { controls: "shell", showDiscards: true };
  f.state([comp("hero", "Hero"), comp("nav", "Navigation")], shell);
  const visible = () => [...f.shadow().querySelectorAll('.reticle')].filter((node) => node.style.display !== 'none').map((node) => node.dataset.componentId);
  hero.dispatchEvent(new f.window.MouseEvent("mouseover", { bubbles: true, clientX: 10, clientY: 10 }));
  assert.deepEqual(visible(), ["hero"]);
  hit = nav;
  f.window.dispatchEvent(new f.window.Event("scroll"));
  assert.deepEqual(visible(), ["nav"]);
  hit = null;
  f.window.dispatchEvent(new f.window.Event("resize"));
  assert.deepEqual(visible(), []);
  hit = hero;
  f.state([comp("nav", "Navigation")], shell);
  assert.deepEqual(visible(), [], "retired component identity is not highlighted");
});

test("reticle clicks send a cycle intent once and wait for saved state", async (t) => {
  const f = await bootFrame(PAGE);
  t.after(() => { f.window.close(); f.parentDom.window.close(); });
  f.window.requestAnimationFrame = (fn) => { fn(); return 1; };
  const hero = f.document.querySelector('[data-double-id="hero"]');
  hero.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 });
  const shell = { controls: "shell", showDiscards: true };
  f.state([comp("hero", "Hero")], shell);
  hero.dispatchEvent(new f.window.MouseEvent("mouseover", { bubbles: true }));
  hero.click();
  assert.deepEqual(f.intents().map((m) => m.intent), ["cycle"]);
  assert.ok(f.shadow().querySelector('.reticle.neutral'), "no optimistic selection");
  f.state([comp("hero", "Hero", { keeper: true })], shell);
  hero.querySelector('h1').click();
  f.state([comp("hero", "Hero", { deleted: true })], shell);
  hero.click();
  assert.equal(f.intents().length, 3);
  f.state([comp("hero", "Hero")], { ...shell, busy: true });
  hero.click();
  f.state([comp("hero", "Hero")], { ...shell, readOnly: true });
  hero.click();
  assert.equal(f.intents().length, 3, "busy/read-only clicks do nothing");
});

test("group and frame targets preserve child state and project distinct final effects", async (t) => {
  const f = await bootFrame('<section data-double-id="whole" data-container="Whole"><div data-double-id="frame" data-container="Frame" style="padding:12px;border:1px solid red;background:white"><p data-double-id="item" data-container="Item">Text</p></div></section>');
  t.after(() => { f.window.close(); f.parentDom.window.close(); });
  f.window.requestAnimationFrame = (fn) => { fn(); return 1; };
  const nodes = ['whole','frame','item'].map((id) => f.document.querySelector(`[data-double-id="${id}"]`));
  nodes.forEach((node, i) => { node.getBoundingClientRect = () => ({ left: i*10, top: i*10, width: 200-i*20, height: 100-i*20 }); });
  const list = [comp('whole','Whole',{scope:'group'}),comp('frame','Frame',{scope:'frame',parentId:'whole'}),comp('item','Item',{parentId:'frame',deleted:true})];
  const shell = { controls:'shell',showDiscards:true };
  f.state(list,shell);
  f.state([{...list[0],keeper:true},list[1],list[2]],shell);
  nodes[2].click();
  assert.equal(f.intents().length,0,'whole selection overrides child interaction');
  f.state([{...list[0],keeper:true},list[1],list[2]],{...shell,showDiscards:false,readOnly:true});
  assert.notEqual(nodes[2].style.display,'none','whole keep overrides child deletion in final view');
  const original=nodes[1].getAttribute('style');
  f.state([list[0],{...list[1],deleted:true},{...list[2],deleted:false}],{...shell,showDiscards:false,readOnly:true});
  assert.equal(nodes[1].style.background,'transparent');
  assert.equal(nodes[1].style.padding,'0px');
  assert.notEqual(nodes[2].style.display,'none');
  f.state(list,shell);
  assert.equal(nodes[1].getAttribute('style'),original,'frame decoration restores exactly');
  f.state([{...list[0],deleted:true},list[1],{...list[2],deleted:false,keeper:true}],{...shell,showDiscards:false,readOnly:true});
  assert.equal(nodes[0].style.display,'none','whole discard removes the component and contents');
});

test("busy disables every control and read-only removes deletion", async () => {
  const f = await bootFrame(PAGE);
  f.state([comp("hero", "Hero"), comp("nav", "Navigation")], { busy: true });
  for (const button of f.shadow().querySelectorAll("button")) assert.equal(button.disabled, true);
  f.state([comp("hero", "Hero", { keeper: true }), comp("nav", "Navigation")], { readOnly: true });
  assert.equal(f.shadow().querySelectorAll(".delete").length, 0);
  for (const button of f.shadow().querySelectorAll("button")) assert.equal(button.disabled, true);
  assert.equal(f.cluster("hero").querySelector(".keep").getAttribute("aria-pressed"), "true");
});

test("deletion hides the saved component and Undo restores its exact inline style", async () => {
  const f = await bootFrame(PAGE);
  const hero = f.document.querySelector("[data-double-id=hero]");
  const nav = f.document.querySelector("[data-double-id=nav]");
  f.state([comp("hero", "Hero", { deleted: true }), comp("nav", "Navigation")]);
  assert.equal(hero.style.getPropertyValue("display"), "none");
  assert.equal(hero.style.getPropertyPriority("display"), "important");
  assert.equal(f.cluster("hero"), undefined);
  assert.equal(nav.getAttribute("style"), null);
  f.state([comp("hero", "Hero"), comp("nav", "Navigation")]);
  assert.equal(hero.style.getPropertyValue("display"), "grid");
  assert.equal(hero.style.getPropertyPriority("display"), "important");
  assert.equal(hero.style.getPropertyValue("color"), "red");
  assert.ok(f.cluster("hero"));
});

test("frame rejects forged, malformed, and wrong-identity state", async () => {
  const f = await bootFrame(PAGE);
  const good = { channel: CHANNEL, type: "state", comparisonId: "trial-1", pane: "left", components: [comp("hero", "Hero", { deleted: true })], busy: false, readOnly: false };
  const other = new JSDOM("").window;
  const hero = f.document.querySelector("[data-double-id=hero]");
  f.send(good, f.window); // from itself, not the parent
  f.send(good, other); // from another window
  f.send(good, null);
  f.send({ ...good, pane: "right" });
  f.send({ ...good, comparisonId: "trial-2" });
  f.send({ ...good, channel: "other" });
  f.send({ ...good, extra: true });
  f.send({ ...good, busy: "no" });
  f.send({ ...good, components: [{ ...comp("hero", "Hero"), deleted: "yes" }] });
  f.send({ ...good, components: [comp("hero", "Hero"), comp("hero", "Again")] });
  f.send({ ...good, components: [{ ...comp("hero", "Hero"), html: "<b>" }] });
  f.send({ ...good, components: [comp("bad id", "Hero")] });
  f.send("not an object");
  f.send(null);
  assert.equal(f.clusters().length, 0);
  assert.notEqual(hero.style.display, "none");
  f.send(good);
  assert.equal(hero.style.display, "none");
});

test("labels render as text, never markup", async () => {
  const f = await bootFrame(PAGE);
  const evil = `<img src=x onerror="parent.pwned=1">"><script>alert(1)</script>`;
  f.state([comp("hero", evil)]);
  const cluster = f.cluster("hero");
  assert.equal(cluster.querySelector(".name").textContent, evil);
  assert.equal(f.shadow().querySelectorAll("img, script").length, 0);
  assert.equal(cluster.querySelector(".keep").getAttribute("aria-label"), `Keep: ${evil}`);
  assert.equal(f.document.querySelectorAll("img").length, 0);
});

test("a body marker hides body but keeps the host and state channel", async () => {
  const f = await bootFrame("<main><p>Whole page</p></main>", { bodyAttrs: ' data-double-id="page" data-container="Page"' });
  f.state([comp("page", "Page")]);
  assert.equal(f.cluster("page").dataset.tag, "body");
  f.state([comp("page", "Page", { deleted: true })]);
  assert.equal(f.document.body.style.display, "none");
  const host = f.document.documentElement.lastElementChild;
  assert.equal(host.localName, "human-review-double");
  assert.equal(host.parentNode, f.document.documentElement);
  assert.equal(host.style.getPropertyValue("display"), "block");
  // The channel still works: Undo state restores the page.
  f.state([comp("page", "Page")]);
  assert.equal(f.document.body.getAttribute("style"), null);
  assert.ok(f.cluster("page"));
});

test("an html marker never hides html; it hides body and shows a mask", async () => {
  const f = await bootFrame("<p>Doc</p>", { htmlAttrs: ' data-double-id="doc" data-container="Document"' });
  f.state([comp("doc", "Document")]);
  assert.equal(f.cluster("doc").dataset.tag, "html");
  f.state([comp("doc", "Document", { deleted: true })]);
  assert.equal(f.document.documentElement.style.display, "");
  assert.equal(f.document.body.style.display, "none");
  assert.match(f.shadow().querySelector(".mask").textContent, /deleted/);
  f.state([comp("doc", "Document")]);
  assert.equal(f.document.body.style.display, "");
  assert.equal(f.shadow().querySelector(".mask"), null);
});

test("a head marker keeps its controls in the dock and is hidden only while deleted", async () => {
  const f = await bootFrame("<p>Body</p>", { head: "<style>p { color: blue }</style>", headAttrs: ' data-double-id="meta" data-container="Head"' });
  const head = f.document.head;
  f.state([comp("meta", "Head")]);
  const group = f.cluster("meta");
  assert.equal(group.dataset.tag, "head");
  assert.ok(group.closest(".dock"));
  f.state([comp("meta", "Head", { deleted: true })]);
  assert.equal(head.style.getPropertyValue("display"), "none");
  assert.equal(head.style.getPropertyPriority("display"), "important");
  assert.equal(f.cluster("meta"), undefined);
  // The head content stays connected: its style still applies.
  assert.equal(f.window.getComputedStyle(f.document.querySelector("p")).color, "rgb(0, 0, 255)");
  f.state([comp("meta", "Head")]);
  assert.equal(head.getAttribute("style"), null);
  assert.deepEqual(reviewedShape(f.document), unscriptedShape(f.html));
});

/**
 * Displayed heads: an accepted copy can display head inline or from a
 * stylesheet, with pseudo-element content. A saved deletion hides it like any
 * other component, and Undo restores the exact prior inline display.
 */
const DISPLAYED_HEADS = [
  ["inline display:block with a pseudo-element", { headAttrs: ' data-double-id="meta" data-container="Metadata" style="display:block"', head: '<style>head::before { content: "Visible head"; display: block }</style>' }],
  ["inline display:block !important and other styles", { headAttrs: ' data-double-id="meta" data-container="Metadata" style="color: red; display: block !important; margin: 2px"', head: "<title>T</title>" }],
  ["stylesheet display:block !important with a pseudo-element", { headAttrs: ' data-double-id="meta" data-container="Metadata"', head: '<style>head { display: block !important } head::after { content: "Tail" }</style><meta name="description" content="y">' }],
  ["displayed style and script children", { headAttrs: ' data-double-id="meta" data-container="Metadata" style="display: flex"', head: "<style>head, head * { display: block }</style><script>window.headScriptRan = true</script>" }],
];

for (const [name, options] of DISPLAYED_HEADS) {
  for (const inHead of [false, true]) {
    test(`a displayed head (${name}) hides on saved deletion and restores exactly on Undo${inHead ? ", with the SDK in head" : ""}`, async () => {
      const f = await bootFrame("<p>Body</p>", { ...options, inHead });
      const d = f.document;
      const head = d.head;
      const original = unscriptedShape(f.html);
      const children = [...head.children];
      const prior = { value: head.style.getPropertyValue("display"), priority: head.style.getPropertyPriority("display"), css: head.style.cssText };
      assert.notEqual(f.window.getComputedStyle(head).display, "none", "the copy displays its head");
      assert.ok(f.ready, "ready is posted");
      f.state([comp("meta", "Metadata")]);
      assert.deepEqual(reviewedShape(d), original, "saved state alone changes nothing");
      assert.ok(f.cluster("meta").closest(".dock"));
      f.state([comp("meta", "Metadata", { deleted: true })]);
      assert.equal(f.window.getComputedStyle(head).display, "none", "the deleted head is not displayed");
      assert.equal(head.style.getPropertyValue("display"), "none");
      assert.equal(head.style.getPropertyPriority("display"), "important");
      assert.equal(f.cluster("meta"), undefined);
      // Metadata, styles, and scripts stay connected; only the inline display changed.
      assert.deepEqual([...head.children], children);
      for (const child of children) assert.equal(child.isConnected, true);
      assert.equal(d.querySelector("human-review-double").parentNode, d.documentElement);
      const others = (css) => css.split(";").map((x) => x.trim()).filter((x) => x && !x.startsWith("display"));
      assert.deepEqual(others(head.style.cssText), others(prior.css), "other inline styles are unchanged");
      // The state channel still works and Undo restores the exact value and priority.
      f.state([comp("meta", "Metadata")]);
      assert.equal(head.style.getPropertyValue("display"), prior.value);
      assert.equal(head.style.getPropertyPriority("display"), prior.priority);
      assert.deepEqual(reviewedShape(d), original, "Undo restores every reviewed attribute and style");
      assert.ok(f.cluster("meta"));
      f.cluster("meta").querySelector(".keep").click();
      assert.equal(f.intents().at(-1).componentId, "meta");
    });
  }
}

test("the SDK refuses to boot without identity or a separate parent", async () => {
  const bad = await bootFrame(PAGE, { comparisonId: "has space" });
  assert.equal(bad.posts.length, 0);
  const badPane = await bootFrame(PAGE, { pane: "middle" });
  assert.equal(badPane.posts.length, 0);
  const dom = new JSDOM(`<p data-double-id="a" data-container="A">x</p><script data-comparison-id="t" data-pane="left">${SDK}</script>`, { runScripts: "dangerously" });
  assert.equal(dom.window.document.querySelector("human-review-double"), null);
});

// ------------------------------------------------------------ accepted identities and counts

test("201-character comparison and component IDs boot and render controls", async () => {
  const comparisonId = `c${"x".repeat(200)}`;
  const id = `h${"y".repeat(200)}`;
  const f = await bootFrame(`<section data-double-id="${id}" data-container="Long">x</section>`, { comparisonId });
  assert.ok(f.ready, "the SDK boots with a long comparison ID");
  f.state([comp(id, "Long")]);
  assert.ok(f.cluster(id));
  f.cluster(id).querySelector(".keep").click();
  assert.equal(f.intents().at(-1).componentId, id);
  f.state([comp(id, "Long", { deleted: true })]);
  assert.equal(f.document.querySelector("section").style.display, "none");
});

test("hostile and path-like IDs stay opaque data", async () => {
  const ids = ['a"]b', "../../etc/passwd", "x\\y", "__proto__", "<b>"];
  const body = ids.map((id, i) => `<section data-double-id="${id.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}" data-container="C${i}">${i}</section>`).join("");
  const f = await bootFrame(body);
  f.state(ids.map((id, i) => comp(id, `C${i}`)));
  assert.deepEqual(f.clusters().map((c) => c.dataset.componentId), ids);
  f.state(ids.map((id, i) => comp(id, `C${i}`, { deleted: i === 0 })));
  assert.equal(f.document.querySelectorAll("section")[0].style.display, "none");
  assert.equal(f.document.querySelectorAll("section")[1].style.display, "");
});

test("501 marked sibling components render controls and apply and restore deletion", async () => {
  const n = 501;
  const body = Array.from({ length: n }, (_, i) => `<section data-double-id="c${i}" data-container="Component ${i}">${i}</section>`).join("");
  const f = await bootFrame(body);
  const list = (deleted) => Array.from({ length: n }, (_, i) => comp(`c${i}`, `Component ${i}`, { deleted: deleted(i) }));
  f.state(list(() => false));
  assert.equal(f.clusters().length, n);
  f.state(list((i) => i === 500 || i === 0));
  const sections = f.document.querySelectorAll("section");
  assert.equal(sections[500].style.display, "none");
  assert.equal(sections[0].style.display, "none");
  assert.equal(sections[250].style.display, "");
  assert.equal(f.clusters().length, n - 2);
  f.state(list(() => false));
  assert.equal(sections[500].getAttribute("style"), null);
  assert.equal(f.clusters().length, n);
});

// ------------------------------------------------------------ inert content

/** True when the node or any flat-tree ancestor, across shadow roots, carries inert. */
function inertInFlatTree(node) {
  for (let n = node; n; n = n.parentNode || n.host) {
    if (n.nodeType === 1 && n.hasAttribute("inert")) return true;
  }
  return false;
}

for (const [where, options, inertContent] of [
  ["the body", { bodyAttrs: ' inert data-double-id="page" data-container="Page"' }, (d) => [d.body]],
  ["ordinary content", {}, (d) => [d.querySelector("[data-double-id=hero]")]],
]) {
  test(`inert on ${where} keeps review content inert and controls usable`, async () => {
    const page = where === "ordinary content"
      ? '<section inert data-double-id="hero" data-container="Hero"><a href="#x">Link</a></section>'
      : "<p>Content</p>";
    const f = await bootFrame(page, options);
    const id = where === "the body" ? "page" : "hero";
    const host = f.document.querySelector("human-review-double");
    f.state([comp(id, "C")]);
    for (const node of inertContent(f.document)) assert.equal(inertInFlatTree(node), true, "reviewed content stays inert");
    assert.equal(inertInFlatTree(host), false, "the control host is outside inert content");
    const keep = f.cluster(id).querySelector(".keep");
    const del = f.cluster(id).querySelector(".delete");
    assert.equal(inertInFlatTree(keep), false);
    assert.equal(keep.disabled, false);
    keep.focus();
    assert.equal(f.shadow().activeElement, keep, "keyboard focus reaches the control");
    keep.click();
    del.click();
    assert.deepEqual(f.intents().map((m) => m.intent), ["keeper", "delete"]);
    f.state([comp(id, "C")], { busy: true });
    assert.equal(f.cluster(id).querySelector(".keep").disabled, true);
    f.state([comp(id, "C", { keeper: true })], { readOnly: true });
    assert.equal(f.cluster(id).querySelector(".delete"), null);
    f.state([comp(id, "C", { deleted: true })]);
    f.state([comp(id, "C")]);
    assert.ok(f.cluster(id));
    for (const node of inertContent(f.document)) assert.equal(inertInFlatTree(node), true);
    assert.equal(inertInFlatTree(f.cluster(id)), false);
  });
}

// ------------------------------------------------------------ Unicode identity

// The input validator's rule: nonempty, no whitespace, no Unicode category C.
const UNICODE_IDS = ["é", "日本語", "✓-mark", "😀", "Ωmega_1", "ß"];
const CATEGORY_C_IDS = ["a\u0085b", "a​b", "a\ud800", "\udc00a", "a­b", "ab", "a͸b", "a\u0007b"];

test("Unicode comparison and component IDs boot, render controls, and send intents", async () => {
  const body = UNICODE_IDS.map((id, i) => `<section data-double-id="${id}" data-container="C${i}">${i}</section>`).join("");
  const f = await bootFrame(body, { comparisonId: "über-✓" });
  assert.ok(f.ready, "a Unicode comparison ID boots");
  f.state(UNICODE_IDS.map((id, i) => comp(id, `C${i}`)));
  assert.deepEqual(f.clusters().map((c) => c.dataset.componentId), UNICODE_IDS);
  f.cluster("😀").querySelector(".keep").click();
  assert.equal(f.intents().at(-1).componentId, "😀");
});

test("category C comparison IDs do not boot", async () => {
  for (const id of ["a\u0085b", "a​b", "a­b"]) {
    const f = await bootFrame(PAGE, { comparisonId: id });
    assert.equal(f.posts.length, 0, `${JSON.stringify(id)} is refused`);
  }
});

test("state with a category C component ID is rejected whole", async () => {
  const f = await bootFrame(PAGE);
  f.state([comp("hero", "Hero")]);
  assert.equal(f.clusters().length, 1);
  for (const id of CATEGORY_C_IDS) {
    f.state([comp("hero", "Hero", { deleted: true }), comp(id, "Bad")]);
    assert.equal(f.clusters().length, 1, `${JSON.stringify(id)} state is ignored`);
    assert.equal(f.document.querySelector("[data-double-id=hero]").style.getPropertyValue("display"), "grid");
  }
});

// ------------------------------------------------------------ reviewed root preservation

/**
 * The attributes of every reviewed element in document order, and the jsdom
 * computed display and visibility of html, head, and body. The SDK host is
 * left out. A style attribute compares by its declarations, because a restored
 * inline property serializes with a final semicolon. jsdom computes only some
 * CSS; it paints nothing.
 */
function reviewedShape(d) {
  const view = d.defaultView;
  const elements = [d.documentElement, ...d.documentElement.querySelectorAll("*")].filter((e) => e.localName !== "human-review-double");
  return {
    attributes: elements.map((e) => [e.localName, ...[...e.attributes].map((a) => `${a.name}=${a.name === "style" ? e.style.cssText : a.value}`)]),
    computed: [d.documentElement, d.head, d.body].map((e) => [e.localName, view.getComputedStyle(e).display, view.getComputedStyle(e).visibility]),
  };
}

/** The same copy parsed without running the SDK. */
const unscriptedShape = (html) => reviewedShape(new JSDOM(html).window.document);

const ROOT_CASES = [
  ["the hidden attribute", { htmlAttrs: " hidden" }],
  ["hidden=until-found", { htmlAttrs: ' hidden="until-found"' }],
  ["inline display:none", { htmlAttrs: ' style="display:none"' }],
  ["inline display:none !important", { htmlAttrs: ' style="display: none !important"' }],
  ["stylesheet display:none", { head: "<style>html { display: none }</style>" }],
  ["stylesheet display:none !important", { head: "<style>:root { display: none !important }</style>" }],
  ["hidden plus inert", { htmlAttrs: " hidden inert" }],
  ["inert alone", { htmlAttrs: ' inert data-double-id="doc" data-container="Document"' }],
  ["hidden overridden visible by CSS", { htmlAttrs: " hidden", head: "<style>html[hidden] { display: block !important }</style>" }],
  ["visible root pseudo-element content", { head: '<style>html::before { content: "Root text" } body::after { content: "Tail" }</style>' }],
  ["hidden root pseudo-element content", { htmlAttrs: " hidden", head: '<style>html::before { content: "Root text"; display: block }</style>' }],
  ["a colored root background", { htmlAttrs: ' hidden style="background: #c00"', head: "<style>html { background: linear-gradient(red, blue) } body { background: green }</style>" }],
];

const HIDDEN_PAGE = `
  <section data-double-id="hero" data-container="Hero" style="color: red; display: grid !important"><h1>Hello</h1></section>
  <section hidden data-double-id="secret" data-container="Secret"><p>Hidden part</p></section>`;

for (const [name, options] of ROOT_CASES) {
  test(`a root with ${name} keeps its reviewed attributes and styles at boot and after Undo`, async () => {
    const f = await bootFrame(HIDDEN_PAGE, options);
    const d = f.document;
    const original = unscriptedShape(f.html);
    assert.deepEqual(reviewedShape(d), original, "boot changes no reviewed attribute or style");
    const states = [comp("hero", "Hero"), comp("secret", "Secret")];
    if (options.htmlAttrs?.includes("doc")) states.push(comp("doc", "Document"));
    f.state(states);
    f.window.dispatchEvent(new f.window.Event("load"));
    assert.deepEqual(reviewedShape(d), original, "saved state and load change no reviewed attribute or style");
    assert.equal(d.querySelector("human-review-double").parentNode, d.documentElement, "only the control host is added");
    assert.ok(f.cluster("hero"), "frame controls still render; the parent shell has the fallback");
    f.state(states, { busy: true });
    f.state(states, { readOnly: true });
    assert.deepEqual(reviewedShape(d), original);
    // A saved deletion is its own effect, and Undo restores the exact prior inline style.
    const hero = d.querySelector("[data-double-id=hero]");
    const secret = d.querySelector("[data-double-id=secret]");
    f.state(states.map((c) => (c.id === "doc" ? c : { ...c, deleted: true })));
    assert.equal(hero.style.getPropertyValue("display"), "none");
    assert.equal(secret.style.getPropertyValue("display"), "none");
    const roots = (shape) => shape.attributes.filter(([tag]) => tag === "html" || tag === "head" || tag === "body");
    assert.deepEqual(roots(reviewedShape(d)), roots(original), "html, head, and body stay untouched");
    assert.deepEqual(reviewedShape(d).computed, original.computed);
    f.state(states);
    assert.equal(hero.style.getPropertyPriority("display"), "important");
    assert.equal(secret.getAttribute("style"), null);
    assert.deepEqual(reviewedShape(d), original, "Undo restores every reviewed style exactly");
  });
}

test("body, html, and head markers in a hidden root restore their exact original state on Undo", async () => {
  const body = await bootFrame("<main><p>Whole page</p></main>", { htmlAttrs: " hidden", bodyAttrs: ' data-double-id="page" data-container="Page" style="color: navy"' });
  const bodyShape = unscriptedShape(body.html);
  body.state([comp("page", "Page")]);
  body.state([comp("page", "Page", { deleted: true })]);
  assert.equal(body.document.body.style.getPropertyValue("display"), "none");
  assert.equal(body.document.documentElement.getAttribute("style"), null, "html is never changed");
  body.state([comp("page", "Page")]);
  assert.equal(body.document.body.style.cssText, "color: navy;");
  assert.deepEqual(reviewedShape(body.document), bodyShape);
  assert.ok(body.cluster("page"));

  const html = await bootFrame("<p>Doc</p>", { htmlAttrs: ' hidden data-double-id="doc" data-container="Document"' });
  const htmlShape = unscriptedShape(html.html);
  html.state([comp("doc", "Document")]);
  assert.equal(html.cluster("doc").dataset.tag, "html");
  html.state([comp("doc", "Document", { deleted: true })]);
  assert.match(html.shadow().querySelector(".mask").textContent, /deleted/);
  assert.equal(html.document.documentElement.getAttribute("style"), null);
  html.state([comp("doc", "Document")]);
  assert.deepEqual(reviewedShape(html.document), htmlShape);
  assert.equal(html.document.documentElement.hasAttribute("hidden"), true);

  const head = await bootFrame("<p>Body</p>", { htmlAttrs: " hidden", headAttrs: ' data-double-id="meta" data-container="Head"' });
  const headShape = unscriptedShape(head.html);
  head.state([comp("meta", "Head")]);
  assert.ok(head.cluster("meta").closest(".dock"));
  head.state([comp("meta", "Head", { deleted: true })]);
  head.state([comp("meta", "Head")]);
  assert.deepEqual(reviewedShape(head.document), headShape);
});

test("a visible root is not changed", async () => {
  const f = await bootFrame(PAGE, { htmlAttrs: ' style="color: blue"' });
  f.state([comp("hero", "Hero")]);
  assert.equal(f.document.documentElement.getAttribute("style"), "color: blue");
  assert.equal(f.document.body.getAttribute("style"), null);
  assert.equal(f.document.head.getAttribute("style"), null);
  assert.deepEqual(reviewedShape(f.document), unscriptedShape(f.html));
});

test("the SDK source has no root adaptation code", () => {
  assert.doesNotMatch(SDK, /removeAttribute\("inert"\)|setAttribute\("inert"|visibility", "hidden"|rootSuppressed|suppressChild/);
});

test("the SDK copies of the frame reset and group precedence match the shared module", () => {
  // The SDK is a classic script, so it keeps its own copies; preview and final output must not drift apart.
  const reset = SDK.match(/var FRAME_RESET = (\{[^}]*\});/);
  assert.ok(reset, "the SDK declares FRAME_RESET");
  assert.deepEqual({ ...vm.runInNewContext(`(${reset[1]})`) }, FRAME_RESET);
  const source = SDK.match(/\n( *)function controllingGroup\(c\) \{[\s\S]*?\n\1\}\n/);
  assert.ok(source, "the SDK declares controllingGroup");
  const variants = [];
  for (const outer of [{}, { keeper: true }, { deleted: true }]) {
    for (const inner of [{}, { keeper: true }, { deleted: true }]) {
      variants.push([
        { id: "whole", scope: "group", ...outer },
        { id: "part", scope: "group", parentId: "whole", ...inner },
        { id: "frame", scope: "frame", parentId: "part", deleted: true },
        { id: "item", parentId: "frame", keeper: true },
        { id: "orphan", parentId: "missing" },
        { id: "loop-a", scope: "group", parentId: "loop-b", keeper: true },
        { id: "loop-b", scope: "group", parentId: "loop-a", deleted: true },
      ]);
    }
  }
  for (const components of variants) {
    const sdk = vm.runInNewContext(`${source[0]}; controllingGroup`, { state: { components } });
    for (const component of components) {
      assert.equal(sdk(component)?.id ?? null, controllingGroup(components, component.id)?.id ?? null, `${component.id} in ${JSON.stringify(components.slice(0, 2))}`);
    }
  }
});
