import test from "node:test";
import assert from "node:assert/strict";
import { decodeDoubleComparisonId, encodeDoubleComparisonId } from "../src/double-route.js";

// Every value here is a valid input identity: nonempty, no whitespace, no Unicode category C.
const ACCEPTED_IDS = [
  ".", "..", "...", "%2e", "%2E%2E", "%2F", ".%2e", "%", "%zz", "%25",
  "~", "~~", "~trial", "~.", "a~b",
  "a/b", "/", "../x", "a\\b", "..\\..",
  "a?b=1", "?", "a#b", "#", "+&=;:@$,!*'()",
  "capabilities", "actions", "send", "trial", "trial-1",
  "é", "日本語", "✓-mark", "😀", "Ωmega_1", "ß",
  `c${"x".repeat(5000)}`, "😀".repeat(1000),
];

const FORBIDDEN_IDS = ["", " ", "a b", "a\tb", "a\nb", "a b", "a　b", "a\u0085b", "a​b", "a­b", "a\u0007b", "a\u0000b", "a\ud800", "\udc00a", "a͸b", "﻿"];

const isRouteError = (code) => (error) => error instanceof Error && error.name === "DoubleRouteError" && error.code === code;

test("encoding is one literal prefix before encodeURIComponent, and decoding restores the exact ID", () => {
  assert.equal(encodeDoubleComparisonId("trial"), "~trial");
  assert.equal(encodeDoubleComparisonId("."), "~.");
  assert.equal(encodeDoubleComparisonId(".."), "~..");
  assert.equal(encodeDoubleComparisonId("~trial"), "~~trial");
  assert.equal(encodeDoubleComparisonId("~"), "~~");
  assert.equal(encodeDoubleComparisonId("%2e"), "~%252e");
  assert.equal(encodeDoubleComparisonId("a/b?c#d"), "~a%2Fb%3Fc%23d");
  assert.equal(encodeDoubleComparisonId("a\\b"), "~a%5Cb");
  assert.equal(encodeDoubleComparisonId("é"), "~%C3%A9");
  for (const id of ACCEPTED_IDS) {
    const segment = encodeDoubleComparisonId(id);
    assert.equal(segment, `~${encodeURIComponent(id)}`, JSON.stringify(id.slice(0, 20)));
    assert.equal(decodeDoubleComparisonId(segment), id, JSON.stringify(id.slice(0, 20)));
  }
});

test("distinct accepted IDs keep distinct segments", () => {
  const segments = ACCEPTED_IDS.map(encodeDoubleComparisonId);
  assert.equal(new Set(segments).size, ACCEPTED_IDS.length);
});

test("WHATWG URL parsing keeps every segment and its action paths exactly", () => {
  // The old unprefixed segment loses dot IDs to dot-segment normalization.
  assert.equal(new URL(`/api/double/${encodeURIComponent(".")}`, "http://127.0.0.1/").pathname, "/api/double/");
  assert.equal(new URL(`/api/double/${encodeURIComponent("..")}/actions`, "http://127.0.0.1/").pathname, "/api/actions");
  assert.equal(new URL("/api/double/%2e%2e/send", "http://127.0.0.1/").pathname, "/api/send");
  for (const id of ACCEPTED_IDS) {
    const segment = encodeDoubleComparisonId(id);
    for (const suffix of ["", "/actions", "/send"]) {
      const url = new URL(`/api/double/${segment}${suffix}`, "http://127.0.0.1/");
      assert.equal(url.pathname, `/api/double/${segment}${suffix}`, JSON.stringify(id.slice(0, 20)));
      assert.equal(url.search, "");
      assert.equal(url.hash, "");
      assert.equal(decodeDoubleComparisonId(url.pathname.split("/")[3]), id);
    }
  }
});

test("the encoder rejects anything that is not a valid identity", () => {
  for (const id of [...FORBIDDEN_IDS, undefined, null, 1, ["a"], { id: "a" }]) {
    assert.throws(() => encodeDoubleComparisonId(id), isRouteError("INVALID_ID"), JSON.stringify(id));
  }
});

test("the decoder rejects missing prefixes, malformed escapes, and forbidden identities", () => {
  const malformed = [
    undefined, null, 1, "",
    "trial", ".", "..", "%7Etrial", "capabilities", // no literal prefix
    "~", // empty identity
    "~%", "~%2", "~%zz", "~%E0%A4%A", "~%C3", "~%FF", "~%ED%A0%80", // malformed escapes or UTF-8
    "~%20", "~a%09b", "~%C2%A0", "~%00", "~%E2%80%8B", "~%C2%AD", "~%EF%BB%BF", "~%CD%B8", // whitespace and category C
  ];
  for (const segment of malformed) {
    assert.throws(() => decodeDoubleComparisonId(segment), isRouteError("INVALID_SEGMENT"), JSON.stringify(segment));
  }
});

test("the decoder rejects noncanonical aliases instead of normalizing them", () => {
  const aliases = [
    "~%2e", "~%2E", "~%2e%2e", "~.%2e", // dot aliases
    "~%7Etrial", "~%7etrial", "~%74rial", // escaped unreserved characters
    "~a%2fb", "~%c3%a9", // lowercase hex
    "~é", "~a/b", "~a?b", "~a#b", "~a\\b", "~a b", // raw characters encodeURIComponent escapes
  ];
  for (const segment of aliases) {
    assert.throws(() => decodeDoubleComparisonId(segment), isRouteError("INVALID_SEGMENT"), JSON.stringify(segment));
  }
});

test("the decoder removes exactly one prefix and decodes exactly once", () => {
  assert.equal(decodeDoubleComparisonId("~~trial"), "~trial");
  assert.equal(decodeDoubleComparisonId("~~~"), "~~");
  assert.equal(decodeDoubleComparisonId("~%252e"), "%2e");
  assert.equal(decodeDoubleComparisonId("~%252E%252E"), "%2E%2E");
  assert.equal(decodeDoubleComparisonId("~%2525"), "%25");
  assert.equal(decodeDoubleComparisonId("~%25"), "%");
  // A double-encoded dot names the literal ID "%2e", never ".".
  assert.notEqual(decodeDoubleComparisonId(encodeDoubleComparisonId("%2e")), ".");
  assert.throws(() => decodeDoubleComparisonId("~~%2e"), isRouteError("INVALID_SEGMENT"));
});
