import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { assertNoNetworkAttempts, readJson, ROOT, runCli, writeJson } from "./qc-test-factories.mjs";
import { BUILT_FIRST_LABEL, computeDesignSourcePackageMaterialFingerprint, createDesignSourcePackageArtifactReference } from "./design-source-package.mjs";
import { parseArgs, prepareBuildRerunCommand } from "./cli.mjs";
import { runReadbackCommand } from "./readback.mjs";
import { evaluateDesignAccess } from "./parity/design-access.mjs";

afterEach(assertNoNetworkAttempts);

async function fixture(t, adopted = false, customSidecars = false) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-recorded-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "target"), source = join(target, "src/short");
  cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
  const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
  spec.spec_identity.public_route_slug = "long-campaign-name";
  spec.campaign.slug = "long-campaign-name";
  const pages = spec.funnels.flatMap((funnel) => funnel.pages);
  for (const page of pages) delete page.sdk_hints;
  const manifestPath = join(dir, "design-manifest.json");
  writeJson(manifestPath, { schema_version: "source-html-manifest/v0", pages: pages.map((page) => ({
    page_id: page.id, path: `${page.id}.html`,
    design_file: { type: "other", file_url: "https://design.example.test/files/example-design" },
    screenshot_refs: ["desktop", "mobile"].map((viewport) => ({ viewport, path: `${viewport}.png`,
      width: viewport === "desktop" ? 1440 : 390, height: 900, sha256: "a".repeat(64) })),
  })) });
  const specPath = join(dir, "spec.json");
  const sidecarArgs = customSidecars ? ["--context", join(target, "records/context.json"), "--report", join(target, "records/report.json")] : [];
  writeJson(specPath, spec);
  writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  writeJson(join(target, "_data/campaigns.json"), { short: { ...spec.campaign, sdk_version: spec.global_config.sdk_version } });
  const prepared = await runCli(["prepare-build", "--spec", specPath, "--target", target, "--template-family", "olympus",
    "--design-manifest", manifestPath, ...(adopted ? ["--adopt", "src/short"] : ["--route", "short", "--source", source]),
    ...(customSidecars ? ["--context-out", sidecarArgs[1], "--report-out", sidecarArgs[3]] : []),
    "--no-run-session", "--no-remit", "--json"]);
  assert.equal(prepared.error, null, prepared.error?.stack);
  assert.equal(prepared.exitCode, 0, prepared.stdout);
  const f = { ...prepared.json, target, source, spec, manifestPath, sidecarArgs };
  f.dspPath = join(dirname(f.packetPath), f.packet.design_source_package.path);
  f.dsp = readJson(f.dspPath);
  assert.equal(f.dsp.readiness.status, "ready");
  for (const page of f.packet.source_html.pages) {
    const path = join(target, "_site", page.page_kit.public_route, "index.html");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "<!doctype html><html><head><title>Example</title></head><body>Example page</body></html>");
  }
  const doctor = await runCli(["doctor", "--packet", f.packetPath, ...sidecarArgs, "--no-live-refs", "--json"]);
  assert.equal(doctor.json.ok, true, JSON.stringify(doctor.json.errors));
  return f;
}

function editPackage(f, refreshFingerprint = false) {
  f.dsp.source_kind = "built_first";
  if (refreshFingerprint) f.dsp.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(f.dsp);
  writeJson(f.dspPath, f.dsp);
}

for (const refreshFingerprint of [false, true]) {
  test(`package-only built_first edit (recomputed material: ${refreshFingerprint}) grants no doctor label or design.access exclusion`, async (t) => {
    const f = await fixture(t);
    editPackage(f, refreshFingerprint);
    const doctor = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
    assert.ok(!doctor.json.warnings.some((issue) => issue.code === "design_source.built_first"));
    assert.ok(doctor.json.derived.prepare_build_gate.issues.some((issue) => issue.code === "next.prepare_build.report_dsp_mismatch"));
    assert.ok(doctor.json.errors.some((issue) => issue.code === "next.prepare_build.report_dsp_mismatch"));
    assert.equal(doctor.json.ok, false);
    assert.equal(doctor.json.next.status, "blocked");
    assert.ok(!doctor.json.derived.qc_results.some((row) => row.reason_code === "built_first"));
  });

  test(`package-only built_first edit (recomputed material: ${refreshFingerprint}) grants no next/readback label or --adopt recovery`, async (t) => {
    const f = await fixture(t);
    editPackage(f, refreshFingerprint);
    const next = await runCli(["next", "--packet", f.packetPath, "--no-write", "--no-remit", "--json"]);
    assert.ok(!next.json.prompt.includes(BUILT_FIRST_LABEL), next.stdout);
    assert.doesNotMatch(JSON.stringify(next.json.next_actions), /--adopt/);
    assert.ok(!runReadbackCommand(parseArgs(["readback", f.target, "--packet", f.packetPath])).text.includes(BUILT_FIRST_LABEL));
    for (const context of [null, f.context, { ...f.context, intake: { ...f.context.intake, adopt: "src/short" } }]) {
      assert.doesNotMatch(prepareBuildRerunCommand({ packet: f.packet, packetPath: f.packetPath, context, targetRepo: f.target }).command, /--adopt/);
    }
  });
}

test("even matching edited package hashes do not replace recorded adoption for design access", async (t) => {
  const f = await fixture(t);
  editPackage(f, true);
  const reference = createDesignSourcePackageArtifactReference(f.dsp, { path: f.dspPath, serialized: readFileSync(f.dspPath) });
  f.packet.design_source_package = reference;
  f.context.design_source_package = reference;
  f.report.design_source_package = reference;
  writeJson(f.packetPath, f.packet);
  writeJson(f.contextPath, f.context);
  writeJson(f.reportPath, f.report);
  const rows = evaluateDesignAccess({ activePages: [{ id: "landing" }], mappings: [{ page_id: "landing", path: "landing.html" }],
    manifest: { pages: [{ page_id: "landing", path: "landing.html", design_file: { type: "figma", file_url: "https://www.figma.com/design/SYNTHKEYA0001/example" } }] },
    designSourcePackage: f.dsp, packet: f.packet, packetPath: f.packetPath });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].result, "excluded");
  assert.notEqual(rows[0].reason_code, "built_first");
});

