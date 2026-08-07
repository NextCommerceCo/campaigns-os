import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";

test("receipt evidence preserves raw declared price fields", () => {
  const { extractReceiptLines } = __qaBrowserTestHooks;
  const [line] = extractReceiptLines({ lines: [{
    product_title: "Fixture",
    quantity: 1,
    price_incl_tax: 45,
    price_excl_tax: 40,
  }] });

  assert.equal(line.price_incl_tax, 45);
  assert.equal(line.price_excl_tax, 40);
  assert.equal(line.price, 45);

  const [missing] = extractReceiptLines({ lines: [{ product_title: "Fixture", quantity: 1, price: 45 }] });
  assert.equal(missing.price_incl_tax, null);
  assert.equal(missing.price_excl_tax, null);
  assert.equal(missing.price, 45);
});

test("order upsell response matcher accepts query strings", () => {
  const { isOrderUpsellsUrl } = __qaBrowserTestHooks;

  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells/"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells?source=checkout"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells/?source=checkout"), true);
  assert.equal(isOrderUpsellsUrl("https://api.example.com/api/v1/orders/123/upsells-extra?source=checkout"), false);
});

test("rendered receipt passes only when persisted lines have a visible populated surface", () => {
  const { assessReceiptRendering } = __qaBrowserTestHooks;
  const result = assessReceiptRendering(2, {
    container_count: 2,
    visible_container_count: 1,
    populated_container_count: 2,
    visible_populated_container_count: 1,
    rendered_item_count: 4,
    visible_rendered_item_count: 2,
  });

  assert.equal(result.required, true);
  assert.equal(result.ok, true);
  assert.equal(result.persisted_line_count, 2);
  assert.equal(result.visible_rendered_item_count, 2);
});

test("rendered receipt fails when populated order-item containers are hidden", () => {
  const { assessReceiptRendering, receiptRenderingAssertion } = __qaBrowserTestHooks;
  const rendering = {
    selector: "[data-next-order-items]",
    container_count: 1,
    visible_container_count: 0,
    populated_container_count: 1,
    visible_populated_container_count: 0,
    rendered_item_count: 2,
    visible_rendered_item_count: 0,
    containers: [{ index: 0, visible: false, child_element_count: 2, populated: true, buyer_visible_content: false }],
  };
  const assessment = assessReceiptRendering(2, rendering);
  const assertionResult = receiptRenderingAssertion(
    { page_id: "checkout", url: "https://example.test/checkout/" },
    "checkout",
    {
      final_url: "https://example.test/receipt/?ref_id=redacted",
      receipt_line_items: [{}, {}],
      receipt_rendering: rendering,
      verification: { order_read_status: 200, receipt_rendering: assessment },
    },
  );

  assert.equal(assessment.ok, false);
  assert.match(assessment.reason, /every .* container is hidden/);
  assert.equal(assertionResult.status, "fail");
  assert.equal(assertionResult.severity, "blocker");
  assert.equal(assertionResult.url, "https://example.test/receipt/");
  assert.equal(assertionResult.evidence.persisted_order.line_count, 2);
  assert.equal(assertionResult.evidence.buyer_visible_rendering.rendered_item_count, 2);
});

test("rendered receipt fails when the order-item container is missing", () => {
  const { assessReceiptRendering } = __qaBrowserTestHooks;
  const result = assessReceiptRendering(1, {
    container_count: 0,
    visible_container_count: 0,
    populated_container_count: 0,
    visible_populated_container_count: 0,
    rendered_item_count: 0,
    visible_rendered_item_count: 0,
  });

  assert.equal(result.required, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /is missing/);
});

test("rendered receipt fails when a visible order-item container has no line items", () => {
  const { assessReceiptRendering } = __qaBrowserTestHooks;
  const result = assessReceiptRendering(1, {
    container_count: 1,
    visible_container_count: 1,
    populated_container_count: 0,
    visible_populated_container_count: 0,
    rendered_item_count: 0,
    visible_rendered_item_count: 0,
  });

  assert.equal(result.required, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no buyer-visible line items/);
});

