import assert from "node:assert/strict";
import { test } from "node:test";

import { collectDemoRefHits } from "./cli.mjs";

// Shared vocab: the starter template's demo-only refs collide with real
// low-integer Campaigns-API ref_ids ("1"/"2") — the root of R2-B1.
const VOCAB = { commerce: { demoOnlyValues: ["1", "2"] } };

test("R2-B1: a ref the spec declares as a real package is not flagged", () => {
  const spec = {
    funnel_pages: [
      { id: "checkout", type: "checkout", enabled: true, packages: [{ ref_id: "1", name: "Single" }] },
    ],
    offers: [{ ref_id: "10", code: "BUY1", packages: [{ ref_id: "1" }] }],
  };
  assert.deepEqual(collectDemoRefHits(spec, VOCAB), []);
});

test("R2-B1: a ref matching a declared shipping_method is not flagged", () => {
  const spec = {
    shipping_methods: [{ ref_id: "2", name: "Default" }],
    funnel_pages: [{ id: "checkout", type: "checkout", enabled: true, shipping_method: "2" }],
  };
  assert.deepEqual(collectDemoRefHits(spec, VOCAB), []);
});

test("signal preserved: a dangling ref the spec never declares is still flagged", () => {
  const spec = {
    funnel_pages: [{ id: "upsell", type: "upsell", enabled: true, package_ref_id: "2" }],
  };
  const hits = collectDemoRefHits(spec, VOCAB);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, "2");
});

test("existing provenance escape still works for an undeclared ref", () => {
  const spec = {
    campaign: { _provenance: { api: true }, fallback: { ref_id: "1" } },
  };
  assert.deepEqual(collectDemoRefHits(spec, VOCAB), []);
});

test("empty demo vocabulary yields no hits", () => {
  const spec = { funnel_pages: [{ id: "checkout", type: "checkout", enabled: true, packages: [{ ref_id: "1" }] }] };
  assert.deepEqual(collectDemoRefHits(spec, {}), []);
});

for (const [name, declarations] of Object.entries({
  "top-level package": { packages: [{ ref_id: 1 }] },
  "page package": { funnel_pages: [{ id: "upsell", type: "upsell", packages: [{ ref_id: 1 }] }] },
  "offer package": { offers: [{ packages: [{ ref_id: 1 }] }] },
  "top-level shipping": { shipping_methods: [{ ref_id: 1 }] },
  "offer shipping": { offers: [{ shipping_methods: [{ ref_id: 1 }] }] },
  "offer": { offers: [{ ref_id: 1 }] },
})) {
  test(`numeric commerce refs: ${name} does not raise demo warnings`, () => {
    const spec = { ...declarations, campaign: { selection: { ref_id: "1" } } };
    assert.deepEqual(collectDemoRefHits(spec, VOCAB), [], JSON.stringify(declarations));
  });
}

test("commerce refs accept zero and trimmed strings, skip invalid values and preserve fallback order", () => {
  const declarations = [
    { packages: [{ ref_id: 0 }] },
    { packages: [{ ref_id: " 0 " }] },
    { packages: [{ ref_id: 0, package_id: 2 }] },
    { packages: [{ ref_id: " ", package_id: 0 }] },
    { packages: [{ ref_id: NaN, package_id: {}, id: 0 }] },
    { shipping_methods: [{ ref_id: Infinity, id: false, shipping_method_id: 0 }] },
    { offers: [{ ref_id: [], id: 0 }] },
  ];
  const vocab = { commerce: { demoOnlyValues: ["0"] } };
  for (const declared of declarations) {
    assert.deepEqual(collectDemoRefHits({ ...declared, campaign: { selection: { ref_id: "0" } } }, vocab), []);
  }
  for (const invalid of [null, undefined, "", " ", NaN, Infinity, -Infinity, true, {}, []]) {
    const value = String(invalid);
    const hits = collectDemoRefHits({ packages: [{ ref_id: invalid }], campaign: { selection: { ref_id: value } } },
      { commerce: { demoOnlyValues: [value] } });
    assert.ok(hits.some((hit) => hit.path === "campaign.selection.ref_id"), `must not declare ${value}`);
  }
});
