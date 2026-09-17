// `campaigns-os spec derive`: write the fields the target repo already states
// into the packet's local CampaignSpec.
//
// Every field in a CampaignSpec has a class (#432): authored (a human writes
// it), mirrored (pulled from the Campaigns API or the store) or derived (the
// repo or the store already states it). Derived fields are generated, never
// typed, and this command is the generator for the repo-derived ones: the
// SDK pin from `_data/campaigns.json[<route>].sdk_version`, each page's public
// route from the page tree under `src/<route>/`, and the analytics ids the
// entry carries (`gtm_id`, `fb_pixel_id`). Doctor then compares generated
// against generated instead of refereeing a human's typing against the repo.
//
// The repo is the authority for exactly those fields. A spec value that looks
// authored but sits in a derived field is overwritten, with the before -> after
// line showing it; nothing outside the derived fields is written, ever.
// The store-derived fields (the nine campaign.store_* Store Profile fields,
// authority: the store's Admin API) are planned by spec-derive-store.mjs
// behind --from-store; their rows are applied here under the same guard.
//
// This module is pure: the CLI reads the packet, the spec, the entry and the
// page tree, and does the writing and the printing.
import { isReleasedSdkVersion } from "../campaign-spec/dist/index.js";
import { PAGE_KIT_CAMPAIGNS_REL_PATH } from "./page-kit-campaign-config.mjs";
import { PAGE_KIT_STORE_PROFILE_FIELDS } from "./page-kit-store-profile.mjs";
import { compareReleasedSdkVersions, entryInScaffoldState, resolveSpecSdkPin } from "./page-kit-sdk-version.mjs";
import { isAbsoluteHttpUrl, normalizePageKitRoute, runtimeRelativeRouteForSpecValue, stripPublicRoutePrefix } from "./route-identity.mjs";
import { publicRouteForPage } from "./source-html-intake.mjs";

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
  ...PAGE_KIT_STORE_PROFILE_FIELDS.map((field) => `campaign.${field}`),
]);

// campaigns.json analytics keys and the spec provider field each one derives.
export const ANALYTICS_ID_FIELDS = Object.freeze([
  Object.freeze({ key: "gtm_id", provider: "gtm", property: "containerId", shape: /^GTM-[A-Z0-9]{4,}$/, describe: "a GTM container id (GTM-XXXXXXX)" }),
  Object.freeze({ key: "fb_pixel_id", provider: "facebook", property: "pixelId", shape: /^\d{5,20}$/, describe: "a Meta pixel id (digits only)" }),
]);

// The SDK routing meta tags a page's `sdk_hints.meta_tags` may carry, and the
// declared routing field (a page id) each one is the route of. A derived
// route change on the referenced page leaves such a hint stale; the hint is a
// spec projection the editor regenerates, so it is reported, not rewritten.
const ROUTING_HINT_FIELDS = Object.freeze({
  "next-success-url": "success_url",
  "next-upsell-accept-url": "on_accept",
  "next-upsell-decline-url": "on_decline",
});

