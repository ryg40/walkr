import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { tmpRoot } from "./tmp-root.js";

const repository = path.resolve(import.meta.dirname, "..");

test("offline package installs and preflights with complete rendered references and no Pi autoload", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpRoot, "walkr-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  // On Windows npm is npm.cmd, which needs a shell; npm test names its own CLI script.
  const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ["npm"];
  const packed = JSON.parse(run(npm[0], [...npm.slice(1), "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], repository))[0];
  // A relative archive name: GNU tar reads "C:..." as a remote host.
  run("tar", ["-xzf", packed.filename]);
  const unpacked = path.join(root, "package");
  const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
  assert.equal(pkg.pi, undefined);
  assert.equal(fs.existsSync(path.join(unpacked, "extensions")), false);
  const { installSkills, SKILL_NAMES } = await import(pathToFileURL(path.join(unpacked, "src/setup.js")));
  const home = path.join(root, "home");
  const options = { global: true, home, piAgentDir: path.join(root, "profile") };
  installSkills(root, { ...options, dryRun: true });
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.existsSync(options.piAgentDir), false);
  installSkills(root, options);
  installSkills(root, { ...options, dryRun: true });
  const visited = new Set();
  function references(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const [, rawLink] of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = rawLink.replaceAll("{{REPOSITORY}}", unpacked);
      if (/^[a-z]+:|^#/i.test(link)) continue;
      const target = path.resolve(path.dirname(file), link.split("#")[0]);
      assert.equal(fs.existsSync(target), true, `${file}: ${link}`);
      if (target.endsWith(".md")) references(target);
    }
  }
  for (const name of SKILL_NAMES) {
    const installed = path.join(home, ".agents/skills", name, "SKILL.md");
    assert.doesNotMatch(fs.readFileSync(installed, "utf8"), /\{\{[A-Z_]+\}\}/);
    references(installed);
    const prompt = fs.readFileSync(path.join(options.piAgentDir, "prompts", `${name}.md`), "utf8");
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
    assert.ok(prompt.includes(JSON.stringify(path.join(home, ".agents/skills", name, "SKILL.md"))));
  }
  references(path.join(unpacked, "README.md"));
  // Every {{LOCAL_*_COMMAND}} placeholder in a source skill renders to its quoted checkout command.
  const rendered = { DOUBLE: ["walkr-double", "gui view"], COINFLIP: ["walkr-coinflip", "gui view"], TRAINER: ["walkr-trainer", "serve"] };
  const placeholders = new Set(SKILL_NAMES.flatMap((name) => [...fs.readFileSync(path.join(unpacked, "skills", name, "SKILL.md"), "utf8")
    .matchAll(/\{\{LOCAL_([A-Z]+)_COMMAND\}\}/g)].map((match) => match[1])));
  assert.deepEqual([...placeholders].sort(), Object.keys(rendered).sort());
  for (const [mode, [name, args]] of Object.entries(rendered)) {
    const skill = fs.readFileSync(path.join(home, ".agents/skills", name, "SKILL.md"), "utf8");
    assert.ok(skill.includes(`node '${path.join(unpacked, "src", `${name}.js`)}' ${args}`), mode);
  }
  // Every packed extension resolves its relative imports inside the package, wherever the files sit.
  const extensions = fs.readdirSync(path.join(unpacked, "integrations/pi"), { recursive: true }).filter((entry) => entry.endsWith(".ts"));
  assert.ok(extensions.length > 0);
  for (const entry of extensions) {
    const file = path.join(unpacked, "integrations/pi", entry);
    const text = fs.readFileSync(file, "utf8");
    for (const [, relative] of text.matchAll(/from "(\.[^"]+)"/g)) {
      assert.equal(fs.existsSync(path.resolve(path.dirname(file), relative)), true);
    }
  }
});
