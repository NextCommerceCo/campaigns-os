import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks, runBrowserTestOrders } from "./qa-browser.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";
import { commonTestOrderPaths, resolveTestOrderTopology } from "./qa-test-order-topology.mjs";

// The default `common` depth (#530): every actual terminal path when they fit
// under the flood cap, otherwise the sample plus one shortest decline path per
// offer page no planned path declines yet. All planning here runs without a
// browser. Which paths run is read through testOrderPaths / testOrderPlans, the
// entry points the dispatcher uses; commonOrderPathPlan only for the plan's
// metadata (effective depth, reason, pages left out).

const { testOrderPaths, testOrderPlans, enforceTestOrderLimit, dispatchTestOrderPlans } = __qaBrowserTestHooks;
const { maybeRunTestOrders } = __qaNodeTestHooks;

function commonOrderPathPlan(topologies, args) {
  assert.equal(typeof __qaBrowserTestHooks.commonOrderPathPlan, "function", "the common plan records its effective depth and the pages it leaves out");
  return __qaBrowserTestHooks.commonOrderPathPlan(topologies, args);
}

const SITE = "https://shop.example.com/";
const route = (name) => new URL(name, SITE).toString();

function offer(pageId, pageType, accept, decline) {
  return { page_id: pageId, page_type: pageType, url: route(`${pageId}/`), expected_accept_url: route(accept), expected_decline_url: route(decline) };
}

