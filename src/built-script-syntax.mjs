// Built-output script syntax gate (#480).
//
// A campaign-owned script that does not parse throws a SyntaxError on every
// load of every page that references it, and nothing it defines runs. The
// shape that shipped: a template-family checkout script copied and
// hand-edited, left with one closing `});` too many. Page Kit built it, every
// other doctor gate read the HTML and passed, and doctor reported the build
// ready.
//
// This gate parses every campaign-owned `.js` file a built page loads by a
// LOCAL `<script src>`, with acorn at the latest ecmaVersion: `sourceType:
// 'script'` for classic scripts and `'module'` for `type="module"`, which is
// how the browser reads each. A parse failure is an error naming the file, the
// line and the column. Remote scripts (CDN URLs, protocol-relative, data:)
// are not campaign-owned and are not read. A referenced local file that does
// not exist on disk is a warning (#502): the browser gets a 404 for it and
// nothing it would define runs, but whether the page needs it is not known
// here, so it does not block.
//
// Two shapes are not read and only warn (#515). A `<script>` left unclosed at
// the end of the file never runs: the browser does not prepare a script
// element whose end tag never arrives. And a script that is a symlink, or
// sits under a symlinked directory, resolving outside the site root: a static
// server would follow it, but its bytes are not part of the built output. A
// symlink that stays inside the site root is read where it points.
//
// Not waivable: a script that cannot be parsed cannot be intended to ship.
// Both doctor entry points drive it, like the other static built-output gates.

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";

import { parse as parseJs } from "acorn";
import { parse as parseHtml } from "parse5";

import { htmlScanMemo, htmlScanScriptPrograms, readHtmlScanText } from "./html-scan.mjs";

export const SCRIPT_SYNTAX = "built_output.script_syntax";
export const SCRIPT_SYNTAX_PARSE_FAILURE = `${SCRIPT_SYNTAX}.parse_failure`;
export const SCRIPT_SYNTAX_MISSING_SCRIPT = `${SCRIPT_SYNTAX}.missing_script`;
export const SCRIPT_SYNTAX_UNCLOSED_SCRIPT = `${SCRIPT_SYNTAX}.unclosed_script`;
export const SCRIPT_SYNTAX_SYMLINK_OUTSIDE_SITE = `${SCRIPT_SYNTAX}.symlink_outside_site`;

// Classic script MIME types the browser executes. Anything else with a type
// attribute (JSON-LD, text/template, importmap) is a data block, not script.
const CLASSIC_SCRIPT_TYPE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^text\/(?:javascript1\.[0-5]|jscript|livescript)$/i;

/**
 * How a module-capable browser treats a `<script>` element, from its
 * attributes: "classic", "module", or null when it never runs it. Follows the
 * HTML "prepare the script element" steps: an absent or empty type (or, with
 * no type, an absent or empty language) is classic; otherwise the type has
 * leading and trailing ASCII whitespace stripped and is compared
 * ASCII-case-insensitively. `nomodule` stops only classic scripts; a module
 * script ignores it.
 *
 * @param {Record<string, string>} attrs
 * @returns {"classic" | "module" | null}
 */
export function scriptKind(attrs) {
  // The script block's type string, as the HTML steps build it: an empty
  // type, or no type with an empty or absent language, is text/javascript; a
  // type attribute is stripped of ASCII whitespace; otherwise "text/" plus the
  // language attribute, unstripped.
  const hasType = typeof attrs.type === "string";
  const hasLanguage = typeof attrs.language === "string";
  let type;
  if (hasType ? attrs.type === "" : !hasLanguage || attrs.language === "") type = "text/javascript";
  else if (hasType) type = attrs.type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  else type = `text/${attrs.language}`;
  let kind = null;
  if (type.toLowerCase() === "module") kind = "module";
  else if (CLASSIC_SCRIPT_TYPE.test(type)) kind = "classic";
  if (kind === "classic" && "nomodule" in attrs) return null;
  return kind;
}

