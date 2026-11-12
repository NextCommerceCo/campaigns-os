import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  sidecarBundleReadinessLine,
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

function writeFunnelBundle(root, { route = "some-other-route", mapId = "some-other-map", packetName = `campaign-runtime-${route}.build.json` } = {}) {
  const runtimeDir = `.campaign-runtime/funnels/${route}`;
  const packet = readJson(join(FIXTURE, "campaign-runtime.build.json"));
  packet.campaign.public_route_slug = route;
  packet.campaign.campaign_directory = route;
  packet.campaign.live_url_path = `/${route}/`;
  packet.spec.map_id = mapId;
  packet.assembly.runtime_dir = runtimeDir;
  writeJson(join(root, packetName), packet);

  const context = readJson(join(FIXTURE, ".campaign-runtime/build-context.json"));
  context.packet_path = packetName;
  context.report_path = `${runtimeDir}/assembly-report.json`;
  writeJson(join(root, runtimeDir, "build-context.json"), context);

  const report = readJson(join(FIXTURE, ".campaign-runtime/assembly-report.json"));
  Object.assign(report.identity, {
    map_id: mapId,
    public_route_slug: route,
    campaign_directory: route,
    live_url_path: `/${route}/`,
  });
  report.inputs.packet_path = packetName;
  report.inputs.context_path = `${runtimeDir}/build-context.json`;
  writeJson(join(root, runtimeDir, "assembly-report.json"), report);

  const doctor = readJson(join(FIXTURE, ".campaign-runtime/doctor-output.json"));
  Object.assign(doctor.derived, { packet_path: packetName, map_id: mapId, public_route_slug: route });
  writeJson(join(root, runtimeDir, "doctor-output.json"), doctor);

  const qa = readJson(join(FIXTURE, ".campaign-runtime/qa-verdict.json"));
  Object.assign(qa, { campaign_slug: mapId, public_route_slug: route });
  writeJson(join(root, runtimeDir, "qa-verdict.json"), qa);
  return { packetPath: join(root, packetName), packetName, runtimeDir };
}

test("the default bundle result preserves the origin/main digest and artifact paths", () => {
  const result = inspectSidecarBundle({ packetPath: join(FIXTURE, "campaign-runtime.build.json"), requireQa: true });
  // Captured from origin/main d4e837bc before changing the checker.
  const artifacts = [
    ["build_packet", "campaign-runtime.build.json", "required", "campaign-runtime-build-packet/v0", "2026-08-24T00:00:00.000Z", "56d809378d9582780aa0d3d0f86dcad27bafa5cb430ee092e6c84c00954973b4", "7dde828f647ca8af6c7cb070fea9c814b986b170ad500f5654bfcadaaf1fb6d4"],
    ["build_context", ".campaign-runtime/build-context.json", "required", "campaign-runtime-build-context/v0", "2026-08-24T00:00:00.000Z", "ec7e6cf3a1f526ed92ee665b443103e73debc25fa45c8d29737f44040a6bb2b6", "2734f64a1af3741063d1a55951b6a645ad63cb725ef4dd70e7f7b6e3a841a224"],
    ["assembly_report", ".campaign-runtime/assembly-report.json", "required", "campaign-runtime-assembly-report/v0", "2026-08-24T00:00:00.000Z", "3b7207c438d59340a9ab788701a46041e70448c96769c4b95a96a3a153d77d62", "524ddde74571d0ba3c3d9a4c137a4252729f4834b2719c569ff325130818ae0d"],
    ["doctor_output", ".campaign-runtime/doctor-output.json", "required", "campaigns-os-doctor-output/v0", "2026-08-24T00:01:00.000Z", "49b911334afb0873d7717f78420f586c16149596cf9edfae50a48c9456426599", "5a023262b415313144b1267f63666a2d4adb34de4fb0dbeb7b76676cf69f27c6"],
    ["qa_verdict", ".campaign-runtime/qa-verdict.json", "required_after_qa", "1.0", "2026-08-24T00:04:00.000Z", "1445c823553e7ad173cf2078cf46e25b03faaaaa1c6354e3fccfd01104093f3f", "38e257b02fdd203be39030a89048513f08c4ff74e71edd8a158f539f0d3c14b2"],
  ].map(([kind, path, requirement, schema_version, generated_at, sha256, material_sha256]) => ({
    kind, path, requirement, present: true, schema_version, generated_at,
    sha256: `sha256:${sha256}`, material_sha256: `sha256:${material_sha256}`,
  }));
  assert.deepEqual(result, {
    schema_version: "campaigns-os-sidecar-bundle-conformance/v0",
    bundle_id: "campaigns-os-migration-sidecar-bundle/v0",
    ok: true,
    status: "conformant",
    stage_blocked: false,
    root: FIXTURE,
    packet_generated_at: "2026-08-24T00:00:00.000Z",
    material_digest: "sha256:ace7d8f87ec371487fec5c68c672e318f74f5c18486f2955de347b507864fc1c",
    artifacts,
    errors: [],
    warnings: [],
  });
});

