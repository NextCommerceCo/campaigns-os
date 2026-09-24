import test from "node:test";
import assert from "node:assert/strict";

import { assessAnalyticsInventory, assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { effectivePurchase, normalizeCapture } from "./qa-analytics-parity.mjs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { resolveTestOrderTopology } from "./qa-test-order-topology.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const WAIVABLE = "analytics-correctness:purchase-fires";
const PLAN = "accept-decline";

function capture(source = "datalayer", sensitive = false) {
  const transactionId = sensitive ? "txn-secret-123" : "txn-1";
  const events = source === "datalayer"
    ? [{ layer: "dataLayer", data: {
      event: "dl_purchase",
      ecommerce: { value: 149.99, currency: "USD", transaction_id: transactionId },
    } }]
    : [];
  const tagFires = source === "meta"
    ? [{ kind: "meta", id: "pixel-secret", host: "facebook.com", params: { ev: "Purchase", eid: transactionId } }]
    : source === "ga4"
      ? [{ kind: "ga4", id: "G-SECRET", host: "google-analytics.com", params: { en: "purchase" } }]
      : [];
  return normalizeCapture({ events, tagFires });
}

function receiptAttempt({
  planId = PLAN,
  source = "datalayer",
  receiptRecognized = true,
  receiptUrl = "https://shop.example/campaign/receipt/?ref_id=order-secret&utm_source=qa",
  captureError,
} = {}) {
  return {
    planId,
    receiptRecognized,
    receiptUrl,
    ...(captureError ? { captureError } : { capture: source ? capture(source, true) : normalizeCapture() }),
  };
}

function assess(attempts, plannedPlanIds = attempts.map((attempt) => attempt.planId), waivers = {}) {
  return assessReceiptPurchase({ plannedPlanIds, attempts }, { waivers });
}

test("campaign-root analytics inventory never emits or evidences Purchase authority", () => {
  const assertions = assessAnalyticsInventory(capture("datalayer", true), {
    providers: { gtm: { enabled: true, containerId: "GTM-MISSING" } },
  }, { url: "https://shop.example/campaign/" });

  assert.ok(assertions.length > 0);
  assert.ok(!assertions.some((assertion) => assertion.id === WAIVABLE));
  const serialized = JSON.stringify(assertions);
  assert.doesNotMatch(serialized, /purchase_signals|purchase_fired|txn-secret-123|149\.99/);
  assert.equal(assertions[0].id, "analytics-correctness:tag:gtm");
  assert.equal(assertions[0].status, STATUS.FAIL, "existing provider failures stay blocking");
  assert.equal(assertions[0].severity, SEVERITY.BLOCKER);
});

for (const source of ["datalayer", "meta", "ga4"]) {
  test(`receipt-qualified ${source} Purchase passes with source-aware evidence`, () => {
    const assertion = assess([receiptAttempt({ source })]);
    assert.equal(assertion.id, WAIVABLE);
    assert.equal(assertion.status, STATUS.PASS);
    assert.equal(assertion.evidence.receipts[0].purchase_fired, true);
    assert.equal(assertion.evidence.receipts[0].via, source);
    assert.deepEqual(assertion.evidence.receipts[0].signals, {
      dataLayer: source === "datalayer",
      meta: source === "meta",
      ga4: source === "ga4",
    });
  });
}

test("a reached canonical receipt with no effective Purchase remains a blocker", () => {
  const assertion = assess([receiptAttempt({ source: null })]);
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER);
  assert.equal(computeDisposition([assertion]), "blocked");
});

test("a measured zero-signal receipt and an unmeasured one are both blockers but distinguishable", () => {
  const measuredZero = assess([receiptAttempt({ source: null })]).evidence.receipts[0];
  const unmeasured = assess([receiptAttempt({ captureError: "analytics binding detached" })]).evidence.receipts[0];

  // Both read purchase_fired:false — that is the trap #198 was made of.
  assert.equal(measuredZero.purchase_fired, false);
  assert.equal(unmeasured.purchase_fired, false);

  // `measured` is what separates "we looked and saw nothing" from "we could
  // not look", without the reader having to consult capture_error_plan_ids.
  assert.equal(measuredZero.measured, true);
  assert.deepEqual(measuredZero.signals, { dataLayer: false, meta: false, ga4: false });
  assert.equal(unmeasured.measured, false);
  assert.equal(unmeasured.signals, null);
});