test("rendered receipt fails when loading or empty copy is the only visible content", () => {
  const { assessReceiptRendering } = __qaBrowserTestHooks;
  const result = assessReceiptRendering(1, {
    container_count: 1,
    visible_container_count: 1,
    populated_container_count: 1,
    visible_populated_container_count: 0,
    rendered_item_count: 0,
    visible_rendered_item_count: 0,
    visible_text_length: 22,
    containers: [{
      index: 0,
      visible: true,
      child_element_count: 1,
      item_candidate_count: 0,
      visible_item_count: 0,
      has_items_state: false,
      populated: true,
      buyer_visible_content: false,
    }],
  });

  assert.equal(result.required, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no buyer-visible line items/);
});

test("rendered receipt fails when fewer lines render than persisted", () => {
  const { assessReceiptRendering } = __qaBrowserTestHooks;
  const result = assessReceiptRendering(5, {
    container_count: 2,
    visible_container_count: 2,
    populated_container_count: 2,
    visible_populated_container_count: 2,
    rendered_item_count: 5,
    visible_rendered_item_count: 5,
    max_visible_rendered_item_count: 3,
  });

  assert.equal(result.required, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /persisted order has 5 line\(s\) but only 3/);
});

test("rendered receipt check is skipped when order read-back has no lines", () => {
  const { assessReceiptRendering } = __qaBrowserTestHooks;
  const result = assessReceiptRendering(0, {
    container_count: 0,
    visible_container_count: 0,
    visible_populated_container_count: 0,
    visible_rendered_item_count: 0,
  });

  assert.equal(result.required, false);
  assert.equal(result.ok, null);
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

test("upsell accept step: order read-back is authoritative over the live API observation", () => {
  const { upsellAcceptStepFailures } = __qaBrowserTestHooks;
  const proofOk = { ok: true, reason: null };
  const proofMissing = { ok: false, reason: "expected upsell package(s) not found in final order lines: 3" };

  // Upsell line present in the persisted order → no failure, even if the live request was missed.
  assert.deepEqual(upsellAcceptStepFailures(0, proofOk, false), []);
  assert.deepEqual(upsellAcceptStepFailures(0, proofOk, true), []);

  // Line genuinely absent → real failure; the missed live request is reported alongside it.
  assert.deepEqual(upsellAcceptStepFailures(0, proofMissing, false), [
    "step 1: expected upsell package(s) not found in final order lines: 3",
    "step 1: upsell accept did not call order upsell API",
  ]);

  // Line absent but the request WAS seen → just the read-back proof failure.
  assert.deepEqual(upsellAcceptStepFailures(0, proofMissing, true), [
    "step 1: expected upsell package(s) not found in final order lines: 3",
  ]);
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

test("commerce structure assertion soft-fails when a required family shell selector is missing", () => {
  const { commerceStructureAssertionFromEvidence } = __qaBrowserTestHooks;
  const page = { page_id: "checkout", page_type: "checkout", url: "https://example.test/checkout/" };
  const result = commerceStructureAssertionFromEvidence(page, {
    template_family: "olympus",
    contract_status: "loaded",
    checks: [
      { name: "Olympus checkout wrapper", status: "fail", selectors: [".checkout-wrapper"], count: 0, visible_count: 0 },
      { name: "rendered order summary", status: "pass", selectors: ["[data-next-cart-summary]"], count: 1, visible_count: 1 },
    ],
  });

  assert.equal(result.id, "browser-commerce-structure:checkout");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "warn");
  assert.match(result.actual, /missing Olympus checkout wrapper/);
});

test("commerce structure assertion passes when contract checks pass", () => {
  const { commerceStructureAssertionFromEvidence } = __qaBrowserTestHooks;
  const page = { page_id: "checkout", page_type: "checkout" };
  const result = commerceStructureAssertionFromEvidence(page, {
    template_family: "olympus",
    contract_status: "loaded",
    checks: [
      { name: "Olympus checkout wrapper", status: "pass", selectors: [".checkout-wrapper"], count: 1, visible_count: 1 },
      { name: "rendered order summary", status: "pass", selectors: ["[data-next-cart-summary]"], count: 1, visible_count: 1 },
    ],
  });

  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
});

test("commerce structure assertion asks for manual review when contract has no selectors", () => {
  const { commerceStructureAssertionFromEvidence } = __qaBrowserTestHooks;
  const result = commerceStructureAssertionFromEvidence({ page_id: "checkout" }, {
    template_family: "demeter",
    contract_status: "missing_family_qa_structure",
    checks: [],
  });

  assert.equal(result.status, "manual_review");
  assert.equal(result.severity, "warn");
});

test("primary CTA assertion soft-fails unreadable route-driving controls", () => {
  const { primaryCtaAssertionFromEvidence } = __qaBrowserTestHooks;
  const page = { page_id: "presell", page_type: "presell", url: "https://example.test/presell/" };
  const result = primaryCtaAssertionFromEvidence(page, {
    ok: false,
    reason: "low_contrast",
    expected_url: "https://example.test/checkout/",
    primary: {
      selector: "a.cta",
      text: "Continue",
      href: "https://example.test/checkout/",
      route_matches: true,
      width: 160,
      height: 48,
      foreground: "#ffffff",
      background: "#ffffff",
      contrast_ratio: 1,
      readable: false,
      size_ok: true,
    },
    candidates: [],
  });

  assert.equal(result.id, "browser-primary-cta:presell");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "warn");
  assert.match(result.actual, /low_contrast/);
});

test("primary CTA assertion passes readable route-driving controls", () => {
  const { primaryCtaAssertionFromEvidence } = __qaBrowserTestHooks;
  const result = primaryCtaAssertionFromEvidence({ page_id: "landing", page_type: "landing" }, {
    ok: true,
    reason: "ok",
    expected_url: "https://example.test/checkout/",
    primary: {
      selector: "a.cta",
      text: "Shop now",
      href: "https://example.test/checkout/",
      route_matches: true,
      width: 180,
      height: 52,
      foreground: "#ffffff",
      background: "#113322",
      contrast_ratio: 12,
      readable: true,
      size_ok: true,
    },
    candidates: [],
  });

  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
});

test("promoted template families declare checkout commerce structure contracts", () => {
  const catalog = JSON.parse(readFileSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), "utf8"));
  const promotedFamilies = [
    "apollo",
    "apollo-mv-single-step",
    "olympus",
    "demeter",
    "shop-single-step",
    "olympus-mv-single-step",
    "olympus-mv-two-step",
    "shop-three-step",
  ];

  for (const family of promotedFamilies) {
    const contract = catalog.families?.[family]?.agentContract?.qaStructure?.checkout;
    assert.ok(contract, `${family} should declare checkout qaStructure`);
    assert.ok(contract.requiredVisibleSelectors?.length > 0, `${family} should have visible structure selectors`);
  }
});

