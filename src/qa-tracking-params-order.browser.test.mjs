// Unit 1.1 fixture rows, order attribution and preserve-declared names
// (contract §1.1 Result rules, "Order attribution, per credited field" and
// "Preserve-declared name with no credited field"), leg QB: real Chromium on a
// loopback stub campaign (src/qa-tracking-params-fixtures.mjs), driven
// through the actual `runBrowserTestOrders` entry point.
//
// Each test first checks the seed-independent facts of its synthetic setup
// (pages loaded, creates posted, order outcome), which hold on the base as
// well, and only then loads the new module and reads the row.
//
// API assumptions (shared, see src/qa-tracking-params-fixtures.mjs):
// runBrowserTestOrders resolves to { ..., qc_results } and pushes one
// browser-test-order qc.* assertion per row; the setup's ids and subjects are
// the literals tracking.url:checkout:url, tracking.order:checkout:order and
// tracking.tag:checkout:tag:oid; preserve names come from options.spec; order
// members are keyed by credited field, or by the declared name when it has no
// credited field; an order row lists coverage.sources_observed and a missing
// echo as a coverage.limits entry; an unexercised URL row reports
// coverage.last_observed and coverage.limits [<reason code>].
// API assumption (I24): options.trackingTestHooks.beforeExtractor(name) is
// called first inside each wrapped extractor; "request_equality" is the order
// request body extractor (see the URL test file for the full seam).
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  ALL_SOURCES,
  DEFAULT_URL_KEYS,
  EXCLUDED_BY_POLICY,
  OID_TAG_ID,
  ORDER_ID,
  SEEDED_ORDER_FIELDS,
  SEED_VALUE,
  URL_ID,
  UTM_FIELDS,
  assertCoverage,
  assertExactMembers,
  assertFailingHops,
  assertLoopbackOnly,
  assertRow,
  assertSourcesObserved,
  chromiumAvailable,
  documentPaths,
  members,
  orderAssertion,
  rowOf,
  runTrackingScenario,
  sharedRun,
  specWithPreserve,
  trackingRows,
  installNodeGuard,
} from "./qa-tracking-params-fixtures.mjs";

installNodeGuard();
afterEach(() => assertLoopbackOnly());

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; 1.1 order-attribution rows skipped (run `npm run qa:install-browser`)", () => {});
}

const T = { timeout: 240000 };
const ENTRY_HOPS = ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/", "/x/receipt/"];
const loadModule = () => import("./qa-tracking-params.mjs");
const defaultRun = () => sharedRun("default", () => runTrackingScenario("order-default"));
const queryOf = (entry) => new URLSearchParams(entry.query);
const IDS = [URL_ID, ORDER_ID];
const URL_TO_FIELD = Object.freeze({ utm_source: "utm_source", utm_medium: "utm_medium", utm_campaign: "utm_campaign", utm_content: "utm_content", utm_term: "utm_term", affid: "affiliate", sub1: "subaffiliate1", subaffiliate2: "subaffiliate2" });

function assertAccepted(result, log, paths = ENTRY_HOPS) {
  assert.deepEqual(documentPaths(log), paths, "setup: the pages the synthetic setup loads");
  assert.equal(log.creates.length, 1, "setup: exactly one order create was posted");
  assert.equal(orderAssertion(result).status, "pass", "setup: the order was accepted and read back");
}

// With the check in place: the entry load was seeded, and the create request's
// attribution carried those seeds under the credited field names.
function assertRequestCarriesSeeds(log, { except = [] } = {}) {
  const entry = log.documents.find((document) => document.path === "/x/landing/");
  const attribution = log.creates[0].body?.attribution || {};
  for (const [param, field] of Object.entries(URL_TO_FIELD)) {
    const seed = queryOf(entry).get(param);
    assert.match(seed || "", SEED_VALUE, `the entry load carried the seed for ${param}`);
    if (!except.includes(field)) assert.equal(attribution[field], seed, `the request carried ${param} as ${field}`);
  }
}

// The default order members: the eight seeded credited fields reading
// `result` / `reasonCode`, the five fields the default policy never seeds
// excluded, then any per-row overrides.
const orderMembers = (result, reasonCode, overrides = {}) => ({ ...members(SEEDED_ORDER_FIELDS, result, reasonCode), ...EXCLUDED_BY_POLICY, ...overrides });

// An order row every seeded credited field of which reads the row's own
// result, with the five fields the default policy never seeds excluded.
function assertSeededFieldsRead(order, result, reasonCode) {
  assertRow(order, result, reasonCode);
  assertExactMembers(order, orderMembers(result, reasonCode));
}

