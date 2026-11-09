// API and storage observations in campaign scripts (#729, #730 milestone 3).
//
// Advisory only: every finding is a warning, never a blocker, and no ready
// line or gate is added. A campaign script that reaches past the SDK's public
// surface keeps working until the next SDK release changes what it reached
// for, so doctor names what it can verify and claims nothing more:
//
// - sdk_prefixed_storage: a browser storage read, write or removal whose key
//   starts with the SDK's `next-`/`next_` prefix. The receiver is the
//   browser's own localStorage/sessionStorage (no local binding shadows it on
//   the way out) and the key or its literal start resolves statically. The
//   prefix alone does not establish that the SDK owns the key.
// - network_global_replaced: an assignment that replaces the page's `fetch`
//   or `XMLHttpRequest.prototype.open`/`send`. Every caller on the page,
//   the SDK included, then goes through it; whether it changes an SDK request
//   is not established statically, so no bypass is claimed.
// - sdk_debug_surface: a reference to the SDK's `nextDebug` global, its
//   debugging surface.
// - sdk_private_member: an underscore member reached from the SDK's own
//   globals (`next`, `NextCommerce`). An underscore member on any other
//   receiver is not reported: the name alone does not make it the SDK's.
//
// Inputs: the local records of builtScriptReferences (remote and missing
// scripts are not read; the syntax gate already warns about missing ones),
// keyed by path plus classic/module, since the same bytes can parse and
// resolve differently as either. Bytes come from readHtmlScanText; programs
// from htmlScanScriptPrograms, parsed only when this check asks. A script that
// cannot be read or does not parse yields no observation here; the syntax
// gate owns that failure.
//
// Every finding records the delivery form (always `local` here), ownership
// (`unknown`: these observations do not consult the family script reference
// to tell campaign code from a family copy) and provenance (null until there
// is an ownership claim to prove).

import { relative, sep } from "node:path";

import { parse as parseJs } from "acorn";

import { builtScriptReferences } from "./built-script-syntax.mjs";
import { htmlScanScriptPrograms, readHtmlScanText } from "./html-scan.mjs";
import { children as childNodes, javaScriptScopeAnalysis } from "./sdk-storage-compatibility.mjs";

export const SCRIPT_OBSERVATIONS = "built_output.script_observations";
export const SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE = `${SCRIPT_OBSERVATIONS}.sdk_prefixed_storage`;
export const SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED = `${SCRIPT_OBSERVATIONS}.network_global_replaced`;
export const SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE = `${SCRIPT_OBSERVATIONS}.sdk_debug_surface`;
export const SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER = `${SCRIPT_OBSERVATIONS}.sdk_private_member`;
export const SCRIPT_OBSERVATIONS_TRUNCATED = `${SCRIPT_OBSERVATIONS}.truncated`;

// Warnings past this many are counted in one truncation warning instead.
export const SCRIPT_OBSERVATIONS_LIMIT = 50;

const SDK_STORAGE_PREFIX = /^next[-_]/;
const SDK_GLOBALS = ["next", "NextCommerce"];
const XHR_METHODS = new Set(["open", "send"]);
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * The observations in one parsed program, in source order.
 *
 * @param {object} program an acorn Program parsed with locations
 * @param {{ module?: boolean }} [options]
 * @returns {Array<{ code: string, line: number, column: number, operation: string, receiver: string, key?: { text: string, match: "exact" | "prefix" } }>}
 */
