// Synthetic loopback fixtures for the unit 1.1 tracking-params browser tests
// (src/qa-tracking-params*.browser.test.mjs, src/qc-real-1-1.browser.test.mjs).
// Imported only by those tests; never shipped (src/.npmignore).
//
// The stub page script below stands in for the campaign-cart SDK's documented
// attribution behaviour, just far enough to drive `runBrowserTestOrders`:
//   - credited fields are collected from the URL by the SDK alias map
//     (utm_* as named; affid beats aff -> affiliate; the long form beats the
//     short one for subaffiliate1-5; funnel and gclid as named), merged over
//     what sessionStorage already holds, and persisted there;
//   - rendered <meta name="os-tracking-tag" data-tag-name data-tag-value> tags
//     are copied into attribution.metadata;
//   - the order create request carries { lines, attribution } with
//     attribution.landing_page and attribution.metadata, as the SDK sends them.
// It is NOT the SDK. It proves the observer, not the SDK (contract 1.1 Code
// plan, Tests). It deliberately contains no literal call of the three page
// script entry points, so only a test page's own inline script can read as
// page-script involvement.
//
// Every value is synthetic, every host is loopback (127.0.0.1), and two guards
// fail the running test on any non-loopback request, swallowed or not:
//   - node (installNodeGuard, the qc-test-factories pattern, letting loopback
//     through for the stub servers): fetch, which follows redirects itself so
//     that every hop's URL is checked before it is requested; http(s).request
//     and get; the WebSocket constructor; and, under all of them, every TCP or
//     TLS socket connect (net.Socket.prototype.connect), so a client that
//     bypasses the wrappers is still caught;
//   - every Chromium context Playwright launches in this process
//     (installBrowserGuard): each request and every hop of its redirect chain,
//     each redirect response's Location target, and each WebSocket a page
//     opens, plus a host resolver rule that keeps non-loopback names from
//     resolving at all.
// An attempt is recorded before it is refused, so a caller that swallows the
// error still fails its test at the next assertLoopbackOnly().
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http, { createServer } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

// ---------------------------------------------------------------------------
// Network guards

const nodeAttempts = [];
const browserAttempts = [];
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1", "::ffff:127.0.0.1"];
const LOCAL_SCHEMES = ["data:", "about:", "blob:", "chrome-error:", "chrome:"];

export function isLoopbackUrl(value) {
  try {
    const url = new URL(String(value));
    if (LOCAL_SCHEMES.includes(url.protocol)) return true;
    return LOOPBACK_HOSTS.includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  } catch {
    return false;
  }
}

const isLoopbackHost = (host) => LOOPBACK_HOSTS.includes(String(host)) || /^127\.\d+\.\d+\.\d+$/.test(String(host));

function targetOf(input) {
  if (typeof input === "string" || input instanceof URL) return String(input);
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  const host = input?.hostname ?? input?.host ?? "localhost";
  return `${input?.protocol ?? "http:"}//${host}${input?.port ? `:${input.port}` : ""}${input?.path ?? ""}`;
}

const blocked = (target) => new Error(`tracking fixtures: non-loopback request blocked (${target})`);

// fetch with every redirect hop checked before it is requested: the request
// goes out with redirect "manual" and the guard follows a 3xx itself (fetch
// spec method rewrite for 301/302 POST and 303), unless the caller asked for
// "manual" or "error".
function guardFetch(originalFetch) {
  const guarded = async (input, init) => {
    const first = targetOf(input);
    if (!isLoopbackUrl(first)) {
      nodeAttempts.push(`fetch ${first}`);
      throw blocked(first);
    }
    const request = new Request(input, init);
    if (request.redirect !== "follow") return originalFetch(request);
    const body = request.body ? await request.arrayBuffer() : null;
    let hop = { url: request.url, method: request.method, body };
    for (let count = 0; count <= 20; count += 1) {
      const response = await originalFetch(new Request(hop.url, { method: hop.method, headers: request.headers, body: hop.body, redirect: "manual", signal: request.signal }));
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        if (count) {
          Object.defineProperty(response, "url", { value: hop.url });
          Object.defineProperty(response, "redirected", { value: true });
        }
        return response;
      }
      const next = new URL(location, hop.url).href;
      if (!isLoopbackUrl(next)) {
        nodeAttempts.push(`fetch redirect ${hop.url} -> ${next}`);
        throw blocked(next);
      }
      const rewrite = response.status === 303 || ([301, 302].includes(response.status) && hop.method === "POST");
      hop = { url: next, method: rewrite ? "GET" : hop.method, body: rewrite ? null : hop.body };
    }
    throw new TypeError("tracking fixtures: too many redirects");
  };
  guarded.__trackingGuard = true;
  return guarded;
}

function guardTransport(module, name, method) {
  const original = module[method];
  const guarded = function guardedRequest(input, ...rest) {
    const target = targetOf(input);
    if (!isLoopbackUrl(target)) {
      nodeAttempts.push(`${name}.${method} ${target}`);
      throw blocked(target);
    }
    return original.call(this, input, ...rest);
  };
  guarded.__trackingGuard = true;
  return guarded;
}

function guardWebSocket(Original) {
  const Guarded = class extends Original {
    constructor(url, ...rest) {
      const target = String(url instanceof URL ? url.href : url);
      if (!isLoopbackUrl(target)) {
        nodeAttempts.push(`websocket ${target}`);
        throw blocked(target);
      }
      super(url, ...rest);
    }
  };
  Guarded.__trackingGuard = true;
  return Guarded;
}

// The connect target of net.Socket.prototype.connect's argument forms:
// (options), (path), (port[, host]) or net's internal normalized [options, cb]
// (net.connect, net.createConnection and tls.connect all arrive here). Only a
// path that is a non-empty string is an IPC connect; any other path (absent,
// "", null) is TCP and its host is checked. A bare string is a path only when
// net would not read it as a port (Number(value) >= 0).
function connectTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (typeof first.path === "string" && first.path !== "") return null;
    return { host: first.host ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && !(Number(first) >= 0)) return null;
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

