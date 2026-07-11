import test from "node:test";
import assert from "node:assert/strict";

import { assessAnalyticsCorrectness } from "./qa-analytics-correctness.mjs";
import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const byId = (assertions) => Object.fromEntries(assertions.map((a) => [a.id, a]));

// A capture where the SDK dl_* events are present and GTM + Meta fire, incl. a
// Meta Purchase with eventID.
function fullCapture() {
  return normalizeCapture({
    events: [
      { layer: "dataLayer", data: { event: "dl_purchase", ecommerce: { value: 49.99, currency: "USD", transaction_id: "1043" } } },
    ],
    tagFires: [
      { kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} },
      { kind: "meta", id: "998877", host: "facebook.com", params: { ev: "Purchase", eid: "1043" } },
      { kind: "everflow", id: "ef-1", host: "offers.everflow.io", params: {} },
    ],
  });
}

test("no declared contract → non-gating manual_review only (nothing blocks)", () => {
  const a = assessAnalyticsCorrectness(fullCapture(), {});
  assert.equal(a.length, 1);
  assert.equal(a[0].id, "analytics-correctness:no-contract");
  assert.equal(a[0].severity, SEVERITY.INFO);
  // Nothing gating.
  assert.ok(!a.some((x) => x.severity === SEVERITY.BLOCKER));
});

test("declared analytics contract lifts missing GTM and purchase from INFO to blockers", () => {
  const sameCapture = normalizeCapture({ events: [], tagFires: [] });
  const declaredContract = {
    mode: "auto",
    providers: {
      gtm: { enabled: true, containerId: "GTM-DECLARED123" },
    },
    manual_events: [
      { event: "dl_purchase", page: "upsell-1", trigger: "page-load" },
    ],
  };

  const withoutContract = assessAnalyticsCorrectness(sameCapture, {});
  assert.deepEqual(withoutContract.map(({ id, status, severity }) => ({ id, status, severity })), [{
    id: "analytics-correctness:no-contract",
    status: STATUS.MANUAL_REVIEW,
    severity: SEVERITY.INFO,
  }]);
  assert.equal(computeDisposition(withoutContract), "ready_with_exceptions");

  const withContract = assessAnalyticsCorrectness(sameCapture, declaredContract);
  assert.deepEqual(withContract.map(({ id, status, severity }) => ({ id, status, severity })), [
    { id: "analytics-correctness:tag:gtm", status: STATUS.FAIL, severity: SEVERITY.BLOCKER },
    { id: "analytics-correctness:purchase-fires", status: STATUS.FAIL, severity: SEVERITY.BLOCKER },
  ]);
  assert.equal(computeDisposition(withContract), "blocked");
});

test("declared tags + purchase all present → all pass", () => {
  const contract = {
    providers: { gtm: { enabled: true, containerId: "GTM-ABC123" }, facebook: { enabled: true, pixelId: "998877" } },
    out_of_band_pixels: [{ vendor: "everflow", id: "ef-1" }],
  };
  const a = byId(assessAnalyticsCorrectness(fullCapture(), contract));
  assert.equal(a["analytics-correctness:tag:gtm"].status, STATUS.PASS);
  assert.equal(a["analytics-correctness:tag:meta"].status, STATUS.PASS);
  assert.equal(a["analytics-correctness:oob:everflow"].status, STATUS.PASS);
  assert.equal(a["analytics-correctness:purchase-fires"].status, STATUS.PASS);
});

test("declared GTM container absent → blocker fail", () => {
  const contract = { providers: { gtm: { enabled: true, containerId: "GTM-MISSING" } } };
  const a = byId(assessAnalyticsCorrectness(fullCapture(), contract));
  assert.equal(a["analytics-correctness:tag:gtm"].status, STATUS.FAIL);
  assert.equal(a["analytics-correctness:tag:gtm"].severity, SEVERITY.BLOCKER);
});

test("source-aware: dl_purchase blocked but Meta Purchase fires → purchase passes", () => {
  // No dataLayer purchase event; only the Meta pixel Purchase fire (the
  // blockedEvents + manual-fire pattern).
  const capture = normalizeCapture({
    events: [{ layer: "dataLayer", data: { event: "dl_add_to_cart" } }],
    tagFires: [
      { kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} },
      { kind: "meta", id: "998877", host: "facebook.com", params: { ev: "Purchase", eid: "1043" } },
    ],
  });
  const contract = { providers: { facebook: { enabled: true, pixelId: "998877", blockedEvents: ["dl_purchase"] } } };
  const a = byId(assessAnalyticsCorrectness(capture, contract));
  assert.equal(a["analytics-correctness:purchase-fires"].status, STATUS.PASS, "Meta Purchase counts as a purchase fire");
  assert.equal(a["analytics-correctness:purchase-fires"].evidence.via, "meta");
});

test("no purchase fire from any source → blocker fail", () => {
  const capture = normalizeCapture({
    events: [{ layer: "dataLayer", data: { event: "dl_add_to_cart" } }],
    tagFires: [{ kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} }],
  });
  const a = byId(assessAnalyticsCorrectness(capture, { providers: { gtm: { enabled: true, containerId: "GTM-ABC123" } } }));
  assert.equal(a["analytics-correctness:purchase-fires"].status, STATUS.FAIL);
  assert.equal(a["analytics-correctness:purchase-fires"].severity, SEVERITY.BLOCKER);
});

test("unknown out-of-band vendor → manual review, not a false fail", () => {
  const contract = { out_of_band_pixels: [{ vendor: "triplepixel" }] };
  const a = byId(assessAnalyticsCorrectness(fullCapture(), contract));
  assert.equal(a["analytics-correctness:oob:triplepixel"].status, STATUS.MANUAL_REVIEW);
  assert.equal(a["analytics-correctness:oob:triplepixel"].severity, SEVERITY.WARN);
});
