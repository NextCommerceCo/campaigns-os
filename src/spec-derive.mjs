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
// Store-derived fields (the Store Profile over the Admin API) are the second
// slice and need a credential path; they are not touched here.
//
// This module is pure: the CLI reads the packet, the spec, the entry and the
// page tree, and does the writing and the printing.
import { isReleasedSdkVersion } from "../campaign-spec/dist/index.js";
import { entryInScaffoldState, resolveSpecSdkPin, SPEC_DERIVE_COMMAND } from "./page-kit-sdk-version.mjs";
import { normalizePageKitRoute, runtimeRelativeRouteForSpecValue, stripPublicRoutePrefix } from "./route-identity.mjs";
import { publicRouteForPage } from "./source-html-intake.mjs";

export { SPEC_DERIVE_COMMAND };

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

const PAGE_TREE_IGNORED = /^(?:_includes|_layouts|_data|assets|node_modules)(?:\/|$)|(?:^|\/)_[^/]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasControlCharacters(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function compareReleased(a, b) {
  const [am, an, ap] = a.split(".").map(Number);
  const [bm, bn, bp] = b.split(".").map(Number);
  return am - bm || an - bn || ap - bp;
}

// The public route a page-kit source file builds to, relative to the campaign
// root: page-kit routes by filename (`checkout.html` -> `checkout/`,
// `a/b.html` -> `a/b/`, `index.html` -> the directory's route, so the top-level
// `index.html` is the entry route ""), and a `permalink` in the file's
// frontmatter overrides that. Files page-kit does not render as pages
// (`_includes/`, `_layouts/`, `_data/`, `assets/`, underscore-prefixed files)
// return null.
export function pageRouteForFile(relativePath, { permalink = null, publicRouteSlug = "" } = {}) {
  const path = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || !/\.html$/i.test(path) || PAGE_TREE_IGNORED.test(path)) return null;
  if (isNonEmptyString(permalink)) return stripPublicRoutePrefix(normalizePageKitRoute(permalink), publicRouteSlug);
  const withoutExtension = path.replace(/\.html$/i, "");
  const segments = withoutExtension.split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index") segments.pop();
  return segments.length ? `${segments.join("/")}/` : "";
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
    if (file.route === currentRoute) candidates.add(file);
    else if (currentTerminal && terminalSegment(file.route) === currentTerminal) candidates.add(file);
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
// for the route; `pageFiles` as `{ path, basename, route }` rows for every
// page file under the campaign's source directory (null when the directory
// does not exist); `packetBindings` as a Map of page id -> target file path
// from the packet's page-kit projection; `waivedGates` as the checkpoint
// gates an active named-human waiver currently covers.
export function planSpecDerive({ spec, entry, pageFiles = null, packetBindings = new Map(), waivedGates = [], publicRouteSlug = "" } = {}) {
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
  const sdkSource = "_data/campaigns.json[<route>].sdk_version".replace("<route>", publicRouteSlug || "<route>");
  const sdkWaiver = waivedBy.get("page_kit.sdk_version") || null;
  if (observed === undefined) {
    notDerived.push({ field: "global_config.sdk_version", reason: "target_missing", detail: `the target entry has no sdk_version; add the Campaign Cart pin the funnel serves to ${sdkSource}, then derive again.` });
  } else if (!isReleasedSdkVersion(observed)) {
    notDerived.push({ field: "global_config.sdk_version", reason: "target_invalid", detail: `the target pin ${JSON.stringify(observed)} is not a released MAJOR.MINOR.PATCH version; correct ${sdkSource}, then derive again.` });
  } else if (entryInScaffoldState(target)) {
    notDerived.push({ field: "global_config.sdk_version", reason: "scaffold_seed", detail: `the target entry still carries the starter demo store profile, so its pin ${observed} is the starter's seed, not a version anyone chose; the spec seeds the pin in that state (page-kit sync). Sync the scaffold from the spec first, then derive.` });
  } else if (sdkWaiver) {
    notDerived.push({ field: "global_config.sdk_version", reason: "waived", detail: `the SDK pin is covered by an active page_kit.sdk_version waiver recorded by ${sdkWaiver}; spec derive leaves the spec as the waiver accepted it. Withdraw the waiver on the Assembly Report (waivers[]) to let derive write the repo pin.` });
  } else {
    for (const row of sdkTargets) {
      const change = { field: row.field, path: row.path, before: row.before, after: observed, source: sdkSource };
      if (row.before === observed) unchanged.push(change);
      else {
        // A spec pin ahead of the repo is a bump the repo never received (or
        // a lost one). The repo still wins, but the downgrade is flagged.
        if (specPin.status === "ok" && compareReleased(specPin.value, observed) > 0) change.downgrade = { from: specPin.value };
        changes.push(change);
      }
    }
  }

  // Page routes: page-kit routes by source filename (or permalink), so the
  // tree is the authority for `page_url`.
  const activePages = activePagesWithPaths(spec);
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
      const row = { field, page_id: page.id, path: [...path, "page_url"], before, after, source };
      // The route is compared in its normalized page-kit form: a value that
      // differs only in spelling ("checkout" vs "checkout/") is the same route
      // to doctor and is not rewritten.
      if (typeof before === "string" && normalizePageKitRoute(before) === after) unchanged.push(row);
      else {
        changes.push(row);
        derivedRouteByPageId.set(page.id, after);
        const mirrorAt = mirrorIndex.get(page.id);
        if (mirrorAt !== undefined) {
          const mirror = spec.funnel_pages[mirrorAt];
          const mirrorBefore = Object.hasOwn(mirror, "page_url") ? mirror.page_url : undefined;
          if (!(typeof mirrorBefore === "string" && normalizePageKitRoute(mirrorBefore) === after)) {
            changes.push({ field: `funnel_pages[${mirrorAt}].page_url`, page_id: page.id, path: ["funnel_pages", mirrorAt, "page_url"], before: mirrorBefore, after, source: `mirror of ${field}` });
          }
        }
      }
    }
    // A routing hint on another page that names a page whose route just
    // moved is now stale. Hints are a spec projection the editor regenerates
    // (doctor reads them as build expectations), so they are reported.
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
    const source = `_data/campaigns.json[${publicRouteSlug || "<route>"}].${key}`;
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      if (isNonEmptyString(current)) {
        notDerived.push({ field, reason: "target_empty", detail: `the target entry's ${key} is empty but the spec declares ${field} ${JSON.stringify(current)}; add the id to ${source} if the funnel should carry it, or remove it from the spec. Nothing was written.` });
      } else notInTarget.push(field);
      continue;
    }
    if (typeof raw !== "string" || hasControlCharacters(raw) || !shape.test(raw.trim())) {
      notDerived.push({ field, reason: "target_invalid", detail: `the target entry's ${key} ${typeof raw === "string" ? JSON.stringify(raw) : `is ${Array.isArray(raw) ? "an array" : `a ${typeof raw}`}`} is not ${describe}; correct ${source}, then derive again.` });
      continue;
    }
    const after = raw.trim();
    const row = { field, path: ["analytics", "providers", provider, property], before: current, after, source };
    if (current === after) unchanged.push(row);
    else changes.push(row);
  }

  return { changes, unchanged, not_derived: notDerived, not_in_target: notInTarget, stale_hints: staleHints };
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
