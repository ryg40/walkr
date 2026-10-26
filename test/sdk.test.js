import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as css from "css-tree";
import { serializeDocument } from "../src/serialize.js";

// jsdom (a dev dependency) needs Node 22+; the library itself supports Node 20.
let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}
const skip = JSDOM ? false : "jsdom unavailable on this Node version";

const CHROME_ORIGIN = "http://localhost:4000";
let seq = 0;
/** The most recent boot, so its pending timers can be flushed before the next one takes the globals. */
let current = null;

/**
 * Boot the editor SDK against a jsdom document standing in for the review
 * iframe. The SDK talks to the chrome only through parent.postMessage, and
 * jsdom's parent is the window itself, so patching postMessage captures
 * every row it reports. Each boot re-imports the module with a cache-busting
 * query so module-level state starts fresh.
 */
async function bootSdk(body) {
  // Every instance posts through the global `parent`. An edit still sitting in
  // a previous instance's flush timer would land in this test's capture, so
  // drain it while the old window is still the global one.
  if (current) {
    current.fromChrome({ type: "eh:flush" });
    current = null;
  }
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, {
    url: "http://127.0.0.1:4000/artifact/t/k/index.html",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const posts = [];
  window.postMessage = (message) => posts.push(JSON.parse(JSON.stringify(message)));
  // jsdom has no layout: give Range the geometry the link popup asks for.
  if (!window.Range.prototype.getBoundingClientRect) {
    const zero = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
    window.Range.prototype.getBoundingClientRect = zero;
    window.Range.prototype.getClientRects = () => [];
  }
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (value) => String(value).replace(/[^\w-]/g, (c) => `\\${c}`);
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name === "undefined" || name in globalThis) continue;
    try {
      globalThis[name] = window[name];
    } catch {}
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    parent: window,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    CSS: window.CSS,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
  });
  seq += 1;
  await import(`../src/sdk.js?boot=${seq}`);
  const fromChrome = (data) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: CHROME_ORIGIN, source: window }));
  const shadow = window.document.querySelector("[data-eh-ui]").shadowRoot;
  current = { fromChrome };
  return { window, document: window.document, posts, fromChrome, shadow };
}

const rows = (posts) => posts.filter((m) => m.type === "eh:edit").map(({ label, kind, before, after }) => ({ label, kind, before, after }));

test("deleting a block reports it, offers undo, and undo restores it", { skip }, async () => {
  const { document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>Keep me.</p><p>Delete me.</p><p>Closing.</p>");
  const target = document.querySelectorAll("p")[1];
  target.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();

  assert.equal(document.querySelectorAll("p").length, 2);
  assert.deepEqual(rows(posts), [{ label: "Plan · p 2", kind: "deleted", before: "Delete me.", after: "" }]);
  assert.ok(posts.some((m) => m.type === "eh:undoable" && m.kind === "deleted" && m.label === "Plan · p 2"));
  assert.ok(posts.some((m) => m.type === "eh:html"), "the file is rewritten without the block");

  fromChrome({ type: "eh:undo", label: "Plan · p 2", kind: "deleted" });
  const texts = [...document.querySelectorAll("p")].map((p) => p.textContent);
  assert.deepEqual(texts, ["Keep me.", "Delete me.", "Closing."], "the block is back where it was");
  assert.ok(posts.some((m) => m.type === "eh:undone" && m.label === "Plan · p 2"), "the chrome is told so it can drop the row");

  // Nothing left to restore under that label: the chrome hears that too.
  fromChrome({ type: "eh:undo", label: "Plan · p 2", kind: "deleted" });
  assert.ok(posts.some((m) => m.type === "eh:undoFailed"));
});

test("older deletes stay restorable, and ⌘Z undoes the latest one unless typing came after", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p><p>Three.</p>");
  const [one, two, three] = document.querySelectorAll("p");
  for (const p of [one, two]) {
    p.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    shadow.getElementById("chipDelete").click();
  }
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["Three."]);

  // The first deletion, not the most recent, restores from the edit list.
  fromChrome({ type: "eh:undo", label: "Plan · p 1", kind: "deleted" });
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Three."]);

  // ⌘Z right after the remaining deletion brings the second one back.
  document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two.", "Three."]);

  // After typing, ⌘Z is the browser's own undo again: nothing of ours moves.
  three.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  one.dispatchEvent(new window.Event("input", { bubbles: true }));
  const zed = new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(zed);
  assert.equal(zed.defaultPrevented, false);
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two."]);
  assert.equal(posts.filter((m) => m.type === "eh:undone").length, 2);
});

