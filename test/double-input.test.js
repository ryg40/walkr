import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateDoubleInput } from "../src/double-input.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const region = (id = "hero", label = "Hero") => `<section data-double-id="${id}" data-container="${label}"><img src="image.png" alt=""></section>`;
const page = (body = region(), head = '<link rel="stylesheet" href="base.css">') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "double-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { comparisonId: "trial:1", label: "Two proposals", panes: {} };
  for (const pane of ["left", "right"]) {
    const originalRoot = path.join(root, `original-${pane}`);
    const copyRoot = path.join(root, pane);
    await mkdir(originalRoot);
    await mkdir(copyRoot);
    const originals = [];
    for (const [file, bytes] of Object.entries({ "index.html": page(), "base.css": '.hero { background: url("image.png"); }', "image.png": PNG })) {
      await writeFile(path.join(originalRoot, file), bytes);
      await writeFile(path.join(copyRoot, file), bytes);
      originals.push({ path: path.join(originalRoot, file), sha256: hash(bytes) });
    }
    input.panes[pane] = {
      label: `${pane} proposal`,
      original: { entry: path.join(originalRoot, "index.html"), files: originals },
      copy: { root: copyRoot, entry: "index.html", assets: ["base.css", "image.png"] },
    };
  }
  return { root, input, async html(source, pane = "left") { await writeFile(path.join(input.panes[pane].copy.root, "index.html"), source); } };
}

async function snapshot(directory) {
  const result = {};
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) result[file] = "symlink";
      else if (stat.isDirectory()) await visit(file);
      else result[file] = hash(await readFile(file));
    }
  }
  await visit(directory);
  return result;
}

async function check(f, code, expected = {}) {
  const before = await snapshot(f.root);
  const inputBefore = structuredClone(f.input);
  const result = await validateDoubleInput(f.input);
  assert.deepEqual(await snapshot(f.root), before, "validation never changes original or copy bytes");
  assert.deepEqual(f.input, inputBefore, "validation never changes its input object");
  if (!code) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.diagnostics, []);
  } else {
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "comparison"), false, "an invalid pair returns no actionable partial result");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, code, JSON.stringify(result));
    for (const [key, value] of Object.entries(expected)) assert.equal(result.diagnostics[0][key], value);
  }
  return result;
}

test("accepts copied HTML/CSS/images with separate provenance and stable opposite-pane identity", async (t) => {
  const f = await fixture(t);
  await f.html(page(region("hero", "Changed label")));
  const first = await check(f);
  const second = await check(f);
  assert.deepEqual(first, second);
  const { left, right } = first.comparison.panes;
  assert.equal(first.comparison.id, "trial:1");
  assert.equal(left.components[0].label, "Changed label");
  assert.deepEqual(left.components[0].identity, { comparisonId: "trial:1", pane: "left", componentId: "hero" });
  assert.deepEqual(right.components[0].identity, { comparisonId: "trial:1", pane: "right", componentId: "hero" });
  assert.notEqual(left.original.files[0].baselineSha256, left.copy.files[0].sha256);
  assert.equal(left.original.files[0].baselineSha256, left.original.files[0].currentSha256);
  assert.equal(left.copy.files[0].path, "index.html");
  assert.ok(path.isAbsolute(left.original.entry));
  await f.html(page(`<p>Moved region</p>${region("hero", "Another label")}`));
  const moved = await check(f);
  assert.deepEqual(moved.comparison.panes.left.components[0].identity, left.components[0].identity);
  f.input.comparisonId = "another-comparison";
  const another = await check(f);
  assert.notDeepEqual(another.comparison.panes.left.components[0].identity, left.components[0].identity);
});

test("accepts fragments and a shared original without executing scripts or fetching", async (t) => {
  const f = await fixture(t);
  f.input.panes.right.original = structuredClone(f.input.panes.left.original);
  await f.html('<section data-double-id="hero" data-container="Hero"><p>Static fragment</p></section>');
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden"); });
  await check(f);
  await f.html(page(region() + '<script>globalThis.doubleInputExecuted = true</script>'));
  await check(f, "UNSUPPORTED_HTML");
  assert.equal(globalThis.doubleInputExecuted, undefined);
});

