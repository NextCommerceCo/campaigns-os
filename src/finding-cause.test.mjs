import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  annotateDoctorIssueCauses,
  annotateQaAssertionCauses,
  CAUSE_CLASSES,
  classifyDoctorIssue,
  classifyQaAssertion,
  doctorIssueFingerprint,
  doctorUpstreamDriftReason,
  findPriorRunRecord,
  formatCauseSummaryLine,
  formatCauseTag,
  loadPriorQaVerdict,
  priorSetFromEntries,
  qaAssertionFingerprint,
  qaEnvironmentReason,
  summarizeCauses,
} from "./finding-cause.mjs";
import { deriveExceptions, isFindingAssertion } from "./qa-verdict.mjs";

function finding({ id, family = "funnel-flow", page = "checkout", status = "fail", severity = "blocker", evidence = undefined }) {
  return { id, family, page, status, severity, ...(evidence ? { evidence } : {}) };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "campaigns-os-cause-"));
}

/**
 * Write a packet-directory-shaped fixture: a Run Record under
 * .campaign-runtime/run-records/ pointing at a previous QA verdict, exactly
 * the layout `qa run` and `run-record` produce side by side.
 */
function writePriorRun(baseDir, { runId, mapId, verdict }) {
  const recordsDir = join(baseDir, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  const verdictRel = `qa-output/${mapId}/${verdict.run_id}.json`;
  const verdictPath = join(baseDir, verdictRel);
  mkdirSync(join(baseDir, `qa-output/${mapId}`), { recursive: true });
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  writeFileSync(
    join(recordsDir, `${runId}.json`),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: runId,
      identity: { map_id: mapId, campaign_slug: null, template_family: null, entry_point_shape: "packet" },
      artifacts: [{ kind: "qa_verdict", path: `./${verdictRel}`, schema_version: "1.0", sha256: null }],
      observations: {},
    }, null, 2)}\n`,
  );
  return verdictPath;
}

/**
 * A prior run that needed repair and re-test: two qa_verdict artifacts on one
 * Run Record, appended in session order — the blocked first attempt, then the
 * final verdict the run actually closed on.
 */
function writePriorRunWithAttempts(baseDir, { runId, mapId, attempts }) {
  const recordsDir = join(baseDir, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  mkdirSync(join(baseDir, `qa-output/${mapId}`), { recursive: true });
  const artifacts = attempts.map((verdict) => {
    const rel = `qa-output/${mapId}/${verdict.run_id}.json`;
    writeFileSync(join(baseDir, rel), `${JSON.stringify(verdict, null, 2)}\n`);
    return { kind: "qa_verdict", path: `./${rel}`, schema_version: "1.0", sha256: null };
  });
  writeFileSync(
    join(recordsDir, `${runId}.json`),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: runId,
      identity: { map_id: mapId, campaign_slug: null, template_family: null, entry_point_shape: "packet" },
      artifacts,
      observations: {},
    }, null, 2)}\n`,
  );
}

