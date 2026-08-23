import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import {
  computeDesignSourcePackageMaterialFingerprint,
  evaluateDesignSourcePackageReadiness,
  generateDesignSourcePackageReadback,
} from "./design-source-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const DSP_REL_PATH = ".campaign-runtime/input/design-source-package.json";
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateDsp = ajv.compile(readSchema("campaign-design-source-package.v0.schema.json"));
const validatePacket = ajv.compile(readSchema("campaign-runtime-build-packet.v0.schema.json"));
const validateContext = ajv.compile(readSchema("campaign-runtime-build-context.v0.schema.json"));
const validateReport = ajv.compile(readSchema("campaign-runtime-assembly-report.v0.schema.json"));

function readSchema(name) {
  return JSON.parse(readFileSync(resolve(ROOT, "schemas", name), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(path, value, spaces = 2) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, spaces)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
}

function refreshDerived(value) {
  value.readiness = evaluateDesignSourcePackageReadiness(value, {
    generatedAt: value.generated_at,
    now: Date.parse(value.generated_at),
  });
  value.readback = generateDesignSourcePackageReadback(value);
  value.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(value);
  return value;
}

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-dsp-prepare-"));
  const source = join(dir, "source");
  const target = join(dir, "target");
  const specPath = join(dir, "campaignspec.json");
  mkdirSync(join(source, ".campaigns-os"), { recursive: true });
  mkdirSync(join(source, "assets"), { recursive: true });
  mkdirSync(target, { recursive: true });

  const sourceFiles = {
    "landing.html": "<main><h1>Landing</h1><img src=\"assets/product.png\"></main>\n",
    "checkout.html": "<main><h1>Checkout</h1></main>\n",
  };
  for (const [path, content] of Object.entries(sourceFiles)) writeFileSync(join(source, path), content);
  writeFileSync(join(source, "assets/product.png"), "fixture-product-image");
  writeJson(join(source, ".campaigns-os/source-html-manifest.json"), {
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-08-22T10:00:00.000Z",
    generator: "fixture-exporter@1.0.0",
    campaign_slug: "dsp-fixture",
    producer_provenance: {
      source_type: "agency_html_export",
      generator_version: "1.0.0",
      material_fingerprint: "9".repeat(64),
    },
    files: [
      { path: "landing.html", role: "page", sha256: sha256(sourceFiles["landing.html"]) },
      { path: "checkout.html", role: "page", sha256: sha256(sourceFiles["checkout.html"]) },
      { path: "assets/product.png", role: "asset", sha256: sha256("fixture-product-image") },
    ],
    pages: [
      { page_id: "landing", page_type: "landing", page_url: "landing/", path: "landing.html", source_hash: sha256(sourceFiles["landing.html"]) },
      { page_id: "checkout", page_type: "checkout", page_url: "checkout/", path: "checkout.html", source_hash: sha256(sourceFiles["checkout.html"]) },
    ],
  });
  writeJson(specPath, {
    spec_identity: {
      map_id: "map-dsp-fixture",
      public_route_slug: "dsp-fixture",
    },
    campaign: { id: "dsp-fixture", slug: "dsp-fixture" },
    funnels: [{
      id: "default",
      weight: 100,
      pages: [
        { id: "landing", type: "landing", label: "Landing", page_url: "landing/", next_page: "checkout" },
        { id: "checkout", type: "checkout", label: "Checkout", page_url: "checkout/" },
      ],
    }],
  });
  writeJson(join(target, "package.json"), { private: true });

  try {
    return run({ dir, source, target, specPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPrepare({ dir, source, target, specPath }, {
  templateFamily = "olympus",
  extraArgs = [],
} = {}) {
  const result = spawnSync("node", [
    CLI,
    "prepare-build",
    "--spec", specPath,
    "--source", source,
    "--target", target,
    "--template-family", templateFamily,
    "--no-run-session",
    ...extraArgs,
    "--json",
  ], { cwd: dir, encoding: "utf8" });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    json: result.status === 0 ? JSON.parse(result.stdout) : null,
  };
}

function runCli(args, cwd) {
  const result = spawnSync("node", [CLI, ...args, "--json"], { cwd, encoding: "utf8" });
  const stdout = String(result.stdout || "");
  return {
    status: result.status,
    stdout,
    stderr: String(result.stderr || ""),
    json: stdout.trim() ? JSON.parse(stdout) : null,
  };
}

const NEXT_STAGE_REQUESTS = [null, "setup", "build", "polish", "deploy", "qa"];

function makePrepareGateTerminal(report) {
  report.status = "prepared";
  report.blockers = [];
  report.stages.prepare_build.status = "completed";
  report.stages.prepare_build.blockers = [];
  return report;
}

function assertPrepareOnlyNextMatrix(fixture, packetPath, {
  errorCode = null,
  extraArgs = [],
} = {}) {
  for (const stage of NEXT_STAGE_REQUESTS) {
    const next = runCli([
      "next", ...(stage ? [stage] : []), "--packet", packetPath, ...extraArgs, "--no-write",
    ], fixture.dir);
    assert.notEqual(next.status, 0, `${stage || "automatic"}: ${next.stdout || next.stderr}`);
    assert.equal(next.json.stage, "prepare-build", stage || "automatic");
    assert.equal(next.json.status, "blocked", stage || "automatic");
    assert.equal(next.json.gates.find((gate) => gate.id === "prepare_build")?.status, "blocked", stage || "automatic");
    if (errorCode) {
      assert.ok(next.json.errors.some((error) => error.code === errorCode), `${stage || "automatic"}: ${JSON.stringify(next.json.errors, null, 2)}`);
    }
    assert.deepEqual(next.json.next_actions.map((action) => action.id), ["rerun_prepare_build"], stage || "automatic");
  }
}

function targetArtifactPaths(target) {
  return [
    join(target, DSP_REL_PATH),
    join(target, "campaign-runtime.build.json"),
    join(target, ".campaign-runtime/build-context.json"),
    join(target, ".campaign-runtime/assembly-report.json"),
    join(target, ".campaign-runtime/input/campaign-build-brief.normalized.json"),
  ];
}

function snapshotArtifacts(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}

function assertArtifactsUnchanged(snapshot) {
  for (const [path, before] of snapshot) {
    if (before == null) {
      assert.equal(existsSync(path), false, `${path} must remain absent`);
    } else {
      assert.ok(readFileSync(path).equals(before), `${path} must remain byte-identical`);
    }
  }
}

function assertSchema(validate, value, label) {
  assert.equal(validate(value), true, `${label}: ${JSON.stringify(validate.errors, null, 2)}`);
}

test("prepare-build emits a schema-valid DSP and carries one exact-byte reference across packet, context, and report", () => {
  withFixture((fixture) => {
    const result = runPrepare(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.designSourcePackageMode, "emitted");

    const dspPath = join(fixture.target, DSP_REL_PATH);
    const packetPath = join(fixture.target, "campaign-runtime.build.json");
    const contextPath = join(fixture.target, ".campaign-runtime/build-context.json");
    const reportPath = join(fixture.target, ".campaign-runtime/assembly-report.json");
    const rawBytes = readFileSync(dspPath);
    const dsp = JSON.parse(rawBytes.toString("utf8"));
    const packet = readJson(packetPath);
    const context = readJson(contextPath);
    const report = readJson(reportPath);

    assertSchema(validateDsp, dsp, "Design Source Package");
    assertSchema(validatePacket, packet, "Build Packet");
    assertSchema(validateContext, context, "Build Context");
    assertSchema(validateReport, report, "Assembly Report");

    assert.deepEqual(packet.design_source_package, {
      path: DSP_REL_PATH,
      schema_version: "campaign-design-source-package/v0",
      sha256: `sha256:${sha256(rawBytes)}`,
      material_fingerprint: dsp.material_fingerprint,
    });
    assert.equal(context.design_source_package.path, "input/design-source-package.json");
    assert.equal(report.design_source_package.path, "input/design-source-package.json");
    for (const ref of [context.design_source_package, report.design_source_package]) {
      assert.deepEqual({ ...ref, path: packet.design_source_package.path }, packet.design_source_package);
    }

    assert.equal(dsp.readiness.status, "blocked");
    assert.deepEqual(
      new Set(dsp.source_todos.flatMap((todo) => todo.required_viewports || [])),
      new Set(["desktop", "mobile"]),
    );
    assert.deepEqual(
      new Set(dsp.surface_identity.filter((surface) => surface.kind === "page")
        .map((surface) => surface.mappings.campaign_spec_page_id)),
      new Set(["landing", "checkout"]),
    );
    const html = dsp.contributions.find((contribution) => contribution.id === "html-funnel");
    assert.equal(html.provenance.manifest_schema_version, "source-html-manifest/v0");
    assert.equal(html.provenance.generator, "fixture-exporter@1.0.0");
    assert.equal(
      html.provenance.manifest_sha256,
      `sha256:${sha256(readFileSync(join(fixture.source, ".campaigns-os/source-html-manifest.json")))}`,
    );
    assert.equal(html.provenance.asset_crawl_schema_version, "source-asset-crawl/v0");
    assert.equal(resolve(dirname(dspPath), html.provenance.source_root), fixture.source);
    assert.ok(html.source_refs.some((ref) => ref.path === "assets/product.png"));
    const template = dsp.contributions.find((contribution) => contribution.id === "template-baseline");
    assert.equal(Object.hasOwn(template, "template_reference"), false, "family selection is not Template Reference proof");
    assert.deepEqual(template.mappings, []);

    assert.equal(context.status, "blocked");
    assert.equal(report.status, "blocked");
    assert.equal(report.stages.prepare_build.status, "blocked");
    assert.ok(report.blockers.some((blocker) => /capture-landing-desktop/.test(blocker.message)));
    assert.ok(report.stages.prepare_build.blockers.some((blocker) => /capture-landing-desktop/.test(blocker.message)));
    assert.equal(Object.hasOwn(report.stages.assembly, "source_package_material_fingerprint"), false);
    for (const artifact of [packet, context, report]) {
      assert.equal(JSON.stringify(artifact).includes('"surface_identity"'), false, "DSP must be referenced, not embedded");
    }
  });
});

test("packet and context schemas keep the DSP reference optional but make all four reference fields strict", () => {
  for (const name of [
    "campaign-runtime-build-packet.v0.schema.json",
    "campaign-runtime-build-context.v0.schema.json",
  ]) {
    const ref = readSchema(name).properties.design_source_package;
    assert.equal(ref.additionalProperties, false);
    assert.deepEqual(ref.required, ["path", "schema_version", "sha256", "material_fingerprint"]);
  }
});

test("prepare-build validates and reuses harmlessly reformatted DSP bytes without rewriting", () => {
  withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const dspPath = join(fixture.target, DSP_REL_PATH);
    const packageValue = readJson(dspPath);
    packageValue.notes.push("Administrative review note; intentionally non-material.");
    const seededBytes = Buffer.from(`${JSON.stringify(reverseKeys(packageValue), null, 4)}\n`);
    writeFileSync(dspPath, seededBytes);
    const before = statSync(dspPath);

    const second = runPrepare(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.designSourcePackageMode, "reused");
    const afterBytes = readFileSync(dspPath);
    const after = statSync(dspPath);
    assert.ok(afterBytes.equals(seededBytes), "reuse must preserve the original raw bytes");
    assert.equal(after.mtimeMs, before.mtimeMs, "reuse must not touch artifact mtime");
    assert.equal(second.json.packet.design_source_package.sha256, `sha256:${sha256(seededBytes)}`);
    assert.equal(
      second.json.packet.design_source_package.material_fingerprint,
      packageValue.material_fingerprint,
      "administrative bytes must not alter the validated material fingerprint",
    );
  });
});

test("prepare-build refuses stale or contradictory existing packages and leaves their bytes untouched", async (t) => {
  await t.test("stale material fingerprint", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const dspPath = join(fixture.target, DSP_REL_PATH);
    const packageValue = readJson(dspPath);
    packageValue.material_fingerprint = `sha256:${"0".repeat(64)}`;
    const seededBytes = Buffer.from(`${JSON.stringify(packageValue, null, 2)}\n`);
    writeFileSync(dspPath, seededBytes);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /material_fingerprint_stale/);
    assert.ok(readFileSync(dspPath).equals(seededBytes));
  }));

  await t.test("missing current active page", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const dspPath = join(fixture.target, DSP_REL_PATH);
    const packageValue = readJson(dspPath);
    packageValue.surface_identity = packageValue.surface_identity.filter((surface) =>
      surface.mappings?.campaign_spec_page_id !== "checkout");
    for (const contribution of packageValue.contributions) {
      contribution.mappings = contribution.mappings.filter((mapping) => mapping.surface_id !== "checkout");
    }
    packageValue.source_todos = packageValue.source_todos.filter((todo) => !todo.applies_to.includes("checkout"));
    refreshDerived(packageValue);
    const seededBytes = Buffer.from(`${JSON.stringify(packageValue, null, 2)}\n`);
    writeFileSync(dspPath, seededBytes);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_page_missing/);
    assert.ok(readFileSync(dspPath).equals(seededBytes));
  }));

  await t.test("forged ready state with missing coverage", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const dspPath = join(fixture.target, DSP_REL_PATH);
    const packageValue = readJson(dspPath);
    for (const contribution of packageValue.contributions) contribution.mappings = [];
    packageValue.source_todos = [];
    packageValue.readiness = {
      status: "ready",
      blocking_reasons: [],
      gap_count: 0,
      todo_count: 0,
      waiver_count: 0,
      generated_at: packageValue.generated_at,
    };
    packageValue.readback = generateDesignSourcePackageReadback(packageValue);
    packageValue.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(packageValue);
    const seededBytes = Buffer.from(`${JSON.stringify(packageValue, null, 2)}\n`);
    writeFileSync(dspPath, seededBytes);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /readiness_(?:contradiction|blockers)/);
    assert.ok(readFileSync(dspPath).equals(seededBytes));
  }));
});

