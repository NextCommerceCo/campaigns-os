// The shared QC rows whose QA producer was a stand-in, re-run end to end with the
// real 1.1 producer. The QA rows and verdict assertions come from real
// `runBrowserTestOrders` runs on a loopback stub campaign
// (src/qa-tracking-params-fixtures.mjs), and every reader, `next` and
// `checkpoint accept` re-derives them through the registry's real module:
// no qcStandIns.qa is passed anywhere in this file. The doctor half of
// F1.0-W2 keeps its 1.5 stand-in (that producer is stream C's).
//
// The real rows: one run whose bridge -> checkout document hop drops
// utm_medium (tracking.url warning url_param_dropped, accept-eligible), with
// the order row and the declared syn_tag row passing; and, for F1.0-B10, a
// second run of the same run id with nothing dropped (every row pass).
//
// API assumptions: as in src/qa-tracking-params-fixtures.mjs (qc_results on
// the runBrowserTestOrders result; the literal ids and subjects
// tracking.url:checkout:url, tracking.order:checkout:order,
// tracking.tag:checkout:tag:syn_tag; members keyed by URL parameter or
// credited field, tag rows without members; coverage.sources_observed on the
// order row).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, afterEach } from "node:test";

// The shared test factory (no-network guard for node) before any module under test.
import {
  BUILD_FP,
  OPERATOR,
  OTHER_BUILD_FP,
  QA_RUN_ID,
  assertAccepted as assertAcceptCommand,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  countReportWrites,
  delay,
  doctorOf,
  fullVerdict,
  handoffOf,
  installQaStage,
  liveTokenId,
  liveTokenStandIn,
  readBytes,
  readJson,
  refOf,
  resultsOf,
  runAccept,
  runNext,
  setBuiltPage,
  snapshot,
} from "./qc-test-factories.mjs";
import {
  ALL_SOURCES,
  DEFAULT_URL_KEYS,
  EXCLUDED_BY_POLICY,
  ORDER_ID,
  SEEDED_ORDER_FIELDS,
  SUBJECTS,
  TAG_ID,
  URL_ID,
  assertExactMembers,
  assertLoopbackOnly,
  assertSourcesObserved,
  chromiumAvailable,
  installNodeGuard,
  members,
  orderAssertion,
  runTrackingScenario,
  sharedRun,
} from "./qa-tracking-params-fixtures.mjs";
import { QA_SCHEMA_VERSION } from "./qa-verdict.mjs";

// The factory keeps its stricter fetch and http(s) guard; this adds the
// socket and WebSocket guards beneath it.
installNodeGuard({ transports: false });

afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(() => assertNoNetworkAttempts());

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; 1.1 U5 re-run rows skipped (run `npm run qa:install-browser`)", () => {});
}

const T = { timeout: 300000 };
const E = "evidence_not_reproducible";
const RUN_ID = "qa-tracking-u5";
const TAG = [{ name: "syn_tag", value: "syn_v" }];
const SETUP_IDS = [URL_ID, ORDER_ID, TAG_ID];
// The real producer's members per setup: the warning run drops utm_medium on
// the bridge -> checkout document hop; the pass run drops nothing.
const ORDER_PASS_MEMBERS = Object.freeze({ ...members(SEEDED_ORDER_FIELDS, "pass", null), ...EXCLUDED_BY_POLICY });
const WARNING_MEMBERS = Object.freeze({
  [URL_ID]: { ...members(DEFAULT_URL_KEYS, "pass", null), utm_medium: ["warning", "url_param_dropped"] },
  [ORDER_ID]: ORDER_PASS_MEMBERS,
  [TAG_ID]: {},
});
const PASS_MEMBERS = Object.freeze({
  [URL_ID]: members(DEFAULT_URL_KEYS, "pass", null),
  [ORDER_ID]: ORDER_PASS_MEMBERS,
  [TAG_ID]: {},
});
const CHECKS = ["tracking.url", "tracking.order", "tracking.tag"];
const PACKAGE_RUNTIME = `campaigns-os-node-qa@${readJson(new URL("../package.json", import.meta.url)).version}`;

// One real run per setup, shared by the rows of this file.
const warningRun = () => sharedRun("u5-warning", () => runTrackingScenario("u5-warning", { tags: TAG, bridge: { drop: ["utm_medium"] } }, { runId: RUN_ID }));
const passRun = () => sharedRun("u5-pass", () => runTrackingScenario("u5-pass", { tags: TAG }, { runId: RUN_ID }));