test("typing over a selection that spans blocks reports every block it touched", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Goals</h2><p>First goal paragraph.</p><p>Second goal paragraph.</p>");
  const [first, second] = document.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(first.firstChild, 6);
  range.setEnd(second.firstChild, 7);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  first.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  // What the browser does for a keystroke over that selection: the first
  // block absorbs the remainder of the second, which disappears.
  first.textContent = "First Xgoal paragraph.";
  second.remove();
  first.dispatchEvent(new window.Event("input", { bubbles: true }));
  fromChrome({ type: "eh:flush" });

  assert.deepEqual(rows(posts), [
    { label: "Goals · p 1", kind: "edited", before: "First goal paragraph.", after: "First Xgoal paragraph." },
    { label: "Goals · p 2", kind: "deleted", before: "Second goal paragraph.", after: "" },
  ]);
});

test("a keyboard selection opens the compose card when the key is released", { skip }, async () => {
  const { window, document, posts } = await bootSdk("<h1>Plan</h1><p>Select these words with the keyboard.</p>");
  const p = document.querySelector("p");
  const range = document.createRange();
  range.setStart(p.firstChild, 7);
  range.setEnd(p.firstChild, 12);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
  p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const compose = posts.filter((m) => m.type === "eh:compose");
  assert.equal(compose.length, 1, "one card for the settled selection, not one per keystroke");
  assert.equal(compose[0].kind, "selection");
  assert.equal(compose[0].quote, "these");
});

test("labels number siblings by their order at load, so a deletion does not renumber the rest", { skip }, async () => {
  const { document, posts, shadow } = await bootSdk("<h2>Goals</h2><p>One.</p><p>Two.</p><p>Three.</p>");
  const paragraphs = document.querySelectorAll("p");
  paragraphs[1].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  paragraphs[2].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  assert.deepEqual(
    rows(posts).map((r) => r.label),
    ["Goals · p 2", "Goals · p 3"],
    "the third paragraph keeps its number after the second is gone"
  );
});

/**
 * jsdom has no execCommand. This stand-in does what Chrome does for the two
 * commands the list paths use: delete the selection, and turn the block the
 * caret is in into a list item. It fires the input event Chrome fires too.
 */
function installExecCommand(window) {
  window.document.execCommand = (command) => {
    const document = window.document;
    const sel = window.getSelection();
    if (command === "delete") {
      if (sel.rangeCount) sel.getRangeAt(0).deleteContents();
      document.body.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    }
    if (command === "insertUnorderedList" || command === "insertOrderedList") {
      let node = sel.anchorNode;
      let block = node && (node.nodeType === 1 ? node : node.parentElement);
      while (block && block !== document.body && !/^(p|div|h[1-6])$/i.test(block.tagName)) block = block.parentElement;
      if (!block || block === document.body) return false;
      const list = document.createElement(command === "insertOrderedList" ? "ol" : "ul");
      const item = document.createElement("li");
      while (block.firstChild) item.appendChild(block.firstChild);
      list.appendChild(item);
      block.replaceWith(list);
      const range = document.createRange();
      range.selectNodeContents(item);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      item.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    }
    return false;
  };
}

test("typing a list marker turns the paragraph into a list under the paragraph's own label", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Goals</h2><p>-Ship it.</p>");
  installExecCommand(window);
  const p = document.querySelector("p");
  const range = document.createRange();
  range.setStart(p.firstChild, 1);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const space = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  p.dispatchEvent(space);
  assert.equal(space.defaultPrevented, true, "the marker keystroke is consumed");
  assert.equal(document.querySelector("ul li").textContent, "Ship it.");
  fromChrome({ type: "eh:flush" });
  assert.deepEqual(rows(posts), [{ label: "Goals · p", kind: "edited", before: "-Ship it.", after: "Ship it." }]);
  const row = posts.find((m) => m.type === "eh:edit");
  assert.match(row.after_html, /^<li>Ship it\.<\/li>$/);
});

