// The campaign intent summary: a short, deterministic orientation rendered
// from the normalized Campaign Build Brief for the stage prompts and every
// `next` result. It is output only: nothing persists it and no routing,
// gate, price or commerce decision reads it.
//
// Every displayed brief value carries the marker its `_meta.field_sources`
// entry proves, and nothing stronger: an entry counts only when build-brief's
// fieldSourceEntryMatches accepts it (exactly {kind, value_fingerprint}, a
// recorded kind, and the fingerprint of the current value). Values are
// rendered as quoted data and never interpreted. A collection the summary
// cannot read as its expected shape is said to be not recorded, and a blank
// value reads not stated; neither is ever presented as complete.
//
// Pure: equal inputs give byte-identical output. No file, clock or
// environment access; a failure is handed to the caller's onError.
import { fieldSourceEntryMatches, SUMMARY_FIELDS } from "./build-brief.mjs";
import { canonicalJson } from "./polish-capture.mjs";

export const SUMMARY_WORD_LIMIT = 150;

const NO_BRIEF_TEXT = "No Campaign Build Brief is recorded for this campaign. Ask the operator for purpose and audience before business-sensitive choices; never assume them.";
const NOT_SUMMARISED_TEXT = "The Campaign Build Brief could not be summarised.";
const COMMERCE_TEXT = "products, prices and offers come from CampaignSpec/API values; cart, checkout and post-purchase behaviour stay with the SDK.";

// The provenance-stamped fields, in the order build-brief exports them. The
// page-keyed field names a concrete page id in place of "<page>", joined by
// plain concatenation so no character of the id is interpreted.
const [AUDIENCE, CONVERSION_GOAL, TONE, PALETTE_SOURCE, PRIMARY_ACCENT, CTA_STYLE, AVOID, PAGE_SOURCE, BLOCK_PLACEHOLDERS] = SUMMARY_FIELDS;
const [PAGE_SOURCE_PREFIX, PAGE_SOURCE_SUFFIX, ...PAGE_SOURCE_REST] = PAGE_SOURCE.split("<page>");
if (PAGE_SOURCE_SUFFIX === undefined || PAGE_SOURCE_REST.length) {
  throw new Error(`SUMMARY_FIELDS must name the page-keyed design authority field with exactly one "<page>" placeholder; got ${JSON.stringify(PAGE_SOURCE)}.`);
}
const pageSourceField = (pageId) => PAGE_SOURCE_PREFIX + pageId + PAGE_SOURCE_SUFFIX;

const NOT_RECORDED = "not_recorded";
// An active page whose id is missing or blank keeps its place in the journey.
const PAGE_ID_NOT_RECORDED = "(page id not recorded)";
const MARKERS = Object.freeze({ stated: "[stated]", source: "[from source]", default: "[default]", [NOT_RECORDED]: "[source not recorded]" });
// Weakest first: a value whose origin was not recorded claims the least of
// the marks; a part that reads not stated (null) claims less than any mark.
const STRENGTH = Object.freeze([NOT_RECORDED, "default", "source", "stated"]);

// design_authority.<page>.source values the generator writes; any other
// non-null value is shown verbatim in its own group.
const SUPPLIED_DESIGN = "provided_design_export";
const TEMPLATE = "template";

const VALUE_WORDS = 12;
const FINAL_CUT_WORDS = 8;
const LIST_CUT_LINES = Object.freeze([7, 4, 3]);

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => (isPlainObject(object) && Object.hasOwn(object, key) ? object[key] : undefined);
const valueAt = (brief, path) => path.split(".").reduce((value, key) => own(value, key), brief);
const singleLine = (text) => text.replace(/\r\n|[\n\r\u2028\u2029]/g, " ");
// Whitespace only, counting NEL (U+0085), which String.prototype.trim keeps.
const isBlank = (value) => typeof value === "string" && !value.replace(/\u0085/g, "").trim();
const notStated = (value) => value == null || isBlank(value);

