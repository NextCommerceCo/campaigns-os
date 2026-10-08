import assert from "node:assert/strict";
import test from "node:test";

import { PricingState, deriveState, normalizeJourney, planScenarios } from "./commercial-journey.mjs";

function calculateEnvelope(descriptor) {
  const lines = descriptor.body.lines.map((line) => ({
    package_id: line.package_id,
    quantity: line.quantity,
    discounts: [],
    subtotal: "59.98",
    original_package_price: "59.98",
    total_discount: "0.00",
    total: "59.98",
  }));
  return {
    status: 200,
    response: {
      lines,
      offer_discounts: [],
      voucher_discounts: [],
      subtotal: "59.98",
      total_discount: "0.00",
      total: "59.98",
      currency: "USD",
    },
    calculated_at: "2026-08-24T00:00:00.000Z",
  };
}

test("raw page rows survive planning and drive quantity-aware recurrence truth", () => {
  const page = {
    id: "checkout",
    type: "checkout",
    order: 1,
    packages: [{
      ref_id: "5",
      qty: 2,
      is_recurring: true,
      price_recurring: "29.99",
      interval: "day",
      interval_count: 30,
    }],
  };
  const spec = {
    campaign: { currency: "USD" },
    funnels: [{ id: "default", pages: [page] }],
  };
  const plan = planScenarios(page, spec);
  const responses = Object.fromEntries(plan.map((descriptor) => [descriptor.id, calculateEnvelope(descriptor)]));
  const journey = normalizeJourney(plan, responses, spec, {});
  const row = journey.pages[0].rows[0];

  assert.equal(journey.state, PricingState.Exact);
  assert.deepEqual(row.recurrence, {
    state: PricingState.Exact,
    amount: { state: PricingState.Exact, value: "59.98", label: "Campaigns-calculated · before tax" },
    interval_count: 30,
    interval: "day",
  });
  assert.equal(row.recurring_annotation, "then $59.98 / 30 days");
});

test("an invalid recurrence never leaks a numeric recurring annotation", () => {
  const page = {
    id: "checkout",
    type: "checkout",
    packages: [{ ref_id: "5", qty: 1, is_recurring: true, price_recurring: "29.99", interval: "", interval_count: 30 }],
  };
  const spec = { campaign: { currency: "USD" }, funnels: [{ id: "default", pages: [page] }] };
  const plan = planScenarios(page, spec);
  const responses = Object.fromEntries(plan.map((descriptor) => [descriptor.id, calculateEnvelope(descriptor)]));
  const journey = normalizeJourney(plan, responses, spec, {});
  const pageResult = journey.pages[0];
  const row = pageResult.rows[0];

  assert.equal(journey.state, PricingState.Unresolved);
  assert.match(journey.reason, /invalid recurring package facts/);
  assert.equal(pageResult.state, PricingState.Unresolved);
  assert.match(pageResult.reason, /invalid recurring package facts/);
  assert.equal(row.state, PricingState.Unresolved);
  assert.match(row.reason, /invalid recurring package facts/);
  assert.equal(row.recurring_annotation, null);
  assert.equal(row.recurrence.state, PricingState.Unresolved);
  assert.match(row.recurrence.reason, /invalid recurring package facts/);
});

test("supported self-referencing commercial journey export resolves", async () => {
  const exported = await import("@nextcommerce/campaigns-os/commercial-journey");
  assert.equal(exported.planScenarios, planScenarios);
});

test("deriveState treats a prefix or case difference in the spec hash as the same spec", () => {
  const hex = "a".repeat(64);
  const calculatedAt = "2026-08-24T00:00:00.000Z";
  const result = { ok: true, spec_hash: `sha256:${hex.toUpperCase()}`, calculated_at: calculatedAt };
  const meta = { spec_hash: hex, calculated_at: calculatedAt };

  assert.equal(deriveState(result, meta), PricingState.Exact);
  assert.equal(deriveState({ ...result, spec_hash: `sha256:${"b".repeat(64)}` }, meta), PricingState.Stale);
  // Two absent hashes carry no identity: the spec-hash axis neither matches
  // nor marks the result stale, so the state falls through to the time axes.
  assert.equal(deriveState({ ok: true, calculated_at: calculatedAt }, { calculated_at: calculatedAt }), PricingState.Exact);
});

test("a checkout row marked is_order_bump alone is a bump, not part of the representative cart", () => {
  // The schema and the authoring guide mark a checkout add-on with
  // is_order_bump; the certified fixtures use it alone. Read as a main row,
  // the bump was priced into the representative checkout and never got its
  // with/without scenarios.
  for (const flag of ["is_upsell", "is_order_bump"]) {
    const page = { id: "checkout", type: "checkout", order: 1, packages: [{ ref_id: "1", qty: 1 }, { ref_id: "2", qty: 1, [flag]: true }] };
    const plan = planScenarios(page, { campaign: { currency: "USD" }, funnels: [{ id: "default", pages: [page] }] });
    const byRole = (role) => plan.filter((descriptor) => descriptor.context.role === role).map((descriptor) => descriptor.body.lines);
    assert.deepEqual(byRole("representative"), [[{ package_id: 1, quantity: 1 }]], flag);
    assert.deepEqual(byRole("bump-with"), [[{ package_id: 1, quantity: 1 }, { package_id: 2, quantity: 1, is_upsell: true }]], flag);
  }
});

// Multi-step checkout (campaigns-os#641): on a three-step path the cart is
// declared on the first step and the Checkout (billing) carries no packages,
// so it is never planned. The summary prices the step that carries the cart.
test("a three-step path's checkout total comes from the step that declares the cart", async () => {
  const { readFileSync } = await import("node:fs");
  const spec = JSON.parse(readFileSync(new URL("../contracts/fixtures/campaign-specs/shop-three-step-dynamic-shipping.json", import.meta.url), "utf8"));
  const pages = spec.funnels[0].pages;
  assert.deepEqual(pages.filter((page) => planScenarios(page, spec).length).map((page) => page.id), ["information", "upsell-stepper"]);
  const plan = pages.flatMap((page) => planScenarios(page, spec));
  const responses = plan.map((descriptor) => calculateEnvelope(descriptor));
  const journey = normalizeJourney(plan, responses, spec, {});
  assert.deepEqual(journey.pages.map((page) => [page.page_id, page.page_type]), [["information", "checkout_step"], ["upsell-stepper", "upsell"]]);
  assert.notEqual(journey.summary.representative_checkout_total.state, PricingState.Unresolved);
});
