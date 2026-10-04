// Raw cart placeholders (built_output.cart_placeholders).
//
// Flags a known Campaign Cart template placeholder ({item.name}, {subtotal},
// {package.name} ...) that sits in live built HTML outside every SDK-owned
// scope, where the shopper sees it as raw text. A sibling doctor gate, kept
// out of sdk_markup (which withholds warnings while its blockers stand) and
// out of validateBuiltHtmlStructure (which escalates warnings to errors), so
// a placeholder is always a warning and never a blocker.
//
// Ported from the public starter-template lint:
//   NextCommerceCo/campaign-cart-starter-templates@1bfa99b:
//   scripts/lib/sdk-template-token-lint.mjs:24-60 (findLiveSdkTemplateTokens)
// Differences from the starter: it reads built HTML instead of Liquid source;
// it knows every renderer namespace (item, line, discount, property, package,
// bundle, toggle); live item lists, their declared row templates and the
// SDK-substituted quantity tokens are owned; only text nodes and the
// attributes that render or are announced as text are scanned; brace strings
// that are not known placeholders are review results; and every page reads
// its SDK pin from its own loader, with page, size, candidate and result caps.
//
// Results (one per page and token or shape; doctor issue code
// built_output.cart_placeholders.<reason_code>):
//   warning     live_token                    known placeholder, unowned
//   review      unknown_brace                 unknown brace shape, unowned
//   review      template_selector_unresolved  unowned candidate on a page
//                                             whose item template selector
//                                             is not an #id
//   pass        (page)                        parsed in full, no unowned
//                                             candidate, verified pin
//   unexercised (page) sdk_pin_unverified, sdk_pin_unknown, page_unreadable
//               (also nesting deeper than a browser parser builds),
//               page_too_large, page_cap_reached, candidate_cap_reached,
//               finding_cap_reached
// A page that reached a cap or could not be read never passes, and every
// result kept on a capped page carries the capped-page member, so none of
// them is accept-eligible. Unknown brace strings are kept only as a sha256.
//
// Pure: callers hand in built HTML. Both doctor entry points drive it.

import { createHash } from "node:crypto";

import { defaultTreeAdapter, parse } from "parse5";

import { aggregateQcResults, buildQcResult } from "./qc-results.mjs";
import { SDK_TEMPLATE_PLACEHOLDERS, SDK_TEMPLATE_PLACEHOLDERS_VERIFIED_PINS } from "./sdk-attribute-index.mjs";
import { TEMPLATE_CONTAINER_ATTRIBUTES, TEMPLATE_ID_ATTRIBUTES } from "./sdk-markup.mjs";

export const CART_PLACEHOLDERS = "built_output.cart_placeholders";
export const CART_PLACEHOLDERS_CHECK = "cart_placeholders";
export const CART_PLACEHOLDERS_PAGE_KEY = "page";

// Shared doctor bounds.
export const CART_PLACEHOLDERS_LIMITS = Object.freeze({
  pages: 500,
  page_bytes: 5 * 1024 * 1024,
  candidates: 2000,
  results: 50,
});

export const CART_PLACEHOLDERS_REASONS = Object.freeze({
  LIVE_TOKEN: "live_token",
  UNKNOWN_BRACE: "unknown_brace",
  TEMPLATE_SELECTOR_UNRESOLVED: "template_selector_unresolved",
  SDK_PIN_UNVERIFIED: "sdk_pin_unverified",
  SDK_PIN_UNKNOWN: "sdk_pin_unknown",
  PAGE_UNREADABLE: "page_unreadable",
  PAGE_TOO_LARGE: "page_too_large",
  PAGE_CAP_REACHED: "page_cap_reached",
  CANDIDATE_CAP_REACHED: "candidate_cap_reached",
  FINDING_CAP_REACHED: "finding_cap_reached",
});
const R = CART_PLACEHOLDERS_REASONS;

