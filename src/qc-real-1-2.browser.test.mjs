// The shared QC row whose QA producer was a stand-in for the content
// parameter check, re-run end to end with the real 1.2 producer. The QA row
// and its verdict assertion come from a real `runBrowserChecks` run on a
// loopback stub page whose SDK never finishes loading
// (body[data-next-sdk-loading] stays "true"), and the reader, `next` and the
// accept assessment re-derive it through the registry's real module: no
// qcStandIns is passed anywhere in this file.
//
// API assumptions: as in src/qa-content-params.browser.test.mjs
// (runBrowserChecks takes options.spec and pushes its content_param rows, and
// nothing else, into options.qcResults, returning each row's browser-runtime
// assertion; the (reviews, landing) pair's row id is
// content_param:landing:reviews and its assertion id the contract's
// qc.content_param:reviews:landing; a row decided by readiness has no
// members).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test. The fixture
// module imports only node builtins; its guard covers every raw TCP or TLS
// socket connect and WebSocket. The factory, imported after it, installs its
// stricter fetch and http(s) guard before it loads any module under test, so
// a module that keeps a reference to any of these at import time keeps the
// guarded one.
import { assertLoopbackOnly, chromiumAvailable, installBrowserGuard, installNodeGuard } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
const {
  BUILD_FP,
  QA_RUN_ID,
  appendAccept,
  assertNoNetworkAttempts,
  campaignFixture,
  handAccept,
  handoffOf,
  installQaStage,
  readJson,
  resultsOf,
  runNext,
} = await import("./qc-test-factories.mjs");

afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; 1.2 re-run rows skipped (run `npm run qa:install-browser`)", () => {});
}

const NAME = "reviews";
const PAGE = "landing";
const ID = "content_param:landing:reviews";
const ASSERTION_ID = "qc.content_param:reviews:landing";
const SUBJECT = Object.freeze({ check: "content_param", page: PAGE, key: NAME });
const RUN_SPEC = Object.freeze({ analytics: { params: { content: [{ name: NAME }] } } });
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic content params</title></head>`
  + `<body data-next-sdk-loading="true"><main><section data-next-hide="param.reviews"><h2>Synthetic section</h2><p>Synthetic copy.</p></section></main></body></html>`;
// The QA checks of the fixture's spec that hold no row in this QA stage
// (tracking always; the policy links because the example spec declares store
// policy URLs), each listed under coverage as not captured.
const NOT_CAPTURED = ["policy.availability", "policy.presence", "tracking.order", "tracking.tag", "tracking.url"];
// The Polish checks, listed under coverage because the fixture has no Polish
// stage.
const POLISH_NOT_RUN = ["media.oversize", "media.weight", "readability.contrast"];

async function startPage() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/landing/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(PAGE_HTML);
    }
    response.writeHead(404, { "content-type": "text/plain" });
    return response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/landing/`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// The real producer's row and verdict assertion for the readiness timeout.
async function realReadinessTimeout() {
  await installBrowserGuard();
  const { runBrowserChecks } = await import("./qa-browser.mjs");
  const page = await startPage();
  let assertions;
  const qcResults = [];
  try {
    const topologies = [{ funnel_id: "default", funnel_name: "Default", pages: [{ page_id: PAGE, page_type: "landing", order: 1, url: page.url }] }];
    // The page never signals readiness, so both loads wait out the readiness
    // bound: 8 s each in production, 1.5 s each here (the in-process
    // contentParamLimits).
    assertions = await runBrowserChecks(topologies, { "browser-timeout": 10_000 }, { spec: structuredClone(RUN_SPEC), qcResults, contentParamLimits: { readinessMs: 1_500 } });
  } finally {
    await page.close();
  }
  const rows = structuredClone(qcResults);
  const qcAssertions = structuredClone(assertions.filter((entry) => String(entry?.id || "").startsWith("qc.")));
  assert.deepEqual(rows.map((row) => row?.id), [ID], "the real producer's QC results are exactly the setup's row");
  assert.deepEqual(qcAssertions.map((entry) => [entry.id, entry.evidence?.qc?.result_id]), [[ASSERTION_ID, ID]], "the run's qc.* assertions are exactly the row's verdict assertion");
  const [row] = rows;
  assert.deepEqual(
    [row.subject, row.result, row.reason_code, row.accept_eligible, row.members],
    [SUBJECT, "unexercised", "readiness_timeout", false, []],
    "setup: the real row is unexercised / readiness_timeout",
  );
  return { rows, assertions: qcAssertions, measuredAt: new Date(Date.now() - 60_000).toISOString() };
}

