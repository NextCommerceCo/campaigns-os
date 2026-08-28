#!/usr/bin/env node
/**
 * Bind the reconciliation modules to their contract.
 *
 * Every reconciliation report embeds the comparison matrix's sha256 as
 * `matrix_hash`, claiming the verdicts were produced under those rules. That
 * claim is only worth anything if something enforces it — otherwise the prose
 * drifts from the code and the hash certifies a document nobody honours.
 *
 * This is that enforcement. It fails the build when the modules and
 * contracts/reconcile-comparison-matrix.v0.json disagree about the verdict
 * vocabulary, the compared fields, the package model, or which rows are judged.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OUTCOME, VERDICT, createReconciliationReport } from "../src/reconcile-diff.mjs";
import { UNSUPPORTED_RESOURCES } from "../src/reconcile-plan.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const matrix = readJson("contracts/reconcile-comparison-matrix.v0.json");
const failures = [];
const fail = (message) => failures.push(message);

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

// 1. Verdict and outcome vocabularies are closed and identical on both sides.
if (!sameSet(Object.keys(matrix.verdicts), Object.values(VERDICT))) {
  fail(`verdict vocabulary drift: contract ${Object.keys(matrix.verdicts).sort()} vs code ${Object.values(VERDICT).sort()}`);
}
if (!sameSet(Object.keys(matrix.outcomes), Object.values(OUTCOME))) {
  fail(`outcome vocabulary drift: contract ${Object.keys(matrix.outcomes).sort()} vs code ${Object.values(OUTCOME).sort()}`);
}

// 2. Unsupported resources match, so a resource cannot quietly stop being counted.
if (!sameSet(matrix.unsupported_resources.map((r) => r.resource), [...UNSUPPORTED_RESOURCES])) {
  fail(`unsupported resource drift: contract ${matrix.unsupported_resources.map((r) => r.resource)} vs code ${[...UNSUPPORTED_RESOURCES]}`);
}

// 3. Run the real fixtures and confirm the emitted rows are exactly the rows
//    the contract describes — and that judged/unjudged agrees field by field.
const fixture = (name) => readJson(`fixtures/reconcile/${name}`);
const report = createReconciliationReport(
  fixture("desired-campaignspec.json"),
  {
    campaign: fixture("observed-campaign-1602-retrieve.json"),
    packages: fixture("observed-campaign-1602-packages.json"),
    products: fixture("observed-products-by-sku-tacslingbag.json"),
    gatewayGroups: fixture("observed-gateway-groups-list.json"),
  },
  {},
);

const contractFields = new Map();
for (const row of [...matrix.settings_rows, ...matrix.entry_rows, ...matrix.package_rows]) {
  contractFields.set(row.field, row);
}
for (const resource of matrix.unsupported_resources) {
  contractFields.set(resource.resource, { field: resource.resource, verdict: "unsupported", judged: false });
}

for (const row of report.rows) {
  const declared = contractFields.get(row.field);
  if (!declared) {
    fail(`emitted field "${row.field}" (${row.scope}) is not declared in the contract`);
    continue;
  }
  if (declared.judged === false && declared.verdict && row.verdict !== declared.verdict) {
    fail(`field "${row.field}" is declared ${declared.verdict} but emitted ${row.verdict}`);
  }
  if (declared.basis && row.basis !== declared.basis) {
    fail(`field "${row.field}" must carry basis "${declared.basis}", got "${row.basis}"`);
  }
}

const emitted = new Set(report.rows.map((row) => row.field));
for (const [field, row] of contractFields) {
  if (row.judged !== false && !emitted.has(field)) {
    fail(`contract declares judged field "${field}" but no row was emitted for it`);
  }
}

// 4. Fields the contract forbids comparing must never surface as comparable rows.
for (const forbidden of matrix.never_compared) {
  if (emitted.has(forbidden.field)) {
    fail(`"${forbidden.field}" is listed never_compared but appears as a row`);
  }
}
if (JSON.stringify(report).includes("\"api_key\"")) {
  fail("api_key reached the report; the normalization redaction boundary is broken");
}

// 5. The package model claim must hold: entries are not deduplicated by ref_id.
if (matrix.package_model.deduplicate_by_ref_id !== false) {
  fail("contract must state deduplicate_by_ref_id: false");
}
const bindingRows = report.rows.filter((row) => row.field === "binding" && row.scope.startsWith("selection["));
const refs = bindingRows.map((row) => row.desired);
if (refs.length === new Set(refs).size) {
  fail("the reference fixture must exercise many-entries-to-one-package; no repeated ref_id was emitted");
}

if (failures.length) {
  console.error("Reconcile matrix check FAILED:");
  for (const message of failures) console.error(`  - ${message}`);
  process.exitCode = 1;
} else {
  console.log(
    `Reconcile matrix check passed (${contractFields.size} declared fields, ${report.rows.length} emitted rows, ${bindingRows.length} selection entries).`,
  );
}
