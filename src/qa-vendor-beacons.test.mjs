import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyTagFire, effectivePurchase, normalizeCapture } from "./qa-analytics-parity.mjs";
import { computeDisposition, isFindingAssertion } from "./qa-verdict.mjs";
import {
  createVendorBeaconLedger,
  QA_VENDOR_BEACONS,
  routeVendorBeacons,
  vendorBeaconAssertion,
  vendorBeaconLedgerFor,
  vendorBeaconMode,
  withVendorBeaconRouting,
} from "./qa-vendor-beacons.mjs";
import { readVendorBeacon } from "./qa-vendor-endpoints.mjs";
import { REFUSED_INVOCATION } from "./lifecycle.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";

test("interception is the default for a test-order run, live is the opt-out, other values are refused", () => {
  assert.equal(vendorBeaconMode({}), null, "no test order: nothing is routed");
  assert.equal(vendorBeaconMode({ "test-order": "off" }), null);
  assert.equal(vendorBeaconMode({ "test-order": "common" }), "intercept");
  assert.equal(vendorBeaconMode({ "test-order": true }), "intercept", "bare --test-order");
  assert.equal(vendorBeaconMode({ "test-order": "common", "vendor-beacons": "live" }), "live");
  assert.equal(vendorBeaconMode({ "test-order": "common", "vendor-beacons": "LIVE" }), "live");
  for (const args of [{ "vendor-beacons": "live" }, { "test-order": "off", "vendor-beacons": "live" }]) {
    assert.throws(() => vendorBeaconMode(args), (error) => {
      assert.equal(error.code, REFUSED_INVOCATION);
      assert.match(error.message, /applies only to a browser test-order run/);
      return true;
    }, "live without a test order would do nothing, so it is refused");
  }
  for (const value of ["intercept", "off", "", true, "live,intercept"]) {
    assert.throws(() => vendorBeaconMode({ "test-order": "common", "vendor-beacons": value }), (error) => {
      assert.equal(error.code, REFUSED_INVOCATION);
      assert.match(error.message, /--vendor-beacons takes one value, live/);
      return true;
    }, `refuses ${JSON.stringify(value)}`);
  }
});

test("a listed beacon is a tag fire of its vendor, so inventory and the Meta purchase read it", () => {
  assert.deepEqual(
    [classifyTagFire("https://ct.pinterest.com/v3/?tid=2612&event=checkout").kind, classifyTagFire("https://ct.pinterest.com/v3/?tid=2612&event=checkout").id],
    ["pinterest", "2612"],
  );
  assert.equal(classifyTagFire("https://trc.taboola.com/1234567/log/3/unip?en=page_view").id, "1234567");
  assert.equal(classifyTagFire("https://tr.snapchat.com/p").kind, "snap");
  assert.equal(classifyTagFire("https://s.pinimg.com/ct/core.js"), null, "a loader of a new vendor is not a fire");
  // The kinds classified before keep their ids.
  assert.equal(classifyTagFire("https://www.facebook.com/tr?id=998877&ev=Purchase").id, "998877");
  assert.equal(classifyTagFire("https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CTEST").id, "CTEST");
  const capture = normalizeCapture({
    tagFires: [
      classifyTagFire("https://www.facebook.com/tr?id=998877&ev=Purchase&eid=ord-1"),
      classifyTagFire("https://ct.pinterest.com/v3/?tid=2612&event=checkout"),
    ],
  });
  assert.deepEqual(capture.inventory.pinterest, ["2612"]);
  assert.deepEqual(capture.inventory.triplewhale, []);
  // A vendor beacon never becomes purchase proof: only the Meta row it always had.
  assert.equal(effectivePurchase(capture).via, "meta");
});

function fakeRequest({ url, method = "GET", body = null, headers = {} }) {
  return { url: () => url, method: () => method, postData: () => body, headers: () => headers };
}

function fakeContext() {
  const routes = [];
  const listeners = [];
  return {
    routes,
    listeners,
    route: async (matcher, handler) => { routes.push({ matcher, handler }); },
    on: (event, listener) => { if (event === "request") listeners.push(listener); },
  };
}

