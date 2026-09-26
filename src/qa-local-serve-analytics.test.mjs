// #483: under deploy.target local-serve the build renders the development
// environment, which gates every vendor loader out. Fire-dependent
// analytics-correctness checks are manual review there, not blockers; the same
// campaign QA'd as a production render keeps them as blockers.

import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";
import { assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const { runAnalyticsOrderSequence, resolveLocalServeAnalytics } = __qaNodeTestHooks;
const { analyticsCorrectnessCaptureAssertions } = __qaBrowserTestHooks;

const PIXEL_ID = "1000000000000001";
const CONTRACT = {
  providers: { facebook: { enabled: true, pixelId: PIXEL_ID } },
  out_of_band_pixels: [{ vendor: "tiktok", id: "FIXTURE-TT-1" }],
};
const LOCAL_URL = "http://localhost:8080/campaign/";
const PREVIEW_URL = "https://preview.example/campaign/";
const localServePacket = { deploy: { target: "local-serve", preview_url: "http://localhost:8080/" } };
const parityReport = {
  stages: { assembly: { evidence: { build_environment: "development", local_proof: { production_parity: {
    status: "pass",
    checked_at: "2026-09-26T00:00:00.000Z",
    page_count: 2,
    pages: [
      { route: "/campaign/", gated_hosts: ["connect.facebook.net", "analytics.tiktok.com"] },
      { route: "/campaign/checkout/", gated_hosts: ["connect.facebook.net"] },
    ],
  } } } } },
};

// The real inventory assessment of a page where nothing fired (what the
// development render produces), a data-layer check that failed on the order,
// and the real receipt Purchase assessment of a recognized receipt with no
// Purchase fire.
// The real inventory leg output: the capture assertion (which records the
// page it measured, requested and final URL) followed by the declared-tag
// checks. `finalUrl` defaults to the requested URL (no redirect).
function inventoryAssertions(capture, { url, finalUrl = url, source = "campaign_root" }) {
  return analyticsCorrectnessCaptureAssertions({
    capture,
    contract: CONTRACT,
    url,
    capturePage: { url, source, http_status: 200 },
    finalUrl,
  });
}

async function runSequence({ url, localServeAnalytics, receiptAttempt = null, inventory = null }) {
  const assertions = [];
  await runAnalyticsOrderSequence({
    args: {},
    resolved: {
      spec: { analytics: CONTRACT },
      analyticsCaptureTarget: { url, source: "resolved_identity:public_route_slug" },
      qaWaivers: {},
      localServeAnalytics,
    },
    runId: "run-483",
    assertions,
  }, {
    async runInventory() {
      return inventoryAssertions(normalizeCapture({ events: [], tagFires: [] }), { url, ...(inventory || {}) });
    },
    async runOrders({ assertions: sink }) {
      sink.push({
        id: "analytics-correctness:data-layer-purchase:accept",
        family: "analytics-correctness",
        page: "checkout:order:accept",
        status: STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: "exactly one dl_purchase",
        actual: "no dl_purchase pushed",
      });
      return {
        orders: [{ plan_id: "accept" }],
        receiptAnalytics: {
          plannedPlanIds: ["accept"],
          attempts: [receiptAttempt || { planId: "accept", receiptRecognized: true, receiptUrl: `${url}receipt/`, capture: normalizeCapture({ events: [] }) }],
        },
      };
    },
    assessReceipt: assessReceiptPurchase,
  });
  return assertions;
}

const FIRE_DEPENDENT = [
  "analytics-correctness:tag:meta",
  "analytics-correctness:oob:tiktok",
  "analytics-correctness:purchase-fires",
];
// The SDK pushes dl_purchase on the development render too, so a miss there
// still blocks on localhost.
const DATA_LAYER_PURCHASE = "analytics-correctness:data-layer-purchase:accept";

test("a local-serve run with a declared pixel that did not fire leaves only the data-layer Purchase check blocking", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  assert.ok(localServeAnalytics);
  const assertions = await runSequence({ url: LOCAL_URL, localServeAnalytics });

  for (const id of FIRE_DEPENDENT) {
    const item = assertions.find((entry) => entry.id === id);
    assert.ok(item, `${id} emitted`);
    assert.equal(item.status, STATUS.MANUAL_REVIEW, id);
    assert.equal(item.severity, SEVERITY.WARN, id);
    assert.equal(item.evidence.reason, "local_serve_development_render", id);
    assert.equal(item.evidence.local_serve_status, STATUS.FAIL, id);
    assert.deepEqual(item.evidence.build_environment, { field: "stages.assembly.evidence.build_environment", value: "development" }, id);
    assert.match(item.evidence.follow_up, /PR preview.*--base-url/, id);
    assert.match(item.actual, /--base-url/, id);
    assert.equal(item.evidence.production_parity.field, "stages.assembly.evidence.local_proof.production_parity");
    assert.equal(item.evidence.production_parity.status, "pass");
    assert.deepEqual(item.evidence.production_parity.gated_hosts, ["analytics.tiktok.com", "connect.facebook.net"]);
  }
  const dataLayer = assertions.find((entry) => entry.id === DATA_LAYER_PURCHASE);
  assert.equal(dataLayer.status, STATUS.FAIL);
  assert.equal(dataLayer.severity, SEVERITY.BLOCKER);
  assert.equal(dataLayer.evidence?.reason, undefined);
  const blockers = assertions.filter((item) => item.status === STATUS.FAIL && item.severity === SEVERITY.BLOCKER);
  assert.deepEqual(blockers.map((item) => item.id), [DATA_LAYER_PURCHASE]);
});

