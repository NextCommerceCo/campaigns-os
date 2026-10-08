import { basename, extname, join, resolve } from "node:path";
import {
  readSourceHtmlManifestFile,
} from "./source-html-manifest.mjs";
// Built output of campaign-spec (same import shape as src/page-kit-sdk-version.mjs),
// so build-time wiring and spec-time analysis share one edge resolver.
import { checkoutPathFrom, declineRouteTarget, forwardRouteTarget, forwardTargetPage, isCheckoutStepPage } from "../campaign-spec/dist/index.js";
import { isAbsoluteHttpUrl, normalizePageKitRoute, normalizePublicRouteSlug, stripPublicRoutePrefix } from "./route-identity.mjs";

const CPK_PAGE_TYPES = new Set(["product", "checkout", "upsell", "receipt"]);

export function createSourceHtmlIntake({
  sourceRoot,
  specPages,
  htmlFiles,
  publicRouteSlug,
  outputDir,
  buildScope = null,
  manifestPath = null,
  templateFamily = null,
}) {
  const manifestResult = readSourceHtmlManifestFile(sourceRoot, { manifestPath });
  const scopeOptions = { buildScope, templateFamily };
  const matched = manifestResult.manifest
    ? applyManifestToPages(specPages, manifestResult.manifest, manifestResult.path, scopeOptions)
    : matchSourcePages(specPages, htmlFiles, scopeOptions);
  const pageById = new Map((specPages || []).map((page) => [page.id, page]));
  const projectionDecisions = [];

  const mappings = matched.mappings.map((mapping) => {
    const specPage = pageById.get(mapping.page_id);
    if (!specPage || !mapping.path) return mapping;
    const pageKit = pageKitProjectionForPage(specPage, { pageById, publicRouteSlug, outputDir, specPages: specPages || [] });
    projectionDecisions.push({
      id: `dec_page_kit_target_${specPage.id}`,
      stage: "prepare_build",
      decision_type: "deterministic_derivation",
      decision: `projected CampaignSpec page "${specPage.id}" to Page Kit target "${pageKit.target_path}" with CPK page_type "${pageKit.page_type}"`,
      confidence: "high",
      evidence: [
        `source path "${mapping.path}" remains producer provenance`,
        `target path "${pageKit.output_path}" derives from CampaignSpec route "${pageKit.spec_route || "(entry route)"}" and public slug "${publicRouteSlug}"`,
      ],
    });
    return { ...mapping, page_kit: pageKit };
  });

  const targetPrompts = pageKitTargetPrompts(mappings);

  return {
    manifestResult,
    manifestWarnings: [
      ...(manifestResult.warning ? [manifestResult.warning] : []),
      ...(manifestResult.warnings || []),
    ],
    mappings,
    prompts: [...matched.prompts, ...targetPrompts],
    decisions: [...matched.decisions, ...projectionDecisions],
    ambiguousCandidates: matched.ambiguousCandidates || [],
    manifestDraft: matched.manifestDraft || null,
    declaredSkips: matched.declaredSkips || [],
  };
}

// A partial-source build is the ordinary shape of a template-family campaign:
// a few designed pages carry prepared source HTML, the rest assemble from the
// certified family. Two explicit declarations turn a missing source file from
// a blocker into a recorded out-of-scope page:
//   1. a source-html manifest entry with skip_reason instead of path (per-page), or
//   2. CampaignSpec build_scope.mode "partial" (blanket, for pages with no
//      manifest entry and no design_source).
// A page that declares design_source still blocks without a per-page skip
// entry — it was produced to have source HTML, so its absence stays an error.
// Full/undeclared scope keeps today's blocking behavior exactly.
function declaredPartialScope(buildScope) {
  return buildScope?.mode === "partial";
}

function buildScopeSkipReason(buildScope) {
  const reasons = Array.isArray(buildScope?.reasons) ? buildScope.reasons.filter(isNonEmptyString).map((reason) => reason.trim()) : [];
  const base = 'Declared out of source scope by CampaignSpec build_scope (mode "partial"); the page assembles from the selected template family.';
  return reasons.length ? `${base} Reasons: ${reasons.join(" ")}` : base;
}

