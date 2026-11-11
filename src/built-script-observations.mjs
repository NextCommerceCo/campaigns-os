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
//   or `XMLHttpRequest.prototype.open`/`send` (`=`, or `&&=`, which assigns
//   over the defined browser function; `||=` and `??=` do not), or a
//   defineProperty whose literal descriptor sets its value or accessors.
//   Every caller on the page,
//   the SDK included, then goes through it; whether it changes an SDK request
//   is not established statically, so no bypass is claimed.
// - sdk_debug_surface: a reference to the SDK's `nextDebug` global, its
//   debugging surface.
// - sdk_private_member: an underscore member reached from the SDK's own
//   globals (`next`, `NextCommerce`). An underscore member on any other
//   receiver is not reported: the name alone does not make it the SDK's.
// - incomplete: the analysis of a script that parsed did not finish (an
//   expression nested too deep to resolve), so its observations are not
//   listed rather than read as none.
//
// Inputs: the syntax gate's builtLocalScripts and their shared programs,
// keyed by path plus classic/module, since the same bytes can parse and
// resolve differently as either. A script that cannot be read or does not
// parse yields no observation here; the syntax gate owns that failure.
//
// Every finding records the delivery form (always `local` here), ownership
// (`unknown`: these observations do not consult the family script reference
// to tell campaign code from a family copy) and provenance (null until there
// is an ownership claim to prove).

import { parse as parseJs } from "acorn";

import { builtLocalScripts, builtScriptReferences } from "./built-script-syntax.mjs";
import { children as childNodes, javaScriptScopeAnalysis } from "./sdk-storage-compatibility.mjs";

export const SCRIPT_OBSERVATIONS = "built_output.script_observations";
export const SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE = `${SCRIPT_OBSERVATIONS}.sdk_prefixed_storage`;
export const SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED = `${SCRIPT_OBSERVATIONS}.network_global_replaced`;
export const SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE = `${SCRIPT_OBSERVATIONS}.sdk_debug_surface`;
export const SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER = `${SCRIPT_OBSERVATIONS}.sdk_private_member`;
export const SCRIPT_OBSERVATIONS_TRUNCATED = `${SCRIPT_OBSERVATIONS}.truncated`;
export const SCRIPT_OBSERVATIONS_INCOMPLETE = `${SCRIPT_OBSERVATIONS}.incomplete`;

// Warnings past this many are counted in one truncation warning instead.
export const SCRIPT_OBSERVATIONS_LIMIT = 50;

const SDK_STORAGE_PREFIX = /^next[-_]/;
const SDK_GLOBALS = ["next", "NextCommerce"];
const XHR_METHODS = new Set(["open", "send"]);
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
// `&&=` assigns whenever the target is truthy, as the browser's fetch is;
// `||=` and `??=` leave it in place.
const REPLACING_OPERATORS = new Set(["=", "&&="]);
const DESCRIPTOR_BEHAVIOUR = new Set(["value", "get", "set"]);

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
  const topLevel = scopes.get(program);
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
      // A bare `fetch = ...` assigns the global when nothing binds it, or when
      // the binding is a classic script's top-level `var` or function, which
      // is the global object's own property. A top-level `let`, `const` or
      // `class` is a lexical binding beside it, never `window.fetch`.
      if (target.name !== "fetch") return null;
      const bound = binding("fetch", scopes.get(target));
      const global = !bound || (!module && topLevel.bindings.get("fetch") === bound && (bound.kind === "var" || bound.kind === "function"));
      return global ? "fetch" : null;
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

  // A defineProperty descriptor that sets the value or an accessor. One that
  // only changes attributes (`enumerable`, `writable`) keeps the function,
  // and a descriptor not written out here establishes nothing.
  const setsBehaviour = (descriptor) => descriptor?.type === "ObjectExpression" && descriptor.properties.some((property) => property.type === "Property"
    && DESCRIPTOR_BEHAVIOUR.has(property.computed ? literal(property.key, scopes.get(descriptor)) : property.key.name ?? property.key.value));

  // Iterative, in source order, like the scope analysis it reads.
  const pending = [[program, null, false]];
  while (pending.length) {
    const [node, parent, inFunction] = pending.pop();
    if (node.type === "AssignmentExpression" && REPLACING_OPERATORS.has(node.operator)) {
      const replaced = replacesNetworkGlobal(node.left);
      if (replaced) add(SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED, node.left, { operation: "replace", receiver: replaced });
    }
    // Object.defineProperty(window, "fetch", ...)
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier" && node.callee.object.name === "Object"
      && !binding("Object", scopes.get(node)) && memberName(node.callee) === "defineProperty" && literal(node.arguments[1], scopes.get(node)) === "fetch"
      && setsBehaviour(node.arguments[2])) {
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
    // A destructure from the global object reads nextDebug there:
    // `const { nextDebug } = window` (its later uses are an alias, not reported).
    if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init) {
      const global = browserGlobal(node.init, scopes.get(node));
      for (const property of global && !global.shadowed ? node.id.properties : []) {
        const key = property.type === "Property" ? (property.computed ? literal(property.key, scopes.get(node)) : property.key.name) : null;
        if (key === "nextDebug") add(SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE, property, { operation: "read", receiver: `${node.init.name}.nextDebug` });
      }
    }
    const name = node.type === "Identifier" ? node.name : node.type === "MemberExpression" ? memberName(node) : null;
    // Only the global itself: an alias (`const d = window.nextDebug`, or one
    // named nextDebug) is reported where it reads the global, not again where
    // the alias is used, so an identifier counts only while nothing binds it.
    if (name === "nextDebug" && isReference(node, parent) && sdkGlobal(node, ["nextDebug"])
      && (node.type === "MemberExpression" || !binding("nextDebug", scopes.get(node)))) {
      add(SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE, node, { operation: accessOf(node, parent), receiver: globalSpelling(node, "nextDebug") });
      continue;
    }
    if (node.type === "MemberExpression") {
      if (typeof name === "string" && name.startsWith("_")) {
        const receiver = sdkReceiver(node.object);
        if (receiver) add(SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER, node, { operation: accessOf(node, parent), receiver: `${receiver}.${name}` });
      }
    }
    const nested = inFunction || FUNCTION_TYPES.has(node.type) || node.type === "StaticBlock";
    const next = childNodes(node);
    for (let i = next.length - 1; i >= 0; i--) pending.push([next[i], node, nested]);
  }
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

