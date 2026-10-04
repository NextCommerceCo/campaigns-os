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
//                     host and path; otherwise its file is never looked for
//                     and it reads `relative_present`); an absolute URL under
//                     a deploy base (its origin, and a path inside the base's
//                     path) passes when its file is in _site/ and is
//                     og_image_missing_file otherwise; with no known deploy
//                     base it is unexercised og_image_base_unknown, and
//                     anywhere else og_image_remote_not_fetched (never
//                     fetched)
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
// A host is read only from a whole value, never a substring: a URL_ATTRIBUTES
// value (srcset and imagesrcset split per HTML, ping per whitespace), any
// other attribute whose whole value is a URL, and the url() and string tokens
// of a style attribute or <style> text (cssUrlValues), so a URL inside
// another URL's query names no host. Every host, the Tailwind script's
// included, is the URL parser's hostname (hostOf). Whether a value is
// absolute or scheme-relative is read from its own text, never from where it
// resolves. Markup the HTML parser keeps as text but a visitor can load, the
// text of a <noscript> and the srcdoc of an <iframe>, is parsed as a document
// of its own and read by the same two rules. Text nodes and script bodies are
// not scanned. The per-page candidate cap counts each in-page anchor, each
// <meta> and <link> (in <template> content too), each URL_ATTRIBUTES value
// whether relative or absolute, any other attribute value holding an absolute
// URL, each <style> holding one, and each <noscript> or srcdoc holding markup
// (whose own candidates count on the page too); that markup together may not
// exceed the page size cap, and past it the page is capped as well.
//
// Every parse goes through the 1.5 gate's bounded parser (parseBounded), so
// nesting deeper than MAX_ELEMENT_DEPTH (a nested document's depth counting
// from its host element) stops the parse and reads page_unreadable.
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
// Callers hand in built HTML and the local scripts each page loads: either
// `readScripts`, called with the srcs of the scripts the page's own parse
// lists (doctor's bounded script collector), or a `page.scripts` list
// ({src, file, content} when read, {src, file, unread} when not); a page with
// neither reads every local script it loads unread. Every URL reference that
// names a file under _site/ (the og:image file, each local script) maps
// through builtFileOf: the URL parser resolves it against the page's own URL
// under the site root, and each segment of the resulting path is
// percent-decoded onto `siteRoot`. A path that names no file (`%ZZ`, bytes
// that are not UTF-8, an empty segment, so a trailing `/`) is never a file.
// The og:image file is stat-ed here, once per og:image, and counts only when
// its real path (symlinks followed) lies inside `siteRoot`. No network
// request.

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { CART_PLACEHOLDERS_LIMITS, MAX_ELEMENT_DEPTH, isFileReadFailure, isPageReadFailure, parseBounded, scriptKind } from "./cart-placeholders.mjs";
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

// The origin built pages are read from: the site root (_site/) is its path
// `/`, so a page's URL is its path under _site/ and every reference on it
// resolves as a browser resolves it there. Only a path reference resolves
// against it; no reference is ever judged by whether it lands on this origin,
// so an absolute URL that names it is just another remote URL.
const SITE_ORIGIN = "https://built.invalid";
const SITE_BASE = `${SITE_ORIGIN}/`;

const parseUrl = (value, base) => {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
};

// What a reference is, read from its own text and never from where it
// resolves: `absolute` when the URL parser reads it with no base (it has a
// scheme), `scheme_relative` when it starts with two slashes or backslashes
// (after the leading C0 controls and spaces, and the tabs and newlines, the
// parser drops), else a `path`. `url` is the parsed URL of an absolute
// reference, or of a scheme-relative one resolved against `base`.
function readReference(value, base = SITE_BASE) {
  const absolute = parseUrl(value);
  if (absolute) return { kind: "absolute", url: absolute };
  const text = String(value).replace(/^[\u0000- ]+/, "").replace(/[\t\n\r]/g, "");
  if (/^[/\\]{2}/.test(text)) return { kind: "scheme_relative", url: parseUrl(value, base) };
  return { kind: "path", url: null };
}

// The host a candidate names, read by the URL parser (userinfo, port, IPv6
// brackets, IDN, case and IPv4 forms are its own): an http(s) URL that is
// absolute or protocol-relative, its hostname without a trailing root dot.
// Anything else, a relative path included, names no host.
function hostOf(candidate) {
  const { kind, url } = readReference(candidate);
  if (kind === "path" || !url || !WEB_PROTOCOLS.has(url.protocol)) return null;
  return url.hostname.replace(/\.$/, "") || null;
}