test("--select-package builds strict card selectors covering package and bundle refs", () => {
  const { packageCardSelectors } = __qaBrowserTestHooks;
  const selectors = packageCardSelectors("7");

  assert.deepEqual(selectors, [
    '[data-next-selector-card][data-next-package-id="7"]',
    '[data-next-bundle-card][data-next-bundle-id="7"]',
    '[data-next-package-id="7"]',
    '[data-next-bundle-id="7"]',
  ]);

  // Refs are CSS-escaped so a hostile/odd ref cannot break out of the selector.
  const escaped = packageCardSelectors('a"b');
  assert.ok(escaped.every((selector) => selector.includes('a\\"b')));
});

test("order creation proof: read-back is authoritative when the live create request was missed", () => {
  const { assessOrderCreation } = __qaBrowserTestHooks;
  const body = { ref_id: "01ORDER", lines: [] };

  // Observed 2xx create → ok, no observation note.
  assert.deepEqual(
    assessOrderCreation({ orderCreate: { status: 201, body }, orderRead: null, upsellOrderResponse: null, refId: "01ORDER" }),
    { ok: true, observation: null },
  );
  // Observed create that failed stays a real failure, even with a read-back.
  assert.equal(
    assessOrderCreation({ orderCreate: { status: 422, body: {} }, orderRead: { status: 200, body }, upsellOrderResponse: null, refId: "01ORDER" }).ok,
    false,
  );
  // Missed create + persisted order returned for the ref → ok with observation.
  const readBack = assessOrderCreation({ orderCreate: null, orderRead: { status: 200, body }, upsellOrderResponse: null, refId: "01ORDER" });
  assert.equal(readBack.ok, true);
  assert.match(readBack.observation, /order read-back/);
  // Upsell mutation response also counts as read-back proof.
  assert.equal(
    assessOrderCreation({ orderCreate: null, orderRead: null, upsellOrderResponse: { status: 200, body }, refId: "01ORDER" }).ok,
    true,
  );
  // No ref_id or no evidence at all → not created.
  assert.equal(assessOrderCreation({ orderCreate: null, orderRead: null, upsellOrderResponse: null, refId: null }).ok, false);
  assert.equal(assessOrderCreation({ orderCreate: null, orderRead: null, upsellOrderResponse: null, refId: "01ORDER" }).ok, false);
});

