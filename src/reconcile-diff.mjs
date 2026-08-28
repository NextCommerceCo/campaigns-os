/**
 * Plan + normalized snapshot -> field matrix, verdicts, and report envelope.
 *
 * Exact-only comparison semantics, following commercial-parity: no fuzzy
 * matching, no "close enough" on money, no inference. A row the reconciler
 * cannot decide says so rather than guessing.
 *
 * Contract: docs/reconcile-comparison-matrix-v0.md
 */

import { createHash } from "node:crypto";

import {
  PACKAGE_FIELDS,
  UNSUPPORTED_RESOURCES,
  planReconciliation,
} from "./reconcile-plan.mjs";
import {
  nfcTrim,
  normalizeCodeSet,
  normalizeMoney,
  normalizeSnapshot,
} from "./reconcile-normalize.mjs";

export const RECONCILE_REPORT_SCHEMA_VERSION = "campaigns-os-reconcile-report/v0";

export const VERDICT = Object.freeze({
  MATCHED: "matched",
  CHANGED: "changed",
  MISSING_LIVE: "missing_live",
  EXTRA_LIVE: "extra_live",
  UNRESOLVED_BINDING: "unresolved_binding",
  UNSUPPORTED: "unsupported",
  NOT_ASSERTED: "not_asserted",
});

export const OUTCOME = Object.freeze({
  CLEAN: "reconciled_no_asserted_differences",
  DIFFERENCES: "reconciled_with_differences",
  INCONCLUSIVE: "inconclusive",
});

/** Verdicts that represent an asserted difference the operator must act on. */
const DIFFERENCE_VERDICTS = new Set([
  VERDICT.CHANGED,
  VERDICT.MISSING_LIVE,
  VERDICT.UNRESOLVED_BINDING,
]);

