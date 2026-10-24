import { createHash } from "node:crypto";
import { canonicalJson } from "./polish-capture.mjs";

export const CAPTURES_SCHEMA = "campaigns-os-polish-captures/v0";
export const CAPTURES_PRODUCER = "campaigns-os polish capture";
const object = (value) => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const viewports = new Map([["desktop", [1440, 1200]], ["mobile", [390, 844]]]);
export function capturesIntegrity(record) {
  const { integrity: _ignored, ...rest } = record || {};
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

// A-C4: one actual build capture per planned route; either viewport may supply it.
export function capturedBuildForEveryRoute(record) {
  const routes = record?.subject?.routes;
  return Array.isArray(routes) && routes.length > 0 && Array.isArray(record?.cells)
    && routes.every((route) => {
      const path = typeof route === "string" ? route : own(route, "requested_route") ?? own(route, "route");
      return typeof path === "string" && record.cells.some((cell) => object(cell) && cell.side === "build"
        && cell.route === path && (typeof route === "string" || cell.page_id === route.page_id)
        && cell.status === "rendered" && cell.actual?.status === "captured");
    });
}

// Data only: ignored PNG files are deliberately not opened by the gate.
export function packageCapturesSatisfy(record, report) {
  if (!record || Object.getPrototypeOf(record) !== Object.prototype
      || record.schema_version !== CAPTURES_SCHEMA || record.performed_by !== CAPTURES_PRODUCER
      || record.integrity !== capturesIntegrity(record)
      || !record.subject?.build_fingerprint
      || record.subject.build_fingerprint !== report?.stages?.assembly?.build_fingerprint
      || !Array.isArray(record.cells) || !record.cells.length) return false;
  return capturedBuildForEveryRoute(record) && record.cells.every((cell) => {
    if (!object(cell)) return false;
    const viewport = viewports.get(own(cell, "viewport"));
    if (cell.state !== "default_load" || cell.device_scale_factor !== 1
        || !viewport || cell.width !== viewport[0] || cell.height !== viewport[1]) return false;
    return [cell.actual, cell.stabilized].every((shot) => {
      if (!object(shot)) return false;
      if (shot.status !== "captured") return ["skipped", "failed", "timeout"].includes(own(shot, "status"));
      const crop = shot.crop;
      return Number.isFinite(shot.full_height_css) && shot.full_height_css > 0
        && crop?.x === 0 && crop.y === 0 && crop.width === cell.width
        && crop.height === Math.min(shot.full_height_css, 12000)
        && shot.truncated === (shot.full_height_css > 12000)
        && shot.png?.width_px === crop.width && shot.png.height_px === crop.height
        && /^sha256:[a-f0-9]{64}$/.test(shot.png.sha256);
    });
  });
}
