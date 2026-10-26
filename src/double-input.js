import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Parser } from "parse5";
import * as css from "css-tree";

const PANES = ["left", "right"];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
const TAGS = new Set(("html head body title meta link style main header footer nav aside section article div span " +
  "h1 h2 h3 h4 h5 h6 p a img ul ol li dl dt dd figure figcaption blockquote pre code br hr " +
  "strong em b i u s small sub sup mark time abbr address q cite details summary button " +
  "table caption colgroup col thead tbody tfoot tr th td").split(" "));
const GLOBAL_ATTRIBUTES = new Set("id class title lang dir hidden inert role tabindex style".split(" "));
const TAG_ATTRIBUTES = {
  html: ["lang"], meta: ["charset", "name", "content"], link: ["rel", "href", "media", "type"],
  style: ["media", "type"], a: ["href"], img: ["src", "alt", "width", "height", "loading", "decoding"],
  ol: ["start", "reversed", "type"], li: ["value"], time: ["datetime"], details: ["open", "name"],
  button: ["type", "disabled"], col: ["span"], colgroup: ["span"],
  th: ["colspan", "rowspan", "scope", "headers", "abbr"], td: ["colspan", "rowspan", "headers"],
};
const CSS_AT_RULES = new Set(["import", "media", "supports", "layer", "container", "keyframes", "-webkit-keyframes"]);
const CSS_FUNCTIONS = new Set(("var env calc min max clamp rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix " +
  "light-dark linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient " +
  "repeating-conic-gradient translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d " +
  "rotate rotatex rotatey rotatez rotate3d skew skewx skewy matrix matrix3d perspective cubic-bezier steps " +
  "blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia " +
  "minmax repeat fit-content counter counters symbols selector").split(" "));

class InvalidInput extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.diagnostic = { code, message, pane: null, file: null, componentId: null, ...context };
  }
}

function reject(code, message, context) {
  throw new InvalidInput(code, message, context);
}

function shape(value, keys, context) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    reject("INPUT_SHAPE", `Expected exactly these fields: ${keys.join(", ")}.`, context);
  }
}

function label(value, context) {
  if (typeof value !== "string" || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    reject("INVALID_LABEL", "A readable label is required.", context);
  }
}

function identity(value, context) {
  if (typeof value !== "string" || !value || /[\s\p{C}]/u.test(value)) {
    reject("INVALID_ID", "An ID must be nonempty and contain no whitespace or control characters.", context);
  }
}

function absolutePath(value, context) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.endsWith(path.sep) ||
      path.normalize(value) !== value || /[\x00-\x1f\x7f\\]/.test(value)) {
    reject("INVALID_PATH", "Use a canonical absolute path without traversal or a trailing slash.", context);
  }
}

function relativePath(value, context) {
  if (typeof value !== "string" || /[^A-Za-z0-9._/-]/.test(value) ||
      !value.split("/").every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))) {
    reject("INVALID_PATH", "Use relative ASCII file names without traversal, escapes, queries, or fragments.", context);
  }
}

function contains(root, file) {
  return file === root || file.startsWith(`${root}${path.sep}`);
}

async function io(operation, context) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    reject(error.code === "ENOENT" ? "MISSING_FILE" : "FILE_ACCESS", "Cannot read the declared path.", {
      ...context, fsCode: error.code || "UNKNOWN",
    });
  }
}

async function inspectPath(file, context, directory = false) {
  const parts = file.slice(path.parse(file).root.length).split(path.sep);
  let current = path.parse(file).root;
  let stat;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    stat = await io(() => lstat(current, { bigint: true }), context);
    if (stat.isSymbolicLink()) reject("SYMLINK", "Symlinks, including parent directories, are unsupported.", context);
    if (index < parts.length - 1 && !stat.isDirectory()) reject("FILE_TYPE", "A parent path is not a directory.", context);
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) reject("FILE_TYPE", `Expected a ${directory ? "directory" : "regular file"}.`, context);
  if (!directory && stat.nlink !== 1n) reject("HARDLINK", "Files must have exactly one hard link.", context);
  return stat;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a, b) {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

async function readFile(file, context) {
  const before = await inspectPath(file, context);
  return io(async () => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameVersion(before, opened)) reject("FILE_CHANGED", "The file changed while being validated.", context);
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const current = await lstat(file, { bigint: true });
      if (!sameVersion(before, after) || !sameVersion(before, current)) {
        reject("FILE_CHANGED", "The file changed while being validated.", context);
      }
      return { bytes, stat: after, sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await handle.close();
    }
  }, context);
}

function text(bytes, context) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("UNSUPPORTED_ENCODING", "HTML and CSS must use UTF-8.", context);
  }
}

