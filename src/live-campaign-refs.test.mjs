import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { doctorPacket, readDoctorLiveCampaign } from "./doctor/inspect.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";
import { campaignMirrorDrift } from "./spec-derive-campaign.mjs";
import {
  campaignDriftMessage,
  evaluateLiveCampaignRefs,
  extractRenderedRefs,
  readLiveCampaign,
  readLiveCampaignForPacket,
} from "./live-campaign-refs.mjs";

const codes = (issues) => issues.map((issue) => issue.code);
const PROXY_BASE = "https://proxy.example.test";
const LIVE_URL = `${PROXY_BASE}/api/campaign`;

// The upstream campaign retrieve body: what the proxy carries in `data`.
function campaign({ ref = 501, packages = [10, 17, 19, 30], shipping = [20, 21] } = {}) {
  return {
    ref_id: ref,
    name: "Fixture Campaign",
    packages: packages.map((ref) => ({ ref_id: ref, name: `Package ${ref}`, price: "10.00" })),
    shipping_methods: shipping.map((ref) => ({ ref_id: ref, code: `ship-${ref}`, price: "4.95" })),
  };
}

// What the proxy's GET /api/campaign answers: an envelope around the upstream
// body (one campaign, or an array of them).
function envelope(data, { requestedRefId } = {}) {
  return {
    ok: true,
    status: 200,
    endpoint: "campaigns",
    ...(requestedRefId !== undefined ? { requested_ref_id: requestedRefId } : {}),
    retrieved_at: "2026-09-30T00:00:00.000Z",
    data,
  };
}

function liveBody(options = {}) {
  return envelope(campaign(options));
}

function jsonFetch(body, { status = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

// A saved Map (the Olympus fixture spec, packages 10/17/19/30, plus shipping 20/21)
// and a built campaign whose pages render the given markup. The live campaign
// is whatever the test hands doctor.
async function withBuiltCampaign({ checkoutHtml, upsellHtml = null, specEdit = null }, run) {
  const repo = mkdtempSync(join(tmpdir(), "campaigns-os-live-refs-"));
  try {
    const spec = JSON.parse(readFileSync(new URL("../contracts/fixtures/campaign-specs/olympus-tiered-standard-free.json", import.meta.url), "utf8"));
    // The starter's Olympus fixture ships one method and a free-shipping coupon
    // (starter-templates #246). These tests are about Map-vs-live drift, so the
    // Map carries its own second method rather than the starter's shipping model.
    spec.shipping_methods = [...spec.shipping_methods.filter((method) => method.ref_id !== 21),
      { key: "free", ref_id: 21, name: "Free Shipping", price: "0.00" }];
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

test("ref extraction: every valid attribute syntax is read; comments, noscript and visible text are not", () => {
  // [markup, shipping refs, package refs]
  const cases = [
    ['<input data-next-shipping-id="21">', ["21"], []],
    ['<input data-next-shipping-id = "21">', ["21"], []],
    ["<input data-next-shipping-id=21>", ["21"], []],
    ["<input data-next-shipping-id='21'>", ["21"], []],
    ['<input DATA-NEXT-SHIPPING-ID="21">', ["21"], []],
    ['<input data-next-shipping-id="&#50;&#49;">', ["21"], []],
    ['<input data-next-shipping-id=" 21 ">', ["21"], []],
    ["<div data-next-package-id = 10></div>", [], ["10"]],
    ["<div DATA-PACKAGE-ID='17'></div>", [], ["17"]],
    ['<div data-package-id="&#49;&#55;"></div>', [], ["17"]],
    ['<script>window.cfg = { packageId: 19, shippingId: "21" };</script>', ["21"], ["19"]],
    ['<script type="application/json">{"packageId":"19"}</script>', [], ["19"]],
    ['<button onclick="next.addItem({packageId: 30})">Add</button>', [], ["30"]],
    ["<template><div data-next-package-id=30></div></template>", [], ["30"]],
    ['<!-- <input data-next-shipping-id="21"> -->', [], []],
    ['<noscript><input data-next-shipping-id="21"></noscript>', [], []],
    ["<p>shippingId: 21, packageId: 19</p>", [], []],
    ['<input data-next-shipping-id="">', [], []],
  ];
  for (const [markup, shipping, packages] of cases) {
    const refs = extractRenderedRefs(page(markup));
    assert.deepEqual([...refs.shipping_refs], shipping, markup);
    assert.deepEqual([...refs.package_refs], packages, markup);
  }
});

test("ref extraction: spaced and unquoted refs reach both the live check and the CampaignSpec check", async () => {
  await withBuiltCampaign({
    checkoutHtml: page("<div data-next-package-id = 10></div><input data-next-shipping-id = \"21\"><input data-next-shipping-id=99>"),
  }, ({ doctor }) => {
    const result = doctor({ status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: ["20"] });
    const live = result.errors.find((entry) => entry.code === "built_output.shipping_ref_live_missing");
    assert.deepEqual(live?.detail.refs, ["21", "99"]);
    assert.equal(result.derived.live_campaign_refs.status, "blocked");
    // 99 is not in the Map either: the CampaignSpec check reads the same refs.
    const map = [...result.errors, ...result.warnings].find((entry) => entry.code === "built_output.shipping_ref");
    assert.match(map?.message || "", /: 99\.$/);
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
    ["http_status", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: false, error: "upstream request failed", detail: "socket hang up" }, { status: 502 }) })],
    ["not_found", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, campaignRefId: 999, fetchImpl: jsonFetch({ ok: false, status: 404, requested_ref_id: 999, upstream_shape: "array", error: "No campaign with ref_id 999" }, { status: 404 }) })],
    ["timeout", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, timeoutMs: 20, fetchImpl: () => new Promise(() => {}) })],
    ["unparseable", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch("<html>not json</html>") })],
    // The bare upstream campaign, without the proxy's envelope, is not what the
    // proxy serves and is refused rather than read.
    ["unexpected_body", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(campaign()) })],
    ["unexpected_body", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: true, status: 200, endpoint: "campaigns" }) })],
    ["unexpected_body", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(envelope({ packages: [] })) })],
    ["unexpected_body", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(envelope({ packages: [{ name: "no ref" }], shipping_methods: [] })) })],
    ["proxy_error", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: false, status: 401, endpoint: "campaigns", error: "Upstream answered 401" }) })],
    ["ambiguous_campaign", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(envelope([campaign({ ref: 501 }), campaign({ ref: 502 })])) })],
    ["not_found", await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(envelope([])) })],
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
  assert.equal(refused.reason_code, "key_source_refused");

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

