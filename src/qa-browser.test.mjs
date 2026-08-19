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

test("test-order 'common' preset = checkout + accept/decline sample plus a shortest real receipt path", () => {
  const { testOrderPaths } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topo = (upsells) => {
    const receipt = { page_id: "receipt", page_type: "thankyou", url: route("receipt/") };
    const pages = [{
      page_id: "checkout",
      page_type: "checkout",
      url: route("checkout/"),
      ...(upsells ? { expected_next_url: route("upsell-1/") } : {}),
    }];
    for (let index = 1; index <= upsells; index += 1) {
      const nextUrl = index === upsells ? receipt.url : route(`upsell-${index + 1}/`);
      pages.push({
        page_id: `upsell-${index}`,
        page_type: "upsell",
        url: route(`upsell-${index}/`),
        expected_accept_url: nextUrl,
        expected_decline_url: nextUrl,
      });
    }
    pages.push(receipt);
    return [{ funnel_id: `depth-${upsells}`, pages }];
  };

  // no upsells → checkout baseline only
  assert.deepEqual(testOrderPaths("common", topo(0)), ["checkout"]);
  // one upsell → checkout + first-upsell accept + decline (3 shapes)
  assert.deepEqual(testOrderPaths("common", topo(1)), ["checkout", "accept", "decline"]);
  // two+ upsells → adds one deeper mixed path (4 shapes, still under the flood cap)
  assert.deepEqual(testOrderPaths("common", topo(2)), ["checkout", "accept", "decline", "accept-decline"]);
  // bare `--test-order` parses to boolean true → same default preset
  assert.deepEqual(testOrderPaths(true, topo(1)), ["checkout", "accept", "decline"]);
});

