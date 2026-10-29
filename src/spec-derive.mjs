// `campaigns-os spec derive`: write the fields the target repo already states
// into the packet's local CampaignSpec.
//
// Every field in a CampaignSpec has a class (#432): authored (a human writes
// it), mirrored (pulled from the Campaigns API or the store) or derived (the
// repo or the store already states it). Derived fields are generated, never
// typed, and this command is the generator for the repo-derived ones: the
// SDK pin from `_data/campaigns.json[<route>].sdk_version`, each page's public
// route from the page tree under `src/<route>/`, and the analytics ids the
// entry carries (`gtm_id`, `fb_pixel_id`, and the starter-template vendor ids
// such as `ga4_id` or `triplewhale_name`). Doctor then compares generated
// against generated instead of refereeing a human's typing against the repo.
//
// The repo is the authority for exactly those fields. A spec value that looks
// authored but sits in a derived field is overwritten, with the before -> after
// line showing it; nothing outside the derived fields is written, ever.
// The store-derived fields (the nine campaign.store_* Store Profile fields,
// authority: the store's Admin API) are planned by spec-derive-store.mjs
// behind --from-store; their rows are applied here under the same guard.
//
// After handoff (#721) the repo is also the authority for which pages exist:
// a page file the tree gains is added to the spec, a page whose built file is
// gone is removed, and the routing that links an added or removed page is read
// from the page files' frontmatter links. Pages are matched by id, never by
// position. The offer and package fields the spec mirrors from the Campaigns
// App are planned by spec-derive-campaign.mjs from the live campaign read and
// applied here under the same guard.
//
// This module is pure: the CLI reads the packet, the spec, the entry and the
// page tree, and does the writing and the printing.
import { ANALYTICS_VENDORS, isPlaceholderVendorId, isReleasedSdkVersion } from "../campaign-spec/dist/index.js";
import { PAGE_KIT_CAMPAIGNS_REL_PATH } from "./page-kit-campaign-config.mjs";
import { PAGE_KIT_STORE_PROFILE_FIELDS } from "./page-kit-store-profile.mjs";
import { compareReleasedSdkVersions, entryInScaffoldState, resolveSpecSdkPin } from "./page-kit-sdk-version.mjs";
import { isAbsoluteHttpUrl, normalizePageKitRoute, runtimeRelativeRouteForSpecValue, stripPublicRoutePrefix } from "./route-identity.mjs";
import { publicRouteForPage } from "./source-html-intake.mjs";
import { MIRRORED_OFFER_FIELDS, MIRRORED_PACKAGE_FIELDS, MIRRORED_PAGE_OFFER_FIELDS } from "./spec-derive-campaign.mjs";

// The spec fields this command may write, as path patterns. `applySpecDerive`
// refuses any change whose path matches none of them, so a plan row can never
// reach an authored field.
export const SPEC_DERIVE_FIELDS = Object.freeze([
  "global_config.sdk_version",
  "runtime.sdk_version",
  "funnels[].pages[].page_url",
  "funnel_pages[].page_url",
  "analytics.providers.gtm.containerId",
  "analytics.providers.facebook.pixelId",
  ...ANALYTICS_VENDORS.map(({ key }) => `analytics.vendors.${key}.id`),
  ...PAGE_KIT_STORE_PROFILE_FIELDS.map((field) => `campaign.${field}`),
]);

// The page routing fields derive writes after handoff, and only on an edge
// that names a page the tree added or removed (#721).
export const PAGE_ROUTING_FIELDS = Object.freeze(["next_page", "on_accept", "on_decline", "success_url"]);

