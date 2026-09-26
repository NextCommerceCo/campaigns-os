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
import { dirname, join, relative, resolve, sep } from "node:path";

import { parse as parseJs } from "acorn";
import { parse as parseHtml } from "parse5";

export const SCRIPT_SYNTAX = "built_output.script_syntax";
export const SCRIPT_SYNTAX_PARSE_FAILURE = `${SCRIPT_SYNTAX}.parse_failure`;

// Classic script MIME types the browser executes. Anything else with a type
// attribute (JSON-LD, text/template, importmap) is a data block, not script.
const CLASSIC_SCRIPT_TYPE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^text\/(?:javascript1\.[0-5]|jscript|livescript)$/i;

/**
 * Parse one script the way the browser would read it.
 *
 * @param {string} source
 * @param {{ module?: boolean }} [options]
 * @returns {null | { line: number, column: number, message: string }}
 *   null when the source parses; otherwise the 1-based position and acorn's
 *   message without its trailing "(line:col)".
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
    const line = Number.isInteger(error?.loc?.line) ? error.loc.line : 1;
    const column = Number.isInteger(error?.loc?.column) ? error.loc.column + 1 : 1;
    const message = String(error?.message || "Unparsable script").replace(/\s*\(\d+:\d+\)$/, "");
    return { line, column, message };
  }
}

/**
 * `<script src>` references on a page, in document order, with whether each
 * is a module. Data-block types are dropped. Template content and noscript
 * are inert and not walked.
 *
 * @param {string} html
 * @returns {Array<{ src: string, module: boolean }>}
 */
export function pageScriptReferences(html) {
  const refs = [];
  let document;
  try {
    document = parseHtml(String(html ?? ""));
  } catch {
    return refs;
  }
  const walk = (node) => {
    if (node.tagName === "script") {
      const attrs = Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value]));
      const type = typeof attrs.type === "string" ? attrs.type.trim() : "";
      const module = type.toLowerCase() === "module";
      if (typeof attrs.src === "string" && attrs.src.trim() && (!type || module || CLASSIC_SCRIPT_TYPE.test(type))) {
        refs.push({ src: attrs.src.trim(), module });
      }
    }
    if (node.tagName === "noscript") return;
    for (const child of node.childNodes || []) walk(child);
  };
  walk(document);
  return refs;
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
 * Absolute srcs resolve against the site root first (page-kit emits
 * `/<slug>/js/...`), then the campaign directory (a root-served campaign emits
 * `/js/...`); relative srcs resolve against the page. The same rule the
 * campaign identity gate follows.
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
    for (const ref of pageScriptReferences(html)) {
      if (isRemote(ref.src)) continue;
      const clean = ref.src.replace(/[?#].*$/, "");
      if (!clean) continue;
      let path;
      if (clean.startsWith("/")) {
        const rel = clean.replace(/^\/+/, "");
        const candidates = [join(scope.site_root, rel), join(scope.campaign_dir, rel)];
        path = candidates.find((candidate) => existsSync(candidate)) || null;
      } else {
        path = resolve(dirname(page.built_path), clean);
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