test("prepare-build refuses current material-input drift without rewriting the DSP or sidecars", async (t) => {
  await t.test("source HTML bytes without a manifest update", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));
    writeFileSync(join(fixture.source, "landing.html"), "<main><h1>Unannounced source edit</h1></main>\n");

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_source_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));

  await t.test("referenced asset bytes", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));
    writeFileSync(join(fixture.source, "assets/product.png"), "revised-fixture-product-image");

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_source_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));

  await t.test("source bytes and updated manifest hashes", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));
    const landingPath = join(fixture.source, "landing.html");
    const revised = "<main><h1>Revised Landing</h1><img src=\"assets/product.png\"></main>\n";
    writeFileSync(landingPath, revised);
    const manifestPath = join(fixture.source, ".campaigns-os/source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.files.find((file) => file.path === "landing.html").sha256 = sha256(revised);
    manifest.pages.find((page) => page.page_id === "landing").source_hash = sha256(revised);
    writeJson(manifestPath, manifest);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_(?:source|html_funnel)_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));

  await t.test("manifest artifact bytes", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));
    const manifestPath = join(fixture.source, ".campaigns-os/source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.generated_at = "2026-08-22T11:00:00.000Z";
    writeJson(manifestPath, manifest);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_html_funnel_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));

  await t.test("manifest provenance", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));
    const manifestPath = join(fixture.source, ".campaigns-os/source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.generator = "fixture-exporter@2.0.0";
    manifest.producer_provenance.generator_version = "2.0.0";
    manifest.producer_provenance.material_fingerprint = "8".repeat(64);
    writeJson(manifestPath, manifest);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_(?:source|html_funnel)_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));

  await t.test("template family", () => withFixture((fixture) => {
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));

    const rerun = runPrepare(fixture, { templateFamily: "shop-three-step" });
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_template_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));
});

