import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  demoAssetConfig,
  findForbiddenPriceHides,
  forbiddenComputedColors,
  loadTemplateBrandContract,
  normalizeCssColor,
  placeholderTextResidueConfig,
  placeholderTextResidueMatches,
  referencedDemoAssetBasenames,
  repeatedIconSrcs,
  summarizePlaceholderTerms,
  TEMPLATE_BRAND_CONTRACT_SCHEMA,
} from "./template-brand-contract.mjs";

test("demeter contract loads and declares the starter defaults", () => {
  const contract = loadTemplateBrandContract("demeter");
  assert.equal(contract.schema_version, TEMPLATE_BRAND_CONTRACT_SCHEMA);
  assert.equal(contract.family, "demeter");
  assert.equal(contract.extends, undefined);
  assert.equal(contract.brand_tokens.forbidden_default_values["--brand--color--primary"], "#3c7dff");
  assert.equal(contract.brand_tokens.forbidden_default_values["--brand--color--primary-dark"], "#0a265c");
  assert.equal(contract.css_load_order.core_stylesheet, "next-core.css");
  assert.ok(contract.qa_inspection.computed_style_checks.length >= 3);
  assert.deepEqual(contract.pricing_surfaces.modes, ["full_price", "compare_at_current", "unit_price_plus_total", "savings_badge_amount", "code_discounted_post_checkout"]);
  assert.equal(contract.pricing_surfaces.legacy_aliases.discounted, "compare_at_current");
  assert.equal(contract.family_inventory.bundle_picker.includes("Editorial tier selector"), true);
});

test("every catalog family has a loadable brand/residue/pricing contract and inventory matrix", () => {
  const catalog = JSON.parse(readFileSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), "utf8"));
  for (const family of Object.keys(catalog.families).sort()) {
    const contract = loadTemplateBrandContract(family);
    assert.ok(contract, `${family} should have a template brand contract`);
    assert.equal(contract.family, family);
    assert.equal(contract.brand_tokens.forbidden_default_values["--brand--color--primary"], "#3c7dff");
    assert.ok(contract.pricing_surfaces.forbidden_css_hides.includes(".price-wrapper"));
    for (const key of [
      "supported_pages",
      "required_sdk_anchors",
      "theme_insertion_point",
      "default_color_residue",
      "pricing_presentation",
      "bundle_picker",
      "order_bump",
      "upsell_downsell",
      "exit_pop",
      "qa_selectors",
    ]) {
      assert.ok(contract.family_inventory[key], `${family} family_inventory.${key} should be declared`);
    }
  }
});

test("non-Demeter families inherit residue and pricing rules", () => {
  const olympus = loadTemplateBrandContract("olympus");
  const limos = loadTemplateBrandContract("limos");
  assert.deepEqual(forbiddenComputedColors(olympus).map((color) => color.rgb), ["rgb(60, 125, 255)", "rgb(10, 38, 92)"]);
  assert.ok(findForbiddenPriceHides(olympus, ".price-display { display:none }").length === 1);
  assert.equal(limos.family_inventory.exit_pop.default_included, true);
  assert.deepEqual(limos.family_inventory.exit_pop.default_coupon_codes, ["EXIT10", "SAVE10"]);
});

test("unknown family returns null instead of throwing", () => {
  assert.equal(loadTemplateBrandContract("no-such-family"), null);
  assert.equal(loadTemplateBrandContract(null), null);
  assert.equal(loadTemplateBrandContract(""), null);
});

test("normalizeCssColor maps hex and rgb(a) into one comparable form", () => {
  assert.equal(normalizeCssColor("#3c7dff"), "rgb(60, 125, 255)");
  assert.equal(normalizeCssColor("#FFF"), "rgb(255, 255, 255)");
  assert.equal(normalizeCssColor("rgb(60, 125, 255)"), "rgb(60, 125, 255)");
  assert.equal(normalizeCssColor("rgba(60,125,255,0.9)"), "rgb(60, 125, 255)");
  assert.equal(normalizeCssColor("rgba(0,0,0,0)"), null, "fully transparent is not a visible color");
  assert.equal(normalizeCssColor("transparent"), null);
  assert.equal(normalizeCssColor(undefined), null);
});

test("forbiddenComputedColors normalizes the demeter palette", () => {
  const contract = loadTemplateBrandContract("demeter");
  const colors = forbiddenComputedColors(contract);
  assert.deepEqual(colors.map((color) => color.rgb), ["rgb(60, 125, 255)", "rgb(10, 38, 92)"]);
});

