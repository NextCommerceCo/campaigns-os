import { boundedDimensions, VISUAL_MAX_DECODE_PIXELS } from "./png-header.mjs";

const own = (value, key) => value !== null && ["object", "function"].includes(typeof value) && Object.hasOwn(value, key) ? value[key] : undefined;
const boundedArea = boundedDimensions;
function geometry(image) {
  boundedArea(own(image, "width"), own(image, "height"));
  if (!ArrayBuffer.isView(image.data) || image.data.length !== image.width * image.height * 4) throw new RangeError("invalid_image_geometry");
}
const track = (memory, data) => { memory?.acquire(data); return data; };
function release(image, memory) {
  const data = image.data;
  image.data = null;
  if (data) memory?.release(data);
}
const allocate = (length, memory) => track(memory, Buffer.alloc(length));
function maskRects(rects) {
  if (!Array.isArray(rects) || rects.some((r) => !r || ![r.x, r.y].every(Number.isFinite)
      || ![r.width, r.height].every((n) => Number.isFinite(n) && n >= 0))) throw new RangeError("invalid_mask");
}

// Comparisons consume their RGBA inputs. Callbacks must finish encoding/writing
// artifacts synchronously; only metrics survive into the next comparison.
export function readRgba(source, memory) {
  boundedArea(own(source, "width"), own(source, "height"));
  if (typeof own(source, "load") !== "function") { geometry(source); return source; }
  const image = source.load();
  geometry(image);
  if (image.width !== source.width || image.height !== source.height) throw new RangeError("invalid_image_geometry");
  track(memory, image.data); return image;
}
export function releaseComparison(part, memory) {
  for (const key of ["basis_crop", "build_crop", "heatmap"]) if (part?.[key]) {
    release(part[key], memory); delete part[key];
  }
  delete part.mismatches; delete part.mask;
}

export const DIFF_OPTIONS = Object.freeze({ threshold: 0.1, include_aa: false, alpha: 0.1 });
export async function loadVisualDependencies({ importer = (name) => import(name) } = {}) {
  async function load(name, type) {
    try {
      const module = await importer(name);
      const api = own(module, "default") || module;
      const result = { status: "available", version: own(module, "version") ?? own(api, "version") ?? null, package: name };
      if (type === "decoder") {
        const PNG = own(module, "PNG") || own(api, "PNG");
        const sync = own(PNG, "sync");
        if (typeof own(sync, "read") !== "function" || typeof own(sync, "write") !== "function") throw new TypeError("Invalid PNG module");
        result.decode = (bytes) => PNG.sync.read(bytes);
        result.encode = (image) => PNG.sync.write(image);
      } else {
        if (typeof api !== "function") throw new TypeError("Invalid diff module");
        result.compare = api;
      }
      return result;
    } catch (error) {
      // A missing transitive import is a broken installation, not this package being absent.
      const missing = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error?.code)
        && new RegExp(`(?:package|module) ['\"]${name}['\"]`).test(error.message || "");
      return { status: missing ? "missing" : "failed", version: null, package: name,
        install_hint: `Install ${name} where campaigns-os is installed (npm install ${name}).` };
    }
  }
  const [decoder, diff] = await Promise.all([load("pngjs", "decoder"), load("pixelmatch", "diff")]);
  return { decoder, diff };
}

export function padRgba(image, width, height, color = [255, 255, 255, 255], memory) {
  boundedArea(width, height);
  geometry(image);
  if (width < image.width || height < image.height || image.data.length !== image.width * image.height * 4) throw new RangeError("invalid_image_geometry");
  const data = allocate(width * height * 4, memory);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  for (let y = 0; y < image.height; y++) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
  return { width, height, data };
}

