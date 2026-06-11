import test from "node:test";
import assert from "node:assert/strict";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";

const { TEST_ORDER_STEP_LADDER, createStepLadder, formatStepEvent, hostedRedirectInfo, redactUrlQuery, testOrderAssertion } = __qaBrowserTestHooks;

test("step ladder declares the canonical ordered step names", () => {
  assert.deepEqual([...TEST_ORDER_STEP_LADDER], [
    "opened_checkout",
    "selected_bundle",
    "bump_state",
    "customer_fields_filled",
    "card_fields_filled",
    "cart_created",
    "hosted_redirect_observed",
    "order_submitted",
    "upsell_action",
    "receipt_reached",
  ]);
});

test("ladder records ok steps incrementally and emits one progress line per step", async () => {
  const lines = [];
  const ladder = createStepLadder({ emit: (line) => lines.push(line) });

  await ladder.run("opened_checkout", async () => {}, { timeoutMs: 1000 });
  assert.equal(ladder.steps.length, 1, "step appended as soon as it finishes");
  await ladder.run("selected_bundle", async () => "default bundle selection", { timeoutMs: 1000 });

  assert.equal(ladder.steps[0].step, "opened_checkout");
  assert.equal(ladder.steps[0].status, "ok");
  assert.ok(typeof ladder.steps[0].started_at === "string");
  assert.ok(Number.isFinite(ladder.steps[0].duration_ms));
  assert.equal(ladder.steps[1].detail, "default bundle selection", "resolved string becomes the step detail");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[qa:test-order\] step=opened_checkout status=ok \d+ms$/);
});

test("ladder records failures with the error and rethrows so the path aborts", async () => {
  const ladder = createStepLadder({ emit: () => {} });
  await assert.rejects(
    ladder.run("customer_fields_filled", async () => {
      throw new Error("Target page, context or browser has been closed");
    }, { timeoutMs: 1000 }),
    /has been closed/,
  );
  assert.equal(ladder.steps.length, 1, "failed step is still recorded");
  assert.equal(ladder.steps[0].status, "failed");
  assert.match(ladder.steps[0].error, /has been closed/);
});

test("ladder bounds each step: a hung step records timeout instead of hanging forever", async () => {
  const ladder = createStepLadder({ emit: () => {} });
  await assert.rejects(
    ladder.run("order_submitted", () => new Promise((resolve) => setTimeout(resolve, 250)), { timeoutMs: 25 }),
    /timed out after 25ms/,
  );
  assert.equal(ladder.steps[0].status, "timeout");

  // Exhausted overall order budget (timeoutMs <= 0) also records a timeout.
  await assert.rejects(
    ladder.run("upsell_action", async () => {}, { timeoutMs: -1 }),
    /order timeout budget exhausted/,
  );
  assert.equal(ladder.steps[1].status, "timeout");
});

test("ladder supports skipped steps with reasons, via skip() and { skip } results", async () => {
  const ladder = createStepLadder({ emit: () => {} });
  ladder.skip("upsell_action", "path has no upsell steps");
  await ladder.run("cart_created", async () => ({ skip: "no cart API call observed" }), { timeoutMs: 1000 });

  assert.deepEqual(ladder.steps.map((entry) => [entry.step, entry.status, entry.detail]), [
    ["upsell_action", "skipped", "path has no upsell steps"],
    ["cart_created", "skipped", "no cart API call observed"],
  ]);
  assert.equal(ladder.has("upsell_action"), true);
  assert.equal(ladder.has("receipt_reached"), false);
});

test("format of the progress event line is stable", () => {
  assert.equal(
    formatStepEvent({ step: "customer_fields_filled", status: "ok", duration_ms: 1240 }),
    "[qa:test-order] step=customer_fields_filled status=ok 1240ms",
  );
});

test("hosted redirect detection: different origin + /accounts/complete-order/ path, query redacted", () => {
  const checkoutUrl = "https://preview.netlify.app/recovery-relief-stack-v1/checkout/";
  const hosted = hostedRedirectInfo(
    "https://keer.29next.store/accounts/complete-order/?order_token=SECRET&ref_id=abc",
    checkoutUrl,
  );
  assert.equal(hosted.origin, "https://keer.29next.store");
  assert.equal(hosted.redacted_url, "https://keer.29next.store/accounts/complete-order/");
  assert.doesNotMatch(hosted.redacted_url, /SECRET/);

  // same origin → not a hosted handoff
  assert.equal(hostedRedirectInfo("https://preview.netlify.app/accounts/complete-order/", checkoutUrl), null);
  // different origin but not the hosted path → not a hosted handoff
  assert.equal(hostedRedirectInfo("https://keer.29next.store/upsell/", checkoutUrl), null);
  assert.equal(hostedRedirectInfo(null, checkoutUrl), null);
});

test("redactUrlQuery strips query strings and tolerates non-URLs", () => {
  assert.equal(redactUrlQuery("https://a.test/receipt/?ref_id=01ABC"), "https://a.test/receipt/");
  assert.equal(redactUrlQuery("not a url?x=1"), "not a url");
});

test("hosted-checkout path maps to a manual_review assertion with the step ladder, not a blocker", () => {
  const checkoutPage = { page_id: "checkout", page_type: "checkout", url: "https://preview.netlify.app/c/checkout/" };
  const steps = [
    { step: "opened_checkout", status: "ok", started_at: "2026-06-11T00:00:00.000Z", duration_ms: 900 },
    { step: "order_submitted", status: "ok", started_at: "2026-06-11T00:00:05.000Z", duration_ms: 4000 },
    { step: "hosted_redirect_observed", status: "ok", started_at: "2026-06-11T00:00:09.000Z", duration_ms: 0, detail: "redirected to hosted checkout: https://keer.29next.store/accounts/complete-order/" },
    { step: "upsell_action", status: "skipped", started_at: "2026-06-11T00:00:09.000Z", duration_ms: 0, detail: "hosted checkout flow is platform-owned; typed-card runner stops at the handoff" },
  ];
  const result = testOrderAssertion(checkoutPage, "checkout", {
    ok: false,
    manual_review: true,
    error: null,
    order: {
      path: "checkout",
      ok: false,
      outcome: "manual_review",
      hosted_checkout_url: "https://keer.29next.store/accounts/complete-order/",
      final_url: "https://keer.29next.store/accounts/complete-order/",
      evidence: { steps },
    },
  });

  assert.equal(result.status, "manual_review");
  assert.equal(result.severity, "warn");
  assert.match(result.actual, /hosted checkout redirect observed/);
  assert.deepEqual(result.evidence.steps, steps);
});

test("failed path maps to a blocker assertion that carries the step ladder up to the failure", () => {
  const checkoutPage = { page_id: "checkout", page_type: "checkout", url: "https://preview.netlify.app/c/checkout/" };
  const steps = [
    { step: "opened_checkout", status: "ok", started_at: "2026-06-11T00:00:00.000Z", duration_ms: 900 },
    { step: "customer_fields_filled", status: "failed", started_at: "2026-06-11T00:00:02.000Z", duration_ms: 310, error: "Target page, context or browser has been closed" },
  ];
  const result = testOrderAssertion(checkoutPage, "accept", {
    ok: false,
    error: "Target page, context or browser has been closed",
    order: {
      path: "accept",
      ok: false,
      final_url: null,
      verification: { verified: false, error: "Target page, context or browser has been closed" },
      evidence: { steps, events: {} },
    },
    events: {},
  });

  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.deepEqual(result.evidence.steps, steps);
});
