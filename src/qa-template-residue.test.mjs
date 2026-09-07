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
  fetchAssetText,
  readBoundedAssetText,
  ASSET_FETCH_TIMEOUT_MS,
  ASSET_FETCH_MAX_BYTES,
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

// evaluate() receives the bounded-read argument object; the URL is its target.
function fakePage(bodyByUrl) {
  return {
    evaluate: async (fn, arg) => {
      const body = bodyByUrl[arg.target];
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
  const page = "https://example.test/c/upsell/";
  const resolve = (html) => referencedAssetUrl(html, "upsell-payment-logos.svg", page);

  assert.equal(
    resolve('<img src="../images/upsell-payment-logos.svg" alt="payments">'),
    "https://example.test/c/images/upsell-payment-logos.svg"
  );
  assert.equal(resolve("<main>clean</main>"), null);
});

test("every reference form a deployed page actually uses resolves to the asset", () => {
  // The first cut scooped up whatever non-quote text preceded the basename, so a
  // reference could resolve to something like <page>/src=name.svg — a 404, then
  // residue, then a blocker on a page with no chrome. Each form is anchored on
  // the delimiters it really has, and each keeps any ?query#fragment it carries.
  const page = "https://example.test/c/upsell/";
  const resolve = (html) => referencedAssetUrl(html, "upsell-payment-logos.svg", page);
  const asset = "https://example.test/c/upsell/images/upsell-payment-logos.svg";

  assert.equal(resolve('<img src="images/upsell-payment-logos.svg">'), asset);
  // Cache-busted: the suffix has to survive, or we fetch a URL the site never served.
  assert.equal(resolve('<img src="images/upsell-payment-logos.svg?v=4">'), `${asset}?v=4`);
  // A style attribute is itself a quoted value, so url() has to win first or the
  // whole `background:url(...)` declaration gets resolved as a path.
  assert.equal(resolve('<div style="background:url(images/upsell-payment-logos.svg)">'), asset);
  assert.equal(resolve(`<div style="background:url('images/upsell-payment-logos.svg')">`), asset);
  assert.equal(resolve("<img src=images/upsell-payment-logos.svg>"), asset);
  assert.equal(resolve('<svg><use href="images/upsell-payment-logos.svg#paypal"/></svg>'), `${asset}#paypal`);
});

test("one fetch per URL per page, not one per method", () => {
  // The contract attributes an asset matching no method token to EVERY
  // unsupported method, so the same strip is asked about once per method. Without
  // the shared cache that is N round-trips against the deployed site for one file.
  const html = '<img src="images/upsell-payment-logos.svg">';
  const pageUrl = "https://example.test/c/upsell/";
  const assetUrl = "https://example.test/c/upsell/images/upsell-payment-logos.svg";
  let fetches = 0;
  const counting = {
    evaluate: async (fn, arg) => {
      fetches += 1;
      return arg.target === assetUrl ? EDITED_STRIP : null;
    },
  };
  const cache = new Map();

  return Promise.all(["paypal", "klarna"].map((method) =>
    partitionReferencedAssets(counting, {
      html, pageUrl, referencedAssets: ["upsell-payment-logos.svg"], method, cache,
    })
  )).then((results) => {
    assert.equal(fetches, 1);
    for (const result of results) assert.deepEqual(result.edited, ["upsell-payment-logos.svg"]);
  });
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

// --- Bounded asset reads (review finding A3, 2026-09-07) ---
// fetchAssetText ran fetch()+text() in the page with no deadline and no size
// ceiling of its own; the browser navigation timeout does not cover it. Every
// case below runs the same page-side function under Node with fetch stubbed.

function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = original; });
}

function streamOf(chunks, { stall = false } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      if (chunks.length > 0) {
        const chunk = chunks.shift();
        controller.enqueue(chunk instanceof Uint8Array ? chunk : encoder.encode(chunk));
        return undefined;
      }
      if (stall) return new Promise(() => {});
      controller.close();
      return undefined;
    },
  });
}

function responseWith(body, { ok = true, contentLength } = {}) {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { ok, headers, body, text: async () => "unused" };
}

const bounded = (overrides = {}) => readBoundedAssetText({ target: "https://example.test/a.svg", timeoutMs: 50, maxBytes: 64, ...overrides });

test("bounded read: a normal small asset comes back whole, edited or unedited", async () => {
  await withFetch(async () => responseWith(streamOf([EDITED_STRIP.slice(0, 20), EDITED_STRIP.slice(20)])), async () => {
    assert.equal(await bounded({ maxBytes: 1024 }), EDITED_STRIP);
  });
  await withFetch(async () => responseWith(streamOf([UNTOUCHED_STRIP])), async () => {
    assert.equal(await bounded({ maxBytes: 1024 }), UNTOUCHED_STRIP);
  });
});

