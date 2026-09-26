// Real-browser proof for #500: the analytics-correctness inventory records the
// page URL it actually settled on, so a localhost campaign root that redirects
// to a production host is not mistaken for a local development render.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";
import { assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { __qaNodeTestHooks as qaNodeHooks } from "./qa-node.mjs";
import { STATUS } from "./qa-verdict.mjs";

const REMOTE_HOST = "preview.fixture.test";
const CONTRACT = { providers: { facebook: { enabled: true, pixelId: "1000000000000001" } } };
const ARGS = { "analytics-settle": "250", "browser-timeout": "10000" };
const PAGE = "<!doctype html><title>Campaign</title><h1>Campaign</h1>";
const developmentReport = { stages: { assembly: { evidence: { build_environment: "development" } } } };

// One real server plays both sides so the redirect is an HTTP 302 the browser
// follows (Playwright routes do not see a redirect's follow-up request):
// requests to 127.0.0.1 are the local-serve origin, and Chromium's host
// resolver maps the remote production host onto the same socket.
let redirectRoot = false;
const server = createServer((request, response) => {
  const remote = String(request.headers.host || "").startsWith(`${REMOTE_HOST}:`);
  if (request.url === "/campaign/" && redirectRoot && !remote) {
    response.writeHead(302, { location: REMOTE_ROOT });
    return response.end();
  }
  if (request.url === "/campaign/") {
    response.writeHead(200, { "content-type": "text/html" });
    return response.end(PAGE);
  }
  response.writeHead(404, { "content-type": "text/html" });
  return response.end("<!doctype html><title>Not found</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const LOCAL_ROOT = `${ORIGIN}/campaign/`;
const REMOTE_ROOT = `http://${REMOTE_HOST}:${server.address().port}/campaign/`;
const localServePacket = { deploy: { target: "local-serve", preview_url: `${ORIGIN}/` } };

let browser = null;

async function sharedBrowser() {
  if (browser) return browser;
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`] });
  return browser;
}

after(async () => {
  if (browser) await browser.close();
  browser = null;
  await new Promise((resolve) => server.close(resolve));
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

// `redirect` makes the loopback root answer 302 to the remote host.
async function captureLeg({ redirect }) {
  redirectRoot = redirect;
  const context = await (await sharedBrowser()).newContext();
  try {
    return await hooks.captureAnalyticsCorrectnessInContext(context, LOCAL_ROOT, CONTRACT, ARGS, [], {});
  } finally {
    await context.close();
  }
}

async function reviewed(inventory) {
  const assertions = [];
  await qaNodeHooks.runAnalyticsOrderSequence({
    args: {},
    resolved: {
      spec: { analytics: CONTRACT },
      analyticsCaptureTarget: { url: LOCAL_ROOT },
      qaWaivers: {},
      localServeAnalytics: qaNodeHooks.resolveLocalServeAnalytics({ packet: localServePacket, report: developmentReport, captureUrl: LOCAL_ROOT }),
    },
    runId: "run-500",
    assertions,
  }, {
    async runInventory() { return inventory; },
    async runOrders() { return { orders: [], receiptAnalytics: { plannedPlanIds: [], attempts: [] } }; },
    assessReceipt: assessReceiptPurchase,
  });
  return assertions;
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed local-serve redirect proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("a localhost root that redirects to a production host records the final URL and keeps the pixel blocker", async () => {
  const inventory = await captureLeg({ redirect: true });
  const capture = inventory.find((item) => item.id === "analytics-correctness:capture");
  assert.equal(capture.evidence.capture_page.url, LOCAL_ROOT);
  assert.equal(capture.evidence.final_url, REMOTE_ROOT);
  const meta = (await reviewed(inventory)).find((item) => item.id === "analytics-correctness:tag:meta");
  assert.equal(meta.status, STATUS.FAIL);
  assert.equal(meta.evidence.reason, undefined);
});

browserTest("a localhost root served in place records a loopback final URL and is reviewed", async () => {
  const inventory = await captureLeg({ redirect: false });
  const capture = inventory.find((item) => item.id === "analytics-correctness:capture");
  assert.equal(capture.evidence.final_url, LOCAL_ROOT);
  const meta = (await reviewed(inventory)).find((item) => item.id === "analytics-correctness:tag:meta");
  assert.equal(meta.status, STATUS.MANUAL_REVIEW);
  assert.equal(meta.evidence.reason, "local_serve_development_render");
});
