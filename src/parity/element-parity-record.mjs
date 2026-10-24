// Element parity: the package-owned stages.polish.evidence.visual_review.element_parity
// record, the rules that map a Comparison (src/parity/compare.mjs) to
// parity.element rows, and the reader that re-derives every row on read.
//
// The record holds refs, hashes, identities, side statuses and viewport
// geometry only. Page text, styles, colours, boxes and selector paths live in
// the local probe files (src/parity/snapshot.mjs), which the reader re-hashes;
// no cell status is stored. Rows never change a gate, `next` status or stage.
//
// The registry (src/qc-check-registry.mjs) loads ELEMENT_PARITY_QC_RULES with
// `plan` (planPolishCapture), `readFile` and `readFileForIdentity` (the probe
// file reads) attached, so this module needs neither the capture node nor the
// file module at load. Tests pass the same object with a comparator stand-in
// as `compare` (qcStandIns.polish["parity.element"]).
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { computeDesignSourcePackageMaterialFingerprint } from "../design-source-package.mjs";
import { canonicalJson } from "../polish-capture.mjs";
import { capturesIntegrity } from "../polish-captures-record.mjs";
import {
  PARITY_MAX_ROUTES,
  PARITY_PROBE_CELL_MS,
  PARITY_PROBE_RUN_MS,
  PARITY_PROBE_WALK_MS,
} from "../polish-deadline.mjs";
import { QC_PRODUCERS, QC_REASON, aggregateQcResults, buildQcResult, polishRecordIntegrity, qcResultId } from "../qc-results.mjs";
import { readRegularFileSync } from "../source-html-server.mjs";
import { PARITY_TOLERANCES, compareElementParity } from "./compare.mjs";

export const ELEMENT_PARITY_CHECK = "parity.element";
export const ELEMENT_PARITY_SCHEMA = "campaigns-os-polish-element-parity/v0";
export const ELEMENT_PARITY_PRODUCER = QC_PRODUCERS.polish;
export const PARITY_PROBE_VERSION = "parity-probe/v1";
export const PARITY_PROBE_FILE_SCHEMA = "campaigns-os-parity-probe/v0";
export const PARITY_SNAPSHOT_SCHEMA = "campaigns-os-parity-snapshot/v0";
export const PARITY_VIEWPORTS = Object.freeze(["desktop", "mobile"]);
export const PARITY_LIMITS = Object.freeze({
  routes: PARITY_MAX_ROUTES, elements: 1500, text_chars: 500, page_text_chars: 262144, font_faces: 200,
  walk_ms: PARITY_PROBE_WALK_MS, probe_cell_ms: PARITY_PROBE_CELL_MS, probe_run_ms: PARITY_PROBE_RUN_MS,
});
export const ELEMENT_PARITY_VOCABULARY = Object.freeze({
  probe_status: Object.freeze(["measured", "timeout", "failed", "document_changed", "not_run", "run_budget_exhausted"]),
  viewport: PARITY_VIEWPORTS,
  category: Object.freeze(["copy", "typography", "color", "geometry"]),
  comparison_status: Object.freeze(["compared", "viewport_mismatch", "design_elements_unavailable", "invalid_input"]),
});
// The ProbeOutput coverage conditions, in the order the comparison row names
// the first one present (contract §5.2 coverage table).
export const PARITY_COVERAGE_CONDITIONS = Object.freeze([
  Object.freeze({ reason: "element_cap_reached", present: (c) => c?.elements_capped === true, cap: true }),
  Object.freeze({ reason: "probe_time_cap_reached", present: (c) => c?.time_capped === true, cap: true }),
  Object.freeze({ reason: "page_text_truncated", present: (c) => c?.page_text_truncated === true }),
  Object.freeze({ reason: "closed_shadow_root_not_read", present: (c) => c?.closed_shadow_roots > 0 }),
  Object.freeze({ reason: "frame_not_read", present: (c) => c?.frames_not_read > 0 }),
  Object.freeze({ reason: "font_face_cap_reached", present: (c) => c?.font_faces_capped === true }),
]);
export const FONT_USAGE_LIMIT = "font_usage_not_observed";

const CATEGORY_KEYS = Object.freeze({ copy: "copy", typography: "type", color: "color", geometry: "geom" });
const C_CELL_CODES = Object.freeze(["navigation_failed", "http_error", "run_budget_exhausted", "producer_timeout", "browser_unavailable", "source_html_missing", "source_root_unavailable"]);
const COMPARATOR_STOPS = Object.freeze({ invalid_input: "probe_output_invalid", viewport_mismatch: "viewport_mismatch", design_elements_unavailable: "design_elements_unavailable" });
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const E = QC_REASON.EVIDENCE_NOT_REPRODUCIBLE;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const fingerprint = (value) => typeof value === "string" && FINGERPRINT.test(value);
const sameJson = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
const canonicalTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const firstCodePoints = (value, max) => [...value].slice(0, max).join("");

