// Unit 1.2 fixture rows, leg QB: content parameters checked at runtime by
// `qa run --browser` (runBrowserChecks), each against a loopback stub page.
//
// The stub page script (/stub-runtime.js below) stands in for the SDK's
// conditional display pass, just far enough to drive the check: it reads the
// page's own query, hides each [data-next-hide] whose condition holds and each
// [data-next-show] whose condition fails (show wins on an element carrying
// both), for the few single-term forms these pages use, then sets
// body[data-next-sdk-loading="false"] and/or html.next-display-ready. It is
// NOT the SDK; anything it cannot read it leaves alone. Every value is
// synthetic and every host is loopback (127.0.0.1).
//
// Each served document gets a `syn_ctx` cookie, and the stub logs every
// document request with its query and whether it carried that cookie, so each
// row compares the exact request log: the page checks' own load, then the
// pair's baseline load and its `?reviews=n` load, each in a fresh context.
//
// API assumption (every row): runBrowserChecks(topologies, args, options)
// takes the CampaignSpec as options.spec and an array as options.qcResults.
// After the page checks it pushes one full campaigns-os-qc-result/v0 row
// (buildQcResult) per declared (param, applicable page) into
// options.qcResults, and nothing else, and returns that row's
// toQaAssertion(row, { family: "browser-runtime" }) under the contract's
// assertion id among the assertions it already returns (none of which is a
// qc.* assertion). The applicable pages are the topology pages listed in the
// entry's `pages`, or every topology page when `pages` is absent.
//
// Ids (every row): the verdict assertion id is the contract's
// `qc.content_param:<name>:<page>`. The row id follows the 1.0 qcResultId over
// the accept subject {check: "content_param", page: <page id>, key: <param
// name>}, so it reads `content_param:<page>:<name>`, and the assertion names
// it in evidence.qc.result_id. Both are pinned as literals.
//
// API assumption (observation): the row observation carries the contract's
// fields param, page, readiness {baseline, param_n}, references [{attr,
// expr_sha256, form, prediction}], targets [{attr, expr_sha256, element_path,
// baseline: {present, visible, stable}, param_n: {...}}] and counts
// {baseline, param_n}, where:
//   - expr_sha256 is "sha256:" + the hex sha256 of the attribute value as the
//     DOM returns it;
//   - element_path is "body" followed by ">tag[index]" for each element step
//     down to the element, with the lowercase tag name and the 0-based index
//     among the parent's element children of the same tag (section 2 of
//     <main> is body>main[0]>section[1]);
//   - form is "presence" (param.<name>), "equals" (== or === a literal),
//     "not_equals" (!= a literal), "has" (param.has / param.exists), "is"
//     (param.is / param.equals) or "unsupported", and an unsupported
//     reference predicts "unknown".
//
// API assumption (members): one member per live element attribute that
// references the param, keyed "<attr>:<element_path>", with that reference's
// own result and reason code (so a reference that is not a target, such as an
// unsupported one, keeps its element_path in the observation; the tests
// compare references on the contract's four fields only). A row decided
// before any per-reference judgement (readiness_timeout, navigation_failed,
// page_not_served, budget_exhausted, no_resolvable_target, not_toggled_by_n,
// target_count_changed, excluded) has no members.
//
// API assumption (budget): the 60 s budget clock starts when the content
// parameter leg starts, after the page checks; pairs run in the declared
// param order, then topology page order.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test. The fixture
// module imports only node builtins; its guard covers every raw TCP or TLS
// socket connect and WebSocket. The factory, imported after it, installs its
// stricter fetch and http(s) guard before it loads any module under test, so
// a module that keeps a reference to any of these at import time keeps the
// guarded one.
import { assertExactMembers, assertLoopbackOnly, chromiumAvailable, installBrowserGuard, installNodeGuard, sha256 } from "./qa-tracking-params-fixtures.mjs";

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
  test.skip("Playwright Chromium is unavailable; content parameter browser rows skipped (run `npm run qa:install-browser`)", () => {});
}

// One runBrowserChecks call per row: a browser launch, the page checks' own
// load (up to the 10 s browser timeout plus its 5 s settle) and two loads of
// at most 20 s navigation plus 8 s readiness each. 120 s covers that worst case.
const T = { timeout: 120_000 };
const ARGS = Object.freeze({ "browser-timeout": 10_000 });
const NAME = "reviews";
const PAGE = "index";
const ID = "content_param:index:reviews";
const ASSERTION_ID = "qc.content_param:reviews:index";
const SUBJECT = Object.freeze({ check: "content_param", page: PAGE, key: NAME });
const SPEC = Object.freeze({ analytics: { params: { content: [{ name: NAME }] } } });
const READY = Object.freeze({ baseline: "ready", param_n: "ready" });
const VISIBLE = Object.freeze({ present: true, visible: true, stable: true });
const HIDDEN = Object.freeze({ present: true, visible: false, stable: true });
// The QA verdict mapping of each result (contract 1.0 vocabulary table).
const ASSERTION_STATUS = Object.freeze({
  pass: ["pass", "info"],
  warning: ["warn", "warn"],
  review: ["manual_review", "warn"],
  unexercised: ["manual_review", "warn"],
  excluded: ["skipped", "info"],
});