test("multi-plan aggregation is fail-first, then unqualified warning, and passes only when every plan qualifies", () => {
  const passA = receiptAttempt({ planId: "accept", source: "datalayer" });
  const passB = receiptAttempt({ planId: "decline", source: "meta" });
  const fail = receiptAttempt({ planId: "decline", source: null });
  const unqualified = receiptAttempt({ planId: "decline", receiptRecognized: false, source: "ga4", receiptUrl: "https://shop.example/campaign/upsell/" });

  assert.equal(assess([passA, passB]).status, STATUS.PASS);
  assert.equal(assess([passA, fail]).status, STATUS.FAIL, "PASS + FAIL blocks");
  const warning = assess([passA, unqualified]);
  assert.equal(warning.status, STATUS.MANUAL_REVIEW, "PASS + unqualified warns");
  assert.equal(warning.severity, SEVERITY.WARN);
  assert.deepEqual(warning.evidence.unqualified_plan_ids, ["decline"]);
});

test("missing planned attempt and no typed-card order are manual review, never false failure", () => {
  const missing = assess([receiptAttempt({ planId: "accept" })], ["accept", "decline"]);
  assert.equal(missing.status, STATUS.MANUAL_REVIEW);
  assert.deepEqual(missing.evidence.unqualified_plan_ids, ["decline"]);

  const none = assess([], []);
  assert.equal(none.status, STATUS.MANUAL_REVIEW);
  assert.equal(none.severity, SEVERITY.WARN);
  assert.deepEqual(none.evidence.attempted_plan_ids, []);
});

test("capture errors block explicitly and are never converted into a fake zero-signal receipt", () => {
  const assertion = assess([receiptAttempt({ captureError: "analytics binding detached" })]);
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER);
  assert.deepEqual(assertion.evidence.capture_error_plan_ids, [PLAN]);
  assert.equal(assertion.evidence.receipts[0].purchase_fired, false);
  // An unmeasured receipt must not read as a measured zero-signal receipt.
  assert.equal(assertion.evidence.receipts[0].measured, false);
  assert.equal(assertion.evidence.receipts[0].signals, null);
  assert.equal(assertion.evidence.receipts[0].via, null);
  assert.ok(!("capture" in assertion.evidence));
});

test("typed receipt capture waits the configured settle window and includes a delayed final-document Purchase", async () => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  let now = 1_000;
  let settled = false;
  const captureHandle = {
    async collectScopes({ strict }) {
      assert.equal(strict, true);
      const scoped = settled ? capture("ga4") : normalizeCapture();
      return { journey: scoped, currentDocument: scoped };
    },
  };

  const result = await collectOrderAnalytics({
    captureHandle,
    receiptRecognized: true,
    settleMs: 5_000,
    deadline: 7_000,
    now: () => now,
    wait: async (ms) => {
      assert.equal(ms, 5_000);
      now += ms;
      settled = true;
    },
  });

  assert.equal(effectivePurchase(result.receiptCapture).via, "ga4");
  assert.equal(effectivePurchase(result.journeyCapture).via, "ga4");
  assert.equal(result.receiptCaptureError, undefined);
});

