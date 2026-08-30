import test from "node:test";
import assert from "node:assert/strict";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { resolveTestOrderTopology } from "./qa-test-order-topology.mjs";

const {
  TEST_ORDER_STEP_LADDER,
  cartCreationEvidence,
  cartLineCount,
  createFieldTrace,
  createUpsellActionTrace,
  createStepLadder,
  fillCheckoutFields,
  requiredActionTimeout,
  formatStepEvent,
  hostedRedirectInfo,
  recordTestOrderTerminalEvidence,
  redactUrlQuery,
  testOrderAssertion,
  testOrderPlans,
} = __qaBrowserTestHooks;

test("step ladder declares the canonical ordered step names", () => {
  assert.deepEqual([...TEST_ORDER_STEP_LADDER], [
    "opened_checkout",
    "selected_bundle",
    "bump_state",
    "customer_fields_filled",
    "coupon_applied",
    "card_fields_filled",
    "cart_created",
    "hosted_redirect_observed",
    "order_submitted",
    "upsell_action",
    "receipt_reached",
    "receipt_rendered",
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

test("a common-selected shortcut receipt records receipt_reached as ok through runtime terminal evidence", () => {
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topologies = [{ funnel_id: "shortcut", pages: [
    { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell-1/") },
    { page_id: "upsell-1", page_type: "upsell", url: route("upsell-1/"), expected_accept_url: route("upsell-2/"), expected_decline_url: route("upsell-2/") },
    { page_id: "upsell-2", page_type: "upsell", url: route("upsell-2/"), expected_accept_url: route("receipt/"), expected_decline_url: route("downsell/") },
    { page_id: "downsell", page_type: "downsell", url: route("downsell/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
    { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
  ] }];
  const plan = testOrderPlans("common", topologies, {}).find((candidate) => candidate.path === "accept-accept");
  const ladder = createStepLadder({ emit: () => {} });

  const evidence = recordTestOrderTerminalEvidence({
    ladder,
    topologyPlan: plan.topology_plan,
    finalUrl: `${route("receipt/")}?ref_id=qa-secret`,
  });

  assert.equal(plan.path, "accept-accept");
  assert.equal(evidence.kind, "receipt");
  assert.equal(evidence.terminal.kind, "receipt");
  assert.deepEqual(
    ladder.steps.map(({ step, status, detail }) => ({ step, status, detail })),
    [{ step: "receipt_reached", status: "ok", detail: route("receipt/") }],
  );
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


// --- Step-ladder evidence: the structured seam, the customer/address-field
// trace written through it, and the cart-API observation that replaced a
// boolean "did any URL contain /carts/" probe.
//
// The behaviour-preservation tests here are deliberate: the field trace wraps a
// fill sequence whose ordering, progressive-disclosure calls and optional-field
// tolerance are load-bearing, and a wrapper is exactly the kind of change that
// regresses them silently.

const FIELD_SELECTOR = (field) => `[data-next-checkout-field="${field}"]`;

// A Playwright-shaped stub covering only what fillCheckoutFields touches.
// `fields` is keyed by checkout field name; anything unlisted is present and
// visible and accepts input.
function fakePage(fields = {}, extras = {}) {
  const calls = [];
  const configFor = (selector) => {
    const entry = Object.entries(fields).find(([field]) => selector === FIELD_SELECTOR(field));
    if (entry) return entry[1];
    if (selector.startsWith('.checkout-form--reveal')) return extras[selector] || { present: false };
    return extras[selector] || {};
  };
  const makeLocator = (selector) => {
    const cfg = configFor(selector);
    const present = () => (typeof cfg.present === "function" ? cfg.present() : cfg.present !== false);
    const locator = {
      first: () => locator,
      locator: (innerSelector) => makeLocator(`${selector} ${innerSelector}`),
      count: async () => (present() ? 1 : 0),
      // `visible` may be a thunk so a stub can model progressive disclosure:
      // a field that is hidden until the funnel reveals it.
      isVisible: async () => present() && (typeof cfg.visible === "function" ? cfg.visible() : cfg.visible !== false),
      waitFor: async () => {
        calls.push(`waitFor:${selector}`);
      },
      click: async () => {
        calls.push(`click:${selector}`);
        if (cfg.clickError) throw new Error(cfg.clickError);
        if (cfg.onClick) cfg.onClick();
      },
      check: async () => {
        calls.push(`check:${selector}`);
      },
      fill: async (value) => {
        calls.push(`fill:${selector}:${value}`);
        if (cfg.fillError) throw new Error(cfg.fillError);
      },
      selectOption: async (value) => {
        calls.push(`select:${selector}:${value}`);
        if (cfg.selectError) throw new Error(cfg.selectError);
      },
      pressSequentially: async (value) => {
        calls.push(`pressSequentially:${selector}:${value}`);
        if (cfg.onPressSequentially) cfg.onPressSequentially();
      },
      press: async (key) => {
        calls.push(`press:${selector}:${key}`);
      },
      evaluate: async (predicate) => predicate({
        hidden: cfg.hidden === true,
        inert: cfg.inert === true,
        getAttribute: (name) => (name === "aria-hidden" ? cfg.ariaHidden ?? null : null),
        classList: { contains: (name) => name === "billing-form-collapsed" && cfg.billingCollapsed === true },
        ownerDocument: {
          defaultView: {
            getComputedStyle: () => ({
              display: cfg.display || "block",
              visibility: cfg.visibility || "visible",
              pointerEvents: cfg.pointerEvents || "auto",
            }),
          },
        },
        parentElement: null,
      }),
      evaluateAll: async () => [],
    };
    return locator;
  };
  return {
    calls,
    page: {
      locator: makeLocator,
      waitForTimeout: async () => {},
    },
  };
}

test("ladder entries carry structured evidence, and a failing step still reports what it gathered", async () => {
  const ladder = createStepLadder({ emit: () => {} });

  ladder.ok("opened_checkout", "loaded", { url_kind: "campaign" });
  assert.deepEqual(ladder.steps[0].evidence, { url_kind: "campaign" });

  // Empty and non-object evidence never produces an empty `evidence` key.
  ladder.ok("selected_bundle", "default");
  assert.equal("evidence" in ladder.steps[1], false);
  ladder.skip("bump_state", "none", {});
  assert.equal("evidence" in ladder.steps[2], false);

  // The failure path resolves the thunk, so partial work survives the throw.
  const gathered = { fields: ["email"] };
  await assert.rejects(
    ladder.run("customer_fields_filled", async () => {
      gathered.fields.push("postal");
      throw new Error("boom");
    }, { timeoutMs: 1000, evidence: () => gathered }),
  );
  const failed = ladder.steps.at(-1);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.evidence, { fields: ["email", "postal"] });

  // A thunk that throws yields no evidence rather than masking the step result.
  ladder.ok("card_fields_filled", null, () => {
    throw new Error("evidence blew up");
  });
  assert.equal("evidence" in ladder.steps.at(-1), false);
});

test("a deep upsell timeout names the route, edge, action state, SDK readiness, and last browser evidence", async () => {
  const base = "https://campaign.example/";
  const route = (name) => new URL(name, base).toString();
  const topologyPlan = resolveTestOrderTopology({
    funnel_id: "deep-upsell",
    pages: [
      { page_id: "checkout", page_type: "checkout", url: route("checkout/"), expected_next_url: route("upsell-1/") },
      { page_id: "upsell-1", page_type: "upsell", url: route("upsell-1/"), expected_accept_url: route("upsell-2/"), expected_decline_url: route("receipt/") },
      { page_id: "upsell-2", page_type: "upsell", url: route("upsell-2/"), expected_accept_url: route("receipt/"), expected_decline_url: route("receipt/") },
      { page_id: "receipt", page_type: "thankyou", url: route("receipt/") },
    ],
  });
  const selector = '[data-next-upsell-action="add"]';
  let currentUrl = route("upsell-2/");
  const control = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
  };
  const page = {
    url: () => currentUrl,
    locator: (value) => {
      assert.equal(value, selector);
      return { first: () => control };
    },
    evaluate: async () => ({
      window_next_present: true,
      display_ready: true,
      sdk_loading: "false",
    }),
  };
  const events = {
    requests: [],
    responses: [],
    failed: [],
    console: [],
    pageErrors: [],
    navigations: [],
  };
  const trace = createUpsellActionTrace({
    page,
    events,
    topologyPlan,
    stepIndex: 1,
    path: "accept",
  });
  await trace.inspect();
  // The prior edge can finish settling after this trace is created. It is the
  // current route, not evidence that this edge's action handler ran.
  events.navigations.push({ url: route("upsell-2/") });
  trace.markClickAttempted();
  trace.markClickCompleted();

  currentUrl = route("receipt/");
  assert.equal(
    trace.summary().action_binding.observed,
    false,
    "URL drift without a captured main-frame navigation is not binding evidence",
  );
  currentUrl = route("upsell-2/");

  const ladder = createStepLadder({ emit: () => {} });
  let timeoutError = null;
  try {
    await ladder.run("upsell_action", () => new Promise(() => {}), {
      timeoutMs: 5,
      evidence: trace.summary,
      formatError: trace.formatError,
    });
  } catch (error) {
    timeoutError = error;
  }

  assert.ok(timeoutError);
  assert.match(timeoutError.message, /page_id=upsell-2/);
  assert.match(timeoutError.message, /edge=2/);
  assert.match(timeoutError.message, /action=add/);
  assert.match(timeoutError.message, /binding_observed=false/);
  const timedOut = ladder.steps[0];
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.error, timeoutError.message);
  assert.deepEqual(timedOut.evidence.route, {
    page_id: "upsell-2",
    page_type: "upsell",
    url: route("upsell-2/"),
  });
  assert.equal(timedOut.evidence.edge_index, 1);
  assert.equal(timedOut.evidence.edge_number, 2);
  assert.equal(timedOut.evidence.requested_action, "add");
  assert.equal(timedOut.evidence.selector, selector);
  assert.deepEqual(timedOut.evidence.element, { present: true, visible: true, enabled: true });
  assert.deepEqual(timedOut.evidence.sdk, {
    window_next_present: true,
    display_ready: true,
    sdk_loading: "false",
  });
  assert.deepEqual(timedOut.evidence.action_binding, {
    click_attempted: true,
    click_completed: true,
    observed: false,
    basis: [],
  });
  assert.deepEqual(timedOut.evidence.last_navigation, { url: route("upsell-2/") });
  assert.equal(timedOut.evidence.last_upsell_api_request, null);

  currentUrl = route("receipt/");
  events.navigations.push({ url: currentUrl });
  events.requests.push({ method: "POST", url: `${base}api/v1/orders/100/upsells/?token=redacted` });
  const progressed = trace.summary();
  assert.deepEqual(progressed.action_binding, {
    click_attempted: true,
    click_completed: true,
    observed: true,
    basis: ["navigation", "upsell_api_request"],
  });
  assert.deepEqual(progressed.last_navigation, { url: route("receipt/") });
  assert.deepEqual(progressed.last_upsell_api_request, {
    method: "POST",
    url: `${base}api/v1/orders/100/upsells/`,
  });

  trace.markStepCompleted();
  assert.equal(trace.summary(), null, "successful actions keep the established compact ladder shape");

  const assertion = testOrderAssertion(
    { page_id: "checkout", page_type: "checkout", url: route("checkout/") },
    "accept-accept",
    {
      ok: false,
      error: timeoutError.message,
      order: {
        path: "accept-accept",
        ok: false,
        final_url: route("upsell-2/"),
        verification: { verified: false, error: timeoutError.message },
        evidence: { steps: ladder.steps },
      },
      events,
    },
  );
  assert.match(assertion.actual, /page_id=upsell-2/);
  assert.equal(assertion.evidence.steps[0].evidence.action_binding.observed, false);
  assert.equal(assertion.evidence.steps[0].evidence.last_upsell_api_request, null);
});

test("a failing customer field names itself in the step evidence", async () => {
  const { page } = fakePage({ postal: { fillError: "element is not editable" } });
  const trace = createFieldTrace();

  await assert.rejects(() => fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace }));

  const summary = trace.summary();
  assert.equal(summary.blocking_field, "postal");
  assert.equal(summary.blocking_status, "failed");
  assert.equal(summary.coverage, "customer_and_address_fields");
  const postal = summary.fields.find((entry) => entry.field === "postal");
  assert.equal(postal.status, "failed");
  assert.match(postal.error, /not editable/);
  // Fields completed before the failure are recorded as ok, so the reader sees
  // how far the fill got — not just where it stopped.
  assert.equal(summary.fields.find((entry) => entry.field === "email").status, "ok");
});

test("a step that hangs mid-field leaves that field pending, which is what names it", async () => {
  const trace = createFieldTrace();
  let release;
  const stuck = new Promise((resolve) => {
    release = resolve;
  });

  const inflight = trace.inspect("city", "fill", () => stuck).catch(() => {});
  await Promise.resolve();
  // While the action is still in flight the entry is already on the trace.
  assert.equal(trace.summary().blocking_field, "city");
  assert.equal(trace.summary().blocking_status, "pending");
  release();
  await inflight;
});

test("optional fields stay best-effort: an unusable one is recorded, not thrown", async () => {
  // A visible optional billing field that refuses input is the exact shape that
  // must NOT become a blocker.
  const { page } = fakePage({
    phone: { present: false },
    "billing-city": { fillError: "intercepted by another element" },
  });
  const trace = createFieldTrace();

  await fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace });

  const summary = trace.summary();
  assert.equal(summary.fields.find((entry) => entry.field === "phone").status, "unusable");
  assert.equal(summary.fields.find((entry) => entry.field === "billing-city").status, "unusable");
  // Nothing blocking: an unusable optional field is not a failure.
  assert.equal("blocking_field" in summary, false);
});

test("progressive-address disclosure still runs when city starts hidden", async () => {
  // Models the real funnel: city is hidden until address1 is typed into.
  let cityRevealed = false;
  const { page, calls } = fakePage({
    city: { visible: () => cityRevealed },
    address1: { onPressSequentially: () => { cityRevealed = true; } },
  });

  await fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace: createFieldTrace() });

  // address1 is re-typed keystroke-by-keystroke to trigger the funnel's
  // disclosure, and city is then waited for.
  assert.ok(calls.some((call) => call.startsWith(`pressSequentially:${FIELD_SELECTOR("address1")}`)));
  assert.ok(calls.includes(`waitFor:${FIELD_SELECTOR("city")}`));
});

test("checkout reveal is opened before the first customer field is filled", async () => {
  const activeForm = '.checkout-form--reveal:not(.is-revealed)';
  const trigger = '.checkout-form--reveal:not(.is-revealed) [data-checkout-reveal-trigger]';
  const revealedPanel = '.checkout-form--reveal.is-revealed [data-checkout-reveal-panel]';
  let revealed = false;
  const { page, calls } = fakePage({}, {
    [activeForm]: { present: () => !revealed },
    [trigger]: { present: () => !revealed, onClick: () => { revealed = true; } },
    [revealedPanel]: { present: () => revealed, visible: () => revealed },
  });

  await fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace: createFieldTrace() });

  const revealClick = calls.indexOf(`click:${trigger}`);
  const firstFieldFill = calls.findIndex((call) => call.startsWith(`fill:${FIELD_SELECTOR("fname")}`));
  assert.ok(revealClick >= 0, "the canonical checkout reveal trigger was clicked");
  assert.ok(revealClick < firstFieldFill, "the reveal happened before customer-field interaction");
  assert.ok(calls.includes(`waitFor:${revealedPanel}`), "the prober waited for the revealed panel state");
});

