import test from "node:test";
import assert from "node:assert/strict";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { forbiddenComputedColors, loadTemplateBrandContract, placeholderTextResidueMatches } from "./template-brand-contract.mjs";

const {
  computedStyleResidueAssertions,
  logoResidueAssertion,
  methodPaymentArtifacts,
  referencedAssetBasenames,
  paymentChromeResidueAssertion,
  upsellPriceVisibilityAssertion,
  checkoutPriceVisibilityAssertion,
  placeholderTextResidueAssertion,
  demoAssetResidueAssertion,
} = __qaBrowserTestHooks;

const demeter = loadTemplateBrandContract("demeter");
const forbidden = forbiddenComputedColors(demeter);
const checkoutPage = { page_id: "checkout", page_type: "checkout", url: "https://example.test/c/checkout/" };
const upsellPage = { page_id: "upsell-1", page_type: "upsell", url: "https://example.test/c/upsell/" };

test("computed-style residue fails when a commerce surface renders the starter palette", () => {
  // The dogfood escape: checkout submit button shipped --brand--color--primary #3c7dff.
  const results = computedStyleResidueAssertions({
    page: checkoutPage,
    evidence: [{
      id: "checkout_submit_button",
      selector: ".submit-button",
      optional: false,
      found: true,
      properties: { "background-color": "rgb(60, 125, 255)", "border-color": "rgb(10, 38, 92)" },
    }],
    forbidden,
    severity: "blocker",
  });

  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.id, "template-residue:checkout:style:checkout_submit_button");
  assert.equal(result.family, "template_residue");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.equal(result.expected, "not rgb(60, 125, 255) (starter default --brand--color--primary)");
  assert.equal(result.actual, "rgb(60, 125, 255)");
  assert.equal(result.evidence.selector, ".submit-button");
  assert.equal(result.evidence.property, "background-color");
  assert.equal(result.evidence.page_url, checkoutPage.url);
  // both starter defaults are reported
  assert.equal(result.evidence.matches.length, 2);
});

test("computed-style residue passes branded surfaces and respects waived severity", () => {
  const pass = computedStyleResidueAssertions({
    page: checkoutPage,
    evidence: [{ id: "checkout_submit_button", selector: ".submit-button", optional: false, found: true, properties: { "background-color": "rgb(34, 85, 51)" } }],
    forbidden,
    severity: "blocker",
  })[0];
  assert.equal(pass.status, "pass");
  assert.equal(pass.severity, undefined);

  const waived = computedStyleResidueAssertions({
    page: checkoutPage,
    evidence: [{ id: "checkout_submit_button", selector: ".submit-button", optional: false, found: true, properties: { "background-color": "#3c7dff" } }],
    forbidden,
    severity: "warn",
  })[0];
  assert.equal(waived.status, "fail");
  assert.equal(waived.severity, "warn");
});

test("missing selectors: optional contract entries skip, required ones warn (contract drift, not a blocker)", () => {
  const results = computedStyleResidueAssertions({
    page: checkoutPage,
    evidence: [
      { id: "announcement_bar", selector: ".announcement", optional: true, found: false, properties: {} },
      { id: "checkout_submit_button", selector: ".submit-button", optional: false, found: false, properties: {} },
    ],
    forbidden,
    severity: "blocker",
  });
  assert.equal(results[0].status, "skipped");
  assert.equal(results[0].severity, undefined);
  assert.equal(results[1].status, "warn");
  assert.equal(results[1].severity, "warn");
  assert.match(results[1].evidence.note, /contract bug/);
});

test("logo residue fails on the starter asset basename, passes branded logos, skips when absent", () => {
  const logo = demeter.default_residue.logo;
  const fail = logoResidueAssertion({ page: checkoutPage, logo, sources: ["/c/images/next-logo.png"], severity: "blocker" });
  assert.equal(fail.id, "template-residue:checkout:logo");
  assert.equal(fail.status, "fail");
  assert.equal(fail.severity, "blocker");

  const pass = logoResidueAssertion({ page: checkoutPage, logo, sources: ["/c/images/acme-logo.svg"], severity: "blocker" });
  assert.equal(pass.status, "pass");
  assert.equal(pass.severity, undefined);

  const skipped = logoResidueAssertion({ page: checkoutPage, logo, sources: [], severity: "blocker" });
  assert.equal(skipped.status, "skipped");
});

test("payment chrome artifacts split per method; shared chrome counts for any unsupported method", () => {
  const chrome = demeter.default_residue.payment_chrome;
  const paypal = methodPaymentArtifacts(chrome, "paypal");
  assert.deepEqual(paypal.selectors, [".payment-method__icon--paypal-logo", ".payment-method__icon--paypal-txt"]);
  assert.ok(paypal.assets.includes("images/paypal-logo.svg"));
  assert.ok(paypal.assets.includes("images/upsell-payment-logos.svg"), "shared chrome is implied residue");
  assert.ok(!paypal.assets.includes("images/klarna-logo.svg"));

  const klarna = methodPaymentArtifacts(chrome, "klarna");
  assert.deepEqual(klarna.selectors, [".payment-method__icon--klarna-logo"]);
  assert.ok(klarna.assets.includes("images/klarna-logo.svg"));
  assert.ok(!klarna.assets.includes("images/paypal.svg"));
});

