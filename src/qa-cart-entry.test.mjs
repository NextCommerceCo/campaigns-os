import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  CART_ENTRY_CODES,
  CART_ENTRY_CONTROL_SELECTOR,
  CART_ENTRY_ROUTE_ATTRIBUTE,
  CART_ENTRY_STEP,
  assessCartBeforeSubmit,
  cartEntryHrefFor,
  cartEntryControlsScript,
  checkoutSelectionSurfaceScript,
  chooseCartEntryControl,
  codedError,
  isCartEntryCode,
  resolveCartEntryPage,
  summarizeSelectionSurface,
  UNDECLARED_ROUTE_ATTRIBUTES,
} from "./qa-cart-entry.mjs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";

const { cartStateBeforeSubmit, classifyTestOrderCreation, createOrderCreationBudget, dispatchTestOrderPlans, TEST_ORDER_STEP_LADDER, PRIMARY_CTA_SELECTOR, COUPON_INPUT_SELECTORS, COUPON_APPLY_CONTROL_SELECTOR, primaryCtaInspectionScript, primaryCtaAssertionFromEvidence, clickCouponApplyControl } = __qaBrowserTestHooks;

const BASE = "https://campaign.example";
const checkout = { page_id: "checkout", page_type: "checkout", order: 3, url: `${BASE}/checkout/`, expected_next_url: `${BASE}/upsell-1/` };

function topology(pages) {
  return [{ funnel_id: "default", pages }];
}

// The cart-entry vocabulary is the SDK's activation selector for its
// add-to-cart feature and nothing more. This pins it without a browser, so a
// spelling the SDK does not instantiate on cannot creep back in as an entry
// the runner would click.
test("the cart-entry control selector is exactly the SDK's add-to-cart activation selector", () => {
  assert.equal(CART_ENTRY_CONTROL_SELECTOR, '[data-next-action="add-to-cart"]');
});

// The SDK declares `data-next-action` and `data-next-coupon` as its control
// activations; `data-next-checkout-action` is not an attribute it reads. A
// selector list that names an undeclared spelling claims an activation the SDK
// does not have, so every list in the runner is pinned to declared spellings.
test("the primary-CTA candidate selector names only attributes the SDK declares", () => {
  const dataNextEntries = PRIMARY_CTA_SELECTOR.split(", ").filter((entry) => entry.includes("data-next-"));
  assert.deepEqual(dataNextEntries, ["[data-next-action]", CART_ENTRY_CONTROL_SELECTOR]);
  assert.ok(!PRIMARY_CTA_SELECTOR.includes("data-next-checkout-action"), PRIMARY_CTA_SELECTOR);
});

test("the coupon locators are the SDK's declared coupon activations, nothing spelled otherwise", () => {
  assert.equal(COUPON_APPLY_CONTROL_SELECTOR, '[data-next-coupon="apply"]');
  const dataNextEntries = COUPON_INPUT_SELECTORS.filter((entry) => entry.includes("data-next-"));
  assert.deepEqual(dataNextEntries, ['[data-next-checkout-field="coupon"]', 'input[data-next-coupon="input"]']);
  for (const entry of [COUPON_APPLY_CONTROL_SELECTOR, ...COUPON_INPUT_SELECTORS]) {
    assert.ok(!/data-next-checkout-action|data-next-coupon-apply|data-next-coupon-input|apply-coupon/.test(entry), entry);
  }
});

// --- cartEntryHrefFor: the route rule the primary-CTA recogniser runs in-page,
// exercised here against element-shaped objects so each branch has a
// browser-free case. `matches` answers only for the SDK selector, the way a
// real element would for a control carrying data-next-action="add-to-cart".

const ROUTE_RULE = { cartEntrySelector: CART_ENTRY_CONTROL_SELECTOR, cartEntryRouteAttribute: CART_ENTRY_ROUTE_ATTRIBUTE, origin: "https://campaign.example", baseHref: "https://campaign.example/lp/nested/index.html" };

function element({ tag = "button", attrs = {}, href, form = null } = {}) {
  const sdkControl = attrs["data-next-action"] === "add-to-cart";
  return {
    tagName: tag.toUpperCase(),
    href,
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    matches: (selector) => selector === CART_ENTRY_CONTROL_SELECTOR && sdkControl,
    closest: (selector) => (selector === "form" ? form : null),
  };
}