function guardConnect(original) {
  const guarded = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (target && !isLoopbackHost(target.host)) {
      const label = `${target.host}:${target.port}`;
      nodeAttempts.push(`socket ${label}`);
      process.nextTick(() => this.destroy(blocked(label)));
      return this;
    }
    return original.apply(this, args);
  };
  guarded.__trackingGuard = true;
  return guarded;
}

let nodeGuardMode = null;
const nodeGuardIntact = () => {
  const socketsGuarded = net.Socket.prototype.connect.__trackingGuard === true
    && (globalThis.WebSocket == null || globalThis.WebSocket.__trackingGuard === true);
  if (nodeGuardMode !== "all") return socketsGuarded;
  return socketsGuarded
    && globalThis.fetch?.__trackingGuard === true
    && [http.request, http.get, https.request, https.get].every((method) => method.__trackingGuard === true);
};

// The QB files call this before anything loads the code under test. A file
// that imports src/qc-test-factories.mjs keeps that stricter fetch and
// http(s) guard (it blocks loopback too, and checks that it stays installed)
// and calls this with { transports: false }, which adds only the socket and
// WebSocket guards beneath it.
export function installNodeGuard({ transports = true } = {}) {
  process.env.CAMPAIGNS_OS_TELEMETRY = "off";
  nodeGuardMode = transports ? "all" : (nodeGuardMode ?? "sockets");
  if (transports && globalThis.fetch?.__trackingGuard !== true) globalThis.fetch = guardFetch(globalThis.fetch);
  if (transports) {
    for (const [module, name] of [[http, "http"], [https, "https"]]) {
      for (const method of ["request", "get"]) {
        if (module[method].__trackingGuard !== true) module[method] = guardTransport(module, name, method);
      }
    }
  }
  if (globalThis.WebSocket && globalThis.WebSocket.__trackingGuard !== true) globalThis.WebSocket = guardWebSocket(globalThis.WebSocket);
  if (net.Socket.prototype.connect.__trackingGuard !== true) net.Socket.prototype.connect = guardConnect(net.Socket.prototype.connect);
  syncBuiltinESMExports();
}

let browserGuardInstalled = false;
const watchedContexts = new WeakSet();
const watchedPages = new WeakSet();

function noteBrowser(kind, url) {
  if (!isLoopbackUrl(url)) browserAttempts.push(`browser ${kind} ${url}`);
}

function watchPage(page) {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on("websocket", (socket) => noteBrowser("websocket", socket.url()));
}

function watchContext(context) {
  if (watchedContexts.has(context)) return context;
  watchedContexts.add(context);
  context.on("request", (request) => {
    // Every hop: the request itself and each request it was redirected from.
    for (let hop = request; hop; hop = hop.redirectedFrom()) noteBrowser(hop.method(), hop.url());
  });
  context.on("response", (response) => {
    const location = response.headers().location;
    if (response.status() >= 300 && response.status() < 400 && location) {
      let target = location;
      try { target = new URL(location, response.url()).href; } catch { /* recorded as given */ }
      noteBrowser("redirect", target);
    }
  });
  context.on("page", watchPage);
  for (const page of context.pages()) watchPage(page);
  return context;
}

// Patches the process's Playwright chromium launcher, which the package's
// launcher (src/browser-launch.mjs) imports and calls.
export async function installBrowserGuard() {
  if (browserGuardInstalled) return;
  const { chromium } = await import("playwright");
  const launch = chromium.launch.bind(chromium);
  const launchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const resolverRule = "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1";
  chromium.launch = async (options = {}) => {
    const browser = await launch({ ...options, args: [...(options.args || []), resolverRule] });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => watchContext(await newContext(...args));
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      watchContext(page.context());
      watchPage(page);
      return page;
    };
    return browser;
  };
  chromium.launchPersistentContext = async (dir, options = {}) => watchContext(await launchPersistentContext(dir, { ...options, args: [...(options.args || []), resolverRule] }));
  browserGuardInstalled = true;
}

// The per-test check: every non-loopback attempt since the last check fails
// the running test, as does a node guard the code under test removed (it is
// put back).
export function assertLoopbackOnly() {
  const attempts = [...nodeAttempts.splice(0), ...browserAttempts.splice(0)];
  const intact = nodeGuardMode == null || nodeGuardIntact();
  if (nodeGuardMode != null) installNodeGuard({ transports: nodeGuardMode === "all" });
  assert.deepEqual(attempts, [], "no request left loopback");
  assert.equal(intact, true, "the loopback-only guard was left installed");
}

// Chromium is required under CAMPAIGNS_OS_REQUIRE_BROWSER=1; without it the
// file skips, as every browser lane test does (rule 11).
export async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

// ---------------------------------------------------------------------------
// The contract's seed policy, as data the tests compare against (contract 1.1
// "Seed set", "Credited fields not seeded by default").

export const DEFAULT_URL_KEYS = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "affid", "sub1", "subaffiliate2"]);
export const UTM_FIELDS = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
export const SEEDED_ORDER_FIELDS = Object.freeze([...UTM_FIELDS, "affiliate", "subaffiliate1", "subaffiliate2"]);
export const NOT_SEEDED_ORDER_FIELDS = Object.freeze(["funnel", "gclid", "subaffiliate3", "subaffiliate4", "subaffiliate5"]);
export const DEFAULT_ORDER_KEYS = Object.freeze([...SEEDED_ORDER_FIELDS, ...NOT_SEEDED_ORDER_FIELDS]);
export const SEED_VALUE = /^cosqa_[a-z0-9_]+_[0-9a-f]{8}$/;

