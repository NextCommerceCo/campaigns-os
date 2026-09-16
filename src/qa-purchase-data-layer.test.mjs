import test from "node:test";
import assert from "node:assert/strict";
import {
  PURCHASE_DATA_LAYER,
  PURCHASE_EVENT,
  assessPurchaseDataLayer,
  expectedOrderReferences,
  purchaseDataLayerAssertion,
  purchaseDataLayerProbe,
} from "./qa-purchase-data-layer.mjs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { SEVERITY, STATUS } from "./qa-verdict.mjs";

const ORDER = {
  next_order_id: "100234",
  ref_id: "a1b2c3d4-ref",
  final_url: "https://example.test/receipt/?ref_id=a1b2c3d4-ref",
  evidence: {},
};

const CHECKOUT = { route: "https://example.test/checkout/", generation: 1 };
const UPSELL = { route: "https://example.test/upsell/", generation: 2 };
const RECEIPT = { route: "https://example.test/receipt/", generation: 3 };

function push(document, data, layer = PURCHASE_DATA_LAYER) {
  return { layer, data, document };
}

function purchase(transactionId, extra = {}) {
  return { event: PURCHASE_EVENT, ecommerce: { transaction_id: transactionId, value: 45, currency: "USD", ...extra } };
}

// The shape attachAnalyticsCapture(page).rawEvents() hands back.
function raw(events, complete = true) {
  return { complete, events };
}

// A journey the SDK actually produces: checkout pushes cart events, the first
// ref_id page (the upsell) reports the purchase, the receipt is deduped.
function healthyJourney(transactionId = "100234") {
  return raw([
    push(CHECKOUT, { event: "dl_user_data" }),
    push(CHECKOUT, { event: "dl_begin_checkout" }),
    push(UPSELL, { event: "dl_user_data" }),
    push(UPSELL, purchase(transactionId)),
    // The GTM adapter mirrors the same event to window.dataLayer: not a duplicate.
    push(UPSELL, purchase(transactionId), "dataLayer"),
    push(RECEIPT, { event: "dl_user_data" }),
    push(RECEIPT, { event: "dl_cart_updated" }),
  ]);
}

// --- the three outcomes the issue names ---------------------------------

test("present once with a matching order id passes", () => {
  const probe = purchaseDataLayerProbe(healthyJourney());
  const record = assessPurchaseDataLayer(probe, ORDER);
  assert.equal(record.outcome, "pass");
  assert.equal(record.ok, true);
  assert.equal(record.measured, true);
  assert.equal(record.count, 1);
  assert.equal(record.order_ref_match, true);
  assert.deepEqual(record.observed_transaction_ids, ["100234"]);
  assert.deepEqual(record.expected_order_refs, ["100234", "a1b2c3d4-ref"]);
  assert.match(record.reason, /one dl_purchase .* on https:\/\/example\.test\/upsell\/ carrying transaction_id 100234/);

  const assertion = purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER, data_layer: record });
  assert.equal(assertion.id, "analytics-correctness:data-layer-purchase:checkout");
  assert.equal(assertion.family, "analytics-correctness");
  assert.equal(assertion.page, "checkout:order:checkout");
  assert.equal(assertion.url, "https://example.test/receipt/");
  assert.equal(assertion.status, STATUS.PASS);
  assert.equal(assertion.severity, undefined);
  assert.equal(assertion.actual, record.reason);
});

test("absent dl_purchase on every page after the order fails as a blocker", () => {
  const probe = purchaseDataLayerProbe(raw([
    push(CHECKOUT, { event: "dl_user_data" }),
    push(UPSELL, { event: "dl_user_data" }),
    push(RECEIPT, { event: "dl_cart_updated" }),
  ]));
  const record = assessPurchaseDataLayer(probe, ORDER);
  assert.equal(record.outcome, "absent");
  assert.equal(record.ok, false);
  assert.equal(record.count, 0);
  assert.equal(record.order_ref_match, null);
  assert.match(record.reason, /no dl_purchase in window\.NextDataLayer on any page after the order \(3 event\(s\) on 3 document\(s\): dl_user_data×2, dl_cart_updated×1\)/);

  const assertion = purchaseDataLayerAssertion({ page_id: "checkout" }, "accept", { ...ORDER, data_layer: record });
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER);
});

