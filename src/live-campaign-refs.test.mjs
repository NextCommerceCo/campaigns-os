import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { doctorPacket, readDoctorLiveCampaign } from "./doctor/inspect.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";
import {
  evaluateLiveCampaignRefs,
  readLiveCampaign,
  readLiveCampaignForPacket,
} from "./live-campaign-refs.mjs";

const codes = (issues) => issues.map((issue) => issue.code);
const PROXY_BASE = "https://proxy.example.test";
const LIVE_URL = `${PROXY_BASE}/api/campaign`;

function liveBody({ packages = [10, 17, 19, 30], shipping = [20, 21] } = {}) {
  return {
    name: "Fixture Campaign",
    packages: packages.map((ref) => ({ ref_id: ref, name: `Package ${ref}`, price: "10.00" })),
    shipping_methods: shipping.map((ref) => ({ ref_id: ref, code: `ship-${ref}`, price: "4.95" })),
  };
}

function jsonFetch(body, { status = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

// A saved Map (the Olympus fixture spec: shipping 20/21, packages 10/17/19/30)
// and a built campaign whose pages render the given markup. The live campaign
// is whatever the test hands doctor.
async function withBuiltCampaign({ checkoutHtml, upsellHtml = null, specEdit = null }, run) {
  const repo = mkdtempSync(join(tmpdir(), "campaigns-os-live-refs-"));
  try {
    const spec = JSON.parse(readFileSync(new URL("../contracts/fixtures/campaign-specs/olympus-tiered-standard-free.json", import.meta.url), "utf8"));
    spec.campaign.campaigns_api_key = "pk_fixture_public_key";
    if (specEdit) specEdit(spec);
    writeFileSync(join(repo, "spec.json"), JSON.stringify(spec));
    const packet = {
      schema_version: "campaign-runtime-build-packet/v0",
      campaign: { public_route_slug: "offer", allowed_domains_confirmed: true },
      spec: { map_id: spec.spec_identity.map_id, local_path: "spec.json" },
      source_html: { root: ".", pages: [] },
      assembly: { target_repo: ".", output_dir: "src/offer", template_family: "olympus" },
    };
    writeFileSync(join(repo, "packet.json"), JSON.stringify(packet));
    writeFileSync(join(repo, "report.json"), JSON.stringify({ stages: { assembly: { status: "completed" } } }));
    const writePage = (route, html) => {
      mkdirSync(join(repo, "_site", "offer", route), { recursive: true });
      writeFileSync(join(repo, "_site", "offer", route, "index.html"), html);
    };
    writePage("checkout", checkoutHtml);
    if (upsellHtml) writePage("upsell-stepper", upsellHtml);
    return await run({
      repo,
      packet,
      spec,
      packetPath: join(repo, "packet.json"),
      doctor: (liveCampaign) => doctorPacket(join(repo, "packet.json"), { contextPath: null, reportPath: join(repo, "report.json"), ...(liveCampaign !== undefined ? { liveCampaign } : {}) }),
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const page = (body) => `<html><head></head><body><script>window.next = {};</script>${body}</body></html>`;

test("D1: a shipping ref the Map lists but the live campaign does not serve blocks doctor", async () => {
  await withBuiltCampaign({ checkoutHtml: page('<div data-next-package-id="10"></div><input data-next-shipping-id="21">') }, async ({ packet, spec, packetPath, doctor }) => {
    const calls = [];
    const live = await readLiveCampaignForPacket({ packet, packetPath, spec, env: {}, fetchImpl: jsonFetch(liveBody({ shipping: [20] }), { calls }), proxyBase: PROXY_BASE });
    const result = doctor(live);
    // The minimal packet carries unrelated blockers of its own, so the proof is
    // the difference: against a live campaign that serves 21 the same page
    // adds nothing; against one that does not, the live miss is the one added
    // error.
    const served = doctor({ status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: ["20", "21"] });
    const added = codes(result.errors).filter((code) => !codes(served.errors).includes(code));
    assert.deepEqual(added, ["built_output.shipping_ref_live_missing"]);
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    const issue = result.errors.find((entry) => entry.code === "built_output.shipping_ref_live_missing");
    assert.ok(issue, "the page's live-missing shipping ref is a blocker");
    assert.deepEqual(issue.detail.refs, ["21"]);
    assert.equal(issue.detail.page_id, "checkout");
    // The CampaignSpec comparison alone still passes the page: 21 is in the Map.
    assert.equal(codes([...result.errors, ...result.warnings]).includes("built_output.shipping_ref"), false);
    // One GET of the proxy's campaign route, under the public campaign key.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LIVE_URL);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
    assert.deepEqual(calls[0].init.headers, { Accept: "application/json", "X-Campaign-Key": "pk_fixture_public_key" });
    assert.equal(live.key_source, "the packet-local CampaignSpec campaign.campaigns_api_key");
    assert.doesNotMatch(JSON.stringify(result), /pk_fixture_public_key/);
  });
});

test("D2: package refs are checked from every attribute the CampaignSpec check reads", async () => {
  const html = page([
    '<div data-next-package-id="10"></div>',
    '<div data-package-id="17"></div>',
    '<script>window.cfg = { packageId: 19 };</script>',
    '<input data-next-shipping-id="20">',
  ].join(""));
  await withBuiltCampaign({ checkoutHtml: html }, ({ doctor }) => {
    const result = doctor({ status: "read", package_refs: ["30"], shipping_refs: ["20", "21"] });
    const issue = result.errors.find((entry) => entry.code === "built_output.package_ref_live_missing");
    assert.ok(issue);
    assert.deepEqual(issue.detail.refs, ["10", "17", "19"]);
    assert.equal(codes(result.errors).includes("built_output.shipping_ref_live_missing"), false);
    assert.equal(codes([...result.errors, ...result.warnings]).includes("built_output.package_ref"), false, "all three are in the Map");
  });
});

test("D3: Map-vs-live drift is a separate warning in both directions and never softens a page blocker", async () => {
  await withBuiltCampaign({
    checkoutHtml: page('<div data-next-package-id="10"></div><input data-next-shipping-id="21">'),
    upsellHtml: page('<button data-next-package-id="30">Add</button>'),
  }, ({ doctor }) => {
    const result = doctor({ status: "read", package_refs: ["10", "17", "19", "30", "44"], shipping_refs: ["20", "22"] });
    assert.deepEqual(codes(result.errors).filter((code) => code.endsWith("_live_missing")), ["built_output.shipping_ref_live_missing"]);
    const drift = result.warnings.find((entry) => entry.code === "spec.campaign_drift");
    assert.ok(drift, "drift reported as its own warning");
    assert.deepEqual(drift.detail.drift, {
      packages: { map_only: [], live_only: ["44"] },
      shipping_methods: { map_only: ["21"], live_only: ["22"] },
    });
    assert.equal(result.derived.live_campaign_refs.status, "blocked");

    const clean = doctor({ status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: ["20", "21"] });
    assert.equal(codes([...clean.errors, ...clean.warnings]).some((code) => code.endsWith("_live_missing") || code === "spec.campaign_drift"), false);
    assert.equal(clean.derived.live_campaign_refs.status, "pass");
    assert.ok(clean.ready.some((line) => line.startsWith("Built page shipping and package refs are served by the live campaign")));
  });
});

test("D4: no key, no read, network failure, non-2xx, 404, timeout and a non-campaign body are not_run, never pass", async () => {
  const pk = "pk_fixture_public_key";
  const cases = [
    ["no_key", await readLiveCampaign({ apiKey: "", proxyBase: PROXY_BASE, fetchImpl: jsonFetch(liveBody()) })],
    ["not_read", await readLiveCampaign({ apiKey: pk })],
    ["insecure_proxy_base", await readLiveCampaign({ apiKey: pk, proxyBase: "http://proxy.example.test", fetchImpl: () => assert.fail("no request over plain http") })],
    ["fetch_unavailable", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE })],
    ["network_error", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: async () => { throw new TypeError("fetch failed"); } })],
    ["http_status", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ detail: "error" }, { status: 500 }) })],
    ["not_found", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ detail: "Not found." }, { status: 404 }) })],
    ["timeout", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, timeoutMs: 20, fetchImpl: () => new Promise(() => {}) })],
    ["unparseable", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch("<html>not json</html>") })],
    ["unexpected_body", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ packages: [] }) })],
    ["unexpected_body", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ packages: [{ name: "no ref" }], shipping_methods: [] }) })],
  ];
  for (const [reason, live] of cases) {
    assert.equal(live.status, "not_run", reason);
    assert.equal(live.reason_code, reason);
    assert.ok(live.reason.length > 0);
  }
  // A rejected env name never reads its value; there is no other source.
  const refused = await readLiveCampaignForPacket({
    packet: { campaign: { api_key_source: "env:STORE_ADMIN_TOKEN" } },
    env: { STORE_ADMIN_TOKEN: "admin-secret-value" },
    fetchImpl: () => assert.fail("no request without a campaign key"),
  });
  assert.equal(refused.reason_code, "key_rejected");

  await withBuiltCampaign({ checkoutHtml: page('<input data-next-shipping-id="21">') }, async ({ doctor }) => {
    const failed = doctor(cases.find(([reason]) => reason === "http_status")[1]);
    assert.equal(failed.derived.live_campaign_refs.status, "not_run");
    assert.equal(failed.derived.live_campaign_refs.reason_code, "http_status");
    assert.ok(codes(failed.warnings).includes("built_output.live_refs_not_run"), "an attempted read that failed is visible");
    assert.equal(codes(failed.errors).some((code) => code.endsWith("_live_missing")), false, "no fallback to the Map list");
    assert.ok(failed.ready.some((line) => line.startsWith("Built HTML structure and commerce refs checked")), "doctor's other checks still ran");
    assert.equal(failed.ready.some((line) => line.includes("served by the live campaign")), false);

    const unread = doctor(undefined);
    assert.equal(unread.derived.live_campaign_refs.status, "not_run");
    assert.equal(unread.derived.live_campaign_refs.reason_code, "not_read");
  });
});

