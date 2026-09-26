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

// --- An accept whose mutation body read timed out ---
//
// The checkout already left order evidence (its read-back, base line only).
// The upsell mutation answered 201, but its body loaded after the bounded
// read gave up. Judging the step straight away compares the checkout's stale
// lines and records "no new upsell line" for an upsell that was added. The
// step must wait for evidence of this mutation, and without any, report the
// upsell as unverified rather than missing.

const UPSELL_REF = "FIXTUREREF4";
const BASE_LINE = { product_title: "Base bundle", quantity: 1, is_upsell: false, price_incl_tax: "40.00" };
const UPSELL_LINE = { product_title: "Add-on", quantity: 1, is_upsell: true, price_incl_tax: "15.00" };

function acceptFixture() {
  const handlers = new Map();
  const page = {
    on(event, handler) { handlers.set(event, handler); },
    url: () => `http://127.0.0.1/thank-you/?ref_id=${UPSELL_REF}`,
    locator: () => ({ evaluateAll: async () => [] }),
  };
  const events = hooks.captureCheckoutEvents(page);
  const respond = (url, status, body, delayMs = 0) => handlers.get("response")({
    url: () => url,
    status: () => status,
    text: () => (body === undefined
      ? new Promise(() => {})
      : new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(body)), delayMs))),
  });
  const orderBody = (lines) => ({ ref_id: UPSELL_REF, number: "1002", is_test: true, lines });
  const detailUrl = `http://127.0.0.1/api/v1/orders/${UPSELL_REF}/`;
  const upsellsUrl = `http://127.0.0.1/api/v1/orders/${UPSELL_REF}/upsells/`;
  // The step's upsell record as clickUpsellPath leaves it after a timed-out read.
  const upsell = {
    path: "accept",
    clicked: true,
    expected_items: [],
    api_response_seen: true,
    api_response_status: 201,
    api_response_url: upsellsUrl,
    api_response_body_read: { timed_out: true, waited_ms: hooks.RESPONSE_BODY_READ_TIMEOUT_MS, bound_ms: hooks.RESPONSE_BODY_READ_TIMEOUT_MS },
  };
  return { page, events, respond, orderBody, detailUrl, upsellsUrl, upsell };
}

// Mirrors the runner's accept branch: refresh the evidence, then judge it.
async function judgeAccept({ page, events, upsell, initialLineItems, responseIndexBefore, lateWaitMs }) {
  const { refreshed, lateUpsellEvidence } = await hooks.refreshUpsellStepEvidence({
    page, events, path: "accept", email: null, checkoutPage: { url: "http://127.0.0.1/checkout/" }, args: {},
    step: "accept", upsell, preferredOrderBody: null, initialLineItems, responseIndexBefore, lateWaitMs,
  });
  const proof = hooks.acceptedUpsellStepProof(
    upsell,
    lateUpsellEvidence,
    hooks.acceptedUpsellProof(refreshed.receipt_line_items, initialLineItems, upsell.expected_items, events),
  );
  return { proof, lateUpsellEvidence, failures: hooks.upsellActionStepFailures(0, "accept", upsell, proof) };
}

async function checkoutEvidence(fixture) {
  fixture.respond(fixture.detailUrl, 200, fixture.orderBody([BASE_LINE]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const checkout = await hooks.buildOrderEvidence({
    page: fixture.page, events: fixture.events, path: "accept", email: null, checkoutPage: { url: "http://127.0.0.1/checkout/" }, args: {},
  });
  assert.equal(checkout.receipt_line_items.length, 1, "the checkout left base-line evidence");
  return { initialLineItems: checkout.receipt_line_items.slice(), responseIndexBefore: fixture.events.responses.length };
}

test("an accepted upsell whose mutation body loads after the bound is proved by that late body", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respond(fixture.upsellsUrl, 201, fixture.orderBody([BASE_LINE, UPSELL_LINE]), 1200);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(proof.ok, true, `expected the late body to prove the upsell; got: ${proof.reason}`);
  assert.equal(lateUpsellEvidence.source, "late_upsell_body");
  assert.deepEqual(failures, []);
});

test("an accepted upsell whose body never loads is proved by a later order read-back", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respond(fixture.upsellsUrl, 201, undefined);
  fixture.respond(fixture.detailUrl, 200, fixture.orderBody([BASE_LINE, UPSELL_LINE]), 800);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(proof.ok, true, `expected the read-back to prove the upsell; got: ${proof.reason}`);
  assert.equal(lateUpsellEvidence.source, "order_read_back");
  assert.deepEqual(failures, []);
});

