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

test("collects distinct packages across funnel pages without duplicating", () => {
  const packages = collectSpecPackages(spec);
  assert.deepEqual(packages.map((entry) => entry.ref_id), ["1", "2", "3", "4"]);
});

test("reads authority from _provenance rather than inventing ownership", () => {
  assert.equal(authorityForPath(spec._provenance, "campaign.currency"), "api");
  assert.equal(authorityForPath(spec._provenance, "campaign.tracking"), "ops");
  assert.equal(authorityForPath(spec._provenance, "nothing.declared.here"), "unknown");
});

test("counts asserted-but-unobservable resources so coverage can show them", () => {
  const plan = planReconciliation(spec);
  assert.equal(plan.unsupported.offers.asserted_count, 7);
  assert.equal(plan.unsupported.quantity_tier_pricing.asserted_count, 3);
  assert.equal(plan.unsupported.campaign_shipping_methods.asserted_count, 2);
  assert.equal(plan.unsupported.offers.observable, false);
});

test("marks qty unobservable on every package that asserts it", () => {
  const plan = planReconciliation(spec);
  assert.ok(plan.packages.every((entry) => entry.unobservable_fields.includes("qty")));
});

test("flags that asserted offers make observed prices pre-Offer", () => {
  const plan = planReconciliation(spec);
  assert.equal(plan.price_basis, "pre_offer");
  assert.equal(plan.offers_affect_price, true);
  assert.equal(planReconciliation({ campaign: {} }).offers_affect_price, false);
});

test("tolerates an empty spec without throwing", () => {
  const plan = planReconciliation({});
  assert.deepEqual(plan.packages, []);
  assert.equal(plan.campaign_ref_id, null);
});
