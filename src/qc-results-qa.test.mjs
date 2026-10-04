// F1.0 frozen fixture rows for the QA reader site and the QA side of the QC
// handoff (contract §1.0 Reader sites "QA qc_results", silence rule).
//
// Stand-in override shape (freeze addendum U5), passed in-process only:
//   readQaResults({ stageEvidence, stage, fullVerdict, currentBuild, qcStandIns })
//   and main(argv, { qcStandIns }), with qcStandIns.qa = { "<check id>": (observation) => Derived | null }
//   (synthetic QA re-deriver; see src/qc-test-factories.mjs).
//
// API assumption (per-row reads): readQaResults accepts the parsed full verdict
// as `fullVerdict` and the QA stage record as `stage` (for identity.verdict_run_id)
// beside `stageEvidence`, and returns the read rows (an array, or { results }).
import assert from "node:assert/strict";
import { lstatSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

// The factory (no-network guard) is imported before any module under test.
import {
  BUILD_FP,
  OTHER_BUILD_FP,
  QA_RUN_ID,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  delay,
  fullVerdict,
  handoffOf,
  installQaStage,
  qaAssertionFor,
  qaObservation,
  qaRederive,
  qaRowFor,
  qaStandIns,
  readBytes,
  readJson,
  refOf,
  resultsOf,
  runAccept,
  runCli,
  runNext,
  snapshot,
  writeJson,
} from "./qc-test-factories.mjs";
import { QA_SCHEMA_VERSION } from "./qa-verdict.mjs";

// No network: any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const WARN_ID = "policy.availability:campaign:store_terms";
const PASS_ID = "policy.presence:campaign:store_privacy";
const SETUP_IDS = [WARN_ID, PASS_ID];
const E = "evidence_not_reproducible";
const PACKAGE_RUNTIME = `campaigns-os-node-qa@${readJson(new URL("../package.json", import.meta.url)).version}`;

// Two rows: the warning row under test and an untouched pass row.
function qaParts() {
  const measuredAt = new Date(Date.now() - 60_000).toISOString();
  const observations = [
    qaObservation({ check: "policy.availability", key: "store_terms", outcome: "unreachable" }),
    qaObservation({ check: "policy.presence", key: "store_privacy", outcome: "reachable" }),
  ];
  const rows = observations.map((observation) => qaRowFor(observation, { measured_at: measuredAt }));
  const assertions = rows.map((row) => qaAssertionFor(row));
  return { rows, assertions, measuredAt };
}

function qaStage(rows, { qcBuildFingerprint = BUILD_FP } = {}) {
  return {
    stage: "qa",
    status: "completed",
    outputs: [],
    identity: { verdict_run_id: QA_RUN_ID },
    evidence: { qc_results: rows, qc_build_fingerprint: qcBuildFingerprint },
  };
}

async function readQa({ rows, assertions, measuredAt, stage = qaStage(rows), verdict = fullVerdict({ assertions, measuredAt }), currentBuild = BUILD_FP }) {
  const { readQaResults } = await import("./qc-results.mjs");
  const results = resultsOf(readQaResults({ stageEvidence: stage.evidence, stage, fullVerdict: verdict, currentBuild, qcStandIns: { qa: qaStandIns() } }));
  assert.ok(Array.isArray(results), "readQaResults returns the read rows");
  return results;
}

function resultFor(results, id) {
  const matches = results.filter((candidate) => candidate.id === id);
  assert.equal(matches.length, 1, `the reader lists ${id} exactly once`);
  return matches[0];
}

function assertRow(results, id, result, reasonCode) {
  const row = resultFor(results, id);
  assert.equal(row.result, result, `${id} reads ${result}`);
  assert.equal(row.reason_code, reasonCode, `${id} reads reason ${reasonCode}`);
}

// The reader lists exactly these result ids: none omitted, none extra.
function assertIds(results, ids) {
  assert.deepEqual(results.map((row) => row.id).sort(), [...ids].sort(), "the reader lists exactly the setup's result ids");
}

// The untouched row still reads its own re-derived result.
const assertControlPass = (results) => assertRow(results, PASS_ID, "pass", null);

// Verdict-level failure through the reader: every setup row, by id, reads
// unexercised / evidence_not_reproducible.
function assertEveryResultNotReproducible(results) {
  assertIds(results, SETUP_IDS);
  for (const id of SETUP_IDS) assertRow(results, id, "unexercised", E);
}

// Verdict-level failure through `next`: no QA row is open or in review, and
// the coverage lists each of the setup's QA checks, one entry per check, as
// unexercised / evidence_not_reproducible with count 1 on page "campaign".
// API assumption: a coverage entry groups one check × result × reason_code;
// `count` is its number of results and `pages` their subject pages.
function assertEveryQaRowNotReproducible(handoff) {
  const listed = [...(handoff.open || []), ...(handoff.review || [])].filter((entry) => entry.leg === "qa");
  assert.deepEqual(listed, [], "no QA row is open or in review");
  const setupChecks = ["policy.availability", "policy.presence"];
  const coverage = (handoff.coverage || [])
    .filter((entry) => entry.leg === "qa" && setupChecks.includes(entry.check))
    .map((entry) => [entry.check, entry.result, entry.reason_code, entry.count, entry.pages])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(
    coverage,
    [
      ["policy.availability", "unexercised", E, 1, ["campaign"]],
      ["policy.presence", "unexercised", E, 1, ["campaign"]],
    ],
    `coverage lists each QA check of the setup as unexercised / evidence_not_reproducible: ${JSON.stringify(handoff.coverage)}`,
  );
}

function cliSetup(t, options = {}) {
  const f = campaignFixture(options.fixture);
  t.after(f.cleanup);
  const parts = qaParts();
  const installed = installQaStage(f, { rows: parts.rows, assertions: parts.assertions, measuredAt: parts.measuredAt, ...(options.install || {}) });
  return { f, ...parts, installed, qcStandIns: { qa: qaStandIns() } };
}

// The reader run over what cliSetup wrote to disk.
async function readInstalled(f, installed, { fullVerdict: verdict } = {}) {
  const report = readJson(f.reportPath);
  return readQa({
    rows: report.stages.qa.evidence.qc_results,
    stage: report.stages.qa,
    verdict: verdict === undefined ? readJson(installed.verdictPath) : verdict,
  });
}

// ---------------------------------------------------------------------------
// Broken rows

test("F1.0-B6 [stand-in: QA policy.availability] qc_results[i].result hand-edited from warning to pass, observation unchanged: result unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  parts.rows[0] = { ...parts.rows[0], result: "pass" };
  assert.equal(parts.rows[0].result, "pass", "setup: the stored row reads pass");
  assert.equal(qaRederive(parts.rows[0].observation).result, "warning", "setup: its unchanged observation re-derives warning");
  assert.deepEqual(parts.assertions[0].evidence.qc.observation, parts.rows[0].observation, "setup: the paired assertion's observation is unchanged");
  const results = await readQa(parts);
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", E);
  assertControlPass(results);
});

