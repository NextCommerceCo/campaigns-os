import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/qa-order-reconciliation/stray-non-upsell-line.json", import.meta.url),
  "utf8",
));

const page = { page_id: "checkout", url: "https://campaign.example.test/device/checkout/" };

function orderFrom({ display, lines, total }) {
  const { reconcileOrderAgainstDisplay, assessOrderTotalParity } = __qaBrowserTestHooks;
  return {
    verification: {
      display_reconciliation: reconcileOrderAgainstDisplay({ lines, display, events: fixture.events }),
      total_parity: assessOrderTotalParity({ display, preUpsellTotal: total }),
    },
  };
}

test("a non-upsell line the checkout never displayed is a blocker naming the package id", () => {
  const { orderDisplayParityAssertion } = __qaBrowserTestHooks;
  const order = orderFrom({
    display: fixture.checkout_display,
    lines: fixture.order_lines,
    total: fixture.order_pre_upsell_total,
  });

  const result = orderDisplayParityAssertion(page, "checkout", order);
  assert.equal(result.id, "browser-order-display-parity:checkout");
  assert.equal(result.family, "browser-test-order");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  // The extra package must be named — "something does not reconcile" is not
  // actionable, and the id is what the operator removes from the cart wiring.
  assert.match(result.actual, /charged but never displayed: 7 \(Retinol Serum\)/);
  assert.deepEqual(result.evidence.summary_package_ids, ["2"]);
  assert.equal(result.evidence.non_upsell_line_count, 2);
  assert.deepEqual(result.evidence.missing, []);
  // The discount rows ride along: the stray package announced itself there
  // while being invisible everywhere else on the page.
  assert.equal(result.evidence.discount_rows.length, 2);
});

test("the same order without the stray line reconciles clean", () => {
  const { orderDisplayParityAssertion } = __qaBrowserTestHooks;
  const clean = fixture.clean_variant;
  const order = orderFrom({
    display: clean.checkout_display,
    lines: fixture.order_lines.filter((line) => line.sku === "DEV-BUNDLE"),
    total: clean.order_pre_upsell_total,
  });

  const result = orderDisplayParityAssertion(page, "checkout", order);
  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
  assert.equal(result.evidence.extra.length, 0);
});

test("a selected unit package bought twice reconciles only to a persisted quantity of two", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const events = { responses: [{ body: { packages: [
    { ref_id: 1, qty: 1, product_sku: "DEMO-BAG", product_id: 382, product_variant_id: 383 },
    { ref_id: 2, qty: 2, product_sku: "DEMO-BAG", product_id: 382, product_variant_id: 383 },
  ] } }] };
  const display = {
    summary_present: true,
    summary_rows: [{ package_id: "1", text: "2x Demo Bag" }],
    selected_bundle_package_ids: ["1"],
  };
  const selected_packages = [{ packageId: "1", quantity: 2 }];

  const correct = reconcileOrderAgainstDisplay({
    lines: [{ title: "Demo Bag", quantity: 2, sku: "DEMO-BAG", product_id: 382, variant_id: 383 }],
    display,
    events,
    selected_packages,
  });
  assert.equal(correct.ok, true);
  assert.deepEqual(correct.matched_quantities, [{ package_ref_id: "1", unit_quantity: 1, purchase_multiplier: 2, persisted_quantity: 2 }]);

  const wrong = reconcileOrderAgainstDisplay({
    lines: [{ title: "Demo Bag", quantity: 1, sku: "DEMO-BAG", product_id: 382, variant_id: 383 }],
    display,
    events,
    selected_packages,
  });
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.missing, ["1"]);
  assert.match(wrong.quantity_mismatches[0].reason, /requested 2.*persisted 1/);
});

