// Keeping test orders out of vendor data (campaigns-os#689, #683 item 5).
//
// A `qa run --test-order` run places real orders, and the page under test
// reports each purchase to every analytics vendor the campaign configures. By
// default every browser context the run opens answers requests to the listed
// vendor beacon endpoints (qa-vendor-endpoints.mjs) with a local 204, so they
// never reach the vendor. Loader scripts pass through. `--vendor-beacons live`
// turns that off.
//
// Either way each request to a listed endpoint is recorded, and the verdict
// carries the record as evidence: per vendor, how many requests, whether one
// named a purchase, the ids and event names, plus the configured vendors never
// seen and the vendors the list does not intercept. It is evidence only
// (decided 2026-10-29): "the page sent it" is never vendor purchase proof and
// never a blocker, since an answered request proves the page sent it, not that
// the vendor received it. Purchase proof stays with effectivePurchase.
//
// The intercepted requests still reach the page's own request listeners, so
// attachAnalyticsCapture's tagFires (via classifyTagFire) see them too.
//
// Page-method-only, like qa-analytics-parity.mjs: no playwright import.

import { refused } from "./lifecycle.mjs";
import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import { configuredVendors, NOT_INTERCEPTED_VENDORS, readVendorBeacon, vendorBeaconFor } from "./qa-vendor-endpoints.mjs";

// The run's ledger rides on args under this key, like QA_RUN_CURRENCY, so every
// browser leg of one `qa run` records into the same one.
export const QA_VENDOR_BEACONS = Symbol("qa run --vendor-beacons");

export const VENDOR_BEACON_MODES = Object.freeze({
  INTERCEPT: "intercept",
  LIVE: "live",
});

// Kept per vendor; past these the counts still grow but no new value is kept.
const MAX_VALUES = 10;

// "intercept" or "live" for a run that drives browser test orders, null for
// one that does not (nothing is routed or recorded then). Any --vendor-beacons
// value but `live` is refused before anything runs.
export function vendorBeaconMode(args = {}) {
  if (Object.hasOwn(args, "vendor-beacons")) {
    const value = args["vendor-beacons"];
    if (typeof value !== "string" || value.trim().toLowerCase() !== VENDOR_BEACON_MODES.LIVE) {
      const got = typeof value === "string" && value !== "" ? JSON.stringify(value) : "no value";
      throw refused(`--vendor-beacons takes one value, live, which lets test-order runs send to the analytics vendors (got ${got}). Leave the flag off to answer vendor beacons locally.`);
    }
  }
  const testOrder = String(args["test-order"] ?? "off").toLowerCase();
  if (!testOrder || testOrder === "off" || testOrder === "false") return null;
  return Object.hasOwn(args, "vendor-beacons") ? VENDOR_BEACON_MODES.LIVE : VENDOR_BEACON_MODES.INTERCEPT;
}

// The per-run record. `configured` is the vendor keys the CampaignSpec
// analytics block declares.
export function createVendorBeaconLedger({ mode, analytics = null } = {}) {
  const vendors = new Map();
  return {
    mode,
    configured: configuredVendors(analytics),
    vendors,
    record(read) {
      if (!read) return;
      let entry = vendors.get(read.vendor);
      if (!entry) {
        entry = { requests: 0, purchase: read.purchase === null ? null : false, ids: new Set(), events: new Set(), endpoints: new Set() };
        vendors.set(read.vendor, entry);
      }
      entry.requests += 1;
      if (read.purchase === true) entry.purchase = true;
      const keep = (set, values) => { for (const value of values) if (set.size < MAX_VALUES) set.add(value); };
      keep(entry.ids, read.ids);
      keep(entry.events, read.events);
      keep(entry.endpoints, [read.endpoint]);
    },
  };
}

// The ledger to record into for this run, or null when nothing is routed.
export function vendorBeaconLedgerFor(args) {
  return args?.[QA_VENDOR_BEACONS] || null;
}

function postDataOf(request) {
  try {
    const body = typeof request.postData === "function" ? request.postData() : null;
    return typeof body === "string" ? body : null;
  } catch {
    return null;
  }
}

