import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSpecHash, specHashOf, specHashesMatch, specMaterialHash } from "./spec-identity.mjs";

test("spec material identity ignores harmless JSON formatting", () => {
  const compact = JSON.parse('{"schema_version":"4.3","campaign":{"currency":"USD"},"funnels":[]}');
  const formatted = JSON.parse(`{
    "funnels": [],
    "campaign": { "currency": "USD" },
    "schema_version": "4.3"
  }`);

  assert.equal(specMaterialHash(compact), specMaterialHash(formatted));
});

test("spec material identity ignores only declared volatile top-level metadata", () => {
  const base = { schema_version: "4.3", campaign: { currency: "USD" }, funnels: [] };
  const resaved = {
    ...base,
    spec_identity: { map_id: "new-map", spec_url: "https://example.test/spec/new-map" },
    slug: "editor-slug",
    map_id: "new-map",
    saved_at: "2026-09-10T12:00:00Z",
  };

  assert.equal(specMaterialHash(base), specMaterialHash(resaved));
});

test("spec material identity changes with commerce or a different spec", () => {
  const base = { schema_version: "4.3", campaign: { currency: "USD" }, funnels: [] };
  const changedCommerce = { ...base, campaign: { currency: "EUR" } };
  const differentSpec = { ...base, funnels: [{ id: "default", weight: 100, pages: [] }] };

  assert.notEqual(specMaterialHash(base), specMaterialHash(changedCommerce));
  assert.notEqual(specMaterialHash(base), specMaterialHash(differentSpec));
});

test("spec hash normalisation: prefix, case, whitespace and empty forms", () => {
  const hex = "a".repeat(64);
  const table = [
    [hex, hex],
    [`sha256:${hex}`, hex],
    [`SHA256:${hex.toUpperCase()}`, hex],
    [`  sha256:${hex}\n`, hex],
    [`sha256: ${hex}`, hex],
    [`sha256:sha256:${hex}`, `sha256:${hex}`],
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["sha256:", null],
    [42, "42"],
  ];
  for (const [input, expected] of table) {
    assert.equal(normalizeSpecHash(input), expected, `normalizeSpecHash(${JSON.stringify(input)})`);
  }
});

test("spec hashes match across spellings and never on absence", () => {
  const hex = "b".repeat(64);
  assert.equal(specHashesMatch(hex, `sha256:${hex}`), true);
  assert.equal(specHashesMatch(`SHA256:${hex.toUpperCase()}`, ` ${hex} `), true);
  assert.equal(specHashesMatch(`sha256:${hex}`, `sha256:${"c".repeat(64)}`), false);
  assert.equal(specHashesMatch(null, null), false);
  assert.equal(specHashesMatch("", ""), false);
  assert.equal(specHashesMatch(undefined, undefined), false);
  assert.equal(specHashesMatch(hex, null), false);
  assert.equal(specHashesMatch("", hex), false);
});

test("specHashOf reads the top-level hash before the spec_identity hash and returns the raw value", () => {
  assert.equal(specHashOf({ spec_hash: "sha256:ABC" }), "sha256:ABC");
  assert.equal(specHashOf({ spec_identity: { spec_hash: "sha256:def" } }), "sha256:def");
  assert.equal(specHashOf({ spec_hash: "top", spec_identity: { spec_hash: "nested" } }), "top");
  assert.equal(specHashOf({ spec_identity: {} }), null);
  assert.equal(specHashOf({}), null);
  assert.equal(specHashOf(null), null);
});