const pathOf = (index) => `body>main[0]>section[${index}]`;
const keyOf = (attr, index) => `${attr}:${pathOf(index)}`;

// ---------------------------------------------------------------------------
// The loopback stub

const STUB_RUNTIME_JS = String.raw`(function () {
  var config = window.__stubConfig || {};
  var params = new URLSearchParams(location.search);
  var value = function (name) { return params.has(name) ? params.get(name) : undefined; };
  function evaluate(expression) {
    var text = String(expression || "").trim();
    var m;
    if ((m = /^params?\.([A-Za-z_]\w*)$/.exec(text))) return params.has(m[1]);
    if ((m = /^params?\.([A-Za-z_]\w*)\s*===?\s*'([^']*)'$/.exec(text))) return value(m[1]) === m[2];
    if ((m = /^params?\.([A-Za-z_]\w*)\s*!=\s*'([^']*)'$/.exec(text))) return value(m[1]) !== m[2];
    if ((m = /^param\.(?:has|exists)\('([^']*)'\)$/.exec(text))) return params.has(m[1]);
    if ((m = /^param\.([A-Za-z_]\w*)\s*\|\|\s*param\.([A-Za-z_]\w*)$/.exec(text))) return params.has(m[1]) || params.has(m[2]);
    return null;
  }
  function displayPass() {
    var elements = document.querySelectorAll("[data-next-hide], [data-next-show]");
    for (var i = 0; i < elements.length; i += 1) {
      var element = elements[i];
      var show = element.getAttribute("data-next-show");
      var hide = element.getAttribute("data-next-hide");
      var hidden = show !== null ? evaluate(show) === false : evaluate(hide) === true;
      if (hidden) element.style.display = "none";
    }
  }
  function replaceLoop(selector) {
    var replace = function () {
      var element = document.querySelector(selector);
      if (element) element.replaceWith(element.cloneNode(true));
    };
    setInterval(replace, 0);
    (function frame() { replace(); requestAnimationFrame(frame); })();
  }
  function ready() {
    if (config.ready === "never") return;
    if (config.ready !== "class") document.body.setAttribute("data-next-sdk-loading", "false");
    if (config.ready !== "attribute") document.documentElement.classList.add("next-display-ready");
    if (config.replaceLoop) replaceLoop(config.replaceLoop);
  }
  function boot() {
    displayPass();
    setTimeout(ready, 50);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();`;

const escapeAttr = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const section = (attrs = {}) => {
  const rendered = Object.entries(attrs).map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  return `<section${rendered}><h2>Synthetic section</h2><p>Synthetic copy for a content parameter check.</p></section>`;
};
const hideSection = (expression, attrs = {}) => section({ ...attrs, "data-next-hide": expression });