// C0, DEL and C1 control characters (ESC and NEL among them) written as \t or
// \uXXXX escapes, so none reaches a prompt or terminal raw.
const escapeControls = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => (char === "\t" ? "\\t" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
// Inside quotes, `\` and `"` are escaped first, so no value can close them.
const escapeQuoted = (text) => escapeControls(text.replace(/[\\"]/g, "\\$&"));

// stated | source | default | not_recorded, or null for an absent value.
function provenanceOf(brief, field, value) {
  if (value == null) return null;
  const entry = own(own(own(brief, "_meta"), "field_sources"), field);
  if (!fieldSourceEntryMatches(entry, value)) return NOT_RECORDED;
  return entry.kind;
}

// The weakest mark among the parts a line or group shows; a part that reads
// not stated makes it null, so it never claims a mark that part lacks.
function weakest(provenances) {
  if (!provenances.length || provenances.some((provenance) => provenance == null)) return null;
  return STRENGTH[Math.min(...provenances.map((provenance) => STRENGTH.indexOf(provenance)))];
}

// A brief value as quoted data: line breaks collapse to spaces, the value is
// trimmed and cut to `maxWords` words with "…", and escaped.
function quoted(value, maxWords, cut) {
  const text = singleLine(typeof value === "string" ? value : canonicalJson(value)).trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) cut.happened = true;
  const kept = words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : text;
  return `"${escapeQuoted(kept)}"`;
}

// A list cut to its first k items plus "+N more", where N counts what the
// dropped items stand for (one each by default).
function listItems(items, k, render, cut, weight = () => 1) {
  if (k == null || items.length <= k) return items.map(render);
  cut.happened = true;
  const more = items.slice(k).reduce((sum, item) => sum + weight(item), 0);
  return [...items.slice(0, k).map(render), `+${more} more`];
}
// A page id as displayed: unquoted, with line breaks collapsed to spaces and
// control characters escaped.
const pageIdText = (id) => (id == null ? PAGE_ID_NOT_RECORDED : escapeControls(singleLine(id)));

function marked(value, provenance, maxWords, cut) {
  return `${quoted(value, maxWords, cut)} ${MARKERS[provenance]}`;
}

// A blank string reads not stated, like an absent value.
function field(brief, path) {
  const raw = valueAt(brief, path);
  const value = notStated(raw) ? null : raw;
  return { value, provenance: provenanceOf(brief, path, value) };
}

// Line 1 and the line-5 palette clause have page-keyed generator values, so
// they show a value only when the brief file states it.
function statedOnly({ value, provenance }) {
  return provenance === "stated" ? { value, provenance } : { value: null, provenance: null };
}

// Line 4: each active page in exactly one group, in the fixed group order;
// each group carries the weakest marker among its pages. Authority and stamp
// are read with the page id exactly as recorded; a page without one, or with
// a blank source, reads not stated.
function authorityGroups(brief, pageIds) {
  const authority = own(brief, "design_authority");
  const supplied = { kind: "supplied", source: SUPPLIED_DESIGN, pages: [], provenances: [] };
  const template = { kind: "template", source: TEMPLATE, pages: [], provenances: [] };
  const others = new Map();
  const unstated = { kind: "not_stated", source: null, pages: [], provenances: [] };
  for (const pageId of pageIds) {
    const recorded = pageId == null ? null : own(own(authority, pageId), "source");
    const source = notStated(recorded) ? null : recorded;
    const provenance = pageId == null ? null : provenanceOf(brief, pageSourceField(pageId), source);
    let group = unstated;
    if (source === SUPPLIED_DESIGN) group = supplied;
    else if (source === TEMPLATE) group = template;
    else if (source != null) {
      const key = canonicalJson(source);
      if (!others.has(key)) others.set(key, { kind: "other", source, pages: [], provenances: [] });
      group = others.get(key);
    }
    group.pages.push(pageId);
    group.provenances.push(provenance);
  }
  return [supplied, template, ...others.values(), unstated]
    .filter((group) => group.pages.length)
    .map(({ provenances, ...group }) => ({ ...group, provenance: weakest(provenances) }));
}

function readModel(brief, activePageIds) {
  // Page ids stay as recorded and are escaped only when rendered; a missing,
  // non-string or blank id is null and keeps its place.
  const pageIds = (Array.isArray(activePageIds) ? activePageIds : []).map((id) => (typeof id === "string" && !isBlank(id) ? id : null));
  const avoid = field(brief, AVOID);
  const avoidItems = avoid.value == null ? [] : Array.isArray(avoid.value) ? avoid.value : [avoid.value];
  // Questions not recorded as a list are null, never read as none.
  const questions = own(brief, "questions");
  return {
    purpose: statedOnly(field(brief, CONVERSION_GOAL)),
    audience: field(brief, AUDIENCE),
    journey: pageIds,
    authority: authorityGroups(brief, pageIds),
    palette: statedOnly(field(brief, PALETTE_SOURCE)),
    buttons: field(brief, CTA_STYLE),
    accent: field(brief, PRIMARY_ACCENT),
    tone: field(brief, TONE),
    avoid: { ...avoid, items: avoidItems, itemNotStated: avoidItems.some(notStated) },
    placeholders: field(brief, BLOCK_PLACEHOLDERS),
    questions: Array.isArray(questions) ? questions.map((question) => (typeof question?.id === "string" && !isBlank(question.id) ? singleLine(question.id.trim()) : "unnamed question")) : null,
  };
}

// The nine lines, with the line-3/4/7 lists cut to `cuts[line]` items and the
// line-1/2/5/6 values cut to `valueWords` words. Line 4 cut to k keeps its
// first k groups, each with its first k page ids; "+N more" counts pages.
function renderLines(model, cuts, valueWords) {
  const cut = { happened: false };
  const value = (item, fallback) => (item.value == null ? fallback : marked(item.value, item.provenance, valueWords, cut));
  const group = (entry) => {
    const ids = listItems(entry.pages, cuts[4], pageIdText, cut).join(", ");
    if (entry.kind === "supplied") return `${ids} follow the supplied design ${MARKERS[entry.provenance]}`;
    if (entry.kind === "template") return `${ids} follow the template ${MARKERS[entry.provenance]}`;
    if (entry.kind === "other") return `${ids} use ${marked(entry.source, entry.provenance, VALUE_WORDS, cut)}`;
    return `${ids} not stated`;
  };
  const avoid = model.avoid.value == null
    ? "avoid not stated"
    : `avoid ${model.avoid.items.length ? listItems(model.avoid.items, cuts[7], (item) => (notStated(item) ? "not stated" : quoted(item, VALUE_WORDS, cut)), cut).join("; ") : "none"} ${MARKERS[model.avoid.provenance]}`;
  const placeholders = model.placeholders.value == null
    ? "not stated"
    : typeof model.placeholders.value === "boolean"
      ? `${model.placeholders.value ? "yes" : "no"} ${MARKERS[model.placeholders.provenance]}`
      : marked(model.placeholders.value, model.placeholders.provenance, VALUE_WORDS, cut);
  const lines = [
    `Purpose: ${value(model.purpose, "not stated")}.`,
    `Audience: ${value(model.audience, "not stated")}.`,
    model.journey.length ? `Journey: ${listItems(model.journey, cuts[3], pageIdText, cut).join(" → ")} (CampaignSpec).` : "Journey: not stated.",
    model.authority.length ? `Visual authority: ${listItems(model.authority, cuts[4], group, cut, (entry) => entry.pages.length).join("; ")}.` : "Visual authority: not stated.",
    `Palette and buttons: ${model.palette.value == null ? "palette source not stated" : `palette from ${marked(model.palette.value, "stated", valueWords, cut)}`}; button style ${value(model.buttons, "not stated")}; accent ${value(model.accent, "not stated")}.`,
    `Tone: ${value(model.tone, "not stated")}.`,
    `Preserve: ${avoid}; template placeholders removed: ${placeholders}.`,
    `Commerce: ${COMMERCE_TEXT}`,
    `Open brief questions: ${model.questions == null ? "not recorded" : model.questions.length ? model.questions.map(escapeControls).join(", ") : "none"}.`,
  ];
  const text = lines.join("\n");
  return { text, wordCount: wordCount(text), cut: cut.happened };
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// Within the word bound: cut one list at a time, in order, to its first k
// items (k from 5 down to 1) until the bound holds: line 7, then line 4, then
// line 3. Only if it still fails, cut the line-1/2/5/6 values to 8 words.
// Lines 8 and 9 are never cut, and nothing is padded.
function renderWithinBound(model) {
  const cuts = {};
  let rendered = renderLines(model, cuts, VALUE_WORDS);
  for (const line of LIST_CUT_LINES) {
    for (let k = 5; k >= 1 && rendered.wordCount > SUMMARY_WORD_LIMIT; k -= 1) {
      cuts[line] = k;
      rendered = renderLines(model, cuts, VALUE_WORDS);
    }
  }
  if (rendered.wordCount > SUMMARY_WORD_LIMIT) rendered = renderLines(model, cuts, FINAL_CUT_WORDS);
  return rendered;
}

function isPartial(model, cut) {
  const values = [model.purpose, model.audience, model.palette, model.buttons, model.accent, model.tone, model.avoid, model.placeholders];
  const missing = values.some((item) => item.value == null) || model.avoid.itemNotStated || !model.journey.length || model.journey.includes(null) || !model.authority.length;
  const unrecorded = [...values, ...model.authority].some((item) => item.provenance === NOT_RECORDED);
  const ungrouped = model.authority.some((group) => group.kind === "other" || group.kind === "not_stated");
  return missing || unrecorded || ungrouped || model.questions == null || model.questions.length > 0 || cut;
}

const unavailable = (text) => ({ status: "unavailable", text, lines: [], word_count: wordCount(text), open_questions: [] });

// Never throws. No brief reads the fixed no-brief text. A brief the summary
// cannot be computed from (for example a value nested too deeply to
// fingerprint) reads unavailable with its own text, and the error is passed
// to `onError` so the caller can name it.
export function summarizeCampaignBrief({ brief, activePageIds = [], onError } = {}) {
  if (!isPlainObject(brief)) return unavailable(NO_BRIEF_TEXT);
  try {
    return summarize(brief, activePageIds);
  } catch (error) {
    onError?.(error);
    return unavailable(NOT_SUMMARISED_TEXT);
  }
}

function summarize(brief, activePageIds) {
  const model = readModel(brief, activePageIds);
  const rendered = renderWithinBound(model);
  const line = (label, value, provenance) => ({ label, value, provenance });
  return {
    status: isPartial(model, rendered.cut) ? "partial" : "available",
    text: rendered.text,
    lines: [
      line("Purpose", model.purpose.value, model.purpose.provenance),
      line("Audience", model.audience.value, model.audience.provenance),
      line("Journey", model.journey, null),
      line("Visual authority", model.authority.map(({ pages, source, provenance }) => ({ page_ids: pages, source, provenance })), weakest(model.authority.map((group) => group.provenance))),
      line("Palette and buttons", { commerce_palette_source: model.palette.value, cta_style: model.buttons.value, primary_accent: model.accent.value }, weakest([model.palette.provenance, model.buttons.provenance, model.accent.provenance])),
      line("Tone", model.tone.value, model.tone.provenance),
      line("Preserve", { avoid: model.avoid.value, block_placeholders: model.placeholders.value }, weakest([model.avoid.itemNotStated ? null : model.avoid.provenance, model.placeholders.provenance])),
      line("Commerce", COMMERCE_TEXT, null),
      line("Open brief questions", model.questions, null),
    ],
    word_count: rendered.wordCount,
    open_questions: model.questions ?? [],
  };
}
