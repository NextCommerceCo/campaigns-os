import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";

test("a response body that never finishes loading is reported as null after the bound", async () => {
  const started = Date.now();
  const body = await hooks.readJsonResponseBodyWithin({ text: () => new Promise(() => {}) }, 50);
  assert.equal(body, null);
  assert.ok(Date.now() - started < 1000);
});

test("a loaded body is still parsed, and a failed read is null", async () => {
  assert.deepEqual(await hooks.readJsonResponseBody({ text: async () => "{\"ok\":true}" }), { ok: true });
  assert.equal(await hooks.readJsonResponseBody({ text: async () => { throw new Error("gone"); } }), null);
  assert.equal(await hooks.readJsonResponseBody({ text() { throw new Error("sync"); } }), null);
});

test("a zero, negative or unbounded timeout falls back to the fixed bound instead of waiting forever", async () => {
  for (const timeoutMs of [0, -1, Infinity, Number.NaN, undefined]) {
    let timer = null;
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve("hung"), 4500); });
    const body = await Promise.race([hooks.readJsonResponseBodyWithin({ text: () => new Promise(() => {}) }, timeoutMs), guard]);
    clearTimeout(timer);
    assert.equal(body, null, `timeout ${timeoutMs}`);
  }
});

// The checkout event listener is not awaited by anything, so a bound there
// only loses data: a successful order body that finishes loading after the
// bound would be recorded as null, lastJsonResponse would skip it, and a real
// order would be reported as not created. waitForLateOrderEvidence polls for
// that late entry instead.
test("a successful order read-back whose body loads after the bound still proves the order", { timeout: 15000 }, async () => {
  const REF = "FIXTUREREF3";
  const handlers = new Map();
  const page = {
    on(event, handler) { handlers.set(event, handler); },
    url: () => `http://127.0.0.1/thank-you/?ref_id=${REF}`,
    locator: () => ({ evaluateAll: async () => [] }),
  };
  const events = hooks.captureCheckoutEvents(page);
  const lateMs = hooks.RESPONSE_BODY_READ_TIMEOUT_MS + 500;
  const body = JSON.stringify({ ref_id: REF, number: "1001", is_test: true, lines: [] });
  handlers.get("response")({
    url: () => `http://127.0.0.1/api/v1/orders/${REF}/`,
    status: () => 200,
    text: () => new Promise((resolve) => setTimeout(() => resolve(body), lateMs)),
  });

  const order = await hooks.buildOrderEvidence({
    page, events, path: "decline", email: null, checkoutPage: { url: "http://127.0.0.1/checkout/" }, args: {},
  });

  assert.equal(order.ok, true, "the late order read-back is the order's proof");
  assert.equal(order.next_order_id, "1001");
  assert.equal(order.verification.order_read_status, 200);
});