test("checks relative assets against the referencing CSS file", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.input.panes.left.copy.root, "styles"));
  await writeFile(path.join(f.input.panes.left.copy.root, "styles", "nested.css"), '.x{background:url(image.png)}');
  f.input.panes.left.copy.assets.push("styles/nested.css");
  await check(f, "UNDECLARED_ASSET", { pane: "left", file: "styles/nested.css" });
  await writeFile(path.join(f.input.panes.left.copy.root, "styles", "image.png"), PNG);
  f.input.panes.left.copy.assets.push("styles/image.png");
  await check(f);
});

test("labels alone are ignored alongside a valid region", async (t) => {
  const f = await fixture(t);
  await f.html(page(`<div data-container="Legacy" data-block="old">Legacy</div>${region()}`));
  assert.equal((await check(f)).comparison.panes.left.components.length, 1);
});

for (const [name, body, code, componentId] of [
  ["duplicate IDs", region() + region(), "DUPLICATE_COMPONENT", "hero"],
  ["nested regions", `<section data-double-id="outer" data-container="Outer">${region()}</section>`, "NESTED_COMPONENT", "hero"],
  ["empty ID", region(""), "INVALID_ID", ""],
  ["bare ID attribute", '<section data-double-id data-container="Hero"></section>', "INVALID_ID", ""],
  ["whitespace ID", region("  "), "INVALID_ID", "  "],
  ["missing label", '<section data-double-id="hero"></section>', "INVALID_LABEL", "hero"],
  ["empty label", region("hero", ""), "INVALID_LABEL", "hero"],
  ["whitespace label", region("hero", "  "), "INVALID_LABEL", "hero"],
  ["invisible label", region("hero", "\u200b"), "INVALID_LABEL", "hero"],
  ["missing ID on label-only entry", '<section data-container="Hero"></section>', "NO_COMPONENTS", null],
  ["no markers", '<p>No regions</p>', "NO_COMPONENTS", null],
  ["duplicate attributes", '<section data-double-id="one" data-double-id="two" data-container="Hero"></section>', "INVALID_HTML", null],
]) {
  test(`rejects ${name} without writes or a partial pair`, async (t) => {
    const f = await fixture(t);
    await f.html(page(body));
    await check(f, code, { pane: "left", file: "index.html", componentId });
  });
}

for (const [name, source, componentId] of [
  ["orphan duplicate cell without a label", page(`${region()}<td data-double-id="hero">Discarded declaration</td>`), "hero"],
  ["orphan cell with a unique valid marker", page(`${region()}<td data-double-id="cell" data-container="Cell">Discarded</td>`), "cell"],
  ["orphan empty marker", page(`${region()}<td data-double-id data-container="Cell">Discarded</td>`), ""],
  ["orphan marker without any retained components", '<td data-double-id="cell" data-container="Cell">Discarded</td>', "cell"],
  ["discarded nested declaration", page('<section data-double-id="hero" data-container="Hero"><td data-double-id="cell" data-container="Cell">Discarded</td></section>'), "cell"],
  ["discarded row in a fragment", `${region()}<tr data-double-id="row" data-container="Row"></tr>`, "row"],
  ["duplicate body declaration", '<!doctype html><html><head></head><body data-double-id="body" data-container="Body"><body data-double-id="body">Text</body></html>', "body"],
  ["discarded second html marker", '<!doctype html><html data-double-id="root" data-container="Root"><head></head><body><html data-double-id="second" data-container="Second">Text</body></html>', "second"],
  ["marker merged onto an existing body", '<!doctype html><html><head></head><body data-container="Body"><body data-double-id="body" data-container="Body">Text</body></html>', "body"],
]) {
  test(`rejects ${name} without writes or a partial pair`, async (t) => {
    const f = await fixture(t);
    await f.html(source, "right");
    const result = await check(f, "INVALID_HTML", { pane: "right", file: "index.html", componentId });
    assert.ok(result.diagnostics[0].line >= 1);
    assert.ok(result.diagnostics[0].column >= 1);
  });
}

test("rejects a component duplicated by formatting reconstruction", async (t) => {
  const f = await fixture(t);
  await f.html('<b data-double-id="bold" data-container="Bold">One<p>Two</b>Three</p>');
  await check(f, "INVALID_HTML", { pane: "left", file: "index.html", componentId: "bold" });
});

