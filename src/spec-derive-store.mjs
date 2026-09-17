// `campaigns-os spec derive --from-store <subdomain>`: the store-derived half
// of the CampaignSpec (#432 slice 2).
//
// The nine `campaign.store_*` Store Profile fields are class "derived": the
// store already states them, so they are generated from it, never typed. The
// authority is the store's Admin API (`https://<subdomain>.29next.store/api/admin/`):
// `GET /store/` (name, primary domain, contact phone) and `GET /pages/` (the
// storefront's own pages, served at `https://<primary_domain>/<slug>/`, which
// is where the legal links point). Reading the store takes a credential and
// the network, both of which slice 1 promised never to need, so the store
// source is opt-in behind `--from-store`, and the default run stays offline.
//
// Direction: store -> spec (this module) -> repo (`page-kit sync`). Nothing
// here writes the repo, and the spec keeps its value for any field the store
// cannot state (an empty phone, no page that reads as the returns policy):
// the miss is reported as not derived, the field is never emptied.
//
// This module is pure apart from `readStoreProfile`, the one transport, which
// takes its fetch as an argument so tests never touch the network. The token
// travels in and never out: no result, reason or error carries it.
import { PAGE_KIT_STORE_PROFILE_FIELDS, normalizeStoreProfileValue, storeProfileSpecValueProblem } from "./page-kit-store-profile.mjs";
import { hasControlCharacters, quoteValue } from "./spec-derive.mjs";

export const ADMIN_API_STORE_VERSION = "2024-04-01";
// `/pages/` exists only in the unstable Admin API version today; the header
// is pinned to it and named in the docs, so a move is one constant.
export const ADMIN_API_PAGES_VERSION = "unstable";
export const STORE_READ_TIMEOUT_MS = 15_000;
// The whole read (store plus every pages cursor) shares one budget, so a
// store that answers each request slowly cannot hold the command for
// eleven timeouts in a row.
export const STORE_READ_BUDGET_MS = 45_000;
// Pages are read cursor by cursor; a storefront with more pages than this
// many requests return is reported rather than partially matched.
export const STORE_PAGES_MAX_REQUESTS = 10;
// And more rows than any storefront carries is a platform fault, reported
// as truncated rather than held in memory.
export const STORE_PAGES_MAX_ROWS = 2_000;

// The spec fields this source writes, as `applySpecDerive` path patterns.
export const SPEC_DERIVE_STORE_FIELDS = Object.freeze(PAGE_KIT_STORE_PROFILE_FIELDS.map((field) => `campaign.${field}`));
const URL_FIELDS = new Set(["store_url", "store_terms", "store_privacy", "store_contact", "store_returns", "store_shipping"]);

// The legal-link fields and the words (in a page's slug or title) that name
// each one. A page may carry more than one policy (`shipping-returns`) and
// then binds to each; a field with no page, or several, is not derived.
export const STORE_PAGE_MATCHERS = Object.freeze({
  store_terms: Object.freeze({ slugs: ["terms", "tos", "terms-of-service", "terms-and-conditions", "terms-conditions", "terms-of-use"], words: ["terms", "tos", "conditions"], describe: "terms" }),
  store_privacy: Object.freeze({ slugs: ["privacy", "privacy-policy"], words: ["privacy"], describe: "privacy" }),
  store_contact: Object.freeze({ slugs: ["contact", "contact-us"], words: ["contact"], describe: "contact" }),
  store_returns: Object.freeze({ slugs: ["returns", "refunds", "return-policy", "returns-policy", "refund-policy", "returns-and-refunds", "shipping-returns", "shipping-and-returns"], words: ["return", "returns", "refund", "refunds"], describe: "returns/refunds" }),
  store_shipping: Object.freeze({ slugs: ["shipping", "delivery", "shipping-policy", "delivery-policy", "shipping-returns", "shipping-and-returns"], words: ["shipping", "delivery"], describe: "shipping/delivery" }),
});

const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;
// Labels as DNS takes them; the last label is a letters-only TLD or a
// punycode one (`xn--…`), so an internationalized primary domain is a host.
const HOSTNAME_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i;
// A bearer token is one line of printable ASCII; anything else is not a
// token this command will put in a header (the header validator would echo
// it back in its error).
const TOKEN_REGEX = /^[\x21-\x7e]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// The `<subdomain>` of `<subdomain>.29next.store`, lower-cased, or null when
// the value is not one (a URL, a path, an empty string).
export function normalizeStoreSubdomain(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return SUBDOMAIN_REGEX.test(text) ? text : null;
}

