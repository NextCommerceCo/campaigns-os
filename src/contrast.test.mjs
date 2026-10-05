// F2.4 frozen fixture rows for the shared contrast helper (contract 2.4
// "Shared helper src/contrast.mjs", "Element measurement (frozen)"; Code plan
// "Tests": parser table, vm self-containment, predicates).
//
// The helper does not exist at BASE_SHA, so every row imports it dynamically
// inside its own body and fails on its own ("module not found").
//
// API assumptions (every row; the helper interface shapes the contract
// leaves open):
// - src/contrast.mjs exports one factory, contrastToolkit(), returning a
//   plain object of the helper functions plus version "contrast/v1";
// - parseComputedColor(str) → {space, coords:[c1,c2,c3], alpha} or
//   {unparseable: str}; toSrgb(color) → {rgb, alpha, gamut_clipped};
//   isLargeText({fontSizePx, fontWeight}), requiredRatio(isLarge),
//   meetsRequirement(ratio, required);
// - deriveElementMeasurement({fg_raw, fill_raw, bg_layers_raw, font_size_px,
//   font_weight}) → {fg_srgb, bg_srgb, gamut_clipped, ratio, size_class,
//   required, review_reason}, review_reason set only by trigger 9.
//
// Setup ratios are computed here from the WCAG 2.x definitions
// (src/readability-harness.test.mjs), never by the helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach } from "node:test";

// The no-network guard is installed by this import, before any module under
// test loads; every test then checks that no request was attempted.
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";
import { buildDocument, hexToSrgb, ratioOf } from "./readability-harness.test.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const TABLE = JSON.parse(readFileSync(new URL("../fixtures/readability/chromium-153-color-serialization.json", import.meta.url), "utf8"));

async function toolkit() {
  const { contrastToolkit } = await import("./contrast.mjs");
  assert.equal(typeof contrastToolkit, "function", "src/contrast.mjs exports the contrastToolkit factory");
  return contrastToolkit();
}

// The 3.44 pair of F2.4-W3/W5/B4: #fff on #e0662b, unrounded.
const RATIO_344 = ratioOf(hexToSrgb("#ffffff"), hexToSrgb("#e0662b"));

test("F2.4-W1 parser table of pinned Chromium 153 serialization strings (all six forms, none, / alpha): parsed values equal the frozen table", async () => {
  const kit = await toolkit();
  // (setup, not the row's assertion) the table covers all six forms, none
  // and / alpha.
  const serialized = TABLE.rows.map((row) => row.serialized);
  for (const form of ["rgb(", "rgba(", "color(", "lab(", "lch(", "oklab(", "oklch("]) {
    assert.ok(serialized.some((text) => text.startsWith(form)), `setup: the table holds a ${form}…) string`);
  }
  assert.ok(serialized.some((text) => / none[ )]/.test(text)), "setup: the table holds a none component");
  assert.ok(serialized.some((text) => text.includes(" / ")), "setup: the table holds a / alpha");
  const parsed = TABLE.rows.map((row) => ({ serialized: row.serialized, value: kit.parseComputedColor(row.serialized) }));
  assert.deepEqual(parsed, TABLE.rows.map((row) => ({ serialized: row.serialized, value: row.expected })), "every serialization parses to its frozen entry");
  const refused = TABLE.unparseable.map((text) => kit.parseComputedColor(text));
  assert.deepEqual(refused, TABLE.unparseable.map((text) => ({ unparseable: text })), "a syntax outside the closed list is unparseable");
});

test("F2.4-W5 helper with 18.66px/700 at 3.44: pass", async () => {
  const kit = await toolkit();
  assert.ok(RATIO_344 > 3.43 && RATIO_344 < 3.45, `setup: the pair is 3.44:1 (${RATIO_344})`);
  const large = kit.isLargeText({ fontSizePx: 18.66, fontWeight: 700 });
  assert.equal(large, true, "18.66px/700 is large text");
  assert.equal(kit.requiredRatio(large), 3, "large text requires 3:1");
  assert.equal(kit.meetsRequirement(RATIO_344, kit.requiredRatio(large)), true, "pass: 3.44 meets the large-text requirement");
});

