import test from "node:test";
import assert from "node:assert/strict";
import { loadVisualDependencies, padRgba, paintMaskUnion, compareImages, compareBands, worstTiles, encodeHeatmap, releaseComparison, readRgba } from "./visual-diff.mjs";
import { compareVisualPair, evaluateVisualDiff, evaluateVisualReference, VISUAL_MASKS, writePolishPng } from "./polish-visual.mjs";
import { verifyReference } from "./visual-reference.mjs";
import { readPngStructure, VISUAL_MAX_DECODE_PIXELS } from "./png-header.mjs";
import { createRgbaPng, syntheticVisualFixture } from "./polish-visual-fixtures.mjs";

const dependencies = await loadVisualDependencies();
const createRgba = (width, height, color) => dependencies.decoder.decode(createRgbaPng(width, height, color));
const decisions = [];
const ref = { verification: { level: "decoded" }, provenance: { class: "declared_source" }, viewport: "desktop", css_width: 1440, dpr: 1 };
function cell(side, sections = []) {
  return { side, viewport: "desktop", width: 1440, height: 1200, route: "/page/", page_id: "page", device_scale_factor: 1,
    status: "rendered", actual: { status: "captured", truncated: false },
    stabilized: { status: "captured", truncated: false, treatment: { mask_selectors: VISUAL_MASKS, masks: [], mask_cap_reached: false } },
    sections: { bands: sections, duplicated_keys: [], capped: false }, readiness: { fonts: { status: "settled" }, await: { status: "not_present" } } };
}
function decision(comparison, build, basis, options = {}) {
  const row = evaluateVisualDiff(comparison, { record: { dependencies }, reference: ref, build, basis, ...options });
  decisions.push(row); return row;
}
const band = (key, top, height, width = 64) => ({ key, top, height, left: 0, width });
const copyImage = (image) => ({ ...image, data: Buffer.from(image.data) });
// Production sources reload content-addressed files. Synthetic sources keep
// encoded fixture bytes only, and discard the initial decoded image.
function source(image, memory) {
  const bytes = dependencies.decoder.encode(image), { width, height } = image;
  const data = image.data; image.data = null; memory?.release(data);
  return { width, height, load: () => dependencies.decoder.decode(bytes) };
}