test("DSP template material follows the upstream source hint while the packet owns a Build override", async (t) => {
  await t.test("a stable source hint survives a different locked Build choice", () => withFixture((fixture) => {
    const spec = readJson(fixture.specPath);
    spec.spec_identity.preferred_template_family = "olympus";
    writeJson(fixture.specPath, spec);
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const dspPath = join(fixture.target, DSP_REL_PATH);
    const before = readFileSync(dspPath);

    const rerun = runPrepare(fixture, { templateFamily: "shop-three-step" });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(rerun.json.designSourcePackageMode, "reused");
    assert.ok(readFileSync(dspPath).equals(before));
    assert.equal(rerun.json.packet.assembly.template_family, "shop-three-step");
    const dsp = readJson(dspPath);
    assert.match(
      dsp.contributions.find((contribution) => contribution.id === "template-baseline")
        .presentation_intent.summary,
      /olympus/,
    );
  }));

  await t.test("changing the upstream source hint remains material drift", () => withFixture((fixture) => {
    const spec = readJson(fixture.specPath);
    spec.spec_identity.preferred_template_family = "olympus";
    writeJson(fixture.specPath, spec);
    const first = runPrepare(fixture);
    assert.equal(first.status, 0, first.stderr);
    const snapshot = snapshotArtifacts(targetArtifactPaths(fixture.target));
    spec.spec_identity.preferred_template_family = "shop-three-step";
    writeJson(fixture.specPath, spec);

    const rerun = runPrepare(fixture);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /current_template_material_stale/);
    assertArtifactsUnchanged(snapshot);
  }));
});