// Residual row (amendments A1): the documented outcome is asserted, not detection.
test("F1.0-B10 [stand-in: QA policy.availability] row and matching qc.* assertion both rewritten to a pass observation, run_id/schema/runtime kept: result reads pass (A1 accepted behaviour)", async () => {
  const parts = qaParts();
  const original = parts.rows[0];
  const rewritten = qaRowFor({ ...original.observation, outcome: "reachable" }, { measured_at: parts.measuredAt });
  parts.rows[0] = rewritten;
  parts.assertions[0] = qaAssertionFor(rewritten);
  assert.notDeepEqual(rewritten.observation, original.observation, "setup: the row's observation was rewritten");
  assert.equal(original.result, "warning", "setup: the measured row was a warning");
  assert.equal(rewritten.result, "pass", "setup: the rewritten row reads pass");
  assert.deepEqual(parts.assertions[0].evidence.qc.observation, rewritten.observation, "setup: the matching assertion carries the same rewritten observation");
  const verdict = fullVerdict({ assertions: parts.assertions, measuredAt: parts.measuredAt });
  assert.deepEqual([verdict.run_id, verdict.schema_version, verdict.runtime], [QA_RUN_ID, QA_SCHEMA_VERSION, PACKAGE_RUNTIME], "setup: run_id, schema and runtime are kept");
  const results = await readQa({ ...parts, verdict });
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "pass", null);
  assertControlPass(results);
});

