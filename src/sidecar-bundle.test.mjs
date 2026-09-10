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
import { writeQaSidecar } from "./qa-sidecar.mjs";

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

test("equivalent safe repository-relative packet pointers are conformant", () => withFixture((root) => {
  const contextPath = join(root, ".campaign-runtime/build-context.json");
  const reportPath = join(root, ".campaign-runtime/assembly-report.json");
  const context = readJson(contextPath);
  const report = readJson(reportPath);
  context.packet_path = "./campaign-runtime.build.json";
  report.inputs.packet_path = "./campaign-runtime.build.json";
  writeJson(contextPath, context);
  writeJson(reportPath, report);

  const result = inspectSidecarBundle({
    packetPath: join(root, "campaign-runtime.build.json"),
    requireQa: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
}));

test("packet pointers containing traversal or foreign paths are rejected", () => {
  for (const pointer of ["../campaign-runtime.build.json", "nested/../campaign-runtime.build.json", "/tmp/campaign-runtime.build.json", "https://example.test/campaign-runtime.build.json"]) {
    withFixture((root) => {
      const contextPath = join(root, ".campaign-runtime/build-context.json");
      const reportPath = join(root, ".campaign-runtime/assembly-report.json");
      const context = readJson(contextPath);
      const report = readJson(reportPath);
      context.packet_path = pointer;
      report.inputs.packet_path = pointer;
      writeJson(contextPath, context);
      writeJson(reportPath, report);

      const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
      assert.equal(result.ok, false, pointer);
      assert.ok(result.errors.some((finding) => finding.code === "bundle.build_context.packet_path"), pointer);
      assert.ok(result.errors.some((finding) => finding.code === "bundle.assembly_report.packet_path"), pointer);
    });
  }
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

test("material spec identity correlates QA without reinterpreting raw-byte integrity", () => withFixture((root) => {
  const materialHash = `sha256:${"a".repeat(64)}`;
  const contextPath = join(root, ".campaign-runtime/build-context.json");
  const reportPath = join(root, ".campaign-runtime/assembly-report.json");
  const qaPath = join(root, ".campaign-runtime/qa-verdict.json");
  const context = readJson(contextPath);
  const report = readJson(reportPath);
  const qa = readJson(qaPath);
  context.spec.material_hash = materialHash;
  report.identity.spec_material_hash = materialHash;
  qa.spec_hash = materialHash;
  writeJson(contextPath, context);
  writeJson(reportPath, report);
  writeJson(qaPath, qa);

  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.notEqual(context.spec.hash, materialHash);
  assert.equal(report.identity.spec_hash, context.spec.hash);
}));

test("legacy bundles compare raw producer hashes once and never compare QA semantic identity", () => withFixture((root) => {
  const contextPath = join(root, ".campaign-runtime/build-context.json");
  const reportPath = join(root, ".campaign-runtime/assembly-report.json");
  const qaPath = join(root, ".campaign-runtime/qa-verdict.json");
  const context = readJson(contextPath);
  const report = readJson(reportPath);
  const qa = readJson(qaPath);
  delete context.spec.material_hash;
  delete report.identity.spec_material_hash;
  qa.spec_hash = `sha256:${"b".repeat(64)}`;
  writeJson(contextPath, context);
  writeJson(reportPath, report);
  writeJson(qaPath, qa);

  const conformant = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(conformant.errors.some((finding) => finding.code.startsWith("bundle.identity.spec_")), false, JSON.stringify(conformant.errors, null, 2));

  report.identity.spec_hash = `sha256:${"c".repeat(64)}`;
  writeJson(reportPath, report);
  const drifted = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(drifted.errors.filter((finding) => finding.code === "bundle.identity.spec_hash_mismatch").length, 1);
}));

test("changed spec material, foreign QA, and partially regenerated identities fail closed", () => {
  const cases = [
    {
      code: "bundle.identity.spec_material_hash_mismatch",
      mutate: ({ context, report, qa }) => {
        context.spec.material_hash = `sha256:${"a".repeat(64)}`;
        report.identity.spec_material_hash = context.spec.material_hash;
        qa.spec_hash = `sha256:${"b".repeat(64)}`;
      },
    },
    {
      code: "bundle.identity.spec_material_hash_incomplete",
      mutate: ({ context, qa }) => {
        context.spec.material_hash = `sha256:${"a".repeat(64)}`;
        qa.spec_hash = context.spec.material_hash;
      },
    },
  ];

  for (const identityCase of cases) {
    withFixture((root) => {
      const paths = {
        context: join(root, ".campaign-runtime/build-context.json"),
        report: join(root, ".campaign-runtime/assembly-report.json"),
        qa: join(root, ".campaign-runtime/qa-verdict.json"),
      };
      const artifacts = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, readJson(path)]));
      identityCase.mutate(artifacts);
      for (const [kind, path] of Object.entries(paths)) writeJson(path, artifacts[kind]);
      const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((finding) => finding.code === identityCase.code), JSON.stringify(result.errors, null, 2));
    });
  }
});

