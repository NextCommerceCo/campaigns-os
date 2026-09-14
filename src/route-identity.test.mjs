import test from "node:test";
import assert from "node:assert/strict";

import {
  campaignRouteRoot,
  intakeRouteRoot,
  isAbsoluteHttpUrl,
  normalizePageKitRoute,
  normalizePublicRouteSlug,
  packetRouteRoot,
  resolveRouteRoot,
  runtimeRelativeRouteForSpecValue,
  stripPublicRoutePrefix,
} from "./route-identity.mjs";

test("isAbsoluteHttpUrl accepts http(s) URLs only", () => {
  assert.equal(isAbsoluteHttpUrl("https://x.example/a"), true);
  assert.equal(isAbsoluteHttpUrl("http://x.example"), true);
  for (const value of ["/checkout/", "checkout/", "mailto:a@b.c", "ftp://x.example", "", null, undefined, 42]) {
    assert.equal(isAbsoluteHttpUrl(value), false, JSON.stringify(value));
  }
});

test("normalizePublicRouteSlug is the slug as identity: trimmed, slash-free, empty when absent", () => {
  assert.equal(normalizePublicRouteSlug(" /theduo-v3/ "), "theduo-v3");
  assert.equal(normalizePublicRouteSlug("//x//"), "x");
  assert.equal(normalizePublicRouteSlug("x"), "x");
  for (const value of ["", "/", "  ", null, undefined, false, 0]) {
    assert.equal(normalizePublicRouteSlug(value), "", JSON.stringify(value));
  }
  // Case is identity too: the slug is a directory name and a served path.
  assert.equal(normalizePublicRouteSlug("/Slug/"), "Slug");
});

test("normalizePageKitRoute yields `<segments>/`, drops query, fragment and html suffixes, passes URLs through", () => {
  assert.equal(normalizePageKitRoute("/checkout/"), "checkout/");
  assert.equal(normalizePageKitRoute("checkout"), "checkout/");
  assert.equal(normalizePageKitRoute("/x/checkout/index.html"), "x/checkout/");
  assert.equal(normalizePageKitRoute("checkout.html"), "checkout/");
  assert.equal(normalizePageKitRoute("checkout/?utm=1#top"), "checkout/");
  assert.equal(normalizePageKitRoute("index.html"), "");
  assert.equal(normalizePageKitRoute("/"), "");
  assert.equal(normalizePageKitRoute(""), "");
  assert.equal(normalizePageKitRoute(null), "");
  assert.equal(normalizePageKitRoute("https://x.example/a?b#c"), "https://x.example/a?b#c");
});

test("stripPublicRoutePrefix removes exactly the slug prefix", () => {
  assert.equal(stripPublicRoutePrefix("x/checkout/", "x"), "checkout/");
  assert.equal(stripPublicRoutePrefix("/x/checkout", "/x/"), "checkout/");
  assert.equal(stripPublicRoutePrefix("x/", "x"), "");
  assert.equal(stripPublicRoutePrefix("x", "x"), "");
  // A different route, or a slug that is only a prefix of a segment, is untouched.
  assert.equal(stripPublicRoutePrefix("checkout/", "x"), "checkout/");
  assert.equal(stripPublicRoutePrefix("xy/checkout/", "x"), "xy/checkout/");
  // No slug, or no route: the normalized route (or "") comes back.
  assert.equal(stripPublicRoutePrefix("x/checkout/", ""), "x/checkout/");
  assert.equal(stripPublicRoutePrefix("", "x"), "");
  assert.equal(stripPublicRoutePrefix("https://x.example/x/checkout/", "x"), "https://x.example/x/checkout/");
});

test("runtimeRelativeRouteForSpecValue strips the slug and keeps the terminal segment of a nested value", () => {
  assert.equal(runtimeRelativeRouteForSpecValue("x/checkout/", "x"), "checkout/");
  assert.equal(runtimeRelativeRouteForSpecValue("/checkout", "x"), "checkout/");
  assert.equal(runtimeRelativeRouteForSpecValue("a/b/checkout/", "x"), "checkout/");
  assert.equal(runtimeRelativeRouteForSpecValue("x/", "x"), "");
  assert.equal(runtimeRelativeRouteForSpecValue("", "x"), "");
  // An absolute URL is not a spec route value; callers filter those first
  // (isAbsoluteHttpUrl) and this reduces whatever it is given to its terminal
  // segment.
  assert.equal(runtimeRelativeRouteForSpecValue("https://x.example/checkout/", "x"), "checkout/");
});

// The one acceptance rule for a packet: exactly "/" or exactly "/<slug>/".
test("packetRouteRoot honours the canonical form only", () => {
  assert.equal(packetRouteRoot("/", "x"), "/");
  assert.equal(packetRouteRoot("/x/", "x"), "/x/");
  assert.equal(packetRouteRoot(" /x/ ", "x"), "/x/", "surrounding whitespace is trimmed, as a JSON value is");
  // Every near miss the packet schema rejects is not honoured here either.
  for (const nearMiss of ["/x", "x/", "x", "//x//", "/X/", "/Slug/", "/x/offer/", "/other/", "/foo", "", "   "]) {
    assert.equal(packetRouteRoot(nearMiss, "x"), null, JSON.stringify(nearMiss));
  }
  for (const notAString of [null, undefined, 42, {}, ["/"]]) {
    assert.equal(packetRouteRoot(notAString, "x"), null, JSON.stringify(notAString));
  }
  // "/" is root-served whatever the slug; "/<slug>/" needs a slug to match.
  assert.equal(packetRouteRoot("/", ""), "/");
  assert.equal(packetRouteRoot("/x/", ""), null);
});