test("credential isolation: an api_key_source env name that says admin, token, secret, password, private or store is refused with no request", async () => {
  for (const name of ["CAMPAIGN_ADMIN_TOKEN", "CAMPAIGNS_API_TOKEN", "NEXT_ADMIN_TOKEN_SHOP", "campaign_store_key", "CAMPAIGN_SECRET_KEY"]) {
    for (const env of [{ [name]: "pk_looks_like_a_key_01" }, {}]) {
      const refused = await readLiveCampaignForPacket({
        packet: { campaign: { api_key_source: `env:${name}` } },
        env,
        fetchImpl: () => assert.fail(`no request for env:${name}`),
        proxyBase: PROXY_BASE,
      });
      assert.equal(refused.status, "not_run", name);
      assert.equal(refused.reason_code, "key_source_refused", name);
      assert.doesNotMatch(refused.reason, /pk_looks_like_a_key_01/);
    }
  }
  // The documented public-key name still reads.
  const calls = [];
  const read = await readLiveCampaignForPacket({
    packet: { campaign: { api_key_source: "env:CAMPAIGNS_API_KEY" } },
    env: { CAMPAIGNS_API_KEY: "pk_fixture_public_key" },
    fetchImpl: jsonFetch(liveBody(), { calls }),
    proxyBase: PROXY_BASE,
  });
  assert.equal(read.status, "read");
  assert.equal(read.key_source, "env:CAMPAIGNS_API_KEY");
  assert.deepEqual(calls.map((call) => call.init.headers["X-Campaign-Key"]), ["pk_fixture_public_key"]);
  // A packet key wins over the env source, so the refused variable is never
  // read and only the packet's public key travels.
  const packetCalls = [];
  const packetFirst = await readLiveCampaignForPacket({
    packet: { campaign: { campaigns_api_key: "pk_fixture_public_key", api_key_source: "env:CAMPAIGN_ADMIN_TOKEN" } },
    env: { CAMPAIGN_ADMIN_TOKEN: "admin_token_value_01" },
    fetchImpl: jsonFetch(liveBody(), { calls: packetCalls }),
    proxyBase: PROXY_BASE,
  });
  assert.equal(packetFirst.status, "read");
  assert.deepEqual(packetCalls.map((call) => call.init.headers["X-Campaign-Key"]), ["pk_fixture_public_key"]);
  // Doctor shows the refusal: the key check sees a campaign-named source, so
  // the live check is where the operator learns nothing was sent.
  await withBuiltCampaign({ checkoutHtml: page('<input data-next-shipping-id="21">') }, async ({ doctor }) => {
    const result = doctor(await readLiveCampaignForPacket({
      packet: { campaign: { api_key_source: "env:CAMPAIGN_ADMIN_TOKEN" } },
      env: { CAMPAIGN_ADMIN_TOKEN: "admin_token_value_01" },
      fetchImpl: () => assert.fail("no request"),
      proxyBase: PROXY_BASE,
    }));
    assert.equal(result.derived.live_campaign_refs.reason_code, "key_source_refused");
    const warning = result.warnings.find((entry) => entry.code === "built_output.live_refs_not_run");
    assert.equal(warning?.detail.reason_code, "key_source_refused");
    assert.doesNotMatch(JSON.stringify(result), /admin_token_value_01/);
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
    // Without --currency the run enters in the spec's campaign.currency.
    if (String(url) === `${pageUrl}?currency=USD`) return new Response('<div data-next-package-id="10"></div><input data-next-shipping-id="21">', { status: 200 });
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
  const run = (options, extraArgs = {}) => __qaNodeTestHooks.runResolvedQa({ _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, json: true, ...extraArgs }, resolved, options);
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

    // --no-live-refs: a key resolves and a page was served, yet no request is
    // made and the verdict records the check skipped with reason disabled.
    spec.campaign.campaigns_api_key = "pk_fixture_public_key";
    const disabled = await run({ liveCampaignFetch: () => assert.fail("no request under --no-live-refs") }, { "no-live-refs": true });
    delete spec.campaign.campaigns_api_key;
    const skipped = disabled.verdict.assertions.find((entry) => entry.id === "live-campaign-refs");
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.evidence.reason_code, "disabled");
    // The verdict says what went unchecked: the one served page.
    assert.equal(skipped.evidence.pages_eligible, 1);
    assert.equal(disabled.verdict.assertions.some((entry) => entry.id.startsWith("built_output.") || entry.id === "spec.campaign_drift"), false);

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

test("proxy envelope: data as one campaign or an array is unwrapped, and a known campaign ref asks the proxy for that one", async () => {
  const pk = "pk_fixture_public_key";
  const object = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(envelope(campaign({ packages: [10], shipping: [20] }))) });
  assert.deepEqual([object.status, object.package_refs, object.shipping_refs], ["read", ["10"], ["20"]]);

  const single = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch(envelope([campaign({ packages: [17], shipping: [21] })])) });
  assert.deepEqual([single.status, single.package_refs, single.shipping_refs], ["read", ["17"], ["21"]]);

  const calls = [];
  const picked = await readLiveCampaign({
    apiKey: pk,
    proxyBase: PROXY_BASE,
    campaignRefId: 502,
    fetchImpl: jsonFetch(envelope([campaign({ ref: 501, shipping: [20] }), campaign({ ref: 502, shipping: [21] })], { requestedRefId: 502 }), { calls }),
  });
  assert.deepEqual(calls.map((call) => call.url), [`${LIVE_URL}?ref_id=502`]);
  assert.deepEqual([picked.status, picked.campaign_ref_id, picked.shipping_refs], ["read", "502", ["21"]]);

  const missing = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, campaignRefId: "503", fetchImpl: jsonFetch(envelope([campaign({ ref: 501 }), campaign({ ref: 502 })])) });
  assert.equal(missing.reason_code, "campaign_mismatch");
  // Asked for by ref, an empty array carries that ref no more than a list
  // without it does: both are the campaign_mismatch the identity rule names.
  const none = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, campaignRefId: "503", fetchImpl: jsonFetch(envelope([])) });
  assert.deepEqual([none.status, none.reason_code, none.campaign_ref_id], ["not_run", "campaign_mismatch", "503"]);
  assert.match(none.reason, /asked for campaign ref 503 but got no campaign/);

  const refused = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, campaignRefId: "offer-1", fetchImpl: () => assert.fail("no request for a non-numeric campaign ref") });
  assert.equal(refused.reason_code, "unexpected_ref");

  // The CampaignSpec's campaign.ref_id is the ref the packet read asks for.
  const packetCalls = [];
  const fromSpec = await readLiveCampaignForPacket({
    packet: {},
    spec: { campaign: { ref_id: 501, campaigns_api_key: pk } },
    env: {},
    fetchImpl: jsonFetch(envelope(campaign({ ref: 501 }), { requestedRefId: 501 }), { calls: packetCalls }),
    proxyBase: PROXY_BASE,
  });
  assert.equal(fromSpec.status, "read");
  assert.deepEqual(packetCalls.map((call) => call.url), [`${LIVE_URL}?ref_id=501`]);
});