test("a schema-valid blocked QA verdict cannot satisfy QA-complete handoff", () => withFixture((root) => {
  const qaPath = join(root, ".campaign-runtime/qa-verdict.json");
  const qa = readJson(qaPath);
  qa.disposition = "blocked";
  qa.assertions[0].status = "fail";
  writeJson(qaPath, qa);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.ok, false);
  assert.equal(result.stage_blocked, true);
  assert.ok(result.errors.some((finding) => finding.code === "bundle.qa_verdict.blocked"));
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

test("fresh prepare-build, doctor, and QA projection form a conformant bundle", () => {
  const root = join(tmpdir(), `campaigns-os-sidecar-integration-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const target = join(root, "target");
  try {
    cpSync(join(ROOT, "examples/target-page-kit"), target, { recursive: true });
    execFileSync("node", [
      CLI,
      "prepare-build",
      "--spec", join(ROOT, "examples/campaignspec.v42.basic.json"),
      "--source", join(ROOT, "examples/source-html"),
      "--target", target,
      "--template-family", "olympus",
      "--no-run-session",
      "--json",
    ], { encoding: "utf8", cwd: root, stdio: "pipe" });

    const packetPath = join(target, "campaign-runtime.build.json");
    try {
      execFileSync("node", [CLI, "doctor", "--packet", packetPath, "--strip-paths", "--json"], {
        encoding: "utf8",
        cwd: root,
        stdio: "pipe",
      });
    } catch (error) {
      assert.equal(error.status, 2, String(error.stderr || error));
    }

    const packet = readJson(packetPath);
    const context = readJson(join(target, ".campaign-runtime/build-context.json"));
    writeQaSidecar({
      packetPath,
      now: () => "2026-09-10T01:00:00.000Z",
      verdict: {
        schema_version: "1.0",
        run_id: "FRESHBUNDLE000000000000000001",
        campaign_slug: packet.spec.map_id,
        public_route_slug: packet.campaign.public_route_slug,
        campaign_ref_id: null,
        spec_version: "4.2",
        spec_hash: context.spec.material_hash,
        started_at: "2026-09-10T00:58:00.000Z",
        completed_at: "2026-09-10T00:59:00.000Z",
        runtime: "campaigns-os-node-qa@integration-test",
        disposition: "ready",
        entry_urls: [],
        page_urls: [],
        tested_urls: [],
        assertions: [{ id: "http:checkout", family: "funnel-flow", page: "checkout", status: "pass", severity: "info" }],
        test_orders: [],
        exceptions: [],
      },
    });

    const result = inspectSidecarBundle({ packetPath, requireQa: true });
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.deepEqual(identities.spec_hash, {
    build_context: "spec.hash",
    assembly_report: "identity.spec_hash",
  });
  assert.deepEqual(identities.spec_material_hash, {
    build_context: "spec.material_hash",
    assembly_report: "identity.spec_material_hash",
    qa_verdict: "spec_hash",
  });
  assert.equal(
    SIDECAR_BUNDLE_CONTRACT.identity_fields.find((identity) => identity.name === "spec_material_hash").compatibility.mode,
    "complete_material_or_strict_legacy_exact",
  );
  assert.deepEqual(
    SIDECAR_BUNDLE_CONTRACT.identity_fields.find((identity) => identity.name === "spec_material_hash").compatibility.legacy_artifact_paths,
    { build_context: "spec.hash", assembly_report: "identity.spec_hash" },
  );
  assert.match(SIDECAR_BUNDLE_CONTRACT.ci_producer.promote_historical_qa, /--verdict <explicit-full-verdict\.json>/);
  assert.deepEqual(SIDECAR_BUNDLE_CONTRACT.ci_producer.never_select_qa_by, [
    "filesystem_mtime",
    "filename_sort",
    "directory_latest",
  ]);
});