// The starter-template vendor ids (analytics.vendors.<vendor>.id), one per
// vendor in the campaign-spec registry, keyed by the campaigns.json key that
// switches the vendor on. GA4 and Taboola have a known format (Taboola's id is
// injected unquoted, so anything but digits breaks the page); the others are
// one token with no whitespace or quotes, since the template writes the id
// into a script.
const VENDOR_ID_SHAPES = Object.freeze({
  ga4: { shape: /^G-[A-Z0-9]{4,}$/, describe: "a GA4 measurement id (G-XXXXXXXXXX)" },
  taboola: { shape: /^\d+$/, describe: "a Taboola account id (digits only)" },
});
const VENDOR_ID_TOKEN = { shape: /^[^\s"'<>\\`]+$/, describe: "one id token with no spaces or quotes" };
export const ANALYTICS_VENDOR_ID_FIELDS = Object.freeze(ANALYTICS_VENDORS.map(({ key, idKey, label }) => Object.freeze({
  key: idKey,
  vendor: key,
  property: "id",
  ...(VENDOR_ID_SHAPES[key] || { ...VENDOR_ID_TOKEN, describe: `a ${label} id (${VENDOR_ID_TOKEN.describe})` }),
})));

// The SDK routing meta tags a page's `sdk_hints.meta_tags` may carry, and the
// declared routing field (a page id) each one is the route of. A derived
// route change on the referenced page leaves such a hint stale, and derive
// reports it. The one exception is an edge derive itself re-points after
// handoff (a page added or removed): there no editor will regenerate the
// hint, so derive writes it with the routing field it goes with.
const ROUTING_HINT_FIELDS = Object.freeze({
  "next-success-url": "success_url",
  "next-upsell-accept-url": "on_accept",
  "next-upsell-decline-url": "on_decline",
});

// The further paths a handed-off derive may write: whole pages added to or
// removed from the funnel the tree states (an element op), the routing
// fields of an edge that names such a page, and the offer and package fields
// the spec mirrors from the live campaign (spec-derive-campaign.mjs).
export const SPEC_DERIVE_ELEMENTS = Object.freeze(["funnels[].pages[]", "funnel_pages[]", "offers[]"]);
export const SPEC_DERIVE_MIRROR_FIELDS = Object.freeze([
  ...PAGE_ROUTING_FIELDS.flatMap((field) => [`funnels[].pages[].${field}`, `funnel_pages[].${field}`]),
  ...Object.keys(ROUTING_HINT_FIELDS).flatMap((tag) => [`funnels[].pages[].sdk_hints.meta_tags.${tag}`, `funnel_pages[].sdk_hints.meta_tags.${tag}`]),
  ...MIRRORED_PACKAGE_FIELDS.flatMap((field) => [`funnels[].pages[].packages[].${field}`, `funnel_pages[].packages[].${field}`]),
  "offers",
  ...MIRRORED_OFFER_FIELDS.map((field) => `offers[].${field}`),
  ...MIRRORED_PAGE_OFFER_FIELDS.flatMap((field) => [`funnels[].pages[].offers[].${field}`, `funnel_pages[].offers[].${field}`]),
]);

// campaigns.json analytics keys and the spec provider field each one derives.
export const ANALYTICS_ID_FIELDS = Object.freeze([
  Object.freeze({ key: "gtm_id", provider: "gtm", property: "containerId", shape: /^GTM-[A-Z0-9]{4,}$/, describe: "a GTM container id (GTM-XXXXXXX)" }),
  Object.freeze({ key: "fb_pixel_id", provider: "facebook", property: "pixelId", shape: /^\d{5,20}$/, describe: "a Meta pixel id (digits only)" }),
]);

// The directories page-kit's own discovery ignores (`_layouts`, `_includes`;
// on 0.2.x everything else under the campaign root, `assets/` and `_data/`
// included, is rendered when it is .html), plus the two no build reads. The
// CLI walker prunes with this and pageRouteForFile filters with it, so the
// list lives in one place.
export const PAGE_TREE_IGNORED_DIRS = Object.freeze(["_layouts", "_includes", "node_modules", ".git"]);
export function isPageTreeIgnoredDir(name) {
  return PAGE_TREE_IGNORED_DIRS.includes(name);
}

// Whether a campaign-relative file sits where page-kit renders no page. From
// 0.3.0 page-kit also skips the campaign's top-level `assets/` (its
// `*/assets/**` glob; a nested `offers/assets/` still renders), so the caller
// says which rule the target's installed page-kit follows. Backslashes and
// leading slashes read as pageRouteForFile reads them.
export function isPageTreeIgnoredPath(relativePath, { assetsHtmlIgnored = false } = {}) {
  const dirs = normalizePageTreePath(relativePath).split("/").slice(0, -1);
  return dirs.some(isPageTreeIgnoredDir) || (assetsHtmlIgnored && dirs[0] === "assets");
}

function normalizePageTreePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasControlCharacters(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

// A repo value echoed in a reason is quoted short: a value mis-pasted into
// the wrong key (a token, a URL) must not travel whole into warnings.
export function quoteValue(value) {
  const text = JSON.stringify(value);
  return text.length > 44 ? `${text.slice(0, 40)}…"` : text;
}

// The placeholder ids the starter templates document (GTM-XXXXXXX, a run of
// one digit): well-formed, never a real container or pixel.
function isPlaceholderId(value) {
  return /^GTM-X+$/i.test(value) || /^(\d)\1+$/.test(value);
}

// Whether the containers along a write path can take the value: an existing
// container of the wrong type (analytics: "off", global_config: []) is a
// spec defect the plan reports, so a dry run and a real run agree. Returns
// null when the path is writable, else the offending label.
function containerProblem(spec, path) {
  let node = spec;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextIsIndex = Number.isInteger(path[index + 1]);
    const child = node?.[segment];
    if (child === undefined || child === null) return nextIsIndex ? pathLabel(path.slice(0, index + 1)) : null;
    if (nextIsIndex ? !Array.isArray(child) : !isPlainObject(child)) return pathLabel(path.slice(0, index + 1));
    node = child;
  }
  return null;
}

// The public route a page-kit source file builds to without a permalink,
// relative to the campaign root. page-kit's resolveOutput routes by the
// FILENAME alone (`checkout.html` -> `checkout/`, `offers/upsell.html` ->
// `upsell/`, intermediate directories ignored with its NESTED_NO_PERMALINK
// warning), and `index.html` is the entry route "". A nested `index.html`
// would collide with the campaign root (page-kit's DUPLICATE_OUTPUT), so it
// is not a page this reads. Files under `_layouts/` or `_includes/` (and,
// with assetsHtmlIgnored, the top-level `assets/`) return null, as page-kit
// never renders them.
export function pageRouteForFile(relativePath, { assetsHtmlIgnored = false } = {}) {
  const path = normalizePageTreePath(relativePath);
  if (!path || !/\.html$/i.test(path)) return null;
  const segments = path.split("/");
  if (isPageTreeIgnoredPath(path, { assetsHtmlIgnored })) return null;
  const basename = segments[segments.length - 1].replace(/\.html$/i, "");
  if (basename === "index") return segments.length === 1 ? "" : null;
  return `${basename}/`;
}

// The campaign-relative route a frontmatter permalink states. page-kit serves
// a permalink verbatim at `/<permalink>/`, and prepare-build only ever writes
// the `/<slug>/<route>/` form, so that is the only form derive accepts: any
// other spelling (no slug prefix, another prefix, `.html`, `..`, a control
// character) is a repo defect reported with the URL page-kit would serve.
// Returns `{ route }` or `{ problem }`; the problem text carries the served
// URL where one can be named.
export function permalinkRoute(permalink, publicRouteSlug = "") {
  const raw = String(permalink ?? "").trim();
  if (hasControlCharacters(raw)) return { problem: "contains control characters" };
  const stripped = raw.replace(/^\/+|\/+$/g, "");
  const served = `/${stripped}/`;
  const segments = stripped.split("/");
  const slug = String(publicRouteSlug || "").trim();
  if (!stripped || segments[0] !== slug) return { problem: `is served at ${served}, outside the campaign root /${slug || "<slug>"}/` };
  const rest = segments.slice(1);
  if (rest.some((segment) => segment === "" || segment === "." || segment === ".." || /\.html$/i.test(segment) || /[?#]/.test(segment))) {
    return { problem: `is served at ${served}, which is not a page-kit route under /${slug}/ (each segment a plain name, no .html, no query)` };
  }
  return { route: rest.length ? `${rest.join("/")}/` : "" };
}

// A route the page tree states must be a relative page-kit route before it
// becomes an authoritative spec value: a permalink that is an absolute URL,
// climbs with `..`, carries an empty segment or a control character is a
// repo defect, reported rather than written. Returns null when the route is
// usable, else the reason.
export function derivedRouteProblem(route) {
  if (typeof route !== "string") return "not a string";
  if (route === "") return null;
  if (hasControlCharacters(route)) return "contains control characters";
  if (isAbsoluteHttpUrl(route)) return "is an absolute URL, not a page-kit route";
  if (!/\/$/.test(route) || route.startsWith("/")) return "is not a relative page-kit route";
  const segments = route.slice(0, -1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "contains an empty, `.` or `..` segment";
  return null;
}

// The read side of the walker's permalink: YAML idioms page-kit's own
// frontmatter reader (gray-matter) understands. `false`, `null` and `~` mean
// no permalink; a trailing `# comment` on an unquoted value is not part of
// it; surrounding quotes are dropped.
export function normalizePermalinkValue(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // A quoted scalar ends at its closing quote; whatever follows (a comment)
  // is not part of it. An unquoted scalar ends at ` #`.
  const quoted = text.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
  if (quoted) return quoted[2] || null;
  const bare = text.replace(/\s+#.*$/, "").trim();
  if (!bare || ["false", "null", "~"].includes(bare)) return null;
  return bare;
}

// The raw `permalink:` scalar of a page file's frontmatter (the first line
// of the block that declares it), quoting and comment intact, or null when
// the block or the key is absent. A BOM and CRLF are read as page-kit's
// frontmatter reader reads them.
export function frontmatterPermalink(text) {
  return frontmatterScalars(text, ["permalink"]).permalink;
}

// The frontmatter keys a page file states that derive reads after handoff:
// the page-kit page_type (which makes a file a funnel page) and the links
// prepare-build projects between pages (next_url, decline_url, next_step).
export const PAGE_FILE_FRONTMATTER_KEYS = Object.freeze(["permalink", "page_type", "next_url", "decline_url", "next_step"]);

// The raw scalar of each named key in a page file's frontmatter (the first
// line of the block that declares it), read as frontmatterPermalink reads a
// permalink; a key absent from the block, or a file with no block, is null.
export function frontmatterScalars(text, keys = PAGE_FILE_FRONTMATTER_KEYS) {
  const values = Object.fromEntries(keys.map((key) => [key, null]));
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const block = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return values;
  for (const line of block[1].split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!match || !Object.hasOwn(values, match[1]) || values[match[1]] !== null) continue;
    values[match[1]] = normalizePermalinkValue(match[2]);
  }
  return values;
}

/**
 * The routing hints whose value no longer matches the route of the page they
 * name (#531). A page's `sdk_hints.meta_tags` routing tag is the route of the
 * page its declared routing field names (next-success-url: success_url, and
 * so on); compared as the SDK composes it (slug prefix stripped, terminal
 * segment), a hint that differs sends the shopper somewhere the funnel no
 * longer serves. With `routeByPageId` (the routes derive is about to write)
 * only the pages it names are compared; without it every target page's
 * current route is. spec derive warns with this, doctor blocks on it, and
 * record spec refuses a routes-only bind while any hint is stale: one rule,
 * one owner.
 */
export function staleRoutingHints(spec, { publicRouteSlug = "", routeByPageId = null } = {}) {
  const pages = activePagesWithPaths(spec).map(({ page }) => page);
  const byId = new Map();
  for (const page of pages) if (!byId.has(page.id)) byId.set(page.id, page);
  const stale = [];
  for (const page of pages) {
    const metaTags = page.sdk_hints?.meta_tags;
    if (!isPlainObject(metaTags)) continue;
    for (const [tag, routingField] of Object.entries(ROUTING_HINT_FIELDS)) {
      const value = metaTags[tag];
      const targetId = page[routingField];
      if (!isNonEmptyString(value) || !isNonEmptyString(targetId)) continue;
      let route;
      if (routeByPageId instanceof Map) {
        if (!routeByPageId.has(targetId)) continue;
        route = routeByPageId.get(targetId);
      } else {
        if (!byId.has(targetId)) continue;
        route = publicRouteForPage(byId.get(targetId));
      }
      if (runtimeRelativeRouteForSpecValue(value, publicRouteSlug) === runtimeRelativeRouteForSpecValue(route, publicRouteSlug)) continue;
      stale.push({ page_id: page.id, tag, value, target_page_id: targetId, derived_route: route });
    }
  }
  return stale;
}

// A routing hint rewritten to `route`, spelled the way the hint it replaces
// was: the prefix in front of its runtime-relative route ("/slug/" in
// "/slug/receipt/", nothing in "receipt/") is kept, so a rooted hint stays
// rooted.
function routingHintValue(previous, route, publicRouteSlug) {
  const relative = runtimeRelativeRouteForSpecValue(route, publicRouteSlug);
  const raw = previous.trim().replace(/[?#].*$/, "");
  const withSlash = raw.endsWith("/") ? raw : `${raw}/`;
  const old = runtimeRelativeRouteForSpecValue(previous, publicRouteSlug);
  const prefix = old && withSlash.endsWith(old) ? withSlash.slice(0, withSlash.length - old.length) : "";
  return `${prefix}${relative}`;
}

function terminalSegment(route) {
  const parts = normalizePageKitRoute(route).replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// Bind one active spec page to one file in the page tree. The packet's own
// projection (`source_html.pages[].page_kit.target_path`, the file the build
// stage wrote for this page id) binds first; without it, a file whose derived
// route equals the page's current route, whose terminal segment equals the
// current route's, or whose filename is the page id. Exactly one candidate
// binds; none or several is reported and the page is left as it is.
function bindPageFile(page, pageFiles, packetBindings) {
  const bound = packetBindings instanceof Map ? packetBindings.get(page.id) : undefined;
  if (isNonEmptyString(bound)) {
    const match = pageFiles.find((file) => file.path === bound.replace(/^\/+/, ""));
    if (match) return { file: match, via: "packet" };
  }
  const currentRoute = publicRouteForPage(page);
  const currentTerminal = terminalSegment(currentRoute);
  const candidates = new Set();
  for (const file of pageFiles) {
    if (file.route !== null && file.route === currentRoute) candidates.add(file);
    else if (currentTerminal && file.route !== null && terminalSegment(file.route) === currentTerminal) candidates.add(file);
    else if (file.basename === page.id) candidates.add(file);
  }
  if (candidates.size === 1) return { file: [...candidates][0], via: "page_tree" };
  return { file: null, candidates: [...candidates].map((file) => file.path).sort(), via: candidates.size ? "ambiguous" : "none" };
}

// Every active page with the JSON path it lives at. `funnels[]` is
// authoritative; `funnel_pages[]` is the legacy mirror and is only the source
// when `funnels[]` is absent (the same fallback doctor's normalizeFunnels
// applies).
function activePagesWithPaths(spec) {
  const pages = [];
  const visit = (page, path) => {
    if (isPlainObject(page) && page.enabled !== false && isNonEmptyString(page.id)) pages.push({ page, path });
  };
  if (Array.isArray(spec?.funnels)) {
    spec.funnels.forEach((funnel, funnelIndex) => {
      (Array.isArray(funnel?.pages) ? funnel.pages : []).forEach((page, pageIndex) => visit(page, ["funnels", funnelIndex, "pages", pageIndex]));
    });
  } else if (Array.isArray(spec?.funnel_pages)) {
    spec.funnel_pages.forEach((page, index) => visit(page, ["funnel_pages", index]));
  }
  return pages;
}

function pathLabel(path) {
  return path.map((segment, index) => (typeof segment === "number" ? `[${segment}]` : `${index ? "." : ""}${segment}`)).join("");
}

// The CampaignSpec page type a page-kit page_type stands for when the tree
// adds a page. page-kit's four runtime types are coarser than the spec's, so
// product reads as a landing page; a page that is something else (a
// presell, a downsell) has its type authored after the add.
const SPEC_TYPE_FOR_PAGE_KIT_TYPE = Object.freeze({ product: "landing", checkout: "checkout", upsell: "upsell", receipt: "thankyou" });

// The frontmatter link that states each routing field, by spec page type: the
// keys prepare-build projects (source-html-intake.mjs) read back the other
// way. A select or checkout_step page's next_url is the Checkout's
// destination, not its own forward link, so only next_step is read there.
function linkFieldsForType(type) {
  if (type === "upsell" || type === "downsell") return [["next_url", "on_accept"], ["decline_url", "on_decline"]];
  if (type === "checkout") return [["next_url", "success_url"]];
  if (type === "select" || type === "checkout_step") return [["next_step", "next_page"]];
  if (type === "thankyou" || type === "receipt") return [];
  return [["next_url", "next_page"]];
}

const PAGE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Which pages a handed-off tree adds and removes (#721), and the routing on
// the edges that name them. Matching is by page id, never by position:
//   - added: a file with a page-kit page_type in its frontmatter that no spec
//     page binds (and no page could be, ambiguously). Its id is the file's
//     name, its type follows page_type, its route is the route the file
//     builds to, and it is appended to the funnel's pages;
//   - removed: a page whose file the packet's projection named
//     (source_html.pages[].page_kit.target_path) and the tree no longer has.
//     A page the build never wrote is still only "not found";
//   - routing: the added page's own frontmatter links set its routing fields,
//     and a kept page whose link now names an added page, or whose routing
//     named a removed one, is re-pointed at the page its link names.
// Page order is not something the tree states: an added page is appended,
// and where the funnel's pages carry an `order` the new page's is reported
// as not derived. Before handoff nothing is added or removed; the files no
// page binds are listed as unclaimed.
function planPageScope({ spec, activePages, pageFiles, packetBindings, boundFiles, ambiguousFiles, notFound, derivedRouteByPageId, publicRouteSlug, handedOff }) {
  const scope = { handed_off: Boolean(handedOff), added: [], removed: [], unclaimed: [], changes: [], not_derived: [] };
  const unbound = pageFiles.filter((file) => !boundFiles.has(file.path) && !ambiguousFiles.has(file.path) && file.route !== null && !file.problem && isNonEmptyString(file.page_type));
  if (!handedOff) {
    scope.unclaimed = unbound.map((file) => file.path);
    return scope;
  }
  const bindings = packetBindings instanceof Map ? packetBindings : new Map();
  const gone = notFound.filter(({ page }) => isNonEmptyString(bindings.get(page.id)));
  const funnels = Array.isArray(spec?.funnels) ? spec.funnels : null;
  const container = funnels
    ? (funnels.length === 1 && Array.isArray(funnels[0]?.pages) ? ["funnels", 0, "pages"] : null)
    : Array.isArray(spec?.funnel_pages) ? ["funnel_pages"] : null;
  const containerPages = container ? (container.length === 1 ? spec.funnel_pages : spec.funnels[0].pages) : [];
  const mirror = funnels && Array.isArray(spec?.funnel_pages) ? spec.funnel_pages : null;
  const mirrorIndexOf = (id) => (mirror ? mirror.findIndex((page) => isPlainObject(page) && page.id === id) : -1);

  const takenIds = new Set();
  for (const list of [...(funnels || []).map((funnel) => funnel?.pages), spec?.funnel_pages]) {
    for (const page of Array.isArray(list) ? list : []) if (isPlainObject(page) && isNonEmptyString(page.id)) takenIds.add(page.id);
  }
  const added = [];
  for (const file of unbound) {
    const id = file.basename;
    const label = `page file ${file.path}`;
    const type = SPEC_TYPE_FOR_PAGE_KIT_TYPE[file.page_type];
    if (!type) {
      scope.not_derived.push({ field: label, page_id: id, reason: "page_type_unknown", detail: `${file.path} declares page_type ${quoteValue(file.page_type)}, which is not one of page-kit's product, checkout, upsell or receipt; the page was not added. Correct the frontmatter, then derive again.` });
      continue;
    }
    if (!PAGE_ID_SHAPE.test(id) || id === "index" || takenIds.has(id)) {
      scope.not_derived.push({ field: label, page_id: id, reason: "page_id_unusable", detail: `${file.path} would add page "${id}", but ${takenIds.has(id) ? "the spec already has a page with that id" : "that is not a usable page id (letters, digits, - and _, not the entry file)"}; rename the file, then derive again.` });
      continue;
    }
    if (!container) {
      scope.not_derived.push({ field: label, page_id: id, reason: "page_funnel_ambiguous", detail: `${file.path} is a page the spec does not have, but the spec has ${funnels ? `${funnels.length} funnels` : "no page list"}, so which funnel it joins is not something the tree states. Add the page to the right funnel by hand, then derive again.` });
      continue;
    }
    takenIds.add(id);
    added.push({ file, id, type });
  }

  // A page whose file is gone and a new file of the same type in one run is
  // most likely a rename (upsell.html to upsell-1.html). Applied as written,
  // the remove would discard the page's authored record (its packages,
  // offers, label and hints) and the add would start a bare one, so neither
  // is applied: the pair is reported for a person to resolve.
  const goneTypes = new Set(gone.map(({ page }) => page.type));
  const renamedTypes = new Set(added.filter(({ type }) => goneTypes.has(type)).map(({ type }) => type));
  const held = (type) => renamedTypes.has(type);
  for (const { file, id, type } of added.filter((entry) => held(entry.type))) {
    const was = gone.filter(({ page }) => page.type === type).map(({ page }) => `"${page.id}"`).join(", ");
    scope.not_derived.push({ field: `page file ${file.path}`, page_id: id, reason: "page_renamed", detail: `${file.path} is a new ${type} page and the file of ${type} page ${was} is gone, which reads as a rename; derive applies neither, so the page's packages, offers and other authored fields are not lost. If it is a rename, set that page's page_url to ${JSON.stringify(file.route)} (it keeps its id), or rename the file back. If it is a new page, remove the old page from the spec by hand. Then derive again.` });
  }
  for (const { page, path } of gone) {
    if (held(page.type)) {
      scope.not_derived.push({ field: pathLabel(path), page_id: page.id, reason: "page_renamed", detail: `the file of page "${page.id}" (${bindings.get(page.id).replace(/^\/+/, "")}) is gone and the tree has a new ${page.type} page file, which reads as a rename; derive did not remove the page. See the page_renamed row for the new file.` });
      continue;
    }
    scope.removed.push({ page_id: page.id, file: bindings.get(page.id).replace(/^\/+/, "") });
    scope.changes.push({ field: pathLabel(path), page_id: page.id, path, op: "remove", before: page, after: undefined, source: `${bindings.get(page.id).replace(/^\/+/, "")} (no longer in the page tree)` });
    const at = mirrorIndexOf(page.id);
    if (at !== -1) scope.changes.push({ field: `funnel_pages[${at}]`, page_id: page.id, path: ["funnel_pages", at], op: "remove", before: mirror[at], after: undefined, source: `mirror of ${pathLabel(path)}` });
  }
  if (renamedTypes.size) added.splice(0, added.length, ...added.filter((entry) => !held(entry.type)));

  // The routes of the pages the spec will hold, for resolving links.
  const finalRoutes = new Map([...derivedRouteByPageId].filter(([id]) => !scope.removed.some((removed) => removed.page_id === id)));
  for (const { id, file } of added) finalRoutes.set(id, file.route);
  const resolveLink = (value) => {
    if (!isNonEmptyString(value) || value.trim().startsWith("#") || isAbsoluteHttpUrl(value.trim())) return null;
    const wanted = runtimeRelativeRouteForSpecValue(value, publicRouteSlug);
    const matches = [...finalRoutes].filter(([, route]) => runtimeRelativeRouteForSpecValue(route, publicRouteSlug) === wanted).map(([id]) => id);
    return matches.length === 1 ? matches[0] : null;
  };
  const addedIds = new Set(added.map((entry) => entry.id));
  const removedIds = new Set(scope.removed.map((entry) => entry.page_id));

  const hasOrder = containerPages.some((page) => isPlainObject(page) && typeof page.order === "number");
  added.forEach(({ file, id, type }, offset) => {
    const path = [...container, containerPages.length + offset];
    const page = { id, type, page_url: file.route };
    for (const [key, field] of linkFieldsForType(type)) {
      const target = resolveLink(file[key]);
      if (target && target !== id) page[field] = target;
      else {
        scope.not_derived.push({ field: `${pathLabel(path)}.${field}`, page_id: id, reason: "routing_not_derived", detail: file[key]
          ? `${file.path} links ${key} to ${quoteValue(file[key])}, which is not the route of exactly one page; set ${field} on page "${id}" by hand.`
          : `${file.path} states no ${key}, so page "${id}"'s ${field} is not something the tree states; set it by hand.` });
      }
    }
    scope.added.push({ page_id: id, file: file.path, type, route: file.route });
    if (type !== "thankyou") {
      scope.not_derived.push({ field: `${pathLabel(path)}.packages`, page_id: id, reason: "page_packages_not_derived", detail: `page "${id}" was added from ${file.path}; which packages it sells is authored, so set them by hand. Until each path into the Checkout passes a page that sells a main-cart package, and each upsell or downsell has its offer package, doctor blocks (CheckoutPathHasPackages, UpsellHasPackages).` });
    }
    scope.changes.push({ field: pathLabel(path), page_id: id, path, op: "insert", before: undefined, after: page, source: `${file.path} (page_type ${file.page_type})` });
    if (mirror) {
      const mirrorPath = ["funnel_pages", mirror.length + offset];
      scope.changes.push({ field: pathLabel(mirrorPath), page_id: id, path: mirrorPath, op: "insert", before: undefined, after: { ...page }, source: `mirror of ${pathLabel(path)}` });
    }
    if (hasOrder) {
      scope.not_derived.push({ field: `${pathLabel(path)}.order`, page_id: id, reason: "page_order_not_derived", detail: `page "${id}" was appended to the funnel's pages; the repo states its links, not its position, so its order is left for you to set.` });
    }
  });

  // The kept pages' edges that name an added or a removed page. Re-pointing
  // an edge also writes the routing hint that goes with it (when the page
  // carries one) to the new target's route, and the legacy mirror's copy of
  // both: after handoff no editor regenerates them, and a hint left on the
  // old route is what doctor and record spec then refuse.
  const fileByPageId = new Map();
  for (const file of pageFiles) if (boundFiles.has(file.path)) fileByPageId.set(boundFiles.get(file.path), file);
  const hintTagFor = new Map(Object.entries(ROUTING_HINT_FIELDS).map(([tag, field]) => [field, tag]));
  const repoint = (page, path, field, before, after, source) => {
    const rows = [{ field: `${pathLabel(path)}.${field}`, page_id: page.id, path: [...path, field], before, after, source }];
    const tag = hintTagFor.get(field);
    const hintRow = (record, recordPath) => {
      const value = record?.sdk_hints?.meta_tags?.[tag];
      if (!tag || !isNonEmptyString(value) || isAbsoluteHttpUrl(value.trim()) || !finalRoutes.has(after)) return null;
      const next = routingHintValue(value, finalRoutes.get(after), publicRouteSlug);
      if (next === value) return null;
      return { field: `${pathLabel(recordPath)}.sdk_hints.meta_tags.${tag}`, page_id: page.id, path: [...recordPath, "sdk_hints", "meta_tags", tag], before: value, after: next, source: `route of page "${after}" (${source})` };
    };
    const own = hintRow(page, path);
    if (own) rows.push(own);
    const at = path[0] === "funnels" ? mirrorIndexOf(page.id) : -1;
    if (at !== -1) {
      const mirrorPath = ["funnel_pages", at];
      if (isPlainObject(mirror[at]) && mirror[at][field] !== after) rows.push({ field: `${pathLabel(mirrorPath)}.${field}`, page_id: page.id, path: [...mirrorPath, field], before: mirror[at][field], after, source: `mirror of ${pathLabel(path)}.${field}` });
      const mirrorHint = hintRow(mirror[at], mirrorPath);
      if (mirrorHint) rows.push(mirrorHint);
    }
    scope.changes.push(...rows);
  };
  for (const { page, path } of activePages) {
    if (removedIds.has(page.id)) continue;
    const file = fileByPageId.get(page.id);
    for (const [key, field] of linkFieldsForType(page.type)) {
      const current = isNonEmptyString(page[field]) ? page[field] : undefined;
      const target = file ? resolveLink(file[key]) : null;
      if (target && addedIds.has(target) && current !== target) {
        repoint(page, path, field, current, target, `${file.path} frontmatter ${key}`);
      } else if (current && removedIds.has(current)) {
        if (target && target !== current) repoint(page, path, field, current, target, `${file.path} frontmatter ${key}`);
        else scope.not_derived.push({ field: `${pathLabel(path)}.${field}`, page_id: page.id, reason: "routing_target_removed", detail: `page "${page.id}" routes ${field} to "${current}", which the tree removed, and ${file ? `${file.path}'s ${key} names no page the spec keeps` : "no page file states where it goes now"}; set ${field} by hand.` });
      }
    }
  }
  return scope;
}

// The field-by-field plan. `changes` are the derived fields whose value will
// move, `unchanged` already match, `not_derived` are derived fields the repo
// cannot state for this campaign right now (with the reason), `not_in_target`
// are derived fields the repo simply does not carry (left as they are), and
// `stale_hints` are routing hints on other pages that a derived route change
// leaves pointing at the old route.
//
// Inputs, all read by the CLI: the parsed spec; the campaigns.json `entry`
// for the route; `pageFiles` as `{ path, basename, route, permalink }` rows for every
// page file under the campaign's source directory (null when the directory
// does not exist); `packetBindings` as a Map of page id -> target file path
// from the packet's page-kit projection; `waivedGates` as the checkpoint
// gates an active named-human waiver currently covers.
export function planSpecDerive({ spec, entry, pageFiles = null, packetBindings = new Map(), waivedGates = [], waiversUnknown = false, publicRouteSlug = "", handedOff = false } = {}) {
  const target = isPlainObject(entry) ? entry : {};
  const changes = [];
  const unchanged = [];
  const notDerived = [];
  const notInTarget = [];
  const staleHints = [];
  const waivedBy = new Map(
    (Array.isArray(waivedGates) ? waivedGates : [])
      .filter((gate) => isPlainObject(gate) && typeof gate.scope === "string")
      .map((gate) => [gate.scope, gate.waived_by || "a named human"]),
  );

  // SDK pin: the repo pin is what the funnel serves. It is written into the
  // canonical field and, when the spec also declares the alias, into the alias
  // too, so the two never conflict. It is not derived while the entry is still
  // a scaffold (the pin is the starter's seed and page-kit sync's seeding rule
  // owns that direction), when the repo pin is missing or not a released
  // version, or while a named-human waiver covers the exact pair.
  const observed = Object.hasOwn(target, "sdk_version") ? target.sdk_version : undefined;
  const specPin = resolveSpecSdkPin(spec);
  const sdkTargets = [
    { field: "global_config.sdk_version", path: ["global_config", "sdk_version"], before: spec?.global_config?.sdk_version },
    ...(spec?.runtime != null && Object.hasOwn(spec.runtime, "sdk_version")
      ? [{ field: "runtime.sdk_version", path: ["runtime", "sdk_version"], before: spec.runtime.sdk_version }]
      : []),
  ];
  const entrySource = (key) => `${PAGE_KIT_CAMPAIGNS_REL_PATH}[${publicRouteSlug || "<route>"}].${key}`;
  const sdkSource = entrySource("sdk_version");
  const sdkWaiver = waivedBy.get("page_kit.sdk_version") || null;
  if (observed === undefined) {
    notDerived.push({ field: "global_config.sdk_version", reason: "target_missing", detail: `the target entry has no sdk_version; add the Campaign Cart pin the funnel serves to ${sdkSource}, then derive again.` });
  } else if (!isReleasedSdkVersion(observed)) {
    notDerived.push({ field: "global_config.sdk_version", reason: "target_invalid", detail: `the target pin ${quoteValue(observed)} is not a released MAJOR.MINOR.PATCH version; correct ${sdkSource}, then derive again.` });
  } else if (entryInScaffoldState(target)) {
    notDerived.push({ field: "global_config.sdk_version", reason: "scaffold_seed", detail: `the target entry still carries the starter demo store profile, so its pin ${observed} is the starter's seed, not a version anyone chose; the spec seeds the pin in that state (page-kit sync). Sync the scaffold from the spec first, then derive.` });
  } else if (sdkWaiver) {
    notDerived.push({ field: "global_config.sdk_version", reason: "waived", detail: `the SDK pin is covered by an active page_kit.sdk_version waiver recorded by ${sdkWaiver}; spec derive leaves the spec as the waiver accepted it. Withdraw the waiver on the Assembly Report (waivers[]) to let derive write the repo pin.` });
  } else if (waiversUnknown) {
    // An unreadable Assembly Report means a named-human waiver on the pin
    // may exist unseen; "unknown" is not "none", so the pin waits.
    notDerived.push({ field: "global_config.sdk_version", reason: "waivers_unknown", detail: "the Assembly Report could not be read, so an active page_kit.sdk_version waiver cannot be ruled out; spec derive leaves the pin alone rather than reverse a decision it cannot see. Repair or restore the report, then derive again." });
  } else {
    // A spec pin ahead of the repo pin is the state doctor blocks on with
    // page-kit sync as the repair (#413: a bump the repo never received, or
    // a lost one); the repo moves forward, the spec is not moved back. Only
    // one command may own that state, so derive reports it and writes nothing.
    // Every released pin the spec declares is checked, so a conflicting pair
    // (canonical ahead, alias behind) cannot slip a lowering past the rule.
    const declaredAhead = sdkTargets.map((row) => row.before).filter((value) => isReleasedSdkVersion(value) && compareReleasedSdkVersions(value, observed) > 0);
    if (declaredAhead.length) {
      notDerived.push({ field: "global_config.sdk_version", reason: "spec_ahead", detail: `the spec pin ${declaredAhead[0]} is ahead of the target pin ${observed}; doctor blocks on that state and page-kit sync is its repair (it moves the repo forward, and never moves a configured campaign's pin backwards). Run page-kit sync, or lower the spec pin by hand if ${observed} is what should ship, then derive again.` });
    } else {
      for (const row of sdkTargets) {
        const change = { field: row.field, path: row.path, before: row.before, after: observed, source: sdkSource };
        const problem = containerProblem(spec, row.path);
        if (problem) notDerived.push({ field: row.field, reason: "spec_container_invalid", detail: `the spec's ${problem} is not an object, so ${row.field} cannot be written; repair the spec, then derive again.` });
        else if (row.before === observed) unchanged.push(change);
        else changes.push(change);
      }
    }
  }

  // Page routes: page-kit routes by source filename (or permalink), so the
  // tree is the authority for `page_url`.
  const activePages = activePagesWithPaths(spec);
  // A page id that appears twice cannot bind one route: doctor's
  // PageIdUniqueness rule blocks the spec, and derive names it too rather
  // than let the last binding win.
  const idCounts = new Map();
  for (const { page } of activePages) idCounts.set(page.id, (idCounts.get(page.id) || 0) + 1);
  // The route every bound page derives to, changed or not: the standing
  // check on routing hints reads it, so a hint left stale by an earlier run
  // keeps surfacing until the hint is fixed.
  const derivedRouteByPageId = new Map();
  // What the page-scope plan reads: the files a page binds, the files more
  // than one page could be, and the pages no file binds.
  const boundFiles = new Map();
  const ambiguousFiles = new Set();
  const notFound = [];
  let pageScope = { handed_off: handedOff, added: [], removed: [], unclaimed: [], changes: [], not_derived: [] };
  if (pageFiles === null) {
    for (const { page, path } of activePages) {
      notDerived.push({ field: `${pathLabel(path)}.page_url`, page_id: page.id, reason: "page_tree_missing", detail: `the campaign's page tree does not exist in the target repo, so no route can be derived for page "${page.id}". Scaffold and build the campaign first, then derive.` });
    }
  } else {
    const mirrorIndex = new Map();
    if (Array.isArray(spec?.funnels) && Array.isArray(spec?.funnel_pages)) {
      spec.funnel_pages.forEach((page, index) => {
        if (isPlainObject(page) && isNonEmptyString(page.id) && !mirrorIndex.has(page.id)) mirrorIndex.set(page.id, index);
      });
    }
    for (const { page, path } of activePages) {
      const field = `${pathLabel(path)}.page_url`;
      if (idCounts.get(page.id) > 1) {
        notDerived.push({ field, page_id: page.id, reason: "page_id_duplicate", detail: `page id "${page.id}" appears more than once in the spec, so no single route can be derived for it; make page ids unique, then derive again.` });
        continue;
      }
      const binding = bindPageFile(page, pageFiles, packetBindings);
      if (!binding.file) {
        if (binding.via === "ambiguous") {
          for (const candidate of binding.candidates) ambiguousFiles.add(candidate);
          notDerived.push({ field, page_id: page.id, reason: "page_file_ambiguous", detail: `more than one page file could be page "${page.id}" (${binding.candidates.join(", ")}); add a permalink or rename so one file carries the route, then derive again.` });
        } else {
          const row = { field, page_id: page.id, reason: "page_file_not_found", detail: `no page file in the page tree binds to page "${page.id}" (by the packet's page-kit projection, the page's current route ${JSON.stringify(publicRouteForPage(page))}, or a file named after the page id); the page has not been built, or was renamed past recognition. Build it, or name the file after the page, then derive again.` };
          notFound.push({ page, path, row });
          notDerived.push(row);
        }
        continue;
      }
      boundFiles.set(binding.file.path, page.id);
      const after = binding.file.route;
      const before = Object.hasOwn(page, "page_url") ? page.page_url : undefined;
      const source = `${binding.file.path}${binding.file.permalink ? " (permalink)" : ""}`;
      const problem = binding.file.problem || derivedRouteProblem(after);
      if (problem) {
        notDerived.push({ field, page_id: page.id, reason: "target_invalid", detail: `the permalink ${source} states for page "${page.id}" (${quoteValue(binding.file.permalink ?? after)}) ${problem}; fix the file's permalink, then derive again.` });
        continue;
      }
      const row = { field, page_id: page.id, path: [...path, "page_url"], before, after, source };
      // The entry route is the empty string, and doctor honours an empty
      // page_url only on a page flagged is_entry (publicRouteForPage falls
      // back to the type's default route otherwise). Writing "" onto any
      // other page would move it, in doctor's eyes, to a route that does not
      // exist; the flag is authored in the Map, so it is asked for instead.
      if (after === "" && page.is_entry !== true) {
        notDerived.push({ field, page_id: page.id, reason: "entry_route_undeclared", detail: `page "${page.id}" binds to ${source}, the entry route, but the page is not flagged is_entry; doctor reads an empty page_url only on the entry page. Flag it in the Map (or give the file a permalink), then derive again.` });
        continue;
      }
      derivedRouteByPageId.set(page.id, after);
      const containerIssue = containerProblem(spec, row.path);
      if (containerIssue) {
        notDerived.push({ field, page_id: page.id, reason: "spec_container_invalid", detail: `the spec's ${containerIssue} is not an object, so ${field} cannot be written; repair the spec, then derive again.` });
        continue;
      }
      // Compared the way prepare-build projects a route (normalized, slug
      // prefix stripped): a value that differs only in spelling
      // ("/slug/checkout/", "checkout") is the same route and is not
      // rewritten; a value nested differently from the tree is not.
      const sameRoute = typeof before === "string"
        && stripPublicRoutePrefix(normalizePageKitRoute(before), publicRouteSlug) === after
        && (before.trim() !== "" || page.is_entry === true);
      if (sameRoute) unchanged.push(row);
      else changes.push(row);
      // The legacy mirror is reconciled for every derived page, changed or
      // not: a mirror left stale by an earlier edit would otherwise stay so.
      const mirrorAt = mirrorIndex.get(page.id);
      if (mirrorAt !== undefined) {
        const mirror = spec.funnel_pages[mirrorAt];
        const mirrorBefore = Object.hasOwn(mirror, "page_url") ? mirror.page_url : undefined;
        const mirrorSame = typeof mirrorBefore === "string"
          && stripPublicRoutePrefix(normalizePageKitRoute(mirrorBefore), publicRouteSlug) === after
          && (mirrorBefore.trim() !== "" || page.is_entry === true);
        if (!mirrorSame) {
          changes.push({ field: `funnel_pages[${mirrorAt}].page_url`, page_id: page.id, path: ["funnel_pages", mirrorAt, "page_url"], before: mirrorBefore, after, source: `mirror of ${field}` });
        }
      }
    }
    // The pages the tree adds or removes (#721), matched by id.
    pageScope = planPageScope({ spec, activePages, pageFiles, packetBindings, boundFiles, ambiguousFiles, notFound, derivedRouteByPageId, publicRouteSlug, handedOff });
    changes.push(...pageScope.changes);
    notDerived.push(...pageScope.not_derived);

    // A routing hint that names a page whose route it does not match is
    // stale, whether the route moved in this run or an earlier one. It is
    // read off the spec as this plan leaves it, so a hint the plan rewrites
    // is not reported and one an added or removed page leaves behind is:
    // the same list doctor blocks on and record spec refuses after the
    // write. Hints are a spec projection (doctor reads them as build
    // expectations); derive rewrites only the hint on an edge it re-points.
    const routesAfter = new Map([...derivedRouteByPageId].filter(([id]) => !pageScope.removed.some((entry) => entry.page_id === id)));
    for (const entry of pageScope.added) routesAfter.set(entry.page_id, entry.route);
    let planned = null;
    try {
      planned = applySpecDerive(structuredClone(spec), { changes });
    } catch {
      // A plan the guard would refuse is reported by the write; the hints
      // are then read off the spec as it is.
    }
    staleHints.push(...staleRoutingHints(planned || spec, { publicRouteSlug, routeByPageId: routesAfter }));
  }
  // A page the tree no longer builds is reported as not found unless this run
  // removes it.
  for (const removed of pageScope.removed) {
    const at = notDerived.findIndex((row) => row.reason === "page_file_not_found" && row.page_id === removed.page_id);
    if (at !== -1) notDerived.splice(at, 1);
  }

  // Analytics ids the entry carries. A usable id is written into the provider
  // or vendor block (created when the spec lacks it). An empty repo value
  // never deletes a spec id: the mismatch is reported so someone decides
  // which side is wrong. A vendor neither side carries is not listed under
  // not_in_target: the template vendors are opt-in (absent means off), so
  // eight "not in target" lines on every run would say nothing.
  const analyticsIdRows = [
    ...ANALYTICS_ID_FIELDS.map(({ key, provider, property, shape, describe }) => ({ key, block: "providers", name: provider, property, shape, describe, optIn: false })),
    ...ANALYTICS_VENDOR_ID_FIELDS.map(({ key, vendor, property, shape, describe }) => ({ key, block: "vendors", name: vendor, property, shape, describe, optIn: true })),
  ];
  for (const { key, block, name, property, shape, describe, optIn } of analyticsIdRows) {
    const field = `analytics.${block}.${name}.${property}`;
    const raw = Object.hasOwn(target, key) ? target[key] : undefined;
    const current = spec?.analytics?.[block]?.[name]?.[property];
    const source = entrySource(key);
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      if (isNonEmptyString(current)) {
        notDerived.push({ field, reason: "target_empty", detail: `the target entry's ${key} is empty but the spec declares ${field} ${quoteValue(current)}; add the id to ${source} if the funnel should carry it, or remove it from the spec. Nothing was written.` });
      } else if (!optIn) notInTarget.push(field);
      continue;
    }
    if (typeof raw !== "string" || hasControlCharacters(raw) || !shape.test(raw.trim())) {
      notDerived.push({ field, reason: "target_invalid", detail: `the target entry's ${key} ${typeof raw === "string" ? quoteValue(raw) : `is ${Array.isArray(raw) ? "an array" : `a ${typeof raw}`}`} is not ${describe}; correct ${source}, then derive again.` });
      continue;
    }
    const after = raw.trim();
    if (isPlaceholderId(after) || (block === "vendors" && isPlaceholderVendorId(after))) {
      const consequence = block === "vendors"
        ? "the template loads the vendor for any non-empty value, so the campaign is sending to a vendor account that does not exist"
        : "writing it would declare an analytics contract QA then blocks on";
      notDerived.push({ field, reason: "target_invalid", detail: `the target entry's ${key} ${quoteValue(after)} is a placeholder, not a real id; ${consequence}. Replace it in ${source} (or clear it), then derive again.` });
      continue;
    }
    const row = { field, path: ["analytics", block, name, property], before: current, after, source };
    const problem = containerProblem(spec, row.path);
    if (problem) notDerived.push({ field, reason: "spec_container_invalid", detail: `the spec's ${problem} is not an object, so ${field} cannot be written; repair the spec, then derive again.` });
    else if (current === after) unchanged.push(row);
    else changes.push(row);
  }

  // A provider block derive will create is a new analytics contract: QA
  // stops treating analytics as advisory and expects that tag to fire.
  const createdBlocks = ANALYTICS_ID_FIELDS
    .filter(({ provider, property }) => changes.some((row) => row.field === `analytics.providers.${provider}.${property}`) && !isPlainObject(spec?.analytics?.providers?.[provider]))
    .map(({ provider }) => `analytics.providers.${provider}`);
  // A vendor block derive will create declares the vendor: doctor then reads
  // its campaigns.json key against the spec. When the spec had no analytics
  // block at all, the new block also turns on QA's analytics leg.
  const createdVendorBlocks = ANALYTICS_VENDOR_ID_FIELDS
    .filter(({ vendor, property }) => changes.some((row) => row.field === `analytics.vendors.${vendor}.${property}`) && !isPlainObject(spec?.analytics?.vendors?.[vendor]))
    .map(({ vendor }) => `analytics.vendors.${vendor}`);
  const analyticsCreated = (createdBlocks.length > 0 || createdVendorBlocks.length > 0) && !isPlainObject(spec?.analytics);

  const pageScopeSummary = { handed_off: pageScope.handed_off, added: pageScope.added, removed: pageScope.removed, unclaimed: pageScope.unclaimed };
  return {
    changes,
    unchanged,
    not_derived: notDerived,
    not_in_target: notInTarget,
    stale_hints: staleHints,
    created_blocks: [...new Set(createdBlocks)],
    created_vendor_blocks: createdVendorBlocks,
    analytics_created: analyticsCreated,
    page_scope: pageScopeSummary,
  };
}

function pathMatchesPattern(path, pattern) {
  const expected = pattern.split(".").flatMap((segment) => (segment.endsWith("[]") ? [segment.slice(0, -2), "[]"] : [segment]));
  if (expected.length !== path.length) return false;
  return expected.every((segment, index) => (segment === "[]" ? Number.isInteger(path[index]) : path[index] === segment));
}

// Apply a plan to the parsed spec. Mutates ONLY the derived field each change
// names, in place, so key order and every other key survive; a missing
// container object is created (`global_config`; a provider or vendor block
// such as `analytics.providers.gtm` or `analytics.vendors.ga4` as
// `{ enabled: true }`), a missing array element is never invented. A row
// with `op` adds ("insert", appended at its index) or removes ("remove") a
// whole element of a list derive governs (a page, an offer record): field
// writes go first, against the indices the plan read, then inserts, then
// removals from the highest index down, so no write lands on a shifted
// element. Returns the same spec object.
export function applySpecDerive(spec, plan) {
  if (!isPlainObject(spec)) throw new Error("CampaignSpec must be a JSON object.");
  const writable = [...SPEC_DERIVE_FIELDS, ...SPEC_DERIVE_MIRROR_FIELDS];
  const fieldRows = [];
  const inserts = [];
  const removes = [];
  for (const change of plan.changes) {
    const path = Array.isArray(change.path) ? change.path : [];
    if (change.op === "insert" || change.op === "remove") {
      if (!SPEC_DERIVE_ELEMENTS.some((pattern) => pathMatchesPattern(path, pattern))) {
        throw new Error(`Refusing to ${change.op === "insert" ? "add" : "remove"} "${change.field}": spec derive adds and removes only ${SPEC_DERIVE_ELEMENTS.join(", ")}.`);
      }
      (change.op === "insert" ? inserts : removes).push({ change, path });
      continue;
    }
    if (!writable.some((pattern) => pathMatchesPattern(path, pattern))) {
      throw new Error(`Refusing to write "${change.field}": spec derive governs only ${SPEC_DERIVE_FIELDS.join(", ")} (and, after handoff or from the live campaign, ${SPEC_DERIVE_MIRROR_FIELDS.join(", ")}).`);
    }
    fieldRows.push({ change, path });
  }
  for (const { change, path } of fieldRows) {
    let node = spec;
    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index];
      if (Number.isInteger(segment)) {
        if (!Array.isArray(node) || !isPlainObject(node[segment])) throw new Error(`Refusing to write "${change.field}": ${pathLabel(path.slice(0, index + 1))} is not an object in the spec.`);
        node = node[segment];
        continue;
      }
      const nextIsIndex = Number.isInteger(path[index + 1]);
      if (node[segment] === undefined || node[segment] === null) {
        if (nextIsIndex) throw new Error(`Refusing to write "${change.field}": ${pathLabel(path.slice(0, index + 1))} is not an array in the spec.`);
        // A provider or vendor block created by derive is enabled: an id the
        // repo carries is a tag the funnel fires, which is what QA then expects.
        node[segment] = path[index - 1] === "providers" || path[index - 1] === "vendors" ? { enabled: true } : {};
      } else if (nextIsIndex ? !Array.isArray(node[segment]) : !isPlainObject(node[segment])) {
        throw new Error(`Refusing to write "${change.field}": ${pathLabel(path.slice(0, index + 1))} is not ${nextIsIndex ? "an array" : "an object"} in the spec.`);
      }
      node = node[segment];
    }
    node[path[path.length - 1]] = change.after;
  }
  const listAt = (path, change) => {
    let node = spec;
    for (const segment of path.slice(0, -1)) {
      node = node?.[segment];
      if (node === undefined || node === null) break;
    }
    if (!Array.isArray(node)) throw new Error(`Refusing to change "${change.field}": ${pathLabel(path.slice(0, -1))} is not an array in the spec.`);
    return node;
  };
  for (const { change, path } of inserts.sort((a, b) => a.path[a.path.length - 1] - b.path[b.path.length - 1])) {
    const list = listAt(path, change);
    if (path[path.length - 1] !== list.length || !isPlainObject(change.after)) throw new Error(`Refusing to add "${change.field}": it is not the next element of ${pathLabel(path.slice(0, -1))}.`);
    list.push(change.after);
  }
  for (const { change, path } of removes.sort((a, b) => b.path[b.path.length - 1] - a.path[a.path.length - 1])) {
    const list = listAt(path, change);
    const index = path[path.length - 1];
    if (!isPlainObject(list[index]) || (isNonEmptyString(change.page_id) && list[index].id !== change.page_id)) throw new Error(`Refusing to remove "${change.field}": it is not page "${change.page_id}" in the spec.`);
    list.splice(index, 1);
  }
  return spec;
}

// One line per field for the printed diff. `undefined` (the spec had no such
// key) prints as (absent); everything else is JSON so a string that merely
// looks empty is visibly quoted.
export function formatDeriveValue(value) {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}
