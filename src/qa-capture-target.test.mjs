// Packet 01 (qa-capture-target-and-purchase-waiver), capture-target commit.
// INV-2: any URL the analytics legs visit derives from the campaign's
// resolved identity — public_route_slug AND route_root — never from a raw
// operator argument. INV-3(c): the URL actually visited rides on EVERY
// emitted analytics assertion, pass and fail alike, top-level and in
// evidence. Composition mirrors doctor's route-root rule (#192): route_root
// "/" means the funnel lives at the SITE ROOT (slug stays identity, not a
// path prefix); the default "/<slug>/" keeps the slug-prefixed base.
import test from "node:test";
import assert from "node:assert/strict";

import { __qaNodeTestHooks } from "./qa-node.mjs";
import { assessAnalyticsCorrectness } from "./qa-analytics-correctness.mjs";
import { diffAnalyticsParity, normalizeCapture } from "./qa-analytics-parity.mjs";
import { STATUS } from "./qa-verdict.mjs";

const { resolveCampaignRouteRoot, resolveAnalyticsCaptureTarget } = __qaNodeTestHooks;

const CONTRACT = {
  providers: { gtm: { enabled: true, containerId: "GTM-ABC123" } },
  out_of_band_pixels: [{ vendor: "everflow", id: "ef-1" }, { vendor: "triplewhale" }],
  manual_events: [{ event: "dl_purchase", page: "receipt", trigger: "page-load" }],
};

function emptyCapture() {
  return normalizeCapture({ events: [], tagFires: [] });
}

function firingCapture() {
  return normalizeCapture({
    events: [{ layer: "dataLayer", data: { event: "dl_purchase", ecommerce: { value: 49.99, currency: "USD", transaction_id: "1043" } } }],
    tagFires: [
      { kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} },
      { kind: "everflow", id: "ef-1", host: "offers.everflow.io", params: {} },
    ],
  });
}

test("route root resolution mirrors doctor: canonical, lenient-spec, malformed, absent", () => {
  // Canonical packet declarations.
  assert.equal(resolveCampaignRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/" } }, publicRouteSlug: "x" }), "/");
  assert.equal(resolveCampaignRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/x/" } }, publicRouteSlug: "x" }), "/x/");
  // Lenient spec intake shapes (prepare-build canonicalizes "/x" to "/x/").
  assert.equal(resolveCampaignRouteRoot({ spec: { spec_identity: { route_root: "/" } }, publicRouteSlug: "x" }), "/");
  assert.equal(resolveCampaignRouteRoot({ spec: { campaign: { route_root: "/x" } }, publicRouteSlug: "x" }), "/x/");
  assert.equal(resolveCampaignRouteRoot({ rawSpec: { spec_identity: { route_root: "/" } }, publicRouteSlug: "x" }), "/");
  // A malformed/foreign declaration NEVER roots a capture — slug default, like doctor.
  assert.equal(resolveCampaignRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/other/" } }, publicRouteSlug: "x" }), "/x/");
  // Absent → slug-prefixed default; no slug at all → null.
  assert.equal(resolveCampaignRouteRoot({ publicRouteSlug: "x" }), "/x/");
  assert.equal(resolveCampaignRouteRoot({ publicRouteSlug: null }), null);
});

// CAPTURE-TARGET FIXTURE (packet 01 test 1): slug X, route_root "/", operator
// passes --base-url with a wrong path. The captured URL derives from X's
// resolved identity — root-served, so the stray path is discarded and the
// target is the site root, not a slug-prefixed path that does not exist.
test("capture-target fixture: root-served campaign discards the operator's wrong path", () => {
  const target = resolveAnalyticsCaptureTarget({
    inputBaseUrl: "https://host.example/wrong-path",
    publicRouteSlug: "x",
    routeRoot: "/",
  });
  assert.equal(target.url, "https://host.example/");
  assert.equal(target.route_root, "/");
  assert.equal(target.public_route_slug, "x");
  assert.equal(target.source, "resolved_identity:route_root");
});

test("capture-target fixture: the captured URL appears verbatim on every analytics-correctness:* assertion, pass and fail alike", () => {
  const url = resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example/wrong-path", publicRouteSlug: "x", routeRoot: "/" }).url;
  for (const capture of [emptyCapture(), firingCapture()]) {
    const assertions = assessAnalyticsCorrectness(capture, CONTRACT, { url });
    assert.ok(assertions.length >= 4);
    for (const a of assertions) {
      assert.ok(a.id.startsWith("analytics-correctness:"), a.id);
      assert.equal(a.url, url, `${a.id} (${a.status}) must carry the captured URL top-level`);
      assert.equal(a.evidence.url, url, `${a.id} (${a.status}) must carry the captured URL in evidence`);
    }
    // Both pass and fail statuses are represented across the two captures.
  }
  // The no-contract inventory path carries it too.
  const noContract = assessAnalyticsCorrectness(emptyCapture(), {}, { url });
  assert.equal(noContract[0].id, "analytics-correctness:no-contract");
  assert.equal(noContract[0].url, url);
  assert.equal(noContract[0].evidence.url, url);
});

test("capture-target fixture: the captured URL appears verbatim on every analytics-parity:* assertion, pass and fail alike", () => {
  const url = resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example/wrong-path", publicRouteSlug: "x", routeRoot: "/" }).url;
  const baseline = firingCapture();
  for (const candidate of [emptyCapture(), firingCapture()]) {
    const assertions = diffAnalyticsParity(baseline, candidate, { url });
    assert.ok(assertions.length >= 1);
    for (const a of assertions) {
      assert.ok(a.id.startsWith("analytics-parity:"), a.id);
      assert.equal(a.url, url, `${a.id} (${a.status}) must carry the captured URL top-level`);
      assert.equal(a.evidence.url, url, `${a.id} (${a.status}) must carry the captured URL in evidence`);
    }
  }
  const statuses = new Set(diffAnalyticsParity(baseline, firingCapture(), { url }).map((a) => a.status));
  assert.ok(statuses.has(STATUS.PASS), "pass assertions are stamped too");
});

// PATH-SERVED FIXTURE (packet 01 test 2): a non-root route_root must be
// composed into the target — guards against a fix that only handles the
// root case.
test("path-served fixture: non-root route_root composes the slug onto the base", () => {
  const target = resolveAnalyticsCaptureTarget({
    inputBaseUrl: "https://host.example/store",
    publicRouteSlug: "x",
    routeRoot: "/x/",
  });
  assert.equal(target.url, "https://host.example/store/x/");
  assert.ok(target.url.includes("/x/"), "composed URL includes the route root");
  assert.equal(target.source, "resolved_identity:public_route_slug");

  // A base already ending at the slug is not double-suffixed (normalizeQaBaseUrl semantics).
  assert.equal(
    resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example/x", publicRouteSlug: "x", routeRoot: "/x/" }).url,
    "https://host.example/x/",
  );

  // Default (undeclared) route_root behaves as the slug-prefixed root.
  assert.equal(
    resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example", publicRouteSlug: "x", routeRoot: null }).url,
    "https://host.example/x/",
  );
});

test("degenerate identities: no base URL yields no target; no slug and no route root falls back to the base URL", () => {
  const unresolved = resolveAnalyticsCaptureTarget({ inputBaseUrl: null, publicRouteSlug: "x", routeRoot: "/" });
  assert.equal(unresolved.url, null);
  assert.equal(unresolved.source, "unresolved");
  const bare = resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example/page", publicRouteSlug: null, routeRoot: null });
  assert.equal(bare.url, "https://host.example/page/");
  assert.equal(bare.source, "base_url");
});