test("intercept mode answers a listed beacon locally and records it; other requests are not matched", async () => {
  const ledger = createVendorBeaconLedger({ mode: "intercept", analytics: { providers: { facebook: { pixelId: "998877" } }, vendors: { snap: { id: "s-1" } } } });
  const context = fakeContext();
  await routeVendorBeacons(context, ledger);
  assert.equal(context.routes.length, 1);
  const { matcher, handler } = context.routes[0];
  assert.equal(matcher(new URL("https://www.facebook.com/tr?id=1")), true);
  assert.equal(matcher(new URL("https://connect.facebook.net/en_US/fbevents.js")), false);
  assert.equal(matcher(new URL("https://shop.example.com/checkout/")), false);

  const fulfilled = [];
  const route = (request) => ({ request: () => request, fulfill: async (answer) => { fulfilled.push(answer); } });
  await handler(route(fakeRequest({ url: "https://www.facebook.com/tr?id=998877&ev=Purchase", headers: { origin: "https://shop.example.com" } })));
  await handler(route(fakeRequest({ url: "https://www.facebook.com/tr", method: "OPTIONS" })));
  assert.equal(fulfilled.length, 2, "a CORS preflight is answered too");
  assert.equal(fulfilled[0].status, 204);
  assert.equal(fulfilled[0].headers["access-control-allow-origin"], "https://shop.example.com");
  assert.equal(fulfilled[0].headers["access-control-allow-credentials"], "true");

  const row = vendorBeaconAssertion(ledger);
  assert.equal(row.id, "browser-test-order:vendor-beacons");
  assert.deepEqual(row.evidence.vendors.meta, {
    requests: 1, purchase_seen: true, ids: ["998877"], events: ["Purchase"], endpoints: ["https://www.facebook.com/tr"],
  }, "the preflight is not counted, and nothing from the query string but the id and event is kept");
  assert.deepEqual(row.evidence.configured_not_seen, ["snap"]);
  assert.deepEqual(row.evidence.configured_not_observable, []);
  assert.deepEqual(row.evidence.not_intercepted.map((entry) => entry.vendor), ["gtm", "northbeam"]);
  assert.match(row.actual, /^answered locally: meta 1 \(purchase\); configured, never seen: snap; not intercepted: gtm, northbeam$/);
  // Evidence only: never a finding, never a blocker.
  assert.equal(isFindingAssertion(row), false);
  assert.equal(computeDisposition([row]), "ready");
});

test("live mode routes nothing and records the listed requests as they go out", async () => {
  const ledger = createVendorBeaconLedger({ mode: "live" });
  const context = fakeContext();
  await routeVendorBeacons(context, ledger);
  assert.equal(context.routes.length, 0);
  for (const listener of context.listeners) {
    listener(fakeRequest({ url: "https://tr.snapchat.com/p", method: "POST", body: JSON.stringify({ pid: "s-1", ev: "PURCHASE" }) }));
    listener(fakeRequest({ url: "https://sc-static.net/scevent.min.js" }));
  }
  const row = vendorBeaconAssertion(ledger);
  assert.deepEqual(Object.keys(row.evidence.vendors), ["snap"]);
  assert.equal(row.evidence.vendors.snap.purchase_seen, true);
  assert.deepEqual(row.evidence.not_intercepted.map((entry) => entry.vendor).sort(), [
    "axon", "ga4", "gtm", "meta", "northbeam", "pinterest", "snap", "taboola", "tiktok", "triplewhale",
  ], "with live nothing is intercepted, and the field is still a list");
  assert.equal(row.evidence.not_intercepted.find((entry) => entry.vendor === "meta").reason, "--vendor-beacons live");
  assert.match(row.evidence.not_intercepted.find((entry) => entry.vendor === "northbeam").reason, /Northbeam|beacon/i);
  assert.match(row.actual, /^sent: snap 1 \(purchase\)/);
  assert.equal(computeDisposition([row]), "ready");
});

test("a configured vendor with no listed beacon is not reported as never seen", () => {
  const ledger = createVendorBeaconLedger({
    mode: "intercept",
    analytics: { providers: { gtm: { containerId: "GTM-AB12" }, facebook: { pixelId: "1" } }, vendors: { northbeam: { id: "nb-1" }, snap: { id: "s-1" } } },
  });
  ledger.record(readVendorBeacon("https://www.facebook.com/tr?id=1&ev=Purchase"));
  const row = vendorBeaconAssertion(ledger);
  assert.deepEqual(row.evidence.configured, ["gtm", "meta", "northbeam", "snap"]);
  assert.deepEqual(row.evidence.configured_not_seen, ["snap"], "GTM and Northbeam cannot be seen, so they are not 'never seen'");
  assert.deepEqual(row.evidence.configured_not_observable, ["gtm", "northbeam"]);
  assert.equal(
    row.actual,
    "answered locally: meta 1 (purchase); configured, never seen: snap; not intercepted: gtm (configured), northbeam (configured)",
  );
});

