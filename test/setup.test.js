import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import { AGENTS_BLOCK, SKILL_NAMES, installSkills, invocation, isTransientBin, mergeAgentsBlock } from "../src/setup.js";

const legacySkill = fs.readFileSync(new URL("./fixtures/mode-skills/legacy-skill.txt", import.meta.url), "utf8");
const legacyAgents = fs.readFileSync(new URL("./fixtures/mode-skills/legacy-agents.txt", import.meta.url), "utf8");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "walkr-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map((relative) => {
    const file = path.join(root, relative);
    const info = fs.lstatSync(file);
    return [relative, info.isSymbolicLink() ? fs.readlinkSync(file) : info.isFile() ? fs.readFileSync(file, "utf8") : null];
  });
}

test("global setup installs five skills for Claude, Codex, and shared agents without ambient Pi writes", (t) => {
  const home = fixture(t);
  const result = installSkills(home, { global: true, home });
  for (const root of [".claude", ".codex", ".agents"]) {
    for (const name of SKILL_NAMES) {
      const file = path.join(home, root, "skills", name, "SKILL.md");
      assert.match(fs.readFileSync(file, "utf8"), new RegExp(`name: ${name}\\n`));
    }
    assert.equal(fs.existsSync(path.join(home, root, "skills", "human-review")), false);
  }
  assert.equal(fs.existsSync(path.join(home, ".pi")), false);
  assert.equal(fs.existsSync(path.join(home, "AGENTS.md")), false);
  for (const label of ["Claude Code", "Codex", "Shared agents"]) assert.ok(result.some((line) => line.startsWith(`${label} skill`)));
  assert.match(result.join("\n"), /Pi aliases not installed/);
});

test("explicit Pi active profile gets only prompts and ownership metadata, never executable integration", (t) => {
  const home = fixture(t);
  const piAgentDir = path.join(home, "profiles", "active");
  installSkills(home, { global: true, home, piAgentDir });
  assert.deepEqual(fs.readdirSync(piAgentDir).sort(), [".walkr-setup.json", "prompts"]);
  assert.deepEqual(fs.readdirSync(path.join(piAgentDir, "prompts")).sort(), SKILL_NAMES.map((name) => `${name}.md`).sort());
  for (const name of SKILL_NAMES) {
    const prompt = fs.readFileSync(path.join(piAgentDir, "prompts", `${name}.md`), "utf8");
    assert.ok(prompt.includes(JSON.stringify(path.join(home, ".agents", "skills", name, "SKILL.md"))));
    assert.ok(prompt.includes("$ARGUMENTS"));
  }
  assert.equal(fs.existsSync(path.join(home, ".pi")), false);
});

test("project setup installs Claude/shared skills and Pi aliases, and repeats without changes", (t) => {
  const cwd = fixture(t);
  const home = fixture(t);
  installSkills(cwd, { home });
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "prompts", "walkr.md")), true);
  assert.equal(fs.existsSync(path.join(cwd, ".agents", "skills", "walkr-core", "SKILL.md")), true);
  assert.deepEqual(fs.readdirSync(home), []);
  const before = snapshot(cwd);
  const file = path.join(cwd, ".agents", "skills", "walkr", "SKILL.md");
  const mtime = fs.statSync(file).mtimeMs;
  const result = installSkills(cwd, { home });
  assert.deepEqual(snapshot(cwd), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.ok(result.includes("AGENTS.md already current"));
});

