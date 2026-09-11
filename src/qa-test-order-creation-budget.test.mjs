import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { computeDisposition } from "./qa-verdict.mjs";
import { __qaNodeTestHooks, runQaCli } from "./qa-node.mjs";

const {
  classifyTestOrderCreation,
  createOrderCreationBudget,
  dispatchTestOrderPlans,
  summarizeOrderCreateActivity,
  confirmedOrderCreates,
  testOrderAssertion,
} = __qaBrowserTestHooks;

// A typed-card path that failed AFTER the platform created the order used to be
// re-run from scratch, which submitted the checkout a second time and bought the
// same thing twice. A receipt that did not render is the common case, and it is
// the one the shadow-campaign validation run flagged as unproved. The runner now
// classifies what the failed attempt did to the store before it decides what to
// do next, and it never resubmits anything it cannot prove was not created.

const CHECKOUT_PAGE = { page_id: "checkout", page_type: "checkout", url: "https://campaign.example/checkout/" };
const RECEIPT_URL = "https://campaign.example/receipt/?ref_id=ref-1";
const ORDERS_API = "https://api.example/api/v1/orders/";

function eventLog({ requests = [], responses = [], failed = [] } = {}) {
  return { requests, responses, failed, console: [], pageErrors: [], navigations: [] };
}

function createResponse(status) {
  return { status, url: ORDERS_API, body: { ref_id: "ref-1" } };
}

function steps(names) {
  return names.map((step) => ({ step, status: "ok", started_at: "2026-09-11T00:00:00.000Z", duration_ms: 1 }));
}

const PRE_SUBMIT_STEPS = steps(["opened_checkout", "selected_bundle", "customer_fields_filled"]);
const SUBMITTED_STEPS = steps(["opened_checkout", "selected_bundle", "customer_fields_filled", "card_fields_filled", "order_submitted"]);

// A real order exists: 2xx create, a ref id, a persisted read-back — and the
// receipt page never rendered the lines the buyer is supposed to see.
function receiptFailureAttempt() {
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
      receipt_line_items: [{ title: "Bundle" }],
      card: { last4: "1117" },
      vouchers: [],
      verification: {
        verified: true,
        order_create_status: 201,
        receipt_rendering: { required: true, ok: false, reason: "populated container is not visible" },
        receipt_rendering_failures: ["buyer-visible receipt line items: populated container is not visible"],
      },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ responses: [createResponse(201)] }),
  };
}

function passedAttempt(refId = "ref-1") {
  return {
    ok: true,
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: true,
      ref_id: refId,
      next_order_id: "1002",
      is_test: true,
      final_url: RECEIPT_URL,
      receipt_line_items: [{ title: "Bundle" }],
      card: { last4: "1117" },
      verification: { verified: true, order_create_status: 201 },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ responses: [createResponse(201)] }),
  };
}

// Nothing was submitted: the path died while filling the form.
function preSubmitFailureAttempt() {
  return {
    ok: false,
    error: "step customer_fields_filled failed: field not found",
    submit: { reserved: false },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false, error: "field not found" },
      evidence: { steps: PRE_SUBMIT_STEPS },
    },
    events: eventLog(),
  };
}

function plannedPlans(count = 1) {
  return Array.from({ length: count }, (_, index) => (index === 0 ? "checkout" : `plan-${index}`));
}

// A scripted runner standing in for runSingleBrowserTestOrder. It reserves a
// creation exactly where the real runner does — immediately before the submit
// click — so "how many real orders would this run have placed" is observable
// without a browser and without a store.
function scriptedRunner(script) {
  const submissions = [];
  const calls = [];
  const runSingleTestOrder = async (context, page, plan, args, runId, options) => {
    const id = typeof plan === "string" ? plan : plan.path;
    calls.push(id);
    const next = script[calls.length - 1];
    if (!next) throw new Error(`scripted runner ran out of attempts at call ${calls.length}`);
    if (next.submits) {
      try {
        options.creationBudget.reserve({ plan_id: id });
      } catch (error) {
        return {
          ok: false,
          budget_exhausted: true,
          error: error.message,
          submit: { reserved: false },
          order: {
            path: id,
            ok: false,
            ref_id: null,
            final_url: CHECKOUT_PAGE.url,
            verification: { verified: false, error: error.message },
            evidence: { steps: PRE_SUBMIT_STEPS },
          },
          events: eventLog(),
        };
      }
      submissions.push(id);
    }
    return next.attempt;
  };
  return { runSingleTestOrder, submissions, calls };
}

