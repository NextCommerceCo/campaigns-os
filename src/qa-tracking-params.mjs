// Tracking parameters reach the order: during a browser test order QA already
// places, seed synthetic attribution values on the runner's own loads before
// the campaign navigates, then report two results separately:
// - URL preservation (tracking.url): whether each seeded value is still in the
//   address on every page navigation observed, through to the navigation
//   after the order;
// - order attribution (tracking.order): whether the credited attribution field
//   reached the request of an order the store accepted.
// Declared <meta> tracking tags get one tracking.tag row each: the markup
// literal against the request's attribution metadata.
//
// The observer here is fed by listeners registered in qa-browser.mjs
// (captureCheckoutEvents and gotoAndSettle). It keeps raw values in memory
// only: the observation it persists holds the synthetic seed table, origin+path
// hop paths, equality outcomes, declared tag names and the sha256 of each tag
// literal. No query string, request or response body, attribution metadata or
// landing page is ever stored. Every extractor is wrapped: an exception records
// extractor_failed on its row and never breaks the order.
//
// rederiveQcResult(observation) is the rule the QC readers call; the producer
// builds every row through it, so a stored row only stands when its stored
// observation re-derives to the same result.
//
// SDK pin. The credited-field aliases, test-order attribution and tag grammar
// follow campaign-cart 12ba5d14: src/core/attribution/attribution-collector.ts
// lines 18-59 (credited fields and aliases) and 361-392 (tracking tags), and
// src/features/checkout/builders/order-builder.ts lines 172-216 (test-order
// attribution). Both line ranges are unchanged at the v0.4.38 tag, the pin of
// the vendored attribute index (src/sdk-attribute-index.mjs).
import { createHash, randomBytes } from "node:crypto";

import { aggregateQcResults, buildQcResult, toQaAssertion } from "./qc-results.mjs";
import { REDACTED_QUERY, TRUNCATED, redactUrlQueriesInText, redactUrlQuery } from "./qa-url-privacy.mjs";

export const TRACKING_CHECKS = Object.freeze(["tracking.url", "tracking.order", "tracking.tag"]);
const ROW_KEY = Object.freeze({ "tracking.url": "url", "tracking.order": "order", "tracking.tag": "tag" });
const FAMILY = "browser-test-order";

// Credited order field -> the URL names the SDK reads for it, preferred first
// (affid beats aff; the long subaffiliate form beats the short one).
export const CREDITED_FIELD_ALIASES = Object.freeze({
  affiliate: Object.freeze(["affid", "aff"]),
  funnel: Object.freeze(["funnel"]),
  gclid: Object.freeze(["gclid"]),
  utm_source: Object.freeze(["utm_source"]),
  utm_medium: Object.freeze(["utm_medium"]),
  utm_campaign: Object.freeze(["utm_campaign"]),
  utm_content: Object.freeze(["utm_content"]),
  utm_term: Object.freeze(["utm_term"]),
  subaffiliate1: Object.freeze(["subaffiliate1", "sub1"]),
  subaffiliate2: Object.freeze(["subaffiliate2", "sub2"]),
  subaffiliate3: Object.freeze(["subaffiliate3", "sub3"]),
  subaffiliate4: Object.freeze(["subaffiliate4", "sub4"]),
  subaffiliate5: Object.freeze(["subaffiliate5", "sub5"]),
});

// The published default seed policy: one URL name per credited field below.
export const DEFAULT_SEEDED_URL_NAMES = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "affid", "sub1", "subaffiliate2"]);
// Credited fields the default policy leaves unseeded; each is an explicit
// excluded / not_seeded_by_policy order member unless tracking.preserve opts
// it in (funnel and gclid never can: they are on the never-seeded list).
export const NOT_SEEDED_BY_DEFAULT = Object.freeze(["funnel", "gclid", "subaffiliate3", "subaffiliate4", "subaffiliate5"]);
const NEVER_SEEDED = Object.freeze(["funnel", "reset", "test", "debugger", "payment_failed", "payment_method", "gclid", "fbclid", "clickid", "evclid"]);
export const MAX_SEEDED_KEYS = 16;
const UTM_FIELDS = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
const ORDER_SOURCES = Object.freeze(["request", "create_response", "readback"]);
const OUTCOMES = Object.freeze(["equal", "differs", "absent"]);
const CREATE_OUTCOMES = Object.freeze(["accepted", "rejected", "failed", "none"]);
const EXTRACTORS = Object.freeze(["hop_equality", "request_equality", "response_equality", "tag_dom_read", "page_script_scan"]);
const PAGE_SCRIPT_CALLS = Object.freeze(["setAttribution(", "addMetadata(", "setMetadata("]);
const SCRIPT_SCAN_MAX_BYTES = 1024 * 1024;
// Everything the observer makes an attempt wait for (document reads the
// runner awaits, the create-response read, the final settle) shares this one
// budget, so tracking adds at most this much to an attempt.
export const TRACKING_ADDED_BOUND_MS = 1000;
// A read nothing awaits still gives up after this long.
const DOCUMENT_READ_TIMEOUT_MS = 1000;
const SDK_TEST_UTM_SOURCE = "konami_code";
// The campaign's own SDK loader, campaign-cart@v<version>/dist/loader.js; only
// the package and version are kept.
const LOADER_PIN_PATTERN = /campaign-cart@(v?\d+(?:\.\d+){0,2}(?:-[0-9a-z.]+)?)\/dist\/loader\.js/i;
const LOADER_PIN_VALUE = /^campaign-cart@v?\d+(?:\.\d+){0,2}(?:-[0-9a-z.]+)?$/i;

