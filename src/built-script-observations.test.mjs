// API/storage observations in campaign scripts (#729, #730 milestone 3):
// advisory warnings that name the operation, file, line and column, and only
// when the receiver and key are verified. fixtures/script-observations holds
// one script per shape: supported, ambiguous, shadowed, aliased, and one file
// loaded as a classic script on one page and as a module on another.

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  SCRIPT_OBSERVATIONS,
  SCRIPT_OBSERVATIONS_LIMIT,
  SCRIPT_OBSERVATIONS_TRUNCATED,
  SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED,
  SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE,
  SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE,
  SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER,
  collectBuiltScriptObservations,
  evaluateBuiltScriptObservations,
  observeScriptSource,
} from "./built-script-observations.mjs";
import { SCRIPT_SYNTAX, SCRIPT_SYNTAX_PARSE_FAILURE } from "./built-script-syntax.mjs";
import { doctorBuiltOutput } from "./doctor/inspect.mjs";
import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import { withHtmlScanSnapshot } from "./html-scan.mjs";
import { analyzeStorageJavaScript } from "./sdk-storage-compatibility.mjs";

const FIXTURE_ROOT = resolve(new URL("../fixtures/script-observations", import.meta.url).pathname);
const SLUG = "example-campaign";
const RUNS_AS_ROOT = process.getuid?.() === 0;
const observationsOf = (result) => result.warnings.filter((issue) => issue.code.startsWith(`${SCRIPT_OBSERVATIONS}.`));
const row = ({ detail: { finding } }) => [finding.file.split("/").pop(), finding.line, finding.column, finding.source_type, finding.code.split(".").pop(), finding.operation, finding.receiver, finding.key ? `${finding.key.match}:${finding.key.text}` : null];
const shape = (source, options) => observeScriptSource(source, options).map((item) => [item.code.split(".").pop(), item.operation, item.receiver, item.key ? `${item.key.match}:${item.key.text}` : null]);

