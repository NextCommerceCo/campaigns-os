import assert from "node:assert/strict";
import test from "node:test";

import { PricingState, normalizeJourney, planScenarios } from "./commercial-journey.mjs";

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
