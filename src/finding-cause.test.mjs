import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  formatCauseBasisLine,
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
  assert.equal(summary.prior_run_id, "run_1757000000000_aaaaaaaa");
  assert.equal(summary.prior_qa_attempt_run_id, "qa_prior");
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
    formatCauseSummaryLine({ ...summary, surface: "doctor", comparison: "prior_run", prior_run_id: "run_1_a" }),
    "Causes: 3 findings — 1 caused by this change, 2 pre-existing (compared against run run_1_a).",
  );
  // The QA line says which artifact of that record was read.
  assert.equal(
    formatCauseSummaryLine({ ...summary, surface: "qa", comparison: "prior_run", prior_run_id: "run_1_a" }),
    "Causes: 3 findings — 1 caused by this change, 2 pre-existing (compared against the final QA attempt of run run_1_a).",
  );
  assert.match(formatCauseSummaryLine(summary), /no previous run to compare against/);
  // A record id must never be presented as "compared against" when nothing was.
  assert.match(
    formatCauseSummaryLine({ ...summary, comparison: "prior_run_verdict_unreadable", prior_run_id: "run_1_a" }),
    /no comparison was possible/,
  );
  assert.equal(formatCauseSummaryLine({ total: 0, counts: {} }), "Causes: no findings.");
});

test("the comparison-basis line tells the truth for every reason, and names the record when there is one", () => {
  // A comparison happened: no basis line at all.
  assert.equal(formatCauseBasisLine({ comparison: "prior_run", prior_run_id: "run_1_a" }), null);

  // No prior record: the labels really do improve once one exists.
  const none = formatCauseBasisLine({ comparison: "no_prior_run", prior_run_id: null });
  assert.match(none, /no previous run for this campaign/);
  assert.match(none, /once a Run Record exists/);
  assert.doesNotMatch(none, /run \(unidentified\)/);

  // A prior record EXISTS in these three. Telling the operator to wait for a
  // second run would be false, and would send them to re-run something that
  // fails the same way — so each names the record and says what is missing.
  for (const [reason, pattern] of [
    ["prior_run_without_qa_verdict", /references no QA verdict/],
    ["prior_run_verdict_unreadable", /QA verdict is missing or unreadable/],
    ["prior_run_verdict_unlocated", /outside the packet directory/],
    ["prior_run_without_doctor_observations", /carries no doctor observations/],
  ]) {
    const line = formatCauseBasisLine({ comparison: reason, prior_run_id: "run_1_a" });
    assert.match(line, new RegExp(`Comparison basis: ${reason}\\.`));
    assert.match(line, /Previous run run_1_a exists/);
    assert.match(line, pattern);
    assert.doesNotMatch(line, /until a second run/);
    assert.doesNotMatch(line, /starts working once/);
  }

  // An unrecognised reason still must not claim a second run will fix it.
  const unknown = formatCauseBasisLine({ comparison: "something_new", prior_run_id: "run_1_a" });
  assert.match(unknown, /No previous-run comparison was possible/);
  assert.doesNotMatch(unknown, /once a Run Record exists/);
});

test("a stray file in the run-records directory is not a previous run", () => {
  const base = scratch();
  const recordsDir = join(base, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  // An operator note dropped beside the records. It is JSON, it names this
  // campaign, and under an `endsWith(".json")` scan it is the only candidate —
  // so it gets selected as THE previous run and its (absent) findings become
  // the comparison set. A stray file must be invisible to the scan.
  writeFileSync(
    join(recordsDir, "notes.json"),
    `${JSON.stringify({ run_id: "notes", identity: { map_id: "map-1" }, artifacts: [], observations: { doctor: { error_codes: [], warning_codes: [] } } })}\n`,
  );
  assert.equal(findPriorRunRecord({ baseDir: base, mapId: "map-1" }), null);

  const errors = [{ code: "built_output.page_missing", message: "x" }];
  const summary = annotateDoctorIssueCauses({ errors, warnings: [], baseDir: base, mapId: "map-1" });
  assert.equal(summary.comparison, "no_prior_run");
  assert.equal(errors[0].cause, CAUSE_CLASSES.UNKNOWN);

  // A real record beside the stray one is still found.
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_prior", assertions: [] },
  });
  assert.equal(findPriorRunRecord({ baseDir: base, mapId: "map-1" }).run_id, "run_1757000000000_aaaaaaaa");
});