function pageHtml({ main, ready = "both", style = "", replaceLoop = null }) {
  const config = JSON.stringify({ ready, replaceLoop });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic content params</title>${style ? `<style>${style}</style>` : ""}</head>`
    + `<body data-next-sdk-loading="true"><main>${main}</main><script>window.__stubConfig = ${config};</script><script src="/stub-runtime.js"></script></body></html>`;
}

// Each case path answers (query) => { status?, html }.
const KEEP_VISIBLE = ".keep { display: block !important; }";
const CASES = {
  "/w1/": () => ({ html: pageHtml({ main: hideSection("param.reviews") }) }),
  "/w2/": () => ({ html: pageHtml({ ready: "attribute", main: hideSection("param.reviews == 'n'") + hideSection("param.has('reviews')") }) }),
  "/w3/": () => ({ html: pageHtml({ ready: "class", main: section({ "data-next-show": "param.reviews != 'n'" }) }) }),
  "/b1/": () => ({ html: pageHtml({ style: KEEP_VISIBLE, main: hideSection("param.reviews", { class: "keep" }) }) }),
  "/b2/": () => ({ html: pageHtml({ main: hideSection("param.reviews == 'y'") }) }),
  "/b3/": () => ({ html: pageHtml({ style: KEEP_VISIBLE, main: hideSection("param.reviews", { class: "keep" }) + hideSection("param.reviews || param.x") }) }),
  "/i1/": () => ({ html: pageHtml({ main: hideSection("param.reviews", { style: "display:none" }) }) }),
  "/i2/": () => ({ html: pageHtml({ main: hideSection("param.promo") }) }),
  "/i3/": () => ({ html: pageHtml({ main: hideSection("param.reviews && cart.hasItems") }) }),
  "/i4/": () => ({ html: pageHtml({ main: hideSection("param.reviews !== 'y'") }) }),
  "/i5/": () => ({ html: pageHtml({ ready: "never", main: hideSection("param.reviews") }) }),
  "/i6/": () => ({ html: pageHtml({ main: section({ "data-next-show": "order.hasItems", "data-next-hide": "param.reviews" }) }) }),
  "/i7/": () => ({ html: pageHtml({ main: `<template>${hideSection("param.reviews")}</template><p>Synthetic copy.</p>` }) }),
  // The variant context renders one more matching target.
  "/i9/": (query) => ({ html: pageHtml({ main: hideSection("param.reviews") + (query.has(NAME) ? hideSection("param.reviews") : "") }) }),
  // The variant page script keeps replacing the target with an identical node
  // at the same location once the page is ready.
  "/i10/": (query) => ({ html: pageHtml({ main: hideSection("param.reviews"), replaceLoop: query.has(NAME) ? "main > section" : null }) }),
  // A 404 that still renders a working page.
  "/i12/": () => ({ status: 404, html: pageHtml({ main: hideSection("param.reviews") }) }),
  "/i14/": () => ({ html: pageHtml({ main: hideSection("!param.reviews") }) }),
  "/i15/": () => ({ html: pageHtml({ main: hideSection("(param.reviews)") }) }),
  "/i16/": () => ({ html: pageHtml({ main: hideSection("param.reviews > 0") }) }),
  "/i17/": () => ({ html: pageHtml({ main: hideSection("param.reviews >= 1") }) }),
  "/i18/": () => ({ html: pageHtml({ main: hideSection("param.reviews <= 1") }) }),
  // Nine fast pages, one (reviews, page) pair each.
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`/i8/p${index + 1}/`, () => ({ html: pageHtml({ main: hideSection("param.reviews") }) })])),
  // Two slow pages: after the page checks' own (fast) load, each load waits
  // SLOW_MS for its document, and page b's ?reviews=n load is never answered.
  "/i13/a/": () => ({ html: pageHtml({ main: hideSection("param.reviews") }) }),
  "/i13/b/": () => ({ html: pageHtml({ main: hideSection("param.reviews") }) }),
};

// F1.2-I13 runs the leg on a 10 s budget instead of the production 60 s
// (runBrowserChecks' contentParamLimits). The three answered slow loads take
// 3 s of it, plus four fresh contexts, which leaves several seconds before
// the cut; the fourth load is held until the budget ends it.
const I13_BUDGET_MS = 10_000;
// Document delays by request (path and query) and its 1-based count.
const SLOW_MS = 1_000;
const DELAYS = {
  "/i13/a/": (nth) => (nth === 1 ? 0 : SLOW_MS),
  "/i13/a/?reviews=n": () => SLOW_MS,
  "/i13/b/": (nth) => (nth === 1 ? 0 : SLOW_MS),
  "/i13/b/?reviews=n": () => "hold",
};

let stub = null;
async function stubServer() {
  if (stub) return stub;
  const log = [];
  const counts = new Map();
  const held = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/stub-runtime.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      return response.end(STUB_RUNTIME_JS);
    }
    const render = CASES[url.pathname];
    if (!render) {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("not found");
    }
    const requested = `${url.pathname}${url.search}`;
    log.push({ path: url.pathname, query: url.search, fresh: !String(request.headers.cookie || "").includes("syn_ctx="), at: Date.now() });
    counts.set(requested, (counts.get(requested) || 0) + 1);
    const delay = DELAYS[requested]?.(counts.get(requested)) ?? 0;
    const { status = 200, html } = render(url.searchParams);
    const answer = () => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "set-cookie": "syn_ctx=1; Path=/" });
      response.end(html);
    };
    if (delay === "hold") return held.add(response);
    if (delay > 0) return setTimeout(answer, delay);
    return answer();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub = {
    base: `http://127.0.0.1:${server.address().port}`,
    log,
    close: () => new Promise((resolve) => {
      for (const response of held) response.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
  return stub;
}

async function closedLoopbackUrl(path) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}${path}`;
}

// One runBrowserChecks call over a one-funnel topology of `pages`
// ([{ id, path, url? }]). `limits` replaces fields of the leg's
// CONTENT_PARAM_LIMITS (runBrowserChecks' in-process contentParamLimits).
async function runPages(pages, { spec = SPEC, limits } = {}) {
  await installBrowserGuard();
  const server = await stubServer();
  const { runBrowserChecks } = await import("./qa-browser.mjs");
  const topologies = [{
    funnel_id: "default",
    funnel_name: "Default",
    pages: pages.map((page, index) => ({ page_id: page.id, page_type: "landing", order: index + 1, url: page.url ?? `${server.base}${page.path}` })),
  }];
  const start = server.log.length;
  const qcResults = [];
  const assertions = await runBrowserChecks(topologies, { ...ARGS }, { spec: structuredClone(spec), qcResults, contentParamLimits: limits });
  const finishedAt = Date.now();
  assert.ok(Array.isArray(assertions), "runBrowserChecks still returns its assertions");
  return { assertions, qcResults, log: server.log.slice(start), finishedAt };
}
const runCase = (path, { url = null, limits } = {}) => runPages([{ id: PAGE, path, url }], { limits });

// ---------------------------------------------------------------------------
// Reading the 1.2 rows of a run

// The run's complete QC result set (everything pushed into qcResults) and its
// complete qc.* assertion set are exactly the ids of `pages`: row
// content_param:<page>:reviews with assertion qc.content_param:reviews:<page>,
// paired by evidence.qc.result_id. Each row is a full QA row with its pinned
// subject, its paired assertion carries its observation with the verdict
// mapping of its result, nothing persisted holds expression text (no "param."
// at all, nor any of the page's other expressions) or the variant query, and
// the complete set re-derives through the 1.0 QA reader with the real module
// from the registry. Returns the rows by page id.
async function contentRows(run, pages, expressions = []) {
  const ids = pages.map((page) => `content_param:${page}:${NAME}`);
  const subjects = Object.fromEntries(pages.map((page, index) => [ids[index], { check: "content_param", page, key: NAME }]));
  const assertionIds = Object.fromEntries(pages.map((page, index) => [ids[index], `qc.content_param:${NAME}:${page}`]));
  const rows = run.qcResults;
  assert.deepEqual(rows.map((row) => row?.id).sort(), [...ids].sort(), "the run's QC results are exactly the setup's content_param rows");
  const qcAssertions = run.assertions.filter((entry) => String(entry?.id || "").startsWith("qc."));
  assert.deepEqual(
    qcAssertions.map((entry) => [entry.evidence?.qc?.result_id, entry.id]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [...ids].sort().map((id) => [id, assertionIds[id]]),
    "the run's qc.* assertions are exactly one qc.content_param:reviews:<page> assertion per row",
  );
  for (const row of rows) {
    const paired = qcAssertions.find((entry) => entry.evidence?.qc?.result_id === row.id);
    assert.equal(row.schema, "campaigns-os-qc-result/v0", `${row.id} schema`);
    assert.equal(row.check, "content_param", `${row.id} check`);
    assert.equal(row.leg, "qa", `${row.id} leg`);
    assert.equal(row.producer, "campaigns-os qa run", `${row.id} producer`);
    assert.deepEqual(row.subject, subjects[row.id], `${row.id} subject`);
    assert.deepEqual(
      [paired.id, paired.family, paired.page, paired.status, paired.severity],
      [assertionIds[row.id], "browser-runtime", subjects[row.id].page, ...ASSERTION_STATUS[row.result]],
      `${row.id} paired assertion`,
    );
    assert.deepEqual(paired.evidence.qc.observation, row.observation, `${row.id} assertion carries the row's observation`);
    const persisted = JSON.stringify([row, paired]);
    for (const expression of ["param.", ...expressions]) assert.equal(persisted.includes(expression), false, `${row.id}: no expression text is persisted (${expression})`);
    assert.equal(persisted.includes(`${NAME}=n`), false, `${row.id}: the variant is never stored as a query string`);
  }

  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const measuredAt = new Date().toISOString();
  const read = readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: qcAssertions, measuredAt }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  const project = (entry) => [entry.id, entry.subject, entry.result, entry.reason_code, entry.state_fingerprint, entry.members, entry.accept_eligible, entry.coverage];
  const byId = (a, b) => String(a[0]).localeCompare(String(b[0]));
  assert.deepEqual(read.map(project).sort(byId), rows.map(project).sort(byId), "the 1.0 QA reader re-derives exactly the run's rows with the real module");
  return new Map(rows.map((row) => [row.subject.page, row]));
}
async function contentRow(run, expressions = []) {
  const row = (await contentRows(run, [PAGE], expressions)).get(PAGE);
  assert.deepEqual([row.id, row.subject], [ID, SUBJECT], "the pinned result id and subject");
  assert.deepEqual(run.assertions.filter((entry) => String(entry?.id || "").startsWith("qc.")).map((entry) => entry.id), [ASSERTION_ID], "the pinned assertion id");
  return row;
}