test("F2.4-W17 contrastToolkit.toString() evaluated in an empty vm context: every function callable (no ReferenceError)", async () => {
  const { contrastToolkit } = await import("./contrast.mjs");
  const vm = await import("node:vm");
  const context = vm.createContext({});
  const kit = vm.runInContext(`(${contrastToolkit.toString()})()`, context);
  const names = Object.keys(kit).filter((name) => typeof kit[name] === "function").sort();
  // (setup, not the row's assertion) every contract and card function is
  // present, so "every function" is not an empty set.
  for (const name of ["parseComputedColor", "toSrgb", "relativeLuminance", "contrastRatio", "compositeOver", "isLargeText", "requiredRatio", "meetsRequirement", "displayRatio", "measureTextElement", "documentMeasurability", "deriveElementMeasurement", "isTextBearing"]) {
    assert.ok(names.includes(name), `setup: the vm-built toolkit has ${name}`);
  }
  assert.equal(kit.version, "contrast/v1", "setup: the vm-built toolkit carries its version");

  // Representative arguments; the DOM functions get an in-memory page (the
  // element under test is an add-to-cart label, #fff on #0080aa).
  const page = buildDocument({
    body: [{ tag: "button", key: "label", attrs: { "data-next-action": "add-to-cart", type: "button" }, text: "Buy now", style: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(0, 128, 170)", display: "inline-block" } }],
  });
  const label = page.byKey.label;
  const parsed = kit.parseComputedColor("rgb(255, 255, 255)");
  const args = {
    parseComputedColor: ["oklch(0.7 none 150 / 0.5)"],
    toSrgb: [parsed],
    relativeLuminance: [[0.5, 0.5, 0.5]],
    contrastRatio: [0.2, 0.1],
    compositeOver: [{ rgb: [1, 1, 1], alpha: 0.5 }, { rgb: [0, 0, 0], alpha: 1 }],
    isLargeText: [{ fontSizePx: 16, fontWeight: 400 }],
    requiredRatio: [false],
    meetsRequirement: [4.5, 4.5],
    displayRatio: [4.4986],
    deriveElementMeasurement: [{ fg_raw: "rgb(255, 255, 255)", fill_raw: "rgb(255, 255, 255)", bg_layers_raw: ["rgb(0, 128, 170)"], font_size_px: 16, font_weight: 400 }],
    isTextBearing: [label, page.window],
    measureTextElement: [label, page.window],
    documentMeasurability: [page.document],
  };
  const referenceErrors = [];
  for (const name of names) {
    try {
      const value = kit[name](...(args[name] || []));
      if (value && typeof value.then === "function") await value;
    } catch (error) {
      if (error?.name === "ReferenceError" || error?.constructor?.name === "ReferenceError") referenceErrors.push(`${name}: ${error.message}`);
    }
  }
  assert.deepEqual(referenceErrors, [], "every toolkit function runs from its source text with no ReferenceError");
});

test("F2.4-B4 helper with 18.65px/700 at 3.44: warning", async () => {
  const kit = await toolkit();
  assert.ok(RATIO_344 > 3.43 && RATIO_344 < 3.45, `setup: the pair is 3.44:1 (${RATIO_344})`);
  const large = kit.isLargeText({ fontSizePx: 18.65, fontWeight: 700 });
  assert.equal(large, false, "18.65px/700 is not large text");
  assert.equal(kit.requiredRatio(large), 4.5, "normal text requires 4.5:1");
  assert.equal(kit.meetsRequirement(RATIO_344, kit.requiredRatio(large)), false, "warning: 3.44 does not meet 4.5");
});

test("F2.4-I5 helper with oklch(0.7 0.4 150) foreground: gamut_clipped = true", async () => {
  const kit = await toolkit();
  const parsed = kit.parseComputedColor("oklch(0.7 0.4 150)");
  assert.deepEqual(parsed, { space: "oklch", coords: [0.7, 0.4, 150], alpha: 1 }, "setup: the foreground parses");
  assert.equal(kit.toSrgb(parsed).gamut_clipped, true, "toSrgb clips it and says so");
  const measured = kit.deriveElementMeasurement({ fg_raw: "oklch(0.7 0.4 150)", fill_raw: "oklch(0.7 0.4 150)", bg_layers_raw: ["rgb(255, 255, 255)"], font_size_px: 16, font_weight: 400 });
  assert.equal(measured.gamut_clipped, true, "the element measurement carries gamut_clipped = true");
});

test("F2.4-I6 helper with color(foo 1 2 3): review / unparseable_color", async () => {
  const kit = await toolkit();
  assert.deepEqual(kit.parseComputedColor("color(foo 1 2 3)"), { unparseable: "color(foo 1 2 3)" }, "the colour is unparseable");
  const measured = kit.deriveElementMeasurement({ fg_raw: "color(foo 1 2 3)", fill_raw: "color(foo 1 2 3)", bg_layers_raw: ["rgb(255, 255, 255)"], font_size_px: 16, font_weight: 400 });
  assert.equal(measured.review_reason, "unparseable_color", "review / unparseable_color");
});

test("F2.4-I46 helper with color rgb(255, 255, 255) and -webkit-text-fill-color color(foo 1 2 3): review / unparseable_color", async () => {
  const kit = await toolkit();
  assert.deepEqual(kit.parseComputedColor("rgb(255, 255, 255)"), { space: "rgb", coords: [255, 255, 255], alpha: 1 }, "setup: color itself parses");
  const measured = kit.deriveElementMeasurement({ fg_raw: "rgb(255, 255, 255)", fill_raw: "color(foo 1 2 3)", bg_layers_raw: ["rgb(0, 0, 0)"], font_size_px: 16, font_weight: 400 });
  assert.equal(measured.review_reason, "unparseable_color", "an unparseable text fill is review / unparseable_color even when color parses");
});

// ---------------------------------------------------------------------------
// Helper unit tests

test("src/contrast.mjs holds one exported factory and nothing else at module scope", async () => {
  const { contrastToolkit } = await import("./contrast.mjs");
  const source = readFileSync(new URL("./contrast.mjs", import.meta.url), "utf8");
  assert.equal(source.replace(/^(\/\/.*\n)*/, ""), `export ${contrastToolkit.toString()}\n`);
});

test("relative luminance with the 0.04045 knee equals the 0.03928-knee formula on every 8-bit value", async () => {
  const kit = await toolkit();
  for (let value = 0; value < 256; value += 1) {
    const c = value / 255;
    const legacy = 0.2126 * (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    assert.ok(Math.abs(kit.relativeLuminance([c, 0, 0]) - legacy) <= 1e-15, `${value}: ${kit.relativeLuminance([c, 0, 0])} vs ${legacy}`);
  }
});

test("large text is 24px, or 18.66px at weight 700; semibold and 18.65px are not", async () => {
  const kit = await toolkit();
  const cases = [[18.66, 700, true], [18.6667, 700, true], [24, 400, true], [18.65, 700, false], [18.6667, 600, false], [18.66, 699, false], [23.99, 400, false]];
  assert.deepEqual(cases.map(([fontSizePx, fontWeight]) => kit.isLargeText({ fontSizePx, fontWeight })), cases.map(([, , large]) => large));
});

test("deriveElementMeasurement composites translucent layers and compares the unrounded ratio", async () => {
  const kit = await toolkit();
  const derive = (fg_raw, bg_layers_raw, fill_raw = fg_raw) => kit.deriveElementMeasurement({ fg_raw, fill_raw, bg_layers_raw, font_size_px: 16, font_weight: 400 });

  const b1 = derive("rgb(255, 255, 255)", ["rgb(0, 128, 170)"]);
  assert.ok(Math.abs(b1.ratio - ratioOf(hexToSrgb("#ffffff"), hexToSrgb("#0080aa"))) < 1e-12 && b1.ratio < 4.5, `4.4986 unrounded (${b1.ratio})`);
  assert.equal(kit.meetsRequirement(b1.ratio, b1.required), false);
  assert.equal(kit.displayRatio(b1.ratio), 4.5, "only the display value is rounded");

  const b8 = derive("rgb(255, 255, 255)", ["rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)"]);
  assert.deepEqual(b8.bg_srgb, [0.5, 0.5, 0.5], "half-black over white, not 8-bit quantized");
  assert.ok(Math.abs(b8.ratio - ratioOf([1, 1, 1], [0.5, 0.5, 0.5])) < 1e-12, `luminance of the exact composite (${b8.ratio})`);

  assert.deepEqual(derive("rgba(255, 255, 255, 0.3)", ["rgb(0, 0, 0)"]).fg_srgb, [0.3, 0.3, 0.3], "the foreground alpha is composited");
  assert.ok(derive("rgb(0, 0, 0)", ["rgb(0, 0, 0)"], "rgb(255, 255, 255)").ratio > 20.99, "a text fill that differs from color is the foreground");

  const translucent = derive("rgb(0, 0, 0)", ["rgba(0, 0, 0, 0.5)"]);
  assert.deepEqual([translucent.fg_srgb, translucent.bg_srgb, translucent.ratio, translucent.review_reason], [null, null, null, null], "no opaque layer, no ratio");
  assert.equal(derive("rgb(0, 0, 0)", ["color(foo 1 2 3)", "rgb(255, 255, 255)"]).review_reason, "unparseable_color", "an unparseable traversed background");
});

test("measureTextElement in an in-memory page: transparent backgrounds end at the default canvas, or at canvas_unknown in a dark scheme", async () => {
  const { contrastToolkit } = await import("./contrast.mjs");
  const { vmPage } = await import("./readability-harness.test.mjs");
  const measureIn = (rootStyle) => {
    const page = vmPage({ rootStyle, body: [{ tag: "p", key: "text", text: "Synthetic", style: { color: "rgb(17, 17, 17)" } }] });
    // What crosses the page boundary: a serialized copy of the page's value.
    return JSON.parse(JSON.stringify(page.run(`(${contrastToolkit.toString()})()`).measureTextElement(page.byKey.text, page.window)));
  };
  const light = measureIn({});
  assert.equal(light.selector_path, "html>body>p:nth-of-type(1)");
  assert.deepEqual(light.bg_layers_raw, ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"]);
  assert.equal(light.review_reason, null);
  const kit = await toolkit();
  const { review_reason, ...derived } = kit.deriveElementMeasurement(light);
  assert.deepEqual(derived, Object.fromEntries(Object.keys(derived).map((field) => [field, light[field]])), "the stored fields re-derive from the raw fields alone");

  const dark = measureIn({ colorScheme: "dark" });
  assert.deepEqual([dark.review_reason, dark.ratio], ["canvas_unknown", null]);
});

test("documentMeasurability reads sdk_not_ready, then styles_incomplete, then fonts_pending", async () => {
  const kit = await toolkit();
  const reading = ({ bodyAttrs = {}, sheet = {}, fonts = "loaded", script = null }) => {
    const page = buildDocument({ bodyAttrs, head: [{ tag: "link", attrs: { rel: "stylesheet", href: "/site.css" }, sheet }, ...(script ? [{ tag: "script", attrs: { src: script } }] : [])] });
    page.document.fonts.status = fonts;
    return kit.documentMeasurability(page.document);
  };
  assert.deepEqual(reading({ bodyAttrs: { "data-next-sdk-loading": "true" }, sheet: null, fonts: "loading" }), { measurable: false, reason: "sdk_not_ready" });
  assert.deepEqual(reading({ script: "https://cdn.example.invalid/npm/@next-commerce/campaign-cart@0.4.38/dist/loader.js" }), { measurable: false, reason: "sdk_not_ready" });
  assert.deepEqual(reading({ bodyAttrs: { "data-next-sdk-loading": "false" }, sheet: null, fonts: "loading" }), { measurable: false, reason: "styles_incomplete" });
  assert.deepEqual(reading({ fonts: "loading" }), { measurable: false, reason: "fonts_pending" });
  assert.deepEqual(reading({ script: "https://cdn.example.invalid/vendor/loader.js" }), { measurable: true });
});

test("the SDK signals restated inside the factory match their source constants", async () => {
  const { contrastToolkit } = await import("./contrast.mjs");
  const { SDK_DATA_NEXT_ATTRIBUTES } = await import("./sdk-attribute-index.mjs");
  const factory = contrastToolkit.toString();
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const loader = "/campaign-cart(?:@[^\"']*)?\\/dist\\/loader\\.js/i";
  assert.ok(source("./doctor/checks.mjs").includes(loader) && factory.includes(loader), "the campaign-cart loader pattern");
  for (const signal of ["getAttribute(\"data-next-sdk-loading\") === \"false\"", "classList.contains(\"next-display-ready\")"]) {
    assert.ok(source("./qa-content-params.mjs").includes(signal) && factory.includes(signal), signal);
  }
  for (const name of ["data-next-loading", "data-next-sdk-loading"]) {
    assert.ok(SDK_DATA_NEXT_ATTRIBUTES.includes(name) && factory.includes(`"${name}"`), name);
  }
});

// Near-misses of each closed form: wrong arity, alpha where the form has none,
// commas or extra spaces where Chromium writes single separators, `none` in
// the comma form, units and percents, and number spellings Chromium never
// writes.
const COLOR_SPACES = ["srgb", "srgb-linear", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020", "xyz-d50", "xyz-d65"];
const NEAR_MISSES = [
  "rgb(0, 0, 0, 1)", "rgb(0, 0, 0, 0.5)", "rgb(0,0,0)", "rgb( 0, 0, 0)", "rgb(0, 0, 0 )", "rgb(0 , 0, 0)", "rgb(0,  0, 0)", "rgb(0, 0, 0 / 0.5)", "rgb(0%, 0%, 0%)", "rgb(none, 0, 0)", "rgb(+1, 0, 0)", "rgb(.5, 0, 0)", "rgb(1., 0, 0)", "RGB(0, 0, 0)",
  " rgb(0, 0, 0)", "rgb(0, 0, 0) ", "rgb(0, 0, 0)\n",
  "rgba(0, 0, 0)", "rgba(0, 0, 0, 0.5, 1)", "rgba(0,0,0,0.5)", "rgba(0, 0, 0,0.5)", "rgba(0, 0, 0 , 0.5)", "rgba(0, 0, 0 / 0.5)", "rgba(0, 0, 0, 50%)", "rgba(0, 0, 0, none)", "rgba(0, 0, 0, .5)",
  ...COLOR_SPACES.flatMap((space) => [`color(${space} 0.5 0.5)`, `color(${space} 0.5 0.5 0.5 0.5)`, `color(${space}  0.5 0.5 0.5)`, `color( ${space} 0.5 0.5 0.5)`, `color(${space} 0.5 0.5 0.5 )`, `color(${space} 0.5 0.5 0.5/0.5)`, `color(${space} 0.5 0.5 0.5 /0.5)`, `color(${space} 0.5 0.5 0.5 / 0.5 / 1)`, `color(${space} 50% 0.5 0.5)`, `color(${space}, 0.5, 0.5, 0.5)`, `color(${space} .5 0.5 0.5)`]),
  "color(xyz 0.2 0.3 0.4)", "color(srgb\t0.5 0.5 0.5)", "color(srgb 0.5 0.5 0.5 / )",
  "lab(50 20)", "lab(50 20 -30 0.5)", "lab(50, 20, -30)", "lab(50% 20 -30)", "lab(50 20 -30 )", "lab(50  20 -30)", "lab(50 20 -30/0.5)", "lab(+50 20 -30)",
  "lch(60 40)", "lch(60 40 120deg)", "lch(60 40 120 / 0.5 / 1)", "lch(60\t40 120)", "lch(60 40 120 /0.75)",
  "oklab(0.5 -0.1)", "oklab(0.5 -0.1 0.1 0.25)", "oklab(0.5 -0.1 0.1/0.25)", "oklab( 0.5 -0.1 0.1)", "oklab(0.5 1E-7 0.1)", "oklab(0.5 -.1 0.1)",
  "oklch(0.7 0.1)", "oklch(0.7 0.1 30 0.5)", "oklch(70% 0.1 30)", "oklch(0.7 0.1 30 / 50%)", "oklch(0.7 0.1 30 / 0.5 )", "oklch(.7 0.1 30)", "oklch(0.7 0.1 30.)",
];

test("the parser refuses near-misses of every closed form: arity, alpha placement, separators, none, units, number spelling and whitespace", async () => {
  const kit = await toolkit();
  const accepted = NEAR_MISSES.filter((text) => !("unparseable" in kit.parseComputedColor(text)));
  assert.deepEqual(accepted, [], "every near-miss is unparseable");
  assert.deepEqual(kit.parseComputedColor("rgb(0, 0, 0, 1)"), { unparseable: "rgb(0, 0, 0, 1)" });
  assert.deepEqual(kit.parseComputedColor("rgba(0, 0, 0)"), { unparseable: "rgba(0, 0, 0)" });
});

test("an rgba() background with three arguments is review / unparseable_color, never a ratio", async () => {
  const kit = await toolkit();
  const measured = kit.deriveElementMeasurement({ fg_raw: "rgb(255, 255, 255)", fill_raw: "rgb(255, 255, 255)", bg_layers_raw: ["rgba(0, 0, 0)"], font_size_px: 16, font_weight: 400 });
  assert.deepEqual([measured.review_reason, measured.ratio], ["unparseable_color", null]);
});

test("the parser accepts the number spellings Chromium 153 writes: exponents, negatives and none in every modern position", async () => {
  const kit = await toolkit();
  assert.deepEqual(kit.parseComputedColor("oklab(0.5 1.00000e-7 -0.0000123)"), { space: "oklab", coords: [0.5, 1e-7, -0.0000123], alpha: 1 });
  assert.deepEqual(kit.parseComputedColor("lab(50 1.23457e+8 -30)"), { space: "lab", coords: [50, 123457000, -30], alpha: 1 });
  assert.deepEqual(kit.parseComputedColor("oklch(0.5 0.1 30 / 1.00000e-7)"), { space: "oklch", coords: [0.5, 0.1, 30], alpha: 1e-7 });
  assert.deepEqual(kit.parseComputedColor("color(srgb none none none / none)"), { space: "srgb", coords: [0, 0, 0], alpha: 0 });
  assert.deepEqual(kit.parseComputedColor("rgba(0, 0, 0, 0.004)"), { space: "rgb", coords: [0, 0, 0], alpha: 0.004 });
});