function recorderRecovery(outcome) {
  const calls = [];
  const recoverCreatedOrder = async ({ attempt }) => {
    calls.push(attempt.order.ref_id);
    return outcome(attempt);
  };
  return { recoverCreatedOrder, calls };
}

function clearedRecovery() {
  return recorderRecovery((attempt) => ({
    attempts: 1,
    cleared: true,
    checks: [{ check: "receipt_rendering", ok: true, reason: "1 visible rendered line for 1 persisted line" }],
    result: {
      ...attempt,
      ok: true,
      error: null,
      order: {
        ...attempt.order,
        verification: {
          ...attempt.order.verification,
          receipt_rendering: { required: true, ok: true, reason: "1 visible rendered line for 1 persisted line" },
          receipt_rendering_failures: undefined,
        },
      },
    },
  }));
}

function unclearedRecovery() {
  return recorderRecovery((attempt) => ({
    attempts: 1,
    cleared: false,
    checks: [{ check: "receipt_rendering", ok: false, reason: "populated container is still not visible" }],
    result: attempt,
  }));
}

async function dispatch({ plans = plannedPlans(1), runner, recovery, args = {}, options = {} } = {}) {
  return dispatchTestOrderPlans({
    context: null,
    plans,
    checkoutPage: CHECKOUT_PAGE,
    args,
    runId: "test-run",
    options: {
      ...options,
      runSingleTestOrder: runner.runSingleTestOrder,
      ...(recovery ? { recoverCreatedOrder: recovery.recoverCreatedOrder } : {}),
    },
  });
}

function testOrderAssertionFor(assertions, planIdentifier = "checkout") {
  return assertions.find((entry) => entry.id === `browser-test-order:${planIdentifier}`);
}

test("a receipt failure after a confirmed order is recovered, never re-bought", async () => {
  const runner = scriptedRunner([{ submits: true, attempt: receiptFailureAttempt() }]);
  const recovery = clearedRecovery();
  const { assertions, creationBudget } = await dispatch({ runner, recovery });

  // The whole point: one submit, one order, for a failure that happened after
  // the platform already had the money.
  assert.deepEqual(runner.submissions, ["checkout"]);
  assert.equal(runner.calls.length, 1);
  assert.equal(creationBudget.reserved, 1);
  assert.deepEqual(recovery.calls, ["ref-1"]);

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.evidence.order_creation.classification, "created");
  assert.equal(result.evidence.order_creation.action, "recovered");
  assert.equal(result.evidence.order_creation.submissions_reserved, 1);
});

test("a recovery pass that clears is never laundered into a first-attempt pass", async () => {
  const runner = scriptedRunner([{ submits: true, attempt: receiptFailureAttempt() }]);
  const recovery = clearedRecovery();
  const { assertions } = await dispatch({ runner, recovery });

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
  assert.equal(computeDisposition([result]), "ready");

  // Distinguishable from a first-time pass, which is the 2026-09-06 property
  // carried forward from the retry it replaces.
  assert.equal(result.evidence.recovery.attempts, 1);
  assert.equal(result.evidence.recovery.cleared, true);
  assert.match(result.evidence.recovery.original_error, /buyer-visible receipt line items/);
  assert.equal(result.evidence.recovery.original_ref_id, "ref-1");
  assert.equal(result.evidence.order_creation.submissions_reserved, 1);

  const firstTime = testOrderAssertion(CHECKOUT_PAGE, "checkout", passedAttempt());
  assert.equal(firstTime.evidence.recovery, undefined);
  assert.equal(firstTime.evidence.order_creation, undefined);
});

