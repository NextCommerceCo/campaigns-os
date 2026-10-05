// The shared QC row whose 1.4 observation was a stand-in, re-run end to end
// with the real 1.4 producer. The QA rows and their verdict assertions come
// from a real `runBrowserChecks` run on a loopback stub page that links the
// configured store_terms URL (a loopback policy page answering 200
// text/html), so the run yields a presence pass and an availability pass.
// The availability row's observation is then given an outcome outside the
// vocabulary ("maybe") in both the row and its paired assertion, and the
// reader and `next` re-derive both rows through the registry's real module:
// no qcStandIns is passed anywhere in this file.
//
// API assumptions: as in src/qa-policy-links.browser.test.mjs
// (runBrowserChecks takes options.spec and pushes its policy rows, and
// nothing else for a spec without content parameters, into
// options.qcResults, returning each row's browser-runtime assertion under
// qc.<check>:<field>; row ids <check>:campaign:<field>; an availability
// observation carries availability.outcome, "pass" on a pass; no members).
// The availability probes use the global fetch. Coverage follows the rules in
// src/qa-policy-links.test.mjs: one page read of one expected and one
// answered probe, so both real rows carry {observed: 1, expected: 1, limits:
// []}; the reader's unreproducible row carries {observed: 0, expected: null,
// limits: ["evidence_not_reproducible"]}. The policy page sends its headers,
// then a slow body; the probe reads headers only, so its connection closes
// within 1 s of the headers, before the body ends.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test. The fixture
// module imports only node builtins; its guard covers every raw TCP or TLS
// socket connect and WebSocket. The factory, imported after it, installs its
// stricter fetch and http(s) guard (it refuses loopback too) before it loads
// any module under test. Node's own fetch is kept first: the real run's
// availability probes go through a loopback-only wrapper of it, installed as
// the global fetch for that run only, and the factory's guard is put back
// right after.
import { assertLoopbackOnly, chromiumAvailable, installBrowserGuard, installNodeGuard, isLoopbackUrl } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
const nodeFetch = globalThis.fetch;
const {
  BUILD_FP,
  QA_RUN_ID,
  assertNoNetworkAttempts,
  campaignFixture,
  handoffOf,
  installQaStage,
  resultsOf,
  runNext,
} = await import("./qc-test-factories.mjs");

const refusedProbes = [];
afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
  assert.deepEqual(refusedProbes.splice(0), [], "the run's fetch was never asked for a non-loopback URL");
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; 1.4 re-run rows skipped (run `npm run qa:install-browser`)", () => {});
}

const FIELD = "store_terms";
const PRESENCE_ID = "policy.presence:campaign:store_terms";
const AVAILABILITY_ID = "policy.availability:campaign:store_terms";
const SUBJECTS = Object.freeze({
  [AVAILABILITY_ID]: { check: "policy.availability", page: "campaign", key: FIELD },
  [PRESENCE_ID]: { check: "policy.presence", page: "campaign", key: FIELD },
});
const ASSERTION_IDS = Object.freeze({ [AVAILABILITY_ID]: "qc.policy.availability:store_terms", [PRESENCE_ID]: "qc.policy.presence:store_terms" });
const E = "evidence_not_reproducible";
// The availability outcomes the contract names (§1.4 Result rules), and pass.
const OUTCOMES = Object.freeze(["pass", "not_found", "server_error", "redirected_to_root", "redirected_elsewhere", "redirect_loop", "redirect_limit", "auth_required", "rate_limited", "non_html_response", "unexpected_status", "configured_url_invalid", "network_unavailable", "non_http_destination", "browser_checks_not_requested"]);
// The QA checks of the fixture's spec that hold no row in this QA stage, each
// listed under coverage as not captured, and the Polish checks, listed
// because the fixture has no Polish stage.
const NOT_CAPTURED = ["tracking.order", "tracking.tag", "tracking.url"];
const POLISH_NOT_RUN = ["media.oversize", "media.weight"];
const PAGE_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Synthetic campaign</title></head><body><main><h1>Synthetic campaign</h1></main><footer><a href=\"/policy/terms\">Synthetic footer link</a></footer></body></html>";
const POLICY_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Synthetic policy</title></head><body><p>Synthetic policy page.</p></body></html>";
const BODY_CHUNK = Buffer.alloc(16 * 1024, " ");
const BODY_CHUNKS = 64;
const BODY_EVERY_MS = 40;
const CLOSE_WITHIN_MS = 1_000;
const ONE_OF_ONE = Object.freeze({ observed: 1, expected: 1, limits: [] });
const UNREPRODUCED = Object.freeze({ observed: 0, expected: null, limits: [E] });