test("typed receipt capture reports explicit settle exhaustion when the full window does not fit the order deadline", async () => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  let waited = false;
  const empty = normalizeCapture();
  const result = await collectOrderAnalytics({
    captureHandle: { async collectScopes() { return { journey: empty, currentDocument: empty }; } },
    receiptRecognized: true,
    settleMs: 5_000,
    deadline: 5_999,
    now: () => 1_000,
    wait: async () => { waited = true; },
  });

  assert.equal(waited, false, "a partial settle is not mistaken for the configured settle window");
  assert.deepEqual(result.receiptCaptureError, {
    code: "analytics_settle_deadline_exhausted",
    message: "analytics settle window exceeded the typed-order deadline",
  });
  const assertion = assess([{
    planId: PLAN,
    receiptRecognized: true,
    receiptUrl: "https://shop.example/receipt/",
    captureError: result.receiptCaptureError,
  }], [PLAN], {
    [WAIVABLE]: { reason: "accepted gap", waived_by: "human@example.test" },
  });
  assert.equal(assertion.status, STATUS.FAIL);
  assert.equal(assertion.severity, SEVERITY.BLOCKER, "settle exhaustion is non-waivable");
  assert.equal(assertion.waiver, undefined);
});

test("capture completion after the order deadline is discarded as an explicit collection error", async () => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  let now = 1_000;
  const empty = normalizeCapture();
  const result = await collectOrderAnalytics({
    captureHandle: {
      async collectScopes() {
        now = 2_001;
        return { journey: empty, currentDocument: empty };
      },
    },
    receiptRecognized: true,
    settleMs: 0,
    deadline: 2_000,
    now: () => now,
    wait: async () => {},
  });

  assert.equal(result.journeyCapture, undefined);
  assert.equal(result.receiptCapture, undefined);
  assert.deepEqual(result.journeyCaptureError, {
    code: "analytics_capture_collection_deadline_exhausted",
    message: "analytics capture collection exceeded the typed-order deadline",
  });
  assert.deepEqual(result.receiptCaptureError, result.journeyCaptureError);
});

test("a never-resolving capture collection is bounded by the remaining order deadline", { timeout: 1_000 }, async (t) => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let collectionStarted;
  const started = new Promise((resolve) => { collectionStarted = resolve; });
  let completed = false;
  const pending = collectOrderAnalytics({
    captureHandle: { collectScopes: async () => { collectionStarted(); return new Promise(() => {}); } },
    receiptRecognized: true,
    settleMs: 0,
    deadline: Date.now() + 20,
    wait: async () => {},
  }).then((result) => { completed = true; return result; });

  // Enter collection before advancing the clock: CPU contention must not
  // consume the deadline in the preceding settle phase instead.
  await started;
  t.mock.timers.tick(19);
  await Promise.resolve();
  assert.equal(completed, false, "collection remains pending before the deadline");
  t.mock.timers.tick(1);
  const result = await pending;
  assert.deepEqual(result.journeyCaptureError, {
    code: "analytics_capture_collection_deadline_exhausted",
    message: "analytics capture collection exceeded the typed-order deadline",
  });
  assert.deepEqual(result.receiptCaptureError, result.journeyCaptureError);
});

test("a never-resolving settle wait is bounded by the remaining order deadline", { timeout: 1_000 }, async (t) => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let collected = false;
  let settleStarted;
  const started = new Promise((resolve) => { settleStarted = resolve; });
  const pending = collectOrderAnalytics({
    captureHandle: {
      async collectScopes() {
        collected = true;
        return { journey: normalizeCapture(), currentDocument: normalizeCapture() };
      },
    },
    receiptRecognized: true,
    settleMs: 1,
    deadline: Date.now() + 20,
    wait: async () => { settleStarted(); return new Promise(() => {}); },
  });

  await started;
  t.mock.timers.tick(20);
  const result = await pending;
  assert.equal(collected, false, "collection never starts after settle consumes the deadline");
  assert.deepEqual(result.receiptCaptureError, {
    code: "analytics_settle_deadline_exhausted",
    message: "analytics settle window exceeded the typed-order deadline",
  });
  assert.deepEqual(result.journeyCaptureError, {
    code: "analytics_capture_collection_deadline_exhausted",
    message: "analytics capture collection exceeded the typed-order deadline",
  });
});

