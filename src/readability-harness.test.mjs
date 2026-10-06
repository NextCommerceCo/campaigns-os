// Shared node-side harness for the unit 2.4 (readability) row tests. It
// registers no tests of its own. Imported by src/contrast.test.mjs,
// src/polish-readability.test.mjs and src/qa-cart-entry.test.mjs.
//
// Two parts, both independent of the code under test:
// - WCAG 2.x arithmetic written out from the definitions (sRGB transfer with
//   the 0.04045 knee, relative luminance, (L1 + 0.05) / (L2 + 0.05)), used to
//   state setup ratios, and the computed-style string of an 8-bit colour. It
//   never calls src/contrast.mjs.
// - A small in-memory DOM for vm evaluation (the src/qa-cart-entry.test.mjs
//   vm pattern): a window object that is the vm context itself, so code
//   evaluated from source text sees only these browser globals, with no
//   module scope and no Node globals. Computed styles are what the spec
//   gives, with CSS initial values and inheritance for the rest.
import vm from "node:vm";

// ---------------------------------------------------------------------------
// WCAG 2.x arithmetic

export const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
export const ratioOf = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// An 8-bit "#rrggbb" → gamma-encoded sRGB channels in [0, 1].
export const hexToSrgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
// The computed-style string Chromium serializes for an opaque 8-bit colour.
export const rgbString = (hex) => `rgb(${hexToSrgb(hex).map((c) => Math.round(c * 255)).join(", ")})`;
// 8-digit hex (rrggbbaa) of opaque sRGB channels in [0, 1].
export const hex8 = (rgb) => `${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}ff`;
// Contract 2.4 large-text predicate and requirement, restated.
export const isLarge = (px, weight) => px >= 24 || (px >= 18.66 && weight >= 700);
export const requiredFor = (px, weight) => (isLarge(px, weight) ? 3 : 4.5);

// ---------------------------------------------------------------------------
// In-memory DOM for vm evaluation

const INHERITED = new Set(["color", "fontSize", "fontWeight", "visibility", "colorScheme", "webkitTextFillColor", "fontFamily", "lineHeight"]);
const INITIAL = Object.freeze({
  display: "block",
  visibility: "visible",
  opacity: "1",
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  webkitBackgroundClip: "border-box",
  filter: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  mixBlendMode: "normal",
  maskImage: "none",
  webkitMaskImage: "none",
  fontSize: "16px",
  fontWeight: "400",
  fontFamily: "sans-serif",
  lineHeight: "normal",
  position: "static",
  content: "normal",
  colorScheme: "normal",
  contentVisibility: "visible",
  textShadow: "none",
  webkitTextStroke: "0px rgb(0, 0, 0)",
  clipPath: "none",
  zIndex: "auto",
  isolation: "auto",
  overflow: "visible",
  pointerEvents: "auto",
  cursor: "auto",
  transform: "none",
});
const camel = (name) => (name.startsWith("--") ? name : name.replace(/^-(webkit|moz|ms)-/, (_, vendor) => `${vendor}-`).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

function styleObject(values) {
  const style = { ...values };
  style.getPropertyValue = (name) => {
    const key = camel(String(name));
    return key in values ? values[key] : "";
  };
  style.getPropertyPriority = () => "";
  style.item = (index) => Object.keys(values)[index] ?? "";
  Object.defineProperty(style, "length", { value: Object.keys(values).length });
  return style;
}

// Selector matching: lists, compound selectors (tag, *, #id, .class,
// [attr], [attr=v], [attr~=v], [attr^=v], [attr$=v], [attr*=v], [attr|=v],
// optional " i"), descendant and child combinators, and the pseudo-classes
// :disabled, :enabled, :checked, :not(), :is(), :where(), :root, :link,
// :any-link, :first-child. Any other pseudo-class or pseudo-element matches
// nothing.
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function tokenizeComplex(selector) {
  // → [compound, combinator, compound, ...]
  const out = [];
  let current = "";
  let depth = 0;
  let quote = null;
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && (ch === ">" || ch === " " || ch === "+" || ch === "~")) {
      flush();
      if (ch !== " ") out.push(ch);
      else if (out.length && ![">", "+", "~", " "].includes(out.at(-1))) out.push(" ");
      continue;
    }
    current += ch;
  }
  flush();
  // Collapse " " adjacent to an explicit combinator.
  const cleaned = [];
  for (const token of out) {
    if ([">", "+", "~"].includes(token) && cleaned.at(-1) === " ") cleaned.pop();
    if (token === " " && [">", "+", "~"].includes(cleaned.at(-1))) continue;
    cleaned.push(token);
  }
  while (cleaned.at(-1) === " ") cleaned.pop();
  return cleaned;
}

function matchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  let rest = compound;
  const tag = rest.match(/^(\*|[a-zA-Z][a-zA-Z0-9-]*)/);
  if (tag) {
    if (tag[1] !== "*" && el.localName !== tag[1].toLowerCase()) return false;
    rest = rest.slice(tag[1].length);
  }
  while (rest.length) {
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) {
      if (el.id !== m[1]) return false;
    } else if ((m = rest.match(/^\.([\w-]+)/))) {
      if (!el.classList.contains(m[1])) return false;
    } else if ((m = rest.match(/^\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(i)?\s*)?\]/))) {
      const [, name, op, dq, sq, bare, insensitive] = m;
      if (!el.hasAttribute(name)) return false;
      if (op) {
        let actual = el.getAttribute(name);
        let wanted = dq ?? sq ?? bare ?? "";
        if (insensitive) {
          actual = actual.toLowerCase();
          wanted = wanted.toLowerCase();
        }
        const ok = op === "=" ? actual === wanted
          : op === "~=" ? actual.split(/\s+/).includes(wanted)
            : op === "^=" ? wanted !== "" && actual.startsWith(wanted)
              : op === "$=" ? wanted !== "" && actual.endsWith(wanted)
                : op === "*=" ? wanted !== "" && actual.includes(wanted)
                  : actual === wanted || actual.startsWith(`${wanted}-`);
        if (!ok) return false;
      }
    } else if ((m = rest.match(/^::?([\w-]+)(\((.*)\))?/))) {
      const [whole, name, , arg] = m;
      // Balanced argument: re-scan for the matching parenthesis.
      let consumed = whole;
      let argument = arg;
      if (m[2]) {
        let depth = 0;
        let end = rest.indexOf("(");
        for (let i = end; i < rest.length; i += 1) {
          if (rest[i] === "(") depth += 1;
          if (rest[i] === ")") depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
        consumed = rest.slice(0, end + 1);
        argument = rest.slice(rest.indexOf("(") + 1, end);
      }
      if (rest.startsWith("::")) return false;
      const formControl = ["button", "input", "select", "textarea", "optgroup", "option", "fieldset"].includes(el.localName);
      let ok;
      switch (name) {
        case "disabled": ok = formControl && el.disabled === true; break;
        case "enabled": ok = formControl && el.disabled !== true; break;
        case "checked": ok = el.checked === true; break;
        case "not": ok = !matchesList(el, argument); break;
        case "is":
        case "where": ok = matchesList(el, argument); break;
        case "root": ok = el.ownerDocument.documentElement === el; break;
        case "link":
        case "any-link": ok = ["a", "area"].includes(el.localName) && el.hasAttribute("href"); break;
        case "first-child": ok = el.parentElement?.children[0] === el; break;
        default: ok = false;
      }
      if (!ok) return false;
      rest = rest.slice(consumed.length);
      continue;
    } else {
      return false;
    }
    rest = rest.slice(m[0].length);
  }
  return true;
}

function matchesComplex(el, tokens, index = tokens.length - 1) {
  if (!matchesCompound(el, tokens[index])) return false;
  if (index === 0) return true;
  const combinator = tokens[index - 1];
  if (combinator === ">") return matchesComplex(el.parentElement, tokens, index - 2);
  if (combinator === " ") {
    for (let up = el.parentElement; up; up = up.parentElement) if (matchesComplex(up, tokens, index - 2)) return true;
    return false;
  }
  const siblings = el.parentElement ? el.parentElement.children : [];
  const at = siblings.indexOf(el);
  if (combinator === "+") return at > 0 && matchesComplex(siblings[at - 1], tokens, index - 2);
  if (combinator === "~") return siblings.slice(0, Math.max(at, 0)).some((sibling) => matchesComplex(sibling, tokens, index - 2));
  return false;
}

function matchesList(el, list) {
  return splitTop(String(list), ",").some((selector) => matchesComplex(el, tokenizeComplex(selector)));
}

const parseInline = (text) => Object.fromEntries(String(text || "").split(";").map((part) => part.split(":")).filter((pair) => pair.length >= 2).map(([key, ...value]) => [camel(key.trim()), value.join(":").trim()]));