export function observeScriptProgram(program, { module = false } = {}) {
  const analysis = javaScriptScopeAnalysis(program, { sameNameAliases: true });
  const { scopes, binding, literal, browserGlobal, globalReference, keyPrefix } = analysis;
  const observations = [];
  const seen = new Set();
  const add = (code, node, data) => {
    const { line, column } = node.loc.start;
    const id = `${code}\u0000${line}\u0000${column}`;
    if (seen.has(id)) return;
    seen.add(id);
    observations.push({ code, line, column: column + 1, ...data });
  };
  const memberName = (node) => (node.computed ? literal(node.property, scopes.get(node)) : node.property.name);
  const globalSpelling = (node, name) => (node.type === "MemberExpression" ? `${node.object.name}.${name}` : name);

  analysis.visitStorageAccesses(({ node, storage, key, keyNode, operation, reason, metadata }) => {
    if (storage.shadowed || metadata || reason || !["read", "write", "remove"].includes(operation)) return;
    const prefix = key !== null ? { text: key, exact: true } : keyNode ? keyPrefix(keyNode, scopes.get(node)) : null;
    if (!prefix || !SDK_STORAGE_PREFIX.test(prefix.text)) return;
    add(SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE, node, {
      operation,
      receiver: storage.name,
      key: { text: prefix.text, match: prefix.exact ? "exact" : "prefix" },
    });
  });

  // An expression that is a reference to an unshadowed global named in `names`.
  const sdkGlobal = (node, names) => {
    const found = globalReference(node, scopes.get(node), names);
    return found && !found.shadowed ? found : null;
  };
  // A reference position: not a property name, label or declared name.
  const isReference = (node, parent) => !(
    (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    || (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type) && parent.key === node && !parent.computed && !parent.shorthand)
    || (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent?.type) && parent.label === node)
    || (parent?.type === "VariableDeclarator" && parent.id === node)
    || (FUNCTION_TYPES.has(parent?.type) && (parent.id === node || parent.params.includes(node)))
    || (["ClassDeclaration", "ClassExpression"].includes(parent?.type) && parent.id === node)
    || (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ExportSpecifier"].includes(parent?.type))
  );
  const accessOf = (node, parent) => {
    if (parent?.type === "AssignmentExpression" && parent.left === node) return "write";
    if (parent?.type === "UnaryExpression" && parent.operator === "delete") return "remove";
    if (parent?.type === "UpdateExpression") return "write";
    if (parent?.type === "CallExpression" && parent.callee === node) return "call";
    return "read";
  };
  const replacesNetworkGlobal = (target) => {
    if (target.type === "Identifier") {
      // A bare `fetch = ...` with nothing binding it assigns the global.
      return target.name === "fetch" && !binding("fetch", scopes.get(target)) ? "fetch" : null;
    }
    if (target.type !== "MemberExpression") return null;
    const name = memberName(target);
    if (name === "fetch") {
      const global = browserGlobal(target.object, scopes.get(target));
      // window, globalThis and self are one object on a page.
      return global && !global.shadowed ? "window.fetch" : null;
    }
    if (XHR_METHODS.has(name) && target.object.type === "MemberExpression" && memberName(target.object) === "prototype" && sdkGlobal(target.object.object, ["XMLHttpRequest"])) {
      return `XMLHttpRequest.prototype.${name}`;
    }
    return null;
  };
  // The receiver path of `object` when it is rooted at an SDK global through
  // plain property reads (`next.cart`, `window.NextCommerce.store`), else null.
  const sdkReceiver = (object) => {
    const path = [];
    for (let node = object; node; node = node.object) {
      const global = sdkGlobal(node, SDK_GLOBALS);
      if (global) return [global.name, ...path].join(".");
      if (node.type !== "MemberExpression") return null;
      const name = memberName(node);
      if (typeof name !== "string") return null;
      path.unshift(name);
    }
    return null;
  };

  const walk = (node, parent, inFunction) => {
    // Only a plain `=` replaces it: `||=`, `&&=` and `??=` leave a defined fetch in place.
    if (node.type === "AssignmentExpression" && node.operator === "=") {
      const replaced = replacesNetworkGlobal(node.left);
      if (replaced) add(SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED, node.left, { operation: "replace", receiver: replaced });
    }
    // Object.defineProperty(window, "fetch", ...)
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier" && node.callee.object.name === "Object"
      && !binding("Object", scopes.get(node)) && memberName(node.callee) === "defineProperty" && literal(node.arguments[1], scopes.get(node)) === "fetch") {
      const global = browserGlobal(node.arguments[0], scopes.get(node));
      if (global && !global.shadowed) add(SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED, node, { operation: "replace", receiver: "window.fetch" });
    }
    // In a classic script a top-level function declaration or initialized
    // `var` is a property of the global object; in a module it is local.
    if (!module && !inFunction) {
      if (node.type === "FunctionDeclaration" && parent?.type === "Program" && node.id?.name === "fetch") {
        add(SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED, node.id, { operation: "replace", receiver: "fetch" });
      }
      if (node.type === "VariableDeclarator" && parent?.kind === "var" && node.id.type === "Identifier" && node.id.name === "fetch" && node.init) {
        add(SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED, node.id, { operation: "replace", receiver: "fetch" });
      }
    }
    const name = node.type === "Identifier" ? node.name : node.type === "MemberExpression" ? memberName(node) : null;
    // Only the global itself: an alias (`const d = window.nextDebug`, or one
    // named nextDebug) is reported where it reads the global, not again where
    // the alias is used, so an identifier counts only while nothing binds it.
    if (name === "nextDebug" && isReference(node, parent) && sdkGlobal(node, ["nextDebug"])
      && (node.type === "MemberExpression" || !binding("nextDebug", scopes.get(node)))) {
      add(SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE, node, { operation: accessOf(node, parent), receiver: globalSpelling(node, "nextDebug") });
      return;
    }
    if (node.type === "MemberExpression") {
      if (typeof name === "string" && name.startsWith("_")) {
        const receiver = sdkReceiver(node.object);
        if (receiver) add(SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER, node, { operation: accessOf(node, parent), receiver: `${receiver}.${name}` });
      }
    }
    const nested = inFunction || FUNCTION_TYPES.has(node.type) || node.type === "StaticBlock";
    for (const child of childNodes(node)) walk(child, node, nested);
  };
  walk(program, null, false);
  return observations.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Parse and observe one script as the browser would read it. A script that
 * does not parse has no observations (the syntax gate reports it).
 *
 * @param {string} source
 * @param {{ module?: boolean }} [options]
 */