// The real producer's rows and verdict assertions, after the seed-independent
// setup facts and the module load.
async function realParts(run = warningRun, expectedMembers = WARNING_MEMBERS) {
  const { result, log } = await run();
  assert.equal(log.creates.length, 1, "setup: one order create was posted");
  assert.equal(orderAssertion(result).status, "pass", "setup: the order was accepted and read back");
  await import("./qa-tracking-params.mjs");
  assert.ok(Array.isArray(result.qc_results), "the real producer returns qc_results[]");
  const rows = structuredClone(result.qc_results.filter((row) => String(row?.check || "").startsWith("tracking.")));
  const qcAssertions = structuredClone(result.assertions.filter((entry) => String(entry?.id || "").startsWith("qc.tracking.")));
  assert.deepEqual(rows.map((row) => row.id).sort(), [...SETUP_IDS].sort(), "the real producer emitted exactly the setup's rows");
  assert.deepEqual(qcAssertions.map((entry) => entry.evidence?.qc?.result_id).sort(), [...SETUP_IDS].sort(), "one verdict assertion per row");
  for (const id of SETUP_IDS) {
    const row = rows.find((candidate) => candidate.id === id);
    assert.deepEqual(row.subject, SUBJECTS[id], `${id} subject`);
    assertExactMembers(row, expectedMembers[id]);
  }
  assertSourcesObserved(rows.find((row) => row.id === ORDER_ID), ALL_SOURCES);
  return { rows, assertions: qcAssertions, measuredAt: new Date(Date.now() - 60_000).toISOString() };
}

const rowById = (rows, id) => rows.find((row) => row.id === id);

async function readReal({ rows, assertions, measuredAt, qcBuildFingerprint = BUILD_FP, verdict = fullVerdict({ assertions, measuredAt }) }) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const stage = { identity: { verdict_run_id: QA_RUN_ID } };
  const results = resultsOf(readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: qcBuildFingerprint },
    stage,
    fullVerdict: verdict,
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  }));
  assert.ok(Array.isArray(results), "readQaResults returns the read rows");
  assert.deepEqual(results.map((row) => row.id).sort(), [...SETUP_IDS].sort(), "the reader lists exactly the setup's result ids");
  return results;
}

function assertRead(results, id, result, reasonCode) {
  const matches = results.filter((row) => row.id === id);
  assert.equal(matches.length, 1, `the reader lists ${id} exactly once`);
  assert.equal(matches[0].result, result, `${id} reads ${result}`);
  assert.equal(matches[0].reason_code, reasonCode, `${id} reads reason ${reasonCode}`);
}

function openEntry(handoff, id) {
  const entry = (handoff.open || []).find((candidate) => String(candidate.result_ref).startsWith(`${id}@`));
  assert.ok(entry, `qc_handoff.open lists ${id}: ${JSON.stringify(handoff.open)}`);
  return entry;
}

function assertAcceptedListed(handoff, ref) {
  assert.ok(
    (handoff.accepted || []).some((entry) => entry.result_ref === ref && entry.accepted_by === OPERATOR),
    `qc_handoff.accepted lists ${ref} accepted by ${OPERATOR}: ${JSON.stringify(handoff.accepted)}`,
  );
}

function fixtureWith(t, parts, install = {}) {
  const f = campaignFixture();
  t.after(f.cleanup);
  const installed = installQaStage(f, { rows: parts.rows, assertions: parts.assertions, measuredAt: parts.measuredAt, ...install });
  return { f, installed };
}

// ---------------------------------------------------------------------------

browserTest("F1.0-W2 [real: 1.1] doctor (1.5 stand-in) and real QA tracking.url warnings accepted in one command: both accepts active; one report write", T, async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const parts = await realParts();
  assert.equal(rowById(parts.rows, URL_ID).result, "warning", "setup: the real tracking.url row is a warning");
  const { f } = fixtureWith(t, parts);
  setBuiltPage(f, "<p class=\"cart-line\">{item.name}</p>");
  const qcStandIns = { doctor: [liveTokenStandIn(f)] };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const doctorRef = openEntry(handoff, liveTokenId("{item.name}")).result_ref;
  const qaRef = openEntry(handoff, URL_ID).result_ref;
  await delay(5);
  const { value: res, count } = await countReportWrites(f, () => runAccept(f, [doctorRef, qaRef], { qcStandIns }));
  assertAcceptCommand(res);
  assert.equal(count, 1, "exactly one Assembly Report write");
  const records = readJson(f.reportPath).qc_accepts;
  assert.equal(records.length, 2);
  const afterHandoff = handoffOf(await runNext(f, qcStandIns));
  assertAcceptedListed(afterHandoff, doctorRef);
  assertAcceptedListed(afterHandoff, qaRef);
  const doctorResults = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const report = readJson(f.reportPath);
  const qaResults = await readReal({ rows: report.stages.qa.evidence.qc_results, assertions: parts.assertions, measuredAt: parts.measuredAt, verdict: readJson(resolve(f.targetRepo, report.stages.qa.outputs[0])) });
  const assessed = assessQcAccepts(records, [...doctorResults, ...qaResults], { now: new Date().toISOString() });
  assert.deepEqual(assessed.map((entry) => entry.status), ["active", "active"]);
});

browserTest("F1.0-W3 [real: 1.1] doctor has no warnings, one real QA tracking.url warning: next status identical before and after the accept", T, async (t) => {
  const parts = await realParts();
  const { f } = fixtureWith(t, parts);
  assert.deepEqual(doctorOf(f.packetPath, {}).warnings, [], "doctor has no warnings");
  const before = await runNext(f, {});
  const entry = openEntry(handoffOf(before), URL_ID);
  assert.equal(entry.reason_code, "url_param_dropped");
  await delay(5);
  assertAcceptCommand(await runAccept(f, [entry.result_ref], {}));
  const afterNext = await runNext(f, {});
  assertAcceptedListed(handoffOf(afterNext), entry.result_ref);
  assert.equal(afterNext.status, before.status, "next status is identical before and after the accept");
});