test("the fixture reports exactly the verified shapes, as advisory warnings with file, line and column", () => {
  const result = doctorBuiltOutput({ built: FIXTURE_ROOT, slug: SLUG });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(observationsOf(result).map(row), [
    ["supported.js", 4, 3, "script", "sdk_prefixed_storage", "write", "sessionStorage", "prefix:next_selected_currency__"],
    ["supported.js", 5, 16, "script", "sdk_prefixed_storage", "read", "localStorage", "exact:next-campaign-cache"],
    ["supported.js", 6, 3, "script", "network_global_replaced", "replace", "window.fetch", null],
    ["supported.js", 9, 3, "script", "network_global_replaced", "replace", "XMLHttpRequest.prototype.send", null],
    ["supported.js", 10, 14, "script", "sdk_debug_surface", "read", "window.nextDebug", null],
    ["supported.js", 11, 3, "script", "sdk_private_member", "write", "next._selector._getSelectedBundleItems", null],
    // ambiguous.js and shadowed.js: nothing verifies an SDK receiver or key.
    ["aliases.js", 7, 15, "module", "sdk_debug_surface", "read", "window.nextDebug", null],
    ["aliases.js", 8, 1, "module", "sdk_prefixed_storage", "remove", "sessionStorage", "exact:next-order"],
    ["aliases.js", 9, 1, "module", "sdk_prefixed_storage", "write", "localStorage", "prefix:next-checkout-store__"],
    ["aliases.js", 10, 1, "module", "network_global_replaced", "replace", "window.fetch", null],
    ["aliases.js", 11, 1, "module", "sdk_private_member", "read", "next._state", null],
    // global-fetch.js is classic on checkout and a module on upsell: only the classic load replaces window.fetch.
    ["global-fetch.js", 3, 10, "script", "network_global_replaced", "replace", "fetch", null],
  ]);
  const [first] = observationsOf(result);
  assert.deepEqual(first.detail.finding, {
    code: SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE,
    file: `_site/${SLUG}/js/supported.js`,
    line: 4,
    column: 3,
    source_type: "script",
    pages: ["checkout"],
    operation: "write",
    receiver: "sessionStorage",
    key: { text: "next_selected_currency__", match: "prefix" },
    delivery: "local",
    ownership: "unknown",
    provenance: null,
  });
  assert.match(first.message, /^_site\/example-campaign\/js\/supported\.js:4:3 writes a sessionStorage key starting "next_selected_currency__" \(the rest is computed\) \(local classic script, loaded by checkout; owner not established\)\. The key starts with the SDK's next prefix, but the name alone does not establish that the SDK owns it\./);
  // No gate, ready line or trace entry of its own: the advisory adds warnings and nothing else.
  assert.equal(result.derived.doctor_checks.some((id) => id.startsWith(SCRIPT_OBSERVATIONS)), false);
  assert.equal(result.derived.checkpoint_gates.some((gate) => gate.id.startsWith(SCRIPT_OBSERVATIONS)), false);
  assert.equal(result.ready.some((line) => /observation/i.test(line)), false);
});

test("no message claims an SDK bypass or SDK ownership the evidence does not support", () => {
  const result = doctorBuiltOutput({ built: FIXTURE_ROOT, slug: SLUG });
  for (const { message } of observationsOf(result)) {
    assert.doesNotMatch(message, /\bbypass(es)?\b|\bSDK-owned\b|\bowned by the SDK\b/i);
  }
  const byCode = Object.fromEntries(observationsOf(result).map((issue) => [issue.code, issue.message]));
  assert.match(byCode[SCRIPT_OBSERVATION_NETWORK_GLOBAL_REPLACED], /whether it changes an SDK request is not established statically/);
  assert.match(byCode[SCRIPT_OBSERVATION_SDK_PREFIXED_STORAGE], /the name alone does not establish that the SDK owns it/);
  assert.match(byCode[SCRIPT_OBSERVATION_SDK_PRIVATE_MEMBER], /reached from the SDK's next global/);
  assert.match(byCode[SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE], /debugging surface/);
});

test("an underscore member is reported only on a receiver reached from an SDK global", () => {
  assert.deepEqual(shape("selector._getSelectedBundleItems = f;"), []);
  assert.deepEqual(shape("document.body._next = 1;"), []);
  assert.deepEqual(shape("var sdk = window.next; sdk._cart = null;"), [], "a var alias can be reassigned");
  assert.deepEqual(shape("window.next.cart.items = [];"), [], "a public member");
  assert.deepEqual(shape("const sdk = window.NextCommerce; sdk.store._items.push(1);"), [["sdk_private_member", "read", "NextCommerce.store._items", null]]);
  assert.deepEqual(shape("next['_cart']();"), [["sdk_private_member", "call", "next._cart", null]]);
  assert.deepEqual(shape("it.next._x;"), [], "a property named next is not the global");
});

test("a fetch reassignment is reported only when it replaces the page's global fetch", () => {
  assert.deepEqual(shape("api.fetch = f; const o = { fetch: f };"), []);
  assert.deepEqual(shape("let fetch = f; fetch = g;"), [], "a local binding");
  assert.deepEqual(shape("fetch = wrap(fetch);"), [["network_global_replaced", "replace", "fetch", null]]);
  assert.deepEqual(shape("self['fetch'] = f;"), [["network_global_replaced", "replace", "window.fetch", null]]);
  assert.deepEqual(shape("Object.defineProperty(window, 'fetch', { value: f });"), [["network_global_replaced", "replace", "window.fetch", null]]);
  assert.deepEqual(shape("window.XMLHttpRequest.prototype.open = f; XMLHttpRequest.prototype.abort = g;"), [["network_global_replaced", "replace", "XMLHttpRequest.prototype.open", null]]);
});

test("storage observations need the browser's own storage and a key that starts with the SDK prefix", () => {
  assert.deepEqual(shape("localStorage.setItem('timer_end', 1); sessionStorage.getItem(key);"), []);
  assert.deepEqual(shape("localStorage.getItem('nextOrder');"), [], "no separator after next");
  assert.deepEqual(shape("sessionStorage.next_order = '{}'; delete localStorage['next-x'];"), [
    ["sdk_prefixed_storage", "write", "sessionStorage", "exact:next_order"],
    ["sdk_prefixed_storage", "remove", "localStorage", "exact:next-x"],
  ]);
  assert.deepEqual(shape("const p = 'next_'; const k = p + 'funnel__' + scope; sessionStorage.getItem(k);"), [["sdk_prefixed_storage", "read", "sessionStorage", "prefix:next_funnel__"]]);
  assert.deepEqual(shape("let p = 'next_'; sessionStorage.getItem(p + scope);"), [], "a let prefix can change");
  assert.deepEqual(shape("sessionStorage.getItem(scope + 'next_x');"), [], "the prefix must be at the start");
  assert.deepEqual(shape("const { sessionStorage: s } = window; s.removeItem('next-order');"), [["sdk_prefixed_storage", "remove", "sessionStorage", "exact:next-order"]]);
  assert.deepEqual(shape("let { sessionStorage: s } = window; s.removeItem('next-order');"), [], "a mutable destructure");
  assert.deepEqual(shape("sessionStorage.key(0); sessionStorage.length; sessionStorage.clear();"), []);
});

test("shadowed globals are never the browser's or the SDK's", () => {
  assert.deepEqual(shape("(function (window, sessionStorage, next, nextDebug, XMLHttpRequest) { window.fetch = f; sessionStorage.setItem('next-order', 1); next._a; nextDebug.stores; XMLHttpRequest.prototype.send = f; })(w, s, n, d, X);"), []);
  assert.deepEqual(shape("{ const localStorage = memory; localStorage.getItem('next-order'); }"), []);
  assert.deepEqual(shape("class A { m(globalThis) { globalThis.fetch = f; } }"), []);
});

test("a const or destructure that binds a global's own name to that global still refers to it", () => {
  assert.deepEqual(shape("const next = window.next; next._cart = null;"), [["sdk_private_member", "write", "next._cart", null]]);
  assert.deepEqual(shape("const localStorage = window.localStorage; localStorage.getItem('next-x');"), [["sdk_prefixed_storage", "read", "localStorage", "exact:next-x"]]);
  assert.deepEqual(shape("const { sessionStorage } = window; sessionStorage.removeItem('next-order');"), [["sdk_prefixed_storage", "remove", "sessionStorage", "exact:next-order"]]);
  // Bound to anything else, or mutable, the name is shadowed.
  assert.deepEqual(shape("const next = makeNext(); next._cart = null;"), []);
  assert.deepEqual(shape("let next = window.next; next._cart = null;"), []);
  assert.deepEqual(shape("let { sessionStorage } = window; sessionStorage.removeItem('next-order');"), []);
  assert.deepEqual(shape("const fetch = window.fetch; fetch = f;"), [], "assigning a const throws; it never replaces the global");
});

test("logical assignment does not replace a defined fetch, and delete reads as a removal", () => {
  assert.deepEqual(shape("window.fetch ||= f; globalThis.fetch ??= f; self.fetch &&= f; fetch ||= f; XMLHttpRequest.prototype.send ??= f;"), []);
  assert.deepEqual(shape("delete window.nextDebug; delete next._x;"), [
    ["sdk_debug_surface", "remove", "window.nextDebug", null],
    ["sdk_private_member", "remove", "next._x", null],
  ]);
  assert.match(evaluateBuiltScriptObservations({ scripts: [{ file: "js/a.js", pages: [], observations: observeScriptSource("delete next._x;") }] })[0].message, /^js\/a\.js:1:8 removes next\._x /);
});

test("the debug surface is reported where the global is read, not again through an alias", () => {
  assert.deepEqual(shape("const d = window.nextDebug; d.stores.cart.getState(); d.x;"), [["sdk_debug_surface", "read", "window.nextDebug", null]]);
  assert.deepEqual(shape("if (typeof nextDebug !== 'undefined') nextDebug.stores;"), [
    ["sdk_debug_surface", "read", "nextDebug", null],
    ["sdk_debug_surface", "read", "nextDebug", null],
  ]);
  assert.deepEqual(shape("window.nextDebug = { stores: {} };"), [["sdk_debug_surface", "write", "window.nextDebug", null]]);
  assert.deepEqual(shape("const o = { nextDebug: 1 }; o.nextDebug;"), []);
});

test("classic and module reads of the same bytes differ where the browser's do", () => {
  const declared = "function fetch(input) { return input; }\nvar XMLHttpRequest = 1;";
  assert.deepEqual(shape(declared), [["network_global_replaced", "replace", "fetch", null]]);
  assert.deepEqual(shape(declared, { module: true }), []);
  assert.deepEqual(shape("var fetch = wrap(window.fetch);"), [["network_global_replaced", "replace", "fetch", null]]);
  assert.deepEqual(shape("var fetch;"), [], "a var without an initializer keeps the global's value");
  assert.deepEqual(shape("function wrap() { var fetch = f; function fetch2() {} }"), [], "inside a function");
  // An HTML-like comment parses only as a classic script; a module that does not parse has no observations.
  const commented = "<!-- legacy\nsessionStorage.setItem('next-order', '{}');";
  assert.deepEqual(shape(commented), [["sdk_prefixed_storage", "write", "sessionStorage", "exact:next-order"]]);
  assert.deepEqual(shape(commented, { module: true }), []);
});

test("the storage analysis reads a classic script as a script; the tracked-source scan stays a module read", () => {
  const manifest = { keys: [] };
  const commented = "<!-- legacy\nsessionStorage.getItem('timer');";
  const asModule = analyzeStorageJavaScript(commented, { manifest, targetSdkVersion: "0.4.40" });
  assert.equal(asModule[0].reason, "parse-failure");
  const asScript = analyzeStorageJavaScript(commented, { manifest, targetSdkVersion: "0.4.40", sourceType: "script" });
  assert.deepEqual(asScript.map((finding) => [finding.line, finding.reason, finding.key]), [[2, "literal-unaffected-key", "timer"]]);
});

test("missing, remote, unreadable and unparsable scripts yield no observation and do not throw", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-script-observations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const siteRoot = join(dir, "_site", SLUG);
  cpSync(join(FIXTURE_ROOT, "_site", SLUG), siteRoot, { recursive: true });
  writeFileSync(join(siteRoot, "checkout", "index.html"), `<!DOCTYPE html><html><head>
    <script src="/${SLUG}/js/not-built.js"></script>
    <script src="https://cdn.example.com/x.js"></script>
    <script src="/${SLUG}/js/broken.js"></script>
    <script src="/${SLUG}/js/locked.js"></script>
    <script src="/${SLUG}/js/supported.js"></script>
  </head><body></body></html>`);
  writeFileSync(join(siteRoot, "js", "broken.js"), "sessionStorage.setItem('next-order', 1);\n});\n");
  writeFileSync(join(siteRoot, "js", "locked.js"), "sessionStorage.setItem('next-order', 1);");
  if (!RUNS_AS_ROOT) chmodSync(join(siteRoot, "js", "locked.js"), 0o000);
  const scope = resolveBuiltSiteScope(dir, { slug: SLUG });
  const collected = withHtmlScanSnapshot(() => collectBuiltScriptObservations(scope, dir));
  const files = collected.scripts.map((script) => script.file.split("/").pop());
  assert.ok(!files.includes("not-built.js") && !files.includes("x.js") && !files.includes("broken.js"));
  if (!RUNS_AS_ROOT) assert.ok(!files.includes("locked.js"));
  assert.ok(files.includes("supported.js"));
  // The parse failure is the syntax gate's to report; the advisory runs beside the blocked gate.
  // (An unreadable script still escapes doctorBuiltOutput through the residue gate, as the
  // goldens pin, so the doctor run reads it again first.)
  chmodSync(join(siteRoot, "js", "locked.js"), 0o644);
  writeFileSync(join(siteRoot, "js", "locked.js"), "var locked;");
  const result = doctorBuiltOutput({ built: dir, slug: SLUG });
  assert.ok(result.errors.some((issue) => issue.code === SCRIPT_SYNTAX_PARSE_FAILURE));
  assert.ok(result.derived.doctor_checks.includes(SCRIPT_SYNTAX));
  assert.equal(observationsOf(result).filter((issue) => /broken\.js|locked\.js/.test(issue.message)).length, 0);
  assert.equal(observationsOf(result).length, 6, "supported.js is still observed");
});

test("one script loaded on several pages is observed once per source type, naming every page", () => {
  const result = doctorBuiltOutput({ built: FIXTURE_ROOT, slug: SLUG });
  const scope = resolveBuiltSiteScope(FIXTURE_ROOT, { slug: SLUG });
  const collected = withHtmlScanSnapshot(() => collectBuiltScriptObservations(scope, FIXTURE_ROOT));
  const globalFetch = collected.scripts.filter((script) => script.file.endsWith("global-fetch.js"));
  assert.deepEqual(globalFetch.map((script) => [script.module, script.pages, script.observations.length]), [[false, ["checkout"], 1], [true, ["upsell"], 0]]);
  assert.equal(collected.scripts_observed, 6);
  assert.equal(observationsOf(result).length, 12);
});

test("past the limit, observations are counted in one truncation warning", () => {
  const observations = Array.from({ length: SCRIPT_OBSERVATIONS_LIMIT + 3 }, (_, index) => ({
    code: SCRIPT_OBSERVATION_SDK_DEBUG_SURFACE, line: index + 1, column: 1, operation: "read", receiver: "nextDebug",
  }));
  const warnings = evaluateBuiltScriptObservations({ scripts: [{ file: "js/a.js", module: false, pages: ["checkout"], observations }] });
  assert.equal(warnings.length, SCRIPT_OBSERVATIONS_LIMIT + 1);
  assert.deepEqual(warnings.at(-1).finding, { code: SCRIPT_OBSERVATIONS_TRUNCATED, listed: SCRIPT_OBSERVATIONS_LIMIT, omitted: 3 });
  assert.deepEqual(evaluateBuiltScriptObservations({}), []);
});
