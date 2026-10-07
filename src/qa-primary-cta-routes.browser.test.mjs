// QA's browser-primary-cta check on SDK-routed checkout and upsell pages, real
// Chromium. A checkout advances through its checkout form's submit button,
// which carries no link (the SDK submits the form and goes to the page's
// success route), and an upsell through its SDK accept / decline actions,
// which are href="#" links (the SDK goes to the page's accept / decline
// route). The check reads those declared routes from the page's topology
// fields, the same ones the static route-link rows read, so such a control is
// the route candidate when its declared route is the expected next route.
//
// The pages are modelled on the starter templates' checkout (bundle cards,
// express wallet buttons and a `button[type="submit"]` inside
// `<form data-next-checkout="form">`) and single-offer upsell markup. Each
// row serves one stub page on 127.0.0.1 and runs the QA browser page checks
// (runBrowserChecks, the `qa run --browser` entry) over it.
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";

import { browserTest, htmlPage, respond } from "./readability-harness.browser.test.mjs";
import { stubOrigin } from "./polish-media-weight-harness.browser.test.mjs";
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const BOX = "display:inline-block;width:280px;height:48px;line-height:48px;text-align:center;text-decoration:none;font-family:sans-serif;font-size:16px;font-weight:700;color:#ffffff;background:#111111;border:0";
const CARD = "display:block;width:280px;height:48px;line-height:48px;margin:4px 0;font-family:sans-serif;font-size:16px;color:#111111;background:#ffffff;border:1px solid #111111";
const WALLET = "display:block;width:280px;height:44px;margin:4px 0;background:#ffc439;border:0";

// A form that is not the SDK checkout form, beside the page's SDK controls: a
// newsletter sign-up whose submit button posts to `action`.
function signupForm(action) {
  return `<form action="${action}" class="newsletter"><input type="email" name="email" aria-label="Email"><button type="submit" class="signup" style="${BOX}">Sign up</button></form>`;
}

// The starter checkout's shape: bundle cards (role="button"), the express
// wallet buttons the SDK mounts, and the submit block's button. `action`
// adds a form action to the checkout form; `sdkForm: false` leaves the
// checkout form out; `submitType` is the submit block button's type attribute
// (null for none); `extra` is markup after it.
function checkoutPage({ action = null, sdkForm = true, submitType = "submit", extra = "" } = {}) {
  return htmlPage(`${sdkForm ? `
<form data-next-checkout="form" id="combo_form" method="post"${action ? ` action="${action}"` : ""}>
  <div data-next-bundle-selector data-next-selector-id="main">
    <div data-next-bundle-card data-next-bundle-id="bundle-1x" role="button" class="os-card" style="${CARD}">1x Package Title</div>
    <div data-next-bundle-card data-next-bundle-id="bundle-2x" role="button" class="os-card" style="${CARD}">2x Package Title</div>
  </div>
  <div data-next-express-checkout="container" class="exp-checkout">
    <div data-next-express-checkout="buttons" class="express-checkout__buttons">
      <button type="button" data-next-express-checkout="paypal" aria-label="PayPal" style="${WALLET}"></button>
      <button data-next-express-checkout="apple_pay" aria-label="Apple Pay" style="${WALLET}"></button>
    </div>
  </div>
  <div class="submit-section"><div class="submit-section__button"><button os-checkout-payment="combo" data-action="submit"${submitType ? ` type="${submitType}"` : ""} class="submit-button" style="${BOX}">
    <div data-pb-element="checkout-button-info" class="submit-button__content"><div class="submit-button__main-text">COMPLETE PURCHASE</div></div>
  </button></div></div>
</form>` : ""}${extra}`, { head: "<meta name=\"next-page-type\" content=\"checkout\">" });
}