test("a root packet reads its own per-funnel runtime directory", () => withFixture((root) => {
  const { packetPath, runtimeDir } = writeFunnelBundle(root, { packetName: "campaign-runtime.build.json" });
  // Leave no project-level records to satisfy the checked packet by accident.
  for (const name of ["build-context.json", "assembly-report.json", "doctor-output.json", "qa-verdict.json"]) {
    rmSync(join(root, ".campaign-runtime", name));
  }
  const result = inspectSidecarBundle({ packetPath, requireQa: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.artifacts.map((artifact) => artifact.path), [
    "campaign-runtime.build.json",
    ...["build-context.json", "assembly-report.json", "doctor-output.json", "qa-verdict.json"].map((name) => `${runtimeDir}/${name}`),
  ]);
}));

test("two funnels read only their own packet and records", () => withFixture((root) => {
  const firstPacket = join(root, "campaign-runtime.build.json");
  const before = inspectSidecarBundle({ packetPath: firstPacket, requireQa: true });
  const second = writeFunnelBundle(root);
  const results = [
    inspectSidecarBundle({ packetPath: firstPacket, requireQa: true }),
    inspectSidecarBundle({ packetPath: second.packetPath, requireQa: true }),
  ];
  for (const result of results) {
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
    assert.deepEqual(result.errors.filter((finding) => finding.code.startsWith("bundle.identity.")), []);
    for (const artifact of result.artifacts) {
      assert.equal(artifact.sha256, `sha256:${createHash("sha256").update(readFileSync(join(root, artifact.path))).digest("hex")}`);
    }
  }
  assert.deepEqual(results[0], before);
  assert.equal(results[1].artifacts[0].path, second.packetName);
  assert.ok(results[1].artifacts.slice(1).every((artifact) => artifact.path.startsWith(`${second.runtimeDir}/`)));
  assert.notEqual(results[1].material_digest, results[0].material_digest);
  const first = readJson(firstPacket);
  const other = readJson(second.packetPath);
  assert.notEqual(first.spec.map_id, other.spec.map_id);
  assert.notEqual(first.campaign.public_route_slug, other.campaign.public_route_slug);
}));

test("a missing per-funnel record never borrows a project-level record", () => withFixture((root) => {
  const { packetPath, runtimeDir } = writeFunnelBundle(root);
  rmSync(join(root, runtimeDir, "doctor-output.json"));
  const result = inspectSidecarBundle({ packetPath, requireQa: true });
  const finding = result.errors.find((entry) => entry.code === "bundle.doctor_output.missing");
  assert.ok(finding, JSON.stringify(result.errors, null, 2));
  assert.equal(finding.message, `Missing canonical JSON artifact ${runtimeDir}/doctor-output.json.`);
  const artifact = result.artifacts.find((entry) => entry.kind === "doctor_output");
  assert.equal(artifact.path, `${runtimeDir}/doctor-output.json`);
  assert.equal(artifact.present, false);
  assert.equal(artifact.sha256, null);
  assert.equal(artifact.material_sha256, null);
  assert.equal(result.errors.some((entry) => entry.code.startsWith("bundle.identity.")), false);
}));

test("a packet named for another route is noncanonical", () => withFixture((root) => {
  const { packetPath } = writeFunnelBundle(root, { packetName: "campaign-runtime-foreign-route.build.json" });
  const result = inspectSidecarBundle({ packetPath, requireQa: true });
  assert.equal(result.ok, false);
  const finding = result.errors.find((entry) => entry.code === "bundle.packet.noncanonical_path");
  assert.ok(finding);
  assert.match(finding.message, /campaign-runtime\.build\.json/);
  assert.match(finding.message, /campaign-runtime-<public_route_slug>\.build\.json/);
}));

test("an invalid runtime directory is refused before any sidecar is read", () => withFixture((root) => {
  const packetPath = join(root, "campaign-runtime.build.json");
  for (const runtimeDir of ["../outside", "/tmp/outside", ".campaign-runtime/funnels/some-other-route", ".campaign-runtime/funnels", "https://example.test/records", "", 42]) {
    const packet = readJson(packetPath);
    packet.assembly.runtime_dir = runtimeDir;
    writeJson(packetPath, packet);
    const result = inspectSidecarBundle({ packetPath, requireQa: true });
    assert.equal(result.ok, false, String(runtimeDir));
    const finding = result.errors.find((entry) => entry.code === "bundle.packet.runtime_dir");
    assert.ok(finding, JSON.stringify(result.errors, null, 2));
    assert.equal(finding.artifact, "build_packet");
    assert.match(finding.message, /"\.campaign-runtime" or "\.campaign-runtime\/funnels\/<campaign.public_route_slug>"/);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.kind), ["build_packet"]);
    assert.equal(result.errors.some((entry) => entry.artifact !== "build_packet"), false);
    assert.deepEqual(result.warnings, []);
  }
}));

