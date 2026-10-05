// Readability: the sibling stages.polish.evidence.visual_review.readability
// record and the rules every reader re-derives its results with.
//
// The record holds measurements only. Its results are never stored: readers
// (src/qc-results.mjs readReadability) check the record, re-derive every
// stored element through the shared contrast helper, then call
// READABILITY_QC_RULES.evaluate on each cell (reached through
// src/qc-check-registry.mjs).
//
// Per cell (one built route × viewport):
// - cell_status: "measured", or why the cell measured nothing;
// - capped: the probe stopped at the per-cell element cap;
// - elements[]: every text-bearing element the probe read, and every role
//   element whose text did not render (rendered: false). A disabled control
//   carries no colour fields (it is listed before any colour is read); every
//   other element carries its raw computed colours, font size and weight, and
//   the fields the helper derives from them;
// - coverage_gaps[]: what the probe could not measure: closed shadow roots,
//   cross-origin frames, loading, hidden or generated-text role elements, and
//   selected, active or expanded states not present at load.
import { relative, sep } from "node:path";

import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import { CART_PLACEHOLDERS_LIMITS } from "./cart-placeholders.mjs";
import { contrastToolkit } from "./contrast.mjs";
import { MAX_POLISH_CAPTURE_ROUTES, POLISH_CAPTURE_VIEWPORTS } from "./polish-node.mjs";
import { QC_PRODUCERS, aggregateQcResults } from "./qc-results.mjs";

export const READABILITY_CHECK = "readability.contrast";
export const READABILITY_SCHEMA = "campaigns-os-polish-readability/v0";
export const READABILITY_PRODUCER = QC_PRODUCERS.polish;
export const READABILITY_ROUTE_SOURCE = "built_site";

const toolkit = contrastToolkit();
export const READABILITY_HELPER_VERSION = toolkit.version;

export const READABILITY_THRESHOLDS = Object.freeze({
  normal: toolkit.requiredRatio(false),
  large: toolkit.requiredRatio(true),
  large_px: 24,
  large_bold_px: 18.66,
  large_bold_weight: 700,
});

// Text-bearing roles, in the order the first matching one is taken.
export const READABILITY_ROLES = Object.freeze([
  "add_to_cart",
  "upsell_accept",
  "upsell_decline",
  "submit_control",
  "sdk_action",
  "bundle_card",
  "order_bump",
  "price",
  "checkout_label",
  "checkout_hint",
  "body_text",
]);

export const READABILITY_VOCABULARY = Object.freeze({
  cell_status: Object.freeze(["measured", "navigation_failed", "probe_timeout", "document_changed", "styles_incomplete", "fonts_pending", "sdk_not_ready", "run_budget_exhausted", "producer_timeout"]),
  coverage_gap: Object.freeze(["closed_shadow_root", "cross_origin_text", "control_loading", "state_not_observed", "not_visible_at_load", "generated_text"]),
  role: READABILITY_ROLES,
  state: Object.freeze(["selected", "active", "expanded", "default"]),
  size_class: Object.freeze(["normal", "large"]),
  review_reason: Object.freeze(["background_gradient", "background_image", "pseudo_element_background", "overlapping_layer", "opacity", "filter", "blend_mode", "text_fill_background", "unparseable_color", "canvas_unknown", "disabled_state_uncertain", "mask"]),
  crop_reason: Object.freeze(["outside_viewport", "crop_unavailable"]),
});

// Crops live under the target repo, named by the sha256 of their bytes.
export const READABILITY_CROP_DIR = ".campaign-runtime/polish/readability";
const CROP_PATH = /^\.campaign-runtime\/polish\/readability\/([a-f0-9]{64})\.png$/;
const CROP_SHA = /^sha256:([a-f0-9]{64})$/;

// The fixed viewport keys and the record's limits. Read when called, not at
// load, so the capture modules this one imports may import it in turn.
export const readabilityViewports = () => POLISH_CAPTURE_VIEWPORTS.map((viewport) => viewport.key);