test("a receipt failure that survives recovery stays a blocker and says so", async () => {
  const runner = scriptedRunner([{ submits: true, attempt: receiptFailureAttempt() }]);
  const recovery = unclearedRecovery();
  const { assertions, creationBudget } = await dispatch({ runner, recovery });

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.equal(computeDisposition([result]), "blocked");
  assert.equal(result.evidence.recovery.cleared, false);
  assert.match(result.evidence.recovery.note, /survived/i);
  assert.equal(result.evidence.order_creation.submissions_reserved, 1);
  assert.equal(creationBudget.reserved, 1);
  assert.deepEqual(runner.submissions, ["checkout"]);
});

test("a ref id with an unusable read-back is ambiguous, and is never resubmitted", async () => {
  const attempt = {
    ok: false,
    error: "order read-back returned HTTP 502",
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: false,
      ref_id: "ref-1",
      final_url: RECEIPT_URL,
      receipt_line_items: [],
      verification: { verified: false, order_read_status: 502, error: "order read-back returned HTTP 502" },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ responses: [{ status: 502, url: "https://api.example/api/v1/orders/ref-1/", body: {} }] }),
  };
  const classification = classifyTestOrderCreation(attempt);
  assert.equal(classification.creation, "ambiguous");

  const runner = scriptedRunner([{ submits: true, attempt }]);
  const { assertions } = await dispatch({ runner });
  assert.deepEqual(runner.submissions, ["checkout"]);
  assert.equal(runner.calls.length, 1);

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.status, "fail");
  assert.equal(result.evidence.order_creation.classification, "ambiguous");
  assert.equal(result.evidence.order_creation.action, "stopped");
  // The operator has to know what to look for before running this path again.
  assert.match(result.actual, /existing order/i);
  assert.match(result.evidence.order_creation.operator_check, /ref id|QA email/i);
});

test("a lost create response and a network-failed create are both ambiguous", async () => {
  // Submit was clicked and the outcome never arrived: the create was in flight.
  const lost = {
    ok: false,
    error: "step order_submitted timed out after 45000ms",
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false, error: "timed out" },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ requests: [{ method: "POST", url: ORDERS_API }] }),
  };
  assert.equal(classifyTestOrderCreation(lost).creation, "ambiguous");

  // DNS/reset/abort on the create: the server may still have processed it.
  const networkFailed = {
    ok: false,
    error: "order create request failed: net::ERR_CONNECTION_RESET",
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ failed: [{ url: ORDERS_API, failure: "net::ERR_CONNECTION_RESET" }] }),
  };
  assert.equal(classifyTestOrderCreation(networkFailed).creation, "ambiguous");

  for (const attempt of [lost, networkFailed]) {
    const runner = scriptedRunner([{ submits: true, attempt }]);
    await dispatch({ runner });
    assert.equal(runner.submissions.length, 1);
    assert.equal(runner.calls.length, 1);
  }
});

test("a 4xx after an earlier 2xx create is ambiguous, not a licence to buy again", async () => {
  // waitForCheckoutResult treats the MOST RECENT create response as decisive,
  // so [201, 400] throws "order create rejected" while an order exists.
  const attempt = {
    ok: false,
    error: "order create rejected: HTTP 400",
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ responses: [createResponse(201), { status: 400, url: ORDERS_API, body: { detail: "duplicate" } }] }),
  };
  const classification = classifyTestOrderCreation(attempt);
  assert.equal(classification.creation, "ambiguous");
  assert.notEqual(classification.creation, "not_created");

  const runner = scriptedRunner([{ submits: true, attempt }]);
  await dispatch({ runner });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.submissions.length, 1);
});