// ---------------------------------------------------------------------------
// Inputs shared by the producer and the reader

// Whether the packet maps at least one page to source HTML: the applicability
// of parity.element (contract §5.2 silence rule).
export function packetHasMappedPage(packet) {
  return Array.isArray(packet?.source_html?.pages) && packet.source_html.pages.some((page) => isNonEmptyString(page?.path));
}

// The Design Source Package the packet names, read packet-relative as doctor
// and C's capture read it. {status: "ok", value} or {status: "unavailable"}.
export function readDesignSourcePackage(packet, packetPath) {
  const path = packet?.design_source_package?.path;
  if (!isNonEmptyString(path) || !isNonEmptyString(packetPath)) return { status: "unavailable" };
  try {
    const value = JSON.parse(readRegularFileSync(resolve(dirname(packetPath), path)).toString("utf8"));
    return isPlainObject(value) ? { status: "ok", value } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

// Bind CampaignSpec page ids only; source page ids can name another page's surface.
export function dspSurfaceId(dsp, pageId) {
  const surfaces = Array.isArray(dsp?.surface_identity) ? dsp.surface_identity : [];
  const surface = surfaces.find((s) => isPlainObject(s) && isNonEmptyString(s.id)
    && s.mappings?.campaign_spec_page_id === pageId);
  return surface ? surface.id : null;
}

const htmlFunnel = (dsp) => (Array.isArray(dsp?.contributions) ? dsp.contributions : []).find((c) => isPlainObject(c) && c.kind === "html_funnel") || null;

// The sha256 the DSP records for a surface's source-<surface>-html ref, or null.
export function dspRecordedSha(dsp, surfaceId) {
  if (!surfaceId) return null;
  const ref = (Array.isArray(htmlFunnel(dsp)?.source_refs) ? htmlFunnel(dsp).source_refs : [])
    .find((r) => isPlainObject(r) && r.id === `source-${surfaceId}-html`);
  return fingerprint(ref?.sha256) ? ref.sha256 : null;
}

// Whether P1 recorded a design file for the surface (observation only).
export function dspDesignFileRecorded(dsp, surfaceId) {
  if (!surfaceId) return false;
  return (Array.isArray(dsp?.contributions) ? dsp.contributions : []).some((c) => isPlainObject(c)
    && c.provenance?.source_type === "design_file" && Array.isArray(c.mappings) && c.mappings.some((m) => m?.surface_id === surfaceId));
}

// ---------------------------------------------------------------------------
// Producer

const cCell = (captures, side, route, viewport) => (Array.isArray(captures?.cells) ? captures.cells : [])
  .filter((cell) => isPlainObject(cell) && cell.side === side && cell.route === route && cell.viewport === viewport);

// The record of one capture. `run` is the probe run (createParityProbeRun);
// `writeFile(value)` writes one probe file and returns {path, sha256}. The
// grid is the first PARITY_LIMITS.routes plan routes × desktop, mobile,
// route-major; later routes are uncaptured_routes. A side reads `measured`
// with its file ref only when its probe measured and its file was written.
export function buildElementParityRecord({ plan, captures, run, packet, packetPath, buildFingerprint, sourceFingerprint = null,
  writeFile, measuredAt = new Date().toISOString() } = {}) {
  const planned = Array.isArray(plan?.routes) ? plan.routes : [];
  const routes = planned.slice(0, PARITY_LIMITS.routes);
  const dsp = readDesignSourcePackage(packet, packetPath);
  const dspValue = dsp.status === "ok" ? dsp.value : null;
  const sourceFp = fingerprint(sourceFingerprint) ? sourceFingerprint : null;
  const cells = routes.flatMap((route) => PARITY_VIEWPORTS.map((viewport) => {
    const [build] = cCell(captures, "build", route.requested_route, viewport);
    const [source] = cCell(captures, "source_html", route.requested_route, viewport);
    const surfaceId = dspSurfaceId(dspValue, route.page_id);
    const sourceIdentity = {
      source_ref_id: surfaceId ? `source-${surfaceId}-html` : null,
      recorded_sha256: dspRecordedSha(dspValue, surfaceId),
      served_sha256: fingerprint(source?.source_sha256) ? source.source_sha256 : null,
    };
    const side = (name, envelope) => {
      const result = run?.result?.(name, route.requested_route, viewport) ?? null;
      if (!result) return { probe_status: run?.exhausted?.(name, route.requested_route, viewport) ? "run_budget_exhausted" : "not_run", ref: null };
      const status = ["measured", "timeout", "failed", "document_changed"].includes(result.status) ? result.status : "failed";
      if (status !== "measured") return { probe_status: status, ref: null };
      try {
        return { probe_status: "measured", ref: writeFile({ ...envelope, probe: result.value }) };
      } catch (error) {
        return { probe_status: "failed", ref: null, ...(error?.message === "parity_ignore_invalid" ? { failure_reason: "parity_ignore_invalid" } : {}) };
      }
    };
    const identity = { probe_version: PARITY_PROBE_VERSION, page_id: route.page_id, route: route.requested_route, viewport };
    const snapshot = side("source_html", { schema: PARITY_SNAPSHOT_SCHEMA, side: "source_html", ...identity, surface_id: surfaceId,
      source_package_material_fingerprint: sourceFp, source_identity: sourceIdentity });
    const probe = side("build", { schema: PARITY_PROBE_FILE_SCHEMA, side: "build", ...identity, build_fingerprint: buildFingerprint });
    const fixed = viewport === "desktop" ? [1440, 1200] : [390, 844];
    return {
      page_id: route.page_id, surface_id: surfaceId, route: route.requested_route, viewport,
      width: build?.width ?? fixed[0], height: build?.height ?? fixed[1], device_scale_factor: build?.device_scale_factor ?? 1,
      source_html: { probe_status: snapshot.probe_status, snapshot_ref: snapshot.ref, source_identity: sourceIdentity,
        ...(snapshot.failure_reason ? { failure_reason: snapshot.failure_reason } : {}) },
      build: { probe_status: probe.probe_status, probe_ref: probe.ref, ...(probe.failure_reason ? { failure_reason: probe.failure_reason } : {}) },
    };
  }));
  const record = {
    schema_version: ELEMENT_PARITY_SCHEMA,
    performed_by: ELEMENT_PARITY_PRODUCER,
    probe_version: PARITY_PROBE_VERSION,
    subject: {
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: sourceFp,
      campaign_slug: packet?.campaign?.public_route_slug ?? null,
      captures_integrity: captures?.integrity ?? null,
      routes: routes.map((route) => route.requested_route),
      viewports: [...PARITY_VIEWPORTS],
    },
    uncaptured_routes: planned.slice(PARITY_LIMITS.routes).map((route) => route.requested_route),
    tolerances: { ...PARITY_TOLERANCES },
    limits: { ...PARITY_LIMITS },
    cells,
    measured_at: new Date(measuredAt).toISOString(),
  };
  return { ...record, integrity: polishRecordIntegrity(record) };
}

// ---------------------------------------------------------------------------
// Rules: one cell's Comparison → rows

const subjectOf = (page, viewport, key) => ({ check: ELEMENT_PARITY_CHECK, page, viewport, key });
const textSha = (text) => `sha256:${sha256Hex(String(text))}`;

// The element key of a finding: el- and the first 12 hex of the sha256 of its
// canonical design identity.
export function parityElementKey(designIdentity) {
  return `el-${sha256Hex(canonicalJson(designIdentity)).slice(0, 12)}`;
}

function comparisonShapeOk(comparison) {
  if (!isPlainObject(comparison) || !ELEMENT_PARITY_VOCABULARY.comparison_status.includes(comparison.status)) return false;
  if (comparison.status !== "compared") return true;
  const counts = comparison.counts;
  if (!isPlainObject(counts) || !["design", "matched", "unmatched_present", "unmatched_missing"].every((key) => integer(counts[key]))) return false;
  if (!Array.isArray(comparison.findings)) return false;
  const keys = new Set();
  for (const finding of comparison.findings) {
    if (!isPlainObject(finding) || !ELEMENT_PARITY_VOCABULARY.category.includes(finding.category) || !integer(finding.design)
      || !isPlainObject(finding.design_identity) || !Array.isArray(finding.members) || finding.members.length === 0
      || finding.members.some((m) => !isPlainObject(m) || !isNonEmptyString(m.property) || !["warning", "review"].includes(m.result) || !isNonEmptyString(m.reason_code))) return false;
    const key = `${CATEGORY_KEYS[finding.category]}:${parityElementKey(finding.design_identity)}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

// The coverage conditions present on either side of a compared cell:
// {reasons (first present first), members (per side, source_html first), caps}.
export function parityCoverageConditions(designCoverage, buildCoverage) {
  const sides = [["source_html", designCoverage], ["build", buildCoverage]];
  const reasons = PARITY_COVERAGE_CONDITIONS.filter((condition) => sides.some(([, coverage]) => condition.present(coverage))).map((c) => c.reason);
  const members = sides.flatMap(([side, coverage]) => PARITY_COVERAGE_CONDITIONS.filter((condition) => condition.present(coverage))
    .map((condition) => ({ key: `${side}:${condition.reason}`, result: "unexercised", reason_code: condition.reason })));
  const caps = PARITY_COVERAGE_CONDITIONS.filter((condition) => condition.cap && reasons.includes(condition.reason)).map((c) => c.reason);
  return { reasons, members, caps };
}

function elementState(category, members) {
  if (category === "copy") {
    const [copy] = members;
    return { reason_code: copy.reason_code, design_text_sha256: textSha(copy.design ?? ""),
      build_text_sha256: copy.build == null ? null : textSha(copy.build), similarity: copy.delta ?? null };
  }
  const values = members.map(({ property, design = null, build = null, delta = null }) => (category === "geometry"
    ? { property, design, build, delta } : { property, design, build }));
  return { members: category === "typography" ? values.sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : 0)) : values };
}

// One cell's rows from its comparator output (contract §5.2 steps 8 to 10):
// a comparator stop reads `comparison` unexercised with no element rows; a
// compared cell reads `comparison` pass, or unexercised with the first
// coverage condition present, and one row per finding. `design` and `build`
// are the two ProbeOutputs (for labels and selector paths only). A malformed
// or throwing comparator reads comparator_failed.
export function evaluateElementParityCell({ page_id, viewport, design = null, build = null, comparison, compareError = false,
  designFileRecorded = false, measured_at = null } = {}) {
  const comparisonRow = (decision, observation = {}) => buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish",
    subject: subjectOf(page_id, viewport, "comparison"), result: decision.result, reason_code: decision.reason_code ?? null,
    members: decision.members ?? [], accept_eligible: false,
    coverage: decision.coverage ?? { observed: 0, expected: null, limits: [FONT_USAGE_LIMIT, decision.reason_code] },
    state: { reason_code: decision.reason_code ?? null, ...(decision.state ?? {}) }, observation, measured_at });
  if (compareError || !comparisonShapeOk(comparison)) return [comparisonRow({ result: "unexercised", reason_code: "comparator_failed" })];
  if (comparison.status !== "compared") return [comparisonRow({ result: "unexercised", reason_code: COMPARATOR_STOPS[comparison.status] })];
  const conditions = parityCoverageConditions(design?.coverage, build?.coverage);
  const counts = comparison.counts;
  const coverage = { observed: counts.matched + counts.unmatched_present + counts.unmatched_missing, expected: counts.design,
    limits: [FONT_USAGE_LIMIT, ...conditions.reasons] };
  const decision = conditions.reasons.length
    ? { result: "unexercised", reason_code: conditions.reasons[0], members: conditions.members, coverage }
    : { result: "pass", reason_code: null, members: [], coverage };
  const rows = [comparisonRow({ ...decision, state: { counts } }, { basis: "source_html_export", design_file_recorded: designFileRecorded === true,
    drift: isPlainObject(comparison.drift) ? comparison.drift : null, counts })];
  const designElements = new Map((Array.isArray(design?.elements) ? design.elements : []).filter(isPlainObject).map((el) => [el.index, el]));
  const buildElements = new Map((Array.isArray(build?.elements) ? build.elements : []).filter(isPlainObject).map((el) => [el.index, el]));
  for (const finding of comparison.findings) {
    const elementKey = parityElementKey(finding.design_identity);
    const key = `${CATEGORY_KEYS[finding.category]}:${elementKey}`;
    const members = finding.members.map((m) => ({ key: m.property, result: m.result, reason_code: m.reason_code }));
    const caps = conditions.caps.map((reason) => ({ key: "page_coverage", result: "unexercised", reason_code: reason }));
    const aggregated = aggregateQcResults([...members, ...caps]);
    const designText = designElements.get(finding.design)?.text;
    rows.push(buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish", subject: subjectOf(page_id, viewport, key),
      result: aggregated.result, reason_code: aggregated.reason_code, members: aggregated.members,
      coverage: finding.category === "typography" ? { observed: 1, expected: 1, limits: [FONT_USAGE_LIMIT] } : undefined,
      state: elementState(finding.category, finding.members),
      observation: {
        element_key: elementKey,
        design_selector_path: typeof finding.design_identity.selector_path === "string" ? finding.design_identity.selector_path : null,
        build_selector_path: finding.build == null ? null : buildElements.get(finding.build)?.selector_path ?? null,
        label: firstCodePoints(collapse(typeof designText === "string" ? designText : ""), 40),
        basis: "source_html_export",
        design_file_recorded: designFileRecorded === true,
        members: finding.members.map(({ property, design: d = null, build: b = null, delta = null }) => (finding.category === "copy"
          ? { property, delta } : { property, design: d, build: b, delta })),
      },
      measured_at }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Reader (contract §5.2 reader checks and precedence)

const viewportOk = (value) => PARITY_VIEWPORTS.includes(value);
const cellIdentityOk = (cell) => isPlainObject(cell) && isNonEmptyString(cell.page_id) && viewportOk(cell.viewport);
const refOk = (ref) => isPlainObject(ref) && Object.keys(ref).length === 2 && typeof ref.path === "string" && fingerprint(ref.sha256)
  && ref.path === `.campaign-runtime/polish/parity/${ref.sha256.slice(7)}.json`;
const nullableFp = (value) => value === null || fingerprint(value);

// Record-level checks 1 to 5 (every row evidence_not_reproducible): the
// failing check's name, or null.
function recordProblem(record, { packet, campaignSlug, planned, captures, rules }) {
  if (!isPlainObject(record) || record.schema_version !== ELEMENT_PARITY_SCHEMA || record.performed_by !== ELEMENT_PARITY_PRODUCER) return "record_shape_invalid";
  if (record.integrity !== polishRecordIntegrity(record)) return "integrity_mismatch";
  if (!canonicalTime(record.measured_at)) return "record_shape_invalid";
  if (!sameJson(record.tolerances, rules.thresholds) || !sameJson(record.limits, PARITY_LIMITS)) return "limits_changed";
  const subject = record.subject;
  if (!isPlainObject(subject) || !sameJson(subject.viewports, PARITY_VIEWPORTS)) return "record_shape_invalid";
  const slug = packet?.campaign?.public_route_slug;
  if (!isNonEmptyString(slug) || subject.campaign_slug !== slug || (campaignSlug != null && subject.campaign_slug !== campaignSlug)) return "campaign_slug_mismatch";
  if (!fingerprint(subject.build_fingerprint) || !nullableFp(subject.source_package_material_fingerprint) || !fingerprint(subject.captures_integrity)
    || typeof record.probe_version !== "string") return "record_shape_invalid";
  const routes = subject.routes, uncaptured = record.uncaptured_routes;
  if (!Array.isArray(routes) || !routes.every(isNonEmptyString) || !Array.isArray(uncaptured) || !uncaptured.every(isNonEmptyString)) return "record_shape_invalid";
  if (!Array.isArray(record.cells)) return "record_shape_invalid";
  for (const cell of record.cells) {
    if (!cellIdentityOk(cell) || !isNonEmptyString(cell.route) || !(cell.surface_id === null || isNonEmptyString(cell.surface_id))
      || ![cell.width, cell.height, cell.device_scale_factor].every((n) => typeof n === "number" && Number.isFinite(n))
      || !isPlainObject(cell.source_html) || !isPlainObject(cell.build) || !isPlainObject(cell.source_html.source_identity)) return "record_shape_invalid";
    const identity = cell.source_html.source_identity;
    if (!(identity.source_ref_id === null || isNonEmptyString(identity.source_ref_id)) || !nullableFp(identity.recorded_sha256) || !nullableFp(identity.served_sha256)) return "record_shape_invalid";
    for (const [side, refName] of [[cell.source_html, "snapshot_ref"], [cell.build, "probe_ref"]]) {
      if (!ELEMENT_PARITY_VOCABULARY.probe_status.includes(side.probe_status)) return "vocabulary_invalid";
      if (side.probe_status === "measured" ? !refOk(side[refName]) : side[refName] !== null) return "vocabulary_invalid";
    }
  }
  // Grid: disjoint, in plan order, inside the plan; at most 32 captured
  // routes and uncaptured ones only beyond them; cells exactly routes ×
  // viewports, route-major.
  const order = new Map(planned.map((route, index) => [route.requested_route, index]));
  const inPlanOrder = (list) => list.every((route, i) => order.has(route) && (i === 0 || order.get(list[i - 1]) < order.get(route)));
  if (!inPlanOrder(routes) || !inPlanOrder(uncaptured) || routes.some((route) => uncaptured.includes(route))) return "grid_invalid";
  if (routes.length > PARITY_LIMITS.routes || (uncaptured.length > 0 && routes.length !== PARITY_LIMITS.routes)) return "grid_invalid";
  const expected = routes.flatMap((route) => PARITY_VIEWPORTS.map((viewport) => [route, viewport]));
  if (record.cells.length !== expected.length || record.cells.some((cell, i) => cell.route !== expected[i][0] || cell.viewport !== expected[i][1]
    || cell.page_id !== planned[order.get(cell.route)].page_id)) return "grid_invalid";
  // C binding.
  if (!isPlainObject(captures) || captures.integrity !== capturesIntegrity(captures)) return "captures_unverified";
  if (subject.captures_integrity !== captures.integrity) return "captures_integrity_mismatch";
  for (const cell of record.cells) {
    const builds = cCell(captures, "build", cell.route, cell.viewport), sources = cCell(captures, "source_html", cell.route, cell.viewport);
    if (builds.length !== 1 || sources.length !== 1) return "captures_cell_missing";
    if (cell.width !== builds[0].width || cell.height !== builds[0].height || cell.device_scale_factor !== builds[0].device_scale_factor) return "captures_geometry_mismatch";
  }
  return null;
}

// Every row of a record, re-derived on read. `rules` is ELEMENT_PARITY_QC_RULES
// as loaded (with plan, readFile, readFileForIdentity, compare). Never throws.
export function readElementParityRows(context = {}, rules = ELEMENT_PARITY_QC_RULES) {
  const comparisonCache = new Map();
  try {
    return readRows(context, rules, comparisonCache);
  } catch {
    return refusedRecordRows(context, rules, E, "reader_failed", null, comparisonCache);
  }
}

// The fallback may revisit cells already compared before a reader failure.
// Keep successes and failures per cell for this read only.
function compareCell(cell, design, build, { rules, comparisonCache }) {
  if (!comparisonCache.has(cell)) {
    let comparison = null, compareError = false;
    try { comparison = (rules.compare ?? compareElementParity)(design, build); } catch { compareError = true; }
    comparisonCache.set(cell, { comparison, compareError });
  }
  return comparisonCache.get(cell);
}

function plannedRoutes(packet, rules) {
  if (!packet || typeof rules?.plan !== "function") return null;
  try {
    const plan = rules.plan({ packet, baseUrl: "http://127.0.0.1" });
    return Array.isArray(plan?.routes) ? plan.routes : null;
  } catch (error) {
    return error?.code === "no_capturable_routes" ? [] : null;
  }
}

// Rows named only to keep their identities: a refused cell keeps the element
// rows its files name, so an accept lapses instead of orphaning.
function identityRows(cell, env) {
  const { record, targetRepo, rules, measuredAt, qcAccepts } = env;
  // Accepts supply identity only, never evidence or disposition. When a ref
  // or entire cell is gone there may be no bytes from which to reconstruct a
  // finding. Keep those named subjects on refusal so the accept can lapse.
  const retained = (Array.isArray(qcAccepts) ? qcAccepts : []).filter((accept) => accept?.check === ELEMENT_PARITY_CHECK
    && accept.leg === "polish" && accept.subject?.check === ELEMENT_PARITY_CHECK
    && accept.subject.page === cell.page_id && accept.subject.viewport === cell.viewport
    && /^(copy|type|color|geom):el-[a-f0-9]{12}$/.test(accept.subject.key))
    .map((accept) => buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish", subject: subjectOf(cell.page_id, cell.viewport, accept.subject.key),
      result: "unexercised", reason_code: E, accept_eligible: false, state: { reason_code: E }, measured_at: measuredAt ?? null }));
  const keep = (rows = []) => [...new Map([...retained, ...rows].map((row) => [row.id, row])).values()];
  if (typeof rules?.readFileForIdentity !== "function") return retained;
  const design = rules.readFileForIdentity(cell.source_html?.snapshot_ref, targetRepo)?.probe;
  const build = rules.readFileForIdentity(cell.build?.probe_ref, targetRepo)?.probe;
  if (!isPlainObject(design) || !isPlainObject(build)) return retained;
  const { comparison, compareError } = compareCell(cell, design, build, env);
  if (compareError || !comparisonShapeOk(comparison) || comparison.status !== "compared") return retained;
  return keep(evaluateElementParityCell({ page_id: cell.page_id, viewport: cell.viewport, design, build, comparison, measured_at: measuredAt ?? record?.measured_at ?? null })
    .filter((row) => row.subject.key !== "comparison"));
}

const refuseRow = (row, reason, stale) => (stale
  ? { ...row, result: "unexercised", reason_code: reason, accept_eligible: false,
    coverage: { ...row.coverage, limits: [...(row.subject.key.startsWith("type:") ? [FONT_USAGE_LIMIT] : []), reason] } }
  : { ...row, result: "unexercised", reason_code: reason, accept_eligible: false, members: [], observation: {},
    coverage: { observed: 0, expected: null, limits: [...(row.subject.key.startsWith("type:") ? [FONT_USAGE_LIMIT] : []), reason] } });

function refusedCellRows(cell, reason, env, { members = [], result = "unexercised", elements = true } = {}) {
  const measuredAt = canonicalTime(env.record?.measured_at) ? env.record.measured_at : null;
  const comparison = buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish", subject: subjectOf(cell.page_id, cell.viewport, "comparison"),
    result, reason_code: reason, members, accept_eligible: false, state: { reason_code: reason },
    coverage: { observed: 0, expected: null, limits: [FONT_USAGE_LIMIT, reason] }, measured_at: measuredAt });
  if (!elements) return [comparison];
  return [comparison, ...identityRows(cell, env).map((row) => refuseRow(row, reason, reason === QC_REASON.STALE_BINDING))];
}

// Every row of a record that failed a record-level check: the comparison row
// (with the failure as its member for evidence_not_reproducible) and the
// element rows its files/retained accepts name. The expected grid comes from
// the packet plan and record subject even when only some cells survive.
function refusedRecordRows(context, rules, reason, detail = null, planned = null, comparisonCache) {
  const env = { record: context.record, targetRepo: context.targetRepo, rules, qcAccepts: context.qcAccepts, comparisonCache };
  const members = reason === E && detail ? [{ key: "evidence", result: "unexercised", reason_code: detail }] : [];
  const cells = (Array.isArray(context.record?.cells) ? context.record.cells : []).filter(cellIdentityOk);
  const grid = (planned ?? plannedRoutes(context.packet, rules) ?? []).flatMap((route) => PARITY_VIEWPORTS.map((viewport) => ({ page_id: route.page_id, route: route.requested_route, viewport })));
  const targets = [...new Map([...grid, ...cells].map((cell) => [JSON.stringify([cell.page_id, cell.viewport]), cell])).values()];
  const rows = targets.flatMap((cell) => refusedCellRows(cell, reason, env, { members }));
  // Preserve page_not_captured identities as well when the record names an
  // uncaptured part of the plan; all rows share the record-level refusal.
  for (const cell of grid) if (Array.isArray(context.record?.subject?.routes) && !context.record.subject.routes.includes(cell.route)) {
    rows.push(buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish", subject: subjectOf(cell.page_id, cell.viewport, "cell"),
      result: "unexercised", reason_code: reason, members, state: { reason_code: reason }, accept_eligible: false,
      coverage: { observed: 0, expected: null, limits: [reason] }, measured_at: null }));
  }
  if (!rows.length) {
    rows.push(buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish", subject: { check: ELEMENT_PARITY_CHECK, page: null, key: "element_parity" },
      result: "unexercised", reason_code: reason, members, state: { reason_code: reason }, measured_at: null,
      coverage: { observed: 0, expected: null, limits: [FONT_USAGE_LIMIT, reason] } }));
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function readRows(context, rules, comparisonCache) {
  const { record, captures, packet, packetPath, currentBuild, currentSource, buildOutput, campaignSlug, targetRepo } = context;
  const planned = plannedRoutes(packet, rules);
  const refuseRecord = (reason, detail = null) => refusedRecordRows(context, rules, reason, detail, planned, comparisonCache);
  if (!packet) return refuseRecord(E, "packet_unavailable");
  if (!planned) return refuseRecord(E, "packet_plan_invalid");
  if (!isPlainObject(rules) || typeof rules.readFile !== "function" || typeof rules.evaluate !== "function") {
    return refuseRecord(E, "rules_unavailable");
  }
  const problem = recordProblem(record, { packet, campaignSlug, planned, captures, rules });
  if (problem) return refuseRecord(E, problem);
  if (record.probe_version !== PARITY_PROBE_VERSION) return refuseRecord("not_captured_by_this_version");
  const measuredAt = record.measured_at;
  const env = { record, targetRepo, rules, measuredAt, qcAccepts: context.qcAccepts, comparisonCache };
  const stale = record.subject.build_fingerprint !== currentBuild
    || record.subject.source_package_material_fingerprint !== (currentSource || null)
    || (buildOutput !== undefined && buildOutput?.status !== "pass");
  if (stale) return refuseRecord(QC_REASON.STALE_BINDING);

  const rows = [];
  const dsp = readDesignSourcePackage(packet, packetPath);
  let dspReason = null;
  if (dsp.status !== "ok") dspReason = "source_package_unavailable";
  else {
    try { if (computeDesignSourcePackageMaterialFingerprint(dsp.value) !== currentSource) dspReason = "source_package_stale"; }
    catch { dspReason = "source_package_stale"; }
  }
  // Planned routes this record did not capture (uncaptured_routes, or added
  // to the plan since): one cell row per viewport.
  for (const route of planned) {
    if (record.subject.routes.includes(route.requested_route)) continue;
    for (const viewport of PARITY_VIEWPORTS) {
      const subject = subjectOf(route.page_id, viewport, "cell");
      rows.push(buildQcResult({ check: ELEMENT_PARITY_CHECK, leg: "polish", subject, result: "unexercised", reason_code: "page_not_captured",
        state: { route: route.requested_route }, observation: { route: route.requested_route }, accept_eligible: false,
        coverage: { observed: 0, expected: 1, limits: ["page_not_captured"] }, measured_at: measuredAt }));
    }
  }
  for (const cell of record.cells) {
    if (dspReason) { rows.push(...refusedCellRows(cell, dspReason, env)); continue; }
    rows.push(...cellRows(cell, { ...env, captures, dsp: dsp.value }));
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

// Steps 6 to 10 for one cell of a record that passed every record-level check.
function cellRows(cell, env) {
  const { record, captures, dsp, targetRepo, rules } = env;
  const refuse = (reason, options) => refusedCellRows(cell, reason, env, options);
  const sides = [["source_html", cell.source_html.snapshot_ref], ["build", cell.build.probe_ref]];
  // a, b: each referenced file, source side first.
  const files = {};
  for (const [side, ref] of sides) if (ref) files[side] = rules.readFile(ref, targetRepo);
  if (sides.some(([side]) => files[side]?.status === "absent")) return refuse("probe_file_absent");
  if (sides.some(([side]) => files[side] && files[side].status !== "ok")) return refuse(E, { members: [{ key: "evidence", result: "unexercised", reason_code: "probe_file_invalid" }] });
  const snapshot = files.source_html?.value, probe = files.build?.value;
  // c: envelopes.
  const envelopeOk = (value, side, schema) => isPlainObject(value) && value.schema === schema && value.side === side
    && value.probe_version === PARITY_PROBE_VERSION && value.page_id === cell.page_id && value.route === cell.route && value.viewport === cell.viewport;
  if ((snapshot !== undefined && (!envelopeOk(snapshot, "source_html", PARITY_SNAPSHOT_SCHEMA) || snapshot.surface_id !== cell.surface_id))
    || (probe !== undefined && !envelopeOk(probe, "build", PARITY_PROBE_FILE_SCHEMA))) {
    return refuse(E, { members: [{ key: "evidence", result: "unexercised", reason_code: "probe_envelope_mismatch" }] });
  }
  // d: authoritative identities.
  const identity = cell.source_html.source_identity;
  const surfaceId = dspSurfaceId(dsp, cell.page_id);
  const [cSource] = cCell(captures, "source_html", cell.route, cell.viewport);
  const [cBuild] = cCell(captures, "build", cell.route, cell.viewport);
  const served = fingerprint(cSource.source_sha256) ? cSource.source_sha256 : null;
  if ((probe !== undefined && probe.build_fingerprint !== record.subject.build_fingerprint)
    || (snapshot !== undefined && (snapshot.source_package_material_fingerprint !== record.subject.source_package_material_fingerprint
      || !sameJson(snapshot.source_identity, identity)))
    || cell.surface_id !== surfaceId || identity.source_ref_id !== (surfaceId ? `source-${surfaceId}-html` : null)
    || identity.recorded_sha256 !== dspRecordedSha(dsp, surfaceId) || identity.served_sha256 !== served) {
    return refuse(E, { members: [{ key: "evidence", result: "unexercised", reason_code: "source_identity_unbound" }] });
  }
  // Step 7: the closed translation, source side before build side.
  const cellsBySide = [["source_html", cSource, cell.source_html], ["build", cBuild, cell.build]];
  for (const [, cCellValue] of cellsBySide) {
    if (cCellValue.status !== "rendered") return refuse(C_CELL_CODES.includes(cCellValue.status) ? cCellValue.status : "navigation_failed");
  }
  const recorded = dspRecordedSha(dsp, surfaceId);
  if (recorded === null) return refuse("source_identity_unrecorded");
  if (served !== recorded) return refuse("source_identity_mismatch", { result: "review", elements: false });
  const readiness = cellsBySide.flatMap(([side, c]) => [
    ...(c.readiness?.fonts?.status !== "settled" ? [{ key: `${side}:fonts`, result: "unexercised", reason_code: "readiness_timeout" }] : []),
    ...(!["settled", "not_present"].includes(c.readiness?.await?.status) ? [{ key: `${side}:await`, result: "unexercised", reason_code: "readiness_timeout" }] : []),
  ]);
  if (readiness.length) return refuse("readiness_incomplete", { members: readiness });
  for (const [status, reason] of [["run_budget_exhausted", "run_budget_exhausted"], ["not_run", "probe_not_run"]]) {
    if (cellsBySide.some(([, , p]) => p.probe_status === status)) return refuse(reason);
  }
  for (const [, , p] of cellsBySide) {
    if (p.probe_status === "measured") continue;
    return refuse(p.probe_status === "timeout" ? "probe_timeout" : p.probe_status === "document_changed" ? "document_changed" : "probe_failed");
  }
  // Steps 8 to 10.
  const design = snapshot.probe, build = probe.probe;
  const { comparison, compareError } = compareCell(cell, design, build, env);
  const designOk = isPlainObject(design), buildOk = isPlainObject(build);
  return rules.evaluate({ page_id: cell.page_id, viewport: cell.viewport, design: designOk ? design : null, build: buildOk ? build : null,
    comparison, compareError, designFileRecorded: dspDesignFileRecorded(dsp, surfaceId), measured_at: record.measured_at });
}

export const ELEMENT_PARITY_QC_RULES = Object.freeze({
  thresholds: PARITY_TOLERANCES,
  vocabulary: ELEMENT_PARITY_VOCABULARY,
  limits: PARITY_LIMITS,
  viewports: PARITY_VIEWPORTS,
  schema_version: ELEMENT_PARITY_SCHEMA,
  probe_version: PARITY_PROBE_VERSION,
  evaluate: evaluateElementParityCell,
  compare: compareElementParity,
  read: readElementParityRows,
  applies: packetHasMappedPage,
  rowKeys: (rows) => (Array.isArray(rows) ? rows.map((row) => qcResultId(row?.subject)) : []),
});