test("a selected two-unit bundle card reconciles by the packages its items declare, not by its bundle id", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const events = { responses: [{ body: { packages: [
    { ref_id: 1, qty: 1, product_sku: "DEMO-PURIFIER", product_id: 101 },
    { ref_id: 2, qty: 1, product_sku: "DEMO-FILTER", product_id: 102 },
  ] } }] };
  // What the collector reads off a starter bundle selector with bundle-2x
  // ([{"packageId":1,"quantity":2}]) selected and the filter bump active. No
  // --select-package names the quantity; only the card declares it.
  const display = {
    summary_present: true,
    summary_rows: [{ package_id: "1", text: "2x Demo Purifier" }, { package_id: "2", text: "1x Demo Filter" }],
    selected_bundle_package_ids: ["1"],
    selected_bundle_items: [{ bundle_id: "bundle-2x", items: [{ package_id: "1", quantity: 2 }] }],
    active_toggle_package_ids: ["2"],
  };
  const lines = [
    { title: "Demo Purifier", quantity: 2, sku: "DEMO-PURIFIER", product_id: 101 },
    { title: "Demo Filter", quantity: 1, sku: "DEMO-FILTER", product_id: 102, is_upsell: true },
  ];

  const reconciliation = reconcileOrderAgainstDisplay({ lines, display, events, requested_cart: [{ packageId: "2", quantity: 1, quantityExplicit: true }] });
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation));
  assert.deepEqual(reconciliation.displayed_package_ids, ["1", "2"]);
  assert.deepEqual(reconciliation.missing, []);
  assert.equal(reconciliation.unresolved_lines, undefined);
  assert.deepEqual(reconciliation.matched_quantities, [{ package_ref_id: "1", unit_quantity: 1, purchase_multiplier: 2, persisted_quantity: 2 }]);
});

test("every item a selected multi-item card declares must be in the order, even one the summary does not show", () => {
  const { reconcileOrderAgainstDisplay, orderDisplayParityAssertion } = __qaBrowserTestHooks;
  const events = { responses: [{ body: { packages: [
    { ref_id: 1, qty: 1, product_sku: "DEMO-PURIFIER", product_id: 101 },
    { ref_id: 4, qty: 1, product_sku: "DEMO-STAND", product_id: 104 },
  ] } }] };
  // A kit card declaring two purifiers and the stand, chosen by
  // --select-package 4:1, while the summary renders only the purifiers.
  const display = {
    summary_present: true,
    summary_rows: [{ package_id: "1", text: "2x Demo Purifier" }],
    selected_bundle_package_ids: ["1", "4"],
    selected_bundle_items: [{ bundle_id: "bundle-kit", items: [{ package_id: "1", quantity: 2 }, { package_id: "4", quantity: 1 }] }],
    active_toggle_package_ids: [],
  };
  const purifiers = { title: "Demo Purifier", quantity: 2, sku: "DEMO-PURIFIER", product_id: 101 };
  const stand = { title: "Demo Stand", quantity: 1, sku: "DEMO-STAND", product_id: 104 };
  const parity = (lines) => orderDisplayParityAssertion(page, "checkout", { verification: {
    display_reconciliation: reconcileOrderAgainstDisplay({ lines, display, events, selected_packages: [{ packageId: "4", quantity: 1, quantityExplicit: true }] }),
  } });

  const short = parity([purifiers]);
  assert.equal(short.status, "fail");
  assert.deepEqual(short.evidence.missing, ["4"]);
  assert.match(short.actual, /displayed but never charged: 4/);

  const full = parity([purifiers, stand]);
  assert.equal(full.status, "pass", full.actual);
  assert.deepEqual(full.evidence.missing, []);
});

test("a selected card with malformed data-next-bundle-items still has an explicit --cart quantity compared with the order", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const events = { responses: [{ body: { packages: [
    { ref_id: 1, qty: 1, product_sku: "DEMO-PURIFIER", product_id: 101 },
  ] } }] };
  // The card's items attribute does not parse, so the card stands as its
  // bundle id, as on base; nothing it declares can judge the quantity.
  const display = {
    summary_present: true,
    summary_rows: [{ package_id: "1", text: "1x Demo Purifier" }],
    selected_bundle_package_ids: ["bundle-2x"],
    selected_bundle_items: [{ bundle_id: "bundle-2x", items: null }],
    active_toggle_package_ids: [],
  };
  const lines = [{ title: "Demo Purifier", quantity: 1, sku: "DEMO-PURIFIER", product_id: 101 }];

  const reconciliation = reconcileOrderAgainstDisplay({ lines, display, events, requested_cart: [{ packageId: "1", quantity: 2, quantityExplicit: true }] });
  assert.equal(reconciliation.ok, false, JSON.stringify(reconciliation));
  assert.deepEqual(reconciliation.missing, []);
  assert.deepEqual(reconciliation.quantity_mismatches.map((entry) => entry.reason), ["package 1 requested 2 unit(s) (1 per package × 2) but persisted 1"]);
});