test("a provably pre-submit failure keeps its one bounded re-run", async () => {
  // The 2026-09-06 transient-accept regression the retry exists for. Nothing
  // was submitted, so nothing was bought, so re-running is free.
  const attempt = preSubmitFailureAttempt();
  assert.equal(classifyTestOrderCreation(attempt).creation, "not_created");

  const runner = scriptedRunner([
    { submits: false, attempt },
    { submits: true, attempt: passedAttempt("ref-2") },
  ]);
  const { assertions, orders, creationBudget } = await dispatch({ runner });

  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.submissions, ["checkout"]);
  assert.equal(creationBudget.reserved, 1, "a re-run after a pre-submit failure creates at most one order in total");
  assert.equal(orders.length, 2);

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.status, "pass");
  // The retry ledger the previous behaviour established is preserved for the
  // one case that still earns a re-run.
  assert.equal(result.evidence.retry.attempts, 2);
  assert.equal(result.evidence.order_creation.action, "rerun");
});

test("an exhausted creation budget stops the run before the submit click", async () => {
  const runner = scriptedRunner([
    { submits: true, attempt: passedAttempt("ref-1") },
    { submits: true, attempt: passedAttempt("ref-2") },
  ]);
  const { assertions, creationBudget } = await dispatch({
    plans: ["checkout", "accept"],
    runner,
    args: { "max-order-creations": "1" },
  });

  assert.equal(creationBudget.limit, 1);
  // Proving the check is pre-submit and not post-hoc accounting: the second
  // path records zero submissions.
  assert.deepEqual(runner.submissions, ["checkout"]);
  assert.equal(creationBudget.reserved, 1);

  const stopped = testOrderAssertionFor(assertions, "accept");
  assert.equal(stopped.status, "fail");
  assert.match(stopped.actual, /budget/i);
  assert.equal(stopped.evidence.order_creation_budget.limit, 1);
  assert.equal(stopped.evidence.order_creation_budget.reserved, 1);
});

test("a budget stop is not reported as a broken checkout", async () => {
  const runner = scriptedRunner([
    { submits: true, attempt: passedAttempt("ref-1") },
    { submits: true, attempt: passedAttempt("ref-2") },
  ]);
  const { assertions } = await dispatch({
    plans: ["checkout", "accept"],
    runner,
    args: { "max-order-creations": "1" },
  });
  const stopped = testOrderAssertionFor(assertions, "accept");

  // A supervisor reading this must not dispatch a checkout repair for a safety
  // stop the runner chose. Its text and evidence differ from a submit failure.
  assert.match(stopped.evidence.order_creation_budget.note, /safety stop/i);
  assert.doesNotMatch(stopped.actual, /order not created/);

  const genuine = testOrderAssertion(CHECKOUT_PAGE, "accept", preSubmitFailureAttempt());
  assert.equal(genuine.evidence.order_creation_budget, undefined);
  assert.notEqual(genuine.actual, stopped.actual);
});

test("a hosted-checkout manual review is not re-run, and it consumes a creation slot", async () => {
  const attempt = {
    ok: false,
    manual_review: true,
    error: null,
    submit: { reserved: false },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      outcome: "manual_review",
      hosted_checkout_url: "https://pay.example/hosted",
      final_url: "https://pay.example/hosted",
      verification: { verified: false, hosted_redirect: true },
      evidence: { steps: PRE_SUBMIT_STEPS },
    },
    events: eventLog(),
  };
  const runner = scriptedRunner([{ submits: false, attempt }]);
  const { assertions, creationBudget } = await dispatch({ runner });

  assert.equal(runner.calls.length, 1, "a hosted redirect is platform-owned, not a flake");
  // The platform may have created an order behind the redirect, so the budget
  // counts it rather than pretending the run is still at zero.
  assert.equal(creationBudget.reserved, 1);
  assert.equal(testOrderAssertionFor(assertions).status, "manual_review");
});

test("two concurrent runs against distinct targets hold separate budgets", async () => {
  const first = scriptedRunner([
    { submits: true, attempt: passedAttempt("ref-a1") },
    { submits: true, attempt: passedAttempt("ref-a2") },
  ]);
  const second = scriptedRunner([
    { submits: true, attempt: passedAttempt("ref-b1") },
    { submits: true, attempt: passedAttempt("ref-b2") },
  ]);

  const [a, b] = await Promise.all([
    dispatch({ plans: ["checkout", "accept"], runner: first, args: { "max-order-creations": "1" } }),
    dispatch({ plans: ["checkout", "accept"], runner: second }),
  ]);

  // Exhausting one run's budget must not decrement or block the other. This is
  // the test that fails the moment the budget becomes module-level state.
  assert.deepEqual(first.submissions, ["checkout"]);
  assert.deepEqual(second.submissions, ["checkout", "accept"]);
  assert.equal(a.creationBudget.reserved, 1);
  assert.equal(b.creationBudget.reserved, 2);
  assert.equal(b.creationBudget.limit, 2, "the default budget is one creation per planned path");
});

