import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_DATA_LAYER,
  RECEIPT_DATA_LAYER_PROBE_INPUT,
  RECEIPT_PURCHASE_EVENT,
  assessReceiptDataLayer,
  expectedOrderReferences,
  receiptDataLayerAssertion,
  receiptDataLayerProbeScript,
} from "./qa-receipt-data-layer.mjs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { SEVERITY, STATUS } from "./qa-verdict.mjs";

const ORDER = {
  next_order_id: "100234",
  ref_id: "a1b2c3d4-ref",
  final_url: "https://example.test/receipt/?ref_id=a1b2c3d4-ref",
  evidence: {},
};

function purchase(transactionId, extra = {}) {
  return { event: RECEIPT_PURCHASE_EVENT, ecommerce: { transaction_id: transactionId, value: 45, currency: "USD", ...extra } };
}

function probeFor(entries) {
  return { layer: RECEIPT_DATA_LAYER, event: RECEIPT_PURCHASE_EVENT, defined: true, is_array: true, length: entries.length, ...countAndPurchases(entries) };
}

function countAndPurchases(entries) {
  const event_counts = {};
  const purchases = [];
  entries.forEach((entry, index) => {
    event_counts[entry.event] = (event_counts[entry.event] || 0) + 1;
    if (entry.event === RECEIPT_PURCHASE_EVENT) {
      purchases.push({ index, transaction_id: entry.ecommerce?.transaction_id ?? null, value: entry.ecommerce?.value ?? null, currency: entry.ecommerce?.currency ?? null });
    }
  });
  return { event_counts, purchases };
}

// Run the serialised evaluate body against a fake window, the way the page
// would, so the reader under test is the reader the runner ships.
function runProbe(layerValue, input = RECEIPT_DATA_LAYER_PROBE_INPUT) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, input.layer);
  if (layerValue === undefined) delete globalThis[input.layer];
  else globalThis[input.layer] = layerValue;
  try {
    return receiptDataLayerProbeScript()(input);
  } finally {
    if (previous) Object.defineProperty(globalThis, input.layer, previous);
    else delete globalThis[input.layer];
  }
}

// --- the three outcomes the issue names ---------------------------------

test("present once with a matching order id passes", () => {
  const record = assessReceiptDataLayer(probeFor([{ event: "dl_user_data" }, purchase("100234")]), ORDER);
  assert.equal(record.outcome, "pass");
  assert.equal(record.ok, true);
  assert.equal(record.measured, true);
  assert.equal(record.count, 1);
  assert.equal(record.order_ref_match, true);
  assert.deepEqual(record.observed_transaction_ids, ["100234"]);
  assert.deepEqual(record.expected_order_refs, ["100234", "a1b2c3d4-ref"]);
  assert.match(record.reason, /one dl_purchase .* transaction_id 100234/);

  const assertion = receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER, data_layer: record });
  assert.equal(assertion.id, "analytics-correctness:data-layer-purchase:checkout");
  assert.equal(assertion.family, "analytics-correctness");
  assert.equal(assertion.page, "checkout:receipt:checkout");
  assert.equal(assertion.url, "https://example.test/receipt/");
  assert.equal(assertion.status, STATUS.PASS);
  assert.equal(assertion.severity, undefined);
  assert.equal(assertion.actual, record.reason);
});

test("absent dl_purchase fails as a blocker", () => {
  const record = assessReceiptDataLayer(probeFor([{ event: "dl_user_data" }, { event: "dl_view_item" }]), ORDER);
  assert.equal(record.outcome, "absent");
  assert.equal(record.ok, false);
  assert.equal(record.count, 0);
  assert.equal(record.order_ref_match, null);
  assert.match(record.reason, /no dl_purchase in window\.NextDataLayer .*dl_user_data×1, dl_view_item×1/);

  const assertion = receiptDataLayerAssertion({ page_id: "checkout" }, "accept", { ...ORDER, data_layer: record });
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER);
});

