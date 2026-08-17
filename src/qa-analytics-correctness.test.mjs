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

test("forcedAnalyticsCorrectness: tri-state — absent is undefined (not false) and does not throw (NEXT-114, packet 04 Stage A)", async () => {
  const { forcedAnalyticsCorrectness } = await import("./qa-node.mjs");
  assert.equal(forcedAnalyticsCorrectness({}), undefined);
  assert.equal(forcedAnalyticsCorrectness({ "analytics-correctness": undefined }), undefined);
  assert.equal(forcedAnalyticsCorrectness({ "analytics-correctness": null }), undefined);
  assert.equal(forcedAnalyticsCorrectness({ "analytics-correctness": "true" }), true);
  assert.equal(forcedAnalyticsCorrectness({ "analytics-correctness": true }), true);
  assert.equal(forcedAnalyticsCorrectness({ "analytics-correctness": "false" }), false);
  assert.throws(() => forcedAnalyticsCorrectness({ "analytics-correctness": "maybe" }), /must be true or false/);
});

// Packet 04 Stage A / IC-2 — the three behavioral proofs for the tri-state
// dispatch. The leg's dispatch is analyticsCorrectnessLegDecision(forced,
// analyticsContract): "run" appends the leg's assertions, "disabled" appends
// exactly one visible SKIPPED marker, "not-applicable" appends nothing.
test("Stage A proof 1: analytics-declaring spec + --analytics-correctness false → leg disabled, one visible skipped marker, zero gating analytics assertions", async () => {
  const { __qaNodeTestHooks, forcedAnalyticsCorrectness } = await import("./qa-node.mjs");
  const { analyticsCorrectnessLegDecision, analyticsCorrectnessDisabledAssertion } = __qaNodeTestHooks;
  const contract = { providers: { gtm: { enabled: true, containerId: "GTM-ABC123" } } };

  const forced = forcedAnalyticsCorrectness({ "analytics-correctness": "false" });
  assert.equal(analyticsCorrectnessLegDecision(forced, contract), "disabled",
    "explicit false must skip the leg EVEN when the spec declares an analytics block");

  // The skip is visible, not silent — the run's only analytics-correctness
  // assertion is the SKIPPED marker, and it gates nothing.
  const marker = analyticsCorrectnessDisabledAssertion(contract);
  assert.equal(marker.family, "analytics-correctness");
  assert.equal(marker.id, "analytics-correctness:disabled-by-flag");
  assert.equal(marker.status, STATUS.SKIPPED);
  assert.equal(marker.evidence.spec_declares_analytics, true);
  assert.ok(!marker.severity, "skip marker carries no severity");
  assert.equal(computeDisposition([marker]), "ready", "the marker is disposition-neutral");
});

test("Stage A proof 2: no analytics block + --analytics-correctness true → the leg runs (forced)", async () => {
  const { __qaNodeTestHooks, forcedAnalyticsCorrectness } = await import("./qa-node.mjs");
  const { analyticsCorrectnessLegDecision } = __qaNodeTestHooks;
  const forced = forcedAnalyticsCorrectness({ "analytics-correctness": "true" });
  assert.equal(analyticsCorrectnessLegDecision(forced, undefined), "run");
});

test("Stage A proof 3 (negative control): analytics-declaring spec, flag absent → the leg still runs", async () => {
  const { __qaNodeTestHooks, forcedAnalyticsCorrectness } = await import("./qa-node.mjs");
  const { analyticsCorrectnessLegDecision } = __qaNodeTestHooks;
  const contract = { providers: { gtm: { enabled: true, containerId: "GTM-ABC123" } } };
  const forced = forcedAnalyticsCorrectness({});
  assert.equal(analyticsCorrectnessLegDecision(forced, contract), "run",
    "default invocation on an analytics-declaring spec must keep today's behavior — the fix must not become a global disable");
  // And with neither flag nor block, nothing runs and nothing is emitted.
  assert.equal(analyticsCorrectnessLegDecision(forced, undefined), "not-applicable");
});
