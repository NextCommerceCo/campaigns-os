// Real-browser proof for the vendor-beacons effect rows of `qa run
// --test-order` (campaigns-os#689): a fixture page fires beacons to listed
// vendor endpoints. By default they are answered locally and recorded, and the
// page's own analytics capture still sees them as tag fires; with
// `--vendor-beacons live` they are let through.
//
// Nothing here reaches the network. The browser's own contexts carry a
// catch-all route registered before the run's routing, standing in for the
// network: it serves the fixture page and loader, answers any vendor request
// that gets past the run's routing, and records it. Routes registered later
// run first, so the run's routing sees each request before the stand-in.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { attachAnalyticsCapture } from "./qa-analytics-parity.mjs";
import { createVendorBeaconLedger, vendorBeaconAssertion, withVendorBeaconRouting } from "./qa-vendor-beacons.mjs";

const ORIGIN = "https://shop.fixture.test";
const PAGE = `${ORIGIN}/campaign/receipt/`;

const PAGE_HTML = `<!doctype html><html><head><title>Receipt</title>
<script src="https://sc-static.net/scevent.min.js"></script>
</head><body><h1>Thanks</h1><script>
window.__results = {};
(async () => {
  window.__results.beacon = navigator.sendBeacon("https://www.facebook.com/tr?id=998877&ev=Purchase&eid=ord-1");
  window.__results.snap = await fetch("https://tr.snapchat.com/p", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid: "snap-1", ev: "PURCHASE" }),
  }).then((response) => response.status, (error) => "error: " + error.message);
  window.__results.pinterest = await new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve("load");
    image.onerror = () => resolve("error");
    image.src = "https://ct.pinterest.com/v3/?tid=2612&event=checkout";
  });
  window.__done = true;
})();
</script></body></html>`;

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

// The real browser with the network stand-in installed on every context it
// opens, before anything the run adds.
function standInBrowser(real, network) {
  return {
    newContext: async (options) => {
      const context = await real.newContext(options);
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === ORIGIN) return route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML });
        network.push({ host: url.hostname, path: url.pathname, method: request.method() });
        if (url.hostname === "sc-static.net") return route.fulfill({ status: 200, contentType: "text/javascript", body: "window.__loaderRan = true;" });
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": ORIGIN,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "content-type",
          },
          body: "",
        });
      });
      return context;
    },
  };
}

async function runFixture(mode) {
  const network = [];
  const ledger = createVendorBeaconLedger({ mode, analytics: { providers: { facebook: { pixelId: "998877" } }, vendors: { tiktok: { id: "CTEST" } } } });
  const context = await withVendorBeaconRouting(standInBrowser(await sharedBrowser(), network), ledger).newContext();
  try {
    const page = await context.newPage();
    const capture = await attachAnalyticsCapture(page);
    await page.goto(PAGE);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 10000 });
    // sendBeacon settles after the page's own promise chain.
    await page.waitForTimeout(250);
    const results = await page.evaluate(() => ({ ...window.__results, loaderRan: window.__loaderRan === true }));
    const collected = await capture.collect();
    capture.detach();
    return { network, ledger, results, collected };
  } finally {
    await context.close();
  }
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; vendor-beacon browser proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("vendor beacons: a --test-order run answers listed vendor beacons locally and records them", async () => {
  const { network, ledger, results, collected } = await runFixture("intercept");

  // The loader still loads; no beacon reaches the network stand-in.
  assert.equal(results.loaderRan, true);
  assert.deepEqual(network.map((request) => request.host), ["sc-static.net"]);
  // Each beacon settled as a success on the page.
  assert.equal(results.beacon, true);
  assert.equal(results.snap, 204);

  const row = vendorBeaconAssertion(ledger);
  assert.equal(row.evidence.mode, "intercept");
  assert.deepEqual(Object.keys(row.evidence.vendors).sort(), ["meta", "pinterest", "snap"]);
  assert.deepEqual(row.evidence.vendors.meta, { requests: 1, purchase_seen: true, ids: ["998877"], events: ["Purchase"], endpoints: ["https://www.facebook.com/tr"] });
  assert.deepEqual([row.evidence.vendors.snap.requests, row.evidence.vendors.snap.ids, row.evidence.vendors.snap.purchase_seen], [1, ["snap-1"], true]);
  assert.deepEqual([row.evidence.vendors.pinterest.ids, row.evidence.vendors.pinterest.purchase_seen], [["2612"], true]);
  assert.deepEqual(row.evidence.configured_not_seen, ["tiktok"]);
  assert.equal(JSON.stringify(row).includes("eid=ord-1"), false, "no query string is recorded");

  // The page's analytics capture read the same requests as tag fires.
  assert.deepEqual(collected.inventory.meta, ["998877"]);
  assert.deepEqual(collected.inventory.snap, ["snap-1"]);
  assert.deepEqual(collected.inventory.pinterest, ["2612"]);
  assert.equal(collected.purchaseSignals.meta, true);
  assert.equal(collected.metaPurchaseEventId, "ord-1");
});

browserTest("vendor beacons: --vendor-beacons live lets the listed vendor beacons through", async () => {
  const { network, ledger, results, collected } = await runFixture("live");

  const reached = network.map((request) => `${request.method} ${request.host}${request.path}`);
  assert.ok(reached.includes("POST www.facebook.com/tr"), reached.join(", "));
  assert.ok(reached.includes("POST tr.snapchat.com/p"), reached.join(", "));
  assert.ok(reached.includes("GET ct.pinterest.com/v3/"), reached.join(", "));
  assert.equal(results.snap, 204);

  const row = vendorBeaconAssertion(ledger);
  assert.equal(row.evidence.mode, "live");
  assert.deepEqual(Object.keys(row.evidence.vendors).sort(), ["meta", "pinterest", "snap"]);
  assert.equal(row.evidence.vendors.snap.requests, 1);
  assert.match(row.actual, /^sent: /);
  assert.deepEqual(collected.inventory.meta, ["998877"]);
});