export function readabilityLimits() {
  return Object.freeze({
    elements_per_cell: 2000,
    crops_per_cell: 40,
    probe_ms_per_cell: 1500,
    probe_ms_per_run: 120_000,
    crop_ms_per_run: 30_000,
    added_ms_per_run: 300_000,
    routes: MAX_POLISH_CAPTURE_ROUTES,
    route_enumeration: CART_PLACEHOLDERS_LIMITS.pages,
  });
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const inVocabulary = (field, value) => READABILITY_VOCABULARY[field].includes(value);
const isSrgb = (value) => Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === "number" && c >= 0 && c <= 1);
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function invalid(message) {
  throw new TypeError(`readability cell ${message}.`);
}

// ---------------------------------------------------------------------------
// Routes

// The readability route set: every .html under _site/<slug>/ (entries
// prefixed _ or . skipped), as public routes (index.html → /<slug>/<dir>/,
// any other file → /<slug>/<path>), sorted. The first 500 are enumerated;
// the first 128 of those are captured and the rest listed as uncaptured.
export function readabilityRoutes(targetRepo, slug) {
  if (!isNonEmptyString(slug)) return { ok: false, error: "no campaign slug", routes: [], uncaptured_routes: [], route_enumeration_capped: false };
  const scope = resolveBuiltSiteScope(targetRepo, { slug });
  if (!scope.ok) return { ok: false, error: scope.error, routes: [], uncaptured_routes: [], route_enumeration_capped: false };
  const limits = readabilityLimits();
  const all = scope.pages.map((page) => {
    const rel = relative(scope.campaign_dir, page.built_path).split(sep).join("/");
    if (rel === "index.html") return `/${slug}/`;
    if (rel.endsWith("/index.html")) return `/${slug}/${rel.slice(0, -"index.html".length)}`;
    return `/${slug}/${rel}`;
  }).sort(byCodeUnit);
  const enumerated = all.slice(0, limits.route_enumeration);
  return {
    ok: true,
    routes: enumerated.slice(0, limits.routes),
    uncaptured_routes: enumerated.slice(limits.routes),
    route_enumeration_capped: all.length > limits.route_enumeration,
  };
}

// ---------------------------------------------------------------------------
// Pair key

// 8-digit hex (rrggbbaa) of an opaque gamma-encoded sRGB colour.
const hex8 = (rgb) => `${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}ff`;

// The pair row key of a measured element: its composited foreground and its
// background as 8-digit hex, and its size class. Used for grouping only; the
// accept state holds the exact values.
export function readabilityPairKey({ fg_srgb, bg_srgb, size_class }) {
  return `pair:${hex8(fg_srgb)}/${hex8(bg_srgb)}:${size_class}`;
}

// The pair keys an element can be identified by: the key of the fields the
// helper derives from its raw colours and font (with the helper's fixed
// thresholds), and the key of its stored derived fields when they differ.
function elementPairKeys(element) {
  const keys = [];
  try {
    const derived = toolkit.deriveElementMeasurement({
      fg_raw: element.fg_raw,
      fill_raw: element.fill_raw,
      bg_layers_raw: element.bg_layers_raw,
      font_size_px: element.font_size_px,
      font_weight: element.font_weight,
    });
    if (isSrgb(derived.fg_srgb) && isSrgb(derived.bg_srgb)) keys.push(readabilityPairKey(derived));
  } catch {
    // Raw fields the helper cannot read name no pair.
  }
  if (isSrgb(element.fg_srgb) && isSrgb(element.bg_srgb) && inVocabulary("size_class", element.size_class)) keys.push(readabilityPairKey(element));
  return keys;
}

// The row keys a cell names, read without the record's thresholds and
// without checking the cell: for each element, every row its fields can
// name (its flags, its review reason and its pair keys from elementPairKeys,
// together; no field hides another's row), each coverage gap, and `cell`. A
// reader names the rows of a cell that fails its checks with these, so an
// accept of one of them lapses rather than orphans. Never throws.
export function readabilityRowKeys(cell) {
  const keys = new Set(["cell"]);
  const elements = isPlainObject(cell) && Array.isArray(cell.elements) ? cell.elements.filter(isPlainObject) : [];
  const gaps = isPlainObject(cell) && Array.isArray(cell.coverage_gaps) ? cell.coverage_gaps.filter(isPlainObject) : [];
  for (const element of elements) {
    if (element.disabled === true) keys.add("inactive_control");
    if (element.rendered === false && isNonEmptyString(element.role)) keys.add(`role:${element.role}:coverage`);
    if (isNonEmptyString(element.review_reason)) {
      if (element.role === "body_text") keys.add("review:body_text:non_solid");
      else if (isNonEmptyString(element.role)) keys.add(`review:${element.role}:${element.review_reason}`);
    }
    for (const key of elementPairKeys(element)) keys.add(key);
  }
  for (const gap of gaps) {
    if (gap.reason === "closed_shadow_root" || gap.reason === "cross_origin_text") keys.add(`gap:${gap.reason}`);
    else if (gap.reason === "state_not_observed" && gap.role === null) keys.add("state:expanded:coverage");
    else if (isNonEmptyString(gap.role)) keys.add(`role:${gap.role}:coverage`);
  }
  return [...keys].sort(byCodeUnit);
}

