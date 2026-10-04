// Unit 1.2 fixture row, leg QN: a QA run without browser checks (contract
// §1.2 "Without browser checks"). The run goes through qa run's own runner
// (runResolvedQa) with resolved inputs and a loopback stub serving the
// campaign pages; nothing is published, no live campaign is read, and no
// browser starts.
//
// This file does not import src/qc-test-factories.mjs: its guard blocks every
// fetch, loopback included, and the run's static page checks fetch the stub
// pages. The fixture guard below lets loopback through and fails the test on
// any other request (fetch, http(s), sockets, WebSocket).
//
// API assumption: runResolvedQa(args, resolved) without args.browser resolves
// to a result whose qc_results lists one content_param row per declared
// (param, applicable page), each excluded / browser_checks_not_requested with
// no members, and the verdict it writes carries each row's toQaAssertion(row,
// { family: "browser-runtime" }) (skipped + info, evidence.qc.reason_code
// set) under the contract's assertion id qc.content_param:<name>:<page>. The
// applicable pages of an entry without `pages` are every page of the run's
// topologies. Result ids follow the 1.0 qcResultId over the accept subject
// {check: "content_param", page, key: <param name>}. The run's other QC rows
// are the three tracking run-scope rows a run without test orders already
// writes (excluded / test_order_not_requested), unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

// The guard is installed before any module under test is imported.
import { assertLoopbackOnly, installNodeGuard } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard();
afterEach(() => assertLoopbackOnly());
after(() => assertLoopbackOnly());

const NAME = "reviews";
// Every QC row of the run: [id, subject, assertion id, assertion family,
// reason code].
const EXPECTED = Object.freeze([
  ["content_param:checkout:reviews", { check: "content_param", page: "checkout", key: NAME }, "qc.content_param:reviews:checkout", "browser-runtime", "browser_checks_not_requested"],
  ["content_param:landing:reviews", { check: "content_param", page: "landing", key: NAME }, "qc.content_param:reviews:landing", "browser-runtime", "browser_checks_not_requested"],
  ["tracking.order:run:order", { check: "tracking.order", page: "run", key: "order" }, "qc.tracking.order:run:order", "browser-test-order", "test_order_not_requested"],
  ["tracking.tag:run:tag", { check: "tracking.tag", page: "run", key: "tag" }, "qc.tracking.tag:run:tag", "browser-test-order", "test_order_not_requested"],
  ["tracking.url:run:url", { check: "tracking.url", page: "run", key: "url" }, "qc.tracking.url:run:url", "browser-test-order", "test_order_not_requested"],
]);
const byFirst = (a, b) => String(a[0]).localeCompare(String(b[0]));
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic page</title></head><body><main><section data-next-hide="param.reviews"><h2>Synthetic section</h2><p>Synthetic copy.</p></section></main></body></html>`;

async function startPages() {
  const log = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    log.push(`${request.method} ${url.pathname}${url.search}`);
    if (["/demo/landing/", "/demo/checkout/"].includes(url.pathname)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(PAGE_HTML);
    }
    response.writeHead(404, { "content-type": "text/plain" });
    return response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    log,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

test("F1.2-I19 spec declares reviews; qa run without --browser: excluded (browser_checks_not_requested)", { timeout: 120_000 }, async (t) => {
  const pages = await startPages();
  const outputDir = mkdtempSync(join(tmpdir(), "qa-content-params-"));
  t.after(async () => {
    await pages.close();
    rmSync(outputDir, { recursive: true, force: true });
  });
  const topologies = [{
    funnel_id: "main",
    funnel_name: "Main",
    pages: [
      { page_id: "landing", page_type: "landing", order: 1, url: `${pages.base}/demo/landing/` },
      { page_id: "checkout", page_type: "checkout", order: 2, url: `${pages.base}/demo/checkout/` },
    ],
  }];
  const spec = {
    campaign: {},
    funnels: [{ id: "main", pages: [{ id: "landing", type: "landing" }, { id: "checkout", type: "checkout" }] }],
    analytics: { params: { content: [{ name: NAME }] } },
  };
  const resolved = {
    themeGate: { status: "not_applicable", code: "theme_gate.policy_off", reason: "synthetic fixture" },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "synthetic fixture" },
    checkpointGates: [],
    qaWaivers: {},
    analyticsCaptureTarget: { url: null },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath: null,
    mapId: "content-params-synthetic",
    publicRouteSlug: "demo",
    proxyBase: "https://proxy.example.invalid",
    baseUrl: `${pages.base}/demo/`,
    spec,
    rawSpec: spec,
    specVersion: "4.3",
    specHash: "sha256:content-params-synthetic",
    topologies,
    excludedPages: [],
  };
  const args = { _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, "no-remit": true, "no-live-refs": true, "analytics-correctness": "false", json: true };
  assert.equal(args.browser, undefined, "setup: browser checks were not requested");

  const { __qaNodeTestHooks } = await import("./qa-node.mjs");
  const result = await __qaNodeTestHooks.runResolvedQa(args, resolved);
  assert.ok(pages.log.length > 0, "setup: the run's static page checks read the stub pages");

  // The run's complete QC result set: one content_param row per declared
  // (param, page) beside the tracking run-scope rows, all excluded, no members.
  const rows = Array.isArray(result.qc_results) ? result.qc_results : [];
  assert.deepEqual(
    rows.map((row) => [row.id, row.schema, row.check, row.leg, row.producer, row.subject, row.result, row.reason_code, row.accept_eligible, row.members]).sort(byFirst),
    EXPECTED.map(([id, subject, , , reasonCode]) => [id, "campaigns-os-qc-result/v0", subject.check, "qa", "campaigns-os qa run", subject, "excluded", reasonCode, false, []]),
    "the run's QC rows are exactly one excluded content_param row per (param, page) and the tracking run-scope rows",
  );

  // The written verdict's complete qc.* assertion set: one skipped assertion
  // per row, paired by result id, each carrying its row's observation.
  const verdict = JSON.parse(readFileSync(result.local_path, "utf8"));
  const qcAssertions = verdict.assertions.filter((entry) => String(entry?.id || "").startsWith("qc."));
  assert.deepEqual(
    qcAssertions.map((entry) => [entry.evidence?.qc?.result_id, entry.id, entry.family, entry.page, entry.status, entry.severity, entry.evidence?.qc?.reason_code]).sort(byFirst),
    EXPECTED.map(([id, subject, assertionId, family, reasonCode]) => [id, assertionId, family, subject.page, "skipped", "info", reasonCode]),
    "the verdict's qc.* assertions are exactly one skipped assertion per row",
  );
  for (const entry of qcAssertions) {
    const row = rows.find((candidate) => candidate.id === entry.evidence.qc.result_id);
    assert.deepEqual(entry.evidence.qc.observation, row.observation, `${entry.id} carries its row's observation`);
  }

  // The complete set re-derives through the 1.0 QA reader with the real modules.
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const build = "sha256:content-params-synthetic-build";
  const read = readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: build },
    stage: { identity: { verdict_run_id: verdict.run_id } },
    fullVerdict: verdict,
    currentBuild: build,
    rederivers: await loadQcRederivers(),
  });
  assert.deepEqual(
    read.map((row) => [row.id, row.subject, row.result, row.reason_code, row.members]).sort(byFirst),
    EXPECTED.map(([id, subject, , , reasonCode]) => [id, subject, "excluded", reasonCode, []]),
    "the reader re-derives exactly the run's rows",
  );

  // Nothing was loaded with the parameter.
  assert.deepEqual(pages.log.filter((line) => line.includes(`${NAME}=`)), [], "no request carried ?reviews=");
});