// A declared out-of-scope page is template stock: the family's own page is
// the design, so the decision carries `template_stock: true` and the family
// the page assembles from. The Design Source Package reads the same marker
// (through prepare-build's templateStockPageIds) so intake never asks for a
// design source the page cannot have, and the build stage materialises the
// page from that family's stock page.
function declaredScopeSkip(page, { skipEntry = null, buildScope = null, manifestPath = null, templateFamily = null }) {
  // Mirror the validator's contract (skip_reason is a non-empty string) rather
  // than assuming it: a malformed entry falls back to the build_scope text
  // instead of throwing mid-intake.
  const skipReason = optionalString(skipEntry?.skip_reason) || buildScopeSkipReason(buildScope);
  const family = optionalString(templateFamily);
  const familyLabel = family ? `the locked ${family} family` : "the selected template family";
  return {
    mapping: { page_id: page.id, skip_reason: skipReason },
    declaredSkip: {
      page_id: page.id,
      skip_reason: skipReason,
      declared_by: skipEntry ? "source_html_manifest" : "campaign_spec_build_scope",
    },
    decision: {
      id: `dec_page_scope_${page.id}`,
      stage: "prepare_build",
      decision_type: "deterministic_derivation",
      decision: `recorded CampaignSpec page "${page.id}" as template stock, declared out of source scope (${skipEntry ? "explicit source-html manifest skip entry" : 'CampaignSpec build_scope mode "partial"'}); keep the route unbuilt unless the operator opts in to materialising it from ${familyLabel}'s stock page; intake demands no design source for it`,
      confidence: "high",
      template_stock: true,
      template_family: family,
      evidence: [
        skipEntry
          ? `source-html manifest entry for "${page.id}" at ${manifestPath} declares skip_reason without a path`
          : `CampaignSpec build_scope.mode is "partial" and page "${page.id}" has no bound source HTML and no design_source`,
      ],
    },
  };
}

export function publicRouteForPage(page) {
  if (isNonEmptyString(page?.page_url)) return pageRouteForPageKit(page.page_url);
  if (isNonEmptyString(page?.url)) return pageRouteForPageKit(page.url);
  if (page?.is_entry) return "";
  return defaultRouteForSpecType(page?.type);
}

function pageRouteForPageKit(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!isAbsoluteHttpUrl(raw)) return normalizePageKitRoute(raw);
  try {
    const url = new URL(raw);
    return normalizePageKitRoute(url.pathname);
  } catch {
    return normalizePageKitRoute(raw);
  }
}

// The SDK meta tags whose content is a route. Doctor checks the same three.
export const SDK_ROUTING_META_TAGS = [
  "next-success-url",
  "next-upsell-accept-url",
  "next-upsell-decline-url",
];

export const HOST_STRIPPED_CODE = "routing_meta.host_stripped";

// A route value that carries a host in front of its path (#531): an older
// saved Map stored `shop.example.com/route/upsell/` where the route is
// `/route/upsell/`, and every stage that roots a route then nested the host
// inside the campaign path. Returns `{ host, from, to }` — `to` is the rooted
// path with any query and fragment kept — or null when the value is not
// host-prefixed.
//
// Read as host-prefixed:
//   - `http://` or `https://` URLs (any host);
//   - protocol-relative `//<host>/...`;
//   - bare `<host>/...`, where the first segment is followed by "/" and is
//     `localhost`, a valid IPv4 address (each octet 0-255), any name with a
//     `:port`, or a dotted name whose last label is 2-63 letters and not a
//     page or script extension (ROUTE_FILE_EXTENSION: `html`, `htm`,
//     `shtml`, `php`, `asp`, `aspx`, `jsp`, `cgi`; not `pl`, which is also
//     Poland's country-code domain), such as
//     `shop.example.com`. `//<host>/...` takes the same hosts.
// Everything else is a route and is left to the existing route checks: a
// rooted `/...` value, a first segment with no dot (`route/x/`), a dotted
// segment whose last label is not all letters (`v1.2/offer/`), a dotted
// quad with an octet over 255 (`300.1.2.3/offer/`), a page or script
// filename (`checkout.html`, `index.php/checkout/`), and a bare host with no
// path after it.
// `keepAbsolute: true` leaves an absolute http(s) URL alone: it is a valid
// SDK routing meta target, and projection already converts an absolute
// page_url to its path, so doctor accepts both; only the bare and
// protocol-relative forms count.
export function parseHostPrefixedRoute(value, { keepAbsolute = false } = {}) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || (raw.startsWith("/") && !raw.startsWith("//"))) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (scheme) {
    if (keepAbsolute || !/^https?$/i.test(scheme[1])) return null;
    return splitHostPrefix(value, raw.slice(scheme[0].length), { requireHostShape: false });
  }
  if (raw.startsWith("//")) return splitHostPrefix(value, raw.slice(2), { requireHostShape: true });
  return splitHostPrefix(value, raw, { requireHostShape: true, requirePath: true });
}

