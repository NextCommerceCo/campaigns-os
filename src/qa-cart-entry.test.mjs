import test from "node:test";
import assert from "node:assert/strict";

import {
  CART_ENTRY_CODES,
  CART_ENTRY_STEP,
  assessCartBeforeSubmit,
  chooseCartEntryControl,
  codedError,
  isCartEntryCode,
  resolveCartEntryPage,
  summarizeSelectionSurface,
} from "./qa-cart-entry.mjs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";

const { classifyTestOrderCreation, createOrderCreationBudget, dispatchTestOrderPlans, TEST_ORDER_STEP_LADDER } = __qaBrowserTestHooks;

const BASE = "https://campaign.example";
const checkout = { page_id: "checkout", page_type: "checkout", order: 3, url: `${BASE}/checkout/`, expected_next_url: `${BASE}/upsell-1/` };

function topology(pages) {
  return [{ funnel_id: "default", pages }];
}

test("the entry step is the first rung of the ladder", () => {
  assert.equal(TEST_ORDER_STEP_LADDER[0], CART_ENTRY_STEP);
  assert.equal(TEST_ORDER_STEP_LADDER[1], "opened_checkout");
});

test("entry resolves to the page that routes into checkout, preferring the selector page over a presell", () => {
  const presell = { page_id: "presell", page_type: "presell", order: 1, url: `${BASE}/presell/`, expected_next_url: `${BASE}/checkout/` };
  const select = { page_id: "select", page_type: "select", order: 2, url: `${BASE}/select/`, expected_next_url: `${BASE}/checkout/` };
  const entry = resolveCartEntryPage(topology([presell, select, checkout]), checkout);
  assert.deepEqual(entry, { page_id: "select", page_type: "select", url: `${BASE}/select/`, resolution: "routes_into_checkout" });
});

test("entry falls back to the entry-like page when nothing declares the checkout as its next page", () => {
  const landing = { page_id: "landing", page_type: "landing", order: 1, url: `${BASE}/`, expected_next_url: null };
  const entry = resolveCartEntryPage(topology([landing, checkout]), checkout);
  assert.equal(entry.page_id, "landing");
  assert.equal(entry.resolution, "entry_page_fallback");
});

test("a receipt or an offer page is never the cart entry, whatever the fallback order says", () => {
  const upsell = { page_id: "upsell-1", page_type: "upsell", order: 4, url: `${BASE}/upsell-1/` };
  const receipt = { page_id: "receipt", page_type: "receipt", order: 5, url: `${BASE}/receipt/` };
  assert.equal(resolveCartEntryPage(topology([checkout, upsell, receipt]), checkout), null);
  assert.equal(resolveCartEntryPage(topology([checkout]), checkout), null);
  assert.equal(resolveCartEntryPage([], checkout), null);
  assert.equal(resolveCartEntryPage(topology([checkout]), null), null);
});

test("a page after the checkout is not an entry even when typed like one", () => {
  const late = { page_id: "landing-2", page_type: "landing", order: 9, url: `${BASE}/landing-2/` };
  assert.equal(resolveCartEntryPage(topology([checkout, late]), checkout), null);
});

test("multi-funnel: the checkout's own funnel supplies the entry page", () => {
  const otherLanding = { page_id: "b-landing", page_type: "landing", order: 1, url: `${BASE}/b/`, expected_next_url: `${BASE}/b/checkout/` };
  const otherCheckout = { page_id: "b-checkout", page_type: "checkout", order: 2, url: `${BASE}/b/checkout/` };
  const landing = { page_id: "a-landing", page_type: "landing", order: 1, url: `${BASE}/a/`, expected_next_url: `${BASE}/checkout/` };
  const entry = resolveCartEntryPage([
    { funnel_id: "b", pages: [otherLanding, otherCheckout] },
    { funnel_id: "a", pages: [landing, checkout] },
  ], checkout);
  assert.equal(entry.page_id, "a-landing");
});

const visibleAction = { index: 0, kind: "add_to_cart", visible: true, text: "Claim", package_id: "1", next_url: "/checkout/" };
const hiddenAction = { index: 1, kind: "add_to_cart", visible: false, text: "Hidden", package_id: "2", next_url: "/checkout/" };
const link = { index: 2, kind: "checkout_link", visible: true, text: "Buy", package_id: "3", next_url: "/checkout/?forcePackageId=3:1" };

test("control choice prefers a visible SDK control, then a visible checkout link, then anything", () => {
  assert.equal(chooseCartEntryControl([hiddenAction, link, visibleAction]).control, visibleAction);
  assert.equal(chooseCartEntryControl([hiddenAction, link]).control, link);
  assert.equal(chooseCartEntryControl([hiddenAction]).control, hiddenAction);
  assert.match(chooseCartEntryControl([]).reason, /no add-to-cart control or forcePackageId checkout link/);
});

test("--select-package is strict on the entry page: the control must carry the ref", () => {
  const wanted = [{ packageId: "2", quantity: 1 }];
  assert.equal(chooseCartEntryControl([visibleAction, hiddenAction], wanted).control, hiddenAction);
  const miss = chooseCartEntryControl([visibleAction], [{ packageId: "7", quantity: 1 }]);
  assert.equal(miss.control, null);
  assert.match(miss.reason, /--select-package 7: no cart-entry control on the entry page carries package 7 \(rendered: 1\)/);
  const two = chooseCartEntryControl([visibleAction, hiddenAction], [{ packageId: "1" }, { packageId: "2" }]);
  assert.equal(two.control, null);
  assert.match(two.reason, /at most one package/);
});