// The starter single-offer upsell's accept and decline: SDK actions on
// href="#" links inside the offer.
// `extra` is markup after the offer.
function upsellPage({ add = true, skip = true, extra = "" } = {}) {
  return htmlPage(`
<div data-next-upsell="offer" data-next-package-id="7">
  ${add ? `<a data-next-upsell-action="add" href="#" class="button cc-xl" style="${BOX}"><div data-button="content" class="button_content"><div>Yes, Add to My Order</div></div></a>` : ""}
  <p></p>
  ${skip ? `<a data-next-upsell-action="skip" href="#" class="upsell-decline" style="${BOX}">No thanks, I'll pass</a>` : ""}
</div>${extra}`, { head: "<meta name=\"next-page-type\" content=\"upsell\">" });
}

// Serves `html` at `path` and runs QA's browser page checks on it as a
// `pageType` page whose declared routes are the given paths. Returns the
// page's one browser-primary-cta assertion.
async function primaryCta(html, { pageType, path, next, accept = null, decline = null }) {
  const origin = await stubOrigin();
  try {
    origin.serve(path, respond("200 OK", "text/html; charset=utf-8", html));
    const { runBrowserChecks } = await import("./qa-browser.mjs");
    const page = {
      page_id: pageType,
      page_type: pageType,
      url: origin.url(path),
      expected_next_url: origin.url(next),
      ...(accept ? { expected_accept_url: origin.url(accept) } : {}),
      ...(decline ? { expected_decline_url: origin.url(decline) } : {}),
    };
    const assertions = await runBrowserChecks([{ pages: [page] }], {}, {});
    assert.ok(assertions.some((entry) => entry.id === `browser-load:${pageType}` && entry.status === "pass"), "setup: QA loaded the page");
    const found = assertions.filter((entry) => entry.id === `browser-primary-cta:${pageType}`);
    assert.equal(found.length, 1, `QA reports one browser-primary-cta assertion for the page (found ${found.length})`);
    return found[0];
  } finally {
    await origin.close();
  }
}

const outcome = (entry) => ({ status: entry.status, reason: entry.evidence?.reason });
const routeRows = (entry) => (entry.evidence?.candidates || []).filter((candidate) => candidate.route_matches);

// ---------------------------------------------------------------------------

browserTest("QA CTA routes: starter-shaped checkout, submit button with no href and no form action: the submit button is the route control and the row passes", async () => {
  const entry = await primaryCta(checkoutPage(), { pageType: "checkout", path: "/checkout/", next: "/upsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  const rows = routeRows(entry);
  assert.deepEqual(rows.map((row) => row.selector), ["button.submit-button"], JSON.stringify(entry.evidence.candidates));
  assert.equal(new URL(rows[0].href).pathname, "/upsell/", "the submit button leads to the page's success route");
  assert.ok(rows[0].elements.length > 0, "the submit button's label is measured");
});

browserTest("QA CTA routes: upsell accept is an SDK add action on an href=\"#\" link: it is the route control when the page's accept route is the next route, and the row passes", async () => {
  const entry = await primaryCta(upsellPage(), { pageType: "upsell", path: "/upsell/", next: "/receipt/", accept: "/receipt/", decline: "/downsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  const rows = routeRows(entry);
  assert.deepEqual(rows.map((row) => row.selector), ["a.button.cc-xl"], JSON.stringify(entry.evidence.candidates));
  assert.equal(new URL(rows[0].href).pathname, "/receipt/");
  const decline = entry.evidence.candidates.find((candidate) => candidate.selector === "a.upsell-decline");
  assert.equal(new URL(decline.href).pathname, "/downsell/", "the decline action leads to the page's decline route");
  assert.equal(decline.route_matches, false, "a decline route that is not the next route is not a route candidate");
});

browserTest("QA CTA routes: downsell whose only control is an SDK skip action on an href=\"#\" link, decline route = next route: it is the route control and the row passes", async () => {
  const entry = await primaryCta(upsellPage({ add: false }), { pageType: "downsell", path: "/downsell/", next: "/receipt/", decline: "/receipt/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  const rows = routeRows(entry);
  assert.deepEqual(rows.map((row) => row.selector), ["a.upsell-decline"], JSON.stringify(entry.evidence.candidates));
  assert.equal(new URL(rows[0].href).pathname, "/receipt/");
});

// A form action is not a route for everything inside the form: on the
// checkout, the bundle cards and the wallet buttons (one typed button, one
// typeless) are not route candidates, and only the submit button is.
browserTest("QA CTA routes: checkout form with an action: bundle cards and wallet buttons are not route candidates; only the submit button is", async () => {
  const entry = await primaryCta(checkoutPage({ action: "/upsell/" }), { pageType: "checkout", path: "/checkout/", next: "/upsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  assert.deepEqual(routeRows(entry).map((row) => row.selector), ["button.submit-button"], JSON.stringify(entry.evidence.candidates));
  const others = entry.evidence.candidates.filter((candidate) => candidate.selector !== "button.submit-button");
  assert.ok(others.some((candidate) => candidate.selector === "div.os-card"), "setup: the bundle cards are listed");
  assert.ok(others.some((candidate) => candidate.selector === "button" && candidate.text === "PayPal"), "setup: the wallet buttons are listed");
  for (const candidate of others) assert.equal(candidate.href, null, `${candidate.selector} (${candidate.text}) takes no route from the form action`);
});

// On a checkout, upsell or downsell the only form-borne route is the one the
// page declares for its SDK control. Another form's action, even when it is
// the next route, makes nothing a route candidate there.
browserTest("QA CTA routes: checkout with an unrelated form whose action is the next route: its submit button is not a route candidate; the SDK checkout submit is", async () => {
  const entry = await primaryCta(checkoutPage({ extra: signupForm("/upsell/") }), { pageType: "checkout", path: "/checkout/", next: "/upsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  assert.deepEqual(routeRows(entry).map((row) => row.selector), ["button.submit-button"], JSON.stringify(entry.evidence.candidates));
  const signup = entry.evidence.candidates.find((candidate) => candidate.selector === "button.signup");
  assert.ok(signup, "setup: the unrelated form's submit button is listed");
  assert.equal(signup.href, null, "the unrelated form's action is no route on a checkout");
});

browserTest("QA CTA routes: checkout whose only form is an unrelated one with the next route as its action, and no SDK checkout submit: the row reads missing_route_cta", async () => {
  const entry = await primaryCta(checkoutPage({ sdkForm: false, extra: signupForm("/upsell/") }), { pageType: "checkout", path: "/checkout/", next: "/upsell/" });
  assert.deepEqual(outcome(entry), { status: "fail", reason: "missing_route_cta" }, entry.actual);
  assert.deepEqual(routeRows(entry), [], JSON.stringify(entry.evidence.candidates));
});

browserTest("QA CTA routes: upsell with an unrelated form whose action is the next route and no SDK add control: the form's submit is not a route candidate and the row reads missing_route_cta", async () => {
  const entry = await primaryCta(upsellPage({ add: false, extra: signupForm("/receipt/") }), { pageType: "upsell", path: "/upsell/", next: "/receipt/", accept: "/receipt/", decline: "/downsell/" });
  assert.deepEqual(outcome(entry), { status: "fail", reason: "missing_route_cta" }, entry.actual);
  const signup = entry.evidence.candidates.find((candidate) => candidate.selector === "button.signup");
  assert.ok(signup, "setup: the unrelated form's submit button is listed");
  assert.equal(signup.href, null, "the unrelated form's action is no route on an upsell");
});

browserTest("QA CTA routes: upsell with an unrelated form whose action is the next route: only the SDK add action is a route candidate", async () => {
  const entry = await primaryCta(upsellPage({ extra: signupForm("/receipt/") }), { pageType: "upsell", path: "/upsell/", next: "/receipt/", accept: "/receipt/", decline: "/downsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  assert.deepEqual(routeRows(entry).map((row) => row.selector), ["a.button.cc-xl"], JSON.stringify(entry.evidence.candidates));
});

// A <button> with no type attribute submits its form, so in the SDK checkout
// form it is the submit control as much as a type="submit" one; a
// type="button" control there submits nothing and is no route candidate.
browserTest("QA CTA routes: checkout whose submit button has no type attribute: it submits the checkout form, so it is the route control and the row passes", async () => {
  const entry = await primaryCta(checkoutPage({ submitType: null }), { pageType: "checkout", path: "/checkout/", next: "/upsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  const rows = routeRows(entry);
  assert.deepEqual(rows.map((row) => row.selector), ["button.submit-button"], JSON.stringify(entry.evidence.candidates));
  assert.equal(new URL(rows[0].href).pathname, "/upsell/");
});

browserTest("QA CTA routes: checkout whose only form button is type=\"button\": it is not a route candidate and the row reads missing_route_cta", async () => {
  const entry = await primaryCta(checkoutPage({ submitType: "button" }), { pageType: "checkout", path: "/checkout/", next: "/upsell/" });
  assert.deepEqual(outcome(entry), { status: "fail", reason: "missing_route_cta" }, entry.actual);
  const button = entry.evidence.candidates.find((candidate) => candidate.selector === "button.submit-button");
  assert.ok(button, "setup: the type=\"button\" control is listed");
  assert.equal(button.href, null, "a type=\"button\" control does not submit the checkout form");
});

// The SDK binds upsell actions only inside a [data-next-upsell] container, so
// an action outside one does nothing and goes to no route.
function orphanedAction(action) {
  return `<section><a data-next-upsell-action="${action}" href="#" class="orphan-${action}" style="${BOX}">Yes, add it</a></section>`;
}

browserTest("QA CTA routes: upsell whose only add action sits outside any data-next-upsell container: it is not a route candidate and the row reads missing_route_cta", async () => {
  const entry = await primaryCta(upsellPage({ add: false, extra: orphanedAction("add") }), { pageType: "upsell", path: "/upsell/", next: "/receipt/", accept: "/receipt/", decline: "/downsell/" });
  assert.deepEqual(outcome(entry), { status: "fail", reason: "missing_route_cta" }, entry.actual);
  const orphan = entry.evidence.candidates.find((candidate) => candidate.selector === "a.orphan-add");
  assert.ok(orphan, "setup: the orphaned add action is listed");
  assert.notEqual(new URL(orphan.href).pathname, "/receipt/", "an orphaned add action does not go to the accept route");
});

browserTest("QA CTA routes: upsell with an in-offer add action and an orphaned one: only the in-offer action is a route candidate", async () => {
  const entry = await primaryCta(upsellPage({ extra: orphanedAction("add") }), { pageType: "upsell", path: "/upsell/", next: "/receipt/", accept: "/receipt/", decline: "/downsell/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  assert.deepEqual(routeRows(entry).map((row) => row.selector), ["a.button.cc-xl"], JSON.stringify(entry.evidence.candidates));
});

// Unchanged-behaviour controls.

browserTest("QA CTA routes (control): on a landing page a form's action is still the route of that form's own submit button", async () => {
  const entry = await primaryCta(htmlPage(signupForm("/checkout/")), { pageType: "landing", path: "/lp/", next: "/checkout/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  assert.deepEqual(routeRows(entry).map((row) => row.selector), ["button.signup"], JSON.stringify(entry.evidence.candidates));
});

browserTest("QA CTA routes (control): a landing page whose CTA is a real link to the next route passes as before", async () => {
  const entry = await primaryCta(htmlPage(`<a href="/checkout/" class="cta" style="${BOX}">Buy now</a>`), { pageType: "landing", path: "/lp/", next: "/checkout/" });
  assert.deepEqual(outcome(entry), { status: "pass", reason: "ok" }, entry.actual);
  assert.deepEqual(routeRows(entry).map((row) => row.selector), ["a.cta"]);
});

browserTest("QA CTA routes (control): an upsell that declares no accept route: its SDK add action is not a route candidate and the row reads missing_route_cta", async () => {
  const entry = await primaryCta(upsellPage({ skip: false }), { pageType: "upsell", path: "/upsell/", next: "/receipt/" });
  assert.deepEqual(outcome(entry), { status: "fail", reason: "missing_route_cta" }, entry.actual);
});
