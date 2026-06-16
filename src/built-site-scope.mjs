// Non-packet runnability (learnings L7).
//
// A page-kit `campaign-build` campaign produces a built `_site/` but no full
// campaigns-os Build Packet, so doctor/qa historically had nothing to run
// against — only the static contract `check` gate was reachable. This module
// resolves QA scope directly from the built `_site/` (enumerating pages and
// inferring their funnel type) and synthesizes a minimal Build Packet, so the
// existing built-output gates (literal residue, placeholder text, demo-asset
// fidelity, brand contract) can run without a hand-authored packet.
//
// Pure with respect to doctor/qa state: it only reads the filesystem and
// returns plain data. Callers turn that data into doctor issues / QA
// topologies / a packet.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const HTML_EXT = ".html";

// Funnel page-type inference from a built route or filename. Order matters:
// downsell is tested before upsell, and the broad fallbacks (landing/page) run
// last. Returns one of the page types QA understands; "page" for generic
// content pages with no funnel role.
export function inferPageType(routeOrName) {
  const value = String(routeOrName || "").toLowerCase().trim();
  if (value === "" || value === "/" || value === "index") return "landing";
  if (/down[\s_/-]*sell/.test(value)) return "downsell";
  if (/up[\s_/-]*sell|(^|[\s_/-])oto([\s_/-]|\d|$)|one[\s_/-]*time[\s_/-]*offer/.test(value)) return "upsell";
  if (/thank|receipt|confirm(ation)?|order[\s_/-]*complete/.test(value)) return "receipt";
  if (/checkout|\bcart\b|\border\b/.test(value)) return "checkout";
  if (/presell|advertorial|listicle|review/.test(value)) return "presell";
  if (/landing|^home$|index/.test(value)) return "landing";
  return "page";
}

function listHtmlFiles(root) {
  const files = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return files;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip page-kit/Jekyll internals and VCS/deps. Built includes/layouts are
      // template scaffolding, not rendered pages, so they never define scope.
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(HTML_EXT)) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

function routeForFile(campaignDir, file) {
  const rel = relative(campaignDir, file).split(sep).join("/");
  if (rel === "index.html") return "";
  if (rel.endsWith("/index.html")) return rel.slice(0, -"/index.html".length);
  return rel.replace(/\.html$/i, "");
}

