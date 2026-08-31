import test from "node:test";
import assert from "node:assert/strict";

import {
  baseUrlWithoutSlug,
  probeOneUrl,
  probeRouteUrls,
  ROUTE_PROBE_MAX_URLS,
} from "./qa-route-probe.mjs";
import { __qaNodeTestHooks, qaResolveNextProofLines } from "./qa-node.mjs";

const { resolveRouteProbe, resolvePayload, resolveStatus } = __qaNodeTestHooks;

// The reproduction from #273, as data: a packet whose public_route_slug is
// "renewalift-device" pointed at a host that serves the same campaign under a
// different route root. Every derived route 404s; the host itself is alive.
const RENEWALIFT_BASE = "https://renewalift.netlify.app/renewalift-device/";
const RENEWALIFT_ROUTES = [
  "https://renewalift.netlify.app/renewalift-device/",
  "https://renewalift.netlify.app/renewalift-device/checkout/",
  "https://renewalift.netlify.app/renewalift-device/upsell/",
];

function fakeFetch(byUrl, { onRequest = null } = {}) {
  return async (url, options) => {
    onRequest?.(url, options);
    const entry = byUrl[url];
    if (entry === undefined) return { status: 404 };
    if (entry instanceof Error) throw entry;
    return { status: entry };
  };
}

function transportError(code = "ENOTFOUND") {
  const error = new Error("fetch failed");
  error.cause = { code };
  return error;
}

function resolvedFixture(overrides = {}) {
  return {
    mapId: "renewalift-device",
    specSource: "campaign-spec.json",
    specVersion: "4.3",
    specHash: "sha256:abc",
    baseUrl: RENEWALIFT_BASE,
    publicRouteSlug: "renewalift-device",
    spec: { campaign: { name: "RenewaLift", slug: "renewalift-device", ref_id: 42 } },
    checkpointGates: [
      { id: "page_kit.store_profile", status: "pass" },
      { id: "page_kit.sdk_version", status: "pass" },
      { id: "polish.hidden_eager_media", status: "pass" },
    ],
    themeGate: { status: "pass", code: "theme_gate.applied", reason: "ok" },
    polishGate: { status: "pass", code: "polish.evidence_current", reason: "ok" },
    topologies: RENEWALIFT_ROUTES.map((url, index) => ({
      funnel_id: `funnel-${index}`,
      funnel_name: `Funnel ${index}`,
      pages: [{ page_id: `presell-${index}`, page_type: "presell", label: "Presell", url }],
    })),
    ...overrides,
  };
}

test("#273 regression: a route set that is 100% dead never reports ready", async () => {
  // The host is alive at its root; only the packet's slug root is dead.
  const probe = await resolveRouteProbe(resolvedFixture(), {}, {
    fetchImpl: fakeFetch({ "https://renewalift.netlify.app/": 200 }),
  });

  assert.equal(probe.status, "failed");
  assert.equal(probe.code, "route_probe.routes_unresolved");
  assert.equal(probe.counts.unresolved, 3);
  assert.equal(probe.counts.resolved, 0);
  // The status must name the FIRST URL that failed, not just a count.
  assert.equal(probe.first_failure.url, RENEWALIFT_ROUTES[0]);
  assert.equal(probe.first_failure.http_status, 404);
  assert.match(probe.reason, /First failure: https:\/\/renewalift\.netlify\.app\/renewalift-device\/ \(HTTP 404\)/);

  const payload = resolvePayload(resolvedFixture(), { routeProbe: probe });
  assert.equal(payload.status, "routes_unresolved");
  assert.equal(payload.ok, false);
  assert.equal(payload.route_probe.code, "route_probe.routes_unresolved");

  // The printed next command was the misleading half: `qa run` against these
  // URLs cannot succeed, so resolve must stop suggesting it.
  const lines = qaResolveNextProofLines(payload).join("\n");
  assert.doesNotMatch(lines, /campaigns-os qa run/);
  assert.match(lines, /Next expected proof: none/);
});