test("a malformed active checkout reveal fails with reveal-specific evidence", async () => {
  const activeForm = '.checkout-form--reveal:not(.is-revealed)';
  const { page, calls } = fakePage({}, {
    [activeForm]: { present: true },
  });

  await assert.rejects(
    () => fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace: createFieldTrace() }),
    /Checkout reveal is active, but its reveal CTA is missing/,
  );
  assert.ok(!calls.some((call) => call.startsWith(`fill:${FIELD_SELECTOR("fname")}`)));
});

test("collapsed billing fields are skipped before any click timeout can start", async () => {
  const billingFieldNames = [
    "billing-fname",
    "billing-lname",
    "billing-phone",
    "billing-country",
    "billing-address1",
    "billing-city",
    "billing-province",
    "billing-postal",
  ];
  const fields = Object.fromEntries(billingFieldNames.map((field) => [field, { visible: true }]));
  fields["billing-fname"].pointerEvents = "none";
  const { page, calls } = fakePage(fields);
  const trace = createFieldTrace();

  await fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace });

  for (const field of Object.keys(fields)) {
    assert.ok(!calls.includes(`click:${FIELD_SELECTOR(field)}`), `${field} was not clicked`);
    assert.equal(trace.summary().fields.find((entry) => entry.field === field).status, "unusable");
  }
});