test("boundary: no Map shipping refs, string vs number refs, duplicates across pages, and zero live shipping methods", async () => {
  await withBuiltCampaign({
    checkoutHtml: page('<input data-next-shipping-id="20"><script>window.cfg = { shippingId: "20" };</script>'),
    upsellHtml: page('<button data-next-package-id="30"></button><input data-next-shipping-id="20">'),
    specEdit: (spec) => { delete spec.shipping_methods; },
  }, ({ doctor }) => {
    // The Map lists no shipping methods, so the CampaignSpec check skips; the
    // live check still runs against the pages.
    const none = doctor({ status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: [] });
    const shipping = none.errors.filter((entry) => entry.code === "built_output.shipping_ref_live_missing");
    assert.deepEqual(shipping.map((entry) => [entry.detail.page_id, entry.detail.refs]), [["checkout", ["20"]], ["upsell-stepper", ["20"]]]);

    const served = doctor({ status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: ["20"] });
    assert.equal(codes(served.errors).some((code) => code.endsWith("_live_missing")), false, "20 on the page and 20 from the API are one ref");
  });
  const evaluated = evaluateLiveCampaignRefs({
    pages: [{ page_id: "a", package_refs: [5], shipping_refs: ["7"] }],
    map: { package_refs: ["5"], shipping_refs: [7] },
    live: { status: "read", package_refs: ["5"], shipping_refs: ["7"] },
  });
  assert.equal(evaluated.status, "pass");
  assert.equal(evaluated.drift, null);
});