test("#273 regression: a dead slug root on a live host names the route-root mismatch", async () => {
  const probe = await resolveRouteProbe(resolvedFixture(), {}, {
    fetchImpl: fakeFetch({ "https://renewalift.netlify.app/": 200 }),
  });

  assert.equal(probe.route_root_hint.code, "route_probe.route_root_mismatch");
  assert.equal(probe.route_root_hint.probed_url, "https://renewalift.netlify.app/");
  // resolve appends public_route_slug on purpose — the packet is the authority
  // on where the campaign is served — so the remedy names the packet, never a
  // different --base-url.
  assert.match(probe.route_root_hint.reason, /public_route_slug "renewalift-device"/);
  assert.match(probe.route_root_hint.reason, /correct campaign\.public_route_slug/i);
  assert.match(probe.route_root_hint.reason, /not to pass a different --base-url/);

  const payload = resolvePayload(resolvedFixture(), { routeProbe: probe });
  assert.match(qaResolveNextProofLines(payload).join("\n"), /Correct campaign\.public_route_slug/);
});

test("a dead preview reports the host as dead too, rather than blaming the slug", async () => {
  const probe = await resolveRouteProbe(resolvedFixture(), {}, {
    fetchImpl: fakeFetch({}),
  });

  assert.equal(probe.status, "failed");
  assert.equal(probe.route_root_hint.code, "route_probe.host_also_dead");
  assert.match(probe.route_root_hint.reason, /the preview itself is likely dead/);
});

test("offline degrades to a named not-probed state instead of failing or claiming ready", async () => {
  const probe = await resolveRouteProbe(resolvedFixture(), {}, {
    fetchImpl: async () => { throw transportError("ENOTFOUND"); },
  });

  assert.equal(probe.status, "not_probed");
  assert.equal(probe.code, "route_probe.unreachable");
  assert.equal(probe.counts.unreachable, 3);
  assert.match(probe.reason, /evidence about this machine's network, not about the deployment/);
  // No route-root hint: nothing was learned about the deployment at all.
  assert.equal(probe.route_root_hint, null);

  const payload = resolvePayload(resolvedFixture(), { routeProbe: probe });
  assert.equal(payload.status, "ready_unprobed");
  // Usable offline: ready_unprobed is not a failure.
  assert.equal(payload.ok, true);
  assert.match(qaResolveNextProofLines(payload).join("\n"), /campaigns-os qa run/);
});

test("a timeout is a transport failure, not a dead route", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const probe = await probeRouteUrls({
    entryUrls: RENEWALIFT_ROUTES,
    baseUrl: RENEWALIFT_BASE,
    publicRouteSlug: "renewalift-device",
    timeoutMs: 1234,
    fetchImpl: async () => { throw timeout; },
  });

  assert.equal(probe.status, "not_probed");
  assert.equal(probe.code, "route_probe.unreachable");
  assert.match(probe.first_failure.error, /no response within 1234ms/);
});

test("--no-probe skips the network entirely and still degrades to not_probed", async () => {
  let requests = 0;
  const probe = await resolveRouteProbe(resolvedFixture(), { "no-probe": true }, {
    fetchImpl: async () => { requests += 1; return { status: 200 }; },
  });

  assert.equal(requests, 0);
  assert.equal(probe.status, "not_probed");
  assert.equal(probe.code, "route_probe.disabled");
  assert.match(probe.reason, /--no-probe/);
  assert.equal(resolvePayload(resolvedFixture(), { routeProbe: probe }).status, "ready_unprobed");
});

test("a blocked checkpoint keeps its own status and spends no network", async () => {
  let requests = 0;
  const resolved = resolvedFixture({
    checkpointGates: [{ id: "page_kit.store_profile", status: "blocked", code: "x", reason: "y" }],
  });
  const probe = await resolveRouteProbe(resolved, {}, {
    fetchImpl: async () => { requests += 1; return { status: 200 }; },
  });

  assert.equal(requests, 0);
  assert.equal(probe.status, "not_probed");
  assert.match(probe.reason, /a checkpoint gate blocks this run/);
  assert.equal(resolvePayload(resolved, { routeProbe: probe }).status, "blocked");
});