// How a connection ended, or { finished: null, afterMs: Infinity } while it is
// still open 2 s on (a probe that neither reads nor cancels a body never lets
// the server finish sending it).
async function endOf(closed) {
  let timer;
  const open = new Promise((resolve) => { timer = setTimeout(() => resolve({ finished: null, afterMs: Infinity }), 2_000); });
  try {
    return await Promise.race([closed, open]);
  } finally {
    clearTimeout(timer);
  }
}

// The policy page sends its headers at once, then 64 chunks of 16 KiB, one
// every 40 ms; `ends` gets a promise of how each such connection ended
// ({ finished, afterMs }).
async function startStub() {
  const log = [];
  const ends = [];
  const drips = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    log.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/landing/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(PAGE_HTML);
    }
    if (url.pathname === "/policy/terms") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.flushHeaders();
      const headersAt = performance.now();
      let sent = 0;
      const drip = setInterval(() => {
        if (sent === BODY_CHUNKS) {
          clearInterval(drip);
          response.end();
          return;
        }
        response.write(sent === 0 ? Buffer.concat([Buffer.from(POLICY_HTML), BODY_CHUNK]) : BODY_CHUNK);
        sent += 1;
      }, BODY_EVERY_MS);
      drips.add(drip);
      ends.push(new Promise((resolve) => response.once("close", () => {
        clearInterval(drip);
        drips.delete(drip);
        resolve({ finished: response.writableFinished, afterMs: performance.now() - headersAt });
      })));
      return undefined;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    return response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    log,
    ends,
    close: () => new Promise((resolve) => {
      for (const drip of drips) clearInterval(drip);
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function loopbackFetch(input, init) {
  const url = String(input instanceof Request ? input.url : input);
  if (!isLoopbackUrl(url)) {
    refusedProbes.push(url);
    return Promise.reject(new TypeError(`policy link re-run: non-loopback request refused (${url})`));
  }
  return nodeFetch(input, init);
}

// The real producer's rows and verdict assertions: a presence pass and an
// availability pass for store_terms.
async function realPolicyRows() {
  await installBrowserGuard();
  const { runBrowserChecks } = await import("./qa-browser.mjs");
  const stub = await startStub();
  const guardedFetch = globalThis.fetch;
  let assertions;
  let probeEnds = [];
  const qcResults = [];
  try {
    const topologies = [{ funnel_id: "default", funnel_name: "Default", pages: [{ page_id: "landing", page_type: "landing", order: 1, url: `${stub.base}/landing/` }] }];
    globalThis.fetch = loopbackFetch;
    assertions = await runBrowserChecks(topologies, { "browser-timeout": 10_000 }, { spec: { campaign: { [FIELD]: `${stub.base}/policy/terms` } }, qcResults });
  } finally {
    globalThis.fetch = guardedFetch;
    probeEnds = await Promise.all(stub.ends.map(endOf));
    await stub.close();
  }
  assert.deepEqual(stub.log.filter((line) => line.includes("/policy/")), ["GET /policy/terms"], "setup: the run probed the configured URL once");
  assert.deepEqual(
    probeEnds.map(({ finished, afterMs }) => [finished, afterMs <= CLOSE_WITHIN_MS]),
    [[false, true]],
    `setup: the probe read headers only, its connection closed within ${CLOSE_WITHIN_MS} ms of its headers, before its body ended (${probeEnds.map(({ afterMs }) => Math.round(afterMs)).join(", ")} ms)`,
  );
  const rows = structuredClone(qcResults);
  const qcAssertions = structuredClone(assertions.filter((entry) => String(entry?.id || "").startsWith("qc.")));
  assert.deepEqual(rows.map((row) => row?.id).sort(), [AVAILABILITY_ID, PRESENCE_ID], "the real producer's QC results are exactly the setup's two rows");
  assert.deepEqual(
    qcAssertions.map((entry) => [entry.evidence?.qc?.result_id, entry.id]).sort(),
    [[AVAILABILITY_ID, ASSERTION_IDS[AVAILABILITY_ID]], [PRESENCE_ID, ASSERTION_IDS[PRESENCE_ID]]],
    "the run's qc.* assertions are exactly the rows' verdict assertions",
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.subject, row.result, row.reason_code, row.accept_eligible, row.members, row.coverage]).sort(),
    [[AVAILABILITY_ID, SUBJECTS[AVAILABILITY_ID], "pass", null, false, [], { ...ONE_OF_ONE }], [PRESENCE_ID, SUBJECTS[PRESENCE_ID], "pass", null, false, [], { ...ONE_OF_ONE }]],
    "setup: the real rows are a presence pass and an availability pass, each with coverage {1, 1, []}",
  );
  return { rows, assertions: qcAssertions, measuredAt: new Date(Date.now() - 60_000).toISOString() };
}