test("F1.0-B15 [stand-in: QA policy.availability] qa promote --verdict of a hand-written all-pass verdict: QC handoff unchanged", async (t) => {
  const { f, rows, measuredAt, qcStandIns } = cliSetup(t);
  const before = handoffOf(await runNext(f, qcStandIns));
  assert.ok((before.open || []).some((entry) => String(entry.result_ref).startsWith(`${WARN_ID}@`)), "the QA warning is open before the promote");
  const passing = rows.map((row) => qaRowFor({ ...row.observation, outcome: "reachable" }, { measured_at: measuredAt }));
  const handWritten = join(f.dir, "hand-written-verdict.json");
  writeJson(handWritten, fullVerdict({ assertions: passing.map((row) => qaAssertionFor(row)), measuredAt }));
  const sidecarBefore = readBytes(f.qaSidecarPath);
  const promote = await runCli(["qa", "promote", "--verdict", handWritten, "--packet", f.packetPath, "--json"]);
  assert.equal(promote.exitCode, 0, promote.error?.message || promote.stderr);
  assert.equal(readBytes(f.qaSidecarPath).equals(sidecarBefore), false, "the committed sidecar was rewritten");
  const after = handoffOf(await runNext(f, qcStandIns));
  assert.deepEqual(after, before, "the QC handoff is unchanged");
});

test("F1.0-B16 [stand-in: QA policy.availability] a qc_results row with producer \"agent\": result unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  parts.rows[0] = { ...parts.rows[0], producer: "agent" };
  assert.notEqual(parts.rows[0].producer, "campaigns-os qa run", "setup: the producer is not the package's");
  const results = await readQa(parts);
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", E);
  assertControlPass(results);
});

test("F1.0-B17 [stand-in: QA policy.availability] a qc_results row with schema campaigns-os-qc-result/v9: result unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  parts.rows[0] = { ...parts.rows[0], schema: "campaigns-os-qc-result/v9" };
  assert.notEqual(parts.rows[0].schema, "campaigns-os-qc-result/v0", "setup: the row schema is not v0");
  const results = await readQa(parts);
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", E);
  assertControlPass(results);
});

test("F1.0-B18 [stand-in: QA policy.availability] the QA stage's qa-output verdict path is a symlink to the committed sidecar: every QA result unexercised (evidence_not_reproducible)", async (t) => {
  const { f, installed, qcStandIns } = cliSetup(t);
  rmSync(installed.verdictPath);
  symlinkSync(f.qaSidecarPath, installed.verdictPath);
  assert.equal(lstatSync(installed.verdictPath).isSymbolicLink(), true, "setup: the verdict path is a symlink");
  assert.equal(realpathSync(installed.verdictPath), realpathSync(f.qaSidecarPath), "setup: it points at the committed sidecar");
  assertEveryQaRowNotReproducible(handoffOf(await runNext(f, qcStandIns)));
});

test("F1.0-B19 [stand-in: QA policy.availability] a warning row deleted from qc_results while its qc.* assertion remains: that id listed unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  parts.rows = parts.rows.filter((row) => row.id !== WARN_ID);
  assert.equal(parts.rows.some((row) => row.id === WARN_ID), false, "setup: the warning row is gone");
  assert.ok(parts.assertions.some((assertion) => assertion.evidence.qc.result_id === WARN_ID), "setup: its qc.* assertion remains");
  const results = await readQa(parts);
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", E);
  assertControlPass(results);
});

test("F1.0-B24 [stand-in: QA policy.availability] full verdict run_id differs from the stage's identity.verdict_run_id: every QA result unexercised (evidence_not_reproducible)", async (t) => {
  const { f, installed, qcStandIns } = cliSetup(t, { install: { verdictPatch: { run_id: "qc-synthetic-run-9999" } } });
  const verdictRunId = readJson(installed.verdictPath).run_id;
  const stageRunId = readJson(f.reportPath).stages.qa.identity.verdict_run_id;
  assert.equal(verdictRunId, "qc-synthetic-run-9999", "setup: the full verdict's run_id");
  assert.equal(stageRunId, QA_RUN_ID, "setup: the stage's identity.verdict_run_id");
  assert.notEqual(verdictRunId, stageRunId, "setup: the two run ids differ");
  assertEveryResultNotReproducible(await readInstalled(f, installed));
  assertEveryQaRowNotReproducible(handoffOf(await runNext(f, qcStandIns)));
});

