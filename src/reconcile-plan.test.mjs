import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  authorityForPath,
  collectSpecPackages,
  planReconciliation,
} from "./reconcile-plan.mjs";

const spec = JSON.parse(readFileSync(new URL("../fixtures/reconcile/desired-campaignspec.json", import.meta.url), "utf8"));

test("plans every asserted settings field from the reference spec", () => {
  const plan = planReconciliation(spec);
  assert.equal(plan.campaign_ref_id, 1602);
  assert.ok(plan.settings.every((row) => row.asserted));
});

test("keeps repeated package refs as distinct selection entries (bundle picker)", () => {
  const entries = collectSpecPackages(spec);
  assert.equal(entries.length, 6, "six selection entries across four live packages");
  const picker = entries.filter((entry) => entry.ref_id === "1");
  assert.deepEqual(picker.map((entry) => entry.qty), [1, 2, 3]);
  assert.ok(picker.every((entry) => entry.page_id === "checkout"));
});

test("never de-duplicates by ref_id, which would drop every picker option but the first", () => {
  const entries = collectSpecPackages(spec);
  const refs = entries.map((entry) => entry.ref_id);
  assert.ok(refs.length > new Set(refs).size, "repeats are expected, not a defect");
});

test("reads authority from _provenance rather than inventing ownership", () => {
  assert.equal(authorityForPath(spec._provenance, "campaign.currency"), "api");
  assert.equal(authorityForPath(spec._provenance, "campaign.tracking"), "ops");
  assert.equal(authorityForPath(spec._provenance, "nothing.declared.here"), "unknown");
});

test("counts resources this source cannot yet observe so scope limits are visible", () => {
  const plan = planReconciliation(spec);
  assert.equal(plan.unsupported.offers.asserted_count, 7);
  assert.equal(plan.unsupported.campaign_shipping_methods.asserted_count, 2);
  assert.equal(plan.unsupported.offers.observable, false);
  assert.match(plan.unsupported.offers.provenance, /in development/);
});

test("carries quantity on the selection entry, where it belongs", () => {
  const plan = planReconciliation(spec);
  assert.equal(plan.selection_entry_count, 6);
  assert.deepEqual(plan.referenced_package_ids, ["1", "2", "3", "4"]);
  assert.deepEqual(
    plan.packages.map((entry) => entry.selection_id),
    ["checkout#1x1", "checkout#1x2", "checkout#1x3", "checkout#2x1", "upsell#3x1", "upsell#4x1"],
  );
});

test("labels observed prices as list prices and reports whether offers are asserted", () => {
  const plan = planReconciliation(spec);
  assert.equal(plan.price_basis, "list");
  assert.equal(plan.offers_asserted, true);
  assert.equal(planReconciliation({ campaign: {} }).offers_asserted, false);
});

test("tolerates an empty spec without throwing", () => {
  const plan = planReconciliation({});
  assert.deepEqual(plan.packages, []);
  assert.equal(plan.campaign_ref_id, null);
});
