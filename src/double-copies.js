import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parse } from "parse5";
import { hash as digest, fail } from "./double-archive.js";
import { escapeHtml } from "./hosted.js";

const PANES = ["left", "right"];
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const changed = () => fail("FILE_CHANGED", "A declared review copy changed or is unavailable. Restore the checked copy before reopening.");

// Pin every path component and file version for this capability's lifetime.
// The archive supplies hashes after restart; no original is read during recovery.
async function checkedFile(file, baseline, pins) {
  const parents = [];
  let current = path.parse(file).root;
  const parts = file.slice(current.length).split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) changed();
    const prior = pins.get(current);
    if (prior && !(last ? sameVersion(prior, stat) : sameIdentity(prior, stat))) changed();
    parents.push({ file: current, stat, last });
  }
  const before = parents.at(-1).stat;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameVersion(before, await handle.stat({ bigint: true }))) changed();
    const bytes = await handle.readFile();
    if (digest(bytes) !== baseline || !sameVersion(before, await handle.stat({ bigint: true }))) changed();
    for (const entry of parents) {
      const after = await fs.lstat(entry.file, { bigint: true });
      if (after.isSymbolicLink() || !(entry.last ? sameVersion(entry.stat, after) : sameIdentity(entry.stat, after))) changed();
      pins.set(entry.file, after);
    }
    return bytes;
  } finally { await handle.close(); }
}

export async function checkedCopies(provenance, pins) {
  const buffers = new Map();
  try {
    for (const pane of PANES) {
      const copy = provenance.panes[pane].copy;
      for (const file of copy.files) {
        const full = path.resolve(copy.root, file.path);
        if (!full.startsWith(`${copy.root}${path.sep}`)) changed();
        buffers.set(`${pane}/${file.path}`, await checkedFile(full, file.sha256, pins));
      }
    }
    // Recheck after the complete pair, not only after each individual read.
    for (const [file, before] of pins) {
      const after = await fs.lstat(file, { bigint: true });
      if (after.isSymbolicLink() || !(before.isFile() ? sameVersion(before, after) : sameIdentity(before, after))) changed();
    }
    return buffers;
  } catch { changed(); }
}

export function injectDouble(bytes, comparisonId, pane) {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.tagName === "html");
  const head = root?.childNodes.find((node) => node.tagName === "head");
  const offset = head?.sourceCodeLocation?.endTag?.startOffset ?? html.length;
  const script = `<script src="/double-sdk.js" data-comparison-id="${escapeHtml(comparisonId)}" data-pane="${pane}"></script>`;
  return html.slice(0, offset) + script + html.slice(offset);
}
