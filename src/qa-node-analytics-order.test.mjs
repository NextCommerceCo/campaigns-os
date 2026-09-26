import test from "node:test";
import assert from "node:assert/strict";

import { __qaNodeTestHooks } from "./qa-node.mjs";
import { assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { STATUS } from "./qa-verdict.mjs";
import { applyQaBuildScope } from "./qa-build-scope.mjs";

const { maybeRunTestOrders, runAnalyticsOrderSequence } = __qaNodeTestHooks;

const target = { url: "https://shop.example/campaign/", source: "resolved_identity:public_route_slug" };
const contract = { providers: { gtm: { enabled: true, containerId: "GTM-1" } } };
const resolved = {
  spec: { analytics: contract },
  analyticsCaptureTarget: target,
  qaWaivers: {},
};

function passingEnvelope() {
  return {
    plannedPlanIds: ["accept-decline"],
    attempts: [{
      planId: "accept-decline",
      receiptRecognized: true,
      receiptUrl: "https://shop.example/campaign/receipt/?ref_id=secret",
      capture: normalizeCapture({ events: [{ data: { event: "dl_purchase", ecommerce: { transaction_id: "secret", value: 10, currency: "USD" } } }] }),
    }],
  };
}

test("orchestration is root inventory, optional parity, exactly one typed-order call, then Purchase finalization", async () => {
  const calls = [];
  const assertions = [];
  let orderCalls = 0;
  const orders = await runAnalyticsOrderSequence({
    args: { "test-order": "common", "analytics-baseline": "https://legacy.example/receipt/" },
    resolved,
    runId: "run-1",
    assertions,
  }, {
    async runInventory(args, receivedContract, options) {
      calls.push("root-inventory");
      assert.equal(receivedContract, contract);
      assert.equal(options.target, target);
      return [{ id: "analytics-correctness:capture", family: "analytics-correctness", page: "analytics", status: STATUS.PASS }];
    },
    async runParity() {
      calls.push("parity");
      return [{ id: "analytics-parity:capture", family: "analytics-parity", page: "analytics", status: STATUS.PASS }];
    },
    async runOrders(input) {
      calls.push("typed-order");
      orderCalls += 1;
      assert.equal(input.captureAnalytics, true, "the existing canonical order owns receipt capture");
      return { orders: [{ plan_id: "accept-decline" }], receiptAnalytics: passingEnvelope() };
    },
    assessReceipt(envelope, options) {
      calls.push("purchase-finalize");
      assert.equal(envelope.plannedPlanIds[0], "accept-decline");
      assert.equal(options.waivers, resolved.qaWaivers);
      return assessReceiptPurchase(envelope, options);
    },
  });

  assert.deepEqual(calls, ["root-inventory", "parity", "typed-order", "purchase-finalize"]);
  assert.equal(orderCalls, 1, "no second browser order or replay");
  assert.deepEqual(orders, [{ plan_id: "accept-decline" }]);
  assert.equal(assertions.filter((assertion) => assertion.id === "analytics-correctness:purchase-fires").length, 1);
  assert.equal(assertions.at(-1).status, STATUS.PASS);
});

test("analytics run with no browser receipt finalizes manual review; legacy orders cannot qualify", async () => {
  for (const mode of ["off", "legacy-api-only"]) {
    const assertions = [];
    const orders = mode === "legacy-api-only" ? [{ path: "accept", next_order_id: "private" }] : [];
    await runAnalyticsOrderSequence({ args: {}, resolved, runId: "run-2", assertions }, {
      async runInventory() { return []; },
      async runParity() { throw new Error("parity should not run"); },
      async runOrders(input) {
        assert.equal(input.captureAnalytics, true);
        return { orders, receiptAnalytics: { plannedPlanIds: [], attempts: [] } };
      },
      assessReceipt: assessReceiptPurchase,
    });
    const purchase = assertions.find((assertion) => assertion.id === "analytics-correctness:purchase-fires");
    assert.equal(purchase.status, STATUS.MANUAL_REVIEW, mode);
  }
});

test("disabled and not-applicable analytics legs never emit a Purchase assertion or request capture", async () => {
  for (const scenario of [
    { args: { "analytics-correctness": "false", "test-order": "common" }, resolved },
    { args: { "test-order": "common" }, resolved: { ...resolved, spec: {}, qaWaivers: {} } },
  ]) {
    const assertions = [];
    let inventoryCalls = 0;
    await runAnalyticsOrderSequence({ ...scenario, runId: "run-3", assertions }, {
      async runInventory() { inventoryCalls += 1; return []; },
      async runParity() { return []; },
      async runOrders(input) {
        assert.equal(input.captureAnalytics, false);
        return { orders: [{ plan_id: "checkout" }], receiptAnalytics: passingEnvelope() };
      },
      assessReceipt() { throw new Error("Purchase must not finalize for disabled/not-applicable legs"); },
    });
    assert.equal(inventoryCalls, 0);
    assert.equal(assertions.some((assertion) => assertion.id === "analytics-correctness:purchase-fires"), false);
  }
});

test("maybeRunTestOrders returns the private envelope for browser mode and empty receipt evidence for off/legacy", async () => {
  const base = { resolved: { topologies: [] }, runId: "run-4", assertions: [] };
  assert.deepEqual(
    await maybeRunTestOrders({ ...base, args: {} }),
    { orders: [], receiptAnalytics: { plannedPlanIds: [], attempts: [] } },
  );

  let browserCalls = 0;
  const browserEnvelope = passingEnvelope();
  const browserAssertions = [];
  const browserResult = await maybeRunTestOrders({
    ...base,
    args: { "test-order": "common" },
    assertions: browserAssertions,
    captureAnalytics: true,
  }, {
    async runBrowser(topologies, args, runId, options) {
      browserCalls += 1;
      assert.equal(options.captureAnalytics, true);
      return { orders: [{ plan_id: "accept-decline" }], assertions: [{ id: "browser-proof" }], receiptAnalytics: browserEnvelope };
    },
  });
  assert.equal(browserCalls, 1);
  assert.equal(browserResult.receiptAnalytics, browserEnvelope);
  assert.deepEqual(browserAssertions, [{ id: "browser-proof" }]);

  let legacyCalls = 0;
  const legacyResult = await maybeRunTestOrders({
    ...base,
    args: { "legacy-api-test-order": "accept" },
  }, {
    async runLegacy(input) {
      legacyCalls += 1;
      assert.equal(input.args["test-order"], "accept");
      return [{ path: "accept", next_order_id: "private" }];
    },
    async runBrowser() { throw new Error("legacy-only mode must not use the browser runner"); },
  });
  assert.equal(legacyCalls, 1);
  assert.deepEqual(legacyResult, {
    orders: [{ path: "accept", next_order_id: "private" }],
    receiptAnalytics: { plannedPlanIds: [], attempts: [] },
  });
});

test("#493: a partial build whose root is an unbuilt out-of-scope page hands the inventory its built entry", async () => {
  const { analyticsCaptureScope } = __qaNodeTestHooks;
  const partial = {
    ...resolved,
    excludedPages: [{ page_id: "landing", url: "https://shop.example/campaign/" }],
    topologies: [{
      funnel_id: "default",
      partial_build_scope: true,
      pages: [
        { page_id: "checkout", page_type: "checkout", url: "https://shop.example/campaign/checkout/" },
        { page_id: "receipt", page_type: "receipt", url: "https://shop.example/campaign/receipt/" },
      ],
    }],
  };
  const scope = analyticsCaptureScope(partial);
  assert.equal(scope.rootInScope, false);
  assert.equal(scope.fallbackTargets.length, 1);
  assert.equal(scope.fallbackTargets[0].page_id, "checkout");
  assert.equal(scope.fallbackTargets[0].url, "https://shop.example/campaign/checkout/");

  // index.html spellings name the same root.
  assert.equal(analyticsCaptureScope({
    ...partial, excludedPages: [{ page_id: "landing", url: "https://shop.example/campaign/index.html" }],
  }).rootInScope, false);

  // A full build keeps the root; the entry is still offered for a non-2xx root.
  const full = analyticsCaptureScope({
    ...partial,
    excludedPages: [],
    topologies: partial.topologies.map(({ partial_build_scope, ...topology }) => topology),
  });
  assert.equal(full.rootInScope, true);
  assert.equal(full.fallbackTargets[0].page_id, "checkout");

  let received = null;
  await runAnalyticsOrderSequence({ args: {}, resolved: partial, runId: "run-493", assertions: [] }, {
    async runInventory(args, receivedContract, options) { received = options; return []; },
    async runOrders() { return { orders: [], receiptAnalytics: { plannedPlanIds: [], attempts: [] } }; },
    assessReceipt: assessReceiptPurchase,
  });
  assert.equal(received.target, target);
  assert.equal(received.rootInScope, false);
  assert.equal(received.fallbackTargets[0].page_id, "checkout");
});

// #495 review: root membership comes from the built scope, not from whether an
// excluded page happens to sit at the root URL.
test("#493: a partial build with no built page at the root keeps the root out of scope even when no excluded page sits there", () => {
  const { analyticsCaptureScope } = __qaNodeTestHooks;
  const root = "https://preview.example.test/demo/";
  const pageUrl = (id) => `${root}${id}/`;
  const declared = ["presell", "landing"].map((page_id) => ({ page_id, skip_reason: "Remains on another host" }));
  const topologies = [{
    funnel_id: "main",
    pages: ["presell", "landing", "checkout", "receipt"].map((id, order) => ({
      page_id: id, page_type: id === "receipt" ? "thankyou" : id, order, label: id, url: pageUrl(id),
    })),
  }];
  const qaScope = applyQaBuildScope(topologies, {
    packet: { source_html: { pages: declared } },
    report: { stages: { prepare_build: { declared_out_of_scope: declared } } },
    publicRouteSlug: "demo",
  });
  assert.deepEqual(qaScope.excludedPages.map((page) => page.page_id), ["presell", "landing"]);
  const scope = analyticsCaptureScope({
    analyticsCaptureTarget: { url: root, source: "resolved_identity:public_route_slug" },
    topologies: qaScope.topologies,
    excludedPages: qaScope.excludedPages,
  });
  assert.equal(scope.rootInScope, false, "no built in-scope page lives at the campaign root");
  assert.equal(scope.fallbackTargets[0].url, pageUrl("checkout"));

  // A partial build whose built in-scope page is served at the root keeps it.
  const rootServed = analyticsCaptureScope({
    analyticsCaptureTarget: { url: root },
    topologies: [{ funnel_id: "main", partial_build_scope: true, pages: [
      { page_id: "landing", page_type: "landing", url: `${root}index.html` },
      { page_id: "checkout", page_type: "checkout", url: pageUrl("checkout") },
    ] }],
    excludedPages: [{ page_id: "presell", url: pageUrl("presell") }],
  });
  assert.equal(rootServed.rootInScope, true);

  // A full build whose landing page is the root still captures the root.
  const full = analyticsCaptureScope({
    analyticsCaptureTarget: { url: root },
    topologies: [{ funnel_id: "main", pages: [
      { page_id: "landing", page_type: "landing", url: root },
      { page_id: "checkout", page_type: "checkout", url: pageUrl("checkout") },
    ] }],
    excludedPages: [],
  });
  assert.equal(full.rootInScope, true);
  assert.equal(full.fallbackTargets[0].page_id, "landing");
});