// ---------------------------------------------------------------------------
// Rules

const sameThresholds = (thresholds) => isPlainObject(thresholds)
  && Object.keys(READABILITY_THRESHOLDS).length === Object.keys(thresholds).length
  && Object.entries(READABILITY_THRESHOLDS).every(([field, value]) => thresholds[field] === value);

function checkElement(element) {
  if (!isPlainObject(element)) invalid("element is not an object");
  if (!inVocabulary("role", element.role)) invalid("element role is not in the vocabulary");
  if (!isNonEmptyString(element.selector_path)) invalid("element has no selector_path");
  if (!inVocabulary("state", element.state)) invalid("element state is not in the vocabulary");
  if (typeof element.disabled !== "boolean" || typeof element.rendered !== "boolean") invalid("element disabled or rendered is not a boolean");
  if (!Number.isFinite(element.font_size_px) || !Number.isFinite(element.font_weight)) invalid("element has no font size or weight");
  if (!inVocabulary("size_class", element.size_class)) invalid("element size_class is not in the vocabulary");
  if (element.review_reason !== null && !inVocabulary("review_reason", element.review_reason)) invalid("element review_reason is not in the vocabulary");
  if (element.crop_reason !== null && !inVocabulary("crop_reason", element.crop_reason)) invalid("element crop_reason is not in the vocabulary");
  if (element.crop_ref !== null && !cropRefShapeOk(element.crop_ref)) invalid("element crop_ref is not {path, sha256}");
}

// A crop reference names its file by the sha256 of its bytes.
export function cropRefShapeOk(ref) {
  if (!isPlainObject(ref) || Object.keys(ref).length !== 2 || typeof ref.path !== "string" || typeof ref.sha256 !== "string") return false;
  const path = CROP_PATH.exec(ref.path);
  const sha = CROP_SHA.exec(ref.sha256);
  return Boolean(path && sha && path[1] === sha[1]);
}

function checkGap(gap) {
  if (!isPlainObject(gap)) invalid("coverage gap is not an object");
  if (!inVocabulary("coverage_gap", gap.reason)) invalid("coverage gap reason is not in the vocabulary");
  if (gap.role !== null && !inVocabulary("role", gap.role)) invalid("coverage gap role is not in the vocabulary");
  if (gap.selector_path !== null && !isNonEmptyString(gap.selector_path)) invalid("coverage gap selector_path is not a string or null");
}

// The cell vocabulary every reader checks before it evaluates anything.
export function readabilityCellShapeOk(cell) {
  try {
    if (!isPlainObject(cell) || !isNonEmptyString(cell.route) || !isNonEmptyString(cell.viewport)) return false;
    if (cell.page_load_integrity !== null && !isNonEmptyString(cell.page_load_integrity)) return false;
    if (!inVocabulary("cell_status", cell.cell_status) || typeof cell.capped !== "boolean") return false;
    if (!Array.isArray(cell.coverage_gaps) || !Array.isArray(cell.elements)) return false;
    cell.coverage_gaps.forEach(checkGap);
    cell.elements.forEach(checkElement);
    return true;
  } catch {
    return false;
  }
}

const unique = (list) => [...new Set(list)];
const sortedUnique = (entries) => unique(entries.map((entry) => JSON.stringify(entry))).sort(byCodeUnit).map((text) => JSON.parse(text));
const STATE_GAP_ROLES = new Set(["bundle_card", "order_bump"]);

