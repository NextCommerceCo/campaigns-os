import assert from "node:assert/strict";
import test from "node:test";

import { MAX_NAME_TOKENS, hasForbiddenName, sha256 } from "./check-private-strings.mjs";

// Synthetic names only: the real denylist is digests, and this file is public.
const digests = new Set(["acme", "acmebrand", "acmebigbrand", "acmebigbrandco"].map(sha256));

test("a single-word name matches in any case and punctuation", () => {
  assert.equal(hasForbiddenName("Built for ACME, launched 2026.", new Set([sha256("acme")])), true);
});

test("a two-word name matches spaced, hyphenated or joined", () => {
  const two = new Set([sha256("acmebrand")]);
  for (const text of ["the Acme Brand build", "acme-brand/logo.svg", "AcmeBrand"]) {
    assert.equal(hasForbiddenName(text, two), true, text);
  }
});

test("names of three and four words match", () => {
  assert.equal(hasForbiddenName("from the Acme Big Brand build", new Set([sha256("acmebigbrand")])), true);
  assert.equal(hasForbiddenName("acme big brand co.", new Set([sha256("acmebigbrandco")])), true);
  assert.equal(MAX_NAME_TOKENS, 4);
});

test("a name longer than the window does not match", () => {
  assert.equal(hasForbiddenName("acme big brand co ltd", new Set([sha256("acmebigbrandcoltd")])), false);
});

test("unlisted names and substrings of listed names do not match", () => {
  assert.equal(hasForbiddenName("route_root for rootfunnel", digests), false);
  assert.equal(hasForbiddenName("acmes and brands", digests), false);
});

test("the shipped denylist leaves the synthetic replacements alone", () => {
  assert.equal(hasForbiddenName("rootfunnel multi-root-repo private-template agent fixture"), false);
});
