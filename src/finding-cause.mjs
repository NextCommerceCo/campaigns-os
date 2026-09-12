// Per-finding cause class — "did the change under test cause this?"
//
// A run that surfaces eleven findings, none of them caused by the change being
// tested, reads exactly like a run that broke eleven things. The operator has
// no mechanical way to tell the two apart, so every bump run ends in a manual
// read of every finding. This module attaches one cause class to each finding
// so the answer is on the report.
//
// Deliberately mechanical. Every class here is derived from something the
// toolkit ALREADY records: the assertion identity the verdict already uses to
// derive exceptions, the doctor issue codes the Run Record already snapshots,
// the runner's own environment markers, and the SDK-pin checkpoint the doctor
// already evaluates. Nothing is inferred from message text, severity, or
// plausibility. When no class can be assigned from recorded data the answer is
// `unknown` with a reason, never a guess.

export const CAUSE_CLASSES = Object.freeze({
  CAUSED_BY_CHANGE: "caused_by_change",
  PRE_EXISTING: "pre_existing",
  TEST_ENVIRONMENT: "test_environment",
  UPSTREAM_DRIFT: "upstream_drift",
  UNKNOWN: "unknown",
});

// Report order: the class an operator is looking for first comes first.
export const CAUSE_CLASS_VOCABULARY = Object.freeze([
  CAUSE_CLASSES.CAUSED_BY_CHANGE,
  CAUSE_CLASSES.PRE_EXISTING,
  CAUSE_CLASSES.TEST_ENVIRONMENT,
  CAUSE_CLASSES.UPSTREAM_DRIFT,
  CAUSE_CLASSES.UNKNOWN,
]);

export const CAUSE_CLASS_LABELS = Object.freeze({
  [CAUSE_CLASSES.CAUSED_BY_CHANGE]: "caused by this change",
  [CAUSE_CLASSES.PRE_EXISTING]: "pre-existing",
  [CAUSE_CLASSES.TEST_ENVIRONMENT]: "test environment",
  [CAUSE_CLASSES.UPSTREAM_DRIFT]: "upstream drift",
  [CAUSE_CLASSES.UNKNOWN]: "unknown",
});

// Doctor issue codes that ARE an already-detected version disagreement between
// what the CampaignSpec pins and what the target carries. Enumerated, not
// prefix-matched: the sibling `page_kit.sdk_version.spec_missing` /
// `.target_missing` / `.waiver_inert` codes are configuration gaps and waiver
// hygiene, not drift, and calling them drift would tell an operator the
// upstream moved when it did not.
export const UPSTREAM_DRIFT_DOCTOR_CODES = Object.freeze([
  // observed target SDK version != the CampaignSpec pin (the blocking form)
  "page_kit.sdk_version",
  // the same disagreement, accepted under a named-human waiver
  "page_kit.sdk_version.waived",
  // two spec-side declarations of the pin disagree with each other
  "page_kit.sdk_version.spec_conflict",
]);

const UPSTREAM_DRIFT_DOCTOR_CODE_SET = new Set(UPSTREAM_DRIFT_DOCTOR_CODES);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Stable identity for one QA assertion.
 *
 * Reuses the identity the verdict already projects in deriveExceptions —
 * family, id, page — and nothing else. `url` is deliberately excluded: the
 * same campaign QA'd locally and then against its published deploy produces
 * different URLs for the identical assertion, and including it would report
 * every finding of the published run as new.
 */
export function qaAssertionFingerprint(assertion) {
  return `qa:${text(assertion?.family)}|${text(assertion?.id)}|${text(assertion?.page)}`;
}

/**
 * Stable identity for one doctor issue.
 *
 * Code granularity, because the code is what the Run Record already snapshots
 * (observations.doctor.error_codes / warning_codes) and therefore the only
 * doctor identity a previous run can be compared against. Two distinct
 * violations sharing a code are one finding to this comparison.
 */
export function doctorIssueFingerprint(issue) {
  return `doctor:${text(issue?.code)}`;
}

/**
 * Environment classification for a QA assertion, using the runner's own
 * markers only:
 *   - the order-creation budget safety stop, which the runner records as
 *     `evidence.order_creation_budget` and which is explicitly not a broken
 *     checkout;
 *   - a `<leg>:runner` assertion, the id the analytics and test-order legs
 *     emit when the capture itself failed to complete rather than when the
 *     page was wrong.
 * Returns a reason string, or null when the assertion is not environmental.
 */