test("boolean-form aria-hidden collapses the canonical billing section", async () => {
  const fields = {
    "billing-fname": { visible: true, ariaHidden: "" },
    "billing-lname": { visible: true },
  };
  const { page, calls } = fakePage(fields);
  const trace = createFieldTrace();

  await fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace });

  assert.ok(!calls.includes(`click:${FIELD_SELECTOR("billing-fname")}`));
  assert.equal(trace.summary().fields.find((entry) => entry.field === "billing-fname").status, "unusable");
});

test("the customer/address fill sequence is unchanged by the trace wrapper", async () => {
  const { page, calls } = fakePage();
  await fillCheckoutFields(page, {}, "qa@campaigns-os.test", { trace: createFieldTrace() });

  const order = calls
    .filter((call) => call.startsWith("fill:") || call.startsWith("select:"))
    .map((call) => call.split(":")[1].replace(/\[data-next-checkout-field="(.*)"\]/, "$1"));
  assert.deepEqual(order.slice(0, 9), [
    "fname",
    "lname",
    "email",
    "phone",
    "country",
    "address1",
    "city",
    "province",
    "postal",
  ]);

  // The trace is optional: without one the fill still runs identically.
  const bare = fakePage();
  await fillCheckoutFields(bare.page, {}, "qa@campaigns-os.test");
  assert.deepEqual(bare.calls, calls);
});

