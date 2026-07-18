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