const isAsciiWhitespace = (c) => c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
const trimAsciiWhitespace = (value) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");

// The URLs of a srcset or imagesrcset value, split as the HTML "parse a srcset
// attribute" algorithm splits it: skip ASCII whitespace and commas, take the
// run up to the next ASCII whitespace as the URL (a comma inside it stays;
// trailing commas end the entry), then skip its descriptors up to a comma
// outside parentheses. Descriptors are not validated.
function srcsetUrls(value) {
  const urls = [];
  let i = 0;
  for (;;) {
    while (i < value.length && (isAsciiWhitespace(value[i]) || value[i] === ",")) i += 1;
    if (i >= value.length) return urls;
    const start = i;
    while (i < value.length && !isAsciiWhitespace(value[i])) i += 1;
    const url = value.slice(start, i);
    if (url.endsWith(",")) {
      urls.push(url.replace(/,+$/, ""));
      continue;
    }
    urls.push(url);
    let inParens = false;
    while (i < value.length) {
      const c = value[i];
      i += 1;
      if (c === "(") inParens = true;
      else if (c === ")") inParens = false;
      else if (c === "," && !inParens) break;
    }
  }
}

// CSS Syntax 3 code point classes (§4.2), on preprocessed input (§3.3).
const isCssWhitespace = (c) => c === "\n" || c === "\t" || c === " ";
const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
const isHexDigit = (c) => c !== undefined && /[0-9A-Fa-f]/.test(c);
const isIdentStart = (c) => c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isIdentCodePoint = (c) => isIdentStart(c) || isDigit(c) || c === "-";
const isNonPrintable = (c) => c !== undefined && /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(c);
const isValidEscape = (a, b) => a === "\\" && b !== "\n";
const startsIdentSequence = (a, b, c) => {
  if (a === "-") return isIdentStart(b) || b === "-" || isValidEscape(b, c);
  return isIdentStart(a) || isValidEscape(a, b);
};
const startsNumber = (a, b, c) => {
  if (a === "+" || a === "-") return isDigit(b) || (b === "." && isDigit(c));
  if (a === ".") return isDigit(b);
  return isDigit(a);
};