export function qaEnvironmentReason(assertion) {
  const evidence = assertion?.evidence;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence) && evidence.order_creation_budget) {
    return "order_creation_budget_stop";
  }
  if (text(assertion?.id).endsWith(":runner")) return "runner_capture_failure";
  return null;
}

/**
 * Upstream-drift classification for a doctor issue: true only for the codes
 * the SDK-pin checkpoint already emits for an observed-vs-declared version
 * disagreement.
 */
export function doctorUpstreamDriftReason(issue) {
  return UPSTREAM_DRIFT_DOCTOR_CODE_SET.has(text(issue?.code)) ? "sdk_pin_disagreement" : null;
}

/**
 * The prior-run comparison set: a Map of fingerprint -> status. `status` is
 * whatever the surface calls a status ("fail"/"warn"/... for QA,
 * "error"/"warning" for doctor). Same fingerprint AND same status is
 * pre-existing; a fingerprint whose status moved is not.
 */
export function priorSetFromEntries(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    const fingerprint = text(entry?.fingerprint);
    if (!fingerprint) continue;
    if (!map.has(fingerprint)) map.set(fingerprint, text(entry?.status));
  }
  return map;
}

/** Prior comparison set built from a previous run's QA verdict object. */
export function priorSetFromVerdict(verdict, { isFinding }) {
  const assertions = Array.isArray(verdict?.assertions) ? verdict.assertions : [];
  return priorSetFromEntries(
    assertions
      .filter((assertion) => assertion && typeof assertion === "object" && isFinding(assertion))
      .map((assertion) => ({ fingerprint: qaAssertionFingerprint(assertion), status: assertion.status })),
  );
}

/**
 * Prior comparison set built from a previous Run Record's doctor observations.
 * These are code lists the record already carries, so this works against every
 * Run Record ever written — no new field, no upgrade window.
 */
export function priorSetFromRunRecordDoctor(record) {
  const doctor = record?.observations?.doctor;
  if (!doctor || typeof doctor !== "object") return null;
  const entries = [];
  for (const code of Array.isArray(doctor.error_codes) ? doctor.error_codes : []) {
    entries.push({ fingerprint: `doctor:${text(code)}`, status: "error" });
  }
  for (const code of Array.isArray(doctor.warning_codes) ? doctor.warning_codes : []) {
    entries.push({ fingerprint: `doctor:${text(code)}`, status: "warning" });
  }
  return priorSetFromEntries(entries);
}

/**
 * The classification itself, for one finding. `prior` is a Map from
 * priorSetFromEntries, or null when no previous run was found.
 *
 * Order is load-bearing. Environment and upstream drift are decided first,
 * because a finding the runner already knows is environmental stays
 * environmental whether or not it also happened last time — labelling a
 * Chromium failure "pre-existing" would tell the operator the campaign is at
 * fault. Only then does the previous-run comparison run.
 */
export function classifyFinding({ fingerprint, status, environmentReason = null, upstreamDriftReason = null, prior = null, noPriorReason = "no_prior_run" }) {
  if (environmentReason) {
    return { cause: CAUSE_CLASSES.TEST_ENVIRONMENT, cause_reason: environmentReason };
  }
  if (upstreamDriftReason) {
    return { cause: CAUSE_CLASSES.UPSTREAM_DRIFT, cause_reason: upstreamDriftReason };
  }
  if (!prior) {
    return { cause: CAUSE_CLASSES.UNKNOWN, cause_reason: noPriorReason };
  }
  if (!prior.has(fingerprint)) {
    return { cause: CAUSE_CLASSES.CAUSED_BY_CHANGE, cause_reason: "new_since_prior_run" };
  }
  const priorStatus = prior.get(fingerprint);
  const currentStatus = text(status);
  if (priorStatus === currentStatus) {
    return { cause: CAUSE_CLASSES.PRE_EXISTING, cause_reason: "same_status_in_prior_run" };
  }
  return {
    cause: CAUSE_CLASSES.CAUSED_BY_CHANGE,
    cause_reason: `status_changed_since_prior_run:${priorStatus || "unknown"}->${currentStatus || "unknown"}`,
  };
}

/** Classify one QA assertion. Mutates nothing; returns the cause fields. */
export function classifyQaAssertion(assertion, { prior = null, noPriorReason = "no_prior_run" } = {}) {
  return classifyFinding({
    fingerprint: qaAssertionFingerprint(assertion),
    status: assertion?.status,
    environmentReason: qaEnvironmentReason(assertion),
    prior,
    noPriorReason,
  });
}