test("rejects a component label supplied by a merged start tag", async (t) => {
  const f = await fixture(t);
  await f.html('<!doctype html><html data-double-id="root"><head></head><body><html data-container="Injected label">Text</body></html>');
  await check(f, "INVALID_LABEL", { pane: "left", file: "index.html", componentId: "root" });
});

for (const [name, source, ids] of [
  ["full document root marker", '<!doctype html><html data-double-id="root" data-container="Root"><head><title>Example</title></head><body>Text</body></html>', ["root"]],
  ["full document body marker", '<!doctype html><html><head></head><body data-double-id="body" data-container="Body">Text</body></html>', ["body"]],
  ["table fragment with implicit tbody", '<table><tr><td data-double-id="cell" data-container="Cell">Text</td><td>Plain</td></tr></table>', ["cell"]],
  ["mixed case and decoded attribute values", '<SECTION DATA-DOUBLE-ID="he&#114;o" DATA-CONTAINER="Hero &amp; title">Text</SECTION>', ["hero"]],
  ["unquoted marker and optional closing tags", '<ul><li data-double-id=first data-container=First>One<li data-double-id=second data-container=Second>Two</ul>', ["first", "second"]],
  ["comments, quoted attributes, text, and CSS strings", page(`${region()}
    <!-- <td data-double-id="hero">Not a declaration</td> -->
    <p title='<td data-double-id="hero">' data-example="data-double-id='hero'">data-double-id="hero"</p>
    <pre>&lt;td data-double-id="hero"&gt;Escaped text&lt;/td&gt;</pre>`,
    `<title>Literal <td data-double-id="hero"> text</title>
     <style>.x::before { content: '<td data-double-id="hero">'; }</style>`), ["hero"]],
  ["discarded table text without a declaration", page(`${region()}<td title='data-double-id="hero"'>Plain text</td>`), ["hero"]],
]) {
  test(`preserves supported HTML: ${name}`, async (t) => {
    const f = await fixture(t);
    await f.html(source);
    const result = await check(f);
    assert.deepEqual(result.comparison.panes.left.components.map(({ id }) => id), ids);
  });
}

test("rejects a bad right pane even when left is valid", async (t) => {
  const f = await fixture(t);
  await f.html(page(region("")), "right");
  await check(f, "INVALID_ID", { pane: "right" });
});

for (const [name, mutate] of [
  ["missing comparison identity", (input) => { delete input.comparisonId; }],
  ["third pane", (input) => { input.panes.middle = input.panes.left; }],
  ["missing right", (input) => { delete input.panes.right; }],
  ["pane array", (input) => { input.panes = Object.values(input.panes); }],
  ["missing baseline", (input) => { input.panes.left.original.files = []; }],
  ["bad baseline hash", (input) => { input.panes.left.original.files[0].sha256 = "bad"; }],
  ["baseline with newline", (input) => { input.panes.left.original.files[0].sha256 += "\n"; }],
  ["entry without baseline", (input) => { input.panes.left.original.files.shift(); }],
  ["duplicate asset", (input) => { input.panes.left.copy.assets.push("base.css"); }],
  ["asset not an array", (input) => { input.panes.left.copy.assets = null; }],
  ["extra target field", (input) => { input.panes.left.original.writableTarget = "/tmp/not-a-target"; }],
]) {
  test(`rejects input shape: ${name}`, async (t) => {
    const f = await fixture(t);
    mutate(f.input);
    await check(f, "INPUT_SHAPE");
  });
}

for (const [url, code] of [
  ["https://example.invalid/a.png", "REMOTE_REFERENCE"], ["//example.invalid/a.png", "REMOTE_REFERENCE"],
  ["../outside.png", "OUTSIDE_COPY"], ["/outside.png", "OUTSIDE_COPY"],
  ["missing.png", "UNDECLARED_ASSET"], ["data:image/png;base64,a", "INVALID_PATH"],
  ["file:///tmp/a.png", "INVALID_PATH"], ["image.png?version=1", "INVALID_PATH"],
  ["image.png#view", "INVALID_PATH"], ["%2e%2e/out.png", "INVALID_PATH"],
  ["..\\out.png", "INVALID_PATH"], ["a.svg", "UNSUPPORTED_ASSET"],
  ["javascript:alert(1)", "INVALID_PATH"],
]) {
  test(`rejects image reference ${url}`, async (t) => {
    const f = await fixture(t);
    await f.html(page(`<section data-double-id="hero" data-container="Hero"><img src="${url}" alt=""></section>`));
    await check(f, code, { pane: "left", file: "index.html", componentId: "hero" });
  });
}

