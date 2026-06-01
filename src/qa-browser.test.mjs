import test from "node:test";
import assert from "node:assert/strict";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";

test("order upsell response matcher accepts query strings", () => {
  const { isOrderUpsellsUrl } = __qaBrowserTestHooks;

  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells/"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells?source=checkout"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells/?source=checkout"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells-extra?source=checkout"), false);
});

test("accepted upsell proof requires exact expected quantity", () => {
  const { acceptedUpsellProof } = __qaBrowserTestHooks;
  const expected = [{ package_id: "pkg-oto", quantity: 1, display_name: "OTO" }];
  const events = { responses: [] };

  const tooMany = acceptedUpsellProof([
    { is_upsell: true, quantity: 2, ref_id: "pkg-oto", title: "OTO" },
  ], [], expected, events);
  assert.equal(tooMany.ok, false);

  const exact = acceptedUpsellProof([
    { is_upsell: true, quantity: 1, ref_id: "pkg-oto", title: "OTO" },
  ], [], expected, events);
  assert.equal(exact.ok, true);
});

test("test order email resolves to ONE stable address (reused customer, not per-run)", () => {
  const { testEmail } = __qaBrowserTestHooks;
  const previous = process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;

  try {
    // explicit flag wins
    delete process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;
    assert.equal(testEmail({ "test-email": "buyer@example.test" }), "buyer@example.test");

    // env var (the real monitored inbox in internal runs) wins over the fallback
    process.env.CAMPAIGNS_OS_QA_TEST_EMAIL = "shared@example.test";
    assert.equal(testEmail({}), "shared@example.test");

    // fallback is a SINGLE stable address — identical across calls, no runId/timestamp
    delete process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;
    const a = testEmail({});
    const b = testEmail({});
    assert.equal(a, b);
    assert.match(a, /^[^@\s]+@[^@\s]+$/);
    assert.doesNotMatch(a, /\d{10,}/); // no epoch-ms suffix

    // prefix override is also stable (no unique suffix)
    assert.equal(testEmail({ "test-email-prefix": "qa+custom" }), "qa+custom@campaigns-os.test");
    assert.equal(testEmail({ "test-email-prefix": "qa+custom@my.test" }), "qa+custom@my.test");
  } finally {
    if (previous === undefined) {
      delete process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;
    } else {
      process.env.CAMPAIGNS_OS_QA_TEST_EMAIL = previous;
    }
  }
});

test("test-order 'common' preset = checkout + accept/decline sample, scaled to funnel depth", () => {
  const { testOrderPaths } = __qaBrowserTestHooks;
  const topo = (upsells) => [{ pages: [
    { page_type: "checkout" },
    ...Array.from({ length: upsells }, () => ({ page_type: "upsell" })),
  ] }];

  // no upsells → checkout baseline only
  assert.deepEqual(testOrderPaths("common", topo(0)), ["checkout"]);
  // one upsell → checkout + first-upsell accept + decline (3 shapes)
  assert.deepEqual(testOrderPaths("common", topo(1)), ["checkout", "accept", "decline"]);
  // two+ upsells → adds one deeper mixed path (4 shapes, still under the flood cap)
  assert.deepEqual(testOrderPaths("common", topo(2)), ["checkout", "accept", "decline", "accept-decline"]);
  // bare `--test-order` parses to boolean true → same default preset
  assert.deepEqual(testOrderPaths(true, topo(1)), ["checkout", "accept", "decline"]);
});
