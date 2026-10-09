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

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

import { isFileReadFailure } from "./cart-placeholders.mjs";

const HTML_EXT = ".html";

// The route tokens inferPageType reads for the funnel roles, exported so a
// caller can tell which token produced a guess (#529: an explicit "upsell"
// word is a stronger signal than "oto"). Tested against the lower-cased,
// trimmed route.
export const ROUTE_TOKENS = Object.freeze({
  downsell: /down[\s_/-]*sell/,
  upsell: /up[\s_/-]*sell/,
  one_time_offer: /(^|[\s_/-])oto([\s_/-]|\d|$)|one[\s_/-]*time[\s_/-]*offer/,
  receipt: /thank|receipt|confirm(ation)?|order[\s_/-]*complete/,
  checkout: /checkout|\bcart\b|\border\b/,
});

// Funnel page-type inference from a built route or filename. Order matters:
// downsell is tested before upsell, and the broad fallbacks (landing/page) run
// last. Returns one of the page types QA understands; "page" for generic
// content pages with no funnel role.
export function inferPageType(routeOrName) {
  const value = String(routeOrName || "").toLowerCase().trim();
  if (value === "" || value === "/" || value === "index") return "landing";
  if (ROUTE_TOKENS.downsell.test(value)) return "downsell";
  if (ROUTE_TOKENS.upsell.test(value) || ROUTE_TOKENS.one_time_offer.test(value)) return "upsell";
  if (ROUTE_TOKENS.receipt.test(value)) return "receipt";
  if (ROUTE_TOKENS.checkout.test(value)) return "checkout";
  // The two-step bundle-selection step. Deliberately narrow, and anchored on
  // BOTH ends: the route must *be* about choosing a bundle, not merely contain
  // the words. An editorial "/our-choose-bundle-guide/" stays generic rather
  // than being pulled into commerce residue checking. Checkout/cart/order win
  // above, so "select-checkout" stays checkout.
  // Matched against the FINAL route segment, whole: the segment must *be* the
  // selector step, not merely contain the words. "/our-choose-bundle-guide/"
  // and "selected-items" stay generic.
  const lastSegment = value.split("/").filter(Boolean).pop() || value;
  if (/^(?:select|bundle[\s_-]*select|select[\s_-]*bundle|choose[\s_-]*(?:your[\s_-]*)?(?:bundle|package))$/.test(lastSegment)) return "select";
  if (/presell|advertorial|listicle|review/.test(value)) return "presell";
  if (/landing|^home$|index/.test(value)) return "landing";
  return "page";
}

// Whether a symbolic link may stand for a built page: its name ends in .html,
// or its target is a directory, or its target cannot be inspected (missing,
// EACCES, ELOOP, any file-system error). A link to a regular file (or any
// other non-directory) not named .html is no page. Only file-system errors
// are caught; anything else throws.
function linkMayBePage(full, name) {
  if (name.toLowerCase().endsWith(HTML_EXT)) return true;
  try {
    return statSync(full).isDirectory();
  } catch (error) {
    if (!isFileReadFailure(error)) throw error;
    return true;
  }
}

// `links`, when given, collects every symbolic link that may stand for a page
// (see linkMayBePage). They are never pages themselves (build output holds no
// links, and a link is not followed), but a caller that must account for every
// built page can name them.
function listHtmlFiles(root, links = null) {
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
      else if (links && entry.isSymbolicLink() && linkMayBePage(full, entry.name)) links.push(full);
    }
  };
  walk(root);
  links?.sort();
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
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return { siteRoot: candidate, slugDiscovery: true };
  }
  return { siteRoot: targetRepo, slugDiscovery: basename(targetRepo) === "_site" };
}