test("checks declared but unused and missing assets", async (t) => {
  const f = await fixture(t);
  f.input.panes.left.copy.assets.push("absent.png");
  await check(f, "MISSING_FILE", { pane: "left", file: "absent.png" });
});

test("rejects missing originals and copy entries", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.input.panes.left.copy.root, "index.html"));
  await check(f, "MISSING_FILE", { pane: "left", file: "index.html" });
  await rm(f.input.panes.right.original.entry);
  // The first error remains deterministic: left's missing entry wins.
  await check(f, "MISSING_FILE", { pane: "left" });
  await f.html(page());
  await check(f, "MISSING_FILE", { pane: "right", file: f.input.panes.right.original.entry });
});

test("supports nested paths, inline styles, local CSS imports and import cycles without fetching", async (t) => {
  const f = await fixture(t);
  const root = f.input.panes.left.copy.root;
  await mkdir(path.join(root, "styles"));
  await writeFile(path.join(root, "styles", "more.css"), '@import "more.css"; .x { color: rgb(1, 2, 3); }');
  await writeFile(path.join(root, "base.css"), '@import url("styles/more.css"); .x { --tone: red; color: var(--tone); background: url(image.png); }');
  f.input.panes.left.copy.assets.push("styles/more.css");
  await f.html(page(`<section data-double-id="hero" data-container="Hero" style="background:url('./image.png')"><a href="#hero">Here</a></section>`,
    '<link rel="stylesheet" href="base.css"><style>@media (min-width:1px){.x{background:url(image.png)}}</style>'));
  await check(f);
});

for (const value of [
  'url(image.png)',
  'var(--missing, url(image.png))',
  'var(--missing, var(--also-missing, URL("image.png")))',
  'var(--existing, url(image.png)) !important',
  'linear-gradient(red, blue), url(image.png)',
]) {
  test(`rejects cross-stylesheet URL-valued custom properties: ${value}`, async (t) => {
    const f = await fixture(t);
    const copy = f.input.panes.left.copy;
    await mkdir(path.join(copy.root, "tokens"));
    await writeFile(path.join(copy.root, "tokens", "vars.css"), `:root { --existing: none; --hero-image: ${value}; }`);
    await writeFile(path.join(copy.root, "tokens", "image.png"), PNG);
    await writeFile(path.join(copy.root, "use.css"), '.hero { background-image: var(--hero-image); }');
    await writeFile(path.join(copy.root, "base.css"), '@import "tokens/vars.css"; @import "use.css";');
    await rm(path.join(copy.root, "image.png"));
    copy.assets = ["base.css", "tokens/vars.css", "tokens/image.png", "use.css"];
    await f.html(page('<section class="hero" data-double-id="hero" data-container="Hero">Text</section>'));
    await check(f, "UNSUPPORTED_CSS", { pane: "left", file: "tokens/vars.css", componentId: null });
  });
}

for (const [name, body] of [
  ["style attribute", '<section data-double-id="hero" data-container="Hero" style="--image:var(--missing,url(image.png));background:var(--image)">Text</section>'],
  ["style element", '<section data-double-id="hero" data-container="Hero"><style>@media (min-width:1px){.hero{--image:var(--missing,url(image.png));background:var(--image)}}</style></section>'],
]) {
  test(`rejects URL-valued custom properties in a ${name}`, async (t) => {
    const f = await fixture(t);
    await f.html(page(body));
    await check(f, "UNSUPPORTED_CSS", { pane: "left", file: "index.html", componentId: "hero" });
  });
}