test("the run's durable evidence reconciles creations against test_orders[]", async () => {
  const runner = scriptedRunner([
    { submits: true, attempt: receiptFailureAttempt() },
    { submits: false, attempt: preSubmitFailureAttempt() },
    { submits: true, attempt: passedAttempt("ref-2") },
  ]);
  const recovery = clearedRecovery();
  const { assertions, orders, creationBudget } = await dispatch({
    plans: ["checkout", "accept"],
    runner,
    recovery,
  });

  const created = orders.filter((order) => order?.ref_id);
  assert.equal(creationBudget.reserved, created.length);

  const recovered = testOrderAssertionFor(assertions, "checkout");
  assert.equal(recovered.evidence.order_creation.submissions_reserved, 1);
  assert.equal(recovered.evidence.recovery.cleared, true);
  assert.match(recovered.evidence.recovery.original_error, /receipt line items/);
  assert.equal(recovered.evidence.recovery.checks.length, 1);
  assert.equal(recovered.evidence.ref_id, "ref-1");

  const rerun = testOrderAssertionFor(assertions, "accept");
  assert.equal(rerun.evidence.order_creation.submissions_reserved, 1);
  assert.equal(rerun.evidence.retry.attempts, 2);

  const totalCreations = [recovered, rerun]
    .reduce((sum, entry) => sum + entry.evidence.order_creation.submissions_reserved, 0);
  assert.equal(totalCreations, created.length);
});

test("the budget refuses to be talked past, whoever asks", () => {
  const budget = createOrderCreationBudget({ plans: plannedPlans(2), args: {} });
  assert.equal(budget.limit, 2);
  budget.reserve({ plan_id: "checkout" });
  budget.reserve({ plan_id: "accept" });
  assert.throws(() => budget.reserve({ plan_id: "decline" }), /budget/i);
  assert.equal(budget.reserved, 2);

  // An explicit operator raise is the only way past it.
  const raised = createOrderCreationBudget({ plans: plannedPlans(2), args: { "max-order-creations": "3" } });
  assert.equal(raised.limit, 3);
});

// --- The evidence window a safety decision is allowed to read from -----------

// Everything the runner carries onwards has been through `sanitizedEvents`,
// which keeps the last 20 entries per stream. On a multi-offer path the upsell
// and cart traffic that FOLLOWS a successful create pushes that create out of
// the retained window, so a classifier reading the truncated copy would see a
// bare rejection, call the path not_created, and submit again against a store
// that already holds the order. The counts are therefore taken once, from the
// whole log, and travel on the result as `order_creates`.
function noisyCreateLog() {
  const responses = [
    createResponse(201),
    ...Array.from({ length: 19 }, (_, index) => ({
      status: 200,
      url: `https://api.example/api/v1/upsells/${index}/`,
      body: { ok: true },
    })),
    { status: 422, url: ORDERS_API, body: { detail: "already placed" } },
  ];
  return eventLog({ responses });
}

function truncate(events) {
  return {
    requests: events.requests.slice(-20),
    responses: events.responses.slice(-20),
    failed: events.failed.slice(-20),
    console: [],
    pageErrors: [],
    navigations: [],
  };
}

test("a successful create evicted from the sanitized window still counts", () => {
  const full = noisyCreateLog();
  const summary = summarizeOrderCreateActivity(full);
  assert.equal(summary.accepted_create_responses, 1);
  assert.equal(summary.rejected_create_responses, 1);
  assert.equal(summary.observed_ref_id, "ref-1");

  // The fact the durable summary exists to survive: after truncation the 201 is
  // simply gone from the log, and no amount of re-reading it brings it back.
  const sanitized = truncate(full);
  assert.equal(sanitized.responses.length, 20);
  assert.equal(sanitized.responses.some((response) => response.status === 201), false);
});