test("⌘K on an existing link retargets it, and Remove unwraps it, each as one edit row", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk('<h2>Links</h2><p>Read <a href="https://old.example">the spec</a> first.</p>');
  const anchor = document.querySelector("a");
  const caret = document.createRange();
  caret.setStart(anchor.firstChild, 2);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);

  const k = new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
  anchor.dispatchEvent(k);
  assert.equal(k.defaultPrevented, true);
  const input = shadow.getElementById("linkInput");
  assert.equal(input.value, "https://old.example", "the popup opens on the link's current target");
  input.value = "new.example/spec";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(anchor.getAttribute("href"), "https://new.example/spec", "a bare domain gets a scheme");
  fromChrome({ type: "eh:flush" });
  assert.deepEqual(rows(posts), [{ label: "Links · p", kind: "edited", before: "Read the spec first.", after: "Read the spec first." }]);
  assert.match(posts.find((m) => m.type === "eh:edit").after_html, /href="https:\/\/new\.example\/spec"/);

  posts.length = 0;
  sel.removeAllRanges();
  sel.addRange(caret);
  anchor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
  shadow.getElementById("linkRemove").click();
  assert.equal(document.querySelector("a"), null, "the link is gone, its text stays");
  assert.equal(document.querySelector("p").textContent, "Read the spec first.");
  fromChrome({ type: "eh:flush" });
  const removed = posts.find((m) => m.type === "eh:edit");
  assert.equal(removed.after_html, "<p>Read the spec first.</p>");
});

test("a plain click reaches tabs and toggles, but not bare buttons or links", { skip }, async () => {
  const { window, document } = await bootSdk(
    `<button type="button" id="tab" aria-expanded="false"><span>Find work to automate</span></button>
     <div role="tab" id="roletab">Advisor</div>
     <button type="button" id="bare">Delete item</button>
     <a href="/next"><button type="button" id="linked" aria-expanded="false">Next page</button></a>`
  );
  const reached = new Set();
  for (const id of ["tab", "roletab", "bare", "linked"]) document.getElementById(id).addEventListener("click", () => reached.add(id));
  const click = (el, init = {}) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };

  assert.equal(click(document.querySelector("#tab span")).defaultPrevented, false, "clicking the tab's title switches the tab");
  click(document.getElementById("roletab"));
  assert.equal(click(document.getElementById("bare")).defaultPrevented, true);
  assert.equal(click(document.getElementById("linked")).defaultPrevented, true, "a toggle inside a link still never navigates");
  assert.deepEqual([...reached].sort(), ["roletab", "tab"]);

  click(document.getElementById("bare"), { metaKey: true });
  assert.ok(reached.has("bare"), "⌘-click still runs a bare button");
});

test("a pasted image lands at the caret once the chrome confirms where it was saved", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Design</h2><p>Before the image.</p>");
  const p = document.querySelector("p");
  const caret = document.createRange();
  caret.setStart(p.firstChild, p.firstChild.length);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);

  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => ({ type: "image/png", arrayBuffer: async () => new ArrayBuffer(4) }) }] },
  });
  p.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true, "the SDK owns image pastes");
  for (let i = 0; i < 50 && !posts.some((m) => m.type === "eh:asset"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const asset = posts.find((m) => m.type === "eh:asset");
  assert.ok(asset, "the bytes go to the chrome to be saved");
  assert.equal(asset.assetType, "image/png");

  fromChrome({ type: "eh:assetSaved", id: asset.id, src: "assets/design-paste-1.png" });
  const img = document.querySelector("p img");
  assert.ok(img, "the image is inserted at the caret");
  assert.equal(img.getAttribute("src"), "assets/design-paste-1.png");
  const row = posts.find((m) => m.type === "eh:edit");
  assert.equal(row.label, "Design · p");
  assert.equal(row.before, "Before the image.");
  assert.match(row.after_html, /<img src="assets\/design-paste-1\.png"/);
});