function splitHostPrefix(from, rest, { requireHostShape, requirePath = false }) {
  const end = rest.search(/[/?#]/);
  const host = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? "" : rest.slice(end);
  if (!host || /\s/.test(host)) return null;
  if (requirePath && !tail.startsWith("/")) return null;
  if (requireHostShape && !looksLikeHost(host)) return null;
  return { host, from, to: tail.startsWith("/") ? tail : `/${tail}` };
}

// A dotted first segment ending in one of these is a page or script filename
// (`index.php/checkout/`), not a host.
const ROUTE_FILE_EXTENSION = /^(?:html?|shtml|php|aspx?|jsp|cgi)$/i;

function looksLikeHost(segment) {
  if (/^localhost(?::\d+)?$/i.test(segment)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(segment) && segment.split(".").every((octet) => Number(octet) <= 255)) return true;
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*:\d+$/.test(segment)) return true;
  const labels = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(segment)
    ? segment.split(".")
    : null;
  if (!labels) return false;
  const last = labels[labels.length - 1];
  return /^[A-Za-z]{2,63}$/.test(last) && !ROUTE_FILE_EXTENSION.test(last);
}

// Intake normalisation (#531): every host-prefixed page_url, and every
// host-prefixed SDK routing meta tag value, in funnels[].pages[] and the
// funnel_pages[] mirror, reduced to its rooted path before anything reads the
// spec. Returns the spec unchanged (the same object) with no evidence when
// nothing carries a host; otherwise a copy and one evidence record per changed
// value, `{ code, page_id, field, from, to }`, where `from` is the value
// exactly as the Map or file held it.
export function stripHostPrefixedRoutes(spec) {
  const evidence = [];
  if (!spec || typeof spec !== "object") return { spec, evidence };
  const copy = JSON.parse(JSON.stringify(spec));
  const lists = [];
  if (Array.isArray(copy.funnels)) {
    copy.funnels.forEach((funnel, funnelIndex) => {
      if (Array.isArray(funnel?.pages)) lists.push([`funnels[${funnelIndex}].pages`, funnel.pages]);
    });
  }
  if (Array.isArray(copy.funnel_pages)) lists.push(["funnel_pages", copy.funnel_pages]);
  for (const [label, pages] of lists) {
    pages.forEach((page, pageIndex) => {
      if (!page || typeof page !== "object") return;
      const at = `${label}[${pageIndex}]`;
      const pageId = typeof page.id === "string" ? page.id : null;
      const stripped = parseHostPrefixedRoute(page.page_url);
      if (stripped) {
        page.page_url = stripped.to;
        evidence.push({ code: HOST_STRIPPED_CODE, page_id: pageId, field: `${at}.page_url`, from: stripped.from, to: stripped.to });
      }
      const metaTags = page.sdk_hints?.meta_tags;
      if (!metaTags || typeof metaTags !== "object" || Array.isArray(metaTags)) return;
      for (const tag of SDK_ROUTING_META_TAGS) {
        const meta = parseHostPrefixedRoute(metaTags[tag], { keepAbsolute: true });
        if (!meta) continue;
        metaTags[tag] = meta.to;
        evidence.push({ code: HOST_STRIPPED_CODE, page_id: pageId, field: `${at}.sdk_hints.meta_tags.${tag}`, from: meta.from, to: meta.to });
      }
    });
  }
  return evidence.length ? { spec: copy, evidence } : { spec, evidence };
}

function applyManifestToPages(specPages, manifest, manifestPath, { buildScope = null, templateFamily = null } = {}) {
  const mappings = [];
  const prompts = [];
  const decisions = [];
  const declaredSkips = [];
  const manifestPages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const byPageId = new Map();
  for (const entry of manifestPages) {
    if (!entry || !isNonEmptyString(entry.page_id)) continue;
    if (byPageId.has(entry.page_id)) {
      const firstEntry = byPageId.get(entry.page_id);
      prompts.push({
        code: "MANIFEST_DUPLICATE_PAGE",
        stage: "prepare_build",
        message: `Source-html manifest has more than one entry for page_id "${entry.page_id}" (first path "${firstEntry.path || ""}", duplicate path "${entry.path || ""}"). Only the first entry is used. Deduplicate the manifest before build.`,
        page_id: entry.page_id,
      });
      continue;
    }
    byPageId.set(entry.page_id, entry);
  }

  const byPageUrl = new Map();
  const typeBuckets = new Map();
  for (const entry of manifestPages) {
    if (!entry || !isNonEmptyString(entry.path)) continue;
    const url = optionalString(entry.page_url);
    if (url !== null) {
      const norm = pageRouteForPageKit(url);
      const firstEntry = byPageUrl.get(norm);
      if (firstEntry) {
        prompts.push({
          code: "MANIFEST_DUPLICATE_PAGE_URL",
          stage: "prepare_build",
          message: `Source-html manifest has more than one entry for page_url "${url}" (first path "${firstEntry.path || ""}", duplicate path "${entry.path || ""}"). Only the first entry is used for page_url matching. Deduplicate page_url values before build.`,
          page_url: norm,
        });
      } else {
        byPageUrl.set(norm, entry);
      }
    }
    const t = optionalString(entry.page_type);
    if (t) {
      if (!typeBuckets.has(t)) typeBuckets.set(t, []);
      typeBuckets.get(t).push(entry);
    }
  }

  const typeOrdinals = new Map();
  const typeSeen = new Map();
  for (const page of specPages) {
    const t = page.type || "page";
    const n = (typeSeen.get(t) || 0) + 1;
    typeSeen.set(t, n);
    typeOrdinals.set(page.id, n);
  }
  const usedEntries = new Set();
  const matchedIds = new Set();

  for (const page of specPages) {
    let entry = byPageId.get(page.id);
    let matchVia = "page_id";
    if (!(entry && isNonEmptyString(entry.path))) {
      const norm = pageRouteForPageKit(optionalString(page.page_url) || optionalString(page.url) || "");
      const urlEntry = byPageUrl.get(norm);
      if (urlEntry && isNonEmptyString(urlEntry.path) && !usedEntries.has(urlEntry)) {
        entry = urlEntry;
        matchVia = "page_url";
      } else {
        const bucket = typeBuckets.get(page.type) || [];
        const ordinal = typeOrdinals.get(page.id) || 1;
        const typeEntry = bucket[ordinal - 1];
        if (typeEntry && isNonEmptyString(typeEntry.path) && !usedEntries.has(typeEntry)) {
          entry = typeEntry;
          matchVia = "page_type+ordinal";
        }
      }
    }
    if (entry && isNonEmptyString(entry.path)) {
      usedEntries.add(entry);
      const mapping = { page_id: page.id, path: entry.path };
      if (isNonEmptyString(entry.page_type)) mapping.page_type = entry.page_type;
      addSpecHints(mapping, page);
      const sourceHash = optionalString(entry.source_hash);
      if (sourceHash) mapping.source_hash = sourceHash;
      mappings.push(mapping);
      matchedIds.add(page.id);
      decisions.push({
        id: `dec_page_map_${page.id}`,
        stage: "prepare_build",
        decision_type: "deterministic_derivation",
        decision: `mapped CampaignSpec page "${page.id}" to source file "${entry.path}" via source-html manifest (matched by ${matchVia})`,
        confidence: matchVia === "page_id" ? "high" : "medium",
        evidence: [`source-html manifest entry matched page "${page.id}" by ${matchVia}; path="${entry.path}" from ${manifestPath}`],
      });
    } else {
      const skipEntry = entry && !isNonEmptyString(entry.path) && isNonEmptyString(entry.skip_reason) ? entry : null;
      if (skipEntry || (declaredPartialScope(buildScope) && !isObject(page.design_source))) {
        const declared = declaredScopeSkip(page, { skipEntry, buildScope, manifestPath, templateFamily });
        if (skipEntry) usedEntries.add(skipEntry);
        matchedIds.add(page.id);
        mappings.push(declared.mapping);
        declaredSkips.push(declared.declaredSkip);
        decisions.push(declared.decision);
        continue;
      }
      mappings.push({
        page_id: page.id,
        skip_reason: `No entry for "${page.id}" in source-html manifest at ${manifestPath}; add this page_id to the manifest (with a path, or a skip_reason to declare it out of source scope), set CampaignSpec build_scope.mode to "partial" for template-derived pages, or remove the manifest to fall back to filesystem matching.`,
      });
      prompts.push({
        code: "MISSING_SOURCE_PAGE",
        stage: "prepare_build",
        message: `Active CampaignSpec page "${page.id}" has no matching HTML file (source-html manifest did not list it).`,
        page_id: page.id,
      });
    }
  }

  for (const entry of manifestPages) {
    if (!entry || !isNonEmptyString(entry.page_id)) continue;
    if (matchedIds.has(entry.page_id)) continue;
    if (specPages.some((page) => page.id === entry.page_id)) continue;
    if (usedEntries.has(entry)) continue;
    prompts.push({
      code: "MANIFEST_EXTRA_PAGE",
      stage: "prepare_build",
      message: `Source-html manifest lists page_id "${entry.page_id}" (path "${entry.path || ""}") which is not an active CampaignSpec page. Reconcile the manifest or the spec before build.`,
      page_id: entry.page_id,
    });
  }

  return { mappings, prompts, decisions, declaredSkips };
}

function matchSourcePages(specPages, htmlFiles, { buildScope = null, templateFamily = null } = {}) {
  const usedByPageId = new Map();
  const mappings = [];
  const prompts = [];
  const decisions = [];
  const declaredSkips = [];
  const ambiguousCandidates = [];
  const counts = new Map();
  const ordinals = new Map();

  for (const page of specPages) {
    const key = page.type || "page";
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    ordinals.set(page.id, next);
  }

  for (const page of specPages) {
    const keys = pageMatchKeys(page, ordinals.get(page.id));
    const candidates = htmlFiles
      .map((file) => ({
        ...file,
        matched_keys: keys.filter((key) => key && key === slugify(file.basename)),
      }))
      .filter((file) => file.matched_keys.length > 0);
    const unused = candidates.filter((file) => !usedByPageId.has(file.path));
    const match = unused.length === 1 ? unused[0] : null;
    if (unused.length > 1) {
      const candidateEntries = candidateEntriesForPrompt(unused);
      ambiguousCandidates.push({
        page_id: page.id,
        page_type: page.type || null,
        match_keys: keys,
        candidates: candidateEntries,
      });
      mappings.push({
        page_id: page.id,
        skip_reason: `Ambiguous source HTML candidates found: ${candidateEntries.map((candidate) => candidate.path).join(", ")}. Add .campaigns-os/source-html-manifest.json to bind this page explicitly before build.`,
      });
      prompts.push({
        code: "AMBIGUOUS_SOURCE_PAGE",
        stage: "prepare_build",
        message: `Active CampaignSpec page "${page.id}" has multiple matching HTML files. Add a source-html manifest entry for this page before build.`,
        page_id: page.id,
        detail: {
          match_keys: keys,
          candidates: candidateEntries,
          manifest_entry: manifestEntryDraft(page, candidateEntries[0]?.path || ""),
        },
      });
    } else if (match) {
      usedByPageId.set(match.path, page.id);
      const mapping = { page_id: page.id, path: match.path };
      addSpecHints(mapping, page);
      mappings.push(mapping);
      decisions.push({
        id: `dec_page_map_${page.id}`,
        stage: "prepare_build",
        decision_type: "deterministic_derivation",
        decision: `mapped CampaignSpec page "${page.id}" to source file "${match.path}"`,
        confidence: candidates.length === 1 ? "high" : "medium",
        evidence: [`matched source filename against page keys: ${keys.join(", ")}`],
      });
    } else if (candidates.length > 0) {
      const candidateEntries = candidateEntriesForPrompt(candidates, usedByPageId);
      ambiguousCandidates.push({
        page_id: page.id,
        page_type: page.type || null,
        match_keys: keys,
        candidates: candidateEntries,
      });
      mappings.push({
        page_id: page.id,
        skip_reason: `Matching source HTML candidates were already assigned to other pages: ${candidateEntries.map((candidate) => `${candidate.path}${candidate.used_by_page_id ? ` used by ${candidate.used_by_page_id}` : ""}`).join(", ")}. Add .campaigns-os/source-html-manifest.json to bind this page explicitly before build.`,
      });
      prompts.push({
        code: "AMBIGUOUS_SOURCE_PAGE",
        stage: "prepare_build",
        message: `Active CampaignSpec page "${page.id}" only matched HTML files already assigned to another page. Add a source-html manifest entry for this page before build.`,
        page_id: page.id,
        detail: {
          match_keys: keys,
          candidates: candidateEntries,
          manifest_entry: { ...manifestEntryDraft(page, ""), path_conflicts: true },
        },
      });
    } else {
      const hasDesignSource = isObject(page.design_source);
      if (declaredPartialScope(buildScope) && !hasDesignSource) {
        const declared = declaredScopeSkip(page, { buildScope, templateFamily });
        mappings.push(declared.mapping);
        declaredSkips.push(declared.declaredSkip);
        decisions.push(declared.decision);
        continue;
      }
      if (!hasDesignSource) {
        mappings.push({ page_id: page.id, skip_reason: "No matching source HTML file found; provide a source file or an explicit skip reason before build." });
      }
      prompts.push({
        code: "MISSING_SOURCE_PAGE",
        stage: "prepare_build",
        message: `Active CampaignSpec page "${page.id}" has no matching HTML file.`,
        page_id: page.id,
        detail: {
          match_keys: keys,
          manifest_entry: manifestEntryDraft(page, ""),
        },
      });
    }
  }

  return {
    mappings,
    prompts,
    decisions,
    declaredSkips,
    ambiguousCandidates,
    manifestDraft: ambiguousCandidates.length > 0
      ? createManifestDraft(specPages, mappings, ambiguousCandidates)
      : null,
  };
}

function candidateEntriesForPrompt(candidates, usedByPageId = null) {
  return candidates.map((candidate) => ({
    path: candidate.path,
    bytes: candidate.bytes ?? null,
    sha256: candidate.sha256 || null,
    matched_keys: candidate.matched_keys || [],
    ...(usedByPageId?.has(candidate.path) ? { used_by_page_id: usedByPageId.get(candidate.path) } : {}),
  }));
}

function manifestEntryDraft(page, path) {
  const entry = {
    page_id: page.id,
    path,
  };
  if (isNonEmptyString(page.type)) entry.page_type = page.type;
  const pageUrl = optionalString(page.page_url) || optionalString(page.url);
  if (pageUrl) entry.page_url = pageUrl;
  return entry;
}

function createManifestDraft(specPages, mappings, ambiguousCandidates) {
  const mappingByPageId = new Map(mappings.map((mapping) => [mapping.page_id, mapping]));
  const ambiguousByPageId = new Map(ambiguousCandidates.map((entry) => [entry.page_id, entry]));
  return {
    schema_version: "source-html-manifest/v0",
    generator: "campaigns-os@prepare-build-draft",
    pages: specPages
      .map((page) => {
        const mapping = mappingByPageId.get(page.id);
        const ambiguous = ambiguousByPageId.get(page.id);
        const path = mapping?.path || ambiguous?.candidates?.[0]?.path || "";
        return path ? manifestEntryDraft(page, path) : null;
      })
      .filter(Boolean),
  };
}

function addSpecHints(mapping, page) {
  const upsellPattern = optionalString(page.upsell_template_pattern);
  if (upsellPattern) mapping.upsell_template_pattern = upsellPattern;
  const mvTiers = normalizedMvTiers(page.upsell_mv_tiers);
  if (mvTiers) mapping.upsell_mv_tiers = mvTiers;
  const variantLabels = normalizedVariantLabels(page.variant_labels);
  if (variantLabels) mapping.variant_labels = variantLabels;
}

function pageKitProjectionForPage(page, { pageById, publicRouteSlug, outputDir, specPages = [] }) {
  const specRoute = publicRouteForPage(page);
  const relativeRoute = stripPublicRoutePrefix(specRoute, publicRouteSlug);
  const publicRoute = rootedCampaignRoute(relativeRoute, publicRouteSlug);
  const targetPath = targetPagePathForRoute(relativeRoute, page);
  const defaultRoute = defaultPublicRouteForTargetPath(targetPath, publicRouteSlug);
  const permalinkRequired = normalizeRootedRoute(publicRoute) !== normalizeRootedRoute(defaultRoute);
  const pageType = cpkPageTypeForSpecType(page.type);
  const frontmatter = { page_type: pageType };
  if (permalinkRequired) frontmatter.permalink = publicRoute;

  const nextUrl = nextUrlForPage(page, pageById, publicRouteSlug);
  if (nextUrl) frontmatter.next_url = nextUrl;
  const declineUrl = declineUrlForPage(page, pageById, publicRouteSlug);
  if (declineUrl && declineUrl !== nextUrl) frontmatter.decline_url = declineUrl;
  Object.assign(frontmatter, checkoutFlowFrontmatter(page, { specPages, pageById, publicRouteSlug }));

  return {
    target_path: targetPath,
    output_path: join(outputDir, targetPath),
    public_route: publicRoute,
    spec_route: relativeRoute,
    page_type: pageType,
    permalink_required: permalinkRequired,
    frontmatter,
  };
}

// Multi-step checkout wiring (campaigns-os#641), for any page that leads into a
// Checkout without being it: a select page, a checkout_step, or a landing page
// whose forward links reach a Checkout.
//   success_url  the Checkout's post-payment destination (its own next_url).
//                The page's next-success-url meta tag carries it, because the
//                SDK reads that tag for express orders placed on this page; an
//                express order on step 1 must land on the first upsell, not on
//                step 2. Forward navigation never uses that tag: a step form
//                navigates by data-next-checkout-step, a select page by a link.
//   step_number  on a checkout_step only: its position among the steps of its
//                path, from 1, for the form's data-next-step-number.
function checkoutFlowFrontmatter(page, { specPages, pageById, publicRouteSlug }) {
  if (!page || page.type === "checkout") return {};
  const path = checkoutPathFrom(specPages, page);
  if (!path || path.length < 2) return {};
  const out = {};
  const successUrl = nextUrlForPage(path[path.length - 1], pageById, publicRouteSlug);
  if (successUrl) out.success_url = successUrl;
  if (isCheckoutStepPage(page)) out.step_number = checkoutStepNumber(page, specPages);
  return out;
}

function checkoutStepNumber(page, specPages) {
  let number = 1;
  const seen = new Set([page]);
  let current = page;
  for (;;) {
    const previous = specPages.find((candidate) => !seen.has(candidate)
      && isCheckoutStepPage(candidate)
      && forwardTargetPage(specPages, candidate) === current);
    if (!previous) return number;
    number += 1;
    seen.add(previous);
    current = previous;
  }
}

function pageKitTargetPrompts(mappings) {
  const prompts = [];
  const byOutputPath = new Map();
  for (const mapping of mappings) {
    const outputPath = mapping.page_kit?.output_path;
    if (!outputPath) continue;
    const existing = byOutputPath.get(outputPath);
    if (existing) {
      prompts.push({
        code: "PAGE_KIT_TARGET_CONFLICT",
        stage: "prepare_build",
        message: `CampaignSpec pages "${existing.page_id}" and "${mapping.page_id}" both project to Page Kit target "${outputPath}". Give one page a distinct route before build.`,
        page_id: mapping.page_id,
        detail: {
          output_path: outputPath,
          existing_page_id: existing.page_id,
          conflicting_page_id: mapping.page_id,
        },
      });
    } else {
      byOutputPath.set(outputPath, mapping);
    }
  }
  return prompts;
}

function targetPagePathForRoute(relativeRoute, page) {
  const route = normalizePageKitRoute(relativeRoute || defaultRouteForSpecType(page.type));
  const segments = route.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.length === 0) return "index.html";
  return `${segments[segments.length - 1]}.html`;
}

