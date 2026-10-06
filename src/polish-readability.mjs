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
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import { CART_PLACEHOLDERS_LIMITS } from "./cart-placeholders.mjs";
import { contrastToolkit } from "./contrast.mjs";
import {
  READABILITY_ADDED_RUN_MS,
  READABILITY_CROP_RUN_MS,
  READABILITY_PROBE_CELL_MS,
  READABILITY_PROBE_RUN_MS,
} from "./polish-deadline.mjs";
import { MAX_POLISH_CAPTURE_ROUTES, POLISH_CAPTURE_VIEWPORTS } from "./polish-node.mjs";
import { QC_PRODUCERS, aggregateQcResults, polishRecordIntegrity } from "./qc-results.mjs";

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
    probe_ms_per_cell: READABILITY_PROBE_CELL_MS,
    probe_ms_per_run: READABILITY_PROBE_RUN_MS,
    crop_ms_per_run: READABILITY_CROP_RUN_MS,
    added_ms_per_run: READABILITY_ADDED_RUN_MS,
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

// ---------------------------------------------------------------------------
// Probe

// The page-side read of one cell. It runs in the Polish isolated world with
// the shared contrast helper (readabilityProbeSource), and only reads the
// page: it never clicks, focuses, hovers, scrolls, types or writes a style,
// and returns no text content. It reads the document, every open shadow root
// (recursively) and every visible same-origin frame's loaded document, each
// measured with its own window; a visible frame still loading is listed as
// text it cannot reach, like a cross-origin one. The cell measurability
// checks run on the document and on each frame document it measures, each
// with the open shadow roots inside it; the first that fails makes the cell
// read that reason. `limits.elements` bounds the text-bearing elements it
// measures; `closedRoots` are the closed shadow roots the adapter resolved
// (or, for one inside a frame, that frame's element); `generatedText` is
// generatedTextRenders. Every element carries its rectangle in the main
// frame's viewport (`rect`, clipped to its frames) for crops, which the
// record does not keep.
export function readabilityProbe(toolkit, limits, closedRoots, generatedText) {
  const win = window;
  const doc = document;
  const viewport = { width: win.innerWidth, height: win.innerHeight };
  const unmeasured = (status) => ({ status, capped: false, coverage_gaps: [], elements: [], viewport });
  const measurability = toolkit.documentMeasurability(doc);
  if (!measurability.measurable) return unmeasured(measurability.reason);
  if (!doc.body) return unmeasured("measured");

  // Text-bearing roles, first match; an element matches when it or an
  // ancestor matches. checkout_label and checkout_hint are read separately.
  const ROLES = [
    ["add_to_cart", "[data-next-action=\"add-to-cart\"]"],
    ["upsell_accept", "[data-next-upsell-action=\"add\"]"],
    ["upsell_decline", "[data-next-upsell-action=\"skip\"]"],
    ["submit_control", "button.submit-button[os-checkout-payment=\"combo\"], button[os-checkout-payment=\"combo\"], button[type=\"submit\"], input[type=\"submit\"], input[type=\"button\"]"],
    ["sdk_action", "[data-next-action]"],
    ["bundle_card", "[data-next-bundle-card], [data-next-selector-card], [data-next-package-id], [data-next-bundle-id]"],
    ["order_bump", "[data-next-toggle-card], [data-next-bump], [data-next-package-toggle]"],
    ["price", "[data-next-display*=\"price\"], [data-next-bundle-display*=\"price\"], [data-next-display=\"cart.total\"]"],
  ];
  const STATE_GROUPS = ROLES.filter(([role]) => role === "bundle_card" || role === "order_bump");
  const CHECKOUT_FIELD = "[data-next-checkout-field]";
  // Elements that hold no text of their own: never a text_not_rendered role element.
  const TEXTLESS = new Set(["select", "textarea", "img", "svg", "video", "canvas", "iframe", "object", "embed", "picture", "hr", "br"]);

  // The flat tree, as the shared helper walks it: an element slotted into an
  // open shadow root sits in its slot, and the top element of a shadow tree
  // sits in the root's host. A frame's document is its own tree.
  const { flatParent, flatClosest, flatContains, flatSubtree, isVisible } = toolkit;
  const flatText = (el) => [el.textContent, ...flatSubtree(el).filter((node) => node.shadowRoot).map((node) => node.shadowRoot.textContent)].join("");

  const frameDocument = (frame) => {
    try {
      return frame.contentDocument;
    } catch {
      return null;
    }
  };
  // A frame's document has loaded when it is complete and is not the initial
  // blank document standing in for a page still on its way (a src other than
  // about:blank, or a srcdoc). A frame with no src, or src about:blank, is
  // blank by design.
  const frameLoaded = (frame, inner) => {
    if (inner.readyState !== "complete") return false;
    if (inner.URL !== "about:blank") return true;
    const src = (frame.getAttribute("src") || "").trim();
    return !frame.hasAttribute("srcdoc") && (src === "" || /^about:blank(?:[?#]|$)/i.test(frame.src));
  };
  const meet = (a, b) => {
    if (!a) return b;
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
  };

  // Every tree the probe reads: the document, each open shadow root and each
  // visible same-origin frame's loaded document, with the window that
  // measures it, its offset in the main frame's viewport and the frame boxes
  // clipping it. `elements` lists every element in tree order, a host's
  // shadow tree and a frame's document right after the host or frame. A
  // frame (iframe or frame) whose document is cross-origin or still loading
  // is not readable.
  const scopes = [];
  const inOrder = [];
  const frames = [];
  const enter = (root, scopeWin, offset, clip, top) => {
    const scope = { root, win: scopeWin, offset, clip };
    scopes.push(scope);
    for (const el of top) {
      inOrder.push([el, scope]);
      if (el.shadowRoot) enter(el.shadowRoot, scopeWin, offset, clip, el.shadowRoot.querySelectorAll("*"));
      if (el.localName !== "iframe" && el.localName !== "frame") continue;
      const inner = frameDocument(el);
      const readable = Boolean(inner) && frameLoaded(el, inner);
      frames.push([el, scope, readable]);
      if (!readable || !inner.body || !inner.defaultView || !isVisible(el)) continue;
      const box = el.getBoundingClientRect();
      const style = scopeWin.getComputedStyle(el);
      const padding = (side) => Number.parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
      const content = {
        x: offset.x + box.left + el.clientLeft + padding("left"),
        y: offset.y + box.top + el.clientTop + padding("top"),
        width: el.clientWidth - padding("left") - padding("right"),
        height: el.clientHeight - padding("top") - padding("bottom"),
      };
      enter(inner, inner.defaultView, { x: content.x, y: content.y }, meet(clip, content), [inner.body, ...inner.body.querySelectorAll("*")]);
    }
  };
  enter(doc, win, { x: 0, y: 0 }, null, [doc.body, ...doc.body.querySelectorAll("*")]);
  // The document's own check above covers its open shadow roots; each frame
  // document's covers that frame's.
  for (const scope of scopes) {
    if (scope.root.nodeType !== 9 || scope.root === doc) continue;
    const framed = toolkit.documentMeasurability(scope.root);
    if (!framed.measurable) return unmeasured(framed.reason);
  }

  const checkoutLabel = (el) => {
    const label = flatClosest(el, "label");
    if (!label) return false;
    const named = label.htmlFor ? label.getRootNode().getElementById(label.htmlFor) : null;
    return Boolean(named && named.matches(CHECKOUT_FIELD)) || Boolean(label.querySelector(CHECKOUT_FIELD));
  };
  const roleOf = (el) => {
    for (const [role, selector] of ROLES) if (flatClosest(el, selector)) return role;
    return checkoutLabel(el) ? "checkout_label" : "body_text";
  };
  const rectOf = (el, scope) => {
    const box = el.getBoundingClientRect();
    const rect = { x: scope.offset.x + box.left, y: scope.offset.y + box.top, width: box.width, height: box.height };
    return scope.clip ? meet(scope.clip, rect) : rect;
  };
  const windowOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || win;
  const showsText = (el) => flatSubtree(el).some((node) => toolkit.isTextBearing(node, windowOf(node)));
  const recordOf = (measured, role, rect) => ({
    role,
    selector_path: measured.selector_path,
    state: measured.state,
    disabled: measured.disabled,
    rendered: measured.rendered,
    font_size_px: measured.font_size_px,
    font_weight: measured.font_weight,
    size_class: measured.size_class,
    fg_raw: measured.fg_raw,
    fill_raw: measured.fill_raw,
    bg_layers_raw: measured.bg_layers_raw,
    fg_srgb: measured.fg_srgb,
    bg_srgb: measured.bg_srgb,
    gamut_clipped: measured.gamut_clipped,
    ratio: measured.ratio,
    required: measured.required,
    review_reason: measured.review_reason,
    crop_ref: null,
    crop_reason: null,
    rect,
  });

  const gaps = [];
  const gap = (reason, role, el) => gaps.push({ reason, role, selector_path: toolkit.selectorPath(el) });
  const elements = [];
  let measured = 0;
  let capped = false;
  // One more element to measure, inside the cap.
  const admit = () => {
    if (measured >= limits.elements) {
      capped = true;
      return false;
    }
    measured += 1;
    return true;
  };

  // Selected, active and expanded states not present at load: content an
  // aria-expanded="false" control names (in the control's own tree), and
  // every closed <details>.
  const collapsed = [];
  for (const { root } of scopes) {
    for (const control of root.querySelectorAll("[aria-expanded=\"false\"]")) {
      for (const id of (control.getAttribute("aria-controls") || "").split(/\s+/)) {
        const target = id ? root.getElementById(id) : null;
        if (target) collapsed.push(target);
      }
      gap("state_not_observed", null, control);
    }
  }
  for (const { root } of scopes) {
    for (const details of root.querySelectorAll("details:not([open])")) {
      collapsed.push(details);
      gap("state_not_observed", null, details);
    }
  }

  // Every text-bearing element, in tree order.
  for (const [el, scope] of inOrder) {
    if (!toolkit.isTextBearing(el, scope.win)) continue;
    if (!admit()) break;
    const role = roleOf(el);
    const read = toolkit.measureTextElement(el, scope.win);
    if (read.control_loading) gaps.push({ reason: "control_loading", role, selector_path: read.selector_path });
    else elements.push(recordOf(read, role, rectOf(el, scope)));
  }

  // Placeholder hints of checkout fields: the ::placeholder text, against the
  // field's background.
  for (const scope of scopes) {
    for (const field of scope.root.querySelectorAll(`input${CHECKOUT_FIELD}[placeholder], textarea${CHECKOUT_FIELD}[placeholder]`)) {
      if (capped) break;
      if (!/\S/.test(field.getAttribute("placeholder")) || field.value !== "" || !isVisible(field)) continue;
      if (!admit()) break;
      const read = toolkit.measurePlaceholder(field, scope.win);
      if (read.control_loading) gaps.push({ reason: "control_loading", role: "checkout_hint", selector_path: read.selector_path });
      else elements.push(recordOf(read, "checkout_hint", rectOf(field, scope)));
    }
  }

  // Role elements whose text is not measured, first match: text supplied by
  // CSS content, no rendered text (an element with rendered: false), or text
  // not visible at load (unless it sits in content already listed as a
  // state not observed). A role element's text includes its shadow trees'.
  const roleSelector = ROLES.map(([, selector]) => selector).join(", ");
  const roleElements = [
    ...scopes.flatMap((scope) => Array.from(scope.root.querySelectorAll(roleSelector), (el) => [el, scope])),
    ...scopes.flatMap((scope) => Array.from(scope.root.querySelectorAll("label")).filter(checkoutLabel).map((el) => [el, scope])),
  ];
  let checked = 0;
  const listed = new Set();
  for (const [el, scope] of roleElements) {
    if (checked >= limits.elements) {
      capped = true;
      break;
    }
    checked += 1;
    const tag = el.localName;
    const button = tag === "input" && (el.type === "submit" || el.type === "button");
    if (TEXTLESS.has(tag) || (tag === "input" && !button)) continue;
    const role = roleOf(el);
    const generated = ["::before", "::after"].some((pseudo) => /^(["']).+\1$/s.test(scope.win.getComputedStyle(el, pseudo).getPropertyValue("content")));
    if (generated) {
      gap("generated_text", role, el);
      listed.add(el);
      continue;
    }
    if (!/\S/.test(button ? el.value : flatText(el))) {
      elements.push(recordOf(toolkit.measureTextElement(el, scope.win), role, rectOf(el, scope)));
      continue;
    }
    if (!showsText(el) && !collapsed.some((scope) => flatContains(scope, el))) {
      gap("not_visible_at_load", role, el);
      listed.add(el);
    }
  }

  // Generated text anywhere in the cell, not only on role elements (a
  // descendant of a role element, or body text): every element the probe
  // reads whose ::before or ::after renders text (generatedText), with the
  // role its text would be measured under. A role element already listed
  // above is not listed twice.
  for (const [el, scope] of inOrder) {
    if (!listed.has(el) && generatedText(el, scope.win)) gap("generated_text", roleOf(el), el);
  }

  // Bundle cards and order bumps with no member selected or active at load.
  for (const [role, selector] of STATE_GROUPS) {
    const members = elements.filter((element) => element.role === role && element.rendered && !element.disabled);
    if (!members.length || members.some((element) => element.state === "selected" || element.state === "active")) continue;
    for (const { root } of scopes) {
      for (const card of root.querySelectorAll(selector)) {
        if (flatParent(card) && flatClosest(flatParent(card), selector)) continue;
        if (showsText(card)) gap("state_not_observed", role, card);
      }
    }
  }

  // Text the probe cannot reach: closed shadow roots, and visible frames
  // whose document it cannot read, cross-origin or still loading.
  for (const root of closedRoots) {
    const holder = root && (root.host || (root.nodeType === 1 ? root : null));
    if (holder) gap("closed_shadow_root", null, holder);
  }
  for (const [frame, , readable] of frames) {
    if (isVisible(frame) && !readable) gap("cross_origin_text", null, frame);
  }

  return { status: "measured", capped, coverage_gaps: gaps, elements, viewport };
}

// The function declaration the adapter calls in the isolated world: the
// probe, composed with the shared contrast helper and generatedTextRenders
// by source text.
export function readabilityProbeSource() {
  return `function (limits, ...closedRoots) { return (${readabilityProbe.toString()})((${contrastToolkit.toString()})(), limits, closedRoots, ${generatedTextRenders.toString()}); }`;
}

// Whether an element's ::before or ::after renders text: its computed
// content holds a string with a non-blank character, a counter, an
// attribute value or a quotation mark, and the pseudo-element is displayed
// and visible on an element that is rendered (an element with
// display: contents renders its pseudo-elements without a box of its own).
// Generated text is never measured. Polish and QA both hand it to pages as
// source text, so it references nothing outside itself.
export function generatedTextRenders(el, win) {
  const own = win.getComputedStyle(el);
  if (!el.checkVisibility() && own.getPropertyValue("display") !== "contents") return false;
  const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  return ["::before", "::after"].some((pseudo) => {
    const generated = win.getComputedStyle(el, pseudo);
    if (generated.getPropertyValue("display") === "none" || generated.getPropertyValue("visibility") !== "visible") return false;
    const content = generated.getPropertyValue("content");
    if (content === "none" || content === "normal") return false;
    if ((content.match(STRING) || []).some((text) => /\S/.test(text.slice(1, -1)))) return true;
    return /\b(?:counters?|attr)\(|\b(?:open|close)-quote\b/.test(content.replace(STRING, ""));
  });
}

// ---------------------------------------------------------------------------
// Producer

// The elements a crop is due for, by index: the first member of every row
// that reads warning or review, in element order (the row keys of
// evaluateReadability).
export function readabilityCropTargets(elements) {
  const rows = new Map();
  (Array.isArray(elements) ? elements : []).forEach((element, index) => {
    if (!isPlainObject(element) || element.disabled || !element.rendered) return;
    let key;
    let due;
    if (element.review_reason !== null) {
      key = element.role === "body_text" ? "review:body_text:non_solid" : `review:${element.role}:${element.review_reason}`;
      due = true;
    } else if (isSrgb(element.fg_srgb) && isSrgb(element.bg_srgb) && Number.isFinite(element.ratio)) {
      key = readabilityPairKey(element);
      due = !toolkit.meetsRequirement(element.ratio, element.required);
    } else return;
    const row = rows.get(key) || { first: index, due: false };
    row.due ||= due;
    rows.set(key, row);
  });
  return [...rows.values()].filter((row) => row.due).map((row) => row.first).sort((a, b) => a - b);
}

// A crop's bytes, written under the target repo by their sha256.
export function writeReadabilityCrop(targetRepo, bytes) {
  const hex = createHash("sha256").update(bytes).digest("hex");
  const path = `${READABILITY_CROP_DIR}/${hex}.png`;
  const dir = join(targetRepo, ...READABILITY_CROP_DIR.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hex}.png`), bytes);
  return { path, sha256: `sha256:${hex}` };
}

const ELEMENT_FIELDS = Object.freeze(["role", "selector_path", "state", "disabled", "rendered", "font_size_px", "font_weight", "size_class", "fg_raw", "fill_raw", "bg_layers_raw", "fg_srgb", "bg_srgb", "gamut_clipped", "ratio", "required", "review_reason", "crop_ref", "crop_reason"]);
const GAP_FIELDS = Object.freeze(["reason", "role", "selector_path"]);
const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, value[field] ?? null]));

// Whether an adapter's readability observation is one the record can hold:
// a cell status, and for a measured cell its elements and coverage gaps.
export function readabilityObservationOk(observation) {
  return isPlainObject(observation)
    && inVocabulary("cell_status", observation.status)
    && (observation.status !== "measured"
      || (Array.isArray(observation.elements) && observation.elements.every(isPlainObject)
        && Array.isArray(observation.coverage_gaps) && observation.coverage_gaps.every(isPlainObject)
        && typeof observation.capped === "boolean"));
}

// One cell of the record. `status` is the cell status; a measured cell's
// `observation` is the adapter's probe read ({capped, coverage_gaps,
// elements, crops}). Only the record's fields are kept. Each crop the adapter
// took (crops[] of {element, data}, base64 PNG) is written by `writeCrop`
// and referenced by path and sha256; one that cannot be written reads
// crop_unavailable. A measured cell outside the record vocabulary reads
// document_changed: what the probe returned is not a measurement.
export function buildReadabilityCell({ route, viewport, pageLoadIntegrity = null, status, observation = null, writeCrop = null }) {
  const unmeasured = (cellStatus) => ({ route, viewport, page_load_integrity: pageLoadIntegrity, cell_status: cellStatus, capped: false, coverage_gaps: [], elements: [] });
  if (status !== "measured") return unmeasured(status);
  const elements = observation.elements.map((element) => pick(element, ELEMENT_FIELDS));
  for (const crop of Array.isArray(observation.crops) ? observation.crops : []) {
    const element = elements[crop?.element];
    if (!element) continue;
    try {
      if (typeof writeCrop !== "function" || typeof crop.data !== "string" || crop.data === "") throw new Error("no crop");
      element.crop_ref = writeCrop(Buffer.from(crop.data, "base64"));
      element.crop_reason = null;
    } catch {
      element.crop_ref = null;
      element.crop_reason = "crop_unavailable";
    }
  }
  const cell = {
    route,
    viewport,
    page_load_integrity: pageLoadIntegrity,
    cell_status: "measured",
    capped: observation.capped,
    coverage_gaps: observation.coverage_gaps.map((entry) => pick(entry, GAP_FIELDS)),
    elements,
  };
  return readabilityCellShapeOk(cell) ? cell : unmeasured("document_changed");
}

// The record for one Polish run: its cells (one per captured route ×
// viewport), bound to the current build and source package; the built routes
// over the route cap; whether the enumeration ceiling was reached.
export function buildReadabilityRecord({ buildFingerprint, sourceFingerprint = null, slug, routes, uncapturedRoutes = [], routeEnumerationCapped = false, cells, measuredAt = new Date().toISOString() }) {
  const record = {
    schema_version: READABILITY_SCHEMA,
    performed_by: READABILITY_PRODUCER,
    helper_version: READABILITY_HELPER_VERSION,
    subject: {
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: isNonEmptyString(sourceFingerprint) ? sourceFingerprint : null,
      campaign_slug: slug,
      route_source: READABILITY_ROUTE_SOURCE,
      routes: [...routes],
      viewports: readabilityViewports(),
    },
    thresholds: { ...READABILITY_THRESHOLDS },
    limits: { ...readabilityLimits() },
    cells,
    uncaptured_routes: [...uncapturedRoutes],
    route_enumeration_capped: routeEnumerationCapped === true,
    measured_at: new Date(measuredAt).toISOString(),
  };
  return { ...record, integrity: polishRecordIntegrity(record) };
}
