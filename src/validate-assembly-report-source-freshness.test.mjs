import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  assemblySourcePackageFingerprintMissing,
  assessAssemblySourcePackageFreshnessWaivers,
  evaluatePolishGate,
} from "./polish-gate.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const EXAMPLE_REPORT = resolve(ROOT, "examples/assembly-report.example.json");
const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const BUILD_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const FRESHNESS_CODE = "stages.assembly.source_package_material_fingerprint";
const ACTIVE_WAIVER = Object.freeze({
  scope: "assembly_source_package_freshness",
  reason: "Source package changed after build; re-build is scheduled.",
  waived_by: "release-owner",
  waived_at: "2026-09-13T00:00:00.000Z",
  expires_at: "2099-01-01T00:00:00.000Z",
});

// A completed-assembly report shaped the way the polish gate reads one, so the
// gate and the standalone validator are asked about the same artifact.
function buildReport({
  sourcePackage = true,
  assemblyFingerprint = null,
  waivers = null,
  assemblyStatus = "completed",
  buildFingerprint = BUILD_FINGERPRINT,
} = {}) {
  const report = JSON.parse(readFileSync(EXAMPLE_REPORT, "utf8"));
  report.stages.assembly.status = assemblyStatus;
  if (buildFingerprint) report.stages.assembly.build_fingerprint = buildFingerprint;
  if (sourcePackage) {
    report.design_source_package = {
      schema_version: "campaign-design-source-package/v0",
      material_fingerprint: SOURCE_FINGERPRINT,
    };
  }
  if (assemblyFingerprint) report.stages.assembly.source_package_material_fingerprint = assemblyFingerprint;
  if (waivers) report.waivers = waivers;
  return report;
}

function validate(report) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-report-freshness-"));
  try {
    const reportPath = join(dir, "assembly-report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const result = spawnSync("node", [CLI, "validate-assembly-report", "--report", reportPath, "--json"], { encoding: "utf8" });
    return JSON.parse(String(result.stdout || ""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function errorCodes(result) {
  return (result.errors || []).map((issue) => issue.code);
}

test("validate-assembly-report rejects a design-source-package report with no assembly material fingerprint", () => {
  const result = validate(buildReport());
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.ok(errorCodes(result).includes(FRESHNESS_CODE), `expected ${FRESHNESS_CODE}, got ${errorCodes(result).join(", ")}`);
});

test("validate-assembly-report accepts the same report once the assembly fingerprint is recorded", () => {
  const result = validate(buildReport({ assemblyFingerprint: SOURCE_FINGERPRINT }));
  assert.ok(!errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
  assert.equal(result.ok, true);
});

test("validate-assembly-report leaves a report without any design source package alone", () => {
  const result = validate(buildReport({ sourcePackage: false }));
  assert.ok(!errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
  assert.equal(result.ok, true);
});

test("validate-assembly-report honors an active source freshness waiver", () => {
  const result = validate(buildReport({
    waivers: [ACTIVE_WAIVER],
  }));
  assert.ok(!errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
  assert.equal(result.ok, true);
});

// The shape `prepare-build` and `start` emit: the package fingerprint is
// recorded before any build has consumed it, and Assembly is still pending.
test("validate-assembly-report accepts a prepared report whose assembly is still pending", () => {
  const result = validate(buildReport({ assemblyStatus: "pending", buildFingerprint: null }));
  assert.ok(!errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
  assert.equal(result.ok, true);
});

test("validate-assembly-report does not raise the freshness error before a build fingerprint exists", () => {
  const result = validate(buildReport({ buildFingerprint: null }));
  assert.ok(!errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
});

const MALFORMED_WAIVER = Object.freeze({
  scope: "assembly_source_package_freshness",
  reason: "Source package changed after build; re-build is scheduled.",
  waived_by: "release-owner",
  waived_at: "2026-09-13T00:00:00.000Z",
  expires_at: "whenever",
});

// The gate refuses to honor a waiver whose expires_at does not parse and
// blocks on polish.waiver_expires_at_invalid. The validator must not read that
// record as "no waiver, but otherwise fine" and pass the report.
test("validate-assembly-report reports a waiver whose expires_at does not parse", () => {
  const result = validate(buildReport({ waivers: [MALFORMED_WAIVER] }));
  assert.equal(result.ok, false);
  assert.ok(errorCodes(result).includes("stages.assembly.waiver_expires_at_invalid"), errorCodes(result).join(", "));
  // A malformed record is not an active waiver, so the freshness error stands
  // beside it; the gate names only the first of the two, as it always has.
  assert.ok(errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
  const gate = evaluatePolishGate({ report: buildReport({ waivers: [MALFORMED_WAIVER] }) });
  assert.equal(gate.code, "polish.waiver_expires_at_invalid");
});

// A report too broken to have stages cannot be asked whether Assembly consumed
// the package: it must fail on the structure and say nothing about freshness.
test("a structurally broken report fails on structure only", () => {
  const report = buildReport();
  delete report.stages;
  const result = validate(report);
  assert.equal(result.ok, false);
  assert.ok(errorCodes(result).includes("stages"), errorCodes(result).join(", "));
  assert.ok(!errorCodes(result).includes(FRESHNESS_CODE), errorCodes(result).join(", "));
  assert.ok(!errorCodes(result).includes("stages.assembly.waiver_expires_at_invalid"), errorCodes(result).join(", "));
});

// The predicate takes a pre-computed waiver assessment so the gate does not
// scan the same records twice; the answer must not depend on which it gets.
test("the predicate accepts a pre-computed waiver assessment", () => {
  for (const report of [buildReport(), buildReport({ waivers: [ACTIVE_WAIVER] })]) {
    const assessment = assessAssemblySourcePackageFreshnessWaivers(report);
    assert.equal(
      assemblySourcePackageFingerprintMissing(report, Date.now(), assessment),
      assemblySourcePackageFingerprintMissing(report),
    );
  }
});

// The point of the shared predicate: whatever makes the ladder block must make
// the validator fail, on the same report, for every variant above.
test("the polish gate and the validator agree on the source-freshness condition", () => {
  const cases = [
    buildReport(),
    buildReport({ assemblyFingerprint: SOURCE_FINGERPRINT }),
    buildReport({ sourcePackage: false }),
    buildReport({ assemblyStatus: "pending", buildFingerprint: null }),
    buildReport({ buildFingerprint: null }),
    buildReport({
      waivers: [ACTIVE_WAIVER],
    }),
  ];
  for (const report of cases) {
    const gate = evaluatePolishGate({ report });
    const gateBlocksOnFreshness = gate.status === "blocked"
      && gate.code === "polish.assembly_source_package_fingerprint_missing";
    assert.equal(assemblySourcePackageFingerprintMissing(report), gateBlocksOnFreshness);
    assert.equal(errorCodes(validate(report)).includes(FRESHNESS_CODE), gateBlocksOnFreshness);
  }
});