export function adminApiBaseForStore(subdomain) {
  return `https://${subdomain}.29next.store/api/admin/`;
}

// The env var the token is read from when `--store-token-source` is not
// given: `<SUBDOMAIN>_ADMIN_TOKEN`, dashes as underscores (`my-store` ->
// `MY_STORE_ADMIN_TOKEN`); a subdomain that starts with a digit gets a
// leading underscore so the name is one a shell can export.
export function defaultStoreTokenEnvVar(subdomain) {
  const name = `${String(subdomain).toUpperCase().replace(/-/g, "_")}_ADMIN_TOKEN`;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

// Only `env:<VAR>` is a token source: a token typed on the command line
// would land in shell history and process listings. Returns `{ env }` or
// `{ problem }`.
export function parseStoreTokenSource(value) {
  if (typeof value !== "string" || !value.trim()) return { problem: "is empty; write env:<VAR>, the environment variable that holds the store's Admin API token." };
  const text = value.trim();
  const match = text.match(/^env:(.+)$/);
  if (!match) return { problem: "must be env:<VAR> (an environment variable name); a token is never written on the command line." };
  const name = match[1];
  if (!ENV_NAME_REGEX.test(name)) return { problem: `names an invalid environment variable ${quoteValue(name)}; use letters, digits and underscores (env:MY_STORE_ADMIN_TOKEN).` };
  return { env: name };
}

// The `https://<domain>` form `campaign.store_url` takes from a primary
// domain (no trailing slash, the spelling every Map export carries), or null
// when the domain is not a hostname.
export function storeUrlFromDomain(domain) {
  if (typeof domain !== "string") return null;
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return HOSTNAME_REGEX.test(host) ? `https://${host}` : null;
}

// URL fields compare without a trailing slash: `https://x.example` and
// `https://x.example/` name one place, and a rewrite between them would
// only churn the spec and the repo behind it.
function sameStoreValue(field, before, after) {
  if (typeof before !== "string") return false;
  const a = normalizeStoreProfileValue(before);
  return URL_FIELDS.has(field) ? a.replace(/\/+$/, "") === after.replace(/\/+$/, "") : a === after;
}

// Whether a token can travel in an Authorization header at all.
export function isUsableStoreToken(token) {
  return typeof token === "string" && TOKEN_REGEX.test(token);
}

// `store_phone_tel` from the store's display phone: `tel:` plus the digits
// (a leading + kept, wherever the punctuation put it), the only href form
// every dialer reads. Only a plain number converts: an extension, a second
// number, a vanity word or any other letter would fold into the digits and
// dial something else, so those return null and the field is not derived.
export function telUriFromPhone(phone) {
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (!/^[\s().\-+0-9]+$/.test(trimmed)) return null;
  const plus = /^[\s().\-]*\+/.test(trimmed) ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 4 || (trimmed.match(/\+/g) || []).length > 1) return null;
  return `tel:${plus}${digits}`;
}

