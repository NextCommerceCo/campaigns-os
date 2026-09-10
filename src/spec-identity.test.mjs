import assert from "node:assert/strict";
import test from "node:test";

import { specMaterialHash } from "./spec-identity.mjs";

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