test("findForbiddenPriceHides flags the exact CSS hack from the dogfood run", () => {
  const contract = loadTemplateBrandContract("demeter");
  const css = `
.rr-hero { color: red; }
.rr-full-price .price-wrapper:first-child { display: none !important; }
.rr-badge { display: none; }
.price-display { font-weight: 600; }
`;
  const hits = findForbiddenPriceHides(contract, css);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].target, ".price-wrapper");
  assert.match(hits[0].selector, /rr-full-price/);
});

test("findForbiddenPriceHides sees through @media and @supports wrappers", () => {
  const contract = loadTemplateBrandContract("demeter");
  const css = `
@media (max-width: 768px) {
  .rr-mobile .price-wrapper { display: none !important; }
}
@supports (display: grid) {
  @media screen {
    .price-display { display:none }
  }
}
@media print { .rr-hero { color: black; } }
`;
  const hits = findForbiddenPriceHides(contract, css);
  assert.deepEqual(
    hits.map((hit) => hit.target).sort(),
    [".price-display", ".price-wrapper"],
    "at-rule nesting must not bypass the price-hide scan",
  );
});

test("findForbiddenPriceHides handles CSS nesting with parent selector context", () => {
  const contract = loadTemplateBrandContract("demeter");
  const css = `.rr-full-price { color: red; .price-wrapper { display: none; } }`;
  const hits = findForbiddenPriceHides(contract, css);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].target, ".price-wrapper");
  assert.match(hits[0].selector, /rr-full-price/);
});

test("findForbiddenPriceHides ignores comments and declaration-only at-rules", () => {
  const contract = loadTemplateBrandContract("demeter");
  const css = `
/* .price-wrapper { display: none; } */
@font-face { font-family: X; src: url(x.woff2); }
.price-wrapper { font-weight: 700; }
`;
  assert.deepEqual(findForbiddenPriceHides(contract, css), []);
});

test("normalizeCssColor treats near-invisible alpha as no visible color", () => {
  assert.equal(normalizeCssColor("rgba(60,125,255,0.01)"), null, "alpha hack reads as invisible, not as a pass");
  assert.equal(normalizeCssColor("rgba(60,125,255,0.5)"), "rgb(60, 125, 255)", "half-transparent starter blue still ships the palette");
});

test("findForbiddenPriceHides handles statement at-rules before a rule", () => {
  const contract = loadTemplateBrandContract("demeter");
  const css = `@charset "utf-8"; @import url(base.css); .price-wrapper { display: none; }`;
  const hits = findForbiddenPriceHides(contract, css);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].selector, ".price-wrapper");
});

test("findForbiddenPriceHides matches on CSS token boundaries, not substrings", () => {
  const contract = loadTemplateBrandContract("demeter");
  const css = `
.summary_price-row { display: none; }
.summary_price.cc-sm { display: none; }
`;
  const hits = findForbiddenPriceHides(contract, css);
  assert.deepEqual(hits.map((hit) => hit.selector), [".summary_price.cc-sm"], "longer identifiers must not substring-match a target");
});

test("findForbiddenPriceHides boundary handles compound, Unicode, and attribute selectors", () => {
  const fakeContract = (targets) => ({ pricing_surfaces: { forbidden_css_hides: targets } });
  // Compound selector: the leading "." may follow an ident char.
  assert.equal(findForbiddenPriceHides(fakeContract([".price-wrapper"]), "div.price-wrapper { display: none; }").length, 1);
  // Unicode identifier continuation: ".price" must not match inside ".priceΑ"
  // or ".price-événement" (code points >= U+0080 are CSS ident chars).
  assert.equal(findForbiddenPriceHides(fakeContract([".price"]), ".priceΑ { display: none; }").length, 0);
  assert.equal(findForbiddenPriceHides(fakeContract([".price"]), ".price-événement { display: none; }").length, 0);
  assert.equal(findForbiddenPriceHides(fakeContract([".price"]), ".price { display: none; }").length, 1);
  // Attribute selector targets are self-delimited by their brackets.
  assert.equal(
    findForbiddenPriceHides(fakeContract(["[data-next-display*='price']"]), ".x [data-next-display*='price'] { display: none; }").length,
    1,
  );
});

test("findForbiddenPriceHides ignores price selectors without display:none", () => {
  const contract = loadTemplateBrandContract("demeter");
  assert.deepEqual(findForbiddenPriceHides(contract, ".price-wrapper { color: black; }"), []);
  assert.deepEqual(findForbiddenPriceHides(contract, ""), []);
  assert.deepEqual(findForbiddenPriceHides(contract, null), []);
});