/**
 * The value of every <url-token> and <string-token> in CSS text (a <style>
 * element's text or a style attribute), tokenized per CSS Syntax 3 §4.3:
 * escapes decoded (consume an escaped code point), `url(` recognized only as
 * an ident-like token (so `u\72l(` is one, a `1url(` dimension is not), and
 * `url( "…" )` read as a function whose string token follows. Comments,
 * <bad-url-token>s and <bad-string-token>s give no value. Every other token is
 * consumed only to find where the next one starts.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function cssUrlValues(text) {
  const s = String(text).replace(/\r\n?|\f/g, "\n").replace(/\u0000/g, "�");
  const values = [];
  let i = 0;

  // §4.3.7, the backslash already consumed.
  const escapedCodePoint = () => {
    if (i >= s.length) return "�";
    if (isHexDigit(s[i])) {
      let hex = "";
      while (hex.length < 6 && isHexDigit(s[i])) hex += s[i++];
      if (isCssWhitespace(s[i])) i += 1;
      const value = Number.parseInt(hex, 16);
      return value === 0 || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff ? "�" : String.fromCodePoint(value);
    }
    const char = String.fromCodePoint(s.codePointAt(i));
    i += char.length;
    return char;
  };
  // §4.3.12.
  const identSequence = () => {
    let out = "";
    for (;;) {
      if (isIdentCodePoint(s[i])) {
        out += s[i];
        i += 1;
      } else if (isValidEscape(s[i], s[i + 1])) {
        i += 1;
        out += escapedCodePoint();
      } else {
        return out;
      }
    }
  };
  // §4.3.5, the opening quote already consumed; null for a <bad-string-token>.
  const stringToken = (ending) => {
    let out = "";
    while (i < s.length) {
      const c = s[i];
      if (c === "\n") return null;
      i += 1;
      if (c === ending) return out;
      if (c !== "\\") out += c;
      else if (s[i] === "\n") i += 1;
      else if (i < s.length) out += escapedCodePoint();
    }
    return out;
  };
  // §4.3.14.
  const badUrlRemnants = () => {
    while (i < s.length) {
      const c = s[i];
      i += 1;
      if (c === ")") return;
      if (isValidEscape(c, s[i])) escapedCodePoint();
    }
  };
  // §4.3.6, `url(` already consumed; null for a <bad-url-token>.
  const urlToken = () => {
    while (isCssWhitespace(s[i])) i += 1;
    let out = "";
    while (i < s.length) {
      const c = s[i];
      i += 1;
      if (c === ")") return out;
      if (isCssWhitespace(c)) {
        while (isCssWhitespace(s[i])) i += 1;
        if (i >= s.length) return out;
        if (s[i] === ")") {
          i += 1;
          return out;
        }
        badUrlRemnants();
        return null;
      }
      if (c === "\"" || c === "'" || c === "(" || isNonPrintable(c) || (c === "\\" && !isValidEscape(c, s[i]))) {
        badUrlRemnants();
        return null;
      }
      out += c === "\\" ? escapedCodePoint() : c;
    }
    return out;
  };
  // §4.3.4.
  const identLikeToken = () => {
    const name = identSequence();
    if (s[i] !== "(") return;
    i += 1;
    if (!/^url$/i.test(name)) return;
    while (isCssWhitespace(s[i]) && isCssWhitespace(s[i + 1])) i += 1;
    const next = isCssWhitespace(s[i]) ? s[i + 1] : s[i];
    if (next === "\"" || next === "'") return;
    const value = urlToken();
    if (value != null) values.push(value);
  };
  // §4.3.3.
  const numericToken = () => {
    if (s[i] === "+" || s[i] === "-") i += 1;
    while (isDigit(s[i])) i += 1;
    if (s[i] === "." && isDigit(s[i + 1])) {
      i += 1;
      while (isDigit(s[i])) i += 1;
    }
    if ((s[i] === "e" || s[i] === "E") && (isDigit(s[i + 1]) || ((s[i + 1] === "+" || s[i + 1] === "-") && isDigit(s[i + 2])))) {
      i += 2;
      while (isDigit(s[i])) i += 1;
    }
    if (startsIdentSequence(s[i], s[i + 1], s[i + 2])) identSequence();
    else if (s[i] === "%") i += 1;
  };

  // §4.3.1 (whitespace and single-code-point tokens advance by one).
  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
    } else if (c === "\"" || c === "'") {
      i += 1;
      const value = stringToken(c);
      if (value != null) values.push(value);
    } else if (c === "#") {
      i += 1;
      if (isIdentCodePoint(s[i]) || isValidEscape(s[i], s[i + 1])) identSequence();
    } else if (c === "+" || c === ".") {
      if (startsNumber(c, s[i + 1], s[i + 2])) numericToken();
      else i += 1;
    } else if (c === "-") {
      if (startsNumber(c, s[i + 1], s[i + 2])) numericToken();
      else if (s[i + 1] === "-" && s[i + 2] === ">") i += 3;
      else if (startsIdentSequence(c, s[i + 1], s[i + 2])) identLikeToken();
      else i += 1;
    } else if (c === "<") {
      i += s.startsWith("<!--", i) ? 4 : 1;
    } else if (c === "@") {
      i += 1;
      if (startsIdentSequence(s[i], s[i + 1], s[i + 2])) identSequence();
    } else if (c === "\\") {
      if (isValidEscape(c, s[i + 1])) identLikeToken();
      else i += 1;
    } else if (isDigit(c)) {
      numericToken();
    } else if (isIdentStart(c)) {
      identLikeToken();
    } else {
      i += 1;
    }
  }
  return values;
}

// The host candidates of one attribute value, each a whole value: a srcset or
// imagesrcset URL, a ping URL (split on ASCII whitespace), a url() or string
// token of a style attribute, or else the whole trimmed value. hostOf reads
// each one; a value that is not an absolute or protocol-relative URL names no
// host, so outside URL_ATTRIBUTES only a whole URL counts.
function attributeCandidates(name, value) {
  if (name === "srcset" || name === "imagesrcset") return srcsetUrls(value);
  if (name === "ping") return value.split(ASCII_WHITESPACE).filter(Boolean);
  if (name === "style") return cssUrlValues(value);
  return [trimAsciiWhitespace(value)];
}

function hostsOf(candidates) {
  const hosts = new Set();
  for (const candidate of candidates) {
    const host = hostOf(candidate);
    if (host) hosts.add(host);
  }
  return [...hosts];
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

// A page's own URL: its path under the site root, each segment
// percent-encoded; null when the page is not under the site root.
function pageUrlOf(builtPath, siteRoot) {
  if (!siteRoot || !insideRoot(siteRoot, builtPath)) return null;
  return `${SITE_ORIGIN}/${relative(siteRoot, builtPath).split(sep).map(encodeURIComponent).join("/")}`;
}

/**
 * The one mapping from a URL reference on a built page to a file under
 * `_site/`, used for the og:image file and every local script. The URL parser
 * resolves the reference against the page's own URL (pageUrlOf), as a browser
 * does: backslashes read as `/`, dot segments are removed, a root-relative
 * reference starts at the site root, and the query and fragment are not part
 * of the path. Only a path reference (see readReference) is local, or an
 * absolute or scheme-relative one under one of `bases` (a deploy base: its
 * origin, or its host for a scheme-relative one, and a path starting with the
 * base's path). Each segment of its path is then percent-decoded and joined
 * onto `siteRoot`: `a%23b.png` names `a#b.png`, never a file literally called
 * `a%23b.png`. An empty segment names no file: `og.png/` (or `og.png/%2e`,
 * which the parser reads as `og.png/`) is a directory, and `a//b.png` is not
 * `a/b.png`. Whether the file is inside the site root is the reader's check
 * (its real path).
 *
 * @param {string} reference  the attribute value
 * @param {string} builtPath  the page's file
 * @param {string|null} siteRoot  the built `_site/` directory
 * @param {{ bases?: Array<{ origin: string, host: string, prefix: string }> }} [options]
 * @returns {null|{ path: string, site_path: string }|{ unmappable: true, site_path?: string }}
 *   null when the reference is not local (anywhere but a deploy base, data:,
 *   or no path at all); unmappable when its path names no file (see
 *   decodePathSegment, and an empty segment), or when there is no site root
 *   or page URL to resolve it from.
 */