export function loaderPinOf(url) {
  const match = LOADER_PIN_PATTERN.exec(String(url || ""));
  return match ? `campaign-cart@${match[1]}` : null;
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const sha256 = (text) => `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
// A rendered tag's name is page text: it is persisted cut at its first query
// (qa-url-privacy.mjs). The projection of a non-blank name is never blank.
const persistedTagName = (name) => redactUrlQueriesInText(name);
// A hop's origin+path, with no query left in it in any encoding (a path can
// carry an encoded "?"). Persisted exits project rows again with the same
// projection, which leaves these unchanged.
const persistedPath = (url) => redactUrlQueriesInText(redactUrlQuery(url));

// The attempt's raw observation, kept on the runner's in-memory result under a
// symbol key so it is never serialized.
export const TRACKING_OBSERVATION = Symbol("campaigns-os.tracking-observation");

// ---------------------------------------------------------------------------
// Markers

// The rows each extractor feeds: a failed extractor bars a pass on each.
const EXTRACTOR_ROWS = Object.freeze({
  hop_equality: Object.freeze(["tracking.url"]),
  request_equality: Object.freeze(["tracking.order", "tracking.tag"]),
  response_equality: Object.freeze(["tracking.order"]),
  tag_dom_read: Object.freeze(["tracking.tag"]),
  page_script_scan: Object.freeze(["tracking.order", "tracking.tag"]),
});
const SHA256_LITERAL = /^sha256:[a-f0-9]{64}$/;
const isSeq = (value) => Number.isInteger(value) && value >= 0;
const oneOf = (values) => (value) => values.includes(value);

// The one closed schema of the status and completeness markers of a 1.1
// observation. Capture (finalize) and re-derivation (readObservation) both
// check every marker against it:
//   at        where it lives: the observation, every hop, every seeded key of
//             a hop's params, every order field entry, every name entry;
//   valid     its vocabulary; a missing, null, unknown or ill-typed value is
//             outside it and never reads as a success value (`optional`:
//             absence is judged by `valid` too);
//   complete  the valid values that may contribute to a pass;
//   failure   what an invalid value is recorded as, where the marker has one
//             (never a complete value);
//   extractor the extractor an invalid value fails, where it has no failure
//             value (a function of the entry for an order field outcome);
//   feeds     the rows it feeds; a value that is invalid, or valid but not
//             complete, bars a pass on each, with `reason` (`bars`: only
//             the rows a listed extractor feeds);
//   producer  the markers the producer adds beside the contract's fields.
// Every observation finalize writes carries every marker listed here.
//
// A marker whose complete value depends on a read starts in a value that is
// not complete (tag_read "not_run", page_script_involved and
// sdk_test_attribution null) and takes a complete value only when that read
// completes, so an attempt whose read never ran never reads as one whose read
// found nothing.
export const OBSERVATION_MARKERS = Object.freeze({
  extractor_failed: Object.freeze({
    at: "observation", key: "extractor_failed", producer: true,
    valid: (value) => Array.isArray(value) && value.every((name) => EXTRACTORS.includes(name)),
    complete: (value) => value.length === 0,
    failure: () => [...EXTRACTORS],
    feeds: TRACKING_CHECKS, bars: (value) => [...new Set(value.flatMap((name) => EXTRACTOR_ROWS[name]))], reason: "extractor_failed",
  }),
  // "not_run": no document read completed, so no tag list was read.
  tag_read: Object.freeze({
    at: "observation", key: "tag_read", producer: true,
    valid: oneOf(["read", "failed", "not_run"]), complete: oneOf(["read"]), failure: () => "failed",
    feeds: ["tracking.tag"], reason: "extractor_failed",
  }),
  request_read: Object.freeze({
    at: "observation", key: "request_read", producer: true,
    valid: oneOf(["parsed", "unreadable", "none"]), complete: oneOf(["parsed"]), failure: () => "unreadable",
    feeds: ["tracking.order", "tracking.tag"], reason: (value) => (value === "none" ? "no_accepted_order" : "request_body_unreadable"),
  }),
  // null: no create request body was parsed, so the marker was never read.
  sdk_test_attribution: Object.freeze({
    at: "observation", key: "sdk_test_attribution", producer: true,
    valid: (value) => value === null || value === true || value === false, complete: oneOf([false]), failure: () => true,
    feeds: ["tracking.order"], reason: "sdk_test_attribution",
  }),
  recovered: Object.freeze({
    at: "observation", key: "recovered", producer: true,
    valid: oneOf([true, false]), complete: oneOf([false]), failure: () => true,
    feeds: ["tracking.url", "tracking.order"], reason: "attempt_recovered_on_new_page",
  }),
  create: Object.freeze({
    at: "observation", key: "create",
    valid: oneOf(CREATE_OUTCOMES), complete: oneOf(["accepted"]), failure: () => "none",
    feeds: TRACKING_CHECKS, reason: { "tracking.url": "attempt_incomplete", "tracking.order": "no_accepted_order", "tracking.tag": "no_accepted_order" },
  }),
  attribution_object: Object.freeze({
    at: "observation", key: "attribution_object",
    valid: oneOf([true, false]), complete: oneOf([true]), failure: () => false,
    feeds: ["tracking.order"], reason: "attribution_not_sent",
  }),
  // Both booleans are complete observations (true is judged as page-script
  // involvement); null is a scan that never completed (no document's inline
  // scripts were read and no received script made a call); anything else,
  // such as a DOM scan that answered neither, is a failed scan.
  page_script_involved: Object.freeze({
    at: "observation", key: "page_script_involved",
    valid: (value) => value === null || value === true || value === false, complete: oneOf([true, false]), extractor: "page_script_scan",
    feeds: ["tracking.order", "tracking.tag"], reason: "extractor_failed",
  }),
  measured_seed_seq: Object.freeze({
    at: "observation", key: "measured_seed_seq",
    valid: (value) => value === null || isSeq(value), complete: isSeq, failure: () => null,
    feeds: ["tracking.url"], reason: "seed_hop_not_observed",
  }),
  post_order_seq: Object.freeze({
    at: "observation", key: "post_order_seq",
    valid: (value) => value === null || isSeq(value), complete: isSeq, failure: () => null,
    feeds: ["tracking.url"], reason: "attempt_incomplete",
  }),
  "hop.seq": Object.freeze({
    at: "hop", key: "seq",
    valid: (value, context) => {
      if (!isSeq(value) || context.seqs.has(value)) return false;
      context.seqs.add(value);
      return true;
    },
    complete: () => true, extractor: "hop_equality",
    feeds: ["tracking.url"], reason: "extractor_failed",
  }),
  "hop.initiator": Object.freeze({
    at: "hop", key: "initiator",
    valid: oneOf(["runner", "page"]), complete: () => true, extractor: "hop_equality",
    feeds: ["tracking.url"], reason: "extractor_failed",
  }),
  "hop.kind": Object.freeze({
    at: "hop", key: "kind",
    valid: oneOf(["document", "history"]), complete: () => true, extractor: "hop_equality",
    feeds: ["tracking.url"], reason: "extractor_failed",
  }),
  // false is judged per hop by the URL rule (a gap in the measured sequence).
  "hop.observer_attached": Object.freeze({
    at: "hop", key: "observer_attached",
    valid: oneOf([true, false]), complete: () => true, extractor: "hop_equality",
    feeds: ["tracking.url"], reason: "extractor_failed",
  }),
  "hop.params.*": Object.freeze({
    at: "hop.params",
    valid: oneOf(OUTCOMES), complete: () => true, extractor: "hop_equality",
    feeds: ["tracking.url"], reason: "extractor_failed",
  }),
  "field.source": Object.freeze({
    at: "field", key: "source",
    valid: oneOf(ORDER_SOURCES), complete: () => true, extractor: "response_equality",
    feeds: ["tracking.order"], reason: "extractor_failed",
  }),
  "field.outcome": Object.freeze({
    at: "field", key: "outcome",
    valid: oneOf(OUTCOMES), complete: () => true, extractor: (entry) => (entry.source === "request" ? "request_equality" : "response_equality"),
    feeds: ["tracking.order"], reason: "extractor_failed",
  }),
  "name.source": Object.freeze({
    at: "name", key: "source",
    valid: oneOf(ORDER_SOURCES), complete: () => true, extractor: "request_equality",
    feeds: ["tracking.order", "tracking.tag"], reason: "extractor_failed",
  }),
  // null: the request was not compared (no request body was parsed).
  "name.outcome": Object.freeze({
    at: "name", key: "outcome",
    valid: (value) => value === null || OUTCOMES.includes(value), complete: oneOf(OUTCOMES), extractor: "request_equality",
    feeds: ["tracking.order", "tracking.tag"], reason: "extractor_failed",
  }),
  // Which kind of entry this is: true for a rendered tag's entry, false for a
  // seeded declared name's. An observation in the contract's own shape has
  // none; there the presence of literal_sha256 alone tells them apart.
  "name.rendered": Object.freeze({
    at: "name", key: "rendered", producer: true, optional: true,
    valid: (value, context, entry, present) => (present ? value === true || value === false : context.contractShape),
    complete: () => true, extractor: "tag_dom_read",
    feeds: ["tracking.tag"], reason: "extractor_failed",
  }),
  // Present on a rendered tag's entry only. Its absence is valid only on the
  // entry of a seeded declared name that was never rendered (rendered
  // false), so a rendered tag whose hash is missing is a failed tag read,
  // never a declared name.
  "name.literal_sha256": Object.freeze({
    at: "name", key: "literal_sha256", optional: true,
    valid: (value, context, entry, present) => {
      const rendered = Object.hasOwn(entry, "rendered") ? entry.rendered : context.contractShape ? present : null;
      return present
        ? rendered === true && typeof value === "string" && SHA256_LITERAL.test(value)
        : rendered === false && context.declared.has(entry.tag_or_name);
    },
    complete: () => true, extractor: "tag_dom_read",
    feeds: ["tracking.tag"], reason: "extractor_failed",
  }),
});
// The observation-level markers only the producer writes: an observation
// with none of them is in the contract's own shape.
const PRODUCER_MARKERS = Object.freeze(Object.keys(OBSERVATION_MARKERS).filter((id) => OBSERVATION_MARKERS[id].producer && OBSERVATION_MARKERS[id].at === "observation"));
const isContractShape = (observation) => PRODUCER_MARKERS.every((id) => !Object.hasOwn(observation, OBSERVATION_MARKERS[id].key));
// A rendered tag's entry: marked rendered, or carrying a literal hash. An
// entry that lost either one stays a tag entry (and fails the tag read).
const isTagEntry = (entry) => entry.rendered === true || Object.hasOwn(entry, "literal_sha256");

const markerReason = (marker, check, value) => {
  if (typeof marker.reason === "function") return marker.reason(value);
  return typeof marker.reason === "string" ? marker.reason : marker.reason[check];
};
const markerExtractor = (marker, holder) => (typeof marker.extractor === "function" ? marker.extractor(holder) : marker.extractor ?? null);

// Visits every marker location of an observation in schema order:
// visit(id, marker, holder, key, value, valid). `keys` are the seeded URL
// names (every hop's params are checked on each) and `declared` the seeded
// names with no credited field.
function walkMarkers(observation, { keys, declared }, visit) {
  const context = { seqs: new Set(), declared: new Set(declared), contractShape: isContractShape(observation) };
  const entries = (list) => (Array.isArray(list) ? list.filter(isPlainObject) : []);
  const hops = entries(observation.hops);
  const at = {
    observation: [observation],
    hop: hops,
    field: entries(observation.fields),
    name: entries(observation.names),
  };
  for (const [id, marker] of Object.entries(OBSERVATION_MARKERS)) {
    const locations = marker.at === "hop.params"
      ? hops.filter((hop) => isPlainObject(hop.params)).flatMap((hop) => keys.map((key) => [hop.params, key]))
      : at[marker.at].map((holder) => [holder, marker.key]);
    for (const [holder, key] of locations) {
      const present = Object.hasOwn(holder, key);
      const value = holder[key];
      const valid = present || marker.optional ? marker.valid(value, context, holder, present) : false;
      visit(id, marker, holder, key, value, valid);
    }
  }
}

// ---------------------------------------------------------------------------
// Seed policy

export function creditedFieldFor(name) {
  for (const [field, aliases] of Object.entries(CREDITED_FIELD_ALIASES)) {
    if (aliases.includes(name)) return field;
  }
  return null;
}

const isNeverSeeded = (name) => NEVER_SEEDED.includes(name.toLowerCase()) || name.toLowerCase().startsWith("force");
// A name the persisted projection could change (a query or fragment
// character, a "%", a "://", a projection marker, or any other text the
// projection rewrites) is never seeded: no row may depend on a key whose
// stored form differs from the one it was judged under. The projection of
// such a name is one too, so the stored name reads the same way again.
const UNSEEDABLE_TEXT = /[?#%]|:\/\//;
const changedByProjection = (name) => UNSEEDABLE_TEXT.test(name)
  || name.includes(REDACTED_QUERY)
  || name.includes(TRUNCATED)
  || redactUrlQueriesInText(name) !== name;
const aliasRank = (field, name) => CREDITED_FIELD_ALIASES[field].indexOf(name);

// The URL names a run seeds, by the first rule that applies to each
// tracking.preserve name: never-seeded names, and names the persisted
// projection could change (kept as their projection), are excluded; a
// credited field or alias is seeded in the SDK's preferred form, one name per
// field; any other name is seeded as a declared name. Seeded keys stop at
// MAX_SEEDED_KEYS; a name past the cap is listed as overflow.
export function trackingSeedPlan(preserve = []) {
  const seeded = DEFAULT_SEEDED_URL_NAMES.map((name) => ({ name, field: creditedFieldFor(name), declared: false }));
  const excluded = [];
  const overflow = [];
  const declared = [...new Set((Array.isArray(preserve) ? preserve : [])
    .filter(isNonEmptyString)
    .map((name) => name.trim())
    .map((name) => (changedByProjection(name) ? redactUrlQueriesInText(name) : name)))];
  for (const name of declared) {
    if (isNeverSeeded(name) || changedByProjection(name)) {
      if (!excluded.includes(name)) excluded.push(name);
      continue;
    }
    const field = creditedFieldFor(name);
    const sameField = field ? seeded.find((entry) => entry.field === field) : null;
    if (sameField) {
      // Two names for one credited field: only the SDK's preferred form.
      if (aliasRank(field, name) < aliasRank(field, sameField.name)) sameField.name = name;
      continue;
    }
    if (seeded.some((entry) => entry.name === name)) continue;
    if (seeded.length >= MAX_SEEDED_KEYS) {
      overflow.push({ name, field });
      continue;
    }
    seeded.push({ name, field, declared: true });
  }
  return { seeded, excluded, overflow, preserve: declared };
}

const seedSlug = (name) => name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "param";

// The run's seed table: synthetic values cosqa_<name>_<run8>, where run8 is a
// lowercase hex token generated per run.
export function createTrackingSeedTable({ spec = null, random = randomBytes } = {}) {
  const preserve = spec?.analytics?.params?.tracking?.preserve;
  const plan = trackingSeedPlan(preserve);
  const token = Buffer.from(random(4)).toString("hex").slice(0, 8).padEnd(8, "0");
  const seeds = Object.fromEntries(plan.seeded.map(({ name }) => [name, `cosqa_${seedSlug(name)}_${token}`]));
  return { plan, seeds };
}

// ---------------------------------------------------------------------------
// Equality (in memory; only the outcome leaves)

// A value equals its seed only when it is a string identical to it; any other
// JSON value (an array, number, object or boolean) differs. A missing value,
// null or an empty string is absent.
function outcomeOf(value, expected) {
  if (value === undefined || value === null || value === "") return "absent";
  return typeof value === "string" && value === expected ? "equal" : "differs";
}

function hopParams(url, seeds) {
  const params = new URL(url).searchParams;
  return Object.fromEntries(Object.entries(seeds).map(([name, value]) => [name, outcomeOf(params.has(name) ? params.get(name) : undefined, value)]));
}

// The literal calls a page script uses to set attribution itself.
export function hasPageScriptCall(text) {
  const source = String(text || "");
  return PAGE_SCRIPT_CALLS.some((call) => source.includes(call));
}

// Read in the page: the declared tags (name and value both non-empty, as the
// SDK reads them), whether an inline script makes a page-script call, and the
// SDK loader pin of any script element (package and version only).
function documentReadScript() {
  return ({ calls, loader }) => {
    const tags = Array.from(document.querySelectorAll('meta[name="os-tracking-tag"], meta[name="data-next-tracking-tag"]'))
      .map((meta) => ({ name: meta.getAttribute("data-tag-name"), value: meta.getAttribute("data-tag-value") }))
      .filter((tag) => tag.name && tag.value);
    const inline = Array.from(document.scripts).some((script) => !script.src && calls.some((call) => (script.textContent || "").includes(call)));
    const pattern = new RegExp(loader, "i");
    const pins = Array.from(document.scripts)
      .map((script) => pattern.exec(script.src || ""))
      .filter(Boolean)
      .map((match) => `campaign-cart@${match[1]}`);
    return { tags, inline, pins };
  };
}

// ---------------------------------------------------------------------------
// Per-run state and the per-attempt observer

export function createTrackingRun({ runId, spec = null, hooks = null, random = randomBytes } = {}) {
  const table = createTrackingSeedTable({ spec, random });
  const attempts = new Map();
  return {
    seeds: table.seeds,
    observe(plan) {
      const index = (attempts.get(plan) || 0) + 1;
      attempts.set(plan, index);
      return createTrackingObserver({ table, plan, runId, attemptId: `${plan}:${index}`, hooks });
    },
    // The rows of one plan: computed for the attempt that produced the
    // accepted order, or for the last attempt when none was accepted. The
    // choice is made over every attempt, observed or not, so an attempt with
    // no observation yields no rows (the QC handoff then lists the checks as
    // not captured) rather than an earlier attempt's rows. An attempt that
    // needed recovery on a new page is marked as such; otherwise the
    // observation's own `recovered` marker stands as captured, so a missing
    // or invalid one still reads as not complete.
    rowsFor({ attempts: planAttempts = [], recoveredAttempt = null, measuredAt = new Date().toISOString() } = {}) {
      const all = planAttempts.filter((attempt) => attempt && typeof attempt === "object");
      if (!all.length) return [];
      const accepted = (attempt) => (isPlainObject(attempt[TRACKING_OBSERVATION])
        ? attempt[TRACKING_OBSERVATION].create === "accepted"
        : Number(attempt.order_creates?.accepted_create_responses) > 0);
      const chosen = [...all].reverse().find(accepted) || all.at(-1);
      if (!isPlainObject(chosen[TRACKING_OBSERVATION])) return [];
      const recovered = Boolean(recoveredAttempt) && recoveredAttempt === chosen;
      const observation = recovered ? { ...chosen[TRACKING_OBSERVATION], recovered: true } : chosen[TRACKING_OBSERVATION];
      return trackingQcRows(observation, { measuredAt });
    },
  };
}

export function createTrackingObserver({ table, plan, runId, attemptId, hooks = null }) {
  const { seeds } = table;
  const seededFields = table.plan.seeded.filter((entry) => entry.field);
  const declaredNames = table.plan.seeded.filter((entry) => !entry.field).map((entry) => entry.name);
  const failed = new Set();
  const hops = [];
  // In-flight reads, each registered by observeRead with the extractors it
  // feeds before anything awaits it.
  const pending = new Set();
  let spentMs = 0;
  let nextSeq = 0;
  let runnerPending = false;
  let lastSeededLoad = null;
  let pageHopSeen = false;
  let pageHopCount = 0;
  let measuredSeedSeq = null;
  let gapPending = false;
  let acceptedAt = null;
  let postOrderSeq = null;
  // `frozen`: no document or script read begins once the create request is
  // sent or the attempt is being finalized. `finalized`: the observation has
  // been taken and is never written again; a read settling after it had its
  // extractors failed when it was taken.
  let frozen = false;
  let finalized = false;
  let snapshot = null;
  // Not run until a read completes: tagRead becomes "read" when a document's
  // tag list is read; pageScriptInvolved a boolean when a document's inline
  // scripts are scanned, or true when any scan finds a page-script call.
  let tagRead = "not_run";
  let pageScriptInvolved = null;
  // Every distinct literal each declared tag was rendered with, across the
  // documents read; an empty set is a tag whose literal could not be kept.
  const tagLiterals = new Map();
  const loaderPins = new Set();
  // Every create request of the attempt, kept in memory until finalize and
  // never persisted; and every echo of each response source, in arrival
  // order. No observation replaces an earlier one.
  const requests = [];
  const echoes = { create_response: [], readback: [] };
  // Accepted creates the response listener saw, and how many create bodies
  // each reader (the held tap, the listener) actually read. An accepted create
  // neither reader read is an unread echo, never an absent one.
  const createReads = { accepted: 0, tap: 0, listener: 0 };

  const fail = (...names) => {
    if (finalized) return;
    for (const name of names) failed.add(name);
  };
  // Each extractor runs inside this wrapper: the test seam is called first,
  // and any exception marks that extractor failed instead of escaping.
  const extract = (name, fn) => {
    try {
      if (typeof hooks?.beforeExtractor === "function") hooks.beforeExtractor(name);
      return { ok: true, value: fn() };
    } catch {
      fail(name);
      return { ok: false };
    }
  };
  const remainingMs = () => Math.max(0, TRACKING_ADDED_BOUND_MS - spentMs);
  // Waits for `promise` at most `limitMs`; a wait the attempt makes is
  // charged to its added-time budget. Never rejects.
  const within = async (promise, limitMs, { charge = true } = {}) => {
    const started = Date.now();
    const TIMED_OUT = Symbol("timed out");
    let timer = null;
    try {
      const outcome = await Promise.race([
        Promise.resolve(promise).then((value) => ({ ok: true, value }), () => ({ ok: false })),
        new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, limitMs)); }),
      ]);
      if (outcome === TIMED_OUT) return { status: "timed_out" };
      return outcome.ok ? { status: "ok", value: outcome.value } : { status: "rejected" };
    } finally {
      clearTimeout(timer);
      if (charge) spentMs += Date.now() - started;
    }
  };
  // The one path an asynchronous read feeding a 1.1 row takes (document and
  // script reads, order bodies, the held create body, the tap's CDP setup).
  // The read is registered with the extractors it `feeds` before `start`
  // runs, so nothing awaits it unseen. `record` takes the value of a read
  // that settled before the observation was taken; one that rejects,
  // overruns `limitMs` or throws in `record` fails its extractors, and one
  // still pending when the observation is taken fails them there. A read
  // settling after that changes nothing: the observation already records the
  // failure and is never written again, so no row built from it goes stale.
  // Never rejects.
  const observeRead = (feeds, start, record = null, { limitMs = null, charge = true } = {}) => {
    if (finalized) return Promise.resolve();
    const entry = { feeds, done: null };
    pending.add(entry);
    let read;
    try {
      read = Promise.resolve(start());
    } catch (error) {
      read = Promise.reject(error);
    }
    const outcome = limitMs === null
      ? read.then((value) => ({ status: "ok", value }), () => ({ status: "rejected" }))
      : within(read, limitMs, { charge });
    entry.done = outcome.then((settled) => {
      pending.delete(entry);
      if (finalized) return;
      if (settled.status !== "ok") {
        fail(...feeds);
        return;
      }
      try {
        if (record) record(settled.value);
      } catch {
        fail(...feeds);
      }
    });
    return entry.done;
  };

  // A body that is not an order object carries no echo.
  const recordEcho = (source, body) => {
    if (!isPlainObject(body)) return;
    extract("response_equality", () => {
      const attribution = isPlainObject(body.attribution) ? body.attribution : null;
      if (attribution) echoes[source].push(Object.fromEntries(seededFields.map(({ name, field }) => [field, outcomeOf(attribution[field], seeds[name])])));
    });
  };

  // The response listener's in-memory body (null when its read failed). An
  // unread read-back is a failed extractor; an unread create body is one only
  // if the held tap did not read it either (checked at finalize).
  const onOrderResponse = (source, body) => {
    if (body === null || body === undefined) {
      if (source === "readback") fail("response_equality");
      return;
    }
    if (source === "create_response") createReads.listener += 1;
    recordEcho(source, body);
  };

  // A document read's answer: declared tags as {name, value} strings, the
  // inline page-script scan as a boolean (checked against the
  // page_script_involved marker) and loader pins. A tag list or scan answer
  // of any other shape is that extractor failed, never "nothing rendered" or
  // "no involvement".
  const recordDocument = (value) => {
    if (!isPlainObject(value)) {
      fail("tag_dom_read", "page_script_scan");
      return;
    }
    for (const pin of Array.isArray(value.pins) ? value.pins : []) if (LOADER_PIN_VALUE.test(String(pin))) loaderPins.add(String(pin));
    if (!Array.isArray(value.tags) || !value.tags.every((tag) => isPlainObject(tag) && typeof tag.name === "string" && typeof tag.value === "string")) {
      fail("tag_dom_read");
    } else {
      // The literal is kept exactly as rendered: a non-empty value is a tag
      // even when it is only whitespace (the SDK reads it as given).
      const rendered = value.tags.filter((tag) => isNonEmptyString(tag.name) && tag.value !== "");
      for (const tag of rendered) if (!tagLiterals.has(tag.name)) tagLiterals.set(tag.name, new Set());
      const read = extract("tag_dom_read", () => {
        for (const tag of rendered) tagLiterals.get(tag.name).add(String(tag.value));
      });
      if (read.ok) tagRead = "read";
    }
    if (typeof value.inline !== "boolean") {
      fail("page_script_scan");
      return;
    }
    const scan = extract("page_script_scan", () => value.inline);
    if (scan.ok) pageScriptInvolved = pageScriptInvolved === true || scan.value === true;
  };

  return {
    // Called by gotoAndSettle before the runner navigates. Before the
    // attempt's first page-initiated hop the URL is seeded; after it, the load
    // is not re-seeded and only breaks continuity.
    runnerUrl(url, addParam) {
      try {
        runnerPending = true;
        if (pageHopSeen) return url;
        lastSeededLoad = { hopSeq: null };
        return Object.entries(seeds).reduce((target, [name, value]) => addParam(target, name, value), url);
      } catch {
        return url;
      }
    },

    // A listener in qa-browser.mjs could not read its event: a missed hop is
    // a gap in the sequence, a missed response an extractor failure.
    onListenerError(kind) {
      if (kind === "hop") gapPending = true;
      else fail("response_equality");
    },

    // The hop listener (main frame, framenavigated). `commit` is the
    // browser's own commit signal for this hop, when it gave one:
    // {url, newDocument}, newDocument true for a committed document and false
    // for a same-document navigation (pushState, replaceState, a fragment).
    // A hop is a document hop only when that signal, for exactly this URL,
    // says a new document committed. Every other hop (no signal, a signal
    // for another URL, a signal the page could not give) is a history hop,
    // so it can never be the post-order navigation.
    onFrameNavigated(url, commit = null) {
      try {
        if (!/^https?:\/\//i.test(String(url || ""))) {
          // A main-frame document QA cannot compare (an error page) once
          // the sequence has started is an unobserved step.
          if (hops.length) gapPending = true;
          return;
        }
        const initiator = runnerPending ? "runner" : "page";
        runnerPending = false;
        const kind = isPlainObject(commit) && commit.url === String(url) && commit.newDocument === true ? "document" : "history";
        if (initiator === "page" && !pageHopSeen) {
          pageHopSeen = true;
          measuredSeedSeq = lastSeededLoad ? lastSeededLoad.hopSeq : null;
        }
        if (initiator === "page") pageHopCount += 1;
        // Test seam: a listener attached only after the last pre-page-hop
        // runner load began misses every runner hop before the first page hop.
        if (hooks?.lateHopListener === true && initiator === "runner" && !pageHopSeen) return;
        // Test seam: the observer detached across the n-th page hop.
        if (initiator === "page" && hooks?.detachObserverAtPageHop === pageHopCount) {
          gapPending = true;
          return;
        }
        const params = extract("hop_equality", () => hopParams(url, seeds));
        if (!params.ok) {
          gapPending = true;
          return;
        }
        const seq = nextSeq;
        nextSeq += 1;
        hops.push({ seq, path: persistedPath(url), initiator, kind, observer_attached: !gapPending, params: params.value });
        gapPending = false;
        if (initiator === "runner" && !pageHopSeen && lastSeededLoad) lastSeededLoad.hopSeq = seq;
        if (acceptedAt !== null && postOrderSeq === null && initiator === "page" && kind === "document") postOrderSeq = seq;
      } catch {
        // A hop this listener could not record is a gap in the sequence.
        gapPending = true;
      }
    },

    // Inside the existing request listener, before summarizeRequestPostData
    // discards the body: an order create request. `postData` is the body or a
    // function that reads it; a read that throws is an extractor failure.
    onCreateRequest(postData) {
      if (finalized) return;
      frozen = true;
      const next = { read: "unreadable", attribution_object: false, sdk_test: false, fields: {}, names: {}, metadata: null };
      requests.push(next);
      extract("request_equality", () => {
        const text = typeof postData === "function" ? postData() : postData;
        let parsed = null;
        try {
          parsed = JSON.parse(String(text ?? ""));
        } catch {
          parsed = null;
        }
        if (!isPlainObject(parsed)) return;
        next.read = "parsed";
        const attribution = isPlainObject(parsed.attribution) ? parsed.attribution : null;
        next.attribution_object = Boolean(attribution);
        const metadata = isPlainObject(attribution?.metadata) ? attribution.metadata : {};
        // Only key presence is read for the SDK's test-order marker.
        next.sdk_test = Boolean(attribution) && (attribution.utm_source === SDK_TEST_UTM_SOURCE || Object.hasOwn(metadata, "test_order"));
        for (const { name, field } of seededFields) next.fields[field] = outcomeOf(attribution?.[field], seeds[name]);
        for (const name of declaredNames) next.names[name] = outcomeOf(Object.hasOwn(metadata, name) ? metadata[name] : undefined, seeds[name]);
        next.metadata = metadata;
      });
    },

    // Called synchronously when an order create response arrives: the
    // post-order navigation is the first page document hop after an accepted
    // create.
    onCreateResponseStatus(status) {
      if (!(Number(status) >= 200 && Number(status) < 300) || finalized) return;
      createReads.accepted += 1;
      if (acceptedAt === null) acceptedAt = nextSeq;
    },

    // The response listener's body read of an order response: the create
    // response or the receipt page's own order read-back. The listener starts
    // the read and hands it here before it awaits anything. An unread
    // read-back is a failed extractor; an unread create body is one only if
    // the held tap did not read it either (the reader count at finalize), so
    // the listener's create read feeds the row through that count.
    orderResponseBody(source, start) {
      if (source !== "create_response" && source !== "readback") return Promise.resolve();
      return observeRead(source === "readback" ? ["response_equality"] : [], start, (body) => onOrderResponse(source, body), { charge: false });
    },

    // The create response body, read while the response is held. Resolves
    // within the attempt's remaining added-time budget and never rejects; a
    // read that fails, returns nothing or overruns the budget marks
    // response_equality failed.
    tapCreateResponse(readBody) {
      return observeRead(["response_equality"], readBody, (body) => {
        if (body === null || body === undefined) {
          fail("response_equality");
          return;
        }
        createReads.tap += 1;
        recordEcho("create_response", body);
      }, { limitMs: remainingMs() });
    },

    // The CDP setup the create-body tap needs (session and Fetch.enable). It
    // feeds no extractor itself: a tap that never attached reads nothing, and
    // an accepted create no reader read is failed at finalize.
    attachTap(start) {
      return observeRead([], start, null, { charge: false });
    },

    // Script responses the page already received (no new request): a
    // page-script call in one counts as involvement. A body that cannot be
    // read, or is over 1 MiB, is a failed scan.
    onScriptResponse(response) {
      try {
        const pin = loaderPinOf(response.url());
        if (pin) loaderPins.add(pin);
      } catch {
        // The pin is read again from the document's script elements.
      }
      if (frozen) return Promise.resolve();
      return observeRead(["page_script_scan"], () => {
        const declared = Number(response.headers()?.["content-length"]);
        if (Number.isFinite(declared) && declared > SCRIPT_SCAN_MAX_BYTES) throw new RangeError("script over the scan limit");
        return response.body();
      }, (bytes) => {
        if (!bytes || typeof bytes.length !== "number" || bytes.length > SCRIPT_SCAN_MAX_BYTES) {
          fail("page_script_scan");
          return;
        }
        const scan = extract("page_script_scan", () => hasPageScriptCall(bytes.toString("utf8")));
        if (scan.ok && scan.value) pageScriptInvolved = true;
      }, { charge: false });
    },

    // The live DOM of an observed document: declared tags, inline page-script
    // calls and the loader pin. A read the runner awaits is held to the
    // attempt's remaining added-time budget; one nothing awaits (a document's
    // domcontentloaded) to DOCUMENT_READ_TIMEOUT_MS. A read that rejects,
    // times out or returns no object marks the tag read and the page-script
    // scan failed. No read begins after the create request (a document
    // rendered after it cannot have shaped it); one begun before it is
    // recorded if it lands before the observation is taken.
    readDocument(page, { awaited = true } = {}) {
      if (frozen) return Promise.resolve();
      return observeRead(
        ["tag_dom_read", "page_script_scan"],
        () => page.evaluate(documentReadScript(), { calls: PAGE_SCRIPT_CALLS, loader: LOADER_PIN_PATTERN.source }),
        recordDocument,
        { limitMs: awaited ? remainingMs() : DOCUMENT_READ_TIMEOUT_MS, charge: awaited },
      );
    },

    // The attempt's observation: synthetic seeds, hop and order equality
    // outcomes, declared tag names and literal hashes. `create` comes from
    // summarizeOrderCreateActivity over the whole event log. Reads still in
    // flight get what is left of the added-time budget; every one still
    // pending after it is a failed extractor, as is an accepted create whose
    // body no reader read. Its markers are checked against
    // OBSERVATION_MARKERS before it is returned, and it is never written
    // again.
    async finalize({ createActivity = null } = {}) {
      if (snapshot) return snapshot;
      frozen = true;
      if (pending.size) await within(Promise.allSettled([...pending].map((entry) => entry.done)), remainingMs());
      for (const entry of pending) fail(...entry.feeds);
      if (createReads.accepted > Math.max(createReads.tap, createReads.listener)) fail("response_equality");
      finalized = true;
      const create = createOutcome(createActivity);
      const parsed = requests.filter((entry) => entry.read === "parsed");
      const requestRead = !requests.length ? "none" : requests.some((entry) => entry.read !== "parsed") ? "unreadable" : "parsed";
      const fields = [];
      for (const { field } of seededFields) {
        for (const entry of parsed) fields.push({ field, source: "request", outcome: entry.fields[field] });
        for (const source of ["create_response", "readback"]) {
          for (const echo of echoes[source]) fields.push({ field, source, outcome: echo[field] });
        }
      }
      const names = [];
      for (const name of declaredNames) {
        if (!parsed.length) names.push({ tag_or_name: name, source: "request", outcome: null, rendered: false });
        for (const entry of parsed) names.push({ tag_or_name: name, source: "request", outcome: entry.names[name], rendered: false });
      }
      for (const [tag, literals] of tagLiterals) {
        const tagName = persistedTagName(tag);
        if (!literals.size) names.push({ tag_or_name: tagName, source: "request", outcome: null, literal_sha256: null, rendered: true });
        for (const literal of literals) {
          const literalSha = sha256(literal);
          if (!parsed.length) names.push({ tag_or_name: tagName, source: "request", outcome: null, literal_sha256: literalSha, rendered: true });
          for (const entry of parsed) {
            const metadata = entry.metadata || {};
            names.push({ tag_or_name: tagName, source: "request", outcome: outcomeOf(Object.hasOwn(metadata, tag) ? metadata[tag] : undefined, literal), literal_sha256: literalSha, rendered: true });
          }
        }
      }
      for (const entry of requests) entry.metadata = null;
      const raw = {
        plan,
        run_id: runId,
        attempt_id: attemptId,
        seeds: { ...seeds },
        preserve: [...table.plan.preserve],
        hops: hops.map((hop) => ({ ...hop, params: { ...hop.params } })),
        measured_seed_seq: pageHopSeen ? measuredSeedSeq : (lastSeededLoad ? lastSeededLoad.hopSeq : null),
        post_order_seq: postOrderSeq,
        create,
        request_read: requestRead,
        attribution_object: parsed.length > 0 && parsed.every((entry) => entry.attribution_object),
        sdk_test_attribution: parsed.length ? parsed.some((entry) => entry.sdk_test) : null,
        page_script_involved: pageScriptInvolved,
        fields,
        names,
        tag_read: failed.has("tag_dom_read") ? "failed" : tagRead,
        extractor_failed: EXTRACTORS.filter((name) => failed.has(name)),
        loader_pins: [...loaderPins].sort(),
        recovered: false,
      };
      // Test seam: the raw observation as capture produced it, before its
      // markers are checked.
      if (typeof hooks?.rawObservation === "function") hooks.rawObservation(raw);
      snapshot = captureMarkers(raw, { keys: Object.keys(seeds), declared: declaredNames });
      return snapshot;
    },
  };
}

// Capture's check of the finalized observation against OBSERVATION_MARKERS:
// an invalid marker is written as its failure value or fails its extractor,
// so a stored observation never holds a value outside the schema that a
// reader could take for a success. tag_read, page_script_involved and
// extractor_failed are kept in step: a tag read or page-script scan that is
// not complete is its extractor failed, and a failed tag read is never "read".
function captureMarkers(raw, scope) {
  const failed = new Set();
  walkMarkers(raw, scope, (id, marker, holder, key, value, valid) => {
    if (valid) return;
    if (marker.failure) holder[key] = marker.failure();
    const extractor = markerExtractor(marker, holder);
    if (extractor) failed.add(extractor);
  });
  for (const name of raw.extractor_failed) failed.add(name);
  if (raw.tag_read !== "read") failed.add("tag_dom_read");
  if (raw.page_script_involved === null) failed.add("page_script_scan");
  raw.extractor_failed = EXTRACTORS.filter((name) => failed.has(name));
  if (failed.has("tag_dom_read") && raw.tag_read === "read") raw.tag_read = "failed";
  return raw;
}

function createOutcome(activity) {
  if (!isPlainObject(activity)) return "none";
  if (Number(activity.accepted_create_responses) > 0) return "accepted";
  if (Number(activity.rejected_create_responses) > 0) return "rejected";
  if (Number(activity.failed_create_requests) > 0 || Number(activity.create_requests) > 0) return "failed";
  return "none";
}

// ---------------------------------------------------------------------------
// Rows

// Every row of an attempt, each built from rederiveQcResult so the stored row
// and a later read agree by construction.
export function trackingQcRows(observation, { measuredAt = new Date().toISOString() } = {}) {
  const tags = renderedTags(observation);
  const parts = [
    { check: "tracking.url" },
    { check: "tracking.order" },
    ...tags.map((tag) => ({ check: "tracking.tag", tag })),
    ...(!tags.length && tagReadFailed(observation) ? [{ check: "tracking.tag", tag: null }] : []),
  ];
  const rows = [];
  for (const part of parts) {
    const rowObservation = { ...observation, check: part.check };
    if (part.check === "tracking.tag") rowObservation.tag = part.tag;
    const row = buildRow(rowObservation, measuredAt);
    if (row) rows.push(row);
  }
  return rows;
}

// The run-scope rows of a QA run with no browser test order requested.
export function trackingRunScopeRows({ runId = null, measuredAt = new Date().toISOString() } = {}) {
  return TRACKING_CHECKS.map((check) => buildRow({ scope: "run", check, run_id: runId, reason_code: "test_order_not_requested" }, measuredAt)).filter(Boolean);
}

export function trackingQaAssertion(row) {
  return toQaAssertion(row, { family: FAMILY });
}

// Whether the observation's tag read is anything but complete (the tag-less
// tag row then reports it).
function tagReadFailed(observation) {
  try {
    return Boolean(readObservation(observation)?.failed.includes("tag_dom_read"));
  } catch {
    return false;
  }
}

function buildRow(observation, measuredAt) {
  const derived = rederiveQcResult(observation);
  if (!derived) return null;
  return buildQcResult({
    check: derived.check,
    leg: "qa",
    subject: derived.subject,
    result: derived.result,
    reason_code: derived.reason_code,
    state: derived.state,
    observation,
    members: derived.members,
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at: measuredAt,
  });
}

// ---------------------------------------------------------------------------
// Re-derivation

// Re-derives one row from its stored observation, or returns null when the
// observation is not one this rule can read (the reader then reports
// evidence_not_reproducible).
export function rederiveQcResult(observation) {
  try {
    return derive(observation);
  } catch {
    return null;
  }
}

function derive(observation) {
  if (!isPlainObject(observation) || !TRACKING_CHECKS.includes(observation.check)) return null;
  const { check } = observation;
  if (observation.scope === "run") {
    if (observation.reason_code !== "test_order_not_requested") return null;
    return {
      check,
      subject: { check, page: "run", key: ROW_KEY[check] },
      result: "excluded",
      reason_code: "test_order_not_requested",
      members: [],
      accept_eligible: false,
      // Nothing was loaded, so no loader pin could be read.
      coverage: { observed: 0, expected: null, limits: [], loader_pins: null },
      state: { scope: "run", run_id: observation.run_id ?? null, reason_code: "test_order_not_requested" },
    };
  }
  const read = readObservation(observation);
  if (!read) return null;
  if (check === "tracking.url") return urlRow(read);
  if (check === "tracking.order") return orderRow(read);
  return tagRow(read, observation.tag);
}

// The producer markers of an observation in the contract's own shape (none
// of them stored), as its rules read them.
const CONTRACT_SHAPE = Object.freeze({
  extractor_failed: () => [],
  tag_read: () => "read",
  request_read: (observation) => (observation.create === "accepted" || observation.create === "rejected" || observation.create === "failed" ? "parsed" : "none"),
  sdk_test_attribution: () => false,
  recovered: () => false,
});

// Re-derivation's check of a stored observation against OBSERVATION_MARKERS.
// Returns the observation-level values the rules read (an invalid one as its
// failure value), the failed extractors, and per row the first reason a
// marker bars its pass (`barred`). An observation with none of the producer
// markers is the contract's own shape: its rules read the contract's fields
// as they stand, but nothing records that its reads completed, so no row of
// it can pass.
function readMarkers(observation, scope) {
  const contractShape = isContractShape(observation);
  const values = {};
  const failed = new Set();
  const barred = new Map();
  const bar = (checks, reasonOf) => {
    for (const check of checks) if (!barred.has(check)) barred.set(check, reasonOf(check));
  };
  walkMarkers(observation, scope, (id, marker, holder, key, value, valid) => {
    if (contractShape && marker.producer && marker.at === "observation") {
      values[key] = CONTRACT_SHAPE[key](observation);
      bar(marker.feeds, (check) => markerReason(marker, check, null));
      return;
    }
    const read = valid || !marker.failure ? value : marker.failure();
    if (marker.at === "observation") values[key] = read;
    if (!valid) {
      const extractor = markerExtractor(marker, holder);
      if (extractor) failed.add(extractor);
    }
    if (!valid) bar(marker.feeds, (check) => markerReason(marker, check, read));
    else if (!marker.complete(read)) bar(marker.bars ? marker.bars(read) : marker.feeds, (check) => markerReason(marker, check, read));
  });
  for (const name of Array.isArray(values.extractor_failed) ? values.extractor_failed : EXTRACTORS) failed.add(name);
  if (values.tag_read !== "read") failed.add("tag_dom_read");
  if (values.page_script_involved === null) failed.add("page_script_scan");
  for (const name of EXTRACTORS) if (failed.has(name)) bar(EXTRACTOR_ROWS[name], () => "extractor_failed");
  return { values, failed, barred };
}

// The observation, checked against the vocabulary and against the seed plan
// its own preserve list implies (an observation outside them is not
// re-derivable); its markers are checked by readMarkers.
function readObservation(observation) {
  const {
    plan, run_id: runId, attempt_id: attemptId, seeds, hops, fields, names,
  } = observation;
  if (!isNonEmptyString(plan) || !isNonEmptyString(runId) || !isNonEmptyString(attemptId)) return null;
  if (!isPlainObject(seeds) || !Array.isArray(hops) || !Array.isArray(fields) || !Array.isArray(names)) return null;
  const preserve = observation.preserve ?? [];
  if (!Array.isArray(preserve) || !preserve.every((name) => typeof name === "string")) return null;
  const seedPlan = trackingSeedPlan(preserve);
  const keys = seedPlan.seeded.map((entry) => entry.name);
  if (!sameSet(Object.keys(seeds), keys) || !keys.every((key) => isNonEmptyString(seeds[key]))) return null;
  for (const hop of hops) {
    if (!isPlainObject(hop) || typeof hop.path !== "string" || !isPlainObject(hop.params)) return null;
    if (!Object.keys(hop.params).every((key) => keys.includes(key))) return null;
  }
  if (!fields.every((entry) => isPlainObject(entry) && isNonEmptyString(entry.field))) return null;
  if (!names.every((entry) => isPlainObject(entry) && isNonEmptyString(entry.tag_or_name))) return null;
  const loaderPins = observation.loader_pins ?? [];
  if (!Array.isArray(loaderPins) || !loaderPins.every((pin) => typeof pin === "string" && LOADER_PIN_VALUE.test(pin))) return null;
  const declared = seedPlan.seeded.filter((entry) => !entry.field).map((entry) => entry.name);
  const { values, failed, barred } = readMarkers(observation, { keys, declared });
  return {
    observation,
    plan,
    seedPlan,
    keys,
    hops: [...hops].sort((a, b) => a.seq - b.seq),
    measuredSeedSeq: values.measured_seed_seq,
    postOrderSeq: values.post_order_seq,
    create: values.create,
    requestRead: values.request_read,
    attributionObject: values.attribution_object === true,
    sdkTest: values.sdk_test_attribution !== false,
    pageScript: values.page_script_involved === true,
    recovered: values.recovered !== false,
    failed: EXTRACTORS.filter((name) => failed.has(name)),
    barred,
    fields,
    names: names.map((entry) => (entry.outcome === null || OUTCOMES.includes(entry.outcome) ? entry : { ...entry, outcome: null })),
    loaderPins: [...new Set(loaderPins)].sort(),
  };
}

// A row whose members would read pass while a marker it depends on is not
// complete reads unexercised with that marker's reason instead: every pass
// member takes it.
function barPass(read, check, members) {
  const reason = read.barred.get(check);
  if (!reason || aggregateQcResults(members).result !== "pass") return members;
  return members.map((entry) => (entry.result === "pass" ? member(entry.key, "unexercised", reason) : entry));
}

const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && b.every((item) => a.includes(item));

// What the accept state binds: run and attempt, the expected seeds, the full
// hop equality matrix, every order source outcome, the create outcome and
// page-script involvement, plus the row's own result.
function rowState(read, { reasonCode, members, extra = {} }) {
  const { observation } = read;
  return {
    run_id: observation.run_id,
    attempt_id: observation.attempt_id,
    reason_code: reasonCode,
    members: members.map(({ key, result, reason_code: reason }) => ({ key, result, reason_code: reason ?? null })),
    seeds: observation.seeds,
    hops: read.hops.map(({ seq, path, initiator, kind, observer_attached: attached, params }) => ({ seq, path, initiator, kind, observer_attached: attached, params })),
    fields: read.fields.map(({ field, source, outcome }) => ({ field, source, outcome })),
    names: observation.names.map(({ tag_or_name: name, source, outcome }) => ({ tag_or_name: name, source: source ?? null, outcome: outcome ?? null })),
    create: observation.create ?? null,
    page_script_involved: observation.page_script_involved ?? null,
    ...extra,
  };
}

const member = (key, result, reasonCode = null) => ({ key, result, reason_code: result === "pass" ? null : reasonCode });
const unexercisedReasons = (members) => [...new Set(members.filter((entry) => entry.result === "unexercised").map((entry) => entry.reason_code))];

// The 1.0 coverage shape: `expected` counts the members in scope (every one
// not excluded), `observed` those judged (in scope and not unexercised). The
// row's own limits and extra fields follow, then the campaign's SDK loader
// pins as observed during the attempt.
function rowCoverage(read, members, extra) {
  const inScope = members.filter((entry) => entry.result !== "excluded");
  return {
    observed: inScope.filter((entry) => entry.result !== "unexercised").length,
    expected: inScope.length,
    ...extra,
    loader_pins: read.loaderPins,
  };
}

function finishRow(read, check, key, members, coverage) {
  const aggregate = aggregateQcResults(members);
  return {
    check,
    subject: { check, page: read.plan, key },
    result: aggregate.result,
    reason_code: aggregate.reason_code,
    members,
    accept_eligible: aggregate.accept_eligible,
    coverage: rowCoverage(read, members, coverage),
    state: rowState(read, { reasonCode: aggregate.reason_code, members }),
  };
}

// ---- URL preservation

// The continuously observed sequence from the measured seed hop: it stops at
// the post-order navigation, at a runner hop after the first page hop, at a
// gap (a missing seq or a hop observed after the observer was detached), or
// at the last hop. A gap at or before the measured seed hop (the seed hop or
// an earlier hop recorded with observer_attached false, or a seq missing
// below it) leaves the seed hop itself unproven: the whole sequence reads as
// an observation gap.
function observedSequence(read) {
  const bySeq = new Map(read.hops.map((hop) => [hop.seq, hop]));
  const seedHop = read.measuredSeedSeq === null ? null : bySeq.get(read.measuredSeedSeq) || null;
  if (!seedHop) return { seedHop: null, sequence: [], reached: false, stop: "seed_hop_not_observed" };
  for (let seq = 0; seq <= seedHop.seq; seq += 1) {
    if (bySeq.get(seq)?.observer_attached !== true) return { seedHop, sequence: [seedHop], reached: false, stop: "observation_gap", seedGap: true };
  }
  const postHop = read.create === "accepted" && read.postOrderSeq !== null ? bySeq.get(read.postOrderSeq) : null;
  const postOrderSeq = postHop && postHop.initiator === "page" && postHop.kind === "document" && postHop.seq > seedHop.seq ? postHop.seq : null;
  const sequence = [seedHop];
  let previous = seedHop;
  let stop = null;
  while (previous.seq !== postOrderSeq) {
    const next = bySeq.get(previous.seq + 1);
    if (!next) {
      stop = read.hops.some((hop) => hop.seq > previous.seq) ? "observation_gap" : "end";
      break;
    }
    if (next.observer_attached !== true) {
      stop = "observation_gap";
      break;
    }
    if (next.initiator === "runner") {
      stop = "runner_reload_in_sequence";
      break;
    }
    sequence.push(next);
    previous = next;
  }
  return { seedHop, sequence, reached: postOrderSeq !== null && previous.seq === postOrderSeq, stop };
}

// One seeded key along the observed sequence. A failing hop is named only for
// a drop between two observed page hops; a loss next to the runner's own seed
// load is never blamed on a hop.
function urlKeyResult(key, observed) {
  const { seedHop, sequence, reached, stop } = observed;
  if (!seedHop) return member(key, "unexercised", "seed_hop_not_observed");
  if (observed.seedGap) return member(key, "unexercised", "observation_gap");
  if (seedHop.params[key] !== "equal") return member(key, "unexercised", "seed_hop_not_observed");
  let warning = null;
  let review = null;
  let unnamedLoss = false;
  for (let index = 1; index < sequence.length; index += 1) {
    const from = sequence[index - 1];
    const to = sequence[index];
    const before = from.params[key];
    const after = to.params[key];
    if (after === "equal") continue;
    if (to.kind === "document") {
      if (after === "differs") warning = warning || { reason: "url_param_changed" };
      else if (before === "equal" && from.initiator === "page") warning = warning || { reason: "url_param_dropped", failing_hop: { from: from.path, to: to.path } };
      else if (before === "equal") unnamedLoss = true;
    } else if (before === "equal" || before !== after) {
      review = review || { reason: "history_rewrite" };
    }
  }
  if (warning) {
    const result = member(key, "warning", warning.reason);
    return warning.failing_hop ? { ...result, failing_hop: warning.failing_hop } : result;
  }
  if (review) return member(key, "review", review.reason);
  if (unnamedLoss) return member(key, "unexercised", "no_page_hop_after_seed");
  if (reached) return member(key, "pass");
  if (stop === "observation_gap" || stop === "runner_reload_in_sequence") return member(key, "unexercised", stop);
  return member(key, "unexercised", sequence.length > 1 ? "attempt_incomplete" : "no_page_hop_after_seed");
}

function urlRow(read) {
  const observed = observedSequence(read);
  const forced = read.failed.includes("hop_equality") ? "extractor_failed" : read.recovered ? "attempt_recovered_on_new_page" : null;
  const members = barPass(read, "tracking.url", [
    ...read.keys.map((key) => (forced ? member(key, "unexercised", forced) : urlKeyResult(key, observed))),
    ...read.seedPlan.excluded.map((name) => member(name, "excluded", "not_seeded_by_policy")),
    ...read.seedPlan.overflow.map(({ name }) => member(name, "unexercised", "seed_allowlist_overflow")),
  ]);
  const lastObserved = observed.sequence.length ? observed.sequence.at(-1).path : null;
  return finishRow(read, "tracking.url", "url", members, { last_observed: lastObserved, limits: unexercisedReasons(members) });
}

// ---- Order attribution

// Why no seeded field can be judged, if any: the first that applies.
function orderBlocker(read) {
  if (read.failed.includes("request_equality") || read.failed.includes("response_equality") || read.failed.includes("page_script_scan")) return "extractor_failed";
  if (read.recovered) return "attempt_recovered_on_new_page";
  if (read.create !== "accepted" || read.requestRead === "none") return "no_accepted_order";
  if (read.requestRead === "unreadable") return "request_body_unreadable";
  if (!read.attributionObject) return "attribution_not_sent";
  return null;
}

// Every observation of every source counts; none replaces another. A pass
// needs at least one request observation, every request observation equal,
// and no observation of any source that differs.
function sourceOutcomes(entries) {
  const bySource = Object.fromEntries(ORDER_SOURCES.map((source) => [source, []]));
  for (const entry of entries) bySource[entry.source].push(entry.outcome);
  return { bySource, all: entries.map((entry) => entry.outcome) };
}

function fieldResult(read, field) {
  const { bySource, all } = sourceOutcomes(read.fields.filter((entry) => entry.field === field));
  if (!bySource.request.length) throw new TypeError(`no request outcome for ${field}`);
  if (all.includes("differs")) return read.pageScript ? ["review", "page_script_mapping"] : ["warning", "order_attribution_differs"];
  if (bySource.request.includes("absent")) return read.pageScript ? ["review", "page_script_mapping"] : ["warning", "order_attribution_missing"];
  if (read.pageScript && all.includes("absent")) return ["review", "page_script_mapping"];
  return ["pass", null];
}

// A declared name the SDK credits to no field: out of scope by the SDK's map,
// unless a rendered tag shares its name or the request metadata carries it.
function declaredNameResult(read, name) {
  if (read.names.some((entry) => entry.tag_or_name === name && isTagEntry(entry))) return ["review", "declared_tag_same_name"];
  const carried = read.names.filter((entry) => entry.tag_or_name === name && entry.source === "request" && !isTagEntry(entry));
  if (carried.some((entry) => entry.outcome === "equal" || entry.outcome === "differs")) return ["review", "page_script_mapping"];
  return ["excluded", "no_credited_field"];
}

function orderRow(read) {
  const blocker = orderBlocker(read);
  let members = [];
  const seen = new Set();
  const add = (key, result, reasonCode) => {
    if (seen.has(key)) return;
    seen.add(key);
    members.push(member(key, result, reasonCode));
  };
  for (const { field } of read.seedPlan.seeded) {
    if (!field) continue;
    if (blocker) add(field, "unexercised", blocker);
    else if (read.sdkTest && UTM_FIELDS.includes(field)) add(field, "unexercised", "sdk_test_attribution");
    else add(field, ...fieldResult(read, field));
  }
  const seededFields = new Set(read.seedPlan.seeded.map((entry) => entry.field).filter(Boolean));
  for (const field of NOT_SEEDED_BY_DEFAULT) if (!seededFields.has(field)) add(field, "excluded", "not_seeded_by_policy");
  for (const name of read.seedPlan.excluded) add(creditedFieldFor(name) || name, "excluded", "not_seeded_by_policy");
  for (const { name } of read.seedPlan.seeded) if (!creditedFieldFor(name)) add(name, ...declaredNameResult(read, name));
  for (const { name, field } of read.seedPlan.overflow) {
    if (field) add(field, "unexercised", "seed_allowlist_overflow");
    else add(name, ...declaredNameResult(read, name));
  }
  members = barPass(read, "tracking.order", members);
  const sourcesObserved = ORDER_SOURCES.filter((source) => read.fields.some((entry) => entry.source === source));
  const echoLimits = read.create === "accepted" && read.requestRead === "parsed"
    ? ["create_response", "readback"].filter((source) => !sourcesObserved.includes(source)).map((source) => `${source}: absent`)
    : [];
  return finishRow(read, "tracking.order", "order", members, { sources_observed: sourcesObserved, limits: [...echoLimits, ...unexercisedReasons(members)] });
}

// ---- Declared tags

function renderedTags(observation) {
  const names = Array.isArray(observation?.names) ? observation.names : [];
  return [...new Set(names.filter((entry) => isPlainObject(entry) && isTagEntry(entry) && isNonEmptyString(entry.tag_or_name)).map((entry) => entry.tag_or_name))];
}

// A tag row judges the request: a pass needs at least one request
// observation of metadata[X], every one equal to its literal, and no
// observation of any source that differs. A tag rendered with more than one
// literal keeps an entry per literal, so a request can equal only one of them.
function tagRow(read, tag) {
  const check = "tracking.tag";
  const entries = tag === null || tag === undefined
    ? []
    : read.names.filter((candidate) => candidate.tag_or_name === tag && isTagEntry(candidate));
  if (tag !== null && tag !== undefined && !entries.length) return null;
  if (!entries.length && !read.failed.includes("tag_dom_read")) return null;
  const literalShas = [...new Set(entries.map((entry) => entry.literal_sha256))].sort();
  // A literal not kept as a sha256, or an entry the request was not compared
  // with, is an incomplete tag read.
  const incomplete = entries.some((entry) => typeof entry.literal_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.literal_sha256) || entry.outcome === null);
  let result;
  if (read.failed.includes("tag_dom_read") || read.failed.includes("request_equality") || read.failed.includes("page_script_scan")) result = ["unexercised", "extractor_failed"];
  else if (read.create !== "accepted" || read.requestRead === "none") result = ["unexercised", "no_accepted_order"];
  else if (read.requestRead === "unreadable") result = ["unexercised", "request_body_unreadable"];
  else if (incomplete) result = ["unexercised", "extractor_failed"];
  else {
    const { bySource, all } = sourceOutcomes(entries);
    if (!bySource.request.length) return null;
    if (all.includes("differs")) result = read.pageScript ? ["review", "page_script_mapping"] : ["warning", "tag_value_differs"];
    else if (bySource.request.includes("absent")) result = read.pageScript ? ["review", "page_script_mapping"] : ["warning", "tag_missing"];
    else if (read.pageScript && all.includes("absent")) result = ["review", "page_script_mapping"];
    else result = ["pass", null];
  }
  if (result[0] === "pass" && read.barred.has(check)) result = ["unexercised", read.barred.get(check)];
  const [value, reasonCode] = result;
  return {
    check,
    subject: { check, page: read.plan, key: entries.length ? `tag:${tag}` : "tag" },
    result: value,
    reason_code: value === "pass" ? null : reasonCode,
    members: [],
    accept_eligible: value === "warning",
    coverage: {
      observed: value === "unexercised" ? 0 : 1,
      expected: 1,
      limits: value === "unexercised" ? [reasonCode] : [],
      loader_pins: read.loaderPins,
    },
    state: rowState(read, { reasonCode: value === "pass" ? null : reasonCode, members: [], extra: { tag: tag ?? null, literal_sha256: literalShas.length > 1 ? literalShas : literalShas[0] ?? null } }),
  };
}
