import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { computeDisposition } from "./qa-verdict.mjs";

const { testOrderAssertion, retryEvidence, shouldRetryTestOrder } = __qaBrowserTestHooks;

// Card 11. On 2026-09-06 `browser-test-order:accept` failed in 2 of 5 browser
// runs, each time on a build whose adjacent run passed the same path. The
// supervisor counted the miss as a new issue and reported no progress after a
// repair that had actually worked. The runner now re-runs a failed path once
// before recording it — and says so, either way.

const upsellPage = { page_id: "upsell-1", page_type: "upsell", url: "https://campaign.example/upsell/" };
const PLAN = { path: "accept", source: "spec", plan_id: "accept" };
const ACCEPT_ERROR = "expected upsell package(s) not found in final order lines; upsell accept did not call order upsell API";

function failedAttempt(error = ACCEPT_ERROR) {
  return { ok: false, error, order: { ref_id: "ref-first", path: "accept", final_url: upsellPage.url, evidence: { steps: [] } } };
}

function passedAttempt() {
  return {
    ok: true,
    order: {
      ref_id: "ref-second",
      next_order_id: "NC-1002",
      final_url: "https://campaign.example/receipt/",
      is_test: true,
      receipt_line_items: [{ title: "Upsell" }],
      card: { last4: "1117" },
      verification: { accepted_upsell_line_present: true },
    },
  };
}

test("no retry, no retry evidence: a first-time pass is byte-for-byte what it was", () => {
  assert.deepEqual(retryEvidence(null), {});
  const result = testOrderAssertion(upsellPage, PLAN, passedAttempt());
  assert.equal(result.status, "pass");
  assert.equal(result.evidence.retry, undefined);
});

test("a transient failure that does not reproduce passes, and still says it was retried", () => {
  const result = testOrderAssertion(upsellPage, PLAN, passedAttempt(), failedAttempt());

  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
  // The whole point: this must not be indistinguishable from a first-time pass.
  assert.equal(result.evidence.retry.attempts, 2);
  assert.equal(result.evidence.retry.first_attempt_status, "failed");
  assert.match(result.evidence.retry.first_attempt_error, /upsell accept did not call order upsell API/);
  assert.equal(result.evidence.retry.first_attempt_ref_id, "ref-first");

  // And the verdict-level consequence the card is really after: this path
  // contributes no blocker, so a repair that worked is not reported as no
  // progress.
  assert.equal(computeDisposition([result]), "ready");
});

test("a failure that reproduces still counts, and carries both attempts", () => {
  const result = testOrderAssertion(upsellPage, PLAN, failedAttempt(), failedAttempt());

  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.equal(result.evidence.retry.attempts, 2);
  assert.match(result.actual, /upsell accept did not call order upsell API/);
  assert.equal(computeDisposition([result]), "blocked");
});

test("the retry note points an operator at the second real order", () => {
  const result = testOrderAssertion(upsellPage, PLAN, passedAttempt(), failedAttempt());
  // A retry places a second real order on the store. Whoever cleans up test
  // orders has to be able to tell from the verdict that there are two.
  assert.match(result.evidence.retry.note, /Both orders are in test_orders\[\]/);
  assert.match(result.evidence.retry.note, /One retry per path per run/);
});

test("a first attempt with no error string still records why it was retried", () => {
  const bare = { ok: false, order: { ref_id: "ref-bare", verification: {} } };
  assert.equal(retryEvidence(bare).retry.first_attempt_error, "order not created");

  const verified = { ok: false, order: { ref_id: "ref-v", verification: { error: "card declined" } } };
  assert.equal(retryEvidence(verified).retry.first_attempt_error, "card declined");
});

// The retry decision decides whether a second REAL order is placed on a live
// store, and it lived inline in a browser loop no test could reach. A stray edit
// dropped the manual_review clause and nothing objected, while the changelog,
// the skill, the in-code comment and the PR all still described the old rule.
// It is a named predicate now, and these are its cases.

test("only a hard failure earns a retry", () => {
  assert.equal(shouldRetryTestOrder({ ok: true }), false);
  assert.equal(shouldRetryTestOrder({ ok: false }), true);
  assert.equal(shouldRetryTestOrder({ ok: false, error: "boom" }), true);
});

test("a manual_review is never retried", () => {
  // A hosted-checkout redirect is a platform-owned flow, not a flake. Re-running
  // it places another real order on the store and proves nothing.
  assert.equal(shouldRetryTestOrder({ ok: false, manual_review: true }), false);
  assert.equal(shouldRetryTestOrder({ ok: false, manual_review: true, order: { hosted_checkout_url: "https://pay.example/x" } }), false);
});

test("a missing attempt is not a retry candidate", () => {
  assert.equal(shouldRetryTestOrder(null), false);
  assert.equal(shouldRetryTestOrder(undefined), false);
});

test("recorded first-attempt status is computed, not asserted", () => {
  // Defence in depth: if the guard is ever loosened again, the ledger must not
  // describe a hosted-checkout redirect as a failure.
  assert.equal(retryEvidence({ ok: false, order: {} }).retry.first_attempt_status, "failed");
  assert.equal(
    retryEvidence({ ok: false, manual_review: true, order: {} }).retry.first_attempt_status,
    "manual_review"
  );
});