/**
 * Resolve QA/doctor scope from a built page-kit campaign directory.
 *
 * @param {string} targetRepo Absolute path to the page-kit target repo (or a
 *   `_site/` directory, or a campaign directory).
 * @param {{ slug?: string|null, includeLinkedPages?: boolean }} [options]
 *   `includeLinkedPages` adds `linked_pages`: every symbolic link under the
 *   campaign directory that may stand for a page (named .html, or its target
 *   a directory, or its target not inspectable; each one entry, its
 *   `built_path` the link itself; skipped as pages, not followed), in the
 *   same shape as `pages`. A link to a regular file not named .html is
 *   dropped. Off by default; without it the result is unchanged.
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
export function resolveBuiltSiteScope(targetRepo, { slug = null, includeLinkedPages = false } = {}) {
  const base = { ok: false, target_repo: targetRepo, site_root: null, slug: "", campaign_dir: null, pages: [], html_count: 0 };
  if (!targetRepo || !existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    return { ...base, error: `Built campaign directory does not exist: ${targetRepo}` };
  }
  const { siteRoot, slugDiscovery } = resolveSiteRoot(targetRepo);

  // Slug discovery: prefer an explicit slug; otherwise the campaign is either a
  // single subdirectory under `_site/` or rendered at the site root.
  let resolvedSlug = typeof slug === "string" && slug.trim() ? slug.trim() : null;
  if (!resolvedSlug) {
    if (!slugDiscovery) {
      resolvedSlug = "";
    } else {
      const entries = readdirSync(siteRoot, { withFileTypes: true });
      const subdirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .map((entry) => entry.name)
        .filter((name) => listHtmlFiles(join(siteRoot, name)).length > 0);
      const rootHtml = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith(HTML_EXT));
      if (subdirs.length === 1 && !rootHtml) {
        resolvedSlug = subdirs[0];
      } else if (rootHtml || subdirs.length === 0) {
        resolvedSlug = "";
      } else {
        return { ...base, site_root: siteRoot, error: `Multiple campaign slugs under ${siteRoot}; pass --slug to choose one.`, slug_candidates: subdirs };
      }
    }
  }

  const campaignDir = resolvedSlug ? join(siteRoot, resolvedSlug) : siteRoot;
  if (!existsSync(campaignDir) || !statSync(campaignDir).isDirectory()) {
    return { ...base, site_root: siteRoot, slug: resolvedSlug, error: `Campaign directory does not exist: ${campaignDir}` };
  }

  const toPage = (file) => {
    const route = routeForFile(campaignDir, file);
    return {
      page_id: pageIdForRoute(route),
      page_type: inferPageType(route),
      route,
      built_path: file,
    };
  };
  const links = includeLinkedPages ? [] : null;
  const pages = listHtmlFiles(campaignDir, links).map(toPage);
  const linked = links ? { linked_pages: links.map(toPage) } : {};

  if (!pages.length) {
    return { ...base, site_root: siteRoot, slug: resolvedSlug, campaign_dir: campaignDir, ...linked, error: `No built HTML pages found under ${campaignDir}.` };
  }

  return {
    ok: true,
    target_repo: targetRepo,
    site_root: siteRoot,
    slug: resolvedSlug,
    campaign_dir: campaignDir,
    pages,
    html_count: pages.length,
    ...linked,
  };
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

// Build QA topologies (the spec-shaped { topology_id, pages: [{page_id,
// page_type, url}] } structure runQa walks) from a built-site scope plus a
// served base URL. base URL points at the campaign root the pages are served
// under; a page's route is appended to form its URL. A base URL is required —
// the whole point of a topology is fetchable page URLs, so fail fast rather
// than hand a direct caller (tests, future tools) a topology with null URLs.
export function topologiesFromBuiltSiteScope(scope, baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  if (!base) {
    throw new Error("topologiesFromBuiltSiteScope requires a non-empty base URL so built pages have fetchable URLs.");
  }
  const pages = (scope?.pages || []).map((page) => ({
    page_id: page.page_id,
    page_type: page.page_type,
    url: page.route ? `${base}/${page.route}/` : `${base}/`,
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
    qa: {},
    pages: (scope?.pages || []).map((page) => ({ page_id: page.page_id, type: page.page_type, route: page.route })),
  };
}

// Build output fingerprint. `stages.assembly.build_fingerprint` is the value
// every later stage (polish capture, the polish gate, QA) binds its evidence
// to, so it must change exactly when the built output changes — and only
// then. It therefore hashes the OUTPUT, never the inputs: a toolkit or
// template upgrade that renders different bytes from identical source is a
// different build, and a rebuild from identical source on another machine is
// the same build. The manifest is `<path>\n<sha256>\n` per file, paths
// relative to the output root with `/` separators and sorted by code point,
// so directory walk order and the absolute location never leak into the
// value. Page Kit (0.2.0) writes only rendered HTML and copied assets into
// _site/, nothing it timestamps, so nothing is excluded by default; `exclude`
// takes root-relative paths for a consumer whose build does stamp a file.
// Symbolic links are never build output and are skipped, not followed.
export const BUILD_FINGERPRINT_ALGORITHM = "sha256-manifest/v1";

function listFilesRelative(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks are not build output: page-kit writes files and copies
      // assets, never links. A link is skipped rather than followed, so a
      // link into the source tree (or a loop) can neither leak input bytes
      // into the value nor hang the walk.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Fingerprint a built output tree. Returns
 *   { ok, algorithm, root, fingerprint, file_count, excluded, manifest, error }
 * where `fingerprint` is `sha256:<hex>` over the canonical manifest and
 * `manifest` is that manifest text, so an operator can recompute the value by
 * hand (`sha256sum` over each file, sort by path, hash the lines). `ok: false`
 * with `error` when the root is not a directory; an empty tree still hashes
 * (the empty manifest) so a wiped _site/ reads as a changed build, not a
 * missing one.
 */
