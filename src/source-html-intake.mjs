import { basename, extname, join, resolve } from "node:path";
import {
  readSourceHtmlManifestFile,
} from "./source-html-manifest.mjs";

const CPK_PAGE_TYPES = new Set(["product", "checkout", "upsell", "receipt"]);

export function createSourceHtmlIntake({
  sourceRoot,
  specPages,
  htmlFiles,
  publicRouteSlug,
  outputDir,
}) {
  const manifestResult = readSourceHtmlManifestFile(sourceRoot);
  const matched = manifestResult.manifest
    ? applyManifestToPages(specPages, manifestResult.manifest, manifestResult.path)
    : matchSourcePages(specPages, htmlFiles);
  const pageById = new Map((specPages || []).map((page) => [page.id, page]));
  const projectionDecisions = [];

  const mappings = matched.mappings.map((mapping) => {
    const specPage = pageById.get(mapping.page_id);
    if (!specPage || !mapping.path) return mapping;
    const pageKit = pageKitProjectionForPage(specPage, { pageById, publicRouteSlug, outputDir });
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
    manifestWarnings: manifestResult.warning ? [manifestResult.warning] : [],
    mappings,
    prompts: [...matched.prompts, ...targetPrompts],
    decisions: [...matched.decisions, ...projectionDecisions],
  };
}

export function normalizePageKitRoute(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isAbsoluteHttpUrl(raw)) return raw;

  const clean = raw
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/?index\.html$/i, "")
    .replace(/\.html$/i, "")
    .replace(/^\/+|\/+$/g, "");

  return clean ? `${clean}/` : "";
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

function applyManifestToPages(specPages, manifest, manifestPath) {
  const mappings = [];
  const prompts = [];
  const decisions = [];
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
      mappings.push({
        page_id: page.id,
        skip_reason: `No entry for "${page.id}" in source-html manifest at ${manifestPath}; add this page_id to the manifest, provide an explicit skip_reason in the packet, or remove the manifest to fall back to filesystem matching.`,
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

  return { mappings, prompts, decisions };
}

function matchSourcePages(specPages, htmlFiles) {
  const used = new Set();
  const mappings = [];
  const prompts = [];
  const decisions = [];
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
    const candidates = htmlFiles.filter((file) => keys.includes(slugify(file.basename)));
    const unused = candidates.filter((file) => !used.has(file.path));
    const match = unused[0] || candidates[0] || null;
    if (match) {
      used.add(match.path);
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
    } else {
      const hasDesignSource = isObject(page.design_source);
      if (!hasDesignSource) {
        mappings.push({ page_id: page.id, skip_reason: "No matching source HTML file found; provide a source file or an explicit skip reason before build." });
      }
      prompts.push({
        code: "MISSING_SOURCE_PAGE",
        stage: "prepare_build",
        message: `Active CampaignSpec page "${page.id}" has no matching HTML file.`,
        page_id: page.id,
      });
    }
  }

  return { mappings, prompts, decisions };
}

function addSpecHints(mapping, page) {
  const upsellPattern = optionalString(page.upsell_template_pattern);
  if (upsellPattern) mapping.upsell_template_pattern = upsellPattern;
  const mvTiers = normalizedMvTiers(page.upsell_mv_tiers);
  if (mvTiers) mapping.upsell_mv_tiers = mvTiers;
  const variantLabels = normalizedVariantLabels(page.variant_labels);
  if (variantLabels) mapping.variant_labels = variantLabels;
}

function pageKitProjectionForPage(page, { pageById, publicRouteSlug, outputDir }) {
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

function nextUrlForPage(page, pageById, publicRouteSlug) {
  if (page.type === "presell" || page.type === "landing") {
    return pageKitFlowUrl(page.next_page, pageById, publicRouteSlug);
  }
  if (page.type === "checkout") {
    return pageKitFlowUrl(page.success_url, pageById, publicRouteSlug);
  }
  if (page.type === "upsell" || page.type === "downsell") {
    return pageKitFlowUrl(page.on_accept, pageById, publicRouteSlug);
  }
  return null;
}

function declineUrlForPage(page, pageById, publicRouteSlug) {
  if (page.type !== "upsell" && page.type !== "downsell") return null;
  return pageKitFlowUrl(page.on_decline, pageById, publicRouteSlug);
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

function stripPublicRoutePrefix(route, publicRouteSlug) {
  const normalized = normalizePageKitRoute(route);
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  if (!normalized || !slug) return normalized;
  const clean = normalized.replace(/^\/+|\/+$/g, "");
  if (clean === slug) return "";
  if (clean.startsWith(`${slug}/`)) return `${clean.slice(slug.length + 1).replace(/\/?$/, "/")}`;
  return normalized;
}

function normalizeRootedRoute(value) {
  const normalized = normalizePageKitRoute(value);
  return normalized ? `/${normalized}` : "/";
}

function cpkPageTypeForSpecType(type) {
  if (type === "presell" || type === "landing") return "product";
  if (type === "thankyou" || type === "receipt") return "receipt";
  if (type === "upsell" || type === "downsell") return "upsell";
  if (type === "checkout" || type === "select") return "checkout";
  return CPK_PAGE_TYPES.has(type) ? type : "product";
}

function defaultRouteForSpecType(type) {
  if (type === "thankyou" || type === "receipt") return "receipt/";
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
  if (page.type === "upsell") keys.add("upsell");
  if (page.type === "downsell") keys.add("downsell");
  return [...keys];
}

function normalizePublicRouteSlug(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
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

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