test("a routed browser routes every context it opens, and is untouched when the run routes nothing", async () => {
  const opened = [];
  const browser = {
    newContext: async (options) => { const context = { ...fakeContext(), options }; opened.push(context); return context; },
    close: async function close() { return this === browser; },
  };
  assert.equal(withVendorBeaconRouting(browser, null), browser);
  const ledger = createVendorBeaconLedger({ mode: "intercept" });
  const routed = withVendorBeaconRouting(browser, ledger);
  await routed.newContext({ viewport: { width: 1, height: 1 } });
  await routed.newContext();
  assert.deepEqual(opened.map((context) => context.routes.length), [1, 1]);
  assert.deepEqual(opened[0].options, { viewport: { width: 1, height: 1 }, serviceWorkers: "block" }, "a service worker could pass a beacon around the route");
  assert.deepEqual(opened[1].options, { serviceWorkers: "block" });
  await withVendorBeaconRouting(browser, createVendorBeaconLedger({ mode: "live" })).newContext({ viewport: { width: 2, height: 2 } });
  assert.deepEqual(opened[2].options, { viewport: { width: 2, height: 2 } }, "live mode leaves the context options alone");
  assert.equal(await routed.close(), true, "other methods keep the real browser as this");
  assert.equal(vendorBeaconLedgerFor({ [QA_VENDOR_BEACONS]: ledger }), ledger);
  assert.equal(vendorBeaconLedgerFor({ "test-order": "common" }), null);
});

test("the ledger keeps a bounded set of values per vendor", () => {
  const ledger = createVendorBeaconLedger({ mode: "intercept" });
  for (let index = 0; index < 25; index += 1) ledger.record(readVendorBeacon(`https://www.facebook.com/tr?id=${index}&ev=PageView`));
  const meta = vendorBeaconAssertion(ledger).evidence.vendors.meta;
  assert.equal(meta.requests, 25);
  assert.equal(meta.ids.length, 10);
  assert.equal(meta.purchase_seen, false);
});

// qa run threads one ledger through its browser legs and adds the row. A
// topology with no checkout means the order leg returns before any browser
// launches, so this needs no Chromium and makes no browser request.
function resolvedWithoutCheckout() {
  return {
    themeGate: { status: "pass", code: "theme_gate.brand_layer_present", reason: "Fixture theme gate passes." },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Fixture has no assembly report." },
    checkpointGates: [],
    qaWaivers: {},
    analyticsCaptureTarget: { url: null, source: "unresolved" },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath: null,
    packet: null,
    mapId: "vendor-beacons",
    publicRouteSlug: "vendor-beacons",
    proxyBase: "https://proxy.example.test",
    baseUrl: "https://preview.example.test/",
    specPath: null,
    specSource: "test",
    portalManaged: false,
    rawSpec: { campaign: { ref_id: 4242 } },
    spec: { campaign: { ref_id: 4242 }, analytics: { vendors: { tiktok: { id: "CTEST" } } } },
    specVersion: "4.3",
    specHash: "sha256:vendor-beacons",
    templateFamily: null,
    commerceStructureContract: null,
    topologies: [{ funnel_id: "default", funnel_name: "Default", weight: 100, pages: [] }],
  };
}

test("qa run --test-order carries the vendor-beacons row; without --test-order it does not", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "qa-vendor-beacons-"));
  const realWrite = process.stderr.write;
  process.stderr.write = () => true;
  const run = (args) => __qaNodeTestHooks.runResolvedQa({
    _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, "no-live-refs": true, "analytics-correctness": "false", ...args,
  }, resolvedWithoutCheckout());
  try {
    const rowOf = (result) => result.verdict.assertions.find((entry) => entry.id === "browser-test-order:vendor-beacons");
    const intercepted = rowOf(await run({ "test-order": "common" }));
    assert.equal(intercepted.evidence.mode, "intercept");
    assert.deepEqual(intercepted.evidence.configured_not_seen, ["tiktok"]);
    const live = rowOf(await run({ "test-order": "common", "vendor-beacons": "live" }));
    assert.equal(live.evidence.mode, "live");
    assert.equal(rowOf(await run({})), undefined);
  } finally {
    process.stderr.write = realWrite;
    rmSync(outputDir, { recursive: true, force: true });
  }
});