test("cartEntryHrefFor: an SDK control routes by data-next-url resolved against the origin, never by href", () => {
  const withRoute = element({ attrs: { "data-next-action": "add-to-cart", "data-next-url": "checkout/" }, href: "https://campaign.example/lp/nested/stray/" });
  assert.equal(cartEntryHrefFor(withRoute, ROUTE_RULE), "https://campaign.example/checkout/");
  const anchorControl = element({ tag: "a", attrs: { "data-next-action": "add-to-cart", "data-next-url": "/checkout/", href: "/elsewhere/" }, href: "https://campaign.example/elsewhere/" });
  assert.equal(cartEntryHrefFor(anchorControl, ROUTE_RULE), "https://campaign.example/checkout/", "the SDK's own click handler prevents the anchor navigation");
  assert.equal(cartEntryHrefFor(element({ attrs: { "data-next-action": "add-to-cart" }, href: "https://campaign.example/checkout/" }), ROUTE_RULE), null, "no data-next-url: adds to cart and stays put");
  assert.equal(cartEntryHrefFor(element({ attrs: { "data-next-action": "add-to-cart", "data-next-url": "http://[bad" } }), ROUTE_RULE), null, "an unparseable route is no route");
});

test("cartEntryHrefFor: an HTML anchor keeps its natively resolved href, and data-next-url on a non-SDK element is a decoy", () => {
  const anchor = element({ tag: "a", attrs: { href: "../checkout/", "data-next-url": "/support/" }, href: "https://campaign.example/lp/checkout/" });
  assert.equal(cartEntryHrefFor(anchor, ROUTE_RULE), "https://campaign.example/lp/checkout/");
  // An SVG <a> exposes href as an object, so the attribute is read against the base instead.
  const svgAnchor = element({ tag: "a", attrs: { href: "../checkout/" }, href: { baseVal: "../checkout/" } });
  assert.equal(cartEntryHrefFor(svgAnchor, ROUTE_RULE), "https://campaign.example/lp/checkout/");
  const decoy = element({ attrs: { "data-next-url": "/checkout/" } });
  assert.equal(cartEntryHrefFor(decoy, ROUTE_RULE), null, "a plain button's data-next-url has no navigation semantics");
});

test("cartEntryHrefFor: href-shaped attributes and a wrapping form's action resolve against the document base; undeclared spellings do not", () => {
  assert.equal(cartEntryHrefFor(element({ attrs: { "data-href": "/checkout/?forcePackageId=1" } }), ROUTE_RULE), "https://campaign.example/checkout/?forcePackageId=1");
  assert.equal(cartEntryHrefFor(element({ attrs: { href: "checkout/" } }), ROUTE_RULE), "https://campaign.example/lp/nested/checkout/");
  const form = { getAttribute: (name) => (name === "action" ? "/checkout/" : null) };
  assert.equal(cartEntryHrefFor(element({ attrs: {}, form }), ROUTE_RULE), "https://campaign.example/checkout/");
  assert.equal(cartEntryHrefFor(element({ attrs: { "data-next-href": "/checkout/" } }), ROUTE_RULE), null, "data-next-href is not an SDK attribute and not a route");
  assert.equal(cartEntryHrefFor(element({ attrs: { href: "http://[bad" } }), ROUTE_RULE), null, "an unparseable href is not a route, on either branch");
  assert.equal(cartEntryHrefFor(element(), ROUTE_RULE), null);
  assert.equal(cartEntryHrefFor(null, ROUTE_RULE), null);
});