// The token grammar:
//   known    a bare cart-summary var or live token ({subtotal}, {quantity},
//            {step}), a {qty} form ({qty}, {qty*2}, {qty+1}, {qty-1}), or
//            {<namespace>.<field>[.<field>...]} at any depth in one of the
//            seven namespaces (every namespaced renderer takes any key path)
//   unknown  {name} or {name.field} that is not known
// Any other brace string is not a candidate. A field is any run of
// characters other than a brace or the `.` separator, whitespace included:
// the renderers read every key as /\{([^}]+)\}/ and the package, bundle and
// toggle keys come from arbitrary JSON keys ({toggle.first-name},
// {package.product title}).
// Every single-brace pair is a candidate whatever surrounds it ({item.name}},
// }{item.name}, {{item.name}, {{{item.name}}, {{{item.name}}}); only the
// inner pair of an exactly balanced `{{...}}` (one `{` before, one `}` after,
// and no further brace next to either) is not, being left to sdk_markup's
// double-brace check.
const QTY_FORMS = SDK_TEMPLATE_PLACEHOLDERS.quantity_text.qty_forms;
const FIELD = "[^{}.]+";
const CANDIDATE = new RegExp(`\\{([A-Za-z_][A-Za-z0-9_]*(?:\\.${FIELD})*|${QTY_FORMS})\\}`, "g");
const NAMESPACED = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)(?:\\.${FIELD})+$`);
const UNKNOWN_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?$/;
const QTY = new RegExp(`^(?:${QTY_FORMS})$`);

const KNOWN_BARE = new Set([...SDK_TEMPLATE_PLACEHOLDERS.cart_summary_vars, ...SDK_TEMPLATE_PLACEHOLDERS.live_tokens]);
const KNOWN_NAMESPACES = new Set(SDK_TEMPLATE_PLACEHOLDERS.namespaces);
const VERIFIED_PINS = new Set(SDK_TEMPLATE_PLACEHOLDERS_VERIFIED_PINS);

// Attributes whose values render or are announced as text. `value` counts
// only on a button-like input.
const TEXT_ATTRIBUTES = new Set(["alt", "title", "placeholder", "aria-label"]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset"]);
// Never painted, never scanned.
const UNSCANNED_ELEMENTS = new Set(["script", "style"]);

// The ownership attributes. An element owns only when its attribute value is
// exactly one of `values` (case and whitespace included: INCREASE or
// " increase " owns nothing); with no `values` the SDK selects the attribute
// by presence ([data-next-remove-item]), so any value owns. The row template
// an item list reads is resolved separately (indexLiveDocument).
const P = SDK_TEMPLATE_PLACEHOLDERS;
const ITEM_TEMPLATE_ID = "data-item-template-id";
const ITEM_LISTS = P.item_list_containers.map((attribute) => ({ attribute }));
const owns = (attrs, { attribute, values }) => attrs.has(attribute) && (values == null || values.includes(attrs.get(attribute)));
const ownsItemList = (attrs) => ITEM_LISTS.some((ownership) => owns(attrs, ownership));

// The loader is read only from a <script> a browser runs as a classic or
// module script (HTML "prepare the script element"): an HTML-namespace
// <script> outside <template>, <noscript>, SVG and MathML whose type, ASCII
// whitespace stripped, is absent or empty, a JavaScript MIME type essence or
// `module` (ASCII case-insensitive). A classic script with `nomodule` does
// not run, nor does one with both `for` and `event` unless `for` is `window`
// and `event` is `onload` or `onload()` (whitespace stripped, ASCII
// case-insensitive). Anything else (application/json, text/plain, importmap,
// speculationrules, an SVG <script> ...) is no loader.
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SCRIPT_BARRIERS = new Set(["template", "noscript"]);
// MIME Sniffing, "JavaScript MIME type".
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
const ASCII_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
const asciiLowercase = (value) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());

// The loader is a script fetched over http(s) whose URL path ends in
// `campaign-cart[@<spec>]/dist/loader.js`: the package segment is the whole
// path segment (`not-campaign-cart@...` is another package), and an npm scope
// in front of it, if any, is the SDK's own. Its version is exact only as
// `<major>.<minor>.<patch>`, with or without a leading `v`.
const LOADER_PACKAGE = /^campaign-cart(?:@(.*))?$/;
const LOADER_SCOPES = new Set(["@nextcommerce"]);
const LOADER_PROTOCOLS = new Set(["http:", "https:"]);
const EXACT_VERSION = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

// Nesting deeper than a browser's HTML parser builds (Blink stops nesting at
// 512) is not the DOM a shopper gets, so such a page is not read.
export const MAX_ELEMENT_DEPTH = 512;

export function isKnownCartPlaceholder(name) {
  const value = String(name ?? "");
  if (KNOWN_BARE.has(value) || QTY.test(value)) return true;
  const namespaced = value.match(NAMESPACED);
  return Boolean(namespaced) && KNOWN_NAMESPACES.has(namespaced[1]);
}

const isCandidate = (name) => isKnownCartPlaceholder(name) || UNKNOWN_SHAPE.test(name);

// Whether the brace pair at `index` is the inner pair of an exactly balanced
// `{{...}}`: one `{` right before it, one `}` right after it, and no other
// brace of either kind beyond those.
const isBrace = (char) => char === "{" || char === "}";
const isDoubleBraced = (text, index, length) =>
  text[index - 1] === "{" && text[index + length] === "}" && !isBrace(text[index - 2]) && !isBrace(text[index + length + 1]);

// The page's own URL is not known here; an http(s) stand-in takes its place.
const PAGE_URL = "https://base.invalid/";

// The document base URL (HTML "document base URL"): the frozen base URL of
// the first HTML <base> in tree order that has an href attribute (template
// content is not in the tree), else the page URL. That href resolves against
// the page URL; one that fails to parse, or names a data: or javascript: URL,
// leaves the page URL. A later <base>, or one without href, is not read.
export function documentBaseUrl(document) {
  const base = liveElements(document).find((node) => node.namespaceURI === HTML_NAMESPACE && node.tagName === "base" && attrsOf(node).has("href"));
  if (!base) return PAGE_URL;
  let url;
  try {
    url = new URL(attrsOf(base).get("href"), PAGE_URL);
  } catch {
    return PAGE_URL;
  }
  return url.protocol === "data:" || url.protocol === "javascript:" ? PAGE_URL : url.href;
}

// Whether a <script src> is the Campaign Cart loader: `{ version }` (the
// exact version, or null when it names none) or null when it is not. The URL
// resolves as the browser resolves it, against the document base URL, so a
// relative or protocol-relative src lands where the page's <base> puts it, an
// src that cannot resolve against that base is no loader, and an opaque one
// (data:, javascript:, blob: ...) keeps its own scheme and is never the
// loader. Path segments are compared decoded.
export function campaignCartLoader(src, baseUrl = PAGE_URL) {
  let url;
  try {
    url = new URL(String(src), baseUrl);
  } catch {
    return null;
  }
  if (!LOADER_PROTOCOLS.has(url.protocol)) return null;
  const segments = url.pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const [pkg, dist, file] = segments.slice(-3);
  if (segments.length < 4 || dist !== "dist" || file !== "loader.js") return null;
  const match = pkg.match(LOADER_PACKAGE);
  if (!match) return null;
  const scope = segments[segments.length - 4];
  if (scope.startsWith("@") && !LOADER_SCOPES.has(scope)) return null;
  const exact = match[1] == null ? null : match[1].match(EXACT_VERSION);
  return { version: exact ? exact[1] : null };
}

// Every element under `root` in document order (template content excluded,
// it is not live DOM), without recursion.
function liveElements(root) {
  const out = [];
  const stack = [...(root.childNodes || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node.tagName) continue;
    out.push(node);
    if (node.tagName !== "template") for (let i = (node.childNodes || []).length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
  }
  return out;
}

class TooDeep extends Error {}

// parse5 with a tree adapter that stops the parse once an element would sit
// deeper than MAX_ELEMENT_DEPTH (template content counts from its
// <template>). parse5's own cost grows with the square of the nesting, so the
// bound has to hold during the parse, not after it. Its error is one
// isPageReadFailure reads as a page that cannot be read.
export function parseBounded(html) {
  const templateOf = new WeakMap();
  const check = (parent, node) => {
    if (!node.tagName) return;
    let depth = 1;
    for (let at = parent; at; at = at.parentNode || templateOf.get(at)) {
      if (at.tagName) depth += 1;
      if (depth > MAX_ELEMENT_DEPTH) throw new TooDeep();
    }
  };
  const treeAdapter = {
    ...defaultTreeAdapter,
    appendChild(parent, node) {
      check(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      check(parent, node);
      defaultTreeAdapter.insertBefore(parent, node, reference);
    },
    setTemplateContent(template, content) {
      templateOf.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
  return parse(html, { sourceCodeLocationInfo: true, treeAdapter });
}

// The deepest element nesting, template content included, without recursion.
function elementDepth(root) {
  let max = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > max) max = depth;
    for (const child of childrenOf(node)) if (child.tagName) stack.push([child, depth + 1]);
  }
  return max;
}

export function cartPlaceholderShapeKey(text) {
  return `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
}