test("proxy errors: ok false and non-2xx envelopes are not_run with the proxy's error as one line, never the raw body or the key", async () => {
  const pk = "pk_fixture_public_key";
  const okFalse = await readLiveCampaign({
    apiKey: pk,
    proxyBase: PROXY_BASE,
    fetchImpl: jsonFetch({ ok: false, status: 403, endpoint: "campaigns", error: `Upstream refused\n  key ${pk}\tfor this origin`, data: { packages: [], shipping_methods: [] } }),
  });
  assert.equal(okFalse.status, "not_run");
  assert.equal(okFalse.reason_code, "proxy_error");
  assert.match(okFalse.reason, /Upstream refused key \[key\] for this origin/);
  assert.doesNotMatch(okFalse.reason, /\n|pk_fixture_public_key|packages/);

  const missingKey = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: false, error: "Missing X-Campaign-Key header" }, { status: 400 }) });
  assert.deepEqual([missingKey.reason_code, missingKey.http_status], ["http_status", 400]);
  assert.match(missingKey.reason, /answered 400.*The proxy said: Missing X-Campaign-Key header$/);

  const transport = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: false, error: "Upstream fetch failed", detail: "connect ECONNREFUSED 10.0.0.1:443" }, { status: 502 }) });
  assert.equal(transport.reason_code, "http_status");
  assert.match(transport.reason, /Upstream fetch failed/);
  assert.doesNotMatch(transport.reason, /ECONNREFUSED/);

  const notFound = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, campaignRefId: 999, fetchImpl: jsonFetch({ ok: false, status: 404, requested_ref_id: 999, upstream_shape: "array", error: "No campaign with ref_id 999" }, { status: 404 }) });
  assert.equal(notFound.reason_code, "not_found");
  assert.equal(notFound.campaign_ref_id, "999");
  assert.match(notFound.reason, /404 for campaign ref 999.*No campaign with ref_id 999/);

  const long = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: false, error: "x".repeat(5000) }, { status: 500 }) });
  assert.ok(long.reason.length < 400, "the error line is capped");
});

