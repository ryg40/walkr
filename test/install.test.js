import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clone = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const script = path.join(clone, "install.sh");
const LINKS = {
  walkr: "src/cli.js",
  "walkr-core": "src/walkr-core.js",
  "walkr-double": "src/walkr-double.js",
  "walkr-coinflip": "src/walkr-coinflip.js",
  "walkr-trainer": "src/walkr-trainer.js",
};
const posix = process.platform !== "win32";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "walkr-install-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { home: path.join(root, "home"), bin: path.join(root, "bin"), stubs: path.join(root, "stubs"), log: path.join(root, "npm.log") };
  fs.mkdirSync(dirs.home);
  fs.mkdirSync(dirs.stubs);
  // A stub npm keeps the test offline and leaves node_modules of the clone alone.
  stub(dirs.stubs, "npm", `echo "$@" >> '${dirs.log}'`);
  return dirs;
}
function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}
function install(dirs, args) {
  const env = { ...process.env, HOME: dirs.home, PATH: `${dirs.stubs}:${process.env.PATH}` };
  delete env.SUDO_USER;
  return spawnSync("sh", [script, "--bin-dir", dirs.binArg ?? dirs.bin, ...args], { cwd: dirs.cwd ?? dirs.home, env, encoding: "utf8" });
}
function tree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).sort();
}

test("dry run writes nothing", { skip: !posix }, (t) => {
  const dirs = fixture(t);
  const result = install(dirs, ["--global", "--dry-run", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(tree(dirs.home), []);
  assert.equal(fs.existsSync(dirs.bin), false);
  assert.equal(fs.existsSync(dirs.log), false);
});

test("install links exactly the five commands to their targets, and uninstall removes only them", { skip: !posix }, (t) => {
  const dirs = fixture(t);
  const result = install(dirs, ["--global", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  const npmRuns = fs.readFileSync(dirs.log, "utf8").trim().split("\n").map((line) => line.split(" "));
  assert.ok(npmRuns.some((words) => words[0] === "ci" && words.includes("--ignore-scripts")), "npm ci --ignore-scripts runs");
  assert.deepEqual(fs.readdirSync(dirs.bin).sort(), Object.keys(LINKS).sort());
  for (const [name, target] of Object.entries(LINKS)) {
    const link = path.join(dirs.bin, name);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), name);
    assert.equal(fs.realpathSync(link), path.join(clone, target));
  }

  const foreign = path.join(dirs.bin, "other-tool");
  fs.writeFileSync(foreign, "keep me\n");
  const removed = install(dirs, ["--uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(fs.readdirSync(dirs.bin), ["other-tool"]);
  assert.equal(fs.readFileSync(foreign, "utf8"), "keep me\n");
});

test("an old Node is refused before any write", { skip: !posix }, (t) => {
  const dirs = fixture(t);
  stub(dirs.stubs, "node", "echo v18.20.0");
  const result = install(dirs, ["--global", "--yes"]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(dirs.bin), false);
  assert.equal(fs.existsSync(dirs.log), false);
});

test("a bin path with .. through a missing directory creates no other directory", { skip: !posix }, (t) => {
  const dirs = fixture(t);
  const root = path.dirname(dirs.bin);
  dirs.binArg = path.join(root, "unused") + "/../bin";
  const result = install(dirs, ["--skip-setup", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, "unused")), false);
  assert.deepEqual(fs.readdirSync(dirs.bin).sort(), Object.keys(LINKS).sort());
});

test("a bin path with a newline in a component is refused before any write", { skip: !posix }, (t) => {
  const dirs = fixture(t);
  const root = path.dirname(dirs.bin);
  const target = path.join(root, "target\n");
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(root, "alias"));
  // Directly in the argument, only through a link to such a directory, and relative to such a current directory.
  for (const [binArg, cwd] of [[path.join(target, "bin")], [path.join(root, "alias", "bin")], ["bin", target]]) {
    dirs.binArg = binArg;
    dirs.cwd = cwd;
    const result = install(dirs, ["--skip-setup", "--yes"]);
    assert.notEqual(result.status, 0, binArg);
    assert.deepEqual(fs.readdirSync(root).sort(), ["alias", "home", "stubs", "target\n"]);
    assert.deepEqual(tree(target), []);
    assert.equal(fs.existsSync(dirs.log), false);
  }
});