test("more than one dl_purchase fails as a blocker (#302), even when both name the order", () => {
  const record = assessReceiptDataLayer(probeFor([purchase("100234"), { event: "dl_upsell_purchase", ecommerce: { transaction_id: "100235" } }, purchase("100234")]), ORDER);
  assert.equal(record.outcome, "duplicate");
  assert.equal(record.ok, false);
  assert.equal(record.count, 2, "dl_upsell_purchase is a different event and is not counted");
  assert.deepEqual(record.observed_transaction_ids, ["100234", "100234"]);
  assert.equal(record.order_ref_match, true);
  assert.match(record.reason, /pushed 2 times .*one order must report one purchase/);

  const assertion = receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER, data_layer: record });
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER);
});

// --- the edges around them -----------------------------------------------

test("one dl_purchase naming a different order is a mismatch blocker", () => {
  const record = assessReceiptDataLayer(probeFor([purchase("999")]), ORDER);
  assert.equal(record.outcome, "mismatch");
  assert.equal(record.ok, false);
  assert.equal(record.order_ref_match, false);
  assert.match(record.reason, /transaction_id 999 is not the placed order \(100234 \/ a1b2c3d4-ref\)/);
});

test("one dl_purchase with no transaction_id is a mismatch blocker", () => {
  const record = assessReceiptDataLayer(probeFor([purchase(null)]), ORDER);
  assert.equal(record.outcome, "mismatch");
  assert.match(record.reason, /carries no transaction_id/);
});

test("the ref id is an acceptable match when the order number is unknown", () => {
  const record = assessReceiptDataLayer(probeFor([purchase("a1b2c3d4-ref")]), { ...ORDER, next_order_id: null });
  assert.equal(record.outcome, "pass");
  assert.deepEqual(record.expected_order_refs, ["a1b2c3d4-ref"]);
  assert.deepEqual(expectedOrderReferences({ next_order_id: " 7 ", ref_id: "7" }), ["7"]);
});

test("one dl_purchase with no recorded order reference is manual review, not a pass", () => {
  const record = assessReceiptDataLayer(probeFor([purchase("100234")]), { next_order_id: null, ref_id: "" });
  assert.equal(record.outcome, "order_ref_unknown");
  assert.equal(record.ok, null);
  assert.equal(record.order_ref_match, null);
  const assertion = receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", { data_layer: record });
  assert.equal(assertion.status, STATUS.MANUAL_REVIEW);
  assert.equal(assertion.severity, SEVERITY.WARN);
  assert.equal(assertion.url, undefined);
});

test("an unreadable data layer is an unmeasured blocker, never a zero-signal reading", () => {
  const record = assessReceiptDataLayer(null, ORDER, { probeError: "page closed" });
  assert.equal(record.outcome, "unmeasured");
  assert.equal(record.measured, false);
  assert.equal(record.ok, false);
  assert.equal(record.count, null);
  assert.equal(record.observed_transaction_ids, null);
  assert.match(record.reason, /could not be read on the receipt: page closed/);
  assert.equal(receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", { data_layer: record }).status, STATUS.FAIL);
});

test("a receipt with no NextDataLayer at all, or a non-array one, is absent", () => {
  const undefinedLayer = assessReceiptDataLayer({ defined: false, is_array: false, length: 0, event_counts: {}, purchases: [] }, ORDER);
  assert.equal(undefinedLayer.outcome, "absent");
  assert.match(undefinedLayer.reason, /is not defined on the receipt document/);
  const notArray = assessReceiptDataLayer({ defined: true, is_array: false, length: 0, event_counts: {}, purchases: [] }, ORDER);
  assert.equal(notArray.outcome, "absent");
  assert.match(notArray.reason, /is not an array/);
});

test("no assertion is emitted for an order without a data-layer record", () => {
  assert.equal(receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER }), null);
  assert.equal(receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", null), null);
});

