import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  inspectSidecarBundle,
  SIDECAR_BUNDLE_CONTRACT,
} from "./sidecar-bundle.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped");
const CLI = join(ROOT, "bin/campaigns-os.mjs");

function copyFixture() {
  const root = join(tmpdir(), `campaigns-os-sidecar-bundle-${process.pid}-${Math.random().toString(16).slice(2)}`);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function withFixture(fn) {
  const root = copyFixture();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the public production-shaped fixture is a QA-complete conformant bundle", () => {
  const result = inspectSidecarBundle({
    packetPath: join(FIXTURE, "campaign-runtime.build.json"),
    requireQa: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.status, "conformant");
  assert.match(result.material_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.artifacts.map((artifact) => [artifact.kind, artifact.present]), [
    ["build_packet", true],
    ["build_context", true],
    ["assembly_report", true],
    ["doctor_output", true],
    ["qa_verdict", true],
  ]);
});

test("the conformance result and doctor fixture validate against their published schemas", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const conformanceSchema = readJson(join(ROOT, "schemas/campaigns-os-sidecar-bundle-conformance.v0.schema.json"));
  const doctorSchema = readJson(join(ROOT, "schemas/campaigns-os-doctor-output.v0.schema.json"));
  const validateConformance = ajv.compile(conformanceSchema);
  const validateDoctor = ajv.compile(doctorSchema);
  const result = inspectSidecarBundle({ packetPath: join(FIXTURE, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(validateConformance(result), true, JSON.stringify(validateConformance.errors, null, 2));
  assert.equal(validateDoctor(readJson(join(FIXTURE, ".campaign-runtime/doctor-output.json"))), true, JSON.stringify(validateDoctor.errors, null, 2));
});

test("QA is lifecycle-optional until --require-qa makes it part of conformance", () => withFixture((root) => {
  rmSync(join(root, ".campaign-runtime/qa-verdict.json"));
  const base = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json") });
  assert.equal(base.ok, true);
  assert.ok(base.warnings.some((finding) => finding.code === "bundle.qa_verdict.missing"));

  const completed = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(completed.ok, false);
  assert.ok(completed.errors.some((finding) => finding.code === "bundle.qa_verdict.missing"));
}));

test("markdown evidence cannot substitute for the canonical QA JSON sidecar", () => withFixture((root) => {
  rmSync(join(root, ".campaign-runtime/qa-verdict.json"));
  writeFileSync(join(root, ".campaign-runtime/qa-report.md"), "# QA\n\nVerdict: ready\n");
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((finding) => finding.code === "bundle.qa_verdict.missing"));
}));

test("the legacy sidecar packet path gets the explicit root-path remedy", () => withFixture((root) => {
  const canonical = join(root, "campaign-runtime.build.json");
  const legacy = join(root, ".campaign-runtime/campaign-runtime.build.json");
  cpSync(canonical, legacy);
  rmSync(canonical);
  const result = inspectSidecarBundle({ packetPath: legacy, requireQa: true });
  assert.equal(result.ok, false);
  const finding = result.errors.find((entry) => entry.code === "bundle.packet.legacy_path");
  assert.ok(finding);
  assert.match(finding.remedy, /repository-root campaign-runtime\.build\.json/);
}));

test("an arbitrary packet path gets the noncanonical-path remedy", () => withFixture((root) => {
  const packetPath = join(root, "elsewhere", "packet.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  cpSync(join(root, "campaign-runtime.build.json"), packetPath);
  const result = inspectSidecarBundle({ packetPath, requireQa: true });
  const finding = result.errors.find((entry) => entry.code === "bundle.packet.noncanonical_path");
  assert.ok(finding);
  assert.equal(finding.remedy, SIDECAR_BUNDLE_CONTRACT.packet_discovery.noncanonical_remedy);
  assert.match(finding.remedy, /Run bundle check against the repository-root/);
}));

test("cross-artifact identity drift is a conformance failure", () => withFixture((root) => {
  const path = join(root, ".campaign-runtime/assembly-report.json");
  const report = readJson(path);
  report.identity.map_id = "some-other-map";
  writeJson(path, report);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((finding) => finding.code === "bundle.identity.map_id_mismatch"));
}));

test("every producer-owned campaign identity fails conformance independently when it drifts", () => {
  const cases = [
    {
      name: "campaign_directory",
      relativePath: ".campaign-runtime/assembly-report.json",
      mutate: (report) => { report.identity.campaign_directory = "some-other-directory"; },
    },
    {
      name: "live_url_path",
      relativePath: ".campaign-runtime/assembly-report.json",
      mutate: (report) => { report.identity.live_url_path = "/some-other-path/"; },
    },
    {
      name: "template_family",
      relativePath: ".campaign-runtime/build-context.json",
      mutate: (context) => { context.template.family = "demeter"; },
    },
  ];

  for (const identityCase of cases) {
    withFixture((root) => {
      const path = join(root, identityCase.relativePath);
      const artifact = readJson(path);
      identityCase.mutate(artifact);
      writeJson(path, artifact);
      const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
      assert.equal(result.ok, false, identityCase.name);
      assert.ok(
        result.errors.some((finding) => finding.code === `bundle.identity.${identityCase.name}_mismatch`),
        `${identityCase.name}: ${JSON.stringify(result.errors, null, 2)}`,
      );
    });
  }
});

test("nullable packet compatibility does not make null bundle identity conformant", () => withFixture((root) => {
  const packetPath = join(root, "campaign-runtime.build.json");
  const packet = readJson(packetPath);
  packet.campaign.campaign_directory = null;
  packet.campaign.live_url_path = null;
  writeJson(packetPath, packet);
  const result = inspectSidecarBundle({ packetPath, requireQa: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((finding) => finding.code === "bundle.identity.campaign_directory_missing"));
  assert.ok(result.errors.some((finding) => finding.code === "bundle.identity.live_url_path_missing"));
}));

test("published artifact schemas and required bundle identities are enforced", () => withFixture((root) => {
  const path = join(root, ".campaign-runtime/build-context.json");
  const context = readJson(path);
  delete context.source_adapter;
  delete context.spec.hash;
  writeJson(path, context);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((finding) => finding.code === "bundle.build_context.schema"));
  assert.ok(result.errors.some((finding) => finding.code === "bundle.identity.spec_hash_missing"));
}));

test("a stale doctor snapshot is never a conformant readback artifact", () => withFixture((root) => {
  const path = join(root, ".campaign-runtime/doctor-output.json");
  const doctor = readJson(path);
  doctor.stale = true;
  doctor.stale_marked_at = "2026-08-24T00:05:00.000Z";
  writeJson(path, doctor);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json") });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((finding) => finding.code === "bundle.doctor_output.stale"));
}));

test("allowed volatile timestamps and run ids do not change the material digest", () => withFixture((root) => {
  const packetPath = join(root, "campaign-runtime.build.json");
  const first = inspectSidecarBundle({ packetPath, requireQa: true });

  for (const relativePath of [
    "campaign-runtime.build.json",
    ".campaign-runtime/build-context.json",
    ".campaign-runtime/assembly-report.json",
    ".campaign-runtime/doctor-output.json",
    ".campaign-runtime/qa-verdict.json",
  ]) {
    const path = join(root, relativePath);
    const artifact = readJson(path);
    artifact.generated_at = "2026-09-03T12:34:56.000Z";
    if (artifact.run_id) artifact.run_id = `rerun-${artifact.run_id}`;
    if (artifact.started_at) artifact.started_at = "2026-09-03T12:30:00.000Z";
    if (artifact.completed_at) artifact.completed_at = "2026-09-03T12:33:00.000Z";
    writeJson(path, artifact);
  }
  const second = inspectSidecarBundle({ packetPath, requireQa: true });
  assert.equal(second.ok, true, JSON.stringify(second.errors, null, 2));
  assert.equal(second.material_digest, first.material_digest);

  const reportPath = join(root, ".campaign-runtime/assembly-report.json");
  const report = readJson(reportPath);
  report.status = "completed";
  writeJson(reportPath, report);
  const materialChange = inspectSidecarBundle({ packetPath, requireQa: true });
  assert.notEqual(materialChange.material_digest, first.material_digest);
}));

test("the CLI exposes bundle check as JSON and honors --require-qa", () => {
  const stdout = execFileSync("node", [
    CLI,
    "bundle",
    "check",
    "--packet",
    join(FIXTURE, "campaign-runtime.build.json"),
    "--require-qa",
    "--json",
  ], { encoding: "utf8" });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.bundle_id, SIDECAR_BUNDLE_CONTRACT.bundle_id);
});

test("the machine contract forbids mtime selection and requires explicit historical QA promotion", () => {
  assert.equal(SIDECAR_BUNDLE_CONTRACT.packet_discovery.selection_authority, "campaign-runtime.build.json#generated_at");
  assert.equal(SIDECAR_BUNDLE_CONTRACT.packet_discovery.forbidden_selection_authority, "filesystem_mtime");
  const identities = Object.fromEntries(
    SIDECAR_BUNDLE_CONTRACT.identity_fields.map((identity) => [identity.name, identity.artifact_paths]),
  );
  assert.deepEqual(identities.campaign_directory, {
    build_packet: "campaign.campaign_directory",
    assembly_report: "identity.campaign_directory",
  });
  assert.deepEqual(identities.live_url_path, {
    build_packet: "campaign.live_url_path",
    assembly_report: "identity.live_url_path",
  });
  assert.deepEqual(identities.template_family, {
    build_packet: "assembly.template_family",
    build_context: "template.family",
    assembly_report: "template_family.value",
    doctor_output: "derived.template_family",
  });
  assert.match(SIDECAR_BUNDLE_CONTRACT.ci_producer.promote_historical_qa, /--verdict <explicit-full-verdict\.json>/);
  assert.deepEqual(SIDECAR_BUNDLE_CONTRACT.ci_producer.never_select_qa_by, [
    "filesystem_mtime",
    "filename_sort",
    "directory_latest",
  ]);
});