// A browser launch, the page checks' own load and two loads that each wait the
// full readiness bound, then `next` twice: 120 s covers the worst case.
browserTest("F1.0-I3 [real: 1.2] integrity-valid hand-written accept on the real unexercised / readiness_timeout result: accept inert (target_not_warning)", { timeout: 120_000 }, async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const parts = await realReadinessTimeout();
  const f = campaignFixture({ mutateSpec: (spec) => { spec.analytics = { ...(spec.analytics || {}), params: { content: [{ name: NAME }] } }; } });
  t.after(f.cleanup);
  const { stage, verdict } = installQaStage(f, { rows: parts.rows, assertions: parts.assertions, measuredAt: parts.measuredAt });
  assert.deepEqual(verdict.assertions, parts.assertions, "setup: the full verdict holds exactly the real assertion");

  const rederivers = await loadQcRederivers();
  const read = () => resultsOf(readQaResults({ stageEvidence: stage.evidence, stage, fullVerdict: verdict, currentBuild: BUILD_FP, rederivers }));
  const results = read();
  assert.deepEqual(
    results.map((entry) => [entry.id, entry.subject, entry.leg, entry.result, entry.reason_code, entry.accept_eligible, entry.members, entry.state_fingerprint]),
    [[ID, SUBJECT, "qa", "unexercised", "readiness_timeout", false, [], parts.rows[0].state_fingerprint]],
    "the reader's QA results are exactly the real row, re-derived with the real module",
  );
  const [current] = results;
  assert.equal(stage.identity.verdict_run_id, QA_RUN_ID, "setup: the stage names the verdict run");

  const before = await runNext(f, {});
  const unsigned = handAccept(current, { measuredSource: "qa_full_verdict" });
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  appendAccept(f, record);
  assert.deepEqual(readJson(f.reportPath).qc_accepts, [record], "setup: exactly the hand-written accept is on record");

  assert.deepEqual(
    assessQcAccepts([record], read(), { now: new Date().toISOString() }).map(({ status, why }) => [status, why]),
    [["inert", "target_not_warning"]],
    "the accept is inert (target_not_warning)",
  );

  // The whole handoff, every leg: nothing open, in review, lapsed or
  // accepted, the accept listed as inert, the coverage of every leg, and no
  // accept command.
  const afterNext = await runNext(f, {});
  assert.deepEqual(
    handoffOf(afterNext),
    {
      open: [],
      review: [],
      lapsed: [],
      coverage: [
        ...POLISH_NOT_RUN.map((check) => ({ check, leg: "polish", result: "unexercised", reason_code: "leg_not_run", count: 0, pages: [] })),
        { check: "content_param", leg: "qa", result: "unexercised", reason_code: "readiness_timeout", count: 1, pages: [PAGE] },
        ...NOT_CAPTURED.map((check) => ({ check, leg: "qa", result: "unexercised", reason_code: "not_captured_by_this_version", count: 0, pages: [] })),
      ],
      accepted: [],
      inert_accepts: [{ result_id: ID, why: "target_not_warning" }],
      accept_command: null,
    },
    "qc_handoff is exactly the inert accept and the coverage of every leg",
  );
  assert.equal(afterNext.status, before.status, "next status is identical before and after the inert accept");
});