test("per-funnel packet pointers must name the packet checked", () => withFixture((root) => {
  const { packetPath, runtimeDir, packetName } = writeFunnelBundle(root);
  for (const [name, code] of [["build-context.json", "bundle.build_context.packet_path"], ["assembly-report.json", "bundle.assembly_report.packet_path"]]) {
    const path = join(root, runtimeDir, name);
    const record = readJson(path);
    const input = name === "build-context.json" ? record : record.inputs;
    input.packet_path = "campaign-runtime.build.json";
    writeJson(path, record);
    const result = inspectSidecarBundle({ packetPath, requireQa: true });
    const finding = result.errors.find((entry) => entry.code === code);
    assert.ok(finding, JSON.stringify(result.errors, null, 2));
    assert.ok(finding.message.includes(packetName));
    input.packet_path = `./${packetName}`;
    writeJson(path, record);
    const restored = inspectSidecarBundle({ packetPath, requireQa: true });
    assert.equal(restored.ok, true, JSON.stringify(restored.errors, null, 2));
  }
}));

test("per-funnel doctor remedies name that funnel's packet", () => withFixture((root) => {
  const { packetPath, runtimeDir, packetName } = writeFunnelBundle(root);
  const doctorPath = join(root, runtimeDir, "doctor-output.json");
  const doctor = readJson(doctorPath);
  doctor.stale = true;
  doctor.status = "blocked";
  doctor.ok = false;
  writeJson(doctorPath, doctor);
  for (const requireQa of [false, true]) {
    const result = inspectSidecarBundle({ packetPath, requireQa });
    for (const code of ["bundle.doctor_output.stale", "bundle.doctor_output.blocked"]) {
      const finding = [...result.errors, ...result.warnings].find((entry) => entry.code === code);
      assert.ok(finding, JSON.stringify(result));
      assert.ok(finding.remedy.includes(`campaigns-os doctor --packet ${packetName} --write --strip-paths`), finding.remedy);
    }
  }
  rmSync(doctorPath);
  const missing = inspectSidecarBundle({ packetPath });
  assert.ok(missing.errors.find((entry) => entry.code === "bundle.doctor_output.missing").remedy.includes(`--packet ${packetName}`));
}));

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
  assert.match(finding.message, /campaign-runtime\.build\.json or campaign-runtime-<public_route_slug>\.build\.json/);
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

