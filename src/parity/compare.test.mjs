// Stream P3 rows and the Appendix A.1 shared vectors for the element parity
// comparator. Every page is synthetic. The A.1 text and number functions are
// internal, so each vector is asserted through compareElementParity's output.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PARITY_COMPARATOR_VERSION, PARITY_PROBE_LIMITS, PARITY_TOLERANCES, compareElementParity, isProbeOutput,
} from "./compare.mjs";

// ---------------------------------------------------------------------------
// Fixtures (§10 P3 defaults).

const SELECTOR = (index) => `body>main>p:nth-of-type(${index + 1})`;
const el = (index, text, [x, y, w, h], extra = {}) => ({
  index, selector_path: SELECTOR(index), text, ftext: text, box: { x, y, w, h },
  font_family: "Synthetic Sans, sans-serif", font_size_px: 16, font_weight: 400, font_style: "normal",
  line_height: 24, letter_spacing: "normal", text_transform: "none",
  fg_srgb: [0.1, 0.1, 0.1], bg_srgb: [1, 1, 1], color_review: null, ...extra,
});
const inDesignOrder = (elements) => [...elements].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || a.index - b.index);
const COVERAGE = { elements_capped: false, time_capped: false, page_text_truncated: false, font_faces_capped: false, closed_shadow_roots: 0, frames_not_read: 0 };
const probe = (elements, { coverage = {}, ...extra } = {}) => ({
  viewport: { width: 1440, height: 1200 }, dpr: 1, elements,
  page_text: inDesignOrder(elements).map((e) => e.text).filter((t) => t !== "").join(" "),
  font_faces: [], coverage: { ...COVERAGE, ...coverage }, ...extra,
});

const TEXTS = ["Welcome heading", "Intro paragraph copy", "Feature one title", "Feature one detail", "Feature two title",
  "Feature two detail", "Price block copy", "Add to basket", "Guarantee statement", "Footer notice"];
// Ten elements in a column; `edit(index, element)` returns the element to use.
const ten = (edit = (i, e) => e) => TEXTS.map((text, i) => edit(i, el(i, text, [40, 40 + i * 80, 600, 40])));
const identity = (text, index, ordinal = 0) => ({ text, selector_path: SELECTOR(index), ordinal });
const member = (property, result, reason_code, design, build, delta) => ({ property, result, reason_code, design, build, delta });
const finding = (category, design, build, designIdentity, members) => ({ category, design, build, design_identity: designIdentity, members });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Every call runs on deep-frozen inputs (a mutation throws in module code) and
// checks the Rule 12 count identities.
function compare(design, build, options) {
  const result = compareElementParity(deepFreeze(design), deepFreeze(build), options === undefined ? undefined : deepFreeze(options));
  const c = result.counts;
  assert.equal(c.matched, result.pairs.length);
  assert.equal(c.matched, c.by_pass.exact_unique + c.by_pass.exact_nearest + c.by_pass.subtree + c.by_pass.fuzzy);
  if (result.status === "compared") {
    assert.equal(c.design, c.matched + c.unmatched_present + c.unmatched_missing + c.unmatched_unverified + c.below_min_chars);
  }
  return result;
}

const ZERO_COUNTS = { design: 0, build: 0, matched: 0, by_pass: { exact_unique: 0, exact_nearest: 0, subtree: 0, fuzzy: 0 },
  unmatched_present: 0, unmatched_missing: 0, unmatched_unverified: 0, below_min_chars: 0 };
const counts = (overrides) => ({ ...ZERO_COUNTS, ...overrides, by_pass: { ...ZERO_COUNTS.by_pass, ...overrides.by_pass } });
const invalidOutput = (invalid) => ({ comparator_version: PARITY_COMPARATOR_VERSION, status: "invalid_input", invalid,
  drift: { dx: 0, dy: 0, samples: 0 }, counts: ZERO_COUNTS, pairs: [], findings: [] });

// P3-B1 inputs: the hero badge row.
function heroBadgeRow() {
  const design = [
    el(0, "Synthetic headline", [40, 40, 600, 40]),
    el(1, "Badge one", [20, 547, 100, 40]), el(2, "Badge two", [140, 547, 100, 40]), el(3, "Badge three", [260, 547, 100, 40]),
    el(4, "Body copy after hero", [40, 619, 600, 24]),
    el(5, "Synthetic footer", [40, 700, 600, 24]),
  ];
  const build = [
    el(0, "Synthetic headline", [40, 40, 600, 40]),
    el(1, "Badge one", [20, 655, 100, 40]), el(2, "Badge two", [140, 655, 100, 40]), el(3, "Badge three", [260, 655, 100, 40]),
    el(4, "Body copy after hero", [40, 727, 600, 24]),
    el(5, "Synthetic footer", [40, 808, 600, 24]),
  ];
  return [probe(design), probe(build)];
}