export function paintMaskUnion(images, rectsA = [], rectsB = [], color = [255, 0, 255, 255]) {
  maskRects(rectsA); maskRects(rectsB);
  if (typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color)) color = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)).concat(255);
  if (!images.length) return { masked_pixels: 0, mask: new Uint8Array() };
  for (const image of images) geometry(image);
  const { width, height } = images[0];
  boundedArea(width, height);
  if (images.some((image) => image.width !== width || image.height !== height)) throw new RangeError("mask_canvas_mismatch");
  const mask = new Uint8Array(width * height);
  let masked_pixels = 0;
  for (const rect of [...rectsA, ...rectsB]) {
    if (!rect.width || !rect.height) continue;
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width)), y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const index = y * width + x;
      if (!mask[index]) { mask[index] = 1; masked_pixels++; }
      for (const image of images) image.data.set(color, index * 4);
    }
  }
  return { masked_pixels, mask };
}

export function compareImages(basis, build, { diff, rectsA = [], rectsB = [], dpr = 1, memory } = {}) {
  geometry(basis); geometry(build);
  maskRects(rectsA); maskRects(rectsB);
  if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError("invalid_dpr");
  const compare = typeof diff === "function" ? diff : own(diff, "compare");
  if (typeof compare !== "function") throw new Error("dependency_missing");
  const width = Math.max(basis.width, build.width), height = Math.max(basis.height, build.height);
  boundedArea(width, height);
  const originalA = { width: basis.width, height: basis.height }, originalB = { width: build.width, height: build.height };
  track(memory, basis.data); track(memory, build.data);
  const inputs = [{ ...basis }, { ...build }];
  basis.data = null; build.data = null;
  const consume = (image) => {
    if (image.width === width && image.height === height) {
      const result = { ...image }; image.data = null; return result;
    }
    const padded = padRgba(image, width, height, undefined, memory);
    release(image, memory); return padded;
  };
  let a, b, heatmap, completed = false;
  try {
  if (inputs[0].data.buffer === inputs[1].data.buffer
      && inputs[0].data.byteOffset < inputs[1].data.byteOffset + inputs[1].data.byteLength
      && inputs[1].data.byteOffset < inputs[0].data.byteOffset + inputs[0].data.byteLength) {
    const original = inputs[0].data;
    inputs[0].data = allocate(original.length, memory);
    inputs[0].data.set(original);
    if (original !== inputs[1].data) memory?.release(original);
  }
  a = consume(inputs[0]); b = consume(inputs[1]);
  const { mask, masked_pixels } = paintMaskUnion([a, b], rectsA, rectsB);
  heatmap = { width, height, data: allocate(width * height * 4, memory) };
  compare(a.data, b.data, heatmap.data, width, height,
    { threshold: DIFF_OPTIONS.threshold, includeAA: DIFF_OPTIONS.include_aa, alpha: DIFF_OPTIONS.alpha });
  const mismatches = new Uint8Array(width * height);
  let mismatch_pixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, p = i * 4;
    const missing = (x >= originalA.width || y >= originalA.height) !== (x >= originalB.width || y >= originalB.height);
    if (!mask[i] && (missing || (heatmap.data[p] === 255 && heatmap.data[p + 1] === 0 && heatmap.data[p + 2] === 0))) {
      mismatches[i] = 1; mismatch_pixels++;
      heatmap.data.set([255, 0, 0, 255], p);
    }
  }
  const compared_pixels = width * height - masked_pixels;
  const unpad = (image, original) => {
    for (let y = 0; y < original.height; y++) image.data.copyWithin(y * original.width * 4, y * width * 4, (y * width + original.width) * 4);
    return { ...original, data: image.data.subarray(0, original.width * original.height * 4) };
  };
  const result = { status: "compared", reason: null, width_delta_px: originalB.width - originalA.width,
    height_delta_px: originalB.height - originalA.height, canvas: { width, height }, masked_pixels,
    mismatch_pixels, compared_pixels, mismatch_ratio: compared_pixels ? mismatch_pixels / compared_pixels : 0,
    heatmap, basis_crop: unpad(a, originalA), build_crop: unpad(b, originalB), mismatches, mask,
    worst_tiles: worstTiles({ width, height, mismatches, mask }, { tile: Math.min(32 * dpr, Math.max(width, height)) }) };
  completed = true; return result;
  } finally {
    if (!completed) for (const image of [a, b, heatmap, ...inputs]) if (image?.data) release(image, memory);
  }
}