test("a package-only built_first edit cannot hide design-file review rows", async (t) => {
  const f = await fixture(t);
  const manifest = readJson(f.manifestPath);
  for (const page of manifest.pages) page.design_file.file_url = "https://design.example.test/files/example-revision";
  writeJson(f.manifestPath, manifest);
  editPackage(f);
  const doctor = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
  const rows = doctor.json.derived.qc_results.filter((row) => row.check === "design.access");
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.result === "review" && row.reason_code === "design_reference_changed" && !row.accept_eligible));
});

test("an adopted intake with an edited package loses labels, exclusions and --adopt recovery", async (t) => {
  const f = await fixture(t, true);
  f.dsp.notes.push("Example administrative edit");
  writeJson(f.dspPath, f.dsp);
  const doctor = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
  assert.ok(!doctor.json.warnings.some((issue) => issue.code === "design_source.built_first"));
  assert.ok(doctor.json.errors.some((issue) => issue.code === "next.prepare_build.report_dsp_mismatch"));
  assert.ok(!doctor.json.derived.qc_results.some((row) => row.reason_code === "built_first"));
  const next = await runCli(["next", "--packet", f.packetPath, "--no-write", "--no-remit", "--json"]);
  assert.doesNotMatch(next.json.prompt, /--adopt/);
  assert.ok(!next.json.prompt.includes(BUILT_FIRST_LABEL));
  assert.ok(!runReadbackCommand(parseArgs(["readback", f.target, "--packet", f.packetPath])).text.includes(BUILT_FIRST_LABEL));
  assert.doesNotMatch(prepareBuildRerunCommand({ packet: f.packet, packetPath: f.packetPath, context: f.context, targetRepo: f.target }).command, /--adopt/);
});

test("doctor validates an adopted intake's recorded external design manifest just like an ordinary intake", async (t) => {
  const warnings = [];
  for (const adopted of [false, true]) {
    const f = await fixture(t, adopted);
    const manifest = readJson(f.manifestPath);
    manifest.wrapper_policy = "unknown_example_policy";
    writeJson(f.manifestPath, manifest);
    const doctor = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
    warnings.push(doctor.json.warnings.filter((issue) => issue.code === "source_html.manifest").map((issue) => ({ ...issue, message: issue.message.replaceAll(f.manifestPath, "<manifest>") })));
  }
  assert.ok(warnings[0].length > 0);
  assert.deepEqual(warnings[1], warnings[0]);
});

test("genuine recorded adoption keeps labels and recovery with custom context and report paths", async (t) => {
  const f = await fixture(t, true, true);
  const doctor = await runCli(["doctor", "--packet", f.packetPath, ...f.sidecarArgs, "--no-live-refs", "--json"]);
  assert.equal(doctor.json.warnings.find((issue) => issue.code === "design_source.built_first")?.message, BUILT_FIRST_LABEL);
  assert.equal(doctor.json.derived.qc_results.filter((row) => row.check === "design.access" && row.reason_code === "built_first").length, 4);
  const next = await runCli(["next", "--packet", f.packetPath, ...f.sidecarArgs, "--no-write", "--no-remit", "--json"]);
  assert.ok(next.json.prompt.includes(BUILT_FIRST_LABEL));
  assert.ok(runReadbackCommand(parseArgs(["readback", f.target, "--packet", f.packetPath, ...f.sidecarArgs])).text.includes(BUILT_FIRST_LABEL));
  assert.match(prepareBuildRerunCommand({ packet: f.packet, packetPath: f.packetPath, context: f.context, targetRepo: f.target }).command, /--adopt src\/short/);
});

test("a supplied report resolves its package reference from its own directory for every label reader", async (t) => {
  const f = await fixture(t, true);
  rmSync(join(f.target, "_site"), { recursive: true });
  const reportPath = join(f.target, "copied/report.json");
  const report = structuredClone(f.report);
  report.stages.prepare_build.status = "blocked";
  report.stages.prepare_build.blockers = [{ code: "EXAMPLE_SOURCE_BLOCKER", message: "Example source gap needs resolution." }];
  for (const samePackage of [true, false]) {
    report.design_source_package.path = samePackage
      ? relative(dirname(reportPath), f.dspPath)
      : f.report.design_source_package.path;
    writeJson(reportPath, report);
    const doctor = await runCli(["doctor", "--packet", f.packetPath, "--report", reportPath, "--no-live-refs", "--json"]);
    assert.equal(doctor.error, null, doctor.error?.stack);
    assert.equal(doctor.json.warnings.some((issue) => issue.code === "design_source.built_first"), samePackage, "doctor label");
    const next = await runCli(["next", "--packet", f.packetPath, "--report", reportPath, "--no-write", "--no-remit", "--json"]);
    assert.equal(next.error, null, next.error?.stack);
    assert.equal(next.json.prompt.includes(BUILT_FIRST_LABEL), samePackage, "next label");
    assert.equal(next.json.prompt.includes("--adopt src/short"), samePackage, `next recovery: ${next.json.prompt}`);
    const readback = runReadbackCommand(parseArgs(["readback", f.target, "--packet", f.packetPath, "--report", reportPath]));
    assert.equal(readback.text.includes(BUILT_FIRST_LABEL), samePackage, "readback label");
  }
});