test("prepare-build rejects every DSP/output collision before mutating artifacts", async (t) => {
  for (const flag of ["--out", "--context-out", "--report-out"]) {
    await t.test(flag, () => withFixture((fixture) => {
      const first = runPrepare(fixture);
      assert.equal(first.status, 0, first.stderr);
      const paths = targetArtifactPaths(fixture.target);
      const snapshot = snapshotArtifacts(paths);
      const dspPath = join(fixture.target, DSP_REL_PATH);

      const collision = runPrepare(fixture, { extraArgs: [flag, dspPath] });
      assert.notEqual(collision.status, 0);
      assert.match(collision.stderr, /output path collision/i);
      assertArtifactsUnchanged(snapshot);
    }));
  }
});

test("prepare-build rejects symlink and hard-link DSP/output aliases before mutating artifacts", async (t) => {
  const cases = [
    { label: "--out symlink", flag: "--out", link: "symlink" },
    { label: "--context-out symlink", flag: "--context-out", link: "symlink" },
    { label: "--report-out symlink", flag: "--report-out", link: "symlink" },
    { label: "--out hard link", flag: "--out", link: "hard" },
  ];
  for (const entry of cases) {
    await t.test(entry.label, () => withFixture((fixture) => {
      const first = runPrepare(fixture);
      assert.equal(first.status, 0, first.stderr);
      const paths = targetArtifactPaths(fixture.target);
      const dspPath = join(fixture.target, DSP_REL_PATH);
      const aliasPath = join(fixture.target, `.campaign-runtime/aliases/${entry.flag.slice(2)}-${entry.link}.json`);
      mkdirSync(dirname(aliasPath), { recursive: true });
      if (entry.link === "hard") linkSync(dspPath, aliasPath);
      else symlinkSync(dspPath, aliasPath);
      const snapshot = snapshotArtifacts([...paths, aliasPath]);

      const collision = runPrepare(fixture, { extraArgs: [entry.flag, aliasPath] });
      assert.notEqual(collision.status, 0);
      assert.match(collision.stderr, /output path collision/i);
      assertArtifactsUnchanged(snapshot);
    }));
  }
});