export function builtFileOf(reference, builtPath, siteRoot, { bases = [] } = {}) {
  const value = String(reference ?? "").trim();
  // An empty reference, or one with only a query or fragment, names the page
  // itself, not a file it loads.
  if (!value || value.startsWith("?") || value.startsWith("#")) return null;
  const pageUrl = pageUrlOf(builtPath, siteRoot);
  const read = readReference(value, pageUrl ?? SITE_BASE);
  let url;
  if (read.kind === "path") {
    if (!pageUrl) return parseUrl(value, SITE_BASE) ? { unmappable: true } : null;
    url = parseUrl(value, pageUrl);
    if (!url) return null;
  } else {
    url = read.url;
    if (!url || !WEB_PROTOCOLS.has(url.protocol)) return null;
    const same = read.kind === "absolute" ? (base) => base.origin === url.origin : (base) => base.host === url.host;
    if (!bases.some((base) => same(base) && url.pathname.startsWith(base.prefix))) return null;
    if (!siteRoot) return { unmappable: true };
  }
  const segments = url.pathname.split("/").slice(1).map(decodePathSegment);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return { unmappable: true, site_path: url.pathname };
  return { path: join(siteRoot, ...segments), site_path: url.pathname };
}

// Nesting past MAX_ELEMENT_DEPTH found after the parse: nodes the parser
// moved, or a nested document's depth added to its host element's.
class TooDeep extends Error {}

// Whether an error means the page cannot be read or parsed (see
// isPageReadFailure), nesting past the bound found after the parse included.
export const isBuiltPageReadFailure = (error) => error instanceof TooDeep || isPageReadFailure(error);

// Every element in document order with its path (`html[1]/body[1]/a[2]`),
// its depth (the root element is 1) and whether it sits in <template>
// content, without recursion. A nested document starts at its host element's
// `path` and `depth`. An element deeper than MAX_ELEMENT_DEPTH throws TooDeep.
function walkElements(document, visit, { path: rootPath = "", depth: rootDepth = 0 } = {}) {
  const stack = [];
  const pushChildren = (node, path, inTemplate, depth) => {
    const counts = new Map();
    const frames = [];
    for (const child of childrenOf(node)) {
      if (!child.tagName) continue;
      const tag = child.tagName.toLowerCase();
      const index = (counts.get(tag) || 0) + 1;
      counts.set(tag, index);
      frames.push({ node: child, tag, path: `${path ? `${path}/` : ""}${tag}[${index}]`, inTemplate, depth: depth + 1 });
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) stack.push(frames[i]);
  };
  pushChildren(document, rootPath, false, rootDepth);
  while (stack.length) {
    const frame = stack.pop();
    if (frame.depth > MAX_ELEMENT_DEPTH) throw new TooDeep();
    visit(frame);
    pushChildren(frame.node, frame.path, frame.inTemplate || frame.tag === "template", frame.depth);
  }
}

