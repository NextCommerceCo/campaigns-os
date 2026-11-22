// Real-browser proof for the upsell price probe reading the SDK's
// data-next-bundle-display price (campaigns-os#532). Visibility is a layout
// question (bounding box, computed display and visibility), so the fixture
// under fixtures/qa-price-display/ runs in Chromium: a visible bundle-display
// price counts, a hidden or empty one does not, even when the empty node has a
// size of its own.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { loadTemplateBrandContract } from "./template-brand-contract.mjs";

const { pricingVisibilityAssertions } = __qaBrowserTestHooks;

const FIXTURE = new URL("../fixtures/qa-price-display/upsell-bundle-display.html", import.meta.url).pathname;
const brandContract = loadTemplateBrandContract("olympus");
const upsellPage = { page_id: "upsell-1", page_type: "upsell", url: "https://shop.example.com/upsell/" };
const checkoutPage = { page_id: "checkout", page_type: "checkout", url: "https://shop.example.com/checkout/" };
const PRICE_NODE = '<span data-next-bundle-display="price">$29.00</span>';
const SIZED_EMPTY_PRICE_NODE = '<span data-next-bundle-display="price" style="display:inline-block;width:100px;height:20px"></span>';

let browser = null;

async function sharedBrowser() {
  if (browser) return browser;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  return browser;
}

after(async () => {
  if (browser) await browser.close();
  browser = null;
});

async function chromiumAvailable() {
  try {
    await sharedBrowser();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

// The probe waits up to 5 s for a late SDK price; a row that should read 0
// does not need the whole window to prove it.
const SHORT_SETTLE = { priceSettleTimeoutMs: 300 };

async function priceRow(priceNode = PRICE_NODE, pageDescriptor = upsellPage, settle = {}) {
  const html = (await readFile(FIXTURE, "utf8")).replace(PRICE_NODE, priceNode);
  const page = await (await sharedBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const [row] = await pricingVisibilityAssertions(page, pageDescriptor, { brandContract, ...settle });
    return row;
  } finally {
    await page.close();
  }
}

test("an upsell whose only price is data-next-bundle-display passes the price visibility row", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await priceRow();
  assert.equal(row.id, "pricing.upsell_price_visible:upsell-1");
  assert.equal(row.status, "pass");
  assert.equal(row.evidence.visible_count, 1);
});

test("a hidden or empty data-next-bundle-display price does not count as visible", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  for (const priceNode of [
    '<span data-next-bundle-display="price" style="display:none">$29.00</span>',
    '<span data-next-bundle-display="price" style="visibility:hidden">$29.00</span>',
    '<span data-next-bundle-display="price"></span>',
    SIZED_EMPTY_PRICE_NODE,
  ]) {
    const row = await priceRow(priceNode, upsellPage, SHORT_SETTLE);
    assert.ok(row.evidence.selectors.includes("[data-next-bundle-display*='price' i]"), "the bundle-display price was probed");
    assert.equal(row.status, "fail", priceNode);
    assert.equal(row.severity, "blocker", priceNode);
    assert.equal(row.evidence.visible_count, 0, priceNode);
  }
});

test("an upsell whose tier cards show only unitPrice bundle displays passes the price visibility row", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The SDK names its bundle price fields in camelCase (unitPrice,
  // originalUnitPrice). A design upsell built from tier cards shows no other
  // price; the probe used to match "price" case-sensitively and read 0 rows.
  const card = (quantity) => `<div data-next-bundle-card data-next-bundle-id="tier-${quantity}x" data-next-bundle-items='[{"packageId":3,"quantity":${quantity}}]'>`
    + `<div class="tier-price"><span data-next-bundle-display="unitPrice">$${(30 - quantity * 2).toFixed(2)}</span></div>`
    + '<div class="compare" data-next-bundle-display="hasDiscount"><span data-next-bundle-display="originalUnitPrice">$39.00</span></div></div>';
  const row = await priceRow(`<div data-next-bundle-selector>${[1, 2, 3].map(card).join("")}</div>`);
  assert.equal(row.status, "pass");
  assert.equal(row.evidence.visible_count, 6);

  // The remote binding spells the same fields in camelCase too.
  const remote = await priceRow('<span data-next-display="bundle.upsell-tiers.unitPrice">$26.00</span>');
  assert.equal(remote.status, "pass");
  assert.equal(remote.evidence.visible_count, 1);
});

