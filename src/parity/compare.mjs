// Pure element parity comparison, implemented from Appendix A of the P contract.
export const PARITY_COMPARATOR_VERSION = "parity-compare/v1";
export const PARITY_TOLERANCES = Object.freeze({
  position_px: 6, size_px: 6, gap_px: 6,
  font_size_px: 0.6, line_height_px: 2, letter_spacing_px: 0.2,
  color_channel: 3, fuzzy_jaccard: 0.6, missing_copy_min_chars: 4,
});
export const PARITY_PROBE_LIMITS = Object.freeze({
  elements: 1500, text_chars: 500, page_text_chars: 262144, font_faces: 200, selector_path_chars: 2048,
});

const plain = (v) => v !== null && typeof v === "object"
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const nonnegative = (v) => finite(v) && v >= 0;
// Rule 0 (A-P4): box values stay within ±1e6 px so drift and distances stay finite.
const coordinate = (v) => finite(v) && Math.abs(v) <= 1e6;
const extent = (v) => coordinate(v) && v >= 0;
const integer = (v, min = 0) => Number.isInteger(v) && v >= min;
const boundedText = (v, max) => typeof v === "string" && [...v].length <= max;
const normalOr = (v, numberTest) => v === "normal" || numberTest(v);
const color = (v) => v === null || (Array.isArray(v) && v.length === 3
  && [...v].every((n) => finite(n) && n >= 0 && n <= 1));

export function isProbeOutput(v) {
  if (!plain(v) || !plain(v.viewport) || !integer(v.viewport.width, 1) || !integer(v.viewport.height, 1)
    || !finite(v.dpr) || v.dpr <= 0 || !Array.isArray(v.elements)
    || v.elements.length > PARITY_PROBE_LIMITS.elements
    || !boundedText(v.page_text, PARITY_PROBE_LIMITS.page_text_chars)
    || !Array.isArray(v.font_faces) || v.font_faces.length > PARITY_PROBE_LIMITS.font_faces
    || !plain(v.coverage)) return false;
  if (!["elements_capped", "time_capped", "page_text_truncated", "font_faces_capped"]
    .every((k) => typeof v.coverage[k] === "boolean")
    || !integer(v.coverage.closed_shadow_roots) || !integer(v.coverage.frames_not_read)) return false;
  for (const face of v.font_faces) {
    if (!plain(face) || typeof face.family !== "string"
      || !["unloaded", "loading", "loaded", "error"].includes(face.status)) return false;
  }
  const indices = new Set();
  for (const e of v.elements) {
    if (!plain(e) || !integer(e.index) || indices.has(e.index)
      || !boundedText(e.selector_path, PARITY_PROBE_LIMITS.selector_path_chars) || e.selector_path === ""
      || !boundedText(e.text, PARITY_PROBE_LIMITS.text_chars)
      || !boundedText(e.ftext, PARITY_PROBE_LIMITS.text_chars)
      || !plain(e.box) || !coordinate(e.box.x) || !coordinate(e.box.y) || !extent(e.box.w) || !extent(e.box.h)
      || !["font_family", "font_style", "text_transform"].every((k) => typeof e[k] === "string")
      || !nonnegative(e.font_size_px) || !finite(e.font_weight) || e.font_weight < 1 || e.font_weight > 1000
      || !normalOr(e.line_height, nonnegative) || !normalOr(e.letter_spacing, finite)
      || !color(e.fg_srgb) || !color(e.bg_srgb)
      || !(e.color_review === null || (typeof e.color_review === "string" && e.color_review !== ""))) return false;
    indices.add(e.index);
  }
  return true;
}