test("the same campaign served as a production render still blocks when the pixel does not fire", async () => {
  for (const [label, localServeAnalytics] of [
    ["deploy.target is not local-serve", resolveLocalServeAnalytics({ packet: { deploy: { target: "netlify" } }, report: parityReport, captureUrl: LOCAL_URL })],
    ["local-serve packet QA'd against the PR preview", resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: PREVIEW_URL })],
  ]) {
    assert.equal(localServeAnalytics, null, label);
    const assertions = await runSequence({ url: PREVIEW_URL, localServeAnalytics });
    for (const id of [...FIRE_DEPENDENT, DATA_LAYER_PURCHASE]) {
      const item = assertions.find((entry) => entry.id === id);
      assert.equal(item.status, STATUS.FAIL, `${label}: ${id}`);
      assert.equal(item.evidence?.reason, undefined, `${label}: ${id}`);
    }
    assert.equal(computeDisposition(assertions), "blocked", label);
  }
});

test("local-serve review leaves passing checks alone and names a missing parity record", async () => {
  const developmentOnly = { stages: { assembly: { evidence: { build_environment: "development" } } } };
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: developmentOnly, captureUrl: "http://127.0.0.1:4173/campaign/" });
  assert.deepEqual(localServeAnalytics.production_parity, {
    field: "stages.assembly.evidence.local_proof.production_parity",
    status: "not_recorded",
  });
  const assertions = [];
  await runAnalyticsOrderSequence({
    args: {},
    resolved: { spec: { analytics: CONTRACT }, analyticsCaptureTarget: { url: LOCAL_URL }, qaWaivers: {}, localServeAnalytics },
    runId: "run-483b",
    assertions,
  }, {
    async runInventory() {
      return inventoryAssertions(normalizeCapture({
        tagFires: [{ kind: "meta", id: PIXEL_ID, host: "facebook.com", params: {} }],
      }), { url: LOCAL_URL });
    },
    async runOrders() { return { orders: [], receiptAnalytics: { plannedPlanIds: [], attempts: [] } }; },
    assessReceipt: assessReceiptPurchase,
  });
  assert.equal(assertions.find((item) => item.id === "analytics-correctness:tag:meta").status, STATUS.PASS);
  const tiktok = assertions.find((item) => item.id === "analytics-correctness:oob:tiktok");
  assert.equal(tiktok.status, STATUS.MANUAL_REVIEW);
  assert.match(tiktok.evidence.production_parity_note, /No passing page-kit parity/);
});

test("a local-serve Purchase capture that failed keeps blocking: an unmeasured receipt is not a gated pixel", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  assert.ok(localServeAnalytics);
  const assertions = await runSequence({
    url: LOCAL_URL,
    localServeAnalytics,
    // Analytics settling timed out at the receipt: the receipt was recognized
    // but its capture errored, so Purchase was never measured.
    receiptAttempt: {
      planId: "accept",
      receiptRecognized: true,
      receiptUrl: `${LOCAL_URL}receipt/`,
      capture: normalizeCapture({ events: [] }),
      captureError: { kind: "settle_timeout", message: "analytics did not settle" },
    },
  });
  const purchase = assertions.find((item) => item.id === "analytics-correctness:purchase-fires");
  assert.deepEqual(purchase.evidence.capture_error_plan_ids, ["accept"]);
  assert.equal(purchase.status, STATUS.FAIL);
  assert.equal(purchase.severity, SEVERITY.BLOCKER);
  assert.equal(purchase.evidence.reason, undefined);
  // The inventory checks that genuinely did not fire are still reviewed.
  for (const id of ["analytics-correctness:tag:meta", "analytics-correctness:oob:tiktok"]) {
    assert.equal(assertions.find((item) => item.id === id).status, STATUS.MANUAL_REVIEW, id);
  }
  assert.equal(computeDisposition(assertions), "blocked");
});

test("a local-serve packet whose recorded build is not a development render keeps its blockers", async () => {
  const withEnvironment = (environment) => ({
    stages: { assembly: { evidence: {
      ...(environment === undefined ? {} : { build_environment: environment }),
      local_proof: parityReport.stages.assembly.evidence.local_proof,
    } } },
  });
  for (const [label, report] of [
    ["build_environment is production", withEnvironment("production")],
    ["build_environment is not recorded", withEnvironment(undefined)],
    ["no runtime report", null],
  ]) {
    const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report, captureUrl: LOCAL_URL });
    assert.equal(localServeAnalytics, null, label);
    const assertions = await runSequence({ url: LOCAL_URL, localServeAnalytics });
    for (const id of FIRE_DEPENDENT) {
      const item = assertions.find((entry) => entry.id === id);
      assert.equal(item.status, STATUS.FAIL, `${label}: ${id}`);
      assert.equal(item.severity, SEVERITY.BLOCKER, `${label}: ${id}`);
    }
    assert.equal(computeDisposition(assertions), "blocked", label);
  }
});