test("an order created before 20 more responses is ambiguous, not a licence to buy again", async () => {
  const full = noisyCreateLog();
  const attempt = {
    ok: false,
    // What `waitForCheckoutResult` throws: the most recent create decides.
    error: "order create rejected: HTTP 422",
    submit: { reserved: true },
    // The value `failedTestOrderResult` always writes, whatever the platform said.
    order_creates: summarizeOrderCreateActivity(full),
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false },
      evidence: { steps: SUBMITTED_STEPS, events: truncate(full) },
    },
    events: truncate(full),
  };

  const classification = classifyTestOrderCreation(attempt);
  assert.equal(classification.creation, "ambiguous");
  // The operator gets something to search for, from the create the platform
  // accepted, even though the failed order row carries no ref id.
  assert.equal(classification.ref_id, "ref-1");

  const runner = scriptedRunner([{ submits: true, attempt }]);
  const { assertions } = await dispatch({ runner });
  assert.deepEqual(runner.submissions, ["checkout"], "the path that already created an order is never submitted twice");
  assert.equal(runner.calls.length, 1);

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.evidence.order_creation.classification, "ambiguous");
  assert.equal(result.evidence.order_creation.action, "stopped");
  assert.equal(result.evidence.order_creation.ref_id, "ref-1");
});

// --- A re-run may not spend a slot a planned path still needs ----------------

function rejectedCreateAttempt(id) {
  return {
    ok: false,
    error: "order create rejected (HTTP 422)",
    submit: { reserved: true },
    order_creates: { create_requests: 1, accepted_create_responses: 0, rejected_create_responses: 1, failed_create_requests: 0 },
    order: {
      path: id,
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false, error: "order create rejected (HTTP 422)" },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ responses: [{ status: 422, url: ORDERS_API, body: { detail: "rejected" } }] }),
  };
}

test("a rejected create does not eat the budget a later planned path needs", async () => {
  // A rejected create is provably not_created, so it is re-run-eligible — but
  // re-running it submits a SECOND time, and under the default budget (one
  // creation per planned path) that slot belongs to a path that has not run
  // yet. The re-run is the thing that yields, never the planned path.
  const runner = scriptedRunner([
    { submits: true, attempt: rejectedCreateAttempt("checkout") },
    { submits: true, attempt: rejectedCreateAttempt("accept") },
    { submits: true, attempt: rejectedCreateAttempt("decline") },
  ]);
  const { assertions, creationBudget } = await dispatch({
    plans: ["checkout", "accept", "decline"],
    runner,
  });

  assert.deepEqual(runner.submissions, ["checkout", "accept", "decline"], "every planned path gets its attempt");
  assert.equal(creationBudget.reserved, 3);

  for (const id of ["checkout", "accept", "decline"]) {
    const result = testOrderAssertionFor(assertions, id);
    // Each path reports the failure it actually had, not a budget stop about a
    // path that demonstrably submitted.
    assert.equal(result.actual, "order create rejected (HTTP 422)");
    assert.equal(result.evidence.order_creation_budget, undefined);
    assert.equal(result.evidence.order_creation.action, "rerun_skipped");
    assert.match(result.evidence.order_creation.rerun_skipped, /budget/i);
    assert.equal(result.evidence.order_creation.submissions_reserved, 1);
  }
});

test("a pre-submit failure still re-runs when the budget has room to spare", async () => {
  // The guard bounds re-runs by remaining budget, not by forbidding them: a
  // pre-submit failure reserved nothing, so the slot this path was given is
  // still unspent and the 2026-09-06 transient case is still answered.
  const runner = scriptedRunner([
    { submits: false, attempt: preSubmitFailureAttempt() },
    { submits: true, attempt: passedAttempt("ref-2") },
    { submits: true, attempt: passedAttempt("ref-3") },
  ]);
  const { assertions, creationBudget } = await dispatch({ plans: ["checkout", "accept"], runner });

  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.submissions, ["checkout", "accept"]);
  assert.equal(creationBudget.reserved, 2);
  assert.equal(testOrderAssertionFor(assertions, "checkout").evidence.retry.attempts, 2);
  assert.equal(testOrderAssertionFor(assertions, "accept").status, "pass");
});

