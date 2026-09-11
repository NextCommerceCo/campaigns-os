import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";

const { recoverCreatedOrder, dispatchTestOrderPlans } = __qaBrowserTestHooks;

// Direct tests for the read-only recovery pass itself. Every other test of this
// change drives recovery through an injected fake, which proves the dispatch
// loop's decision and nothing about the function that decides whether a created
// order's failure actually cleared. That function is what turns a blocker into
// a pass without a second purchase, so it is exactly the one that must not be
// tested only by proxy.
//
// The browser is faked at the Playwright seam the runner already depends on:
// `context.newPage()`, the page event stream `captureCheckoutEvents` subscribes
// to, a navigation that replays scripted responses into it, and one canned
// receipt-DOM reading. No browser launches and no store is touched.

const CHECKOUT_PAGE = { page_id: "checkout", page_type: "checkout", url: "https://campaign.example/checkout/" };
const RECEIPT_URL = "https://campaign.example/receipt/?ref_id=ref-1";
const ORDER_READ_URL = "https://api.example/api/v1/orders/ref-1/";

function persistedOrderBody({ lines = 1, vouchers = null, totalDiscounts = "0.00" } = {}) {
  return {
    ref_id: "ref-1",
    number: "1001",
    is_test: true,
    total_discounts: totalDiscounts,
    ...(vouchers ? { vouchers } : {}),
    lines: Array.from({ length: lines }, (_, index) => ({
      product_title: `Line ${index + 1}`,
      quantity: 1,
      price_incl_tax: "39.99",
      product_sku: `SKU-${index + 1}`,
    })),
  };
}

function renderedReceipt(visibleItems) {
  return {
    container_count: 1,
    visible_container_count: 1,
    visible_populated_container_count: visibleItems > 0 ? 1 : 0,
    max_visible_rendered_item_count: visibleItems,
    visible_rendered_item_count: visibleItems,
  };
}

const HIDDEN_RECEIPT = {
  container_count: 1,
  visible_container_count: 0,
  visible_populated_container_count: 0,
  max_visible_rendered_item_count: 0,
  visible_rendered_item_count: 0,
};

// A Playwright-shaped page that replays scripted responses on navigation and
// answers one receipt-DOM read. Response handlers are awaited so the event log
// is complete before `gotoAndSettle` returns, exactly as the real capture is.
function fakeReceiptContext({ responses = [], rendered = renderedReceipt(1) } = {}) {
  const visited = [];
  const state = { closed: 0, pages: 0 };
  const page = {
    listeners: new Map(),
    on(event, handler) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(handler);
    },
    setDefaultTimeout() {},
    async goto(url) {
      visited.push(url);
      for (const response of responses) {
        for (const handler of this.listeners.get("response") || []) {
          await handler({
            url: () => response.url,
            status: () => response.status,
            text: async () => (response.body === undefined ? "" : JSON.stringify(response.body)),
          });
        }
      }
      return null;
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    async evaluate() { return rendered; },
    async close() { state.closed += 1; },
  };
  const context = {
    async newPage() {
      state.pages += 1;
      return page;
    },
  };
  return { context, page, visited, state };
}

function receiptFailureAttempt({ coupon = null, persistedLines = 1 } = {}) {
  return {
    ok: false,
    error: "buyer-visible receipt line items: populated container is not visible",
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: true,
      ref_id: "ref-1",
      next_order_id: "1001",
      is_test: true,
      final_url: RECEIPT_URL,
      checkout_url: CHECKOUT_PAGE.url,
      receipt_line_items: Array.from({ length: persistedLines }, (_, index) => ({ title: `Line ${index + 1}`, quantity: 1 })),
      vouchers: [],
      verification: {
        verified: true,
        order_create_status: 201,
        receipt_rendering: { required: true, ok: false, reason: "every container is hidden" },
        receipt_rendering_failures: ["buyer-visible receipt line items: every container is hidden"],
        ...(coupon ? { coupon } : {}),
      },
      evidence: { steps: [{ step: "order_submitted", status: "ok" }] },
    },
    events: { requests: [], responses: [], failed: [], console: [], pageErrors: [], navigations: [] },
  };
}