test("proxy errors: ok true with no campaign in data is not_run with the proxy's error as one capped, redacted line", async () => {
  const pk = "pk_fixture_public_key";
  const said = await readLiveCampaign({
    apiKey: pk,
    proxyBase: PROXY_BASE,
    fetchImpl: jsonFetch({ ok: true, status: 200, endpoint: "campaigns", error: `Upstream campaign\n unavailable for ${pk}` }),
  });
  assert.equal(said.status, "not_run");
  assert.equal(said.reason_code, "proxy_error");
  assert.match(said.reason, /no campaign in its data field: Upstream campaign unavailable for \[key\]/);
  assert.doesNotMatch(said.reason, /\n|pk_fixture_public_key/);

  const long = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: true, data: null, error: "y".repeat(5000) }) });
  assert.equal(long.reason_code, "proxy_error");
  assert.ok(long.reason.length < 400, "the error line is capped");

  const silent = await readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, fetchImpl: jsonFetch({ ok: true, status: 200 }) });
  assert.equal(silent.reason_code, "unexpected_body");
});

test("D1 through the envelope: doctor asks for the CampaignSpec's campaign ref and blocks on the page's shipping ref that campaign does not serve", async () => {
  await withBuiltCampaign({
    checkoutHtml: page('<div data-next-package-id="10"></div><input data-next-shipping-id="21">'),
    specEdit: (spec) => { spec.campaign.ref_id = 501; },
  }, async ({ packetPath, doctor }) => {
    const calls = [];
    // The key serves two campaigns; only 502 still serves shipping method 21.
    const body = envelope([campaign({ ref: 501, shipping: [20] }), campaign({ ref: 502, shipping: [20, 21] })], { requestedRefId: 501 });
    const live = await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE }, { env: {}, fetchImpl: jsonFetch(body, { calls }) });
    assert.deepEqual(calls.map((call) => call.url), [`${LIVE_URL}?ref_id=501`]);
    assert.equal(live.status, "read");
    const result = doctor(live);
    const issue = result.errors.find((entry) => entry.code === "built_output.shipping_ref_live_missing");
    assert.deepEqual(issue?.detail.refs, ["21"]);
    assert.equal(result.status, "blocked");
    assert.equal(result.derived.live_campaign_refs.status, "blocked");
  });
});

test("--no-live-refs: doctor sends nothing and records not_run with reason disabled, never a pass and never a warning", async () => {
  await withBuiltCampaign({ checkoutHtml: page('<input data-next-shipping-id="21">') }, async ({ packetPath, doctor }) => {
    const live = await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE, "no-live-refs": true }, { env: {}, fetchImpl: () => assert.fail("no request under --no-live-refs") });
    assert.deepEqual([live.status, live.reason_code], ["not_run", "disabled"]);
    const result = doctor(live);
    assert.equal(result.derived.live_campaign_refs.status, "not_run");
    assert.equal(result.derived.live_campaign_refs.reason_code, "disabled");
    assert.equal(codes([...result.errors, ...result.warnings]).some((code) => code.startsWith("built_output.live_refs") || code.endsWith("_live_missing") || code === "spec.campaign_drift"), false);
    assert.equal(result.ready.some((line) => line.includes("served by the live campaign")), false);
  });
});

