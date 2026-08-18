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

const { resolveCampaignRouteRoot, resolveAnalyticsCaptureTarget, buildAnalyticsCaptureTarget } = __qaNodeTestHooks;

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

// KILO #194/1873: a declared route_root QA cannot honour (multi-segment, or
// foreign) still falls back to the slug default — that is doctor parity and
// stays. What changed is that the fallback is no longer SILENT: the discard is
// recorded, so a campaign actually served at "/x/offer/" leaves a trace in the
// evidence instead of QA quietly auditing "/x/".
test("route root: a declared root QA cannot honour is discarded LOUDLY, not silently", () => {
  for (const declared of ["/x/offer/", "/x/offer", "/other/", "/deep/nested/path/"]) {
    const notes = [];
    const resolved = resolveCampaignRouteRoot({
      packet: { campaign: { public_route_slug: "x", route_root: declared } },
      publicRouteSlug: "x",
      notes,
    });
    // Behaviour is unchanged: slug default, exactly like doctor.
    assert.equal(resolved, "/x/", `${declared} must still fall back to the slug default`);
    // But the discard is now recorded.
    assert.equal(notes.length, 1, `${declared} must record exactly one discard note`);
    assert.equal(notes[0].code, "route_root.declared_discarded");
    assert.equal(notes[0].declared, declared.trim());
    assert.equal(notes[0].resolved, "/x/");
    assert.match(notes[0].reason, /auditing the wrong page/);
  }
});

test("route root: the shapes QA CAN honour record no discard note", () => {
  for (const declared of ["/", "/x/", "/x"]) {
    const notes = [];
    resolveCampaignRouteRoot({
      packet: { campaign: { public_route_slug: "x", route_root: declared } },
      publicRouteSlug: "x",
      notes,
    });
    assert.equal(notes.length, 0, `${declared} is honourable and must not record a discard`);
  }
  // Absent declaration is the clean default, not a discard.
  const notes = [];
  resolveCampaignRouteRoot({ publicRouteSlug: "x", notes });
  assert.equal(notes.length, 0);
});

test("route root: the discard note rides onto the capture target", () => {
  const notes = [];
  const routeRoot = resolveCampaignRouteRoot({
    packet: { campaign: { public_route_slug: "x", route_root: "/x/offer/" } },
    publicRouteSlug: "x",
    notes,
  });
  const target = resolveAnalyticsCaptureTarget({
    inputBaseUrl: "https://host.example",
    publicRouteSlug: "x",
    routeRoot,
    routeRootNote: notes[0] || null,
  });
  assert.equal(target.route_root_note?.code, "route_root.declared_discarded");
  assert.equal(target.route_root_note?.declared, "/x/offer/");
  // The clean path carries an explicit null, not a missing key.
  const clean = resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example", publicRouteSlug: "x", routeRoot: "/x/" });
  assert.equal(clean.route_root_note, null);
});

// KILO #194/1903: root-served composition discards the operator base URL's
// path — and its query and fragment with it. That is deliberate: the capture
// target is the canonical page identity both analytics legs must agree on, so
// a debugging query must not ride into the parity comparison. Pinned so the
// choice is a contract rather than an accident of `new URL("/", base)`.
test("capture-target: root-served composition discards query and fragment with the path", () => {
  const target = resolveAnalyticsCaptureTarget({
    inputBaseUrl: "https://host.example/wrong-path?utm_source=qa&debug=1#frag",
    publicRouteSlug: "x",
    routeRoot: "/",
  });
  assert.equal(target.url, "https://host.example/");
  assert.equal(target.source, "resolved_identity:route_root");
  assert.ok(!target.url.includes("utm_source"), "operator debugging query must not reach the capture target");
  assert.ok(!target.url.includes("#"), "fragment must not reach the capture target");
});

// KILO #194/274: the capture-target shape is enforced by CONSTRUCTION. Every
// producer goes through buildAnalyticsCaptureTarget, so a new field cannot
// land on the identity-composed path and skip the built-site path.
test("capture-target: identity-composed and built-site targets share one shape by construction", () => {
  const composed = resolveAnalyticsCaptureTarget({ inputBaseUrl: "https://host.example", publicRouteSlug: "x", routeRoot: "/x/" });
  const builtSite = buildAnalyticsCaptureTarget({
    url: "https://host.example/",
    publicRouteSlug: "x",
    routeRoot: null,
    source: "built_site_base_url",
  });
  assert.deepEqual(
    Object.keys(composed).sort(),
    Object.keys(builtSite).sort(),
    "both producers must emit an identical key set — if this fails, one path grew a field the other did not",
  );
  for (const target of [composed, builtSite]) {
    assert.deepEqual(Object.keys(target).sort(), ["public_route_slug", "route_root", "route_root_note", "source", "url"]);
  }
});
