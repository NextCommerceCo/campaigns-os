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
// not exist on disk is listed on the gate as information, not judged here.
//
// Not waivable: a script that cannot be parsed cannot be intended to ship.
// Both doctor entry points drive it, like the other static built-output gates.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";

import { parse as parseJs } from "acorn";
import { parse as parseHtml } from "parse5";

export const SCRIPT_SYNTAX = "built_output.script_syntax";
export const SCRIPT_SYNTAX_PARSE_FAILURE = `${SCRIPT_SYNTAX}.parse_failure`;

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

/**
 * `<script src>` references on a page, in document order, with whether each
 * is a module, and the document's first `<base href>` (null when none).
 * Data-block types are dropped. Classic `nomodule` scripts are dropped: a
 * module-capable browser never fetches or runs them, so they cannot fail on
 * load there. A module script ignores `nomodule` and is kept (see scriptKind). Template content and noscript are inert and not walked.
 *
 * @param {string} html
 * @returns {{ base: string | null, refs: Array<{ src: string, module: boolean }> }}
 */
export function pageScriptDocument(html) {
  const refs = [];
  let base = null;
  let document;
  try {
    document = parseHtml(String(html ?? ""));
  } catch {
    return { base, refs };
  }
  const walk = (node) => {
    const attrs = node.tagName ? Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value])) : {};
    if (node.tagName === "base" && base === null && typeof attrs.href === "string") base = attrs.href.trim();
    if (node.tagName === "script") {
      const kind = scriptKind(attrs);
      if (kind && typeof attrs.src === "string" && attrs.src.trim()) {
        refs.push({ src: attrs.src.trim(), module: kind === "module" });
      }
    }
    if (node.tagName === "noscript") return;
    for (const child of node.childNodes || []) walk(child);
  };
  walk(document);
  return { base, refs };
}

/** The `<script src>` references of pageScriptDocument, without the base. */
export function pageScriptReferences(html) {
  return pageScriptDocument(html).refs;
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
// document's effective base. null when that URL is not on the built origin.
function resolveScriptUrl(src, base, pageUrl) {
  let baseUrl;
  try {
    baseUrl = base ? new URL(base, pageUrl) : new URL(pageUrl);
  } catch {
    baseUrl = new URL(pageUrl);
  }
  let url;
  try {
    url = new URL(src, baseUrl);
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

function relFrom(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
}

/**
 * Resolve every built page's local script references against the filesystem.
 * Each src resolves as the browser resolves it: against the document's
 * effective base (its first `<base href>`, else the page URL), with the page
 * URL being its path under the site root. The resulting path is
 * percent-decoded and mapped under the site root first (page-kit emits
 * `/<slug>/js/...`), then the campaign directory (a root-served campaign
 * emits `/js/...`), never outside either. A base or src on another origin is
 * remote and not read.
 *
 * @param {{ site_root: string, campaign_dir: string, pages: Array<{ page_id: string, built_path: string }> }} scope
 * @param {string} targetRepo
 */
export function collectBuiltScriptSyntaxInputs(scope, targetRepo) {
  const scripts = new Map();
  const unresolved = new Map();
  const pages = Array.isArray(scope?.pages) ? scope.pages : [];
  for (const page of pages) {
    let html;
    try {
      html = readFileSync(page.built_path, "utf8");
    } catch {
      continue;
    }
    const { base, refs } = pageScriptDocument(html);
    const pageUrl = pageUrlFor(scope.site_root, page.built_path);
    for (const ref of refs) {
      if (isRemote(ref.src)) continue;
      const { remote, pathname } = resolveScriptUrl(ref.src, base, pageUrl);
      if (remote) continue;
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
        const entry = unresolved.get(ref.src) || { src: ref.src, pages: [] };
        if (!entry.pages.includes(page.page_id)) entry.pages.push(page.page_id);
        unresolved.set(ref.src, entry);
        continue;
      }
      const key = `${resolve(path)}\u0000${ref.module ? "module" : "script"}`;
      if (!scripts.has(key)) {
        let content = null;
        try {
          content = readFileSync(path, "utf8");
        } catch {
          content = null;
        }
        if (content == null) continue;
        scripts.set(key, { file: relFrom(targetRepo, resolve(path)), module: ref.module, content, pages: [] });
      }
      const entry = scripts.get(key);
      if (!entry.pages.includes(page.page_id)) entry.pages.push(page.page_id);
    }
  }
  return { pages_scanned: pages.length, scripts: [...scripts.values()], unresolved: [...unresolved.values()] };
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
 * Evaluate the syntax of the campaign-owned scripts built pages load. Pure:
 * the caller hands in script contents.
 *
 * @param {{ subject?: object, pages_scanned?: number,
 *   scripts?: Array<{ file: string, module?: boolean, content: string, pages?: string[] }>,
 *   unresolved?: Array<{ src: string, pages: string[] }> }} input
 */
export function evaluateBuiltScriptSyntax({ subject, pages_scanned: pagesScanned = 0, scripts = [], unresolved = [] } = {}) {
  const list = Array.isArray(scripts) ? scripts : [];
  const missing = Array.isArray(unresolved) ? unresolved : [];
  if (list.length === 0) {
    return {
      ...gateBase(subject),
      status: "not_applicable",
      code: `${SCRIPT_SYNTAX}.not_applicable`,
      reason: pagesScanned
        ? `No built page loads a campaign-owned script from disk (${pagesScanned} page(s) read).`
        : "No built page was available to scan; script syntax is checked once pages are built.",
      findings: [],
      scripts_scanned: 0,
      scripts_unresolved: missing,
      pages_scanned: pagesScanned,
      required_actions: [],
    };
  }

  const findings = [];
  for (const script of list) {
    const failure = parseScriptSyntax(script.content, { module: Boolean(script.module) });
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
      reason: `${findings.length} of ${list.length} campaign-owned script(s) do not parse: ${findings.map((finding) => `${finding.file}:${finding.line}:${finding.column}`).join(", ")}.`,
      findings,
      scripts_scanned: list.length,
      scripts_unresolved: missing,
      pages_scanned: pagesScanned,
      required_actions: findings.map((finding) => `Fix the syntax error in ${finding.file} at line ${finding.line}, column ${finding.column}, then rebuild.`),
    };
  }

  return {
    ...gateBase(subject),
    status: "pass",
    code: `${SCRIPT_SYNTAX}.pass`,
    reason: `All ${list.length} campaign-owned script(s) loaded by ${pagesScanned} built page(s) parse.`,
    findings: [],
    scripts_scanned: list.length,
    scripts_unresolved: missing,
    pages_scanned: pagesScanned,
    required_actions: [],
  };
}