// The directories page-kit's own discovery ignores (`_layouts`, `_includes`;
// everything else under the campaign root, `assets/` and `_data/` included,
// is rendered when it is .html), plus the two no build reads. The CLI walker
// prunes with this and pageRouteForFile filters with it, so the list lives
// in one place.
export const PAGE_TREE_IGNORED_DIRS = Object.freeze(["_layouts", "_includes", "node_modules", ".git"]);
export function isPageTreeIgnoredDir(name) {
  return PAGE_TREE_IGNORED_DIRS.includes(name);
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
// is not a page this reads. Files under `_layouts/` or `_includes/` return
// null, as page-kit never renders them.
export function pageRouteForFile(relativePath) {
  const path = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || !/\.html$/i.test(path)) return null;
  const segments = path.split("/");
  if (segments.slice(0, -1).some(isPageTreeIgnoredDir)) return null;
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
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const block = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return null;
  for (const line of block[1].split("\n")) {
    const match = line.match(/^permalink:\s*(.*?)\s*$/);
    if (match) return normalizePermalinkValue(match[1]);
  }
  return null;
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
export function planSpecDerive({ spec, entry, pageFiles = null, packetBindings = new Map(), waivedGates = [], waiversUnknown = false, publicRouteSlug = "" } = {}) {
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
  // keeps surfacing until the Map is re-saved.
  const derivedRouteByPageId = new Map();
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
        notDerived.push(binding.via === "ambiguous"
          ? { field, page_id: page.id, reason: "page_file_ambiguous", detail: `more than one page file could be page "${page.id}" (${binding.candidates.join(", ")}); add a permalink or rename so one file carries the route, then derive again.` }
          : { field, page_id: page.id, reason: "page_file_not_found", detail: `no page file in the page tree binds to page "${page.id}" (by the packet's page-kit projection, the page's current route ${JSON.stringify(publicRouteForPage(page))}, or a file named after the page id); the page has not been built, or was renamed past recognition. Build it, or name the file after the page, then derive again.` });
        continue;
      }
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
    // A routing hint that names a page whose derived route it does not match
    // is stale, whether the route moved in this run or an earlier one. Hints
    // are a spec projection the editor regenerates (doctor reads them as
    // build expectations), so they are reported, never rewritten.
    for (const { page } of activePages) {
      const metaTags = page.sdk_hints?.meta_tags;
      if (!isPlainObject(metaTags)) continue;
      for (const [tag, routingField] of Object.entries(ROUTING_HINT_FIELDS)) {
        const value = metaTags[tag];
        const targetId = page[routingField];
        if (!isNonEmptyString(value) || !isNonEmptyString(targetId) || !derivedRouteByPageId.has(targetId)) continue;
        const derived = derivedRouteByPageId.get(targetId);
        if (runtimeRelativeRouteForSpecValue(value, publicRouteSlug) === runtimeRelativeRouteForSpecValue(derived, publicRouteSlug)) continue;
        staleHints.push({ page_id: page.id, tag, value, target_page_id: targetId, derived_route: derived });
      }
    }
  }

  // Analytics ids the entry carries. A usable id is written into the provider
  // block (created when the spec lacks it). An empty repo value never deletes
  // a spec id: the mismatch is reported so someone decides which side is
  // wrong.
  for (const { key, provider, property, shape, describe } of ANALYTICS_ID_FIELDS) {
    const field = `analytics.providers.${provider}.${property}`;
    const raw = Object.hasOwn(target, key) ? target[key] : undefined;
    const current = spec?.analytics?.providers?.[provider]?.[property];
    const source = entrySource(key);
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      if (isNonEmptyString(current)) {
        notDerived.push({ field, reason: "target_empty", detail: `the target entry's ${key} is empty but the spec declares ${field} ${quoteValue(current)}; add the id to ${source} if the funnel should carry it, or remove it from the spec. Nothing was written.` });
      } else notInTarget.push(field);
      continue;
    }
    if (typeof raw !== "string" || hasControlCharacters(raw) || !shape.test(raw.trim())) {
      notDerived.push({ field, reason: "target_invalid", detail: `the target entry's ${key} ${typeof raw === "string" ? quoteValue(raw) : `is ${Array.isArray(raw) ? "an array" : `a ${typeof raw}`}`} is not ${describe}; correct ${source}, then derive again.` });
      continue;
    }
    const after = raw.trim();
    if (isPlaceholderId(after)) {
      notDerived.push({ field, reason: "target_invalid", detail: `the target entry's ${key} ${quoteValue(after)} is a placeholder, not a real id; writing it would declare an analytics contract QA then blocks on. Replace it in ${source} (or clear it), then derive again.` });
      continue;
    }
    const row = { field, path: ["analytics", "providers", provider, property], before: current, after, source };
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

  return { changes, unchanged, not_derived: notDerived, not_in_target: notInTarget, stale_hints: staleHints, created_blocks: [...new Set(createdBlocks)] };
}

function pathMatchesPattern(path, pattern) {
  const expected = pattern.split(".").flatMap((segment) => (segment.endsWith("[]") ? [segment.slice(0, -2), "[]"] : [segment]));
  if (expected.length !== path.length) return false;
  return expected.every((segment, index) => (segment === "[]" ? Number.isInteger(path[index]) : path[index] === segment));
}

// Apply a plan to the parsed spec. Mutates ONLY the derived field each change
// names, in place, so key order and every other key survive; a missing
// container object is created (`global_config`, `analytics.providers.gtm`
// as `{ enabled: true }`), a missing array element is never invented. Returns
// the same spec object.
export function applySpecDerive(spec, plan) {
  if (!isPlainObject(spec)) throw new Error("CampaignSpec must be a JSON object.");
  for (const change of plan.changes) {
    const path = Array.isArray(change.path) ? change.path : [];
    if (!SPEC_DERIVE_FIELDS.some((pattern) => pathMatchesPattern(path, pattern))) {
      throw new Error(`Refusing to write "${change.field}": spec derive governs only ${SPEC_DERIVE_FIELDS.join(", ")}.`);
    }
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
        // A provider block created by derive is enabled: an id the repo
        // carries is a tag the funnel fires, which is what QA then expects.
        node[segment] = path[index - 1] === "providers" ? { enabled: true } : {};
      } else if (nextIsIndex ? !Array.isArray(node[segment]) : !isPlainObject(node[segment])) {
        throw new Error(`Refusing to write "${change.field}": ${pathLabel(path.slice(0, index + 1))} is not ${nextIsIndex ? "an array" : "an object"} in the spec.`);
      }
      node = node[segment];
    }
    node[path[path.length - 1]] = change.after;
  }
  return spec;
}

// One line per field for the printed diff. `undefined` (the spec had no such
// key) prints as (absent); everything else is JSON so a string that merely
// looks empty is visibly quoted.
export function formatDeriveValue(value) {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}
