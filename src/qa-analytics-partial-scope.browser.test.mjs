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
import { applyQaBuildScope } from "./qa-build-scope.mjs";
import { __qaNodeTestHooks as qaNodeHooks } from "./qa-node.mjs";
import { SEVERITY, STATUS } from "./qa-verdict.mjs";

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
// endpoint answers a 1x1 so nothing leaves the process. `pages` overrides a
// path's status/body (e.g. a host that answers 200 with a generic fallback at
// the root, or 503 everywhere).
async function partialBuildContext(pages = {}) {
  const context = await (await sharedBrowser()).newContext();
  const html = await readFile(FIXTURE, "utf8");
  const visited = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith("facebook.com")) {
      return route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64") });
    }
    if (route.request().resourceType() === "document") visited.push(url.pathname);
    const override = url.origin === ORIGIN ? pages[url.pathname] : null;
    if (override) return route.fulfill({ status: override.status, contentType: "text/html", body: override.body ?? html });
    if (url.origin === ORIGIN && url.pathname === "/campaign/checkout/") {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" });
  });
  return { context, visited };
}

async function runLeg(options, pages) {
  const { context, visited } = await partialBuildContext(pages);
  try {
    const assertions = await hooks.captureAnalyticsCorrectnessInContext(context, ROOT, CONTRACT, ARGS, [], options);
    return { assertions, visited };
  } finally {
    await context.close();
  }
}

// The capture options qa-node hands this leg, computed from a topology through
// the real build-scope filter rather than written by hand.
function scopeFor(pageIds, { skipped = [], partial = true, rootPage = null } = {}) {
  const declared = skipped.map((page_id) => ({ page_id, skip_reason: "Remains on another host" }));
  const topologies = [{
    funnel_id: "default",
    pages: pageIds.map((page_id, order) => ({
      page_id, page_type: page_id, order, label: page_id,
      url: page_id === rootPage ? ROOT : `${ROOT}${page_id}/`,
    })),
  }];
  const qaScope = partial
    ? applyQaBuildScope(topologies, {
      packet: { source_html: { pages: declared } },
      report: { stages: { prepare_build: { declared_out_of_scope: declared } } },
      publicRouteSlug: "campaign",
    })
    : { topologies, excludedPages: [] };
  return qaNodeHooks.analyticsCaptureScope({
    analyticsCaptureTarget: { url: ROOT },
    topologies: qaScope.topologies,
    excludedPages: qaScope.excludedPages,
  });
}

const GENERIC_FALLBACK = { status: 200, body: "<!doctype html><title>Index of /campaign/</title><h1>Index</h1>" };
const UNAVAILABLE = { status: 503, body: "<!doctype html><title>Service unavailable</title>" };

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

browserTest("an in-scope root that answers non-2xx with no fallback is an unmeasured blocker, not a skip", async () => {
  const { assertions } = await runLeg({ rootInScope: true, fallbackTargets: [] });

  assert.equal(assertions.length, 1, "no per-vendor assertion is emitted against an empty page");
  const [capture] = assertions;
  assert.equal(capture.id, "analytics-correctness:capture");
  assert.equal(capture.status, STATUS.FAIL);
  assert.equal(capture.severity, SEVERITY.BLOCKER);
  assert.equal(capture.evidence.reason, "no_capture_page_answered");
  assert.deepEqual(capture.evidence.attempts, [{ url: ROOT, source: "campaign_root", outcome: "non_2xx", http_status: 404 }]);
});

browserTest("an out-of-scope root with no built entry is skipped without a visit, and every attempt carries http_status", async () => {
  const { assertions, visited } = await runLeg({ rootInScope: false, fallbackTargets: [] });

  assert.deepEqual(visited, [], "nothing is loaded");
  assert.equal(assertions.length, 1);
  const [capture] = assertions;
  assert.equal(capture.status, STATUS.SKIPPED);
  assert.equal(capture.evidence.reason, "no_in_scope_page_captured");
  assert.deepEqual(capture.evidence.attempts, [{ url: ROOT, source: "campaign_root", outcome: "out_of_built_scope", http_status: null }]);
});

browserTest("a fallback naming the root under another spelling is not loaded twice, and never loads an out-of-scope root", async () => {
  const unslashed = { ...ENTRY, page_id: "landing", url: `${ORIGIN}/campaign` };
  const indexed = { ...ENTRY, page_id: "landing", url: `${ORIGIN}/campaign/index.html` };

  const inScope = await runLeg({ rootInScope: true, fallbackTargets: [unslashed, indexed, ENTRY] });
  assert.deepEqual(inScope.visited, ["/campaign/", "/campaign/checkout/"], "the root is loaded once");
  assert.equal(byId(inScope.assertions, "analytics-correctness:tag:meta").status, STATUS.PASS);

  const outOfScope = await runLeg({ rootInScope: false, fallbackTargets: [unslashed, indexed, ENTRY] });
  assert.deepEqual(outOfScope.visited, ["/campaign/checkout/"], "the out-of-scope root is never loaded");
});

browserTest("presell and landing excluded: a root that answers 200 with a generic fallback is not captured; the checkout entry is", async () => {
  const options = scopeFor(["presell", "landing", "checkout", "receipt"], { skipped: ["presell", "landing"] });
  const { assertions, visited } = await runLeg(options, { "/campaign/": GENERIC_FALLBACK });

  assert.deepEqual(visited, ["/campaign/checkout/"], "the unbuilt root is never visited");
  const meta = byId(assertions, "analytics-correctness:tag:meta");
  assert.equal(meta.status, STATUS.PASS, `tag:meta ${meta.status}: ${meta.actual}`);
  assert.equal(meta.url, CHECKOUT);
  const capture = byId(assertions, "analytics-correctness:capture");
  assert.equal(capture.evidence.capture_page.page_id, "checkout");
  assert.equal(capture.evidence.root_fallback.reason, "out_of_built_scope");
});

browserTest("every candidate answering 503 fails as a blocker naming each attempt, so a later order cannot report ready unmeasured", async () => {
  const options = scopeFor(["presell", "landing", "checkout", "receipt"], { skipped: ["presell", "landing"] });
  const { assertions } = await runLeg(options, { "/campaign/": UNAVAILABLE, "/campaign/checkout/": UNAVAILABLE });

  assert.equal(assertions.length, 1);
  const [capture] = assertions;
  assert.equal(capture.id, "analytics-correctness:capture");
  assert.equal(capture.status, STATUS.FAIL);
  assert.equal(capture.severity, SEVERITY.BLOCKER);
  assert.equal(capture.evidence.reason, "no_capture_page_answered");
  assert.deepEqual(capture.evidence.attempts, [
    { url: ROOT, source: "campaign_root", outcome: "out_of_built_scope", http_status: null },
    { url: CHECKOUT, source: "built_entry", outcome: "non_2xx", http_status: 503 },
  ]);
  assert.match(capture.actual, /503/);
});

browserTest("a full build whose landing page is the root still captures the root", async () => {
  const options = scopeFor(["landing", "checkout", "receipt"], { partial: false, rootPage: "landing" });
  assert.equal(options.rootInScope, true);
  const { assertions, visited } = await runLeg(options, { "/campaign/": { status: 200 } });

  assert.deepEqual(visited, ["/campaign/"]);
  const capture = byId(assertions, "analytics-correctness:capture");
  assert.equal(capture.status, STATUS.PASS);
  assert.equal(capture.evidence.capture_page.source, "campaign_root");
  assert.equal(capture.evidence.root_fallback, undefined);
  assert.equal(byId(assertions, "analytics-correctness:tag:meta").status, STATUS.PASS);
});
