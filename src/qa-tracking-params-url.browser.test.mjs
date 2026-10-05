// Unit 1.1 fixture rows, URL preservation (contract §1.1 Result rules,
// "URL preservation, per seeded key"), leg QB: real Chromium on a loopback
// stub campaign (src/qa-tracking-params-fixtures.mjs), driven through the
// actual `runBrowserTestOrders` entry point.
//
// Each test first checks the seed-independent facts of its synthetic setup
// (the pages loaded, the creates posted, the order outcome), which hold on the
// base as well, and only then loads the new module and reads the row.
//
// API assumptions (shared, see src/qa-tracking-params-fixtures.mjs):
// runBrowserTestOrders resolves to { ..., qc_results } and pushes one
// browser-test-order qc.* assertion per row; the setup's ids and subjects are
// the literals tracking.url:checkout:url and tracking.order:checkout:order;
// preserve names come from options.spec; members are keyed by URL parameter
// name; an unexercised URL row reports coverage.last_observed and
// coverage.limits [<reason code>].
//
// API assumption (I5, I17, I27): options.trackingTestHooks is an in-process
// test seam, like qcStandIns, never reachable from argv, env or disk:
//   beforeExtractor(name)   called first inside each wrapped 1.1 extractor; a
//                           throw there is that extractor's exception. Names:
//                           "hop_equality", "request_equality", "tag_dom_read".
//   detachObserverAtPageHop n: the hop observer is detached across the n-th
//                           page-initiated navigation after the measured seed
//                           hop (1-based) and attached again after it.
//   lateHopListener         true: the hop listener is attached only after the
//                           last pre-page-hop runner load has begun.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  DEFAULT_URL_KEYS,
  ORDER_ID,
  SEED_VALUE,
  URL_ID,
  assertCoverage,
  assertExactMembers,
  assertLoopbackOnly,
  assertRow,
  chromiumAvailable,
  documentPaths,
  assertFailingHops,
  memberOf,
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
  test.skip("Playwright Chromium is unavailable; 1.1 URL-preservation rows skipped (run `npm run qa:install-browser`)", () => {});
}

const T = { timeout: 240000 };
const ENTRY_HOPS = ["/x/checkout/", "/x/landing/", "/x/bridge/", "/x/checkout/", "/x/receipt/"];
const loadModule = () => import("./qa-tracking-params.mjs");
const defaultRun = () => sharedRun("default", () => runTrackingScenario("url-default"));
const queryOf = (entry) => new URLSearchParams(entry.query);
const IDS = [URL_ID, ORDER_ID];
const allUrlMembers = (result, reasonCode) => members(DEFAULT_URL_KEYS, result, reasonCode);

// An unexercised URL row: every seeded member reads the row's reason, no
// member names a failing hop, and the row reports the last observed point and
// its coverage limit exactly.
function assertUnexercisedUrl(url, reasonCode, lastObserved) {
  assertRow(url, "unexercised", reasonCode);
  assertExactMembers(url, allUrlMembers("unexercised", reasonCode));
  assertFailingHops(url);
  assertCoverage(url, { last_observed: lastObserved, limits: [reasonCode] });
}

function assertAccepted(result, log) {
  assert.equal(log.creates.length, 1, "setup: exactly one order create was posted");
  assert.equal(orderAssertion(result).status, "pass", "setup: the order was accepted and read back");
}