const attrsOf = (node) => {
  const map = new Map();
  for (const attr of node.attrs || []) map.set(attr.name.toLowerCase(), attr.value);
  return map;
};

const childrenOf = (node) => (node.tagName === "template" && node.content ? node.content.childNodes : node.childNodes) || [];

// "classic", "module" or null: how a browser runs a <script> with these
// attributes, from its type (or, with no type, its language).
export function scriptKind(attrs) {
  const type = attrs.get("type");
  const language = attrs.get("language");
  let kind;
  if (type === "" || (type == null && (language == null || language === ""))) kind = "text/javascript";
  else if (type != null) kind = type.replace(ASCII_WHITESPACE_EDGES, "");
  else kind = `text/${language}`;
  kind = asciiLowercase(kind);
  if (JAVASCRIPT_MIME_TYPES.has(kind)) return attrs.has("nomodule") || !classicForEventRuns(attrs) ? null : "classic";
  return kind === "module" ? "module" : null;
}

// HTML "prepare the script element": a classic script with both `for` and
// `event` runs only as the window's onload handler.
function classicForEventRuns(attrs) {
  if (!attrs.has("for") || !attrs.has("event")) return true;
  const stripped = (name) => asciiLowercase(attrs.get(name).replace(ASCII_WHITESPACE_EDGES, ""));
  return stripped("for") === "window" && (stripped("event") === "onload" || stripped("event") === "onload()");
}

