// Real-browser proof that the analytics-correctness inventory captures the
// built entry of a partial build instead of an absent campaign root
// (campaigns-os#493).
//
// The fixture campaign is built from checkout/ onward: the presell and
// landing pages live on another host, so /<slug>/ answers 404 and the
// declared Meta pixel only loads on the built checkout page. The leg used to
// capture the root and fail the pixel as "absent (0 fired)".
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";
import { STATUS } from "./qa-verdict.mjs";

const FIXTURE = new URL("../fixtures/qa-analytics-partial-scope/checkout.html", import.meta.url).pathname;
const ORIGIN = "https://partial.fixture.test";
const ROOT = `${ORIGIN}/campaign/`;
const CHECKOUT = `${ORIGIN}/campaign/checkout/`;
const PIXEL_ID = "1000000000000001";
const CONTRACT = { providers: { facebook: { enabled: true, pixelId: PIXEL_ID } } };
const ARGS = { "analytics-settle": "250", "browser-timeout": "10000" };
const ENTRY = { funnel_id: "default", page_id: "checkout", url: CHECKOUT };

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

// The campaign root has no page; checkout/ is the built entry; the pixel
// endpoint answers a 1x1 so nothing leaves the process.
async function partialBuildContext() {
  const context = await (await sharedBrowser()).newContext();
  const html = await readFile(FIXTURE, "utf8");
  const visited = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith("facebook.com")) {
      return route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64") });
    }
    if (route.request().resourceType() === "document") visited.push(url.pathname);
    if (url.origin === ORIGIN && url.pathname === "/campaign/checkout/") {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" });
  });
  return { context, visited };
}

async function runLeg(options) {
  const { context, visited } = await partialBuildContext();
  try {
    const assertions = await hooks.captureAnalyticsCorrectnessInContext(context, ROOT, CONTRACT, ARGS, [], options);
    return { assertions, visited };
  } finally {
    await context.close();
  }
}

const byId = (assertions, id) => assertions.find((item) => item.id === id);

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed analytics partial-scope proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("a root out of the built scope is not visited; the built checkout entry is captured and the declared pixel passes", async () => {
  const { assertions, visited } = await runLeg({ rootInScope: false, fallbackTargets: [ENTRY] });

  const meta = byId(assertions, "analytics-correctness:tag:meta");
  assert.equal(meta.status, STATUS.PASS, `tag:meta ${meta.status}: ${meta.actual}`);
  assert.equal(meta.url, CHECKOUT, "the tag assertion names the page it measured");
  assert.deepEqual(visited, ["/campaign/checkout/"], "the out-of-scope root is never visited");

  const capture = byId(assertions, "analytics-correctness:capture");
  assert.equal(capture.status, STATUS.PASS);
  assert.equal(capture.url, CHECKOUT);
  assert.deepEqual(capture.evidence.capture_page, {
    url: CHECKOUT, source: "built_entry", page_id: "checkout", funnel_id: "default", http_status: 200,
  });
  assert.deepEqual(capture.evidence.root_fallback, { url: ROOT, reason: "out_of_built_scope", http_status: null });
});

browserTest("a root in scope that answers non-2xx falls back to the built entry and records the root status", async () => {
  const { assertions, visited } = await runLeg({ rootInScope: true, fallbackTargets: [ENTRY] });

  const meta = byId(assertions, "analytics-correctness:tag:meta");
  assert.equal(meta.status, STATUS.PASS, `tag:meta ${meta.status}: ${meta.actual}`);
  assert.deepEqual(visited, ["/campaign/", "/campaign/checkout/"]);
  const capture = byId(assertions, "analytics-correctness:capture");
  assert.equal(capture.evidence.capture_page.source, "built_entry");
  assert.deepEqual(capture.evidence.root_fallback, { url: ROOT, reason: "non_2xx", http_status: 404 });
});

browserTest("with no capturable in-scope page the leg is skipped with a named reason, not a fail per vendor", async () => {
  const { assertions } = await runLeg({ rootInScope: true, fallbackTargets: [] });

  assert.equal(assertions.length, 1, "no per-vendor assertion is emitted against an empty page");
  const [capture] = assertions;
  assert.equal(capture.id, "analytics-correctness:capture");
  assert.equal(capture.status, STATUS.SKIPPED);
  assert.equal(capture.evidence.reason, "no_in_scope_page_captured");
  assert.deepEqual(capture.evidence.attempts, [{ url: ROOT, source: "campaign_root", outcome: "non_2xx", http_status: 404 }]);
  assert.equal(assertions.some((item) => item.status === STATUS.FAIL), false);
});