// ------------------------------------------------------------ selection reticle

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const frame = (window) => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
/** The reticle box as the reviewer sees it, or null when it is hidden. */
const reticle = (shadow) => {
  const box = shadow.getElementById("activeBox");
  if (box.style.display !== "block") return null;
  return { left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height };
};
/** Whether the reticle shows around the component, with the same gap outside it on each side. */
const around = (shadow, el) => {
  const box = reticle(shadow);
  if (!box) return false;
  const [left, top, width, height] = [box.left, box.top, box.width, box.height].map(parseFloat);
  const r = el.getBoundingClientRect();
  const gaps = [r.left - left, r.top - top, left + width - r.right, top + height - r.bottom];
  return gaps[0] > 0 && gaps.every((gap) => gap === gaps[0]);
};
/** Each rule of a style sheet as selector -> { property: value }. */
function rules(text) {
  const out = {};
  css.walk(css.parse(text), {
    visit: "Rule",
    enter(node) {
      const declarations = (out[css.generate(node.prelude)] ||= {});
      node.block.children.forEach((d) => { declarations[d.property] = css.generate(d.value); });
    },
  });
  return out;
}

test("a clicked block gets the green reticle, apart from the hover outline, and the block stays as it was", { skip }, async () => {
  const { window, document, posts, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  const two = document.querySelectorAll("p")[1];
  const before = two.outerHTML;
  two.getBoundingClientRect = () => rect(10, 100, 200, 40);

  two.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  assert.equal(shadow.getElementById("outline").style.display, "block", "hover shows the plain outline");
  assert.equal(reticle(shadow), null, "hover alone is not a selection");

  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  assert.ok(posts.some((m) => m.type === "eh:compose" && m.kind === "element"));
  assert.ok(around(shadow, two), "the reticle stands just outside the block");
  const box = shadow.getElementById("activeBox");
  assert.ok(box.classList.contains("reticle") && !box.classList.contains("outline"), "selection and hover are different marks");
  for (const corner of ["tl", "tr", "bl", "br"]) assert.ok(box.querySelector(`.corner.${corner}`), `corner ${corner}`);
  assert.equal(two.outerHTML, before, "the reviewed block gains nothing");
  assert.doesNotMatch(serializeDocument(document), /activeBox|reticle|corner/, "saved HTML has no reticle");
});

test("the reticle takes no clicks, glows Double keep green, and loads nothing", { skip }, async () => {
  const { shadow } = await bootSdk("<p>One.</p>");
  const text = shadow.querySelector("style").textContent;
  const core = rules(text);
  assert.equal(core[".box"]["pointer-events"], "none", "clicks pass through to the component");
  assert.ok(Object.entries(core).every(([selector, d]) => !/reticle|corner/.test(selector) || !("pointer-events" in d)));
  assert.match(core[".reticle"].filter, /drop-shadow\(/, "a glow");
  assert.doesNotMatch(text, /url\(|@import/, "no new network access from the frame");

  // Core and Double draw the same corners in the same green.
  const source = fs.readFileSync(new URL("../src/double-sdk.js", import.meta.url), "utf8");
  const strings = source.match(/var STYLE = \[([\s\S]*?)\]\.join/)[1].replace(/,\s*$/, "");
  const double = rules(JSON.parse(`[${strings}]`).join("\n"));
  assert.equal(core[".reticle"].color, double[".outline.reticle"].color);
  for (const corner of ["tl", "tr", "bl", "br"]) {
    assert.ok(Object.keys(core).some((selector) => selector.includes(`.${corner}`)), `corner ${corner} is drawn`);
  }
});

test("the reticle follows scroll, window resize, and a change of the block size", { skip }, async () => {
  const observed = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observed.push(this); this.targets = []; }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
  };
  let booted;
  try {
    booted = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  } finally {
    delete globalThis.ResizeObserver;
  }
  const { window, document, shadow } = booted;
  const two = document.querySelectorAll("p")[1];
  let at = rect(10, 100, 200, 40);
  two.getBoundingClientRect = () => at;
  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  assert.ok(around(shadow, two));
  assert.ok(observed[0].targets.includes(two), "the selected block is watched for size changes");

  at = rect(10, 40, 200, 40);
  window.dispatchEvent(new window.Event("scroll"));
  await frame(window);
  assert.ok(around(shadow, two), "scrolled with the page");

  at = rect(10, 40, 120, 40);
  window.dispatchEvent(new window.Event("resize"));
  await frame(window);
  assert.ok(around(shadow, two), "resized with the window");

  at = rect(10, 40, 120, 90);
  observed[0].callback([]);
  await frame(window);
  assert.ok(around(shadow, two), "grew with its content");
});

test("typing keeps the reticle on the edited block until the selection moves or ends", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  const [one, two] = document.querySelectorAll("p");
  one.getBoundingClientRect = () => rect(10, 50, 200, 20);
  two.getBoundingClientRect = () => rect(10, 100, 200, 20);

  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  window.getSelection().collapse(two.firstChild, 1);
  two.firstChild.data = "TXwo.";
  two.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.ok(posts.some((m) => m.type === "eh:dismiss"), "typing retires the comment card");
  // The chrome answers the dismiss with a cancel; the edit keeps its reticle.
  fromChrome({ type: "eh:cancel" });
  assert.ok(around(shadow, two));

  one.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  assert.ok(around(shadow, one), "a click on another block moves it");
  fromChrome({ type: "eh:cancel" });
  assert.equal(reticle(shadow), null, "cancelling the card ends the selection");

  one.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  document.body.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  // The chrome cancels an empty card when it hears the dismiss.
  assert.ok(posts.at(-1).type === "eh:dismiss");
  fromChrome({ type: "eh:cancel" });
  assert.equal(reticle(shadow), null, "a click outside any block ends it");

  // With no card open (an edit only), the outside click ends it at once.
  window.getSelection().collapse(two.firstChild, 1);
  two.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.ok(around(shadow, two));
  window.getSelection().removeAllRanges();
  document.body.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  assert.equal(reticle(shadow), null, "a click outside any block ends an edit selection");
});

