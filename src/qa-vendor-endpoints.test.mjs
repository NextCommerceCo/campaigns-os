import test from "node:test";
import assert from "node:assert/strict";

import {
  configuredVendors,
  INTERCEPTED_VENDORS,
  NOT_INTERCEPTED_VENDORS,
  readVendorBeacon,
  VENDOR_ENDPOINTS,
  VENDOR_KEYS,
  vendorBeaconFor,
} from "./qa-vendor-endpoints.mjs";

// The analytics.vendors keys of Map Builder's Route C vendor registry
// (ROUTE_C_VENDORS), plus the two SDK providers. A vendor added there owes an
// entry here, intercepted or named as not.
const ROUTE_C_VENDOR_KEYS = ["ga4", "axon", "taboola", "triplewhale", "tiktok", "northbeam", "snap", "pinterest"];

test("the endpoint list covers exactly the Route C vendors plus gtm and meta", () => {
  assert.deepEqual([...VENDOR_KEYS].sort(), [...ROUTE_C_VENDOR_KEYS, "gtm", "meta"].sort());
  assert.deepEqual(VENDOR_ENDPOINTS.map((entry) => entry.vendor), [...VENDOR_KEYS]);
});

test("every intercepted vendor records where its endpoints were confirmed, every other one why not", () => {
  for (const entry of VENDOR_ENDPOINTS) {
    assert.ok(entry.loaders.length > 0, `${entry.vendor} names its loader, which always passes through`);
    if (entry.beacons.length) assert.match(entry.source, /\S/, `${entry.vendor} source`);
    else assert.match(entry.reason, /\S/, `${entry.vendor} reason`);
  }
  assert.deepEqual(NOT_INTERCEPTED_VENDORS.map((entry) => entry.vendor), ["gtm", "northbeam"]);
  assert.deepEqual(INTERCEPTED_VENDORS, ["meta", "ga4", "axon", "taboola", "triplewhale", "tiktok", "snap", "pinterest"]);
});

test("beacon endpoints match and loader scripts never do, even on a shared host", () => {
  const beacon = (url) => vendorBeaconFor(url)?.vendor || null;
  assert.equal(beacon("https://www.facebook.com/tr?id=1&ev=Purchase"), "meta");
  assert.equal(beacon("https://www.facebook.com/tr/"), "meta");
  assert.equal(beacon("https://www.facebook.com/trust"), null, "a path prefix matches whole segments");
  assert.equal(beacon("https://connect.facebook.net/en_US/fbevents.js"), null);
  assert.equal(beacon("https://region1.google-analytics.com/g/collect?tid=G-1&en=purchase"), "ga4");
  assert.equal(beacon("https://stats.g.doubleclick.net/g/collect?tid=G-1"), "ga4");
  assert.equal(beacon("https://www.googletagmanager.com/gtag/js?id=G-1"), null);
  assert.equal(beacon("https://www.googletagmanager.com/gtm.js?id=GTM-1"), null);
  assert.equal(beacon("https://analytics.tiktok.com/api/v2/pixel"), "tiktok");
  assert.equal(beacon("https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1"), null);
  assert.equal(beacon("https://api.config-security.com/event"), "triplewhale");
  assert.equal(beacon("https://api.config-security.com/first?host=shop.example"), null);
  assert.equal(beacon("https://conf.config-security.com/model"), null);
  assert.equal(beacon("https://tr.snapchat.com/p"), "snap");
  assert.equal(beacon("https://sc-static.net/scevent.min.js"), null);
  assert.equal(beacon("https://ct.pinterest.com/v3/?tid=2612&event=checkout"), "pinterest");
  assert.equal(beacon("https://ct.pinterest.com/static/ct/token_create.js"), null);
  assert.equal(beacon("https://s.pinimg.com/ct/core.js"), null);
  assert.equal(beacon("https://trc.taboola.com/1234567/log/3/unip?en=make_purchase"), "taboola");
  assert.equal(beacon("https://cdn.taboola.com/libtrc/unip/1234567/tfa.js"), null);
  assert.equal(beacon("https://b.applovin.com/v1/pixel?event_key=k"), "axon");
  assert.equal(beacon("https://s.axon.ai/pixel.js"), null);
  assert.equal(beacon("https://j.northbeam.io/ota-sp/client.js"), null, "Northbeam is not intercepted");
  assert.equal(beacon("https://shop.example.com/tr"), null);
  assert.equal(beacon("not a url"), null);
});

test("a beacon is read for its vendor, ids and event names from the query, the path or the body", () => {
  assert.deepEqual(readVendorBeacon("https://www.facebook.com/tr?id=998877&ev=Purchase&eid=ord-1&cd%5Bvalue%5D=45"), {
    vendor: "meta",
    endpoint: "https://www.facebook.com/tr",
    ids: ["998877"],
    events: ["Purchase"],
    purchase: true,
  });
  // GA4 batches one event per URL-encoded body line.
  const ga4 = readVendorBeacon("https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST1&cid=1.2", "en=page_view&_et=1\nen=purchase&ep.transaction_id=1");
  assert.deepEqual([ga4.ids, ga4.events, ga4.purchase], [["G-TEST1"], ["page_view", "purchase"], true]);
  // TikTok and Snap carry both in a JSON body; TikTok's id is nested.
  const tiktok = readVendorBeacon("https://analytics.tiktok.com/api/v2/pixel", JSON.stringify({ event: "Purchase", context: { pixel: { code: "CTEST" } } }));
  assert.deepEqual([tiktok.ids, tiktok.events, tiktok.purchase], [["CTEST"], ["Purchase"], true]);
  const snap = readVendorBeacon("https://tr.snapchat.com/p", JSON.stringify([{ pid: "snap-1", ev: "PAGE_VIEW" }]));
  assert.deepEqual([snap.ids, snap.events, snap.purchase], [["snap-1"], ["PAGE_VIEW"], false]);
  // Taboola's account id is a path segment.
  const taboola = readVendorBeacon("https://trc.taboola.com/1234567/log/3/unip?en=make_purchase&item-url=https%3A%2F%2Fshop.example%2F");
  assert.deepEqual([taboola.endpoint, taboola.ids, taboola.purchase], ["https://trc.taboola.com/1234567/log/3/unip", ["1234567"], true]);
  // Axon's event field is unconfirmed, so a purchase is unknown, not false.
  const axon = readVendorBeacon("https://b.applovin.com/v1/pixel?event_key=ek-1", JSON.stringify({ name: "purchase" }));
  assert.deepEqual([axon.ids, axon.events, axon.purchase], [["ek-1"], [], null]);
  assert.equal(readVendorBeacon("https://connect.facebook.net/en_US/fbevents.js"), null);
});

test("configured vendors come from the spec's analytics block, by vendor key", () => {
  assert.deepEqual(configuredVendors({
    providers: { gtm: { containerId: "GTM-1" }, facebook: { pixelId: "1" }, rudderstack: { enabled: true } },
    vendors: { triplewhale: { id: "shop.example" }, snap: { id: "s", enabled: false } },
    out_of_band_pixels: [{ vendor: "northbeam" }, { vendor: "everflow" }],
  }), ["gtm", "meta", "triplewhale", "northbeam"]);
  assert.deepEqual(configuredVendors({ mode: "disabled", providers: { gtm: {} } }), []);
  assert.deepEqual(configuredVendors(null), []);
});
