// Policy links resolve: for each configured campaign.store_* policy URL,
// `qa run --browser` reports two rows, both family browser-runtime:
// - presence (policy.presence:campaign:<field>, assertion
//   qc.policy.presence:<field>): a rendered anchor on the visited pages points
//   to the configured URL;
// - availability (policy.availability:campaign:<field>, assertion
//   qc.policy.availability:<field>): a bounded, header-only GET chain reaches
//   an HTML page.
//
// This module holds the URL normalization and classes, the presence counts,
// the availability probe, the result rules and the anchor reader. The page
// visits stay in qa-browser.mjs (runPageBrowserChecks), which calls
// readPageAnchors once per visited page; runBrowserChecks then calls
// runPolicyLinkChecks once, after the page checks.
//
// Privacy: link text is compared inside the page and never leaves it; presence
// keeps counts. A query is compared in memory and kept only as query_sha256
// (the sha256 of its sorted key=value pairs). Every stored URL is
// origin+path, written as the persisted-verdict projection
// (src/qa-url-privacy.mjs) leaves it, so a row and its verdict assertion carry
// the same observation. That projection can merge distinct paths (an encoded
// "?" in a path is redacted), so no rule compares stored URLs: each hop also
// keeps sha256 hashes of its raw URL, path and host (chain_identity), and the
// rules compare those.
//
// Time: one run budget (createPolicyLinkBudget) bounds the time the policy
// link checks add to a QA run. Every anchor read and the probes take their
// deadline from it, nothing starts once it is spent, and what it cut short
// reads unexercised.
//
// rederiveQcResult(observation) is the rule the QC readers call; the producer
// builds every row through it, and the availability outcome is a function of
// the stored request chain, so a stored outcome only stands when the chain
// re-derives to it.
import { createHash } from "node:crypto";

import { runWithDeadline } from "./deadline.mjs";
import { buildQcResult, toQaAssertion } from "./qc-results.mjs";
import { REDACTED_QUERY, redactPersisted } from "./qa-url-privacy.mjs";

export const POLICY_PRESENCE_CHECK = "policy.presence";
export const POLICY_AVAILABILITY_CHECK = "policy.availability";
const CHECKS = Object.freeze([POLICY_PRESENCE_CHECK, POLICY_AVAILABILITY_CHECK]);
const FAMILY = "browser-runtime";
const PAGE = "campaign";

// The CampaignSpec policy fields, in the order rows are written. store_url is
// not a policy.
export const POLICY_LINK_FIELDS = Object.freeze(["store_terms", "store_privacy", "store_returns", "store_shipping", "store_contact"]);

// Cost bound: at most 5 distinct URLs per run (one per field at most), all
// probed at once; per URL up to 6 requests (1 + 5 redirects), 5 s per request
// (its body cancel included) and a 15 s deadline; at most 30 requests. The
// anchor reads and the probes together add at most addedMs to the run.
export const POLICY_LINK_LIMITS = Object.freeze({
  maxUrls: 5,
  maxRedirects: 5,
  requestTimeoutMs: 5_000,
  deadlineMs: 15_000,
  addedMs: 20_000,
});
// The anchor read of one page, after its load settled.
const ANCHOR_READ_MS = 5_000;
// A page with more anchors than this is not read (its read would be partial).
const MAX_ANCHORS = 10_000;
// Anchor text is compared in full, inside the page. A page with an anchor text
// longer than this many characters is not read (its read would be partial).
const MAX_TEXT = 1_048_576;
// What the probe waits for a canceled body to settle, within its request's
// deadline.
const CANCEL_SETTLE_MS = 1_000;