test("campaign identity: a campaign asked for by ref must carry that ref (ref_id, else id) in the object and array shapes, or the check is not_run", async () => {
  const pk = "pk_fixture_public_key";
  const read = (data, campaignRefId = 501) => readLiveCampaign({ apiKey: pk, proxyBase: PROXY_BASE, campaignRefId, fetchImpl: jsonFetch(envelope(data, { requestedRefId: campaignRefId })) });
  const withoutRef = ({ ref_id, ...rest }) => rest;
  // [data, expected status, expected reason_code]
  const cases = [
    [campaign({ ref: 502 }), "not_run", "campaign_mismatch"],
    [withoutRef(campaign()), "not_run", "campaign_mismatch"],
    [{ ...withoutRef(campaign()), id: 502 }, "not_run", "campaign_mismatch"],
    [{ ...campaign({ ref: 502 }), id: 501 }, "not_run", "campaign_mismatch"],
    [{ ...campaign(), ref_id: { value: 501 } }, "not_run", "campaign_mismatch"],
    [[{ ...withoutRef(campaign()), id: 502 }], "not_run", "campaign_mismatch"],
    [campaign({ ref: 501 }), "read", undefined],
    [campaign({ ref: "501" }), "read", undefined],
    [{ ...withoutRef(campaign()), id: 501 }, "read", undefined],
    [[campaign({ ref: 502 }), { ...withoutRef(campaign()), id: 501 }], "read", undefined],
  ];
  for (const [data, status, reasonCode] of cases) {
    const live = await read(data);
    assert.equal(live.status, status, JSON.stringify(data));
    assert.equal(live.reason_code, reasonCode, JSON.stringify(data));
    if (status === "read") assert.equal(live.campaign_ref_id, "501");
  }
  // No ref asked for: the one campaign returned is the key's campaign.
  assert.equal((await read(campaign({ ref: 502 }), null)).status, "read");

  // Doctor: the wrong campaign is a visible not_run, never a pass, and its
  // refs never reach the page comparison.
  await withBuiltCampaign({
    checkoutHtml: page('<input data-next-shipping-id="21">'),
    specEdit: (spec) => { spec.campaign.ref_id = 501; },
  }, async ({ packetPath, doctor }) => {
    const live = await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE }, { env: {}, fetchImpl: jsonFetch(envelope(campaign({ ref: 502, shipping: [20, 21] }), { requestedRefId: 501 })) });
    const result = doctor(live);
    assert.deepEqual([result.derived.live_campaign_refs.status, result.derived.live_campaign_refs.reason_code], ["not_run", "campaign_mismatch"]);
    assert.equal(result.warnings.find((entry) => entry.code === "built_output.live_refs_not_run")?.detail.reason_code, "campaign_mismatch");
    assert.equal(result.ready.some((line) => line.includes("served by the live campaign")), false);
  });
});

test("coverage: every built page under _site/<route>/ is compared with the live campaign, including pages the CampaignSpec does not list", async () => {
  await withBuiltCampaign({ checkoutHtml: page('<input data-next-shipping-id="20">') }, ({ repo, doctor }) => {
    mkdirSync(join(repo, "_site", "offer", "extra-checkout"), { recursive: true });
    writeFileSync(join(repo, "_site", "offer", "extra-checkout", "index.html"), page('<div data-next-package-id="99"></div><input data-next-shipping-id="21">'));
    const result = doctor({ status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: ["20"] });
    const live = result.errors.filter((entry) => entry.code.endsWith("_live_missing"));
    assert.deepEqual(live.map((entry) => [entry.code, entry.detail.page_id, entry.detail.file, entry.detail.in_spec, entry.detail.refs]), [
      ["built_output.shipping_ref_live_missing", "extra-checkout/index.html", "./_site/offer/extra-checkout/index.html", false, ["21"]],
      ["built_output.package_ref_live_missing", "extra-checkout/index.html", "./_site/offer/extra-checkout/index.html", false, ["99"]],
    ]);
    assert.match(live[0].message, /^Built page \.\/_site\/offer\/extra-checkout\/index\.html \(not a CampaignSpec page\) references shipping ID/);
    assert.equal(result.derived.live_campaign_refs.status, "blocked");
    assert.equal(result.derived.live_campaign_refs.checked_pages, 2);
    // The CampaignSpec ref check keeps its scope, the spec's pages: package 99
    // on the unlisted page is not reported as a Map miss.
    assert.equal([...result.errors, ...result.warnings].some((entry) => entry.code === "built_output.package_ref" && /99/.test(entry.message)), false);
  });
});

