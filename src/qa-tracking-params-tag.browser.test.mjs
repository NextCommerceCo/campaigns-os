// Unit 1.1 fixture rows, declared custom tags (contract §1.1 Result
// rules, "Declared custom tag X with literal V", F1.1-W3 as accepted) and the privacy guard F1.1-P1 (contract §1.1 "Prerequisite:
// redact existing raw-query persistence before seeding"), leg QB: real
// Chromium on a loopback stub campaign (src/qa-tracking-params-fixtures.mjs),
// driven through the actual `runBrowserTestOrders` entry point.
//
// API assumptions (shared, see src/qa-tracking-params-fixtures.mjs):
// runBrowserTestOrders resolves to { ..., qc_results } and pushes one
// browser-test-order qc.* assertion per row; the setup's ids and subjects are
// the literals tracking.url:checkout:url, tracking.order:checkout:order and
// tracking.tag:checkout:tag:syn_tag (subject key "tag:syn_tag"); a tag row
// judges one tag and does not aggregate, so its members are [].
// API assumption (I28): options.trackingTestHooks.beforeExtractor(name) is
// called first inside each wrapped extractor; "tag_dom_read" is the declared
// tag DOM read (see the URL test file for the full seam).
// API assumption (F1.1-P1): the persisted exits of a browser test order are
// what runBrowserTestOrders returns as orders[] (qa run's test_orders),
// assertions[] and qc_results[]. The test assembles the full verdict from them
// with the package's own createVerdict, exactly as qa run does, and walks the
// whole JSON of that verdict and of qc_results; values kept raw in memory for
// recovery are not serialized (JSON skips symbol keys and non-enumerable
// properties).
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  ORDER_ID,
  TAG_ID,
  URL_ID,
  assertExactMembers,
  assertLoopbackOnly,
  assertNothingPrivatePersisted,
  assertRow,
  chromiumAvailable,
  documentPaths,
  orderAssertion,
  rowOf,
  runTrackingScenario,
  syntheticMarker,
  trackingRows,
  installNodeGuard,
} from "./qa-tracking-params-fixtures.mjs";

installNodeGuard();
afterEach(() => assertLoopbackOnly());

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; 1.1 declared-tag and privacy rows skipped (run `npm run qa:install-browser`)", () => {});
}

const T = { timeout: 240000 };
const ENTRY_HOPS = ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/", "/x/receipt/"];
const TAG = [{ name: "syn_tag", value: "syn_v" }];
const IDS = [URL_ID, ORDER_ID, TAG_ID];
const loadModule = () => import("./qa-tracking-params.mjs");
const requestMetadata = (log) => log.creates[0]?.body?.attribution?.metadata || {};

// The tag row reads exactly `result` / `reasonCode`, with no members.
function assertTagRow(rows, result, reasonCode) {
  const tag = rowOf(rows, TAG_ID);
  assertRow(tag, result, reasonCode);
  assertExactMembers(tag, {});
}

function assertAccepted(result, log) {
  assert.deepEqual(documentPaths(log), ENTRY_HOPS, "setup: the pages the synthetic setup loads");
  assert.equal(log.creates.length, 1, "setup: exactly one order create was posted");
  assert.equal(orderAssertion(result).status, "pass", "setup: the order was accepted and read back");
}

// ---------------------------------------------------------------------------
// Working

browserTest("F1.1-W3 <meta name=\"os-tracking-tag\" data-tag-name=\"syn_tag\" data-tag-value=\"syn_v\">; request metadata.syn_tag = \"syn_v\": tag row pass", T, async () => {
  const { result, log } = await runTrackingScenario("tag-w3", { tags: TAG });
  assertAccepted(result, log);
  assert.equal(requestMetadata(log).syn_tag, "syn_v", "setup: the request metadata carries the markup literal");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "pass", null);
});

// ---------------------------------------------------------------------------
// Broken

browserTest("F1.1-B4 tag rendered; key absent from request metadata: tag row warning (tag_missing)", T, async () => {
  const { result, log } = await runTrackingScenario("tag-b4", { tags: TAG, metadataOmit: ["syn_tag"] });
  assertAccepted(result, log);
  assert.equal(Object.hasOwn(requestMetadata(log), "syn_tag"), false, "setup: syn_tag is absent from the request metadata");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "warning", "tag_missing");
});

browserTest("F1.1-B7 tag literal syn_v; request metadata.syn_tag = \"other\"; no page script: tag row warning (tag_value_differs)", T, async () => {
  const { result, log } = await runTrackingScenario("tag-b7", { tags: TAG, metadataOverride: { syn_tag: "other" } });
  assertAccepted(result, log);
  assert.equal(requestMetadata(log).syn_tag, "other", "setup: the request carries another value");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "warning", "tag_value_differs");
});