test("preflight is read-only and rejects invalid profile options before any writes", (t) => {
  const home = fixture(t);
  const result = installSkills(home, { global: true, home, piAgentDir: path.join(home, "active"), dryRun: true });
  assert.match(result.at(-1), /no files changed/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.throws(() => installSkills(home, { home, piAgentDir: "/unused" }), /requires global/);
  assert.throws(() => installSkills(home, { global: true, home, piAgentDir: "relative" }), /explicit absolute/);
  assert.deepEqual(fs.readdirSync(home), []);
  for (const piAgentDir of [path.join(home, ".agents", "."), path.join(home, ".agents", "skills", "active"), home]) {
    assert.throws(() => installSkills(home, { global: true, home, piAgentDir }), /must be separate/);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test("template path substitution metacharacters fail before writes", (t) => {
  const root = fixture(t);
  const home = path.join(root, "$ARGUMENTS");
  assert.throws(() => installSkills(root, { global: true, home, piAgentDir: path.join(root, "active") }), /dollar signs/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("unchanged hash-owned previous guidance updates", (t) => {
  const home = fixture(t);
  installSkills(home, { global: true, home });
  const base = path.join(home, ".agents");
  const relative = "skills/walkr/SKILL.md";
  const skill = path.join(base, relative);
  const expected = fs.readFileSync(skill, "utf8");
  const previous = "Previous generated revision\n";
  fs.writeFileSync(skill, previous);
  const manifestFile = path.join(base, ".walkr-setup.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files[relative] = createHash("sha256").update(previous).digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  installSkills(home, { global: true, home });
  assert.equal(fs.readFileSync(skill, "utf8"), expected);
});

for (const command of ["npx -y human-review", "human-review", '"/opt/node bin/node" "/opt/private checkout/src/cli.js"']) {
  test(`recognized legacy skill migrates to an undiscovered backup (${command})`, (t) => {
    const home = fixture(t);
    const skill = path.join(home, ".claude", "skills", "human-review", "SKILL.md");
    const content = legacySkill.replaceAll("npx -y human-review", command);
    put(skill, content);
    installSkills(home, { global: true, home });
    assert.equal(fs.existsSync(skill), false);
    const backupRoot = path.join(home, ".claude", ".walkr-setup-backups");
    const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0], "SKILL.md");
    assert.equal(fs.readFileSync(backup, "utf8"), content);
    const before = snapshot(home);
    installSkills(home, { global: true, home });
    assert.deepEqual(snapshot(home), before);
  });
}

test("profile-local legacy guidance also retires only when exactly recognized", (t) => {
  const home = fixture(t);
  const piAgentDir = path.join(home, "active");
  put(path.join(piAgentDir, "skills", "human-review", "SKILL.md"), legacySkill);
  installSkills(home, { global: true, home, piAgentDir });
  assert.equal(fs.existsSync(path.join(piAgentDir, "skills", "human-review")), false);
  assert.equal(fs.existsSync(path.join(piAgentDir, ".walkr-setup-backups")), true);
});

for (const relative of [".agents/skills/walkr/SKILL.md", ".agents/skills/human-review/SKILL.md", ".claude/skills/walkr/notes.txt", "active/prompts/walkr-trainer.md", "active/skills/walkr/SKILL.md", ".agents/skills/walkr.md", ".agents/skills/human-review.md"]) {
  test(`name conflict leaves all targets unchanged: ${relative}`, (t) => {
    const home = fixture(t);
    put(path.join(home, relative), "Owner customization\n");
    const before = snapshot(home);
    assert.throws(() => installSkills(home, { global: true, home, piAgentDir: path.join(home, "active") }), /conflict/);
    assert.deepEqual(snapshot(home), before);
  });
}

for (const relative of [".agents/skills/walkr", ".agents/skills/human-review", ".claude", "active/prompts/walkr.md", ".agents/.walkr-setup.json"]) {
  test(`symlink collision preserves backing source: ${relative}`, (t) => {
    const home = fixture(t);
    const backing = fixture(t);
    put(path.join(backing, "SKILL.md"), "Unrelated artifact service skill\n");
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(backing, target);
    const before = snapshot(home);
    assert.throws(() => installSkills(home, { global: true, home, piAgentDir: path.join(home, "active") }), /symlinks/);
    assert.deepEqual(snapshot(home), before);
    assert.equal(fs.readFileSync(path.join(backing, "SKILL.md"), "utf8"), "Unrelated artifact service skill\n");
  });
}

test("broken symlinks and hard-linked files fail closed", (t) => {
  const home = fixture(t);
  const link = path.join(home, ".agents", "skills", "walkr");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(home, "missing"), link);
  assert.throws(() => installSkills(home, { global: true, home }), /symlinks/);
  const second = fixture(t);
  const backing = path.join(second, "backing");
  put(backing, "custom\n");
  const hardlink = path.join(second, ".agents", "skills", "walkr", "SKILL.md");
  fs.mkdirSync(path.dirname(hardlink), { recursive: true });
  fs.linkSync(backing, hardlink);
  assert.throws(() => installSkills(second, { global: true, home: second }), /hard-linked/);
  assert.equal(fs.readFileSync(backing, "utf8"), "custom\n");
});

test("a customized installed skill is not replaced even with an ownership manifest", (t) => {
  const home = fixture(t);
  installSkills(home, { global: true, home });
  const skill = path.join(home, ".agents", "skills", "walkr", "SKILL.md");
  fs.appendFileSync(skill, "\nOwner rules.\n");
  const before = snapshot(home);
  assert.throws(() => installSkills(home, { global: true, home }), /customized content/);
  assert.deepEqual(snapshot(home), before);
});

test("discovery preserves unrelated skills and respects skill-root and hidden-directory boundaries", (t) => {
  const home = fixture(t);
  const root = path.join(home, ".agents/skills");
  const custom = "---\nname: custom\ndescription: Owner guidance\n---\n";
  const collision = "---\nname: walkr\ndescription: Not discovered\n---\n";
  put(path.join(root, "pack/custom/SKILL.md"), custom);
  put(path.join(root, "pack/custom/nested/SKILL.md"), collision);
  put(path.join(root, ".hidden/SKILL.md"), collision);
  put(path.join(root, "node_modules/dependency/SKILL.md"), collision);
  put(path.join(root, "pack/readme.md"), collision);
  const before = snapshot(home);
  installSkills(home, { global: true, home });
  const after = new Map(snapshot(home));
  for (const [file, content] of before) assert.equal(after.get(file), content);
});

for (const [relative, content] of [
  ["SKILL.md", "---\nname: custom\ndescription: Hides children\n---\n"],
  [".ignore", "custom-pack/\n"],
  ["custom-pack/router/SKILL.md", "---\nname: &name walkr\ndescription: Custom\n---\n"],
  ["custom-pack/router/SKILL.md", "---\nname: 'walkr' # valid YAML comment\ndescription: Custom\n---\n"],
]) {
  test(`uncertain discovery refuses without writes: ${relative} ${content.slice(0, 30)}`, (t) => {
    const home = fixture(t);
    put(path.join(home, ".agents/skills", relative), content);
    const before = snapshot(home);
    assert.throws(() => installSkills(home, { global: true, home }), /Walkr setup conflict/);
    assert.deepEqual(snapshot(home), before);
  });
}

test("discovery reads through a linked pack and refuses a Walkr name inside it without writes", (t) => {
  const home = fixture(t), external = fixture(t);
  put(path.join(external, "router/SKILL.md"), "---\nname: walkr\ndescription: External\n---\n");
  const link = path.join(home, ".agents/skills/custom-pack");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(external, link);
  const before = snapshot(external);
  assert.throws(() => installSkills(home, { global: true, home }), /discoverable skill name walkr collides/);
  assert.equal(fs.readlinkSync(link), external);
  assert.deepEqual(snapshot(external), before);
  assert.deepEqual(fs.readdirSync(home), [".agents"]);
});

test("linked unrelated skills, link cycles and a linked Markdown skill install without touching the links", (t) => {
  const home = fixture(t), external = fixture(t);
  put(path.join(external, "aws/SKILL.md"), "---\nname: aws-archify\ndescription: Unrelated\ndisable-model-invocation: true\n---\n");
  put(path.join(external, "notes.md"), "---\nname: notes\ndescription: Unrelated\n---\n");
  fs.symlinkSync(external, path.join(external, "loop"));
  const claude = path.join(home, ".claude/skills"), agents = path.join(home, ".agents/skills");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.symlinkSync(path.join(external, "aws"), path.join(claude, "aws-archify"));
  fs.symlinkSync("../../.claude/skills/aws-archify", path.join(agents, "aws-archify"));
  fs.symlinkSync(path.join(external, "notes.md"), path.join(agents, "notes.md"));
  fs.symlinkSync(external, path.join(agents, "pack"));
  const before = snapshot(external);
  installSkills(home, { global: true, home });
  for (const name of SKILL_NAMES) assert.ok(fs.existsSync(path.join(agents, name, "SKILL.md")));
  assert.equal(fs.readlinkSync(path.join(claude, "aws-archify")), path.join(external, "aws"));
  assert.equal(fs.readlinkSync(path.join(agents, "aws-archify")), "../../.claude/skills/aws-archify");
  assert.deepEqual(snapshot(external), before);
});

for (const [label, target] of [["a linked root Markdown file", "walkr.md"], ["a broken link", "missing"]]) {
  test(`discovery refuses ${label} without writes`, (t) => {
    const home = fixture(t), external = fixture(t);
    put(path.join(external, "walkr.md"), "---\nname: walkr-core\ndescription: External\n---\n");
    const link = path.join(home, ".agents/skills/other.md");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(external, target), link);
    const before = snapshot(home);
    assert.throws(() => installSkills(home, { global: true, home }), target === "missing" ? /unresolvable symlinks \(ENOENT\)/ : /walkr-core collides/);
    assert.deepEqual(snapshot(home), before);
  });
}

test("a link into a Walkr install path is refused, so no second copy of a Walkr name appears", (t) => {
  const home = fixture(t);
  installSkills(home, { global: true, home });
  const link = path.join(home, ".claude/skills/router");
  fs.symlinkSync(path.join(home, ".agents/skills/walkr"), link);
  const before = snapshot(home);
  assert.throws(() => installSkills(home, { global: true, home }), /into or above a Walkr setup path/);
  assert.deepEqual(snapshot(home), before);
});

for (const [label, front, name] of [
  ["a folded description", "name: custom\ndescription: >\n  First line.\n\n  Second line.\n", null],
  ["a wrapped plain description", "name: custom\ndescription: First line\n  continues here\n", null],
  ["a Walkr name with a block description", "name: walkr\ndescription: |-\n  Router\n", "walkr"],
]) {
  test(`frontmatter with ${label} is read by its name`, (t) => {
    const home = fixture(t);
    put(path.join(home, ".agents/skills/custom/SKILL.md"), `---\n${front}---\n`);
    if (name) assert.throws(() => installSkills(home, { global: true, home }), new RegExp(`name ${name} collides`));
    else installSkills(home, { global: true, home });
  });
}

for (const linkName of ["walkr-core", "human-review"]) {
  test(`a nameless linked skill takes the name of its link path: ${linkName}`, (t) => {
    const home = fixture(t), external = fixture(t);
    put(path.join(external, "foo/SKILL.md"), "---\ndescription: Nameless\n---\n");
    fs.mkdirSync(path.join(home, ".agents/skills/pack"), { recursive: true });
    fs.mkdirSync(path.join(home, ".agents/skills/pack2"), { recursive: true });
    // The first path to the shared target has a harmless name; the second must still be checked.
    fs.symlinkSync(path.join(external, "foo"), path.join(home, ".agents/skills/pack/ok"));
    fs.symlinkSync(path.join(external, "foo"), path.join(home, ".agents/skills/pack2", linkName));
    const before = snapshot(home);
    assert.throws(() => installSkills(home, { global: true, home }), new RegExp(`name ${linkName} collides`));
    assert.deepEqual(snapshot(home), before);
  });
}

test("a link into the legacy backup directory is refused before the legacy move", (t) => {
  const home = fixture(t);
  put(path.join(home, ".claude/skills/human-review/SKILL.md"), legacySkill);
  fs.mkdirSync(path.join(home, ".claude/.walkr-setup-backups"));
  fs.mkdirSync(path.join(home, ".agents/skills"), { recursive: true });
  fs.symlinkSync(path.join(home, ".claude/.walkr-setup-backups"), path.join(home, ".agents/skills/bk"));
  const before = snapshot(home);
  assert.throws(() => installSkills(home, { global: true, home }), /into or above a Walkr setup path/);
  assert.deepEqual(snapshot(home), before);
});

test("link fan-out without a cycle is refused instead of an exponential walk", (t) => {
  const home = fixture(t), external = fixture(t);
  for (let level = 0; level <= 20; level++) fs.mkdirSync(path.join(external, `d${level}`));
  for (let level = 0; level < 20; level++) {
    for (const name of ["a", "b"]) fs.symlinkSync(path.join(external, `d${level + 1}`), path.join(external, `d${level}`, name));
  }
  fs.mkdirSync(path.join(home, ".agents/skills"), { recursive: true });
  fs.symlinkSync(path.join(external, "d0"), path.join(home, ".agents/skills/pack"));
  const started = Date.now();
  assert.throws(() => installSkills(home, { global: true, home, dryRun: true }), /more than 20000 directories/);
  assert.ok(Date.now() - started < 30000);
});

test("a link to the filesystem root is refused as above every setup path", (t) => {
  const home = fixture(t);
  fs.mkdirSync(path.join(home, ".agents/skills"), { recursive: true });
  fs.symlinkSync(path.parse(home).root, path.join(home, ".agents/skills/everything"));
  assert.throws(() => installSkills(home, { global: true, home }), /into or above a Walkr setup path/);
});

for (const [label, front] of [
  ["an indented line before the first key", "  name: walkr\ndescription: Custom\n"],
  ["a quoted multiline description", "name: custom\ndescription: \"First\n  second\"\n"],
]) {
  test(`frontmatter with ${label} stays uncertain`, (t) => {
    const home = fixture(t);
    put(path.join(home, ".agents/skills/custom/SKILL.md"), `---\n${front}---\n`);
    assert.throws(() => installSkills(home, { global: true, home }), /uncertain YAML frontmatter|quoted scalar/);
  });
}

test("an indented line under name stays uncertain", (t) => {
  const home = fixture(t);
  put(path.join(home, ".agents/skills/custom/SKILL.md"), "---\nname:\n  walkr\ndescription: Custom\n---\n");
  assert.throws(() => installSkills(home, { global: true, home }), /uncertain YAML frontmatter/);
});

test("malformed ownership metadata fails before writes", (t) => {
  const home = fixture(t);
  put(path.join(home, ".agents", ".walkr-setup.json"), "{broken");
  const before = snapshot(home);
  assert.throws(() => installSkills(home, { global: true, home }), /unknown ownership manifest/);
  assert.deepEqual(snapshot(home), before);
});

test("a project setup migrates exact legacy AGENTS blocks and preserves neighboring text", (t) => {
  for (const marked of [false, true]) {
    const cwd = fixture(t);
    const body = legacyAgents.replaceAll("npx -y human-review", "human-review");
    const old = marked ? `<!-- human-review:start -->\n${body}\n<!-- human-review:end -->\n` : `${body}\n\n`;
    const file = path.join(cwd, "AGENTS.md");
    put(file, `# House rules\n\n${old}## Testing\n\nRun npm test.\n`);
    installSkills(cwd, { home: fixture(t) });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /# House rules/);
    assert.match(text, /## Testing\n\nRun npm test/);
    assert.match(text, /<!-- walkr:start -->/);
    assert.doesNotMatch(text, /human-review|npx/);
    assert.equal(mergeAgentsBlock(text).action, "current");
  }
});

for (const body of [
  "# Project\nWe use human-review our own way.\n",
  "## Reviewing files and localhost pages with human-review\n\nCustom policy.\n",
  `<!-- human-review:start -->\n${legacyAgents}\nCustom policy.\n<!-- human-review:end -->\n`,
  "<!-- human-review:start -->\nBroken marker\n",
  "<!-- human-review:end -->\n<!-- human-review:start -->\n",
  `<!-- walkr:start -->\n${AGENTS_BLOCK}\nCustom policy.\n<!-- walkr:end -->\n`,
]) {
  test(`custom AGENTS guidance stays unchanged: ${body.slice(0, 50)}`, (t) => {
    assert.deepEqual(mergeAgentsBlock(body), { text: body, action: "custom" });
    const cwd = fixture(t);
    put(path.join(cwd, "AGENTS.md"), body);
    const result = installSkills(cwd, { home: fixture(t) });
    assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), body);
    assert.match(result.join("\n"), /preserved unchanged/);
  });
}

test("AGENTS symlink conflict blocks the whole project installation", (t) => {
  const cwd = fixture(t);
  const home = fixture(t);
  const backing = path.join(home, "rules.md");
  put(backing, "Owner rules\n");
  fs.symlinkSync(backing, path.join(cwd, "AGENTS.md"));
  assert.throws(() => installSkills(cwd, { home }), /symlinks/);
  assert.deepEqual(fs.readdirSync(cwd), ["AGENTS.md"]);
  assert.equal(fs.readFileSync(backing, "utf8"), "Owner rules\n");
});

test("transient bins are not durable installs", () => {
  for (const file of ["/Users/x/.npm/_npx/a/node_modules/.bin/human-review", "C:\\Users\\x\\node_modules\\.bin\\human-review.cmd", "/Users/x/project/node_modules/.bin/human-review"]) assert.equal(isTransientBin(file), true);
  for (const file of ["/usr/local/bin/human-review", "/Users/x/.volta/bin/human-review", "/Users/x/my_npx_tools/bin/human-review", "/Users/x/node_modules_backup/bin/human-review"]) assert.equal(isTransientBin(file), false);
});

test("existing runtime invocation remains private and hides its lookup window", () => {
  const probe = (bin) => (_probe, _args, options) => {
    assert.equal(options.windowsHide, true);
    return { status: bin ? 0 : 1, stdout: bin ? `${bin}\n` : "" };
  };
  const local = invocation(probe(""));
  assert.match(local, /cli\.js/);
  assert.ok(local.includes(process.execPath));
  assert.doesNotMatch(local, /npx/);
  assert.equal(invocation(probe("/Users/x/project/node_modules/.bin/human-review")), local);
  assert.equal(invocation(probe("/Users/x/.local/bin/human-review")), "human-review");
});