test("a record written under an operator-supplied run id is still a record", () => {
  // `--run-id` lets an operator name a run, and writeRunRecord writes whatever
  // it is given. A filter that required the minted `run_<epoch-ms>_<hex>` shape
  // would report such a run as missing — worse than the stray file it excludes.
  const base = scratch();
  const recordsDir = join(base, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(
    join(recordsDir, "run_synth_0000000001.json"),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: "run_synth_0000000001",
      identity: { map_id: "map-1" },
      artifacts: [],
      observations: { doctor: { error_codes: ["built_output.page_missing"], warning_codes: [] } },
    })}\n`,
  );
  const errors = [{ code: "built_output.page_missing", message: "x" }];
  const summary = annotateDoctorIssueCauses({ errors, warnings: [], baseDir: base, mapId: "map-1" });
  assert.equal(summary.comparison, "prior_run");
  assert.equal(summary.prior_run_id, "run_synth_0000000001");
  assert.equal(errors[0].cause, CAUSE_CLASSES.PRE_EXISTING);
});

test("both surfaces report the same previous-run identity", () => {
  const base = scratch();
  writePriorRun(base, {
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_prior", assertions: [] },
  });
  writePriorDoctorRun(base, {
    runId: "run_1757000001000_bbbbbbbb",
    mapId: "map-1",
    errorCodes: ["built_output.page_missing"],
  });
  // Both read the newest record, and both name it the same way — the QA
  // summary no longer reports a verdict id where doctor reports a record id.
  const qa = annotateQaAssertionCauses([finding({ id: "http:checkout" })], { baseDir: base, mapId: "map-1", isFinding: isFindingAssertion });
  const doctor = annotateDoctorIssueCauses({ errors: [{ code: "built_output.page_missing", message: "x" }], warnings: [], baseDir: base, mapId: "map-1" });
  assert.equal(qa.prior_run_id, "run_1757000001000_bbbbbbbb");
  assert.equal(doctor.prior_run_id, "run_1757000001000_bbbbbbbb");
  assert.equal(qa.surface, "qa");
  assert.equal(doctor.surface, "doctor");
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
  // prior_run_id is the Run Record's id — the same identity the doctor summary
  // reports — and the attempt actually read rides alongside under its own name.
  assert.equal(summary.prior_run_id, "run_1757000000000_aaaaaaaa");
  assert.equal(summary.prior_qa_attempt_run_id, "qa_final");
  assert.equal(summary.surface, "qa");
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
  assert.equal(summary.prior_run_id, "run_1757000001000_bbbbbbbb");
  assert.equal(summary.prior_qa_attempt_run_id, "qa_final");
  assert.equal(assertions[0].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
});

// ---------------------------------------------------------------------------
// The previous run's verdict outside the packet directory: the Run Record
// references it as `external:qa_verdict` (kind + digest, no path) whenever the
// target repo is not the packet's own directory.
// ---------------------------------------------------------------------------

const sha256Of = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * A packet directory and a separate target repo, laid out the way `qa run`
 * and `run-record` leave them when `assembly.target_repo` points elsewhere:
 * the full verdict under `<target>/qa-output/<map id>/`, the record under the
 * packet directory referencing it only as `external:qa_verdict` plus the
 * file's digest, and optionally a committed sidecar beside the packet.
 */
function writeExternalPriorRun({ runId, mapId, verdict, sha256, createdAt = "2026-09-14T10:00:00.000Z", disposition = null, sidecar = null }) {
  const packetDir = scratch();
  const targetRepo = scratch();
  const verdictDir = join(targetRepo, `qa-output/${mapId}`);
  mkdirSync(verdictDir, { recursive: true });
  const verdictPath = join(verdictDir, `${verdict.run_id}.json`);
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  const recordsDir = join(packetDir, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(
    join(recordsDir, `${runId}.json`),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: runId,
      created_at: createdAt,
      identity: { map_id: mapId, campaign_slug: null, template_family: null, entry_point_shape: "packet" },
      artifacts: [{ kind: "qa_verdict", path: "external:qa_verdict", schema_version: "1.0", sha256: sha256 === undefined ? sha256Of(verdictPath) : sha256 }],
      observations: disposition ? { qa: { disposition, gap_classes: [] } } : {},
    }, null, 2)}\n`,
  );
  if (sidecar) {
    writeFileSync(join(recordsDir, "../qa-verdict.json"), `${JSON.stringify(sidecar, null, 2)}\n`);
  }
  return { packetDir, targetRepo, verdictPath };
}