// The primary-CTA inspection is serialised into the page as source text:
// `inspectPrimaryCtaScript` and `cartEntryHrefFor` both travel by
// `Function.prototype.toString`, so neither may reference a module-scope
// identifier — an import or a top-level constant compiles and unit-tests fine
// here and then throws ReferenceError inside the page. This evaluates the
// exact text the runner sends, in a fresh vm context that holds only the
// browser globals the script reads (no module scope, no Node globals), so a
// leaked identifier fails this test instead of the next QA run.
function pageContext({ base, elements }) {
  const attrMatches = (element, selector) => selector.split(",").map((part) => part.trim()).some((part) => {
    const attr = part.match(/^([a-z]*)\[([^=\]]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/i);
    if (attr) {
      const [, tag, name, dq, sq] = attr;
      if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const value = dq ?? sq;
      return value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value;
    }
    return element.tagName.toLowerCase() === part.toLowerCase();
  });
  const make = ({ tag = "button", attrs = {}, text = "", href }) => {
    const element = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      id: "",
      className: attrs.class || "",
      innerText: text,
      textContent: text,
      parentElement: null,
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      hasAttribute: (name) => name in attrs,
      matches: (selector) => attrMatches(element, selector),
      closest: () => null,
      getBoundingClientRect: () => ({ width: 200, height: 48 }),
    };
    if (tag === "a" && href !== undefined) element.href = href;
    return element;
  };
  const nodes = elements.map(make);
  const context = {
    URL,
    Node: { ELEMENT_NODE: 1 },
    location: { href: base, origin: new URL(base).origin },
    document: { querySelectorAll: (selector) => nodes.filter((node) => attrMatches(node, selector)) },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", color: "rgb(255, 255, 255)", backgroundColor: "rgb(17, 51, 34)" }),
  };
  return vm.createContext(context);
}

// What the runner receives: the page boundary serialises the return value,
// so the cross-realm arrays and objects come back as plain host values.
function evaluateInPage(script, context) {
  return JSON.parse(JSON.stringify(vm.runInContext(script, context)));
}

