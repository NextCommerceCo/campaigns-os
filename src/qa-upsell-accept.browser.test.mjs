// Real-browser proof that an upsell accept completes against a control under a
// perpetual transform animation (campaigns-os#481).
//
// Stock upsell accept buttons carry pb-animate="pulse-upsell", which never lets
// Playwright see the element as stable. The runner used to arm its 20s upsell
// mutation watch, then spend ~30s on an unbounded scrollIntoViewIfNeeded() and
// 10s on a normal click before the forced click fired, so the POST landed after
// the watch had expired: api_response_seen false on a real accept. The fixture
// under fixtures/qa-upsell-accept/ carries the shipped animation rule verbatim.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";

const FIXTURE = new URL("../fixtures/qa-upsell-accept/pulse-upsell/upsell.html", import.meta.url).pathname;
const ORIGIN = "https://upsell.fixture.test";
const REF = "FIXTUREREF1";

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

// Serves the fixture offer, a 201 for the order upsell mutation, and a bare
// thank-you page, all from one fake origin so nothing leaves the process.
async function openOffer() {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1280, height: 720 } });
  const html = await readFile(FIXTURE, "utf8");
  const posts = [];
  await context.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/upsell/")) {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    if (request.method() === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells/`) {
      posts.push(Date.now());
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ref_id: REF, lines: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Thanks</title><p>Thanks</p>" });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/upsell/?ref_id=${REF}`, { waitUntil: "load" });
  return { context, page, posts };
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed upsell accept proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("the pulsing accept control is detected as perpetually animated; a paint-only loop is not", async () => {
  const { context, page } = await openOffer();
  try {
    assert.equal(await hooks.isPerpetuallyAnimated(page.locator('[data-next-upsell-action="add"]')), true);
    assert.equal(await hooks.isPerpetuallyAnimated(page.locator('[data-next-upsell-action="skip"]')), false);
  } finally {
    await context.close();
  }
});

browserTest("an accept on a pb-animate=\"pulse-upsell\" control sees the upsell POST well inside the step budget", async () => {
  const { context, page, posts } = await openOffer();
  try {
    // The fixture only exercises the scroll if the accept starts off-screen.
    const top = await page.locator('[data-next-upsell-action="add"]').evaluate((element) => element.getBoundingClientRect().top - window.innerHeight);
    assert.ok(top > 0, "the accept control starts below the fold");

    // clickUpsellPath is the production step end to end: scroll, probe,
    // mutation watch, click, and the post-click checkout-result wait.
    const started = Date.now();
    const step = await hooks.clickUpsellPath(page, "accept");
    const elapsed = Date.now() - started;

    assert.equal(posts.length, 1, "the accept click posted the order upsell mutation exactly once");
    assert.equal(step.clicked, true);
    assert.equal(step.api_response_seen, true, "the mutation watch was still listening when the POST landed");
    assert.equal(step.api_response_status, 201);
    assert.match(step.final_url, /\/thank-you\/\?ref_id=/);
    // The old sequence took 40s+ before the POST even fired.
    assert.ok(elapsed < 15000, `accept path took ${elapsed}ms; expected well under 15s`);
    // The click itself must not wait on stability: the POST lands within a
    // couple of seconds of starting, not after a scroll or click timeout.
    assert.ok(posts[0] - started < 5000, `upsell POST fired ${posts[0] - started}ms after the step started`);
  } finally {
    await context.close();
  }
});
