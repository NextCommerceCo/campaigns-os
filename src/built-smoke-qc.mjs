// Built-output smoke checks (built_output.smoke_qc).
//
// Advisory observations on every built page, each a QC result and never a
// blocker. A sibling doctor gate, kept out of validateBuiltHtmlStructure
// (which escalates warnings to errors), so every finding stays a warning.
//
// Rules, one result per (page, rule, key); doctor issue code
// built_output.smoke_qc.<reason_code>:
//   anchor:<target>   an in-page link (<a> or <area> href="#x"; SVG <use> is
//                     not a link) whose target no element on the page carries
//                     as id (or <a name>): warning anchor_target_missing, once
//                     every local script the page loads was read; review
//                     anchor_target_in_template or
//                     anchor_target_possibly_script_created; unexercised
//                     script_unreadable when any local script the page loads
//                     was missing, outside _site/, over 1 MiB or past the
//                     16-script cap, whatever the scripts read say. `#`,
//                     `#top` and the empty fragment are valid. The target is
//                     the fragment percent-decoded (UTF-8 bytes, a `%` without
//                     two hex digits kept as is) and only that is matched.
//   favicon:link      no link[rel~=icon] and no apple-touch-icon link:
//                     warning favicon_missing
//   og:title, og:description, og:image
//                     warning og_*_missing when the tag is absent
//   og:image_target   the og:image destination, only when the page has one:
//                     a URL without both a scheme and a host (path-relative,
//                     root-relative or scheme-relative `//host/x`) is
//                     og_image_not_absolute, or og_image_missing_file when it
//                     maps into _site/ and the file is not there (a
//                     scheme-relative URL maps only through a deploy base
//                     host; otherwise its file is never looked for and it
//                     reads `relative_present`); an absolute URL on a deploy
//                     base passes when its file is in _site/ and is
//                     og_image_missing_file otherwise; with no known deploy
//                     base it is unexercised og_image_base_unknown, and on
//                     another host og_image_remote_not_fetched (never fetched)
//   tailwind_cdn:cdn.tailwindcss.com, loopback:loopback
//                     decided only for a recorded production build: warning
//                     tailwind_cdn_in_production / loopback_url, else pass; a
//                     development build reads unexercised development_render
//                     and an unknown one build_environment_unknown, on every
//                     page whatever it contains
//   asset_host:cdn.29next.store
//                     any URL on the primary NEXT asset host, in any
//                     environment: warning primary_asset_host
// The asset-host and loopback rules read every attribute value (data-* and
// <meta content> included) and <style> text, matching absolute URLs by host.
// Text nodes and script bodies are not scanned. The per-page candidate cap
// counts each in-page anchor, each <meta> and <link> (in <template> content
// too), each URL_ATTRIBUTES value whether relative or absolute, any other
// attribute value holding an absolute URL, and each <style> holding one.
//
// Page-level outcomes apply first to every rule key (the bare `anchor` key
// standing for the anchor rule): page_unreadable, page_too_large and
// page_cap_reached read unexercised on each key. A page past the candidate cap
// or with more than 50 anchor results (pass included) is capped: it keeps the
// warning and review results already observed in full (an anchor's target,
// read over every id on the page; the og:image destination; a Tailwind,
// asset-host or loopback URL found) and the first 50 anchor results' findings,
// and reads unexercised/<cap> on every other key. A finding that rests on
// something being absent (favicon, og presence) is never kept, nor is any
// pass. Every result it keeps carries the capped-page member, so none is
// accept-eligible.
//
// Only fragments, the og:image destination (origin and path, or site path),
// element paths, attribute names and counts are kept; no query string, script
// body or page text.
//
// Callers hand in built HTML and, per page, the local scripts it loads
// (`page.scripts`, from collectBuiltPageIdentityInputs in its bounded form,
// which lists them through pageScriptSources: {src, file, content} when read,
// {src, file, unread} when not); a page with no such list reads every local
// script it loads unread. Every URL reference that names a file under _site/
// (the og:image file, each local script) maps through builtFileOf: query and
// fragment dropped, each path segment percent-decoded, then `resolveAsset`;
// a path that names no file (`%ZZ`, bytes that are not UTF-8) is never a
// file. The og:image file is stat-ed here, once per og:image, and counts only
// when its real path (symlinks followed) lies inside `siteRoot`.
// No network request.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parse } from "parse5";