test("a malformed selected card does not change how --cart refs are judged beside a well-formed selected card", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const events = { responses: [{ body: { packages: [
    { ref_id: 1, qty: 1, product_sku: "DEMO-PURIFIER", product_id: 101 },
    { ref_id: 4, qty: 1, product_sku: "DEMO-STAND", product_id: 104 },
  ] } }] };
  // bundle-2x declares [{"packageId":1,"quantity":2}]; the stand comes from a
  // plain card no selected bundle card declares.
  const wellFormed = { bundle_id: "bundle-2x", items: [{ package_id: "1", quantity: 2 }] };
  const malformed = { bundle_id: "bundle-gift", items: null };
  const display = (cards) => ({
    summary_present: true,
    summary_rows: [{ package_id: "1", text: "2x Demo Purifier" }, { package_id: "4", text: "1x Demo Stand" }],
    selected_bundle_package_ids: ["1"],
    selected_bundle_items: cards,
    active_toggle_package_ids: [],
  });
  const lines = [
    { title: "Demo Purifier", quantity: 2, sku: "DEMO-PURIFIER", product_id: 101 },
    { title: "Demo Stand", quantity: 1, sku: "DEMO-STAND", product_id: 104 },
  ];
  const judge = (cards, cart) => reconcileOrderAgainstDisplay({ lines, display: display(cards), events, requested_cart: cart });
  const asked = (refs) => refs.map(([packageId, quantity]) => ({ packageId, quantity, quantityExplicit: true }));

  for (const cart of [asked([["1", 2], ["4", 1]]), asked([["1", 2], ["4", 2]]), asked([["1", 3]])]) {
    const alone = judge([wellFormed], cart);
    const beside = judge([wellFormed, malformed], cart);
    assert.equal(beside.ok, alone.ok, JSON.stringify(cart));
    assert.deepEqual(beside.quantity_mismatches, alone.quantity_mismatches, JSON.stringify(cart));
  }
  assert.equal(judge([wellFormed], asked([["1", 2], ["4", 1]])).ok, true);
  assert.deepEqual(
    judge([wellFormed], asked([["1", 2], ["4", 2]])).quantity_mismatches.map((entry) => entry.reason),
    ["package 4 requested 2 unit(s) (1 per package × 2) but persisted 1"],
  );
});

test("a displayed package that was never charged is a blocker too", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const display = {
    ...fixture.checkout_display,
    summary_rows: [
      ...fixture.checkout_display.summary_rows,
      { package_id: "7", text: "1x Retinol Serum $59.00 $29.00" },
    ],
  };
  const reconciliation = reconcileOrderAgainstDisplay({
    lines: fixture.order_lines.filter((line) => line.sku === "DEV-BUNDLE"),
    display,
    events: fixture.events,
  });

  assert.equal(reconciliation.comparable, true);
  assert.equal(reconciliation.ok, false);
  assert.deepEqual(reconciliation.missing, ["7"]);
  assert.deepEqual(reconciliation.extra, []);
});