// #500: eligibility is computed from the campaign root, but the page a check
// measured can be elsewhere. Each downgrade is scoped to a page on record as
// loopback.
const REMOTE_ENTRY = "https://preview.example/campaign/checkout/";

test("a remote built-entry capture under an eligible local-serve run keeps its pixel blockers", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  assert.ok(localServeAnalytics);
  // The localhost root answered 404, so the #493 fallback captured the built
  // entry whose explicit page.url is a production preview.
  const assertions = await runSequence({
    url: REMOTE_ENTRY,
    localServeAnalytics,
    inventory: { source: "built_entry" },
    receiptAttempt: { planId: "accept", receiptRecognized: true, receiptUrl: `${LOCAL_URL}receipt/`, capture: normalizeCapture({ events: [] }) },
  });
  for (const id of ["analytics-correctness:tag:meta", "analytics-correctness:oob:tiktok"]) {
    const item = assertions.find((entry) => entry.id === id);
    assert.equal(item.status, STATUS.FAIL, id);
    assert.equal(item.severity, SEVERITY.BLOCKER, id);
    assert.equal(item.evidence.reason, undefined, id);
  }
  // The receipt was measured on localhost, so its silent Purchase is still reviewed.
  assert.equal(assertions.find((entry) => entry.id === "analytics-correctness:purchase-fires").status, STATUS.MANUAL_REVIEW);
  assert.equal(computeDisposition(assertions), "blocked");
});

test("a localhost capture that redirected to a production host keeps its pixel blockers", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  assert.ok(localServeAnalytics);
  const assertions = await runSequence({ url: LOCAL_URL, localServeAnalytics, inventory: { finalUrl: PREVIEW_URL } });
  const capture = assertions.find((entry) => entry.id === "analytics-correctness:capture");
  assert.equal(capture.evidence.final_url, PREVIEW_URL);
  for (const id of ["analytics-correctness:tag:meta", "analytics-correctness:oob:tiktok"]) {
    const item = assertions.find((entry) => entry.id === id);
    assert.equal(item.status, STATUS.FAIL, id);
    assert.equal(item.severity, SEVERITY.BLOCKER, id);
    assert.equal(item.evidence.reason, undefined, id);
  }
  assert.equal(computeDisposition(assertions), "blocked");
});

test("a local-serve capture whose final page URL was not recorded keeps its pixel blockers", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  const assertions = await runSequence({ url: LOCAL_URL, localServeAnalytics, inventory: { finalUrl: null } });
  for (const id of ["analytics-correctness:tag:meta", "analytics-correctness:oob:tiktok"]) {
    assert.equal(assertions.find((entry) => entry.id === id).status, STATUS.FAIL, id);
  }
});

test("a receipt that landed on a production host keeps the Purchase blocker under an eligible local-serve run", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  assert.ok(localServeAnalytics);
  const assertions = await runSequence({
    url: LOCAL_URL,
    localServeAnalytics,
    receiptAttempt: { planId: "accept", receiptRecognized: true, receiptUrl: `${PREVIEW_URL}receipt/`, capture: normalizeCapture({ events: [] }) },
  });
  const purchase = assertions.find((entry) => entry.id === "analytics-correctness:purchase-fires");
  assert.equal(purchase.status, STATUS.FAIL);
  assert.equal(purchase.severity, SEVERITY.BLOCKER);
  assert.equal(purchase.evidence.reason, undefined);
  // The inventory page was measured on localhost and is still reviewed.
  assert.equal(assertions.find((entry) => entry.id === "analytics-correctness:tag:meta").status, STATUS.MANUAL_REVIEW);
});

test("a loopback built-entry capture is still downgraded", async () => {
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: parityReport, captureUrl: LOCAL_URL });
  const assertions = await runSequence({
    url: `${LOCAL_URL}checkout/`,
    localServeAnalytics,
    inventory: { source: "built_entry", finalUrl: "http://127.0.0.1:8080/campaign/checkout/" },
  });
  const capture = assertions.find((entry) => entry.id === "analytics-correctness:capture");
  assert.equal(capture.evidence.final_url, "http://127.0.0.1:8080/campaign/checkout/");
  for (const id of FIRE_DEPENDENT) {
    const item = assertions.find((entry) => entry.id === id);
    assert.equal(item.status, STATUS.MANUAL_REVIEW, id);
    assert.equal(item.evidence.reason, "local_serve_development_render", id);
  }
  const blockers = assertions.filter((item) => item.status === STATUS.FAIL && item.severity === SEVERITY.BLOCKER);
  assert.deepEqual(blockers.map((item) => item.id), [DATA_LAYER_PURCHASE]);
});