browserTest("tag literal of three spaces; request metadata.syn_tag = \"syn_v\": the tag keeps its row, warning (tag_value_differs), hashed as rendered", T, async () => {
  const { sha256 } = await import("./qa-tracking-params-fixtures.mjs");
  const { result, log } = await runTrackingScenario("tag-blank", { tags: [{ name: "syn_tag", value: "   " }], metadataOverride: { syn_tag: "syn_v" } });
  assertAccepted(result, log);
  assert.equal(requestMetadata(log).syn_tag, "syn_v", "setup: the request carries another value");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "warning", "tag_value_differs");
  const literals = rowOf(rows, TAG_ID).observation.names.filter((entry) => entry.tag_or_name === "syn_tag").map((entry) => entry.literal_sha256);
  assert.deepEqual([...new Set(literals)], [sha256("   ")], "the literal is hashed exactly as rendered");
});

browserTest("tag literal \" syn_v \" with surrounding spaces; request metadata.syn_tag the same: tag row pass, the literal hashed untrimmed", T, async () => {
  const { sha256 } = await import("./qa-tracking-params-fixtures.mjs");
  const { result, log } = await runTrackingScenario("tag-spaced", { tags: [{ name: "syn_tag", value: " syn_v " }] });
  assertAccepted(result, log);
  assert.equal(requestMetadata(log).syn_tag, " syn_v ", "setup: the request metadata carries the markup literal");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "pass", null);
  const literals = rowOf(rows, TAG_ID).observation.names.filter((entry) => entry.tag_or_name === "syn_tag").map((entry) => entry.literal_sha256);
  assert.deepEqual([...new Set(literals)], [sha256(" syn_v ")], "the literal is hashed exactly as rendered");
  assert.notEqual(sha256(" syn_v "), sha256("syn_v"));
});

// ---------------------------------------------------------------------------
// Incomplete

browserTest("F1.1-I22 tag rendered; submit fails, no create request: tag row unexercised (no_accepted_order)", T, async () => {
  const { result, log } = await runTrackingScenario("tag-i22", { tags: TAG, submit: "noop" }, { args: { "step-timeout-ms": 12000 } });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/"], "setup: no receipt");
  assert.equal(log.creates.length, 0, "setup: no create request was sent");
  assert.equal(orderAssertion(result).status, "fail", "setup: the attempt failed");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "unexercised", "no_accepted_order");
});

browserTest("F1.1-I23 tag rendered; inline next.addMetadata( call; request metadata.syn_tag differs: tag row review (page_script_mapping)", T, async () => {
  const scenario = { tags: TAG, checkoutInline: "<script>next.addMetadata(\"syn_tag\", \"syn_other\");</script>" };
  const { result, log } = await runTrackingScenario("tag-i23", scenario);
  assertAccepted(result, log);
  assert.equal(requestMetadata(log).syn_tag, "syn_other", "setup: page script changed the request value");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "review", "page_script_mapping");
});

browserTest("F1.1-I28 tag rendered; injected exception in the tag DOM read; order still accepted: tag row unexercised (extractor_failed)", T, async () => {
  const hooks = { beforeExtractor(name) { if (name === "tag_dom_read") throw new Error("synthetic tag read failure"); } };
  const { result, log } = await runTrackingScenario("tag-i28", { tags: TAG }, { options: { trackingTestHooks: hooks } });
  assertAccepted(result, log);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "unexercised", "extractor_failed");
});

browserTest("F1.1-I29 tag rendered; order request body unparseable: tag row unexercised (request_body_unreadable)", T, async () => {
  const { result, log } = await runTrackingScenario("tag-i29", { tags: TAG, rawBody: "syn-unparseable{" });
  assertAccepted(result, log);
  assert.equal(log.creates[0].body, null, "setup: the posted body does not parse");
  await loadModule();
  const rows = await trackingRows(result, IDS);
  assertTagRow(rows, "unexercised", "request_body_unreadable");
});

// ---------------------------------------------------------------------------
// Privacy guard (no exception for configured URLs)