test("cart observation reports status and line count, and ignores repricing calls", () => {
  const evidence = cartCreationEvidence({
    responses: [
      { status: 422, url: "https://api.example.test/api/v1/carts/calculate/", body: { lines: [1, 2, 3, 4] } },
      { status: 201, url: "https://api.example.test/api/v1/carts/", body: { lines: [{ id: 1 }, { id: 2 }] } },
    ],
  });

  assert.equal(evidence.status, 201);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.line_count, 2);
  assert.equal(evidence.response_count, 1);
  assert.match(evidence.url, /\/api\/v1\/carts\/$/);

  // A repricing call alone is not cart creation.
  assert.equal(cartCreationEvidence({
    responses: [{ status: 200, url: "https://api.example.test/api/v1/carts/calculate/", body: {} }],
  }), null);

  // No cart traffic at all → the step's documented skip path.
  assert.equal(cartCreationEvidence({ responses: [] }), null);
});

test("cart observation is query-tolerant and the latest create decides", () => {
  const withQuery = cartCreationEvidence({
    responses: [{ status: 201, url: "https://api.example.test/api/v1/carts/?expand=lines", body: { items: [{}] } }],
  });
  assert.equal(withQuery.status, 201);
  assert.equal(withQuery.line_count, 1);

  // A 500 retried into a 201 reports the 201, mirroring order-create handling.
  const retried = cartCreationEvidence({
    responses: [
      { status: 500, url: "https://api.example.test/api/v1/carts/", body: {} },
      { status: 201, url: "https://api.example.test/api/v1/carts/", body: { lines: [] } },
    ],
  });
  assert.equal(retried.status, 201);
  assert.equal(retried.line_count, 0);
  assert.equal(retried.response_count, 2);

  // A failing create is reported as failing, not hidden.
  const failing = cartCreationEvidence({
    responses: [{ status: 422, url: "https://api.example.test/api/v1/carts/", body: {} }],
  });
  assert.equal(failing.ok, false);
  // An unreadable body omits line_count rather than guessing zero.
  assert.equal("line_count" in failing, false);
});

test("cart line counts read the shapes the API actually returns", () => {
  assert.equal(cartLineCount({ lines: [1, 2] }), 2);
  assert.equal(cartLineCount({ items: [1] }), 1);
  assert.equal(cartLineCount({ cart: { lines: [1, 2, 3] } }), 3);
  assert.equal(cartLineCount({ data: { items: [] } }), 0);
  assert.equal(cartLineCount({ lines: "nope" }), null);
  assert.equal(cartLineCount(null), null);
});

test("the required-action timeout only ever tightens Playwright's default", () => {
  // No budget → no explicit timeout, i.e. today's behaviour.
  assert.deepEqual(requiredActionTimeout({}), {});
  assert.deepEqual(requiredActionTimeout({ actionTimeoutMs: 0 }), {});
  assert.deepEqual(requiredActionTimeout({ actionTimeoutMs: -1 }), {});
  // A budget under the default tightens.
  assert.deepEqual(requiredActionTimeout({ actionTimeoutMs: 9000 }), { timeout: 9000 });
  // A budget over the default is capped, never loosened.
  assert.deepEqual(requiredActionTimeout({ actionTimeoutMs: 120000 }), { timeout: 30000 });
});