test("the assertion evidence carries the record plus the probe's event counts and purchases", () => {
  const entries = [{ event: "dl_user_data" }, purchase("100234")];
  const probe = probeFor(entries);
  const record = assessReceiptDataLayer(probe, ORDER);
  const assertion = receiptDataLayerAssertion({ page_id: "checkout" }, "checkout", { ...ORDER, data_layer: record, evidence: { data_layer: probe } });
  assert.deepEqual(assertion.evidence.event_counts, { dl_user_data: 1, dl_purchase: 1 });
  assert.equal(assertion.evidence.purchases.length, 1);
  assert.equal(assertion.evidence.outcome, "pass");
});

// --- the in-page reader ----------------------------------------------------

test("the probe script reads dl_purchase entries off the named layer and counts every event", () => {
  const probe = runProbe([
    { event: "dl_user_data" },
    purchase(100234, { value: 45 }),
    { event: "dl_upsell_purchase", ecommerce: { transaction_id: "100235", value: 10, currency: "USD" } },
    "not an object",
    { noEvent: true },
  ]);
  assert.equal(probe.layer, "NextDataLayer");
  assert.equal(probe.defined, true);
  assert.equal(probe.is_array, true);
  assert.equal(probe.length, 5);
  assert.deepEqual(probe.event_counts, { dl_user_data: 1, dl_purchase: 1, dl_upsell_purchase: 1 });
  assert.deepEqual(probe.purchases, [{ index: 1, transaction_id: "100234", value: 45, currency: "USD" }]);
});

test("the probe script reports an undefined or non-array layer without throwing", () => {
  assert.deepEqual(runProbe(undefined), { layer: "NextDataLayer", event: "dl_purchase", defined: false, is_array: false, length: 0, event_counts: {}, purchases: [] });
  const notArray = runProbe({ push() {} });
  assert.equal(notArray.defined, true);
  assert.equal(notArray.is_array, false);
});

test("the probe script refuses an input without its layer and event", () => {
  assert.throws(() => receiptDataLayerProbeScript()({}), /RECEIPT_DATA_LAYER_PROBE_INPUT/);
});

test("a duplicate push read through the probe judges as duplicate end to end", () => {
  const probe = runProbe([purchase("100234"), purchase("100234")]);
  assert.equal(assessReceiptDataLayer(probe, ORDER).outcome, "duplicate");
});

// --- the browser-side reader against a fake page ----------------------------

test("receiptDataLayerEvidence waits for the event, allows a duplicate grace, then reads once", async () => {
  const { receiptDataLayerEvidence } = __qaBrowserTestHooks;
  const calls = [];
  const page = {
    async waitForFunction(fn, input, options) {
      calls.push(["waitForFunction", input, options.timeout]);
      // The predicate is serialised into the page; exercise it here the same way.
      globalThis.NextDataLayer = [purchase("100234")];
      try { assert.equal(fn(input), true); } finally { delete globalThis.NextDataLayer; }
    },
    async waitForTimeout(ms) { calls.push(["waitForTimeout", ms]); },
    async evaluate(fn, input) {
      calls.push(["evaluate", input]);
      globalThis.NextDataLayer = [purchase("100234")];
      try { return fn(input); } finally { delete globalThis.NextDataLayer; }
    },
  };
  const result = await receiptDataLayerEvidence(page, { settleMs: 250 });
  assert.equal(result.error, null);
  assert.equal(result.probe.purchases.length, 1);
  assert.deepEqual(calls, [
    ["waitForFunction", RECEIPT_DATA_LAYER_PROBE_INPUT, 250],
    ["waitForTimeout", 250],
    ["evaluate", RECEIPT_DATA_LAYER_PROBE_INPUT],
  ]);
});

test("receiptDataLayerEvidence never throws: a read failure comes back as error", async () => {
  const { receiptDataLayerEvidence } = __qaBrowserTestHooks;
  const page = {
    async waitForFunction() { throw new Error("target closed"); },
    async waitForTimeout() {},
    async evaluate() { throw new Error("Execution context was destroyed"); },
  };
  const result = await receiptDataLayerEvidence(page, { settleMs: 10 });
  assert.equal(result.probe, null);
  assert.match(result.error, /Execution context was destroyed/);
  assert.equal(assessReceiptDataLayer(result.probe, ORDER, { probeError: result.error }).outcome, "unmeasured");
});