function pageIdForRoute(route) {
  if (!route) return "index";
  return route.replace(/\//g, "-").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "index";
}

// Find the built `_site/` for a target repo and the campaign directory within
// it. Accepts a page-kit target repo (contains `_site/`), a `_site/` directory,
// or a campaign directory directly.
function resolveSiteRoot(targetRepo) {
  const candidate = join(targetRepo, "_site");
  if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  return targetRepo;
}

/**
 * Resolve QA/doctor scope from a built page-kit campaign directory.
 *
 * @param {string} targetRepo Absolute path to the page-kit target repo (or a
 *   `_site/` directory, or a campaign directory).
 * @param {{ slug?: string|null }} [options]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   target_repo: string,
 *   site_root: string,
 *   slug: string,
 *   campaign_dir: string,
 *   pages: Array<{ page_id: string, page_type: string, route: string, built_path: string }>,
 *   html_count: number,
 *   slug_candidates?: string[],
 * }}
 */
export function resolveBuiltSiteScope(targetRepo, { slug = null } = {}) {
  const base = { ok: false, target_repo: targetRepo, site_root: null, slug: "", campaign_dir: null, pages: [], html_count: 0 };
  if (!targetRepo || !existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    return { ...base, error: `Built campaign directory does not exist: ${targetRepo}` };
  }
  const siteRoot = resolveSiteRoot(targetRepo);

  // Slug discovery: prefer an explicit slug; otherwise the campaign is either a
  // single subdirectory under `_site/` or rendered at the site root.
  let resolvedSlug = typeof slug === "string" && slug.trim() ? slug.trim() : null;
  if (!resolvedSlug) {
    const subdirs = readdirSync(siteRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .filter((name) => listHtmlFiles(join(siteRoot, name)).length > 0);
    const rootHtml = readdirSync(siteRoot, { withFileTypes: true }).some((e) => e.isFile() && e.name.toLowerCase().endsWith(HTML_EXT));
    if (subdirs.length === 1 && !rootHtml) {
      resolvedSlug = subdirs[0];
    } else if (rootHtml || subdirs.length === 0) {
      resolvedSlug = "";
    } else {
      return { ...base, site_root: siteRoot, error: `Multiple campaign slugs under ${siteRoot}; pass --slug to choose one.`, slug_candidates: subdirs };
    }
  }

  const campaignDir = resolvedSlug ? join(siteRoot, resolvedSlug) : siteRoot;
  if (!existsSync(campaignDir) || !statSync(campaignDir).isDirectory()) {
    return { ...base, site_root: siteRoot, slug: resolvedSlug, error: `Campaign directory does not exist: ${campaignDir}` };
  }

  const pages = listHtmlFiles(campaignDir).map((file) => {
    const route = routeForFile(campaignDir, file);
    return {
      page_id: pageIdForRoute(route),
      page_type: inferPageType(route),
      route,
      built_path: file,
    };
  });

  if (!pages.length) {
    return { ...base, site_root: siteRoot, slug: resolvedSlug, campaign_dir: campaignDir, error: `No built HTML pages found under ${campaignDir}.` };
  }

  return {
    ok: true,
    target_repo: targetRepo,
    site_root: siteRoot,
    slug: resolvedSlug,
    campaign_dir: campaignDir,
    pages,
    html_count: pages.length,
  };
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

// Build QA topologies (the spec-shaped { topology_id, pages: [{page_id,
// page_type, url}] } structure runQa walks) from a built-site scope plus a
// served base URL. base URL points at the campaign root the pages are served
// under; a page's route is appended to form its URL.
export function topologiesFromBuiltSiteScope(scope, baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  const pages = (scope?.pages || []).map((page) => ({
    page_id: page.page_id,
    page_type: page.page_type,
    url: base ? (page.route ? `${base}/${page.route}/` : `${base}/`) : null,
    route: page.route,
  }));
  return [{ topology_id: scope?.slug || "campaign", pages }];
}

/**
 * Synthesize a minimal Build Packet from a built-site scope so the existing
 * packet-driven surfaces can consume a `campaign-build`'d page-kit campaign.
 * Deliberately marked `_synthesized` and missing the source_html/full assembly
 * fields a real packet carries — it is enough to point doctor/qa at the built
 * output and the chosen family, not a substitute for a real build packet.
 */
export function synthesizeMinimalBuildPacket({
  schemaVersion,
  targetRepo,
  scope,
  family = null,
  mapId = null,
  baseUrl = null,
  deployTarget = "unknown",
}) {
  const slug = scope?.slug || "";
  const outputDir = scope?.campaign_dir && targetRepo
    ? relative(targetRepo, scope.campaign_dir).split(sep).join("/") || "."
    : ".";
  return {
    schema_version: schemaVersion,
    _synthesized: {
      from: "built_site",
      note: "Minimal packet auto-emitted from a built _site/. Not a full Build Packet: source_html and assembly provenance are absent.",
      site_root: scope?.site_root || null,
      campaign_dir: scope?.campaign_dir || null,
      html_count: scope?.html_count || 0,
    },
    campaign: {
      public_route_slug: slug || (mapId || "local-campaign"),
      allowed_domains_confirmed: false,
    },
    spec: {
      map_id: mapId || slug || "local-campaign",
    },
    assembly: {
      target_repo: targetRepo,
      output_dir: outputDir,
      template_family: family || "undecided",
    },
    deploy: {
      target: deployTarget || "unknown",
      preview_url: baseUrl || null,
    },
    qa: {
      test_orders_allowed: false,
      sandbox_test_card_confirmed: false,
    },
    pages: (scope?.pages || []).map((page) => ({ page_id: page.page_id, type: page.page_type, route: page.route })),
  };
}
