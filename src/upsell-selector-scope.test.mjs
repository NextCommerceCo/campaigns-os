import assert from "node:assert/strict";
import { test } from "node:test";

import { inferPageType } from "./built-site-scope.mjs";
import {
  UPSELL_SELECTOR_SCOPE,
  builtPageIsPostPurchase,
  builtPageTypeOverRouteGuess,
  collectBundleSelectors,
  evaluateUpsellSelectorScope,
  readBuiltPageTypeMetas,
} from "./upsell-selector-scope.mjs";

const SUBJECT = { public_route_slug: "example-campaign", site_root: "_site/example-campaign" };

const UNSCOPED = '<div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x" style="display:none"></div>';
const SCOPED = '<div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"></div>';

function upsellPage(body, { page_id = "upsell-2", page_type = "upsell" } = {}) {
  return { page_id, page_type, file: `_site/example-campaign/${page_id}/index.html`, content: body };
}

function gateFor(pages, options = {}) {
  return evaluateUpsellSelectorScope({ subject: SUBJECT, pages, ...options });
}

// --- Selector scan -----------------------------------------------------------

test("scan reads the two attributes that decide which basket a selector writes to", () => {
  const [unscoped, scoped, selectMode] = collectBundleSelectors(`
    ${UNSCOPED}
    ${SCOPED}
    <div data-next-bundle-selector data-next-selector-id="display" data-next-selection-mode="select"></div>
  `);
  assert.deepEqual(
    { id: unscoped.selector_id, mode: unscoped.selection_mode, cart: unscoped.writes_to_cart, hidden: unscoped.hidden },
    { id: "upsell-bundle-1x", mode: "swap", cart: true, hidden: true },
  );
  assert.deepEqual(
    { id: scoped.selector_id, mode: scoped.selection_mode, cart: scoped.writes_to_cart },
    { id: "upsell-bundle", mode: "swap", cart: false },
  );
  assert.deepEqual(
    { id: selectMode.selector_id, mode: selectMode.selection_mode, cart: selectMode.writes_to_cart },
    { id: "display", mode: "select", cart: false },
  );
});

test("scan ignores commented-out markup and prose that names the attributes", () => {
  // The certified upsell templates carry long comments quoting these attribute
  // names verbatim; a scan that counted them would block every clean build.
  const selectors = collectBundleSelectors(`
    <!-- UpsellEnhancer picks the first [data-next-bundle-selector] inside the offer. -->
    <!-- ${UNSCOPED} -->
    ${SCOPED}
  `);
  assert.equal(selectors.length, 1);
  assert.equal(selectors[0].selector_id, "upsell-bundle");
});

test("scan is not truncated by a > inside a preceding attribute value", () => {
  const selectors = collectBundleSelectors(
    '<div data-next-show="param.qty>2" data-next-bundle-selector data-next-selector-id="tiers"></div>',
  );
  assert.equal(selectors.length, 1);
  assert.equal(selectors[0].selector_id, "tiers");
});

test("scan does not match an attribute that merely starts with the name", () => {
  assert.deepEqual(collectBundleSelectors('<div data-next-bundle-selector-legend="x"></div>'), []);
});

// --- Page role ---------------------------------------------------------------

test("a page is post-purchase by declared type or by its own next-page-type meta", () => {
  assert.equal(builtPageIsPostPurchase({ page_type: "upsell", content: "" }), true);
  assert.equal(builtPageIsPostPurchase({ page_type: "downsell", content: "" }), true);
  assert.equal(builtPageIsPostPurchase({ page_type: null, content: '<meta name="next-page-type" content="upsell">' }), true);
  // Either signal alone is enough: disagreement is a reason to look harder.
  assert.equal(builtPageIsPostPurchase({ page_type: "page", content: '<meta name="next-page-type" content="upsell">' }), true);
  assert.equal(builtPageIsPostPurchase({ page_type: "checkout", content: '<meta name="next-page-type" content="checkout">' }), false);
});