test("a committed or activated comment keeps the reticle on its block until it is removed", { skip }, async () => {
  const { window, document, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  const [one, two] = document.querySelectorAll("p");
  one.getBoundingClientRect = () => rect(10, 50, 200, 20);
  two.getBoundingClientRect = () => rect(10, 100, 200, 20);

  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  fromChrome({ type: "eh:commit", id: "c1" });
  assert.equal(two.getAttribute("data-eh-el"), "c1");
  assert.ok(around(shadow, two), "the new comment is the active one");

  one.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  fromChrome({ type: "eh:cancel" });
  fromChrome({ type: "eh:activate", id: "c1" });
  assert.ok(around(shadow, two), "a comment card click selects its block again");

  fromChrome({ type: "eh:remove", id: "c1" });
  assert.equal(reticle(shadow), null);

  // A text comment marks the block that holds the quote, not the inline highlight.
  const range = document.createRange();
  range.setStart(one.firstChild, 0);
  range.setEnd(one.firstChild, 3);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  one.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(around(shadow, one), "selected text selects its block");
  fromChrome({ type: "eh:commit", id: "c2" });
  assert.equal(one.querySelector("mark").textContent, "One");
  assert.ok(around(shadow, one), "the saved text comment keeps it there");
});

test("text selected across two sibling blocks marks the block where it starts, as its saved comment does", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<p>First paragraph.</p><p>Second paragraph.</p>");
  const [first, second] = document.querySelectorAll("p");
  first.getBoundingClientRect = () => rect(10, 50, 200, 20);
  second.getBoundingClientRect = () => rect(10, 100, 200, 20);
  const range = document.createRange();
  range.setStart(first.firstChild, 2);
  range.setEnd(second.firstChild, 4);
  window.getSelection().addRange(range);
  first.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(posts.some((m) => m.type === "eh:compose" && m.kind === "selection"), "the comment card opens");
  assert.ok(around(shadow, first), "the block where the selection starts is marked");

  fromChrome({ type: "eh:commit", id: "c1" });
  fromChrome({ type: "eh:activate", id: "c1" });
  assert.ok(around(shadow, first), "activating the saved comment marks the same block");
});