import { CART_PLACEHOLDERS_LIMITS, isFileReadFailure, isPageReadFailure, scriptKind } from "./cart-placeholders.mjs";
import { aggregateQcResults, buildQcResult } from "./qc-results.mjs";
import { isLoopbackHostname } from "./remit.mjs";

export const SMOKE_QC = "built_output.smoke_qc";
export const SMOKE_QC_CHECK = "smoke_qc";

export const PRIMARY_ASSET_HOST = "cdn.29next.store";
export const TAILWIND_CDN_HOST = "cdn.tailwindcss.com";

// Shared doctor bounds, plus the anchor script hint's own.
export const SMOKE_QC_LIMITS = Object.freeze({
  ...CART_PLACEHOLDERS_LIMITS,
  scripts: 16,
  script_bytes: 1024 * 1024,
});

export const SMOKE_QC_REASONS = Object.freeze({
  ANCHOR_TARGET_MISSING: "anchor_target_missing",
  ANCHOR_TARGET_IN_TEMPLATE: "anchor_target_in_template",
  ANCHOR_TARGET_POSSIBLY_SCRIPT_CREATED: "anchor_target_possibly_script_created",
  SCRIPT_UNREADABLE: "script_unreadable",
  FAVICON_MISSING: "favicon_missing",
  OG_TITLE_MISSING: "og_title_missing",
  OG_DESCRIPTION_MISSING: "og_description_missing",
  OG_IMAGE_MISSING: "og_image_missing",
  OG_IMAGE_MISSING_FILE: "og_image_missing_file",
  OG_IMAGE_NOT_ABSOLUTE: "og_image_not_absolute",
  OG_IMAGE_BASE_UNKNOWN: "og_image_base_unknown",
  OG_IMAGE_REMOTE_NOT_FETCHED: "og_image_remote_not_fetched",
  TAILWIND_CDN_IN_PRODUCTION: "tailwind_cdn_in_production",
  PRIMARY_ASSET_HOST: "primary_asset_host",
  LOOPBACK_URL: "loopback_url",
  DEVELOPMENT_RENDER: "development_render",
  BUILD_ENVIRONMENT_UNKNOWN: "build_environment_unknown",
  PAGE_UNREADABLE: "page_unreadable",
  PAGE_TOO_LARGE: "page_too_large",
  PAGE_CAP_REACHED: "page_cap_reached",
  CANDIDATE_CAP_REACHED: "candidate_cap_reached",
  FINDING_CAP_REACHED: "finding_cap_reached",
});
const R = SMOKE_QC_REASONS;

// The result key of every rule but the per-target anchors. `anchor` is the
// anchor rule's own row, used only when its targets are not known (a
// page-level outcome) and as the finding-cap row.
export const SMOKE_QC_KEYS = Object.freeze({
  anchor: "anchor",
  favicon: "favicon:link",
  og_title: "og:title",
  og_description: "og:description",
  og_image: "og:image",
  og_image_target: "og:image_target",
  tailwind_cdn: `tailwind_cdn:${TAILWIND_CDN_HOST}`,
  asset_host: `asset_host:${PRIMARY_ASSET_HOST}`,
  loopback: "loopback:loopback",
});
const K = SMOKE_QC_KEYS;
const anchorKey = (target) => `anchor:${target}`;

const ENVIRONMENTS = new Set(["production", "development"]);
const ENVIRONMENT_REASON = Object.freeze({ development: R.DEVELOPMENT_RENDER, unknown: R.BUILD_ENVIRONMENT_UNKNOWN });
const environmentOf = (value) => (ENVIRONMENTS.has(value) ? value : "unknown");

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const OG_FIELDS = new Map([["og:title", "title"], ["og:description", "description"], ["og:image", "image"]]);
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

