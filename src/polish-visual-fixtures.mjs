// Synthetic test data only. No browser, source HTML capture or merchant material.
import { deflateSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { crc32, sha256Hex, boundedDimensions, VISUAL_MAX_REFERENCE_BYTES } from "./png-header.mjs";
import { buildCapturesRecord, planVisualCapture, writePolishPng, containedWritePath, VISUAL_VIEWPORTS, VISUAL_MASKS } from "./polish-visual.mjs";

export function pngChunk(type, data = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(data) || data.length > VISUAL_MAX_REFERENCE_BYTES - 12) throw new RangeError("too_large");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 4, "ascii"); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}
export function createRgba(width, height, color = [255, 255, 255, 255]) {
  boundedDimensions(width, height);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}
export function createRgbaPng(width, height, color = [255, 255, 255, 255], { raw = null, idat = null, interlace = 0 } = {}) {
  // Explicit IDAT permits deliberately oversized headers without allocating pixels.
  if (!idat) boundedDimensions(width, height);
  else if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0x7fffffff)) throw new RangeError("image_too_large");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = interlace;
  if (!idat) {
    if (!raw) {
      raw = Buffer.alloc(height * (1 + width * 4));
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(color, y * (1 + width * 4) + 1 + x * 4);
    }
    idat = deflateSync(raw);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND")]);
}
export const syntheticHash = (bytes) => `sha256:${sha256Hex(bytes)}`;
export const syntheticReport = () => ({ stages: { assembly: { build_fingerprint: `sha256:${"a".repeat(64)}` } } });
export function syntheticCapturesRecord(report, { routes = [{ page_id: "page", requested_route: "/page/" }], viewports = VISUAL_VIEWPORTS,
  targetRepo = mkdtempSync(resolve(tmpdir(), "visual-record-")) } = {}) {
  const plan = planVisualCapture({ route_scope: "all", routes, viewports });
  if (!plan) return null;
  const cells = plan.cells.map((cell) => {
    const png = writePolishPng(targetRepo, "captures", createRgbaPng(cell.width, cell.height));
    const shot = { status: "captured", png, full_height_css: cell.height,
      crop: { x: 0, y: 0, width: cell.width, height: cell.height }, truncated: false };
    return { ...cell, source_path_rel: null, source_sha256: null, status: "rendered",
      networkidle: { status: "settled", duration_ms: 0 },
      readiness: { fonts: { status: "settled", failed_faces: 0, waited_ms: 0 }, await: { status: "not_present", remaining_count: 0, waited_ms: 0 } },
      external: cell.side === "source_html" ? { blocked_count: 0, blocked_websocket_count: 0, blocked_origins: [] } : null,
      sections: { status: "no_section_keys", bands: [], duplicated_keys: [], capped: false },
      actual: structuredClone(shot), stabilized: { ...structuredClone(shot), treatment: {
        animations: "disabled", caret: "hide", mask_color: "#ff00ff", mask_selectors: VISUAL_MASKS, masks: [], mask_cap_reached: false } },
      captured_at: "2026-01-01T00:00:00.000Z" };
  });
  return buildCapturesRecord({ buildFingerprint: report.stages.assembly.build_fingerprint, slug: "sample", routes, cells,
    environment: { browser: "chromium/synthetic", device_scale_factor: 1 },
    dependencies: { decoder: { status: "available", version: null }, diff: { status: "available", version: null } },
    measuredAt: "2026-01-01T00:00:00.000Z" });
}

export function syntheticVisualFixture() {
  const targetRepo = mkdtempSync(resolve(tmpdir(), "visual-core-"));
  const sourceRoot = containedWritePath(targetRepo, "source");
  const htmlPath = containedWritePath(targetRepo, "source/page.html");
  mkdirSync(sourceRoot);
  const html = Buffer.from("<!doctype html><p>synthetic source</p>");
  writeFileSync(htmlPath, html);
  const linkedSource = { kind: "html_file", identity: { sha256: syntheticHash(html), sha256_recorded: syntheticHash(html) }, provenance: { class: "declared_source", reasons: [] } };
  return { targetRepo, sourceRoot, linkedSource, report: syntheticReport(),
    recorded: { captured_at: "2026-01-01T00:00:00.000Z", source_ref_id: "html", scale_factor: 1 },
    write(name, bytes) { const path = containedWritePath(sourceRoot, name); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, bytes); return path; },
    cleanup() { rmSync(targetRepo, { recursive: true, force: true }); } };
}