const SCHEMES = Object.freeze(["http", "https", "mailto", "other", "invalid"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NOT_REQUESTED = "browser_checks_not_requested";
const INVALID = "configured_url_invalid";
const NON_HTTP = "non_http_destination";
const NETWORK = "network_unavailable";
const PAGES_NOT_READ = "pages_not_read";
const HTML_TYPES = Object.freeze(["text/html", "application/xhtml+xml"]);

// Availability outcome → result.
const AVAILABILITY_RESULTS = Object.freeze({
  pass: "pass",
  not_found: "warning",
  server_error: "warning",
  redirected_to_root: "warning",
  redirected_elsewhere: "review",
  redirect_loop: "review",
  redirect_limit: "review",
  auth_required: "review",
  rate_limited: "review",
  non_html_response: "review",
  unexpected_status: "review",
  [INVALID]: "review",
  [NETWORK]: "unexercised",
  [NON_HTTP]: "excluded",
  [NOT_REQUESTED]: "excluded",
});

// The English wording hint per field, matched case-insensitively at the start
// of a word of the anchor text.
const HINTS = Object.freeze({
  store_terms: ["terms"],
  store_privacy: ["privacy"],
  store_returns: ["refund", "return"],
  store_shipping: ["shipping"],
  store_contact: ["contact"],
});
// Each pattern's source; the anchor read tests it inside the page, flag "i".
const HINT_SOURCES = Object.freeze(Object.fromEntries(Object.entries(HINTS).map(([field, words]) => [field, `\\b(?:${words.join("|")})`])));

const SHA = /^sha256:[a-f0-9]{64}$/;
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
// A stored string is written as the persisted-verdict projection
// (redactPersisted, which the verdict applies when it is assembled) leaves it.
const persistable = (text) => redactPersisted(text);
const isPersistable = (text) => typeof text === "string" && persistable(text) === text;
// Every stored object has a closed key list, defined next to the code that
// writes it. The producer writes each object through record(), so it holds
// exactly those keys; the reader refuses one that does not (hasExactKeys).
const record = (keys, values) => Object.fromEntries(keys.map((key) => [key, values[key]]));
const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// ---------------------------------------------------------------------------
// Clock and run budget

// The clock every deadline reads: a monotonic now() in milliseconds and the
// timer pair runWithDeadline arms. Tests inject their own.
export const SYSTEM_CLOCK = Object.freeze({
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle),
});

// The run budget of the policy link checks: at most `addedMs` of time added to
// the QA run (contract §1.4 Cost: "Added QA wall clock is at most 20 s").
// Created once, when the checks start, and passed to every step. A step is
// one anchor read, or the probes of all URLs at once; it runs through step(),
// which hands it `endsAt` (the clock time the budget runs out) and charges
// its elapsed time to the budget. The time between steps (the page visits) is
// not added time and is not charged. A step that finds the budget spent does
// nothing.
export function createPolicyLinkBudget({ addedMs = POLICY_LINK_LIMITS.addedMs, clock = SYSTEM_CLOCK } = {}) {
  let spent = 0;
  return {
    clock,
    async step(operation) {
      const started = clock.now();
      try {
        return await operation(started + (addedMs - spent));
      } finally {
        spent += clock.now() - started;
      }
    },
  };
}

// Runs `operation` until the clock reaches `endsAt` (see runWithDeadline).
const untilClock = (clock, endsAt, operation, options = {}) => runWithDeadline(operation, {
  ...options,
  timeoutMs: endsAt - clock.now(),
  setTimer: clock.setTimer,
  clearTimer: clock.clearTimer,
});

// ---------------------------------------------------------------------------
// Normalization and URL classes

// The query as a sorted key=value multiset, or null when it has no pair.
function queryKey(url) {
  const pairs = [...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).sort();
  return pairs.length ? pairs.join("&") : null;
}

const trimSlash = (path) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

// The hashes of one raw http(s) URL that the availability rules compare:
// url_sha256 its exact origin+path (with query_sha256, a hop's identity for
// loops), path_sha256 its path with the trailing slash ignored, host_sha256
// its host without a leading "www." (the pass allowances). Stored as a hop's
// chain_identity entry.
const IDENTITY_KEYS = Object.freeze(["url_sha256", "path_sha256", "host_sha256"]);
const urlIdentity = (protocol, host, pathname) => record(IDENTITY_KEYS, {
  url_sha256: sha256(`${protocol}//${host}${pathname}`),
  path_sha256: sha256(trimSlash(pathname)),
  host_sha256: sha256(host.replace(/^www\./, "")),
});
const ROOT_PATH_SHA = sha256("/");

// The projection's marker as the URL parser writes it in a path (its angle
// brackets percent-encoded). A stored path the projection redacted ends with
// the marker; parsed again, that suffix is read as the marker.
const ENCODED_REDACTED_QUERY = encodeURI(REDACTED_QUERY);
const withMarker = (text) => (text.endsWith(ENCODED_REDACTED_QUERY) ? `${text.slice(0, -ENCODED_REDACTED_QUERY.length)}${REDACTED_QUERY}` : text);

// The stored value of a URL whose projection does not read back as itself:
// its scheme (and, where the scheme needs one, its host) with the marker.
function placeholderOf(url) {
  if (url.protocol === "mailto:") return `mailto:${REDACTED_QUERY}`;
  const opaque = `${url.protocol}${REDACTED_QUERY}`;
  return URL.canParse(opaque) ? opaque : `${url.protocol}//${url.host}/${REDACTED_QUERY}`;
}

// The stored value of a URL whose placeholder does not read back as itself
// either (its scheme or host is too long for the projection's bound): a fixed
// value of its class, with the marker.
const BOUNDED_PLACEHOLDERS = Object.freeze({
  http: `http://host-redacted.invalid/${REDACTED_QUERY}`,
  https: `https://host-redacted.invalid/${REDACTED_QUERY}`,
  mailto: `mailto:${REDACTED_QUERY}`,
  other: `scheme-redacted:${REDACTED_QUERY}`,
});

// One URL as the rules compare it, in one pass (see parseTarget).
function classifyTarget(value) {
  if (typeof value !== "string" || !value.trim()) return { scheme: "invalid" };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { scheme: "invalid" };
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") {
    if (!url.hostname) return { scheme: "invalid" };
    url.hash = "";
    url.username = "";
    url.password = "";
    const query = queryKey(url);
    const originPath = `${protocol}//${url.host}${url.pathname}`;
    return {
      scheme: protocol.slice(0, -1),
      stored: persistable(withMarker(originPath)),
      placeholder: placeholderOf(url),
      query,
      querySha: query == null ? null : sha256(query),
      ids: urlIdentity(protocol, url.host, url.pathname),
      match: `${protocol}//${url.host}${trimSlash(url.pathname)}`,
      host: url.host,
      request: url.href,
    };
  }
  if (protocol === "mailto:") {
    const address = safeDecode(url.pathname).trim().toLowerCase();
    return { scheme: "mailto", stored: persistable(`mailto:${address}`), placeholder: placeholderOf(url), query: null, querySha: null, match: `mailto:${address}` };
  }
  const bare = url.href.split(/[?#]/)[0].replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  return { scheme: "other", stored: persistable(withMarker(bare)), placeholder: placeholderOf(url), query: null, querySha: null, match: bare };
}

// One URL as the rules compare it. `scheme` is the class; `stored` is the
// persisted value; for http(s), `ids` are the hashes of the raw URL
// (urlIdentity), `match` the presence identity (trailing slash ignored, query
// kept) and `request` the URL a probe fetches (no fragment, no userinfo). The
// query text never leaves this object.
//
// Invariant: every stored value parseTarget returns is a fixed point of both
// parseTarget and the persisted-verdict projection, so a stored identity
// persisted in a verdict reads back as itself (readIdentity holds every
// stored identity to that). The projection is one when, classified again, it
// is the same class with the same stored value. When it is not (the
// persisted-verdict projection replaced it whole or cut it, or it is no URL
// of its class, as a file: URL's "null" origin), the placeholder is stored:
// it depends only on the scheme and host it names, so it parses back to
// itself, and it is one when the projection leaves it unchanged. A
// placeholder longer than the projection's bound is not, and the bounded
// placeholder of its class is stored instead. Decisions never read the stored
// value: they compare `ids` and `match`, taken from the raw URL.
function parseTarget(value) {
  const { placeholder, ...target } = classifyTarget(value);
  if (target.scheme === "invalid") return target;
  const again = classifyTarget(target.stored);
  if (again.scheme === target.scheme && again.stored === target.stored) return target;
  return { ...target, stored: persistable(placeholder) === placeholder ? placeholder : BOUNDED_PLACEHOLDERS[target.scheme] };
}

const sameTarget = (a, b) => Boolean(a?.match) && a.match === b.match && a.query === b.query;
const samePath = (a, b) => Boolean(a?.match) && a.match === b.match;

// The configured policy fields of a spec: every non-empty string value (the
// fields the QC handoff treats as applicable).
export function configuredPolicyFields(spec) {
  const campaign = isPlainObject(spec?.campaign) ? spec.campaign : {};
  return POLICY_LINK_FIELDS.filter((field) => isNonEmptyString(campaign[field])).map((field) => ({ field, value: campaign[field] }));
}

export const hasPolicyLinkFields = (spec) => configuredPolicyFields(spec).length > 0;

// ---------------------------------------------------------------------------
// Presence

const normalText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// The labels footer_links declares for the configured URL.
function declaredLabels(spec, target) {
  const links = Array.isArray(spec?.campaign?.footer_links) ? spec.campaign.footer_links : [];
  const labels = [];
  for (const link of links) {
    if (!isPlainObject(link) || !isNonEmptyString(link.label) || typeof link.url !== "string") continue;
    if (sameTarget(parseTarget(link.url), target)) labels.push(normalText(link.label));
  }
  return labels;
}

// The declared labels of every configured field, by field: what the anchor
// read compares each anchor's text with.
function declaredLabelsByField(spec) {
  const labels = {};
  for (const { field, value } of configuredPolicyFields(spec)) {
    const target = parseTarget(value);
    if (target.scheme !== "invalid") labels[field] = declaredLabels(spec, target);
  }
  return labels;
}

// The stored presence block: the counts presenceCounts writes.
const PRESENCE_KEYS = Object.freeze(["pages_expected", "pages_read", "pages_with_match", "path_match_query_differs", "label_declared", "label_anchor_mismatch_pages", "hint_anchor_elsewhere"]);

// The presence counts of one configured field over the visited pages
// ({read, anchors}; each anchor {href, label_fields, hint_fields} as
// readPageAnchors gives it). Only pages whose anchors were read are compared.
export function presenceCounts({ field, target, pages, labels = [] }) {
  const counts = {
    pages_expected: pages.length,
    pages_read: pages.filter((page) => page.read === true).length,
    pages_with_match: 0,
    path_match_query_differs: 0,
    label_declared: labels.length > 0,
    label_anchor_mismatch_pages: 0,
    hint_anchor_elsewhere: 0,
  };
  if (target.scheme === "invalid") return record(PRESENCE_KEYS, { ...counts, label_declared: false });
  for (const page of pages) {
    if (page.read !== true) continue;
    let matched = false;
    let queryDiffers = false;
    let mislabelled = false;
    for (const anchor of page.anchors) {
      const points = parseTarget(anchor.href);
      if (sameTarget(points, target)) {
        matched = true;
        continue;
      }
      if ((target.scheme === "http" || target.scheme === "https") && samePath(points, target)) queryDiffers = true;
      if (labels.length && anchor.label_fields.includes(field)) mislabelled = true;
      if (anchor.hint_fields.includes(field)) counts.hint_anchor_elsewhere += 1;
    }
    if (matched) counts.pages_with_match += 1;
    if (queryDiffers) counts.path_match_query_differs += 1;
    if (mislabelled) counts.label_anchor_mismatch_pages += 1;
  }
  return record(PRESENCE_KEYS, counts);
}

// ---------------------------------------------------------------------------
// Availability outcome (shared by the probe and the reader)

const isHttpStored = (text) => {
  if (!isPersistable(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.search && !url.hash;
  } catch {
    return false;
  }
};
const validQuery = (value) => value === null || SHA.test(value);
const validHop = (hop) => hasExactKeys(hop, HOP_KEYS) && isHttpStored(hop.url) && validQuery(hop.query_sha256) && Number.isSafeInteger(hop.status) && hop.status >= 100 && hop.status <= 599;
// The raw-URL hashes kept for a stored URL, in an object of exactly `keys`.
// When the stored URL is the raw origin+path itself (the projection redacted
// nothing), they must be its hashes.
function validIdentity(ids, stored, keys = IDENTITY_KEYS) {
  if (!hasExactKeys(ids, keys) || !IDENTITY_KEYS.every((key) => SHA.test(ids[key]))) return false;
  if (stored.includes(REDACTED_QUERY) || stored.endsWith("[truncated]")) return true;
  const url = new URL(stored);
  const recomputed = urlIdentity(url.protocol, url.host, url.pathname);
  return IDENTITY_KEYS.every((key) => ids[key] === recomputed[key]);
}
// A request's identity: its exact raw origin+path and its query.
const requestKey = (ids, querySha) => `${ids.url_sha256} ${querySha}`;

// Whether the final URL is the configured one, allowing only a scheme, a
// leading "www." or a trailing-slash difference. Both are compared through the
// hashes of their raw URLs.
function passesAs(final, configured) {
  return final.query_sha256 === configured.query_sha256
    && final.ids.host_sha256 === configured.ids.host_sha256
    && final.ids.path_sha256 === configured.ids.path_sha256;
}

function finalOutcome(final, contentType, configured) {
  const status = final.status;
  if (status >= 200 && status < 300) {
    if (!passesAs(final, configured)) return final.ids.path_sha256 === ROOT_PATH_SHA && configured.ids.path_sha256 !== ROOT_PATH_SHA ? "redirected_to_root" : "redirected_elsewhere";
    return HTML_TYPES.includes(contentType) ? "pass" : "non_html_response";
  }
  if (status === 404 || status === 410) return "not_found";
  if (status >= 500) return "server_error";
  if (status === 401 || status === 403) return "auth_required";
  if (status === 429) return "rate_limited";
  return "unexpected_status";
}

// The outcome a stored availability block re-derives to, or null when the
// block is not one a probe of the configured value can have written.
function availabilityOutcome({ scheme, configured, configured_query_sha256: configuredQuery, run_scope: runScope }, block, { maxRedirects = POLICY_LINK_LIMITS.maxRedirects } = {}) {
  if (!hasExactKeys(block, BLOCK_KEYS) || !Array.isArray(block.chain)) return null;
  const { chain, chain_identity: ids, next_hop: nextHop } = block;
  if (!Array.isArray(ids)) return null;
  const empty = chain.length === 0 && ids.length === 0 && block.final === null && block.final_query_sha256 === null && block.status === null && block.content_type === null && nextHop === null;
  if (runScope === NOT_REQUESTED) return empty ? NOT_REQUESTED : null;
  if (runScope != null) return null;
  if (scheme === "invalid") return empty ? INVALID : null;
  if (scheme === "mailto" || scheme === "other") return empty ? NON_HTTP : null;
  if (!chain.length) return empty ? NETWORK : null;
  if (chain.length > maxRedirects + 1 || !chain.every(validHop)) return null;
  if (ids.length !== chain.length || !ids.every((hopIds, index) => validIdentity(hopIds, chain[index].url))) return null;
  // The first request is the configured URL; every hop but the last is a
  // redirect; no request repeats (a repeat ends the chain as a loop instead).
  if (chain[0].url !== configured || chain[0].query_sha256 !== configuredQuery) return null;
  if (!chain.slice(0, -1).every((hop) => REDIRECT_STATUSES.has(hop.status))) return null;
  const keys = chain.map((hop, index) => requestKey(ids[index], hop.query_sha256));
  if (new Set(keys).size !== keys.length) return null;
  const last = chain.at(-1);
  if (block.final !== last.url || block.final_query_sha256 !== last.query_sha256 || block.status !== last.status) return null;
  if (block.content_type !== null && !CONTENT_TYPE.test(block.content_type)) return null;
  if (REDIRECT_STATUSES.has(last.status) && nextHop !== null) {
    if (!isPlainObject(nextHop) || !isHttpStored(nextHop.url) || !validQuery(nextHop.query_sha256) || !validIdentity(nextHop, nextHop.url, NEXT_HOP_KEYS)) return null;
    if (keys.includes(requestKey(nextHop, nextHop.query_sha256))) return "redirect_loop";
    if (chain.length === maxRedirects + 1) return "redirect_limit";
    // The redirect was due but its request got no response in time.
    return NETWORK;
  }
  if (nextHop !== null) return null;
  return finalOutcome({ ...last, ids: ids.at(-1) }, block.content_type, { ...chain[0], ids: ids[0] });
}

// ---------------------------------------------------------------------------
// Availability probe

// The stored availability block, as probePolicyUrl writes it.
const BLOCK_KEYS = Object.freeze(["chain", "chain_identity", "final", "final_query_sha256", "status", "content_type", "outcome", "next_hop"]);
const emptyBlock = (outcome) => record(BLOCK_KEYS, { chain: [], chain_identity: [], final: null, final_query_sha256: null, status: null, content_type: null, outcome, next_hop: null });

const contentTypeOf = (value) => {
  const type = String(value ?? "").split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE.test(type) ? type : null;
};

const cancelBody = (response) => {
  try {
    const canceled = response?.body?.cancel?.();
    if (canceled && typeof canceled.then === "function") return canceled.then(() => {}, () => {});
  } catch {
    // A body that cannot be canceled has nothing more to settle.
  }
  return null;
};

// One GET with redirect "manual": the status and headers, then the body is
// canceled without reading it. The whole request, its body cancel included,
// ends by `endsAt` on `clock`: it rejects when it has not, whether or not
// `fetchImpl` honours the abort signal. A cancel that has not settled after
// CANCEL_SETTLE_MS (and before `endsAt`) is left to finish on its own.
async function headersOnly(fetchImpl, url, { endsAt, clock }) {
  const controller = new AbortController();
  const pending = Promise.resolve().then(() => fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: controller.signal,
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
  }));
  try {
    return await untilClock(clock, endsAt, async () => {
      const response = await pending;
      const answer = {
        status: response.status,
        location: response.headers?.get?.("location") ?? null,
        contentType: contentTypeOf(response.headers?.get?.("content-type")),
      };
      const canceled = cancelBody(response);
      if (canceled) await untilClock(clock, clock.now() + CANCEL_SETTLE_MS, () => canceled).catch(() => {});
      return answer;
    }, { onTimeout: () => controller.abort(), label: "probePolicyUrl" });
  } catch (error) {
    // A response that arrives after the deadline is canceled unread.
    pending.then(cancelBody, () => {});
    throw error;
  }
}

// The next request of a redirect, or null when its Location is missing or
// is not an http(s) URL.
function redirectTarget(location, from) {
  if (typeof location !== "string" || !location.trim()) return null;
  let next;
  try {
    next = new URL(location.trim(), from);
  } catch {
    return null;
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") return null;
  const target = parseTarget(next.href);
  return target.scheme === "http" || target.scheme === "https" ? target : null;
}

// A stored chain hop, and the stored next hop of a redirect that ended the
// chain (with its raw-URL hashes).
const HOP_KEYS = Object.freeze(["url", "query_sha256", "status"]);
const NEXT_HOP_KEYS = Object.freeze(["url", "query_sha256", ...IDENTITY_KEYS]);
const hopOf = (target, status) => record(HOP_KEYS, { url: target.stored, query_sha256: target.querySha, status });
const nextHopOf = (target) => record(NEXT_HOP_KEYS, { url: target.stored, query_sha256: target.querySha, ...target.ids });

// Probes one configured value: GET with redirect "manual", following up to
// `maxRedirects` redirects (off-origin included). Each request ends by the
// earliest of its own `timeoutMs`, the chain's `deadlineMs` and `endsAt` (the
// run budget's end), all on `clock`; nothing is requested once one of them is
// reached, and a response is accepted only when it, its body cancel included,
// completed before its request's end. Resolves to the availability block
// {chain, chain_identity, final, final_query_sha256, status, content_type,
// outcome, next_hop}; never rejects. A value that is not an absolute http(s)
// URL sends nothing. `fetchImpl` defaults to the global fetch at call time.
export async function probePolicyUrl(url, {
  maxRedirects = POLICY_LINK_LIMITS.maxRedirects,
  timeoutMs = POLICY_LINK_LIMITS.requestTimeoutMs,
  deadlineMs = POLICY_LINK_LIMITS.deadlineMs,
  fetchImpl = globalThis.fetch,
  clock = SYSTEM_CLOCK,
  endsAt = Infinity,
} = {}) {
  const configured = parseTarget(url);
  if (configured.scheme === "invalid") return emptyBlock(INVALID);
  if (configured.scheme === "mailto" || configured.scheme === "other") return emptyBlock(NON_HTTP);
  const deadlineAt = Math.min(clock.now() + deadlineMs, endsAt);
  const chain = [];
  const chainIdentity = [];
  let contentType = null;
  let nextHop = null;
  let current = configured;
  const finish = () => {
    const last = chain.at(-1) ?? null;
    const block = record(BLOCK_KEYS, {
      chain,
      chain_identity: chainIdentity,
      final: last?.url ?? null,
      final_query_sha256: last?.query_sha256 ?? null,
      status: last?.status ?? null,
      content_type: last ? contentType : null,
      outcome: null,
      next_hop: nextHop,
    });
    const observed = { scheme: configured.scheme, configured: configured.stored, configured_query_sha256: configured.querySha };
    block.outcome = availabilityOutcome(observed, block, { maxRedirects });
    // A chain the rules cannot read is kept as unanswered: never a pass.
    return block.outcome ? block : emptyBlock(NETWORK);
  };
  const seen = new Set();
  for (;;) {
    const requestEndsAt = Math.min(clock.now() + timeoutMs, deadlineAt);
    if (!(requestEndsAt > clock.now())) return finish();
    let answer;
    try {
      answer = await headersOnly(fetchImpl, current.request, { endsAt: requestEndsAt, clock });
    } catch {
      return finish();
    }
    // A response whose processing ended at or after its deadline is not one
    // the probe got in time.
    if (!(clock.now() < requestEndsAt)) return finish();
    chain.push(hopOf(current, answer.status));
    chainIdentity.push(current.ids);
    seen.add(requestKey(current.ids, current.querySha));
    contentType = answer.contentType;
    nextHop = null;
    if (!REDIRECT_STATUSES.has(answer.status)) return finish();
    const next = redirectTarget(answer.location, current.request);
    if (!next) return finish();
    nextHop = nextHopOf(next);
    // A repeat is found in memory (exact raw URLs, query included), before
    // the repeated URL is requested again.
    if (seen.has(requestKey(next.ids, next.querySha))) return finish();
    if (chain.length > maxRedirects) return finish();
    current = next;
  }
}

// ---------------------------------------------------------------------------
// Result rules

const PRESENCE_COUNTS = Object.freeze(PRESENCE_KEYS.filter((key) => key !== "label_declared"));

// The identity fields shared by both checks, or null when they are not
// consistent with the scheme: a stored configured value is one the producer
// writes for its class, so classified again it is that class and that stored
// value, byte for byte.
function readIdentity(observation) {
  if (!isPlainObject(observation)) return null;
  const { check, field, configured, configured_query_sha256: configuredQuery, scheme } = observation;
  if (!CHECKS.includes(check) || !POLICY_LINK_FIELDS.includes(field) || !SCHEMES.includes(scheme)) return null;
  const scoped = Object.hasOwn(observation, "run_scope");
  if (!hasExactKeys(observation, observationKeys(check, scoped))) return null;
  if (!validQuery(configuredQuery)) return null;
  const runScope = scoped ? observation.run_scope : null;
  if (scoped && runScope !== NOT_REQUESTED) return null;
  if (scheme === "invalid") {
    if (configured !== null || configuredQuery !== null) return null;
  } else {
    const target = parseTarget(configured);
    if (target.scheme !== scheme || target.stored !== configured) return null;
    // Only an http(s) value keeps a query (as its hash).
    if (!(scheme === "http" || scheme === "https") && configuredQuery !== null) return null;
  }
  return { check, field, configured, configured_query_sha256: configuredQuery, scheme, run_scope: runScope };
}

function readPresence(presence, scheme) {
  if (!hasExactKeys(presence, PRESENCE_KEYS) || !PRESENCE_COUNTS.every((key) => isCount(presence[key])) || typeof presence.label_declared !== "boolean") return null;
  const { pages_expected: expected, pages_read: read } = presence;
  if (read > expected) return null;
  if (["pages_with_match", "path_match_query_differs", "label_anchor_mismatch_pages"].some((key) => presence[key] > read)) return null;
  if (presence.label_anchor_mismatch_pages > 0 && !presence.label_declared) return null;
  if (!(scheme === "http" || scheme === "https") && presence.path_match_query_differs !== 0) return null;
  if (read === 0 && presence.hint_anchor_elsewhere !== 0) return null;
  return presence;
}

function decidePresence(identity, presence) {
  if (identity.run_scope === NOT_REQUESTED) return { result: "excluded", reason_code: NOT_REQUESTED, read: false };
  if (identity.scheme === "invalid") return { result: "review", reason_code: INVALID, read: false };
  // Presence is decided only when every expected page had its anchors read.
  if (!(presence.pages_expected > 0 && presence.pages_read === presence.pages_expected)) return { result: "unexercised", reason_code: PAGES_NOT_READ, read: true };
  if (presence.label_anchor_mismatch_pages > 0) return { result: "warning", reason_code: "destination_mismatch", read: true };
  if (presence.pages_with_match === 0 && presence.path_match_query_differs > 0) return { result: "warning", reason_code: "policy_link_query_differs", read: true };
  if (presence.pages_with_match === 0) return { result: "warning", reason_code: "policy_link_absent", read: true };
  if (presence.hint_anchor_elsewhere > 0) return { result: "review", reason_code: "possible_policy_link_mismatch", read: true };
  return { result: "pass", reason_code: null, read: true };
}

function derivePresence(identity, observation) {
  const presence = readPresence(observation.presence, identity.scheme);
  if (!presence) return null;
  const decided = decidePresence(identity, presence);
  const coverage = decided.read
    ? { observed: presence.pages_read, expected: presence.pages_expected, limits: decided.result === "unexercised" ? [PAGES_NOT_READ] : [] }
    : { observed: 0, expected: null, limits: [] };
  return {
    decided,
    coverage,
    state: {
      reason_code: decided.reason_code,
      configured: identity.configured,
      configured_query_sha256: identity.configured_query_sha256,
      pages_expected: presence.pages_expected,
      pages_read: presence.pages_read,
      pages_with_match: presence.pages_with_match,
      path_match_query_differs: presence.path_match_query_differs,
      label_anchor_mismatch_pages: presence.label_anchor_mismatch_pages,
      hint_anchor_elsewhere: presence.hint_anchor_elsewhere,
    },
  };
}

function deriveAvailability(identity, observation) {
  const block = observation.availability;
  const outcome = availabilityOutcome(identity, block);
  // The stored outcome stands only when the chain re-derives to it.
  if (!outcome || block.outcome !== outcome) return null;
  const result = AVAILABILITY_RESULTS[outcome];
  const reasonCode = outcome === "pass" ? null : outcome;
  const coverage = result === "excluded" || outcome === INVALID
    ? { observed: 0, expected: null, limits: [] }
    : outcome === NETWORK
      ? { observed: 0, expected: 1, limits: [NETWORK] }
      : { observed: 1, expected: 1, limits: [] };
  return {
    decided: { result, reason_code: reasonCode },
    coverage,
    state: {
      reason_code: reasonCode,
      configured: identity.configured,
      configured_query_sha256: identity.configured_query_sha256,
      chain: block.chain.map(({ url, query_sha256: querySha, status }) => ({ url, query_sha256: querySha, status })),
      final: block.final,
      final_query_sha256: block.final_query_sha256,
      status: block.status,
      content_type: block.content_type,
    },
  };
}

// Re-derives one row from its stored observation, or returns null when the
// observation is not one this rule can read (the reader then reports
// evidence_not_reproducible).
export function rederiveQcResult(observation) {
  try {
    const identity = readIdentity(observation);
    if (!identity) return null;
    const derived = identity.check === POLICY_PRESENCE_CHECK ? derivePresence(identity, observation) : deriveAvailability(identity, observation);
    if (!derived) return null;
    const { result, reason_code: reasonCode } = derived.decided;
    return {
      check: identity.check,
      subject: { check: identity.check, page: PAGE, key: identity.field },
      result,
      reason_code: reasonCode,
      members: [],
      accept_eligible: result === "warning",
      coverage: derived.coverage,
      state: derived.state,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rows and assertions

export function policyLinkQcRow(observation, { measuredAt = new Date().toISOString() } = {}) {
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

// The row's verdict assertion, under the id qc.<check>:<field>. It names its
// row in evidence.qc.result_id, which is how readers pair them.
export function policyLinkQaAssertion(row) {
  return { ...toQaAssertion(row, { family: FAMILY }), id: `qc.${row.check}:${row.subject.key}` };
}

// The stored observation of one row: the field's identity, the check's block
// and, for a run-scope row only, run_scope.
const observationKeys = (check, scoped) => [
  "check", "field", "configured", "configured_query_sha256", "scheme",
  check === POLICY_PRESENCE_CHECK ? "presence" : "availability",
  ...(scoped ? ["run_scope"] : []),
];
const identityOf = (check, field, target) => ({
  check,
  field,
  configured: target.scheme === "invalid" ? null : target.stored,
  configured_query_sha256: target.scheme === "invalid" ? null : target.querySha,
  scheme: target.scheme,
});

const emptyPresence = (pagesExpected) => record(PRESENCE_KEYS, {
  pages_expected: pagesExpected,
  pages_read: 0,
  pages_with_match: 0,
  path_match_query_differs: 0,
  label_declared: false,
  label_anchor_mismatch_pages: 0,
  hint_anchor_elsewhere: 0,
});

// Both rows of one field. An observation the rules cannot read (which the
// producer never writes) is kept unread: unexercised, never a pass.
function fieldRows({ field, target, presence, availability, runScope = null }, measuredAt) {
  const observationOf = (check, block) => record(observationKeys(check, Boolean(runScope)), { ...identityOf(check, field, target), ...block, run_scope: runScope });
  const presenceObservation = observationOf(POLICY_PRESENCE_CHECK, { presence });
  const availabilityObservation = observationOf(POLICY_AVAILABILITY_CHECK, { availability });
  const presenceRow = policyLinkQcRow(presenceObservation, { measuredAt })
    ?? policyLinkQcRow({ ...presenceObservation, presence: emptyPresence(presence.pages_expected) }, { measuredAt });
  const availabilityRow = policyLinkQcRow(availabilityObservation, { measuredAt })
    ?? policyLinkQcRow({ ...availabilityObservation, availability: emptyBlock(target.scheme === "http" || target.scheme === "https" ? NETWORK : availability.outcome) }, { measuredAt });
  return [presenceRow, availabilityRow].filter(Boolean);
}

const topologyPageCount = (topologies) => (Array.isArray(topologies) ? topologies : [])
  .reduce((total, topology) => total + (Array.isArray(topology?.pages) ? topology.pages.length : 0), 0);

// The run-scope rows of a QA run without browser checks: presence and
// availability excluded / browser_checks_not_requested for every configured
// field. Nothing is read and no request is made.
export function policyLinkNotRequestedRows(spec, topologies, { measuredAt = new Date().toISOString() } = {}) {
  const pagesExpected = topologyPageCount(topologies);
  return configuredPolicyFields(spec).flatMap(({ field, value }) => fieldRows({
    field,
    target: parseTarget(value),
    presence: emptyPresence(pagesExpected),
    availability: emptyBlock(NOT_REQUESTED),
    runScope: NOT_REQUESTED,
  }, measuredAt));
}

const isFieldList = (value) => Array.isArray(value) && value.every((field) => POLICY_LINK_FIELDS.includes(field));
const isReadAnchor = (anchor) => isPlainObject(anchor) && typeof anchor.href === "string" && isFieldList(anchor.label_fields) && isFieldList(anchor.hint_fields);

// The policy link leg of `qa run --browser`, run after the page checks.
// `pages` holds one {read, anchors} entry per page visit the page checks
// attempted (readPageAnchors). Each distinct configured http(s) URL is probed
// once, all at once, as one step of `budget` (the run budget the anchor reads
// drew on). Returns the rows and their verdict assertions.
export async function runPolicyLinkChecks({ spec, pages = [], fetchImpl, measuredAt = null, budget = createPolicyLinkBudget() } = {}) {
  const fields = configuredPolicyFields(spec).map(({ field, value }) => ({ field, target: parseTarget(value) }));
  if (!fields.length) return { rows: [], assertions: [] };
  const visits = (Array.isArray(pages) ? pages : []).map((page) => (page?.read === true && Array.isArray(page.anchors) && page.anchors.every(isReadAnchor) ? { read: true, anchors: page.anchors } : { read: false, anchors: [] }));
  // There are at most five policy fields, so at most POLICY_LINK_LIMITS.maxUrls
  // distinct URLs.
  const urls = [];
  for (const { target } of fields) {
    if ((target.scheme === "http" || target.scheme === "https") && !urls.includes(target.request) && urls.length < POLICY_LINK_LIMITS.maxUrls) urls.push(target.request);
  }
  // A probe the budget leaves no time for sends nothing and reads
  // network_unavailable (contract §1.4 Cost).
  const blocks = new Map(urls.length ? await budget.step((endsAt) => Promise.all(urls.map(async (url) => [url, await probePolicyUrl(url, {
    ...(fetchImpl ? { fetchImpl } : {}),
    clock: budget.clock,
    endsAt,
  })]))) : []);
  const at = measuredAt ?? new Date().toISOString();
  const rows = fields.flatMap(({ field, target }) => {
    const availability = target.scheme === "http" || target.scheme === "https"
      ? structuredClone(blocks.get(target.request) ?? emptyBlock(NETWORK))
      : emptyBlock(target.scheme === "invalid" ? INVALID : NON_HTTP);
    const presence = presenceCounts({ field, target, pages: visits, labels: target.scheme === "invalid" ? [] : declaredLabels(spec, target) });
    return fieldRows({ field, target, presence, availability }, at);
  });
  return { rows, assertions: rows.map(policyLinkQaAssertion) };
}

// ---------------------------------------------------------------------------
// Anchor reader

// The page's rendered anchors are read in an isolated world of the main
// frame, reached through the Chrome DevTools Protocol: the page's own scripts
// share the DOM with that world but not its globals or prototypes, so a page
// that overrides querySelectorAll, href or textContent cannot change what is
// read. Each a[href] gives its href as the browser resolves it against
// document.baseURI. Its text is compared in that world, in full, and never
// leaves it: the read keeps the fields whose declared label equals the text
// (whitespace collapsed, as declaredLabels normalizes a label) and the fields
// whose wording hint it holds. A page whose read would be partial (too many
// anchors, or a text over MAX_TEXT) is not read.
const WORLD_NAME = "campaigns-os-policy-links";

function anchorReadExpression(maxAnchors, maxText, labels, hints) {
  const anchors = document.querySelectorAll("a[href]");
  if (anchors.length > maxAnchors) return { complete: false, anchors: [] };
  const patterns = Object.keys(hints).map((field) => [field, new RegExp(hints[field], "i")]);
  const read = [];
  for (const anchor of Array.from(anchors)) {
    let href = anchor.href;
    if (typeof href !== "string") {
      try {
        href = new URL(anchor.getAttribute("href"), document.baseURI).href;
      } catch {
        href = String(anchor.getAttribute("href") ?? "");
      }
    }
    const text = String(anchor.textContent ?? "");
    if (text.length > maxText) return { complete: false, anchors: [] };
    const normal = text.replace(/\s+/g, " ").trim();
    read.push({
      href,
      label_fields: Object.keys(labels).filter((field) => labels[field].includes(normal)),
      hint_fields: patterns.filter(([, pattern]) => pattern.test(text)).map(([field]) => field),
    });
  }
  return { complete: true, anchors: read };
}

const anchorReadSource = (spec) => `(${anchorReadExpression})(${MAX_ANCHORS}, ${MAX_TEXT}, ${JSON.stringify(declaredLabelsByField(spec))}, ${JSON.stringify(HINT_SOURCES)})`;

// The anchors of the page's current document, or null when they could not be
// read in full (the page then counts as not read). The read is one step of
// `budget` and ends by the earlier of ANCHOR_READ_MS and the budget's end; it
// does not start once the budget is spent. Never throws.
export async function readPageAnchors(context, browserPage, { spec = null, budget = createPolicyLinkBudget() } = {}) {
  const { clock } = budget;
  return budget.step(async (endsAt) => {
    const readEndsAt = Math.min(clock.now() + ANCHOR_READ_MS, endsAt);
    if (!(readEndsAt > clock.now())) return null;
    let session = null;
    let ended = false;
    try {
      return await untilClock(clock, readEndsAt, async () => {
        const opened = await context.newCDPSession(browserPage);
        if (ended) {
          Promise.resolve().then(() => opened.detach()).catch(() => {});
          return null;
        }
        session = opened;
        const { frameTree } = await session.send("Page.getFrameTree");
        const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD_NAME });
        const { result, exceptionDetails } = await session.send("Runtime.evaluate", { contextId: executionContextId, expression: anchorReadSource(spec), returnByValue: true });
        const value = exceptionDetails ? null : result?.value;
        if (!isPlainObject(value) || value.complete !== true || !Array.isArray(value.anchors)) return null;
        return value.anchors.every(isReadAnchor) ? value.anchors : null;
      }, { onTimeout: () => { ended = true; }, label: "readPageAnchors" });
    } catch {
      return null;
    } finally {
      ended = true;
      // The session is closed in the background, so a detach that stalls
      // adds no time.
      if (session) Promise.resolve().then(() => session.detach()).catch(() => {});
    }
  });
}