/**
 * Observations for every local script the built pages load, one entry per
 * path and mode in first-seen order (the script syntax gate's order).
 *
 * @param {{ site_root: string, campaign_dir: string, pages: Array<{ page_id: string, built_path: string }> }} scope
 * @param {string} targetRepo
 * @returns {{ scripts_observed: number, scripts: Array<{ file: string, module: boolean, pages: string[], observations: object[] }> }}
 */
export function collectBuiltScriptObservations(scope, targetRepo) {
  const observed = [];
  for (const script of builtLocalScripts(builtScriptReferences(scope).refs, targetRepo)) {
    let program;
    try {
      program = script.program();
    } catch {
      continue;
    }
    const entry = { file: script.file, module: script.module, pages: script.pages, observations: [] };
    try {
      entry.observations = observeScriptProgram(program, { module: script.module });
    } catch (error) {
      // An advisory never stops doctor's report. What remains recursive
      // (resolving a deeply nested key or alias) can still exhaust the stack.
      entry.incomplete = { reason: error?.name || "Error" };
    }
    observed.push(entry);
  }
  return { scripts_observed: observed.length, scripts: observed };
}

function loadedAs(script) {
  return `local ${script.module ? "module" : "classic script"}${script.pages.length ? `, loaded by ${script.pages.join(", ")}` : ""}`;
}

function describeIncomplete(script) {
  return `${script.file} (${loadedAs(script)}): doctor could not finish its script API/storage analysis (${script.incomplete.reason}), so any observations in it are not listed. The script parses; the syntax gate is unaffected.`;
}

const OPERATION_VERBS = { read: "reads", write: "writes", remove: "removes", call: "calls", replace: "replaces" };

function describe(observation, script) {
  const where = `${script.file}:${observation.line}:${observation.column}`;
  const verb = OPERATION_VERBS[observation.operation] || observation.operation;
  const origin = `(${loadedAs(script)}; owner not established)`;
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
 * order, at most SCRIPT_OBSERVATIONS_LIMIT plus one truncation warning, and
 * one incomplete warning (outside the limit) per script whose analysis did
 * not finish. Pure.
 *
 * @param {{ scripts?: Array<{ file: string, module?: boolean, pages?: string[], observations?: object[], incomplete?: { reason: string } }> }} input
 * @returns {Array<{ code: string, message: string, finding: object }>}
 */
export function evaluateBuiltScriptObservations({ scripts = [] } = {}) {
  const warnings = [];
  let total = 0;
  let listed = 0;
  for (const script of Array.isArray(scripts) ? scripts : []) {
    const pages = Array.isArray(script.pages) ? script.pages : [];
    const module = Boolean(script.module);
    if (script.incomplete) {
      warnings.push({
        code: SCRIPT_OBSERVATIONS_INCOMPLETE,
        message: describeIncomplete({ file: script.file, module, pages, incomplete: script.incomplete }),
        finding: { code: SCRIPT_OBSERVATIONS_INCOMPLETE, file: script.file, source_type: module ? "module" : "script", pages, reason: script.incomplete.reason, delivery: "local", ownership: "unknown", provenance: null },
      });
    }
    for (const observation of Array.isArray(script.observations) ? script.observations : []) {
      total += 1;
      if (listed >= SCRIPT_OBSERVATIONS_LIMIT) continue;
      listed += 1;
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
  if (total > listed) {
    const omitted = total - listed;
    warnings.push({
      code: SCRIPT_OBSERVATIONS_TRUNCATED,
      message: `${omitted} further script API/storage observation(s) are not listed; doctor lists the first ${SCRIPT_OBSERVATIONS_LIMIT}.`,
      finding: { code: SCRIPT_OBSERVATIONS_TRUNCATED, listed, omitted },
    });
  }
  return warnings;
}