export const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const syntheticMarker = (label) => `syn_private_${label}_${randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------
// The stub page script (served as /stub-sdk.js).

const STUB_SDK_JS = String.raw`(function () {
  var C = window.__stubConfig || {};
  var ATTRIBUTION = "stub-sdk:attribution";
  var PARAMS = "stub-sdk:params";
  var LANDING = "stub-sdk:landing";
  var CART = "stub-sdk:cart";
  var ENTERED = "stub-sdk:entered";
  var BOUNCED = "stub-sdk:bounced";
  var FIELD_SOURCES = {
    utm_source: ["utm_source"], utm_medium: ["utm_medium"], utm_campaign: ["utm_campaign"],
    utm_content: ["utm_content"], utm_term: ["utm_term"],
    affiliate: ["affid", "aff"],
    subaffiliate1: ["subaffiliate1", "sub1"], subaffiliate2: ["subaffiliate2", "sub2"],
    subaffiliate3: ["subaffiliate3", "sub3"], subaffiliate4: ["subaffiliate4", "sub4"],
    subaffiliate5: ["subaffiliate5", "sub5"],
    funnel: ["funnel"], gclid: ["gclid"]
  };
  function read(store, key, fallback) {
    try { var value = store.getItem(key); return value ? JSON.parse(value) : fallback; } catch (e) { return fallback; }
  }
  function write(store, key, value) { store.setItem(key, JSON.stringify(value)); }

  var params = new URLSearchParams(location.search);
  var attribution = read(sessionStorage, ATTRIBUTION, {});
  Object.keys(FIELD_SOURCES).forEach(function (field) {
    var names = FIELD_SOURCES[field];
    for (var i = 0; i < names.length; i += 1) {
      if (params.has(names[i])) { attribution[field] = params.get(names[i]); break; }
    }
  });
  write(sessionStorage, ATTRIBUTION, attribution);
  // Every query parameter seen, for the preserve-on-navigation mode.
  var seen = read(sessionStorage, PARAMS, {});
  params.forEach(function (value, name) { if (name !== "ref_id" && name.indexOf("syn_private") !== 0) seen[name] = value; });
  write(sessionStorage, PARAMS, seen);
  if (!sessionStorage.getItem(LANDING)) sessionStorage.setItem(LANDING, location.href + (C.landingExtra ? (location.search ? "&" : "?") + C.landingExtra : ""));

  var metadata = {};
  Array.prototype.forEach.call(document.querySelectorAll('meta[name="os-tracking-tag"], meta[name="data-next-tracking-tag"]'), function (meta) {
    var name = meta.getAttribute("data-tag-name");
    if (name && (C.metadataOmit || []).indexOf(name) === -1) metadata[name] = meta.getAttribute("data-tag-value");
  });

  function cart() { return read(localStorage, CART, []); }
  function add(packageId) {
    var items = cart().filter(function (item) { return String(item.packageId) !== String(packageId); });
    items.push({ packageId: String(packageId), quantity: 1 });
    write(localStorage, CART, items);
  }
  if (document.body.hasAttribute("data-stub-reset-cart")) write(localStorage, CART, []);
  var preselected = document.querySelector("[data-next-bundle-selector] [data-next-selector-card].next-selected[data-next-package-id]");
  if (preselected && !cart().length) add(preselected.getAttribute("data-next-package-id"));

  window.next = {
    getCartCount: function () { return cart().reduce(function (sum, item) { return sum + item.quantity; }, 0); },
    setAttribution: function (values) { Object.keys(values || {}).forEach(function (key) { attribution[key] = values[key]; }); write(sessionStorage, ATTRIBUTION, attribution); },
    addMetadata: function (key, value) { metadata[key] = value; },
    setMetadata: function (values) { Object.keys(values || {}).forEach(function (key) { metadata[key] = values[key]; }); }
  };
  window.nextDebug = { stores: { cart: { getState: function () { return { items: cart() }; } } } };

  // The query a navigation carries: the current one, or (preserve mode) every
  // parameter seen so far.
  function forwardQuery() {
    if (!C.preserveFromStore) return location.search;
    var out = new URLSearchParams();
    Object.keys(seen).forEach(function (name) { out.set(name, seen[name]); });
    var text = out.toString();
    return text ? "?" + text : "";
  }
  function transform(search, rule) {
    if (!rule) return search;
    if (rule.strip) return "";
    var out = new URLSearchParams(search);
    (rule.drop || []).forEach(function (name) { out.delete(name); });
    Object.keys(rule.replace || {}).forEach(function (name) { if (out.has(name)) out.set(name, rule.replace[name]); });
    var text = out.toString();
    return text ? "?" + text : "";
  }

  document.addEventListener("click", function (event) {
    var control = event.target.closest('[data-next-action="add-to-cart"]');
    if (!control) return;
    event.preventDefault();
    add(control.getAttribute("data-next-package-id"));
    sessionStorage.setItem(ENTERED, "1");
    location.href = control.getAttribute("data-next-url") + forwardQuery();
  });

  var page = document.body.getAttribute("data-stub-page");
  if (page === "bridge") {
    setTimeout(function () {
      var query = transform(forwardQuery(), C.bridge);
      if (C.bridgeExtra) query += (query ? "&" : "?") + C.bridgeExtra;
      location.replace("/x/checkout/" + query);
    }, 50);
  }
  if (page === "checkout" && C.checkoutAwayTo && !sessionStorage.getItem(BOUNCED)) {
    sessionStorage.setItem(BOUNCED, "1");
    setTimeout(function () { location.replace(C.checkoutAwayTo + forwardQuery()); }, 50);
  }
  if (page === "checkout" && C.replaceStateDrop && sessionStorage.getItem(ENTERED)) {
    window.addEventListener("load", function () {
      setTimeout(function () {
        var url = new URL(location.href);
        C.replaceStateDrop.forEach(function (name) { url.searchParams.delete(name); });
        history.replaceState(null, "", url.pathname + url.search);
      }, 200);
    });
  }

  var lines = document.querySelector("[data-next-cart-summary] [data-summary-lines]");
  if (lines) {
    cart().forEach(function (item) {
      var row = document.createElement("div");
      row.setAttribute("data-next-package-id", item.packageId);
      row.textContent = "Package " + item.packageId + " x" + item.quantity;
      lines.appendChild(row);
    });
  }

  var receipt = document.querySelector("[data-next-order-items]");
  var refId = params.get("ref_id");
  if (receipt && refId) {
    fetch("/api/v1/orders/" + encodeURIComponent(refId) + "/").then(function (response) { return response.json(); }).then(function (order) {
      if (C.receiptRender === false) return;
      receipt.textContent = "";
      (order.lines || []).forEach(function (line) {
        var row = document.createElement("div");
        row.setAttribute("data-next-order-item", "");
        row.textContent = line.product_title + " x" + line.quantity;
        receipt.appendChild(row);
      });
      receipt.classList.add("order-has-items");
    });
  }

  function requestAttribution() {
    var out = {};
    Object.keys(attribution).forEach(function (key) { out[key] = attribution[key]; });
    var rule = C.attribution || {};
    Object.keys(rule.override || {}).forEach(function (key) { out[key] = rule.override[key]; });
    (rule.omit || []).forEach(function (key) { delete out[key]; });
    var landing = sessionStorage.getItem(LANDING) || location.href;
    out.landing_page = landing;
    var meta = { landing_page: landing, user_agent: navigator.userAgent, referrer: document.referrer };
    if (C.privateMetadata) meta.syn_private_meta = C.privateMetadata;
    Object.keys(metadata).forEach(function (key) { meta[key] = metadata[key]; });
    Object.keys(C.metadataOverride || {}).forEach(function (key) { meta[key] = C.metadataOverride[key]; });
    if (rule.testOrderKey) meta.test_order = true;
    out.metadata = meta;
    return out;
  }

  var form = document.querySelector("form[data-stub-checkout]");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (C.submit === "noop") return;
      var items = cart();
      if (!items.length) return;
      var body = { lines: items, attribution: requestAttribution() };
      if (C.omitAttribution) delete body.attribution;
      if (C.requestNote) body.syn_note = C.requestNote;
      fetch(C.createUrl || "/api/v1/orders/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: C.rawBody || JSON.stringify(body)
      }).then(function (response) {
        if (!response.ok) { document.body.setAttribute("data-stub-create", "rejected"); return null; }
        return response.json();
      }).then(function (order) {
        if (!order) return;
        write(localStorage, CART, []);
        if (C.afterCreate === "stay") return;
        if (C.afterCreate === "replaceState") {
          history.replaceState(null, "", location.pathname + location.search + (location.search ? "&" : "?") + "syn_state=done");
          return;
        }
        var query = new URLSearchParams(forwardQuery());
        var out = "ref_id=" + encodeURIComponent(order.ref_id);
        query.forEach(function (value, name) { if (name !== "ref_id") out += "&" + encodeURIComponent(name) + "=" + encodeURIComponent(value); });
        if (C.receiptExtra) out += "&" + C.receiptExtra;
        location.href = "/x/receipt/?" + out;
      }).catch(function () { document.body.setAttribute("data-stub-create", "failed"); });
    });
  }
})();
`;

// ---------------------------------------------------------------------------
// Pages

const CHECKOUT_FORM = `
  <form data-stub-checkout>
    <input data-next-checkout-field="fname" placeholder="First name">
    <input data-next-checkout-field="lname" placeholder="Last name">
    <input data-next-checkout-field="email" type="email" placeholder="Email">
    <input data-next-checkout-field="phone" placeholder="Phone">
    <select data-next-checkout-field="country"><option value="US">United States</option><option value="CA">Canada</option></select>
    <input data-next-checkout-field="address1" placeholder="Address">
    <input data-next-checkout-field="city" placeholder="City">
    <select data-next-checkout-field="province"><option value="CA">California</option><option value="NY">New York</option></select>
    <input data-next-checkout-field="postal" placeholder="Postal">
    <fieldset>
      <input type="radio" id="combo_mode_credit" name="payment_method" value="credit" checked>
      <iframe id="spreedly-number-frame-1" title="Card number" srcdoc="&lt;input aria-label=&quot;Card number&quot;&gt;"></iframe>
      <iframe id="spreedly-cvv-frame-1" title="CVV" srcdoc="&lt;input aria-label=&quot;CVV&quot;&gt;"></iframe>
      <select data-next-checkout-field="exp-month"><option value="">Month</option><option value="12">12</option></select>
      <select data-next-checkout-field="exp-year"><option value="">Year</option><option value="2030">2030</option></select>
    </fieldset>
    <button type="submit">Complete order</button>
  </form>`;

const SELECTOR = `
  <section data-next-bundle-selector data-next-selector-id="main">
    <div class="card next-selected" data-next-selector-card data-next-package-id="1">1 bottle</div>
    <div class="card" data-next-selector-card data-next-package-id="2">3 bottles</div>
  </section>`;

function tagMeta(tags = []) {
  return tags.map(({ name, value }) => `<meta name="os-tracking-tag" data-tag-name="${name}" data-tag-value="${value}">`).join("");
}

function pageHtml({ page, title, body, config, tags, inline = "", reset = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${tagMeta(tags)}
<style>body{font-family:sans-serif;margin:24px} .card{border:1px solid #ccc;padding:12px;margin:8px 0} .card.next-selected{border-color:#000} iframe{width:200px;height:32px;border:1px solid #ccc}</style>
</head>
<body data-stub-page="${page}"${reset ? " data-stub-reset-cart" : ""}>
<main>${body}</main>
<script>window.__stubConfig = ${JSON.stringify(config)};</script>
<script src="/stub-sdk.js"></script>
${inline}
</body>
</html>`;
}