test("duplicate-SKU packages remain ambiguous unless rendered or requested identity resolves them", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const events = { responses: [
    { body: { packages: [{ ref_id: 1, qty: 1, product_sku: "SAME-SKU" }] } },
    { body: { packages: [
      { ref_id: 1, qty: 1, product_sku: "SAME-SKU" },
      { ref_id: 2, qty: 1, product_sku: "SAME-SKU" },
    ] } },
  ] };
  const reconciliation = reconcileOrderAgainstDisplay({
    lines: [{ title: "Ambiguous", quantity: 1, sku: "SAME-SKU" }],
    display: {
      summary_present: true,
      summary_rows: [{ package_id: "1" }, { package_id: "2" }],
    },
    events,
  });

  assert.equal(reconciliation.ok, false);
  assert.deepEqual(reconciliation.missing, ["1", "2"]);
  assert.deepEqual(reconciliation.unresolved_lines, [{ title: "Ambiguous", quantity: 1 }]);

  const renderedIdentity = reconcileOrderAgainstDisplay({
    lines: [{ title: "Resolved", quantity: 1, sku: "SAME-SKU" }],
    display: {
      summary_present: true,
      summary_rows: [{ package_id: "2" }],
    },
    events,
  });
  assert.equal(renderedIdentity.ok, true);
  assert.deepEqual(renderedIdentity.matched_quantities, [
    { package_ref_id: "2", unit_quantity: 1, purchase_multiplier: 1, persisted_quantity: 1 },
  ]);
});

test("upsell lines are out of scope — an accepted upsell is not a stray charge", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const lines = [
    ...fixture.order_lines.filter((line) => line.sku === "DEV-BUNDLE"),
    { ...fixture.order_lines[1], is_upsell: true },
  ];
  const reconciliation = reconcileOrderAgainstDisplay({
    lines,
    display: fixture.clean_variant.checkout_display,
    events: fixture.events,
  });

  assert.equal(reconciliation.ok, true);
  assert.equal(reconciliation.non_upsell_line_count, 1);
});

test("a checkout order bump the summary displays is charged, though the order tags it is_upsell", () => {
  const { orderDisplayParityAssertion } = __qaBrowserTestHooks;
  // The add-on is selected on the checkout, rendered in the summary, and
  // persisted with is_upsell: true, the platform's reporting tag for a bump.
  const display = {
    ...fixture.clean_variant.checkout_display,
    summary_rows: [
      ...fixture.clean_variant.checkout_display.summary_rows,
      { package_id: "7", text: "1x Retinol Serum $29.00" },
    ],
  };
  const order = {
    verification: {
      display_reconciliation: __qaBrowserTestHooks.reconcileOrderAgainstDisplay({
        lines: [
          ...fixture.order_lines.filter((line) => line.sku === "DEV-BUNDLE"),
          { ...fixture.order_lines[1], is_upsell: true },
        ],
        display,
        events: fixture.events,
      }),
    },
  };

  const result = orderDisplayParityAssertion(page, "checkout", order);
  assert.equal(result.status, "pass", result.actual);
  assert.deepEqual(result.evidence.missing, []);
  assert.deepEqual(result.evidence.extra, []);
  assert.equal(result.evidence.order_bump_line_count, 1);
});

test("a summary whose rows carry no package id is reported not-comparable, never guessed at", () => {
  const { orderDisplayParityAssertion } = __qaBrowserTestHooks;
  const order = orderFrom({
    display: fixture.unidentified_summary_variant.checkout_display,
    lines: fixture.order_lines,
    total: fixture.order_pre_upsell_total,
  });

  const result = orderDisplayParityAssertion(page, "checkout", order);
  // Named absence, not silence: partial id coverage would make legitimately
  // displayed packages look like stray charges.
  assert.equal(result.status, "skipped");
  assert.equal(result.severity, undefined);
  assert.match(result.actual, /exposes a package id on only some of its 1 row/);
});

test("no order summary at all, and an unreadable collector, both report why", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const none = reconcileOrderAgainstDisplay({
    lines: fixture.order_lines,
    display: { summary_present: false, summary_rows: [] },
    events: fixture.events,
  });
  assert.equal(none.comparable, false);
  assert.match(none.reason, /renders no \[data-next-cart-summary\]/);

  const broken = reconcileOrderAgainstDisplay({
    lines: fixture.order_lines,
    display: { collector_error: "Execution context was destroyed" },
    events: fixture.events,
  });
  assert.equal(broken.comparable, false);
  assert.match(broken.reason, /Execution context was destroyed/);

  const uncaptured = reconcileOrderAgainstDisplay({ lines: fixture.order_lines, display: null });
  assert.equal(uncaptured.comparable, false);
});