function funnel(id, firstPage, offers) {
  return [{
    funnel_id: id,
    pages: [
      { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route(firstPage) },
      ...offers,
      { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
    ],
  }];
}

// checkout -> offer; the downsell is reachable only through the offer's decline.
const downsellOnDecline = () => funnel("downsell-on-decline", "offer/", [
  offer("offer", "upsell", "receipt/", "downsell/"),
  offer("downsell", "downsell", "receipt/", "receipt/"),
]);

// Five terminal paths plus the checkout baseline: exactly the default cap of 6.
const atCap = () => funnel("at-cap", "upsell-1/", [
  offer("upsell-1", "upsell", "upsell-2/", "downsell-1/"),
  offer("downsell-1", "downsell", "receipt/", "receipt/"),
  offer("upsell-2", "upsell", "receipt/", "downsell-2/"),
  offer("downsell-2", "downsell", "receipt/", "receipt/"),
]);

// Two offers and two downsells sharing one receipt: 10 full paths.
const twoDownsells = () => funnel("two-downsells", "upsell-1/", [
  offer("upsell-1", "upsell", "upsell-2/", "downsell-1/"),
  offer("downsell-1", "downsell", "upsell-2/", "upsell-2/"),
  offer("upsell-2", "upsell", "receipt/", "downsell-2/"),
  offer("downsell-2", "downsell", "receipt/", "receipt/"),
]);

// The offer page each step of a path clicks, walked over the fixture's own
// routes (independent of the planner under test).
function walk(topologies, path) {
  const pages = topologies[0].pages;
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const steps = path === "checkout" ? [] : path.split("-");
  let current = byUrl.get(pages[0].expected_next_url);
  const clicks = [];
  for (const step of steps) {
    if (!current || !["upsell", "downsell"].includes(current.page_type)) break;
    clicks.push({ page: current, action: step });
    current = byUrl.get(step === "accept" ? current.expected_accept_url : current.expected_decline_url);
  }
  return clicks;
}

// Stand-in for the browser runner: records a click per step, the shape
// runSingleBrowserTestOrder keeps in upsell_steps.
function fakeRun(topologies, { skipDeclineOn = null } = {}) {
  return async (_context, _page, plan) => {
    const upsellSteps = walk(topologies, plan.path)
      .filter(({ page, action }) => !(action === "decline" && page.page_id === skipDeclineOn))
      .map(({ page, action }) => ({ path: action, clicked: true, offer_url: `${page.url}?ref=qa` }));
    return {
      ok: true,
      order: {
        ref_id: `ref-${plan.path}`,
        path: plan.path,
        final_url: route("receipt/"),
        is_test: true,
        card: { last4: "1111" },
        receipt_line_items: [{ title: "Item" }],
        verification: {},
        evidence: { steps: [] },
        upsell_steps: upsellSteps,
      },
    };
  };
}

async function dispatch(topologies, plans, { orderPathPlan = null, ...options } = {}) {
  return dispatchTestOrderPlans({
    context: null,
    plans,
    checkoutPage: topologies[0].pages[0],
    args: {},
    options: { runSingleTestOrder: fakeRun(topologies, options), orderPathPlan, topologies },
  });
}

const coverageRow = (assertions) => assertions.find((entry) => entry.id === "browser-test-order:upsell-action-coverage");

test("common declines through a downsell when the full plan fits the cap; the old sample never did", () => {
  const topologies = downsellOnDecline();
  const paths = testOrderPaths("common", topologies);
  assert.ok(paths.includes("decline-decline"), `common must decline through the downsell: ${paths.join(", ")}`);
  assert.deepEqual(paths, ["checkout", "accept", "decline-decline", "decline-accept"]);
  const plan = commonOrderPathPlan(topologies, {});
  assert.equal(plan.effective_depth, "full");
  assert.equal(plan.reason, "under_cap");
  assert.deepEqual(plan.uncovered_pages, []);

  // Negative control: the sample `common` planned before #530 (still the
  // tiers:common shape) stops on the downsell without clicking its decline.
  const resolved = resolveTestOrderTopology(topologies[0], topologies[0].pages[0]);
  const sample = commonTestOrderPaths(resolved);
  assert.deepEqual(sample, ["checkout", "accept", "decline"]);
  assert.ok(!sample.some((path) => path.startsWith("decline-")), "the sample has no path past the offer's decline");
});

test("common with no offers, or one offer and no downsell, records full/under_cap and plans what it did", () => {
  const noOffer = [{ funnel_id: "no-offer", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];
  const offerOnly = funnel("offer-only", "offer/", [offer("offer", "upsell", "receipt/", "receipt/")]);
  const none = commonOrderPathPlan(noOffer, {});
  assert.equal(none.effective_depth, "full");
  assert.equal(none.reason, "under_cap");
  const plan = commonOrderPathPlan(offerOnly, {});
  assert.equal(plan.effective_depth, "full");
  assert.equal(plan.reason, "under_cap");

  // Regression: these funnels plan the same paths as before.
  assert.deepEqual(testOrderPaths("common", noOffer), ["checkout"]);
  assert.deepEqual(testOrderPaths("common", offerOnly), ["checkout", "accept", "decline"]);
});

test("common at exactly the cap runs every terminal path", () => {
  const paths = testOrderPaths("common", atCap());
  assert.deepEqual(paths, ["checkout", "accept-accept", "decline-decline", "decline-accept", "accept-decline-decline", "accept-decline-accept"]);
  assert.doesNotThrow(() => enforceTestOrderLimit(testOrderPlans("common", atCap(), {}), { "test-order": "common" }));
});

test("common over the cap keeps the sample and adds one shortest decline path per uncovered downsell or offer", () => {
  const topologies = twoDownsells();
  assert.deepEqual(testOrderPaths("common", topologies), ["checkout", "accept", "decline", "accept-accept", "accept-decline-decline", "decline-decline-accept"]);
  const plan = commonOrderPathPlan(topologies, {});
  assert.equal(plan.full_path_count, 10);
  assert.equal(plan.effective_depth, "common");
  assert.equal(plan.reason, "over_cap");
  assert.deepEqual(plan.baseline_paths, ["checkout", "accept", "decline", "accept-accept"]);
  // accept-decline-decline declines upsell-2 and downsell-2 together, so
  // downsell-2 needs no path of its own.
  assert.deepEqual(plan.coverage_paths, ["accept-decline-decline", "decline-decline-accept"]);
  assert.deepEqual(testOrderPaths("common", topologies), [...plan.baseline_paths, ...plan.coverage_paths]);
  assert.deepEqual(plan.uncovered_pages, []);

  // An explicit raise at or above the full count runs full.
  const raised = commonOrderPathPlan(topologies, { "max-test-orders": "10" });
  assert.equal(raised.effective_depth, "full");
  assert.equal(raised.paths.length, 10);
});

test("a lowered --max-test-orders bounds the added paths and names the pages left out", () => {
  const topologies = twoDownsells();
  assert.deepEqual(testOrderPaths("common", topologies, { "max-test-orders": "5" }), ["checkout", "accept", "decline", "accept-accept", "accept-decline-decline"]);
  const five = commonOrderPathPlan(topologies, { "max-test-orders": "5" });
  assert.deepEqual(five.paths, ["checkout", "accept", "decline", "accept-accept", "accept-decline-decline"]);
  assert.deepEqual(five.uncovered_pages, [{ page_id: "downsell-1", page_type: "downsell", reason: "cap" }]);

  const atCapFive = commonOrderPathPlan(atCap(), { "max-test-orders": "5" });
  assert.equal(atCapFive.reason, "over_cap");
  assert.equal(atCapFive.paths.length, 5);
  assert.deepEqual(atCapFive.uncovered_pages.map((page) => page.page_id), ["downsell-1"]);

  // The sample is never trimmed: a cap below it is still refused before launch.
  const three = testOrderPlans("common", atCap(), { "max-test-orders": "3" });
  assert.equal(three.length, 4);
  assert.throws(
    () => enforceTestOrderLimit(three, { "test-order": "common", "max-test-orders": "3" }),
    /expands to 4 typed-card order\(s\), above --max-test-orders 3/,
  );
});

test("an offer reached only through its accept is not covered: common adds a path that clicks its decline", () => {
  // Over the cap, the sample's accept-accept reaches upsell-2 and clicks its
  // accept but never its decline. That must not count as covered.
  const topologies = twoDownsells();
  const paths = testOrderPaths("common", topologies);
  const clicks = paths.flatMap((path) => walk(topologies, path));
  assert.ok(clicks.some(({ page, action }) => page.page_id === "upsell-2" && action === "accept"), "the sample accepts upsell-2");
  assert.ok(
    clicks.some(({ page, action }) => page.page_id === "upsell-2" && action === "decline"),
    `a planned path must click upsell-2's decline: ${paths.join(", ")}`,
  );

  // With no room past the sample, the plan names upsell-2 as left out rather
  // than counting the accept.
  const plan = commonOrderPathPlan(atCap(), { "max-test-orders": "4" });
  assert.deepEqual(plan.paths, ["checkout", "accept", "decline", "accept-accept"]);
  assert.deepEqual(plan.uncovered_pages.map((page) => page.page_id), ["upsell-2", "downsell-1", "downsell-2"]);
});

test("the verdict warns naming each offer page whose decline no executed order clicked, even one it accepted", async () => {
  const topologies = atCap();
  const plans = testOrderPlans("common", topologies, { "max-test-orders": "4" });
  const { assertions } = await dispatch(topologies, plans);
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.family, "browser-test-order");
  assert.equal(row.status, "warn");
  assert.equal(row.severity, "warn");
  // Declaration order, as the topology lists them.
  assert.deepEqual(row.evidence.not_clicked_through, ["downsell-1", "upsell-2", "downsell-2"]);
  assert.match(row.actual, /3 of 4 page\(s\) with upsell actions: downsell-1, upsell-2, downsell-2/);
  const upsell2 = row.evidence.pages.find((page) => page.page_id === "upsell-2");
  assert.deepEqual(upsell2, { page_id: "upsell-2", page_type: "upsell", funnel_id: "at-cap", accept_clicked: true, decline_clicked: false });
});

test("the verdict row passes only when every offer page's decline was clicked, and reads clicks, not the plan", async () => {
  const topologies = downsellOnDecline();
  const plans = testOrderPlans("common", topologies, {});
  const bare = coverageRow((await dispatch(topologies, plans)).assertions);
  assert.ok(bare, "coverage row present");
  assert.equal(bare.status, "pass");
  const orderPathPlan = commonOrderPathPlan(topologies, {});
  const clean = coverageRow((await dispatch(topologies, plans, { orderPathPlan })).assertions);
  assert.ok(clean, "coverage row present");
  assert.equal(clean.status, "pass");
  assert.deepEqual(clean.evidence.not_clicked_through, []);
  assert.deepEqual(clean.evidence.uncertainty, []);
  assert.equal(clean.evidence.order_path_depth, "common");
  assert.equal(clean.evidence.order_path_depth_effective, "full");
  assert.equal(clean.evidence.order_path_depth_reason, "under_cap");

  // The plan declined the downsell, but no click was recorded there.
  const missed = coverageRow((await dispatch(topologies, plans, { skipDeclineOn: "downsell" })).assertions);
  assert.ok(missed, "coverage row present");
  assert.equal(missed.status, "warn");
  assert.deepEqual(missed.evidence.not_clicked_through, ["downsell"]);

  // One declaration listed twice in the funnel is one page, and still passes.
  const doubled = downsellOnDecline();
  doubled[0].pages.splice(2, 0, { ...doubled[0].pages[1] });
  const once = coverageRow((await dispatch(doubled, testOrderPlans("common", doubled, {}))).assertions);
  assert.ok(once, "coverage row present");
  assert.equal(once.status, "pass");
  assert.deepEqual(once.evidence.pages.map((page) => page.page_id), ["offer", "downsell"]);
});

test("the verdict row is manual review when no order was recorded, and absent for a funnel with no offers", async () => {
  const topologies = downsellOnDecline();
  const plans = testOrderPlans("common", topologies, {});
  const { assertions } = await dispatchTestOrderPlans({
    context: null,
    plans,
    checkoutPage: topologies[0].pages[0],
    args: {},
    options: { topologies, runSingleTestOrder: async () => { throw new Error("runner unavailable"); } },
  });
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present when no order ran");
  assert.equal(row.status, "manual_review");
  assert.equal(row.severity, "warn");
  assert.match(row.actual, /no test order was placed/);
  assert.equal(row.evidence.reason, "no_order_recorded");

  const noOffer = [{ funnel_id: "no-offer", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];
  const none = await dispatch(noOffer, testOrderPlans("common", noOffer, {}));
  assert.equal(coverageRow(none.assertions), undefined);
});

test("a --test-order off run records the coverage row as manual review naming every page with upsell actions", async () => {
  const topologies = atCap();
  const assertions = [];
  const result = await maybeRunTestOrders({ args: { "test-order": "off" }, resolved: { topologies }, runId: "run-off", assertions });
  assert.deepEqual(result.orders, []);
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present on an off run");
  assert.equal(row.status, "manual_review");
  assert.equal(row.severity, "warn");
  assert.equal(row.evidence.reason, "test_orders_off");
  assert.match(row.actual, /browser test orders were off \(--test-order off\).*upsell-1, downsell-1, upsell-2, downsell-2/);

  const noOffer = [{ funnel_id: "no-offer", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];
  const quiet = [];
  await maybeRunTestOrders({ args: {}, resolved: { topologies: noOffer }, runId: "run-off", assertions: quiet });
  // No test-order assertion: the only rows pushed are the three run-scope 1.1
  // tracking exclusions (test_order_not_requested), skipped at info.
  assert.deepEqual(quiet.map((entry) => entry.id).sort(), ["qc.tracking.order:run:order", "qc.tracking.tag:run:tag", "qc.tracking.url:run:url"]);
  for (const entry of quiet) {
    assert.equal(entry.status, "skipped", `${entry.id} status`);
    assert.equal(entry.severity, "info", `${entry.id} severity`);
  }
});

// A checkout-only primary funnel beside a secondary funnel that carries an
// offer. Operator modes drive only the primary checkout, so the secondary's
// offer is never clicked and must be named, not left out of the inventory.
function primaryPlusSecondary() {
  return [
    { funnel_id: "primary", pages: [
      { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("receipt/") },
      { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
    ] },
    { funnel_id: "secondary", pages: [
      { page_id: "checkout-2", page_type: "checkout", url: route("checkout-2/"), expected_next_url: route("offer-2/") },
      offer("offer-2", "upsell", "receipt-2/", "receipt-2/"),
      { page_id: "receipt-2", page_type: "thankyou", url: route("receipt-2/") },
    ] },
  ];
}

async function dispatchAll(topologies, plans, runSingleTestOrder = fakeRun(topologies)) {
  return dispatchTestOrderPlans({
    context: null,
    plans,
    checkoutPage: topologies[0].pages[0],
    args: {},
    options: { runSingleTestOrder, topologies },
  });
}

test("the coverage row inventories every funnel: a secondary funnel's offer is named with orders off and with orders on", async () => {
  const topologies = primaryPlusSecondary();

  const off = [];
  await maybeRunTestOrders({ args: { "test-order": "off" }, resolved: { topologies }, runId: "run-off", assertions: off });
  const offRow = coverageRow(off);
  assert.ok(offRow, "coverage row present on an off run");
  assert.equal(offRow.status, "manual_review");
  assert.equal(offRow.evidence.reason, "test_orders_off");
  assert.deepEqual(offRow.evidence.not_clicked_through, ["offer-2"]);
  assert.match(offRow.actual, /offer-2 \(funnel secondary\)/);

  // Distinct URLs and plans that belong to the primary funnel: attribution is
  // certain, so the unclicked secondary offer is a warn.
  const plans = testOrderPlans("common", topologies, {});
  assert.deepEqual(plans.map((plan) => plan.path), ["checkout"]);
  const onRow = coverageRow((await dispatchAll(topologies, plans)).assertions);
  assert.ok(onRow, "coverage row present on an orders-on run");
  assert.equal(onRow.status, "warn");
  assert.equal(onRow.severity, "warn");
  assert.deepEqual(onRow.evidence.not_clicked_through, ["offer-2"]);
  assert.deepEqual(onRow.evidence.funnels, [
    { funnel_id: "primary", orders_placed: 1, not_clicked_through: [] },
    { funnel_id: "secondary", orders_placed: 0, not_clicked_through: ["offer-2"] },
  ]);
  assert.match(onRow.actual, /1 of 1 page\(s\) with upsell actions: offer-2 \(funnel secondary\)\. No test order ran through funnel\(s\) secondary/);
});

test("failed attempts with no order reference are not placed orders: the row is manual review, not warn", async () => {
  const topologies = downsellOnDecline();
  const plans = testOrderPlans("common", topologies, {});
  // The real runner, failing before submit: every attempt leaves a
  // reference-less failure record in `orders`.
  const { orders, assertions } = await dispatchTestOrderPlans({
    context: { newPage: async () => { throw new Error("browser context unavailable"); } },
    plans,
    checkoutPage: topologies[0].pages[0],
    args: {},
    options: { topologies },
  });
  assert.ok(orders.length >= plans.length, "each failed attempt leaves a record");
  assert.ok(orders.every((order) => order && !order.ref_id), "none of them carries an order reference");
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.equal(row.severity, "warn");
  assert.equal(row.evidence.reason, "no_order_recorded");
  assert.equal(row.evidence.orders_placed, 0);
  assert.deepEqual(row.evidence.not_clicked_through, ["offer", "downsell"]);
});

// The row may pass or warn only when coverage is certain. Each case below is
// one way it is not, and each lands on manual_review naming why.

const checkoutOnly = (id, next = "receipt/") => ({ funnel_id: id, pages: [
  { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route(next) },
  { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
] });

function secondaryWithOffer(offerUrl) {
  return { funnel_id: "secondary", pages: [
    { page_id: "checkout-2", page_type: "checkout", url: route("checkout-2/"), expected_next_url: route("receipt-2/") },
    { page_id: "offer-2", page_type: "upsell", url: offerUrl, expected_accept_url: route("receipt-2/"), expected_decline_url: route("receipt-2/") },
    { page_id: "receipt-2", page_type: "thankyou", url: route("receipt-2/") },
  ] };
}

test("an offer URL shared by two funnels is manual review: a primary decline does not credit the secondary", async () => {
  const primary = downsellOnDecline()[0];
  const shared = { funnel_id: "secondary", pages: [
    { page_id: "checkout-2", page_type: "checkout", url: route("checkout-2/"), expected_next_url: route("offer/") },
    { ...primary.pages[1], page_id: "offer-copy" },
    { page_id: "receipt-2", page_type: "thankyou", url: route("receipt-2/") },
  ] };
  const topologies = [primary, shared];
  const row = coverageRow((await dispatchAll(topologies, testOrderPlans("common", topologies, {}))).assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.equal(row.evidence.reason, "not_assessable");
  assert.deepEqual(row.evidence.pages.map((page) => [page.funnel_id, page.page_id, page.decline_clicked, page.reason ?? null]), [
    ["downsell-on-decline", "offer", true, "shared_url"],
    ["downsell-on-decline", "downsell", true, null],
    ["secondary", "offer-copy", false, "shared_url"],
  ]);
  assert.deepEqual(row.evidence.funnels.map((funnel) => [funnel.funnel_id, funnel.orders_placed]), [["downsell-on-decline", 4], ["secondary", 0]]);
  assert.match(row.actual, /offer-copy \(funnel secondary; URL shared with another page\)/);
});

test("a placed order with an undeclared decline click and no funnel topology is manual review", async () => {
  const { assertions } = await dispatchTestOrderPlans({
    context: null,
    plans: ["decline"],
    checkoutPage: { page_id: "checkout", page_type: "checkout", url: route("checkout/") },
    args: {},
    options: {
      runSingleTestOrder: async () => ({ ok: true, order: { ref_id: "ref-decline", path: "decline", upsell_steps: [{ path: "decline", clicked: true, offer_url: route("offer/") }] } }),
    },
  });
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.equal(row.evidence.reason, "no_topology");
  assert.deepEqual(row.evidence.uncertainty.map((doubt) => doubt.reason), ["no_topology", "unattributed_plan", "unattributed_click"]);
});

test("a plan whose page list differs from its funnel's, even with the funnel's id, is manual review", async () => {
  const topologies = downsellOnDecline();
  const [checkout] = topologies[0].pages;
  const foreign = {
    topology_id: "downsell-on-decline",
    checkout_url: route("checkout-other/"),
    route_pages: [
      { page_id: "checkout", page_type: "checkout", url: route("checkout-other/") },
      { page_id: "offer-2", page_type: "upsell", url: null },
    ],
  };
  // Same funnel id, a different checkout URL, and an offer with no URL.
  const byId = await dispatchAll(topologies, [...testOrderPlans("common", topologies, {}), { path: "decline-decline", topology_plan: foreign }]);
  const row = coverageRow(byId.assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.deepEqual(row.evidence.uncertainty, [{ reason: "unattributed_plan", plans: ["decline-decline"] }, { reason: "unattributed_click", clicks: 2 }]);

  // The funnel's own checkout page, but planned over a different page list.
  const sameCheckout = await dispatchAll(topologies, [{ path: "decline-decline", checkout_page: checkout, topology_plan: { ...foreign, checkout_url: checkout.url } }]);
  const sameRow = coverageRow(sameCheckout.assertions);
  assert.ok(sameRow, "coverage row present");
  assert.equal(sameRow.status, "manual_review");
  assert.equal(sameRow.evidence.uncertainty[0].reason, "unattributed_plan");
});

test("an offer page with no URL is named as not assessable with orders off, with orders on, and beside a clicked primary offer", async () => {
  const topologies = [checkoutOnly("primary"), secondaryWithOffer(null)];

  const off = [];
  await maybeRunTestOrders({ args: { "test-order": "off" }, resolved: { topologies }, runId: "run-off", assertions: off });
  const offRow = coverageRow(off);
  assert.ok(offRow, "coverage row present on an off run");
  assert.equal(offRow.status, "manual_review");
  assert.equal(offRow.evidence.reason, "test_orders_off");
  assert.deepEqual(offRow.evidence.not_assessable, [{ page_id: "offer-2", funnel_id: "secondary", reason: "no_url" }]);
  assert.match(offRow.actual, /offer-2 \(funnel secondary; no URL\)/);

  const on = coverageRow((await dispatchAll(topologies, testOrderPlans("common", topologies, {}))).assertions);
  assert.ok(on, "coverage row present on an orders-on run");
  assert.equal(on.status, "manual_review");
  assert.equal(on.severity, "warn");
  assert.equal(on.evidence.reason, "not_assessable");
  assert.equal(on.evidence.orders_placed, 1);
  assert.deepEqual(on.evidence.not_clicked_through, ["offer-2"]);
  assert.match(on.actual, /1 page\(s\) cannot be matched to a click\), so 1 of 1 page\(s\).*offer-2 \(funnel secondary; no URL\)/);

  // The primary's own offer and downsell are both declined; the secondary's
  // URL-less offer still keeps the row from passing.
  const clickedPrimary = [downsellOnDecline()[0], secondaryWithOffer(null)];
  const mixed = coverageRow((await dispatchAll(clickedPrimary, testOrderPlans("common", clickedPrimary, {}))).assertions);
  assert.ok(mixed, "coverage row present");
  assert.equal(mixed.status, "manual_review");
  assert.equal(mixed.evidence.reason, "not_assessable");
  assert.deepEqual(mixed.evidence.pages.map((page) => [page.page_id, page.decline_clicked, page.reason ?? null]), [
    ["offer", true, null],
    ["downsell", true, null],
    ["offer-2", false, "no_url"],
  ]);
  assert.match(mixed.actual, /so 1 of 3 page\(s\) with upsell actions are not proved clicked through: offer-2 \(funnel secondary; no URL\)/);
});

test("an offer page whose URL is not an absolute http(s) address is named as not assessable", async () => {
  const topologies = [downsellOnDecline()[0], secondaryWithOffer("offer-2/")];
  const row = coverageRow((await dispatchAll(topologies, testOrderPlans("common", topologies, {}))).assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.deepEqual(row.evidence.not_assessable, [{ page_id: "offer-2", funnel_id: "secondary", reason: "unresolvable_url" }]);
  assert.match(row.actual, /offer-2 \(funnel secondary; URL is not an absolute http\(s\) address\)/);
});

test("funnels with no id are told apart, and neither one's offer is dropped", async () => {
  const first = checkoutOnly(undefined);
  const second = { ...secondaryWithOffer(route("offer-2/")), funnel_id: undefined };
  const topologies = [first, second];
  const row = coverageRow((await dispatchAll(topologies, testOrderPlans("common", topologies, {}))).assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "warn");
  assert.deepEqual(row.evidence.not_clicked_through, ["offer-2"]);
  assert.match(row.actual, /offer-2 \(funnel \(unnamed funnel 2\)\)\. No test order ran through funnel\(s\) \(unnamed funnel 2\)/);
});

test("a page whose type does not say whether it offers anything keeps the row at manual review, clicked or not", async () => {
  const withUntyped = () => {
    const topology = downsellOnDecline()[0];
    topology.pages.splice(3, 0, { page_id: "bridge", url: route("bridge/") }, { page_id: "generic", page_type: "page", url: route("generic/") });
    return [topology];
  };
  const topologies = withUntyped();
  const row = coverageRow((await dispatchAll(topologies, testOrderPlans("common", topologies, {}))).assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.equal(row.evidence.reason, "not_assessable");
  assert.deepEqual(row.evidence.not_assessable.map((page) => [page.page_id, page.reason]), [
    ["bridge", "unknown_page_type"],
    ["generic", "unknown_page_type"],
  ]);

  // A recorded accept click on the untyped page does not make it certain.
  const clickedAccept = withUntyped();
  const { assertions } = await dispatchAll(clickedAccept, testOrderPlans("common", clickedAccept, {}), async (context, page, plan, ...rest) => {
    const result = await fakeRun(clickedAccept)(context, page, plan, ...rest);
    if (plan.path === "accept") result.order.upsell_steps.push({ path: "accept", clicked: true, offer_url: route("bridge/") });
    return result;
  });
  const accepted = coverageRow(assertions);
  assert.ok(accepted, "coverage row present");
  assert.equal(accepted.status, "manual_review");
  const bridge = accepted.evidence.pages.find((page) => page.page_id === "bridge");
  assert.deepEqual([bridge.accept_clicked, bridge.decline_clicked, bridge.reason], [true, false, "unknown_page_type"]);
});

test("an order that clicks a page its funnel never declared makes the row manual review", async () => {
  const topologies = downsellOnDecline();
  const { assertions } = await dispatchAll(topologies, testOrderPlans("common", topologies, {}), async (context, page, plan, ...rest) => {
    const result = await fakeRun(topologies)(context, page, plan, ...rest);
    if (plan.path === "accept") result.order.upsell_steps.push({ path: "decline", clicked: true, offer_url: route("extra-offer/") });
    return result;
  });
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.deepEqual(row.evidence.uncertainty, [{ reason: "undeclared_click", urls: ["/extra-offer"] }]);
  assert.match(row.actual, /an order clicked page\(s\) its funnel does not declare: \/extra-offer/);
});

test("a funnel with no page list is named, not read as having no offers", async () => {
  const assertions = [];
  await maybeRunTestOrders({ args: { "test-order": "off" }, resolved: { topologies: [downsellOnDecline()[0], { funnel_id: "listless" }] }, runId: "run-off", assertions });
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.deepEqual(row.evidence.not_assessable, [{ page_id: null, funnel_id: "listless", reason: "no_pages" }]);
  assert.match(row.actual, /\(page list missing\) \(funnel listless; funnel lists no pages\)/);
});

test("orders placed with no funnel topology give a manual-review row, not silence", async () => {
  const { assertions } = await dispatchTestOrderPlans({
    context: null,
    plans: ["checkout"],
    checkoutPage: { page_id: "checkout", page_type: "checkout", url: route("checkout/") },
    args: {},
    options: { runSingleTestOrder: async () => ({ ok: true, order: { ref_id: "ref-checkout", path: "checkout", upsell_steps: [] } }) },
  });
  const row = coverageRow(assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.equal(row.evidence.reason, "no_topology");
});

test("a run stopped for a missing checkout URL still names every offer page", async () => {
  const topology = downsellOnDecline()[0];
  topology.pages[0] = { ...topology.pages[0], url: null };
  const result = await runBrowserTestOrders([topology], { "test-order": "common" });
  const row = coverageRow(result.assertions);
  assert.ok(row, "coverage row present");
  assert.equal(row.status, "manual_review");
  assert.equal(row.evidence.reason, "no_order_recorded");
  assert.deepEqual(row.evidence.not_clicked_through, ["offer", "downsell"]);
});