test("with no evidence of the mutation, the upsell is unverified, not missing, and maps to manual review", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respond(fixture.upsellsUrl, 201, undefined);

  const started = Date.now();
  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 600 });

  assert.ok(Date.now() - started < 3000, "the wait is bounded");
  assert.equal(proof.ok, false);
  assert.doesNotMatch(proof.reason, /no new upsell line/, "stale lines must not be reported as a missing upsell");
  assert.equal(proof.unverified, true);
  assert.match(proof.reason, /^accepted upsell unverified: .*HTTP 201.*did not load within 3000ms/);
  assert.equal(lateUpsellEvidence.source, "none");
  assert.deepEqual(failures, [], "an unread body is not a step failure");

  const assertion = hooks.testOrderAssertion({ page_id: "checkout", page_type: "checkout", url: "http://127.0.0.1/checkout/" }, "accept", {
    ok: true,
    error: null,
    order: {
      path: "accept", ok: true, ref_id: UPSELL_REF, next_order_id: "1002", final_url: fixture.page.url(), is_test: true,
      receipt_line_items: before.initialLineItems, card: { last4: "1111" },
      verification: { accepted_upsell_line_present: null, upsell_unverified: [proof.reason] },
    },
    events: {},
  });
  assert.equal(assertion.status, "manual_review");
  assert.equal(assertion.severity, "warn");
  assert.match(assertion.actual, /accepted upsell unverified/);
  assert.deepEqual(assertion.evidence.upsell_unverified, [proof.reason]);
});

test("a late mutation body without the upsell line is still a definitive failure", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respond(fixture.upsellsUrl, 201, fixture.orderBody([BASE_LINE]), 300);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(lateUpsellEvidence.source, "late_upsell_body");
  assert.equal(proof.ok, false);
  assert.notEqual(proof.unverified, true);
  assert.match(failures.join("; "), /no new upsell line appeared after accept/);
});

test("a post-click order read-back without the upsell line is a definitive failure, not manual review", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respond(fixture.upsellsUrl, 201, undefined);
  fixture.respond(fixture.detailUrl, 200, fixture.orderBody([BASE_LINE]), 200);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 800 });

  assert.equal(lateUpsellEvidence.source, "order_read_back_missing_line");
  assert.equal(proof.ok, false);
  assert.notEqual(proof.unverified, true, "a read-back confirming the line is missing is not manual review");
  assert.match(failures.join("; "), /no new upsell line appeared after accept/);
});

test("a body read that ended without timing out keeps the definitive verdict and does not wait", () => {
  const upsell = { api_response_status: 201, api_response_body_read: { timed_out: false, waited_ms: 0, bound_ms: 3000 } };
  const proof = { ok: false, reason: "no new upsell line appeared after accept", expected_items: [], matched_lines: [] };
  assert.equal(hooks.acceptedUpsellStepProof(upsell, null, proof), proof);
  const rejected = { api_response_status: 409, api_response_body_read: { timed_out: true, waited_ms: 3000, bound_ms: 3000 } };
  assert.equal(hooks.acceptedUpsellStepProof(rejected, null, proof), proof, "a non-2xx mutation is not unverified");
});

test("the bounded read reports whether it timed out and how long the read itself waited", async () => {
  const pending = await hooks.readJsonResponseBodyBounded({ text: () => new Promise(() => {}) }, 200);
  assert.equal(pending.timed_out, true);
  assert.ok(pending.waited_ms >= 190, `waited ${pending.waited_ms}ms`);
  const failed = await hooks.readJsonResponseBodyBounded({ text: async () => { throw new Error("gone"); } }, 200);
  assert.equal(failed.timed_out, false, "a failed read is not a timeout");
  assert.equal(failed.body, null);
});