test("text selected from the very end of one block into the next marks the block of the first selected text", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<p>First paragraph.</p><p>Second paragraph.</p>");
  const [first, second] = document.querySelectorAll("p");
  first.getBoundingClientRect = () => rect(10, 50, 200, 20);
  second.getBoundingClientRect = () => rect(10, 100, 200, 20);
  const range = document.createRange();
  range.setStart(first.firstChild, first.firstChild.length);
  range.setEnd(second.firstChild, 4);
  window.getSelection().addRange(range);
  first.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(posts.some((m) => m.type === "eh:compose" && m.kind === "selection" && m.quote === "Seco"), "the comment card opens");
  assert.ok(around(shadow, second), "the block that holds the selected text is marked, not the unselected start block");

  fromChrome({ type: "eh:commit", id: "c1" });
  assert.equal(second.querySelector("mark").textContent, "Seco");
  assert.ok(around(shadow, second), "the saved comment keeps the same block");
});

test("text selected from the end of one block across separator whitespace marks the block of the first selected text", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<p>First paragraph.</p> \n <p>Second paragraph.</p>");
  const [first, second] = document.querySelectorAll("p");
  first.getBoundingClientRect = () => rect(10, 50, 200, 20);
  second.getBoundingClientRect = () => rect(10, 100, 200, 20);
  const range = document.createRange();
  range.setStart(first.firstChild, first.firstChild.length);
  range.setEnd(second.firstChild, 4);
  window.getSelection().addRange(range);
  first.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(posts.some((m) => m.type === "eh:compose" && m.kind === "selection" && m.quote.endsWith("Seco")), "the comment card opens");
  assert.ok(around(shadow, second), "the separator whitespace under <body> does not hide the reticle");

  fromChrome({ type: "eh:commit", id: "c1" });
  assert.equal(second.querySelector("mark").textContent, "Seco");
  assert.ok(around(shadow, second), "the saved comment keeps the same block");
  fromChrome({ type: "eh:activate", id: "c1" });
  assert.ok(around(shadow, second), "activating the saved comment marks the same block");
});

/** A ResizeObserver that, as browsers do, reports each new target once after observe(). */
function stubResizeObserver() {
  const log = { observers: [], observed: [], unobserved: [] };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); log.observers.push(this); }
    observe(target) {
      this.targets.add(target);
      log.observed.push(target);
      setTimeout(() => this.callback([]), 0);
    }
    unobserve(target) { this.targets.delete(target); log.unobserved.push(target); }
    disconnect() { this.targets.clear(); }
  };
  return log;
}

async function bootWithResizeObserver(body) {
  const log = stubResizeObserver();
  try {
    return { ...(await bootSdk(body)), log };
  } finally {
    delete globalThis.ResizeObserver;
  }
}

const linkboxOpen = (shadow) => !["", "none"].includes(shadow.getElementById("linkbox").style.display);

test("the ⌘K link popup stays open through size changes of the page and closes on scroll", { skip }, async () => {
  const { window, document, shadow, log } = await bootWithResizeObserver("<h1>Plan</h1><p>One two three.</p>");
  await settle();
  await frame(window);
  const p = document.querySelector("p");
  p.getBoundingClientRect = () => rect(10, 50, 200, 20);
  const select = () => {
    const range = document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, 3);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", shiftKey: true, bubbles: true }));
  };
  select();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(around(shadow, p), "selected text selects its block");

  p.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.ok(linkboxOpen(shadow), "the popup opens");
  await settle();
  await frame(window);
  await frame(window);
  assert.ok(linkboxOpen(shadow), "the initial ResizeObserver notification leaves it open");

  // An image load grows the page while the popup is open.
  log.observers[0].callback([]);
  await frame(window);
  assert.ok(linkboxOpen(shadow), "a later size change leaves it open");

  window.dispatchEvent(new window.Event("scroll"));
  await frame(window);
  assert.ok(!linkboxOpen(shadow), "a scroll still closes it, as before");
});