test("waiver applies only to a genuine recognized-receipt no-signal failure", () => {
  const waivers = { [WAIVABLE]: { reason: "accepted gap", waived_by: "human@example.test", waived_at: "2026-08-20T00:00:00.000Z" } };
  const waived = assess([receiptAttempt({ source: null })], [PLAN], waivers);
  assert.equal(waived.status, STATUS.FAIL);
  assert.equal(waived.severity, SEVERITY.WARN);
  assert.equal(waived.waiver.waived_by, "human@example.test");

  const noReceipt = assess([receiptAttempt({ receiptRecognized: false, source: null })], [PLAN], waivers);
  assert.equal(noReceipt.status, STATUS.MANUAL_REVIEW);
  assert.equal(noReceipt.waiver, undefined);

  const unrecognizedCaptureError = assess([
    receiptAttempt({ receiptRecognized: false, captureError: "page became unreadable" }),
  ], [PLAN], waivers);
  assert.equal(unrecognizedCaptureError.status, STATUS.MANUAL_REVIEW,
    "capture failures only block after canonical receipt qualification");
  assert.deepEqual(unrecognizedCaptureError.evidence.capture_error_plan_ids, []);
  assert.equal(unrecognizedCaptureError.waiver, undefined);

  const captureFailure = assess([receiptAttempt({ captureError: "capture failed" })], [PLAN], waivers);
  assert.equal(captureFailure.severity, SEVERITY.BLOCKER);
  assert.equal(captureFailure.waiver, undefined);

  const passing = assess([receiptAttempt({ source: "ga4" })], [PLAN], waivers);
  assert.equal(passing.status, STATUS.PASS);
  assert.equal(passing.waiver, undefined);
});

test("receipt verdict evidence redacts query/order data and exposes only the fixed safe projection", () => {
  const assertion = assess([receiptAttempt({ source: "datalayer" })]);
  assert.deepEqual(Object.keys(assertion.evidence).sort(), [
    "attempted_plan_ids",
    "capture_error_plan_ids",
    "receipts",
    "unqualified_plan_ids",
  ]);
  assert.deepEqual(Object.keys(assertion.evidence.receipts[0]).sort(), [
    "fired_on",
    "measured",
    "plan_id",
    "purchase_fired",
    "receipt_signals",
    "receipt_url",
    "scope",
    "signals",
    "via",
  ]);
  assert.equal(assertion.evidence.receipts[0].measured, true);
  assert.equal(assertion.evidence.receipts[0].receipt_url, "https://shop.example/campaign/receipt/");
  assert.equal(assertion.expected, "every deterministic receipt-qualified typed-card order emits Purchase via dataLayer, Meta, or GA4 on some page of its post-checkout journey.");
  const serialized = JSON.stringify(assertion);
  assert.doesNotMatch(serialized, /ref_id|utm_source|order-secret|txn-secret|149\.99|USD|pixel-secret|G-SECRET/);
});