class CandidateCap {
  constructor(limit, markupBytes) {
    this.limit = limit;
    this.count = 0;
    this.reached = false;
    this.markupBytes = markupBytes;
    this.markupRead = 0;
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

  // Whether one more nested document of `bytes` may be parsed: one candidate,
  // and the page's nested markup all together within the page size cap.
  takeMarkup(bytes) {
    if (this.reached) return false;
    if (this.markupRead + bytes > this.markupBytes) {
      this.reached = true;
      return false;
    }
    if (!this.take()) return false;
    this.markupRead += bytes;
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
// there is never an element of the page.
function loadedScriptSrc(node, tag, inTemplate) {
  if (inTemplate || tag !== "script" || node.namespaceURI !== HTML_NAMESPACE) return null;
  const attrs = attrsOf(node);
  const src = attrs.get("src");
  return typeof src === "string" && src.trim() && scriptKind(attrs) ? src : null;
}

/**
 * One built page's parse5 tree, through the 1.5 gate's bounded parser. Throws
 * what it throws (isBuiltPageReadFailure reads it).
 *
 * @param {string} content  the page's HTML
 */
export const parseBuiltPage = (content) => parseBounded(content);

/**
 * The src of every script a built page loads, in document order, read from
 * its parse5 tree (see loadedScriptSrc).
 *
 * @param {object} document  the page's tree (parseBuiltPage)
 * @returns {string[]}
 */
export function pageScriptSources(document) {
  const sources = [];
  walkElements(document, ({ node, tag, inTemplate }) => {
    const src = loadedScriptSrc(node, tag, inTemplate);
    if (src != null) sources.push(src);
  });
  return sources;
}

// The markup an element holds that the HTML parser keeps as text but a
// visitor can load, or null: a <noscript>'s text (parse5 parses with
// scripting on, so its content is one text node) and an <iframe>'s srcdoc.
// `at` names it in the element paths of what it holds.
function nestedMarkupOf(node, tag, attrs) {
  if (node.namespaceURI !== HTML_NAMESPACE) return null;
  if (tag === "noscript") return { markup: textOf(node), at: "" };
  if (tag === "iframe" && attrs.has("srcdoc")) return { markup: attrs.get("srcdoc"), at: "@srcdoc/" };
  return null;
}

// One parsed page's raw observation. Candidates past the cap are not
// examined; ids, names and the page's loaded scripts are read from the whole
// tree. A nested document (nestedMarkupOf) is read only for the asset-host
// and loopback rules, its element paths under its host element's.
function observeDocument(document) {
  const cap = new CandidateCap(SMOKE_QC_LIMITS.candidates, SMOKE_QC_LIMITS.page_bytes);
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

  // The page's own elements: every rule.
  const visitPage = ({ node, tag, path, inTemplate }, attrs) => {
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
    if (scriptSrc != null) observed.scripts.push(scriptSrc);
    readUrls(node, tag, path, { skipHref: anchorHref, tailwind: !inTemplate && html && tag === "script" });
  };

  // Every URL-bearing attribute value is a candidate, relative or absolute;
  // only the absolute ones are matched by host.
  const readUrls = (node, tag, path, { skipHref = false, tailwind = false } = {}) => {
    for (const attr of node.attrs || []) {
      const name = attrName(attr);
      if (skipHref && name === "href") continue;
      const hosts = hostsOf(attributeCandidates(name, attr.value));
      if (!hosts.length && !(URL_ATTRIBUTES.has(name) && attr.value.trim())) continue;
      if (!cap.take() || !hosts.length) continue;
      recordHosts(hosts, { element_path: path, attr: name });
      if (tailwind && name === "src" && hostOf(attr.value) === TAILWIND_CDN_HOST) observed.tailwind.push(path);
    }
    if (tag === "style") {
      const hosts = hostsOf(cssUrlValues(textOf(node)));
      if (hosts.length && cap.take()) recordHosts(hosts, { element_path: path, attr: "style" });
    }
  };

  // A page or nested document; a nested one is read for its URLs only.
  const walk = (tree, nested, start) => walkElements(tree, (frame) => {
    const attrs = attrsOf(frame.node);
    if (nested) readUrls(frame.node, frame.tag, frame.path);
    else visitPage(frame, attrs);
    const inner = nestedMarkupOf(frame.node, frame.tag, attrs);
    // Markup with no `<` holds no element, so it is not parsed or counted.
    if (!inner || !inner.markup.includes("<")) return;
    if (!cap.takeMarkup(Buffer.byteLength(inner.markup, "utf8"))) return;
    walk(parseBuiltPage(inner.markup), true, { path: `${frame.path}/${inner.at}`.replace(/\/$/, ""), depth: frame.depth });
  }, start);
  walk(document, false, {});
  return observed;
}

// Whether `path` lies strictly inside `root` (both already real paths when
// the caller compares real paths).
export const insideRoot = (root, path) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

// A path's real path (every symlink followed), or null when it cannot be
// resolved. Only a file-system read failure reads null; any other error is a
// defect and throws.
export function realPathOf(path) {
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isFileReadFailure(error)) throw error;
    return null;
  }
}

// The page's local scripts for the anchor hint: `contents` holds what was
// read, `complete` whether every local script the page loads was. The list is
// the caller's (`page.scripts`, or `readScripts` given the srcs the page
// loads); without one, every local <script src> on the page counts as loaded
// and unread.
function pageScripts(page, observed, builtPath, ctx) {
  const listed = Array.isArray(page.scripts)
    ? page.scripts
    : ctx.readScripts
      ? ctx.readScripts(observed.scripts, builtPath)
      : observed.scripts.filter((src) => builtFileOf(src, builtPath, ctx.siteRoot) != null).map((src) => ({ src, unread: "not_listed" }));
  const contents = listed.filter((script) => typeof script?.content === "string").map((script) => script.content);
  return { contents, loaded: listed.length, read: contents.length, complete: contents.length === listed.length };
}

// Whether a local asset is a file inside the site root, its real path (every
// symlink followed) compared with the site root's own. A path that cannot be
// resolved or stat-ed reads as no file.
function fileExists(realSiteRoot, path) {
  if (!realSiteRoot || path == null) return false;
  const real = realPathOf(path);
  if (!real || !insideRoot(realSiteRoot, real)) return false;
  try {
    return statSync(real).isFile();
  } catch (error) {
    if (!isFileReadFailure(error)) throw error;
    return false;
  }
}

// Where the page's og:image points: { image, image_target }. Absolute means
// a scheme and a host; a scheme-relative one (`//host/x`, or `\\host/x`) is
// not absolute, whatever host it names (readReference). Every file it names
// comes from builtFileOf; a reference whose path names no file is never a
// file in _site/, so it reads missing.
function resolveOgImage(content, builtPath, ctx) {
  const value = content.trim();
  const { kind, url } = readReference(value);
  if (kind === "absolute") {
    if (!WEB_PROTOCOLS.has(url.protocol)) return { image: "absolute_remote", image_target: url.protocol };
    const target = `${url.protocol}//${url.host}${url.pathname}`;
    if (!ctx.bases.length) return { image: "absolute_same_base_unmapped", image_target: target };
    const mapped = builtFileOf(value, builtPath, ctx.siteRoot, { bases: ctx.bases });
    if (!mapped) return { image: "absolute_remote", image_target: target };
    return { image: fileExists(ctx.realSiteRoot, mapped.path ?? null) ? "absolute_same_base_present" : "absolute_same_base_missing", image_target: target };
  }
  if (kind === "scheme_relative" && url) return resolveSchemeRelativeOgImage(value, url, builtPath, ctx);
  const mapped = builtFileOf(value, builtPath, ctx.siteRoot);
  const path = mapped?.path ?? null;
  const target = path != null ? `/${relative(ctx.siteRoot, path).split(sep).join("/")}` : mapped?.site_path ?? null;
  return { image: fileExists(ctx.realSiteRoot, path) ? "relative_present" : "relative_missing", image_target: target };
}

// A scheme-relative og:image, `url` as the parser reads it: relative, so never
// a pass. Under a deploy base (its host and path) its path maps into _site/
// like an absolute same-base URL; anywhere else, or with no known base, its
// file is not looked for and it reads relative_present (the observation enum
// is closed).
function resolveSchemeRelativeOgImage(value, url, builtPath, ctx) {
  const target = `//${url.host}${url.pathname}`;
  const mapped = builtFileOf(value, builtPath, ctx.siteRoot, { bases: ctx.bases });
  if (!mapped) return { image: "relative_present", image_target: target };
  return { image: fileExists(ctx.realSiteRoot, mapped.path ?? null) ? "relative_present" : "relative_missing", image_target: target };
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
 *   pages: Array<{ file: string, content?: string, bytes?: number, unreadable?: boolean, scripts?: Array<{ src: string, file?: string, content?: string, unread?: string }> }>,
 *   environment?: string|null,
 *   siteRoot: string|null,
 *   targetDir?: string|null,
 *   readScripts?: ((srcs: string[], builtPath: string) => Array<{ src: string, file?: string, content?: string, unread?: string }>)|null,
 *   deployBase?: string|string[]|null,
 *   measuredAt?: string,
 * }} input  `pages` in a stable order, `file` relative to the doctor target
 *   ("_site/<slug>/index.html"); pages past the page cap may omit `content`.
 *   `scripts` lists every local script the page loads, read or not (see the
 *   header); without it `readScripts`, when given, lists them from the srcs
 *   the page's parse found, and otherwise the page's local scripts read
 *   unread. `environment` is the recorded build environment ("production" or
 *   "development"; anything else is unknown). `siteRoot` is the built site
 *   root (the scope's `_site/`, or the directory doctor was pointed at when
 *   it has none): every local reference maps onto it through builtFileOf
 *   (none does without it), and a local asset whose real path lies outside it
 *   reads as missing. Page files resolve against `targetDir`, the doctor
 *   target (by default the site root's parent). `deployBase` lists the deploy
 *   URLs under which an absolute og:image maps into the site root (each
 *   one's origin and path); none means the base is unknown. Every result
 *   carries its own {check, page, key} subject.
 * @returns {object[]} QC results (src/qc-results.mjs buildQcResult).
 */
export function evaluateSmokeQc({ pages = [], environment = null, siteRoot = null, targetDir = null, readScripts = null, deployBase = null, measuredAt = new Date().toISOString() } = {}) {
  const check = SMOKE_QC_CHECK;
  const ctx = {
    environment: environmentOf(environment),
    siteRoot,
    bases: deployBases(deployBase),
    realSiteRoot: realPathOf(siteRoot),
    readScripts,
  };
  const pageDir = targetDir ?? (siteRoot ? dirname(siteRoot) : null);
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
      findings = pageFindings(page, file, observed, pageDir ? join(pageDir, file) : file, ctx);
    } catch (error) {
      if (!isBuiltPageReadFailure(error)) throw error;
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

// One page's parse5 tree (parseBuiltPage), or a page-level outcome. A read or
// parse failure, nesting past MAX_ELEMENT_DEPTH included, reads the page
// unreadable; any other error is a defect and throws.
function readPage(page) {
  if (page.unreadable) return { outcome: R.PAGE_UNREADABLE };
  const bytes = Number.isFinite(page.bytes) ? page.bytes : typeof page.content === "string" ? Buffer.byteLength(page.content, "utf8") : null;
  if (bytes != null && bytes > SMOKE_QC_LIMITS.page_bytes) return { outcome: R.PAGE_TOO_LARGE, bytes };
  if (typeof page.content !== "string") return { outcome: R.PAGE_UNREADABLE };
  try {
    return { document: parseBuiltPage(page.content), bytes };
  } catch (error) {
    if (!isBuiltPageReadFailure(error)) throw error;
    return { outcome: R.PAGE_UNREADABLE, bytes };
  }
}

// Each deploy URL as a base an og:image maps through: its origin, its host
// and its path as a directory (`https://deploy.example/s` and `/s/` both
// read `/s/`), so only a path under it maps into the site root.
function deployBases(deployBase) {
  const bases = [];
  for (const value of [deployBase].flat()) {
    if (typeof value !== "string" || !value.trim()) continue;
    const url = parseUrl(value.trim());
    if (!url || !WEB_PROTOCOLS.has(url.protocol)) continue;
    bases.push({ origin: url.origin, host: url.host, prefix: url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/` });
  }
  return bases;
}