// --- Gate --------------------------------------------------------------------

test("an unscoped selector on an upsell page blocks and names the selector id", () => {
  const gate = gateFor([upsellPage(`${UNSCOPED}${SCOPED}`)]);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, UPSELL_SELECTOR_SCOPE);
  assert.equal(gate.waivable, true);
  assert.equal(gate.findings.length, 1);
  assert.equal(gate.findings[0].selector_id, "upsell-bundle-1x");
  assert.equal(gate.selectors_scanned, 2, "the correctly scoped sibling is scanned, not flagged");
  assert.match(gate.reason, /"upsell-bundle-1x"/);
  assert.match(gate.reason, /LIVE CART/);
  assert.match(gate.reason, /without appearing in that checkout's rendered order summary/);
  assert.ok(gate.required_actions.some((action) => action.id === "waive_checkpoint"));
});

test("a selector with no selector id is still named, as its position", () => {
  const gate = gateFor([upsellPage("<div data-next-bundle-selector></div>")]);
  assert.equal(gate.status, "blocked");
  assert.match(gate.reason, /\(no data-next-selector-id\)/);
});

test("hiding the selector changes nothing — the cart write is at init, not on click", () => {
  const hidden = gateFor([upsellPage(UNSCOPED)]);
  const visible = gateFor([upsellPage('<div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x"></div>')]);
  assert.equal(hidden.status, "blocked");
  assert.equal(visible.status, "blocked");
  assert.equal(hidden.findings[0].hidden, true);
  assert.equal(visible.findings[0].hidden, false);
});

test("a downsell page is gated the same way — same position in the funnel", () => {
  assert.equal(gateFor([upsellPage(UNSCOPED, { page_id: "downsell-1", page_type: "downsell" })]).status, "blocked");
});

test("a cart-scoped selector before checkout is correct and is not scanned", () => {
  const gate = gateFor([{ page_id: "index", page_type: "landing", file: "_site/x/index.html", content: UNSCOPED }]);
  assert.equal(gate.status, "not_applicable");
  assert.equal(gate.selectors_scanned, 0);
});

test("every selector scoped to the upsell passes", () => {
  const gate = gateFor([upsellPage(SCOPED)]);
  assert.equal(gate.status, "pass");
  assert.equal(gate.code, "built_output.upsell_selector_scope.pass");
  assert.equal(gate.state_fingerprint, null);
});

test('data-next-selection-mode="select" clears the blocker and warns instead', () => {
  // Every cart write in the SDK's bundle-selector is gated on swap mode, at
  // init and on click alike, so this selector provably does not charge anyone.
  // Blocking it would make the gate's own message false; the pricing surface is
  // still wrong, so it is not silent either.
  const gate = gateFor([upsellPage('<div data-next-bundle-selector data-next-selector-id="display" data-next-selection-mode="select"></div>')]);
  assert.equal(gate.status, "pass");
  assert.equal(gate.code, "built_output.upsell_selector_scope.cart_scoped_select_mode");
  assert.equal(gate.warned.length, 1);
  assert.match(gate.reason, /do not write to the cart/);
});

test("findings accumulate across every built post-purchase page", () => {
  const gate = gateFor([
    upsellPage(UNSCOPED, { page_id: "upsell-1" }),
    upsellPage(`${SCOPED}${UNSCOPED}`, { page_id: "upsell-2" }),
  ]);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.findings.length, 2);
  assert.deepEqual(gate.findings.map((f) => f.page_id), ["upsell-1", "upsell-2"]);
  assert.equal(gate.pages_scanned, 2);
});

// --- Waiver ------------------------------------------------------------------

function waiverFor(gate, overrides = {}) {
  return {
    scope: UPSELL_SELECTOR_SCOPE,
    subject: SUBJECT,
    state_fingerprint: gate.state_fingerprint,
    reason: "Legacy offer page reuses the cart selector; replacement is scheduled.",
    waived_by: "Jordan Ellis",
    waived_at: "2026-08-31T00:00:00.000Z",
    review_condition: "The offer page is rebuilt from the current template.",
    ...overrides,
  };
}