function defaultPublicRouteForTargetPath(targetPath, publicRouteSlug) {
  const filename = basename(targetPath, extname(targetPath));
  if (filename === "index") return `/${normalizePublicRouteSlug(publicRouteSlug)}/`;
  return `/${normalizePublicRouteSlug(publicRouteSlug)}/${filename}/`;
}

// Forward and decline links come from campaign-spec/routing.ts, the single
// source of truth every consumer shares — see that module for why the forward
// link is a first-match precedence while cycle detection takes the full edge
// set. This used to be a page-type switch that silently discarded any edge
// declared outside its table: twelve checkout-typed pages across ten
// certified fixtures route through next_page, and every one of them built with
// no next_url at all.
function nextUrlForPage(page, pageById, publicRouteSlug) {
  return pageKitFlowUrl(forwardRouteTarget(page), pageById, publicRouteSlug);
}

function declineUrlForPage(page, pageById, publicRouteSlug) {
  return pageKitFlowUrl(declineRouteTarget(page), pageById, publicRouteSlug);
}

function pageKitFlowUrl(value, pageById, publicRouteSlug) {
  if (!isNonEmptyString(value)) return null;
  const raw = value.trim();
  if (raw.startsWith("#") || isAbsoluteHttpUrl(raw)) return raw;
  const referencedPage = pageById.get(raw);
  const route = referencedPage ? publicRouteForPage(referencedPage) : raw;
  return rootedCampaignRoute(stripPublicRoutePrefix(route, publicRouteSlug), publicRouteSlug);
}

