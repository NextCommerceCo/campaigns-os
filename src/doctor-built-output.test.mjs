import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  collectPageKitAssetPathViolations,
  validateBuiltDemoAssetFidelity,
  validateBuiltPageKitAssetPaths,
  validateBuiltBumpPricing,
  validateBuiltPlaceholderTextResidue,
  validateBuiltPreCheckoutBootstrap,
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

// --- H3.1: doctor warns on literal placeholder TEXT in built output ---

const TEXT_RESIDUE_CONTRACT = {
  qa_inspection: { placeholder_text_residue: { terms: ["Lorem", "Product Name", "TODO", "Placeholder"] } },
};

test("H3.1 doctor: built placeholder text warns and names the surviving terms", () => {
  withTempDir((dir) => {
    const target = join(dir, "_site", SLUG);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), "<h1>Product Name</h1><p>Lorem ipsum dolor.</p>");
    const warnings = [];
    const ready = [];
    validateBuiltPlaceholderTextResidue(TEXT_RESIDUE_CONTRACT, warnings, ready, { target_output_dir: target });
    assert.ok(codes(warnings).includes("template_contract.placeholder_text_residue"));
    const msg = warnings.find((w) => w.code === "template_contract.placeholder_text_residue").message;
    assert.match(msg, /Product Name/);
    assert.match(msg, /Lorem/);
  });
});

test("H3.1 doctor: clean built output yields a ready line, no warning", () => {
  withTempDir((dir) => {
    const target = join(dir, "_site", SLUG);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), "<h1>Cold Brew Concentrate</h1><p>Smooth, low-acid coffee.</p>");
    const warnings = [];
    const ready = [];
    validateBuiltPlaceholderTextResidue(TEXT_RESIDUE_CONTRACT, warnings, ready, { target_output_dir: target });
    assert.equal(codes(warnings).includes("template_contract.placeholder_text_residue"), false);
    assert.ok(ready.some((note) => note.includes("no literal template placeholder text")));
  });
});

test("H3.1 doctor: includes/layouts are skipped, no contract terms is a no-op", () => {
  withTempDir((dir) => {
    const target = join(dir, "_site", SLUG);
    mkdirSync(join(target, "_includes"), { recursive: true });
    writeFileSync(join(target, "_includes", "head.html"), "<!-- TODO Lorem Product Name -->");
    const warnings = [];
    const ready = [];
    validateBuiltPlaceholderTextResidue(TEXT_RESIDUE_CONTRACT, warnings, ready, { target_output_dir: target });
    assert.equal(codes(warnings).includes("template_contract.placeholder_text_residue"), false);

    // No declared terms -> validator is inert (no warning, no ready line).
    const w2 = [];
    const r2 = [];
    validateBuiltPlaceholderTextResidue({}, w2, r2, { target_output_dir: target });
    assert.equal(w2.length, 0);
    assert.equal(r2.length, 0);
  });
});

// --- H3.2: doctor warns when the family's demo assets survive into built output ---

const DEMO_ASSET_CONTRACT = { demo_assets: { assets: ["images/1x1_1.svg", "images/1x1_2.svg"] } };

test("H3.2 doctor: surviving demo assets warn and prompt a re-skin", () => {
  withTempDir((dir) => {
    const target = join(dir, "_site", SLUG);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), '<img src="/c/images/1x1_1.svg"><img src="/c/images/hero.jpg">');
    const warnings = [];
    const ready = [];
    validateBuiltDemoAssetFidelity(DEMO_ASSET_CONTRACT, warnings, ready, { target_output_dir: target });
    assert.ok(codes(warnings).includes("template_contract.demo_asset_residue"));
    assert.match(warnings[0].message, /1x1_1\.svg/);
    assert.match(warnings[0].message, /Re-skin/);
  });
});

test("H3.2 doctor: no demo-asset references yields a ready line", () => {
  withTempDir((dir) => {
    const target = join(dir, "_site", SLUG);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), '<img src="/c/images/hero.jpg">');
    const warnings = [];
    const ready = [];
    validateBuiltDemoAssetFidelity(DEMO_ASSET_CONTRACT, warnings, ready, { target_output_dir: target });
    assert.equal(codes(warnings).includes("template_contract.demo_asset_residue"), false);
    assert.ok(ready.some((note) => note.includes("no template demo placeholder assets")));
  });
});

const PRESELL_PAGE = { id: "presell", type: "presell" };
const BOOTSTRAP = `
  <script src="/c/config.js"></script>
  <meta name="next-funnel" content="demo">
  <meta name="next-page-type" content="product">
  <script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.4.2/dist/loader.js" type="module"></script>
`;