// The order the stub platform answers with; `echo` adds the attribution the
// request carried (the API echo is unverified, so tests choose it).
function orderBody(order, { echo, note }) {
  return {
    ref_id: order.ref_id,
    number: order.number,
    is_test: true,
    currency: "USD",
    total_incl_tax: "19.00",
    lines: order.lines,
    ...(echo && order.attribution ? { attribution: order.attribution } : {}),
    ...(note ? { syn_note: note } : {}),
  };
}

// ---------------------------------------------------------------------------
// The stub campaign server.
//
// scenario (all optional):
//   direct            landing's add-to-cart goes straight to /x/checkout/ (no /x/bridge/ hop)
//   checkoutSelects   checkout carries its own selection surface (no landing entry)
//   checkoutPath      checkout path (default /x/checkout/)
//   tags              [{ name, value }] rendered on landing, bridge and checkout
//   extraHtml         extra markup appended to the landing and checkout <main>
//   responseNote      a syn_note field added to the create and read-back response bodies
//   checkoutInline    extra inline <script> on checkout, after the stub page script
//   page config:      bridge {drop|strip|replace}, preserveFromStore, checkoutAwayTo,
//                     replaceStateDrop, attribution {override, omit, testOrderKey},
//                     omitAttribution, metadataOmit, metadataOverride, rawBody, submit ("noop"),
//                     afterCreate ("stay" | "replaceState"), receiptRender (false),
//                     receiptExtra, createUrl, privateMetadata, bridgeExtra (a
//                     query pair the bridge adds to its checkout hop), requestNote
//                     (a syn_note field in the create request body), landingExtra
//                     (a query pair added to the landing_page value the page
//                     reports, as a landing URL's own query would be)
//   create            "accept" (201, default) | "reject" (422) | "drop" (socket reset) | "hold" (never answers)
//   createEcho        echo attribution in the create response (default true)
//   readbackEcho      echo attribution in the receipt read-back (default true)
const PAGE_CONFIG_KEYS = ["bridge", "preserveFromStore", "checkoutAwayTo", "replaceStateDrop", "attribution", "omitAttribution", "metadataOmit", "rawBody", "submit", "afterCreate", "receiptRender", "receiptExtra", "createUrl", "privateMetadata", "metadataOverride", "bridgeExtra", "requestNote", "landingExtra"];

