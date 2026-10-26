import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Keep this private checkout independent of the unrelated public npm package. */
export function invocation(run = spawnSync) {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = run(probe, ["human-review"], { encoding: "utf8", windowsHide: true });
  const resolved = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0].trim() : "";
  return resolved && !isTransientBin(resolved)
    ? "human-review"
    : `${commandArg(process.execPath)} ${commandArg(path.join(here, "cli.js"))}`;
}

/**
 * True for a bin that exists only for one command or only inside one project.
 * Every transient channel routes through a `node_modules` directory: `npx`,
 * `pnpm dlx`, `yarn dlx`, `bunx`, and a plain project-local dependency. npm's
 * npx cache additionally sits under `_npx`, which is worth keeping as its own
 * check because npm may relocate the bin inside it. Durable installs resolve
 * through a bin directory with neither segment: `npm i -g`, `npm link`, volta,
 * nvm, asdf, and the pnpm and yarn globals.
 *
 * A durable path that happens to contain either segment degrades to this checkout
 * invocation, so the failure direction here is cosmetic.
 */
export function isTransientBin(binPath) {
  const segments = binPath.split(/[\\/]/);
  return segments.includes("_npx") || segments.includes("node_modules");
}

/**
 * Quote a path for copy-paste into any shell. JSON.stringify would double
 * Windows backslashes; plain double quotes work in bash, zsh, cmd and
 * PowerShell alike, and paths cannot legally contain a double quote on Windows.
 */
export function shellQuote(arg) {
  const text = String(arg);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

function posixQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Quote one argument of a command that an agent runs or an owner pastes.
 * POSIX single quotes keep `$`, backticks and `"` literal in bash and zsh,
 * where shellQuote's double quotes would expand them. Windows keeps shellQuote.
 */
export function commandArg(arg, platform = process.platform) {
  const text = String(arg);
  if (platform === "win32") return shellQuote(text);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : posixQuote(text);
}

/**
 * The Core command that review output names. The managed host installs
 * `walkr-core`, the name that the walkr-core skill uses; elsewhere the
 * private checkout invocation applies.
 */
export function reviewInvocation(env = process.env, run = spawnSync) {
  return env.HUMAN_REVIEW_HOSTED === "1" ? "walkr-core" : invocation(run);
}

export const SKILL_NAMES = Object.freeze([
  "walkr", "walkr-core", "walkr-double", "walkr-coinflip", "walkr-trainer",
]);
const repository = path.resolve(here, "..");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const BLOCK_START = "<!-- walkr:start -->";
const BLOCK_END = "<!-- walkr:end -->";
const LEGACY_HEADING = "## Reviewing files and localhost pages with human-review";
const LEGACY_SKILL_HASH = "e919a34c4fbe8fb6f5f446fbf64d2492d3e07d094fcb858d9da15a151fb74a46";
const LEGACY_AGENTS_HASH = "1389b703c97b0ad6f9e05171c96dddf799dc1b0243104c8f43be9bdfcece3d68";
export const AGENTS_BLOCK = `## Walkr review modes

For HTML or Markdown feedback, read the installed walkr-core skill.
For an explicit named mode, read walkr-double, walkr-coinflip, or walkr-trainer.
Use walkr to choose a mode when the request is unclear.
Skill invocation does not authorize deployment or a chat connection.`;

export function readSkill(name = "walkr") {
  if (!SKILL_NAMES.includes(name)) throw new Error(`Unknown Walkr skill: ${name}`);
  return fs.readFileSync(path.join(repository, "skills", name, "SKILL.md"), "utf8");
}

function isLegacy(text, kind) {
  // Recognize exact historical bytes after undoing setup's one command substitution.
  const command = kind === "skill"
    ? text.match(/^   (.+) path\/to\/file\.html$/m)?.[1]
    : text.match(/`([^`]+) <file\.html>`/)?.[1];
  if (!command) return false;
  const canonical = kind === "skill"
    ? text.split("\n").map((line) => {
      const indent = line.match(/^\s*/)[0];
      return line.startsWith(`${indent}${command} `)
        ? line.replace(`${indent}${command} `, `${indent}npx -y human-review `) : line;
    }).join("\n")
    : text.replaceAll(`\`${command} `, "`npx -y human-review ");
  return digest(kind === "skill" ? canonical : canonical.trim()) ===
    (kind === "skill" ? LEGACY_SKILL_HASH : LEGACY_AGENTS_HASH);
}