test("more than one dl_purchase fails as a blocker (#302), whether on one page or across pages", () => {
  // The dedupe failure: the upsell reported it, then the receipt reported it again.
  const acrossPages = assessPurchaseDataLayer(purchaseDataLayerProbe(raw([
    push(UPSELL, purchase("100234")),
    push(RECEIPT, { event: "dl_upsell_purchase", ecommerce: { transaction_id: "100235" } }),
    push(RECEIPT, purchase("100234")),
  ])), ORDER);
  assert.equal(acrossPages.outcome, "duplicate");
  assert.equal(acrossPages.ok, false);
  assert.equal(acrossPages.count, 2, "dl_upsell_purchase is a different event and is not counted");
  assert.deepEqual(acrossPages.observed_transaction_ids, ["100234", "100234"]);
  assert.equal(acrossPages.order_ref_match, true);
  assert.match(acrossPages.reason, /pushed 2 times to window\.NextDataLayer on https:\/\/example\.test\/upsell\/, https:\/\/example\.test\/receipt\/ .*one order must report one purchase/);

  // The double-bootstrap defect: two pushes on the same page.
  const samePage = assessPurchaseDataLayer(purchaseDataLayerProbe(raw([
    push(UPSELL, purchase("100234")),
    push(UPSELL, purchase("100234")),
  ])), ORDER);
  assert.equal(samePage.outcome, "duplicate");

  const assertion = purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER, data_layer: acrossPages });
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER);
});

// --- the edges around them -----------------------------------------------

test("one dl_purchase naming a different order is a mismatch blocker", () => {
  const record = assessPurchaseDataLayer(purchaseDataLayerProbe(raw([push(UPSELL, purchase("999"))])), ORDER);
  assert.equal(record.outcome, "mismatch");
  assert.equal(record.ok, false);
  assert.equal(record.order_ref_match, false);
  assert.match(record.reason, /transaction_id 999 is not the placed order \(100234 \/ a1b2c3d4-ref\)/);
});

test("one dl_purchase with no transaction_id is a mismatch blocker", () => {
  const record = assessPurchaseDataLayer(purchaseDataLayerProbe(raw([push(UPSELL, purchase(null))])), ORDER);
  assert.equal(record.outcome, "mismatch");
  assert.match(record.reason, /carries no transaction_id/);
});

test("the ref id is an acceptable match when the order number is unknown", () => {
  const record = assessPurchaseDataLayer(purchaseDataLayerProbe(raw([push(UPSELL, purchase("a1b2c3d4-ref"))])), { ...ORDER, next_order_id: null });
  assert.equal(record.outcome, "pass");
  assert.deepEqual(record.expected_order_refs, ["a1b2c3d4-ref"]);
  assert.deepEqual(expectedOrderReferences({ next_order_id: " 7 ", ref_id: "7" }), ["7"]);
});

test("one dl_purchase with no recorded order reference is manual review, not a pass", () => {
  const record = assessPurchaseDataLayer(purchaseDataLayerProbe(raw([push(UPSELL, purchase("100234"))])), { next_order_id: null, ref_id: "" });
  assert.equal(record.outcome, "order_ref_unknown");
  assert.equal(record.ok, null);
  assert.equal(record.order_ref_match, null);
  const assertion = purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", { data_layer: record });
  assert.equal(assertion.status, STATUS.MANUAL_REVIEW);
  assert.equal(assertion.severity, SEVERITY.WARN);
  assert.equal(assertion.url, undefined);
});

test("an unhooked or unreadable data layer is an unmeasured blocker, never a zero-signal reading", () => {
  const explicit = assessPurchaseDataLayer(null, ORDER, { probeError: "the data-layer hook could not attach to the page" });
  assert.equal(explicit.outcome, "unmeasured");
  assert.equal(explicit.measured, false);
  assert.equal(explicit.ok, false);
  assert.equal(explicit.count, null);
  assert.equal(explicit.observed_transaction_ids, null);
  assert.match(explicit.reason, /could not be read after the order: the data-layer hook could not attach/);
  assert.equal(purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", { data_layer: explicit }).status, STATUS.FAIL);

  // A log with no binding holds only the current document: not the journey.
  const incomplete = purchaseDataLayerProbe(raw([push(UPSELL, purchase("100234"))], false));
  assert.equal(incomplete.measured, false);
  assert.deepEqual(incomplete.purchases, []);
  assert.equal(assessPurchaseDataLayer(incomplete, ORDER).outcome, "unmeasured");
});

test("no assertion is emitted for an order without a data-layer record", () => {
  assert.equal(purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER }), null);
  assert.equal(purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", null), null);
});