function checkFor(recovery, name) {
  return recovery.checks.find((entry) => entry.check === name);
}

test("a receipt failure that renders on reload clears, on evidence recovery re-read", async () => {
  const { context, visited, state } = fakeReceiptContext({
    responses: [{ status: 200, url: ORDER_READ_URL, body: persistedOrderBody({ lines: 1 }) }],
    rendered: renderedReceipt(1),
  });

  const recovery = await recoverCreatedOrder({
    context,
    attempt: receiptFailureAttempt(),
    plan: "checkout",
    checkoutPage: CHECKOUT_PAGE,
    args: {},
  });

  // Read-only by construction: one navigation, to the receipt the created order
  // already produced, and nothing clicked or submitted.
  assert.deepEqual(visited, [RECEIPT_URL]);
  assert.equal(state.pages, 1);
  assert.equal(state.closed, 1);

  assert.equal(recovery.cleared, true);
  assert.equal(recovery.result.ok, true);
  assert.equal(recovery.result.error, null);
  assert.equal(checkFor(recovery, "order_read_back").ok, true);
  assert.equal(checkFor(recovery, "receipt_rendering").ok, true);
  assert.equal(recovery.result.order.verification.receipt_rendering_failures, undefined);
});

test("a failed persisted read-back stops recovery honestly instead of clearing", async () => {
  // The read-back the recovery pass depends on returns an error, and the
  // receipt DOM would have satisfied the ORIGINAL attempt's line count. Clearing
  // here would re-decide a blocker against numbers this pass never re-confirmed,
  // and would report `cleared: true` next to a check that says it failed.
  const { context } = fakeReceiptContext({
    responses: [{ status: 500, url: ORDER_READ_URL, body: { detail: "server error" } }],
    rendered: renderedReceipt(3),
  });

  const recovery = await recoverCreatedOrder({
    context,
    attempt: receiptFailureAttempt({ persistedLines: 3 }),
    plan: "checkout",
    checkoutPage: CHECKOUT_PAGE,
    args: {},
  });

  assert.equal(recovery.cleared, false);
  assert.equal(recovery.result.ok, false);
  assert.match(recovery.result.error, /persisted order read-back/);
  assert.match(recovery.result.error, /HTTP 500/);

  const readBack = checkFor(recovery, "order_read_back");
  assert.equal(readBack.ok, false);
  assert.match(readBack.reason, /HTTP 500/);
  // The rendering verdict is not re-decided against the stale count either.
  assert.equal(checkFor(recovery, "receipt_rendering").ok, false);
  assert.match(checkFor(recovery, "receipt_rendering").reason, /not re-assessed/);
  assert.equal(
    recovery.checks.every((entry) => entry.ok === true || !recovery.cleared),
    true,
    "no check may report failure while the pass reports cleared",
  );
});

test("a receipt reload that issues no read-back at all cannot clear either", async () => {
  const { context } = fakeReceiptContext({ responses: [], rendered: renderedReceipt(3) });

  const recovery = await recoverCreatedOrder({
    context,
    attempt: receiptFailureAttempt({ persistedLines: 3 }),
    plan: "checkout",
    checkoutPage: CHECKOUT_PAGE,
    args: {},
  });

  assert.equal(recovery.cleared, false);
  assert.equal(checkFor(recovery, "order_read_back").ok, false);
  assert.match(checkFor(recovery, "order_read_back").reason, /no order read-back/);
});

test("a receipt that still does not render survives recovery as the blocker it was", async () => {
  const { context } = fakeReceiptContext({
    responses: [{ status: 200, url: ORDER_READ_URL, body: persistedOrderBody({ lines: 2 }) }],
    rendered: HIDDEN_RECEIPT,
  });

  const recovery = await recoverCreatedOrder({
    context,
    attempt: receiptFailureAttempt({ persistedLines: 2 }),
    plan: "checkout",
    checkoutPage: CHECKOUT_PAGE,
    args: {},
  });

  assert.equal(recovery.cleared, false);
  assert.equal(recovery.result.ok, false);
  assert.match(recovery.result.error, /buyer-visible receipt line items/);
  assert.equal(checkFor(recovery, "order_read_back").ok, true);
  assert.equal(checkFor(recovery, "receipt_rendering").ok, false);
});

