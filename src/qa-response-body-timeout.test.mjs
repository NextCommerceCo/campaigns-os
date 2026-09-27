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
  // requestStartedAt is when the browser started the request (the runner reads
  // it from request().timing()); it defaults to now, i.e. after the click.
  // Like Playwright, one response hands out one Request object, and each
  // response a different one, even to the same URL. Returns that request.
  const respond = (url, status, body, delayMs = 0, requestStartedAt = Date.now()) => {
    const request = { timing: () => ({ startTime: requestStartedAt }) };
    handlers.get("response")({
      url: () => url,
      status: () => status,
      request: () => request,
      text: () => (body === undefined
        ? new Promise(() => {})
        : new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(body)), delayMs))),
    });
    return request;
  };
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
    mutation_responded_at: null,
  };
  // This step's own mutation: clickUpsellPath records the request its click
  // made on the step record, under the runner's request-identity key.
  const respondMutation = (body, delayMs = 0) => {
    const request = respond(upsellsUrl, 201, body, delayMs);
    upsell[hooks.REQUEST_IDENTITY] = request;
    return request;
  };
  return { page, events, respond, respondMutation, orderBody, detailUrl, upsellsUrl, upsell };
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
  // The accept's mutation answers here, after the checkout's own read-back.
  fixture.upsell.mutation_responded_at = Date.now();
  return { initialLineItems: checkout.receipt_line_items.slice(), responseIndexBefore: fixture.events.responses.length };
}

test("an accepted upsell whose mutation body loads after the bound is proved by that late body", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respondMutation(fixture.orderBody([BASE_LINE, UPSELL_LINE]), 1200);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(proof.ok, true, `expected the late body to prove the upsell; got: ${proof.reason}`);
  assert.equal(lateUpsellEvidence.source, "late_upsell_body");
  assert.deepEqual(failures, []);
});

test("an accepted upsell whose body never loads is proved by a later order read-back", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respondMutation(undefined);
  fixture.respond(fixture.detailUrl, 200, fixture.orderBody([BASE_LINE, UPSELL_LINE]), 800);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(proof.ok, true, `expected the read-back to prove the upsell; got: ${proof.reason}`);
  assert.equal(lateUpsellEvidence.source, "order_read_back");
  assert.deepEqual(failures, []);
});

test("with no evidence of the mutation, the upsell is unverified, not missing, and maps to manual review", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respondMutation(undefined);

  const started = Date.now();
  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 600 });

  assert.ok(Date.now() - started < 3000, "the wait is bounded");
  assert.equal(proof.ok, false);
  assert.doesNotMatch(proof.reason, /no new upsell line/, "stale lines must not be reported as a missing upsell");
  assert.equal(proof.unverified, true);
  assert.match(proof.reason, /^accepted upsell unverified: .*HTTP 201.*did not load within 3000ms/);
  assert.equal(lateUpsellEvidence.source, "none");
  assert.deepEqual(failures, [], "an unread body is not a step failure");

  // The path result as executeTestOrderPath returns it for an otherwise clean
  // path: not ok, carrying the unverified reasons (#505).
  const assertion = hooks.testOrderAssertion({ page_id: "checkout", page_type: "checkout", url: "http://127.0.0.1/checkout/" }, "accept", {
    ok: false,
    upsell_unverified: [proof.reason],
    error: null,
    order: {
      path: "accept", ok: true, ref_id: UPSELL_REF, next_order_id: "1002", final_url: fixture.page.url(), is_test: true,
      receipt_line_items: before.initialLineItems, card: { last4: "1111" },
      verification: { verified: false, accepted_upsell_line_present: null, upsell_unverified: [proof.reason] },
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
  fixture.respondMutation(fixture.orderBody([BASE_LINE]), 300);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(lateUpsellEvidence.source, "late_upsell_body");
  assert.equal(proof.ok, false);
  assert.notEqual(proof.unverified, true);
  assert.match(failures.join("; "), /no new upsell line appeared after accept/);
});

test("a post-click order read-back without the upsell line is a definitive failure, not manual review", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respondMutation(undefined);
  fixture.respond(fixture.detailUrl, 200, fixture.orderBody([BASE_LINE]), 200);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 800 });

  assert.equal(lateUpsellEvidence.source, "order_read_back_missing_line");
  assert.equal(proof.ok, false);
  assert.notEqual(proof.unverified, true, "a read-back confirming the line is missing is not manual review");
  assert.match(failures.join("; "), /no new upsell line appeared after accept/);
});

test("an order read-back requested before the mutation answered is not a definitive negative", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respondMutation(undefined);
  // Requested before the mutation answered: a checkout-page read still in
  // flight, or one started while the click waited to fire. Its body finishes
  // loading afterwards, so it lands past the log offset.
  fixture.respond(fixture.detailUrl, 200, fixture.orderBody([BASE_LINE]), 200, fixture.upsell.mutation_responded_at - 50);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 800 });

  assert.equal(lateUpsellEvidence.source, "none", "a read-back from before the mutation answered is not evidence about it");
  assert.equal(proof.unverified, true);
  assert.deepEqual(failures, [], "stale evidence must not fail a possibly successful accept");
});

