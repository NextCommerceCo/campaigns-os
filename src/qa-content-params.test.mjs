// Unit 1.2 fixture rows, leg QN: stored content parameter observations
// re-evaluated in node (contract §1.2 Accepts "State" and "Lapse").
//
// Each row builds the stored observation of an accepted warning, produces its
// row the way the producer does (the real module's rederiveQcResult, then the
// 1.0 buildQcResult and toQaAssertion), records a real accept on it
// (createQcAccept), then changes exactly one stored field, rebuilds the row
// from the changed observation, reads both through the 1.0 QA reader with the
// real module loaded from the registry (no stand-in), and assesses the accept.
//
// API assumption (every row): rederiveQcResult(observation) returns the 1.0
// Derived shape {check, subject, result, reason_code, members,
// accept_eligible, coverage, state} for a stored observation in the
// contract's shape (§1.2 Observations), exactly as below:
//   { param, page,
//     readiness: { baseline, param_n },     // "ready" | "readiness_timeout" | "navigation_failed" | "page_not_served"
//     references: [{ attr, expr_sha256, form, prediction }],
//     targets: [{ attr, expr_sha256, element_path,
//                 baseline: { present, visible, stable }, param_n: { present, visible, stable } }],
//     counts: { baseline, param_n } }
// with check "content_param" and subject {check: "content_param", page, key:
// param}, so the row id is content_param:<page>:<param>; its verdict
// assertion is qc.content_param:<param>:<page> (contract §1.2 Result rules),
// paired to the row by evidence.qc.result_id. expr_sha256 is "sha256:"
// + the hex sha256 of the attribute value; element_path is "body" then
// ">tag[index]" per element step (0-based among same-tag siblings); form
// "presence" is the single-term `param.<name>` / `params.<name>` form, which
// predicts "hidden" with ?<name>=n.
//
// API assumption (members): one member per live element attribute that
// references the param, keyed "<attr>:<element_path>", with that reference's
// own result and reason code; a row decided before any per-reference
// judgement (readiness_timeout and the other unexercised readiness outcomes,
// no_resolvable_target, not_toggled_by_n, target_count_changed) has no
// members.
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test. The fixture
// module imports only node builtins; its guard covers every raw TCP or TLS
// socket connect and WebSocket. The factory, imported after it, installs its
// fetch and http(s) guard before it loads any module under test, so a module
// that keeps a reference to any of these at import time keeps the guarded one.
import { assertExactMembers, assertLoopbackOnly, installNodeGuard } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
const { BUILD_FP, OPERATOR, QA_RUN_ID, assertNoNetworkAttempts, fullVerdict, sha256 } = await import("./qc-test-factories.mjs");

afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const NAME = "reviews";
const PAGE = "index";
const ID = "content_param:index:reviews";
const ASSERTION_ID = "qc.content_param:reviews:index";
const SUBJECT = Object.freeze({ check: "content_param", page: PAGE, key: NAME });
const E = "evidence_not_reproducible";
const EXPRESSION = "param.reviews";
const SECOND_EXPRESSION = "param.reviews == 'n'";
const PATH_0 = "body>main[0]>section[0]";
const PATH_1 = "body>main[0]>section[1]";
const VISIBLE = Object.freeze({ present: true, visible: true, stable: true });
const HIDDEN = Object.freeze({ present: true, visible: false, stable: true });

const reference = (expression, form) => ({ attr: "hide", expr_sha256: sha256(expression), form, prediction: "hidden" });
const target = (expression, elementPath, paramN = VISIBLE) => ({ attr: "hide", expr_sha256: sha256(expression), element_path: elementPath, baseline: { ...VISIBLE }, param_n: { ...paramN } });

// F1.2-B1's stored observation: one data-next-hide="param.reviews" target,
// visible at baseline and still visible with ?reviews=n, both contexts ready.
function b1Observation() {
  return {
    param: NAME,
    page: PAGE,
    readiness: { baseline: "ready", param_n: "ready" },
    references: [reference(EXPRESSION, "presence")],
    targets: [target(EXPRESSION, PATH_0)],
    counts: { baseline: 1, param_n: 1 },
  };
}

// Two targets, both still visible with ?reviews=n. `secondParamN` is the
// second target's param_n reading.
function twoTargetObservation(secondParamN = VISIBLE) {
  return {
    param: NAME,
    page: PAGE,
    readiness: { baseline: "ready", param_n: "ready" },
    references: [reference(EXPRESSION, "presence"), reference(SECOND_EXPRESSION, "equals")],
    targets: [target(EXPRESSION, PATH_0), target(SECOND_EXPRESSION, PATH_1, secondParamN)],
    counts: { baseline: 2, param_n: 2 },
  };
}

const B1_MEMBERS = Object.freeze({ [`hide:${PATH_0}`]: ["warning", "target_still_visible"] });
const measuredAt = new Date(Date.now() - 60_000).toISOString();

// The producer's row for an observation.
async function rowFor(observationValue) {
  const { rederiveQcResult } = await import("./qa-content-params.mjs");
  const { buildQcResult } = await import("./qc-results.mjs");
  const derived = rederiveQcResult(observationValue);
  assert.ok(derived && typeof derived === "object", "the observation re-derives");
  return buildQcResult({
    check: derived.check,
    leg: "qa",
    subject: derived.subject,
    result: derived.result,
    reason_code: derived.reason_code,
    state: derived.state,
    observation: observationValue,
    members: derived.members ?? [],
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at: measuredAt,
  });
}