/** Verdicts that were accounted but not judged — they never reduce coverage. */
const ACCOUNTED_VERDICTS = new Set([VERDICT.UNSUPPORTED, VERDICT.NOT_ASSERTED]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** Deterministic canonical JSON: sorted keys, no incidental whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Of(value) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function matrixRow(field, scope, verdict, extra = {}) {
  return { field, scope, verdict, ...extra };
}

function compareScalar(field, scope, expected, observed, { normalize = nfcTrim } = {}) {
  const desired = normalize(expected);
  const live = normalize(observed);
  if (!present(desired)) return matrixRow(field, scope, VERDICT.NOT_ASSERTED, { observed: live });
  if (live === null || live === undefined) {
    return matrixRow(field, scope, VERDICT.MISSING_LIVE, { desired });
  }
  return desired === live
    ? matrixRow(field, scope, VERDICT.MATCHED, { desired, observed: live })
    : matrixRow(field, scope, VERDICT.CHANGED, { desired, observed: live });
}

function compareCodeSet(field, scope, expected, observed) {
  const desired = normalizeCodeSet(expected);
  const live = normalizeCodeSet(observed);
  if (desired.length === 0) return matrixRow(field, scope, VERDICT.NOT_ASSERTED, { observed: live });
  const equal = desired.length === live.length && desired.every((code, i) => code === live[i]);
  return equal
    ? matrixRow(field, scope, VERDICT.MATCHED, { desired, observed: live })
    : matrixRow(field, scope, VERDICT.CHANGED, { desired, observed: live });
}

function settingsRows(spec, snapshot) {
  const campaign = spec?.campaign ?? {};
  const live = snapshot.campaign ?? {};
  const rows = [];
  rows.push(compareScalar("name", "campaign", campaign.name, live.name));
  rows.push(compareCodeSet("currency", "campaign", campaign.currency, live.currency));

  // The spec lists every currency including the default; the API splits the
  // default out into `currency` and reports only the rest here.
  const additionalDesired = normalizeCodeSet(campaign.available_currencies)
    .filter((code) => code !== nfcTrim(campaign.currency));
  rows.push(
    additionalDesired.length === 0 && normalizeCodeSet(live.additional_currencies).length === 0
      ? matrixRow("additional_currencies", "campaign", VERDICT.MATCHED, { desired: [], observed: [] })
      : compareCodeSet("additional_currencies", "campaign", additionalDesired, live.additional_currencies),
  );

  rows.push(compareScalar("language", "campaign", campaign.language, live.language));
  rows.push(compareCodeSet(
    "available_shipping_countries", "campaign",
    campaign.available_shipping_countries, live.available_shipping_countries,
  ));
  rows.push(compareCodeSet(
    "available_payment_methods", "campaign",
    campaign.available_payment_methods, live.available_payment_methods,
  ));
  rows.push(compareCodeSet(
    "available_express_payment_methods", "campaign",
    campaign.available_express_payment_methods, live.available_express_payment_methods,
  ));

  // Observable, inexpressible in the spec. Reported as evidence, never judged.
  rows.push(matrixRow("paypal_account_id", "campaign", VERDICT.NOT_ASSERTED, {
    observed: live.paypal_account_id ?? null,
  }));
  rows.push(matrixRow("statement_descriptor", "campaign", VERDICT.NOT_ASSERTED, {
    observed: live.statement_descriptor ?? null,
  }));
  rows.push(matrixRow("payment_gateway_group", "campaign", VERDICT.NOT_ASSERTED, {
    observed: live.payment_gateway_group ?? null,
    note: "observable but inexpressible in CampaignSpec",
  }));
  return rows;
}

function packageRows(plan, spec, snapshot) {
  const rows = [];
  const liveById = new Map(snapshot.packages.map((pkg) => [String(pkg.id), pkg]));
  const referencedIds = new Set();
  const currency = nfcTrim(spec?.campaign?.currency) || "USD";

  // A selection entry is (page, package ref, qty). Several entries may point at
  // one live package — that is a bundle picker, not a duplicate. Package FIELDS
  // are therefore compared once per referenced live package, while entry-level
  // structure (quantity) is reported per entry.
  const comparedPackages = new Set();

  for (const entry of plan.packages) {
    const scope = `selection[${entry.selection_id}]`;
    const live = liveById.get(entry.ref_id);

    if (!live) {
      rows.push(matrixRow("binding", scope, VERDICT.UNRESOLVED_BINDING, {
        desired: entry.ref_id,
        note: "no live package resolved for this ref_id",
      }));
      continue;
    }
    referencedIds.add(entry.ref_id);
    rows.push(matrixRow("binding", scope, VERDICT.MATCHED, {
      desired: entry.ref_id, observed: live.id, qty: entry.qty,
    }));

    // Quantity is a Map/spec selection concept: how many units this picker
    // option adds. It is not a property of the live package and the Admin API
    // is correct not to expose one. Recorded as asserted structure, not as a
    // coverage gap.
    rows.push(matrixRow("qty", scope, VERDICT.NOT_ASSERTED, {
      desired: entry.qty,
      note: "selection quantity is spec-side; the live package resource has no per-selection quantity",
    }));

    if (comparedPackages.has(entry.ref_id)) continue;
    comparedPackages.add(entry.ref_id);

    const desired = entry.spec_package ?? entry.spec ?? {};
    const pkgScope = `package[${entry.ref_id}]`;
    rows.push(compareScalar("name", pkgScope, desired.name, live.name));
    rows.push(compareScalar("product_sku", pkgScope, desired.product_sku, live.product_sku));

    const desiredPrice = normalizeMoney(desired.price);
    const observedPrice = live.prices?.[currency]?.price ?? null;
    if (!present(desiredPrice)) {
      rows.push(matrixRow("price", pkgScope, VERDICT.NOT_ASSERTED, { currency, observed: observedPrice, basis: "list" }));
    } else if (observedPrice === null) {
      rows.push(matrixRow("price", pkgScope, VERDICT.MISSING_LIVE, { currency, desired: desiredPrice, basis: "list" }));
    } else {
      rows.push(matrixRow("price", pkgScope, desiredPrice === observedPrice ? VERDICT.MATCHED : VERDICT.CHANGED, {
        currency, desired: desiredPrice, observed: observedPrice, basis: "list",
      }));
    }

    const desiredRecurring = desired.is_recurring === true;
    rows.push(matrixRow("is_recurring", pkgScope, desiredRecurring === live.is_recurring ? VERDICT.MATCHED : VERDICT.CHANGED, {
      desired: desiredRecurring, observed: live.is_recurring,
    }));
    rows.push(matrixRow("product_variant_id", pkgScope, VERDICT.NOT_ASSERTED, {
      observed: live.product_variant_id,
    }));
  }

  for (const pkg of snapshot.packages) {
    if (!referencedIds.has(String(pkg.id))) {
      rows.push(matrixRow("binding", `package[live:${pkg.id}]`, VERDICT.EXTRA_LIVE, {
        observed: pkg.id, note: "live package not referenced by any spec selection entry",
      }));
    }
  }
  return rows;
}

function unsupportedRows(plan) {
  return UNSUPPORTED_RESOURCES.map((resource) => matrixRow(resource, "campaign", VERDICT.UNSUPPORTED, {
    asserted_count: plan.unsupported[resource].asserted_count,
    note: plan.unsupported[resource].provenance,
  }));
}

export function diffReconciliation(plan, spec, snapshot) {
  return [
    ...settingsRows(spec, snapshot),
    ...packageRows(plan, spec, snapshot),
    ...unsupportedRows(plan),
  ];
}

export function deriveExceptions(rows) {
  return rows
    .filter((row) => DIFFERENCE_VERDICTS.has(row.verdict))
    .map((row) => ({ scope: row.scope, field: row.field, verdict: row.verdict }));
}

/**
 * Full report. `matrixHash` pins the revision of
 * contracts/reconcile-comparison-matrix.v0.json that the verdicts were produced
 * under. That file is machine-checked against these modules by
 * scripts/check-reconcile-matrix.mjs, so the hash certifies rules something
 * actually enforces rather than a document that can quietly drift.
 */
export function createReconciliationReport(spec, observed, { matrixHash = null, generatedAt = null } = {}) {
  const plan = planReconciliation(spec);
  const snapshot = normalizeSnapshot(observed);
  const rows = diffReconciliation(plan, spec, snapshot);

  const counts = { compared: 0, unresolved: 0, accounted: 0 };
  for (const row of rows) {
    if (ACCOUNTED_VERDICTS.has(row.verdict)) counts.accounted += 1;
    else if (row.verdict === VERDICT.UNRESOLVED_BINDING) counts.unresolved += 1;
    else counts.compared += 1;
  }

  const exceptions = deriveExceptions(rows);
  // Partial input can never be reported as a difference; it is inconclusive.
  const outcome = snapshot.partial || snapshot.packages_have_more
    ? OUTCOME.INCONCLUSIVE
    : exceptions.length > 0 ? OUTCOME.DIFFERENCES : OUTCOME.CLEAN;

  return {
    schema_version: RECONCILE_REPORT_SCHEMA_VERSION,
    outcome,
    campaign_ref_id: plan.campaign_ref_id,
    spec_hash: sha256Of(spec),
    snapshot_hash: sha256Of(snapshot),
    matrix_hash: matrixHash,
    ...(generatedAt ? { generated_at: generatedAt } : {}),
    price_basis: plan.price_basis,
    offers_asserted: plan.offers_asserted,
    coverage_complete: !snapshot.partial && !snapshot.packages_have_more && counts.unresolved === 0,
    compared_row_count: counts.compared,
    unresolved_row_count: counts.unresolved,
    accounted_row_count: counts.accounted,
    partial_input: snapshot.partial,
    missing_resources: snapshot.missing_resources,
    exception_count: exceptions.length,
    exceptions,
    rows,
  };
}

/**
 * Allowlist projection for the committable sidecar: verdicts, counts, and
 * hashes only. Observed and desired values never leave the full tier.
 */
export function projectReportForSidecar(report) {
  return {
    schema_version: report.schema_version,
    outcome: report.outcome,
    campaign_ref_id: report.campaign_ref_id,
    spec_hash: report.spec_hash,
    snapshot_hash: report.snapshot_hash,
    matrix_hash: report.matrix_hash,
    price_basis: report.price_basis,
    offers_asserted: report.offers_asserted,
    coverage_complete: report.coverage_complete,
    compared_row_count: report.compared_row_count,
    unresolved_row_count: report.unresolved_row_count,
    accounted_row_count: report.accounted_row_count,
    exception_count: report.exception_count,
    exceptions: report.exceptions,
    rows: report.rows.map(({ field, scope, verdict }) => ({ field, scope, verdict })),
  };
}