test("F1.0-B36 [stand-in: QA policy.availability] the qc.* assertion paired with a warning row keeps its id but its evidence.qc.result_id names no row: that row's id listed unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  const assertion = parts.assertions[0];
  const orphanId = "policy.availability:campaign:store_unknown";
  parts.assertions[0] = { ...assertion, evidence: { qc: { ...assertion.evidence.qc, result_id: orphanId } } };
  assert.equal(parts.assertions[0].id, `qc.${WARN_ID}`, "setup: the assertion id is kept");
  assert.equal(parts.rows.some((row) => row.id === orphanId), false, "setup: its evidence.qc.result_id names no row");
  assert.equal(parts.assertions.some((candidate) => candidate.evidence.qc.result_id === WARN_ID), false, "setup: no assertion pairs with the warning row");
  const results = await readQa(parts);
  // Reader sites: a verdict result_id with no row gets a synthesized row with
  // that result (unexercised / evidence_not_reproducible).
  assertIds(results, [...SETUP_IDS, orphanId]);
  assertRow(results, WARN_ID, "unexercised", E);
  assertRow(results, orphanId, "unexercised", E);
  assertControlPass(results);
});

test("F1.0-B37 [stand-in: QA policy.availability] full verdict schema_version is not the verdict schema's: every QA result unexercised (evidence_not_reproducible)", async (t) => {
  const { f, installed, qcStandIns } = cliSetup(t, { install: { verdictPatch: { schema_version: "9.0" } } });
  assert.notEqual(readJson(installed.verdictPath).schema_version, QA_SCHEMA_VERSION, "setup: the verdict's schema_version is not the verdict schema's");
  assertEveryResultNotReproducible(await readInstalled(f, installed));
  assertEveryQaRowNotReproducible(handoffOf(await runNext(f, qcStandIns)));
});

test("F1.0-B38 [stand-in: QA policy.availability] full verdict runtime names another runtime: every QA result unexercised (evidence_not_reproducible)", async (t) => {
  const { f, installed, qcStandIns } = cliSetup(t, { install: { verdictPatch: { runtime: "synthetic-other-qa@1.0.0" } } });
  assert.notEqual(readJson(installed.verdictPath).runtime, PACKAGE_RUNTIME, "setup: the verdict names another runtime");
  assertEveryResultNotReproducible(await readInstalled(f, installed));
  assertEveryQaRowNotReproducible(handoffOf(await runNext(f, qcStandIns)));
});

// ---------------------------------------------------------------------------
// Incomplete rows

// API assumptions: a ref for a result the handoff does not print is
// `<id>@<first 12 hex of state_fingerprint>`; an absent full verdict is passed
// to readQaResults as `fullVerdict: null`.
test("F1.0-I5 [stand-in: QA policy.availability] QA warning with only the committed sidecar, full verdict absent: result unexercised, so checkpoint accept refuses it (evidence_not_reproducible)", async (t) => {
  const { f, rows, installed, qcStandIns } = cliSetup(t);
  rmSync(installed.verdictPath);
  assert.ok(readBytes(f.qaSidecarPath), "setup: the committed sidecar is present");
  assert.equal(readBytes(installed.verdictPath), null, "setup: the full verdict is absent");
  assertEveryResultNotReproducible(await readInstalled(f, installed, { fullVerdict: null }));
  assertEveryQaRowNotReproducible(handoffOf(await runNext(f, qcStandIns)));
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(rows[0])], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
});

test("F1.0-I10 [stand-in: QA policy.availability] a qc_results row whose result is \"ok\": result unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  parts.rows[0] = { ...parts.rows[0], result: "ok" };
  assert.equal(["pass", "warning", "review", "unexercised", "excluded"].includes(parts.rows[0].result), false, "setup: \"ok\" is outside the result vocabulary");
  const results = await readQa(parts);
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", E);
  assertControlPass(results);
});

test("F1.0-I11 [stand-in: 1.4 observation] a 1.4 observation whose outcome is \"maybe\": result unexercised (evidence_not_reproducible)", async () => {
  const parts = qaParts();
  const observation = { ...parts.rows[0].observation, outcome: "maybe" };
  parts.rows[0] = { ...parts.rows[0], observation };
  parts.assertions[0] = qaAssertionFor(parts.rows[0], observation);
  assert.equal(qaRederive(observation), null, "setup: \"maybe\" is outside the stand-in observation vocabulary");
  assert.deepEqual(parts.assertions[0].evidence.qc.observation, parts.rows[0].observation, "setup: row and assertion still pair on the same observation");
  const results = await readQa(parts);
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", E);
  assertControlPass(results);
});