test("fresh prepare-build rejects dangling and parent-directory symlink aliases before creating the DSP", async (t) => {
  for (const flag of ["--out", "--context-out", "--report-out"]) {
    await t.test(`${flag} dangling leaf`, () => withFixture((fixture) => {
      const paths = targetArtifactPaths(fixture.target);
      const snapshot = snapshotArtifacts(paths);
      const dspPath = join(fixture.target, DSP_REL_PATH);
      const aliasPath = join(fixture.target, `.campaign-runtime/aliases/fresh-${flag.slice(2)}.json`);
      mkdirSync(dirname(aliasPath), { recursive: true });
      symlinkSync(dspPath, aliasPath);

      const collision = runPrepare(fixture, { extraArgs: [flag, aliasPath] });
      assert.notEqual(collision.status, 0);
      assert.match(collision.stderr, /output path collision/i);
      assertArtifactsUnchanged(snapshot);
      assert.equal(lstatSync(aliasPath).isSymbolicLink(), true);
    }));
  }

  await t.test("--out symlinked parent directory", () => withFixture((fixture) => {
    const paths = targetArtifactPaths(fixture.target);
    const snapshot = snapshotArtifacts(paths);
    const inputDir = join(fixture.target, ".campaign-runtime/input");
    const aliasDir = join(fixture.target, ".campaign-runtime/input-alias");
    mkdirSync(inputDir, { recursive: true });
    symlinkSync(inputDir, aliasDir);
    const aliasPath = join(aliasDir, "design-source-package.json");

    const collision = runPrepare(fixture, { extraArgs: ["--out", aliasPath] });
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /output path collision/i);
    assertArtifactsUnchanged(snapshot);
    assert.equal(lstatSync(aliasDir).isSymbolicLink(), true);
  }));
});

test("a nested custom report keeps the DSP reference canonical and omits duplicate blocker paths", () => {
  withFixture((fixture) => {
    const reportPath = join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json");
    const result = runPrepare(fixture, { extraArgs: ["--report-out", reportPath] });
    assert.equal(result.status, 0, result.stderr);
    const report = readJson(reportPath);
    assert.equal(resolve(dirname(reportPath), report.design_source_package.path), join(fixture.target, DSP_REL_PATH));
    for (const blocker of report.stages.prepare_build.blockers) {
      assert.equal(Object.hasOwn(blocker.detail || {}, "design_source_package_path"), false);
    }
  });
});