// ---------------------------------------------------------------------------
// §10 P3 rows.

test("P3-W1: identical design and build compare with no findings", () => {
  const result = compare(probe(ten()), probe(ten()));
  assert.equal(result.comparator_version, "parity-compare/v1");
  assert.equal(result.status, "compared");
  assert.equal(result.invalid, null);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.drift, { dx: 0, dy: 0, samples: 10 });
  assert.deepEqual(result.counts, counts({ design: 10, build: 10, matched: 10, by_pass: { exact_unique: 10 } }));
  assert.deepEqual(result.pairs, TEXTS.map((_, i) => ({ design: i, build: i, via: "exact_unique", similarity: null })));
});

test("P3-B1: a badge row moved below the image reads one gap finding on the first badge", () => {
  const [design, build] = heroBadgeRow();
  assert.deepEqual(compare(design, build), {
    comparator_version: "parity-compare/v1",
    status: "compared",
    invalid: null,
    drift: { dx: 0, dy: 108, samples: 6 },
    counts: counts({ design: 6, build: 6, matched: 6, by_pass: { exact_unique: 6 } }),
    pairs: [0, 1, 2, 3, 4, 5].map((i) => ({ design: i, build: i, via: "exact_unique", similarity: null })),
    findings: [finding("geometry", 1, 1, identity("badge one", 1), [member("gap", "warning", "gap_differs", 467, 575, 108)])],
  });
});

test("P3-B2: a 2 px smaller heading reads one font_size warning", () => {
  const result = compare(probe(ten((i, e) => (i === 0 ? { ...e, font_size_px: 32 } : e))),
    probe(ten((i, e) => (i === 0 ? { ...e, font_size_px: 30 } : e))));
  assert.deepEqual(result.findings, [finding("typography", 0, 0, identity("welcome heading", 0),
    [member("font_size", "warning", "font_size_differs", 32, 30, -2)])]);
});

test("P3-W2: a 0.4 px font size difference is silent", () => {
  const result = compare(probe(ten((i, e) => (i === 0 ? { ...e, font_size_px: 32 } : e))),
    probe(ten((i, e) => (i === 0 ? { ...e, font_size_px: 32.4 } : e))));
  assert.equal(result.status, "compared");
  assert.deepEqual(result.findings, []);
});

test("P3-W3: a font size difference equal to the tolerance is silent (32.6 - 32 in IEEE doubles)", () => {
  assert.equal(32.6 - 32, 0.6000000000000014);
  const result = compare(probe(ten((i, e) => (i === 0 ? { ...e, font_size_px: 32 } : e))),
    probe(ten((i, e) => (i === 0 ? { ...e, font_size_px: 32.6 } : e))));
  assert.equal(result.status, "compared");
  assert.deepEqual(result.findings, []);
});

const b3Design = () => probe(ten((i, e) => (i === 0 ? { ...e, text: "Synthetic headline alpha", ftext: "Synthetic headline alpha" } : e)));
const b3Build = (extra) => probe(ten((i, e) => (i === 0 ? { ...e, text: "Template headline", ftext: "Template headline" } : e)), extra);

test("P3-B3: replaced copy absent from the build page reads copy_missing", () => {
  const build = b3Build();
  assert.ok(!build.page_text.toLowerCase().includes("synthetic headline alpha"));
  const result = compare(b3Design(), build);
  assert.deepEqual(result.findings, [finding("copy", 0, null, identity("synthetic headline alpha", 0),
    [member("copy", "warning", "copy_missing", "synthetic headline alpha", null, null)])]);
  assert.deepEqual(result.counts, counts({ design: 10, build: 10, matched: 9, by_pass: { exact_unique: 9 }, unmatched_missing: 1 }));
});

test("P3-W4: unmatched copy found in the build page text is present, not missing", () => {
  const design = probe([...ten(), el(10, "Free shipping today", [40, 900, 600, 40])]);
  const build = probe(ten());
  const result = compare(design, { ...build, page_text: `${build.page_text} Free shipping today` });
  assert.deepEqual(result.findings, []);
  assert.equal(result.counts.unmatched_present, 1);
  assert.deepEqual(result.counts, counts({ design: 11, build: 10, matched: 10, by_pass: { exact_unique: 10 }, unmatched_present: 1 }));
});

const i1Design = () => probe(ten((i, e) => (i === 0 ? { ...e, text: "Order now and save twenty percent", ftext: "Order now and save twenty percent" } : e)));
const i1Build = (extra) => probe(ten((i, e) => (i === 0 ? { ...e, text: "Order now and save 20 percent", ftext: "Order now and save 20 percent" } : e)), extra);