test("payment chrome residue fails on a visible selector match or a referenced asset filename", () => {
  const chrome = demeter.default_residue.payment_chrome;
  const artifacts = methodPaymentArtifacts(chrome, "paypal");

  const html = '<img src="../images/upsell-payment-logos.svg" alt="payments">';
  const referencedAssets = referencedAssetBasenames(html, artifacts.assets);
  assert.deepEqual(referencedAssets, ["upsell-payment-logos.svg"]);

  const fail = paymentChromeResidueAssertion({
    page: upsellPage,
    method: "paypal",
    artifacts,
    visibleMatches: [],
    referencedAssets,
    severity: "blocker",
  });
  assert.equal(fail.id, "template-residue:upsell-1:payment-chrome:paypal");
  assert.equal(fail.family, "template_residue");
  assert.equal(fail.status, "fail");
  assert.equal(fail.severity, "blocker");
  assert.match(fail.actual, /upsell-payment-logos\.svg/);

  const pass = paymentChromeResidueAssertion({
    page: upsellPage,
    method: "paypal",
    artifacts,
    visibleMatches: [],
    referencedAssets: referencedAssetBasenames("<main>clean page</main>", artifacts.assets),
    severity: "blocker",
  });
  assert.equal(pass.status, "pass");

  const visible = paymentChromeResidueAssertion({
    page: checkoutPage,
    method: "klarna",
    artifacts: methodPaymentArtifacts(chrome, "klarna"),
    visibleMatches: [{ selector: ".payment-method__icon--klarna-logo", visible_count: 1 }],
    referencedAssets: [],
    severity: "warn",
  });
  assert.equal(visible.status, "fail");
  assert.equal(visible.severity, "warn");
});

test("upsell pricing visibility: zero visible price rows is a blocker, one or more passes with the count", () => {
  const selectors = demeter.pricing_surfaces.surfaces.upsell.price_row_selectors;

  // The dogfood escape: .rr-full-price .price-wrapper:first-child { display:none!important }
  const hidden = upsellPriceVisibilityAssertion({ page: upsellPage, selectors, visibleCount: 0 });
  assert.equal(hidden.id, "pricing.upsell_price_visible");
  assert.equal(hidden.family, "pricing");
  assert.equal(hidden.status, "fail");
  assert.equal(hidden.severity, "blocker");
  assert.deepEqual(hidden.evidence.selectors, selectors);
  assert.equal(hidden.evidence.visible_count, 0);

  const visible = upsellPriceVisibilityAssertion({ page: upsellPage, selectors, visibleCount: 2 });
  assert.equal(visible.status, "pass");
  assert.equal(visible.severity, undefined);
  assert.equal(visible.evidence.visible_count, 2);
});

test("checkout pricing visibility: zero visible bundle price rows is a warning, not a blocker", () => {
  const selectors = demeter.pricing_surfaces.surfaces.checkout_bundle.price_row_selectors;
  const hidden = checkoutPriceVisibilityAssertion({ page: checkoutPage, selectors, visibleCount: 0 });
  assert.equal(hidden.id, "pricing.checkout_price_visible");
  assert.equal(hidden.status, "fail");
  assert.equal(hidden.severity, "warn");

  const visible = checkoutPriceVisibilityAssertion({ page: checkoutPage, selectors, visibleCount: 3 });
  assert.equal(visible.status, "pass");
});

// --- H3.1: placeholder text-residue is a verdict blocker, like color residue ---

test("placeholder text-residue fails (blocker) when literal template copy renders", () => {
  const terms = ["Lorem", "Product Name", "TODO"];
  const text = "Lorem ipsum dolor sit. Buy the Product Name now.";
  const result = placeholderTextResidueAssertion({
    page: checkoutPage,
    terms,
    matches: placeholderTextResidueMatches(text, terms),
    severity: "blocker",
  });
  assert.equal(result.id, "template-residue:checkout:placeholder-text");
  assert.equal(result.family, "template_residue");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.match(result.actual, /Lorem/);
  assert.match(result.actual, /Product Name/);
  assert.deepEqual(result.evidence.found, ["Lorem", "Product Name"]);
  assert.equal(result.evidence.page_url, checkoutPage.url);
});

test("placeholder text-residue passes clean visible copy", () => {
  const terms = ["Lorem", "Product Name", "TODO"];
  const result = placeholderTextResidueAssertion({
    page: checkoutPage,
    terms,
    matches: placeholderTextResidueMatches("Premium cold brew concentrate, 32oz.", terms),
    severity: "blocker",
  });
  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
});

// --- H3.2: demo-asset fidelity is a warning that tells the agent to re-skin ---

test("demo-asset residue warns on named demo assets and repeated icon srcs", () => {
  const named = demoAssetResidueAssertion({
    page: checkoutPage,
    namedHits: ["1x1_1.svg"],
    repeatedIcons: [],
  });
  assert.equal(named.id, "template-residue:checkout:demo-asset");
  assert.equal(named.family, "template_residue");
  assert.equal(named.status, "warn");
  assert.equal(named.severity, "warn");
  assert.match(named.actual, /1x1_1\.svg/);

  const repeated = demoAssetResidueAssertion({
    page: checkoutPage,
    namedHits: [],
    repeatedIcons: [{ src: "/i/icon.svg", count: 4 }],
  });
  assert.equal(repeated.status, "warn");
  assert.match(repeated.actual, /repeated 4x/);
});

test("demo-asset residue passes when no demo assets survive", () => {
  const clean = demoAssetResidueAssertion({ page: checkoutPage, namedHits: [], repeatedIcons: [] });
  assert.equal(clean.status, "pass");
  assert.equal(clean.severity, undefined);
});