browserTest("F1.0-B6 [real: 1.1] the real tracking.url row hand-edited from warning to pass, observation unchanged: result unexercised (evidence_not_reproducible)", T, async () => {
  const parts = await realParts();
  const row = rowById(parts.rows, URL_ID);
  assert.equal(row.result, "warning", "setup: the measured row was a warning");
  const observation = structuredClone(row.observation);
  row.result = "pass";
  row.reason_code = null;
  assert.deepEqual(row.observation, observation, "setup: the observation is unchanged");
  const results = await readReal(parts);
  assertRead(results, URL_ID, "unexercised", E);
  assertRead(results, ORDER_ID, "pass", null);
  assertRead(results, TAG_ID, "pass", null);
});

// Residual row (tamper evidence): the documented outcome is asserted, not detection.
browserTest("F1.0-B10 [real: 1.1] the real tracking.url row and its qc.* assertion both rewritten consistently to a pass observation, run_id/schema/runtime kept: result reads pass (A1 accepted behaviour)", T, async () => {
  const parts = await realParts();
  const passing = await realParts(passRun, PASS_MEMBERS);
  const original = rowById(parts.rows, URL_ID);
  const rewritten = rowById(passing.rows, URL_ID);
  assert.equal(original.result, "warning", "setup: the measured row was a warning");
  assert.equal(rewritten.result, "pass", "setup: the replacement row reads pass");
  assert.notDeepEqual(rewritten.observation, original.observation, "setup: the observation was rewritten");
  parts.rows = parts.rows.map((row) => (row.id === URL_ID ? rewritten : row));
  parts.assertions = parts.assertions.map((entry) => (entry.evidence.qc.result_id === URL_ID ? passing.assertions.find((candidate) => candidate.evidence.qc.result_id === URL_ID) : entry));
  const verdict = fullVerdict({ assertions: parts.assertions, measuredAt: parts.measuredAt });
  assert.deepEqual([verdict.run_id, verdict.schema_version, verdict.runtime], [QA_RUN_ID, QA_SCHEMA_VERSION, PACKAGE_RUNTIME], "setup: run_id, schema and runtime are kept");
  const results = await readReal({ ...parts, verdict });
  assertRead(results, URL_ID, "pass", null);
  assertRead(results, ORDER_ID, "pass", null);
  assertRead(results, TAG_ID, "pass", null);
});

browserTest("F1.0-I5 [real: 1.1] real QA warning with only the committed sidecar, full verdict absent: result unexercised, so checkpoint accept refuses it (evidence_not_reproducible)", T, async (t) => {
  const parts = await realParts();
  const { f, installed } = fixtureWith(t, parts);
  rmSync(installed.verdictPath);
  assert.ok(readBytes(f.qaSidecarPath), "setup: the committed sidecar is present");
  assert.equal(readBytes(installed.verdictPath), null, "setup: the full verdict is absent");
  const report = readJson(f.reportPath);
  const results = await readReal({ ...parts, rows: report.stages.qa.evidence.qc_results, verdict: null });
  for (const id of SETUP_IDS) assertRead(results, id, "unexercised", E);
  const handoff = handoffOf(await runNext(f, {}));
  const listed = [...(handoff.open || []), ...(handoff.review || [])].filter((entry) => entry.leg === "qa");
  assert.deepEqual(listed, [], "no QA row is open or in review");
  const coverage = (handoff.coverage || [])
    .filter((entry) => entry.leg === "qa" && CHECKS.includes(entry.check))
    .map((entry) => [entry.check, entry.result, entry.reason_code, entry.count, entry.pages])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(coverage, [
    ["tracking.order", "unexercised", E, 1, ["checkout"]],
    ["tracking.tag", "unexercised", E, 1, ["checkout"]],
    ["tracking.url", "unexercised", E, 1, ["checkout"]],
  ], `coverage lists each 1.1 check of the setup as unexercised / evidence_not_reproducible: ${JSON.stringify(handoff.coverage)}`);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(rowById(parts.rows, URL_ID))], {}), "target_not_warning");
  assertNothingWritten(f, before);
});

browserTest("F1.0-I12 [real: 1.1] real QA results whose qc_build_fingerprint differs from the current build: results unexercised (stale_binding)", T, async () => {
  const parts = await realParts();
  const results = await readReal({ ...parts, qcBuildFingerprint: OTHER_BUILD_FP });
  for (const id of SETUP_IDS) assertRead(results, id, "unexercised", "stale_binding");
});

browserTest("F1.0-I13 [real: 1.1] real QA stage evidence with qc_build_fingerprint null: results unexercised (stale_binding)", T, async () => {
  const parts = await realParts();
  const results = await readReal({ ...parts, qcBuildFingerprint: null });
  for (const id of SETUP_IDS) assertRead(results, id, "unexercised", "stale_binding");
});