test("automatic and every explicit downstream next stage refuse a blocked Design Source Package with recovery-only output", async (t) => {
  for (const customReport of [false, true]) {
    await t.test(customReport ? "packet-only next discovers a nested custom report" : "default report", () => withFixture((fixture) => {
      const reportPath = customReport
        ? join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json")
        : join(fixture.target, ".campaign-runtime/assembly-report.json");
      const prepared = runPrepare(fixture, {
        extraArgs: customReport ? ["--report-out", reportPath] : [],
      });
      assert.equal(prepared.status, 0, prepared.stderr);
      const packetPath = join(fixture.target, "campaign-runtime.build.json");

      const automatic = runCli([
        "next", "--packet", packetPath, ...(customReport ? [] : ["--report", reportPath]), "--no-write",
      ], fixture.dir);
      assert.notEqual(automatic.status, 0);
      assert.equal(automatic.json.stage, "prepare-build");
      assert.equal(automatic.json.status, "blocked");
      assert.equal(automatic.json.gates.find((gate) => gate.id === "prepare_build")?.status, "blocked");
      assert.ok(automatic.json.errors.some((error) => error.code === "DESIGN_SOURCE_PACKAGE_NOT_READY"));
      assert.deepEqual(automatic.json.next_actions.map((action) => action.id), ["rerun_prepare_build"]);

      for (const stage of ["setup", "build", "polish", "deploy", "qa"]) {
        const explicit = runCli([
          "next", stage, "--packet", packetPath, ...(customReport ? [] : ["--report", reportPath]), "--no-write",
        ], fixture.dir);
        assert.notEqual(explicit.status, 0);
        assert.equal(explicit.json.stage, "prepare-build");
        assert.equal(explicit.json.status, "blocked");
        assert.equal(explicit.json.gates.find((gate) => gate.id === "prepare_build")?.status, "blocked");
        assert.ok(explicit.json.errors.some((error) => error.code === "DESIGN_SOURCE_PACKAGE_NOT_READY"));
        assert.match(explicit.json.prompt, /Resolve the prepare-build blockers/);
        assert.deepEqual(explicit.json.next_actions.map((action) => action.id), ["rerun_prepare_build"]);
      }
    }));
  }
});

test("packet-only next retains normal selection when a nested custom report records a terminal prepare gate", () => {
  withFixture((fixture) => {
    const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
    writeJson(fixture.specPath, spec);
    writeFileSync(join(fixture.source, "upsell.html"), '<section data-commerce-zone="upsell-offer"></section>');
    writeFileSync(join(fixture.source, "receipt.html"), '<section data-commerce-zone="receipt-summary"></section>');
    rmSync(join(fixture.source, ".campaigns-os/source-html-manifest.json"));
    writeJson(join(fixture.target, "package.json"), { dependencies: { "next-campaign-page-kit": "fixture" } });
    const reportPath = join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json");
    const prepared = runPrepare(fixture, { extraArgs: ["--report-out", reportPath] });
    assert.equal(prepared.status, 0, prepared.stderr);
    mkdirSync(join(fixture.target, "_data"), { recursive: true });
    const campaignEntry = Object.fromEntries([
      "store_name", "store_url", "store_terms", "store_privacy", "store_contact",
      "store_returns", "store_shipping", "store_phone", "store_phone_tel",
    ].map((field) => [field, spec.campaign[field]]));
    campaignEntry.sdk_version = spec.runtime?.sdk_version || spec.global_config?.sdk_version;
    writeJson(join(fixture.target, "_data/campaigns.json"), {
      [spec.campaign.slug]: campaignEntry,
    });
    const report = readJson(reportPath);
    report.status = "prepared";
    report.blockers = [];
    report.stages.prepare_build.status = "completed";
    report.stages.prepare_build.blockers = [];
    writeJson(reportPath, report);
    const packetPath = join(fixture.target, "campaign-runtime.build.json");

    const next = runCli(["next", "--packet", packetPath, "--no-write"], fixture.dir);
    assert.equal(next.status, 0, JSON.stringify(next.json, null, 2));
    assert.equal(next.json.stage, "setup");
    assert.equal(next.json.status, "ready_with_warnings");
    assert.equal(next.json.gates.find((gate) => gate.id === "prepare_build")?.status, "pass");
    assert.deepEqual(next.json.next_actions.map((action) => action.id), ["setup_skill"]);
  });
});

