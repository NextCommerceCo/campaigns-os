// Real-browser proof that analytics-correctness:tag:meta observes a pixel that
// initialises and tracks in-page when headless Chromium never sends the
// facebook.com/tr request (campaigns-os#686).
//
// The page bootstraps the pixel with Meta's standard base code. fbevents.js is
// served as a stub that installs callMethod and drains the queue but sends
// nothing, which is what the reported headless run saw.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";
import { attachAnalyticsCapture } from "./qa-analytics-parity.mjs";
import { STATUS } from "./qa-verdict.mjs";

const ORIGIN = "https://meta.fixture.test";
const PAGE = `${ORIGIN}/campaign/`;
const PIXEL_ID = "1000000000000002";
const CONTRACT = { providers: { facebook: { enabled: true, pixelId: PIXEL_ID } } };
const ARGS = { "analytics-settle": "250", "browser-timeout": "10000" };

const FBEVENTS_STUB = `(() => {
  const fbq = window.fbq;
  const calls = [];
  fbq.callMethod = function () { calls.push(Array.from(arguments)); };
  for (const args of fbq.queue.splice(0)) fbq.callMethod.apply(fbq, args);
  window.__stubFbqCalls = calls;
})();`;

function pageHtml(calls) {
  return `<!doctype html><html><head><title>Landing</title><script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
${calls}
</script></head><body><h1>Landing</h1></body></html>`;
}

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

async function metaContext(calls) {
  const context = await (await sharedBrowser()).newContext();
  const pixelRequests = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "connect.facebook.net") {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: FBEVENTS_STUB });
    }
    if (url.hostname.endsWith("facebook.com")) {
      pixelRequests.push(url.pathname);
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.origin === ORIGIN && url.pathname === "/campaign/") {
      return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(calls) });
    }
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" });
  });
  return { context, pixelRequests };
}

async function metaRow(calls) {
  const { context, pixelRequests } = await metaContext(calls);
  try {
    const assertions = await hooks.captureAnalyticsCorrectnessInContext(context, PAGE, CONTRACT, ARGS, [], {});
    return { row: assertions.find((item) => item.id === "analytics-correctness:tag:meta"), assertions, pixelRequests };
  } finally {
    await context.close();
  }
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed Meta fbq proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("a pixel that initialises and tracks in-page passes tag:meta with no /tr request", async () => {
  const { row, assertions, pixelRequests } = await metaRow(`fbq('init', '${PIXEL_ID}'); fbq('track', 'PageView');`);
  assert.deepEqual(pixelRequests, [], "the stub sends nothing, as in the reported headless run");
  assert.equal(row.status, STATUS.PASS, `tag:meta ${row.status}: ${row.actual}`);
  assert.equal(row.evidence.observed_count, 1);
  const capture = assertions.find((item) => item.id === "analytics-correctness:capture");
  assert.equal(capture.evidence.inventory.meta, 1);
});

browserTest("init with advanced-matching userData records the pixel id, not the userData", async () => {
  const { row } = await metaRow(`fbq('init', '${PIXEL_ID}', { em: 'hashed' }); fbq('track', 'PageView');`);
  assert.equal(row.status, STATUS.PASS, `tag:meta ${row.status}: ${row.actual}`);
  assert.equal(row.evidence.observed_count, 1);
});

browserTest("a pixel that initialises but never tracks still fails tag:meta", async () => {
  const { row } = await metaRow(`fbq('init', '${PIXEL_ID}');`);
  assert.equal(row.status, STATUS.FAIL);
  assert.equal(row.evidence.observed_count, 0);
  assert.equal(row.evidence.reason, undefined, "the wrapper was intact, so this is a measured absence");
  assert.match(row.actual, /^absent/);
});

browserTest("a different pixel tracking in-page does not satisfy the declared pixel", async () => {
  const { row } = await metaRow("fbq('init', '1000000000000999'); fbq('track', 'PageView');");
  assert.equal(row.status, STATUS.FAIL);
  assert.equal(row.evidence.observed_count, 1);
});

browserTest("a page that redefines window.fbq reports tag:meta as unmeasured, not a clean absence", async () => {
  const { row } = await metaRow(`fbq('init', '${PIXEL_ID}');
const real = window._fbq;
Object.defineProperty(window, 'fbq', { configurable: true, writable: true, value: function () { return real.apply(this, arguments); } });
fbq('track', 'PageView');`);
  assert.equal(row.status, STATUS.FAIL);
  assert.equal(row.evidence.reason, "fbq_observer_disarmed");
  assert.match(row.actual, /^unmeasured: the page replaced window\.fbq/);
});

browserTest("the fbq wrapper leaves the pixel's own queue and callMethod working, and an in-page Purchase is not a Meta Purchase fire", async () => {
  const { context } = await metaContext(`fbq('init', '${PIXEL_ID}'); fbq('track', 'Purchase', { value: 1 }, { eventID: 'order-1' });`);
  const page = await context.newPage();
  try {
    const handle = await attachAnalyticsCapture(page);
    await page.goto(PAGE, { waitUntil: "load" });
    await page.waitForFunction(() => Array.isArray(window.__stubFbqCalls));
    const stubCalls = await page.evaluate(() => window.__stubFbqCalls.map((args) => args[0]));
    assert.deepEqual(stubCalls, ["init", "track"], "fbevents.js still receives every queued call");
    assert.equal(await page.evaluate(() => window.fbq.version), "2.0");
    const capture = await handle.collect();
    assert.deepEqual(capture.inventory.meta, [PIXEL_ID]);
    assert.deepEqual(capture.metaRequestIds, []);
    assert.equal(capture.purchaseSignals.meta, false);
    assert.equal(capture.metaPurchaseEventId, null);
    handle.detach();
  } finally {
    await context.close();
  }
});