test("P3-I1: a fuzzy pair whose design text is off the build page reads copy_changed", () => {
  const result = compare(i1Design(), i1Build());
  assert.deepEqual(result.pairs[0], { design: 0, build: 0, via: "fuzzy", similarity: 0.71 });
  assert.deepEqual(result.findings, [finding("copy", 0, 0, identity("order now and save twenty percent", 0),
    [member("copy", "warning", "copy_changed", "order now and save twenty percent", "order now and save 20 percent", 0.71)])]);
  assert.deepEqual(result.counts.by_pass, { exact_unique: 9, exact_nearest: 0, subtree: 0, fuzzy: 1 });
});

test("P3-I2: unmatched copy with no candidate on a truncated build page reads review page_text_truncated", () => {
  const design = probe([...ten(), el(10, "Synthetic disclaimer line", [40, 900, 600, 40])]);
  const build = probe(ten(), { coverage: { page_text_truncated: true } });
  const result = compare(design, build);
  assert.deepEqual(result.findings, [finding("copy", 10, null, identity("synthetic disclaimer line", 10),
    [member("copy", "review", "page_text_truncated", "synthetic disclaimer line", null, null)])]);
  assert.deepEqual(result.counts, counts({ design: 11, build: 10, matched: 10, by_pass: { exact_unique: 10 }, unmatched_unverified: 1 }));
});

test("P3-I2b: a fuzzy pair on a truncated build page reads review page_text_truncated, not copy_changed", () => {
  const result = compare(i1Design(), i1Build({ coverage: { page_text_truncated: true } }));
  assert.deepEqual(result.pairs[0], { design: 0, build: 0, via: "fuzzy", similarity: 0.71 });
  assert.deepEqual(result.findings, [finding("copy", 0, 0, identity("order now and save twenty percent", 0),
    [member("copy", "review", "page_text_truncated", "order now and save twenty percent", "order now and save 20 percent", 0.71)])]);
});

test("P3-I2c: missing copy with an unread build frame reads review build_text_not_read", () => {
  const result = compare(b3Design(), b3Build({ coverage: { frames_not_read: 1 } }));
  assert.deepEqual(result.findings, [finding("copy", 0, null, identity("synthetic headline alpha", 0),
    [member("copy", "review", "build_text_not_read", "synthetic headline alpha", null, null)])]);
  assert.equal(result.counts.unmatched_unverified, 1);
  assert.equal(result.counts.unmatched_missing, 0);
});

const withBody = (fields) => ten((i, e) => (i === 1 ? { ...e, ...fields } : e));

test("P3-B4: a text colour 10 apart on one channel reads text_color_differs", () => {
  const result = compare(probe(withBody({ fg_srgb: [20 / 255, 20 / 255, 20 / 255] })), probe(withBody({ fg_srgb: [30 / 255, 20 / 255, 20 / 255] })));
  assert.deepEqual(result.findings, [finding("color", 1, 1, identity("intro paragraph copy", 1),
    [member("text_color", "warning", "text_color_differs", [20, 20, 20], [30, 20, 20], 10)])]);
});

test("P3-W5: a text colour 2 apart is silent", () => {
  const result = compare(probe(withBody({ fg_srgb: [20 / 255, 20 / 255, 20 / 255] })), probe(withBody({ fg_srgb: [22 / 255, 20 / 255, 20 / 255] })));
  assert.deepEqual(result.findings, []);
});

test("P3-B5: line height then letter spacing warnings, in member order", () => {
  const result = compare(probe(withBody({ letter_spacing: "normal", line_height: 24 })), probe(withBody({ letter_spacing: 0.5, line_height: 27 })));
  assert.deepEqual(result.findings, [finding("typography", 1, 1, identity("intro paragraph copy", 1), [
    member("line_height", "warning", "line_height_differs", 24, 27, 3),
    member("letter_spacing", "warning", "letter_spacing_differs", "normal", 0.5, 0.5),
  ])]);
});

test("P3-W6: letter spacing 0.1 and line height 1.5 apart are silent", () => {
  const result = compare(probe(withBody({ letter_spacing: "normal", line_height: 24 })), probe(withBody({ letter_spacing: 0.1, line_height: 25.5 })));
  assert.deepEqual(result.findings, []);
});

test("P3-I3: line height normal against a number reads review line_height_unresolved", () => {
  const result = compare(probe(withBody({ line_height: "normal" })), probe(withBody({ line_height: 24 })));
  assert.deepEqual(result.findings, [finding("typography", 1, 1, identity("intro paragraph copy", 1),
    [member("line_height", "review", "line_height_unresolved", "normal", 24, null)])]);
});

test("P3-B6: a top banner reads one gap finding on the first design element; the banner yields nothing", () => {
  const build = [el(10, "Synthetic banner", [0, 0, 1440, 80]),
    ...ten((i, e) => ({ ...e, box: { ...e.box, y: e.box.y + 80 } }))];
  const result = compare(probe(ten()), probe(build));
  assert.deepEqual(result.findings, [finding("geometry", 0, 0, identity("welcome heading", 0),
    [member("gap", "warning", "gap_differs", 40, 120, 80)])]);
  assert.deepEqual(result.drift, { dx: 0, dy: 80, samples: 10 });
  assert.deepEqual(result.counts, counts({ design: 10, build: 11, matched: 10, by_pass: { exact_unique: 10 } }));
});

