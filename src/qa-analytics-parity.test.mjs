import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTagFire,
  diffAnalyticsParity,
  extractPurchase,
  normalizeCapture,
} from "./qa-analytics-parity.mjs";
import { SEVERITY, STATUS } from "./qa-verdict.mjs";

const byId = (assertions) => Object.fromEntries(assertions.map((a) => [a.id, a]));

test("classifyTagFire identifies provider + id from runtime tag URLs", () => {
  assert.equal(classifyTagFire("https://www.googletagmanager.com/gtm.js?id=GTM-ABC123").kind, "gtm");
  assert.equal(classifyTagFire("https://www.googletagmanager.com/gtm.js?id=GTM-ABC123").id, "GTM-ABC123");
  assert.equal(classifyTagFire("https://www.googletagmanager.com/gtag/js?id=G-XYZ").kind, "ga4");
  assert.equal(classifyTagFire("https://www.googletagmanager.com/gtag/js?id=AW-999").kind, "google_ads");
  assert.equal(classifyTagFire("https://www.google-analytics.com/g/collect?tid=G-XYZ").id, "G-XYZ");

  const meta = classifyTagFire("https://www.facebook.com/tr?id=998877&ev=Purchase&eid=1043");
  assert.equal(meta.kind, "meta");
  assert.equal(meta.id, "998877");
  assert.equal(meta.params.eid, "1043");

  assert.equal(classifyTagFire("https://analytics.tiktok.com/api/v2/pixel?sdkid=TT1").kind, "tiktok");
  assert.equal(classifyTagFire("https://offers.everflow.io/postback?id=5").kind, "everflow", "everflow matched by host substring");
  assert.equal(classifyTagFire("https://example-merchant.com/thank-you"), null, "non-analytics host is ignored");
  assert.equal(classifyTagFire("not-a-url"), null);
});

test("extractPurchase reads SDK and legacy purchase shapes", () => {
  const sdk = extractPurchase({
    event: "dl_purchase",
    ecommerce: { value: 49.99, currency: "USD", transaction_id: "1043" },
  });
  assert.deepEqual(sdk, { value: 49.99, currency: "USD", transactionId: "1043" });

  const legacy = extractPurchase({ event: "purchase", value: "49.99", currency: "USD", order_id: 1043 });
  assert.deepEqual(legacy, { value: 49.99, currency: "USD", transactionId: "1043" });

  assert.equal(extractPurchase({ event: "dl_add_to_cart" }), null);
  assert.equal(extractPurchase(null), null);
});

test("normalizeCapture dedupes events, builds inventory + Meta dedup key", () => {
  const cap = normalizeCapture({
    events: [
      { layer: "dataLayer", data: { event: "dl_view_item" } },
      { layer: "dataLayer", data: { event: "dl_purchase", ecommerce: { value: 49.99, currency: "USD", transaction_id: "1043" } } },
      // GTMAdapter mirrors the same purchase to ElevarDataLayer — must not double-count.
      { layer: "ElevarDataLayer", data: { event: "dl_purchase", ecommerce: { value: 49.99, currency: "USD", transaction_id: "1043" } } },
    ],
    tagFires: [
      { kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} },
      { kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} },
      { kind: "meta", id: "998877", host: "facebook.com", params: { ev: "Purchase", eid: "1043" } },
    ],
  });

  assert.deepEqual(cap.eventNames, ["dl_view_item", "dl_purchase"]);
  assert.equal(cap.purchase.present, true);
  assert.equal(cap.purchase.value, 49.99);
  assert.deepEqual(cap.inventory.gtm, ["GTM-ABC123"], "deduped container id");
  assert.deepEqual(cap.inventory.meta, ["998877"]);
  assert.equal(cap.metaPurchaseEventId, "1043");
});