test("F1.0-I12 [stand-in: QA policy.availability] QA results whose qc_build_fingerprint differs from the current build: results unexercised (stale_binding)", async () => {
  const parts = qaParts();
  const stage = qaStage(parts.rows, { qcBuildFingerprint: OTHER_BUILD_FP });
  assert.notEqual(stage.evidence.qc_build_fingerprint, BUILD_FP, "setup: the QA binding differs from the current build");
  const results = await readQa({ ...parts, stage, currentBuild: BUILD_FP });
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", "stale_binding");
  assertRow(results, PASS_ID, "unexercised", "stale_binding");
});

test("F1.0-I13 [stand-in: QA policy.availability] QA stage evidence with qc_build_fingerprint null: results unexercised (stale_binding)", async () => {
  const parts = qaParts();
  const stage = qaStage(parts.rows, { qcBuildFingerprint: null });
  assert.equal(stage.evidence.qc_build_fingerprint, null, "setup: the QA results carry no build binding");
  const results = await readQa({ ...parts, stage, currentBuild: BUILD_FP });
  assertIds(results, SETUP_IDS);
  assertRow(results, WARN_ID, "unexercised", "stale_binding");
  assertRow(results, PASS_ID, "unexercised", "stale_binding");
});

// The QA checks of units 1.1, 1.2 and 1.4 (contract subjects), all applicable
// to these setups: 1.1 always, 1.2 because analytics.params.content is
// declared, 1.4 because campaign.store_terms is declared.
const QA_UNIT_CHECKS = ["tracking.url", "tracking.order", "tracking.tag", "content_param", "policy.presence", "policy.availability"];
const declareContent = (spec) => { spec.analytics = { ...(spec.analytics || {}), params: { content: [{ name: "hide_promo" }] } }; };

// The QA-leg coverage as a set of [check, result, reason_code], exactly.
function assertQaCoverage(handoff, reasonCode) {
  const coverage = (handoff.coverage || []).filter((entry) => entry.leg === "qa");
  const tuples = [...new Set(coverage.map((entry) => JSON.stringify([entry.check, entry.result, entry.reason_code])))].map((text) => JSON.parse(text)).sort();
  assert.deepEqual(
    tuples,
    QA_UNIT_CHECKS.map((check) => [check, "unexercised", reasonCode]).sort(),
    `qc_handoff.coverage lists every applicable QA check, each unexercised / ${reasonCode}: ${JSON.stringify(handoff.coverage)}`,
  );
}

function assertApplicable(f) {
  const spec = readJson(f.specPath);
  assert.ok(spec.analytics?.params?.content?.length > 0, "setup: analytics.params.content is declared");
  assert.ok(spec.campaign?.store_terms, "setup: campaign.store_terms is declared");
}

// API assumption: the report schema requires stages.qa, so "no QA stage
// record" is the pending stage prepare-build leaves (no outputs, identity or
// evidence); deleting stages.qa would make the report invalid instead.
test("F1.0-I18 spec declares analytics.params.content and campaign.store_terms, no QA stage record: handoff coverage lists 1.1, 1.2 and 1.4 unexercised (leg_not_run)", async (t) => {
  const f = campaignFixture({ mutateSpec: declareContent });
  t.after(f.cleanup);
  const qa = readJson(f.reportPath).stages.qa;
  assert.equal(qa.status, "pending", "setup: QA never recorded");
  assert.deepEqual([qa.outputs, qa.identity, qa.evidence], [[], undefined, undefined], "setup: no QA outputs, identity or evidence");
  assertApplicable(f);
  assertQaCoverage(handoffOf(await runNext(f, {})), "leg_not_run");
});

test("F1.0-I19 QA stage recorded by the previous version (no qc_results): handoff coverage lists the QA checks unexercised (not_captured_by_this_version)", async (t) => {
  const f = campaignFixture({ mutateSpec: declareContent });
  t.after(f.cleanup);
  installQaStage(f, { rows: [], assertions: [], evidence: null });
  const qa = readJson(f.reportPath).stages.qa;
  assert.equal(qa.status, "completed", "setup: the QA stage is recorded");
  assert.equal(qa.evidence?.qc_results, undefined, "setup: it carries no qc_results");
  assertApplicable(f);
  assertQaCoverage(handoffOf(await runNext(f, {})), "not_captured_by_this_version");
});