function validOptions(options) {
  if (options === undefined) return true;
  if (!plain(options) || Object.keys(options).some((k) => k !== "tolerances")) return false;
  if (!Object.hasOwn(options, "tolerances")) return true;
  const t = options.tolerances;
  const keys = Object.keys(PARITY_TOLERANCES);
  return plain(t) && Object.keys(t).length === keys.length && keys.every((k) => Object.hasOwn(t, k))
    && keys.filter((k) => k.endsWith("_px") || k === "color_channel").every((k) => nonnegative(t[k]))
    && finite(t.fuzzy_jaccard) && t.fuzzy_jaccard > 0 && t.fuzzy_jaccard <= 1
    && integer(t.missing_copy_min_chars, 1);
}

function norm(s) {
  return s.normalize("NFKC").replace(/[\u2018\u2019\u201a\u201b]/gu, "'")
    .replace(/[\u201c\u201d\u201e]/gu, '"').replace(/[\u2013\u2014\u2212]/gu, "-")
    .replace(/\s+/gu, " ").trim().toLowerCase();
}

function key(s) {
  return norm(s).replace(/[^\p{L}\p{M}\p{N} ]/gu, " ").replace(/ +/g, " ").trim();
}

const tokens = (s) => new Set(key(s).split(" ").filter(Boolean));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / (a.size + b.size - common);
}

