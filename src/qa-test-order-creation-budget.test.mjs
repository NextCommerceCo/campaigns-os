import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { computeDisposition } from "./qa-verdict.mjs";

const {
  classifyTestOrderCreation,
  createOrderCreationBudget,
  dispatchTestOrderPlans,
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
  assert.equal(result.evidence.order_creation.creation_count, 1);
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
  assert.equal(result.evidence.order_creation.creation_count, 1);

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
  assert.equal(result.evidence.order_creation.creation_count, 1);
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
  assert.equal(recovered.evidence.order_creation.creation_count, 1);
  assert.equal(recovered.evidence.recovery.cleared, true);
  assert.match(recovered.evidence.recovery.original_error, /receipt line items/);
  assert.equal(recovered.evidence.recovery.checks.length, 1);
  assert.equal(recovered.evidence.ref_id, "ref-1");

  const rerun = testOrderAssertionFor(assertions, "accept");
  assert.equal(rerun.evidence.order_creation.creation_count, 1);
  assert.equal(rerun.evidence.retry.attempts, 2);

  const totalCreations = [recovered, rerun]
    .reduce((sum, entry) => sum + entry.evidence.order_creation.creation_count, 0);
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
