// #483: under deploy.target local-serve the build renders the development
// environment, which gates every vendor loader out. Fire-dependent
// analytics-correctness checks are manual review there, not blockers; the same
// campaign QA'd as a production render keeps them as blockers.

import test from "node:test";
import assert from "node:assert/strict";

import { __qaNodeTestHooks } from "./qa-node.mjs";
import { assessAnalyticsInventory, assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const { runAnalyticsOrderSequence, resolveLocalServeAnalytics } = __qaNodeTestHooks;

const PIXEL_ID = "1000000000000001";
const CONTRACT = {
  providers: { facebook: { enabled: true, pixelId: PIXEL_ID } },
  out_of_band_pixels: [{ vendor: "tiktok", id: "FIXTURE-TT-1" }],
};
const LOCAL_URL = "http://localhost:8080/campaign/";
const PREVIEW_URL = "https://preview.example/campaign/";
const localServePacket = { deploy: { target: "local-serve", preview_url: "http://localhost:8080/" } };
const parityReport = {
  stages: { assembly: { evidence: { local_proof: { production_parity: {
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
async function runSequence({ url, localServeAnalytics }) {
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
      return assessAnalyticsInventory(normalizeCapture({ events: [], tagFires: [] }), CONTRACT, { url });
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
          attempts: [{ planId: "accept", receiptRecognized: true, receiptUrl: `${url}receipt/`, capture: normalizeCapture({ events: [] }) }],
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
  const localServeAnalytics = resolveLocalServeAnalytics({ packet: localServePacket, report: null, captureUrl: "http://127.0.0.1:4173/campaign/" });
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
      return assessAnalyticsInventory(normalizeCapture({
        tagFires: [{ kind: "meta", id: PIXEL_ID, host: "facebook.com", params: {} }],
      }), CONTRACT, { url: LOCAL_URL });
    },
    async runOrders() { return { orders: [], receiptAnalytics: { plannedPlanIds: [], attempts: [] } }; },
    assessReceipt: assessReceiptPurchase,
  });
  assert.equal(assertions.find((item) => item.id === "analytics-correctness:tag:meta").status, STATUS.PASS);
  const tiktok = assertions.find((item) => item.id === "analytics-correctness:oob:tiktok");
  assert.equal(tiktok.status, STATUS.MANUAL_REVIEW);
  assert.match(tiktok.evidence.production_parity_note, /No passing page-kit parity/);
});