export function computeBuildFingerprint(outputDir, { exclude = [] } = {}) {
  const root = String(outputDir || "");
  const base = { ok: false, algorithm: BUILD_FINGERPRINT_ALGORITHM, root, fingerprint: null, file_count: 0, excluded: [], manifest: null };
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    return { ...base, error: `Build output directory does not exist: ${root || "(empty)"}` };
  }
  const excludeSet = new Set((Array.isArray(exclude) ? exclude : []).map((path) => String(path).split(sep).join("/")));
  const excluded = [];
  const lines = [];
  for (const path of listFilesRelative(root)) {
    if (excludeSet.has(path)) {
      excluded.push(path);
      continue;
    }
    lines.push(`${path}\n${sha256Hex(readFileSync(join(root, path)))}\n`);
  }
  const manifest = lines.join("");
  return {
    ...base,
    ok: true,
    fingerprint: `sha256:${sha256Hex(Buffer.from(manifest, "utf8"))}`,
    file_count: lines.length,
    excluded,
    manifest,
    error: null,
  };
}

// The manifest as `{ path, sha256 }` entries, the shape `record build` keeps
// on stages.assembly.build_manifest beside build_fingerprint so a later
// mismatch can name the files that differ instead of only two hashes.
export function buildManifestEntries(fingerprint) {
  const lines = String(fingerprint?.manifest || "").split("\n");
  const entries = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    if (lines[index]) entries.push({ path: lines[index], sha256: lines[index + 1] });
  }
  return entries;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

// The recorded manifest, only when it is evidence about the recorded build:
// well-formed entries whose canonical manifest hashes to the recorded
// fingerprint. A record made before build kept a manifest, or one rewritten
// by hand, reads as unavailable (null) rather than as a misleading diff.
export function recordedBuildManifest(assembly) {
  const entries = assembly?.build_manifest;
  const recorded = assembly?.build_fingerprint;
  if (!Array.isArray(entries) || typeof recorded !== "string") return null;
  if (!entries.every((entry) => typeof entry?.path === "string" && entry.path && typeof entry?.sha256 === "string" && SHA256_HEX.test(entry.sha256))) return null;
  const manifest = entries.map((entry) => `${entry.path}\n${entry.sha256}\n`).join("");
  return `sha256:${sha256Hex(Buffer.from(manifest, "utf8"))}` === recorded ? entries : null;
}