// result, reason code, accept eligibility and the exact members
// ({ "<key>": [result, reason_code] }).
function assertResult(row, { result, reasonCode, acceptEligible, members }) {
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], [result, reasonCode, acceptEligible], `${row.id} reads ${result} / ${reasonCode}, accept_eligible ${acceptEligible}`);
  assertExactMembers(row, members);
}

const byIdentity = (a, b) => `${a.attr}|${a.expr_sha256}|${a.element_path ?? ""}`.localeCompare(`${b.attr}|${b.expr_sha256}|${b.element_path ?? ""}`);
const reference = (attr, expression, form, prediction) => ({ attr, expr_sha256: sha256(expression), form, prediction });
const target = (attr, expression, index, baseline, paramN) => ({ attr, expr_sha256: sha256(expression), element_path: pathOf(index), baseline, param_n: paramN });

// Compares the named observation fields exactly: each reference on the
// contract's {attr, expr_sha256, form, prediction} and each target on its
// {attr, expr_sha256, element_path, baseline, param_n} (an entry may carry
// more fields, such as a reference's own element_path). `referenceIds`
// compares only each reference's {attr, expr_sha256}.
function assertObservation(row, { readiness, readinessBaseline, references, referenceIds, targets, counts }) {
  const observation = row.observation;
  assert.ok(observation && typeof observation === "object", `${row.id} carries an observation`);
  assert.deepEqual([observation.param, observation.page], [NAME, row.subject.page], "observation param and page");
  if (readiness) assert.deepEqual(observation.readiness, readiness, "observation readiness");
  if (readinessBaseline) assert.equal(observation.readiness?.baseline, readinessBaseline, "observation baseline readiness");
  if (references) {
    assert.ok(Array.isArray(observation.references), "observation references[]");
    const projected = observation.references.map(({ attr, expr_sha256, form, prediction }) => ({ attr, expr_sha256, form, prediction }));
    assert.deepEqual(projected.sort(byIdentity), [...references].sort(byIdentity), "observation references");
  }
  if (referenceIds) {
    assert.ok(Array.isArray(observation.references), "observation references[]");
    assert.deepEqual(observation.references.map(({ attr, expr_sha256 }) => ({ attr, expr_sha256 })).sort(byIdentity), referenceIds.map(([attr, expression]) => ({ attr, expr_sha256: sha256(expression) })).sort(byIdentity), "observation reference identities");
  }
  if (targets) {
    assert.ok(Array.isArray(observation.targets), "observation targets[]");
    const projected = observation.targets.map(({ attr, expr_sha256, element_path, baseline, param_n }) => ({ attr, expr_sha256, element_path, baseline, param_n }));
    assert.deepEqual(projected.sort(byIdentity), [...targets].sort(byIdentity), "observation targets");
  }
  if (counts) assert.deepEqual(observation.counts, counts, "observation counts");
}