test("the assertion evidence carries the record plus the probe's counts, documents and purchases", () => {
  const probe = purchaseDataLayerProbe(healthyJourney());
  const record = assessPurchaseDataLayer(probe, ORDER);
  const assertion = purchaseDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER, data_layer: record, evidence: { data_layer: probe } });
  assert.deepEqual(assertion.evidence.event_counts, { dl_user_data: 3, dl_begin_checkout: 1, dl_purchase: 1, dl_cart_updated: 1 });
  assert.deepEqual(assertion.evidence.documents.map((entry) => [entry.route, entry.event_count, entry.purchase_count]), [
    ["https://example.test/checkout/", 2, 0],
    ["https://example.test/upsell/", 2, 1],
    ["https://example.test/receipt/", 2, 0],
  ]);
  assert.equal(assertion.evidence.purchases.length, 1);
  assert.equal(assertion.evidence.outcome, "pass");
});

// --- the probe reducer ---------------------------------------------------------

test("the probe counts the SDK's own layer only and keeps the purchase fields", () => {
  const probe = purchaseDataLayerProbe(healthyJourney());
  assert.equal(probe.layer, "NextDataLayer");
  assert.equal(probe.measured, true);
  assert.equal(probe.length, 6, "the window.dataLayer mirror is not counted");
  assert.deepEqual(probe.purchases, [{ index: 3, document_route: "https://example.test/upsell/", transaction_id: "100234", value: 45, currency: "USD" }]);
});

test("the probe tolerates malformed pushes and a numeric transaction id", () => {
  const probe = purchaseDataLayerProbe(raw([
    push(UPSELL, "not an object"),
    push(UPSELL, { noEvent: true }),
    push(UPSELL, { event: PURCHASE_EVENT, ecommerce: { transaction_id: 100234, value: "45" } }),
    push(null, { event: PURCHASE_EVENT }),
  ]));
  assert.equal(probe.length, 4);
  assert.deepEqual(probe.event_counts, { dl_purchase: 2 });
  assert.deepEqual(probe.purchases.map((entry) => [entry.document_route, entry.transaction_id, entry.value]), [
    ["https://example.test/upsell/", "100234", null],
    [null, null, null],
  ]);
});

// --- the Node-side wait ------------------------------------------------------

test("waitForPurchaseDataLayer polls until the event arrives, then allows a duplicate grace", async () => {
  const { waitForPurchaseDataLayer } = __qaBrowserTestHooks;
  let clock = 0;
  const events = [push(CHECKOUT, { event: "dl_user_data" })];
  const waits = [];
  const probe = await waitForPurchaseDataLayer({
    read: () => raw(events),
    settleMs: 5000,
    deadline: 10000,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
      // The purchase lands after the third poll; a second push follows within the grace.
      if (waits.length === 3) events.push(push(UPSELL, purchase("100234")));
      if (waits.length === 4) events.push(push(UPSELL, purchase("100234")));
    },
  });
  assert.deepEqual(waits, [100, 100, 100, 1000]);
  assert.equal(probe.purchases.length, 2, "the duplicate that lands inside the grace is counted");
});

test("waitForPurchaseDataLayer gives up at the settle window or the deadline, whichever is first", async () => {
  const { waitForPurchaseDataLayer } = __qaBrowserTestHooks;
  let clock = 0;
  const waits = [];
  const probe = await waitForPurchaseDataLayer({
    read: () => raw([]),
    settleMs: 5000,
    deadline: 250,
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; },
  });
  assert.deepEqual(waits, [100, 100, 50]);
  assert.equal(probe.purchases.length, 0);
  assert.equal(probe.measured, true);
});
