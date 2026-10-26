import { parse, serialize } from "parse5";
import * as css from "css-tree";
import { hash, fail, requireShape } from "./double-archive.js";
import { checkedCopies } from "./double-copies.js";
import { controllingGroup, comparisonComponents, FRAME_RESET } from "./double-selection.js";

// Capture declared bytes once. A final page must survive the loss of disposable input trees.
export async function capturePair(comparison) {
  const buffers = await checkedCopies(comparison.provenance, new Map());
  return Object.fromEntries(["left", "right"].map((pane) => [pane,
    comparison.provenance.panes[pane].copy.files.map((file) => ({
      ...file, base64: buffers.get(`${pane}/${file.path}`).toString("base64"),
    })),
  ]));
}

export function validateMaterial(comparison, material) {
  requireShape(material, ["left", "right"]);
  for (const pane of ["left", "right"]) {
    const expected = comparison.provenance.panes[pane].copy.files;
    if (!Array.isArray(material[pane]) || material[pane].length !== expected.length) throw new Error("Invalid saved material");
    material[pane].forEach((file, index) => {
      requireShape(file, ["path", "sha256", "base64"]);
      const bytes = Buffer.from(file.base64, "base64");
      if (file.path !== expected[index].path || file.sha256 !== expected[index].sha256 ||
          bytes.toString("base64") !== file.base64 || hash(bytes) !== file.sha256) throw new Error("Invalid saved bytes");
    });
  }
}

export function finalPage(comparison, material, pane) {
  const copy = comparison.provenance.panes[pane].copy;
  const components = comparisonComponents(comparison, pane);
  const deleted = components.filter((c) => c.deleted && !controllingGroup(components, c.id)).map((c) => c.id);
  const files = structuredClone(material[pane]);
  const entry = files.find((file) => file.path === copy.entry);
  if (deleted.length) {
    const document = parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(entry.base64, "base64")));
    const found = new Set();
    function visit(node) {
      const marker = node.attrs?.find((a) => a.name === "data-double-id");
      if (marker && deleted.includes(marker.value)) {
        found.add(marker.value);
        // Keep head styles connected, as in the reviewed frame. A deleted html root hides
        // the entire delivered page, including root pseudo-elements; review controls are not output.
        let style = node.attrs.find((a) => a.name === "style");
        if (!style) node.attrs.push(style = { name: "style", value: "" });
        const frame = components.find((component) => component.id === marker.value)?.scope === "frame";
        const reset = frame ? FRAME_RESET : { display: "none" };
        const declarations = css.parse(style.value, { context: "declarationList" });
        declarations.children.forEach((declaration, item, list) => {
          if (declaration.type === "Declaration" && Object.hasOwn(reset, declaration.property.toLowerCase())) list.remove(item);
        });
        // An ordinary deletion keeps the earlier bytes, so pages without frames end as before.
        style.value = frame
          ? [css.generate(declarations), ...Object.entries(reset).map(([property, value]) => `${property}:${value}!important`)].filter(Boolean).join(";")
          : `${css.generate(declarations)};display:none!important`;
      }
      for (const child of node.childNodes || []) visit(child);
    }
    visit(document);
    if (found.size !== deleted.length) fail("UNSUPPORTED_FINAL", "Saved deletions cannot be located in the checked page.");
    const bytes = Buffer.from(serialize(document));
    entry.base64 = bytes.toString("base64");
    entry.sha256 = hash(bytes);
  }
  return {
    comparisonId: comparison.comparisonId, pane, entry: copy.entry, deletedComponentIds: deleted,
    deletionMode: deleted.some((id) => components.find((c) => c.id === id)?.scope === "frame") ? "static-selection" : "static-display-none", files,
  };
}