test("request URL: a proxy base that already carries a query keeps it, and ref_id is added as its own parameter", async () => {
  const pk = "pk_fixture_public_key";
  const read = async (proxyBase, campaignRefId) => {
    const calls = [];
    const live = await readLiveCampaign({
      apiKey: pk,
      proxyBase,
      campaignRefId,
      warn: () => {},
      fetchImpl: jsonFetch(envelope(campaign({ ref: 501 }), { requestedRefId: campaignRefId ?? undefined }), { calls }),
    });
    return { live, urls: calls.map((call) => call.url) };
  };
  const queried = await read("http://127.0.0.1:8787/?tenant=a", 501);
  assert.equal(queried.live.status, "read");
  assert.deepEqual(queried.urls, ["http://127.0.0.1:8787/api/campaign?tenant=a&ref_id=501"]);
  const parsed = new URL(queried.urls[0]);
  assert.deepEqual([parsed.pathname, parsed.searchParams.get("tenant"), parsed.searchParams.get("ref_id")], ["/api/campaign", "a", "501"]);

  // No ref asked for: the base's query stands alone, with no dangling "?".
  assert.deepEqual((await read("http://127.0.0.1:8787/?tenant=a", null)).urls, ["http://127.0.0.1:8787/api/campaign?tenant=a"]);
  // A base with a path prefix and a trailing slash keeps the prefix.
  assert.deepEqual((await read("http://127.0.0.1:8787/edge/", 501)).urls, ["http://127.0.0.1:8787/edge/api/campaign?ref_id=501"]);
});

test("coverage: a stale 404.html and pages under _ or . directories are build noise, not funnel pages; the route-root index.html is still compared", async () => {
  await withBuiltCampaign({ checkoutHtml: page('<input data-next-shipping-id="20">') }, ({ repo, doctor }) => {
    const live = { status: "read", package_refs: ["10", "17", "19", "30"], shipping_refs: ["20"] };
    const write = (route, html) => {
      mkdirSync(join(repo, "_site", "offer", ...route.slice(0, -1)), { recursive: true });
      writeFileSync(join(repo, "_site", "offer", ...route), html);
    };
    // Each carries a ref the live campaign does not serve.
    const stale = page('<div data-next-package-id="99"></div><input data-next-shipping-id="21">');
    write(["404.html"], stale);
    write(["_drafts", "checkout", "index.html"], stale);
    write([".cache", "index.html"], stale);
    const quiet = doctor(live);
    assert.equal(quiet.errors.some((entry) => entry.code.endsWith("_live_missing")), false);
    assert.equal(quiet.derived.live_campaign_refs.status, "pass");
    assert.equal(quiet.derived.live_campaign_refs.checked_pages, 1);

    // The landing page at the route root ships, so it is compared.
    write(["index.html"], stale);
    const landing = doctor(live);
    assert.deepEqual(landing.errors.filter((entry) => entry.code.endsWith("_live_missing")).map((entry) => [entry.code, entry.detail.page_id, entry.detail.file]), [
      ["built_output.shipping_ref_live_missing", "index.html", "./_site/offer/index.html"],
      ["built_output.package_ref_live_missing", "index.html", "./_site/offer/index.html"],
    ]);
    assert.equal(landing.derived.live_campaign_refs.status, "blocked");
  });
});

// #764: the Map's mirrored fields against the live campaign. A spec whose
// package and page-offer records already carry what the live campaign states,
// and a campaign body built from it, so the clean case is a true match.
const MIRROR_HTML = page('<div data-next-package-id="10"></div><input data-next-shipping-id="20">');

function matchingSpec(spec) {
  const pages = spec.funnels.flatMap((funnel) => funnel.pages);
  for (const pkg of pages.flatMap((entry) => entry.packages || [])) Object.assign(pkg, { name: `Package ${pkg.ref_id}`, price: "10.00" });
  const rootOffer = spec.offers.find((offer) => offer.ref_id === "1");
  const pageOffer = pages.find((entry) => entry.id === "upsell-stepper").offers[0];
  for (const field of ["name", "type", "condition", "benefit"]) pageOffer[field] = structuredClone(rootOffer[field]);
}

function mirroredCampaign(spec) {
  const packages = new Map();
  for (const pkg of spec.funnels.flatMap((funnel) => funnel.pages).flatMap((entry) => entry.packages || [])) {
    if (!packages.has(pkg.ref_id)) packages.set(pkg.ref_id, { ref_id: pkg.ref_id, name: pkg.name, price: pkg.price, ...(pkg.interval ? { is_recurring: true, interval: pkg.interval } : {}), ...(pkg.product_sku ? { product_sku: pkg.product_sku } : {}), ...(pkg.product_purchase_availability ? { product_purchase_availability: pkg.product_purchase_availability } : {}) });
  }
  return {
    ref_id: 501,
    packages: [...packages.values()],
    shipping_methods: spec.shipping_methods.map((method) => ({ ref_id: method.ref_id })),
    offers: structuredClone(spec.offers),
  };
}

function liveRead(campaignBody) {
  return {
    status: "read",
    package_refs: campaignBody.packages.map((pkg) => String(pkg.ref_id)),
    shipping_refs: campaignBody.shipping_methods.map((method) => String(method.ref_id)),
    campaign: campaignBody,
  };
}