test("an exact named-human waiver moves the gate to waived", () => {
  const blocked = gateFor([upsellPage(UNSCOPED)]);
  const waived = gateFor([upsellPage(UNSCOPED)], { waivers: [waiverFor(blocked)] });
  assert.equal(waived.status, "waived");
  assert.equal(waived.code, "built_output.upsell_selector_scope.waived");
  assert.equal(waived.waiver.waived_by, "Jordan Ellis");
  assert.equal(waived.required_actions.length, 0);
});

test("a waiver goes inert the moment another unscoped selector appears", () => {
  const blocked = gateFor([upsellPage(UNSCOPED)]);
  const waiver = waiverFor(blocked);
  const widened = gateFor(
    [upsellPage(`${UNSCOPED}<div data-next-bundle-selector data-next-selector-id="second"></div>`)],
    { waivers: [waiver] },
  );
  assert.equal(widened.status, "blocked", "a second selector is a different state, not the waived one");
  assert.equal(widened.waiver_assessment.inert_counts.stale, 1);
});

test("a select-mode warning does not disturb a waiver recorded against the blockers", () => {
  const blocked = gateFor([upsellPage(UNSCOPED)]);
  const withWarning = gateFor(
    [upsellPage(`${UNSCOPED}<div data-next-bundle-selector data-next-selector-id="display" data-next-selection-mode="select"></div>`)],
    { waivers: [waiverFor(blocked)] },
  );
  assert.equal(withWarning.status, "waived");
  assert.equal(withWarning.warned.length, 1);
});

// --- Review follow-ups (#275) -----------------------------------------------

test("the next-page-type meta is read in either attribute order", () => {
  // Raised in review as a silent miss. It is not: the lookahead's [^>]*
  // backtracks, so `content` before `name` resolves. Pinned rather than argued.
  for (const html of [
    '<meta name="next-page-type" content="upsell">',
    '<meta content="upsell" name="next-page-type">',
    "<meta content='upsell' name='next-page-type'>",
    '<meta data-x="1" content="upsell" data-y="2" name="next-page-type">',
    '<meta name="description" content="hi"><meta content="downsell" name="next-page-type">',
  ]) {
    assert.equal(builtPageIsPostPurchase({ page_type: null, content: html }), true, html);
  }
  assert.equal(
    builtPageIsPostPurchase({ page_type: null, content: '<meta content="checkout" name="next-page-type">' }),
    false,
  );
});

test("hidden is bound to a real display declaration, not a substring of one", () => {
  const hiddenOf = (style) => collectBundleSelectors(
    `<div data-next-bundle-selector data-next-selector-id="s" style="${style}"></div>`,
  )[0].hidden;
  assert.equal(hiddenOf("display:none"), true);
  assert.equal(hiddenOf("color:red; display : none ;"), true);
  assert.equal(hiddenOf("display:none !important"), true);
  // Substrings that are not a display declaration.
  assert.equal(hiddenOf("--card-display:none"), false);
  assert.equal(hiddenOf("my-display:none"), false);
  assert.equal(hiddenOf("display:block"), false);
  // The `hidden` attribute still counts, and hidden never changes the verdict.
  assert.equal(
    collectBundleSelectors('<div data-next-bundle-selector hidden></div>')[0].hidden,
    true,
  );
  assert.equal(gateFor([upsellPage('<div data-next-bundle-selector data-next-selector-id="s" style="--card-display:none"></div>')]).status, "blocked");
});

test("a selector inside a <template> is scanned — this SDK clones slot templates into the live DOM", () => {
  const gate = gateFor([upsellPage(`
    <div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"
         data-next-bundle-slot-template-id="slot-tpl"></div>
    <template id="slot-tpl">
      <div data-next-bundle-selector data-next-selector-id="slot-inner"></div>
    </template>
  `)]);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.findings[0].selector_id, "slot-inner");
});