test("coupon proof: persisted voucher code match is authoritative, discount total is weak fallback", () => {
  const { assessCouponApplication, extractOrderVouchers, orderDiscountTotal } = __qaBrowserTestHooks;

  const vouchers = extractOrderVouchers({ vouchers: [{ code: "SAVE10", name: "Save 10", amount: "5.00" }] });
  assert.deepEqual(vouchers, [{ code: "SAVE10", name: "Save 10", amount: "5.00" }]);

  const matched = assessCouponApplication("save10", { vouchers, totalDiscount: 5 });
  assert.equal(matched.ok, true);
  assert.equal(matched.basis, "persisted_voucher_code");

  // Wrong code present in the order → fail, even with a discount total.
  const wrong = assessCouponApplication("EXIT5", { vouchers, totalDiscount: 5 });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /do not include EXIT5/);

  // No voucher surface at all but a positive discount → weak-evidence pass.
  const weak = assessCouponApplication("SAVE10", { vouchers: [], totalDiscount: orderDiscountTotal({ total_discounts: "4.50" }) });
  assert.equal(weak.ok, true);
  assert.equal(weak.basis, "discount_total");

  // Nothing persisted → fail.
  const missing = assessCouponApplication("SAVE10", { vouchers: [], totalDiscount: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.basis, "missing");
});

test("voucher extraction reads alternate persisted shapes and discount-total keys", () => {
  const { extractOrderVouchers, orderDiscountTotal } = __qaBrowserTestHooks;

  const entries = extractOrderVouchers({
    voucher_discounts: [{ voucher: { code: "FREESHIP", name: "Free shipping" }, amount: "0.00" }],
    discounts: [{ voucher_code: "SAVE10", discount: "5.00" }],
  });
  assert.deepEqual(entries.map((entry) => entry.code), ["FREESHIP", "SAVE10"]);

  assert.equal(orderDiscountTotal({ total_discount_incl_tax: "3.25" }), 3.25);
  assert.equal(orderDiscountTotal({ discount_total: 2 }), 2);
  assert.equal(orderDiscountTotal({}), null);
  assert.equal(orderDiscountTotal({ total_discounts: "not-a-number" }), null);
});