function rootedCampaignRoute(route, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const relativeRoute = stripPublicRoutePrefix(route, slug);
  return relativeRoute ? `/${slug}/${relativeRoute}` : `/${slug}/`;
}

function normalizeRootedRoute(value) {
  const normalized = normalizePageKitRoute(value);
  return normalized ? `/${normalized}` : "/";
}

function cpkPageTypeForSpecType(type) {
  if (type === "presell" || type === "landing") return "product";
  if (type === "thankyou" || type === "receipt") return "receipt";
  if (type === "upsell" || type === "downsell") return "upsell";
  // select, checkout_step and checkout all render the SDK checkout surface
  // (campaigns-os#641); only the Checkout places the order.
  if (type === "checkout" || type === "checkout_step" || type === "select") return "checkout";
  return CPK_PAGE_TYPES.has(type) ? type : "product";
}

function defaultRouteForSpecType(type) {
  if (type === "thankyou" || type === "receipt") return "receipt/";
  if (type === "checkout_step") return "checkout-step/";
  if (["presell", "landing", "checkout", "upsell", "downsell"].includes(type)) return `${type}/`;
  return `${type || "page"}/`;
}

function pageMatchKeys(page, ordinal) {
  const keys = new Set([
    slugify(page.id),
    slugify(page.label),
    slugify(page.type),
  ].filter(Boolean));
  const sourceUrl = optionalString(page.page_url) || optionalString(page.url);
  if (sourceUrl) {
    const clean = sourceUrl.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
    if (clean) {
      keys.add(slugify(clean));
      keys.add(slugify(basename(clean, extname(clean))));
    }
  }
  if (ordinal && page.type) keys.add(slugify(`${page.type}-${ordinal}`));
  if (page.type === "thankyou") {
    keys.add("receipt");
    keys.add("thank-you");
    keys.add("thankyou");
  }
  if (page.type === "landing" || page.type === "presell") keys.add("index");
  if (page.type === "checkout") keys.add("checkout");
  if (page.type === "checkout_step") keys.add("checkout-step");
  if (page.type === "upsell") keys.add("upsell");
  if (page.type === "downsell") keys.add("downsell");
  return [...keys];
}

function normalizedMvTiers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { min, max } = value;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max < 1) return null;
  if (min > max) return null;
  return { min, max };
}

function normalizedVariantLabels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const primary = isNonEmptyString(value.primary) ? value.primary.trim() : null;
  if (!primary) return null;
  const out = { primary };
  if (isNonEmptyString(value.secondary)) {
    out.secondary = value.secondary.trim();
  }
  return out;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value, fallback = null) {
  return isNonEmptyString(value) ? value.trim() : fallback;
}