export function worstTiles({ width, height, mismatches, mask = [] }, { tile = 32, count = 3 } = {}) {
  boundedArea(width, height);
  if (!Number.isFinite(tile) || tile <= 0 || !Number.isSafeInteger(count) || count < 0) throw new RangeError("invalid_tile_options");
  tile = Math.max(1, Math.round(tile));
  count = Math.min(count, 3);
  if (!mismatches || mismatches.length !== width * height || (mask.length && mask.length !== width * height)) throw new RangeError("invalid_tile_geometry");
  const tiles = [];
  for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) {
    const w = Math.min(tile, width - x), h = Math.min(tile, height - y);
    let mismatch = 0, compared = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const i = row * width + col;
      if (!mask[i]) { compared++; mismatch += mismatches[i]; }
    }
    tiles.push({ x, y, width: w, height: h, mismatch_ratio: compared ? mismatch / compared : 0 });
    tiles.sort((a, b) => b.mismatch_ratio - a.mismatch_ratio || a.y - b.y || a.x - b.x);
    if (tiles.length > count) tiles.pop();
  }
  return tiles.sort((a, b) => b.mismatch_ratio - a.mismatch_ratio || a.y - b.y || a.x - b.x).slice(0, count);
}

export function encodeHeatmap(image, decoder) {
  geometry(image?.heatmap || image);
  return decoder.encode(image.heatmap || image);
}

export function pairCompatibility(build, basis, { reference = false } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!build || typeof build !== "object" || !basis || typeof basis !== "object") return fail("capture_unavailable");
  if (reference) {
    if (!build || basis.viewport !== build.viewport) return fail("viewport_not_captured");
    if (basis.css_width == null) return fail(basis.dpr == null ? "dpr_unknown" : "width_unknown");
    if (basis.dpr == null) return fail("dpr_unknown");
    if (basis.css_width !== build.width) return fail("width_mismatch");
    if (basis.dpr !== build.device_scale_factor) return fail("dpr_mismatch");
  } else if ([build, basis].some((cell) => cell?.stabilized?.treatment?.mask_cap_reached)) return fail("mask_cap_reached");
  return { ok: true, reason: null };
}
export function pageCompatibility(a, b) {
  return a?.truncated || b?.truncated ? { ok: false, reason: "capture_truncated" } : { ok: true, reason: null };
}