test("packet-only next fails closed when a DSP lifecycle report is unavailable", () => {
  withFixture((fixture) => {
    const reportPath = join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json");
    const prepared = runPrepare(fixture, { extraArgs: ["--report-out", reportPath] });
    assert.equal(prepared.status, 0, prepared.stderr);
    rmSync(reportPath);
    const packetPath = join(fixture.target, "campaign-runtime.build.json");

    for (const stage of [null, "setup", "build", "polish", "deploy", "qa"]) {
      const next = runCli([
        "next", ...(stage ? [stage] : []), "--packet", packetPath, "--no-write",
      ], fixture.dir);
      assert.notEqual(next.status, 0);
      assert.equal(next.json.stage, "prepare-build");
      assert.equal(next.json.status, "blocked");
      assert.equal(next.json.gates.find((gate) => gate.id === "prepare_build")?.status, "blocked");
      assert.match(next.json.reason, /report.*unavailable/i);
      assert.match(next.json.prompt, /report.*unavailable/i);
      assert.deepEqual(next.json.next_actions.map((action) => action.id), ["rerun_prepare_build"]);
    }
  });
});

test("packet-only next treats a mismatched context packet binding as blocking even with a planted ready default report", () => {
  withFixture((fixture) => {
    const customReportPath = join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json");
    const prepared = runPrepare(fixture, { extraArgs: ["--report-out", customReportPath] });
    assert.equal(prepared.status, 0, prepared.stderr);
    const packetPath = join(fixture.target, "campaign-runtime.build.json");
    const contextPath = join(fixture.target, ".campaign-runtime/build-context.json");
    const defaultReportPath = join(fixture.target, ".campaign-runtime/assembly-report.json");

    const customReport = makePrepareGateTerminal(readJson(customReportPath));
    writeJson(customReportPath, customReport);
    const plantedDefault = structuredClone(customReport);
    plantedDefault.design_source_package.path = "input/design-source-package.json";
    writeJson(defaultReportPath, plantedDefault);
    const context = readJson(contextPath);
    context.packet_path = "./foreign-packet.json";
    writeJson(contextPath, context);

    assertPrepareOnlyNextMatrix(fixture, packetPath, {
      errorCode: "next.prepare_build.context_packet_mismatch",
    });
  });
});

test("packet-only next refuses a terminal foreign report selected by the current context", () => {
  withFixture((fixture) => {
    const originalReportPath = join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json");
    const prepared = runPrepare(fixture, { extraArgs: ["--report-out", originalReportPath] });
    assert.equal(prepared.status, 0, prepared.stderr);
    const packetPath = join(fixture.target, "campaign-runtime.build.json");
    const contextPath = join(fixture.target, ".campaign-runtime/build-context.json");
    const foreignReportPath = join(dirname(originalReportPath), "foreign-report.json");

    const report = makePrepareGateTerminal(readJson(originalReportPath));
    report.inputs.packet_path = "./foreign-packet.json";
    report.inputs.context_path = "./foreign-context.json";
    report.identity.map_id = "map-foreign";
    report.identity.public_route_slug = "foreign-campaign";
    report.design_source_package = {
      path: "foreign-design-source-package.json",
      schema_version: "campaign-design-source-package/v9",
      sha256: `sha256:${"f".repeat(64)}`,
      material_fingerprint: `sha256:${"e".repeat(64)}`,
    };
    writeJson(foreignReportPath, report);
    const context = readJson(contextPath);
    context.report_path = "./.campaign-runtime/reports/nested/foreign-report.json";
    writeJson(contextPath, context);

    assertPrepareOnlyNextMatrix(fixture, packetPath, {
      errorCode: "next.prepare_build.report_packet_mismatch",
    });
  });
});