// --- Declared page type over the route guess (#529) ---------------------------

// One row per way a page can carry next-page-type. `role` is what the page
// declares over an ambiguous route that guesses "upsell" ("checkout-oto-1"):
// only a meta the browser puts in the document, unambiguously, replaces the
// guess. Anything else leaves the guess standing, so the post-purchase blocker
// is never lost to inert markup.
const META = (attrs) => `<meta ${attrs}>`;
const CHECKOUT = META('name="next-page-type" content="checkout"');
const DECLARATIONS = [
  ["a live meta", CHECKOUT, "checkout"],
  ["content before name", META('content="checkout" name="next-page-type"'), "checkout"],
  ["single quotes", META("name='next-page-type' content='checkout'"), "checkout"],
  ["no quotes", META("name=next-page-type content=checkout"), "checkout"],
  ["upper-case attribute names", META('NAME="next-page-type" CONTENT="checkout"'), "checkout"],
  ["value case and padding", META('name="next-page-type" content="  Checkout "'), "Checkout"],
  ["a meta in the body", `</head><body>${CHECKOUT}`, "checkout"],
  ["agreeing duplicates", `${CHECKOUT}${META('name="next-page-type" content="CHECKOUT"')}`, "checkout"],
  ["commented out", `<!-- ${CHECKOUT} -->`, "upsell"],
  ["commented out before a live upsell meta", `<!-- ${CHECKOUT} -->${META('name="next-page-type" content="upsell"')}`, "upsell"],
  ["inside <template>", `</head><body><template>${CHECKOUT}</template>`, "upsell"],
  ["inside a <script> string", `<script>const tag = '${CHECKOUT}';</script>`, "upsell"],
  ["inside <noscript>", `<noscript>${CHECKOUT}</noscript>`, "upsell"],
  ["inside <style>", `<style>/* ${CHECKOUT} */</style>`, "upsell"],
  ["inside <textarea>", `</head><body><textarea>${CHECKOUT}</textarea>`, "upsell"],
  ["inside <title>", `<title>${CHECKOUT}</title>`, "upsell"],
  ["conflicting duplicates", `${CHECKOUT}${META('name="next-page-type" content="receipt"')}`, "upsell"],
  ["empty content", META('name="next-page-type" content=""'), "upsell"],
  ["blank content", META('name="next-page-type" content="   "'), "upsell"],
  ["no content attribute", META('name="next-page-type"'), "upsell"],
  ["a blank first meta", `${META('name="next-page-type" content=""')}${CHECKOUT}`, "upsell"],
  ["a look-alike data-content attribute", META('name="next-page-type" data-content="checkout"'), "upsell"],
  ["the name in another case", META('name="Next-Page-Type" content="checkout"'), "upsell"],
  ["the name padded", META('name=" next-page-type" content="checkout"'), "upsell"],
];

test("only a live, unambiguous next-page-type meta replaces the route guess", () => {
  for (const [label, head, role] of DECLARATIONS) {
    const content = `<html><head>${head}</head><body>${UNSCOPED}</body></html>`;
    const page_type = builtPageTypeOverRouteGuess({ route: "checkout-oto-1", route_type: "upsell", content });
    assert.equal(page_type, role, label);
    const gate = gateFor([upsellPage(content, { page_type })]);
    assert.equal(gate.status, role === "upsell" ? "blocked" : "not_applicable", label);
  }
});