async function inventory(root, files, pane, directory = "") {
  const entries = await io(() => readdir(path.join(root, directory), { withFileTypes: true }), { pane, file: directory || root });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    const context = { pane, file };
    if (entry.isSymbolicLink()) reject("SYMLINK", "A copy folder contains a symlink.", context);
    if (entry.isDirectory() && files.some((name) => name.startsWith(`${file}/`))) {
      await inventory(root, files, pane, file);
    } else if (!entry.isFile() || !files.includes(file)) {
      reject("UNDECLARED_FILE", "The copy folder may contain only its entry and declared assets, with their parent directories.", context);
    }
  }
}

function reference(value, from, assets, kind, context) {
  if (/^(?:https?:|ftp:|\/\/)/i.test(value)) reject("REMOTE_REFERENCE", "Remote dependencies are unsupported.", context);
  if (value.startsWith("/") || value.split("/").includes("..")) {
    reject("OUTSIDE_COPY", "Absolute paths and parent traversal are unsupported.", context);
  }
  if (value.startsWith("./")) value = value.slice(2);
  relativePath(value, context);
  const resolved = path.posix.join(path.posix.dirname(from), value);
  const extension = path.posix.extname(resolved).toLowerCase();
  if ((kind === "css" && extension !== ".css") || (kind === "image" && !IMAGE_EXTENSIONS.has(extension))) {
    reject("UNSUPPORTED_ASSET", `Expected a local ${kind} asset.`, { ...context, reference: value });
  }
  if (!assets.has(resolved)) reject("UNDECLARED_ASSET", "The referenced asset is not declared.", { ...context, reference: value });
}

class ComponentParser extends Parser {
  declarations = new Map();

  onStartTag(token) {
    const marker = token.attrs.find(({ name }) => name === "data-double-id");
    if (marker) {
      // Observe real tokens before tree construction can discard or merge them.
      this.declarations.set(token.location.startOffset, {
        id: marker.value,
        label: token.attrs.find(({ name }) => name === "data-container")?.value,
        tagName: token.tagName,
        scope: token.attrs.find(({ name }) => name === "data-double-scope")?.value,
        location: token.location,
      });
    }
    super.onStartTag(token);
  }
}

function validateCss(source, file, assets, context, inline = false) {
  // Escapes and fallback tokens can hide dependency syntax. This trial rejects them.
  if (source.includes("\\")) reject("UNSUPPORTED_CSS", "CSS escapes are unsupported.", context);
  let ast;
  try {
    ast = css.parse(source, {
      context: inline ? "declarationList" : "stylesheet", parseCustomProperty: true,
      onParseError(error) { throw error; },
    });
  } catch {
    reject("INVALID_CSS", "The CSS cannot be parsed without recovery.", context);
  }
  const imports = new Set();
  css.walk(ast, function(node) {
    if (node.type === "Raw") reject("UNSUPPORTED_CSS", "Unparsed CSS is unsupported.", context);
    if (node.type === "Atrule") {
      const name = node.name.toLowerCase();
      if (!CSS_AT_RULES.has(name)) reject("UNSUPPORTED_CSS", `Unsupported CSS at-rule: @${name}.`, context);
      if (name === "import") {
        const children = node.prelude?.children?.toArray() || [];
        if (node.block || children.length !== 1 || !["String", "Url"].includes(children[0].type)) {
          reject("UNSUPPORTED_CSS", "Use a single literal CSS @import without qualifiers.", context);
        }
        reference(children[0].value, file, assets, "css", context);
        imports.add(children[0]);
      }
    }
    if (node.type === "Function" && !CSS_FUNCTIONS.has(node.name.toLowerCase())) {
      reject("UNSUPPORTED_CSS", `Unsupported CSS function: ${node.name}.`, context);
    }
    if (node.type === "Declaration" && ["behavior", "-moz-binding"].includes(node.property.toLowerCase())) {
      reject("UNSUPPORTED_CSS", "Executable CSS properties are unsupported.", context);
    }
    if (node.type === "Url") {
      // Custom-property URLs resolve at consumption, not at their declaration file.
      if (this.declaration?.property.startsWith("--")) {
        reject("UNSUPPORTED_CSS", "URL-valued custom properties, including URL fallbacks, are unsupported.", context);
      }
      if (!imports.has(node)) reference(node.value, file, assets, "image", context);
    }
  });
}