// buildDocument(spec) → { window, document, byKey }.
// spec = { url, rootStyle, bodyStyle, body: [node] }, node = string (a text
// node) | { tag, key, attrs, style, text, children, rect, visible, value,
// type, disabled, checked, before, after, placeholder }. `style` holds
// computed values (camelCase), `rect` the border box {x, y, width, height}
// (default 200×48 at 0,0), `visible` the checkVisibility answer (default
// true), `before`/`after` the pseudo-element computed values.
export function buildDocument(spec = {}) {
  const url = spec.url || "https://campaign.example/lp/";
  const byKey = {};
  const all = [];
  const window = {};
  const document = {
    nodeType: 9,
    nodeName: "#document",
    URL: url,
    documentURI: url,
    readyState: "complete",
    contentType: "text/html",
    visibilityState: "visible",
    hidden: false,
    defaultView: window,
    styleSheets: [],
    fonts: { status: "loaded", ready: Promise.resolve(), check: () => true, size: 0, forEach() {}, [Symbol.iterator]: function* fonts() {} },
  };

  const textNode = (value, parent) => ({
    nodeType: 3,
    nodeName: "#text",
    nodeValue: value,
    data: value,
    textContent: value,
    wholeText: value,
    parentNode: parent,
    parentElement: parent,
    ownerDocument: document,
    childNodes: [],
    isConnected: true,
    getRootNode: () => document,
  });

  const make = (node, parent) => {
    const tag = String(node.tag || "div").toLowerCase();
    const attrs = { ...(node.attrs || {}) };
    if (node.type != null && !("type" in attrs)) attrs.type = node.type;
    const classes = String(attrs.class || "").split(/\s+/).filter(Boolean);
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      localName: tag,
      nodeName: tag.toUpperCase(),
      namespaceURI: "http://www.w3.org/1999/xhtml",
      id: attrs.id || "",
      className: attrs.class || "",
      classList: Object.assign([...classes], { contains: (name) => classes.includes(name), item: (i) => classes[i] ?? null, value: classes.join(" ") }),
      attributes: Object.entries(attrs).map(([name, value]) => ({ name, value: String(value), localName: name })),
      parentElement: parent,
      parentNode: parent || document,
      ownerDocument: document,
      children: [],
      childNodes: [],
      isConnected: true,
      shadowRoot: null,
      assignedSlot: null,
      style: styleObject(parseInline(attrs.style)),
      dataset: Object.fromEntries(Object.entries(attrs).filter(([name]) => name.startsWith("data-")).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), String(value)])),
      hidden: "hidden" in attrs,
      disabled: node.disabled ?? ("disabled" in attrs && ["button", "input", "select", "textarea", "fieldset"].includes(tag)),
      checked: node.checked ?? false,
      readOnly: "readonly" in attrs,
      open: "open" in attrs,
      value: node.value ?? attrs.value ?? "",
      type: tag === "input" ? String(attrs.type || "text").toLowerCase() : tag === "button" ? String(attrs.type || "submit").toLowerCase() : undefined,
      placeholder: attrs.placeholder ?? "",
      sheet: node.sheet === undefined ? (tag === "link" ? {} : null) : node.sheet,
      __spec: node,
    };
    if (tag === "a" && "href" in attrs) el.href = new URL(attrs.href, url).href;
    el.getAttribute = (name) => (Object.hasOwn(attrs, name) ? String(attrs[name]) : null);
    el.hasAttribute = (name) => Object.hasOwn(attrs, name);
    el.getAttributeNames = () => Object.keys(attrs);
    el.matches = (selector) => matchesList(el, selector);
    el.closest = (selector) => {
      for (let at = el; at; at = at.parentElement) if (matchesList(at, selector)) return at;
      return null;
    };
    el.contains = (other) => {
      for (let at = other; at; at = at.parentElement ?? null) if (at === el) return true;
      return false;
    };
    el.querySelectorAll = (selector) => all.filter((candidate) => candidate !== el && el.contains(candidate) && matchesList(candidate, selector));
    el.querySelector = (selector) => el.querySelectorAll(selector)[0] ?? null;
    el.getElementsByTagName = (name) => el.querySelectorAll(name);
    el.getRootNode = () => document;
    const r = { x: 0, y: 0, width: 200, height: 48, ...(node.rect || {}) };
    const rect = () => ({ ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON() { return this; } });
    el.getBoundingClientRect = rect;
    el.getClientRects = () => (r.width || r.height ? [rect()] : []);
    el.checkVisibility = () => node.visible !== false;
    el.getAnimations = () => [];
    Object.defineProperty(el, "textContent", { get: () => el.childNodes.map((child) => child.textContent).join("") });
    Object.defineProperty(el, "innerText", { get: () => (node.visible === false ? "" : el.textContent) });
    Object.defineProperty(el, "firstChild", { get: () => el.childNodes[0] ?? null });
    Object.defineProperty(el, "lastChild", { get: () => el.childNodes.at(-1) ?? null });
    Object.defineProperty(el, "firstElementChild", { get: () => el.children[0] ?? null });
    Object.defineProperty(el, "childElementCount", { get: () => el.children.length });
    Object.defineProperty(el, "nextElementSibling", { get: () => (parent ? parent.children[parent.children.indexOf(el) + 1] ?? null : null) });
    Object.defineProperty(el, "previousElementSibling", { get: () => (parent ? parent.children[parent.children.indexOf(el) - 1] ?? null : null) });
    all.push(el);
    if (node.key) byKey[node.key] = el;
    if (node.text != null) el.childNodes.push(textNode(String(node.text), el));
    for (const child of node.children || []) {
      if (typeof child === "string") el.childNodes.push(textNode(child, el));
      else {
        const made = make(child, el);
        el.children.push(made);
        el.childNodes.push(made);
      }
    }
    return el;
  };

  const html = make({ tag: "html", style: spec.rootStyle, rect: { width: 1440, height: 1200 }, children: [] }, null);
  const head = make({ tag: "head", rect: { width: 0, height: 0 }, visible: false, children: spec.head || [] }, html);
  const body = make({ tag: "body", attrs: spec.bodyAttrs, style: spec.bodyStyle, rect: { width: 1440, height: 1200 }, children: spec.body || [] }, html);
  html.children.push(head, body);
  html.childNodes.push(head, body);
  html.parentNode = document;
  Object.assign(document, {
    documentElement: html,
    head,
    body,
    children: [html],
    childNodes: [html],
    querySelectorAll: (selector) => all.filter((el) => matchesList(el, selector)),
    querySelector: (selector) => all.find((el) => matchesList(el, selector)) ?? null,
    getElementById: (id) => all.find((el) => el.id === id) ?? null,
    getElementsByTagName: (name) => all.filter((el) => name === "*" || el.localName === String(name).toLowerCase()),
    elementsFromPoint: () => [],
    elementFromPoint: () => null,
    getRootNode: () => document,
    contains: (other) => all.includes(other) || other === document,
    createRange: () => {
      let target = null;
      const box = () => (target?.nodeType === 1 ? target : target?.parentElement)?.getBoundingClientRect() ?? { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      return { selectNodeContents(n) { target = n; }, selectNode(n) { target = n; }, setStart(n) { target = n; }, setEnd() {}, getBoundingClientRect: box, getClientRects: () => [box()], detach() {} };
    },
    createTreeWalker: (root, whatToShow = 0xffffffff) => {
      const order = [];
      const walk = (n) => {
        for (const child of n.childNodes || []) {
          if ((child.nodeType === 1 && whatToShow & 0x1) || (child.nodeType === 3 && whatToShow & 0x4)) order.push(child);
          if (child.nodeType === 1) walk(child);
        }
      };
      walk(root);
      let at = -1;
      return { root, currentNode: root, nextNode() { at += 1; this.currentNode = order[at] ?? null; return this.currentNode; } };
    },
  });
  document.scripts = all.filter((el) => el.localName === "script");
  document.links = all.filter((el) => ["a", "area"].includes(el.localName) && el.hasAttribute("href"));
  document.styleSheets = all.filter((el) => el.localName === "link" && el.sheet).map((el) => el.sheet);
  document.location = { href: url, origin: new URL(url).origin, pathname: new URL(url).pathname, protocol: new URL(url).protocol, host: new URL(url).host };

  const computed = (el, pseudo) => {
    const spec = el.__spec || {};
    const parentValues = el.parentElement ? computed(el.parentElement, null) : null;
    const pseudoName = pseudo ? String(pseudo).replace(/^:+/, "") : null;
    if (pseudoName === "before" || pseudoName === "after") {
      const own = spec[pseudoName];
      const base = { ...INITIAL, content: "none" };
      for (const key of INHERITED) if (parentValues) base[key] = computed(el, null)[key];
      return styleObject({ ...base, ...(own || {}) });
    }
    if (pseudoName === "placeholder") return styleObject({ ...computed(el, null), color: spec.placeholderColor || "rgb(117, 117, 117)" });
    const values = { ...INITIAL };
    if (parentValues) for (const key of INHERITED) values[key] = parentValues[key];
    if (el.localName === "html") Object.assign(values, spec.style || {});
    else Object.assign(values, spec.style || {});
    if (!(spec.style && "webkitTextFillColor" in spec.style)) values.webkitTextFillColor = values.color;
    if (["span", "a", "strong", "em", "b", "i", "label"].includes(el.localName) && !(spec.style && "display" in spec.style)) values.display = "inline";
    return values;
  };

  Object.assign(window, {
    window,
    self: window,
    document,
    location: document.location,
    navigator: { userAgent: "vm" },
    innerWidth: 1440,
    innerHeight: 1200,
    devicePixelRatio: 1,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    NodeFilter: { SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 0x1, SHOW_TEXT: 0x4 },
    URL,
    getComputedStyle: (el, pseudo = null) => styleObject(computed(el, pseudo)),
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  });
  return { window, document, byKey };
}

// A fresh vm context whose global object is that window: the evaluated text
// sees the browser globals above and nothing else.
export function vmPage(spec) {
  const page = buildDocument(spec);
  const context = vm.createContext(page.window);
  return { ...page, context, run: (source) => vm.runInContext(source, context) };
}
