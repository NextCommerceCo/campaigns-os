// Real-browser proof that a decline reaches the shopper's visible control when
// the SDK skip action is kept hidden inside the offer and a proxy button
// outside it forwards the click (the starter templates' single-offer upsell:
// box style with show_decline off and a closing-card decline).
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";

const ORIGIN = "https://decline.fixture.test";

// The SDK skip navigates to the decline URL; the proxy forwards its click to
// the in-offer action, as upsells.js initUpsellProxyActions does.
const OFFER = `<!doctype html><title>Offer</title>
<div data-next-upsell="offer">
  <button data-next-upsell-action="add">Yes, add it</button>
  <div class="cc-decline-wrapper" style="display:none" aria-hidden="true">
    <a data-next-upsell-action="skip" href="#">No thanks</a>
  </div>
</div>
<section><a data-upsell-proxy="skip" href="#">No thank you</a></section>
<script>
  document.querySelector('[data-next-upsell-action="skip"]').addEventListener('click', (event) => {
    event.preventDefault();
    location.href = '/thank-you/';
  });
  document.querySelector('[data-upsell-proxy="skip"]').addEventListener('click', (event) => {
    event.preventDefault();
    document.querySelector('[data-next-upsell="offer"] [data-next-upsell-action="skip"]').click();
  });
</script>`;

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

async function openOffer(html) {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1280, height: 720 } });
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.startsWith("/upsell/") ? html : "<!doctype html><title>Thanks</title><p>Thanks</p>";
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/upsell/`, { waitUntil: "load" });
  return { context, page };
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed upsell decline proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("a decline clicks the visible proxy when the in-offer skip is hidden", async () => {
  const { context, page } = await openOffer(OFFER);
  try {
    const step = await hooks.clickUpsellPath(page, "decline");
    assert.equal(step.error, undefined);
    assert.equal(step.clicked, true);
    assert.match(step.final_url, /\/thank-you\/$/);
  } finally {
    await context.close();
  }
});

browserTest("a visible proxy with no in-offer skip is still a missing control", async () => {
  const html = OFFER.replace(/<div class="cc-decline-wrapper"[\s\S]*?<\/div>/, "").replace(/<script>[\s\S]*<\/script>/, "");
  const { context, page } = await openOffer(html);
  try {
    const step = await hooks.clickUpsellPath(page, "decline");
    assert.equal(step.clicked, false);
    assert.match(step.error, /Missing upsell control/);
  } finally {
    await context.close();
  }
});
