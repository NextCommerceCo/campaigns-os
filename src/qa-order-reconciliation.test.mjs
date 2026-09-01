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
