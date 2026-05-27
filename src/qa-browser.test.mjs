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

test("browser test orders can reuse a configured safe QA inbox", () => {
  const { testEmail } = __qaBrowserTestHooks;
  const previous = process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;

  try {
    process.env.CAMPAIGNS_OS_QA_TEST_EMAIL = "shared@example.test";
    assert.equal(testEmail({}, "RUN123"), "shared@example.test");

    delete process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;
    assert.equal(testEmail({ "test-email": "buyer@example.test" }, "RUN123"), "buyer@example.test");
    assert.match(testEmail({}, "RUN123"), /^qa\+campaigns-os-run123-\d+@example\.com$/);
    assert.match(testEmail({ "test-email-prefix": "qa+custom" }, "RUN123"), /^qa\+custom-run123-\d+@example\.com$/);
  } finally {
    if (previous === undefined) {
      delete process.env.CAMPAIGNS_OS_QA_TEST_EMAIL;
    } else {
      process.env.CAMPAIGNS_OS_QA_TEST_EMAIL = previous;
    }
  }
});