/** Classify one doctor issue. `status` is "error" or "warning". */
export function classifyDoctorIssue(issue, status, { prior = null, noPriorReason = "no_prior_run" } = {}) {
  return classifyFinding({
    fingerprint: doctorIssueFingerprint(issue),
    status,
    upstreamDriftReason: doctorUpstreamDriftReason(issue),
    prior,
    noPriorReason,
  });
}

/**
 * Count findings by cause class. `total` is the number of findings counted,
 * which is the number the summary line leads with — an operator comparing
 * "11 findings" against the per-class counts must be able to add them up.
 */
export function summarizeCauses(findings = []) {
  const counts = Object.fromEntries(CAUSE_CLASS_VOCABULARY.map((cause) => [cause, 0]));
  let total = 0;
  for (const finding of findings) {
    const cause = text(finding?.cause);
    if (!cause) continue;
    total += 1;
    if (cause in counts) counts[cause] += 1;
  }
  return { total, counts };
}

/**
 * The one-line report header. Reads as prose, not as a JSON dump, and names
 * the previous run when there was one so the comparison is checkable.
 */
export function formatCauseSummaryLine(summary, { priorRunId = null } = {}) {
  if (!summary || !summary.total) return "Causes: no findings.";
  const parts = CAUSE_CLASS_VOCABULARY
    .filter((cause) => summary.counts[cause] > 0)
    .map((cause) => `${summary.counts[cause]} ${CAUSE_CLASS_LABELS[cause]}`);
  const compared = priorRunId ? ` (compared against run ${priorRunId})` : " (no previous run to compare against)";
  return `Causes: ${summary.total} finding${summary.total === 1 ? "" : "s"} — ${parts.join(", ")}${compared}.`;
}

/** The short per-finding tag the report prints beside each finding. */
export function formatCauseTag(finding) {
  const cause = text(finding?.cause);
  if (!cause) return "";
  const label = CAUSE_CLASS_LABELS[cause] || cause;
  const reason = text(finding?.cause_reason);
  return reason ? `[${label}: ${reason}]` : `[${label}]`;
}

// ---------------------------------------------------------------------------
// Previous-run lookup.
//
// Reuses the existing Run Record discovery (readRunRecordsForTarget, which
// orders `.campaign-runtime/run-records/` newest-first by minted run id and
// swallows unreadable files). No second scanner, no second ordering rule.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { readRunRecordsForTarget } from "./run-record.mjs";

/**
 * The most recent Run Record for the same campaign identity under `baseDir`,
 * or null. Records are discovered newest-first, and the current run's record
 * does not exist yet at classification time (both `qa run` and `doctor`
 * complete before `run-record` assembles anything), so the first identity
 * match is the previous run. `currentRunId` is skipped anyway, defensively.
 *
 * Only the FIRST identity match is considered. Walking further back to find a
 * record that happens to carry usable evidence would silently compare this run
 * against a non-adjacent one and report findings introduced in between as
 * pre-existing.
 */
export function findPriorRunRecord({ baseDir, mapId = null, currentRunId = null } = {}) {
  if (!text(baseDir)) return null;
  for (const entry of readRunRecordsForTarget(baseDir)) {
    const record = entry?.record;
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (currentRunId && record.run_id === currentRunId) continue;
    if (text(mapId) && text(record.identity?.map_id) !== text(mapId)) continue;
    return record;
  }
  return null;
}

function resolveArtifactPath(baseDir, artifactPath) {
  const value = text(artifactPath);
  // `external:<kind>` is what the Run Record writes when the artifact lived
  // outside the packet directory; there is no path to re-open.
  if (!value || value.startsWith("external:")) return null;
  return isAbsolute(value) ? value : resolvePath(baseDir, value);
}

/**
 * The previous run's QA verdict, reached through that run's own Run Record
 * artifact reference. Returns `{ verdict, record, path, reason }`; `verdict`
 * is null whenever `reason` is set.
 */