// An order pass: every seeded field passes, the five unseeded fields are
// excluded, and the sources observed and coverage limits are exactly these.
function assertOrderPass(order, { sources = ALL_SOURCES, limits = [], overrides = {} } = {}) {
  assertRow(order, "pass", null);
  assertExactMembers(order, orderMembers("pass", null, overrides));
  assertSourcesObserved(order, sources);
  assertCoverage(order, { limits });
}

// ---------------------------------------------------------------------------
// Working

browserTest("F1.1-W2 as W1; request attribution equals the seeds, sub1 as subaffiliate1, affid as affiliate: order row pass", T, async () => {
  const { result, log } = await defaultRun();
  assertAccepted(result, log);
  await loadModule();
  assertRequestCarriesSeeds(log);
  const rows = await trackingRows(result, IDS);
  assertOrderPass(rowOf(rows, ORDER_ID));
});

browserTest("F1.1-W4 create response lacks attribution; request equal; order accepted: order row pass (coverage limit create_response: absent)", T, async () => {
  const { result, log } = await runTrackingScenario("order-w4", { createEcho: false });
  assertAccepted(result, log);
  await loadModule();
  assertRequestCarriesSeeds(log);
  const rows = await trackingRows(result, IDS);
  // The missing create-response echo is a coverage limit, not a source.
  assertOrderPass(rowOf(rows, ORDER_ID), { sources: ["request", "readback"], limits: ["create_response: absent"] });
});

browserTest("F1.1-W5 query stripped at page hop 2; sessionStorage carries the values; request equal; order accepted: order row pass", T, async () => {
  const { result, log } = await runTrackingScenario("order-w5", { bridge: { strip: true } });
  assertAccepted(result, log);
  assert.equal(log.documents[3].query, "", "setup: page hop 2 carried no query");
  await loadModule();
  assertRequestCarriesSeeds(log);
  const rows = await trackingRows(result, IDS);
  assertOrderPass(rowOf(rows, ORDER_ID));
});

browserTest("F1.1-W6 tracking.preserve [\"sub3\"]; request attribution.subaffiliate3 equals the seed; order accepted: subaffiliate3 order member pass", T, async () => {
  const { result, log } = await runTrackingScenario("order-w6", {}, { options: { spec: specWithPreserve(["sub3"]) } });
  assertAccepted(result, log);
  await loadModule();
  const seed = queryOf(log.documents[1]).get("sub3");
  assert.match(seed || "", SEED_VALUE, "the entry load carried the declared sub3 seed");
  assert.equal(log.creates[0].body?.attribution?.subaffiliate3, seed, "the request carried it as subaffiliate3");
  const rows = await trackingRows(result, IDS);
  assertOrderPass(rowOf(rows, ORDER_ID), { overrides: { subaffiliate3: ["pass", null] } });
  const url = rowOf(rows, URL_ID);
  assertRow(url, "pass", null);
  assertExactMembers(url, members([...DEFAULT_URL_KEYS, "sub3"], "pass", null));
  assertFailingHops(url);
});

// ---------------------------------------------------------------------------
// Broken

browserTest("F1.1-B1 request attribution.utm_source differs from the seed; no page script: order row warning (order_attribution_differs)", T, async () => {
  const { result, log } = await runTrackingScenario("order-b1", { attribution: { override: { utm_source: "syn_other" } } });
  assertAccepted(result, log);
  assert.equal(log.creates[0].body?.attribution?.utm_source, "syn_other", "setup: the request carried another utm_source");
  await loadModule();
  assertRequestCarriesSeeds(log, { except: ["utm_source"] });
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "warning", "order_attribution_differs");
  assertExactMembers(order, orderMembers("pass", null, { utm_source: ["warning", "order_attribution_differs"] }));
});

browserTest("F1.1-B6 request carries attribution without utm_content; no page script: order row warning (order_attribution_missing)", T, async () => {
  const { result, log } = await runTrackingScenario("order-b6", { attribution: { omit: ["utm_content"] } });
  assertAccepted(result, log);
  assert.equal(typeof log.creates[0].body?.attribution, "object", "setup: the request carried an attribution object");
  assert.equal(Object.hasOwn(log.creates[0].body.attribution, "utm_content"), false, "setup: without utm_content");
  await loadModule();
  assertRequestCarriesSeeds(log, { except: ["utm_content"] });
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "warning", "order_attribution_missing");
  assertExactMembers(order, orderMembers("pass", null, { utm_content: ["warning", "order_attribution_missing"] }));
});

// ---------------------------------------------------------------------------
// Incomplete