test("test-order 'full' emits only actual terminal paths for shortcutting branches", () => {
  const { testOrderPaths } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topology = [{ funnel_id: "shortcut", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell-1/") },
    { page_id: "upsell-1", page_type: "upsell", url: route("upsell-1/"), expected_accept_url: route("upsell-2/"), expected_decline_url: route("upsell-2/") },
    { page_id: "upsell-2", page_type: "upsell", url: route("upsell-2/"), expected_accept_url: route("receipt/"), expected_decline_url: route("downsell/") },
    { page_id: "downsell", page_type: "downsell", url: route("downsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];

  assert.deepEqual(testOrderPaths("full", topology), [
    "checkout",
    "decline-decline-decline",
    "decline-decline-accept",
    "decline-accept",
    "accept-decline-decline",
    "accept-decline-accept",
    "accept-accept",
  ]);
});

test("test-order 'common' adds the shortest real receipt path for a shortcutting funnel", () => {
  const { testOrderPaths } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topology = [{ funnel_id: "shortcut", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell-1/") },
    { page_id: "upsell-1", page_type: "upsell", url: route("upsell-1/"), expected_accept_url: route("upsell-2/"), expected_decline_url: route("upsell-2/") },
    { page_id: "upsell-2", page_type: "upsell", url: route("upsell-2/"), expected_accept_url: route("receipt/"), expected_decline_url: route("downsell/") },
    { page_id: "downsell", page_type: "downsell", url: route("downsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];

  assert.deepEqual(testOrderPaths("common", topology), [
    "checkout",
    "accept",
    "decline",
    "accept-accept",
  ]);
});

test("operator plans carry only the primary checkout's terminal graph for runtime safety", () => {
  const { testOrderPlans } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const primary = {
    funnel_id: "primary",
    pages: [
      { page_id: "checkout-a", page_type: "checkout", url: route("a/checkout/"), expected_next_url: route("a/upsell/") },
      { page_id: "upsell-a", page_type: "upsell", url: route("a/upsell/"), expected_accept_url: route("a/receipt/"), expected_decline_url: route("a/receipt/") },
      { page_id: "receipt-a", page_type: "thankyou", url: route("a/receipt/") },
    ],
  };
  const unrelated = {
    funnel_id: "unrelated",
    pages: [
      { page_id: "checkout-b", page_type: "checkout", url: route("b/checkout/"), expected_next_url: route("b/receipt/") },
      { page_id: "receipt-b", page_type: "thankyou", url: route("b/receipt/") },
    ],
  };

  const plans = testOrderPlans("full", [primary, unrelated], {});

  assert.ok(plans.every((plan) => plan.topology_plan?.topology_id === "primary"));
  assert.ok(plans.every((plan) => plan.topology_plan.recognized_terminals.every((terminal) => !terminal.url.includes("/b/"))));
});

test("operator test-order modes plan one order per path carrying the run-global selection/coupon flags", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topo = [{ pages: [
    { page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell/") },
    { page_type: "upsell", url: route("upsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_type: "thankyou", url: route("receipt/") },
  ] }];

  const plans = testOrderPlans("common", topo, { "select-package": "7:2", "apply-coupon": "SAVE10" });
  assert.deepEqual(plans.map((plan) => plan.path), ["checkout", "accept", "decline"]);
  // plan ids for operator modes stay the bare path — assertion ids are unchanged
  assert.deepEqual(plans.map((plan) => planId(plan)), ["checkout", "accept", "decline"]);
  for (const plan of plans) {
    assert.equal(plan.select_package, "7:2");
    assert.equal(plan.apply_coupon, "SAVE10");
    assert.equal(plan.source, undefined);
  }
});

test("test-order 'tiers' plans one strict-selection baseline per declared tier plus one order per declared coupon", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const topo = [{ pages: [
    {
      page_type: "checkout",
      packages: [
        { ref_id: "1", name: "1x Bottle" },
        { package_id: 2, title: "3x Bottle" },
        { id: "2" }, // duplicate ref under an alias key → deduped
        { name: "no ref at all" }, // ref-less entries are skipped
      ],
      exit_intent: { enabled: true, offer_code: "EXIT10" },
      promo_code_input: { enabled: true, offer_code: "exit10" }, // same code, case-insensitive → one plan, both surfaces
    },
    { page_type: "upsell" },
  ] }];

  const plans = testOrderPlans("tiers", topo, {});
  assert.deepEqual(plans.map((plan) => planId(plan)), [
    "checkout@tier:1",
    "checkout@tier:2",
    "checkout@coupon:EXIT10",
  ]);
  assert.deepEqual(plans[0].source, { type: "selector_tier", ref: "1", declared_by: "1x Bottle" });
  assert.equal(plans[0].select_package, "1");
  assert.equal(plans[0].apply_coupon, null);
  assert.equal(plans[2].select_package, null);
  assert.equal(plans[2].apply_coupon, "EXIT10");
  assert.deepEqual(plans[2].source.surfaces, ["exit_intent", "promo_code_input"]);
});

test("tiers:common and tiers:full cross every declared tier with the path shapes; coupons stay single checkout orders", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topo = [{ pages: [
    {
      page_id: "checkout",
      page_type: "checkout",
      url: route("checkout/"),
      expected_next_url: route("upsell/"),
      packages: [{ ref_id: "1" }, { ref_id: "2" }],
      promo_code_input: { enabled: true, offer_code: "SAVE10" },
    },
    { page_id: "upsell", page_type: "upsell", url: route("upsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];

  assert.deepEqual(testOrderPlans("tiers:common", topo, {}).map((plan) => planId(plan)), [
    "checkout@tier:1", "accept@tier:1", "decline@tier:1",
    "checkout@tier:2", "accept@tier:2", "decline@tier:2",
    "checkout@coupon:SAVE10",
  ]);
  assert.deepEqual(testOrderPlans("tiers:full", topo, {}).map((plan) => planId(plan)), [
    "checkout@tier:1", "decline@tier:1", "accept@tier:1",
    "checkout@tier:2", "decline@tier:2", "accept@tier:2",
    "checkout@coupon:SAVE10",
  ]);
});

test("tiers mode gates: disabled/blank offer surfaces are skipped, operator flags are rejected, empty specs error", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const checkout = (extra) => [{ pages: [{ page_type: "checkout", ...extra }] }];

  // enabled !== true, or a missing offer_code, declares no coupon surface
  const plans = testOrderPlans("tiers", checkout({
    packages: [{ ref_id: "9" }],
    exit_intent: { offer_code: "NOPE" },
    promo_code_input: { enabled: false, offer_code: "ALSONOPE" },
  }), {});
  assert.deepEqual(plans.map((plan) => planId(plan)), ["checkout@tier:9"]);

  // tiers derives selection/coupons from the spec — explicit flags are ambiguous
  assert.throws(
    () => testOrderPlans("tiers", checkout({ packages: [{ ref_id: "9" }] }), { "select-package": "9" }),
    /drop --select-package/,
  );
  assert.throws(
    () => testOrderPlans("tiers", checkout({ packages: [{ ref_id: "9" }] }), { "apply-coupon": "X" }),
    /drop --apply-coupon/,
  );

  // nothing declared → explicit error instead of a silent zero-order "pass"
  assert.throws(() => testOrderPlans("tiers", checkout({}), {}), /nothing to iterate/);

  // no checkout page at all is a different failure than a bare checkout page
  assert.throws(
    () => testOrderPlans("tiers", [{ pages: [{ page_type: "landing" }] }], {}),
    /no checkout page to derive/,
  );
});

test("multi-funnel specs plan every funnel's checkout declarations, each against its own checkout page", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const checkoutA = { page_type: "checkout", page_id: "checkout-a", url: "https://x.test/a/checkout/", packages: [{ ref_id: "1" }] };
  const checkoutB = {
    page_type: "checkout",
    page_id: "checkout-b",
    url: "https://x.test/b/checkout/",
    packages: [{ ref_id: "1" }, { ref_id: "8" }],
    promo_code_input: { enabled: true, offer_code: "OTHER10" },
  };
  const topo = [
    { pages: [checkoutA] },
    { pages: [checkoutB, { page_type: "upsell" }] },
  ];

  const warnings = [];
  const plans = testOrderPlans("tiers", topo, {}, { warn: (line) => warnings.push(line) });
  // primary-checkout plans keep bare ids; funnel B's plans are qualified by
  // page id, so ref "1" declared on BOTH checkouts cannot collide
  assert.deepEqual(plans.map((plan) => planId(plan)), [
    "checkout@tier:1",
    "checkout@tier:1#checkout-b",
    "checkout@tier:8#checkout-b",
    "checkout@coupon:OTHER10#checkout-b",
  ]);
  // each plan names the checkout page that declares it — the runner drives that page
  assert.equal(plans[0].checkout_page, checkoutA);
  assert.equal(plans[1].checkout_page, checkoutB);
  assert.equal(plans[3].source.checkout_page_id, "checkout-b");
  assert.equal(warnings.length, 0);
});

test("tiers:common crosses each funnel's tiers with that funnel's own reachable graph", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const topo = [
    // funnel A: no upsells → checkout baseline only
    { funnel_id: "a", pages: [{ page_type: "checkout", page_id: "checkout-a", url: "https://x.test/a/", packages: [{ ref_id: "1" }] }] },
    // funnel B: one upsell → checkout + accept + decline
    { funnel_id: "b", pages: [
      {
        page_type: "checkout",
        page_id: "checkout-b",
        url: "https://x.test/b/",
        expected_next_url: "https://x.test/b/upsell/",
        packages: [{ ref_id: "8" }],
      },
      {
        page_type: "upsell",
        page_id: "upsell-b",
        url: "https://x.test/b/upsell/",
        expected_accept_url: "https://x.test/b/receipt/",
        expected_decline_url: "https://x.test/b/receipt/",
      },
      { page_type: "thankyou", page_id: "receipt-b", url: "https://x.test/b/receipt/" },
    ] },
  ];

  assert.deepEqual(testOrderPlans("tiers:common", topo, {}).map((plan) => planId(plan)), [
    "checkout@tier:1",
    "checkout@tier:8#checkout-b",
    "accept@tier:8#checkout-b",
    "decline@tier:8#checkout-b",
  ]);
});

test("tiers:full walks each tier's own funnel graph without over-running shortcut branches", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const checkout = { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell/"), packages: [{ ref_id: "1" }] };
  const topology = [{ funnel_id: "shortcut-tier", pages: [
    checkout,
    { page_id: "upsell", page_type: "upsell", url: route("upsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("downsell/") },
    { page_id: "downsell", page_type: "downsell", url: route("downsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];

  assert.deepEqual(testOrderPlans("tiers:full", topology, {}).map((plan) => planId(plan)), [
    "checkout@tier:1",
    "decline-decline@tier:1",
    "decline-accept@tier:1",
    "accept@tier:1",
  ]);
});

test("a non-primary checkout with declarations but no URL cannot be driven — warned, never silently dropped", () => {
  const { testOrderPlans, planId } = __qaBrowserTestHooks;
  const topo = [
    { pages: [{ page_type: "checkout", page_id: "checkout-a", url: "https://x.test/a/", packages: [{ ref_id: "1" }] }] },
    { pages: [{ page_type: "checkout", page_id: "checkout-b", packages: [{ ref_id: "8" }], promo_code_input: { enabled: true, offer_code: "OTHER10" } }] },
  ];

  const warnings = [];
  const plans = testOrderPlans("tiers", topo, {}, { warn: (line) => warnings.push(line) });
  assert.deepEqual(plans.map((plan) => planId(plan)), ["checkout@tier:1"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /checkout-b/);
  assert.match(warnings[0], /tier\(s\) 8/);
  assert.match(warnings[0], /coupon\(s\) OTHER10/);
  assert.match(warnings[0], /no resolvable URL/);
});

test("the flood guard counts expanded tier plans and previews plan ids", () => {
  const { testOrderPlans, enforceTestOrderLimit } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topo = [{ pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell-1/"), packages: [{ ref_id: "1" }, { ref_id: "2" }, { ref_id: "3" }] },
    { page_id: "upsell-1", page_type: "upsell", url: route("upsell-1/"), expected_accept_url: route("upsell-2/"), expected_decline_url: route("upsell-2/") },
    { page_id: "upsell-2", page_type: "upsell", url: route("upsell-2/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];

  const plans = testOrderPlans("tiers:full", topo, {});
  assert.equal(plans.length, 15); // 3 tiers × (checkout + 4 permutations)
  assert.throws(
    () => enforceTestOrderLimit(plans, { "test-order": "tiers:full", "max-test-orders": "6" }),
    /expands to 15 typed-card order\(s\).*checkout@tier:1/s,
  );
  // raising the cap clears the guard — it is a flood guard, not a permission gate
  enforceTestOrderLimit(plans, { "test-order": "tiers:full", "max-test-orders": "15" });
});

test("a depth-three full matrix keeps the default cap and names the exact explicit raise", () => {
  const { testOrderPlans, enforceTestOrderLimit } = __qaBrowserTestHooks;
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topology = [{ funnel_id: "depth-three", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell-1/") },
    { page_id: "upsell-1", page_type: "upsell", url: route("upsell-1/"), expected_accept_url: route("upsell-2/"), expected_decline_url: route("upsell-2/") },
    { page_id: "upsell-2", page_type: "upsell", url: route("upsell-2/"), expected_accept_url: route("upsell-3/"), expected_decline_url: route("upsell-3/") },
    { page_id: "upsell-3", page_type: "upsell", url: route("upsell-3/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];
  const plans = testOrderPlans("full", topology, {});

  assert.equal(plans.length, 9);
  assert.throws(
    () => enforceTestOrderLimit(plans, { "test-order": "full" }),
    /--max-test-orders 9/,
  );
  enforceTestOrderLimit(plans, { "test-order": "full", "max-test-orders": "9" });
});

test("argsForPlan overrides the run-global selection/coupon flags with the plan's per-order values", () => {
  const { argsForPlan } = __qaBrowserTestHooks;
  const args = { "base-url": "https://x.test/", "select-package": "global", "apply-coupon": "GLOBAL" };
  assert.deepEqual(
    argsForPlan(args, { path: "checkout", select_package: "2", apply_coupon: null }),
    { "base-url": "https://x.test/", "select-package": "2" },
  );
  assert.deepEqual(
    argsForPlan(args, { path: "checkout", select_package: null, apply_coupon: "EXIT10" }),
    { "base-url": "https://x.test/", "apply-coupon": "EXIT10" },
  );
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

test("rejected order-create detection matches only the create endpoint with a 4xx/5xx status", () => {
  const { rejectedOrderCreateResponse } = __qaBrowserTestHooks;
  const events = { responses: [
    { status: 201, url: "https://api.example.test/api/v1/carts/", body: {} },
    { status: 400, url: "https://api.example.test/api/v1/orders/", body: { detail: "Unknown voucher" } },
    { status: 404, url: "https://api.example.test/api/v1/orders/123/upsells/", body: {} },
  ] };
  const rejected = rejectedOrderCreateResponse(events);
  assert.equal(rejected.status, 400);
  assert.match(rejected.url, /\/api\/v1\/orders\/$/);

  // A 2xx create, cart 4xx, or upsell 4xx must not register as a rejected create.
  assert.equal(rejectedOrderCreateResponse({ responses: [
    { status: 201, url: "https://api.example.test/api/v1/orders/", body: {} },
    { status: 422, url: "https://api.example.test/api/v1/carts/calculate/", body: {} },
  ] }), null);
});

test("voucher extraction skips identity-less entries so bare amount rows cannot suppress the discount_total fallback", () => {
  const { extractOrderVouchers, assessCouponApplication } = __qaBrowserTestHooks;

  // An amount-bearing entry with no code/name is not an identifiable voucher.
  assert.deepEqual(extractOrderVouchers({ vouchers: [{ amount: "5.00" }] }), []);

  // ...so the discount_total weak-evidence basis still fires for that shape.
  const weak = assessCouponApplication("SAVE10", {
    vouchers: extractOrderVouchers({ vouchers: [{ amount: "5.00" }] }),
    totalDiscount: 5,
  });
  assert.equal(weak.ok, true);
  assert.equal(weak.basis, "discount_total");
  assert.equal(weak.weak_evidence, true);
});

test("line-price delta handles per-unit price semantics and unmatched bonus lines", () => {
  const { assessCouponApplication, linePriceDeltaEvidence } = __qaBrowserTestHooks;
  const events = { responses: [
    { status: 200, url: "https://campaigns.example.test/api/v1/campaigns/", body: { packages: [
      { ref_id: 3, qty: 3, price: "27.00", price_total: "81.00", product_sku: "SKU_A" },
    ] } },
  ] };

  // Per-unit FULL price (27.00 × 3 == 81.00 list) must read as undiscounted,
  // not as a fake (qty-1)× discount — a bogus coupon must fail here.
  const perUnitFull = assessCouponApplication("BOGUS", {
    vouchers: [], totalDiscount: 0, events,
    lines: [{ title: "A", quantity: 3, sku: "SKU_A", price_incl_tax: "27.00" }],
  });
  assert.equal(perUnitFull.ok, false);
  assert.equal(perUnitFull.basis, "line_price_delta");
  assert.equal(perUnitFull.evidence.charged_total, 81);

  // Per-unit DISCOUNTED price (25.65 × 3 = 76.95) reads as the correct delta.
  const perUnitDiscounted = assessCouponApplication("SAVE5", {
    vouchers: [], totalDiscount: 0, events,
    lines: [{ title: "A", quantity: 3, sku: "SKU_A", price_incl_tax: "25.65" }],
  });
  assert.equal(perUnitDiscounted.ok, true);
  assert.equal(perUnitDiscounted.weak_evidence, true);
  assert.equal(perUnitDiscounted.evidence.charged_total, 76.95);
  assert.equal(perUnitDiscounted.evidence.delta, 4.05);

  // A bonus/gift line with no campaign-package equivalent must not defeat the
  // delta for the line that does resolve.
  const withBonusLine = linePriceDeltaEvidence([
    { title: "A", quantity: 3, sku: "SKU_A", price_incl_tax: "76.95" },
    { title: "Free Gift", quantity: 1, sku: "GIFT_SKU", price_incl_tax: "0.00" },
  ], events);
  assert.equal(withBonusLine.list_total, 81);
  assert.equal(withBonusLine.charged_total, 76.95);
  assert.equal(withBonusLine.unmatched_line_count, 1);
  assert.equal(withBonusLine.lines.length, 1);
});

test("rejected order-create: the most recent create response decides, and query strings still match", () => {
  const { rejectedOrderCreateResponse } = __qaBrowserTestHooks;

  // Transient 400 followed by a successful 201 retry → not rejected.
  assert.equal(rejectedOrderCreateResponse({ responses: [
    { status: 400, url: "https://api.example.test/api/v1/orders/", body: {} },
    { status: 201, url: "https://api.example.test/api/v1/orders/", body: {} },
  ] }), null);

  // A create URL carrying a query string is still the create endpoint.
  const withQuery = rejectedOrderCreateResponse({ responses: [
    { status: 400, url: "https://api.example.test/api/v1/orders/?expand=line_items", body: {} },
  ] });
  assert.equal(withQuery.status, 400);
});

test("network-level order-create failures are detected, but never alongside a successful create", () => {
  const { failedOrderCreateRequest } = __qaBrowserTestHooks;
  const failedCreate = { url: "https://api.example.test/api/v1/orders/", failure: "net::ERR_CONNECTION_RESET" };

  const detected = failedOrderCreateRequest({ responses: [], failed: [
    { url: "https://api.example.test/api/v1/carts/", failure: "net::ERR_ABORTED" },
    failedCreate,
  ] });
  assert.equal(detected.failure, "net::ERR_CONNECTION_RESET");

  // An aborted duplicate next to a 2xx create is not a failed order.
  assert.equal(failedOrderCreateRequest({
    responses: [{ status: 201, url: "https://api.example.test/api/v1/orders/", body: {} }],
    failed: [failedCreate],
  }), null);
});