// A browser launch, one page load (up to the 10 s browser timeout plus its
// 5 s settle), one availability probe (at most 15 s), then `next` twice:
// 120 s covers the worst case.
browserTest("F1.0-I11 [real: 1.4] a real 1.4 availability observation whose outcome is \"maybe\": result unexercised (evidence_not_reproducible)", { timeout: 120_000 }, async (t) => {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const parts = await realPolicyRows();
  const real = parts.rows.find((row) => row.id === AVAILABILITY_ID);
  assert.equal(real.observation?.availability?.outcome, "pass", "setup: the real availability observation records outcome pass");

  // The same real rows with the availability outcome set to "maybe" in the
  // row and in its paired assertion, so they still pair on one observation.
  const tampered = structuredClone(parts);
  const row = tampered.rows.find((entry) => entry.id === AVAILABILITY_ID);
  row.observation.availability.outcome = "maybe";
  const paired = tampered.assertions.find((entry) => entry.evidence.qc.result_id === AVAILABILITY_ID);
  paired.evidence.qc.observation = structuredClone(row.observation);
  assert.equal(OUTCOMES.includes("maybe"), false, "setup: \"maybe\" is outside the availability outcome vocabulary");
  assert.deepEqual(paired.evidence.qc.observation, row.observation, "setup: row and assertion still pair on the same observation");

  const rederivers = await loadQcRederivers();
  const project = (entry) => [entry.id, entry.subject, entry.leg, entry.result, entry.reason_code, entry.accept_eligible, entry.members, entry.coverage];
  const readOf = ({ rows, assertions, measuredAt }) => resultsOf(readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: { schema_version: "1.0", run_id: QA_RUN_ID, started_at: measuredAt, completed_at: measuredAt, runtime: installed.verdict.runtime, assertions },
    currentBuild: BUILD_FP,
    rederivers,
  })).map(project).sort();

  const f = campaignFixture();
  t.after(f.cleanup);
  // Control: the untampered real rows read as produced.
  const installed = installQaStage(f, { rows: parts.rows, assertions: parts.assertions, measuredAt: parts.measuredAt });
  assert.deepEqual(
    readOf(parts),
    [[AVAILABILITY_ID, SUBJECTS[AVAILABILITY_ID], "qa", "pass", null, false, [], { ...ONE_OF_ONE }], [PRESENCE_ID, SUBJECTS[PRESENCE_ID], "qa", "pass", null, false, [], { ...ONE_OF_ONE }]],
    "control: the untampered real rows re-derive as a presence pass and an availability pass, each with coverage {1, 1, []}",
  );
  const before = await runNext(f, {});
  const coverageOthers = [
    ...POLISH_NOT_RUN.map((check) => ({ check, leg: "polish", result: "unexercised", reason_code: "leg_not_run", count: 0, pages: [] })),
    ...NOT_CAPTURED.map((check) => ({ check, leg: "qa", result: "unexercised", reason_code: "not_captured_by_this_version", count: 0, pages: [] })),
  ];
  assert.deepEqual(
    handoffOf(before),
    { open: [], review: [], lapsed: [], coverage: coverageOthers, accepted: [], inert_accepts: [], accept_command: null },
    "control: qc_handoff lists nothing for the passing policy rows",
  );

  // The tampered observation: the availability row reads unexercised /
  // evidence_not_reproducible; the presence row is untouched.
  assert.deepEqual(
    readOf(tampered),
    [[AVAILABILITY_ID, SUBJECTS[AVAILABILITY_ID], "qa", "unexercised", E, false, [], { ...UNREPRODUCED }], [PRESENCE_ID, SUBJECTS[PRESENCE_ID], "qa", "pass", null, false, [], { ...ONE_OF_ONE }]],
    "the reader's QA results are exactly the two real rows, the tampered one unexercised (evidence_not_reproducible) with coverage {0, null, [evidence_not_reproducible]}",
  );
  installQaStage(f, { rows: tampered.rows, assertions: tampered.assertions, measuredAt: tampered.measuredAt });
  const afterNext = await runNext(f, {});
  assert.deepEqual(
    handoffOf(afterNext),
    {
      open: [],
      review: [],
      lapsed: [],
      coverage: [
        ...coverageOthers.slice(0, POLISH_NOT_RUN.length),
        { check: "policy.availability", leg: "qa", result: "unexercised", reason_code: E, count: 1, pages: ["campaign"] },
        ...coverageOthers.slice(POLISH_NOT_RUN.length),
      ],
      accepted: [],
      inert_accepts: [],
      accept_command: null,
    },
    "qc_handoff lists exactly the unreproducible availability row under coverage, beside every leg's coverage",
  );
  assert.equal(afterNext.status, before.status, "next status is identical with the real and the tampered observation");
});