// With the check in place: the documents loaded up to `count` carried every default
// seed key with a synthetic seed value.
function assertSeeded(log, count, keys = DEFAULT_URL_KEYS) {
  for (const entry of log.documents.slice(0, count)) {
    const query = queryOf(entry);
    for (const key of keys) assert.match(query.get(key) || "", SEED_VALUE, `${entry.path} carried the seed for ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Working

browserTest("F1.1-W1 stub page, 3 page hops forwarding the query, the last the post-order navigation; accepted order: URL row pass", T, async () => {
  const { result, log } = await defaultRun();
  assert.deepEqual(documentPaths(log), ENTRY_HOPS, "setup: checkout probe and entry load (runner), then bridge, checkout and receipt (page hops)");
  assertAccepted(result, log);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "pass", null);
  assertExactMembers(url, allUrlMembers("pass", null));
  assertFailingHops(url);
  // The seeds were real: both pre-page-hop runner loads were seeded, and every
  // page hop forwarded them.
  assertSeeded(log, 5);
});

// ---------------------------------------------------------------------------
// Broken

browserTest("F1.1-B2 utm_medium equal at page hop 1, absent at document page hop 2 to /checkout/ (outside the existing request filter): URL row warning naming both paths (url_param_dropped)", T, async () => {
  const { result, log, base } = await runTrackingScenario("url-b2", { bridge: { drop: ["utm_medium"] } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS, "setup: the drop happens on the bridge -> checkout document hop");
  assertAccepted(result, log);
  await loadModule();
  assert.equal(queryOf(log.documents[2]).has("utm_medium"), true, "setup: page hop 1 (bridge) carried utm_medium");
  assert.equal(queryOf(log.documents[3]).has("utm_medium"), false, "setup: page hop 2 (checkout) did not");
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "warning", "url_param_dropped");
  assertExactMembers(url, { ...allUrlMembers("pass", null), utm_medium: ["warning", "url_param_dropped"] });
  assert.deepEqual(memberOf(url, "utm_medium").failing_hop, { from: `${base}/x/bridge/`, to: `${base}/x/checkout/` }, "both redacted paths are named");
  assertFailingHops(url, { utm_medium: { from: `${base}/x/bridge/`, to: `${base}/x/checkout/` } });
});

browserTest("F1.1-B3 query stripped at page hop 2, sessionStorage carries the values (setup of F1.1-W5): URL row warning (url_param_dropped)", T, async () => {
  const { result, log, base } = await runTrackingScenario("url-b3", { bridge: { strip: true } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS, "setup: the strip happens on the bridge -> checkout document hop");
  assert.equal(log.documents[3].query, "", "setup: page hop 2 carried no query");
  assertAccepted(result, log);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "warning", "url_param_dropped");
  assertExactMembers(url, allUrlMembers("warning", "url_param_dropped"));
  for (const key of DEFAULT_URL_KEYS) {
    assert.deepEqual(memberOf(url, key).failing_hop, { from: `${base}/x/bridge/`, to: `${base}/x/checkout/` }, `${key} names both paths`);
  }
  assertFailingHops(url, Object.fromEntries(DEFAULT_URL_KEYS.map((key) => [key, { from: `${base}/x/bridge/`, to: `${base}/x/checkout/` }])));
});

browserTest("F1.1-B5 utm_term value replaced by another value at a document page hop: URL row warning (url_param_changed)", T, async () => {
  const { result, log } = await runTrackingScenario("url-b5", { bridge: { replace: { utm_term: "syn_other" } } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS, "setup: the replacement happens on the bridge -> checkout document hop");
  assertAccepted(result, log);
  await loadModule();
  assert.equal(queryOf(log.documents[3]).get("utm_term"), "syn_other", "setup: page hop 2 carried another utm_term value");
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "warning", "url_param_changed");
  assertExactMembers(url, { ...allUrlMembers("pass", null), utm_term: ["warning", "url_param_changed"] });
  assertFailingHops(url);
});

// ---------------------------------------------------------------------------
// Incomplete

browserTest("F1.1-I3 only runner hops after the seed: URL row unexercised, last point reported (no_page_hop_after_seed)", T, async () => {
  const scenario = { checkoutSelects: true, checkoutPath: "/x/order-form/", afterCreate: "stay" };
  const { result, log, base } = await runTrackingScenario("url-i3", scenario);
  assert.deepEqual(documentPaths(log), ["/x/order-form/"], "setup: the checkout probe is the only load; the page never navigates");
  assertAccepted(result, log);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  // No page hop followed the seed: the last point is the measured seed hop.
  assertUnexercisedUrl(rowOf(rows, URL_ID), "no_page_hop_after_seed", `${base}/x/order-form/`);
});

browserTest("F1.1-I4 runner reload between two equal page hops: URL row unexercised (runner_reload_in_sequence)", T, async () => {
  const scenario = { direct: true, checkoutAwayTo: "/x/interstitial/", preserveFromStore: true };
  const { result, log, base } = await runTrackingScenario("url-i4", scenario);
  // Probe load of checkout (runner), page hop to the interstitial, the runner's
  // entry load of landing (a runner navigation after the first page hop), then
  // page hops to checkout and the receipt, both forwarding the stored values.
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/interstitial/", "/x/landing/", "/x/checkout/", "/x/receipt/"], "setup: a runner load between page hops");
  assertAccepted(result, log);
  await loadModule();
  assert.equal(log.documents[2].query, "", "setup: the runner load after the first page hop was not re-seeded");
  for (const index of [1, 3]) assertSeeded({ documents: [log.documents[index]] }, 1);
  const rows = await trackingRows(result, IDS);
  // Measured seed hop: the checkout probe; page hop 1: the interstitial; then
  // the runner's landing load ends the observed sequence.
  assertUnexercisedUrl(rowOf(rows, URL_ID), "runner_reload_in_sequence", `${base}/x/interstitial/`);
});

browserTest("F1.1-I5 observer detached across one navigation: URL row unexercised (observation_gap)", T, async () => {
  const { result, log, base } = await runTrackingScenario("url-i5", {}, { options: { trackingTestHooks: { detachObserverAtPageHop: 2 } } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS, "setup: the same three page hops as F1.1-W1");
  assertAccepted(result, log);
  await loadModule();
  assertSeeded(log, 5);
  const rows = await trackingRows(result, IDS);
  // Page hop 1 (bridge) was observed; the observer was detached across page
  // hop 2 (to checkout).
  assertUnexercisedUrl(rowOf(rows, URL_ID), "observation_gap", `${base}/x/bridge/`);
});

browserTest("F1.1-I10 document hop to checkout loads with utm_medium equal, then page script history.replaceState drops it: URL row review (history_rewrite)", T, async () => {
  const { result, log } = await runTrackingScenario("url-i10", { direct: true, replaceStateDrop: ["utm_medium"] });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/checkout/", "/x/receipt/"], "setup: landing -> checkout document hop, then the receipt");
  assertAccepted(result, log);
  await loadModule();
  assert.equal(queryOf(log.documents[2]).has("utm_medium"), true, "setup: the document hop to checkout carried utm_medium");
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "review", "history_rewrite");
  assertExactMembers(url, { ...allUrlMembers("pass", null), utm_medium: ["review", "history_rewrite"] });
  assertFailingHops(url);
});

browserTest("F1.1-I12 9 tracking.preserve names (17 keys): URL row unexercised, the 9th name over the 16-key cap (seed_allowlist_overflow)", T, async () => {
  const names = Array.from({ length: 9 }, (_, index) => `syn_p${index + 1}`);
  const { result, log, base } = await runTrackingScenario("url-i12", {}, { options: { spec: specWithPreserve(names) } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS);
  assertAccepted(result, log);
  await loadModule();
  assertSeeded(log, 5, [...DEFAULT_URL_KEYS, ...names.slice(0, 8)]);
  for (const entry of log.documents) {
    const query = queryOf(entry);
    assert.equal(query.has("syn_p9"), false, `${entry.path}: the 9th declared name was never seeded`);
    assert.ok([...query.keys()].filter((key) => key !== "ref_id").length <= 16, `${entry.path}: at most 16 seeded keys`);
  }
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  assertRow(url, "unexercised", "seed_allowlist_overflow");
  assertExactMembers(url, { ...members([...DEFAULT_URL_KEYS, ...names.slice(0, 8)], "pass", null), syn_p9: ["unexercised", "seed_allowlist_overflow"] });
  assertFailingHops(url);
  // The 16 seeded keys were observed through the post-order navigation.
  assertCoverage(url, { last_observed: `${base}/x/receipt/`, limits: ["seed_allowlist_overflow"] });
});

browserTest("F1.1-I17 hop listener attached after the last pre-page-hop runner load began: URL row unexercised (seed_hop_not_observed)", T, async () => {
  const { result, log } = await runTrackingScenario("url-i17", {}, { options: { trackingTestHooks: { lateHopListener: true } } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS);
  assertAccepted(result, log);
  await loadModule();
  assertSeeded(log, 5);
  const rows = await trackingRows(result, IDS);
  // The measured seed hop has no record, so no observed sequence starts.
  assertUnexercisedUrl(rowOf(rows, URL_ID), "seed_hop_not_observed", null);
});

browserTest("F1.1-I25 values equal through the cart -> checkout page hop; attempt times out on submit: URL row unexercised (attempt_incomplete)", T, async () => {
  const { result, log, base } = await runTrackingScenario("url-i25", { direct: true, create: "hold" }, { args: { "step-timeout-ms": 12000 } });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/checkout/"], "setup: no post-order navigation");
  assert.equal(log.creates.length, 1, "setup: the create was posted and never answered");
  assert.equal(orderAssertion(result).status, "fail", "setup: the attempt timed out on submit");
  await loadModule();
  assertSeeded(log, 3);
  const rows = await trackingRows(result, IDS);
  assertUnexercisedUrl(rowOf(rows, URL_ID), "attempt_incomplete", `${base}/x/checkout/`);
});

browserTest("F1.1-I26 tracking.preserve [\"gclid\"]: gclid URL member excluded, not seeded (not_seeded_by_policy)", T, async () => {
  const { result, log } = await runTrackingScenario("url-i26", {}, { options: { spec: specWithPreserve(["gclid"]) } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS);
  assertAccepted(result, log);
  for (const entry of log.all) assert.equal(new URLSearchParams(entry.query).has("gclid"), false, `${entry.path}: gclid was never sent`);
  await loadModule();
  assertSeeded(log, 5);
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  // The excluded member is ignored by aggregation; the seeded keys pass.
  assertRow(url, "pass", null);
  assertExactMembers(url, { ...allUrlMembers("pass", null), gclid: ["excluded", "not_seeded_by_policy"] });
  assertFailingHops(url);
});

browserTest("F1.1-I27 injected exception in the hop equality extractor; order still accepted: URL row unexercised (extractor_failed)", T, async () => {
  const hooks = { beforeExtractor(name) { if (name === "hop_equality") throw new Error("synthetic hop extractor failure"); } };
  const { result, log } = await runTrackingScenario("url-i27", {}, { options: { trackingTestHooks: hooks } });
  assert.deepEqual(documentPaths(log), ENTRY_HOPS);
  assertAccepted(result, log);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  // The hop extractor threw on its first call: no hop equality was recorded.
  assertUnexercisedUrl(rowOf(rows, URL_ID), "extractor_failed", null);
});

browserTest("F1.1-I30 values equal through a document page hop; after the accepted create, page script replaceState keeps the seeds; no post-order document redirect, the attempt times out: URL row unexercised (attempt_incomplete)", T, async () => {
  const { result, log, base } = await runTrackingScenario("url-i30", { direct: true, afterCreate: "replaceState" }, { args: { "step-timeout-ms": 12000 } });
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/checkout/"], "setup: no post-order document navigation");
  assert.equal(log.creates.length, 1, "setup: one create was posted");
  assert.equal(orderAssertion(result).status, "fail", "setup: the attempt timed out");
  await loadModule();
  assertSeeded(log, 3);
  const rows = await trackingRows(result, IDS);
  // The after-create replaceState is a history hop on the same origin+path.
  assertUnexercisedUrl(rowOf(rows, URL_ID), "attempt_incomplete", `${base}/x/checkout/`);
});

// ---------------------------------------------------------------------------
// A navigation request that never committed

// A loopback front for the stub campaign: every request is passed through to
// the stub, except the pending document, which is held open (never answered)
// until the front closes.
async function startPendingFront(stub) {
  const { createServer, request: forward } = await import("node:http");
  const target = new URL(stub.base);
  const held = new Set();
  const pending = [];
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, stub.base);
    if (url.pathname === "/x/pending-document/") {
      pending.push(url.search);
      held.add(outgoing);
      return;
    }
    const upstream = forward({ hostname: target.hostname, port: target.port, path: incoming.url, method: incoming.method, headers: incoming.headers }, (answer) => {
      outgoing.writeHead(answer.statusCode, answer.headers);
      answer.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    pending,
    close: () => new Promise((resolve) => {
      for (const response of held) response.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// On checkout after the landing hop, the first submit starts a main-frame
// navigation to the pending document, cancels it with window.stop() before any
// response (no document commits), pushes /x/intervening-history/, then lets
// the stub submit the create. Once the create is accepted (the stub stays on
// the page), the page pushes the cancelled request's own URL. No document
// navigation follows.
const CANCELLED_NAVIGATION_SCRIPT = `<script>
(function () {
  if (!sessionStorage.getItem("stub-sdk:entered")) return;
  var search = location.search;
  var form = document.querySelector("form[data-stub-checkout]");
  var original = window.fetch;
  window.fetch = function (input, init) {
    var answer = original.apply(this, arguments);
    if (init && init.method === "POST") {
      answer.then(function (response) {
        if (response.ok) setTimeout(function () { history.pushState({}, "", "/x/pending-document/" + search); }, 100);
      }, function () {});
    }
    return answer;
  };
  var armed = true;
  window.addEventListener("submit", function (event) {
    if (!armed) return;
    armed = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = "/x/pending-document/" + search;
    setTimeout(function () {
      window.stop();
      history.pushState({}, "", "/x/intervening-history/" + search);
      form.requestSubmit();
    }, 400);
  }, true);
})();
</script>`;

browserTest("a main-frame navigation cancelled before it commits, then a history hop to its URL after the accepted create, never reads as the post-order navigation: URL row unexercised (attempt_incomplete)", T, async () => {
  const { installBrowserGuard, startTrackingStub, stubTopologies, BASE_ARGS } = await import("./qa-tracking-params-fixtures.mjs");
  await installBrowserGuard();
  const { runBrowserTestOrders } = await import("./qa-browser.mjs");
  const scenario = { direct: true, afterCreate: "stay", checkoutInline: CANCELLED_NAVIGATION_SCRIPT };
  const stub = await startTrackingStub(scenario);
  const front = await startPendingFront(stub);
  let result;
  try {
    const topologies = stubTopologies({ ...stub, base: front.base }, scenario);
    result = await runBrowserTestOrders(topologies, { ...BASE_ARGS, "step-timeout-ms": 12000 }, "qa-tracking-url-cancelled", {});
  } finally {
    await front.close();
    await stub.close();
  }
  const { log } = stub;
  const base = front.base;
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/checkout/"], "setup: no document after checkout committed");
  assert.equal(front.pending.length, 1, "setup: the pending document was requested once and never answered");
  assert.equal(log.creates.length, 1, "setup: one create was posted");
  assertSeeded(log, 3);
  for (const key of DEFAULT_URL_KEYS) assert.match(new URLSearchParams(front.pending[0]).get(key) || "", SEED_VALUE, `setup: the cancelled request carried the seed for ${key}`);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  const { observation } = url;
  assert.equal(observation.create, "accepted", "setup: the create was accepted");
  const pageHops = observation.hops.filter((entry) => entry.initiator === "page").map((entry) => [entry.path, entry.kind]);
  assert.deepEqual(pageHops, [
    [`${base}/x/checkout/`, "document"],
    [`${base}/x/intervening-history/`, "history"],
    [`${base}/x/pending-document/`, "history"],
  ], "both pushState hops are history hops; the cancelled request classifies neither");
  assert.equal(observation.post_order_seq, null, "no post-order navigation was observed");
  assertUnexercisedUrl(url, "attempt_incomplete", `${base}/x/pending-document/`);
});

// On checkout after the landing hop, once the create is accepted (the stub
// stays on the page), the page starts a main-frame navigation to the pending
// document, cancels it with window.stop() before any response (no document
// commits, the request fails net::ERR_ABORTED), then pushes the cancelled
// request's own URL with no hop in between. No document navigation follows.
const CANCELLED_THEN_PUSHED_SCRIPT = `<script>
(function () {
  if (!sessionStorage.getItem("stub-sdk:entered")) return;
  var search = location.search;
  var original = window.fetch;
  window.fetch = function (input, init) {
    var answer = original.apply(this, arguments);
    if (init && init.method === "POST") {
      answer.then(function (response) {
        if (!response.ok) return;
        setTimeout(function () {
          location.href = "/x/pending-document/" + search;
          setTimeout(function () {
            window.stop();
            history.pushState({}, "", "/x/pending-document/" + search);
          }, 400);
        }, 100);
      }, function () {});
    }
    return answer;
  };
})();
</script>`;

browserTest("after the accepted create, a seeded document request cancelled (net::ERR_ABORTED) and then a pushState directly to its URL is a history hop, never the post-order navigation: URL row unexercised (attempt_incomplete)", T, async () => {
  const { installBrowserGuard, startTrackingStub, stubTopologies, BASE_ARGS } = await import("./qa-tracking-params-fixtures.mjs");
  await installBrowserGuard();
  const { runBrowserTestOrders } = await import("./qa-browser.mjs");
  const scenario = { direct: true, afterCreate: "stay", checkoutInline: CANCELLED_THEN_PUSHED_SCRIPT };
  const stub = await startTrackingStub(scenario);
  const front = await startPendingFront(stub);
  let result;
  try {
    const topologies = stubTopologies({ ...stub, base: front.base }, scenario);
    result = await runBrowserTestOrders(topologies, { ...BASE_ARGS, "step-timeout-ms": 12000 }, "qa-tracking-url-cancelled-pushed", {});
  } finally {
    await front.close();
    await stub.close();
  }
  const { log } = stub;
  const base = front.base;
  assert.deepEqual(documentPaths(log), ["/x/checkout/", "/x/landing/", "/x/checkout/"], "setup: no document after checkout committed");
  assert.equal(front.pending.length, 1, "setup: the pending document was requested once and never answered");
  assert.equal(log.creates.length, 1, "setup: one create was posted");
  assertSeeded(log, 3);
  for (const key of DEFAULT_URL_KEYS) assert.match(new URLSearchParams(front.pending[0]).get(key) || "", SEED_VALUE, `setup: the cancelled request carried the seed for ${key}`);
  await loadModule();
  const rows = await trackingRows(result, IDS);
  const url = rowOf(rows, URL_ID);
  const { observation } = url;
  assert.equal(observation.create, "accepted", "setup: the create was accepted");
  const pageHops = observation.hops.filter((entry) => entry.initiator === "page").map((entry) => [entry.path, entry.kind]);
  assert.deepEqual(pageHops, [
    [`${base}/x/checkout/`, "document"],
    [`${base}/x/pending-document/`, "history"],
  ], "the pushState to the cancelled request's URL is a history hop");
  assert.equal(observation.post_order_seq, null, "no post-order navigation was observed");
  assertUnexercisedUrl(url, "attempt_incomplete", `${base}/x/pending-document/`);
});
