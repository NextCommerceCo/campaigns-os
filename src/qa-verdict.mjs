export const QA_SCHEMA_VERSION = "1.0";

export const STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  WARN: "warn",
  SKIPPED: "skipped",
  MANUAL_REVIEW: "manual_review",
});

export const SEVERITY = Object.freeze({
  INFO: "info",
  WARN: "warn",
  BLOCKER: "blocker",
});

export function computeDisposition(assertions) {
  let hasBlocker = false;
  let hasSoftIssue = false;
  for (const assertion of assertions) {
    if (assertion.status === STATUS.FAIL && assertion.severity === SEVERITY.BLOCKER) {
      hasBlocker = true;
    } else if (
      assertion.status === STATUS.WARN ||
      assertion.status === STATUS.MANUAL_REVIEW ||
      (assertion.status === STATUS.FAIL && assertion.severity === SEVERITY.WARN)
    ) {
      hasSoftIssue = true;
    }
  }
  if (hasBlocker) return "blocked";
  if (hasSoftIssue) return "ready_with_exceptions";
  return "ready";
}

export function createVerdict({
  runId,
  mapId,
  campaignRefId = null,
  specVersion,
  specHash,
  startedAt,
  completedAt,
  runtime,
  operator = "",
  assertions,
  testOrders = [],
  exceptions = [],
}) {
  return {
    schema_version: QA_SCHEMA_VERSION,
    run_id: runId,
    campaign_slug: mapId,
    campaign_ref_id: campaignRefId,
    spec_version: specVersion,
    spec_hash: specHash,
    started_at: startedAt,
    completed_at: completedAt,
    runtime,
    operator,
    disposition: computeDisposition(assertions),
    assertions,
    test_orders: testOrders,
    exceptions,
  };
}

export function validateVerdict(verdict) {
  const errors = [];
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    return ["verdict: must be an object"];
  }
  for (const field of ["run_id", "campaign_slug", "spec_version", "spec_hash", "started_at", "completed_at", "runtime", "disposition"]) {
    if (typeof verdict[field] !== "string" || verdict[field].length === 0) errors.push(`${field}: required non-empty string`);
  }
  if (verdict.schema_version !== QA_SCHEMA_VERSION) errors.push(`schema_version: expected ${QA_SCHEMA_VERSION}`);
  if (!Array.isArray(verdict.assertions)) errors.push("assertions: must be an array");
  if (!Array.isArray(verdict.test_orders)) errors.push("test_orders: must be an array");
  if (!Array.isArray(verdict.exceptions)) errors.push("exceptions: must be an array");
  return errors;
}
