import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isCanonicalAbsolute, overlaps } from "../src/canonical-path.js";

test("canonical absolute paths have one spelling on POSIX", () => {
  for (const good of ["/a", "/tmp/walkr-x/archive", "/a/b c/RUNNER~1"]) assert.ok(isCanonicalAbsolute(good, path.posix), good);
  for (const bad of [undefined, "", "/", "a/b", "/a/", "/a//b", "/a/./b", "/a/../b", "/a\\b", "/a\nb", "/a\x7fb"]) {
    assert.ok(!isCanonicalAbsolute(bad, path.posix), JSON.stringify(bad));
  }
});

test("canonical absolute paths have one spelling on Windows", () => {
  for (const good of ["C:\\a", "D:\\a\\walkr\\walkr", "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\walkr-x", "C:\\a\\file.json"]) {
    assert.ok(isCanonicalAbsolute(good, path.win32), good);
  }
  for (const bad of [
    "C:\\", "C:", "C:a", "c:\\a", "\\a", "C:\\a\\", "C:/a", "C:\\a/b", "C:\\a\\\\b", "C:\\a\\..\\b", "C:\\a\\.\\b",
    "\\\\server\\share\\a", "\\\\?\\C:\\a", "\\\\.\\C:\\a", "C:\\a\\b:stream", "C:\\a\\*", "C:\\a\\b.", "C:\\a\\b ",
    "C:\\a\\nul", "C:\\a\\CON.txt", "C:\\a\\com1", "C:\\a\nb",
  ]) {
    assert.ok(!isCanonicalAbsolute(bad, path.win32), JSON.stringify(bad));
  }
});

test("overlapping directories are found with the platform separator and case rule", () => {
  assert.ok(overlaps("/a/b", "/a", path.posix));
  assert.ok(overlaps("/a", "/a/b", path.posix));
  assert.ok(!overlaps("/a/bc", "/a/b", path.posix));
  assert.ok(!overlaps("/A/b", "/a", path.posix));
  assert.ok(overlaps("C:\\a\\b", "C:\\a", path.win32));
  assert.ok(overlaps("C:\\A\\b", "c:\\a", path.win32));
  assert.ok(!overlaps("C:\\a\\bc", "C:\\a\\b", path.win32));
  assert.ok(!overlaps("C:\\a/b", "C:\\a/c", path.win32));
});