/** Markers alone do not prove ownership: customized guidance stays byte-for-byte intact. */
export function mergeAgentsBlock(existing, block = AGENTS_BLOCK) {
  const marked = `${BLOCK_START}\n${block.trim()}\n${BLOCK_END}\n`;
  if (!existing) return { text: marked, action: "created" };
  for (const [start, end, legacy] of [
    [BLOCK_START, BLOCK_END, false],
    ["<!-- human-review:start -->", "<!-- human-review:end -->", true],
  ]) {
    if (!existing.includes(start) && !existing.includes(end)) continue;
    if (existing.split(start).length !== 2 || existing.split(end).length !== 2) {
      return { text: existing, action: "custom" };
    }
    const first = existing.indexOf(start);
    const last = existing.indexOf(end);
    if (last < first) return { text: existing, action: "custom" };
    const body = existing.slice(first + start.length, last).trim();
    if (legacy ? !isLegacy(body, "agents") : body !== AGENTS_BLOCK.trim()) {
      return { text: existing, action: "custom" };
    }
    const tail = existing.slice(last + end.length).replace(/^\n/, "");
    const text = `${existing.slice(0, first)}${marked}${tail}`;
    return { text, action: text === existing ? "current" : "updated" };
  }
  const head = existing.indexOf(LEGACY_HEADING);
  if (head !== -1) {
    const next = existing.indexOf("\n## ", head + LEGACY_HEADING.length);
    const stop = next === -1 ? existing.length : next + 1;
    if (!isLegacy(existing.slice(head, stop), "agents")) return { text: existing, action: "custom" };
    return { text: `${existing.slice(0, head)}${marked}${existing.slice(stop)}`, action: "updated" };
  }
  if (/human-review|walkr/i.test(existing)) return { text: existing, action: "custom" };
  return { text: `${existing.trimEnd()}\n\n${marked}`, action: "updated" };
}

function conflict(file, reason) {
  throw new Error(`Walkr setup conflict: ${file}: ${reason}. No planned files were changed; move reviewed conflicts outside discovery and retry.`);
}

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function safePath(file) {
  const parent = path.dirname(file);
  if (parent !== file) safePath(parent);
  const info = stat(file);
  if (info?.isSymbolicLink()) conflict(file, "symlinks are never followed or replaced");
  if (info && !info.isDirectory() && !info.isFile()) conflict(file, "not a regular file or directory");
  if (info?.isFile() && info.nlink > 1) conflict(file, "hard-linked files are not overwritten");
  if (stat(parent) && !stat(parent).isDirectory()) conflict(parent, "parent is not a directory");
  return info;
}

function readRegular(file) {
  const info = safePath(file);
  if (!info) return null;
  if (!info.isFile()) conflict(file, "expected a regular file");
  return fs.readFileSync(file, "utf8");
}