test("#764 mirror drift: a Map that matches its campaign gives no drift warning", async () => {
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: matchingSpec }, ({ spec, doctor }) => {
    const result = doctor(liveRead(mirroredCampaign(spec)));
    assert.equal(codes(result.warnings).includes("spec.campaign_drift"), false);
    assert.equal(result.derived.live_campaign_refs.drift, null);
    assert.equal(result.derived.live_campaign_refs.status, "pass");
    assert.doesNotMatch(JSON.stringify(result), /"campaign":\{/, "the campaign body never reaches doctor's result");
  });
});

test("#764 mirror drift: price, offer percentage, a campaign offer the Map lacks and a recurring interval are counted under unchanged package ids", async () => {
  const recurring = (spec) => {
    matchingSpec(spec);
    const upsell = spec.funnels.flatMap((funnel) => funnel.pages).find((entry) => entry.id === "upsell-stepper");
    Object.assign(upsell.packages[0], { is_recurring: true, interval: "month" });
    const checkout = spec.funnels.flatMap((funnel) => funnel.pages).find((entry) => entry.id === "checkout");
    for (const pkg of checkout.packages.filter((entry) => entry.ref_id === 10)) Object.assign(pkg, { product_sku: "SKU-10", product_purchase_availability: "available" });
  };
  const cases = [
    ["price", (body) => { body.packages.find((pkg) => pkg.ref_id === 10).price = "12.00"; }, { price: 1 }, /on 1 price\./],
    ["offer percentage", (body) => { body.offers[0].benefit.value = "40.00"; }, { offers_changed: 1 }, /on 1 offer\./],
    ["campaign offer missing from the Map", (body) => { body.offers.push({ ref_id: "3", name: "New", type: "offer", code: "NEW10" }); }, { offers_missing: 1 }, /^The campaign has 1 offer the CampaignSpec doesn't list\./],
    ["recurring interval", (body) => { body.packages.find((pkg) => pkg.ref_id === 30).interval = "week"; }, { recurring: 1 }, /on 1 recurring term\./],
    ["availability", (body) => { body.packages.find((pkg) => pkg.ref_id === 10).product_purchase_availability = "unavailable"; }, { availability: 1 }, /on 1 availability field\./],
    ["product sku", (body) => { body.packages.find((pkg) => pkg.ref_id === 10).product_sku = "SKU-NEW"; }, { product: 1 }, /on 1 product field\./],
  ];
  for (const [label, edit, expected, message] of cases) {
    await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: recurring }, ({ spec, doctor }) => {
      const body = mirroredCampaign(spec);
      const clean = doctor(liveRead(body));
      assert.equal(codes(clean.warnings).includes("spec.campaign_drift"), false, `${label}: the unedited campaign matches`);
      edit(body);
      const result = doctor(liveRead(body));
      const drift = result.warnings.find((entry) => entry.code === "spec.campaign_drift");
      assert.ok(drift, `${label}: drift warned`);
      const counts = { price: 0, product: 0, availability: 0, recurring: 0, offers_changed: 0, offers_missing: 0, ...expected };
      assert.deepEqual(drift.detail.drift.mirror.counts, counts, label);
      assert.deepEqual(drift.detail.drift.packages, { map_only: [], live_only: [] }, `${label}: package ids unchanged`);
      const derivedDrift = result.derived.live_campaign_refs.drift;
      assert.ok(derivedDrift.mirror.rows.length >= 1, `${label}: the change rows are in derived`);
      assert.equal(drift.detail.drift.mirror.rows, undefined, `${label}: the warning carries counts only`);
      assert.match(drift.message, message, label);
      assert.match(drift.message, /spec derive --packet <packet> --dry-run`.*spec derive --packet <packet>`/);
      assert.doesNotMatch(drift.message, /\n/);
      // Advisory: the same errors with or without the drift.
      assert.deepEqual(codes(result.errors), codes(clean.errors), `${label}: errors unchanged`);
      assert.deepEqual(derivedDrift.mirror.counts, drift.detail.drift.mirror.counts);
      assert.match(drift.message, /owed again\.$/);
    });
  }
});

test("#764 mirror drift: several kinds at once read as one line, and a package on several pages counts once", async () => {
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: matchingSpec }, ({ spec, doctor }) => {
    const body = mirroredCampaign(spec);
    for (const pkg of body.packages) pkg.price = "11.00";
    body.offers[0].benefit.value = "40.00";
    body.offers.push({ ref_id: "3", code: "NEW10" }, { ref_id: "4", code: "NEW20" });
    const result = doctor(liveRead(body));
    const drift = result.warnings.find((entry) => entry.code === "spec.campaign_drift");
    // Packages 10 (three tiers on one page), 17, 19 and 30.
    assert.equal(drift.detail.drift.mirror.counts.price, 4);
    assert.equal(drift.message, "The CampaignSpec differs from the live campaign on 4 prices and 1 offer, and the campaign has 2 offers the CampaignSpec doesn't list. Run `campaigns-os spec derive --packet <packet> --dry-run` to see each change, then `campaigns-os spec derive --packet <packet>` to write it; a rewritten spec makes the build, Polish and QA owed again.");
  });
});