// Route x meta -> flagged, over a page with an unscoped bundle selector inside
// its offer container. The meta beats the route guess only when the guess is
// ambiguous: "oto" / "one-time-offer" without an "upsell" word, or a route
// that also reads as checkout. An explicit upsell or downsell route blocks
// whatever its meta says, because the charge comes from the page's place in
// the funnel (#529). Where the guess is not post-purchase, an upsell meta
// still brings the page in.
const OFFER_BODY = `<div data-next-upsell="offer">${UNSCOPED}</div>`;
const ROUTE_META_METAS = [null, "checkout", "upsell", "product", "receipt"];
const flaggedFor = (...metas) => Object.fromEntries(ROUTE_META_METAS.map((meta) => [meta ?? "(none)", metas.includes(meta)]));
const ALWAYS = flaggedFor(...ROUTE_META_METAS);
const AMBIGUOUS = flaggedFor(null, "upsell");
const NOT_POST_PURCHASE = flaggedFor("upsell");
const ROUTE_META_TABLE = [
  ["upsell-1", ALWAYS],
  ["up-sell-2", ALWAYS],
  ["upsell-oto", ALWAYS],
  ["checkout-upsell", ALWAYS],
  ["downsell", ALWAYS],
  ["down-sell-2", ALWAYS],
  ["checkout-downsell", ALWAYS],
  ["oto-1", AMBIGUOUS],
  ["oto1", AMBIGUOUS],
  ["one-time-offer", AMBIGUOUS],
  ["checkout-oto-1", AMBIGUOUS],
  ["checkout-oto-v2", AMBIGUOUS],
  ["checkout", NOT_POST_PURCHASE],
  ["order", NOT_POST_PURCHASE],
  ["offer", NOT_POST_PURCHASE],
  ["special", NOT_POST_PURCHASE],
];

test("route x meta: a meta beats only an ambiguous route guess; an explicit upsell or downsell route always blocks", () => {
  for (const [route, expected] of ROUTE_META_TABLE) {
    for (const meta of ROUTE_META_METAS) {
      const head = meta ? META(`name="next-page-type" content="${meta}"`) : "";
      const content = `<html><head>${head}</head><body>${OFFER_BODY}</body></html>`;
      const page_type = builtPageTypeOverRouteGuess({ route, route_type: inferPageType(route), content });
      const gate = gateFor([upsellPage(content, { page_id: route, page_type })]);
      assert.equal(gate.status === "blocked", expected[meta ?? "(none)"], `${route} with meta ${meta ?? "(none)"}`);
    }
  }
});

test("with no route to read, the route type stands against any meta", () => {
  const content = `<html><head>${CHECKOUT}</head><body>${OFFER_BODY}</body></html>`;
  assert.equal(builtPageTypeOverRouteGuess({ route_type: "upsell", content }), "upsell");
});

test("any next-page-type saying post-purchase, live or inert, still makes the page post-purchase", () => {
  for (const head of [
    `${CHECKOUT}${META('name="next-page-type" content="upsell"')}`,
    META("name=next-page-type content=downsell"),
    META('name="NEXT-PAGE-TYPE" content="upsell"'),
    `<!-- ${META('name="next-page-type" content="upsell"')} -->`,
    `<template>${META('name="next-page-type" content="downsell"')}</template>`,
    // Look-alike attributes and mismatched quotes the earlier reader took.
    META('name="next-page-type" data-content="upsell"'),
    META('data-name="next-page-type" content="upsell"'),
    META(`name='next-page-type" content="upsell"`),
  ]) {
    assert.equal(builtPageIsPostPurchase({ page_type: "checkout", content: `<html><head>${head}</head></html>` }), true, head);
  }
  assert.equal(builtPageIsPostPurchase({ page_type: null, content: `<html><head>${CHECKOUT}</head></html>` }), false);
});

test("readBuiltPageTypeMetas lists each mentioned value once, first occurrence first", () => {
  const { live, mentioned } = readBuiltPageTypeMetas('<meta name="next-page-type" content="checkout"><meta name="next-page-type" content="checkout"><!-- <meta name="next-page-type" content="upsell"> -->');
  assert.deepEqual(live, ["checkout", "checkout"]);
  assert.deepEqual(mentioned, ["checkout", "upsell"]);
});