function pixelBand(source, band, dpr) {
  const top = Math.floor(band.top * dpr), bottom = Math.ceil((band.top + band.height) * dpr);
  const left = Math.floor((band.left ?? 0) * dpr);
  const right = Math.ceil(((band.left ?? 0) + (band.width ?? source.width / dpr)) * dpr);
  return { top, left, width: right - left, height: bottom - top };
}
function insideCapture(source, band, dpr) {
  const left = band.left ?? 0, width = band.width ?? source.width / dpr;
  return band.top >= 0 && left >= 0
    && (band.top + band.height) * dpr <= source.height && (left + width) * dpr <= source.width;
}
function crop(source, { top, left, width, height }, memory) {
  boundedArea(width, height);
  const image = readRgba(source, memory);
  const data = allocate(width * height * 4, memory);
  for (let row = 0; row < height; row++) data.set(image.data.subarray(((row + top) * image.width + left) * 4,
    ((row + top) * image.width + left + width) * 4), row * width * 4);
  release(image, memory);
  return { width, height, data };
}
export function compareBands(basis, build, { basisSections, buildSections, rectsA = [], rectsB = [], dpr = 1, diff, cap = 40, memory, onComparison } = {}) {
  boundedArea(own(basis, "width"), own(basis, "height")); boundedArea(own(build, "width"), own(build, "height"));
  if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError("invalid_dpr");
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError("invalid_band_cap");
  cap = Math.min(cap, 40);
  maskRects(rectsA); maskRects(rectsB);
  const a = basisSections?.bands || [], b = buildSections?.bands || [];
  if (!Array.isArray(a) || !Array.isArray(b) || [...a, ...b].some((band) => !band || typeof band !== "object")) throw new RangeError("invalid_band_geometry");
  for (const [source, sections] of [[basis, a], [build, b]]) for (const band of sections) {
    const width = band.width ?? source.width / dpr;
    if (![band.top, band.height, band.left ?? 0, width].every(Number.isFinite)) throw new RangeError("invalid_band_geometry");
    // Section boxes are signed, fractional CSS document coordinates. Only
    // non-finite values and over-cap areas refuse the comparison (A-C1).
    if (width > 0 && band.height > 0 && width * dpr * band.height * dpr > VISUAL_MAX_DECODE_PIXELS) throw new RangeError("image_too_large");
  }
  // Repeated bands read fresh images from caller-provided sources (normally
  // capture files). No decoded originals or encoded snapshots are retained.
  if ([basis, build].some((source) => typeof own(source, "load") !== "function" || source.data != null)) throw new RangeError("image_source_required");
  const keys = [...new Set([...a, ...b].map((band) => band.key))].sort();
  const bands = [], members = [];
  const unsupported = (key, reason) => {
    bands.push({ key, status: "unsupported", reason }); members.push({ key, result: "unexercised", reason_code: reason });
  };
  if (!keys.length) members.push({ key: "sections", result: "unexercised", reason_code: "no_section_keys" });
  for (const [index, key] of keys.entries()) {
    const aa = a.filter((band) => band.key === key), bb = b.filter((band) => band.key === key);
    if (index >= cap) { unsupported(key, "band_cap_reached"); continue; }
    if (aa.length > 1 || bb.length > 1 || [basisSections, buildSections].some((s) => s?.duplicated_keys?.includes(key))) { unsupported(key, "section_mapping_duplicate"); continue; }
    if (!aa.length || !bb.length) { unsupported(key, "section_mapping_missing"); continue; }
    const [sa] = aa, [sb] = bb;
    if (sa.height <= 0 || sb.height <= 0 || sa.width <= 0 || sb.width <= 0) { unsupported(key, "section_not_rendered"); continue; }
    if (!insideCapture(basis, sa, dpr) || !insideCapture(build, sb, dpr)) { unsupported(key, "beyond_capture_height"); continue; }
    const pa = pixelBand(basis, sa, dpr), pb = pixelBand(build, sb, dpr);
    if (pa.width <= 0 || pa.height <= 0 || pb.width <= 0 || pb.height <= 0) { unsupported(key, "section_not_rendered"); continue; }
    const relativeRects = (rects, section) => rects.filter((r) => r.y < section.top + section.height && r.y + r.height > section.top)
      .map((r) => ({ ...r, x: r.x - section.left, y: Math.max(0, r.y - section.top), height: Math.min(r.y + r.height, section.top + section.height) - Math.max(r.y, section.top) }));
    const comparison = compareImages(crop(basis, pa, memory), crop(build, pb, memory), { diff, dpr, memory,
      rectsA: relativeRects(rectsA, pa), rectsB: relativeRects(rectsB, pb) });
    Object.assign(comparison, { key, basis: { top: sa.top, height: sa.height }, build: { top: sb.top, height: sb.height } });
    try { onComparison?.(comparison); } finally { releaseComparison(comparison, memory); }
    bands.push(comparison);
  }
  if (basisSections?.capped || buildSections?.capped) members.push({ key: "sections_cap", result: "unexercised", reason_code: "band_cap_reached" });
  bands.sort((a, b) => (b.mismatch_ratio ?? -1) - (a.mismatch_ratio ?? -1)
    || Math.abs(b.height_delta_px || 0) - Math.abs(a.height_delta_px || 0) || a.key.localeCompare(b.key));
  return { bands, members };
}