// Acorn messages that are fixed text. Anything else interpolates source text
// (an identifier, a regex body, a character) and is reduced to its category,
// so a token at the error site never reaches doctor or QA output.
const FIXED_PARSE_MESSAGES = new Set([
  "Unexpected token", "Unterminated string constant", "Unterminated template", "Unterminated template literal",
  "Unterminated regular expression", "Unterminated comment", "Invalid regular expression flag",
  "Duplicate regular expression flag", "Invalid number", "Identifier directly after number", "Assigning to rvalue",
  "'return' outside of function", "'import' and 'export' may appear only with 'sourceType: module'",
  "'import' and 'export' may only appear at the top level", "Cannot use 'import.meta' outside a module",
  "Cannot use keyword 'await' outside an async function", "'super' keyword outside a method",
  "super() call outside constructor of a subclass", "Illegal newline after throw", "Missing catch or finally clause",
  "Multiple default clauses", "Argument name clash", "Redefinition of property", "Redefinition of __proto__ property",
  "Bad escape sequence in untagged template literal", "Invalid use of 'super'", "'with' in strict mode",
  "Deleting local variable in strict mode", "let is disallowed as a lexically bound name",
  "Shorthand property assignments are valid only in destructuring patterns",
  "Complex binding patterns require an initialization value", "Comma is not permitted after the rest element",
  "Binding member expression", "Binding parenthesized expression", "Not enough stack space to parse input",
  "Optional chaining cannot appear in left-hand side",
  "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses",
]);
const PARSE_MESSAGE_CATEGORIES = [
  [/^Invalid regular expression\b/, "Invalid regular expression"],
  [/^Identifier .* has already been declared$/, "Identifier has already been declared"],
  [/^Unexpected character\b/, "Unexpected character"],
  [/^Unexpected keyword\b/, "Unexpected keyword"],
  [/^The keyword .* is reserved$/, "Reserved keyword"],
  [/^Label .* is already declared$/, "Duplicate label"],
  [/^Duplicate export\b/, "Duplicate export"],
  [/^Undefined export\b/, "Undefined export"],
  [/^Unsyntactic (?:break|continue)$/, "Unsyntactic break or continue"],
  [/^Escape sequence in keyword\b/, "Escape sequence in keyword"],
  [/^Private field\b/, "Undeclared private field"],
  [/^Expected number in radix\b/, "Invalid number"],
  [/in strict mode$/, "Not allowed in strict mode"],
];

/**
 * A parser error as a fixed-vocabulary category plus a 1-based position. The
 * message never carries source text: acorn interpolates identifiers, regex
 * bodies and characters from the script into some messages.
 *
 * @param {unknown} error
 * @returns {{ line: number, column: number, message: string }}
 */
export function parseFailureDiagnostic(error) {
  const line = Number.isInteger(error?.loc?.line) ? error.loc.line : 1;
  const column = Number.isInteger(error?.loc?.column) ? error.loc.column + 1 : 1;
  const raw = String(error?.message || "").replace(/\s*\(\d+:\d+\)$/, "");
  let message = "Syntax error";
  if (FIXED_PARSE_MESSAGES.has(raw)) message = raw;
  else {
    const category = PARSE_MESSAGE_CATEGORIES.find(([pattern]) => pattern.test(raw));
    if (category) message = category[1];
  }
  return { line, column, message };
}

/**
 * Parse one script the way the browser would read it.
 *
 * @param {string} source
 * @param {{ module?: boolean }} [options]
 * @returns {null | { line: number, column: number, message: string }}
 *   null when the source parses; otherwise the 1-based position and a
 *   source-free diagnostic category (see parseFailureDiagnostic).
 */
