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

const pageHtml = (script) => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic content params</title></head>`
  + `<body data-next-sdk-loading="true"><main><section data-next-hide="param.${NAME}"><h2>Synthetic section</h2><p>Synthetic copy.</p></section></main>`
  + `<script>${script}</script></body></html>`;

const CASES = {
  "/spoof-visibility/": pageScript({ toggle: false, overrides: ["visibility"] }),
  "/spoof-all/": pageScript({ toggle: false, overrides: ["visibility", "lookups", "readiness"] }),
  "/spoof-readiness/": pageScript({ toggle: true, overrides: ["readiness"], variantOnly: false, ready: false }),
  "/replace-first-frame/": pageScript({ toggle: true, firstFrame: "replace" }),
  "/move-first-frame/": pageScript({ toggle: true, firstFrame: "move" }),
};

let stub = null;
async function stubServer() {
  if (stub) return stub;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const script = CASES[url.pathname];
    if (!script) {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("not found");
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(pageHtml(script));
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
async function contentRow(path) {
  await installBrowserGuard();
  const server = await stubServer();
  const { runBrowserChecks } = await import("./qa-browser.mjs");
  const topologies = [{ funnel_id: "default", funnel_name: "Default", pages: [{ page_id: PAGE, page_type: "landing", order: 1, url: `${server.base}${path}` }] }];
  const qcResults = [];
  const assertions = await runBrowserChecks(topologies, { ...ARGS }, { spec: structuredClone(SPEC), qcResults });
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

browserTest("a page whose getAttribute and classList report the readiness signal it never sets: unexercised (readiness_timeout)", T, async () => {
  const row = await contentRow("/spoof-readiness/");
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