// The exact document request log: the page checks' own load, then each listed
// load, each of those from a fresh context (no cookie from an earlier load).
function assertLoads(run, path, loads) {
  assert.deepEqual(run.log.map((entry) => `${entry.path}${entry.query}`), [path, ...loads], "the exact document request log");
  assert.deepEqual(run.log.slice(1).filter((entry) => !entry.fresh).map((entry) => `${entry.path}${entry.query}`), [], "every content parameter load came from a fresh browser context");
}
const pairLoads = (path) => [path, `${path}?${NAME}=n`];

// ---------------------------------------------------------------------------
// Working

browserTest("F1.2-W1 data-next-hide=\"param.reviews\" visible at baseline, hidden with ?reviews=n, fresh contexts: pass", T, async () => {
  const run = await runCase("/w1/");
  const row = await contentRow(run);
  assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [keyOf("hide", 0)]: ["pass", null] } });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", "param.reviews", "presence", "hidden")],
    targets: [target("hide", "param.reviews", 0, VISIBLE, HIDDEN)],
    counts: { baseline: 1, param_n: 1 },
  });
  assertLoads(run, "/w1/", pairLoads("/w1/"));
});

browserTest("F1.2-W2 targets using param.reviews == 'n' and param.has('reviews') (readiness by data-next-sdk-loading only): pass", T, async () => {
  const run = await runCase("/w2/");
  const row = await contentRow(run);
  assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [keyOf("hide", 0)]: ["pass", null], [keyOf("hide", 1)]: ["pass", null] } });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", "param.reviews == 'n'", "equals", "hidden"), reference("hide", "param.has('reviews')", "has", "hidden")],
    targets: [target("hide", "param.reviews == 'n'", 0, VISIBLE, HIDDEN), target("hide", "param.has('reviews')", 1, VISIBLE, HIDDEN)],
    counts: { baseline: 2, param_n: 2 },
  });
  assertLoads(run, "/w2/", pairLoads("/w2/"));
});

browserTest("F1.2-W3 data-next-show=\"param.reviews != 'n'\" (readiness by html.next-display-ready only): pass", T, async () => {
  const run = await runCase("/w3/");
  const row = await contentRow(run);
  assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [keyOf("show", 0)]: ["pass", null] } });
  assertObservation(row, {
    readiness: READY,
    references: [reference("show", "param.reviews != 'n'", "not_equals", "hidden")],
    targets: [target("show", "param.reviews != 'n'", 0, VISIBLE, HIDDEN)],
    counts: { baseline: 1, param_n: 1 },
  });
  assertLoads(run, "/w3/", pairLoads("/w3/"));
});

// ---------------------------------------------------------------------------
// Broken

browserTest("F1.2-B1 target stays visible with ?reviews=n after readiness: warning (target_still_visible)", T, async () => {
  const run = await runCase("/b1/");
  const row = await contentRow(run);
  assertResult(row, { result: "warning", reasonCode: "target_still_visible", acceptEligible: true, members: { [keyOf("hide", 0)]: ["warning", "target_still_visible"] } });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", "param.reviews", "presence", "hidden")],
    targets: [target("hide", "param.reviews", 0, VISIBLE, VISIBLE)],
    counts: { baseline: 1, param_n: 1 },
  });
  assertLoads(run, "/b1/", pairLoads("/b1/"));
});