test("primary-CTA inspection script is self-contained: it evaluates in a fresh context with only browser globals", () => {
  const base = "https://campaign.example/lp/";
  const script = primaryCtaInspectionScript("https://campaign.example/checkout/");
  assert.equal(typeof script, "string");
  assert.match(script, /^\(function inspectPrimaryCtaScript\(/);
  assert.match(script, /function cartEntryHrefFor\(/);

  const context = pageContext({
    base,
    elements: [
      { tag: "button", attrs: { "data-next-action": "add-to-cart", "data-next-url": "/checkout/" }, text: "Buy now" },
      { tag: "a", attrs: { href: "../support/" }, text: "Help", href: "https://campaign.example/support/" },
      { tag: "button", attrs: { "data-next-href": "/checkout/", "data-next-url": "/checkout/" }, text: "Continue" },
    ],
  });
  const evidence = evaluateInPage(script, context);

  assert.equal(evidence.ok, true);
  assert.equal(evidence.reason, "ok");
  assert.equal(evidence.expected_url, "https://campaign.example/checkout/");
  assert.deepEqual(Object.keys(evidence).sort(), ["candidates", "expected_url", "ignored_attributes", "ok", "primary", "reason"]);
  assert.equal(evidence.candidates.length, 3);
  for (const candidate of evidence.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ["background", "background_source", "contrast_ratio", "foreground", "height", "href", "ignored_attributes", "readable", "route_matches", "selector", "size_ok", "text", "width"]);
    assert.ok(candidate.href === null || typeof candidate.href === "string", "href is a resolved URL or null");
  }
  const [sdkControl, anchor, undeclared] = evidence.candidates;
  assert.equal(sdkControl.href, "https://campaign.example/checkout/", "the SDK control routes by data-next-url against the origin");
  assert.equal(sdkControl.route_matches, true);
  assert.deepEqual(sdkControl.ignored_attributes, []);
  assert.equal(anchor.href, "https://campaign.example/support/");
  assert.equal(anchor.route_matches, false);
  assert.equal(undeclared.href, null, "an undeclared spelling is not a route");
  assert.deepEqual(undeclared.ignored_attributes, ["data-next-href", "data-next-url"], "seen, reported, not consulted");
  assert.deepEqual(evidence.ignored_attributes, ["data-next-href", "data-next-url"]);
  assert.equal(evidence.primary.selector, "button");
});

test("a page whose only route-shaped spelling is undeclared reads as a vocabulary gap in the verdict, not as a removed CTA", () => {
  const script = primaryCtaInspectionScript("https://campaign.example/checkout/");
  const context = pageContext({
    base: "https://campaign.example/lp/",
    elements: [{ tag: "button", attrs: { "data-next-href": "/checkout/" }, text: "Continue" }],
  });
  const evidence = evaluateInPage(script, context);
  assert.equal(evidence.ok, false);
  assert.equal(evidence.reason, "missing_route_cta");
  assert.deepEqual(evidence.ignored_attributes, ["data-next-href"]);
  assert.ok(UNDECLARED_ROUTE_ATTRIBUTES.includes("data-next-href"));

  const result = primaryCtaAssertionFromEvidence({ page_id: "landing", page_type: "landing" }, evidence);
  assert.equal(result.status, "fail");
  assert.equal(result.actual, "missing_route_cta (page carries route-shaped attributes the runner does not consult: data-next-href)");

  // A page with no such spelling keeps the bare reason.
  const bare = primaryCtaAssertionFromEvidence({ page_id: "landing", page_type: "landing" }, { ok: false, reason: "missing_route_cta", candidates: [], ignored_attributes: [] });
  assert.equal(bare.actual, "missing_route_cta");

  // A passing page spelled that way still names the spelling.
  const passing = primaryCtaAssertionFromEvidence({ page_id: "landing", page_type: "landing" }, {
    ok: true,
    reason: "ok",
    primary: { width: 180, height: 52, contrast_ratio: 12, readable: true, size_ok: true },
    candidates: [],
    ignored_attributes: ["data-next-checkout-action"],
  });
  assert.equal(passing.status, "pass");
  assert.equal(passing.actual, "CTA visible (180x52, contrast 12) (page carries route-shaped attributes the runner does not consult: data-next-checkout-action)");
});

test("the page-level ignored_attributes union covers visible CTA-shaped elements the candidate rows do not list", () => {
  const script = primaryCtaInspectionScript("https://campaign.example/checkout/");
  // An element with an undeclared spelling and neither text nor a route is
  // dropped from candidates[] (nothing to report about it as a CTA), and the
  // ninth-and-later candidates fall past the cap; both still count on the page.
  const filler = Array.from({ length: 8 }, (_, index) => ({ tag: "a", attrs: { href: `/other-${index}/` }, text: `Other ${index}`, href: `https://campaign.example/other-${index}/` }));
  const context = pageContext({
    base: "https://campaign.example/lp/",
    elements: [
      { tag: "div", attrs: { role: "button", "data-next-href": "/checkout/" }, text: "" },
      ...filler,
      { tag: "button", attrs: { "data-next-checkout-action": "go" }, text: "Continue" },
    ],
  });
  const evidence = evaluateInPage(script, context);
  assert.equal(evidence.reason, "missing_route_cta");
  assert.equal(evidence.candidates.length, 8, "candidate rows are capped");
  assert.ok(evidence.candidates.every((candidate) => candidate.ignored_attributes.length === 0), "no listed row carries the spellings");
  assert.deepEqual(evidence.ignored_attributes, ["data-next-checkout-action", "data-next-href"]);
});

// A fake page for the coupon apply-control chooser: the SDK apply control
// (count/visible/click outcome), one visible text control inside the form,
// and the input whose Enter is the last resort.
function couponPage({ explicit, applyText = null }) {
  const calls = [];
  const explicitLocator = {
    count: async () => (explicit ? 1 : 0),
    isVisible: async () => Boolean(explicit?.visible),
    click: async () => {
      calls.push("explicit.click");
      if (explicit?.clickFails) throw new Error("locator.click: Timeout 5000ms exceeded");
    },
  };
  const textControls = applyText ? [{
    innerText: async () => applyText,
    getAttribute: async () => null,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { calls.push("text.click"); },
  }] : [];
  const root = { locator: () => ({ count: async () => textControls.length, nth: (index) => textControls[index] }) };
  const page = { locator: (selector) => (selector === "form" ? root : { first: () => explicitLocator }) };
  const input = { press: async (key) => { calls.push(`input.press:${key}`); } };
  return { page, input, calls };
}

test("the SDK apply control is clicked only when visible and the click lands; otherwise the page's own fallbacks run", async () => {
  const visible = couponPage({ explicit: { visible: true }, applyText: "Apply" });
  assert.equal(await clickCouponApplyControl(visible.page, visible.input), "clicked explicit apply control");
  assert.deepEqual(visible.calls, ["explicit.click"]);

  // Rendered but hidden (a collapsed disclosure): not clicked, not claimed.
  const hidden = couponPage({ explicit: { visible: false }, applyText: "Apply" });
  assert.equal(await clickCouponApplyControl(hidden.page, hidden.input), "clicked visible apply control");
  assert.deepEqual(hidden.calls, ["text.click"]);

  // Visible but the click times out: fall through instead of reporting a click.
  const stuck = couponPage({ explicit: { visible: true, clickFails: true } });
  assert.equal(await clickCouponApplyControl(stuck.page, stuck.input), "pressed Enter in the coupon input");
  assert.deepEqual(stuck.calls, ["explicit.click", "input.press:Enter"]);

  // No SDK control at all: the fallbacks as before.
  const none = couponPage({ explicit: null });
  assert.equal(await clickCouponApplyControl(none.page, none.input), "pressed Enter in the coupon input");
  assert.deepEqual(none.calls, ["input.press:Enter"]);
});

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

const visibleAction = { index: 0, kind: "add_to_cart", visible: true, text: "Claim", package_id: "1", quantity: 1, next_url: "/checkout/" };
const hiddenAction = { index: 1, kind: "add_to_cart", visible: false, text: "Hidden", package_id: "2", quantity: 1, next_url: "/checkout/" };
const link = { index: 0, kind: "checkout_link", visible: true, text: "Buy", package_id: "3", quantity: 1, next_url: "/checkout/?forcePackageId=3:1" };
const twoPack = { index: 2, kind: "add_to_cart", visible: true, text: "Two", package_id: "1", quantity: 2, next_url: "/checkout/" };

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

test("an explicit --select-package quantity must match what the control adds; it is never downgraded", () => {
  const explicit = [{ packageId: "1", quantity: 2, quantityExplicit: true }];
  assert.equal(chooseCartEntryControl([visibleAction, twoPack], explicit).control, twoPack);
  const miss = chooseCartEntryControl([visibleAction], explicit);
  assert.equal(miss.control, null);
  assert.match(miss.reason, /--select-package 1:2: the entry-page control\(s\) for package 1 add quantity 1, not 2/);
  // A bare ref (no explicit quantity) still takes whatever the control adds.
  assert.equal(chooseCartEntryControl([twoPack], [{ packageId: "1", quantity: 1, quantityExplicit: false }]).control, twoPack);
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

test("the guard's cart-API fallback reads only responses captured after the checkout was reached", async () => {
  // A page with no SDK global at all: readable: false, and the runner's
  // bounded SDK-ready wait times out rather than resolving.
  const page = {
    waitForFunction: async () => { throw new Error("timeout"); },
    evaluate: async () => ({ readable: false }),
  };
  const cartCreate = (lineCount) => ({ status: 201, url: "https://api.example/api/v1/carts/", body: { lines: Array.from({ length: lineCount }, () => ({})) } });
  const events = { requests: [], responses: [cartCreate(1), cartCreate(0)], failed: [] };
  const stale = await cartStateBeforeSubmit(page, { ...events, responses: [cartCreate(1)] }, { responseOffset: 1, budget: () => 10 });
  assert.equal(stale.unreadable, true, "the entry page's cart call is not evidence about the checkout's cart");
  const fresh = await cartStateBeforeSubmit(page, events, { responseOffset: 1, budget: () => 10 });
  assert.deepEqual({ empty: fresh.empty, source: fresh.source }, { empty: true, source: "cart_api_response" });
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

// ---------------------------------------------------------------------------
// Checkout loads per path. The selector probe is the checkout's first load;
// nothing else on the path may load the same URL again, because every load
// fires the SDK's page-view events into the capture the analytics leg reads.
// A fake page counts `goto` calls per URL and moves its `url()` the way a real
// page would; the SDK hand-off from the entry page is simulated by the click.

const { enterCartViaLanding, openCheckoutForPath, createSelectorProbeCache } = __qaBrowserTestHooks;
const landing = { page_id: "landing", page_type: "landing", order: 1, url: `${BASE}/`, expected_next_url: checkout.url, resolution: "routes_into_checkout" };
const LOAD_ARGS = Object.freeze({ "browser-timeout": 1000 });

// `evaluate` picks by script identity: the two page-side scripts the entry
// step runs come from the exported factories (fresh closures per call, so the
// fake keys on their source text) rather than sniffing the params shape. `waitForURL` rejects asynchronously
// like Playwright does, so the production catch is the one that fires.
function fakePage({ surface, controls = [], navigates = true }) {
  const loads = [];
  let current = "about:blank";
  const noop = async () => {};
  const locator = () => ({
    nth: () => ({
      scrollIntoViewIfNeeded: noop,
      click: async () => { if (navigates) current = checkout.url; },
    }),
  });
  const scripts = new Map([
    [String(checkoutSelectionSurfaceScript()), () => surface],
    [String(cartEntryControlsScript()), () => controls],
  ]);
  return {
    loads,
    loadsOf: (url) => loads.filter((entry) => entry === url).length,
    url: () => current,
    goto: async (url) => { loads.push(url); current = url; },
    waitForLoadState: noop,
    waitForTimeout: noop,
    waitForFunction: async () => true,
    waitForURL: (predicate) => new Promise((resolve, reject) => {
      setImmediate(() => (predicate(current) ? resolve() : reject(new Error("Timeout 1000ms exceeded."))));
    }),
    locator,
    evaluate: (script) => {
      const answer = scripts.get(String(script));
      return answer ? Promise.resolve(answer()) : Promise.reject(new Error(`unexpected page script: ${String(script).slice(0, 40)}`));
    },
  };
}

const budget = () => 5000;
const SELECTOR_SURFACE = { count: 1, kinds: { bundle_selector: 1 }, excluded: 0 };
const NO_SURFACE = { count: 0, kinds: {}, excluded: 0 };
const ADD_TO_CART = [{ kind: "add_to_cart", index: 0, text: "Claim", package_id: "1", visible: true, quantity: null }];

async function runEntryAndOpen(page, { entryPage = landing, selectorProbeCache = null } = {}) {
  const entry = await enterCartViaLanding({ page, checkoutPage: checkout, entryPage, selectedPackages: [], args: LOAD_ARGS, budget, selectorProbeCache });
  const opened = await openCheckoutForPath({ page, checkoutPage: checkout, entry, args: LOAD_ARGS });
  return { entry, opened };
}

test("a checkout that selects for itself is loaded exactly once per path: the probe's load is the one the ladder keeps", async () => {
  const page = fakePage({ surface: SELECTOR_SURFACE });
  const { entry, opened } = await runEntryAndOpen(page);
  assert.equal(typeof entry.skip, "string");
  assert.equal(entry.evidence.selection_surface_probe, "loaded");
  assert.equal(opened, "already on checkout from the selector probe; not re-opened");
  assert.equal(page.loadsOf(checkout.url), 1, "one checkout load for the whole path");
  assert.equal(page.url(), checkout.url);
});

test("a checkout without a selection surface is loaded once by the probe, then the path goes landing -> SDK arrival with no further checkout load", async () => {
  const page = fakePage({ surface: NO_SURFACE, controls: ADD_TO_CART });
  const { entry, opened } = await runEntryAndOpen(page);
  assert.equal(entry.entered, true);
  assert.equal(entry.evidence.selection_surface_probe, "loaded");
  assert.equal(opened, "arrived from the entry page via SDK navigation; not re-opened");
  assert.deepEqual(page.loads, [checkout.url, landing.url], "probe load, landing load, and the SDK's navigation is not a goto");
  assert.equal(page.url(), checkout.url);
});

test("a multi-path plan probes the checkout once per run: later paths reuse the answer and load the checkout only when they open it", async () => {
  const selectorProbeCache = createSelectorProbeCache();
  const first = fakePage({ surface: SELECTOR_SURFACE });
  const second = fakePage({ surface: { count: 99, kinds: { stale: 99 }, excluded: 0 } });
  const firstRun = await runEntryAndOpen(first, { selectorProbeCache });
  const secondRun = await runEntryAndOpen(second, { selectorProbeCache });
  assert.equal(firstRun.entry.evidence.selection_surface_probe, "loaded");
  assert.equal(secondRun.entry.evidence.selection_surface_probe, "reused");
  assert.deepEqual(secondRun.entry.evidence.checkout_selection_surface, SELECTOR_SURFACE, "the second path did not re-evaluate the page");
  assert.match(secondRun.entry.skip, /probe answer reused from an earlier path of this run/);
  assert.equal(secondRun.opened, null, "the second path opened the checkout itself, once");
  assert.equal(first.loadsOf(checkout.url), 1);
  assert.equal(second.loadsOf(checkout.url), 1);
});

test("a multi-path plan on a landing-entry family probes once; later paths go straight to the landing page", async () => {
  const selectorProbeCache = createSelectorProbeCache();
  const first = fakePage({ surface: NO_SURFACE, controls: ADD_TO_CART });
  const second = fakePage({ surface: NO_SURFACE, controls: ADD_TO_CART });
  await runEntryAndOpen(first, { selectorProbeCache });
  const secondRun = await runEntryAndOpen(second, { selectorProbeCache });
  assert.equal(secondRun.entry.entered, true);
  assert.equal(secondRun.entry.evidence.selection_surface_probe, "reused");
  assert.deepEqual(first.loads, [checkout.url, landing.url]);
  assert.deepEqual(second.loads, [landing.url], "no checkout load at all on the second path");
});

test("a probe whose page-side read failed is tagged as failed, not read as an empty checkout, and is not remembered", async () => {
  const selectorProbeCache = createSelectorProbeCache();
  const broken = fakePage({ surface: NO_SURFACE, controls: ADD_TO_CART });
  const evaluate = broken.evaluate;
  broken.evaluate = (script) => (String(script) === String(checkoutSelectionSurfaceScript()) ? Promise.reject(new Error("Execution context was destroyed")) : evaluate(script));
  const brokenRun = await runEntryAndOpen(broken, { selectorProbeCache });
  assert.equal(brokenRun.entry.entered, true, "the path still proceeds to the entry page");
  assert.equal(brokenRun.entry.evidence.selection_surface_probe, "failed");
  assert.equal(brokenRun.entry.evidence.selection_surface_probe_error, "Execution context was destroyed");
  assert.equal(selectorProbeCache.get(checkout.url), null);
  const next = fakePage({ surface: SELECTOR_SURFACE });
  const nextRun = await runEntryAndOpen(next, { selectorProbeCache });
  assert.equal(nextRun.entry.evidence.selection_surface_probe, "loaded");
  assert.equal(next.loadsOf(checkout.url), 1);
});

test("a click that never reaches the checkout fails by name through the production navigation wait, not as a bare timeout", async () => {
  const page = fakePage({ surface: NO_SURFACE, controls: ADD_TO_CART, navigates: false });
  await assert.rejects(
    enterCartViaLanding({ page, checkoutPage: checkout, entryPage: landing, selectedPackages: [], args: LOAD_ARGS, budget, selectorProbeCache: null }),
    (error) => {
      assert.equal(error.code, CART_ENTRY_CODES.ENTRY_NO_NAVIGATION);
      assert.match(error.message, /^cart_entry_no_navigation: clicked "Claim" on the entry page but the page did not reach/);
      assert.match(error.message, /now at https:\/\/campaign\.example\/\)/);
      return true;
    },
  );
  assert.deepEqual(page.loads, [checkout.url, landing.url]);
});

test("the probe cache keys on the canonical checkout URL, so a trailing-slash or query spelling is the same checkout", async () => {
  const selectorProbeCache = createSelectorProbeCache();
  selectorProbeCache.set(`${BASE}/checkout`, SELECTOR_SURFACE);
  assert.deepEqual(selectorProbeCache.get(`${BASE}/checkout/`), SELECTOR_SURFACE);
  assert.deepEqual(selectorProbeCache.get(`${BASE}/checkout/?utm=x`), SELECTOR_SURFACE);
  assert.equal(selectorProbeCache.get(`${BASE}/other/`), null);
});