test("coupon proof: line-price delta rescues platforms that net the voucher into line prices", () => {
  const { assessCouponApplication } = __qaBrowserTestHooks;
  // Modeled on bladdersupport order 226826: no voucher keys, discounts [],
  // total_discounts "0.00", but the 3x line charged 76.95 vs 81.00 list.
  const events = { responses: [
    { status: 200, url: "https://campaigns.example.test/api/v1/campaigns/", body: { packages: [
      { ref_id: 1, qty: 1, price: "31.00", price_total: "31.00", product_sku: "PN_BLADDER_SUPPORT_60_CAP" },
      { ref_id: 3, qty: 3, price: "27.00", price_total: "81.00", product_sku: "PN_BLADDER_SUPPORT_60_CAP" },
    ] } },
  ] };
  const lines = [{ title: "Bladder Support", quantity: 3, sku: "PN_BLADDER_SUPPORT_60_CAP", price_incl_tax: "76.95", is_upsell: false }];

  const applied = assessCouponApplication("PRIMAL_5", { vouchers: [], totalDiscount: 0, lines, events });
  assert.equal(applied.ok, true);
  assert.equal(applied.basis, "line_price_delta");
  assert.equal(applied.evidence.list_total, 81);
  assert.equal(applied.evidence.charged_total, 76.95);
  assert.equal(applied.evidence.delta, 4.05);

  // Same shape but charged == list → the coupon did NOT apply.
  const rejected = assessCouponApplication("PRIMAL_5", {
    vouchers: [], totalDiscount: 0, events,
    lines: [{ title: "Bladder Support", quantity: 3, sku: "PN_BLADDER_SUPPORT_60_CAP", price_incl_tax: "81.00", is_upsell: false }],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.basis, "line_price_delta");

  // Unresolvable package meta → still fails, with the unverifiable reason.
  const unresolvable = assessCouponApplication("PRIMAL_5", { vouchers: [], totalDiscount: 0, lines, events: { responses: [] } });
  assert.equal(unresolvable.ok, false);
  assert.equal(unresolvable.basis, "missing");
  assert.match(unresolvable.reason, /could not be resolved/);
});

test("package-line matching requires quantity to disambiguate same-SKU tier packages", () => {
  const { packageMatchesLine, linePriceDeltaEvidence } = __qaBrowserTestHooks;
  const oneX = { ref_id: 1, qty: 1, price: "31.00", price_total: "31.00", product_sku: "SKU_A" };
  const threeX = { ref_id: 3, qty: 3, price: "27.00", price_total: "81.00", product_sku: "SKU_A" };

  assert.equal(packageMatchesLine(threeX, { quantity: 3, sku: "SKU_A" }), true);
  assert.equal(packageMatchesLine(oneX, { quantity: 3, sku: "SKU_A" }), false);
  assert.equal(packageMatchesLine(threeX, { quantity: 3, sku: "SKU_B" }), false);
  // Variant/product-id fallbacks when SKU is absent.
  assert.equal(packageMatchesLine({ qty: 1, product_variant_id: 9 }, { quantity: 1, variant_id: 9 }), true);
  assert.equal(packageMatchesLine({ qty: 1, product_id: 5 }, { quantity: 1, product_id: 5 }), true);

  // price_total absent → unit price × qty fallback.
  const events = { responses: [{ status: 200, url: "x", body: { packages: [{ ref_id: 3, qty: 3, price: "27.00", product_sku: "SKU_A" }] } }] };
  const delta = linePriceDeltaEvidence([{ quantity: 3, sku: "SKU_A", price_incl_tax: "76.95" }], events);
  assert.equal(delta.list_total, 81);
  assert.equal(delta.lines[0].package_ref_id, 3);

  // A line no package matches → no delta evidence at all (null, not partial).
  assert.equal(linePriceDeltaEvidence([{ quantity: 2, sku: "SKU_A", price_incl_tax: "50.00" }], events), null);
});