// The <script> elements a browser runs, in document order, without
// recursion: never below a <template>, a <noscript> or a non-HTML element.
function executableScripts(document) {
  const out = [];
  const stack = [...(document.childNodes || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node.tagName || node.namespaceURI !== HTML_NAMESPACE) continue;
    if (node.tagName === "script") {
      if (scriptKind(attrsOf(node))) out.push(node);
      continue;
    }
    if (SCRIPT_BARRIERS.has(node.tagName)) continue;
    for (let i = (node.childNodes || []).length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
  }
  return out;
}

// The page's SDK pin, read from its own loader <script src> only, among the
// scripts a browser runs, each src resolved against the document base URL.
// No loader, any loader with no exact version (none, @latest, a range), or
// two loaders that disagree give no pin.
export function readLoaderPin(document) {
  const baseUrl = documentBaseUrl(document);
  const versions = new Set();
  let unpinned = false;
  for (const element of executableScripts(document)) {
    const src = attrsOf(element).get("src");
    const loader = typeof src === "string" ? campaignCartLoader(src, baseUrl) : null;
    if (!loader) continue;
    if (loader.version) versions.add(loader.version);
    else unpinned = true;
  }
  if (unpinned || versions.size !== 1) return null;
  return [...versions][0];
}

// A selector resolved statically: `#` and a CSS identifier (CSS Syntax 3
// §4.3: non-ASCII code points and escapes included, so `#résumé` and
// `#\31 row` name the ids `résumé` and `1row`), exact. Returns the id, or
// null for anything else: a padded selector, `#1row` (no valid selector; the
// SDK's querySelector throws), or any other selector form.
const CSS_HEX_DIGIT = /^[0-9A-Fa-f]$/;
const CSS_WHITESPACE = new Set([" ", "\t", "\n"]);
const isIdentStart = (char) => char != null && (/^[A-Za-z_]$/.test(char) || char.codePointAt(0) >= 0x80);
const isIdentChar = (char) => isIdentStart(char) || (char != null && /^[0-9-]$/.test(char));
const isValidEscape = (first, second) => first === "\\" && second !== "\n";

function idOfSelector(selector) {
  // CSS input preprocessing: CR, FF and CR LF are newlines, NUL is U+FFFD.
  const chars = [...String(selector).replace(/\r\n?|\f/g, "\n").replaceAll("\0", "�")];
  if (chars[0] !== "#") return null;
  const [a, b, c] = chars.slice(1, 4);
  const startsIdent = a === "-" ? isIdentStart(b) || b === "-" || isValidEscape(b, c) : isIdentStart(a) || isValidEscape(a, b);
  if (!startsIdent) return null;
  let id = "";
  let at = 1;
  while (at < chars.length) {
    const char = chars[at];
    if (isIdentChar(char)) {
      id += char;
      at += 1;
    } else if (isValidEscape(char, chars[at + 1])) {
      at += 1;
      if (at === chars.length) {
        id += "�";
        break;
      }
      if (!CSS_HEX_DIGIT.test(chars[at])) {
        id += chars[at];
        at += 1;
        continue;
      }
      let hex = "";
      while (hex.length < 6 && at < chars.length && CSS_HEX_DIGIT.test(chars[at])) hex += chars[at++];
      if (CSS_WHITESPACE.has(chars[at])) at += 1;
      const code = Number.parseInt(hex, 16);
      id += code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? "�" : String.fromCodePoint(code);
    } else {
      return null;
    }
  }
  return id;
}

// The live element ids, first in document order wins (getElementById), and
// the row template each item list reads, as the SDK picks it
// (cart-item-list.enhancer.ts:21-35, order-item-list.enhancer.ts:26-36): a
// non-empty data-item-template-id names it by id and the selector is never
// read; otherwise a non-empty data-item-template-selector names it.
// Template content is not live DOM.
function indexLiveDocument(document) {
  const ids = new Map();
  const templateIds = new Map();
  const rowTemplates = [];
  for (const element of liveElements(document)) {
    const attrs = attrsOf(element);
    const id = attrs.get("id");
    if (id && !ids.has(id)) ids.set(id, element);
    for (const [name, value] of attrs) {
      if (TEMPLATE_ID_ATTRIBUTES.test(name) && value && !templateIds.has(value)) templateIds.set(value, name);
    }
    if (!ownsItemList(attrs)) continue;
    if (attrs.get(ITEM_TEMPLATE_ID)) rowTemplates.push({ id: attrs.get(ITEM_TEMPLATE_ID) });
    else if (attrs.get(P.item_template_selector)) rowTemplates.push({ selector: attrs.get(P.item_template_selector) });
  }
  const owned = new Set();
  let unresolved = false;
  for (const { id, selector } of rowTemplates) {
    const selectorId = selector == null ? null : idOfSelector(selector);
    if (selector != null && selectorId == null) {
      unresolved = true;
      continue;
    }
    const target = ids.get(id ?? selectorId);
    if (target) owned.add(target);
  }
  const idTemplates = new Map();
  for (const [id, attribute] of templateIds) {
    const target = ids.get(id);
    if (target) idTemplates.set(target, attribute);
  }
  return { rowTemplates: owned, selectorUnresolved: unresolved, idTemplates };
}

// The SDK template owner nearest an unowned occurrence, for the detail: a
// container whose direct <template> the SDK clones, or an element a
// *-template-id attribute names. The placeholder belongs inside that template.
function sdkOwnerOf(attrs, node, idTemplates) {
  const container = TEMPLATE_CONTAINER_ATTRIBUTES.find((name) => attrs.has(name));
  if (container) return container;
  return idTemplates.get(node) || null;
}

class CandidateCapReached extends Error {}

// Scans one parsed page, handing every candidate in a rendered location to
// `onCandidate` in document order, marked owned or not. Iterative, so page
// depth never reaches the call stack.
function scanPage(document, { rowTemplates, idTemplates }, onCandidate) {
  const emit = (text, where, line, ctx, elementPath) => {
    for (const match of text.matchAll(CANDIDATE)) {
      const name = match[1];
      if (!isCandidate(name) || isDoubleBraced(text, match.index, match[0].length)) continue;
      const owned = ctx.template || ctx.itemList || ctx.allowed.has(name) || (ctx.quantityText && QTY.test(name));
      const prefix = text.slice(0, match.index);
      const lineOf = line == null ? null : line + (where === "text" ? prefix.split("\n").length - 1 : 0);
      onCandidate({ text: match[0], name, owned, where, line: lineOf, element_path: elementPath, sdk_owner: ctx.owner });
    }
  };

  // The scope an element sets up. `self` is the part that covers the
  // element's own attributes too: only a <template> and the row template an
  // item list reads. An item list (innerHTML), quantity text (textContent), a
  // quantity control and a remove-item button (innerHTML) rewrite only what
  // is inside them, so their tokens are owned inside them, never in their own
  // attributes.
  const scopes = (ctx, node, tag, attrs) => {
    const self = { ...ctx };
    if (tag === "template") self.template = true;
    if (rowTemplates.has(node)) self.itemList = true;
    const inner = { ...self };
    if (ownsItemList(attrs)) inner.itemList = true;
    if (owns(attrs, P.quantity_text)) inner.quantityText = true;
    const allowed = [];
    if (owns(attrs, P.quantity_control)) allowed.push(...P.quantity_control.tokens);
    if (owns(attrs, P.remove_item)) allowed.push(...P.remove_item.tokens);
    if (allowed.length) inner.allowed = new Set([...ctx.allowed, ...allowed]);
    inner.owner = sdkOwnerOf(attrs, node, idTemplates) || ctx.owner;
    return { self, inner };
  };

  // Frames are pushed in reverse so they pop in document order.
  const pushChildren = (stack, node, ctx, path) => {
    const counts = new Map();
    const frames = [];
    for (const child of childrenOf(node)) {
      if (child.nodeName === "#text") {
        frames.push({ node: child, ctx, path });
        continue;
      }
      if (!child.tagName) continue; // comments, doctype
      const tag = child.tagName.toLowerCase();
      const index = (counts.get(tag) || 0) + 1;
      counts.set(tag, index);
      frames.push({ node: child, ctx, path: `${path ? `${path}/` : ""}${tag}[${index}]`, tag });
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) stack.push(frames[i]);
  };

  const stack = [];
  pushChildren(stack, document, { template: false, itemList: false, quantityText: false, allowed: new Set(), owner: null }, "");
  while (stack.length) {
    const { node, ctx, path, tag } = stack.pop();
    if (!tag) {
      emit(node.value || "", "text", node.sourceCodeLocation?.startLine ?? null, ctx, path);
      continue;
    }
    if (UNSCANNED_ELEMENTS.has(tag)) continue;
    const attrs = attrsOf(node);
    const { self, inner } = scopes(ctx, node, tag, attrs);
    const type = String(attrs.get("type") || "").trim().toLowerCase();
    for (const attr of node.attrs || []) {
      const name = attr.name.toLowerCase();
      const rendered = TEXT_ATTRIBUTES.has(name) || (name === "value" && tag === "input" && BUTTON_INPUT_TYPES.has(type));
      if (!rendered) continue;
      emit(attr.value || "", `attr:${name}`, node.sourceCodeLocation?.attrs?.[attr.name]?.startLine ?? node.sourceCodeLocation?.startLine ?? null, self, path);
    }
    pushChildren(stack, node, inner, path);
  }
}

// The file-system error codes that mean a page cannot be read.
const READ_ERROR_CODES = new Set([
  "EACCES", "EAGAIN", "EBADF", "EBUSY", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG",
  "ENFILE", "ENODEV", "ENOENT", "ENOTDIR", "ENXIO", "EOVERFLOW", "EPERM", "ESTALE", "ETIMEDOUT",
  "ERR_FS_FILE_TOO_LARGE", "ERR_STRING_TOO_LONG",
]);
// The engine's own size and depth bounds (V8 messages).
const BOUND_RANGE_ERRORS = /^(?:Maximum call stack size exceeded|Invalid string length)$/;

// Whether an error is a file-system read failure: one of READ_ERROR_CODES.
// What probes the file system for the page collection catches only these.
export function isFileReadFailure(error) {
  return typeof error?.code === "string" && READ_ERROR_CODES.has(error.code);
}

// Whether an error means the page cannot be read or parsed: a file-system
// error, nesting past MAX_ELEMENT_DEPTH, or the engine's size or depth bound.
// Anything else (a TypeError, a ReferenceError, an assertion) is a defect and
// is not one of these.
export function isPageReadFailure(error) {
  if (error instanceof TooDeep) return true;
  if (error instanceof RangeError) return BOUND_RANGE_ERRORS.test(error.message);
  return isFileReadFailure(error);
}

// One page's raw observation: the pin, and either a page-level outcome or the
// unowned candidates grouped per token or shape, in first-seen order. A read
// or parse failure reads the page unreadable; any other error is a defect and
// throws.
function observePage(page) {
  try {
    return observeReadablePage(page);
  } catch (error) {
    if (!isPageReadFailure(error)) throw error;
    return { pin: null, outcome: R.PAGE_UNREADABLE };
  }
}

function observeReadablePage(page) {
  if (page.unreadable) return { pin: null, outcome: R.PAGE_UNREADABLE };
  // A page over the size cap may come without its HTML.
  const bytes = Number.isFinite(page.bytes) ? page.bytes : typeof page.content === "string" ? Buffer.byteLength(page.content, "utf8") : null;
  if (bytes != null && bytes > CART_PLACEHOLDERS_LIMITS.page_bytes) return { pin: null, outcome: R.PAGE_TOO_LARGE, bytes };
  if (typeof page.content !== "string") return { pin: null, outcome: R.PAGE_UNREADABLE };

  let document;
  try {
    document = parseBounded(page.content);
  } catch (error) {
    if (!isPageReadFailure(error)) throw error;
    return { pin: null, outcome: R.PAGE_UNREADABLE, bytes };
  }
  // A backstop for nesting the parser reached by moving nodes.
  if (elementDepth(document) > MAX_ELEMENT_DEPTH) return { pin: null, outcome: R.PAGE_UNREADABLE, bytes };
  const pin = readLoaderPin(document);
  const index = indexLiveDocument(document);
  const groups = new Map();
  const caps = [];
  const unowned = [];
  let candidates = 0;
  // Past the candidate cap the walk stops; what it examined is kept. A page
  // the walk cannot hold (an engine bound) is not read.
  try {
    scanPage(document, index, (candidate) => {
      if (candidates === CART_PLACEHOLDERS_LIMITS.candidates) throw new CandidateCapReached();
      candidates += 1;
      if (!candidate.owned) unowned.push(candidate);
    });
  } catch (error) {
    if (isPageReadFailure(error)) return { pin: null, outcome: R.PAGE_UNREADABLE, bytes };
    if (!(error instanceof CandidateCapReached)) throw error;
    caps.push(R.CANDIDATE_CAP_REACHED);
  }

  for (const candidate of unowned) {
    const known = isKnownCartPlaceholder(candidate.name);
    const key = known ? candidate.text : cartPlaceholderShapeKey(candidate.text);
    if (!groups.has(key)) {
      if (groups.size >= CART_PLACEHOLDERS_LIMITS.results) {
        if (!caps.includes(R.FINDING_CAP_REACHED)) caps.push(R.FINDING_CAP_REACHED);
        continue;
      }
      const reason = index.selectorUnresolved ? R.TEMPLATE_SELECTOR_UNRESOLVED : known ? R.LIVE_TOKEN : R.UNKNOWN_BRACE;
      groups.set(key, { key, known, token: known ? candidate.text : null, shape_sha256: known ? null : key, reason, occurrences: [] });
    }
    groups.get(key).occurrences.push({ element_path: candidate.element_path, where: candidate.where, line: candidate.line, sdk_owner: candidate.sdk_owner });
  }
  return { pin, bytes, candidates, caps, groups: [...groups.values()] };
}

const capMembersFor = (reasons) => reasons.flatMap((reason) => aggregateQcResults([], { capReason: reason }).members);

/**
 * Evaluate the raw cart placeholder check.
 *
 * @param {{
 *   subject?: object,
 *   pages: Array<{ file: string, content?: string, bytes?: number, unreadable?: boolean }>,
 *   measuredAt?: string,
 * }} input  `pages` in a stable order; `file` is the page path relative to
 *   the doctor target. Pages past the page cap may omit `content`. `subject`
 *   names the scanned site for the caller; every result carries its own
 *   {check, page, key} subject.
 * @returns {object[]} QC results (src/qc-results.mjs buildQcResult).
 */
export function evaluateCartPlaceholders({ subject = null, pages = [], measuredAt = new Date().toISOString() } = {}) {
  const results = [];
  const check = CART_PLACEHOLDERS_CHECK;
  const row = ({ page, key, result, reason_code = null, pin = null, observation, occurrences = [], members = [], coverage }) => buildQcResult({
    check,
    leg: "doctor",
    subject: { check, page, key },
    result,
    reason_code,
    state: {
      reason_code: result === "pass" ? null : reason_code,
      sdk_pin: pin,
      occurrences: occurrences.map(({ element_path, where }) => ({ element_path, where })),
      members,
    },
    observation,
    members,
    coverage,
    measured_at: measuredAt,
  });
  const pageObservation = (page, pin, extra = {}) => ({
    page,
    sdk_pin: pin,
    sdk_pin_source: pin ? "loader" : null,
    token: null,
    shape_sha256: null,
    known: false,
    occurrences: [],
    ...extra,
  });
  const pageRow = (page, result, reasonCode, pin, extra, limits = reasonCode && result === "unexercised" ? [reasonCode] : []) => row({
    page,
    key: CART_PLACEHOLDERS_PAGE_KEY,
    result,
    reason_code: reasonCode,
    pin,
    observation: pageObservation(page, pin, extra),
    coverage: limits.length ? { observed: 0, expected: 1, limits } : { observed: 1, expected: 1, limits: [] },
  });

  (Array.isArray(pages) ? pages : []).forEach((page, index) => {
    const file = String(page?.file ?? "");
    if (index >= CART_PLACEHOLDERS_LIMITS.pages) {
      results.push(pageRow(file, "unexercised", R.PAGE_CAP_REACHED, null, {}));
      return;
    }
    const observed = observePage(page || {});
    if (observed.outcome) {
      results.push(pageRow(file, "unexercised", observed.outcome, observed.pin, observed.bytes == null ? {} : { bytes: observed.bytes }));
      return;
    }
    const { pin, caps, groups } = observed;
    for (const group of groups) {
      const result = group.reason === R.LIVE_TOKEN ? "warning" : "review";
      results.push(row({
        page: file,
        key: group.key,
        result,
        reason_code: group.reason,
        pin,
        occurrences: group.occurrences,
        members: capMembersFor(caps),
        observation: {
          page: file,
          sdk_pin: pin,
          sdk_pin_source: pin ? "loader" : null,
          token: group.token,
          shape_sha256: group.shape_sha256,
          known: group.known,
          occurrences: group.occurrences,
        },
        coverage: caps.length ? { observed: observed.candidates, expected: null, limits: [...caps] } : undefined,
      }));
    }
    const extra = { bytes: observed.bytes, candidates: observed.candidates };
    if (caps.length) {
      results.push(pageRow(file, "unexercised", caps[0], pin, extra, [...caps]));
    } else if (!groups.length) {
      if (pin == null) results.push(pageRow(file, "unexercised", R.SDK_PIN_UNKNOWN, pin, extra));
      else if (!VERIFIED_PINS.has(pin)) results.push(pageRow(file, "unexercised", R.SDK_PIN_UNVERIFIED, pin, extra));
      else results.push(pageRow(file, "pass", null, pin, extra));
    }
  });
  return results;
}