test("a line with no campaign-package equivalent is reported, never counted as a stray charge", () => {
  const { reconcileOrderAgainstDisplay } = __qaBrowserTestHooks;
  const lines = [
    ...fixture.order_lines.filter((line) => line.sku === "DEV-BUNDLE"),
    { title: "Free gift", quantity: 1, is_upsell: false, sku: "GIFT-0", product_id: 999, variant_id: 999 },
  ];
  const reconciliation = reconcileOrderAgainstDisplay({
    lines,
    display: fixture.clean_variant.checkout_display,
    events: fixture.events,
  });

  assert.equal(reconciliation.ok, true);
  assert.deepEqual(reconciliation.unresolved_lines, [{ title: "Free gift", quantity: 1 }]);
});

test("total parity compares the displayed summary total against the order's pre-upsell total", () => {
  const { orderTotalParityAssertion } = __qaBrowserTestHooks;

  const mismatch = orderTotalParityAssertion(page, "checkout", orderFrom({
    display: fixture.checkout_display,
    lines: fixture.order_lines,
    total: fixture.order_pre_upsell_total,
  }));
  assert.equal(mismatch.id, "browser-order-total-parity:checkout");
  assert.equal(mismatch.status, "fail");
  assert.equal(mismatch.severity, "blocker");
  assert.equal(mismatch.evidence.displayed_total, 139);
  assert.equal(mismatch.evidence.order_pre_upsell_total, 168);
  assert.equal(mismatch.evidence.delta, 29);

  const clean = orderTotalParityAssertion(page, "checkout", orderFrom({
    display: fixture.clean_variant.checkout_display,
    lines: fixture.order_lines.filter((line) => line.sku === "DEV-BUNDLE"),
    total: fixture.clean_variant.order_pre_upsell_total,
  }));
  assert.equal(clean.status, "pass");
});

test("total parity skips with a reason when the checkout exposes no readable total", () => {
  const { orderTotalParityAssertion, assessOrderTotalParity } = __qaBrowserTestHooks;
  const noSurface = orderTotalParityAssertion(page, "checkout", {
    verification: { total_parity: assessOrderTotalParity({ display: { total_text: null }, preUpsellTotal: 168 }) },
  });
  assert.equal(noSurface.status, "skipped");
  assert.match(noSurface.actual, /renders no \[data-next-display="cart\.total"\]/);

  const unreadable = assessOrderTotalParity({ display: { total_text: "Free" }, preUpsellTotal: 168 });
  assert.equal(unreadable.comparable, false);
  assert.match(unreadable.reason, /no readable amount/);

  const noOrderTotal = assessOrderTotalParity({ display: { total_text: "$139.00" }, preUpsellTotal: null });
  assert.equal(noOrderTotal.comparable, false);
});

test("total capture supports the maintained Demeter grand-total surface", () => {
  const { checkoutTotalSelectors } = __qaBrowserTestHooks;
  assert.deepEqual(checkoutTotalSelectors(), [
    '[data-next-display="cart.total"]',
    '[data-next-cart-summary] .order-totals__value--total',
  ]);
});

test("displayed money parsing reads the amount, not the currency code beside it", () => {
  const { parseDisplayedMoney } = __qaBrowserTestHooks;
  assert.equal(parseDisplayedMoney("$139.00"), 139);
  assert.equal(parseDisplayedMoney("USD $1,139.00"), 1139);
  assert.equal(parseDisplayedMoney("139"), 139);
  assert.equal(parseDisplayedMoney(""), null);
  assert.equal(parseDisplayedMoney("Free"), null);
});

test("selected bundle cards widen only the charged-but-not-displayed direction", () => {
  const { displayedPackageIds } = __qaBrowserTestHooks;
  const resolved = displayedPackageIds({
    summary_present: true,
    summary_rows: [{ package_id: "2" }],
    selected_bundle_package_ids: ["2", "3"],
    active_toggle_package_ids: ["4"],
  });

  assert.equal(resolved.comparable, true);
  assert.deepEqual(resolved.summary_package_ids, ["2"]);
  assert.deepEqual(resolved.displayed_package_ids, ["2", "3", "4"]);
});