test("a checkout bundle card counts a filled data-next-bundle-display price and not a sized empty one", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The fixture has no cart-summary total, so only the bundle price row can
  // pass the checkout row.
  const filled = await priceRow(PRICE_NODE, checkoutPage);
  assert.equal(filled.id, "pricing.checkout_price_visible");
  assert.equal(filled.status, "pass");
  assert.equal(filled.evidence.visible_count, 1);

  const empty = await priceRow(SIZED_EMPTY_PRICE_NODE, checkoutPage, SHORT_SETTLE);
  assert.ok(empty.evidence.selectors.includes("[data-next-bundle-display*='price' i]"), "the bundle-display price was probed");
  assert.equal(empty.evidence.visible_count, 0);
  assert.equal(empty.evidence.total_visible_count, 0);
  assert.equal(empty.status, "fail");
});

test("a checkout opened with an empty cart and no package selection of its own is skipped, not failed", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The single-step shape: the landing links to checkout with forcePackageId,
  // so the checkout carries no selector and its summary stays hidden while
  // the cart is empty.
  const sdkCart = (count) => `<script>window.next = { getCartCount: () => ${count} };</script>`;
  const hiddenSummary = '<div data-next-cart-summary style="display:none"></div>';
  const upstream = await priceRow(`${sdkCart(0)}${hiddenSummary}`, checkoutPage, SHORT_SETTLE);
  assert.equal(upstream.status, "skipped");
  assert.equal(upstream.severity, undefined);
  assert.equal(upstream.evidence.cart_count, 0);
  assert.equal(upstream.evidence.checkout_selection_surface.count, 0);

  // A checkout with its own package selection still fails when no price shows.
  const selector = await priceRow(`${sdkCart(0)}<div data-next-bundle-selector><div data-next-bundle-card data-next-package-id="1"></div></div>`, checkoutPage, SHORT_SETTLE);
  assert.equal(selector.status, "fail");
  // So does a filled cart whose prices are hidden, without the probe values.
  const filledCart = await priceRow(`${sdkCart(1)}${hiddenSummary}`, checkoutPage, SHORT_SETTLE);
  assert.equal(filledCart.status, "fail");
  assert.equal(filledCart.evidence.cart_count, undefined);
});

// Opens the fixture at a real URL so the page's own address can carry (or
// lack) the order reference QA reads.
async function priceRowAt(url, priceNode, pageDescriptor = upsellPage, settle = SHORT_SETTLE) {
  const html = (await readFile(FIXTURE, "utf8")).replace(PRICE_NODE, priceNode);
  const page = await (await sharedBrowser()).newPage();
  try {
    await page.route("https://shop.example.com/**", (handler) => handler.fulfill({ contentType: "text/html", body: html }));
    await page.goto(url, { waitUntil: "load" });
    const [row] = await pricingVisibilityAssertions(page, pageDescriptor, { brandContract, ...settle });
    return row;
  } finally {
    await page.close();
  }
}

