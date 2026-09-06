import test from "node:test";
import assert from "node:assert/strict";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { forbiddenComputedColors, loadTemplateBrandContract, placeholderTextResidueMatches } from "./template-brand-contract.mjs";

const {
  computedStyleResidueAssertions,
  logoResidueAssertion,
  methodPaymentArtifacts,
  referencedAssetBasenames,
  referencedAssetUrl,
  assetTextCarriesMethod,
  partitionReferencedAssets,
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

// ── Card 10: an edited-in-place chrome asset must not read as residue ────────
// 2026-09-06: the polish operator removed the PayPal and Klarna marks from
// upsell-payment-logos.svg and credit-card-flags.svg in place. The basenames
// stayed referenced, four blockers fired against assets carrying no chrome, and
// the repair loop deleted a cards-only trust strip that was fine.

const UNTOUCHED_STRIP = '<svg><g id="paypal-logo"><path d="M0 0"/></g><g id="visa"><path d="M1 1"/></g></svg>';
const EDITED_STRIP = '<svg><g id="visa"><path d="M1 1"/></g><g id="mastercard"><path d="M2 2"/></g></svg>';

function fakePage(bodyByUrl) {
  return {
    evaluate: async (fn, url) => {
      const body = bodyByUrl[url];
      if (body === undefined) return null;
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

test("asset text carries the method only when the mark is still in the bytes", () => {
  assert.equal(assetTextCarriesMethod(UNTOUCHED_STRIP, "paypal"), true);
  assert.equal(assetTextCarriesMethod(EDITED_STRIP, "paypal"), false);
  // Token compaction matches the contract's own: separators do not hide a mark.
  assert.equal(assetTextCarriesMethod('<svg id="pay_pal-mark"/>', "paypal"), true);
});

test("referenced asset URL resolves against the page, or is null when absent", () => {
  const html = '<img src="../images/upsell-payment-logos.svg" alt="payments">';
  assert.equal(
    referencedAssetUrl(html, "upsell-payment-logos.svg", "https://example.test/c/upsell/"),
    "https://example.test/c/images/upsell-payment-logos.svg"
  );
  assert.equal(referencedAssetUrl("<main>clean</main>", "upsell-payment-logos.svg", "https://example.test/c/upsell/"), null);
});

test("an edited strip is partitioned as edited; an untouched one stays residue", async () => {
  const html = '<img src="images/upsell-payment-logos.svg">';
  const pageUrl = "https://example.test/c/upsell/";
  const assetUrl = "https://example.test/c/upsell/images/upsell-payment-logos.svg";

  const edited = await partitionReferencedAssets(fakePage({ [assetUrl]: EDITED_STRIP }), {
    html, pageUrl, referencedAssets: ["upsell-payment-logos.svg"], method: "paypal",
  });
  assert.deepEqual(edited, { residue: [], edited: ["upsell-payment-logos.svg"] });

  const untouched = await partitionReferencedAssets(fakePage({ [assetUrl]: UNTOUCHED_STRIP }), {
    html, pageUrl, referencedAssets: ["upsell-payment-logos.svg"], method: "paypal",
  });
  assert.deepEqual(untouched, { residue: ["upsell-payment-logos.svg"], edited: [] });
});

test("anything we cannot read into stays residue", async () => {
  const pageUrl = "https://example.test/c/upsell/";

  // A fetch that fails, or a non-OK response the helper turns into null.
  const unfetchable = await partitionReferencedAssets(
    fakePage({ "https://example.test/c/upsell/images/upsell-payment-logos.svg": new Error("network") }),
    {
      html: '<img src="images/upsell-payment-logos.svg">',
      pageUrl, referencedAssets: ["upsell-payment-logos.svg"], method: "paypal",
    }
  );
  assert.deepEqual(unfetchable.residue, ["upsell-payment-logos.svg"]);

  // A raster tells us nothing by its bytes, so it is never cleared by this path.
  // The fake serves a readable body that does not mention the method: without
  // the textual-asset guard this would be cleared, so the guard is what the
  // assertion is actually testing.
  const raster = await partitionReferencedAssets(
    fakePage({ "https://example.test/c/upsell/images/paypal.png": "\u0089PNG not-really-binary" }),
    {
      html: '<img src="images/paypal.png">',
      pageUrl, referencedAssets: ["paypal.png"], method: "paypal",
    }
  );
  assert.deepEqual(raster.residue, ["paypal.png"]);
  assert.deepEqual(raster.edited, []);

  // Named in prose rather than in a src: the basename still resolves to a URL,
  // the fetch then finds nothing there, and the fail-safe answer is residue.
  const prose = await partitionReferencedAssets(fakePage({}), {
    html: "<main>mentions upsell-payment-logos.svg in prose only</main>",
    pageUrl, referencedAssets: ["upsell-payment-logos.svg"], method: "paypal",
  });
  assert.deepEqual(prose.residue, ["upsell-payment-logos.svg"]);
  assert.deepEqual(prose.edited, []);
});

test("the roadflare shape: an edited asset is manual_review, not a blocker", () => {
  const artifacts = methodPaymentArtifacts(demeter.default_residue.payment_chrome, "paypal");
  const result = paymentChromeResidueAssertion({
    page: upsellPage,
    method: "paypal",
    artifacts,
    visibleMatches: [],
    referencedAssets: [],
    editedAssets: ["upsell-payment-logos.svg"],
    severity: "blocker",
  });

  assert.equal(result.status, "manual_review");
  // No severity: manual_review lands the verdict on ready_with_exceptions, and a
  // blocker severity here is what dispatched the repair that deleted the strip.
  assert.equal(result.severity, undefined);
  assert.match(result.actual, /edited in place/);
  assert.match(result.actual, /remove or rename/);
  assert.deepEqual(result.evidence.edited_assets, ["upsell-payment-logos.svg"]);
});

test("an unedited template strip still blocks, and visible chrome outranks an edit", () => {
  const artifacts = methodPaymentArtifacts(demeter.default_residue.payment_chrome, "paypal");

  const stillResidue = paymentChromeResidueAssertion({
    page: upsellPage,
    method: "paypal",
    artifacts,
    visibleMatches: [],
    referencedAssets: ["upsell-payment-logos.svg"],
    editedAssets: [],
    severity: "blocker",
  });
  assert.equal(stillResidue.status, "fail");
  assert.equal(stillResidue.severity, "blocker");

  // One asset edited, another still carrying the mark: the blocker wins. The
  // downgrade is for a page with nothing left to remove, not a partial cleanup.
  const mixed = paymentChromeResidueAssertion({
    page: upsellPage,
    method: "paypal",
    artifacts,
    visibleMatches: [],
    referencedAssets: ["paypal-logo.svg"],
    editedAssets: ["upsell-payment-logos.svg"],
    severity: "blocker",
  });
  assert.equal(mixed.status, "fail");
  assert.equal(mixed.severity, "blocker");

  // Rendered chrome is never downgraded by what the file says.
  const visible = paymentChromeResidueAssertion({
    page: checkoutPage,
    method: "klarna",
    artifacts: methodPaymentArtifacts(demeter.default_residue.payment_chrome, "klarna"),
    visibleMatches: [{ selector: ".payment-method__icon--klarna-logo", visible_count: 1 }],
    referencedAssets: [],
    editedAssets: ["upsell-payment-logos.svg"],
    severity: "blocker",
  });
  assert.equal(visible.status, "fail");
});