export function parseScriptSyntax(source, { module = false } = {}) {
  try {
    parseJs(String(source ?? ""), {
      ecmaVersion: "latest",
      sourceType: module ? "module" : "script",
      allowHashBang: true,
      locations: true,
    });
    return null;
  } catch (error) {
    return parseFailureDiagnostic(error);
  }
}

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * A URL attribute value as the URL parser reads it: leading and trailing C0
 * controls and space removed, nothing else (not U+00A0 or other Unicode
 * whitespace, which String#trim would also strip).
 *
 * @param {string} value
 */
export function stripUrlSpace(value) {
  return String(value).replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

/**
 * Every HTML-namespace `<base href>` in a parse5 document (parsed with
 * `sourceCodeLocationInfo`), in tree order, with the source offset at which
 * the parser inserted it. An SVG or MathML `base` is not a base element.
 *
 * @param {object} root a parse5 node
 * @returns {Array<{ href: string, offset: number }>}
 */
export function documentBases(root) {
  const bases = [];
  const walk = (node) => {
    if (node.tagName === "base" && node.namespaceURI === HTML_NAMESPACE) {
      const href = (node.attrs || []).find((attr) => attr.name === "href");
      if (href) bases.push({ href: href.value, offset: node.sourceCodeLocation?.startOffset ?? -1 });
    }
    // Template content is a separate fragment in parse5 and never walked here.
    for (const child of node.childNodes || []) walk(child);
  };
  walk(root);
  return bases;
}

/**
 * The `<base href>` in effect when the parser prepares a script element: the
 * parser prepares it at its end tag, and "prepare the script element" parses
 * `src` then, against the document base URL, which is the first base element
 * with an href in tree order among those already in the document. Foster
 * parenting can place a base parsed earlier after the script in tree order
 * (it still counts) or one parsed later before it (it does not), so this
 * compares source offsets rather than tree position. null when no base was
 * in the document yet.
 *
 * @param {Array<{ href: string, offset: number }>} bases from documentBases
 * @param {object} scriptNode a parse5 script element
 * @returns {string | null}
 */
export function baseInEffect(bases, scriptNode) {
  const location = scriptNode?.sourceCodeLocation;
  const preparedAt = location?.endTag?.startOffset ?? location?.endOffset ?? Infinity;
  const base = bases.find((entry) => entry.offset < preparedAt);
  return base ? base.href : null;
}

/**
 * Whether the file ended inside this parse5 element, before its end tag. The
 * parser prepares a script at its end tag; at end of file it marks the element
 * "already started" instead, so the browser never fetches or runs it.
 *
 * @param {object} node a parse5 element parsed with `sourceCodeLocationInfo`
 */
export function endsUnclosed(node) {
  return Boolean(node?.sourceCodeLocation) && !node.sourceCodeLocation.endTag;
}

/**
 * `<script src>` references on a page, in document order, with whether each
 * is a module and the `<base href>` in effect when the browser prepares it
 * (see baseInEffect), plus the document's first `<base href>` (null when
 * none). A `<base>` parsed after a script does not move it, whether the
 * script is async, deferred or a module: its URL is resolved when prepared,
 * not when fetched.
 *
 * Only HTML-namespace script elements are references: an SVG `<script>`
 * never loads a `src` attribute. Data-block types are dropped. Classic
 * `nomodule` scripts are dropped: a
 * module-capable browser never fetches or runs them, so they cannot fail on
 * load there. A module script ignores `nomodule` and is kept (see scriptKind).
 * Template content and noscript are inert and not walked.
 *
 * A script element the file ends inside (its end tag never arrives) is never
 * prepared, so it never runs and is not a reference. It is returned in
 * `unclosed` instead: its src, or null for an inline script.
 *
 * @param {string} html
 * @returns {{ base: string | null, refs: Array<{ src: string, module: boolean, base: string | null }>, unclosed: Array<{ src: string | null }> }}
 */
export function pageScriptDocument(html) {
  const refs = [];
  const unclosed = [];
  let document;
  try {
    document = parseHtml(String(html ?? ""), { sourceCodeLocationInfo: true });
  } catch {
    return { base: null, refs, unclosed };
  }
  const bases = documentBases(document);
  const walk = (node) => {
    const attrs = node.tagName ? Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value])) : {};
    // Only an HTML-namespace <script> loads its `src`; an SVG script reads
    // href / xlink:href, and a MathML "script" is not a script element.
    if (node.tagName === "script" && node.namespaceURI === HTML_NAMESPACE) {
      const kind = scriptKind(attrs);
      const hasSrc = typeof attrs.src === "string" && attrs.src !== "";
      if (kind && endsUnclosed(node)) {
        unclosed.push({ src: hasSrc ? stripUrlSpace(attrs.src) : null });
      // "prepare the script element" skips only an empty src; anything else,
      // even whitespace, is parsed as a URL and fetched.
      } else if (kind && hasSrc) {
        refs.push({ src: stripUrlSpace(attrs.src), module: kind === "module", base: baseInEffect(bases, node) });
      }
    }
    if (node.tagName === "noscript") return;
    for (const child of node.childNodes || []) walk(child);
  };
  walk(document);
  return { base: bases[0]?.href ?? null, refs, unclosed };
}