test("Padding preserves every original pixel, counts added area as difference, and heatmaps round-trip", () => {
  const basis = createRgba(2, 2), build = createRgba(2, 3);
  const padded = padRgba(basis, 2, 3, [1, 2, 3, 255]);
  assert.deepEqual(padded.data.subarray(0, 16), basis.data);
  assert.deepEqual([...padded.data.subarray(16, 20)], [1, 2, 3, 255]);
  const compared = compareImages(basis, build, { diff: dependencies.diff });
  assert.equal(compared.mismatch_pixels, 2); assert.equal(compared.compared_pixels, 6);
  assert.equal(compared.height_delta_px, 1); assert.equal(compared.mismatch_ratio, 1 / 3);
  assert.equal(compared.basis_crop.height, 2); assert.equal(compared.build_crop.height, 3);
  assert.equal(compared.heatmap.height, 3);
  const png = encodeHeatmap(compared, dependencies.decoder), decoded = dependencies.decoder.decode(png);
  assert.equal(readPngStructure(png).ok, true); assert.deepEqual(decoded.data, compared.heatmap.data);
  assert.throws(() => padRgba(basis, 100000, 100000), /image_too_large/);
  assert.throws(() => compareImages({ width: 100000, height: 100000 }, basis, { diff: dependencies.diff }), /image_too_large/);
});
// Four distinct columns from x = 0, then black: any resample of a narrower side
// moves or repeats a column, so its crop and its mismatch count would change.
const PALETTE = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
function columns(width, height) {
  const image = createRgba(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y++) for (let x = 0; x < Math.min(width, PALETTE.length); x++) image.data.set(PALETTE[x], (y * width + x) * 4);
  return image;
}
function assertPaddedNotResized(part, { basis, build }, label) {
  const narrow = Math.min(basis.width, build.width), wide = Math.max(basis.width, build.width);
  assert.deepEqual(part.canvas, { width: wide, height: 2 }, label);
  assert.equal(part.width_delta_px, build.width - basis.width, label);
  // §4.3 step 2: only the padded columns differ; the shared columns are identical.
  assert.equal(part.compared_pixels, wide * 2, label); assert.equal(part.mismatch_pixels, (wide - narrow) * 2, label);
  for (let y = 0; y < 2; y++) for (let x = 0; x < wide; x++) assert.equal(part.mismatches[y * wide + x], x >= narrow ? 1 : 0, `${label} (${x},${y})`);
  // Each crop holds exactly its own side's original pixels.
  for (const [name, original] of [["basis_crop", basis], ["build_crop", build]]) {
    assert.deepEqual([part[name].width, part[name].height], [original.width, original.height], `${label} ${name}`);
    assert.deepEqual(Buffer.from(part[name].data), Buffer.from(original.data), `${label} ${name}`);
  }
}
for (const narrowSide of ["build", "source_html"]) test(`Different widths are padded, never resized, at page and band level (narrow ${narrowSide})`, () => {
  const narrow = () => columns(4, 2), wide = () => columns(8, 2);
  const originals = narrowSide === "build" ? { basis: wide(), build: narrow() } : { basis: narrow(), build: wide() };
  const direct = compareImages(copyImage(originals.basis), copyImage(originals.build), { diff: dependencies.diff });
  assertPaddedNotResized(direct, originals, "compareImages");
  const basis = cell("source_html", [band("#band", 0, 2, originals.basis.width)]);
  const build = cell("build", [band("#band", 0, 2, originals.build.width)]);
  const parts = [];
  const comparison = compareVisualPair({ basis, build, basisImage: source(copyImage(originals.basis)), buildImage: source(copyImage(originals.build)),
    diff: dependencies.diff, onComparison(part) { assertPaddedNotResized(part, originals, part.key ?? "page"); parts.push(part.key ?? "page"); } });
  assert.deepEqual(parts, ["page", "#band"]);
  assert.equal(comparison.page.mismatch_pixels, 8); assert.equal(comparison.bands[0].mismatch_pixels, 8);
});
test("Mask union counts overlap once and clips to its canvas", () => {
  const images = [createRgba(8, 8), createRgba(8, 8)];
  const union = paintMaskUnion(images, [{ x: -2, y: 0, width: 6, height: 4 }], [{ x: 2, y: 2, width: 4, height: 4 }]);
  assert.equal(union.masked_pixels, 28); assert.deepEqual(images[0].data, images[1].data);
});
test("Fractional CSS masks are converted and rounded at page and band pixel work", () => {
  const basis = cell("source_html", [band("#hero", 0, 8, 8)]), build = cell("build", structuredClone(basis.sections.bands));
  const rect = { x: 0.25, y: 1.25, width: 4.5, height: 2.5 };
  build.stabilized.treatment.masks = [{ group: "price", count: 1, rects: [rect] }];
  const a = createRgba(8, 8), b = createRgba(8, 8);
  paintMaskUnion([b], [{ x: 0, y: 1, width: 5, height: 3 }], [], [0, 0, 0, 255]);
  const comparison = compareVisualPair({ basis, build, basisImage: source(a), buildImage: source(b), diff: dependencies.diff });
  for (const part of [comparison.page, comparison.bands[0]]) {
    assert.equal(part.masked_pixels, 15); assert.equal(part.compared_pixels, 49); assert.equal(part.mismatch_pixels, 0);
  }
  const row = decision(comparison, build, basis);
  assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
});
test("Fractional section positions and sizes crop at each side's own rounded device offsets", () => {
  const basis = cell("source_html", [{ ...band("#hero", 0.5, 7.25, 7.25), left: 0.5 }]);
  const build = cell("build", [{ ...band("#hero", 8.5, 7.25, 7.25), left: 0.5 }]);
  const a = createRgba(8, 16), b = createRgba(8, 16);
  paintMaskUnion([a], [{ x: 0, y: 0, width: 8, height: 1 }], [], [0, 0, 0, 255]);
  paintMaskUnion([b], [{ x: 0, y: 8, width: 8, height: 1 }], [], [0, 0, 0, 255]);
  const comparison = compareVisualPair({ basis, build, basisImage: source(a), buildImage: source(b), diff: dependencies.diff });
  const compared = comparison.bands[0];
  assert.deepEqual(compared.basis, { top: 0.5, height: 7.25 });
  assert.deepEqual(compared.build, { top: 8.5, height: 7.25 });
  assert.deepEqual(compared.canvas, { width: 8, height: 8 });
  assert.equal(compared.mismatch_pixels, 0); assert.equal(compared.compared_pixels, 64);
  const row = decision(comparison, build, basis);
  assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
});
test("Section wholly below the clipped capture is unsupported while the hero still compares", () => {
  const basis = cell("source_html", [band("#hero", 0, 32, 8), band("#footer", 13000, 32, 8)]);
  const build = cell("build", structuredClone(basis.sections.bands));
  for (const c of [basis, build]) { c.stabilized.truncated = true; c.stabilized.full_height_css = 14000; }
  const comparison = compareVisualPair({ basis, build, basisImage: source(createRgba(8, 12000)), buildImage: source(createRgba(8, 12000)), diff: dependencies.diff });
  assert.equal(comparison.status, "compared");
  assert.equal(comparison.bands.find((b) => b.key === "#hero").status, "compared");
  assert.deepEqual(comparison.bands.find((b) => b.key === "#footer"), { key: "#footer", status: "unsupported", reason: "beyond_capture_height" });
  const row = decision(comparison, build, basis);
  assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
  assert.deepEqual(row.members, [
    { key: "#footer", result: "unexercised", reason_code: "beyond_capture_height" },
    { key: "page", result: "unexercised", reason_code: "capture_truncated" },
  ]);
});
for (const [name, box, reason] of [
  ["negative top", { top: -0.5 }, "beyond_capture_height"],
  ["negative left", { left: -0.5 }, "beyond_capture_height"],
  ["right-edge overflow", { left: 0.5 }, "beyond_capture_height"],
  ["bottom-edge overflow", { top: 8.5 }, "beyond_capture_height"],
  ["zero height", { height: 0 }, "section_not_rendered"],
  ["zero width", { width: 0 }, "section_not_rendered"],
  ["negative height", { height: -0.5 }, "section_not_rendered"],
  ["negative width", { width: -0.5 }, "section_not_rendered"],
  ["height rounding to zero pixels", { top: 8, height: Number.MIN_VALUE }, "section_not_rendered"],
]) for (const side of ["source_html", "build"]) test(`Section geometry: ${name} on ${side} is classified and in-crop bands still compare`, () => {
  const basis = cell("source_html", [band("#inside", 0, 8, 8), band("#outside", 0, 8, 8)]);
  const build = cell("build", structuredClone(basis.sections.bands));
  Object.assign((side === "build" ? build : basis).sections.bands[1], box);
  // Suppress the page so the surviving band is what makes this diagnostic.
  for (const c of [basis, build]) c.stabilized.truncated = true;
  const a = createRgba(8, 16), b = createRgba(8, 16);
  paintMaskUnion([b], [{ x: 0, y: 0, width: 1, height: 1 }], [], [0, 0, 0, 255]);
  const comparison = compareVisualPair({ basis, build, basisImage: source(a), buildImage: source(b), diff: dependencies.diff });
  assert.equal(comparison.status, "compared"); assert.equal(comparison.reason, null);
  assert.deepEqual(comparison.bands.find((part) => part.key === "#outside"), { key: "#outside", status: "unsupported", reason });
  assert.deepEqual(comparison.members, [{ key: "#outside", result: "unexercised", reason_code: reason }]);
  const inside = comparison.bands.find((part) => part.key === "#inside");
  assert.equal(inside.status, "compared"); assert.equal(inside.compared_pixels, 64); assert.equal(inside.mismatch_pixels, 1);
  const row = decision(comparison, build, basis);
  assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
  assert.deepEqual(row.members, [...comparison.members, { key: "page", result: "unexercised", reason_code: "capture_truncated" }]);
});
test("Section geometry: NaN and Infinity in every coordinate or size throw invalid_band_geometry", () => {
  for (const value of [NaN, Infinity, -Infinity]) for (const axis of ["top", "left", "width", "height"]) for (const side of ["source_html", "build"]) {
    const basis = cell("source_html", [band("#bad", 0, 8, 8)]), build = cell("build", structuredClone(basis.sections.bands));
    (side === "build" ? build : basis).sections.bands[0][axis] = value;
    const a = source(createRgba(8, 16)), b = source(createRgba(8, 16));
    assert.throws(() => compareBands(a, b, { basisSections: basis.sections, buildSections: build.sections, diff: dependencies.diff }),
      { name: "RangeError", message: "invalid_band_geometry" });
    assert.throws(() => compareVisualPair({ basis, build, basisImage: a, buildImage: b, diff: dependencies.diff }),
      { name: "RangeError", message: "invalid_band_geometry" });
  }
});
test("Section geometry: over-cap area throws image_too_large and the pair records diff_unavailable", () => {
  for (const side of ["source_html", "build"]) {
    const basis = cell("source_html", [band("#large", 0, 1, 8)]), build = cell("build", structuredClone(basis.sections.bands));
    (side === "build" ? build : basis).sections.bands[0].width = VISUAL_MAX_DECODE_PIXELS + 1;
    const a = source(createRgba(8, 16)), b = source(createRgba(8, 16));
    assert.throws(() => compareBands({ ...a, load() { assert.fail("over-cap band must not decode"); } }, b,
      { basisSections: basis.sections, buildSections: build.sections, diff: dependencies.diff }),
    { name: "RangeError", message: "image_too_large" });
    const comparison = compareVisualPair({ basis, build, basisImage: a, buildImage: b, diff: dependencies.diff });
    assert.equal(comparison.status, "unavailable"); assert.equal(comparison.reason, "image_too_large");
    const row = decision(comparison, build, basis);
    assert.equal(row.result, "unexercised"); assert.equal(row.reason_code, "diff_unavailable");
    assert.deepEqual(row.members, [{ key: "diff", result: "unexercised", reason_code: "image_too_large" }]);
  }
});
test("F3C-B13: duplicate and missing section mappings leave other bands compared", () => {
  const basis = cell("source_html", [band("#hero", 0, 32), band("#reviews", 32, 32), band("#offer", 64, 32)]);
  const build = cell("build", [band("#hero", 0, 32), band("#hero", 32, 32), band("#offer", 64, 32)]);
  const comparison = compareVisualPair({ build, basis, basisImage: source(createRgba(64, 96)), buildImage: source(createRgba(64, 96)), diff: dependencies.diff });
  assert.equal(comparison.bands.find((b) => b.key === "#hero").reason, "section_mapping_duplicate");
  assert.equal(comparison.bands.find((b) => b.key === "#reviews").reason, "section_mapping_missing");
  assert.equal(comparison.bands.find((b) => b.key === "#hero").status, "unsupported");
  assert.equal(comparison.bands.find((b) => b.key === "#reviews").status, "unsupported");
  assert.equal(comparison.bands.find((b) => b.key === "#offer").status, "compared");
  const row = decision(comparison, build, basis); assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
  assert.deepEqual(row.members, [
    { key: "#hero", result: "unexercised", reason_code: "section_mapping_duplicate" },
    { key: "#reviews", result: "unexercised", reason_code: "section_mapping_missing" },
  ]);
});
test("F3C-B17: same-label different masks use the union for page and band metrics", () => {
  const basisImage = createRgba(390, 500), buildImage = createRgba(390, 500);
  const rect = { x: 100, y: 400, width: 200, height: 40 };
  paintMaskUnion([buildImage], [rect]);
  const basis = cell("source_html", [band("#offer", 300, 200, 390)]), build = cell("build", [band("#offer", 300, 200, 390)]);
  build.stabilized.treatment.masks = [{ group: "price", count: 1, rects: [rect] }];
  const control = compareImages(copyImage(basisImage), copyImage(buildImage), { diff: dependencies.diff }); assert.ok(control.mismatch_pixels > 0);
  const comparison = compareVisualPair({ build, basis, basisImage: source(basisImage), buildImage: source(buildImage), diff: dependencies.diff });
  for (const part of [comparison.page, comparison.bands[0]]) {
    assert.equal(part.mismatch_pixels, 0); assert.equal(part.masked_pixels, 8000);
    assert.equal(part.compared_pixels, part.canvas.width * part.canvas.height - 8000);
  }
  assert.ok(comparison.limits.includes("masks_unioned"));
  const row = decision(comparison, build, basis);
  assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
});
test("F3C-B18: truncated page keeps in-crop bands; truncated image-reference pair has nothing to compare", () => {
  const basis = cell("source_html", [band("#hero", 0, 32, 8), band("#end", 11990, 30, 8)]);
  const build = cell("build", structuredClone(basis.sections.bands));
  build.stabilized.truncated = true; build.stabilized.full_height_css = 14000; basis.stabilized.full_height_css = 9000;
  build.actual.truncated = true;
  const basisImage = createRgba(8, 9000), buildImage = createRgba(8, 12000);
  const comparison = compareVisualPair({ build, basis, basisImage: source(basisImage), buildImage: source(buildImage), diff: dependencies.diff });
  assert.equal(comparison.page.status, "unsupported"); assert.equal(comparison.page.reason, "capture_truncated");
  assert.deepEqual(comparison.page, { status: "unsupported", reason: "capture_truncated", width_delta_px: null, height_delta_px: null,
    canvas: null, masked_pixels: null, mismatch_pixels: null, compared_pixels: null, mismatch_ratio: null });
  assert.equal(comparison.bands.find((b) => b.key === "#hero").status, "compared");
  assert.equal(comparison.bands.find((b) => b.key === "#end").reason, "beyond_capture_height");
  let row = decision(comparison, build, basis);
  assert.equal(row.result, "review"); assert.equal(row.reason_code, "visual_diff_diagnostic");
  assert.deepEqual(row.members, [
    { key: "#end", result: "unexercised", reason_code: "beyond_capture_height" },
    { key: "page", result: "unexercised", reason_code: "capture_truncated" },
  ]);
  const imageComparison = compareVisualPair({ build, reference: ref, basisImage: createRgba(1440, 900), buildImage: createRgba(1440, 1200), diff: dependencies.diff });
  row = decision(imageComparison, build, basis);
  assert.equal(row.result, "unexercised"); assert.equal(row.reason_code, "comparison_unsupported");
  assert.deepEqual(row.members, [
    { key: "sections", result: "unexercised", reason_code: "source_section_offsets_unrecorded" },
    { key: "page", result: "unexercised", reason_code: "capture_truncated" },
    { key: "reference_capture", result: "review", reason_code: "reference_capture_unrecorded",
      observation: { unrecorded: ["treatment", "state", "crop_origin", "viewport_height"] } },
  ]);
});
test("F3C-I13: no section keys yields page-only diagnostic review", () => {
  const basis = cell("source_html"), build = cell("build");
  const comparison = compareVisualPair({ build, basis, basisImage: createRgba(8, 8), buildImage: createRgba(8, 8), diff: dependencies.diff });
  const row = decision(comparison, build, basis);
  assert.equal(row.reason_code, "visual_diff_diagnostic"); assert.equal(row.result, "review");
  assert.deepEqual(row.members, [{ key: "sections", result: "unexercised", reason_code: "no_section_keys" }]);
});
test("Bands use their own offsets after an earlier section grows; tiles rank by ratio, y and x", () => {
  const a = createRgba(64, 64), b = createRgba(64, 96);
  const basisSections = { bands: [band("#hero", 0, 32), band("#reviews", 32, 32)] };
  const buildSections = { bands: [band("#hero", 0, 64), band("#reviews", 64, 32)] };
  const result = compareBands(source(a), source(b), { basisSections, buildSections, diff: dependencies.diff });
  assert.equal(result.bands[0].key, "#hero"); assert.equal(result.bands[0].height_delta_px, 32);
  assert.equal(result.bands.find((item) => item.key === "#reviews").mismatch_ratio, 0);
  assert.deepEqual(worstTiles({ width: 64, height: 64, mismatches: new Uint8Array(4096).fill(1) })
    .map(({ x, y }) => [x, y]), [[0, 0], [32, 0], [0, 32]]);
  const left = createRgba(64, 32), right = createRgba(64, 32);
  paintMaskUnion([left], [{ x: 0, y: 0, width: 16, height: 32 }], [], [0, 0, 0, 255]);
  const cropped = compareBands(source(left), source(right), { basisSections: { bands: [{ ...band("#offset", 0, 32, 32), left: 16 }] },
    buildSections: { bands: [band("#offset", 0, 32, 32)] }, diff: dependencies.diff });
  assert.equal(cropped.bands[0].mismatch_pixels, 0);
});
for (const [id, failing, expected, referenceLevel] of [
  ["F3C-I3", "missing", "dependency_missing", "header_checked"],
  ["F3C-I4", "failed", "dependency_failed", "decoded"],
]) test(`${id}: injected optional-dependency ${failing} state precedes capture and reference failures for both bases`, async (t) => {
  const realPng = await import("pngjs");
  const deps = await loadVisualDependencies({ importer: async (name) => {
    if (failing === "failed" && name === "pngjs") return realPng;
    const error = new Error(failing === "missing" ? `Cannot find package '${name}'` : "module initialization failed");
    if (failing === "missing") error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  } });
  assert.equal(deps.diff.status, failing); assert.equal(deps.decoder.status, failing === "failed" ? "available" : "missing");
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const verified = await verifyReference({ ...f, path: f.write("ref.png", createRgbaPng(1440, 900)), decoder: deps.decoder });
  assert.equal(verified.verification.level, referenceLevel);
  const referenceRow = evaluateVisualReference(verified);
  assert.equal(referenceRow.result, failing === "missing" ? "unexercised" : "pass");
  assert.equal(referenceRow.reason_code, failing === "missing" ? "decoder_unavailable" : null);
  for (const basis of ["reference", "source_html"]) {
    const build = cell("build"), source = cell("source_html");
    build.status = "browser_unavailable";
    const row = decision({ basis }, build, source, { record: { dependencies: deps }, reference: { ...verified, viewport: "desktop" } });
    assert.equal(row.result, "unexercised"); assert.equal(row.reason_code, "diff_unavailable"); assert.equal(row.members[0].reason_code, expected);
  }
  const file = createRgbaPng(4, 3);
  assert.equal(readPngStructure(file).level, "header_checked");
  const written = writePolishPng(f.targetRepo, "captures", file);
  assert.equal(written.width_px, 4); assert.equal(written.height_px, 3);
});
test("Missing transitive module is failed rather than an absent optional package", async () => {
  const deps = await loadVisualDependencies({ importer: async () => {
    const error = new Error("Cannot find package 'transitive-module'"); error.code = "ERR_MODULE_NOT_FOUND"; throw error;
  } });
  assert.equal(deps.decoder.status, "failed"); assert.equal(deps.diff.status, "failed");
});
test("Every diff fixture row is review or unexercised, never pass or warning", () => {
  assert.ok(decisions.length >= 9);
  assert.ok(decisions.every((row) => ["review", "unexercised"].includes(row.result) && row.accept_eligible === false));
});

