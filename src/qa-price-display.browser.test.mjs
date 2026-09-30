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

async function priceRow(priceNode = PRICE_NODE, pageDescriptor = upsellPage) {
  const html = (await readFile(FIXTURE, "utf8")).replace(PRICE_NODE, priceNode);
  const page = await (await sharedBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const [row] = await pricingVisibilityAssertions(page, pageDescriptor, { brandContract });
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
    const row = await priceRow(priceNode);
    assert.ok(row.evidence.selectors.includes("[data-next-bundle-display*='price']"), "the bundle-display price was probed");
    assert.equal(row.status, "fail", priceNode);
    assert.equal(row.severity, "blocker", priceNode);
    assert.equal(row.evidence.visible_count, 0, priceNode);
  }
});

test("a checkout bundle card counts a filled data-next-bundle-display price and not a sized empty one", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The fixture has no cart-summary total, so only the bundle price row can
  // pass the checkout row.
  const filled = await priceRow(PRICE_NODE, checkoutPage);
  assert.equal(filled.id, "pricing.checkout_price_visible");
  assert.equal(filled.status, "pass");
  assert.equal(filled.evidence.visible_count, 1);

  const empty = await priceRow(SIZED_EMPTY_PRICE_NODE, checkoutPage);
  assert.ok(empty.evidence.selectors.includes("[data-next-bundle-display*='price']"), "the bundle-display price was probed");
  assert.equal(empty.evidence.visible_count, 0);
  assert.equal(empty.evidence.total_visible_count, 0);
  assert.equal(empty.status, "fail");
});

test("an empty data-next-bundle-display price does not count through an overlapping .price-wrapper selector", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // .price-wrapper comes first in both surfaces' selector lists, so it reaches
  // the node before the bundle-display selector does.
  const overlap = '<span class="price-wrapper" data-next-bundle-display="price" style="display:inline-block;width:100px;height:20px"></span>';
  for (const pageDescriptor of [upsellPage, checkoutPage]) {
    const row = await priceRow(overlap, pageDescriptor);
    assert.equal(row.evidence.selectors[0], ".price-wrapper", pageDescriptor.page_id);
    assert.equal(row.evidence.visible_count, 0, pageDescriptor.page_id);
    assert.equal(row.status, "fail", pageDescriptor.page_id);
  }
  // A filled node carrying both still counts once.
  const filled = await priceRow('<span class="price-wrapper" data-next-bundle-display="price">$29.00</span>');
  assert.equal(filled.status, "pass");
  assert.equal(filled.evidence.visible_count, 1);
});