/**
 * The frozen base URL of a `<base href>` (HTML "set the frozen base URL"):
 * the href parsed against the document's fallback base URL (its own URL),
 * falling back to that URL when the parse fails or yields a `data:` or
 * `javascript:` URL, which the browser refuses as a base.
 *
 * @param {string | null} href the base element's href, or null for none
 * @param {string} documentUrl
 * @returns {string} the URL scripts resolve against
 */
export function frozenBaseUrl(href, documentUrl) {
  if (href === null || href === undefined) return documentUrl;
  let url;
  try {
    url = new URL(href, documentUrl);
  } catch {
    return documentUrl;
  }
  return url.protocol === "data:" || url.protocol === "javascript:" ? documentUrl : url.href;
}

/** The `<script src>` references of pageScriptDocument, without any base. */
export function pageScriptReferences(html) {
  return pageScriptDocument(html).refs.map(({ src, module }) => ({ src, module }));
}

// A synthetic origin standing in for wherever the built site is served. Page
// URLs are their path under the site root; a script URL on any other origin
// is not campaign-owned.
const BUILT_ORIGIN = "http://built-site.invalid";

function pageUrlFor(siteRoot, builtPath) {
  const rel = relative(siteRoot, builtPath);
  const segments = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep) : [basename(builtPath)];
  return `${BUILT_ORIGIN}/${segments.map(encodeURIComponent).join("/")}`;
}

// The browser's view of one reference: the URL it resolves to against the
// base in effect when the script was prepared. null when that URL is not on
// the built origin.
function resolveScriptUrl(src, base, pageUrl) {
  let url;
  try {
    url = new URL(src, frozenBaseUrl(base, pageUrl));
  } catch {
    return { remote: false, pathname: null };
  }
  if (url.origin !== BUILT_ORIGIN) return { remote: true, pathname: null };
  return { remote: false, pathname: url.pathname };
}

// Decode a URL path the way a static server does before it maps it onto the
// disk, then keep it inside `root`. null for a malformed escape, a NUL, or a
// path that escapes the root.
function fileUnder(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rootAbs = resolve(root);
  const path = resolve(rootAbs, `.${posix.normalize(`/${decoded.replace(/\\/g, "/")}`)}`);
  return path === rootAbs || path.startsWith(`${rootAbs}${sep}`) ? path : null;
}