test("a prefix-only spelling difference in spec hashes is not identity drift", () => withFixture((root) => {
  const hex = "a".repeat(64);
  const contextPath = join(root, ".campaign-runtime/build-context.json");
  const reportPath = join(root, ".campaign-runtime/assembly-report.json");
  const qaPath = join(root, ".campaign-runtime/qa-verdict.json");
  const context = readJson(contextPath);
  const report = readJson(reportPath);
  const qa = readJson(qaPath);
  context.spec.material_hash = `sha256:${hex}`;
  report.identity.spec_material_hash = hex.toUpperCase();
  qa.spec_hash = `SHA256:${hex}`;
  context.spec.hash = `sha256:${"d".repeat(64)}`;
  report.identity.spec_hash = "D".repeat(64);
  writeJson(contextPath, context);
  writeJson(reportPath, report);
  writeJson(qaPath, qa);

  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  const identityFindings = result.errors.filter((finding) => finding.code.startsWith("bundle.identity.spec_"));
  assert.deepEqual(identityFindings, [], JSON.stringify(result.errors, null, 2));
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

function blockDoctorSidecar(root) {
  const path = join(root, ".campaign-runtime/doctor-output.json");
  const doctor = readJson(path);
  doctor.ok = false;
  doctor.status = "blocked";
  doctor.errors = [{ code: "page_kit.store_profile", message: "Store Profile fields still carry the scaffold demo value." }];
  writeJson(path, doctor);
}

test("a blocked doctor run is conformant but never ready: warning by default, stage_blocked true", () => withFixture((root) => {
  blockDoctorSidecar(root);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json") });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.status, "conformant");
  // stage_blocked keeps its published required-QA meaning; the doctor block is the finding.
  assert.equal(result.stage_blocked, false);
  const finding = result.warnings.find((entry) => entry.code === "bundle.doctor_output.blocked");
  assert.ok(finding, JSON.stringify(result.warnings, null, 2));
  assert.equal(finding.artifact, "doctor_output");
  assert.match(finding.remedy, /campaigns-os doctor --packet campaign-runtime\.build\.json --write --strip-paths/);
  assert.equal(result.errors.some((entry) => entry.code === "bundle.doctor_output.blocked"), false);
  assert.match(sidecarBundleReadinessLine(result), /^Readiness: BLOCKED \(doctor run is blocked\)/);
}));

test("a blocked doctor run cannot satisfy QA-complete handoff under --require-qa", () => withFixture((root) => {
  blockDoctorSidecar(root);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, "nonconformant");
  assert.equal(result.stage_blocked, false);
  assert.ok(result.errors.some((entry) => entry.code === "bundle.doctor_output.blocked"), JSON.stringify(result.errors, null, 2));
  assert.equal(result.warnings.some((entry) => entry.code === "bundle.doctor_output.blocked"), false);
}));

test("a doctor sidecar whose ok is false blocks even when status is not spelled blocked", () => withFixture((root) => {
  const path = join(root, ".campaign-runtime/doctor-output.json");
  const doctor = readJson(path);
  doctor.ok = false;
  writeJson(path, doctor);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json") });
  assert.ok(result.warnings.some((entry) => entry.code === "bundle.doctor_output.blocked"));
  assert.match(sidecarBundleReadinessLine(result), /^Readiness: BLOCKED \(doctor run is blocked\)/);
}));

test("a blocked QA verdict is reported without --require-qa and the readiness line names it", () => withFixture((root) => {
  const qaPath = join(root, ".campaign-runtime/qa-verdict.json");
  const qa = readJson(qaPath);
  qa.disposition = "blocked";
  qa.assertions[0].status = "fail";
  writeJson(qaPath, qa);
  const result = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json") });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.stage_blocked, false);
  assert.ok(result.warnings.some((entry) => entry.code === "bundle.qa_verdict.blocked"), JSON.stringify(result.warnings, null, 2));
  assert.equal(result.errors.some((entry) => entry.code === "bundle.qa_verdict.blocked"), false);
  assert.match(sidecarBundleReadinessLine(result), /^Readiness: BLOCKED \(QA verdict is blocked\)/);

  blockDoctorSidecar(root);
  const both = inspectSidecarBundle({ packetPath: join(root, "campaign-runtime.build.json") });
  assert.match(sidecarBundleReadinessLine(both), /^Readiness: BLOCKED \(doctor run is blocked; QA verdict is blocked\)/);
}));

test("a ready doctor run leaves the conformance result unchanged and readiness unblocked", () => {
  const result = inspectSidecarBundle({ packetPath: join(FIXTURE, "campaign-runtime.build.json"), requireQa: true });
  assert.equal(result.stage_blocked, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
  assert.equal(Object.hasOwn(result, "readiness"), false);
  assert.match(sidecarBundleReadinessLine(result), /^Readiness: no doctor or QA block recorded/);
});

test("the CLI text report prints a readiness line under Status and keeps it out of --json", () => withFixture((root) => {
  blockDoctorSidecar(root);
  const packetPath = join(root, "campaign-runtime.build.json");
  const text = execFileSync("node", [CLI, "bundle", "check", "--packet", packetPath], { encoding: "utf8" });
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[0], "Status: CONFORMANT");
  assert.match(lines[1], /^Readiness: BLOCKED \(doctor run is blocked\)/);
  assert.ok(lines.some((line) => line.startsWith("- [bundle.doctor_output.blocked]")), text);

  const json = JSON.parse(execFileSync("node", [CLI, "bundle", "check", "--packet", packetPath, "--json"], { encoding: "utf8" }));
  assert.equal(json.stage_blocked, false);
  assert.ok(json.warnings.some((entry) => entry.code === "bundle.doctor_output.blocked"));
  assert.equal(Object.hasOwn(json, "readiness"), false);

  let status = 0;
  try {
    execFileSync("node", [CLI, "bundle", "check", "--packet", packetPath, "--require-qa", "--json"], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 2);
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

test("fresh prepare-build, doctor, and QA projection form a conformant bundle whose blocked doctor still gates handoff", () => {
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
      execFileSync("node", [CLI, "doctor", "--write", "--packet", packetPath, "--strip-paths", "--json"], {
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

    // The example target's doctor run is blocked (its design source package
    // is not ready), so the fresh producers agree with each other and the
    // contract, but a QA projection written beside that doctor cannot make
    // the bundle a QA-complete handoff.
    const doctor = readJson(join(target, ".campaign-runtime/doctor-output.json"));
    assert.equal(doctor.status, "blocked");
    const structural = inspectSidecarBundle({ packetPath });
    assert.equal(structural.ok, true, JSON.stringify(structural.errors, null, 2));
    assert.equal(structural.stage_blocked, false);
    assert.deepEqual(structural.warnings.map((finding) => finding.code), ["bundle.doctor_output.blocked"]);
    const handoff = inspectSidecarBundle({ packetPath, requireQa: true });
    assert.equal(handoff.ok, false);
    assert.deepEqual(handoff.errors.map((finding) => finding.code), ["bundle.doctor_output.blocked"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the machine contract forbids mtime selection and requires explicit historical QA promotion", () => {
  assert.equal(SIDECAR_BUNDLE_CONTRACT.packet_discovery.canonical_funnel_path, "campaign-runtime-<public_route_slug>.build.json");
  assert.equal(SIDECAR_BUNDLE_CONTRACT.packet_discovery.canonical_funnel_route_field, "campaign.public_route_slug");
  assert.deepEqual(SIDECAR_BUNDLE_CONTRACT.sidecar_paths, {
    packet_runtime_directory_field: "assembly.runtime_dir",
    default_runtime_directory: ".campaign-runtime",
    funnel_runtime_directory: ".campaign-runtime/funnels/<public_route_slug>",
    rule: "Each sidecar's runtime_relative_path is relative to the packet's runtime directory, resolved by the shared workspace resolver. An absent assembly.runtime_dir uses .campaign-runtime; a recorded per-funnel directory must name the packet's own campaign.public_route_slug. Any other runtime directory is nonconformant and no sidecars are read. Artifact path values describe the default layout.",
  });
  assert.deepEqual(SIDECAR_BUNDLE_CONTRACT.artifacts.slice(1).map((artifact) => artifact.runtime_relative_path), [
    "build-context.json", "assembly-report.json", "doctor-output.json", "qa-verdict.json",
  ]);
  assert.match(SIDECAR_BUNDLE_CONTRACT.ci_producer.packet_rule, /Every --packet argument takes the funnel's own repository-root packet/);
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

test("local-spec bundle compares local identity across every artifact and refuses mixed provenance", () => withFixture((root) => {
  const paths = {
    packet: join(root, 'campaign-runtime.build.json'),
    report: join(root, '.campaign-runtime/assembly-report.json'),
    context: join(root, '.campaign-runtime/build-context.json'),
    doctor: join(root, '.campaign-runtime/doctor-output.json'),
    qa: join(root, '.campaign-runtime/qa-verdict.json'),
  };
  const packet=readJson(paths.packet), report=readJson(paths.report), context=readJson(paths.context), doctor=readJson(paths.doctor), qa=readJson(paths.qa);
  const localId='local-bundle';
  packet.spec={...packet.spec,map_id:null,local_spec_id:localId,spec_url:null};
  report.identity={...report.identity,map_id:null,local_spec_id:localId,spec_material_hash:'sha256:'+'a'.repeat(64)};
  context.spec.material_hash=report.identity.spec_material_hash;
  doctor.derived={...doctor.derived,map_id:null,local_spec_id:localId};
  qa.local_spec_id=localId;qa.campaign_slug='local-spec-'+localId;qa.spec_hash=report.identity.spec_material_hash;
  for(const [key,value] of Object.entries({packet,report,context,doctor,qa}))writeJson(paths[key],value);
  const check=()=>inspectSidecarBundle({packetPath:paths.packet,requireQa:true});
  assert.equal(check().ok,true,JSON.stringify(check().errors));
  qa.local_spec_id='foreign-local';writeJson(paths.qa,qa);
  assert.ok(check().errors.some(e=>e.code==='bundle.identity.local_spec_id_mismatch'));
  qa.local_spec_id=localId;writeJson(paths.qa,qa);
  doctor.derived.map_id='borrowed-map';writeJson(paths.doctor,doctor);
  assert.ok(check().errors.some(e=>e.code==='bundle.identity.map_id_mismatch'));
}));


test("saved-Map bundle cannot adopt a local verdict whose storage key happens to equal the Map ID", () => withFixture(root => {
  const packetPath=join(root,'campaign-runtime.build.json');
  const packet=readJson(packetPath);
  packet.spec.map_id='local-spec-collision';writeJson(packetPath,packet);
  const reportPath=join(root,'.campaign-runtime/assembly-report.json');
  const report=readJson(reportPath);report.identity.map_id=packet.spec.map_id;writeJson(reportPath,report);
  const doctorPath=join(root,'.campaign-runtime/doctor-output.json');
  const doctor=readJson(doctorPath);doctor.derived.map_id=packet.spec.map_id;writeJson(doctorPath,doctor);
  const qaPath=join(root,'.campaign-runtime/qa-verdict.json');
  const qa=readJson(qaPath);qa.campaign_slug=packet.spec.map_id;qa.local_spec_id='collision';writeJson(qaPath,qa);
  const result=inspectSidecarBundle({packetPath,requireQa:true});
  assert.ok(result.errors.some(e=>e.code==='bundle.identity.local_spec_id_mismatch'));
}));