export async function startTrackingStub(scenario = {}) {
  const config = Object.fromEntries(PAGE_CONFIG_KEYS.filter((key) => scenario[key] !== undefined).map((key) => [key, scenario[key]]));
  const checkoutPath = scenario.checkoutPath || "/x/checkout/";
  const log = { documents: [], creates: [], readbacks: [], all: [] };
  const orders = [];
  const held = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    log.all.push({ method: request.method, path: url.pathname, query: url.search });
    const send = (status, body, type = "text/html; charset=utf-8") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    if (request.method === "POST" && /^\/api\/v1\/orders\/?$/.test(url.pathname)) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      let posted = null;
      try { posted = JSON.parse(raw); } catch { posted = null; }
      log.creates.push({ query: url.search, raw, body: posted });
      const mode = scenario.create || "accept";
      if (mode === "drop") return request.socket.destroy();
      if (mode === "hold") {
        held.add(response);
        return undefined;
      }
      if (mode === "reject") return send(422, JSON.stringify({ detail: "synthetic rejection" }), "application/json");
      const order = {
        ref_id: `synref${orders.length + 1}`,
        number: `${9000 + orders.length + 1}`,
        lines: (Array.isArray(posted?.lines) && posted.lines.length ? posted.lines : [{ packageId: "1", quantity: 1 }])
          .map((line) => ({ product_title: `Package ${line.packageId}`, quantity: line.quantity, price_incl_tax: "19.00" })),
        attribution: posted?.attribution && typeof posted.attribution === "object" ? posted.attribution : null,
      };
      orders.push(order);
      return send(201, JSON.stringify(orderBody(order, { echo: scenario.createEcho !== false, note: scenario.responseNote })), "application/json");
    }
    const detail = /^\/api\/v1\/orders\/([^/]+)\/?$/.exec(url.pathname);
    if (request.method === "GET" && detail) {
      log.readbacks.push({ ref: detail[1] });
      const order = orders.find((candidate) => candidate.ref_id === detail[1]);
      return order ? send(200, JSON.stringify(orderBody(order, { echo: scenario.readbackEcho !== false, note: scenario.responseNote })), "application/json") : send(404, "{}", "application/json");
    }
    if (url.pathname === "/stub-sdk.js") return send(200, STUB_SDK_JS, "text/javascript");
    if (url.pathname === "/favicon.ico") return send(404, "");
    const tags = scenario.tags || [];
    const pageOf = () => {
      if (url.pathname === "/x/landing/") {
        const next = scenario.direct ? checkoutPath : "/x/bridge/";
        return pageHtml({ page: "landing", title: "Landing", tags, config, reset: true, body: `<h1>Landing</h1><button type="button" data-next-action="add-to-cart" data-next-package-id="1" data-next-url="${next}">Claim your offer</button>${scenario.extraHtml || ""}` });
      }
      if (url.pathname === "/x/bridge/") return pageHtml({ page: "bridge", title: "Bridge", tags, config, body: "<h1>One moment</h1>" });
      if (url.pathname === "/x/interstitial/") return pageHtml({ page: "interstitial", title: "Interstitial", tags, config, body: "<h1>Interstitial</h1>" });
      if (url.pathname === checkoutPath) {
        const body = `<h1>Checkout</h1>${scenario.checkoutSelects ? SELECTOR : ""}<aside data-next-cart-summary><h2>Your order</h2><div data-summary-lines><template><div data-next-package-id=""></div></template></div></aside>${CHECKOUT_FORM}${scenario.extraHtml || ""}`;
        return pageHtml({ page: "checkout", title: "Checkout", tags, config, body, inline: scenario.checkoutInline || "" });
      }
      if (url.pathname === "/x/receipt/") return pageHtml({ page: "receipt", title: "Receipt", tags: [], config, body: "<h1>Thank you</h1><div data-next-order-items>Order received.</div>" });
      return null;
    };
    const html = pageOf();
    if (html) {
      log.documents.push({ path: url.pathname, query: url.search });
      return send(200, html);
    }
    return send(404, "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    checkoutPath,
    log,
    orders,
    close: () => new Promise((resolve) => {
      for (const response of held) response.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// The configured page URLs carry no query of their own (director ruling P1):
// every query a run sees is added at runtime by the runner or the page.
export function stubTopologies(stub, scenario = {}) {
  const checkoutUrl = `${stub.base}${stub.checkoutPath}`;
  const pages = [
    ...(scenario.checkoutSelects ? [] : [{ page_id: "landing", page_type: "landing", order: 1, url: `${stub.base}/x/landing/`, expected_next_url: `${stub.base}${stub.checkoutPath}` }]),
    { page_id: "checkout", page_type: "checkout", order: 2, url: checkoutUrl, expected_next_url: `${stub.base}/x/receipt/` },
    { page_id: "receipt", page_type: "receipt", order: 3, url: `${stub.base}/x/receipt/` },
  ];
  return [{ funnel_id: "default", funnel_name: "Default", pages }];
}

export const BASE_ARGS = Object.freeze({
  "test-order": "checkout",
  "step-timeout-ms": 20000,
  "order-timeout-ms": 90000,
  "browser-timeout": 10000,
});

// API assumption (every QB row): runBrowserTestOrders(topologies, args, runId,
// options) takes the CampaignSpec as options.spec (tracking.preserve is read
// from spec.analytics.params.tracking.preserve) and the in-process test seam
// as options.trackingTestHooks, both passed through to each attempt.
export function specWithPreserve(preserve) {
  return preserve ? { analytics: { params: { tracking: { preserve } } } } : { analytics: { params: {} } };
}

// Runs one scenario end to end and closes the stub. `options` are passed to
// runBrowserTestOrders as-is.
export async function runTrackingScenario(name, scenario = {}, { args = {}, options = {}, runId = `qa-tracking-${name}` } = {}) {
  await installBrowserGuard();
  const { runBrowserTestOrders } = await import("./qa-browser.mjs");
  const stub = await startTrackingStub(scenario);
  try {
    const topologies = stubTopologies(stub, scenario);
    const result = await runBrowserTestOrders(topologies, { ...BASE_ARGS, ...args }, runId, options);
    return { result, stub, base: stub.base, log: stub.log, topologies, runId };
  } finally {
    await stub.close();
  }
}

// One run per scenario key per file, shared by the rows that name the same
// synthetic setup.
const runs = new Map();
export function sharedRun(key, run) {
  if (!runs.has(key)) runs.set(key, run());
  return runs.get(key);
}

// ---------------------------------------------------------------------------
// Seed-independent setup facts (they hold on the base and after the phase).

export const documentPaths = (log) => log.documents.map((entry) => entry.path);
export function orderAssertion(result, plan = "checkout") {
  const matches = result.assertions.filter((entry) => entry.id === `browser-test-order:${plan}`);
  assert.equal(matches.length, 1, `setup: one browser-test-order:${plan} assertion`);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Reading the 1.1 rows of a run.

// API assumption (every QB row): result ids follow the 1.0 qcResultId over
// the contract's accept subject {check, page: <plan id>, key: "url" | "order"
// | "tag:<tag>"}, so the contract's proposed qc.tracking.url:<plan> reads
// qc.tracking.url:<plan>:url; the plan id of `--test-order checkout` is
// "checkout". The setup's ids and subjects are pinned here as literals; no
// test derives them from a returned row.
export const URL_ID = "tracking.url:checkout:url";
export const ORDER_ID = "tracking.order:checkout:order";
export const TAG_ID = "tracking.tag:checkout:tag:syn_tag";
export const OID_TAG_ID = "tracking.tag:checkout:tag:oid";
export const SUBJECTS = Object.freeze({
  "tracking.url:checkout:url": Object.freeze({ check: "tracking.url", page: "checkout", key: "url" }),
  "tracking.order:checkout:order": Object.freeze({ check: "tracking.order", page: "checkout", key: "order" }),
  "tracking.tag:checkout:tag:syn_tag": Object.freeze({ check: "tracking.tag", page: "checkout", key: "tag:syn_tag" }),
  "tracking.tag:checkout:tag:oid": Object.freeze({ check: "tracking.tag", page: "checkout", key: "tag:oid" }),
});

const VERDICT_RUN_ID = "qa-tracking-synthetic-verdict";
const BUILD = sha256("synthetic tracking build");

// API assumption (every QB row): runBrowserTestOrders resolves to
// { ..., qc_results } holding every 1.1 row of the run as a full
// campaigns-os-qc-result/v0 row (buildQcResult), and pushes each row's
// toQaAssertion(row, { family: "browser-test-order" }) into `assertions`.
//
// Returns the rows by id after checking that the run's rows and assertions
// are exactly the expected literal ids with their literal subjects, pair one
// to one, and re-derive through the 1.0 QA reader with the real 1.1 module
// from the registry (no stand-in).
export async function trackingRows(result, expectedIds) {
  for (const id of expectedIds) assert.ok(SUBJECTS[id], `setup: ${id} is a pinned literal id`);
  const rows = result.qc_results;
  assert.ok(Array.isArray(rows), "runBrowserTestOrders returns qc_results[]");
  const tracking = rows.filter((row) => String(row?.check || "").startsWith("tracking."));
  assert.deepEqual(tracking.map((row) => row.id).sort(), [...expectedIds].sort(), "the run lists exactly the setup's 1.1 result ids");
  const qcAssertions = result.assertions.filter((entry) => String(entry?.id || "").startsWith("qc.tracking."));
  assert.deepEqual(qcAssertions.map((entry) => entry.id).sort(), expectedIds.map((id) => `qc.${id}`).sort(), "one qc.tracking.* verdict assertion per row");
  for (const row of tracking) {
    assert.deepEqual(row.subject, SUBJECTS[row.id], `${row.id} subject`);
    assert.equal(row.check, SUBJECTS[row.id].check, `${row.id} check`);
    assert.equal(row.schema, "campaigns-os-qc-result/v0", `${row.id} schema`);
    assert.equal(row.leg, "qa", `${row.id} leg`);
    assert.equal(row.producer, "campaigns-os qa run", `${row.id} producer`);
    const paired = qcAssertions.find((entry) => entry.evidence?.qc?.result_id === row.id);
    assert.ok(paired, `${row.id} has its paired assertion`);
    assert.equal(paired.id, `qc.${row.id}`, `${row.id} assertion id`);
    assert.equal(paired.page, "checkout", `${row.id} assertion page`);
    assert.equal(paired.family, "browser-test-order", `${row.id} assertion family`);
    assert.deepEqual(paired.evidence.qc.observation, row.observation, `${row.id} assertion carries the row's observation`);
  }
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const { QA_SCHEMA_VERSION } = await import("./qa-verdict.mjs");
  const { readFileSync } = await import("node:fs");
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const rederivers = await loadQcRederivers();
  const now = new Date().toISOString();
  const read = readQaResults({
    stageEvidence: { qc_results: tracking, qc_build_fingerprint: BUILD },
    stage: { identity: { verdict_run_id: VERDICT_RUN_ID } },
    fullVerdict: { schema_version: QA_SCHEMA_VERSION, run_id: VERDICT_RUN_ID, runtime: `campaigns-os-node-qa@${version}`, started_at: now, completed_at: now, assertions: qcAssertions },
    currentBuild: BUILD,
    rederivers,
  });
  const byId = new Map();
  for (const row of tracking) {
    const reread = read.find((candidate) => candidate.id === row.id);
    assert.ok(reread, `the 1.0 reader lists ${row.id}`);
    assert.deepEqual(
      [reread.subject, reread.result, reread.reason_code, reread.state_fingerprint, reread.members, reread.coverage],
      [SUBJECTS[row.id], row.result, row.reason_code, row.state_fingerprint, row.members, row.coverage],
      `${row.id} re-derives through the 1.0 QA reader with the real 1.1 module`,
    );
    byId.set(row.id, row);
  }
  return byId;
}

export function rowOf(rows, id) {
  const row = rows.get(id);
  assert.ok(row, `the run lists ${id}`);
  return row;
}

export function assertRow(row, result, reasonCode) {
  assert.equal(row.result, result, `${row.id} reads ${result}`);
  assert.equal(row.reason_code, reasonCode, `${row.id} reads reason ${reasonCode}`);
}

// API assumption: members are {key, result, reason_code}; URL members are
// keyed by the URL parameter name, order members by the credited field (or by
// the declared name when it has no credited field). A tag row judges one tag
// and does not aggregate, so its members are [].
export function membersOf(row) {
  assert.ok(Array.isArray(row.members), `${row.id} lists its members`);
  const map = new Map();
  for (const member of row.members) {
    assert.equal(map.has(member.key), false, `${row.id} lists member ${member.key} once`);
    map.set(member.key, member);
  }
  return map;
}

// The expected members of a setup: { "<key>": [result, reason_code] }.
export const members = (keys, result, reasonCode) => Object.fromEntries(keys.map((key) => [key, [result, reasonCode]]));
// The five credited fields the default seed policy never seeds (contract 1.1
// "Credited fields not seeded by default"), each an explicit order member.
export const EXCLUDED_BY_POLICY = Object.freeze(members(NOT_SEEDED_ORDER_FIELDS, "excluded", "not_seeded_by_policy"));

// The row's members are exactly `expected`: the same keys, each with the same
// result and reason code, nothing missing and nothing extra.
export function assertExactMembers(row, expected) {
  const actual = Object.fromEntries([...membersOf(row)].map(([key, member]) => [key, [member.result, member.reason_code ?? null]]));
  assert.deepEqual(actual, expected, `${row.id} lists exactly the setup's members, results and reason codes`);
}

export function memberOf(row, key) {
  const member = membersOf(row).get(key);
  assert.ok(member, `${row.id} lists member ${key}`);
  return member;
}

// API assumption: an order row lists the order sources it observed for the
// accepted order (contract 1.1 "sources_observed is listed") as
// coverage.sources_observed, a set over "request", "create_response" and
// "readback"; a missing echo is also a coverage.limits entry
// "<source>: absent" (F1.1-W4's own wording).
export const ALL_SOURCES = Object.freeze(["request", "create_response", "readback"]);
export function assertSourcesObserved(row, sources) {
  const listed = row.coverage?.sources_observed;
  assert.ok(Array.isArray(listed), `${row.id} lists coverage.sources_observed`);
  assert.deepEqual([...listed].sort(), [...sources].sort(), `${row.id} lists exactly the sources observed`);
}

// API assumption: an unexercised URL row reports (contract 1.1 "Each reports
// the last observed page hop and the coverage limit") as
//   coverage.last_observed: the origin+path of the last hop of the
//     continuously observed sequence that starts at the measured seed hop, i.e.
//     the point after which the next transition was not observed (the measured
//     seed hop itself when no page hop followed it; null when the measured
//     seed hop has no record, or no hop equality was recorded);
//   coverage.limits: exactly [<the row's unexercised reason code>].
// `expected` names the coverage fields to compare; each must match exactly.
export function assertCoverage(row, expected) {
  assert.ok(row.coverage && typeof row.coverage === "object", `${row.id} carries coverage`);
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, row.coverage[key]]));
  assert.deepEqual(actual, expected, `${row.id} coverage`);
}

// API assumption: the failing URL member names its hop pair as
// failing_hop: { from: "<origin+path>", to: "<origin+path>" }. Only the
// url_param_dropped warning names one (contract §1.1: "Both redacted paths are
// named"; every other reason names none), and a loss where either neighbour is
// a runner hop or an observation gap is never named as a failing hop. So every
// member reads failing_hop exactly `expected[key]`, and null (or no field) for
// every key `expected` does not name.
export function assertFailingHops(url, expected = {}) {
  const actual = Object.fromEntries([...membersOf(url)].map(([key, member]) => [key, member.failing_hop ?? null]));
  const wanted = Object.fromEntries(Object.keys(actual).map((key) => [key, expected[key] ?? null]));
  assert.deepEqual(actual, wanted, `${url.id} names exactly the failing hops the contract requires`);
}

// ---------------------------------------------------------------------------
// Privacy (F1.1-P1, director ruling P1): walks every key and every string of
// a persisted JSON value. Contract 1.0 persistence rules: never arbitrary
// query values, raw request or response body text, attribution.metadata, link
// text or expression text; URLs only as origin+path.

function walkJson(value, visit, path = "$") {
  if (Array.isArray(value)) value.forEach((item, index) => walkJson(item, visit, `${path}[${index}]`));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit({ path: `${path}.${key}`, key, item, parent: value });
      walkJson(item, visit, `${path}.${key}`);
    }
  } else if (typeof value === "string") visit({ path, text: value });
}

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