test("preserves URL-free custom properties and resolves ordinary var fallbacks at their own file", async (t) => {
  const f = await fixture(t);
  const copy = f.input.panes.left.copy;
  await mkdir(path.join(copy.root, "tokens"));
  await writeFile(path.join(copy.root, "tokens", "vars.css"), `:root {
    --tone: red; --alias: var(--tone, blue); --size: calc(1px + 2px);
    --text: 'url(https://example.invalid/not-an-asset.png)'; /* url(missing.png) */
  }`);
  copy.assets.push("tokens/vars.css");
  await writeFile(path.join(copy.root, "base.css"), `@import "tokens/vars.css";
    .hero { color:var(--alias); width:var(--size); background:var(--absent,var(--also-absent,url(image.png))); }`);
  await check(f);
  await writeFile(path.join(copy.root, "base.css"), `@import "tokens/vars.css";
    .hero { background:var(--absent,var(--also-absent,url(missing.png))); }`);
  await check(f, "UNDECLARED_ASSET", { pane: "left", file: "base.css", reference: "missing.png" });
});

for (const [source, code] of [
  ['.x{background:url(https://example.invalid/a.png)}', "REMOTE_REFERENCE"],
  ['@import "https://example.invalid/a.css";', "REMOTE_REFERENCE"],
  ['.x{background:url(../a.png)}', "OUTSIDE_COPY"],
  ['.x{background:url(missing.png)}', "UNDECLARED_ASSET"],
  ['@import "missing.css";', "UNDECLARED_ASSET"],
  ['@import "base.css" screen;', "UNSUPPORTED_CSS"],
  ['.x{background:image-set("https://example.invalid/a.png" 1x)}', "UNSUPPORTED_CSS"],
  ['.x{background:u\\72l(image.png)}', "UNSUPPORTED_CSS"],
  ['.x{background:url(var(--asset))}', "INVALID_CSS"],
  ['.x{background:paint(remote)}', "UNSUPPORTED_CSS"],
  ['@font-face{src:url(font.woff2)}', "UNSUPPORTED_CSS"],
  ['.x{behavior:url(image.png)}', "UNSUPPORTED_CSS"],
  ['.x{background:url(base.css)}', "UNSUPPORTED_ASSET"],
  ['@namespace url(https://example.invalid/ns);', "UNSUPPORTED_CSS"],
  ['.x{--hidden:url(https://example.invalid/a.png)}', "UNSUPPORTED_CSS"],
  ['.x{--unused:url(image.png)}', "UNSUPPORTED_CSS"],
]) {
  test(`rejects unsupported or invalid CSS: ${source}`, async (t) => {
    const f = await fixture(t);
    await writeFile(path.join(f.input.panes.left.copy.root, "base.css"), source);
    await check(f, code, { pane: "left", file: "base.css", componentId: null });
  });
}

test("reports inline dependency errors against the owning component", async (t) => {
  const f = await fixture(t);
  await f.html(page('<section data-double-id="hero" data-container="Hero"><p style="background:url(missing.png)">Hello</p></section>'));
  await check(f, "UNDECLARED_ASSET", { pane: "left", file: "index.html", componentId: "hero" });
});

for (const unsupported of [
  '<script>throw new Error("must never execute")</script>', '<script src="app.js"></script>',
  '<img src="image.png" srcset="image.png 1x">', '<img src="image.png" onload="alert(1)">',
  '<iframe src="remote.html"></iframe>', '<base href="https://example.invalid/">',
  '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
  '<svg><image href="image.png"/></svg>', '<template><img src="missing.png"></template>',
  '<object data="image.png"></object>', '<video poster="image.png"></video>',
  '<div background="image.png"></div>', '<link rel="preload" href="image.png">',
]) {
  test(`fails closed for unsupported HTML: ${unsupported}`, async (t) => {
    const f = await fixture(t);
    await f.html(page(region() + unsupported));
    await check(f, "UNSUPPORTED_HTML", { pane: "left", file: "index.html" });
  });
}

test("does not accept page navigation, remote stylesheet links, or non-UTF-8 content", async (t) => {
  const f = await fixture(t);
  await f.html(page(region() + '<a href="https://example.invalid/">Leave</a>'));
  await check(f, "UNSUPPORTED_REFERENCE");
  await f.html(page(region(), '<link rel="stylesheet" href="https://example.invalid/a.css">'));
  await check(f, "REMOTE_REFERENCE");
  await f.html(Buffer.from([0xff, 0xfe, 0x00]));
  await check(f, "UNSUPPORTED_ENCODING");
});