test("a live route set keeps reporting ready, now over probed evidence", async () => {
  const probe = await resolveRouteProbe(resolvedFixture(), {}, {
    fetchImpl: fakeFetch(Object.fromEntries(RENEWALIFT_ROUTES.map((url) => [url, 200]))),
  });

  assert.equal(probe.status, "pass");
  assert.equal(probe.code, "route_probe.all_resolved");
  assert.equal(probe.counts.resolved, 3);

  const payload = resolvePayload(resolvedFixture(), { routeProbe: probe });
  assert.equal(payload.status, "ready");
  assert.equal(payload.ok, true);
});

test("no derived entry URLs is the pre-existing empty-URL guard, not a new failure", async () => {
  const probe = await resolveRouteProbe(resolvedFixture({ topologies: [], baseUrl: null }), {}, {
    fetchImpl: async () => { throw new Error("must not be called"); },
  });

  assert.equal(probe.code, "route_probe.no_routes");
  // no_routes is the one not_probed code that does NOT move the status: an
  // empty Entry URL list already has its own operator guidance.
  assert.equal(resolvePayload(resolvedFixture({ topologies: [] }), { routeProbe: probe }).status, "ready");
});

test("a partially dead route set fails and reports both halves", async () => {
  const probe = await probeRouteUrls({
    entryUrls: RENEWALIFT_ROUTES,
    baseUrl: RENEWALIFT_BASE,
    publicRouteSlug: "renewalift-device",
    fetchImpl: fakeFetch({ [RENEWALIFT_ROUTES[0]]: 200, [RENEWALIFT_ROUTES[1]]: 500 }),
  });

  assert.equal(probe.status, "failed");
  assert.equal(probe.counts.resolved, 1);
  assert.equal(probe.counts.unresolved, 2);
  assert.equal(probe.first_failure.http_status, 500);
  assert.match(probe.reason, /2 of 3 derived entry URL\(s\) are dead/);
  // A host that answers on one route is not a route-root mismatch.
  assert.equal(probe.route_root_hint, null);
});

test("a host that refuses HEAD is answering about the method, so the probe retries with GET", async () => {
  const methods = [];
  const probe = await probeOneUrl("https://host.test/x/", {
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return { status: methods.length === 1 ? 405 : 200 };
    },
  });

  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.equal(probe.outcome, "resolved");
  assert.equal(probe.method, "GET");
});

test("probing is bounded, and anything past the cap is reported as skipped", async () => {
  const urls = Array.from({ length: ROUTE_PROBE_MAX_URLS + 3 }, (_v, i) => `https://host.test/p${i}/`);
  let requests = 0;
  const probe = await probeRouteUrls({
    entryUrls: urls,
    fetchImpl: async () => { requests += 1; return { status: 200 }; },
  });

  assert.equal(requests, ROUTE_PROBE_MAX_URLS);
  assert.equal(probe.counts.skipped, 3);
  assert.equal(probe.results.length, urls.length);
});

test("baseUrlWithoutSlug strips only the packet's own slug segment", () => {
  assert.equal(baseUrlWithoutSlug(RENEWALIFT_BASE, "renewalift-device"), "https://renewalift.netlify.app/");
  assert.equal(
    baseUrlWithoutSlug("https://host.test/renewalift/renewalift-device/", "renewalift-device"),
    "https://host.test/renewalift/",
  );
  assert.equal(baseUrlWithoutSlug("https://host.test/other/", "renewalift-device"), null);
  assert.equal(baseUrlWithoutSlug(RENEWALIFT_BASE, ""), null);
  assert.equal(baseUrlWithoutSlug(null, "slug"), null);
});