test("each report identity and DSP binding independently blocks an otherwise terminal prepare gate", async (t) => {
  const cases = [
    ["context DSP hash", "next.prepare_build.context_dsp_mismatch", ({ context }) => { context.design_source_package.sha256 = `sha256:${"f".repeat(64)}`; }],
    ["report packet", "next.prepare_build.report_packet_mismatch", ({ report }) => { report.inputs.packet_path = "./foreign-packet.json"; }],
    ["report context", "next.prepare_build.report_context_mismatch", ({ report }) => { report.inputs.context_path = "./foreign-context.json"; }],
    ["campaign map", "next.prepare_build.report_campaign_mismatch", ({ report }) => { report.identity.map_id = "map-foreign"; }],
    ["campaign slug", "next.prepare_build.report_campaign_mismatch", ({ report }) => { report.identity.public_route_slug = "foreign-campaign"; }],
    ["DSP schema", "next.prepare_build.report_dsp_mismatch", ({ report }) => { report.design_source_package.schema_version = "campaign-design-source-package/v9"; }],
    ["DSP hash", "next.prepare_build.report_dsp_mismatch", ({ report }) => { report.design_source_package.sha256 = `sha256:${"f".repeat(64)}`; }],
    ["DSP fingerprint", "next.prepare_build.report_dsp_mismatch", ({ report }) => { report.design_source_package.material_fingerprint = `sha256:${"e".repeat(64)}`; }],
    ["DSP path", "next.prepare_build.report_dsp_mismatch", ({ report }) => { report.design_source_package.path = "foreign-design-source-package.json"; }],
  ];
  for (const [label, errorCode, mutate] of cases) {
    await t.test(label, () => withFixture((fixture) => {
      const reportPath = join(fixture.target, ".campaign-runtime/reports/nested/assembly-report.json");
      const prepared = runPrepare(fixture, { extraArgs: ["--report-out", reportPath] });
      assert.equal(prepared.status, 0, prepared.stderr);
      const packetPath = join(fixture.target, "campaign-runtime.build.json");
      const context = readJson(join(fixture.target, ".campaign-runtime/build-context.json"));
      const report = makePrepareGateTerminal(readJson(reportPath));
      mutate({ context, report });
      writeJson(join(fixture.target, ".campaign-runtime/build-context.json"), context);
      writeJson(reportPath, report);

      const next = runCli(["next", "--packet", packetPath, "--no-write"], fixture.dir);
      assert.notEqual(next.status, 0);
      assert.equal(next.json.stage, "prepare-build");
      assert.ok(next.json.errors.some((error) => error.code === errorCode), JSON.stringify(next.json.errors, null, 2));
      assert.deepEqual(next.json.next_actions.map((action) => action.id), ["rerun_prepare_build"]);
    }));
  }
});

test("a terminal prepare status cannot override retained DSP blocker evidence", () => {
  withFixture((fixture) => {
    const prepared = runPrepare(fixture);
    assert.equal(prepared.status, 0, prepared.stderr);
    const packetPath = join(fixture.target, "campaign-runtime.build.json");
    const reportPath = join(fixture.target, ".campaign-runtime/assembly-report.json");
    const report = readJson(reportPath);
    report.stages.prepare_build.status = "completed";
    writeJson(reportPath, report);

    assertPrepareOnlyNextMatrix(fixture, packetPath, {
      errorCode: "DESIGN_SOURCE_PACKAGE_NOT_READY",
    });
  });
});

test("each contradictory prepare ledger signal independently blocks a terminal stage", async (t) => {
  const cases = [
    ["blocked report status", (report) => {
      report.status = "blocked";
      report.blockers = [];
      report.stages.prepare_build.blockers = [];
    }],
    ["stage blockers", (report, dspBlocker) => {
      report.status = "prepared";
      report.blockers = [];
      report.stages.prepare_build.blockers = [dspBlocker];
    }],
    ["top-level DSP blockers", (report, dspBlocker) => {
      report.status = "prepared";
      report.blockers = [dspBlocker];
      report.stages.prepare_build.blockers = [];
    }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => withFixture((fixture) => {
      const prepared = runPrepare(fixture);
      assert.equal(prepared.status, 0, prepared.stderr);
      const packetPath = join(fixture.target, "campaign-runtime.build.json");
      const reportPath = join(fixture.target, ".campaign-runtime/assembly-report.json");
      const report = readJson(reportPath);
      const dspBlocker = report.blockers.find((blocker) => blocker.code === "DESIGN_SOURCE_PACKAGE_NOT_READY");
      assert.ok(dspBlocker);
      report.stages.prepare_build.status = "completed";
      mutate(report, dspBlocker);
      writeJson(reportPath, report);

      const next = runCli(["next", "--packet", packetPath, "--no-write"], fixture.dir);
      assert.notEqual(next.status, 0);
      assert.equal(next.json.stage, "prepare-build");
      assert.equal(next.json.gates.find((gate) => gate.id === "prepare_build")?.status, "blocked");
      assert.deepEqual(next.json.next_actions.map((action) => action.id), ["rerun_prepare_build"]);
    }));
  }
});