browserTest("F1.1-P1 a QB setup with the redaction prerequisite: full verdict and qc_results hold no non-seed query value, no metadata, no landing_page, no body; final_url, checkout_url, requests[].url are origin+path", T, async () => {
  // One unique synthetic private value per private input the setup controls:
  // three non-seed query values added at runtime (the configured page URLs
  // carry no query), request and response body content, request metadata,
  // the landing page, link text and expression text. The whole serialized
  // verdict and qc_results must hold none of them, in any key or value.
  const markers = {
    hop_query: syntheticMarker("hop"),
    receipt_query: syntheticMarker("receipt"),
    create_query: syntheticMarker("create"),
    request_body: syntheticMarker("request_body"),
    response_body: syntheticMarker("response_body"),
    metadata: syntheticMarker("metadata"),
    landing_page: syntheticMarker("landing"),
    link_text: syntheticMarker("link"),
    expression_text: syntheticMarker("expression"),
  };
  const scenario = {
    tags: TAG,
    bridgeExtra: `syn_private=${markers.hop_query}`,
    receiptExtra: `syn_private=${markers.receipt_query}`,
    createUrl: `/api/v1/orders/?syn_private=${markers.create_query}`,
    requestNote: markers.request_body,
    responseNote: markers.response_body,
    privateMetadata: markers.metadata,
    landingExtra: `syn_private=${markers.landing_page}`,
    extraHtml: `<p><a href="/x/landing/">${markers.link_text}</a></p><div data-next-show="param.syn_expr == '${markers.expression_text}'">Synthetic note</div>`,
  };
  const { result, log, base, topologies, runId } = await runTrackingScenario("tag-p1", scenario);
  assertAccepted(result, log);
  // Setup: no configured URL has a query, and every private value really
  // reached a URL, a request, a response or a page.
  const configured = topologies.flatMap((topology) => topology.pages.flatMap((page) => [page.url, page.expected_next_url].filter(Boolean)));
  for (const url of configured) assert.equal(/[?#]/.test(url), false, `setup: the configured URL ${url} carries no query`);
  const queryOf = (entry) => new URLSearchParams(entry.query);
  assert.equal(queryOf(log.documents[3]).get("syn_private"), markers.hop_query, "setup: the bridge's checkout hop added a non-seed query value");
  assert.equal(queryOf(log.documents[4]).getAll("syn_private").includes(markers.receipt_query), true, "setup: the post-order redirect carried a non-seed query value");
  assert.equal(queryOf(log.creates[0]).get("syn_private"), markers.create_query, "setup: the create request URL carried a non-seed query value");
  const body = log.creates[0].body || {};
  assert.equal(body.syn_note, markers.request_body, "setup: the create request body carried a private value");
  assert.equal(body.attribution?.metadata?.syn_private_meta, markers.metadata, "setup: the request metadata carried a private value");
  assert.equal(typeof body.attribution?.landing_page, "string", "setup: the request carried landing_page");
  assert.equal(body.attribution.landing_page.includes(markers.landing_page), true, "setup: the request landing_page carried a private value");
  assert.equal(String(body.attribution.metadata?.landing_page).includes(markers.landing_page), true, "setup: the request metadata.landing_page carried a private value");
  assert.equal(log.readbacks.length, 1, "setup: the receipt read the order back (its response carried the private body value)");

  // The full verdict, assembled from the run's persisted exits the way qa run
  // does, and the stage's qc_results: the whole serialized JSON is searched
  // for every planted marker (any key, any value). Besides the markers, any
  // field the 1.0 persistence rule forbids by name fails whatever it holds
  // (metadata, landing_page, link or expression text, a raw query: the
  // fixture's FORBIDDEN_FIELDS), any query value in any string fails, and a
  // body field (body, postData, payload, response_body, ...) fails unless it
  // is null or one of the two redacted summaries qa-browser already persists.
  const { createVerdict } = await import("./qa-verdict.mjs");
  const pageUrls = topologies.flatMap((topology) => topology.pages.map((page) => page.url));
  const verdict = createVerdict({
    runId,
    mapId: "synthetic-tracking-map",
    specVersion: "v4",
    specHash: "sha256:synthetic",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    runtime: "campaigns-os-node-qa@synthetic",
    baseUrl: base,
    entryUrls: [pageUrls[0]],
    pageUrls,
    testedUrls: pageUrls,
    assertions: result.assertions,
    testOrders: result.orders,
  });
  const strings = assertNothingPrivatePersisted({ verdict, qc_results: result.qc_results ?? null }, {
    markers: { ...markers, non_seed_query_name: "syn_private" },
    forbiddenKeys: ["metadata", "landing_page"],
    forbiddenText: ["HeadlessChrome", "syn_expr"],
  });
  assert.ok(strings > 0, "the walk read the persisted strings");
  const [order] = result.orders;
  assert.equal(order.final_url, `${base}/x/receipt/`, "final_url is origin+path");
  assert.equal(order.checkout_url, `${base}/x/checkout/`, "checkout_url is origin+path");
  const requests = order.evidence?.events?.requests || [];
  assert.ok(requests.some((request) => request.url === `${base}/api/v1/orders/`), "the create request is listed by origin+path");
  for (const request of requests) assert.equal(request.url, `${new URL(request.url).origin}${new URL(request.url).pathname}`, `requests[].url ${request.url} is origin+path`);
  assert.equal(orderAssertion(result).evidence.final_url, `${base}/x/receipt/`, "the assertion's final_url copy is origin+path");

  await loadModule();
  const rows = await trackingRows(result, IDS);
  assert.deepEqual([...rows.keys()].sort(), [...IDS].sort(), "qc_results was checked, not absent");
});