// --- A late body from another upsell step (#505) ---
//
// Every upsell step in a path posts to the same /orders/<ref>/upsells/ URL,
// whether the steps share one page or sit on separate pages. An earlier
// step's slow body can land while this step waits for its own, and must not
// be judged as this step's evidence: only the entry answering this step's own
// request (Playwright request identity) is its late body.

const UPSELL_A_LINE = { product_title: "Add-on A", quantity: 1, is_upsell: true, price_incl_tax: "12.00" };

test("an earlier upsell step's slow body lacking this step's line is not this step's late body", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  await checkoutEvidence(fixture);
  // Step A (another request to the same URL) was proved by a read-back; its
  // own body is still loading when step B clicks. B starts from A's lines.
  const initialLineItems = [
    ...hooks.extractReceiptLines(fixture.orderBody([BASE_LINE, UPSELL_A_LINE])),
  ];
  const responseIndexBefore = fixture.events.responses.length;
  fixture.respond(fixture.upsellsUrl, 201, fixture.orderBody([BASE_LINE, UPSELL_A_LINE]), 200);
  // Step B's own mutation answered 201; its body never loads.
  fixture.respondMutation(undefined);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, initialLineItems, responseIndexBefore, lateWaitMs: 800 });

  assert.equal(lateUpsellEvidence.source, "none", "step A's body is not evidence about step B's mutation");
  assert.equal(proof.unverified, true);
  assert.deepEqual(failures, [], "another step's lines must not fail a possibly successful accept");
});

test("an earlier upsell step's slow body carrying its own line does not prove this step", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  // Step A was left unverified, so B starts from the checkout's lines; A's
  // body, landing now, carries A's upsell line, which is new against them.
  fixture.respond(fixture.upsellsUrl, 201, fixture.orderBody([BASE_LINE, UPSELL_A_LINE]), 200);
  fixture.respondMutation(undefined);

  const { proof, lateUpsellEvidence } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 800 });

  assert.equal(lateUpsellEvidence.source, "none", "step A's body is not evidence about step B's mutation");
  assert.notEqual(proof.ok, true, "step A's upsell line must not pass step B");
  assert.equal(proof.unverified, true);
});

test("this step's own late body still counts when an earlier step's body landed first", { timeout: 15000 }, async () => {
  const fixture = acceptFixture();
  const before = await checkoutEvidence(fixture);
  fixture.respond(fixture.upsellsUrl, 201, fixture.orderBody([BASE_LINE]), 100);
  fixture.respondMutation(fixture.orderBody([BASE_LINE, UPSELL_LINE]), 500);

  const { proof, lateUpsellEvidence, failures } = await judgeAccept({ ...fixture, ...before, lateWaitMs: 5000 });

  assert.equal(lateUpsellEvidence.source, "late_upsell_body");
  assert.equal(proof.ok, true, `expected this step's own body to prove the upsell; got: ${proof.reason}`);
  assert.deepEqual(failures, []);
});

test("the request identity never reaches serialized evidence", () => {
  const entry = { status: 201, url: "http://127.0.0.1/api/v1/orders/X/upsells/", body: null };
  entry[hooks.REQUEST_IDENTITY] = { timing: () => ({}) };
  assert.equal(typeof hooks.REQUEST_IDENTITY, "symbol");
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), { status: 201, url: entry.url, body: null });
});

// --- An unverified upsell on the per-order result (#505) ---
//
// The path result's `ok` is what the dispatcher, the creation classifier and
// the assertion read. An unverified upsell is not a pass there, and not a
// failure to re-run or recover either: a re-run buys a second order and
// recovery cannot re-check an upsell read-only.

test("an unverified upsell result is neither re-run nor recovered, and goes to manual review", async () => {
  const reason = "accepted upsell unverified: the order upsell API answered HTTP 201 but its body did not load within 3000ms";
  const attempt = {
    ok: false,
    upsell_unverified: [reason],
    error: null,
    submit: { reserved: true },
    order: {
      path: "accept", ok: true, ref_id: UPSELL_REF, next_order_id: "1002", final_url: "http://127.0.0.1/thank-you/", is_test: true,
      receipt_line_items: [], card: { last4: "1111" },
      verification: { verified: false, accepted_upsell_line_present: null, upsell_unverified: [reason] },
      evidence: { steps: [] },
    },
    events: {},
  };
  let runs = 0;
  let recoveries = 0;
  const { assertions, orders } = await hooks.dispatchTestOrderPlans({
    context: null,
    plans: ["accept"],
    checkoutPage: { page_id: "checkout", page_type: "checkout", url: "http://127.0.0.1/checkout/" },
    args: {},
    runId: "test-run",
    options: {
      runSingleTestOrder: async () => { runs += 1; return attempt; },
      recoverCreatedOrder: async () => { recoveries += 1; return { attempts: 1, cleared: true, checks: [], result: { ...attempt, ok: true } }; },
    },
  });
  assert.equal(runs, 1, "an unverified upsell is not re-run");
  assert.equal(recoveries, 0, "an unverified upsell is not cleared by a read-only recovery");
  const order = assertions.find((entry) => entry.id === "browser-test-order:accept");
  assert.equal(order.status, "manual_review");
  assert.deepEqual(order.evidence.upsell_unverified, [reason]);
  assert.equal(orders[0].verification.verified, false);
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