browserTest("F1.1-I1 submit fails, no create request: order row unexercised (no_accepted_order)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i1", { submit: "noop" }, { args: { "step-timeout-ms": 12000 } });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/"], "setup: no receipt");
  assert.equal(log.creates.length, 0, "setup: no create request was sent");
  assert.equal(orderAssertion(result).status, "fail", "setup: the attempt failed");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "no_accepted_order");
});

browserTest("F1.1-I2 create request sent with equal attribution; response rejected: order row unexercised (no_accepted_order)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i2", { create: "reject" });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/"], "setup: no receipt");
  assert.equal(log.creates.length, 1, "setup: one create request was sent");
  assert.equal(orderAssertion(result).status, "fail", "setup: the create was rejected");
  await loadModule();
  assertRequestCarriesSeeds(log);
  const rows = await trackingRows(result, IDS);
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "no_accepted_order");
});

browserTest("F1.1-I6 tracking.preserve [\"syn_ref\"]; no page script; no tag: syn_ref order member excluded (no_credited_field)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i6", {}, { options: { spec: specWithPreserve(["syn_ref"]) } });
  assertAccepted(result, log);
  await loadModule();
  assert.match(queryOf(log.documents[1]).get("syn_ref") || "", SEED_VALUE, "the declared name was seeded on the entry load");
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "pass", null);
  assertExactMembers(order, orderMembers("pass", null, { syn_ref: ["excluded", "no_credited_field"] }));
  assertSourcesObserved(order, ALL_SOURCES);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "pass", null);
  assertExactMembers(url, members([...DEFAULT_URL_KEYS, "syn_ref"], "pass", null));
  assertFailingHops(url);
});

browserTest("F1.1-I7 tracking.preserve [\"syn_ref\"]; page script copies ?syn_ref to metadata: syn_ref order member review (page_script_mapping)", T, async () => {
  const scenario = { checkoutInline: "<script>next.addMetadata(\"syn_ref\", new URLSearchParams(location.search).get(\"syn_ref\"));</script>" };
  const { result, log } = await runTrackingScenario("order-i7", scenario, { options: { spec: specWithPreserve(["syn_ref"]) } });
  assertAccepted(result, log);
  await loadModule();
  const seed = queryOf(log.documents[3]).get("syn_ref");
  assert.match(seed || "", SEED_VALUE, "the checkout carried the declared name");
  assert.equal(log.creates[0].body?.attribution?.metadata?.syn_ref, seed, "page script copied it into the request metadata");
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "review", "page_script_mapping");
  assertExactMembers(order, orderMembers("pass", null, { syn_ref: ["review", "page_script_mapping"] }));
});

browserTest("F1.1-I8 request attribution.utm_source = \"konami_code\": utm_* order members unexercised (sdk_test_attribution)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i8", { attribution: { override: { utm_source: "konami_code" } } });
  assertAccepted(result, log);
  assert.equal(log.creates[0].body?.attribution?.utm_source, "konami_code", "setup: SDK test attribution in the request");
  await loadModule();
  assertRequestCarriesSeeds(log, { except: ["utm_source"] });
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "unexercised", "sdk_test_attribution");
  assertExactMembers(order, orderMembers("pass", null, members(UTM_FIELDS, "unexercised", "sdk_test_attribution")));
});

browserTest("F1.1-I9 inline script calls next.setAttribution(; request utm_campaign differs: order row review (page_script_mapping)", T, async () => {
  const scenario = { checkoutInline: "<script>next.setAttribution({ utm_campaign: \"syn_other\" });</script>" };
  const { result, log } = await runTrackingScenario("order-i9", scenario);
  assertAccepted(result, log);
  assert.equal(log.creates[0].body?.attribution?.utm_campaign, "syn_other", "setup: the request carried the page script's utm_campaign");
  await loadModule();
  assertRequestCarriesSeeds(log, { except: ["utm_campaign"] });
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "review", "page_script_mapping");
  assertExactMembers(order, orderMembers("pass", null, { utm_campaign: ["review", "page_script_mapping"] }));
});

browserTest("F1.1-I11 order request body unparseable: order row unexercised (request_body_unreadable)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i11", { rawBody: "syn-unparseable{" });
  assertAccepted(result, log);
  assert.equal(log.creates[0].body, null, "setup: the posted body does not parse");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "request_body_unreadable");
});