test("#764 mirror drift: without the campaign body, or with --no-live-refs, nothing is compared", async () => {
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: matchingSpec }, async ({ spec, doctor, packetPath }) => {
    const body = mirroredCampaign(spec);
    body.packages[0].price = "99.00";
    const { campaign: _omit, ...refsOnly } = liveRead(body);
    assert.equal(codes(doctor(refsOnly).warnings).includes("spec.campaign_drift"), false);
    const disabled = await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE, "no-live-refs": true }, { env: {}, fetchImpl: () => assert.fail("no request under --no-live-refs") });
    const result = doctor(disabled);
    assert.equal(result.derived.live_campaign_refs.status, "not_run");
    assert.equal(codes(result.warnings).includes("spec.campaign_drift"), false);
  });
});

test("#764: doctor's live read keeps the campaign body for the mirror comparison", async () => {
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML }, async ({ packetPath }) => {
    const live = await readDoctorLiveCampaign({ packet: packetPath, "proxy-base": PROXY_BASE }, { env: {}, fetchImpl: jsonFetch(liveBody()) });
    assert.equal(live.status, "read");
    assert.equal(live.campaign?.ref_id, 501);
  });
});

test("#764 mirror drift: fields the Map does not state are not drift (page offers by ref_id only, no image, no root offers)", async () => {
  const bare = (spec) => {
    matchingSpec(spec);
    for (const entry of spec.funnels.flatMap((funnel) => funnel.pages)) entry.offers = (entry.offers || []).map((offer) => ({ ref_id: offer.ref_id }));
  };
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: bare }, ({ spec, doctor }) => {
    const body = mirroredCampaign(spec);
    for (const pkg of body.packages) pkg.image = `https://cdn.example.test/${pkg.ref_id}.png`;
    const result = doctor(liveRead(body));
    assert.equal(codes(result.warnings).includes("spec.campaign_drift"), false, "page offers listed by ref_id, as docs/build-packet.md describes, match");
  });
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: (spec) => { bare(spec); delete spec.offers; } }, ({ spec, doctor }) => {
    const body = mirroredCampaign({ ...spec, offers: [] });
    body.offers = [{ ref_id: "1", code: "A" }, { ref_id: "2", code: "B" }];
    const result = doctor(liveRead(body));
    assert.equal(codes(result.warnings).includes("spec.campaign_drift"), false, "a spec with no root offers list states no offers to compare");
  });
});

test("#764 mirror drift: a comparison that throws never aborts doctor", async () => {
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: matchingSpec }, ({ spec, doctor }) => {
    const body = mirroredCampaign(spec);
    body.packages[0].product_variant_attribute_values = JSON.parse(`${"[".repeat(20000)}${"]".repeat(20000)}`);
    const result = doctor(liveRead(body));
    assert.equal(result.derived.live_campaign_refs.status, "pass", "the ref check still records its result");
    assert.equal(codes(result.warnings).includes("spec.campaign_drift"), false);
  });
});

test("#764 mirror drift: package-id drift and field drift together keep both lists and read as one line", async () => {
  await withBuiltCampaign({ checkoutHtml: MIRROR_HTML, specEdit: matchingSpec }, ({ spec, doctor }) => {
    const body = mirroredCampaign(spec);
    body.shipping_methods = body.shipping_methods.filter((method) => method.ref_id !== 21);
    body.packages.find((pkg) => pkg.ref_id === 10).price = "12.00";
    const result = doctor(liveRead(body));
    const drift = result.warnings.find((entry) => entry.code === "spec.campaign_drift");
    assert.deepEqual(drift.detail.drift.shipping_methods, { map_only: ["21"], live_only: [] });
    assert.deepEqual(drift.detail.drift.packages, { map_only: [], live_only: [] });
    assert.equal(drift.detail.drift.mirror.counts.price, 1);
    assert.match(drift.message, /Re-save the Map from the live campaign.*The CampaignSpec differs from the live campaign on 1 price\. Run/);
    assert.doesNotMatch(drift.message, /\n/);
  });
});

test("#764 mirror drift: a root offers value that is not a list is not drift", () => {
  for (const offers of [null, {}, "none"]) {
    assert.equal(campaignMirrorDrift({ spec: { offers, funnels: [] }, campaign: { packages: [], offers: [{ ref_id: "1", code: "A" }] } }), null, JSON.stringify(offers));
  }
});

test("#764 drift message: several field kinds read as a list joined by and", () => {
  const message = campaignDriftMessage({ mirror: { counts: { price: 1, product: 2, availability: 0, recurring: 1, offers_changed: 0, offers_missing: 0 } } });
  assert.match(message, /^The CampaignSpec differs from the live campaign on 1 price, 2 product fields and 1 recurring term\. Run/);
});