browserTest("F1.2-B2 only handler is data-next-hide=\"param.reviews == 'y'\": warning (not_toggled_by_n)", T, async () => {
  const run = await runCase("/b2/");
  const row = await contentRow(run);
  assertResult(row, { result: "warning", reasonCode: "not_toggled_by_n", acceptEligible: true, members: {} });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", "param.reviews == 'y'", "equals", "visible")],
    targets: [],
    counts: { baseline: 0, param_n: 0 },
  });
  assertLoads(run, "/b2/", pairLoads("/b2/"));
});

browserTest("F1.2-B3 target A stays visible; target B uses param.reviews || param.x: warning (target_still_visible), accept_eligible false, both members listed", T, async () => {
  const run = await runCase("/b3/");
  const row = await contentRow(run);
  assertResult(row, {
    result: "warning",
    reasonCode: "target_still_visible",
    acceptEligible: false,
    members: { [keyOf("hide", 0)]: ["warning", "target_still_visible"], [keyOf("hide", 1)]: ["review", "unsupported_expression"] },
  });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", "param.reviews", "presence", "hidden"), reference("hide", "param.reviews || param.x", "unsupported", "unknown")],
    targets: [target("hide", "param.reviews", 0, VISIBLE, VISIBLE)],
    counts: { baseline: 1, param_n: 1 },
  });
  assertLoads(run, "/b3/", pairLoads("/b3/"));
});

// ---------------------------------------------------------------------------
// Incomplete

browserTest("F1.2-I1 target already hidden at baseline: review (already_hidden_at_baseline)", T, async () => {
  const run = await runCase("/i1/");
  const row = await contentRow(run);
  assertResult(row, { result: "review", reasonCode: "already_hidden_at_baseline", acceptEligible: false, members: { [keyOf("hide", 0)]: ["review", "already_hidden_at_baseline"] } });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", "param.reviews", "presence", "hidden")],
    targets: [target("hide", "param.reviews", 0, HIDDEN, HIDDEN)],
    counts: { baseline: 1, param_n: 1 },
  });
  assertLoads(run, "/i1/", pairLoads("/i1/"));
});

browserTest("F1.2-I2 applicable page has no param.reviews expression: review (no_resolvable_target)", T, async () => {
  const run = await runCase("/i2/");
  const row = await contentRow(run);
  assertResult(row, { result: "review", reasonCode: "no_resolvable_target", acceptEligible: false, members: {} });
  assertObservation(row, { readiness: READY, references: [], targets: [], counts: { baseline: 0, param_n: 0 } });
  assertLoads(run, "/i2/", pairLoads("/i2/"));
});

browserTest("F1.2-I3 data-next-hide=\"param.reviews && cart.hasItems\": review (mixed_param_cart)", T, async () => {
  const run = await runCase("/i3/");
  const row = await contentRow(run, ["cart.hasItems"]);
  assertResult(row, { result: "review", reasonCode: "mixed_param_cart", acceptEligible: false, members: { [keyOf("hide", 0)]: ["review", "mixed_param_cart"] } });
  assertObservation(row, { readiness: READY, referenceIds: [["hide", "param.reviews && cart.hasItems"]] });
  assertLoads(run, "/i3/", pairLoads("/i3/"));
});

// The five other unsupported forms share one shape: a single hide reference,
// classified unsupported with an unknown prediction, and no target.
async function assertUnsupported(path, expression) {
  const run = await runCase(path);
  const row = await contentRow(run);
  assertResult(row, { result: "review", reasonCode: "unsupported_expression", acceptEligible: false, members: { [keyOf("hide", 0)]: ["review", "unsupported_expression"] } });
  assertObservation(row, {
    readiness: READY,
    references: [reference("hide", expression, "unsupported", "unknown")],
    targets: [],
    counts: { baseline: 0, param_n: 0 },
  });
  assertLoads(run, path, pairLoads(path));
}

browserTest("F1.2-I4 data-next-hide=\"param.reviews !== 'y'\": review (unsupported_expression)", T, async () => {
  await assertUnsupported("/i4/", "param.reviews !== 'y'");
});

// The page never signals readiness, so both loads wait out the readiness
// bound: 8 s each in production, 1.5 s each here.
browserTest("F1.2-I5 data-next-sdk-loading stays \"true\": unexercised (readiness_timeout)", T, async () => {
  const run = await runCase("/i5/", { limits: { readinessMs: 1_500 } });
  const row = await contentRow(run);
  assertResult(row, { result: "unexercised", reasonCode: "readiness_timeout", acceptEligible: false, members: {} });
  assertObservation(row, { readinessBaseline: "readiness_timeout" });
  assert.deepEqual(run.log.slice(0, 2).map((entry) => `${entry.path}${entry.query}`), ["/i5/", "/i5/"], "the page checks' load, then the baseline load");
  assert.deepEqual(run.log.slice(1).filter((entry) => !entry.fresh), [], "every content parameter load came from a fresh browser context");
});