test("a re-run that stops on the budget never becomes the deciding result", async () => {
  // Defence in depth for the seam: whatever the re-run does, a stop it chose
  // proves nothing about the checkout, so it must not erase the real failure
  // the first attempt recorded — or report "nothing was submitted" about a
  // path that did submit.
  const first = preSubmitFailureAttempt();
  const runner = scriptedRunner([
    { submits: false, attempt: first },
    {
      submits: false,
      attempt: {
        ok: false,
        budget_exhausted: true,
        error: "order-creation budget exhausted: 1 of 1 real order creation(s) already reserved in this run.",
        submit: { reserved: false },
        order: { path: "checkout", ok: false, ref_id: null, evidence: { steps: PRE_SUBMIT_STEPS } },
        events: eventLog(),
      },
    },
  ]);
  const { assertions } = await dispatch({ runner });

  const result = testOrderAssertionFor(assertions);
  assert.equal(result.actual, first.error);
  assert.doesNotMatch(result.actual, /budget/i);
  assert.equal(result.evidence.order_creation_budget, undefined, "a budget stop on the re-run is not this path's verdict");
  assert.equal(result.evidence.retry, undefined, "an attempt that never submitted is not a recorded retry");
  assert.match(result.evidence.order_creation.rerun_skipped, /budget/i);
});

// --- What the counts mean --------------------------------------------------
//
// A reservation is a slot spent immediately BEFORE the submit click. It stands
// whether or not the create that followed succeeded, which is the property that
// makes it safe — and the property that makes it a bad answer to "did this path
// create an order?". The assertion carries both numbers so an operator never
// has to guess which question they are reading.

test("a spent reservation with no accepted create reports zero confirmed orders", async () => {
  // The create was sent and failed at the network level: the platform may hold
  // the order, so the slot is spent and the path is ambiguous — but nothing was
  // OBSERVED to be created, and the evidence must not imply otherwise.
  const attempt = {
    ok: false,
    error: "order create failed at the network level",
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: CHECKOUT_PAGE.url,
      verification: { verified: false },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog({ failed: [{ url: ORDERS_API }] }),
  };
  const runner = scriptedRunner([{ submits: true, attempt }]);
  const { assertions, creationBudget } = await dispatch({ runner });

  const creation = testOrderAssertionFor(assertions).evidence.order_creation;
  assert.equal(creation.classification, "ambiguous");
  assert.equal(creation.submissions_reserved, 1, "the slot was spent before the click and stays spent");
  assert.equal(creation.orders_confirmed_created, 0, "nothing was observed to be created");
  assert.equal(creationBudget.reserved, 1);
});

test("a confirmed create is reported as a confirmed order, not only as a spent slot", async () => {
  const runner = scriptedRunner([{ submits: true, attempt: receiptFailureAttempt() }]);
  const { assertions } = await dispatch({ runner, recovery: clearedRecovery() });

  const creation = testOrderAssertionFor(assertions).evidence.order_creation;
  assert.equal(creation.submissions_reserved, 1);
  assert.equal(creation.orders_confirmed_created, 1);
});

test("a recovered path counts the one order it already has, never the recovery pass", async () => {
  // Recovery re-reads the created order. Counting the deciding result as a
  // fresh attempt would report two orders for one purchase — the exact
  // over-count the read-only pass exists to avoid.
  const runner = scriptedRunner([{ submits: true, attempt: receiptFailureAttempt() }]);
  const { assertions } = await dispatch({ runner, recovery: clearedRecovery() });

  assert.equal(testOrderAssertionFor(assertions).evidence.order_creation.orders_confirmed_created, 1);
  assert.equal(confirmedOrderCreates([]), 0);
});