// --- H3.1: placeholder text-residue contract + matcher ---

test("placeholder text-residue terms are inherited by every family from shared-commerce", () => {
  const catalog = JSON.parse(readFileSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), "utf8"));
  for (const family of Object.keys(catalog.families)) {
    const config = placeholderTextResidueConfig(loadTemplateBrandContract(family));
    assert.ok(config, `${family} should inherit placeholder_text_residue`);
    for (const term of ["Lorem", "lorem ipsum", "Placeholder", "TODO", "Product Name"]) {
      assert.ok(config.terms.includes(term), `${family} terms should include "${term}"`);
    }
  }
});

test("placeholderTextResidueConfig returns null when no terms are declared", () => {
  assert.equal(placeholderTextResidueConfig(null), null);
  assert.equal(placeholderTextResidueConfig({}), null);
  assert.equal(placeholderTextResidueConfig({ qa_inspection: { placeholder_text_residue: { terms: [] } } }), null);
});

test("placeholderTextResidueMatches matches on word boundaries, case-insensitive, flexible phrase whitespace", () => {
  const terms = ["Lorem", "lorem ipsum", "Placeholder", "TODO", "Product Name"];
  const text = "Buy the Product   Name today. TODO: confirm. Lorem ipsum dolor. Placeholder copy.";
  const found = summarizePlaceholderTerms(placeholderTextResidueMatches(text, terms));
  assert.ok(found.includes("Product Name"), "collapsed multi-space phrase still matches");
  assert.ok(found.includes("TODO"));
  assert.ok(found.includes("Lorem"));
  assert.ok(found.includes("lorem ipsum"));
  assert.ok(found.includes("Placeholder"));
});

test("placeholderTextResidueMatches does not fire inside larger words (Loremaster, todos)", () => {
  assert.deepEqual(placeholderTextResidueMatches("Loremaster Industries makes todos lists", ["Lorem", "TODO"]), []);
  // real visible copy that merely contains the substring is safe
  assert.deepEqual(placeholderTextResidueMatches("Our Placeholders-brand stand mixer", ["Placeholder"]), []);
});

test("placeholderTextResidueMatches handles empty/missing input", () => {
  assert.deepEqual(placeholderTextResidueMatches("", ["Lorem"]), []);
  assert.deepEqual(placeholderTextResidueMatches("Lorem", []), []);
  assert.deepEqual(placeholderTextResidueMatches(null, ["Lorem"]), []);
});

// --- H3.2: demo-asset fidelity contract + detectors ---

test("arjuna declares its own demo-asset set and a repeated-icon selector", () => {
  const config = demoAssetConfig(loadTemplateBrandContract("arjuna"));
  assert.ok(config);
  assert.ok(config.assetBasenames.includes("1x1_1.svg"));
  assert.ok(config.assetBasenames.includes("benefit-icon.svg"));
  assert.ok(config.repeatedIcon.selector.length > 0);
  assert.equal(config.repeatedIcon.minRepeats, 3);
});

test("demoAssetConfig is null when neither assets nor a repeated-icon selector exist", () => {
  assert.equal(demoAssetConfig(null), null);
  assert.equal(demoAssetConfig({ demo_assets: { assets: [] } }), null);
  assert.equal(demoAssetConfig({ demo_assets: { repeated_icon: { min_repeats: 3 } } }), null, "selector is required");
});

test("referencedDemoAssetBasenames reports only basenames present in the HTML", () => {
  const html = '<img src="/c/images/1x1_1.svg"><img src="/c/images/hero.jpg">';
  assert.deepEqual(referencedDemoAssetBasenames(html, ["1x1_1.svg", "1x1_2.svg"]), ["1x1_1.svg"]);
  assert.deepEqual(referencedDemoAssetBasenames("", ["1x1_1.svg"]), []);
});

test("repeatedIconSrcs flags the four-identical-benefit-icons trap, not legitimate variety", () => {
  const trap = ["/i/icon.svg", "/i/icon.svg", "/i/icon.svg", "/i/icon.svg"];
  assert.deepEqual(repeatedIconSrcs(trap, 3), [{ src: "/i/icon.svg", count: 4 }]);
  const distinct = ["/i/a.svg", "/i/b.svg", "/i/c.svg", "/i/d.svg"];
  assert.deepEqual(repeatedIconSrcs(distinct, 3), []);
  // a pair below the threshold does not trip
  assert.deepEqual(repeatedIconSrcs(["/i/a.svg", "/i/a.svg"], 3), []);
});