browserTest("F1.2-I6 element carries both data-next-show and data-next-hide, param on hide: review (show_overrides_hide)", T, async () => {
  const run = await runCase("/i6/");
  const row = await contentRow(run, ["order.hasItems"]);
  assertResult(row, { result: "review", reasonCode: "show_overrides_hide", acceptEligible: false, members: { [keyOf("hide", 0)]: ["review", "show_overrides_hide"] } });
  assertObservation(row, { readiness: READY, referenceIds: [["hide", "param.reviews"]] });
  assertLoads(run, "/i6/", pairLoads("/i6/"));
});

browserTest("F1.2-I7 expression only inside <template>: review (no_resolvable_target)", T, async () => {
  const run = await runCase("/i7/");
  const row = await contentRow(run);
  assertResult(row, { result: "review", reasonCode: "no_resolvable_target", acceptEligible: false, members: {} });
  assertObservation(row, { readiness: READY, references: [], targets: [], counts: { baseline: 0, param_n: 0 } });
  assertLoads(run, "/i7/", pairLoads("/i7/"));
});

browserTest("F1.2-I8 9 (param, page) pairs on fast pages: the 9th pair unexercised (budget_exhausted); the first 8 measured", {
  // Nine page-check loads in one context (each up to the 10 s browser timeout
  // plus its 5 s settle), then a content parameter leg capped at 60 s, plus
  // the browser launch: 240 s covers the worst case.
  timeout: 240_000,
}, async () => {
  const pages = Array.from({ length: 9 }, (_, index) => ({ id: `p${index + 1}`, path: `/i8/p${index + 1}/` }));
  const run = await runPages(pages);
  const rows = await contentRows(run, pages.map((page) => page.id));
  for (const page of pages.slice(0, 8)) {
    const row = rows.get(page.id);
    assertResult(row, { result: "pass", reasonCode: null, acceptEligible: false, members: { [keyOf("hide", 0)]: ["pass", null] } });
    assertObservation(row, {
      readiness: READY,
      references: [reference("hide", "param.reviews", "presence", "hidden")],
      targets: [target("hide", "param.reviews", 0, VISIBLE, HIDDEN)],
      counts: { baseline: 1, param_n: 1 },
    });
  }
  assertResult(rows.get("p9"), { result: "unexercised", reasonCode: "budget_exhausted", acceptEligible: false, members: {} });
  // The page checks load every page once (one shared context); the leg then
  // loads 8 pairs, two fresh contexts each, and never loads the 9th page.
  assert.deepEqual(
    run.log.map((entry) => `${entry.path}${entry.query}`),
    [...pages.map((page) => page.path), ...pages.slice(0, 8).flatMap((page) => pairLoads(page.path))],
    "the exact document request log",
  );
  assert.deepEqual(run.log.slice(9).filter((entry) => !entry.fresh), [], "every content parameter load came from a fresh browser context");
});

browserTest("F1.2-I9 variant context renders one more matching target: review (target_count_changed)", T, async () => {
  const run = await runCase("/i9/");
  const row = await contentRow(run);
  assertResult(row, { result: "review", reasonCode: "target_count_changed", acceptEligible: false, members: {} });
  assertObservation(row, { readiness: READY, counts: { baseline: 1, param_n: 2 } });
  assertLoads(run, "/i9/", pairLoads("/i9/"));
});

browserTest("F1.2-I10 variant page script replaces the target with an identical node at the same location after readiness: review (target_identity_unresolved)", T, async () => {
  const run = await runCase("/i10/");
  const row = await contentRow(run);
  assertResult(row, { result: "review", reasonCode: "target_identity_unresolved", acceptEligible: false, members: { [keyOf("hide", 0)]: ["review", "target_identity_unresolved"] } });
  assertObservation(row, { readiness: READY, references: [reference("hide", "param.reviews", "presence", "hidden")], counts: { baseline: 1, param_n: 1 } });
  const targets = row.observation.targets;
  assert.deepEqual(
    targets.map((entry) => [entry.attr, entry.expr_sha256, entry.element_path, entry.baseline, entry.param_n?.stable]),
    [["hide", sha256("param.reviews"), pathOf(0), VISIBLE, false]],
    "the one target is stable at baseline and replaced (stable: false) in the variant context",
  );
  assertLoads(run, "/i10/", pairLoads("/i10/"));
});

browserTest("F1.2-I11 applicable page URL points at a closed loopback port: unexercised (navigation_failed)", T, async () => {
  const url = await closedLoopbackUrl("/i11/");
  const run = await runCase("/i11/", { url });
  const row = await contentRow(run);
  assertResult(row, { result: "unexercised", reasonCode: "navigation_failed", acceptEligible: false, members: {} });
  assertObservation(row, { readinessBaseline: "navigation_failed" });
});