// The 1.0 QA reader over one row and its verdict assertion (under the
// contract's assertion id), with the real module from the registry.
async function readRow(row) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults, toQaAssertion } = await import("./qc-results.mjs");
  const results = readQaResults({
    stageEvidence: { qc_results: [row], qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: [{ ...toQaAssertion(row, { family: "browser-runtime" }), id: ASSERTION_ID }], measuredAt }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  assert.deepEqual(results.map((entry) => entry.id), [ID], "the reader lists exactly the stored id");
  return results[0];
}

async function acceptOn(row) {
  const { createQcAccept, qcAcceptAttribution } = await import("./qc-accept.mjs");
  const attribution = qcAcceptAttribution({ reason: "known synthetic", acceptedBy: OPERATOR, now: new Date().toISOString() });
  return createQcAccept(row, { measuredAt, attribution });
}

function assertRead(row, { result, reasonCode, acceptEligible, members }, label) {
  assert.equal(row.id, ID, `${label}: the row is ${ID}`);
  assert.deepEqual(row.subject, SUBJECT, `${label}: subject`);
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], [result, reasonCode, acceptEligible], `${label}: reads ${result} / ${reasonCode}, accept_eligible ${acceptEligible}`);
  assertExactMembers(row, members);
}

// Accept the warning read from `before`, then read `after` (one stored field
// changed) and assess the same accept.
async function assertLapses({ before, after, measured, current }) {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const read = await readRow(await rowFor(before));
  assertRead(read, measured, "setup (the accepted warning)");
  const record = await acceptOn(read);
  assert.deepEqual(assessQcAccepts([record], [read]).map(({ status, why }) => [status, why]), [["active", null]], "setup: the accept is active on the measured state");

  const changed = await readRow(await rowFor(after));
  assertRead(changed, current, "the changed observation");
  assert.notEqual(changed.reason_code, E, "the changed observation still re-derives");
  assert.notEqual(changed.state_fingerprint, read.state_fingerprint, "the state fingerprint moved");
  assert.deepEqual(assessQcAccepts([record], [changed]).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]], "the accept lapses");
}

const B1_READ = Object.freeze({ result: "warning", reasonCode: "target_still_visible", acceptEligible: true, members: B1_MEMBERS });

// ---------------------------------------------------------------------------
// Broken (accept lapse)

test("F1.2-B4 accepted target_still_visible; stored observation re-evaluated with the target's expr_sha256 changed: accept lapsed (state_changed)", async () => {
  // The target's expression changed (to `params.reviews`, the same supported
  // form), so its reference carries the same new hash.
  const after = b1Observation();
  after.targets[0].expr_sha256 = sha256("params.reviews");
  after.references[0].expr_sha256 = sha256("params.reviews");
  await assertLapses({ before: b1Observation(), after, measured: B1_READ, current: B1_READ });
});

test("F1.2-B5 accepted target_still_visible; stored observation re-evaluated with the target's element_path changed: accept lapsed (state_changed)", async () => {
  const after = b1Observation();
  after.targets[0].element_path = PATH_1;
  await assertLapses({ before: b1Observation(), after, measured: B1_READ, current: { ...B1_READ, members: { [`hide:${PATH_1}`]: ["warning", "target_still_visible"] } } });
});

test("F1.2-B6 accepted a two-target target_still_visible; one target is now hidden with ?reviews=n: accept lapsed (state_changed)", async () => {
  const both = { [`hide:${PATH_0}`]: ["warning", "target_still_visible"], [`hide:${PATH_1}`]: ["warning", "target_still_visible"] };
  const one = { [`hide:${PATH_0}`]: ["warning", "target_still_visible"], [`hide:${PATH_1}`]: ["pass", null] };
  await assertLapses({
    before: twoTargetObservation(),
    after: twoTargetObservation(HIDDEN),
    measured: { ...B1_READ, members: both },
    current: { ...B1_READ, members: one },
  });
});

test("F1.2-B7 accepted target_still_visible; stored observation re-evaluated with the param_n readiness changed to readiness_timeout only: accept lapsed (state_changed)", async () => {
  const after = b1Observation();
  after.readiness.param_n = "readiness_timeout";
  await assertLapses({ before: b1Observation(), after, measured: B1_READ, current: { result: "unexercised", reasonCode: "readiness_timeout", acceptEligible: false, members: {} } });
});

test("F1.2-B8 accepted target_still_visible; stored observation re-evaluated with the target's param_n.present changed to false only: accept lapsed (state_changed)", async () => {
  const after = b1Observation();
  after.targets[0].param_n.present = false;
  await assertLapses({ before: b1Observation(), after, measured: B1_READ, current: { result: "review", reasonCode: "target_identity_unresolved", acceptEligible: false, members: { [`hide:${PATH_0}`]: ["review", "target_identity_unresolved"] } } });
});

test("F1.2-B9 accepted target_still_visible; stored observation re-evaluated with the target's param_n.stable changed to false only: accept lapsed (state_changed)", async () => {
  const after = b1Observation();
  after.targets[0].param_n.stable = false;
  await assertLapses({ before: b1Observation(), after, measured: B1_READ, current: { result: "review", reasonCode: "target_identity_unresolved", acceptEligible: false, members: { [`hide:${PATH_0}`]: ["review", "target_identity_unresolved"] } } });
});

test("F1.2-B10 accepted target_still_visible; stored observation re-evaluated with counts.param_n changed from 1 to 2 only: accept lapsed (state_changed)", async () => {
  const after = b1Observation();
  after.counts.param_n = 2;
  await assertLapses({ before: b1Observation(), after, measured: B1_READ, current: { result: "review", reasonCode: "target_count_changed", acceptEligible: false, members: {} } });
});