test("detects changed original HTML and asset baselines without rewriting them", async (t) => {
  const f = await fixture(t);
  const original = f.input.panes.left.original;
  await writeFile(original.entry, "changed original");
  await check(f, "ORIGINAL_CHANGED", { pane: "left", file: original.entry });
  await writeFile(original.entry, page());
  const asset = original.files.find((file) => file.path.endsWith("base.css"));
  await writeFile(asset.path, "changed CSS");
  await check(f, "ORIGINAL_CHANGED", { pane: "left", file: asset.path });
});

test("rejects identical, nested, and source/copy aliases", async (t) => {
  const f = await fixture(t);
  const right = f.input.panes.right.copy.root;
  f.input.panes.right.copy.root = f.input.panes.left.copy.root;
  await check(f, "COPY_OVERLAP");
  f.input.panes.right.copy.root = path.join(f.input.panes.left.copy.root, "nested");
  await mkdir(f.input.panes.right.copy.root);
  await check(f, "COPY_OVERLAP");
  f.input.panes.right.copy.root = right;
  const copyEntry = path.join(right, "index.html");
  f.input.panes.left.original = { entry: copyEntry, files: [{ path: copyEntry, sha256: hash(page()) }] };
  await check(f, "SOURCE_COPY_ALIAS", { pane: "left", file: copyEntry });
});

for (const [name, mutate] of [
  ["entry traversal", (input) => { input.panes.left.copy.entry = "../index.html"; }],
  ["asset traversal", (input) => { input.panes.left.copy.assets.push("../other.png"); }],
  ["absolute asset", (input) => { input.panes.left.copy.assets.push("/tmp/other.png"); }],
  ["root traversal", (input) => { input.panes.left.copy.root += "/../left"; }],
  ["trailing root slash", (input) => { input.panes.left.copy.root += "/"; }],
  ["line break in asset path", (input) => { input.panes.left.copy.assets.push("image.png\n"); }],
  ["source traversal", (input) => { input.panes.left.original.entry += "/../index.html"; }],
]) {
  test(`rejects ${name}`, async (t) => {
    const f = await fixture(t);
    mutate(f.input);
    await check(f, "INVALID_PATH", { pane: "left" });
  });
}

test("rejects copy-root and parent-directory symlinks", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  await symlink(f.input.panes.left.copy.root, alias);
  f.input.panes.left.copy.root = alias;
  await check(f, "SYMLINK");
  const parent = path.join(f.root, "parent");
  await symlink(f.root, parent);
  f.input.panes.left.copy.root = path.join(parent, "left");
  await check(f, "SYMLINK");
});

for (const kind of ["symbolic", "hard"]) {
  for (const target of ["original", "opposite copy"]) {
    test(`rejects a ${kind} linked copy asset targeting ${target}`, async (t) => {
      const f = await fixture(t);
      const file = path.join(f.input.panes.left.copy.root, "image.png");
      const source = target === "original" ? f.input.panes.left.original.files[2].path : path.join(f.input.panes.right.copy.root, "image.png");
      await rm(file);
      await (kind === "symbolic" ? symlink : link)(source, file);
      await check(f, kind === "symbolic" ? "SYMLINK" : "HARDLINK");
    });
  }
}

test("rejects symlink originals and unused symlinks in copies", async (t) => {
  const f = await fixture(t);
  const original = f.input.panes.left.original;
  const alias = path.join(f.root, "source-link.html");
  await symlink(original.entry, alias);
  original.files[0].path = alias;
  original.entry = alias;
  await check(f, "SYMLINK");
  original.entry = original.files[0].path = path.join(f.root, "original-left", "index.html");
  await symlink(f.root, path.join(f.input.panes.left.copy.root, "unused-link"));
  await check(f, "SYMLINK", { pane: "left", file: "unused-link" });
});

test("rejects empty extra directories and unsupported declared assets", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.input.panes.left.copy.root, "extra"));
  await check(f, "UNDECLARED_FILE", { pane: "left", file: "extra" });
  f.input.panes.left.copy.assets.push("app.js");
  await check(f, "UNSUPPORTED_ASSET", { pane: "left", file: "app.js" });
});

test("rejects undeclared files rather than discovering dependencies", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.input.panes.left.copy.root, "extra.js"), "throw new Error('never execute')");
  await check(f, "UNDECLARED_FILE", { pane: "left", file: "extra.js" });
});