// --- The coupon a `tiers` plan carries, which never appears in run-level args --

const COUPON_PLAN = {
  path: "checkout",
  apply_coupon: "SAVE10",
  source: { type: "declared_coupon", code: "SAVE10" },
};

function couponFailureAttempt() {
  return receiptFailureAttempt({
    coupon: { requested_code: "SAVE10", ok: false, basis: "missing", matched: [], reason: "persisted order itemizes no vouchers" },
  });
}

test("a tiers coupon is re-checked from the plan, not from run-level flags", async () => {
  // `--test-order tiers` REFUSES a run-level `--apply-coupon` and puts each
  // coupon on its plan instead, so `args` is empty here by construction. Reading
  // the coupon from `args` skipped the check entirely, left nothing remaining,
  // and turned a coupon blocker into a pass on a read-only pass that never
  // looked at a voucher.
  const { context } = fakeReceiptContext({
    responses: [{ status: 200, url: ORDER_READ_URL, body: persistedOrderBody({ lines: 1, vouchers: [] }) }],
    rendered: renderedReceipt(1),
  });

  const recovery = await recoverCreatedOrder({
    context,
    attempt: couponFailureAttempt(),
    plan: COUPON_PLAN,
    checkoutPage: CHECKOUT_PAGE,
    args: {},
  });

  const couponCheck = checkFor(recovery, "coupon_read_back");
  assert.ok(couponCheck, "the plan's coupon must be re-checked");
  assert.equal(couponCheck.ok, false);
  assert.equal(recovery.cleared, false);
  assert.equal(recovery.result.ok, false);
  assert.match(recovery.result.error, /SAVE10/);
  assert.equal(recovery.result.order.verification.coupon.ok, false);
});

test("a tiers coupon that does read back on reload clears with the rest", async () => {
  const { context } = fakeReceiptContext({
    responses: [{
      status: 200,
      url: ORDER_READ_URL,
      body: persistedOrderBody({ lines: 1, vouchers: [{ code: "SAVE10", amount: "8.00" }], totalDiscounts: "8.00" }),
    }],
    rendered: renderedReceipt(1),
  });

  const recovery = await recoverCreatedOrder({
    context,
    attempt: couponFailureAttempt(),
    plan: COUPON_PLAN,
    checkoutPage: CHECKOUT_PAGE,
    args: {},
  });

  assert.equal(checkFor(recovery, "coupon_read_back").ok, true);
  assert.equal(recovery.cleared, true);
  assert.equal(recovery.result.ok, true);
  assert.equal(recovery.result.order.verification.coupon.basis, "persisted_voucher_code");
});

test("the dispatch loop hands recovery the plan it recovered", async () => {
  // The seam the fix depends on: if the plan does not reach recovery, the
  // per-plan coupon cannot be found there however correct the function is.
  const seen = [];
  const runSingleTestOrder = async (context, page, plan, args, runId, options) => {
    options.creationBudget.reserve({ plan_id: plan.path });
    return couponFailureAttempt();
  };
  const recoverCreatedOrderSpy = async ({ plan, args }) => {
    seen.push({ plan, coupon_in_args: args["apply-coupon"] ?? null });
    return { attempts: 1, cleared: false, checks: [], result: couponFailureAttempt() };
  };

  await dispatchTestOrderPlans({
    context: null,
    plans: [COUPON_PLAN],
    checkoutPage: CHECKOUT_PAGE,
    args: {},
    runId: "test-run",
    options: { runSingleTestOrder, recoverCreatedOrder: recoverCreatedOrderSpy },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].plan, COUPON_PLAN);
  assert.equal(seen[0].coupon_in_args, null, "the coupon is on the plan, never on the run-level args");
});
