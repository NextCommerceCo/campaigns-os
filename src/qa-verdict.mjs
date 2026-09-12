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

// Canonical vocabulary of every assertion family the QA runner emits. External
// consumers (e.g. the portal proxy's verdict allowlist) import this instead of
// scanning emitter source for `family:` literals. Order is load-bearing:
// theme_gate first, then the gate-suppressed families in the order a
// gate-blocked verdict emits its skipped audit assertions —
// GATE_SUPPRESSED_FAMILIES in qa-node.mjs derives from this list. A drift test
// in qa-verdict.test.mjs asserts set equality against the literals the
// emitters actually use.
export const QA_ASSERTION_FAMILY_VOCABULARY = Object.freeze([
  "theme_gate",
  "polish_gate",
  "funnel-flow",
  "meta-tags",
  "api-metadata",
  "browser-runtime",
  "template_residue",
  "pricing",
  "browser-test-order",
  "browser-receipt-rendering",
  "analytics-correctness",
  "analytics-parity",
  "parity-capture",
]);

// A waiver record riding an assertion (packet 01: the `qa waive` lane for
// analytics-correctness:purchase-fires). Shape mirrors report.theme.waiver:
// { reason, waived_by, waived_at }.
function assertionCarriesWaiver(assertion) {
  const waiver = assertion?.waiver;
  return !!(waiver && typeof waiver === "object" && !Array.isArray(waiver));
}

export function computeDisposition(assertions) {
  let hasBlocker = false;
  let hasSoftIssue = false;
  for (const assertion of assertions) {
    if (assertion.status === STATUS.FAIL && assertion.severity === SEVERITY.BLOCKER) {
      hasBlocker = true;
    } else if (
      assertion.status === STATUS.WARN ||
      assertion.status === STATUS.MANUAL_REVIEW ||
      (assertion.status === STATUS.FAIL && assertion.severity === SEVERITY.WARN) ||
      // Packet 01 / ratified I-9: a waived blocker is an accepted exception,
      // never a clean pass — any assertion carrying a waiver record keeps the
      // disposition at ready_with_exceptions, never plain ready. (An unwaived
      // failing blocker still lands in the branch above and blocks.)
      assertionCarriesWaiver(assertion)
    ) {
      hasSoftIssue = true;
    }
  }
  if (hasBlocker) return "blocked";
  if (hasSoftIssue) return "ready_with_exceptions";
  return "ready";
}

function dispositionWithCommercial(assertions, commercial) {
  const disposition = computeDisposition(assertions);
  if (disposition === "blocked") return disposition;
  return commercial?.status === "mismatch"
    ? "ready_with_exceptions"
    : disposition;
}

export function createVerdict({
  runId,
  mapId,
  publicRouteSlug = null,
  campaignRefId = null,
  specVersion,
  specHash,
  startedAt,
  completedAt,
  runtime,
  operator = "",
  baseUrl = null,
  entryUrls = [],
  pageUrls = [],
  testedUrls = [],
  assertions,
  testOrders = [],
  exceptions = null,
  commercial = null,
  causeSummary = null,
}) {
  const normalizedExceptions = Array.isArray(exceptions)
    ? exceptions
    : deriveExceptions(assertions);
  const normalizedBaseUrl = optionalString(baseUrl);
  const normalizedEntryUrls = Array.isArray(entryUrls) ? entryUrls : [];
  const normalizedPageUrls = Array.isArray(pageUrls) ? pageUrls : [];
  const normalizedTestedUrls = Array.isArray(testedUrls) ? testedUrls : [];
  return {
    schema_version: QA_SCHEMA_VERSION,
    run_id: runId,
    // campaign_slug carries the Map ID for schema back-compat; the true public
    // route slug rides alongside so consumers stop conflating the two.
    campaign_slug: mapId,
    public_route_slug: optionalString(publicRouteSlug),
    campaign_ref_id: campaignRefId,
    spec_version: specVersion,
    spec_hash: specHash,
    started_at: startedAt,
    completed_at: completedAt,
    runtime,
    operator,
    ...(normalizedBaseUrl ? { base_url: normalizedBaseUrl } : {}),
    entry_urls: normalizedEntryUrls,
    page_urls: normalizedPageUrls,
    tested_urls: normalizedTestedUrls,
    disposition: dispositionWithCommercial(assertions, commercial),
    assertions,
    test_orders: testOrders,
    exceptions: normalizedExceptions,
    ...(commercial && typeof commercial === "object" && !Array.isArray(commercial)
      ? { commercial }
      : {}),
    // Additive, and absent on verdicts emitted before per-finding cause
    // classification existed. Consumers must tolerate its absence rather than
    // read a missing summary as "nothing was caused by the change".
    ...(causeSummary && typeof causeSummary === "object" && !Array.isArray(causeSummary)
      ? { cause_summary: causeSummary }
      : {}),
  };
}

function optionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Is this assertion a FINDING — something the operator has to look at — rather
 * than a clean pass? One definition, because the exception projection and the
 * per-finding cause classification must count the same set: a summary that
 * says "11 findings, 9 pre-existing" is unreadable if "finding" means one
 * thing in the count and another in the list.
 */
export function isFindingAssertion(assertion) {
  return assertion?.status === STATUS.FAIL
    || assertion?.status === STATUS.WARN
    || assertion?.status === STATUS.MANUAL_REVIEW
    || assertion?.severity === SEVERITY.WARN
    || assertion?.severity === SEVERITY.BLOCKER;
}

export function deriveExceptions(assertions = []) {
  if (!Array.isArray(assertions)) return [];
  return assertions
    .filter((assertion) => isFindingAssertion(assertion))
    .map((assertion) => ({
      id: assertion.id || null,
      family: assertion.family || null,
      page: assertion.page || null,
      url: assertion.url || null,
      status: assertion.status || null,
      severity: assertion.severity || null,
      expected: assertion.expected,
      actual: assertion.actual,
      // Cause rides the projection so the exceptions list — the quick read an
      // operator or portal actually looks at — answers "was this us?" without
      // re-joining back to the assertions array.
      ...(assertion.cause !== undefined ? { cause: assertion.cause } : {}),
      ...(assertion.cause_reason !== undefined ? { cause_reason: assertion.cause_reason } : {}),
    }));
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
  if (verdict.commercial !== undefined
    && (!verdict.commercial || typeof verdict.commercial !== "object" || Array.isArray(verdict.commercial))) {
    errors.push("commercial: must be an object when present");
  }
  return errors;
}

// Purchase-proof coverage summary.
//
// COUNTS ONLY, deliberately. This summary is written onto the Assembly Report's
// qa stage, which is committed and rides into the readback bundle. The sidecar
// projection strips order ids, refs, emails and checkout URLs out of the verdict
// before it can be published, and sidecar-bundle conformance FAILS a bundle
// whose projected order arrays are non-empty. So the signal that a purchase
// actually happened has to be numbers, never the orders themselves.
export function summarizePurchaseProof({ verdict = null, proofPolicy = null } = {}) {
  const orders = Array.isArray(verdict?.test_orders) ? verdict.test_orders.filter((order) => order && typeof order === "object") : [];
  // A real id is a non-empty trimmed string or a POSITIVE number. Numeric `0`
  // is the conventional placeholder the runner emits when an id was never
  // received, and `Number.isFinite(0)` is true — counting it would report an
  // order as created on a run that created nothing. Note the `??` chain stops
  // at a literal `0` (it is not nullish), so a zero here is never rescued by
  // the next field either; both facts push the same way, toward not counting.
  const created = orders.filter((order) => {
    const id = order.next_order_id ?? order.order_id ?? order.ref_id;
    if (typeof id === "string") return id.trim().length > 0;
    return Number.isFinite(id) && id > 0;
  });
  return {
    declared_order_path_depth: optionalString(proofPolicy?.order_path_depth),
    declared_typed_card_depth: optionalString(proofPolicy?.typed_card_depth),
    order_paths_executed: orders.length,
    orders_created: created.length,
    orders_verified: orders.filter((order) => order.verification?.verified === true).length,
    // null, not false, when nothing ran: "no order was out of test mode" and
    // "no order ran at all" are different facts.
    all_orders_test_mode: orders.length ? orders.every((order) => order.is_test === true) : null,
  };
}