function writePriorDoctorRun(baseDir, { runId, mapId, errorCodes = [], warningCodes = [] }) {
  const recordsDir = join(baseDir, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(
    join(recordsDir, `${runId}.json`),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: runId,
      identity: { map_id: mapId, campaign_slug: null, template_family: null, entry_point_shape: "packet" },
      artifacts: [],
      observations: {
        doctor: { status: "blocked", error_codes: errorCodes, warning_codes: warningCodes, ready_count: 0 },
      },
    }, null, 2)}\n`,
  );
}

test("the QA fingerprint is the identity the verdict already projects, and excludes the URL", () => {
  const local = finding({ id: "http:checkout", page: "checkout" });
  const published = { ...local, url: "https://example.test/checkout" };
  assert.equal(qaAssertionFingerprint(local), qaAssertionFingerprint(published));
  assert.equal(qaAssertionFingerprint(local), "qa:funnel-flow|http:checkout|checkout");
  assert.notEqual(
    qaAssertionFingerprint(local),
    qaAssertionFingerprint(finding({ id: "http:checkout", page: "upsell1" })),
  );
});

test("findings carried over from the previous run are pre-existing; a new one is caused by this change", () => {
  const base = scratch();
  const x = finding({ id: "meta:title", family: "meta-tags", page: "landing", status: "warn", severity: "warn" });
  const y = finding({ id: "http:upsell1", page: "upsell1" });
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_prior", assertions: [x, y] },
  });

  const z = finding({ id: "http:receipt", page: "receipt" });
  const assertions = [
    { ...x },
    { ...y },
    z,
    finding({ id: "http:landing", page: "landing", status: "pass", severity: "info" }),
  ];
  const summary = annotateQaAssertionCauses(assertions, {
    baseDir: base,
    mapId: "map-1",
    currentRunId: "run_1757999999999_bbbbbbbb",
    isFinding: isFindingAssertion,
  });

  assert.equal(assertions[0].cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(assertions[0].cause_reason, "same_status_in_prior_run");
  assert.equal(assertions[1].cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(assertions[2].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
  assert.equal(assertions[2].cause_reason, "new_since_prior_run");
  // A passing assertion is not a finding and carries no cause at all.
  assert.equal(assertions[3].cause, undefined);

  assert.equal(summary.total, 3);
  assert.equal(summary.counts[CAUSE_CLASSES.PRE_EXISTING], 2);
  assert.equal(summary.counts[CAUSE_CLASSES.CAUSED_BY_CHANGE], 1);
  assert.equal(summary.prior_run_id, "qa_prior");
  assert.equal(summary.comparison, "prior_run");
});

test("a finding whose status moved since the previous run is caused by this change, not pre-existing", () => {
  const base = scratch();
  const before = finding({ id: "http:checkout", page: "checkout", status: "warn", severity: "warn" });
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_prior", assertions: [before] },
  });
  const now = [finding({ id: "http:checkout", page: "checkout", status: "fail", severity: "blocker" })];
  annotateQaAssertionCauses(now, { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(now[0].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
  assert.match(now[0].cause_reason, /^status_changed_since_prior_run:warn->fail$/);
});

test("a budget stop and a runner capture failure are test-environment, even when the previous run had them too", () => {
  const base = scratch();
  // The shipped shape: a spent budget is manual_review/warn, not a blocker —
  // still a finding, and still carrying the runner's own budget marker.
  const budget = finding({
    id: "browser-test-order:checkout",
    family: "browser-test-order",
    page: "checkout",
    status: "manual_review",
    severity: "warn",
    evidence: { order_creation_budget: { limit: 1, reserved: 1, exhausted: true, note: "safety stop" } },
  });
  const runner = finding({ id: "analytics-correctness:runner", family: "analytics-correctness", page: "analytics" });
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_prior", assertions: [budget, runner] },
  });

  const assertions = [{ ...budget }, { ...runner }];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(assertions[0].cause, CAUSE_CLASSES.TEST_ENVIRONMENT);
  assert.equal(assertions[0].cause_reason, "order_creation_budget_stop");
  assert.equal(assertions[1].cause, CAUSE_CLASSES.TEST_ENVIRONMENT);
  assert.equal(assertions[1].cause_reason, "runner_capture_failure");
  assert.equal(summary.counts[CAUSE_CLASSES.TEST_ENVIRONMENT], 2);
  assert.equal(summary.counts[CAUSE_CLASSES.PRE_EXISTING], 0);
});

test("with no previous run every finding is unknown with reason no_prior_run", () => {
  const base = scratch();
  const assertions = [finding({ id: "http:checkout" }), finding({ id: "http:upsell1", page: "upsell1" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });
  for (const assertion of assertions) {
    assert.equal(assertion.cause, CAUSE_CLASSES.UNKNOWN);
    assert.equal(assertion.cause_reason, "no_prior_run");
  }
  assert.equal(summary.total, 2);
  assert.equal(summary.counts[CAUSE_CLASSES.UNKNOWN], 2);
  assert.equal(summary.prior_run_id, null);
  assert.equal(summary.comparison, "no_prior_run");
});

test("a packet-less run has no comparison root and says so rather than inventing one", () => {
  const assertions = [finding({ id: "http:checkout" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: null, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(assertions[0].cause, CAUSE_CLASSES.UNKNOWN);
  assert.equal(summary.comparison, "no_prior_run");
});

test("a Run Record for a different campaign is not a previous run for this one", () => {
  const base = scratch();
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "other-map",
    verdict: { run_id: "qa_prior", assertions: [finding({ id: "http:checkout" })] },
  });
  assert.equal(findPriorRunRecord({ baseDir: base, mapId: "map-1" }), null);
  const assertions = [finding({ id: "http:checkout" })];
  annotateQaAssertionCauses(assertions, { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(assertions[0].cause_reason, "no_prior_run");
});

test("a previous Run Record whose QA verdict is gone reports its own reason, not a false pre-existing", () => {
  const base = scratch();
  const recordsDir = join(base, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(
    join(recordsDir, "run_1757000000000_aaaaaaaa.json"),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: "run_1757000000000_aaaaaaaa",
      identity: { map_id: "map-1" },
      artifacts: [{ kind: "qa_verdict", path: "./qa-output/map-1/gone.json" }],
      observations: {},
    })}\n`,
  );
  const lookup = loadPriorQaVerdict({ baseDir: base, mapId: "map-1" });
  assert.equal(lookup.verdict, null);
  assert.equal(lookup.reason, "prior_run_verdict_unreadable");
});