test("P3-B7: a design web font loaded but errored on the build reads font_face_unavailable on every pair", () => {
  const design = probe(ten(), { font_faces: [{ family: "Synthetic Sans", status: "loaded" }] });
  const build = probe(ten(), { font_faces: [{ family: "Synthetic Sans", status: "error" }] });
  const result = compare(design, build);
  assert.deepEqual(result.findings, TEXTS.map((text, i) => finding("typography", i, i, identity(text.toLowerCase(), i),
    [member("font_face", "warning", "font_face_unavailable", "loaded", "error", null)])));
});

test("P3-I9: the face absent on a capped build font list reads review font_face_unverified", () => {
  const design = probe(ten(), { font_faces: [{ family: "Synthetic Sans", status: "loaded" }] });
  const faces = Array.from({ length: PARITY_PROBE_LIMITS.font_faces }, (_, i) => ({ family: `Other Face ${i}`, status: "loaded" }));
  const build = probe(ten(), { font_faces: faces, coverage: { font_faces_capped: true } });
  const result = compare(design, build);
  assert.deepEqual(result.findings, TEXTS.map((text, i) => finding("typography", i, i, identity(text.toLowerCase(), i),
    [member("font_face", "review", "font_face_unverified", "loaded", "absent", null)])));
});

const withFourth = (fields) => ten((i, e) => (i === 3 ? { ...e, box: { ...e.box, ...fields } } : e));

test("P3-B8: an element 10 px wider reads width_differs", () => {
  const result = compare(probe(ten()), probe(withFourth({ w: 610 })));
  assert.deepEqual(result.findings, [finding("geometry", 3, 3, identity("feature one detail", 3),
    [member("width", "warning", "width_differs", 600, 610, 10)])]);
});

test("P3-B8b: an element 10 px narrower reads a signed width delta", () => {
  const result = compare(probe(ten()), probe(withFourth({ w: 590 })));
  assert.deepEqual(result.findings, [finding("geometry", 3, 3, identity("feature one detail", 3),
    [member("width", "warning", "width_differs", 600, 590, -10)])]);
});

test("P3-B9: one element shifted right 20 px reads x_position_differs", () => {
  const result = compare(probe(ten()), probe(withFourth({ x: 60 })));
  assert.equal(result.drift.dx, 0);
  assert.deepEqual(result.findings, [finding("geometry", 3, 3, identity("feature one detail", 3),
    [member("x_position", "warning", "x_position_differs", 40, 60, 20)])]);
});

test("P3-B10: font weight 700 against 600 reads font_weight_differs", () => {
  const result = compare(probe(ten((i, e) => (i === 0 ? { ...e, font_weight: 700 } : e))),
    probe(ten((i, e) => (i === 0 ? { ...e, font_weight: 600 } : e))));
  assert.deepEqual(result.findings, [finding("typography", 0, 0, identity("welcome heading", 0),
    [member("font_weight", "warning", "font_weight_differs", 700, 600, -100)])]);
});

test("P3-B11: a quoted family with escaped quotes reads font_family_differs on the first families", () => {
  const result = compare(probe(ten((i, e) => (i === 0 ? { ...e, font_family: '"Synthetic \\"Sans\\"", serif' } : e))),
    probe(ten((i, e) => (i === 0 ? { ...e, font_family: "Synthetic Sans, serif" } : e))));
  assert.deepEqual(result.findings, [finding("typography", 0, 0, identity("welcome heading", 0),
    [member("font_family", "warning", "font_family_differs", 'synthetic "sans"', "synthetic sans", null)])]);
});

test("P3-I4: a different viewport reads viewport_mismatch with nothing compared", () => {
  const result = compare(probe(ten(), { viewport: { width: 375, height: 812 } }), probe(ten(), { viewport: { width: 390, height: 844 } }));
  assert.deepEqual(result, { comparator_version: "parity-compare/v1", status: "viewport_mismatch", invalid: null,
    drift: { dx: 0, dy: 0, samples: 0 }, counts: counts({ design: 10, build: 10 }), pairs: [], findings: [] });
});

test("P3-I4b: a DPR-only difference reads viewport_mismatch", () => {
  const result = compare(probe(ten(), { viewport: { width: 390, height: 844 }, dpr: 1 }), probe(ten(), { viewport: { width: 390, height: 844 }, dpr: 2 }));
  assert.equal(result.status, "viewport_mismatch");
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.findings, []);
});