test("A1 pre-checkout bootstrap: presell missing loader + page-type meta is flagged", () => {
  const issues = [];
  const content = `<html><head></head><body><div data-next-hide="param.banner=='n'">Banner</div></body></html>`;
  validateBuiltPreCheckoutBootstrap(content, "/repo/_site/c/index.html", "/repo", PRESELL_PAGE, issues);
  assert.equal(codes(issues).includes("built_output.pre_checkout_sdk_bootstrap"), true);
  assert.equal(issues[0].detail.missing.loader, true);
  assert.equal(issues[0].detail.missing.page_type_meta, true);
  assert.match(issues[0].message, /utmTransfer/);
});

test("A1 pre-checkout bootstrap: fully bootstrapped presell passes", () => {
  const issues = [];
  validateBuiltPreCheckoutBootstrap(`<html><head>${BOOTSTRAP}</head><body></body></html>`, "/repo/_site/c/index.html", "/repo", PRESELL_PAGE, issues);
  assert.equal(issues.length, 0);
});

test("A1 pre-checkout bootstrap: landing with loader but no page-type meta is flagged for the meta only", () => {
  const issues = [];
  const content = `<html><head><script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.4.2/dist/loader.js" type="module"></script></head><body></body></html>`;
  validateBuiltPreCheckoutBootstrap(content, "/repo/_site/c/lp/index.html", "/repo", { id: "landing", type: "landing" }, issues);
  assert.equal(codes(issues).includes("built_output.pre_checkout_sdk_bootstrap"), true);
  assert.equal(issues[0].detail.missing.loader, false);
  assert.equal(issues[0].detail.missing.page_type_meta, true);
});

test("A1 pre-checkout bootstrap: checkout/upsell pages are out of scope", () => {
  const issues = [];
  const bare = `<html><head></head><body>Checkout</body></html>`;
  validateBuiltPreCheckoutBootstrap(bare, "/repo/_site/c/checkout/index.html", "/repo", { id: "checkout", type: "checkout" }, issues);
  validateBuiltPreCheckoutBootstrap(bare, "/repo/_site/c/up1/index.html", "/repo", { id: "up1", type: "upsell" }, issues);
  assert.equal(issues.length, 0);
});

const PER_UNIT_ROW = `<div class="bump__price-row"><span data-next-toggle-display="originalUnitPrice">--</span><span data-next-toggle-display="unitPrice">--</span>/ea</div>`;
const LINE_TOTAL_ROW = `<div class="bump__price-row"><span data-next-toggle-display="originalPrice">--</span><span data-next-toggle-display="price">--</span></div>`;
const bump = (rows) => `<div data-component="prepurchase-upsell" data-variant="check01"><div class="bump__price">${rows}</div></div>`;
const CHECKOUT_PAGE = { id: "checkout", type: "checkout" };

test("B2 bump pricing: a bump rendering both per-unit and line-total rows is flagged", () => {
  const issues = [];
  validateBuiltBumpPricing(bump(PER_UNIT_ROW + LINE_TOTAL_ROW), "/repo/_site/c/checkout/index.html", "/repo", CHECKOUT_PAGE, issues);
  assert.equal(codes(issues).includes("built_output.bump_double_price"), true);
  assert.equal(issues[0].detail.doubled_bumps, 1);
});

test("B2 bump pricing: a single per-unit-only bump passes", () => {
  const issues = [];
  validateBuiltBumpPricing(bump(PER_UNIT_ROW), "/repo/_site/c/checkout/index.html", "/repo", CHECKOUT_PAGE, issues);
  assert.equal(issues.length, 0);
});

test("B2 bump pricing: two bumps, one doubled, counts only the doubled one", () => {
  const issues = [];
  validateBuiltBumpPricing(bump(PER_UNIT_ROW) + bump(PER_UNIT_ROW + LINE_TOTAL_ROW), "/repo/_site/c/checkout/index.html", "/repo", CHECKOUT_PAGE, issues);
  assert.equal(issues[0].detail.doubled_bumps, 1);
});

test("B2 bump pricing: non-checkout pages and bump-free pages are no-ops", () => {
  const issues = [];
  validateBuiltBumpPricing(bump(PER_UNIT_ROW + LINE_TOTAL_ROW), "/repo/_site/c/up1/index.html", "/repo", { id: "up1", type: "upsell" }, issues);
  validateBuiltBumpPricing(`<div class="checkout"></div>`, "/repo/_site/c/checkout/index.html", "/repo", CHECKOUT_PAGE, issues);
  assert.equal(issues.length, 0);
});