// The field names the 1.0 persistence rule forbids at any depth, whatever the
// value. A key is compared in snake case (postData -> post_data), so camelCase
// and snake_case spellings both match:
//   - attribution.metadata: a key that is, or ends in, metadata;
//   - landing_page: a key that is, or ends in, landing_page;
//   - link text: a key ending in link_text or anchor_text;
//   - expression text: a key that is, or ends in, expression or
//     expression_text;
//   - an arbitrary query value: a key that is search, or is or ends in query,
//     query_string, querystring, raw_query, query_params or search_params.
const FORBIDDEN_FIELDS = [
  ["attribution.metadata", (name) => /(^|_)metadata$/.test(name)],
  ["landing_page", (name) => /(^|_)landing_page$/.test(name)],
  ["link text", (name) => /(^|_)(link|anchor)_text$/.test(name)],
  ["expression text", (name) => /(^|_)expression(_text)?$/.test(name)],
  ["an arbitrary query value", (name) => name === "search" || /(^|_)(query|query_string|querystring|raw_query|query_params|search_params)$/.test(name)],
];
const snakeCase = (key) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s.]+/g, "_").toLowerCase();

// A request or response body field: a key that is, or ends in, body / bodies /
// payload / post_data / raw_body, or is request_text / response_text
// (body_present, api_response_body_read: a flag or a read's timing, not the
// body, do not end in one). Director ruling (A1.t correction): contract §1.1
// "Prerequisite" redacts only raw query values, and "no body" means no raw
// body text, so such a field may hold only null (no body) or one of the two
// redacted summaries qa-browser already persists, which order and coupon
// proof read:
//   - the request summary: the string "[redacted-request-body]", or an object
//     with exactly redacted: true, keys: [string], and optionally
//     line_count: integer, currency: string;
//   - the response summary of an object body: an object whose keys are a
//     subset of RESPONSE_SUMMARY_KEYS, with lines an array of receipt lines,
//     checkout_url origin+path, and payment_details only beside a status of
//     400 or more.
// Any other value (a raw string body, any other object, array or scalar) is
// body content.
const isBodyField = (name) => /(^|_)(body|bodies|payload|post_data|raw_body)$/.test(name) || ["request_text", "response_text"].includes(name);
const REQUEST_BODY_MARKER = "[redacted-request-body]";
const REQUEST_SUMMARY_KEYS = ["redacted", "keys", "line_count", "currency"];
const RESPONSE_SUMMARY_KEYS = ["number", "ref_id", "is_test", "total_incl_tax", "currency", "checkout_url", "lines", "detail", "payment_details"];
const RECEIPT_LINE_KEYS = ["title", "quantity", "is_upsell", "price_incl_tax", "price_excl_tax", "price", "sku", "product_id", "variant_id"];
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keysWithin = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