function isRemote(src) {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

// The real path of a file, or null when it cannot be resolved.
function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function relFrom(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
}

/**
 * Every built page's `<script src>` references, resolved against the
 * filesystem once per inspection: the shared script input of the doctor's
 * html-scan context (#730). Each src resolves as the browser resolves it:
 * against the base in effect when the script is prepared (the first `<base
 * href>` before it in tree order, else the page URL; a `data:`, `javascript:`
 * or unparsable base falls back to the page URL), with the page URL being its
 * path under the site root. The resulting path is percent-decoded and mapped
 * under the site root first (page-kit emits `/<slug>/js/...`), then the
 * campaign directory (a root-served campaign emits `/js/...`), never outside
 * either. A base or src on another origin is `remote`.
 *
 * One flat record per reference, in page then document order: `local` (a
 * file, read where a static server would serve it, at `path` as spelled),
 * `missing` (no file; `url_key` is the URL the browser resolves, or the raw
 * src when it resolves to none), `outside_site` (its real path leaves the site
 * root: a symlinked file or directory pointing elsewhere; `path` is the link)
 * or `remote`. A page that cannot be read contributes nothing; one that ends
 * inside a script element is listed in `unclosed`. No script is read here:
 * each consumer reads the bytes it needs and decides what an unreadable one
 * means.
 *
 * @param {{ site_root: string, campaign_dir: string, pages: Array<{ page_id: string, built_path: string }> }} scope
 */
export function builtScriptReferences(scope) {
  const pages = Array.isArray(scope?.pages) ? scope.pages : [];
  const key = ["built-script-references", scope?.site_root, scope?.campaign_dir, ...pages.flatMap((page) => [page.page_id, page.built_path])];
  return htmlScanMemo(JSON.stringify(key), () => resolveScriptReferences(scope, pages));
}

function resolveScriptReferences(scope, pages) {
  const refs = [];
  const unclosed = [];
  const siteRootReal = scope?.site_root ? realPathOf(scope.site_root) : null;
  for (const page of pages) {
    let html;
    try {
      html = readHtmlScanText(page.built_path);
    } catch {
      continue;
    }
    const document = pageScriptDocument(html);
    // One entry per page: the file ends inside at most one script, and the
    // warning is about the page's truncated output.
    if (document.unclosed.length) unclosed.push({ page_id: page.page_id, src: document.unclosed[0].src });
    const pageUrl = pageUrlFor(scope.site_root, page.built_path);
    for (const ref of document.refs) {
      const record = { page_id: page.page_id, src: ref.src, module: ref.module, url_key: null, path: null };
      const { remote, pathname } = isRemote(ref.src) ? { remote: true } : resolveScriptUrl(ref.src, ref.base, pageUrl);
      if (remote) {
        refs.push({ ...record, status: "remote" });
        continue;
      }
      let path = null;
      if (pathname) {
        const candidates = [fileUnder(scope.site_root, pathname), fileUnder(scope.campaign_dir, pathname)].filter(Boolean);
        path = candidates.find((candidate) => existsSync(candidate)) || null;
      }
      let isFile = false;
      try {
        isFile = Boolean(path) && existsSync(path) && statSync(path).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        refs.push({ ...record, url_key: pathname ?? `\u0000${ref.src}`, status: "missing" });
        continue;
      }
      // Served only while the real path stays inside the site root. When
      // either real path is unknown the check is undecidable, and the script
      // counts as local.
      const real = realPathOf(path);
      const outside = siteRootReal && real && real !== siteRootReal && !real.startsWith(`${siteRootReal}${sep}`);
      refs.push({ ...record, path: resolve(path), status: outside ? "outside_site" : "local" });
    }
  }
  return { pages_scanned: pages.length, refs, unclosed };
}

/**
 * The script syntax gate's inputs, projected from builtScriptReferences.
 * Missing scripts are keyed by the URL the browser resolves, so two spellings
 * of one URL (`check&#9;out.js`, `checkout.js`) are one entry, under the first
 * spelling met. A symlink leaving the site root is not read and is listed in
 * `outside_site` by the link's own path. Readable scripts are keyed by path
 * and mode: the same bytes can pass as a module and fail as a classic script.
 * Each carries `syntax`, computed on first read: null when it parses, else
 * its parseScriptSyntax diagnostic, from the run's shared parse
 * (htmlScanScriptPrograms).
 *
 * @param {{ site_root: string, campaign_dir: string, pages: Array<{ page_id: string, built_path: string }> }} scope
 * @param {string} targetRepo
 */
export function collectBuiltScriptSyntaxInputs(scope, targetRepo) {
  const scripts = new Map();
  const unresolved = new Map();
  const outsideSite = new Map();
  const { pages_scanned: pagesScanned, refs, unclosed } = builtScriptReferences(scope);
  const onPage = (entry, pageId) => {
    if (!entry.pages.includes(pageId)) entry.pages.push(pageId);
  };
  for (const ref of refs) {
    if (ref.status === "missing") {
      if (!unresolved.has(ref.url_key)) unresolved.set(ref.url_key, { src: ref.src, pages: [] });
      onPage(unresolved.get(ref.url_key), ref.page_id);
    } else if (ref.status === "outside_site") {
      const file = relFrom(targetRepo, ref.path);
      if (!outsideSite.has(file)) outsideSite.set(file, { file, src: ref.src, pages: [] });
      onPage(outsideSite.get(file), ref.page_id);
    } else if (ref.status === "local") {
      const key = `${ref.path}\u0000${ref.module ? "module" : "script"}`;
      if (!scripts.has(key)) {
        let content;
        try {
          content = readHtmlScanText(ref.path);
        } catch {
          continue;
        }
        scripts.set(key, { path: ref.path, file: relFrom(targetRepo, ref.path), module: ref.module, content, pages: [] });
      }
      onPage(scripts.get(key), ref.page_id);
    }
  }
  // Each script is parsed once per run and mode, through the run's shared
  // programs (the API/storage observations read the same set), with the same
  // options as parseScriptSyntax, so the diagnostic is the same. The parse is
  // lazy: `syntax` is computed on first read, so a caller that wants only the
  // references (the fixture refresh) parses nothing. The parse-budget
  // reservation is not: inside a snapshot, htmlScanScriptPrograms charges the
  // whole set when called here, whether or not `syntax` is read. Outside one
  // it reserves nothing.
  const programs = htmlScanScriptPrograms([...scripts.values()]);
  const parsed = [...scripts.values()].map(({ path, ...script }) => {
    let syntax;
    return Object.defineProperty(script, "syntax", {
      enumerable: true,
      // Configurable, so a caller can `delete` it.
      configurable: true,
      get() {
        if (syntax !== undefined) return syntax;
        try {
          programs(path, script.module, script.content);
          syntax = null;
        } catch (error) {
          syntax = parseFailureDiagnostic(error);
        }
        return syntax;
      },
    });
  });
  return {
    pages_scanned: pagesScanned,
    scripts: parsed,
    unresolved: [...unresolved.values()],
    outside_site: [...outsideSite.values()],
    unclosed: unclosed.map((entry) => ({ src: entry.src, pages: [entry.page_id] })),
  };
}

function gateBase(subject) {
  return {
    id: SCRIPT_SYNTAX,
    scope: SCRIPT_SYNTAX,
    waivable: false,
    subject: subject && typeof subject === "object" ? subject : {},
    waiver: null,
  };
}

/**
 * Evaluate the syntax of the campaign-owned scripts built pages load. The
 * caller hands in each script's content and, optionally, its parse result as
 * `syntax` (null when it parses). A `syntax` that is not undefined wins over
 * `content`: the evaluator trusts it and does not parse again, so a caller
 * that changes `content` after collection must drop `syntax` too (`delete
 * script.syntax`, or a copy without it; the adapter's `syntax` is a getter,
 * so it cannot be assigned). Without
 * one, the evaluator parses `content` itself and reads nothing else.
 *
 * @param {{ subject?: object, pages_scanned?: number,
 *   scripts?: Array<{ file: string, module?: boolean, content: string, pages?: string[], syntax?: null | { line: number, column: number, message: string } }>,
 *   unresolved?: Array<{ src: string, pages: string[] }>,
 *   outside_site?: Array<{ file: string, src: string, pages: string[] }>,
 *   unclosed?: Array<{ src: string | null, pages: string[] }> }} input
 */
export function evaluateBuiltScriptSyntax({ subject, pages_scanned: pagesScanned = 0, scripts = [], unresolved = [], outside_site: outsideSite = [], unclosed = [] } = {}) {
  const list = Array.isArray(scripts) ? scripts : [];
  const missing = Array.isArray(unresolved) ? unresolved : [];
  const outside = Array.isArray(outsideSite) ? outsideSite : [];
  const open = Array.isArray(unclosed) ? unclosed : [];
  const onPages = (pages) => (pages.length ? ` on ${pages.join(", ")}` : "");
  // A local script the page loads that is not in the built output: a 404 at
  // runtime. A warning, not a blocker (#502).
  const warned = missing.map((entry) => {
    const pages = Array.isArray(entry.pages) ? entry.pages : [];
    return {
      code: SCRIPT_SYNTAX_MISSING_SCRIPT,
      src: entry.src,
      pages,
      message: `${entry.src} is loaded by a local <script src>${onPages(pages)} but is not in the built output. The browser gets a 404 for it and nothing it would define runs. Add the file to the build, or remove the reference if the page does not need it.`,
    };
  });
  // A script symlink whose target is outside the site root (#515): not read,
  // and named by the link, never by where it points.
  for (const entry of outside) {
    const pages = Array.isArray(entry.pages) ? entry.pages : [];
    warned.push({
      code: SCRIPT_SYNTAX_SYMLINK_OUTSIDE_SITE,
      file: entry.file,
      src: entry.src,
      pages,
      message: `${entry.file} is loaded by a local <script src>${onPages(pages)} but is a symlink whose target is outside the site root, so its syntax was not checked. A static server may still serve it. Copy the script into the build output instead of linking to it.`,
    });
  }
  // A page that ends inside a script element (#515): the browser never runs
  // that script, so it is not parsed. The page output is probably truncated.
  for (const entry of open) {
    const pages = Array.isArray(entry.pages) ? entry.pages : [];
    warned.push({
      code: SCRIPT_SYNTAX_UNCLOSED_SCRIPT,
      src: entry.src ?? null,
      pages,
      message: `${entry.src ? `The <script src="${entry.src}">` : "An inline <script>"}${onPages(pages)} is never closed: the page ends before its </script>. The browser does not run a script element whose end tag never arrives, so it was not parsed. Check the page for truncated output and rebuild.`,
    });
  }
  const notes = [
    missing.length ? ` ${missing.length} referenced local script(s) are not in the built output.` : "",
    outside.length ? ` ${outside.length} script symlink(s) resolve outside the site root and were not read.` : "",
    open.length ? ` ${open.length} page(s) end inside an unclosed <script>.` : "",
  ];
  const missingNote = notes.join("");
  const common = { scripts_unresolved: missing, scripts_outside_site: outside, warned, pages_scanned: pagesScanned };
  if (list.length === 0) {
    return {
      ...gateBase(subject),
      status: "not_applicable",
      code: `${SCRIPT_SYNTAX}.not_applicable`,
      reason: (pagesScanned
        ? `No built page loads a campaign-owned script from disk (${pagesScanned} page(s) read).`
        : "No built page was available to scan; script syntax is checked once pages are built.") + missingNote,
      findings: [],
      scripts_scanned: 0,
      ...common,
      required_actions: [],
    };
  }

  const findings = [];
  for (const script of list) {
    // `syntax` (null: parses) is the adapter's result from the run's shared
    // parse; without one (undefined), the content is parsed here.
    const failure = script.syntax === undefined ? parseScriptSyntax(script.content, { module: Boolean(script.module) }) : script.syntax;
    if (!failure) continue;
    const pages = Array.isArray(script.pages) ? script.pages : [];
    findings.push({
      code: SCRIPT_SYNTAX_PARSE_FAILURE,
      file: script.file,
      line: failure.line,
      column: failure.column,
      source_type: script.module ? "module" : "script",
      pages,
      message: `${script.file}:${failure.line}:${failure.column}: ${failure.message}. The browser throws a SyntaxError loading this ${script.module ? "module" : "script"}${pages.length ? ` on ${pages.join(", ")}` : ""}, and nothing in it runs. Fix the syntax at that position (a stray or missing bracket is the usual cause) and rebuild.`,
    });
  }

  if (findings.length) {
    return {
      ...gateBase(subject),
      status: "blocked",
      code: SCRIPT_SYNTAX_PARSE_FAILURE,
      reason: `${findings.length} of ${list.length} campaign-owned script(s) do not parse: ${findings.map((finding) => `${finding.file}:${finding.line}:${finding.column}`).join(", ")}.${missingNote}`,
      findings,
      scripts_scanned: list.length,
      ...common,
      required_actions: findings.map((finding) => `Fix the syntax error in ${finding.file} at line ${finding.line}, column ${finding.column}, then rebuild.`),
    };
  }

  return {
    ...gateBase(subject),
    status: "pass",
    code: `${SCRIPT_SYNTAX}.pass`,
    reason: `All ${list.length} campaign-owned script(s) loaded by ${pagesScanned} built page(s) parse.${missingNote}`,
    findings: [],
    scripts_scanned: list.length,
    ...common,
    required_actions: [],
  };
}
