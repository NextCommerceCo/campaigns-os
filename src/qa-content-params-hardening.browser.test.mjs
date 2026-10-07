// Content parameter check hardening, in Chromium: `qa run --browser`
// (runBrowserChecks) against loopback pages whose own scripts try to change
// what the check reads.
//
// Each page has one <section data-next-hide="param.reviews"> and no SDK: its
// inline script sets body[data-next-sdk-loading="false"] 300 ms after it
// runs. Depending on the case it hides the section with ?reviews=n (a working
// toggle) or leaves it visible (a broken one), overrides DOM methods in its
// own world, or replaces or moves the section in the first animation frame
// after the readiness signal. Every value is synthetic and every host is
// loopback (127.0.0.1).
//
// Other pages replace themselves with a document at the same URL served with
// 404 or 200, or are served by an installed service worker: the check reads
// the status of the document it reads, never the one the navigation saw.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test.
import { assertExactMembers, assertLoopbackOnly, chromiumAvailable, installBrowserGuard, installNodeGuard } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
const { BUILD_FP, QA_RUN_ID, assertNoNetworkAttempts, fullVerdict } = await import("./qc-test-factories.mjs");

afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(async () => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
  if (stub) await stub.close();
});

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; content parameter hardening rows skipped (run `npm run qa:install-browser`)", () => {});
}

const T = { timeout: 120_000 };
const ARGS = Object.freeze({ "browser-timeout": 10_000 });
const NAME = "reviews";
const PAGE = "index";
const ID = "content_param:index:reviews";
const SPEC = Object.freeze({ analytics: { params: { content: [{ name: NAME }] } } });
const KEY = "hide:body>main[0]>section[0]";
const KEPT_VISIBLE = Object.freeze({ result: "warning", reasonCode: "target_still_visible", acceptEligible: true, members: { [KEY]: ["warning", "target_still_visible"] } });
const UNRESOLVED = Object.freeze({ result: "review", reasonCode: "target_identity_unresolved", acceptEligible: false, members: { [KEY]: ["review", "target_identity_unresolved"] } });

// Page-world overrides, each installed by the page's own script.
const OVERRIDES = {
  // Visibility and geometry report the data-next-hide section hidden.
  visibility: String.raw`
    var realStyle = window.getComputedStyle;
    var marked = function (element) { return Boolean(element && element.hasAttribute && element.hasAttribute("data-next-hide")); };
    window.getComputedStyle = function (element) {
      if (marked(element)) return { display: "none", visibility: "hidden", getPropertyValue: function () { return "none"; } };
      return realStyle.apply(window, arguments);
    };
    Element.prototype.checkVisibility = function () { return false; };
    Element.prototype.getBoundingClientRect = function () { return new DOMRect(0, 0, 0, 0); };
    Element.prototype.getClientRects = function () { return []; };`,
  // Element lookups list no conditional elements and read no conditions.
  lookups: String.raw`
    var realGet = Element.prototype.getAttribute;
    Document.prototype.querySelectorAll = function () { return document.createDocumentFragment().querySelectorAll("*"); };
    Element.prototype.querySelectorAll = Document.prototype.querySelectorAll;
    Element.prototype.getAttribute = function (name) {
      if (name === "data-next-hide" || name === "data-next-show") return null;
      return realGet.call(this, name);
    };`,
  // The readiness signal reads as present while the page never sets it.
  readiness: String.raw`
    var realGetAttribute = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function (name) {
      if (name === "data-next-sdk-loading") return "false";
      return realGetAttribute.call(this, name);
    };
    var realContains = DOMTokenList.prototype.contains;
    DOMTokenList.prototype.contains = function (token) { return token === "next-display-ready" ? true : realContains.call(this, token); };`,
};