export function observeScriptSource(source, { module = false } = {}) {
  let program;
  try {
    program = parseJs(String(source ?? ""), { ecmaVersion: "latest", sourceType: module ? "module" : "script", locations: true, allowHashBang: true });
  } catch {
    return [];
  }
  return observeScriptProgram(program, { module });
}

function relFrom(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
}

/**
 * Observations for every local script the built pages load, one entry per
 * path and mode in first-seen order (the script syntax gate's order).
 *
 * @param {{ site_root: string, campaign_dir: string, pages: Array<{ page_id: string, built_path: string }> }} scope
 * @param {string} targetRepo
 * @returns {{ scripts_observed: number, scripts: Array<{ file: string, module: boolean, pages: string[], observations: object[] }> }}
 */
export function collectBuiltScriptObservations(scope, targetRepo) {
  const scripts = new Map();
  for (const ref of builtScriptReferences(scope).refs) {
    if (ref.status !== "local") continue;
    const key = `${ref.path}\u0000${ref.module ? "module" : "script"}`;
    if (!scripts.has(key)) scripts.set(key, { path: ref.path, module: ref.module, pages: [] });
    const entry = scripts.get(key);
    if (!entry.pages.includes(ref.page_id)) entry.pages.push(ref.page_id);
  }
  const readable = [];
  for (const script of scripts.values()) {
    try {
      readable.push({ ...script, text: readHtmlScanText(script.path) });
    } catch {
      // Unreadable: no observation. The syntax gate decides what it means.
    }
  }
  const programs = htmlScanScriptPrograms(readable);
  const observed = [];
  for (const script of readable) {
    let program;
    try {
      program = programs(script.path, script.module, script.text);
    } catch {
      continue;
    }
    observed.push({
      file: relFrom(targetRepo, script.path),
      module: script.module,
      pages: script.pages,
      observations: observeScriptProgram(program, { module: script.module }),
    });
  }
  return { scripts_observed: observed.length, scripts: observed };
}