browserTest("F1.2-I12 applicable page returns 404: unexercised (page_not_served)", T, async () => {
  const run = await runCase("/i12/");
  const row = await contentRow(run);
  assertResult(row, { result: "unexercised", reasonCode: "page_not_served", acceptEligible: false, members: {} });
  assertObservation(row, { readinessBaseline: "page_not_served" });
  assert.deepEqual(run.log.slice(0, 2).map((entry) => `${entry.path}${entry.query}`), ["/i12/", "/i12/"], "the page checks' load, then the baseline load");
});

browserTest("F1.2-I13 two pairs; the second pair's param_n load is still running when the budget ends (slow stub): the 2nd pair unexercised (budget_exhausted); the first measured", {
  // Two fast page-check loads, then the leg: three SLOW_MS loads and a fourth
  // that is never answered until the 10 s budget ends it, plus the browser
  // launch and cleanup: 60 s covers the worst case.
  timeout: 60_000,
}, async () => {
  const pages = [{ id: "a", path: "/i13/a/" }, { id: "b", path: "/i13/b/" }];
  const run = await runPages(pages, { limits: { budgetMs: I13_BUDGET_MS } });
  const rows = await contentRows(run, ["a", "b"]);
  assertResult(rows.get("a"), { result: "pass", reasonCode: null, acceptEligible: false, members: { [keyOf("hide", 0)]: ["pass", null] } });
  assertObservation(rows.get("a"), {
    readiness: READY,
    references: [reference("hide", "param.reviews", "presence", "hidden")],
    targets: [target("hide", "param.reviews", 0, VISIBLE, HIDDEN)],
    counts: { baseline: 1, param_n: 1 },
  });
  assertResult(rows.get("b"), { result: "unexercised", reasonCode: "budget_exhausted", acceptEligible: false, members: {} });
  const loads = run.log.map((entry) => `${entry.path}${entry.query}`);
  assert.deepEqual(loads, ["/i13/a/", "/i13/b/", ...pairLoads("/i13/a/"), ...pairLoads("/i13/b/")], "the exact document request log: the 2nd pair's param_n load was started");
  assert.deepEqual(run.log.slice(2).filter((entry) => !entry.fresh), [], "every content parameter load came from a fresh browser context");
  // Both ends of the cut. The leg is timed from its first load reaching the
  // stub (log[2]); the leg's own clock started a little earlier, while it
  // opened that load's fresh context and began navigating, so the time
  // measured here undercounts the leg by that gap. TOLERANCE_MS allows 2 s for
  // it: far above a context opening and a loopback request (well under a
  // second), well below the 6 s or more left if the leg gave up as soon as
  // the 4th load started (after three SLOW_MS loads, under 4 s in). Lower
  // bound: the 2nd pair was cut only after the budget was spent. A floor that
  // needs no tolerance backs it: the leg starts after the page checks, so
  // after the page checks' last load (log[1]). Upper bound: the leg ended
  // within the budget plus up to 5 s to close its contexts and the browser,
  // and the budget, not the 20 s navigation timeout, ended the held load.
  const BUDGET_MS = I13_BUDGET_MS;
  const TOLERANCE_MS = 2_000;
  const CLEANUP_MS = 5_000;
  const held = run.log[5];
  const elapsed = run.finishedAt - run.log[2].at;
  assert.ok(elapsed >= BUDGET_MS - TOLERANCE_MS, `the leg took ${elapsed} ms from its first load: the 2nd pair was cut before the ${BUDGET_MS} ms budget was spent`);
  assert.ok(run.finishedAt - run.log[1].at >= BUDGET_MS, `the run ended ${run.finishedAt - run.log[1].at} ms after the page checks' last load, under the ${BUDGET_MS} ms budget`);
  assert.ok(elapsed <= BUDGET_MS + CLEANUP_MS, `the leg took ${elapsed} ms from its first load, past the ${BUDGET_MS} ms budget plus ${CLEANUP_MS} ms cleanup`);
  assert.ok(run.finishedAt - held.at < 20_000, `the held load ended within ${run.finishedAt - held.at} ms, before a navigation timeout could`);
});

browserTest("F1.2-I14 data-next-hide=\"!param.reviews\": review (unsupported_expression)", T, async () => {
  await assertUnsupported("/i14/", "!param.reviews");
});

browserTest("F1.2-I15 data-next-hide=\"(param.reviews)\": review (unsupported_expression)", T, async () => {
  await assertUnsupported("/i15/", "(param.reviews)");
});

browserTest("F1.2-I16 data-next-hide=\"param.reviews > 0\": review (unsupported_expression)", T, async () => {
  await assertUnsupported("/i16/", "param.reviews > 0");
});

browserTest("F1.2-I17 data-next-hide=\"param.reviews >= 1\": review (unsupported_expression)", T, async () => {
  await assertUnsupported("/i17/", "param.reviews >= 1");
});

browserTest("F1.2-I18 data-next-hide=\"param.reviews <= 1\": review (unsupported_expression)", T, async () => {
  await assertUnsupported("/i18/", "param.reviews <= 1");
});