// An absolute URL (http:, https: or protocol-relative) inside an attribute
// value or <style> text. Not the `//` of another scheme or of a path.
const ABSOLUTE_URL = /(?<![\w+.:/-])(?:https?:)?\/\/[^\s"'`<>()\\,;{}|^]+/gi;

function hostsIn(text) {
  const hosts = [];
  for (const [match] of String(text).matchAll(ABSOLUTE_URL)) {
    let url;
    try {
      url = new URL(match, "https://base.invalid/");
    } catch {
      continue;
    }
    if (WEB_PROTOCOLS.has(url.protocol) && url.hostname) hosts.push(url.hostname);
  }
  return hosts;
}

const attrsOf = (node) => {
  const map = new Map();
  for (const attr of node.attrs || []) map.set(attr.name.toLowerCase(), attr.value);
  return map;
};
const attrName = (attr) => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
const childrenOf = (node) => (node.tagName === "template" && node.content ? node.content.childNodes : node.childNodes) || [];
const textOf = (node) => (node.childNodes || []).filter((child) => child.nodeName === "#text").map((child) => child.value || "").join("");

const isHexByte = (byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
const UTF8_STRICT = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

// The bytes `raw` percent-decodes to over its UTF-8 bytes. A `%` not followed
// by two hex digits is kept as is, or, with `strict`, makes the whole value
// undecodable (null).
function percentBytes(raw, { strict = false } = {}) {
  const input = Buffer.from(raw, "utf8");
  const bytes = [];
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === 0x25 && i + 2 < input.length && isHexByte(input[i + 1]) && isHexByte(input[i + 2])) {
      bytes.push(Number.parseInt(String.fromCharCode(input[i + 1], input[i + 2]), 16));
      i += 2;
    } else if (input[i] === 0x25 && strict) {
      return null;
    } else {
      bytes.push(input[i]);
    }
  }
  return Uint8Array.from(bytes);
}

// A fragment as the target it names (contract 1.6 "Fragments are
// percent-decoded"): WHATWG percent-decode over its UTF-8 bytes, a `%` not
// followed by two hex digits kept as is, then UTF-8 decode (an invalid
// sequence reads U+FFFD). `#caf%C3%A9` names `café`, never `caf%C3%A9`.
function decodeFragment(raw) {
  if (!raw.includes("%")) return raw;
  return UTF8.decode(percentBytes(raw));
}

// One URL path segment as the file name it names, or null when it names none:
// a `%` without two hex digits, bytes that are not UTF-8, or a decoded `/` or
// NUL (no file name holds either).
function decodePathSegment(segment) {
  if (!segment.includes("%")) return segment;
  const bytes = percentBytes(segment, { strict: true });
  if (!bytes) return null;
  let decoded;
  try {
    decoded = UTF8_STRICT.decode(bytes);
  } catch {
    return null;
  }
  return /[/\u0000]/.test(decoded) ? null : decoded;
}

/**
 * The one mapping from a URL reference on a built page to a file under
 * `_site/`, used for the og:image file and every local script. The query and
 * fragment are dropped, each path segment is percent-decoded, and the decoded
 * path goes to `resolveAsset` (which reads `?` and `#` as delimiters, so a
 * decoded name holding one is joined onto the resolved directory here).
 * `a%23b.png` names `a#b.png`, never a file literally called `a%23b.png`.
 * Whether the file is inside the site root is the reader's check (its real
 * path), as before.
 *
 * @param {string} reference  the attribute value or URL path
 * @param {string} builtPath  the page's file
 * @param {(src: string, builtPath: string) => string|null} resolveAsset
 * @returns {null|{ path: string }|{ unmappable: true }}  null when the
 *   reference is not local (remote, data:, empty path); unmappable when its
 *   path names no file (see decodePathSegment).
 */