test("the pre-submit guard trusts the SDK read first, the cart API second, and never guesses", () => {
  assert.deepEqual(assessCartBeforeSubmit({ readable: true, source: "window.next", count: 0, line_count: 0, package_ids: [] }), {
    empty: true, source: "window.next", count: 0, line_count: 0, package_ids: [],
  });
  assert.equal(assessCartBeforeSubmit({ readable: true, source: "window.next", count: 2, line_count: 1, package_ids: ["1"] }).empty, false);
  assert.deepEqual(assessCartBeforeSubmit({ readable: true, source: "window.next", count: 1, line_count: null, package_ids: [] }), {
    empty: false, source: "window.next", count: 1, line_count: null, package_ids: [],
  }, "without the debugger the unit count decides on its own");
  assert.deepEqual(assessCartBeforeSubmit({ readable: false }, { line_count: 0 }), {
    empty: true, source: "cart_api_response", count: null, line_count: 0, package_ids: [],
  });
  assert.equal(assessCartBeforeSubmit({ readable: false }, { line_count: 2 }).empty, false);
  const unknown = assessCartBeforeSubmit({ readable: false }, null);
  assert.equal(unknown.empty, false, "an unreadable cart is not proof of an empty one; the submit proceeds and the platform decides");
  assert.equal(unknown.unreadable, true);
});

test("selection-surface summary names what was found", () => {
  assert.equal(summarizeSelectionSurface({ kinds: { bundle_selector: 1, cart_selector: 0, package_card: 3 } }), "1 bundle_selector, 3 package_card");
  assert.equal(summarizeSelectionSurface({ kinds: {} }), "none");
});

test("coded errors carry the code on the error and in the message", () => {
  const error = codedError(CART_ENTRY_CODES.CART_EMPTY_BEFORE_SUBMIT, "SDK cart holds 0 item(s)");
  assert.equal(error.code, "cart_empty_before_submit");
  assert.match(error.message, /^cart_empty_before_submit: SDK cart holds 0 item\(s\)$/);
  assert.equal(isCartEntryCode("cart_empty_before_submit"), true);
  assert.equal(isCartEntryCode("step_timeout"), false);
});

// --- Budget semantics (#316) for the new refusals ---------------------------

function guardedAttempt(code, steps) {
  return {
    ok: false,
    error: `${code}: refused`,
    failure_code: code,
    submit: { reserved: false },
    order: {
      path: "checkout",
      ok: false,
      ref_id: null,
      final_url: `${BASE}/checkout/`,
      verification: { verified: false, error: `${code}: refused` },
      evidence: { steps },
    },
    events: { requests: [], responses: [], failed: [], console: [], pageErrors: [] },
  };
}

const step = (name, status, error = null) => ({ step: name, status, started_at: "2026-09-11T00:00:00.000Z", duration_ms: 1, ...(error ? { error } : {}) });

test("an empty-cart refusal classifies as not_created: no submit was recorded", () => {
  const attempt = guardedAttempt(CART_ENTRY_CODES.CART_EMPTY_BEFORE_SUBMIT, [
    step("entered_via_landing", "ok"),
    step("opened_checkout", "ok"),
    step("order_submitted", "failed", "cart_empty_before_submit: refused"),
  ]);
  const classification = classifyTestOrderCreation(attempt);
  assert.equal(classification.creation, "not_created");
  assert.equal(classification.signals.submitted, false, "the order_submitted step STARTED, but the submit seam says it never reserved");
});

test("an entry refusal classifies as not_created", () => {
  const attempt = guardedAttempt(CART_ENTRY_CODES.ENTRY_UNRESOLVED, [step("entered_via_landing", "failed", "cart_entry_unresolved: refused")]);
  assert.equal(classifyTestOrderCreation(attempt).creation, "not_created");
});

test("a guard refusal consumes no reservation and keeps the bounded re-run", async () => {
  const attempts = [];
  const runSingleTestOrder = async (context, checkoutPage, plan, args, runId, options) => {
    // The real runner reserves immediately before the submit click; the guard
    // throws before that line is reached, so a scripted attempt never calls
    // reserve() — that is the property under test.
    attempts.push(plan);
    return guardedAttempt(CART_ENTRY_CODES.CART_EMPTY_BEFORE_SUBMIT, [step("order_submitted", "failed", "cart_empty_before_submit: refused")]);
  };
  const creationBudget = createOrderCreationBudget({ plans: ["checkout"], args: {} });
  const dispatched = await dispatchTestOrderPlans({
    context: {},
    plans: ["checkout"],
    checkoutPage: checkout,
    args: {},
    options: { runSingleTestOrder, creationBudget },
  });
  assert.equal(attempts.length, 2, "not_created earns exactly one re-run");
  assert.equal(creationBudget.reserved, 0, "no creation slot was spent");
  const assertion = dispatched.assertions.find((entry) => entry.id === "browser-test-order:checkout");
  assert.equal(assertion.status, "fail");
  assert.equal(assertion.evidence.order_creation.classification, "not_created");
  assert.equal(assertion.evidence.order_creation.submissions_reserved, 0);
  assert.equal(assertion.evidence.order_creation.action, "rerun");
  assert.match(assertion.actual, /cart_empty_before_submit/);
});