function isRequestSummary(value) {
  if (value === REQUEST_BODY_MARKER) return true;
  return isPlainObject(value)
    && keysWithin(value, REQUEST_SUMMARY_KEYS)
    && value.redacted === true
    && Array.isArray(value.keys) && value.keys.every((key) => typeof key === "string")
    && (!Object.hasOwn(value, "line_count") || Number.isInteger(value.line_count))
    && (!Object.hasOwn(value, "currency") || typeof value.currency === "string");
}

function isOriginPath(url) {
  try {
    const parsed = new URL(url);
    return url === `${parsed.origin}${parsed.pathname}`;
  } catch {
    return false;
  }
}

function isResponseSummary(value, status) {
  return isPlainObject(value)
    && keysWithin(value, RESPONSE_SUMMARY_KEYS)
    && (!Object.hasOwn(value, "lines") || (Array.isArray(value.lines) && value.lines.every((line) => isPlainObject(line) && keysWithin(line, RECEIPT_LINE_KEYS))))
    && (!Object.hasOwn(value, "checkout_url") || (typeof value.checkout_url === "string" && isOriginPath(value.checkout_url)))
    && (!Object.hasOwn(value, "payment_details") || Number(status) >= 400);
}

// `markers` maps a label to a synthetic private value the setup planted; the
// whole serialized JSON is searched, so a marker anywhere (any JSON key or
// value, at any depth, under any field name) fails, and the walk names the
// keys and strings that hold it. The allowed redacted summaries carry no raw
// value, so they never hold a marker. Besides that, a FORBIDDEN_FIELDS name,
// and any of `forbiddenKeys`, may not appear at any depth; a body field holds
// only null or an allowed redacted summary; `forbiddenText` may not appear
// inside any string; no string holds a query value ("?name=value" anywhere in
// it); every URL inside any string is origin+path (no query, no fragment).
// Returns the number of strings checked.
export function assertNothingPrivatePersisted(persisted, { markers = {}, forbiddenKeys = ["metadata", "landing_page"], forbiddenText = [] } = {}) {
  const serialized = JSON.stringify(persisted);
  const json = JSON.parse(serialized);
  const problems = [];
  for (const [label, marker] of Object.entries(markers)) {
    if (serialized.includes(marker) || serialized.includes(JSON.stringify(marker).slice(1, -1))) problems.push(`the serialized JSON holds the ${label} value`);
  }
  let strings = 0;
  walkJson(json, ({ path, key, item, parent, text }) => {
    const value = key ?? text;
    if (key !== undefined && forbiddenKeys.includes(key)) problems.push(`${path}: a ${key} field is persisted`);
    if (key !== undefined) {
      const name = snakeCase(key);
      for (const [what, matches] of FORBIDDEN_FIELDS) {
        if (matches(name)) problems.push(`${path}: ${what} is persisted (field ${key})`);
      }
      if (isBodyField(name) && item !== null && !isRequestSummary(item) && !isResponseSummary(item, parent.status)) {
        problems.push(`${path}: request or response body content is persisted (field ${key} is not a redacted summary)`);
      }
    }
    if (text !== undefined && /\?[^\s=&?#"'<>]+=/.test(text)) problems.push(`${path}: a raw query value is persisted`);
    if (text !== undefined) strings += 1;
    for (const [label, marker] of Object.entries(markers)) {
      if (value.includes(marker)) problems.push(`${path}: the ${label} value is persisted`);
    }
    for (const fragment of forbiddenText) {
      if (value.includes(fragment)) problems.push(`${path}: ${JSON.stringify(fragment)} is persisted`);
    }
    if (text !== undefined) {
      for (const url of text.match(URL_IN_TEXT) || []) {
        if (/[?#]/.test(url)) problems.push(`${path}: the URL ${url} keeps a query or fragment`);
      }
    }
  });
  assert.deepEqual(problems, [], "the persisted JSON holds no private value");
  return strings;
}