function validateHtml(source, file, assets, comparisonId, pane) {
  let parser;
  try {
    parser = new ComponentParser({
      sourceCodeLocationInfo: true,
      onParseError(error) {
        if (error.code !== "missing-doctype") reject("INVALID_HTML", `HTML parse error: ${error.code}.`, {
          pane, file, line: error.startLine, column: error.startCol,
        });
      },
    });
    parser.tokenizer.write(source, true);
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    reject("INVALID_HTML", "The entry cannot be parsed.", { pane, file });
  }
  const components = [];
  const ids = new Set();
  function visit(node, parentComponent = null) {
    let componentId = parentComponent;
    if (node.tagName) {
      const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
      const location = node.sourceCodeLocation;
      const context = { pane, file, componentId, ...(location && { line: location.startLine, column: location.startCol }) };
      if (Object.hasOwn(attrs, "data-double-id")) {
        componentId = attrs["data-double-id"];
        context.componentId = componentId;
        identity(componentId, context);
        const declaration = parser.declarations.get(location?.startOffset);
        if (!declaration || declaration.id !== componentId || declaration.tagName !== node.tagName) {
          reject("INVALID_HTML", "A marked region must retain its own explicit start tag.", context);
        }
        label(declaration.label, context);
        const scope = declaration.scope;
        if (scope !== undefined && !["group", "frame"].includes(scope)) reject("INVALID_SCOPE", "Use group or frame for an explicit component scope.", context);
        const parent = components.find((component) => component.id === parentComponent);
        if (parentComponent !== null && !["group", "frame"].includes(parent?.scope)) reject("NESTED_COMPONENT", "Only explicit group or frame regions may contain marked components.", context);
        if (scope === "frame" && node.tagName !== "div") reject("INVALID_SCOPE", "A frame region must be a div wrapper.", context);
        if (ids.has(componentId)) reject("DUPLICATE_COMPONENT", "Component IDs must be unique within a pane.", context);
        parser.declarations.delete(location.startOffset);
        ids.add(componentId);
        components.push({ id: componentId, label: declaration.label, identity: { comparisonId, pane, componentId },
          ...(scope && { scope }), ...(parentComponent !== null && { parentId: parentComponent }),
          location: { file, line: location.startLine, column: location.startCol } });
      }
      if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !TAGS.has(node.tagName)) {
        reject("UNSUPPORTED_HTML", `Unsupported element: ${node.tagName}.`, context);
      }
      for (const attr of node.attrs) {
        if (attr.namespace || (!GLOBAL_ATTRIBUTES.has(attr.name) && !TAG_ATTRIBUTES[node.tagName]?.includes(attr.name) &&
            !attr.name.startsWith("data-") && !attr.name.startsWith("aria-"))) {
          reject("UNSUPPORTED_HTML", `Unsupported attribute: ${attr.name}.`, context);
        }
      }
      if (node.tagName === "meta" && !((attrs.charset?.toLowerCase() === "utf-8" && !attrs.name && !attrs.content) ||
          (["viewport", "description"].includes(attrs.name?.toLowerCase()) && !attrs.charset))) {
        reject("UNSUPPORTED_HTML", "Only UTF-8, viewport, and description metadata are supported.", context);
      }
      if (node.tagName === "a" && attrs.href !== undefined && !/^#[A-Za-z0-9_.:-]*$/.test(attrs.href)) {
        reject("UNSUPPORTED_REFERENCE", "Links may only target an in-page fragment.", context);
      }
      if (node.tagName === "link") {
        if (attrs.rel?.toLowerCase() !== "stylesheet" || !attrs.href || (attrs.type && attrs.type !== "text/css")) {
          reject("UNSUPPORTED_HTML", "Only local stylesheet links are supported.", context);
        }
        reference(attrs.href, file, assets, "css", context);
      }
      if (node.tagName === "img") {
        if (!attrs.src) reject("UNSUPPORTED_REFERENCE", "Images require a literal local src.", context);
        reference(attrs.src, file, assets, "image", context);
      }
      if (node.tagName === "style") {
        if (attrs.type && attrs.type !== "text/css") reject("UNSUPPORTED_HTML", "Only text/css styles are supported.", context);
        validateCss(node.childNodes.map((child) => child.value || "").join(""), file, assets, context);
      }
      if (attrs.style !== undefined) validateCss(attrs.style, file, assets, context, true);
    }
    for (const child of node.childNodes || []) visit(child, componentId);
  }
  visit(parser.document);
  for (const declaration of parser.declarations.values()) {
    reject("INVALID_HTML", "Each data-double-id declaration must remain on its own validated element.", {
      pane, file, componentId: declaration.id, line: declaration.location.startLine, column: declaration.location.startCol,
    });
  }
  if (!components.length) reject("NO_COMPONENTS", "The entry has no Double-marked regions; labels alone are not components.", { pane, file });
  return components;
}

