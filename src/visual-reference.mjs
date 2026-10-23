import { openSync, readSync, closeSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { readPngStructure, boundedInflate, sha256Hex, VISUAL_MAX_DECODE_PIXELS, VISUAL_MAX_REFERENCE_BYTES } from "./png-header.mjs";

const inside = (root, path) => {
  if (!root || !path) return false;
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
};
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const hash = (bytes) => `sha256:${sha256Hex(bytes)}`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;

export function referenceViewport({ ihdr, scale_factor, width, height } = {}) {
  if (!Number.isFinite(scale_factor) || scale_factor <= 0) return { css_width: null, dpr: null, reason: "dpr_unknown" };
  const w = ihdr?.width_px ?? width;
  return { css_width: Number.isFinite(w) && w > 0 ? w / scale_factor : null,
    dpr: scale_factor, reason: w > 0 ? null : "width_unknown" };
}

// linkedSource is the independently read html_file identity + provenance.
export function classifyProvenance({ path, sourceRoot, targetRepo, kind = "source_screenshot", sha256,
  buildCaptureHashes = [], builtHtmlHashes = [], pageKitTargets = [], linkedSource = null,
  recorded = {}, source_ref_id = own(recorded, "source_ref_id"), captured_at = own(recorded, "captured_at") } = {}) {
  recorded = object(recorded) ? recorded : {};
  const reasons = [];
  const html = kind === "html_file" || kind === "source_html";
  const resolved = path ? real(path) : null;
  const paths = html ? [resolved, sourceRoot ? real(sourceRoot) : null] : [resolved];
  if (targetRepo) {
    if (paths.some((p) => inside(real(resolve(targetRepo, "_site")), p))) reasons.push("path_in_build_output");
    if (paths.some((p) => inside(real(resolve(targetRepo, ".campaign-runtime")), p))) reasons.push("path_in_runtime_dir");
  }
  if (html) {
    if (sha256 && new Set(builtHtmlHashes).has(sha256)) reasons.push("hash_equals_built_html");
    if (resolved && pageKitTargets.some((p) => real(resolve(targetRepo || ".", p)) === resolved)) reasons.push("source_is_campaign_page");
  } else {
    const hex = String(sha256 || "").replace(/^sha256:/, "");
    if (sha256 && (new Set(buildCaptureHashes).has(sha256) || (targetRepo && /^[a-f0-9]{64}$/.test(hex)
        && ["captures", "readability"].some((dir) => existsSync(resolve(targetRepo, `.campaign-runtime/polish/${dir}/${hex}.png`)))))) reasons.push("hash_equals_package_capture");
    if (linkedSource?.provenance?.class === "self_referential") reasons.push("linked_source_self_referential");
  }
  if (reasons.length) return { class: "self_referential", reasons };
  if (!html && !captured_at) reasons.push("capture_time_unrecorded");
  if (!html && (!source_ref_id || !linkedSource || !["html_file", "source_html"].includes(linkedSource.kind))) reasons.push("source_link_missing");
  else {
    const identity = html ? { sha256, sha256_recorded: own(recorded, "sha256") } : own(linkedSource, "identity");
    if (!identity?.sha256) reasons.push(html ? "linked_source_missing" : "linked_source_missing");
    else if (!identity.sha256_recorded) reasons.push("source_hash_unrecorded");
    else if (identity.sha256_recorded !== identity.sha256) reasons.push("source_hash_mismatch");
  }
  return { class: reasons.length ? "unknown" : "declared_source", reasons };
}

function readBounded(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - length));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      chunks.push(chunk.subarray(0, n)); length += n;
    }
    if (length > maxBytes) return null;
    return Buffer.concat(chunks, length);
  } finally { closeSync(fd); }
}

export async function verifyReference({ path, url, recorded = {}, sourceRoot, targetRepo, decoder,
  budget = null, kind = "source_screenshot", ...provenanceInputs } = {}) {
  recorded = object(recorded) ? Object.fromEntries(Object.entries(recorded)) : {};
  let resolved = null;
  const identity = { sha256: null, sha256_recorded: recorded.sha256 ?? null, bytes: null,
    ...Object.fromEntries(["captured_at", "browser", "device_profile", "scale_factor", "width", "height", "source_ref_id"].map((key) => [key, own(recorded, key) ?? null])) };
  const result = { kind, path_rel: path ? relative(targetRepo || sourceRoot || ".", resolve(sourceRoot || ".", path)) : null, url_present: Boolean(url), identity,
    verification: { level: "unverifiable", reason: null, png: null }, css_width: null, dpr: null };
  const finish = (reason, level = "unverifiable") => {
    result.verification.reason = reason; result.verification.level = level;
    result.provenance = classifyProvenance({ ...provenanceInputs, path: resolved, sourceRoot, targetRepo, kind,
      sha256: identity.sha256, recorded });
    return result;
  };
  if (!path) return finish(url ? "remote_not_fetched" : "file_missing");
  try { resolved = realpathSync(resolve(sourceRoot || ".", path)); } catch { return finish("file_missing"); }
  result.path_rel = relative(targetRepo || sourceRoot || ".", resolved);
  if (!inside(real(sourceRoot || "."), resolved)
      && !(targetRepo && ["_site", ".campaign-runtime"].some((dir) => inside(real(resolve(targetRepo, dir)), resolved)))) return finish("path_outside_source_root");
  let bytes;
  try { bytes = readBounded(resolved, VISUAL_MAX_REFERENCE_BYTES); } catch { return finish("file_missing"); }
  if (!bytes) return finish("too_large");
  identity.bytes = bytes.length; identity.sha256 = hash(bytes);
  if (["html_file", "source_html"].includes(kind)) {
    // HTML needs only a successful read/hash for verification. Its declared
    // source hash is a separate provenance member (§5.2), not a decode claim.
    return finish(null, "decoded");
  }
  const structure = readPngStructure(bytes);
  if (!structure.ok) return finish(structure.reason);
  const ihdr = structure.ihdr;
  result.verification.png = ihdr;
  Object.assign(result, referenceViewport({ ihdr, ...recorded }));
  delete result.reason;
  if (ihdr.width_px * ihdr.height_px > VISUAL_MAX_DECODE_PIXELS) return finish("image_too_large");
  const decode = typeof decoder === "function" ? decoder : own(decoder, "decode");
  const available = typeof decode === "function" && (!decoder.status || decoder.status === "available");
  if (available) {
    if (budget && ((typeof budget.remaining === "function" && budget.remaining() <= 0)
        || (Number.isFinite(budget.deadline) && (budget.clock || Date.now)() >= budget.deadline))) return finish("verify_budget_exhausted");
    try {
      boundedInflate(bytes, ihdr);
      const image = await decode(bytes);
      if (image.width !== ihdr.width_px || image.height !== ihdr.height_px) throw new Error("dimensions");
    } catch { return finish("decode_failed"); }
  }
  if (recorded.sha256 && recorded.sha256 !== identity.sha256) return finish("recorded_hash_mismatch");
  if ((recorded.width != null && recorded.width !== ihdr.width_px)
      || (recorded.height != null && recorded.height !== ihdr.height_px)) return finish("recorded_dimensions_mismatch");
  return finish(null, available ? "decoded" : "header_checked");
}
