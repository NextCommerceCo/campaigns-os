import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  inferPageType,
  resolveBuiltSiteScope,
  synthesizeMinimalBuildPacket,
  topologiesFromBuiltSiteScope,
} from "./built-site-scope.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-built-site-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Lay out a page-kit-style built campaign: _site/<slug>/<route>/index.html.
function writeBuiltCampaign(repo, slug, routes) {
  for (const [route, html] of Object.entries(routes)) {
    const dir = route ? join(repo, "_site", slug, route) : join(repo, "_site", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
  }
}

test("inferPageType maps routes/filenames to funnel page types", () => {
  assert.equal(inferPageType(""), "landing");
  assert.equal(inferPageType("index"), "landing");
  assert.equal(inferPageType("checkout"), "checkout");
  assert.equal(inferPageType("upsell-1"), "upsell");
  assert.equal(inferPageType("oto1"), "upsell");
  assert.equal(inferPageType("downsell"), "downsell");
  assert.equal(inferPageType("down-sell-2"), "downsell");
  assert.equal(inferPageType("thank-you"), "receipt");
  assert.equal(inferPageType("order-complete"), "receipt");
  assert.equal(inferPageType("presell"), "presell");
  assert.equal(inferPageType("advertorial"), "presell");
  assert.equal(inferPageType("faq"), "page");
});

test("inferPageType resolves downsell before upsell", () => {
  // "downsell" contains neither "upsell"; this guards the ordering intent.
  assert.equal(inferPageType("downsell-offer"), "downsell");
  assert.equal(inferPageType("upsell-then-downsell"), "downsell");
});

test("resolveBuiltSiteScope enumerates a single-slug campaign and infers types", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "acme-launch", {
      "": "<h1>Landing</h1>",
      checkout: "<h1>Checkout</h1>",
      "upsell-1": "<h1>Upsell</h1>",
      "thank-you": "<h1>Thanks</h1>",
    });
    const scope = resolveBuiltSiteScope(repo);
    assert.equal(scope.ok, true);
    assert.equal(scope.slug, "acme-launch");
    assert.equal(scope.html_count, 4);
    const byRoute = Object.fromEntries(scope.pages.map((p) => [p.route, p.page_type]));
    assert.equal(byRoute[""], "landing");
    assert.equal(byRoute["checkout"], "checkout");
    assert.equal(byRoute["upsell-1"], "upsell");
    assert.equal(byRoute["thank-you"], "receipt");
    const landing = scope.pages.find((p) => p.route === "");
    assert.equal(landing.page_id, "index");
  });
});

test("resolveBuiltSiteScope errors with candidates when multiple slugs exist", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "campaign-a", { "": "<h1>A</h1>" });
    writeBuiltCampaign(repo, "campaign-b", { "": "<h1>B</h1>" });
    const scope = resolveBuiltSiteScope(repo);
    assert.equal(scope.ok, false);
    assert.match(scope.error, /pass --slug/);
    assert.deepEqual(scope.slug_candidates.sort(), ["campaign-a", "campaign-b"]);

    const chosen = resolveBuiltSiteScope(repo, { slug: "campaign-b" });
    assert.equal(chosen.ok, true);
    assert.equal(chosen.slug, "campaign-b");
  });
});

test("resolveBuiltSiteScope errors cleanly on a missing or empty campaign", () => {
  assert.equal(resolveBuiltSiteScope("/no/such/path").ok, false);
  withTempDir((repo) => {
    mkdirSync(join(repo, "_site", "empty"), { recursive: true });
    const scope = resolveBuiltSiteScope(repo, { slug: "empty" });
    assert.equal(scope.ok, false);
    assert.match(scope.error, /No built HTML pages/);
  });
});

test("resolveBuiltSiteScope treats a direct campaign directory as the campaign root", () => {
  withTempDir((campaignDir) => {
    mkdirSync(join(campaignDir, "checkout"), { recursive: true });
    writeFileSync(join(campaignDir, "checkout", "index.html"), "<h1>Checkout</h1>");
    const scope = resolveBuiltSiteScope(campaignDir);
    assert.equal(scope.ok, true);
    assert.equal(scope.slug, "");
    assert.equal(scope.campaign_dir, campaignDir);
    assert.equal(scope.pages.length, 1);
    assert.equal(scope.pages[0].route, "checkout");
    assert.equal(scope.pages[0].page_type, "checkout");

    const [topology] = topologiesFromBuiltSiteScope(scope, "http://localhost:8080");
    assert.equal(topology.topology_id, "campaign");
    assert.equal(topology.pages[0].url, "http://localhost:8080/checkout/");
  });
});

test("resolveBuiltSiteScope ignores includes/layouts and dotfiles", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "acme", { "": "<h1>Landing</h1>", checkout: "<h1>Checkout</h1>" });
    const includes = join(repo, "_site", "acme", "_includes");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(includes, "head.html"), "<meta>");
    const scope = resolveBuiltSiteScope(repo, { slug: "acme" });
    assert.equal(scope.html_count, 2);
    assert.equal(scope.pages.some((p) => p.route.includes("_includes")), false);
  });
});

test("topologiesFromBuiltSiteScope builds fetchable URLs per route", () => {
  const scope = {
    slug: "acme",
    pages: [
      { page_id: "index", page_type: "landing", route: "" },
      { page_id: "checkout", page_type: "checkout", route: "checkout" },
    ],
  };
  const [topology] = topologiesFromBuiltSiteScope(scope, "http://localhost:8080/");
  assert.equal(topology.topology_id, "acme");
  assert.equal(topology.pages[0].url, "http://localhost:8080/");
  assert.equal(topology.pages[1].url, "http://localhost:8080/checkout/");
  assert.equal(topology.pages[1].page_type, "checkout");
});

test("topologiesFromBuiltSiteScope throws on an empty base URL (no silently-unfetchable topology)", () => {
  const scope = { slug: "acme", pages: [{ page_id: "index", page_type: "landing", route: "" }] };
  assert.throws(() => topologiesFromBuiltSiteScope(scope, ""), /base URL/);
  assert.throws(() => topologiesFromBuiltSiteScope(scope, null), /base URL/);
});

test("synthesizeMinimalBuildPacket marks itself synthetic and points at the built output", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "acme", { "": "<h1>Landing</h1>", checkout: "<h1>Checkout</h1>" });
    const scope = resolveBuiltSiteScope(repo, { slug: "acme" });
    const packet = synthesizeMinimalBuildPacket({
      schemaVersion: "campaign-runtime-build-packet/v0",
      targetRepo: repo,
      scope,
      family: "olympus",
      baseUrl: "http://localhost:8080/",
    });
    assert.equal(packet.schema_version, "campaign-runtime-build-packet/v0");
    assert.equal(packet._synthesized.from, "built_site");
    assert.equal(packet.campaign.public_route_slug, "acme");
    assert.equal(packet.assembly.template_family, "olympus");
    assert.equal(packet.assembly.output_dir, "_site/acme");
    assert.equal(packet.deploy.preview_url, "http://localhost:8080/");
    assert.equal(packet.qa.test_orders_allowed, false);
    assert.equal(packet.pages.length, 2);
  });
});