export function loadPriorQaVerdict({ baseDir, mapId = null, currentRunId = null } = {}) {
  const record = findPriorRunRecord({ baseDir, mapId, currentRunId });
  if (!record) return { verdict: null, record: null, path: null, reason: "no_prior_run" };
  const ref = (Array.isArray(record.artifacts) ? record.artifacts : []).find((artifact) => artifact?.kind === "qa_verdict");
  const path = ref ? resolveArtifactPath(baseDir, ref.path) : null;
  if (!path) return { verdict: null, record, path: null, reason: "prior_run_without_qa_verdict" };
  try {
    if (!existsSync(path) || !statSync(path).isFile()) {
      return { verdict: null, record, path, reason: "prior_run_verdict_unreadable" };
    }
    const verdict = JSON.parse(readFileSync(path, "utf8"));
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict) || !Array.isArray(verdict.assertions)) {
      return { verdict: null, record, path, reason: "prior_run_verdict_unreadable" };
    }
    return { verdict, record, path, reason: null };
  } catch {
    return { verdict: null, record, path, reason: "prior_run_verdict_unreadable" };
  }
}

/**
 * The previous run's doctor findings, read from the Run Record's own doctor
 * observations (error_codes / warning_codes). Every Run Record ever written
 * carries these, so doctor cause labels work against existing history with no
 * upgrade window. Returns `{ prior, record, reason }`.
 */
export function loadPriorDoctorFindings({ baseDir, mapId = null, currentRunId = null } = {}) {
  const record = findPriorRunRecord({ baseDir, mapId, currentRunId });
  if (!record) return { prior: null, record: null, reason: "no_prior_run" };
  const prior = priorSetFromRunRecordDoctor(record);
  if (!prior) return { prior: null, record, reason: "prior_run_without_doctor_observations" };
  return { prior, record, reason: null };
}

// ---------------------------------------------------------------------------
// The QA wiring: classify one run's findings in place and return the summary
// the report leads with.
// ---------------------------------------------------------------------------

/**
 * Stamp `cause` and `cause_reason` onto every FINDING assertion in `assertions`
 * (passes are left alone — a passing assertion has no cause to explain), and
 * return the summary block for the verdict.
 *
 * `baseDir` is the Build Packet directory, the same root the Run Record uses.
 * Packet-less runs (`--site`, raw map id) have no Run Record home, so they get
 * `unknown` / `no_prior_run` throughout — which is the truth, not a silence.
 */
export function annotateQaAssertionCauses(assertions, { baseDir = null, mapId = null, currentRunId = null, isFinding } = {}) {
  const lookup = baseDir
    ? loadPriorQaVerdict({ baseDir, mapId, currentRunId })
    : { verdict: null, record: null, path: null, reason: "no_prior_run" };
  const prior = lookup.verdict ? priorSetFromVerdict(lookup.verdict, { isFinding }) : null;
  const noPriorReason = lookup.reason || "no_prior_run";
  const findings = [];
  for (const assertion of Array.isArray(assertions) ? assertions : []) {
    if (!assertion || typeof assertion !== "object" || !isFinding(assertion)) continue;
    const { cause, cause_reason } = classifyQaAssertion(assertion, { prior, noPriorReason });
    assertion.cause = cause;
    assertion.cause_reason = cause_reason;
    findings.push(assertion);
  }
  const { total, counts } = summarizeCauses(findings);
  return {
    schema_version: CAUSE_SUMMARY_SCHEMA,
    total,
    counts,
    prior_run_id: text(lookup.verdict?.run_id) || null,
    comparison: lookup.verdict ? "prior_run" : noPriorReason,
  };
}

export const CAUSE_SUMMARY_SCHEMA = "campaigns-os-finding-cause/v0";

/**
 * The doctor twin. `errors` and `warnings` are the doctor output's own arrays;
 * both are stamped in place. Returns the same summary shape.
 */
export function annotateDoctorIssueCauses({ errors = [], warnings = [], baseDir = null, mapId = null, currentRunId = null } = {}) {
  const lookup = baseDir
    ? loadPriorDoctorFindings({ baseDir, mapId, currentRunId })
    : { prior: null, record: null, reason: "no_prior_run" };
  const noPriorReason = lookup.reason || "no_prior_run";
  const findings = [];
  const stamp = (issues, status) => {
    for (const issue of Array.isArray(issues) ? issues : []) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const { cause, cause_reason } = classifyDoctorIssue(issue, status, { prior: lookup.prior, noPriorReason });
      issue.cause = cause;
      issue.cause_reason = cause_reason;
      findings.push(issue);
    }
  };
  stamp(errors, "error");
  stamp(warnings, "warning");
  const { total, counts } = summarizeCauses(findings);
  return {
    schema_version: CAUSE_SUMMARY_SCHEMA,
    total,
    counts,
    prior_run_id: text(lookup.record?.run_id) || null,
    comparison: lookup.prior ? "prior_run" : noPriorReason,
  };
}