// The worked example from the ratified contract spec, as an executable check:
// commerce parity is green; the only exception is a dropped Everflow tag (WARN).
test("diffAnalyticsParity — worked example: green commerce gate + WARN dropped Everflow", () => {
  const baseline = {
    eventNames: ["purchase"],
    purchase: { present: true, value: 49.99, currency: "USD", transactionId: "1043" },
    inventory: { gtm: ["GTM-ABC123"], ga4: ["G-XYZ"], google_ads: [], meta: ["998877"], tiktok: [], everflow: ["ef-1"], other: [] },
    metaPurchaseEventId: "1043",
  };
  const candidate = {
    eventNames: ["dl_view_item", "dl_add_to_cart", "dl_begin_checkout", "dl_purchase"],
    purchase: { present: true, value: 49.99, currency: "USD", transactionId: "7781" },
    inventory: { gtm: ["GTM-ABC123"], ga4: ["G-XYZ"], google_ads: [], meta: ["998877"], tiktok: [], everflow: [], other: [] },
    metaPurchaseEventId: "7781",
  };

  const a = byId(diffAnalyticsParity(baseline, candidate));
  assert.equal(a["analytics-parity:purchase-present"].status, STATUS.PASS);
  assert.equal(a["analytics-parity:purchase-value"].status, STATUS.PASS, "same offer → same client value (tax excluded both sides)");
  assert.equal(a["analytics-parity:purchase-currency"].status, STATUS.PASS);
  assert.equal(a["analytics-parity:purchase-transaction-id"].status, STATUS.PASS, "presence, not equality — different orders");
  assert.equal(a["analytics-parity:capi-dedup"].status, STATUS.PASS);
  // Carried-over tags present both sides pass; the dropped Everflow tag warns.
  assert.equal(a["analytics-parity:carryover:gtm:GTM-ABC123"].status, STATUS.PASS);
  assert.equal(a["analytics-parity:carryover:everflow:ef-1"].status, STATUS.WARN);
  assert.equal(a["analytics-parity:carryover:everflow:ef-1"].severity, SEVERITY.WARN);
});

test("diffAnalyticsParity — missing candidate purchase is a BLOCKER", () => {
  const baseline = { eventNames: ["purchase"], purchase: { present: true, value: 49.99, currency: "USD", transactionId: "1" }, inventory: {} };
  const candidate = { eventNames: ["dl_view_item"], purchase: { present: false }, inventory: {} };
  const a = byId(diffAnalyticsParity(baseline, candidate));
  assert.equal(a["analytics-parity:purchase-present"].status, STATUS.FAIL);
  assert.equal(a["analytics-parity:purchase-present"].severity, SEVERITY.BLOCKER);
});

test("diffAnalyticsParity — value mismatch and missing eventID block cutover", () => {
  const baseline = {
    purchase: { present: true, value: 49.99, currency: "USD", transactionId: "1" },
    inventory: { meta: ["998877"] },
    metaPurchaseEventId: "1",
  };
  const candidate = {
    purchase: { present: true, value: 39.99, currency: "USD", transactionId: "2" },
    inventory: { meta: ["998877"] },
    metaPurchaseEventId: null,
  };
  const a = byId(diffAnalyticsParity(baseline, candidate));
  assert.equal(a["analytics-parity:purchase-value"].status, STATUS.FAIL);
  assert.equal(a["analytics-parity:purchase-value"].severity, SEVERITY.BLOCKER);
  assert.equal(a["analytics-parity:capi-dedup"].status, STATUS.FAIL, "no eventID on candidate Meta Purchase");
  assert.equal(a["analytics-parity:capi-dedup"].severity, SEVERITY.BLOCKER);
});

test("diffAnalyticsParity — source-aware: candidate blocks dl_purchase but fires Meta Purchase → present passes", () => {
  const baseline = {
    eventNames: ["purchase"],
    purchase: { present: true, value: 49.99, currency: "USD", transactionId: "1" },
    inventory: { meta: ["998877"] },
    metaPurchaseEventId: "1",
    purchaseSignals: { dataLayer: true, meta: true, ga4: false },
  };
  // Candidate: no dataLayer purchase, but Meta Purchase fired (blockedEvents pattern).
  const candidate = {
    eventNames: ["dl_add_to_cart"],
    purchase: { present: false },
    inventory: { meta: ["998877"] },
    metaPurchaseEventId: "7781",
    purchaseSignals: { dataLayer: false, meta: true, ga4: false },
  };
  const a = byId(diffAnalyticsParity(baseline, candidate));
  assert.equal(a["analytics-parity:purchase-present"].status, STATUS.PASS, "Meta Purchase counts — no false-fail on a blocked SDK event");
  assert.equal(a["analytics-parity:purchase-present"].evidence.via, "meta");
  // Value can't be compared (pixel-only) → manual review, not a blocker fail.
  assert.equal(a["analytics-parity:purchase-value"].status, STATUS.MANUAL_REVIEW);
  // CAPI dedup still checked from the Meta fire.
  assert.equal(a["analytics-parity:capi-dedup"].status, STATUS.PASS);
});

test("diffAnalyticsParity — no baseline value falls back to manual review, not a false block", () => {
  const baseline = { purchase: { present: true, value: null, currency: null, transactionId: null }, inventory: {} };
  const candidate = { purchase: { present: true, value: 49.99, currency: "USD", transactionId: "2" }, inventory: {} };
  const a = byId(diffAnalyticsParity(baseline, candidate));
  assert.equal(a["analytics-parity:purchase-value"].status, STATUS.MANUAL_REVIEW);
  assert.equal(a["analytics-parity:purchase-value"].severity, SEVERITY.WARN);
});