test("P3-I5: a design with zero text elements reads design_elements_unavailable", () => {
  const expected = { comparator_version: "parity-compare/v1", status: "design_elements_unavailable", invalid: null,
    drift: { dx: 0, dy: 0, samples: 0 }, counts: counts({ design: 0, build: 10 }), pairs: [], findings: [] };
  assert.deepEqual(compare(probe([]), probe(ten())), expected);
  // Elements whose text has no key (empty, whitespace, punctuation) are not in D.
  const keyless = [el(0, "", [0, 0, 10, 10]), el(1, "   ", [0, 20, 10, 10]), el(2, "— !! —", [0, 40, 10, 10])];
  assert.deepEqual(compare({ ...probe(keyless), page_text: "" }, probe(ten())), expected);
});

test("P3-W10: repeated copy in reversed build order pairs by proximity", () => {
  const design = probe([0, 1, 2].map((i) => el(i, "Add to cart", [40, 100 + i * 100, 200, 40])));
  const build = probe([0, 1, 2].map((i) => el(i, "Add to cart", [40, 300 - i * 100, 200, 40])));
  const result = compare(design, build);
  assert.deepEqual(result.pairs, [
    { design: 0, build: 2, via: "exact_nearest", similarity: null },
    { design: 1, build: 1, via: "exact_nearest", similarity: null },
    { design: 2, build: 0, via: "exact_nearest", similarity: null },
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.drift, { dx: 0, dy: 0, samples: 0 });
});

test("P3-I7: a colour review reason on either side reads one review color member", () => {
  const result = compare(probe(withBody({ color_review: null })), probe(withBody({ color_review: "background_gradient" })));
  assert.deepEqual(result.findings, [finding("color", 1, 1, identity("intro paragraph copy", 1),
    [member("color", "review", "color_unresolved", null, "background_gradient", null)])]);
  // Variant: both sides carry a reason. Still one review member, never silence.
  const both = compare(probe(withBody({ color_review: "background_image" })), probe(withBody({ color_review: "background_gradient" })));
  assert.deepEqual(both.findings, [finding("color", 1, 1, identity("intro paragraph copy", 1),
    [member("color", "review", "color_unresolved", "background_image", "background_gradient", null)])]);
});

test("P3-I8: a null build background reads a background_color review member and no text_color", () => {
  const result = compare(probe(ten()), probe(withBody({ bg_srgb: null })));
  assert.deepEqual(result.findings, [finding("color", 1, 1, identity("intro paragraph copy", 1),
    [member("background_color", "review", "color_unresolved", [255, 255, 255], null, null)])]);
});

test("P3-B12: invalid build input reads invalid_input and never throws", () => {
  const variants = [
    probe(ten((i, e) => (i === 2 ? { ...e, font_size_px: NaN } : e))),
    probe(ten((i, e) => (i === 2 ? { ...e, box: { ...e.box, w: -1 } } : e))),
    (({ coverage, ...rest }) => rest)(probe(ten())),
  ];
  for (const build of variants) {
    assert.equal(isProbeOutput(build), false);
    assert.deepEqual(compare(probe(ten()), build), invalidOutput("build"));
  }
  // Design is checked before build, and any JSON-compatible argument is safe.
  assert.deepEqual(compare(variants[0], variants[1]), invalidOutput("design"));
  for (const junk of [null, undefined, 0, "probe", [], {}, [probe(ten())], { ...probe(ten()), elements: {} }]) {
    assert.deepEqual(compareElementParity(junk, probe(ten())), invalidOutput("design"));
    assert.deepEqual(compareElementParity(probe(ten()), junk), invalidOutput("build"));
  }
});

test("A-P4: box values outside ±1e6 px or negative extents read invalid_input, never NaN", () => {
  const withBox = (fields) => probe(ten((i, e) => (i === 2 ? { ...e, box: { ...e.box, ...fields } } : e)));
  const bad = [{ x: 1.7e308 }, { x: -1.7e308 }, { y: 1e6 + 1 }, { y: -1e6 - 1 }, { w: 1.7e308 }, { h: 1e6 + 1 }, { w: -1 }, { h: -1 }];
  for (const fields of bad) {
    assert.equal(isProbeOutput(withBox(fields)), false);
    assert.deepEqual(compare(probe(ten()), withBox(fields)), invalidOutput("build"));
    assert.deepEqual(compare(withBox(fields), probe(ten())), invalidOutput("design"));
  }
  // The reviewer's case: opposite extreme x values on the build side.
  const extreme = probe(ten((i, e) => ({ ...e, box: { ...e.box, x: i % 2 ? 1.7e308 : -1.7e308 } })));
  const result = compare(probe(ten()), extreme);
  assert.deepEqual(result, invalidOutput("build"));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  // The bounds themselves are valid input.
  for (const fields of [{ x: 1e6 }, { x: -1e6 }, { y: -1e6 }, { w: 1e6 }, { h: 0 }]) {
    assert.equal(isProbeOutput(withBox(fields)), true);
    assert.notEqual(compare(probe(ten()), withBox(fields)).status, "invalid_input");
  }
});

test("P3-B13: partial tolerances read invalid_input options", () => {
  assert.deepEqual(compare(probe(ten()), probe(ten()), { tolerances: { font_size_px: 2 } }), invalidOutput("options"));
  // Options are checked before either side.
  assert.deepEqual(compare(null, null, { tolerances: { font_size_px: 2 } }), invalidOutput("options"));
  const bad = [
    null, [], "x", { other: true }, { tolerances: null },
    { tolerances: { ...PARITY_TOLERANCES, extra: 1 } },
    { tolerances: { ...PARITY_TOLERANCES, gap_px: -1 } },
    { tolerances: { ...PARITY_TOLERANCES, fuzzy_jaccard: 0 } },
    { tolerances: { ...PARITY_TOLERANCES, fuzzy_jaccard: 1.01 } },
    { tolerances: { ...PARITY_TOLERANCES, missing_copy_min_chars: 0 } },
    { tolerances: { ...PARITY_TOLERANCES, missing_copy_min_chars: 2.5 } },
    { tolerances: { ...PARITY_TOLERANCES, color_channel: Infinity } },
  ];
  for (const options of bad) assert.deepEqual(compare(probe(ten()), probe(ten()), options), invalidOutput("options"));
  for (const options of [undefined, {}, { tolerances: { ...PARITY_TOLERANCES } }]) {
    assert.equal(compare(probe(ten()), probe(ten()), options).status, "compared");
  }
});

// A fixed permutation (no randomness): odd positions reversed, then even ones.
const shuffle = (items) => [...items.filter((_, i) => i % 2).reverse(), ...items.filter((_, i) => i % 2 === 0)];

test("P3-W7: shuffled element arrays give a deep-equal output", () => {
  const [design, build] = heroBadgeRow();
  const expected = compare(design, build);
  for (const reorder of [shuffle, (items) => [...items].reverse(), (items) => [...items.slice(3), ...items.slice(0, 3)]]) {
    assert.deepEqual(compare({ ...design, elements: reorder(design.elements) }, { ...build, elements: reorder(build.elements) }), expected);
  }
  // font_faces order and a repeated identity do not change the output either.
  const faces = [{ family: "Synthetic Sans", status: "error" }, { family: "Synthetic Sans", status: "loading" }, { family: "Other", status: "loaded" }];
  const withFaces = (d, b) => compare({ ...d, font_faces: [{ family: "Synthetic Sans", status: "loaded" }] }, { ...b, font_faces: faces });
  assert.deepEqual(withFaces(design, { ...build, elements: shuffle(build.elements) }),
    withFaces({ ...design, elements: shuffle(design.elements) }, { ...build, font_faces: [...faces].reverse() }));
});

test("P3-W8: 1 500 by 1 500 elements complete within 2 000 ms without mutating the inputs", () => {
  const side = (variant) => Array.from({ length: PARITY_PROBE_LIMITS.elements }, (_, i) => {
    const row = Math.floor(i / 5), col = i % 5;
    const text = i % 3 === 0 ? "Repeated tile label"
      : variant === "build" && i % 3 === 2 && i % 2 === 0 ? `Product card ${i} detail extra` : `Product card ${i} detail`;
    return el(i, text, [20 + col * 280 + (variant === "build" ? 2 : 0), 40 + row * 60, 260, 40], { ftext: `${text} wrapper` });
  });
  const design = probe(side("design"));
  const build = probe(side("build"));
  const before = [structuredClone(design), structuredClone(build)];
  const started = performance.now();
  const result = compare(design, build);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
  assert.deepEqual([design, build], before);
  assert.equal(result.status, "compared");
  assert.equal(result.counts.matched, 1500);
  assert.ok(result.counts.by_pass.exact_unique > 0 && result.counts.by_pass.exact_nearest > 0 && result.counts.by_pass.fuzzy > 0);
});

test("P3-W9: drift is the unrounded median and x_position residuals use it", () => {
  const offsets = [0, 0, 1 / 3, 7, 7];
  const names = ["Alpha line", "Bravo line", "Charlie line", "Delta line", "Echo line"];
  const design = probe(names.map((text, i) => el(i, text, [40, 100 + i * 100, 300, 40])));
  const build = probe(names.map((text, i) => el(i, text, [40 + offsets[i], 100 + i * 100, 300, 40])));
  const result = compare(design, build);
  assert.deepEqual(result.drift, { dx: 0.33, dy: 0, samples: 5 });
  assert.deepEqual(result.findings, [3, 4].map((i) => finding("geometry", i, i, identity(names[i].toLowerCase(), i),
    [member("x_position", "warning", "x_position_differs", 40, 47, 6.67)])));
});

// ---------------------------------------------------------------------------
// A.1 shared vectors, asserted through the comparator's output.

const missingCopy = (text) => {
  const result = compare(probe([el(0, text, [0, 0, 100, 20])]), probe([]));
  assert.equal(result.findings.length, 1);
  return result.findings[0];
};

test("A.1 norm: '  Order Now — Save ' is 'order now - save'", () => {
  const f = missingCopy("  Order Now — Save ");
  assert.equal(f.design_identity.text, "order now - save");
  assert.equal(f.members[0].design, "order now - save");
});

test("A.1 norm: the fi ligature reads 'fine'", () => {
  const f = missingCopy("ﬁne");
  assert.equal(f.design_identity.text, "fine");
  assert.equal(f.members[0].reason_code, "copy_missing"); // 4 code points, not below_min_chars
});

test("A.1 key: 'Order now — save 20%!' is 'order now save 20'", () => {
  const design = probe([el(0, "Order now — save 20%!", [0, 0, 100, 20])]);
  const onPage = compare(design, { ...probe([]), page_text: "Lead in. order now save 20 then more" });
  assert.equal(onPage.counts.unmatched_present, 1);
  const notOnPage = compare(design, { ...probe([]), page_text: "order now save 200" });
  assert.equal(notOnPage.counts.unmatched_missing, 1);
  const paired = compare(design, probe([el(7, "order now save 20", [0, 0, 100, 20])]));
  assert.deepEqual(paired.pairs, [{ design: 0, build: 7, via: "exact_unique", similarity: null }]);
});

test("A.1 key: 'Café’s best' is 'café s best' (NFKC composes)", () => {
  for (const text of ["Café’s best", "Café’s best"]) {
    const result = compare(probe([el(0, text, [0, 0, 100, 20])]), probe([el(3, "café s best", [0, 0, 100, 20])]));
    assert.deepEqual(result.pairs, [{ design: 0, build: 3, via: "exact_unique", similarity: null }]);
  }
});

test("A.1 key: Devanagari keeps its vowel-sign marks (5 code points)", () => {
  const word = "किताब";
  assert.equal([...word].length, 5);
  const f = missingCopy(word);
  assert.equal(f.design_identity.text, word);
  assert.equal(f.members[0].reason_code, "copy_missing");
  const exact = compare(probe([el(0, word, [0, 0, 100, 20])]), probe([el(0, word, [0, 0, 100, 20])]));
  assert.equal(exact.pairs[0].via, "exact_unique");
  // With marks dropped, key("किताब") would be "क त ब" and pair with this build text.
  const marksAsSpaces = compare(probe([el(0, word, [0, 0, 100, 20])]), probe([el(0, "क त ब", [0, 0, 100, 20])]));
  assert.deepEqual(marksAsSpaces.pairs, []);
  assert.equal(marksAsSpaces.counts.unmatched_missing, 1);
  const stripped = compare(probe([el(0, word, [0, 0, 100, 20])]), probe([el(0, "कतब", [0, 0, 100, 20])]));
  assert.deepEqual(stripped.pairs, []);
});

test("A.1 tokens/J: {a,b} against {b,c} is 1/3, similarity 0.33", () => {
  const design = probe([el(0, "a b", [0, 0, 100, 20])]);
  const build = probe([el(0, "b c", [0, 0, 100, 20])]);
  const result = compare(design, build, { tolerances: { ...PARITY_TOLERANCES, fuzzy_jaccard: 0.3 } });
  assert.deepEqual(result.pairs, [{ design: 0, build: 0, via: "fuzzy", similarity: 0.33 }]);
  assert.deepEqual(result.findings[0].members, [member("copy", "warning", "copy_changed", "a b", "b c", 0.33)]);
  // Below the default 0.6 there is no pair; three code points are below_min_chars.
  assert.deepEqual(compare(design, build).counts.below_min_chars, 1);
});

test("A.1 firstFamily vectors", () => {
  const vectors = [
    ['"Synthetic \\"Sans\\"", serif', 'synthetic "sans"'],
    ["'Synthetic, Sans', serif", "synthetic, sans"],
    ["  Synthetic Sans , serif", "synthetic sans"],
    ['"", serif', "serif"],
    ['""', ""],
    ["", ""],
  ];
  for (const [css, expected] of vectors) {
    const result = compare(probe([el(0, "Family probe", [0, 0, 100, 20], { font_family: css })]),
      probe([el(0, "Family probe", [0, 0, 100, 20], { font_family: "Zeta Other" })]));
    assert.deepEqual(result.findings[0].members[0], member("font_family", "warning", "font_family_differs", expected, "zeta other", null), css);
  }
  const same = compare(probe([el(0, "Family probe", [0, 0, 100, 20], { font_family: "  Synthetic Sans , serif" })]),
    probe([el(0, "Family probe", [0, 0, 100, 20], { font_family: "Synthetic Sans" })]));
  assert.deepEqual(same.findings, []);
});

const driftOf = (xOffsets) => {
  const names = ["Alpha line", "Bravo line", "Charlie line"];
  const design = probe(xOffsets.map((_, i) => el(i, names[i], [0, i * 100, 100, 20])));
  const build = probe(xOffsets.map((dx, i) => el(i, names[i], [dx, i * 100, 100, 20])));
  return compare(design, build).drift;
};

test("A.1 median: [0,108,108,108,108,108] / [] / [2,1]", () => {
  const [design, build] = heroBadgeRow();
  assert.equal(compare(design, build).drift.dy, 108);
  const repeated = compare(probe([el(0, "Same", [0, 0, 10, 10]), el(1, "Same", [0, 50, 10, 10])]),
    probe([el(0, "Same", [5, 0, 10, 10]), el(1, "Same", [5, 50, 10, 10])]));
  assert.deepEqual(repeated.drift, { dx: 0, dy: 0, samples: 0 });
  assert.deepEqual(driftOf([2, 1]), { dx: 1.5, dy: 0, samples: 2 });
});

test("A.1 round2: 0.6000000000000014 / -0.004 / 1.005 / -2.005", () => {
  const sized = compare(probe([el(0, "Sized text", [0, 0, 100, 20], { font_size_px: 32 })]),
    probe([el(0, "Sized text", [0, 0, 100, 20], { font_size_px: 32.6 })]),
    { tolerances: { ...PARITY_TOLERANCES, font_size_px: 0.5 } });
  assert.deepEqual(sized.findings[0].members, [member("font_size", "warning", "font_size_differs", 32, 32.6, 0.6)]);
  const negativeZero = driftOf([-0.004]);
  assert.ok(Object.is(negativeZero.dx, 0));
  assert.equal(driftOf([1.005]).dx, 1);
  assert.equal(driftOf([-2.005]).dx, -2);
});

test("A.1 exceeds: Δ = 32.6 − 32 with t = 0.6 is false", () => {
  const result = compare(probe([el(0, "Sized text", [0, 0, 100, 20], { font_size_px: 32 })]),
    probe([el(0, "Sized text", [0, 0, 100, 20], { font_size_px: 32.6 })]));
  assert.deepEqual(result.findings, []);
});

test("A.1 c8: 0.1 / 1.2 / -0.1", () => {
  const result = compare(probe([el(0, "Coloured text", [0, 0, 100, 20], { fg_srgb: [0.1, 0, 1] })]),
    probe([el(0, "Coloured text", [0, 0, 100, 20], { fg_srgb: [0.5, 0, 1] })]));
  assert.deepEqual(result.findings[0].members, [member("text_color", "warning", "text_color_differs", [26, 0, 255], [128, 0, 255], 102)]);
  // 1.2 and -0.1 would clamp to 255 and 0, but Rule 0 bounds sRGB channels to
  // [0, 1], so such a probe never reaches c8: it reads invalid_input.
  for (const fg of [[1.2, 0, 0], [-0.1, 0, 0]]) {
    assert.deepEqual(compare(probe([el(0, "Coloured text", [0, 0, 100, 20])]), probe([el(0, "Coloured text", [0, 0, 100, 20], { fg_srgb: fg })])),
      invalidOutput("build"));
  }
});

// ---------------------------------------------------------------------------
// Contract surface.

test("exports, constants and module purity", () => {
  assert.equal(PARITY_COMPARATOR_VERSION, "parity-compare/v1");
  assert.ok(Object.isFrozen(PARITY_TOLERANCES) && Object.isFrozen(PARITY_PROBE_LIMITS));
  assert.deepEqual({ ...PARITY_TOLERANCES }, { position_px: 6, size_px: 6, gap_px: 6, font_size_px: 0.6, line_height_px: 2,
    letter_spacing_px: 0.2, color_channel: 3, fuzzy_jaccard: 0.6, missing_copy_min_chars: 4 });
  assert.deepEqual({ ...PARITY_PROBE_LIMITS }, { elements: 1500, text_chars: 500, page_text_chars: 262144, font_faces: 200, selector_path_chars: 2048 });
  assert.equal(isProbeOutput(probe(ten())), true);
  assert.equal(isProbeOutput({ ...probe(ten()), elements: [el(0, "a", [0, 0, 1, 1]), el(0, "b", [0, 0, 1, 1])] }), false);
  const source = readFileSync(new URL("./compare.mjs", import.meta.url), "utf8");
  assert.ok(!/^\s*import\b/m.test(source) && !/\bimport\(/.test(source), "the comparator has no imports");
  assert.ok(!/Date|Math\.random|performance|process\.|globalThis/.test(source), "no clock, randomness or globals");
});