function bufferObserver(images) {
  const live = new Map(); let peak = 0;
  const memory = {
    acquire(data) {
      if (!live.has(data.buffer)) live.set(data.buffer, new Set());
      live.get(data.buffer).add(data);
      peak = Math.max(peak, live.size); assert.ok(live.size <= 3, `live RGBA buffers: ${live.size}`);
    },
    release(data) {
      const views = live.get(data.buffer); assert.ok(views, "released buffer was live");
      const original = [...views].find((view) => view.byteOffset === data.byteOffset && view.byteLength >= data.byteLength);
      assert.ok(original, "released view belonged to live buffer"); views.delete(original);
      if (!views.size) live.delete(data.buffer);
    },
    get peak() { return peak; }, get size() { return live.size; },
  };
  for (const image of images) memory.acquire(image.data);
  return memory;
}
test("Page comparison consumes inputs and never holds more than three simultaneous RGBA buffers", () => {
  for (const [aw, ah, bw, bh] of [[64, 64, 64, 64], [64, 32, 32, 64], [32, 64, 64, 32]]) {
    const a = createRgba(aw, ah), b = createRgba(bw, bh), memory = bufferObserver([a, b]);
    const result = compareImages(a, b, { diff: dependencies.diff, memory });
    assert.equal(a.data, null); assert.equal(b.data, null);
    assert.equal(memory.peak, 3); assert.equal(memory.size, 3);
    assert.equal(result.basis_crop.width, aw); assert.equal(result.build_crop.width, bw);
    releaseComparison(result, memory); assert.equal(memory.size, 0);
  }
});
test("Page plus repeated unequal bands release artifacts before the next allocation (three RGBA buffers maximum)", () => {
  const a = createRgba(64, 96), b = createRgba(64, 128), memory = bufferObserver([a, b]);
  const basis = cell("source_html", [band("#one", 0, 32), band("#two", 32, 32), band("#three", 64, 32)]);
  const build = cell("build", [band("#one", 0, 64, 32), band("#two", 64, 32), band("#three", 96, 32)]);
  let artifacts = 0;
  const result = compareVisualPair({ basis, build, basisImage: source(a, memory), buildImage: source(b, memory), diff: dependencies.diff, memory,
    onComparison(part) {
      assert.equal(memory.size, 3);
      for (const image of [part.basis_crop, part.build_crop, part.heatmap]) assert.equal(readPngStructure(dependencies.decoder.encode(image)).ok, true);
      artifacts++;
    } });
  assert.equal(artifacts, 4); assert.equal(memory.peak, 3); assert.equal(memory.size, 0);
  assert.equal(a.data, null); assert.equal(b.data, null);
  assert.ok([result.page, ...result.bands].every((part) => !part.heatmap && !part.basis_crop && !part.build_crop));
});
test("Standalone band comparisons also consume inputs and release all comparison buffers", () => {
  const a = createRgba(64, 96), b = createRgba(64, 128), memory = bufferObserver([a, b]);
  compareBands(source(a, memory), source(b, memory), { basisSections: { bands: [band("#one", 0, 32)] }, buildSections: { bands: [band("#one", 0, 64, 32)] }, diff: dependencies.diff, memory });
  assert.equal(memory.peak, 3); assert.equal(memory.size, 0); assert.equal(a.data, null); assert.equal(b.data, null);
});
test("Exported pixel primitives reject invalid dimensions before allocating, encoding or comparing", () => {
  for (const value of [Infinity, NaN, -1, 0, 1.5, 17280001]) for (const axis of ["width", "height"]) {
    const shape = { width: 1, height: 1, [axis]: value, data: Buffer.alloc(4) };
    const good = { width: 1, height: 1, data: Buffer.alloc(4) };
    let work = 0;
    const memory = { acquire() { work++; }, release() { work++; } };
    assert.throws(() => padRgba(good, shape.width, shape.height, undefined, memory), /image_too_large/);
    assert.throws(() => padRgba(shape, 1, 1, undefined, memory), /image_too_large/);
    assert.throws(() => compareImages(shape, good, { memory }), /image_too_large/);
    assert.throws(() => paintMaskUnion([shape]), /image_too_large/);
    assert.throws(() => compareBands(shape, good, { memory }), /image_too_large/);
    assert.throws(() => worstTiles({ ...shape, mismatches: [0] }), /image_too_large/);
    assert.throws(() => encodeHeatmap(shape, { encode() { work++; } }), /image_too_large/);
    assert.throws(() => readRgba({ ...shape, load() { work++; } }, memory), /image_too_large/);
    assert.equal(work, 0);
  }
  const good = createRgba(4, 4);
  assert.throws(() => compareBands(good, good, { cap: Infinity }), /invalid_band_cap/);
  assert.throws(() => compareBands(good, good, { basisSections: { bands: [null] } }), /invalid_band_geometry/);
  assert.throws(() => compareBands(good, good, { basisSections: { bands: [band("#bad", 0, Infinity)] } }), /invalid_band_geometry/);
});
test("Inherited optional module APIs are refused as failed dependencies", async () => {
  const inherited = await loadVisualDependencies({ importer: async () => Object.create({ PNG: { sync: { read() {}, write() {} } }, default: () => {} }) });
  assert.equal(inherited.decoder.status, "failed"); assert.equal(inherited.diff.status, "failed");
});
test("Dependency and artifact callback failures release comparison buffers", () => {
  for (const failure of ["diff", "artifact"]) {
    const a = createRgba(64, 64), b = createRgba(64, 64), memory = bufferObserver([a, b]);
    assert.throws(() => compareVisualPair({ basis: cell("source_html"), build: cell("build"), basisImage: a, buildImage: b, memory,
      diff: failure === "diff" ? () => { throw new Error("synthetic_failure"); } : dependencies.diff,
      onComparison() { throw new Error("synthetic_failure"); } }), /synthetic_failure/);
    assert.equal(memory.size, 0); assert.equal(a.data, null); assert.equal(b.data, null);
  }
});
test("Mask geometry and tile options are bounded before pixel mutation", () => {
  for (const value of [Infinity, NaN, -1]) {
    const image = createRgba(4, 4), before = Buffer.from(image.data);
    assert.throws(() => paintMaskUnion([image], [{ x: 0, y: 0, width: value, height: 1 }]), /invalid_mask/);
    assert.deepEqual(image.data, before);
  }
  for (const options of [{ tile: Infinity }, { tile: NaN }, { tile: -1 }, { count: -1 }, { count: Infinity }]) {
    assert.throws(() => worstTiles({ width: 1, height: 1, mismatches: [0] }, options), /invalid_tile_options/);
  }
});
test("Geometry limits bound pixel work rather than rejecting clipped masks, sections or finite DPR", () => {
  const image = createRgba(4, 4);
  assert.equal(paintMaskUnion([image], [{ x: 0.5, y: 0.5, width: 17280001, height: 17280001 }]).masked_pixels, 16);
  assert.equal(paintMaskUnion([image], [{ x: 0.5, y: 0.5, width: 0, height: 0.5 }]).masked_pixels, 0);
  for (const dpr of [0.5, 1.25, 12001, Number.MAX_VALUE]) {
    const comparison = compareImages(createRgba(4, 4), createRgba(4, 4), { dpr, diff: dependencies.diff });
    assert.equal(comparison.mismatch_pixels, 0); assert.equal(comparison.compared_pixels, 16);
  }
  const sections = { bands: [band("#tiny", 0.1, 0.1, 0.1), band("#wide", 0, 1, 5), band("#tall", 0, 13000, 4)] };
  const result = compareBands(source(createRgba(4, 4)), source(createRgba(4, 4)), {
    basisSections: sections, buildSections: sections, diff: dependencies.diff, cap: 41,
  });
  assert.equal(result.bands.find((b) => b.key === "#tiny").compared_pixels, 1);
  assert.deepEqual(result.bands.find((b) => b.key === "#wide"), { key: "#wide", status: "unsupported", reason: "beyond_capture_height" });
  assert.deepEqual(result.members, ["#tall", "#wide"].map((key) => ({ key, result: "unexercised", reason_code: "beyond_capture_height" })));
  assert.equal(worstTiles({ width: 64, height: 64, mismatches: new Uint8Array(4096) }, { tile: 1.5, count: 4 }).length, 3);
  assert.equal(worstTiles({ width: 1, height: 1, mismatches: [0] }, { tile: 17280001 }).length, 1);
});
test("Shared image inputs compare within the same three-buffer bound", () => {
  const image = createRgba(64, 64), memory = bufferObserver([image]);
  const result = compareImages(image, image, { diff: dependencies.diff, memory });
  assert.equal(result.mismatch_pixels, 0); assert.equal(result.compared_pixels, 4096);
  assert.equal(image.data, null); assert.equal(memory.peak, 3);
  releaseComparison(result, memory); assert.equal(memory.size, 0);
});