function headerOf(request, name) {
  try {
    const headers = typeof request.headers === "function" ? request.headers() : {};
    return headers?.[name] || null;
  } catch {
    return null;
  }
}

// The local answer: 204 with CORS headers for the requesting origin, so a
// beacon sent by fetch or XHR with credentials settles as a success rather
// than an error the vendor script retries.
function localAnswer(request) {
  const origin = headerOf(request, "origin");
  return {
    status: 204,
    headers: {
      ...(origin
        ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" }
        : { "access-control-allow-origin": "*" }),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": headerOf(request, "access-control-request-headers") || "content-type",
    },
    body: "",
  };
}

function methodOf(request) {
  try { return String(request.method()).toUpperCase(); } catch { return "GET"; }
}

// Route one browser context for the run. Intercept mode answers every request
// to a listed beacon endpoint locally and records it; anything else falls
// through to the context's other routes or the network. Live mode routes
// nothing and records the requests as they go out. Routing a context turns off
// its HTTP cache, which no QA check relies on (each leg opens a fresh context).
export async function routeVendorBeacons(context, ledger) {
  if (!context || !ledger) return context;
  const recordRequest = (request) => {
    if (methodOf(request) === "OPTIONS") return;
    ledger.record(readVendorBeacon(request.url(), postDataOf(request)));
  };
  if (ledger.mode === VENDOR_BEACON_MODES.LIVE) {
    context.on("request", (request) => {
      if (vendorBeaconFor(request.url())) recordRequest(request);
    });
    return context;
  }
  await context.route((url) => Boolean(vendorBeaconFor(url.href)), async (route) => {
    const request = route.request();
    recordRequest(request);
    await route.fulfill(localAnswer(request));
  });
  return context;
}

// A browser whose every new context is routed for the run. The browser itself
// comes back unchanged when the run routes nothing.
export function withVendorBeaconRouting(browser, ledger) {
  if (!browser || !ledger) return browser;
  const newContext = browser.newContext.bind(browser);
  return new Proxy(browser, {
    get(target, key, receiver) {
      if (key === "newContext") return async (...args) => routeVendorBeacons(await newContext(...args), ledger);
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The verdict's evidence for the run.
export function vendorBeaconEvidence(ledger) {
  const vendors = {};
  for (const [vendor, entry] of ledger.vendors) {
    vendors[vendor] = {
      requests: entry.requests,
      purchase_seen: entry.purchase,
      ids: [...entry.ids],
      events: [...entry.events],
      endpoints: [...entry.endpoints],
    };
  }
  return {
    mode: ledger.mode,
    vendors,
    configured: [...ledger.configured],
    configured_not_seen: ledger.configured.filter((vendor) => !ledger.vendors.has(vendor)),
    not_intercepted: ledger.mode === VENDOR_BEACON_MODES.LIVE
      ? "all: --vendor-beacons live"
      : NOT_INTERCEPTED_VENDORS.map((entry) => ({ ...entry })),
  };
}

function list(values) {
  return values.length ? values.join(", ") : "none";
}

// One informational row on the verdict. It never fails and never blocks.
export function vendorBeaconAssertion(ledger) {
  const evidence = vendorBeaconEvidence(ledger);
  const seen = Object.entries(evidence.vendors).map(([vendor, entry]) => `${vendor} ${entry.requests}${entry.purchase_seen ? " (purchase)" : ""}`);
  const live = ledger.mode === VENDOR_BEACON_MODES.LIVE;
  const notIntercepted = live ? "" : `; not intercepted: ${list(evidence.not_intercepted.map((entry) => entry.vendor))}`;
  return {
    id: "browser-test-order:vendor-beacons",
    family: "browser-test-order",
    page: "campaign",
    status: STATUS.PASS,
    severity: SEVERITY.INFO,
    expected: live
      ? "vendor beacons sent to the vendors (--vendor-beacons live); requests recorded as evidence, not purchase proof"
      : "vendor beacons answered locally, so test orders stay out of vendor data; requests recorded as evidence, not purchase proof",
    actual: `${live ? "sent" : "answered locally"}: ${list(seen)}; configured, never seen: ${list(evidence.configured_not_seen)}${notIntercepted}`,
    evidence,
  };
}