// macOS and iCloud name a sync conflict copy `<name> 2.<ext>` (then ` 3`,
// ...), on files and on folders. A trailing " N" alone is too common in real
// names ("chapter 12.md"), so a path counts as a copy only when the same path
// without the suffix also exists. The flag is a hint, never a verdict.
const CONFLICT_COPY_SEGMENT = /^(.+) (?:[2-9]|[1-9]\d+)(\.[^.]+)?$/;
export function isSyncConflictCopyPath(path, knownPaths) {
  const segments = String(path).split("/");
  const known = [...knownPaths];
  return segments.some((segment, index) => {
    const match = CONFLICT_COPY_SEGMENT.exec(segment);
    if (!match) return false;
    const original = [...segments.slice(0, index), `${match[1]}${match[2] ?? ""}`].join("/");
    return index === segments.length - 1
      ? known.includes(original)
      : known.some((candidate) => candidate.startsWith(`${original}/`));
  });
}

export const BUILD_DRIFT_PATH_LIMIT = 20;

/**
 * Compare the output on disk (a computeBuildFingerprint result) with the
 * manifest stages.assembly recorded. Returns
 *   { manifest: "recorded", extra, missing, changed, conflict_copies, summary }
 * with sorted path lists, or { manifest: "unavailable", summary } when the
 * record carries no usable manifest. `summary` is one sentence for a
 * refusal: each list capped at BUILD_DRIFT_PATH_LIMIT with "+N more".
 */
export function describeBuildOutputDrift(assembly, current) {
  const recorded = recordedBuildManifest(assembly);
  if (!recorded) {
    return {
      manifest: "unavailable",
      summary: "The build record carries no file manifest (it was recorded before record build kept one), so the differing paths cannot be named; re-run record build to record one.",
    };
  }
  const before = new Map(recorded.map((entry) => [entry.path, entry.sha256]));
  const now = new Map(buildManifestEntries(current).map((entry) => [entry.path, entry.sha256]));
  const extra = [...now.keys()].filter((path) => !before.has(path));
  const missing = [...before.keys()].filter((path) => !now.has(path));
  const changed = [...now.keys()].filter((path) => before.has(path) && before.get(path) !== now.get(path));
  const knownPaths = new Set([...before.keys(), ...now.keys()]);
  const isCopy = (path) => isSyncConflictCopyPath(path, knownPaths);
  const conflictCopies = extra.filter(isCopy);
  const list = (label, paths) => {
    if (paths.length === 0) return null;
    const shown = paths.slice(0, BUILD_DRIFT_PATH_LIMIT).map((path) => (isCopy(path) ? `${path} [sync conflict copy]` : path));
    const more = paths.length > BUILD_DRIFT_PATH_LIMIT ? ` (+${paths.length - BUILD_DRIFT_PATH_LIMIT} more)` : "";
    return `${paths.length} ${label}: ${shown.join(", ")}${more}`;
  };
  const parts = [list("extra", extra), list("missing", missing), list("changed", changed)].filter(Boolean);
  const hint = conflictCopies.length
    ? ` ${conflictCopies.length} extra file name(s) look like macOS/iCloud sync conflict copies ("<name> 2.<ext>" beside "<name>.<ext>"); if they are, remove them (or move the repo out of the synced folder) and rebuild.`
    : "";
  return {
    manifest: "recorded",
    extra,
    missing,
    changed,
    conflict_copies: conflictCopies,
    summary: `Against the manifest build recorded: ${parts.length ? parts.join("; ") : "no path differs"}.${hint}`,
  };
}
