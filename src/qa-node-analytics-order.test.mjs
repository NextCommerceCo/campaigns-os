import test from "node:test";
import assert from "node:assert/strict";

import { __qaNodeTestHooks } from "./qa-node.mjs";
import { assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { STATUS } from "./qa-verdict.mjs";

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