// #392: the SDK fires dl_purchase (and the outbound Purchase) on the first
// `?ref_id=` page that fetched the order — the upsell page on a funnel that
// has one — and dedupes it on the receipt. The receipt attempt therefore
// carries the journey reading beside the receipt-document reading, and
// purchase-fires judges the journey. The receipt reading stays as the
// diagnostic that says which document fired.
test("browser private envelope: a recognized receipt carries the journey reading beside the receipt document, and purchase-fires judges the journey (#392)", () => {
  const { journeyAnalyticsAttempt, receiptAnalyticsAttempt, stampTestOrderPlan } = __qaBrowserTestHooks;
  const topology = {
    funnel_id: "fixture",
    pages: [
      { page_id: "checkout", page_type: "checkout", url: "https://shop.example/checkout/", expected_next_url: "https://shop.example/upsell/" },
      { page_id: "upsell", page_type: "upsell", url: "https://shop.example/upsell/", accept_url: "https://shop.example/receipt/", decline_url: "https://shop.example/receipt/" },
      { page_id: "receipt", page_type: "receipt", url: "https://shop.example/receipt/" },
    ],
  };
  const plan = { path: "accept", topology_plan: resolveTestOrderTopology(topology) };
  const result = stampTestOrderPlan({
    order: { final_url: "https://shop.example/receipt/?ref_id=secret" },
    analytics_journey_capture: capture("datalayer", true),
    receipt_analytics_capture: normalizeCapture(),
  }, plan);

  assert.equal(result.order.plan_id, "accept", "non-tier/operator plans are stamped too");
  const attempt = receiptAnalyticsAttempt(plan, result);
  const journeyAttempt = journeyAnalyticsAttempt(plan, result);
  assert.equal(attempt.planId, "accept");
  assert.equal(attempt.receiptRecognized, true);
  assert.equal(attempt.receiptUrl, "https://shop.example/receipt/");
  assert.equal(effectivePurchase(attempt.capture).fired, false, "the receipt document itself is silent after the SDK dedupe");
  assert.equal(effectivePurchase(attempt.journeyCapture).fired, true, "the journey reading carries the upsell-page Purchase");
  assert.equal(effectivePurchase(journeyAttempt.capture).fired, true, "parity retains the same journey reading");

  const assertion = assess([attempt], ["accept"]);
  assert.equal(assertion.status, STATUS.PASS, "a Purchase fired on the upsell page satisfies the receipt-qualified order");
  assert.deepEqual(assertion.evidence.receipts[0], {
    plan_id: "accept",
    receipt_url: "https://shop.example/receipt/",
    measured: true,
    scope: "journey",
    purchase_fired: true,
    via: "datalayer",
    signals: { dataLayer: true, meta: false, ga4: false },
    receipt_signals: { dataLayer: false, meta: false, ga4: false },
    fired_on: "earlier-page",
  });
  assert.doesNotMatch(JSON.stringify(assertion), /ref_id|secret|txn-|149\.99|USD/);

  const deceptive = receiptAnalyticsAttempt(plan, {
    order: { final_url: "https://shop.example/not-a-terminal/thank-you-looking-name/?ref_id=secret" },
    analytics_journey_capture: capture("ga4"),
  });
  assert.equal(deceptive.receiptRecognized, false, "URL wording cannot bypass terminalAtUrl");
  assert.equal(deceptive.receiptUrl, "https://shop.example/not-a-terminal/thank-you-looking-name/");
  assert.equal(deceptive.capture, undefined, "unrecognized traversal evidence never enters receipt correctness");
  assert.equal(deceptive.journeyCapture, undefined, "the journey reading does not cross an unrecognized terminal either");

  // The envelope the browser ships when the journey collection failed while
  // the receipt document was read: the error travels as journeyCaptureError,
  // no journey capture is invented, and the verdict reads it as unmeasured
  // rather than falling back to the silent receipt document.
  const journeyFailed = receiptAnalyticsAttempt(plan, stampTestOrderPlan({
    order: { final_url: "https://shop.example/receipt/?ref_id=secret" },
    analytics_journey_capture_error: { code: "analytics_capture_unreadable", detail: "secret-detail" },
    receipt_analytics_capture: normalizeCapture(),
  }, plan));
  assert.equal(journeyFailed.receiptRecognized, true);
  assert.equal(journeyFailed.journeyCapture, undefined);
  assert.equal(journeyFailed.journeyCaptureError.code, "analytics_capture_unreadable", "projected to the stable error, detail dropped");
  assert.ok(effectivePurchase(journeyFailed.capture).fired === false, "the receipt document is still carried");
  const unmeasured = assess([journeyFailed], ["accept"]);
  assert.equal(unmeasured.status, STATUS.FAIL);
  assert.deepEqual(unmeasured.evidence.capture_error_plan_ids, ["accept"]);
  assert.equal(unmeasured.evidence.receipts[0].measured, false);
  assert.equal(unmeasured.evidence.receipts[0].scope, null);
  assert.doesNotMatch(JSON.stringify(unmeasured), /secret-detail/);
  assert.equal(journeyAnalyticsAttempt(plan, {
    order: { final_url: "https://shop.example/not-a-terminal/" },
    analytics_journey_capture: capture("ga4"),
  }).capture.purchaseSignals.ga4, true, "the same unrecognized traversal remains available to parity");
});
