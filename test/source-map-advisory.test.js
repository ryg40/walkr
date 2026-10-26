import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cssRequire = createRequire(require.resolve("css-tree"));
const sourceMapPath = cssRequire.resolve("source-map-js");

test("CSS parser dependency rejects excessive indexed source-map offsets", () => {
  // Keep potentially blocking dependency code outside the test runner's event loop.
  const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    const { SourceMapConsumer, SourceNode } = require(${JSON.stringify(sourceMapPath)});
    const flat = { version: 3, sources: ["input.css"], sourcesContent: ["a{}"], names: [], mappings: "AAAA" };
    const indexed = (line, map = flat) => ({
      version: 3, sections: [{ offset: { line, column: 0 }, map }],
    });
    for (const map of [indexed(1e12), indexed(6000000, indexed(6000000))]) {
      assert.throws(() => new SourceMapConsumer(map), /Section offset line must not exceed/);
    }
    for (const line of [-1, 0.5, Infinity]) {
      assert.throws(() => new SourceMapConsumer(indexed(line)), /non-negative integers/);
    }
    const code = "a{}\\nb{}\\n";
    assert.equal(SourceNode.fromStringWithSourceMap(code,
      new SourceMapConsumer(indexed(1))).toString(), code);
    assert.equal(SourceNode.fromStringWithSourceMap(code,
      new SourceMapConsumer(indexed(1000000))).toString(), code);
  `], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.signal, null, `Child terminated with ${child.signal}`);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