test("bounded read: headers that never arrive time out to null and release the timer", async () => {
  let abortedSignal = null;
  const stub = (_url, { signal }) => new Promise((_, reject) => {
    abortedSignal = signal;
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const started = Date.now();
  await withFetch(stub, async () => {
    assert.equal(await bounded(), null);
  });
  assert.ok(abortedSignal?.aborted, "the fetch was aborted by the deadline");
  assert.ok(Date.now() - started < 1000, "returned on the deadline, not much later");
});

test("bounded read: a body that stalls after the first chunk times out to null", async () => {
  await withFetch(async () => responseWith(streamOf(["<svg>"], { stall: true })), async () => {
    const started = Date.now();
    assert.equal(await bounded(), null);
    assert.ok(Date.now() - started < 1000);
  });
});

test("bounded read: a fetch that does not honour abort is still bounded by the raced read", async () => {
  // A fetch stub that ignores the signal entirely and never settles.
  await withFetch(() => new Promise(() => {}), async () => {
    assert.equal(await bounded(), null);
  });
});

test("bounded read: Content-Length past the cap is refused without reading the body", async () => {
  let readerTaken = false;
  const body = { getReader() { readerTaken = true; return { read: () => new Promise(() => {}), cancel: async () => {} }; } };
  await withFetch(async () => responseWith(body, { contentLength: 65 }), async () => {
    assert.equal(await bounded(), null);
  });
  assert.equal(readerTaken, false);
});

test("bounded read: a missing or understated Content-Length does not let an oversized body through", async () => {
  const big = "x".repeat(65);
  await withFetch(async () => responseWith(streamOf([big.slice(0, 30), big.slice(30)])), async () => {
    assert.equal(await bounded(), null);
  });
  await withFetch(async () => responseWith(streamOf([big.slice(0, 30), big.slice(30)]), { contentLength: 10 }), async () => {
    assert.equal(await bounded(), null);
  });
});

test("bounded read: one oversized chunk is refused on arrival", async () => {
  await withFetch(async () => responseWith(streamOf([new Uint8Array(65)])), async () => {
    assert.equal(await bounded(), null);
  });
});

test("bounded read: a non-OK response and a network error are both null", async () => {
  await withFetch(async () => responseWith(streamOf(["<svg/>"]), { ok: false }), async () => {
    assert.equal(await bounded(), null);
  });
  await withFetch(async () => { throw new TypeError("network down"); }, async () => {
    assert.equal(await bounded(), null);
  });
});

test("bounded read: a response without a streamable body is refused, never read through text()", async () => {
  // Response.text() takes no signal and allocates the whole body before any cap
  // could be checked, so a body that cannot be streamed cannot be bounded.
  let textCalled = false;
  await withFetch(async () => ({ ok: true, headers: new Headers(), body: null, text: async () => { textCalled = true; return "<svg/>"; } }), async () => {
    assert.equal(await bounded(), null);
  });
  assert.equal(textCalled, false);
});

test("bounded read: a slow reader.cancel() does not hold the read past the deadline", async () => {
  const body = { getReader() { return { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }; } };
  const started = Date.now();
  await withFetch(async () => responseWith(body), async () => {
    assert.equal(await bounded(), null);
  });
  assert.ok(Date.now() - started < 1000, "settled on the deadline even though cancel() never settles");
});

test("fetchAssetText: an evaluate() that never settles cannot hold the QA call open", async () => {
  const hung = { evaluate: () => new Promise(() => {}) };
  const started = Date.now();
  assert.equal(await fetchAssetText(hung, "https://example.test/a.svg", { timeoutMs: 20 }), null);
  // The outer race is the in-page deadline plus one second of headroom.
  assert.ok(Date.now() - started < 3000);
});

test("fetchAssetText: passes the bounds into the page and treats a non-string result as unreadable", async () => {
  let seen = null;
  const page = { evaluate: async (fn, arg) => { seen = { fn, arg }; return 42; } };
  assert.equal(await fetchAssetText(page, "https://example.test/a.svg"), null);
  assert.equal(seen.fn, readBoundedAssetText);
  assert.deepEqual(seen.arg, { target: "https://example.test/a.svg", timeoutMs: ASSET_FETCH_TIMEOUT_MS, maxBytes: ASSET_FETCH_MAX_BYTES });
});

test("a timed-out asset stays residue, and the cache still dedupes the URL across methods", async () => {
  const html = '<img src="images/upsell-payment-logos.svg">';
  const pageUrl = "https://example.test/c/upsell/";
  let calls = 0;
  const hung = { evaluate: () => { calls += 1; return new Promise(() => {}); } };
  const cache = new Map();
  const results = await Promise.all(["paypal", "klarna"].map((method) =>
    partitionReferencedAssets(hung, { html, pageUrl, referencedAssets: ["upsell-payment-logos.svg"], method, cache, assetBounds: { timeoutMs: 20 } })
  ));
  // The hung page is cut by the outer race, and the cut read is residue, not a pass.
  for (const result of results) assert.deepEqual(result, { residue: ["upsell-payment-logos.svg"], edited: [] });
  assert.equal(calls, 1);
});