test("D5: QA runs the same comparison over served pages and records it in the verdict with the same codes", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-live-refs-qa-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
  const spec = {
    schema_version: "4.3",
    campaign: { currency: "USD" },
    shipping_methods: [{ ref_id: 20 }, { ref_id: 21 }],
    funnels: [{ id: "default", pages: [{ id: "checkout", type: "checkout", order: 1, packages: [{ ref_id: 10, qty: 1 }] }] }],
  };
  const pageUrl = "https://shop.example.com/offer/checkout/";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === pageUrl) return new Response('<div data-next-package-id="10"></div><input data-next-shipping-id="21">', { status: 200 });
    throw new Error(`Unexpected fetch: ${String(url)}`);
  };
  const resolved = {
    themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "Test fixture has no theme context." },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Test fixture has no assembly report." },
    checkpointGates: [],
    qaWaivers: {},
    analyticsCaptureTarget: { url: null, source: "unresolved" },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath,
    packet: null,
    mapId: "live-refs",
    publicRouteSlug: "offer",
    proxyBase: "https://proxy.example.test",
    baseUrl: "https://shop.example.com/offer/",
    specPath: null,
    specSource: "test",
    portalManaged: false,
    rawSpec: spec,
    spec,
    specVersion: "4.3",
    specHash: "sha256:test",
    templateFamily: null,
    commerceStructureContract: null,
    topologies: [{ funnel_id: "default", funnel_name: "Default", weight: 100, pages: [{ page_id: "checkout", page_type: "checkout", label: "Checkout", url: pageUrl, packages: spec.funnels[0].pages[0].packages }] }],
  };
  const run = (options) => __qaNodeTestHooks.runResolvedQa({ _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, json: true }, resolved, options);
  try {
    const blocked = await run({ liveCampaign: { status: "read", package_refs: ["10"], shipping_refs: ["20"] } });
    const live = blocked.verdict.assertions.filter((entry) => entry.evidence?.code?.startsWith("built_output.") || entry.evidence?.code === "spec.campaign_drift" || entry.id === "live-campaign-refs");
    assert.deepEqual(live.map((entry) => [entry.id, entry.status, entry.severity]), [
      ["built_output.shipping_ref_live_missing:checkout", "fail", "blocker"],
      ["spec.campaign_drift", "warn", "warn"],
    ]);
    assert.deepEqual(live[0].evidence.refs, ["21"]);
    assert.equal(blocked.verdict.disposition, "blocked");

    // No key anywhere: QA makes no request and records the check skipped.
    const unread = await run({ liveCampaignFetch: () => assert.fail("no request without a campaign key") });
    const notRun = unread.verdict.assertions.find((entry) => entry.id === "live-campaign-refs");
    assert.equal(notRun.status, "skipped");
    assert.equal(notRun.evidence.code, "built_output.live_refs_not_run");
    assert.equal(notRun.evidence.reason_code, "no_key");

    // A key in the CampaignSpec: QA makes the read itself, through the proxy
    // it resolved, and the served page's miss blocks the verdict.
    const calls = [];
    spec.campaign.campaigns_api_key = "pk_fixture_public_key";
    const read = await run({ liveCampaignFetch: jsonFetch(liveBody({ packages: [10], shipping: [20] }), { calls }) });
    delete spec.campaign.campaigns_api_key;
    assert.deepEqual(calls.map((call) => [call.url, call.init.method, call.init.headers["X-Campaign-Key"]]), [
      ["https://proxy.example.test/api/campaign", "GET", "pk_fixture_public_key"],
    ]);
    const readMiss = read.verdict.assertions.find((entry) => entry.id === "built_output.shipping_ref_live_missing:checkout");
    assert.equal(readMiss?.severity, "blocker");
    assert.equal(read.verdict.disposition, "blocked");

    const failed = await run({ liveCampaign: { status: "not_run", reason_code: "timeout", reason: "The live campaign read timed out after 10000ms." } });
    const warn = failed.verdict.assertions.find((entry) => entry.id === "built_output.live_refs_not_run");
    assert.equal(warn.status, "warn");
    assert.equal(failed.verdict.assertions.some((entry) => entry.id.startsWith("built_output.shipping_ref_live_missing")), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("doctor's read: packet mode with built pages and a public key makes one GET of {proxy-base}/api/campaign; otherwise none", async () => {
  await withBuiltCampaign({ checkoutHtml: page('<input data-next-shipping-id="21">') }, async ({ repo, packetPath }) => {
    const calls = [];
    const live = await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE }, { env: {}, fetchImpl: jsonFetch(liveBody({ shipping: [20] }), { calls }) });
    assert.equal(live.status, "read");
    assert.equal(live.key_source, "the packet-local CampaignSpec campaign.campaigns_api_key");
    assert.deepEqual(calls.map((call) => [call.url, call.init.method, call.init.headers["X-Campaign-Key"]]), [[LIVE_URL, "GET", "pk_fixture_public_key"]]);

    const refuse = () => assert.fail("no request is due");
    // --built mode takes no packet, so there is no key and no read.
    assert.equal(await readDoctorLiveCampaign({ built: repo }, { env: {}, fetchImpl: refuse }), undefined);
    // No built page under _site/<route>/: nothing to compare, nothing sent.
    rmSync(join(repo, "_site"), { recursive: true, force: true });
    assert.equal(await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE }, { env: {}, fetchImpl: refuse }), undefined);
  });
});