export function builtFileOf(reference, builtPath, resolveAsset) {
  const pathPart = String(reference ?? "").trim().split(/[?#]/)[0];
  if (!pathPart || resolveAsset(pathPart, builtPath) == null) return null;
  const segments = pathPart.split("/").map(decodePathSegment);
  if (segments.includes(null)) return { unmappable: true };
  const at = segments.findIndex((segment) => /[?#]/.test(segment));
  if (at === -1) {
    const path = resolveAsset(segments.join("/"), builtPath);
    return path == null ? { unmappable: true } : { path };
  }
  const dir = resolveAsset([...segments.slice(0, at), "."].join("/"), builtPath);
  return dir == null ? { unmappable: true } : { path: resolve(dir, ...segments.slice(at)) };
}

// Every element in document order with its path (`html[1]/body[1]/a[2]`) and
// whether it sits in <template> content, without recursion.
function walkElements(document, visit) {
  const stack = [];
  const pushChildren = (node, path, inTemplate) => {
    const counts = new Map();
    const frames = [];
    for (const child of childrenOf(node)) {
      if (!child.tagName) continue;
      const tag = child.tagName.toLowerCase();
      const index = (counts.get(tag) || 0) + 1;
      counts.set(tag, index);
      frames.push({ node: child, tag, path: `${path ? `${path}/` : ""}${tag}[${index}]`, inTemplate });
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) stack.push(frames[i]);
  };
  pushChildren(document, "", false);
  while (stack.length) {
    const frame = stack.pop();
    visit(frame);
    pushChildren(frame.node, frame.path, frame.inTemplate || frame.tag === "template");
  }
}

class CandidateCap {
  constructor(limit) {
    this.limit = limit;
    this.count = 0;
    this.reached = false;
  }

  // Whether one more candidate may be examined.
  take() {
    if (this.reached) return false;
    if (this.count === this.limit) {
      this.reached = true;
      return false;
    }
    this.count += 1;
    return true;
  }
}

// The URL-bearing attributes, a closed list: the HTML Living Standard
// attribute index entries whose value is a URL, a URL list or a hash-name
// reference, the obsolete URL attributes, and SVG href and xlink:href. Each
// non-empty value is one candidate, relative or absolute (a srcset or ping
// list counts once). Any other attribute (data-*, <meta content>, style, ...)
// is a candidate only when it holds an absolute URL, the one form the
// asset-host and loopback rules read from it. Nothing outside the list is
// added.
export const URL_ATTRIBUTES = Object.freeze(new Set([
  "href", "src", "srcset", "imagesrcset", "poster", "action", "formaction", "data", "cite",
  "ping", "itemid", "itemtype", "usemap", "background", "longdesc", "manifest", "codebase",
  "classid", "archive", "profile", "lowsrc", "dynsrc", "xlink:href",
]));

// The src of a <script> the page loads, or null: an HTML <script> with a
// non-empty src whose type runs as JavaScript (classic or module) and that is
// not in <template> content. <noscript> content parses as text, so a script
// there is never an element.
function loadedScriptSrc(node, tag, inTemplate) {
  if (inTemplate || tag !== "script" || node.namespaceURI !== HTML_NAMESPACE) return null;
  const attrs = attrsOf(node);
  const src = attrs.get("src");
  return typeof src === "string" && src.trim() && scriptKind(attrs) ? src : null;
}

/**
 * The src of every script a built page loads, in document order, read from
 * its parse5 tree (see loadedScriptSrc). Throws what parse5 throws.
 *
 * @param {string} content  the page's HTML
 * @returns {string[]}
 */
export function pageScriptSources(content) {
  const sources = [];
  walkElements(parse(content), ({ node, tag, inTemplate }) => {
    const src = loadedScriptSrc(node, tag, inTemplate);
    if (src != null) sources.push(src);
  });
  return sources;
}

// One parsed page's raw observation. Candidates past the cap are not
// examined; ids, names and the page's loaded scripts (used only when the
// caller lists no scripts) are read from the whole tree.
function observeDocument(document) {
  const cap = new CandidateCap(SMOKE_QC_LIMITS.candidates);
  const observed = {
    liveTargets: new Set(),
    templateTargets: new Set(),
    anchors: new Map(),
    favicon: [],
    og: { title: null, description: null, image: null },
    scripts: [],
    tailwind: [],
    assetHost: [],
    loopback: [],
    cap,
  };
  const refs = new Map([[observed.assetHost, new Set()], [observed.loopback, new Set()]]);
  const addRef = (list, ref) => {
    const id = `${ref.element_path}\u0000${ref.attr}`;
    if (refs.get(list).has(id)) return;
    refs.get(list).add(id);
    list.push(ref);
  };
  const recordHosts = (hosts, ref) => {
    if (hosts.includes(PRIMARY_ASSET_HOST)) addRef(observed.assetHost, ref);
    if (hosts.some((host) => isLoopbackHostname(host))) addRef(observed.loopback, ref);
  };

  walkElements(document, ({ node, tag, path, inTemplate }) => {
    const attrs = attrsOf(node);
    const html = node.namespaceURI === HTML_NAMESPACE;
    const targets = inTemplate ? observed.templateTargets : observed.liveTargets;
    if (attrs.get("id")) targets.add(attrs.get("id"));
    if (html && tag === "a" && attrs.get("name")) targets.add(attrs.get("name"));

    // An in-page anchor is one candidate, its href included.
    let anchorHref = false;
    if (!inTemplate) {
      const href = (tag === "a" || tag === "area") && typeof attrs.get("href") === "string" ? attrs.get("href").trim() : null;
      anchorHref = href != null && href.startsWith("#");
      if (anchorHref && cap.take()) {
        const target = decodeFragment(href.slice(1));
        if (!observed.anchors.has(target)) observed.anchors.set(target, { target, element_paths: [] });
        observed.anchors.get(target).element_paths.push(path);
      }
    }
    if (html && tag === "link" && cap.take() && !inTemplate) {
      const rel = String(attrs.get("rel") || "").toLowerCase().split(ASCII_WHITESPACE);
      if (rel.includes("icon") || rel.includes("apple-touch-icon")) observed.favicon.push(path);
    }
    if (html && tag === "meta" && cap.take() && !inTemplate) {
      const content = String(attrs.get("content") || "").trim();
      for (const name of ["property", "name"]) {
        const field = OG_FIELDS.get(String(attrs.get(name) || "").trim().toLowerCase());
        if (field && content && !observed.og[field]) observed.og[field] = { element_path: path, content };
      }
    }
    const scriptSrc = loadedScriptSrc(node, tag, inTemplate);
    if (scriptSrc != null) observed.scripts.push({ src: scriptSrc, element_path: path });

    // Every URL-bearing attribute value is a candidate, relative or absolute;
    // only the absolute ones are matched by host.
    for (const attr of node.attrs || []) {
      const name = attrName(attr);
      if (anchorHref && name === "href") continue;
      const hosts = hostsIn(attr.value);
      if (!hosts.length && !(URL_ATTRIBUTES.has(name) && attr.value.trim())) continue;
      if (!cap.take() || !hosts.length) continue;
      recordHosts(hosts, { element_path: path, attr: name });
      if (!inTemplate && html && tag === "script" && name === "src" && hosts.includes(TAILWIND_CDN_HOST)) observed.tailwind.push(path);
    }
    if (tag === "style") {
      const hosts = hostsIn(textOf(node));
      if (hosts.length && cap.take()) recordHosts(hosts, { element_path: path, attr: "style" });
    }
  });
  return observed;
}

const insideRoot = (root, path) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

// The page's local scripts for the anchor hint: `contents` holds what was
// read, `complete` whether every local script the page loads was. The list is
// the caller's (`page.scripts`); without one, every local <script src> on the
// page counts as loaded and unread.
function pageScripts(page, observed, builtPath, ctx) {
  const listed = Array.isArray(page.scripts)
    ? page.scripts
    : observed.scripts.filter((script) => builtFileOf(script.src, builtPath, ctx.resolveAsset) != null).map((script) => ({ src: script.src, unread: "not_listed" }));
  const contents = listed.filter((script) => typeof script?.content === "string").map((script) => script.content);
  return { contents, loaded: listed.length, read: contents.length, complete: contents.length === listed.length };
}

// Whether a local asset is a file inside the site root, its real path (every
// symlink followed) compared with the site root's own. A path that cannot be
// resolved or stat-ed reads as no file.
function fileExists(realSiteRoot, path) {
  if (!realSiteRoot || path == null) return false;
  try {
    const real = realpathSync(path);
    return insideRoot(realSiteRoot, real) && statSync(real).isFile();
  } catch (error) {
    if (!isFileReadFailure(error)) throw error;
    return false;
  }
}

// The file an og:image reference names (builtFileOf), or null: a reference
// whose path names no file is never a file in _site/, so it reads missing.
const ogImageFile = (reference, builtPath, ctx) => builtFileOf(reference, builtPath, ctx.resolveAsset)?.path ?? null;

function realPathOf(path) {
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isFileReadFailure(error)) throw error;
    return null;
  }
}

// Where the page's og:image points: { image, image_target }. Absolute means
// a scheme and a host; a scheme-relative `//host/x` is not absolute.
function resolveOgImage(content, builtPath, ctx) {
  const value = content.trim();
  if (value.startsWith("//")) return resolveSchemeRelativeOgImage(value, builtPath, ctx);
  let url = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url && !WEB_PROTOCOLS.has(url.protocol)) return { image: "absolute_remote", image_target: url.protocol };
  if (url) {
    const target = `${url.protocol}//${url.host}${url.pathname}`;
    if (!ctx.origins.size) return { image: "absolute_same_base_unmapped", image_target: target };
    if (!ctx.origins.has(url.origin)) return { image: "absolute_remote", image_target: target };
    const path = ogImageFile(url.pathname, builtPath, ctx);
    return { image: fileExists(ctx.realSiteRoot, path) ? "absolute_same_base_present" : "absolute_same_base_missing", image_target: target };
  }
  const pathPart = value.split(/[?#]/)[0];
  const path = ogImageFile(value, builtPath, ctx);
  const target = path != null && ctx.siteRoot && insideRoot(ctx.siteRoot, path)
    ? `/${relative(ctx.siteRoot, path).split(sep).join("/")}`
    : pathPart || null;
  return { image: fileExists(ctx.realSiteRoot, path) ? "relative_present" : "relative_missing", image_target: target };
}

// A scheme-relative og:image (`//host/path`): relative, so never a pass. On a
// deploy base host its path maps into _site/ like an absolute same-base URL;
// on any other host, or with no known base, its file is not looked for and it
// reads relative_present (the observation enum is closed).
function resolveSchemeRelativeOgImage(value, builtPath, ctx) {
  let url = null;
  try {
    url = new URL(`https:${value}`);
  } catch {
    url = null;
  }
  if (!url || !url.host) return { image: "relative_missing", image_target: value.split(/[?#]/)[0] || null };
  const target = `//${url.host}${url.pathname}`;
  if (!ctx.origins.has(`https://${url.host}`) && !ctx.origins.has(`http://${url.host}`)) return { image: "relative_present", image_target: target };
  const path = ogImageFile(url.pathname, builtPath, ctx);
  return { image: fileExists(ctx.realSiteRoot, path) ? "relative_present" : "relative_missing", image_target: target };
}

const OG_IMAGE_RESULT = Object.freeze({
  relative_missing: ["warning", R.OG_IMAGE_MISSING_FILE],
  relative_present: ["warning", R.OG_IMAGE_NOT_ABSOLUTE],
  absolute_same_base_present: ["pass", null],
  absolute_same_base_missing: ["warning", R.OG_IMAGE_MISSING_FILE],
  absolute_same_base_unmapped: ["unexercised", R.OG_IMAGE_BASE_UNKNOWN],
  absolute_remote: ["unexercised", R.OG_IMAGE_REMOTE_NOT_FETCHED],
});

// One target's outcome: [result, reason_code, outcome]. Only the decoded
// target is matched. A target not on the page is unexercised while any local
// script the page loads went unread, whatever the scripts read contain.
function anchorOutcome(anchor, observed, scripts) {
  const { target } = anchor;
  if (target === "" || observed.liveTargets.has(target) || target.toLowerCase() === "top") return ["pass", null, "resolved"];
  if (observed.templateTargets.has(target)) return ["review", R.ANCHOR_TARGET_IN_TEMPLATE, "in_template"];
  if (!scripts.complete) return ["unexercised", R.SCRIPT_UNREADABLE, "script_unreadable"];
  if (scripts.contents.some((content) => content.includes(target))) return ["review", R.ANCHOR_TARGET_POSSIBLY_SCRIPT_CREATED, "in_script"];
  return ["warning", R.ANCHOR_TARGET_MISSING, "missing"];
}

const environmentResult = (environment, found, reasonCode) => {
  if (environment !== "production") return ["unexercised", ENVIRONMENT_REASON[environment]];
  return found ? ["warning", reasonCode] : ["pass", null];
};

// The page's results before any cap: { anchors: [...], fixed: [...] }, each
// { key, result, reason_code, state, observation }, and `absence: true` on a
// result that rests on something not being on the page.
function pageFindings(page, file, observed, builtPath, ctx) {
  const scripts = pageScripts(page, observed, builtPath, ctx);
  const anchors = [...observed.anchors.values()].map((anchor) => {
    const [result, reasonCode, outcome] = anchorOutcome(anchor, observed, scripts);
    const read = outcome === "resolved" || outcome === "in_template" ? null : scripts;
    return {
      key: anchorKey(anchor.target),
      result,
      reason_code: reasonCode,
      state: { element_paths: anchor.element_paths },
      observation: { page: file, target: anchor.target, outcome, scripts_read: read ? read.read : null, scripts_loaded: read ? read.loaded : null },
    };
  });

  const { environment } = ctx;
  const og = observed.og;
  const ogImage = og.image ? resolveOgImage(og.image.content, builtPath, ctx) : { image: "absent", image_target: null };
  const ogObservation = { title: Boolean(og.title), description: Boolean(og.description), image: ogImage.image, image_target: ogImage.image_target };
  const presence = (key, field, reasonCode) => ({
    key,
    result: og[field] ? "pass" : "warning",
    reason_code: og[field] ? null : reasonCode,
    state: { element_paths: og[field] ? [og[field].element_path] : [] },
    observation: { page: file, og: ogObservation },
    absence: true,
  });
  const refsState = (refs) => ({ element_paths: refs.map((ref) => ref.element_path), attributes: refs.map((ref) => ref.attr) });
  const [tailwindResult, tailwindReason] = environmentResult(environment, observed.tailwind.length > 0, R.TAILWIND_CDN_IN_PRODUCTION);
  const [loopbackResult, loopbackReason] = environmentResult(environment, observed.loopback.length > 0, R.LOOPBACK_URL);
  const fixed = [
    {
      key: K.favicon,
      result: observed.favicon.length ? "pass" : "warning",
      reason_code: observed.favicon.length ? null : R.FAVICON_MISSING,
      state: { element_paths: observed.favicon },
      observation: { page: file, favicon: observed.favicon.length > 0 },
      absence: true,
    },
    presence(K.og_title, "title", R.OG_TITLE_MISSING),
    presence(K.og_description, "description", R.OG_DESCRIPTION_MISSING),
    presence(K.og_image, "image", R.OG_IMAGE_MISSING),
    ...(og.image ? [{
      key: K.og_image_target,
      result: OG_IMAGE_RESULT[ogImage.image][0],
      reason_code: OG_IMAGE_RESULT[ogImage.image][1],
      state: { element_paths: [og.image.element_path], image_target: ogImage.image_target },
      observation: { page: file, og: ogObservation },
    }] : []),
    {
      key: K.tailwind_cdn,
      result: tailwindResult,
      reason_code: tailwindReason,
      state: { element_paths: observed.tailwind, environment },
      observation: { page: file, tailwind_cdn: observed.tailwind.length, environment },
    },
    {
      key: K.asset_host,
      result: observed.assetHost.length ? "warning" : "pass",
      reason_code: observed.assetHost.length ? R.PRIMARY_ASSET_HOST : null,
      state: refsState(observed.assetHost),
      observation: { page: file, asset_host_refs: observed.assetHost },
    },
    {
      key: K.loopback,
      result: loopbackResult,
      reason_code: loopbackReason,
      state: { ...refsState(observed.loopback), environment },
      observation: { page: file, loopback_refs: observed.loopback, environment },
    },
  ];
  return { anchors, fixed };
}

const PAGE_LEVEL_KEYS = Object.freeze(Object.values(K));
const isFinding = (finding) => finding.result === "warning" || finding.result === "review";
// What a capped page keeps: a warning or review observed in full, never one
// that rests on something being absent from a page not seen whole.
const keptOnCappedPage = (finding) => isFinding(finding) && !finding.absence;
const capMembersFor = (reasons) => reasons.flatMap((reason) => aggregateQcResults([], { capReason: reason }).members);

/**
 * Evaluate the built-output smoke checks.
 *
 * @param {{
 *   subject?: object,
 *   pages: Array<{ file: string, content?: string, bytes?: number, unreadable?: boolean, scripts?: Array<{ src: string, file?: string, content?: string, unread?: string }> }>,
 *   environment?: string|null,
 *   siteRoot: string|null,
 *   deployBase?: string|string[]|null,
 *   resolveAsset: (src: string, builtPath: string) => string|null,
 *   measuredAt?: string,
 * }} input  `pages` in a stable order, `file` relative to the doctor target
 *   ("_site/<slug>/index.html"); pages past the page cap may omit `content`.
 *   `scripts` lists every local script the page loads, read or not (see the
 *   header); a page without it reads its local scripts unread.
 *   `environment` is the recorded build environment ("production" or
 *   "development"; anything else is unknown). `siteRoot` is the built `_site/`
 *   directory: page files resolve against its parent, and a local asset whose
 *   real path lies outside it reads as missing. `deployBase` lists the deploy URLs whose
 *   origins map an absolute og:image into `_site/`; none means the base is
 *   unknown. `resolveAsset` maps a URL path on a built page to a file path,
 *   or null when it is not local; it gets the reference through builtFileOf,
 *   so already decoded. `subject` names the scanned site for
 *   the caller; every result carries its own {check, page, key} subject.
 * @returns {object[]} QC results (src/qc-results.mjs buildQcResult).
 */
export function evaluateSmokeQc({ subject = null, pages = [], environment = null, siteRoot = null, deployBase = null, resolveAsset = null, measuredAt = new Date().toISOString() } = {}) {
  if (typeof resolveAsset !== "function") throw new TypeError("evaluateSmokeQc needs resolveAsset to map a page's local references to files.");
  const check = SMOKE_QC_CHECK;
  const ctx = {
    environment: environmentOf(environment),
    siteRoot,
    origins: deployOrigins(deployBase),
    resolveAsset,
    realSiteRoot: realPathOf(siteRoot),
  };
  const results = [];
  const row = (page, { key, result, reason_code = null, state = {}, observation = {} }, { members = [], coverage } = {}) => buildQcResult({
    check,
    leg: "doctor",
    subject: { check, page, key },
    result,
    reason_code,
    state: { reason_code: result === "pass" ? null : reason_code, ...state, members },
    observation,
    members,
    coverage: coverage ?? (result === "unexercised" ? { observed: 0, expected: 1, limits: [reason_code] } : { observed: 1, expected: 1, limits: [] }),
    measured_at: measuredAt,
  });
  const pageLevel = (file, reasonCode, extra = {}) => {
    for (const key of PAGE_LEVEL_KEYS) {
      results.push(row(file, { key, result: "unexercised", reason_code: reasonCode, observation: { page: file, ...extra } }));
    }
  };

  (Array.isArray(pages) ? pages : []).forEach((page, index) => {
    const file = String(page?.file ?? "");
    if (index >= SMOKE_QC_LIMITS.pages) {
      pageLevel(file, R.PAGE_CAP_REACHED);
      return;
    }
    const read = readPage(page || {});
    if (read.outcome) {
      pageLevel(file, read.outcome, read.bytes == null ? {} : { bytes: read.bytes });
      return;
    }
    let findings;
    let observed;
    try {
      observed = observeDocument(read.document);
      findings = pageFindings(page, file, observed, siteRoot ? join(siteRoot, "..", file) : file, ctx);
    } catch (error) {
      if (!isPageReadFailure(error)) throw error;
      pageLevel(file, R.PAGE_UNREADABLE, { bytes: read.bytes });
      return;
    }

    const caps = [];
    if (observed.cap.reached) caps.push(R.CANDIDATE_CAP_REACHED);
    // The result cap counts the anchor rule's results, pass included (the
    // only rule with more than one result per page).
    if (findings.anchors.length > SMOKE_QC_LIMITS.results) caps.push(R.FINDING_CAP_REACHED);
    if (!caps.length) {
      for (const finding of [...findings.anchors, ...findings.fixed]) results.push(row(file, finding));
      return;
    }

    // A capped page: the warning and review results observed in full stay,
    // each with the capped-page member; every other rule key reads
    // unexercised for the cap, and nothing passes.
    const members = capMembersFor(caps);
    const capped = (finding) => row(file, finding, { members, coverage: { observed: finding.result === "unexercised" ? 0 : 1, expected: null, limits: [...caps] } });
    const capRow = (key) => capped({ key, result: "unexercised", reason_code: caps[0], observation: { page: file, candidates: observed.cap.count } });
    for (const finding of findings.anchors.slice(0, SMOKE_QC_LIMITS.results)) {
      if (keptOnCappedPage(finding)) results.push(capped(finding));
    }
    results.push(capRow(K.anchor));
    for (const key of PAGE_LEVEL_KEYS.filter((value) => value !== K.anchor)) {
      const finding = findings.fixed.find((item) => item.key === key);
      results.push(finding && keptOnCappedPage(finding) ? capped(finding) : capRow(key));
    }
  });
  return results;
}

// One page's parse5 tree, or a page-level outcome. A read or parse failure
// reads the page unreadable; any other error is a defect and throws.
function readPage(page) {
  if (page.unreadable) return { outcome: R.PAGE_UNREADABLE };
  const bytes = Number.isFinite(page.bytes) ? page.bytes : typeof page.content === "string" ? Buffer.byteLength(page.content, "utf8") : null;
  if (bytes != null && bytes > SMOKE_QC_LIMITS.page_bytes) return { outcome: R.PAGE_TOO_LARGE, bytes };
  if (typeof page.content !== "string") return { outcome: R.PAGE_UNREADABLE };
  try {
    return { document: parse(page.content), bytes };
  } catch (error) {
    if (!isPageReadFailure(error)) throw error;
    return { outcome: R.PAGE_UNREADABLE, bytes };
  }
}

function deployOrigins(deployBase) {
  const origins = new Set();
  for (const value of [deployBase].flat()) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (WEB_PROTOCOLS.has(url.protocol)) origins.add(url.origin);
    } catch {
      // Not a URL: no base.
    }
  }
  return origins;
}