browserTest("F1.1-I13 default seed policy run: funnel, gclid, subaffiliate3-5 order members excluded (not_seeded_by_policy)", T, async () => {
  const { result, log } = await defaultRun();
  assertAccepted(result, log);
  for (const entry of log.all) {
    const query = new URLSearchParams(entry.query);
    for (const name of ["funnel", "gclid", "sub3", "sub4", "sub5", "subaffiliate3", "subaffiliate4", "subaffiliate5"]) {
      assert.equal(query.has(name), false, `${entry.path}: ${name} was never sent`);
    }
  }
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertOrderPass(rowOf(rows, ORDER_ID));
});

browserTest("F1.1-I14 URL-seeded oid (preserve name) and a static same-named oid tag, no URL mapping: oid URL-name order member review (declared_tag_same_name)", T, async () => {
  const scenario = { tags: [{ name: "oid", value: "syn_static" }] };
  const { result, log } = await runTrackingScenario("order-i14", scenario, { options: { spec: specWithPreserve(["oid"]) } });
  assertAccepted(result, log);
  assert.equal(log.creates[0].body?.attribution?.metadata?.oid, "syn_static", "setup: the request metadata carries the static tag literal, not a URL value");
  await loadModule();
  assert.match(queryOf(log.documents[1]).get("oid") || "", SEED_VALUE, "oid was URL-seeded on the entry load");
  const rows = await trackingRows(result, [URL_ID, ORDER_ID, OID_TAG_ID]);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "review", "declared_tag_same_name");
  assertExactMembers(order, orderMembers("pass", null, { oid: ["review", "declared_tag_same_name"] }));
});

browserTest("F1.1-I18 attempt needs recoverCreatedOrder on a new page: URL and order rows unexercised (attempt_recovered_on_new_page)", T, async () => {
  const { result, log, base } = await runTrackingScenario("order-i18", { receiptRender: false });
  assert.deepEqual(documentPaths(log), [...ENTRY_HOPS, "/x/receipt/"], "setup: the receipt was reloaded on a new page by recovery");
  assert.equal(log.creates.length, 1, "setup: one create, accepted");
  assert.equal(log.readbacks.length, 2, "setup: the attempt's read-back and recovery's");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "unexercised", "attempt_recovered_on_new_page");
  assertExactMembers(url, members(DEFAULT_URL_KEYS, "unexercised", "attempt_recovered_on_new_page"));
  // The loss across the recovery page has a runner neighbour: no failing hop.
  assertFailingHops(url);
  // The attempt page observed every hop through the receipt; the recovery page
  // is excluded from observation.
  assertCoverage(url, { last_observed: `${base}/x/receipt/`, limits: ["attempt_recovered_on_new_page"] });
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "attempt_recovered_on_new_page");
});

browserTest("F1.1-I19 accepted order whose request has no attribution object: order row unexercised (attribution_not_sent)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i19", { omitAttribution: true });
  assertAccepted(result, log);
  assert.equal(Object.hasOwn(log.creates[0].body || {}, "attribution"), false, "setup: no attribution object in the request");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "attribution_not_sent");
});

browserTest("F1.1-I20 create request fails at the network layer (no response): order row unexercised (no_accepted_order)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i20", { create: "drop" });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/"], "setup: no receipt");
  assert.ok(log.creates.length >= 1, "setup: the create request reached the server and its connection was reset");
  assert.equal(orderAssertion(result).status, "fail", "setup: the create failed");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "no_accepted_order");
});

browserTest("F1.1-I21 request attribution.metadata.test_order key present; utm_source equals the seed: utm_* order members unexercised (sdk_test_attribution)", T, async () => {
  const { result, log } = await runTrackingScenario("order-i21", { attribution: { testOrderKey: true } });
  assertAccepted(result, log);
  assert.equal(Object.hasOwn(log.creates[0].body?.attribution?.metadata || {}, "test_order"), true, "setup: the test_order key is present");
  await loadModule();
  assertRequestCarriesSeeds(log);
  const rows = await trackingRows(result, IDS);
  const order = rowOf(rows, ORDER_ID);
  assertRow(order, "unexercised", "sdk_test_attribution");
  assertExactMembers(order, orderMembers("pass", null, members(UTM_FIELDS, "unexercised", "sdk_test_attribution")));
});

browserTest("F1.1-I24 injected exception in the request equality extractor; order still accepted: order row unexercised (extractor_failed)", T, async () => {
  const hooks = { beforeExtractor(name) { if (name === "request_equality") throw new Error("synthetic request extractor failure"); } };
  const { result, log } = await runTrackingScenario("order-i24", {}, { options: { trackingTestHooks: hooks } });
  assertAccepted(result, log);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertSeededFieldsRead(rowOf(rows, ORDER_ID), "unexercised", "extractor_failed");
});
