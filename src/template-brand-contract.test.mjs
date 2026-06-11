import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findForbiddenPriceHides,
  forbiddenComputedColors,
  loadTemplateBrandContract,
  normalizeCssColor,
  TEMPLATE_BRAND_CONTRACT_SCHEMA,
} from "./template-brand-contract.mjs";

test("demeter contract loads and declares the starter defaults", () => {
  const contract = loadTemplateBrandContract("demeter");
  assert.equal(contract.schema_version, TEMPLATE_BRAND_CONTRACT_SCHEMA);
  assert.equal(contract.family, "demeter");
  assert.equal(contract.brand_tokens.forbidden_default_values["--brand--color--primary"], "#3c7dff");
  assert.equal(contract.brand_tokens.forbidden_default_values["--brand--color--primary-dark"], "#0a265c");
  assert.equal(contract.css_load_order.core_stylesheet, "next-core.css");
  assert.ok(contract.qa_inspection.computed_style_checks.length >= 3);
  assert.deepEqual(contract.pricing_surfaces.modes, ["full_price", "discounted", "compare_at", "unit_total", "unit_only"]);
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

test("findForbiddenPriceHides ignores price selectors without display:none", () => {
  const contract = loadTemplateBrandContract("demeter");
  assert.deepEqual(findForbiddenPriceHides(contract, ".price-wrapper { color: black; }"), []);
  assert.deepEqual(findForbiddenPriceHides(contract, ""), []);
  assert.deepEqual(findForbiddenPriceHides(contract, null), []);
});
