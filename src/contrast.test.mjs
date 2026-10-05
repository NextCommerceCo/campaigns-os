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