test("the status ladder orders by how much of the deployment was verified", () => {
  const at = (routeProbe, extra = {}) => resolveStatus({
    hasBlockedCheckpoint: false,
    hasCheckpointWarning: false,
    ...extra,
    routeProbe,
  });

  assert.equal(at({ status: "failed" }, { hasBlockedCheckpoint: true }), "blocked");
  assert.equal(at({ status: "failed" }, { hasCheckpointWarning: true }), "routes_unresolved");
  assert.equal(at({ status: "not_probed", code: "route_probe.disabled" }, { hasCheckpointWarning: true }), "ready_unprobed");
  assert.equal(at({ status: "pass" }, { hasCheckpointWarning: true }), "ready_with_exceptions");
  assert.equal(at({ status: "pass" }), "ready");
  // No probe result at all (a caller that never probed) keeps the old ladder.
  assert.equal(at(null), "ready");
});

test("first_failure is the first URL in DERIVED order, not the first response to land", async () => {
  // Workers complete out of order on purpose: the last URL answers instantly
  // and the first answers slowest. `first_failure` must still be the first
  // entry URL, because that is the one an operator matches against the Entry
  // URLs list printed a few lines above it.
  const delayByUrl = { [RENEWALIFT_ROUTES[0]]: 30, [RENEWALIFT_ROUTES[1]]: 15, [RENEWALIFT_ROUTES[2]]: 0 };
  const completionOrder = [];
  const probe = await probeRouteUrls({
    entryUrls: RENEWALIFT_ROUTES,
    baseUrl: RENEWALIFT_BASE,
    publicRouteSlug: "renewalift-device",
    fetchImpl: async (url) => {
      await new Promise((resolve) => setTimeout(resolve, delayByUrl[url]));
      completionOrder.push(url);
      return { status: 404 };
    },
  });

  assert.deepEqual(
    completionOrder.slice(0, RENEWALIFT_ROUTES.length),
    [...RENEWALIFT_ROUTES].reverse(),
    "fixture must complete out of order",
  );
  assert.deepEqual(probe.results.map((result) => result.url), RENEWALIFT_ROUTES);
  assert.equal(probe.first_failure.url, RENEWALIFT_ROUTES[0]);
});

test("a pass reached over unreachable URLs reports which one, not just a count", async () => {
  const probe = await probeRouteUrls({
    entryUrls: RENEWALIFT_ROUTES,
    baseUrl: RENEWALIFT_BASE,
    publicRouteSlug: "renewalift-device",
    fetchImpl: async (url) => {
      if (url === RENEWALIFT_ROUTES[0]) return { status: 200 };
      throw transportError("ECONNRESET");
    },
  });

  assert.equal(probe.status, "pass");
  assert.equal(probe.counts.resolved, 1);
  assert.equal(probe.counts.unreachable, 2);
  // The structured field means the same thing on every branch: the first
  // result that did not cleanly resolve.
  assert.equal(probe.first_failure.url, RENEWALIFT_ROUTES[1]);
  assert.equal(probe.first_failure.outcome, "unreachable");
  assert.match(probe.reason, /First unreached: .*ECONNRESET/);
  // Partial reachability is not a route-root question.
  assert.equal(probe.route_root_hint, null);
  assert.equal(resolvePayload(resolvedFixture(), { routeProbe: probe }).status, "ready");
});

test("only --no-probe disables probing; there is no undocumented --probe flag", async () => {
  const live = fakeFetch(Object.fromEntries(RENEWALIFT_ROUTES.map((url) => [url, 200])));
  for (const args of [{}, { probe: "false" }, { probe: false }]) {
    const probe = await resolveRouteProbe(resolvedFixture(), args, { fetchImpl: live });
    assert.equal(probe.status, "pass", `args ${JSON.stringify(args)} must not disable probing`);
  }
  const disabled = await resolveRouteProbe(resolvedFixture(), { "no-probe": true }, { fetchImpl: live });
  assert.equal(disabled.code, "route_probe.disabled");
});