// The page's script. `toggle`: hide the section with ?reviews=n. `overrides`:
// the OVERRIDES to install (`variantOnly`: only with ?reviews=n). `ready`:
// set the signal. `firstFrame`: what to do in the first frame after it.
function pageScript({ toggle, overrides = [], variantOnly = true, ready = true, firstFrame = null }) {
  const frame = {
    replace: `var s = document.querySelector("main > section"); s.replaceWith(s.cloneNode(true));`,
    move: `var m = document.querySelector("main"); m.insertBefore(document.createElement("section"), m.firstElementChild);`,
  }[firstFrame] ?? "";
  return `(function () {
    var variant = new URLSearchParams(location.search).get("${NAME}") === "n";
    var section = document.querySelector("main > section");
    ${toggle ? `if (variant) section.style.display = "none";` : ""}
    if (variant || ${!variantOnly}) {${overrides.map((name) => OVERRIDES[name]).join("\n")}
    }
    setTimeout(function () {
      ${ready ? `document.body.setAttribute("data-next-sdk-loading", "false");` : ""}
      ${frame ? `requestAnimationFrame(function () { ${frame} });` : ""}
    }, 300);
  })();`;
}

// `before`: markup placed in <main> ahead of the section.
const pageHtml = (script, before = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic content params</title></head>`
  + `<body data-next-sdk-loading="true"><main>${before}<section data-next-hide="param.${NAME}"><h2>Synthetic section</h2><p>Synthetic copy.</p></section></main>`
  + `<script>${script}</script></body></html>`;

// Pages whose ?reviews=n load does not end on the document it asked for. The
// server answers the ?reviews=n request for /drop-param/ or /redirect-away/
// with a 302 that sets a cookie and points at /drop-param/ (the parameter
// dropped) or /elsewhere/ (another path). Those pages hide their section only
// when the cookie is set, so without the check on the read document the
// landing page would read as the variant. /self-navigate/ with ?reviews=n sets
// the cookie and the readiness signal, then replaces itself with /elsewhere/.
const HIDDEN_COOKIE = "synthetic-hidden=1";
const REDIRECTS = { "/drop-param/": "/drop-param/", "/redirect-away/": "/elsewhere/" };
const cookiePageScript = `(function () {
    if (document.cookie.indexOf("${HIDDEN_COOKIE}") !== -1) document.querySelector("main > section").style.display = "none";
    setTimeout(function () { document.body.setAttribute("data-next-sdk-loading", "false"); }, 300);
  })();`;
const selfNavigateScript = `(function () {
    if (new URLSearchParams(location.search).get("${NAME}") === "n") {
      document.cookie = "${HIDDEN_COOKIE}; Path=/";
      document.body.setAttribute("data-next-sdk-loading", "false");
      location.replace("/elsewhere/");
    } else {
      setTimeout(function () { document.body.setAttribute("data-next-sdk-loading", "false"); }, 300);
    }
  })();`;

// /remove-with-n/ removes the section with ?reviews=n instead of hiding it.
// /template-and-live/ has a <template> holding a second
// data-next-hide="param.reviews" section ahead of the live one, which hides
// with ?reviews=n.
const removeScript = `(function () {
    if (new URLSearchParams(location.search).get("${NAME}") === "n") document.querySelector("main > section").remove();
    setTimeout(function () { document.body.setAttribute("data-next-sdk-loading", "false"); }, 300);
  })();`;
const PAGES = {
  "/template-and-live/": pageHtml(pageScript({ toggle: true }), `<template><section data-next-hide="param.${NAME}"><p>Synthetic template copy.</p></section></template>`),
};

const CASES = {
  "/spoof-visibility/": pageScript({ toggle: false, overrides: ["visibility"] }),
  "/spoof-all/": pageScript({ toggle: false, overrides: ["visibility", "lookups", "readiness"] }),
  "/spoof-readiness/": pageScript({ toggle: true, overrides: ["readiness"], variantOnly: false, ready: false }),
  "/replace-first-frame/": pageScript({ toggle: true, firstFrame: "replace" }),
  "/move-first-frame/": pageScript({ toggle: true, firstFrame: "move" }),
  "/drop-param/": cookiePageScript,
  "/redirect-away/": cookiePageScript,
  "/elsewhere/": cookiePageScript,
  "/self-navigate/": selfNavigateScript,
  "/remove-with-n/": removeScript,
};

// Same-URL replacements. The first request for each path is answered 200
// with a cookie. /replace-404/ and /replace-200/ stream a head whose script
// replaces the page with its own URL and never finish, so the navigation's
// load completes on the replacement, which the server answers (cookie set)
// with 404 or 200 and a working toggle. /reload-404/ is a complete page that
// never signals readiness and replaces itself with its own URL once loaded;
// the replacement is answered 404 with a working toggle.
const REPLACED = { "/replace-404/": 404, "/replace-200/": 200, "/reload-404/": 404 };
const REPLACED_COOKIE = "synthetic-replaced=1";
function replacedPage(request, response, path) {
  if (String(request.headers.cookie || "").includes(REPLACED_COOKIE)) {
    response.writeHead(REPLACED[path], { "content-type": "text/html; charset=utf-8" });
    return response.end(pageHtml(pageScript({ toggle: true })));
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `${REPLACED_COOKIE}; Path=/` });
  if (path === "/reload-404/") {
    return response.end(pageHtml(`addEventListener("load", function () { location.replace(location.href); });`));
  }
  response.write(`<!doctype html><html><head><meta charset="utf-8"><script>location.replace(location.href);</script></head><body>`);
  return undefined;
}

// A service worker that answers /service-worker/?controlled=1 itself, with
// status 200 and a working toggle; the server answers that URL 404, so only
// the worker's document can be read. /service-worker/ registers it and waits
// until it controls the page.
const WORKER_SCRIPT = `self.addEventListener("install", function (event) { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (url.pathname !== "/service-worker/" || url.searchParams.get("controlled") !== "1") return;
  var hidden = url.searchParams.get("${NAME}") === "n" ? " style=\\"display:none\\"" : "";
  event.respondWith(new Response("<!doctype html><html><head><meta charset=\\"utf-8\\"></head><body data-next-sdk-loading=\\"false\\"><main><section data-next-hide=\\"param.${NAME}\\"" + hidden + "><p>Synthetic worker copy.</p></section></main></body></html>", { status: 200, headers: { "content-type": "text/html" } }));
});`;
const WORKER_SETUP_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; }).then(function () {
    return new Promise(function (resolve) {
      if (navigator.serviceWorker.controller) resolve();
      else navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    });
  }).then(function () { document.body.setAttribute("data-worker", "controlling"); });
</script></body></html>`;

// While `contextSetup` is set, every context the browser opens runs it first
// and records the status and source of each main-frame document response.
let contextSetup = null;
let documentResponses = [];
async function layerContextSetup() {
  const { chromium } = await import("playwright");
  if (chromium.__contentParamsSetup) return;
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (options = {}) => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      if (!contextSetup) return context;
      context.on("response", (response) => {
        const request = response.request();
        if (request.resourceType() !== "document" || request.frame().parentFrame()) return;
        documentResponses.push({ path: new URL(response.url()).pathname, status: response.status(), worker: response.fromServiceWorker() });
      });
      await contextSetup(context);
      return context;
    };
    return browser;
  };
  chromium.__contentParamsSetup = true;
}