test("the cause labels survive into the derived exceptions projection", () => {
  const assertion = { ...finding({ id: "http:checkout" }), cause: CAUSE_CLASSES.PRE_EXISTING, cause_reason: "same_status_in_prior_run" };
  const [exception] = deriveExceptions([assertion]);
  assert.equal(exception.cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(exception.cause_reason, "same_status_in_prior_run");
});

test("doctor codes present in the previous Run Record are pre-existing; a new code is caused by this change", () => {
  const base = scratch();
  writePriorDoctorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    errorCodes: ["built_output.page_missing"],
    warningCodes: ["template_contract.literal_residue"],
  });
  const errors = [{ code: "built_output.page_missing", message: "x" }, { code: "checkout.unknown_field_binding", message: "y" }];
  const warnings = [{ code: "template_contract.literal_residue", message: "z" }];
  const summary = annotateDoctorIssueCauses({ errors, warnings, baseDir: base, mapId: "map-1" });

  assert.equal(errors[0].cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(errors[1].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
  assert.equal(warnings[0].cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(summary.total, 3);
  assert.equal(summary.prior_run_id, "run_1757000000000_aaaaaaaa");
});

test("a doctor code that moved from warning to error is caused by this change", () => {
  const base = scratch();
  writePriorDoctorRun(base, { runId: "run_1757000000000_aaaaaaaa", mapId: "map-1", warningCodes: ["polish.stale"] });
  const errors = [{ code: "polish.stale", message: "x" }];
  annotateDoctorIssueCauses({ errors, warnings: [], baseDir: base, mapId: "map-1" });
  assert.equal(errors[0].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
  assert.equal(errors[0].cause_reason, "status_changed_since_prior_run:warning->error");
});

test("an SDK-pin disagreement is upstream drift; its sibling configuration codes are not", () => {
  assert.equal(doctorUpstreamDriftReason({ code: "page_kit.sdk_version" }), "sdk_pin_disagreement");
  assert.equal(doctorUpstreamDriftReason({ code: "page_kit.sdk_version.waived" }), "sdk_pin_disagreement");
  assert.equal(doctorUpstreamDriftReason({ code: "page_kit.sdk_version.spec_conflict" }), "sdk_pin_disagreement");
  assert.equal(doctorUpstreamDriftReason({ code: "page_kit.sdk_version.spec_missing" }), null);
  assert.equal(doctorUpstreamDriftReason({ code: "page_kit.sdk_version.waiver_inert" }), null);

  const base = scratch();
  writePriorDoctorRun(base, { runId: "run_1757000000000_aaaaaaaa", mapId: "map-1", errorCodes: ["page_kit.sdk_version"] });
  const errors = [{ code: "page_kit.sdk_version", message: "pin mismatch" }];
  annotateDoctorIssueCauses({ errors, warnings: [], baseDir: base, mapId: "map-1" });
  // Drift wins over the previous-run comparison: it was there last time too,
  // and it is still not something the change under test did.
  assert.equal(errors[0].cause, CAUSE_CLASSES.UPSTREAM_DRIFT);
});

test("the summary line leads with the count and names what it compared against", () => {
  const summary = summarizeCauses([
    { cause: CAUSE_CLASSES.CAUSED_BY_CHANGE },
    { cause: CAUSE_CLASSES.PRE_EXISTING },
    { cause: CAUSE_CLASSES.PRE_EXISTING },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(
    formatCauseSummaryLine(summary, { priorRunId: "qa_prior" }),
    "Causes: 3 findings — 1 caused by this change, 2 pre-existing (compared against run qa_prior).",
  );
  assert.match(formatCauseSummaryLine(summary), /no previous run to compare against/);
  assert.equal(formatCauseSummaryLine({ total: 0, counts: {} }), "Causes: no findings.");
});

test("the per-finding tag reads as a label, not as a field dump", () => {
  assert.equal(
    formatCauseTag({ cause: CAUSE_CLASSES.PRE_EXISTING, cause_reason: "same_status_in_prior_run" }),
    "[pre-existing: same_status_in_prior_run]",
  );
  assert.equal(formatCauseTag({}), "");
});

test("classification helpers agree with the fingerprint helpers", () => {
  const prior = priorSetFromEntries([{ fingerprint: "qa:funnel-flow|http:checkout|checkout", status: "fail" }]);
  assert.equal(
    classifyQaAssertion(finding({ id: "http:checkout" }), { prior }).cause,
    CAUSE_CLASSES.PRE_EXISTING,
  );
  assert.equal(doctorIssueFingerprint({ code: "polish.stale" }), "doctor:polish.stale");
  assert.equal(
    classifyDoctorIssue({ code: "polish.stale" }, "error", { prior: priorSetFromEntries([{ fingerprint: "doctor:polish.stale", status: "error" }]) }).cause,
    CAUSE_CLASSES.PRE_EXISTING,
  );
  assert.equal(qaEnvironmentReason(finding({ id: "http:checkout" })), null);
});

test("the comparison uses the prior run's FINAL QA attempt, not its first blocked one", () => {
  const base = scratch();
  const x = finding({ id: "http:upsell1", page: "upsell1" });
  writePriorRunWithAttempts(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    attempts: [
      // The blocked attempt that triggered the repair: X was present.
      { run_id: "qa_attempt_1", assertions: [x, finding({ id: "http:checkout" })] },
      // The verdict the run actually closed on: X had been fixed.
      { run_id: "qa_final", assertions: [finding({ id: "http:checkout" })] },
    ],
  });

  const assertions = [{ ...x }, finding({ id: "http:checkout" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });

  // X was fixed before the prior run closed and is back now. Comparing against
  // the first attempt would call it pre_existing and hide the regression.
  assert.equal(assertions[0].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
  assert.equal(assertions[0].cause_reason, "new_since_prior_run");
  assert.equal(assertions[1].cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(summary.prior_run_id, "qa_final");
});

test("a multi-attempt prior run is still ONE record: the boundary does not widen to earlier runs", () => {
  const base = scratch();
  writePriorRunWithAttempts(base, {
    runId: "run_1757000001000_bbbbbbbb",
    mapId: "map-1",
    attempts: [
      { run_id: "qa_attempt_1", assertions: [finding({ id: "http:receipt", page: "receipt" })] },
      { run_id: "qa_final", assertions: [] },
    ],
  });
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_older", assertions: [finding({ id: "http:receipt", page: "receipt" })] },
  });
  const assertions = [finding({ id: "http:receipt", page: "receipt" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(summary.prior_run_id, "qa_final");
  assert.equal(assertions[0].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
});