// No YAML parser ships in the production dependency tree. Accept only a flat,
// unambiguous scalar subset; refuse all other frontmatter instead of guessing names.
function discoveryName(file, fallback) {
  const text = readRegular(file).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end === -1) return null;
  // A top-level key cannot start on an indented line, so each indented line belongs to the key above it.
  const entries = [];
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (!entries.length || entries.at(-1).key === "name") conflict(file, "uncertain YAML frontmatter; review discovery manually");
      entries.at(-1).more.push(line.trim());
      continue;
    }
    if (line.startsWith("#")) continue;
    const match = /^([a-zA-Z][\w-]*):(?: +(.*))?$/.exec(line);
    if (!match || entries.some(({ key }) => key === match[1])) conflict(file, "uncertain YAML frontmatter; review discovery manually");
    entries.push({ key: match[1], value: (match[2] ?? "").trim(), more: [] });
  }
  const fields = new Map();
  for (const { key, value, more } of entries) {
    let parsed;
    // Discovery reads only name and description. The type of any other value does not matter.
    if (key !== "name" && key !== "description") {
      parsed = value;
    } else if (more.length) {
      // Only a description continues over lines: a block scalar, or a plain scalar that wraps.
      if (/^[|>][1-9]?[+-]?$|^[|>][+-][1-9]$/.test(value) || !value) parsed = more.join(" ");
      else if (/^["']/.test(value)) conflict(file, "unsupported YAML quoted scalar; review discovery manually");
      else parsed = `${value} ${more.join(" ")}`;
    } else if (value.startsWith('"')) {
      try { parsed = JSON.parse(value); }
      catch { conflict(file, "unsupported YAML quoted scalar; review discovery manually"); }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) conflict(file, "unsupported YAML quoted scalar; review discovery manually");
      parsed = value.slice(1, -1).replaceAll("''", "'");
    } else if (!value) {
      parsed = null;
    } else {
      if (/^(?:null|true|false|~)$/i.test(value) || /^[!&*|>{}\[\]@`%?+\d.-]/.test(value) || /[:#]/.test(value)) {
        conflict(file, "unsupported YAML scalar; review discovery manually");
      }
      parsed = value;
    }
    fields.set(key, parsed);
  }
  const description = fields.get("description");
  if (typeof description !== "string" || !description.trim()) return null;
  return fields.get("name") || fallback;
}

const DISCOVERY_VISIT_LIMIT = 20000;
// Discovery resolves with realpathSync.native: one system call per path, where the JS version
// walks each component (slow on Windows near the visit limit). Linux and macOS results are the same.
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// Resolve a planned path through its existing parent, so it compares with resolved link targets.
function resolvedPlan(file) {
  const parent = path.dirname(file);
  return stat(parent) ? path.join(fs.realpathSync.native(parent), path.basename(file)) : file;
}

// Pi discovers skills through links, so read through each link with the same name checks.
// Setup never writes, moves, or replaces a link. A link into or above a path that setup writes
// or moves into (a Walkr skill directory or the legacy backup directory) is refused.
function followLink(link, logical, context, includeRootFiles, chain) {
  let target;
  try { target = fs.realpathSync.native(link); }
  catch (error) { conflict(link, `unresolvable symlinks (${error.code}) make discovery uncertain`); }
  for (const guarded of context.guarded) {
    if (inside(target, guarded) || inside(guarded, target)) conflict(link, "symlinks into or above a Walkr setup path are never followed");
  }
  const info = fs.statSync(target);
  if (info.isDirectory()) preflightDiscovery(target, context, false, chain, logical);
  else if (!info.isFile()) conflict(link, "symlink target is not a regular file or directory");
  else if (includeRootFiles && link.endsWith(".md")) checkName(target, context, path.basename(path.dirname(logical)));
}

// Pi names a skill without a name field by the directory on its discovery path, which can be a link.
function checkName(file, context, fallback) {
  if (context.expected.has(file)) return; // Exact generated/owned or recognized legacy bytes were already checked.
  const name = discoveryName(file, fallback);
  if (SKILL_NAMES.includes(name) || name === "human-review") conflict(file, `discoverable skill name ${name} collides`);
}

// `root` is the real directory that is read; `logical` is the path on which Pi discovers it.
function preflightDiscovery(root, context, includeRootFiles = true, chain = new Set(), logical = root) {
  const info = safePath(root);
  if (!info) return;
  if (!info.isDirectory()) conflict(root, "expected a skills directory");
  const real = fs.realpathSync.native(root);
  if (chain.has(real)) return; // A link back to an ancestor ends the walk; Pi sees no new skills there.
  // Link fan-out without a cycle grows the walk exponentially. Refuse instead of hanging.
  if (++context.visits > context.visitLimit) conflict(logical, `discovery visits more than ${context.visitLimit} directories through links`);
  chain = new Set(chain).add(real);
  // Pi supports cascading ignore files. Without its ignore parser, their effect
  // is uncertain, including whether new skills would be hidden.
  for (const name of [".gitignore", ".ignore", ".fdignore"]) {
    const file = path.join(root, name);
    if (stat(file) && readRegular(file).split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith("#"))) {
      conflict(file, "discovery ignore rules require manual review");
    }
  }
  const declared = path.join(root, "SKILL.md");
  const declaredInfo = safePath(declared);
  if (declaredInfo?.isFile()) {
    if (includeRootFiles) conflict(declared, "root SKILL.md would hide installed skills");
    checkName(declared, context, path.basename(logical));
    return; // Pi stops descending at a declared skill, even without a description.
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const file = path.join(root, entry.name);
    const next = path.join(logical, entry.name);
    if (entry.isSymbolicLink()) followLink(file, next, context, includeRootFiles, chain);
    else if (entry.isDirectory()) preflightDiscovery(file, context, false, chain, next);
    else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) checkName(file, context, path.basename(logical));
  }
}

/** Preflight the entire install before writes. Pi profile writes require an explicit absolute path. */
export function installSkills(cwd, {
  global: isGlobal = false, home = os.homedir(), piAgentDir, dryRun = false,
  discoveryVisitLimit = DISCOVERY_VISIT_LIMIT, // Internal and undocumented: tests lower the limit; it never rises.
} = {}) {
  cwd = path.resolve(cwd);
  home = path.resolve(home);
  if (piAgentDir !== undefined && (!isGlobal || !path.isAbsolute(piAgentDir))) {
    throw new Error("piAgentDir requires global: true and an explicit absolute profile path");
  }
  const roots = isGlobal
    ? [["Claude Code", path.join(home, ".claude")], ["Codex", path.join(home, ".codex")], ["Shared agents", path.join(home, ".agents")]]
    : [["Claude Code", path.join(cwd, ".claude")], ["Shared agents", path.join(cwd, ".agents")]];
  const piBase = isGlobal ? (piAgentDir === undefined ? undefined : path.resolve(piAgentDir)) : path.join(cwd, ".pi");
  const sharedBase = roots.at(-1)[1];
  const plans = new Map(roots.map(([label, base]) => [base, { label, files: new Map() }]));
  if (piBase) {
    for (const base of plans.keys()) {
      if (piBase === base || piBase.startsWith(`${base}${path.sep}`) || base.startsWith(`${piBase}${path.sep}`)) {
        throw new Error("Pi profile must be separate from the other agent roots");
      }
    }
    plans.set(piBase, { label: "Pi", files: new Map() });
    // Profile-local skills win discovery order over shared skills. Refuse shadowing.
    for (const name of SKILL_NAMES) {
      for (const entry of [name, `${name}.md`]) {
        const file = path.join(piBase, "skills", entry);
        if (safePath(file)) conflict(file, "profile skill would shadow the shared Walkr skill");
      }
    }
  }
  for (const [, base] of roots) {
    for (const name of SKILL_NAMES) {
      const directory = path.join(base, "skills", name);
      if (safePath(directory)) {
        if (!stat(directory).isDirectory()) conflict(directory, "expected a skill directory");
        if (fs.readdirSync(directory).some((entry) => entry !== "SKILL.md")) conflict(directory, "unrecognized skill assets");
      }
      const standalone = path.join(base, "skills", `${name}.md`);
      if (safePath(standalone)) conflict(standalone, "standalone skill name collision");
      plans.get(base).files.set(`skills/${name}/SKILL.md`, readSkill(name)
        .replaceAll("{{LOCAL_DOUBLE_COMMAND}}", `node ${posixQuote(path.join(repository, "src", "walkr-double.js"))}`)
        .replaceAll("{{LOCAL_COINFLIP_COMMAND}}", `node ${posixQuote(path.join(repository, "src", "walkr-coinflip.js"))}`)
        .replaceAll("{{LOCAL_TRAINER_COMMAND}}", `node ${posixQuote(path.join(repository, "src", "walkr-trainer.js"))}`)
        .replaceAll("{{REPOSITORY}}", repository));
    }
  }
  if (piBase) {
    for (const name of SKILL_NAMES) {
      const template = fs.readFileSync(path.join(repository, "prompts", `${name}.md`), "utf8");
      const skillFile = path.join(sharedBase, "skills", name, "SKILL.md");
      if (skillFile.includes("$")) conflict(skillFile, "dollar signs in prompt target paths can trigger Pi argument substitution");
      plans.get(piBase).files.set(`prompts/${name}.md`, template.replaceAll("{{SKILL_FILE}}", JSON.stringify(skillFile)));
    }
  }
  const writes = [];
  const moves = [];
  const done = [];
  for (const [base, plan] of plans) {
    const manifestFile = path.join(base, ".walkr-setup.json");
    const previous = readRegular(manifestFile);
    let owned = {};
    if (previous !== null) {
      try {
        const parsed = JSON.parse(previous);
        if (parsed.version !== 1 || !parsed.files || Array.isArray(parsed.files) || typeof parsed.files !== "object") throw new Error();
        owned = parsed.files;
        if (Object.entries(owned).some(([key, value]) => !plan.files.has(key) || !/^[a-f0-9]{64}$/.test(value))) throw new Error();
      } catch { conflict(manifestFile, "unknown ownership manifest"); }
    }
    const hashes = {};
    for (const [relative, content] of plan.files) {
      const file = path.join(base, relative);
      const existing = readRegular(file);
      if (existing !== null && existing !== content && digest(existing) !== owned[relative]) conflict(file, "unknown or customized content");
      if (existing !== content) writes.push([file, content]);
      hashes[relative] = digest(content);
      done.push(`${plan.label} ${relative.startsWith("prompts/") ? "prompt" : "skill"}  ${file}`);
    }
    const legacy = path.join(base, "skills", "human-review");
    const legacyStat = safePath(legacy);
    if (legacyStat) {
      if (!legacyStat.isDirectory() || fs.readdirSync(legacy).join() !== "SKILL.md") conflict(legacy, "unknown legacy skill assets");
      const content = readRegular(path.join(legacy, "SKILL.md"));
      if (!content || !isLegacy(content, "skill")) conflict(legacy, "custom legacy skill");
      const backup = path.join(base, ".walkr-setup-backups", `human-review-${digest(content).slice(0, 16)}`);
      if (safePath(backup)) conflict(backup, "legacy backup already exists");
      moves.push([legacy, backup]);
      done.push(`Retire legacy skill to ${backup}`);
    }
    const legacyStandalone = path.join(base, "skills", "human-review.md");
    if (safePath(legacyStandalone)) conflict(legacyStandalone, "unrecognized standalone legacy skill");
    const manifest = `${JSON.stringify({ version: 1, files: hashes }, null, 2)}\n`;
    if (manifest !== previous) writes.push([manifestFile, manifest]);
  }
  const expected = new Set([
    ...[...plans].flatMap(([base, plan]) => [...plan.files.keys()]
      .filter((relative) => relative.startsWith("skills/"))
      .map((relative) => path.join(base, relative))),
    ...moves.map(([from]) => path.join(from, "SKILL.md")),
  ]);
  const guarded = [...plans.keys()].flatMap((base) => [
    ...SKILL_NAMES.map((name) => path.join(base, "skills", name)), path.join(base, ".walkr-setup-backups"),
  ]).map(resolvedPlan);
  // The option can only lower the ceiling: a value that is not a positive integer below it keeps the default.
  const visitLimit = Number.isSafeInteger(discoveryVisitLimit) && discoveryVisitLimit > 0
    ? Math.min(discoveryVisitLimit, DISCOVERY_VISIT_LIMIT) : DISCOVERY_VISIT_LIMIT;
  for (const base of plans.keys()) preflightDiscovery(path.join(base, "skills"), { expected, guarded, visits: 0, visitLimit });
  if (!isGlobal) {
    const agents = path.join(cwd, "AGENTS.md");
    const existing = readRegular(agents) ?? "";
    const { text, action } = mergeAgentsBlock(existing);
    if (action === "custom") done.push("AGENTS.md has custom guidance; preserved unchanged. Review its legacy instructions manually.");
    else if (action === "current") done.push("AGENTS.md already current");
    else {
      writes.push([agents, text]);
      done.push(`${action === "created" ? "Created" : "Updated"} AGENTS.md`);
    }
  }
  if (!dryRun) {
    // No rollback claim: filesystem errors or concurrent writers can interrupt this single-writer operation.
    for (const [from, to] of moves) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    for (const [file, content] of writes) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  done.push(piBase ? `Pi aliases: ${path.join(piBase, "prompts")}. Reload only after reviewing the installed resources.` : "Pi aliases not installed. Pass piAgentDir explicitly for the active profile.");
  if (dryRun) done.push("Preflight only; no files changed.");
  return done;
}