// The one intake rule for a spec: any spelling of the slug canonicalises.
test("intakeRouteRoot canonicalises any spelling of the slug and refuses a foreign prefix", () => {
  assert.equal(intakeRouteRoot("/", "x"), "/");
  for (const spelling of ["/x/", "/x", "x/", "x", "//x//", " /x/ "]) {
    assert.equal(intakeRouteRoot(spelling, "x"), "/x/", JSON.stringify(spelling));
  }
  for (const foreign of ["/other/", "/x/offer/", "/X/", "/deep/nested/", "/foo"]) {
    assert.equal(intakeRouteRoot(foreign, "x"), null, JSON.stringify(foreign));
  }
  assert.equal(intakeRouteRoot("", "x"), null);
  assert.equal(intakeRouteRoot(null, "x"), null);
  assert.equal(intakeRouteRoot("/x/", ""), null, "no slug: nothing but \"/\" can be honoured");
});

test("resolveRouteRoot reads the first declaration under its artifact's rule and says whether it was honoured", () => {
  // Packet, canonical: honoured.
  assert.deepEqual(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/" } } }),
    { route_root: "/", declared: "/", source: "packet", accepted: true });
  assert.deepEqual(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/x/" } } }),
    { route_root: "/x/", declared: "/x/", source: "packet", accepted: true });
  // Packet, hand-edited near miss: NOT honoured, default root, and the caller can see that.
  assert.deepEqual(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/x" } } }),
    { route_root: "/x/", declared: "/x", source: "packet", accepted: false });
  assert.deepEqual(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/other/" } } }),
    { route_root: "/x/", declared: "/other/", source: "packet", accepted: false });
  // Spec (intake): the lenient spelling is honoured; a foreign root is not.
  assert.deepEqual(resolveRouteRoot({ spec: { campaign: { route_root: "/x" } }, publicRouteSlug: "x" }),
    { route_root: "/x/", declared: "/x", source: "spec", accepted: true });
  assert.deepEqual(resolveRouteRoot({ spec: { spec_identity: { route_root: "/" } }, publicRouteSlug: "x" }),
    { route_root: "/", declared: "/", source: "spec", accepted: true });
  assert.deepEqual(resolveRouteRoot({ rawSpec: { spec_identity: { route_root: "/" } }, publicRouteSlug: "x" }),
    { route_root: "/", declared: "/", source: "raw_spec", accepted: true });
  assert.deepEqual(resolveRouteRoot({ rawSpec: { campaign: { route_root: "/other/" } }, publicRouteSlug: "x" }),
    { route_root: "/x/", declared: "/other/", source: "raw_spec", accepted: false });
  // The packet outranks the spec even when the packet's value is not honoured:
  // the packet is the authority once it exists.
  assert.deepEqual(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x", route_root: "/x" } }, spec: { campaign: { route_root: "/" } } }),
    { route_root: "/x/", declared: "/x", source: "packet", accepted: false });
  // An empty declaration is no declaration; the next source is read.
  assert.deepEqual(resolveRouteRoot({ spec: { spec_identity: { route_root: "" }, campaign: { route_root: "/" } }, publicRouteSlug: "x" }),
    { route_root: "/", declared: "/", source: "spec", accepted: true });
  // Nothing declared: the slug default, or null with no slug.
  assert.deepEqual(resolveRouteRoot({ publicRouteSlug: "x" }), { route_root: "/x/", declared: null, source: null, accepted: null });
  assert.deepEqual(resolveRouteRoot({ publicRouteSlug: null }), { route_root: null, declared: null, source: null, accepted: null });
  assert.deepEqual(resolveRouteRoot({}), { route_root: null, declared: null, source: null, accepted: null });
  // An explicit slug wins over the packet's own, so a caller that resolved the
  // slug from wider evidence (deploy path, spec) reads the root against it.
  assert.equal(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x" } }, publicRouteSlug: "y" }).route_root, "/y/");
  // Omitted means the packet's slug; an explicit null or "" means no slug.
  assert.equal(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x" } } }).route_root, "/x/");
  assert.equal(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x" } }, publicRouteSlug: undefined }).route_root, "/x/");
  assert.equal(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x" } }, publicRouteSlug: null }).route_root, null);
  assert.equal(resolveRouteRoot({ packet: { campaign: { public_route_slug: "x" } }, publicRouteSlug: "" }).route_root, null);
});

test("campaignRouteRoot is the packet's honoured root or the slug default", () => {
  assert.equal(campaignRouteRoot({ campaign: { public_route_slug: "ruggie", route_root: "/" } }), "/");
  assert.equal(campaignRouteRoot({ campaign: { public_route_slug: "ruggie", route_root: "/ruggie/" } }), "/ruggie/");
  assert.equal(campaignRouteRoot({ campaign: { public_route_slug: "ruggie" } }), "/ruggie/");
  for (const malformed of ["/foo", "/ruggie", "//ruggie//", "/Ruggie/", 42]) {
    assert.equal(campaignRouteRoot({ campaign: { public_route_slug: "ruggie", route_root: malformed } }), "/ruggie/", JSON.stringify(malformed));
  }
  assert.equal(campaignRouteRoot({ campaign: {} }), null);
  assert.equal(campaignRouteRoot(null), null);
});