// Registers the worker in a fresh context and waits until it controls a page.
// A setup that fails is recorded, not thrown, so the browser is still closed.
let workerSetupFailures = [];
async function installWorker(context) {
  try {
    const setup = await context.newPage();
    await setup.goto(`${stub.base}/service-worker/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await setup.waitForSelector("body[data-worker=controlling]", { state: "attached", timeout: 15_000 });
    await setup.close();
  } catch (error) {
    workerSetupFailures.push(String(error?.message || error).split("\n")[0]);
  }
}

let stub = null;
async function stubServer() {
  if (stub) return stub;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const redirect = REDIRECTS[url.pathname];
    if (redirect && url.searchParams.get(NAME) === "n") {
      response.writeHead(302, { "set-cookie": `${HIDDEN_COOKIE}; Path=/`, location: redirect });
      return response.end();
    }
    if (REPLACED[url.pathname]) return replacedPage(request, response, url.pathname);
    if (url.pathname === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      return response.end(WORKER_SCRIPT);
    }
    if (url.pathname === "/service-worker/" && !url.searchParams.has("controlled")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(WORKER_SETUP_HTML);
    }
    const html = PAGES[url.pathname] ?? (CASES[url.pathname] ? pageHtml(CASES[url.pathname]) : null);
    if (!html) {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("not found");
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub = {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
  return stub;
}

// One runBrowserChecks call over `path`; returns its one content_param row
// after checking that the 1.0 QA reader re-derives it with the real module.
// `limits` replaces fields of the leg's CONTENT_PARAM_LIMITS
// (runBrowserChecks' in-process contentParamLimits).
async function contentRow(path, { limits } = {}) {
  await installBrowserGuard();
  const server = await stubServer();
  const { runBrowserChecks } = await import("./qa-browser.mjs");
  const topologies = [{ funnel_id: "default", funnel_name: "Default", pages: [{ page_id: PAGE, page_type: "landing", order: 1, url: `${server.base}${path}` }] }];
  const qcResults = [];
  const assertions = await runBrowserChecks(topologies, { ...ARGS }, { spec: structuredClone(SPEC), qcResults, contentParamLimits: limits });
  assert.deepEqual(qcResults.map((row) => row?.id), [ID], "one content_param row");
  const qcAssertions = assertions.filter((entry) => String(entry?.id || "").startsWith("qc."));
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const read = readQaResults({
    stageEvidence: { qc_results: qcResults, qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: qcAssertions, measuredAt: new Date().toISOString() }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  const project = (entry) => [entry.id, entry.result, entry.reason_code, entry.state_fingerprint, entry.members, entry.accept_eligible];
  assert.deepEqual(read.map(project), qcResults.map(project), "the 1.0 QA reader re-derives the row with the real module");
  return qcResults[0];
}

function assertResult(row, { result, reasonCode, acceptEligible, members }) {
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], [result, reasonCode, acceptEligible], `${row.id} reads ${result} / ${reasonCode}`);
  assertExactMembers(row, members);
}

// ---------------------------------------------------------------------------
// Page-world overrides

browserTest("the variant page overrides getComputedStyle, checkVisibility, getBoundingClientRect and getClientRects to report the visible target hidden: warning (target_still_visible)", T, async () => {
  const row = await contentRow("/spoof-visibility/");
  assertResult(row, KEPT_VISIBLE);
  assert.deepEqual(row.observation.targets.map((entry) => [entry.baseline.visible, entry.param_n.visible]), [[true, true]], "the target is read visible in both contexts");
});

browserTest("the variant page also overrides querySelectorAll, Element.prototype.getAttribute and the readiness reads: warning (target_still_visible)", T, async () => {
  const row = await contentRow("/spoof-all/");
  assertResult(row, KEPT_VISIBLE);
  assert.deepEqual(row.observation.counts, { baseline: 1, param_n: 1 }, "the target is found in both contexts");
});

// The faked signal is in place from the page's first script, so a reader it
// fooled would read the page as ready at once. The real signal never comes,
// so each load waits out the readiness bound: 8 s in production, 1.5 s here.
browserTest("a page whose getAttribute and classList report the readiness signal it never sets: unexercised (readiness_timeout)", T, async () => {
  const row = await contentRow("/spoof-readiness/", { limits: { readinessMs: 1_500 } });
  assertResult(row, { result: "unexercised", reasonCode: "readiness_timeout", acceptEligible: false, members: {} });
  assert.deepEqual(row.observation.readiness, { baseline: "readiness_timeout", param_n: "readiness_timeout" }, "neither context reached the signal");
});

// ---------------------------------------------------------------------------
// Capture at readiness

browserTest("the target is replaced with an identical node in the first frame after readiness (hidden with ?reviews=n): review (target_identity_unresolved)", T, async () => {
  const row = await contentRow("/replace-first-frame/");
  assertResult(row, UNRESOLVED);
  assert.deepEqual(row.observation.targets.map((entry) => [entry.baseline.stable, entry.param_n.stable]), [[false, false]], "the captured node is no longer connected in either context");
});

browserTest("the target is moved by a sibling inserted before it in the first frame after readiness (hidden with ?reviews=n): review (target_identity_unresolved)", T, async () => {
  const row = await contentRow("/move-first-frame/");
  assertResult(row, UNRESOLVED);
  assert.deepEqual(row.observation.targets.map((entry) => [entry.element_path, entry.baseline.stable, entry.param_n.stable]), [["body>main[0]>section[0]", false, false]], "the target is captured at its readiness path and reads moved");
});

// ---------------------------------------------------------------------------
// The document read is the one requested

const NOT_SERVED = Object.freeze({ result: "unexercised", reasonCode: "page_not_served", acceptEligible: false, members: {} });

browserTest("the ?reviews=n load is redirected to the same path without the parameter, where a cookie hides the section: unexercised (page_not_served), never pass", T, async () => {
  const row = await contentRow("/drop-param/");
  assertResult(row, NOT_SERVED);
  assert.deepEqual(row.observation.readiness, { baseline: "ready", param_n: "page_not_served" }, "the variant document is not the one requested");
});

browserTest("the ?reviews=n load is redirected to another path, where a cookie hides the section: unexercised (page_not_served), never pass", T, async () => {
  const row = await contentRow("/redirect-away/");
  assertResult(row, NOT_SERVED);
  assert.deepEqual(row.observation.readiness, { baseline: "ready", param_n: "page_not_served" }, "the variant document is not the one requested");
});

// The replacement document is what the check finds once the load returns; if
// it ever caught the replacement mid-read, the lost read would be
// readiness_timeout, also never a pass.
browserTest("the ?reviews=n page signals readiness, then replaces itself with another path, where a cookie hides the section: unexercised (page_not_served), never pass", T, async () => {
  const row = await contentRow("/self-navigate/");
  assert.notEqual(row.result, "pass", "a variant read from another document never passes");
  assert.equal(row.result, "unexercised", "the variant document is not the one requested");
  assert.ok(["page_not_served", "readiness_timeout"].includes(row.reason_code), `${row.reason_code} is a load outcome`);
  assert.equal(row.observation.readiness.baseline, "ready", "the baseline is read");
});

// ---------------------------------------------------------------------------
// Counts and live targets

browserTest("the ?reviews=n page removes the section instead of hiding it: review (target_count_changed)", T, async () => {
  const row = await contentRow("/remove-with-n/");
  assertResult(row, { result: "review", reasonCode: "target_count_changed", acceptEligible: false, members: {} });
  assert.deepEqual(row.observation.counts, { baseline: 1, param_n: 0 }, "one target at baseline, none with ?reviews=n");
});

browserTest("a data-next-hide=\"param.reviews\" section inside <template> beside a live one that hides with ?reviews=n: pass on the live section only", T, async () => {
  const row = await contentRow("/template-and-live/");
  assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [KEY]: ["pass", null] } });
  assert.deepEqual(row.observation.counts, { baseline: 1, param_n: 1 }, "the template's section is not counted");
  assert.deepEqual(row.observation.targets.map((entry) => entry.element_path), ["body>main[0]>section[0]"], "only the live section is a target");
  assert.deepEqual(row.observation.references.map((entry) => entry.element_path), ["body>main[0]>section[0]"], "only the live section is a reference");
});

// ---------------------------------------------------------------------------
// The status is the read document's own

browserTest("the page replaces itself, before its load completes, with a same-URL document served with 404 that hides the section with ?reviews=n: unexercised (page_not_served), never pass", T, async () => {
  const row = await contentRow("/replace-404/");
  assert.notEqual(row.result, "pass", "a document served with 404 never passes");
  assertResult(row, NOT_SERVED);
  assert.deepEqual(row.observation.readiness, { baseline: "page_not_served", param_n: "page_not_served" }, "neither read document was served");
});

browserTest("the page replaces itself, before its load completes, with a same-URL document served with 200 that hides the section with ?reviews=n: pass", T, async () => {
  const row = await contentRow("/replace-200/");
  assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [KEY]: ["pass", null] } });
});

browserTest("the page replaces itself once loaded with a same-URL document served with 404 that hides the section with ?reviews=n: never pass", T, async () => {
  const row = await contentRow("/reload-404/");
  assert.notEqual(row.result, "pass", "a document served with 404 never passes");
  assert.equal(row.result, "unexercised", "neither load read a served document in a ready state");
  assert.ok(["page_not_served", "readiness_timeout"].includes(row.reason_code), `${row.reason_code} is a load outcome`);
});

browserTest("the page is served by an installed service worker with status 200 and hides the section with ?reviews=n: pass", T, async () => {
  await installBrowserGuard();
  await layerContextSetup();
  await stubServer();
  contextSetup = installWorker;
  documentResponses = [];
  workerSetupFailures = [];
  try {
    const row = await contentRow("/service-worker/?controlled=1");
    assert.deepEqual(workerSetupFailures, [], "the worker controlled a page in every context");
    assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [KEY]: ["pass", null] } });
    const loads = documentResponses.filter((entry) => entry.path === "/service-worker/" && entry.worker);
    assert.ok(loads.length >= 2, "both loads were answered by the worker");
    assert.ok(loads.every((entry) => entry.status === 200), "with status 200");
  } finally {
    contextSetup = null;
  }
});