function firstFamily(s) {
  let quote = null;
  let entry = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (i + 1 < s.length) entry += s[++i];
    } else if (ch === quote) {
      quote = null;
    } else if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
    } else if (!quote && ch === ",") {
      const family = norm(entry);
      if (family) return family;
      entry = "";
    } else {
      entry += ch;
    }
  }
  return norm(entry);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(v) {
  const rounded = Math.round(v * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
const exceeds = (delta, tolerance) => Math.abs(delta) - tolerance > 1e-9;
const c8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const roundValue = (v) => Array.isArray(v) ? v.map(roundValue) : typeof v === "number" ? round2(v) : v;
const designOrder = (a, b) => a.e.box.y - b.e.box.y || a.e.box.x - b.e.box.x || a.e.index - b.e.index;

function emptyComparison() {
  return {
    comparator_version: PARITY_COMPARATOR_VERSION, status: "compared", invalid: null,
    drift: { dx: 0, dy: 0, samples: 0 },
    counts: { design: 0, build: 0, matched: 0,
      by_pass: { exact_unique: 0, exact_nearest: 0, subtree: 0, fuzzy: 0 },
      unmatched_present: 0, unmatched_missing: 0, unmatched_unverified: 0, below_min_chars: 0 },
    pairs: [], findings: [],
  };
}

// Cache text before matching so the 1500 × 1500 case does no repeated
// normalization or font-face/page-text scanning per candidate.
function prepared(e) {
  const textKey = key(e.text);
  return { e, textKey, ftextKey: key(e.ftext), tokens: tokens(e.text !== "" ? e.text : e.ftext) };
}

function groupedByText(elements) {
  const groups = new Map();
  for (const e of elements) {
    if (!groups.has(e.textKey)) groups.set(e.textKey, []);
    groups.get(e.textKey).push(e);
  }
  return groups;
}

function faceStatuses(faces) {
  const map = new Map();
  const rank = { error: 1, unloaded: 2, loading: 3, loaded: 4 };
  for (const face of faces) {
    const family = norm(face.family);
    if (rank[face.status] > (rank[map.get(family)] ?? 0)) map.set(family, face.status);
  }
  return map;
}

export function compareElementParity(design, build, options) {
  const out = emptyComparison();
  const invalid = !validOptions(options) ? "options" : !isProbeOutput(design) ? "design"
    : !isProbeOutput(build) ? "build" : null;
  if (invalid) return { ...out, status: "invalid_input", invalid };
  const t = options?.tolerances ?? PARITY_TOLERANCES;
  const D = design.elements.map(prepared).filter((d) => d.textKey !== "").sort(designOrder);
  const B = build.elements.map(prepared);
  out.counts.design = D.length;
  out.counts.build = B.length;
  if (design.viewport.width !== build.viewport.width || design.viewport.height !== build.viewport.height || design.dpr !== build.dpr) {
    out.status = "viewport_mismatch";
    return out;
  }
  if (!D.length) {
    out.status = "design_elements_unavailable";
    return out;
  }

  const matches = new Map();
  const used = new Set();
  const pair = (d, b, via, similarity = null) => {
    matches.set(d, { b, via, similarity });
    used.add(b);
    out.counts.by_pass[via]++;
  };
  const dg = groupedByText(D);
  const bg = groupedByText(B);
  const xs = [], ys = [];
  for (const d of D) {
    const candidates = bg.get(d.textKey);
    if (dg.get(d.textKey).length === 1 && candidates?.length === 1) {
      const b = candidates[0];
      pair(d, b, "exact_unique");
      xs.push(b.e.box.x - d.e.box.x);
      ys.push(b.e.box.y - d.e.box.y);
    }
  }
  const dx = median(xs), dy = median(ys);
  out.drift = { dx: round2(dx), dy: round2(dy), samples: xs.length };
  const dist = (d, b) => Math.hypot(d.e.box.x + dx - b.e.box.x, d.e.box.y + dy - b.e.box.y);
  const area = (b) => Math.max(1, b.e.box.w) * Math.max(1, b.e.box.h);
  for (const via of ["exact_nearest", "subtree", "fuzzy"]) {
    for (const d of D) {
      if (matches.has(d)) continue;
      let best = null, bestPrimary = Infinity, bestDistance = Infinity, similarity = null;
      const candidates = via === "exact_nearest" ? bg.get(d.textKey) ?? [] : B;
      for (const b of candidates) {
        if (used.has(b)) continue;
        let primary = 0, score = null;
        if (via === "subtree") {
          if (!((b.ftextKey !== "" && b.ftextKey === d.textKey)
            || (d.ftextKey !== "" && b.textKey !== "" && b.textKey === d.ftextKey))) continue;
          primary = area(b);
        } else if (via === "fuzzy") {
          score = jaccard(d.tokens, b.tokens);
          if (score < t.fuzzy_jaccard) continue;
          primary = -score;
        }
        const distance = dist(d, b);
        if (best === null || primary < bestPrimary || (primary === bestPrimary
          && (distance < bestDistance || (distance === bestDistance && b.e.index < best.e.index)))) {
          best = b;
          bestPrimary = primary;
          bestDistance = distance;
          similarity = score;
        }
      }
      if (best) pair(d, best, via, similarity === null ? null : round2(similarity));
    }
  }

  const pageKey = ` ${key(build.page_text)} `;
  const contains = (k) => pageKey.includes(` ${k} `);
  const incomplete = build.coverage.page_text_truncated ? "page_text_truncated"
    : build.coverage.closed_shadow_roots > 0 || build.coverage.frames_not_read > 0 ? "build_text_not_read" : null;
  const designFaces = faceStatuses(design.font_faces), buildFaces = faceStatuses(build.font_faces);
  const categories = { copy: [], typography: [], color: [], geometry: [] };
  const ordinals = new Map();
  let pred = null;
  for (const d of D) {
    const de = d.e;
    const text = norm(de.text);
    const identityKey = JSON.stringify([text, de.selector_path]);
    const ordinal = ordinals.get(identityKey) ?? 0;
    ordinals.set(identityKey, ordinal + 1);
    const design_identity = { text, selector_path: de.selector_path, ordinal };
    const match = matches.get(d);
    const be = match?.b.e;
    const members = { copy: [], typography: [], color: [], geometry: [] };
    const add = (category, property, reason_code, dv, bv, delta = null, result = "warning") => {
      members[category].push({ property, result, reason_code, design: roundValue(dv), build: roundValue(bv), delta: roundValue(delta) });
    };
    const changed = (category, property, dv, bv, tolerance, delta = bv - dv) => {
      if (exceeds(delta, tolerance)) add(category, property, `${property}_differs`, dv, bv, delta);
    };
    const copy = (reason, bv, delta = null) => add("copy", "copy", reason, text, bv, delta,
      incomplete ? "review" : "warning");
    if (!match) {
      if ([...d.textKey].length < t.missing_copy_min_chars) out.counts.below_min_chars++;
      else if (contains(d.textKey)) out.counts.unmatched_present++;
      else if (incomplete) {
        out.counts.unmatched_unverified++;
        copy(incomplete, null);
      } else {
        out.counts.unmatched_missing++;
        copy("copy_missing", null);
      }
    } else {
      out.pairs.push({ design: de.index, build: be.index, via: match.via, similarity: match.similarity });
      if (match.via === "fuzzy" && !contains(d.textKey)) {
        copy(incomplete ?? "copy_changed", norm(be.text !== "" ? be.text : be.ftext), match.similarity);
      }
      const df = firstFamily(de.font_family), bf = firstFamily(be.font_family);
      if (df !== bf) add("typography", "font_family", "font_family_differs", df, bf);
      changed("typography", "font_size", de.font_size_px, be.font_size_px, t.font_size_px);
      changed("typography", "font_weight", de.font_weight, be.font_weight, 0);
      if (de.font_style !== be.font_style) add("typography", "font_style", "font_style_differs", de.font_style, be.font_style);
      if (typeof de.line_height === "number" && typeof be.line_height === "number") {
        changed("typography", "line_height", de.line_height, be.line_height, t.line_height_px);
      } else if (de.line_height !== be.line_height) {
        add("typography", "line_height", "line_height_unresolved", de.line_height, be.line_height, null, "review");
      }
      changed("typography", "letter_spacing", de.letter_spacing, be.letter_spacing, t.letter_spacing_px,
        (be.letter_spacing === "normal" ? 0 : be.letter_spacing) - (de.letter_spacing === "normal" ? 0 : de.letter_spacing));
      if (de.text_transform !== be.text_transform) add("typography", "text_transform", "text_transform_differs", de.text_transform, be.text_transform);
      if (designFaces.get(df) === "loaded" && buildFaces.get(df) !== "loaded") {
        add("typography", "font_face", build.coverage.font_faces_capped ? "font_face_unverified" : "font_face_unavailable",
          "loaded", buildFaces.get(df) ?? "absent", null, build.coverage.font_faces_capped ? "review" : "warning");
      }
      if (de.color_review !== null || be.color_review !== null || de.fg_srgb === null || be.fg_srgb === null) {
        add("color", "color", "color_unresolved", de.color_review, be.color_review, null, "review");
      } else {
        for (const [property, field] of [["text_color", "fg_srgb"], ["background_color", "bg_srgb"]]) {
          const dc = de[field]?.map(c8) ?? null, bc = be[field]?.map(c8) ?? null;
          if (dc === null || bc === null) add("color", property, "color_unresolved", dc, bc, null, "review");
          else changed("color", property, dc, bc, t.color_channel, Math.max(...dc.map((v, i) => Math.abs(bc[i] - v))));
        }
      }
      const gapD = de.box.y - (pred ? pred.d.box.y + pred.d.box.h : 0);
      const gapB = be.box.y - (pred ? pred.b.box.y + pred.b.box.h : 0);
      changed("geometry", "gap", gapD, gapB, t.gap_px);
      changed("geometry", "x_position", de.box.x, be.box.x, t.position_px, (be.box.x - de.box.x) - dx);
      changed("geometry", "width", de.box.w, be.box.w, t.size_px);
      changed("geometry", "height", de.box.h, be.box.h, t.size_px);
      pred = { d: de, b: be };
    }
    for (const category of Object.keys(categories)) {
      if (members[category].length) categories[category].push({ category, design: de.index, build: be?.index ?? null,
        design_identity: { ...design_identity }, members: members[category] });
    }
  }
  out.counts.matched = out.pairs.length;
  out.findings = Object.values(categories).flat();
  return out;
}
