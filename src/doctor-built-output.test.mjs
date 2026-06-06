import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  collectPageKitAssetPathViolations,
  validateBuiltPageKitAssetPaths,
  validateMarketSensitiveCopy,
  validateSpecRoutingMetaTags,
} from "./cli.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-doctor-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SLUG = "test-campaign";
const ROUTING_SPEC = {
  funnel_pages: [
    { id: "upsell", type: "upsell", enabled: true, sdk_hints: { meta_tags: { "next-upsell-accept-url": "upsell" } } },
  ],
};
const PACKET = { campaign: { public_route_slug: SLUG } };
const codes = (issues) => issues.map((issue) => issue.code);

test("R2-B2 routing: unrooted spec literal warns when there is no built output", () => {
  const warnings = [];
  const ready = [];
  validateSpecRoutingMetaTags(ROUTING_SPEC, PACKET, warnings, ready);
  assert.ok(codes(warnings).includes("routing_meta.runtime_root"));
});

test("R2-B2 routing: defers to built output once assembly is complete and _site exists", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "_site", SLUG), { recursive: true });
    const warnings = [];
    const ready = [];
    const buildState = { report: { stages: { assembly: { status: "completed" } } } };
    validateSpecRoutingMetaTags(ROUTING_SPEC, PACKET, warnings, ready, { target_repo: dir }, buildState);
    assert.equal(codes(warnings).includes("routing_meta.runtime_root"), false);
    assert.ok(ready.some((note) => note.includes("deferred to built-output verification")));
  });
});

test("R2-B2 page-kit assets: detects unconverted /assets built references", () => {
  const hits = collectPageKitAssetPathViolations(`
    <script src="/assets/config.js"></script>
    <img src="/${SLUG}/assets/products/hero.png">
    <link href="/${SLUG}/css/brand.css" rel="stylesheet">
  `, SLUG);

  assert.deepEqual(hits.map((hit) => hit.reference), [
    "/assets/config.js",
    `/${SLUG}/assets/products/hero.png`,
  ]);
  assert.deepEqual(hits.map((hit) => hit.expected), [
    `/${SLUG}/config.js`,
    `/${SLUG}/products/hero.png`,
  ]);
});

test("R2-B2 page-kit assets: doctor explains campaign_asset repair for missing built references", () => {
  withTempDir((dir) => {
    const targetRepo = join(dir, "target");
    const builtPath = join(targetRepo, "_site", SLUG, "landing", "index.html");
    mkdirSync(dirname(builtPath), { recursive: true });

    const issues = [];
    validateBuiltPageKitAssetPaths(
      `
        <body data-next-page-type="landing">
          <script src="/assets/config.js"></script>
          <img src="/${SLUG}/assets/products/hero.png">
        </body>
      `,
      builtPath,
      targetRepo,
      { id: "landing" },
      SLUG,
      issues
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "built_output.pagekit_asset_path");
    assert.match(issues[0].message, /copies src\/test-campaign\/assets\/config\.js to "\/test-campaign\/config\.js"/);
    assert.match(issues[0].message, /campaign_asset/);
    assert.deepEqual(issues[0].detail.references.map((hit) => hit.expected), [
      `/${SLUG}/config.js`,
      `/${SLUG}/products/hero.png`,
    ]);
  });
});

function currencyDirs(dir, { sourceHasCurrency, targetHasCurrency }) {
  const source = join(dir, "source");
  const target = join(dir, "target");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, "index.html"), `<p>${sourceHasCurrency ? "$9.99" : "9,99 EUR"}</p>`);
  writeFileSync(join(target, "index.html"), `<p>${targetHasCurrency ? "$9.99" : "{{ price }}"}</p>`);
  return { source_root: source, target_output_dir: target };
}

const EUR_SPEC = { campaign: { currency: "EUR" } };

test("R2-B2 currency: source-only residue is info when built output is currency-clean", () => {
  withTempDir((dir) => {
    const derived = currencyDirs(dir, { sourceHasCurrency: true, targetHasCurrency: false });
    const warnings = [];
    const ready = [];
    validateMarketSensitiveCopy(EUR_SPEC, warnings, ready, derived);
    assert.equal(codes(warnings).includes("copy.hardcoded_currency_symbol"), false);
    assert.ok(ready.some((note) => note.includes("built output is currency-clean")));
  });
});

test("R2-B2 currency: still warns when the built output itself has hardcoded $", () => {
  withTempDir((dir) => {
    const derived = currencyDirs(dir, { sourceHasCurrency: true, targetHasCurrency: true });
    const warnings = [];
    const ready = [];
    validateMarketSensitiveCopy(EUR_SPEC, warnings, ready, derived);
    assert.ok(codes(warnings).includes("copy.hardcoded_currency_symbol"));
  });
});