test("an upsell whose offer is next-hidden until an order exists is skipped when opened without a ref_id", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The SDK marks [data-next-upsell="offer"] next-hidden (display:none) when
  // the page has no order. A buyer always arrives with ?ref_id=, and then the
  // offer and its prices show (F-241, batch-9 N1).
  const heldOffer = '<style>.next-hidden{display:none}</style><div data-next-upsell="offer" class="next-hidden">'
    + '<span data-next-bundle-display="price">$29.99</span></div>';
  const orderless = await priceRowAt("https://shop.example.com/upsell/", heldOffer);
  assert.equal(orderless.id, "pricing.upsell_price_visible:upsell-1");
  assert.equal(orderless.status, "skipped");
  assert.equal(orderless.severity, undefined);
  assert.equal(orderless.evidence.visible_count, 0);
  assert.equal(orderless.evidence.next_hidden_price_rows, 1);
  assert.match(orderless.actual, /no ref_id/);

  // With an order reference the same hidden offer is a real failure.
  const withOrder = await priceRowAt("https://shop.example.com/upsell/?ref_id=ABC123", heldOffer);
  assert.equal(withOrder.status, "fail");
  assert.equal(withOrder.severity, "blocker");
  assert.equal(withOrder.evidence.next_hidden_price_rows, undefined);

  // Prices hidden some other way without an order still fail.
  const cssHidden = await priceRowAt("https://shop.example.com/upsell/", '<span data-next-bundle-display="price" style="display:none">$29.99</span>');
  assert.equal(cssHidden.status, "fail");
  assert.equal(cssHidden.severity, "blocker");

  // A held offer beside a second price row hidden by CSS still fails: only a
  // page whose every price row is next-hidden is held for an order.
  const mixed = await priceRowAt("https://shop.example.com/upsell/", `${heldOffer}<span class="price-wrapper" style="display:none">$29.99</span>`);
  assert.equal(mixed.status, "fail");
  assert.equal(mixed.severity, "blocker");

  // A price wrapper and its nested bundle-display node are one row.
  const nested = await priceRowAt("https://shop.example.com/upsell/", '<style>.next-hidden{display:none}</style><div data-next-upsell="offer" class="next-hidden">'
    + '<span class="price-wrapper"><span data-next-bundle-display="price">$29.99</span></span></div>');
  assert.equal(nested.status, "skipped");
  assert.equal(nested.evidence.next_hidden_price_rows, 1);

  // Prices visible without an order are still checked and pass.
  const visible = await priceRowAt("https://shop.example.com/upsell/", PRICE_NODE);
  assert.equal(visible.status, "pass");
  assert.equal(visible.evidence.visible_count, 1);
});

test("an empty data-next-bundle-display price does not count through an overlapping .price-wrapper selector", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // .price-wrapper comes first in both surfaces' selector lists, so it reaches
  // the node before the bundle-display selector does.
  const overlap = '<span class="price-wrapper" data-next-bundle-display="price" style="display:inline-block;width:100px;height:20px"></span>';
  for (const pageDescriptor of [upsellPage, checkoutPage]) {
    const row = await priceRow(overlap, pageDescriptor, SHORT_SETTLE);
    assert.equal(row.evidence.selectors[0], ".price-wrapper", pageDescriptor.page_id);
    assert.equal(row.evidence.visible_count, 0, pageDescriptor.page_id);
    assert.equal(row.status, "fail", pageDescriptor.page_id);
  }
  // A filled node carrying both still counts once.
  const filled = await priceRow('<span class="price-wrapper" data-next-bundle-display="price">$29.00</span>');
  assert.equal(filled.status, "pass");
  assert.equal(filled.evidence.visible_count, 1);
});

test("an upsell or checkout whose bundle-display price the SDK fills after the page is read still passes", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The SDK writes bundle prices a moment after it reports ready. A single
  // read taken before that sees a sized but empty node and used to report 0
  // visible price rows on a correct page.
  const late = (ms, text) => `<span id="late" data-next-bundle-display="price" style="display:inline-block;min-width:100px;height:20px"></span>`
    + `<script>setTimeout(() => { document.getElementById("late").textContent = ${JSON.stringify(text)}; }, ${ms});</script>`;
  for (const pageDescriptor of [upsellPage, checkoutPage]) {
    const row = await priceRow(late(600, "$29.00"), pageDescriptor);
    assert.equal(row.status, "pass", pageDescriptor.page_id);
    assert.equal(row.evidence.visible_count, 1, pageDescriptor.page_id);
  }

  // A price that never arrives still fails once the wait runs out.
  const never = await priceRow(late(60000, "$29.00"), upsellPage, SHORT_SETTLE);
  assert.equal(never.status, "fail");
  assert.equal(never.severity, "blocker");
  assert.equal(never.evidence.visible_count, 0);
});
