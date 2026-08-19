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

test("a never-resolving capture collection is bounded by the remaining order deadline", { timeout: 250 }, async () => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  const startedAt = Date.now();
  const result = await collectOrderAnalytics({
    captureHandle: { collectScopes: async () => new Promise(() => {}) },
    receiptRecognized: true,
    settleMs: 0,
    deadline: Date.now() + 20,
  });

  assert.ok(Date.now() - startedAt < 200, "collection returns control to QA near the order deadline");
  assert.deepEqual(result.journeyCaptureError, {
    code: "analytics_capture_collection_deadline_exhausted",
    message: "analytics capture collection exceeded the typed-order deadline",
  });
  assert.deepEqual(result.receiptCaptureError, result.journeyCaptureError);
});

test("a never-resolving settle wait is bounded by the remaining order deadline", { timeout: 250 }, async () => {
  const { collectOrderAnalytics } = __qaBrowserTestHooks;
  let collected = false;
  const startedAt = Date.now();
  const result = await collectOrderAnalytics({
    captureHandle: {
      async collectScopes() {
        collected = true;
        return { journey: normalizeCapture(), currentDocument: normalizeCapture() };
      },
    },
    receiptRecognized: true,
    settleMs: 1,
    deadline: Date.now() + 20,
    wait: async () => new Promise(() => {}),
  });

  assert.ok(Date.now() - startedAt < 200, "settle returns control to QA near the order deadline");
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
    "plan_id",
    "purchase_fired",
    "receipt_url",
    "signals",
    "via",
  ]);
  assert.equal(assertion.evidence.receipts[0].receipt_url, "https://shop.example/campaign/receipt/");
  assert.equal(assertion.expected, "every deterministic receipt-qualified typed-card order emits Purchase via dataLayer, Meta, or GA4.");
  const serialized = JSON.stringify(assertion);
  assert.doesNotMatch(serialized, /ref_id|utm_source|order-secret|txn-secret|149\.99|USD|pixel-secret|G-SECRET/);
});

test("browser private envelopes keep journey parity separate from receipt-scoped correctness", () => {
  const { journeyAnalyticsAttempt, receiptAnalyticsAttempt, stampTestOrderPlan } = __qaBrowserTestHooks;
  const topology = {
    funnel_id: "fixture",
    pages: [
      { page_id: "checkout", page_type: "checkout", url: "https://shop.example/checkout/", expected_next_url: "https://shop.example/receipt/" },
      { page_id: "receipt", page_type: "receipt", url: "https://shop.example/receipt/" },
    ],
  };
  const plan = { path: "checkout", topology_plan: resolveTestOrderTopology(topology) };
  const result = stampTestOrderPlan({
    order: { final_url: "https://shop.example/receipt/?ref_id=secret" },
    analytics_journey_capture: capture("datalayer", true),
    receipt_analytics_capture: normalizeCapture(),
  }, plan);

  assert.equal(result.order.plan_id, "checkout", "non-tier/operator plans are stamped too");
  const attempt = receiptAnalyticsAttempt(plan, result);
  const journeyAttempt = journeyAnalyticsAttempt(plan, result);
  assert.equal(attempt.planId, "checkout");
  assert.equal(attempt.receiptRecognized, true);
  assert.equal(attempt.receiptUrl, "https://shop.example/receipt/");
  assert.equal(effectivePurchase(attempt.capture).fired, false, "receipt correctness sees only the silent receipt document");
  assert.equal(effectivePurchase(journeyAttempt.capture).fired, true, "parity retains the earlier checkout Purchase");
  assert.equal(assess([attempt], ["checkout"]).status, STATUS.FAIL, "an earlier Purchase cannot false-pass a silent receipt");

  const deceptive = receiptAnalyticsAttempt(plan, {
    order: { final_url: "https://shop.example/not-a-terminal/thank-you-looking-name/?ref_id=secret" },
    analytics_journey_capture: capture("ga4"),
  });
  assert.equal(deceptive.receiptRecognized, false, "URL wording cannot bypass terminalAtUrl");
  assert.equal(deceptive.receiptUrl, "https://shop.example/not-a-terminal/thank-you-looking-name/");
  assert.equal(deceptive.capture, undefined, "unrecognized traversal evidence never enters receipt correctness");
  assert.equal(journeyAnalyticsAttempt(plan, {
    order: { final_url: "https://shop.example/not-a-terminal/" },
    analytics_journey_capture: capture("ga4"),
  }).capture.purchaseSignals.ga4, true, "the same unrecognized traversal remains available to parity");
});
