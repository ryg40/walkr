import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, serializeOuter } from "parse5";
import { validateDoubleInput } from "./double-input.js";
import { controllingGroup, comparisonComponents } from "./double-selection.js";
import { DoubleArchive, DoubleStoreError, hash, fail, requireShape, id, capture, absolute, contains, readBytes } from "./double-archive.js";

export { DoubleStoreError } from "./double-archive.js";
const PANES = ["left", "right"];
const clone = (value) => structuredClone(value);
const equal = isDeepStrictEqual;

export function separateComparison(archiveDir, manifest) {
  for (const pane of PANES) {
    const { copy, original } = manifest.panes[pane];
    if (contains(copy.root, archiveDir) || contains(archiveDir, copy.root) ||
        original.files.some(({ path: file }) => contains(archiveDir, file) || contains(file, archiveDir))) {
      fail("UNSAFE_PATH", "The archive must be separate from both review copies and every declared original file.");
    }
  }
}

function entryBaselines(source, components) {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const found = [];
  function text(node) {
    return node.nodeName === "#text" ? node.value : (node.childNodes || []).map(text).join("");
  }
  function visit(node) {
    const marker = node.attrs?.find(({ name }) => name === "data-double-id");
    if (marker) {
      const location = node.sourceCodeLocation;
      if (!location) fail("FILE_CHANGED", "A validated component lost its source location.");
      // Serialize the parsed region, not a source slice that could include foster-parented siblings.
      found.push({ id: marker.value, html: serializeOuter(node), text: text(node) });
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  if (!equal(found.map(({ id: componentId }) => componentId), components.map(({ id: componentId }) => componentId))) {
    fail("FILE_CHANGED", "The component baselines no longer match the validated input.");
  }
  return found;
}

async function baselines(comparison) {
  const result = {};
  try {
    for (const pane of PANES) {
      const value = comparison.panes[pane];
      // Reread every declared baseline, not just the HTML used for evidence.
      for (const file of value.original.files) {
        if (hash(await readBytes(file.path)) !== file.baselineSha256) fail("FILE_CHANGED", "An original changed before evidence capture.");
      }
      for (const file of value.copy.files) {
        const bytes = await readBytes(path.join(value.copy.root, file.path));
        if (hash(bytes) !== file.sha256) fail("FILE_CHANGED", "A review copy changed before evidence capture.");
        if (file.path === value.copy.entry) {
          result[pane] = entryBaselines(new TextDecoder("utf-8", { fatal: true }).decode(bytes), value.components);
        }
      }
    }
  } catch (error) {
    if (error instanceof DoubleStoreError) throw error;
    fail("FILE_CHANGED", "Cannot reread the validated baseline files.", { fsCode: error.code || "UNKNOWN" });
  }
  return result;
}

function initial(manifest, provenance, componentBaselines, at) {
  return {
    schemaVersion: 1, comparisonId: manifest.comparisonId, manifest, provenance, baselines: componentBaselines,
    createdAt: at, revision: 0, actions: [], feedback: [],
    state: Object.fromEntries(PANES.map((pane) => [pane, provenance.panes[pane].components.map(({ id: componentId }) => ({
      id: componentId, keeper: false, deleted: false, deletionActionId: null,
    }))])),
    delivery: { status: "editing", batch: null, acknowledgedAt: null }, receipts: [],
  };
}

function component(doc, pane, componentId) {
  if (!PANES.includes(pane)) fail("INVALID_REQUEST", "The pane must be left or right.");
  id(componentId);
  const state = doc.state[pane].find((item) => item.id === componentId);
  if (!state) fail("UNKNOWN_COMPONENT", "The component does not exist in the requested pane.");
  return state;
}

function evidence(doc, pane, componentId) {
  const value = doc.provenance.panes[pane];
  const region = value.components.find((item) => item.id === componentId);
  const baseline = doc.baselines[pane].find((item) => item.id === componentId);
  return clone({
    identity: region.identity, comparisonLabel: doc.provenance.label, paneLabel: value.label,
    label: region.label, ...(region.scope && { scope: region.scope }), ...(region.parentId && { parentId: region.parentId }),
    html: baseline.html, text: baseline.text, original: value.original, copy: value.copy,
  });
}

function view(doc) {
  const reversed = new Set(doc.actions.filter(({ kind }) => kind === "undo" || kind === "clear").map(({ undoes }) => undoes));
  const commentIds = new Set(doc.actions.filter((action) => ["comment", "round-comment"].includes(action.kind)).map((action) => action.id));
  return clone({
    comparisonId: doc.comparisonId, label: doc.provenance.label, revision: doc.revision, status: doc.delivery.status,
    panes: Object.fromEntries(PANES.map((pane) => [pane, {
      id: pane, label: doc.provenance.panes[pane].label,
      components: comparisonComponents(doc, pane).map((item) => ({
        id: item.id, label: item.label,
        keeper: item.keeper, deleted: item.deleted, deletionActionId: item.deletionActionId,
        ...(item.scope && { scope: item.scope }), ...(item.parentId && { parentId: item.parentId }),
      })),
    }])),
    history: doc.actions.filter(({ kind }) => ["delete", "feedback-delete"].includes(kind)).map((action) => ({
      id: action.id, kind: action.kind, pane: action.pane, componentId: action.componentId,
      label: doc.provenance.panes[action.pane].components.find(({ id: componentId }) => componentId === action.componentId).label,
      feedback: action.kind === "feedback-delete" ? doc.feedback.find(({ actionId }) => actionId === action.id).comment : null,
      undone: reversed.has(action.id),
    })),
    ...(commentIds.size ? {
      comments: doc.feedback.filter((entry) => commentIds.has(entry.actionId)).map((entry) => ({
        id: entry.id, comment: entry.comment, ...(entry.scope === "round" ? { scope: "round" }
          : { identity: entry.identity, label: entry.label }),
      })),
    } : {}),
    delivery: { batchId: doc.delivery.batch?.id || null, acknowledged: doc.delivery.acknowledgedAt !== null },
  });
}

function requestShape(operation, request) {
  id(request?.actionId);
  if (operation === "acknowledge") {
    requireShape(request, ["actionId", "batchId"]);
    id(request.batchId);
    return;
  }
  if (operation === "send") requireShape(request, ["actionId", "expectedRevision"]);
  else {
    const fields = {
      keeper: ["pane", "componentId", "selected"], delete: ["pane", "componentId"],
      "feedback-delete": ["pane", "componentId", "feedback"], comment: ["pane", "componentId", "feedback"],
      "round-comment": ["feedback"], undo: ["deletionActionId"], clear: ["deletionActionId"],
    };
    if (typeof request.kind !== "string" || !Object.hasOwn(fields, request.kind)) fail("INVALID_REQUEST", "Unknown comparison action kind.");
    requireShape(request, ["actionId", "expectedRevision", "kind", ...fields[request.kind]]);
    if (request.kind === "undo" || request.kind === "clear") id(request.deletionActionId);
    else if (request.kind !== "round-comment") {
      if (!PANES.includes(request.pane)) fail("INVALID_REQUEST", "The pane must be left or right.");
      id(request.componentId);
    }
    if (request.kind === "keeper" && typeof request.selected !== "boolean") fail("INVALID_REQUEST", "Keeper selection must be a boolean.");
    if (["feedback-delete", "comment", "round-comment"].includes(request.kind) && (typeof request.feedback !== "string" || !request.feedback.trim())) {
      fail("INVALID_REQUEST", "Feedback requires a nonblank comment.");
    }
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    fail("INVALID_REQUEST", "expectedRevision must be a nonnegative safe integer.");
  }
}

function batch(doc, request, at) {
  const payload = {
    comparisonId: doc.comparisonId, label: doc.provenance.label, revision: doc.revision,
    provenance: clone(doc.provenance), keepers: [], plainDeletions: [], feedbackDeletions: [],
    actions: clone(doc.actions), feedback: clone(doc.feedback), historicalFeedback: [], empty: true,
  };
  for (const pane of PANES) {
    const components = comparisonComponents(doc, pane);
    for (const item of components) {
      const group = controllingGroup(components, item.id);
      if (group) {
        // The saved inner choice stays in the record; the agent sees which group suppresses it.
        if (item.keeper || item.deleted) {
          (payload.overridden ??= []).push({ identity: clone(item.identity), keeper: item.keeper,
            deleted: item.deleted, deletionActionId: item.deletionActionId, controllingGroupId: group.id });
        }
        continue;
      }
      if (item.keeper) payload.keepers.push(evidence(doc, pane, item.id));
      if (item.deleted) {
        const action = doc.actions.find(({ id: actionId }) => actionId === item.deletionActionId);
        const entry = { ...evidence(doc, pane, item.id), deletionActionId: action.id };
        if (action.kind === "feedback-delete") payload.feedbackDeletions.push({ ...entry, feedbackId: action.feedbackId });
        else payload.plainDeletions.push(entry);
      }
    }
  }
  const reversed = new Set(doc.actions.filter(({ kind }) => kind === "undo" || kind === "clear").map(({ undoes }) => undoes));
  payload.historicalFeedback = doc.feedback.filter(({ actionId }) => reversed.has(actionId))
    .map(({ id: feedbackId, actionId }) => ({ feedbackId, actionId, undone: true }));
  payload.empty = payload.keepers.length + payload.plainDeletions.length + payload.feedbackDeletions.length === 0 &&
    !doc.actions.some((action) => ["comment", "round-comment"].includes(action.kind));
  return { id: `batch-${hash(JSON.stringify([doc.comparisonId, request.actionId]))}`, comparisonId: doc.comparisonId, sentAt: at, payload };
}

// The same deterministic transitions validate saved records without consulting vanished review copies.
function apply(doc, operation, request, at) {
  requestShape(operation, request);
  if (doc.receipts.some((receipt) => receipt.request.actionId === request.actionId)) fail("ACTION_CONFLICT", "The action ID is already saved.");
  if (operation !== "acknowledge") {
    if (request.expectedRevision !== doc.revision) fail("STALE_REVISION", "Refresh the comparison before starting a new action.");
    if (doc.delivery.status !== "editing") fail("READ_ONLY", "A sent comparison is read-only.");
  }
  if (!Number.isSafeInteger(doc.revision + 1)) fail("READ_ONLY", "The comparison revision limit is reached.");
  const result = { actionId: request.actionId, kind: operation === "act" ? request.kind : operation, revision: doc.revision + 1 };
  if (operation === "acknowledge") {
    if (!doc.delivery.batch || doc.delivery.batch.id !== request.batchId) fail("UNKNOWN_BATCH", "The batch does not belong to this sent comparison.");
    doc.delivery.acknowledgedAt ??= at;
    result.batchId = request.batchId;
  } else if (operation === "send") {
    doc.delivery.status = "sent";
    doc.revision++;
    doc.delivery.batch = batch(doc, request, at);
    result.batchId = doc.delivery.batch.id;
  } else if (request.kind === "round-comment") {
    doc.actions.push({ id: request.actionId, kind: request.kind, feedbackId: request.actionId, at });
    doc.feedback.push({ id: request.actionId, actionId: request.actionId, scope: "round", comment: request.feedback, at });
  } else if (request.kind === "undo" || request.kind === "clear") {
    const deletion = doc.actions.find(({ id: actionId, kind }) => actionId === request.deletionActionId && ["delete", "feedback-delete"].includes(kind));
    if (!deletion) fail("UNKNOWN_DELETION", "Undo requires a saved deletion action.");
    const state = component(doc, deletion.pane, deletion.componentId);
    if (!state.deleted || state.deletionActionId !== deletion.id) fail("INVALID_TRANSITION", "This deletion has already been undone.");
    Object.assign(state, request.kind === "clear" ? { keeper: false, deleted: false, deletionActionId: null } : clone(deletion.priorState));
    doc.actions.push({ id: request.actionId, kind: request.kind, undoes: deletion.id, at });
  } else {
    const state = component(doc, request.pane, request.componentId);
    if (state.deleted && request.kind !== "comment") fail("INVALID_TRANSITION", "Undo the current deletion before changing this component.");
    const action = { id: request.actionId, kind: request.kind, pane: request.pane, componentId: request.componentId, at };
    if (request.kind === "keeper") {
      action.selected = request.selected;
      state.keeper = request.selected;
    } else if (request.kind === "comment") {
      action.feedbackId = request.actionId;
      doc.feedback.push({ id: request.actionId, actionId: request.actionId, ...evidence(doc, request.pane, request.componentId), comment: request.feedback, at });
    } else {
      action.priorState = clone(state);
      state.keeper = false;
      state.deleted = true;
      state.deletionActionId = request.actionId;
      if (request.kind === "feedback-delete") {
        action.feedbackId = request.actionId;
        doc.feedback.push({ id: request.actionId, actionId: request.actionId, ...evidence(doc, request.pane, request.componentId), comment: request.feedback, at });
      }
    }
    doc.actions.push(action);
  }
  if (operation !== "send") doc.revision++;
  doc.receipts.push({ operation, request: clone(request), result, at });
  return result;
}

function validTime(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateImmutable(doc) {
  const { manifest, provenance, baselines: saved } = doc;
  requireShape(manifest, ["comparisonId", "label", "panes"]);
  id(manifest.comparisonId);
  if (manifest.comparisonId !== doc.comparisonId || typeof manifest.label !== "string" || !manifest.label.trim()) throw new Error();
  requireShape(manifest.panes, PANES);
  requireShape(provenance, ["id", "label", "panes"]);
  if (provenance.id !== doc.comparisonId || provenance.label !== manifest.label) throw new Error();
  requireShape(provenance.panes, PANES);
  requireShape(saved, PANES);
  for (const pane of PANES) {
    const input = manifest.panes[pane];
    const value = provenance.panes[pane];
    requireShape(input, ["label", "original", "copy"]);
    requireShape(input.original, ["entry", "files"]);
    requireShape(input.copy, ["root", "entry", "assets"]);
    absolute(input.copy.root);
    absolute(input.original.entry);
    if (typeof input.label !== "string" || !input.label.trim() || !Array.isArray(input.original.files) || !input.original.files.length ||
        !Array.isArray(input.copy.assets)) throw new Error();
    for (const file of input.original.files) {
      requireShape(file, ["path", "sha256"]);
      absolute(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error();
    }
    if (!input.original.files.some(({ path: file }) => file === input.original.entry) ||
        new Set(input.original.files.map(({ path: file }) => file)).size !== input.original.files.length) throw new Error();
    requireShape(value, ["id", "label", "original", "copy", "components"]);
    if (value.id !== pane || value.label !== input.label || !equal(value.original, {
      entry: input.original.entry,
      files: input.original.files.map(({ path: file, sha256 }) => ({ path: file, baselineSha256: sha256, currentSha256: sha256 })),
    })) throw new Error();
    requireShape(value.copy, ["root", "entry", "files"]);
    const files = [input.copy.entry, ...input.copy.assets];
    if (new Set(files).size !== files.length || files.some((file) => typeof file !== "string" ||
        !file.split("/").every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part)))) throw new Error();
    if (value.copy.root !== input.copy.root || value.copy.entry !== input.copy.entry || !Array.isArray(value.copy.files) ||
        !equal(files, value.copy.files.map(({ path: file }) => file))) throw new Error();
    for (const file of value.copy.files) {
      requireShape(file, ["path", "sha256"]);
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error();
    }
    if (!Array.isArray(value.components) || !value.components.length || !Array.isArray(saved[pane]) ||
        saved[pane].length !== value.components.length) throw new Error();
    const ids = new Set();
    for (const [index, region] of value.components.entries()) {
      requireShape(region, ["id", "label", "identity", "location", ...(region.scope ? ["scope"] : []), ...(region.parentId ? ["parentId"] : [])]);
      if (region.scope && !["group", "frame"].includes(region.scope)) throw new Error();
      if (region.parentId && !value.components.slice(0, index).some((parent) => parent.id === region.parentId && ["group", "frame"].includes(parent.scope))) throw new Error();
      id(region.id);
      if (ids.has(region.id) || typeof region.label !== "string" || !region.label.trim()) throw new Error();
      ids.add(region.id);
      if (!equal(region.identity, { comparisonId: doc.comparisonId, pane, componentId: region.id })) throw new Error();
      requireShape(region.location, ["file", "line", "column"]);
      if (region.location.file !== input.copy.entry || !Number.isSafeInteger(region.location.line) || region.location.line < 1 ||
          !Number.isSafeInteger(region.location.column) || region.location.column < 1) throw new Error();
      const baseline = saved[pane][index];
      requireShape(baseline, ["id", "html", "text"]);
      if (baseline.id !== region.id || typeof baseline.html !== "string" || !baseline.html || typeof baseline.text !== "string") throw new Error();
    }
  }
}

function decode(bytes, comparisonId) {
  try {
    const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requireShape(doc, ["schemaVersion", "comparisonId", "manifest", "provenance", "baselines", "createdAt", "revision", "actions", "feedback", "state", "delivery", "receipts", "checksum"]);
    const { checksum, ...body } = doc;
    if (doc.schemaVersion !== 1 || doc.comparisonId !== comparisonId || checksum !== hash(JSON.stringify(body)) ||
        !validTime(doc.createdAt) || !Array.isArray(doc.receipts)) throw new Error();
    validateImmutable(doc);
    const expected = initial(doc.manifest, doc.provenance, doc.baselines, doc.createdAt);
    for (const receipt of doc.receipts) {
      requireShape(receipt, ["operation", "request", "result", "at"]);
      if (!["act", "send", "acknowledge"].includes(receipt.operation) || !validTime(receipt.at)) throw new Error();
      apply(expected, receipt.operation, receipt.request, receipt.at);
    }
    if (!equal(body, expected)) throw new Error();
    return body;
  } catch {
    fail("RECOVERY_REQUIRED", "The comparison archive is invalid or corrupt. Preserve it and recover it before continuing.");
  }
}

// The session core embeds these same comparison records instead of coordinating separate writes.
export async function prepareComparison(input, checkSeparation = () => {}) {
  const manifest = capture(input, "INVALID_INPUT");
  const validated = await validateDoubleInput(manifest);
  if (!validated.ok) fail("INVALID_INPUT", "The complete two-copy input failed validation.", { diagnostics: validated.diagnostics });
  checkSeparation(manifest);
  return initial(manifest, validated.comparison, await baselines(validated.comparison), new Date().toISOString());
}

export function validateComparison(doc) {
  return decode(Buffer.from(JSON.stringify({ ...doc, checksum: hash(JSON.stringify(doc)) })), doc.comparisonId);
}

export { apply as applyComparison, view as comparisonView, initial as initialComparison };

export class DoubleStore {
  #archive;
  #separate;

  constructor(options) {
    requireShape(options, ["archiveDir"]);
    const { archiveDir } = options;
    this.#separate = (manifest) => separateComparison(archiveDir, manifest);
    this.#archive = new DoubleArchive({ archiveDir, prefix: "double", identity: "comparisonId", decode,
      separate: (doc) => this.#separate(doc.manifest) });
  }

  async create(input) {
    const manifest = capture(input, "INVALID_INPUT");
    return this.#archive.run(async () => {
      let existing;
      if (typeof manifest?.comparisonId === "string" && manifest.comparisonId && !/[\s\p{C}]/u.test(manifest.comparisonId)) {
        try { existing = await this.#archive.load(manifest.comparisonId); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
      }
      if (existing) {
        if (!equal(existing.doc.manifest, manifest)) fail("COMPARISON_EXISTS", "This comparison ID belongs to a different input manifest.");
        return view(existing.doc);
      }
      const doc = await prepareComparison(manifest, this.#separate);
      await this.#archive.commit(doc);
      return view(doc);
    });
  }

  async read(comparisonId) {
    return this.#archive.run(async () => view((await this.#archive.load(comparisonId)).doc));
  }

  async snapshot(comparisonId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(comparisonId);
      return clone({ ...doc, checksum: hash(JSON.stringify(doc)) });
    });
  }

  async #mutate(comparisonId, operation, request) {
    const captured = capture(request);
    return this.#archive.run(async () => {
      const { doc, bytes } = await this.#archive.load(comparisonId);
      id(captured?.actionId);
      const receipt = doc.receipts.find((item) => item.request.actionId === captured.actionId);
      if (receipt) {
        if (receipt.operation !== operation || !equal(receipt.request, captured)) {
          fail("ACTION_CONFLICT", "This action ID is already committed with a different complete request.");
        }
        return { view: view(doc), result: clone(receipt.result) };
      }
      const result = apply(doc, operation, captured, new Date().toISOString());
      await this.#archive.commit(doc, bytes);
      return { view: view(doc), result: clone(result) };
    });
  }

  async act(comparisonId, request) {
    return this.#mutate(comparisonId, "act", request);
  }

  async send(comparisonId, request) {
    return this.#mutate(comparisonId, "send", request);
  }

  async poll(comparisonId) {
    return this.#archive.run(async () => {
      const { doc } = await this.#archive.load(comparisonId);
      return doc.delivery.status === "sent" && doc.delivery.acknowledgedAt === null ? clone(doc.delivery.batch) : null;
    });
  }

  async acknowledge(comparisonId, request) {
    return this.#mutate(comparisonId, "acknowledge", request);
  }
}