// Whether a row that has a crop due has a usable one: no member's due crop
// failed, every crop reference resolves (cropAvailable), and at least one
// member records a crop or why it has none.
function cropProblem(elements, cropAvailable) {
  if (elements.some((element) => element.crop_reason === "crop_unavailable")) return true;
  if (elements.some((element) => element.crop_ref !== null && !cropAvailable(element.crop_ref))) return true;
  return elements.every((element) => element.crop_ref === null && element.crop_reason === null);
}

// The results of one readability cell, judged with `thresholds`, one per
// row key (contract result table): `pair:<fg8>/<bg8>:<size_class>` per
// colour pair and size class, `review:<role>:<reason>` per role and review
// trigger (every body_text review member in one `review:body_text:non_solid`
// row), `role:<role>:coverage` per role with unmeasured elements,
// `state:expanded:coverage`, `gap:<reason>`, `inactive_control`, and `cell`
// for a cell that measured nothing. A capped cell adds the page_coverage
// member to every row (the inactive_control row stays excluded); a warning
// or review row whose crop is not usable
// (`cropAvailable(crop_ref)` false for a recorded crop) adds the crop member.
// Either member makes the row accept-ineligible.
export function evaluateReadability(cell, thresholds = READABILITY_THRESHOLDS, { cropAvailable = () => false } = {}) {
  if (!isPlainObject(cell)) invalid("is not an object");
  if (!sameThresholds(thresholds)) invalid("thresholds are not the 2.4 thresholds");
  if (!readabilityCellShapeOk(cell)) invalid("is not in the record vocabulary");
  const capReason = cell.capped ? "element_cap_reached" : null;
  const results = [];
  // An excluded row (inactive controls) stays excluded in a capped cell: it
  // carries the page_coverage member, but the cap does not decide its result.
  const push = (key, members, { state, observation = {}, crop = null, reasonCode = null, excluded = false }) => {
    const extra = crop && cropProblem(crop, cropAvailable) ? [{ key: "crop", result: "unexercised", reason_code: "crop_unavailable" }] : [];
    const aggregated = excluded
      ? { ...aggregateQcResults(members), members: aggregateQcResults(members, { capReason }).members }
      : aggregateQcResults([...members, ...extra], { capReason });
    const result = aggregated.result;
    const reason = result === "pass" ? null : reasonCode && result === "review" ? reasonCode : aggregated.reason_code;
    results.push({
      check: READABILITY_CHECK,
      subject: { check: READABILITY_CHECK, page: cell.route, viewport: cell.viewport, key },
      result,
      reason_code: reason,
      members: aggregated.members,
      accept_eligible: aggregated.accept_eligible,
      coverage: result === "unexercised" ? { observed: 0, expected: 1, limits: [reason] } : { observed: 1, expected: 1, limits: [] },
      state,
      observation,
    });
  };

  if (cell.cell_status !== "measured") {
    push("cell", [{ key: "cell_status", result: "unexercised", reason_code: cell.cell_status }], { state: { reason_code: cell.cell_status } });
    return results;
  }

  const pairs = new Map();
  const reviews = new Map();
  const bodyReview = [];
  const coverage = new Map();
  const expanded = [];
  const gaps = new Map();
  const inactive = [];
  const addTo = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
  for (const element of cell.elements) {
    if (element.disabled) inactive.push(element);
    else if (!element.rendered) addTo(coverage, element.role, { key: element.selector_path, result: "unexercised", reason_code: "text_not_rendered" });
    else if (element.review_reason !== null) {
      if (element.role === "body_text") bodyReview.push(element);
      else addTo(reviews, `review:${element.role}:${element.review_reason}`, element);
    } else {
      if (!Number.isFinite(element.ratio) || !isSrgb(element.fg_srgb) || !isSrgb(element.bg_srgb) || !Number.isFinite(element.required)) invalid("measured element has no ratio");
      addTo(pairs, readabilityPairKey(element), element);
    }
  }
  for (const gap of cell.coverage_gaps) {
    const member = { key: gap.selector_path ?? gap.reason, result: "unexercised", reason_code: gap.reason };
    if (gap.reason === "closed_shadow_root" || gap.reason === "cross_origin_text") addTo(gaps, gap.reason, member);
    else if (gap.reason === "state_not_observed" && gap.role === null) expanded.push(member);
    else if (gap.reason === "state_not_observed" && !STATE_GAP_ROLES.has(gap.role)) invalid("state_not_observed gap names a role without selection states");
    else if (gap.role === null) invalid(`${gap.reason} gap names no role`);
    else addTo(coverage, gap.role, member);
  }

  for (const key of [...pairs.keys()].sort(byCodeUnit)) {
    const elements = pairs.get(key);
    const [{ size_class: sizeClass, required }] = elements;
    const members = elements.map((element) => {
      const meets = toolkit.meetsRequirement(element.ratio, element.required);
      return { key: element.selector_path, result: meets ? "pass" : "warning", reason_code: meets ? null : "low_contrast" };
    });
    const warning = members.some((member) => member.result === "warning");
    const minimum = Math.min(...elements.map((element) => element.ratio));
    push(key, members, {
      crop: warning ? elements : null,
      state: {
        size_class: sizeClass,
        required,
        members: sortedUnique(elements.map(({ fg_srgb, bg_srgb, ratio, font_size_px, font_weight }) => ({ fg_srgb, bg_srgb, ratio, font_size_px, font_weight }))),
      },
      observation: {
        roles: unique(elements.map((element) => element.role)).sort(byCodeUnit),
        fg8: key.slice("pair:".length, "pair:".length + 8),
        bg8: key.slice("pair:".length + 9, "pair:".length + 17),
        ratio: minimum,
        display_ratio: toolkit.displayRatio(minimum),
        required,
        size_class: sizeClass,
        members: elements.map(({ role, selector_path, state, ratio, font_size_px, font_weight, crop_ref }) => ({ role, selector_path, state, ratio, font_size_px, font_weight, crop_ref })),
      },
    });
  }
  const reviewRow = (key, elements, reasonCode = null) => push(key, elements.map((element) => ({ key: element.selector_path, result: "review", reason_code: element.review_reason })), {
    crop: elements,
    reasonCode,
    state: {
      reason_code: reasonCode ?? elements[0].review_reason,
      members: sortedUnique(elements.map(({ selector_path, review_reason, fg_raw, fill_raw, bg_layers_raw, font_size_px, font_weight }) => ({ selector_path, review_reason, fg_raw, fill_raw, bg_layers_raw, font_size_px, font_weight }))),
    },
    observation: { members: elements.map(({ role, selector_path, state, review_reason, crop_ref }) => ({ role, selector_path, state, review_reason, crop_ref })) },
  });
  for (const key of [...reviews.keys()].sort(byCodeUnit)) reviewRow(key, reviews.get(key));
  if (bodyReview.length) reviewRow("review:body_text:non_solid", bodyReview, "non_solid_background");
  const coverageRow = (key, members, { excluded = false } = {}) => push(key, members, { state: { members: sortedUnique(members) }, observation: { members }, excluded });
  for (const role of [...coverage.keys()].sort(byCodeUnit)) coverageRow(`role:${role}:coverage`, coverage.get(role));
  if (expanded.length) coverageRow("state:expanded:coverage", expanded);
  for (const reason of [...gaps.keys()].sort(byCodeUnit)) coverageRow(`gap:${reason}`, gaps.get(reason));
  if (inactive.length) coverageRow("inactive_control", inactive.map((element) => ({ key: element.selector_path, result: "excluded", reason_code: "inactive_control" })), { excluded: true });
  if (!cell.elements.some((element) => element.rendered)) {
    push("cell", [{ key: "elements", result: "unexercised", reason_code: "no_text_measured" }], { state: { reason_code: "no_text_measured" } });
  }
  return results;
}

// The 2.4 rules the QC reader re-derives with (src/qc-check-registry.mjs).
// Besides the Polish rules contract it carries the fixed producer values,
// the record limits and the route set, all of which the reader checks.
export const READABILITY_QC_RULES = Object.freeze({
  thresholds: READABILITY_THRESHOLDS,
  vocabulary: READABILITY_VOCABULARY,
  evaluate: evaluateReadability,
  schema_version: READABILITY_SCHEMA,
  helper_version: READABILITY_HELPER_VERSION,
  route_source: READABILITY_ROUTE_SOURCE,
  routes: readabilityRoutes,
  rowKeys: readabilityRowKeys,
  cellShapeOk: readabilityCellShapeOk,
  cropRefShapeOk,
  get viewports() {
    return readabilityViewports();
  },
  get limits() {
    return readabilityLimits();
  },
});