const OPERATION_VERBS = { read: "reads", write: "writes", remove: "removes", call: "calls", replace: "replaces" };

function describe(observation, script) {
  const where = `${script.file}:${observation.line}:${observation.column}`;
  const kind = script.module ? "module" : "classic script";
  const pages = script.pages.length ? `, loaded by ${script.pages.join(", ")}` : "";
  const verb = OPERATION_VERBS[observation.operation] || observation.operation;
  const origin = `(local ${kind}${pages}; owner not established)`;
  switch (observation.code) {
    case SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE: {
      const key = observation.key.match === "exact"
        ? `the ${observation.receiver} key "${observation.key.text}"`
        : `a ${observation.receiver} key starting "${observation.key.text}" (the rest is computed)`;
      return `${where} ${verb} ${key} ${origin}. The key starts with the SDK's next prefix, but the name alone does not establish that the SDK owns it. If it is SDK state, use the SDK's public API, attributes or events instead: its storage keys can change in any release, as the scoping in 0.4.34 did. If the campaign owns it, give it a name off the next prefix.`;
    }
    case SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED:
      return `${where} replaces ${observation.receiver} ${origin}. Every request on the page that uses it, the SDK's own included, then runs through this code; whether it changes an SDK request is not established statically. Prefer the SDK attribute, option or event for the behaviour over intercepting requests.`;
    case SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE:
      return `${where} ${verb} ${observation.receiver}, the SDK's debugging surface ${origin}. Code that depends on it depends on a debugger global rather than the SDK's public API; use next.getCartData() and the SDK's public events instead.`;
    case SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER:
      return `${where} ${verb} ${observation.receiver} ${origin}. The receiver is reached from the SDK's ${observation.receiver.split(".")[0]} global, and members starting with an underscore are not part of its public API; they can change in any SDK release. Use the public API or an SDK attribute for the behaviour instead.`;
    default:
      return `${where} ${verb} ${observation.receiver} ${origin}.`;
  }
}

/**
 * The advisory warnings for collected observations, in script then source
 * order, at most SCRIPT_OBSERVATIONS_LIMIT plus one truncation warning. Pure.
 *
 * @param {{ scripts?: Array<{ file: string, module?: boolean, pages?: string[], observations?: object[] }> }} input
 * @returns {Array<{ code: string, message: string, finding: object }>}
 */
export function evaluateBuiltScriptObservations({ scripts = [] } = {}) {
  const warnings = [];
  let total = 0;
  for (const script of Array.isArray(scripts) ? scripts : []) {
    const pages = Array.isArray(script.pages) ? script.pages : [];
    const module = Boolean(script.module);
    for (const observation of Array.isArray(script.observations) ? script.observations : []) {
      total += 1;
      if (warnings.length >= SCRIPT_OBSERVATIONS_LIMIT) continue;
      const finding = {
        code: observation.code,
        file: script.file,
        line: observation.line,
        column: observation.column,
        source_type: module ? "module" : "script",
        pages,
        operation: observation.operation,
        receiver: observation.receiver,
        ...(observation.key && { key: observation.key }),
        delivery: "local",
        ownership: "unknown",
        provenance: null,
      };
      warnings.push({ code: observation.code, message: describe(observation, { file: script.file, module, pages }), finding });
    }
  }
  if (total > warnings.length) {
    const omitted = total - warnings.length;
    warnings.push({
      code: SCRIPT_OBSERVATIONS_TRUNCATED,
      message: `${omitted} further script API/storage observation(s) are not listed; doctor lists the first ${SCRIPT_OBSERVATIONS_LIMIT}.`,
      finding: { code: SCRIPT_OBSERVATIONS_TRUNCATED, listed: warnings.length, omitted },
    });
  }
  return warnings;
}
