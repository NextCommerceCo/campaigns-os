import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { shellToken } from "./shell-token.mjs";

// The characters that pass through bare are exactly the POSIX-safe set the
// helper documents; everything else is single-quoted with the embedded
// quote escaped. Every module that prints an operator command goes through
// this helper, so the charset is asserted once, here, rather than per caller.
test("bare tokens: the safe charset passes through unchanged", () => {
  for (const value of [
    "campaign-runtime.build.json",
    "/srv/example/target-page-kit",
    "olympus-mv-two-step",
    "a.b_c:d@e%f+g=h,i-j",
    "0123456789",
  ]) {
    assert.equal(shellToken(value), value, value);
  }
});

test("quoted tokens: whitespace, shell metacharacters and non-ASCII are single-quoted", () => {
  const cases = {
    "path with space": "'path with space'",
    "semi;colon": "'semi;colon'",
    "amp&and": "'amp&and'",
    "pipe|or": "'pipe|or'",
    "dollar$var": "'dollar$var'",
    "back`tick": "'back`tick'",
    "glob*star": "'glob*star'",
    "question?mark": "'question?mark'",
    "paren(open": "'paren(open'",
    "brace{open": "'brace{open'",
    "less<than": "'less<than'",
    "hash#tag": "'hash#tag'",
    "tilde~home": "'tilde~home'",
    'double"quote': "'double\"quote'",
    "back\\slash": "'back\\slash'",
    "new\nline": "'new\nline'",
    "tab\there": "'tab\there'",
    "ünïcode": "'ünïcode'",
    "": "''",
  };
  for (const [value, expected] of Object.entries(cases)) {
    assert.equal(shellToken(value), expected, JSON.stringify(value));
  }
});

test("an embedded single quote closes, escapes and reopens the quoting", () => {
  assert.equal(shellToken("it's"), "'it'\\''s'");
  assert.equal(shellToken("'"), "''\\'''");
  assert.equal(shellToken("a'b'c"), "'a'\\''b'\\''c'");
});

test("null and undefined print as an empty quoted token; every other value prints as itself", () => {
  assert.equal(shellToken(null), "''");
  assert.equal(shellToken(undefined), "''");
  assert.equal(shellToken(42), "42");
  // Falsy values are still values: a count or flag of zero must not vanish
  // from the printed command.
  assert.equal(shellToken(0), "0");
  assert.equal(shellToken(-1.5), "-1.5");
  assert.equal(shellToken(false), "false");
  assert.equal(shellToken(NaN), "NaN");
});

// The quoting is only correct if a POSIX shell reads the token back as the
// original string. Round-trip every case through /bin/sh.
test("every quoted token round-trips through /bin/sh", () => {
  for (const value of [
    "path with space", "semi;colon", "dollar$var", "back`tick", "glob*star", "it's", "a'b'c",
    'double"quote', "back\\slash", "tab\there", "ünïcode", "hash#tag", "paren(open", "",
  ]) {
    const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellToken(value)}`], { encoding: "utf8" });
    assert.equal(out, value, JSON.stringify(value));
  }
});