test("a hosted-checkout manual review charges the budget even after a reserved submit", async () => {
  // The inner guard this replaces skipped the charge whenever the submit seam
  // had already reserved. A redirect that follows a reservation can still leave
  // a platform-created order out of this runner's sight, so the documented
  // "a manual review charges the budget" holds with no exception.
  const attempt = {
    ok: false,
    manual_review: true,
    error: null,
    submit: { reserved: true },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      outcome: "manual_review",
      hosted_checkout_url: "https://pay.example/hosted",
      final_url: "https://pay.example/hosted",
      verification: { verified: false, hosted_redirect: true },
      evidence: { steps: SUBMITTED_STEPS },
    },
    events: eventLog(),
  };
  const runner = scriptedRunner([{ submits: true, attempt }]);
  const { assertions, creationBudget } = await dispatch({ runner, args: { "max-order-creations": "3" } });

  assert.equal(creationBudget.reserved, 2, "the submit slot and the redirect are different risks");
  assert.equal(testOrderAssertionFor(assertions).status, "manual_review");
  assert.equal(runner.calls.length, 1, "a hosted redirect is still never re-run");
});

// --- The flag, at the surface it is typed at --------------------------------
//
// The value used to travel as a raw string into the browser runner and only
// become a number there, where anything non-numeric or non-positive quietly
// became the default budget. A bound that silently ignores what the operator
// typed is worse than no bound: the run places the default number of real
// orders while the operator believes they capped it.

const { validatedOrderCreationLimit } = __qaNodeTestHooks;

test("an unusable --max-order-creations is refused at the qa run entry", () => {
  for (const value of ["foo", "", "1.5", true]) {
    assert.throws(
      () => validatedOrderCreationLimit({ "max-order-creations": value }),
      /--max-order-creations/,
      `expected ${JSON.stringify(value)} to be refused`,
    );
  }
  assert.throws(() => validatedOrderCreationLimit({ "max-order-creations": "-3" }), /must not be negative/);
  assert.throws(() => validatedOrderCreationLimit({ "max-order-creations": "0" }), /--test-order off/);
});

test("a usable --max-order-creations is returned, and an absent one defers", () => {
  assert.equal(validatedOrderCreationLimit({ "max-order-creations": "2" }), 2);
  assert.equal(validatedOrderCreationLimit({ "max-order-creations": 2 }), 2);
  assert.equal(validatedOrderCreationLimit({}), null, "absent defers to the planned path count");
});

test("the budget itself refuses an unusable limit, whichever subcommand built it", () => {
  // The check lives on the budget rather than on a subcommand. Validating it at
  // the `qa run` entry alone left `qa parity` reaching the same runner by its
  // own route and inheriting the silent default this bound exists to remove.
  for (const value of ["foo", "-3", "0"]) {
    assert.throws(
      () => createOrderCreationBudget({ plans: plannedPlans(2), args: { "max-order-creations": value } }),
      /--max-order-creations/,
      `expected ${JSON.stringify(value)} to be refused`,
    );
  }
  assert.equal(createOrderCreationBudget({ plans: plannedPlans(2), args: { "max-order-creations": "1" } }).limit, 1);
  assert.equal(createOrderCreationBudget({ plans: plannedPlans(2), args: {} }).limit, 2, "absent defers to the planned path count");
});

test("qa parity refuses an unusable --max-order-creations before it loads anything", async () => {
  // The reachable regression: this subcommand does not go through runQa, so it
  // used to fall through to the planned-path default for any unusable value.
  await assert.rejects(
    runQaCli({ _: ["qa", "parity"], fixture: "unused.json", scenario: "unused", "max-order-creations": "foo" }),
    /--max-order-creations/,
  );
  // Named before the fixture it never has to read, so a typo costs nothing.
  await assert.rejects(
    runQaCli({ _: ["qa", "parity"], "max-order-creations": "-3" }),
    /--max-order-creations/,
  );
  // A parity run with no such flag still reaches its own required-input errors.
  await assert.rejects(runQaCli({ _: ["qa", "parity"] }), /--fixture/);
});