function words(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// The storefront pages that carry the field's policy. A page whose slug IS
// one of the policy's conventional slugs binds first (exactly one such page
// settles the field on its own); only when no page has a conventional slug
// does the wider match by slug or title words apply, so a "free shipping"
// promo page never outranks `shipping-policy`.
export function matchStorePages(field, pages) {
  const matcher = STORE_PAGE_MATCHERS[field];
  if (!matcher || !Array.isArray(pages)) return [];
  const usable = pages.filter((page) => isPlainObject(page) && isNonEmptyString(page.slug));
  const canonical = usable.filter((page) => matcher.slugs.includes(page.slug.trim().toLowerCase()));
  if (canonical.length) return canonical;
  return usable.filter((page) => {
    const seen = new Set([...words(page.slug), ...words(page.title)]);
    return matcher.words.some((word) => seen.has(word));
  });
}

// The field-by-field plan for the store source, in the same shape as
// `planSpecDerive`: `changes`, `unchanged` and `not_derived` rows over the
// nine `campaign.store_*` fields, plus `domain_changed` when the store's
// primary domain is not the host the spec's store_url named (the loud sign
// of `--from-store` pointing at the wrong store).
//
// `store` is the parsed `GET /store/` body; `pages` the accumulated
// `GET /pages/` results, or null with `pagesStatus` saying why
// (`unavailable`, `truncated`).
export function planStoreProfileDerive({ spec, store, pages = null, pagesStatus = "ok", pagesDetail = null, subdomain = "" } = {}) {
  const changes = [];
  const unchanged = [];
  const notDerived = [];
  const body = isPlainObject(store) ? store : {};
  // A missing campaign block is created on write (as applySpecDerive creates
  // any absent container); one of the wrong type is a spec defect.
  const campaign = isPlainObject(spec?.campaign) ? spec.campaign : spec?.campaign == null ? {} : null;
  const base = adminApiBaseForStore(subdomain || "<store>");
  const storeSource = (key) => `${base}store/ ${key}`;

  const consider = (field, after, source) => {
    const specField = `campaign.${field}`;
    const problem = storeProfileSpecValueProblem(field, after);
    if (problem) {
      const why = problem === "demo_residue"
        ? "is the starter demo value; the store pointed at is the demo store, not a merchant's"
        : problem === "not_http_url" ? "is not an http(s) URL"
          : problem === "not_tel_uri" ? "is not a tel: URI"
            : problem === "control_characters" ? "contains control characters" : "is missing";
      notDerived.push({ field: specField, reason: "target_invalid", detail: `the store's ${source} ${quoteValue(after)} ${why}; correct it in the store's settings, then derive again.` });
      return;
    }
    if (!campaign) {
      notDerived.push({ field: specField, reason: "spec_container_invalid", detail: `the spec's campaign is not an object, so ${specField} cannot be written; repair the spec, then derive again.` });
      return;
    }
    const before = Object.hasOwn(campaign, field) ? campaign[field] : undefined;
    const row = { field: specField, path: ["campaign", field], before, after, source };
    if (sameStoreValue(field, before, after)) unchanged.push(row);
    else changes.push(row);
  };
  const missing = (field, source, what) => {
    notDerived.push({ field: `campaign.${field}`, reason: "store_field_missing", detail: `the store's ${source} is empty, so ${what}; set it in the store's settings, then derive again. The spec's value was left as it is.` });
  };

  // Name.
  const name = typeof body.name === "string" ? normalizeStoreProfileValue(body.name) : "";
  if (name) consider("store_name", name, storeSource("name"));
  else missing("store_name", storeSource("name"), "store_name cannot be derived");

  // Primary domain -> store_url, and the host every legal link is served on.
  const domainRaw = typeof body.primary_domain === "string" ? body.primary_domain.trim() : "";
  const storeUrl = domainRaw ? storeUrlFromDomain(domainRaw) : null;
  let domainChanged = null;
  if (!domainRaw) {
    missing("store_url", storeSource("primary_domain"), "store_url cannot be derived");
  } else if (!storeUrl) {
    notDerived.push({ field: "campaign.store_url", reason: "target_invalid", detail: `the store's ${storeSource("primary_domain")} ${quoteValue(domainRaw)} is not a hostname; correct it in the store's settings, then derive again.` });
  } else {
    consider("store_url", storeUrl, storeSource("primary_domain"));
    const before = campaign?.store_url;
    if (typeof before === "string" && before.trim() && !storeProfileSpecValueProblem("store_url", before)) {
      try {
        const beforeHost = new URL(normalizeStoreProfileValue(before)).hostname.toLowerCase();
        const afterHost = new URL(storeUrl).hostname;
        if (beforeHost !== afterHost) domainChanged = { before: beforeHost, after: afterHost };
      } catch {
        // An unparsable spec value is reported by doctor's store-profile
        // rule; it is not this plan's concern.
      }
    }
  }

  // Phone, display and href forms, from one store field.
  const phoneRaw = typeof body.contact_address?.phone_number === "string" ? normalizeStoreProfileValue(body.contact_address.phone_number) : "";
  const phoneSource = storeSource("contact_address.phone_number");
  if (phoneRaw) {
    consider("store_phone", phoneRaw, phoneSource);
    const tel = telUriFromPhone(phoneRaw);
    if (tel) consider("store_phone_tel", tel, `${phoneSource} (as tel: URI)`);
    else notDerived.push({ field: "campaign.store_phone_tel", reason: "target_invalid", detail: `the store's ${phoneSource} ${quoteValue(phoneRaw)} has too few digits for a tel: URI; correct it in the store's settings, then derive again.` });
  } else {
    missing("store_phone", phoneSource, "store_phone cannot be derived");
    missing("store_phone_tel", phoneSource, "store_phone_tel cannot be derived");
  }

  // Legal links: each bound to exactly one storefront page.
  const pagesSource = `${base}pages/`;
  for (const [field, matcher] of Object.entries(STORE_PAGE_MATCHERS)) {
    const specField = `campaign.${field}`;
    if (!storeUrl) {
      notDerived.push({ field: specField, reason: "store_domain_missing", detail: `the store has no usable primary domain, so no ${matcher.describe} page URL can be formed for ${field}; set the primary domain in the store's settings, then derive again.` });
      continue;
    }
    if (pagesStatus === "truncated") {
      notDerived.push({ field: specField, reason: "store_pages_truncated", detail: `the store lists more pages than ${STORE_PAGES_MAX_REQUESTS} requests to ${pagesSource} return, so a single ${matcher.describe} page cannot be bound for ${field}. The spec's value was left as it is.` });
      continue;
    }
    if (pagesStatus === "unavailable" || !Array.isArray(pages)) {
      notDerived.push({ field: specField, reason: "store_pages_unavailable", detail: `the store's pages could not be listed (${pagesSource}, Admin API version ${ADMIN_API_PAGES_VERSION}${pagesDetail ? `: ${pagesDetail}` : ""}), so no ${matcher.describe} page can be bound for ${field}. The spec's value was left as it is.` });
      continue;
    }
    const matches = matchStorePages(field, pages);
    if (matches.length === 0) {
      notDerived.push({ field: specField, reason: "store_page_not_found", detail: `no storefront page's slug or title names ${matcher.describe} (${matcher.words.join(", ")}), so ${field} cannot be derived from ${pagesSource}. Add the page in the store (or keep the spec's value), then derive again.` });
      continue;
    }
    if (matches.length > 1) {
      notDerived.push({ field: specField, reason: "store_page_ambiguous", detail: `more than one storefront page reads as ${matcher.describe} (${matches.map((page) => quoteValue(page.slug)).sort().join(", ")}), so no single URL can be derived for ${field}; rename or remove one in the store, then derive again. The spec's value was left as it is.` });
      continue;
    }
    const slug = matches[0].slug.trim();
    // A slug is one path segment: no separators, no dot segments (`..`
    // would serve the homepage as the policy), and well-formed text
    // (encodeURIComponent throws on a lone surrogate).
    let encoded = null;
    try {
      encoded = slug.isWellFormed() ? encodeURIComponent(slug) : null;
    } catch {
      encoded = null;
    }
    if (encoded === null || hasControlCharacters(slug) || /[\/?#\s]/.test(slug) || /^\.{1,2}$/.test(slug)) {
      notDerived.push({ field: specField, reason: "target_invalid", detail: `the storefront page slug ${quoteValue(slug)} is not a URL path segment, so ${field} cannot be derived; correct the page in the store, then derive again.` });
      continue;
    }
    consider(field, `${storeUrl}/${encoded}/`, `${pagesSource} slug ${quoteValue(slug)}`);
  }

  // Rows in the Store Profile's own field order, the order doctor's gate and
  // page-kit sync print them in, whatever order the sources were read in.
  const order = new Map(PAGE_KIT_STORE_PROFILE_FIELDS.map((field, index) => [`campaign.${field}`, index]));
  const byField = (a, b) => order.get(a.field) - order.get(b.field);
  return { changes: changes.sort(byField), unchanged: unchanged.sort(byField), not_derived: notDerived.sort(byField), domain_changed: domainChanged };
}

function transportDetail(error) {
  // undici wraps a refused redirect or a TLS failure as "fetch failed" with
  // the reason on `cause`, sometimes as a code, sometimes only as a message.
  const raw = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timed out" : (error?.cause?.code || error?.cause?.message || error?.message || String(error));
  // A header validator quotes the offending header value in its message;
  // whatever follows "Bearer" is never echoed.
  const message = String(raw).replace(/Bearer\s+\S*/g, "Bearer [redacted]").replace(/\s+/g, " ").trim();
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

// The one place a response is dropped unread: an unconsumed body can hold
// the connection open past the command's interest in it.
async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Nothing to do with a body that will not cancel.
  }
}

// Read the store: `GET /store/` then every `GET /pages/` cursor. Returns
// `{ status: "ok", store, pages, pages_status }` or a status the CLI turns
// into a spec.derive.store_* error: `unauthorized` (401/403), `not_found`
// (404: no such store), `unreachable` (transport, timeout, 5xx), `invalid`
// (a body that is not the documented object). A pages failure is not fatal:
// `pages_status` is `unavailable` and the five link fields report it.
export async function readStoreProfile({ subdomain, token, fetchImpl = globalThis.fetch, timeoutMs = STORE_READ_TIMEOUT_MS, budgetMs = STORE_READ_BUDGET_MS } = {}) {
  if (typeof fetchImpl !== "function") return { status: "unreachable", detail: "global fetch is not available; upgrade to Node 18+." };
  if (!isUsableStoreToken(token)) return { status: "credential_invalid", detail: "the token in the environment is not a single line of printable ASCII (a stray newline, space or non-ASCII character); it was not sent. Re-export it as the value the store issued." };
  const base = adminApiBaseForStore(subdomain);
  const deadline = Date.now() + budgetMs;
  const request = async (url, version) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "X-29next-API-Version": version, Accept: "application/json" },
      // A redirect is refused at the HTTP layer, as an off-origin cursor is
      // below: the bearer goes to the store's own origin and nowhere else.
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
    });
    return response;
  };
  let storeResponse;
  try {
    storeResponse = await request(`${base}store/`, ADMIN_API_STORE_VERSION);
  } catch (error) {
    return { status: "unreachable", detail: `${base}store/ could not be reached (${transportDetail(error)}).` };
  }
  if (!storeResponse.ok) await discardBody(storeResponse);
  if (storeResponse.status === 401 || storeResponse.status === 403) return { status: "unauthorized", detail: `${base}store/ answered ${storeResponse.status}; the token is not valid for this store or lacks the store:read scope (the pages read also needs content:read).` };
  if (storeResponse.status === 404) return { status: "not_found", detail: `${base}store/ answered 404; there is no store at that subdomain, or the Admin API does not serve /store/ at version ${ADMIN_API_STORE_VERSION}.` };
  if (!storeResponse.ok) return { status: "unreachable", detail: `${base}store/ answered ${storeResponse.status}.` };
  let store;
  try {
    store = await storeResponse.json();
  } catch {
    // The parser's message quotes the body; a marketing page or an HTML
    // error at an unknown subdomain is not something to echo.
    return { status: "invalid", detail: `${base}store/ did not return JSON; the subdomain may be wrong, or the platform answered with a page instead of the API.` };
  }
  if (!isPlainObject(store)) return { status: "invalid", detail: `${base}store/ returned ${Array.isArray(store) ? "an array" : `a ${store === null ? "null" : typeof store}`}, not the store object.` };

  const pages = [];
  let pagesStatus = "ok";
  let pagesDetail = null;
  let next = `${base}pages/`;
  let requests = 0;
  const unavailable = (why) => {
    pagesStatus = "unavailable";
    pagesDetail = why;
  };
  while (next) {
    if (requests >= STORE_PAGES_MAX_REQUESTS) {
      pagesStatus = "truncated";
      break;
    }
    requests += 1;
    let response;
    try {
      response = await request(next, ADMIN_API_PAGES_VERSION);
    } catch (error) {
      unavailable(`could not be reached (${transportDetail(error)})`);
      break;
    }
    if (!response.ok) {
      await discardBody(response);
      unavailable(response.status === 401 || response.status === 403
        ? `answered ${response.status}; the token lacks the content:read scope`
        : response.status === 404 ? `answered 404; the Admin API does not serve /pages/ at version ${ADMIN_API_PAGES_VERSION}` : `answered ${response.status}`);
      break;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      unavailable("did not return JSON");
      break;
    }
    if (!isPlainObject(body) || !Array.isArray(body.results) || (body.next !== undefined && body.next !== null && typeof body.next !== "string")) {
      unavailable("returned a body that is not the documented page list");
      break;
    }
    for (const page of body.results) {
      if (isPlainObject(page) && isNonEmptyString(page.slug)) pages.push({ slug: page.slug, title: typeof page.title === "string" ? page.title : "" });
    }
    if (pages.length > STORE_PAGES_MAX_ROWS) {
      pagesStatus = "truncated";
      break;
    }
    // The cursor URL is followed only when it resolves under the store's
    // own Admin API pages endpoint: a body that pointed elsewhere (another
    // origin, or `..` back out of the API path) would otherwise carry the
    // token off the endpoint.
    if (isNonEmptyString(body.next)) {
      let resolved = null;
      try {
        resolved = new URL(body.next).href;
      } catch {
        resolved = null;
      }
      if (!resolved || !resolved.startsWith(`${base}pages/`)) {
        unavailable("returned a cursor outside the store's pages endpoint, which was not followed");
        break;
      }
      next = resolved;
    } else next = null;
  }
  return { status: "ok", store, pages: pagesStatus === "ok" ? pages : null, pages_status: pagesStatus, pages_detail: pagesDetail };
}