/** Read-only, fail-closed validation of one explicit Double comparison. No service integration. */
export async function validateDoubleInput(input) {
  try {
    shape(input, ["comparisonId", "label", "panes"]);
    identity(input.comparisonId);
    label(input.label);
    shape(input.panes, PANES);
    const roots = {};
    for (const pane of PANES) {
      const value = input.panes[pane];
      const context = { pane };
      shape(value, ["label", "original", "copy"], context);
      label(value.label, context);
      shape(value.original, ["entry", "files"], context);
      shape(value.copy, ["root", "entry", "assets"], context);
      absolutePath(value.copy.root, context);
      roots[pane] = await inspectPath(value.copy.root, { pane, file: value.copy.root }, true);
      relativePath(value.copy.entry, context);
      if (!/\.html?$/.test(value.copy.entry)) reject("UNSUPPORTED_ENTRY", "The entry must be an .html or .htm file.", context);
      if (!Array.isArray(value.copy.assets)) reject("INPUT_SHAPE", "copy.assets must be an explicit array.", context);
      const files = [value.copy.entry, ...value.copy.assets];
      for (const file of files) relativePath(file, { pane, file });
      if (new Set(files).size !== files.length) reject("INPUT_SHAPE", "Copy file declarations must be unique.", context);
      for (const file of value.copy.assets) {
        if (path.extname(file) !== ".css" && !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
          reject("UNSUPPORTED_ASSET", "Only CSS and raster image assets are supported.", { pane, file });
        }
      }
      absolutePath(value.original.entry, context);
      if (!Array.isArray(value.original.files) || !value.original.files.length) reject("INPUT_SHAPE", "Original baseline files are required.", context);
      const originals = new Set();
      for (const file of value.original.files) {
        shape(file, ["path", "sha256"], context);
        absolutePath(file.path, { pane, file: file.path });
        if (typeof file.sha256 !== "string" || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256)) reject("INPUT_SHAPE", "Baselines must be lowercase SHA-256 hashes.", { pane, file: file.path });
        if (originals.has(file.path)) reject("INPUT_SHAPE", "Original file declarations must be unique within a pane.", context);
        originals.add(file.path);
      }
      if (!originals.has(value.original.entry)) reject("INPUT_SHAPE", "The original entry requires a baseline hash.", context);
    }
    const left = input.panes.left.copy.root;
    const right = input.panes.right.copy.root;
    if (contains(left, right) || contains(right, left) || sameFile(roots.left, roots.right)) {
      reject("COPY_OVERLAP", "Left and right require distinct, non-overlapping copy folders.", { pane: "right", file: right });
    }
    for (const pane of PANES) {
      for (const file of input.panes[pane].original.files) {
        if (contains(left, file.path) || contains(right, file.path)) {
          reject("SOURCE_COPY_ALIAS", "Original provenance must be outside both copy folders.", { pane, file: file.path });
        }
      }
    }

    const panes = {};
    const observations = [];
    for (const pane of PANES) {
      const value = input.panes[pane];
      const originals = [];
      for (const file of value.original.files) {
        const context = { pane, file: file.path };
        const current = await readFile(file.path, context);
        if (current.sha256 !== file.sha256) reject("ORIGINAL_CHANGED", "An original no longer matches its baseline SHA-256 hash.", context);
        originals.push({ path: file.path, baselineSha256: file.sha256, currentSha256: current.sha256 });
        observations.push({ path: file.path, stat: current.stat, context, original: true });
      }
      const files = [value.copy.entry, ...value.copy.assets];
      await inventory(value.copy.root, files, pane);
      const copies = new Map();
      for (const file of files) {
        const fullPath = path.join(value.copy.root, file);
        const context = { pane, file };
        const current = await readFile(fullPath, context);
        copies.set(file, current);
        observations.push({ path: fullPath, stat: current.stat, context });
      }
      const assets = new Set(value.copy.assets);
      const components = validateHtml(text(copies.get(value.copy.entry).bytes, { pane, file: value.copy.entry }), value.copy.entry, assets, input.comparisonId, pane);
      for (const file of value.copy.assets.filter((file) => file.endsWith(".css"))) {
        const context = { pane, file };
        validateCss(text(copies.get(file).bytes, context), file, assets, context);
      }
      panes[pane] = {
        id: pane, label: value.label, original: { entry: value.original.entry, files: originals },
        copy: { root: value.copy.root, entry: value.copy.entry, files: [...copies].map(([file, current]) => ({ path: file, sha256: current.sha256 })) },
        components,
      };
    }
    const inodes = new Map();
    for (const observation of observations) {
      const inode = `${observation.stat.dev}:${observation.stat.ino}`;
      const prior = inodes.get(inode);
      if (prior && !(prior.original && observation.original)) {
        reject("SOURCE_COPY_ALIAS", "Copy files must not alias an original or another copy file.", observation.context);
      }
      inodes.set(inode, observation);
      const current = await inspectPath(observation.path, observation.context);
      if (!sameVersion(current, observation.stat)) reject("FILE_CHANGED", "The file changed during validation.", observation.context);
    }
    return { ok: true, comparison: { id: input.comparisonId, label: input.label, panes }, diagnostics: [] };
  } catch (error) {
    if (!(error instanceof InvalidInput)) throw error;
    return { ok: false, diagnostics: [error.diagnostic] };
  }
}