test("a selected block that a re-render detaches is no longer watched", { skip }, async () => {
  const { window, document, log } = await bootWithResizeObserver("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  const two = document.querySelectorAll("p")[1];
  two.getBoundingClientRect = () => rect(10, 100, 200, 40);
  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  assert.ok(log.observers[0].targets.has(two));
  two.replaceWith(two.cloneNode(true));
  // Browsers report a detached target with a zero size.
  log.observers[0].callback([]);
  await frame(window);
  assert.ok(!log.observers[0].targets.has(two), "the detached block is unobserved");
  assert.ok(log.observers[0].targets.has(document.documentElement), "<html> stays watched");
});

test("the reticle follows its block after a move by drag and after Undo of the move", { skip }, async () => {
  const { window, document, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p><p>Three.</p>");
  const [one, two, three] = document.querySelectorAll("p");
  // Each block sits where its place among its siblings puts it.
  for (const el of document.body.children) {
    if (el.matches("[data-eh-ui]")) continue;
    el.getBoundingClientRect = () => rect(10, 100 + 40 * [...el.parentNode.children].indexOf(el), 200, 30);
  }
  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  const before = reticle(shadow).top;

  // Drag "One." below "Three.": "Two." moves up one place.
  document.elementFromPoint = () => three;
  one.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  const point = { bubbles: true, clientX: 50, clientY: parseFloat(three.getBoundingClientRect().top) + 25 };
  shadow.getElementById("mover").dispatchEvent(new window.MouseEvent("pointerdown", point));
  window.dispatchEvent(new window.MouseEvent("pointermove", point));
  window.dispatchEvent(new window.MouseEvent("pointerup", point));
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["Two.", "Three.", "One."]);
  await frame(window);
  assert.ok(around(shadow, two), "the reticle moved with the block");
  assert.notEqual(reticle(shadow).top, before);

  fromChrome({ type: "eh:undo", label: "Plan · p 1", kind: "moved" });
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two.", "Three."]);
  await frame(window);
  assert.equal(reticle(shadow).top, before);
  assert.ok(around(shadow, two), "Undo puts the reticle back with the block");
});

test("an outside click keeps the reticle while the comment card holds a draft", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  const two = document.querySelectorAll("p")[1];
  two.getBoundingClientRect = () => rect(10, 100, 200, 40);
  two.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  fromChrome({ type: "eh:composeOpen" });

  document.body.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await settle();
  assert.equal(posts.at(-1).type, "eh:dismiss");
  // The card has a draft, so the chrome keeps it open and sends nothing.
  assert.ok(around(shadow, two), "the open card keeps its marked block");

  fromChrome({ type: "eh:commit", id: "c1" });
  assert.equal(two.getAttribute("data-eh-el"), "c1", "the draft saves on the same block");
  assert.ok(around(shadow, two));
});

test("removing a comment clears the reticle only when it marks that comment's block", { skip }, async () => {
  const { window, document, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p>");
  const [one, two] = document.querySelectorAll("p");
  one.getBoundingClientRect = () => rect(10, 50, 200, 20);
  two.getBoundingClientRect = () => rect(10, 100, 200, 20);
  for (const [el, id] of [[one, "c1"], [two, "c2"]]) {
    el.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    await settle();
    fromChrome({ type: "eh:commit", id });
  }
  assert.ok(around(shadow, two));

  fromChrome({ type: "eh:remove", id: "c1" });
  assert.equal(one.hasAttribute("data-eh-el"), false);
  assert.ok(around(shadow, two), "another block's comment leaves the reticle alone");

  // A text comment on the selected block counts as that block's comment.
  const range = document.createRange();
  range.setStart(two.firstChild, 0);
  range.setEnd(two.firstChild, 3);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  two.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", shiftKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  fromChrome({ type: "eh:commit", id: "c3" });
  assert.equal(two.querySelector("mark").textContent, "Two");
  fromChrome({ type: "eh:remove", id: "c2" });
  assert.equal(reticle(shadow), null, "the selected block's own comment ends the selection");

  fromChrome({ type: "eh:activate", id: "c3" });
  assert.ok(around(shadow, two));
  fromChrome({ type: "eh:remove", id: "c3" });
  assert.equal(two.querySelector("mark"), null);
  assert.equal(reticle(shadow), null, "its own text comment ends it too");
});