test("a previous run whose verdict lives under a separate target repo is compared against, through the recorded digest", () => {
  const prior = { run_id: "qa_final", campaign_slug: "map-1", assertions: [finding({ id: "http:checkout" })] };
  const { packetDir, targetRepo, verdictPath } = writeExternalPriorRun({ runId: "run_1757000000000_aaaaaaaa", mapId: "map-1", verdict: prior });

  const lookup = loadPriorQaVerdict({ baseDir: packetDir, targetRepo, mapId: "map-1" });
  assert.equal(lookup.reason, null);
  assert.equal(lookup.path, verdictPath);
  assert.equal(lookup.verdict.run_id, "qa_final");

  const assertions = [finding({ id: "http:checkout" }), finding({ id: "http:upsell1", page: "upsell1" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: packetDir, targetRepo, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(summary.comparison, "prior_run");
  assert.equal(summary.prior_run_id, "run_1757000000000_aaaaaaaa");
  assert.equal(summary.prior_qa_attempt_run_id, "qa_final");
  assert.equal(assertions[0].cause, CAUSE_CLASSES.PRE_EXISTING);
  assert.equal(assertions[1].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
});

test("the digest picks the referenced verdict, not a neighbouring attempt under the same target repo", () => {
  const referenced = { run_id: "qa_final", campaign_slug: "map-1", assertions: [] };
  const { packetDir, targetRepo } = writeExternalPriorRun({ runId: "run_1757000000000_aaaaaaaa", mapId: "map-1", verdict: referenced });
  // A later, unrecorded attempt beside it that DOES carry the finding.
  writeFileSync(
    join(targetRepo, "qa-output/map-1/qa_later.json"),
    `${JSON.stringify({ run_id: "qa_later", campaign_slug: "map-1", assertions: [finding({ id: "http:checkout" })] })}\n`,
  );
  const assertions = [finding({ id: "http:checkout" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: packetDir, targetRepo, mapId: "map-1", isFinding: isFindingAssertion });
  assert.equal(summary.prior_qa_attempt_run_id, "qa_final");
  assert.equal(assertions[0].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
});

test("the committed sidecar is never a stand-in: a projection cannot be tied to the referenced attempt", () => {
  // The full verdict is gone from the target repo (digest matches nothing),
  // and the sidecar beside the packet is a projection of an EARLIER attempt
  // (restored by qa promote) that still carried a finding the recorded final
  // attempt had fixed. Comparing against it would call the regression
  // pre-existing.
  const sidecar = {
    run_id: "qa_attempt_1",
    campaign_slug: "map-1",
    completed_at: "2026-09-14T09:59:00.000Z",
    disposition: "blocked",
    assertions: [finding({ id: "http:checkout" })],
  };
  const { packetDir, targetRepo } = writeExternalPriorRun({
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_other", campaign_slug: "map-1", assertions: [] },
    sha256: "0".repeat(64),
    createdAt: "2026-09-14T10:00:00.000Z",
    disposition: "blocked",
    sidecar,
  });
  const lookup = loadPriorQaVerdict({ baseDir: packetDir, targetRepo, mapId: "map-1", currentRunId: "run_current" });
  assert.equal(lookup.verdict, null);
  assert.equal(lookup.reason, "prior_run_verdict_unlocated");
  const assertions = [finding({ id: "http:checkout" })];
  const summary = annotateQaAssertionCauses(assertions, { baseDir: packetDir, targetRepo, mapId: "map-1", currentRunId: "run_current", isFinding: isFindingAssertion });
  assert.equal(summary.comparison, "prior_run_verdict_unlocated");
  assert.equal(assertions[0].cause, CAUSE_CLASSES.UNKNOWN);
});

test("a reference without a digest cannot be located, even when one verdict sits under the target repo", () => {
  const { packetDir, targetRepo } = writeExternalPriorRun({
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_final", campaign_slug: "map-1", assertions: [] },
    sha256: null,
  });
  const lookup = loadPriorQaVerdict({ baseDir: packetDir, targetRepo, mapId: "map-1" });
  assert.equal(lookup.verdict, null);
  assert.equal(lookup.reason, "prior_run_verdict_unlocated");
});

test("an external reference that resolves nowhere names its own reason, never 'references no QA verdict'", () => {
  const { packetDir } = writeExternalPriorRun({
    runId: "run_1757000000000_aaaaaaaa",
    mapId: "map-1",
    verdict: { run_id: "qa_final", campaign_slug: "map-1", assertions: [] },
  });
  // No target repo known at all: nothing to search by digest.
  const lookup = loadPriorQaVerdict({ baseDir: packetDir, mapId: "map-1" });
  assert.equal(lookup.verdict, null);
  assert.equal(lookup.reason, "prior_run_verdict_unlocated");
  const line = formatCauseBasisLine({ comparison: lookup.reason, prior_run_id: lookup.record.run_id });
  assert.match(line, /references a QA verdict written outside the packet directory/);
  assert.doesNotMatch(line, /references no QA verdict/);
  // A record with no qa_verdict artifact at all keeps the original reason.
  const bare = scratch();
  mkdirSync(join(bare, ".campaign-runtime/run-records"), { recursive: true });
  writeFileSync(
    join(bare, ".campaign-runtime/run-records/run_1757000000000_bbbbbbbb.json"),
    `${JSON.stringify({ schema_version: "campaigns-os-run-record/v0", run_id: "run_1757000000000_bbbbbbbb", identity: { map_id: "map-1" }, artifacts: [], observations: {} })}\n`,
  );
  assert.equal(loadPriorQaVerdict({ baseDir: bare, mapId: "map-1" }).reason, "prior_run_without_qa_verdict");
});
