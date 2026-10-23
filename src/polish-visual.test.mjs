import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VISUAL_QC_RULES, planVisualCapture, buildCapturesRecord, capturesIntegrity, writePolishPng,
  evaluateVisualReference, evaluateVisualDiff, VISUAL_VIEWPORTS, compareVisualPair } from "./polish-visual.mjs";
import { createRgbaPng, createRgba, syntheticCapturesRecord, syntheticVisualFixture } from "./polish-visual-fixtures.mjs";
import { loadVisualDependencies } from "./visual-diff.mjs";
import { runVisualPass, runVisualCells } from "./polish-visual.mjs";
import { planPolishCapture } from "./polish-node.mjs";
import { computeDesignSourcePackageMaterialFingerprint } from "./design-source-package.mjs";
import { evaluatePolishGate, POLISH_PRODUCER } from "./polish-gate.mjs";
import { execFile, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { sha256Hex } from "./png-header.mjs";

function visualInputs(f) {
  const packet = { source_html: { root: "source", pages: [{ page_id: "page", path: "page.html", page_kit: { public_route: "/sample/page/", spec_route: "page/" } }] },
    design_source_package: { path: "dsp.json" } };
  const dsp = { surface_identity: [{ id: "page", mappings: { source_page_id: "page" } }], contributions: [{ kind: "html_funnel",
    source_refs: [{ id: "html", kind: "html_file", path: "page.html", sha256: f.linkedSource.identity.sha256 }],
    mappings: [{ surface_id: "page", screenshot_refs: ["desktop", "mobile"] }], screenshot_refs: ["desktop", "mobile"].map((viewport) => ({
      id: viewport, viewport, path: `${viewport}.png`, scale_factor: 1, captured_at: "2026-01-01T00:00:00.000Z", source_ref_id: "html" })) }] };
  f.write("desktop.png", createRgbaPng(1440, 1200)); f.write("mobile.png", createRgbaPng(390, 844));
  writeFileSync(resolve(f.targetRepo, "dsp.json"), JSON.stringify(dsp));
  const report = { ...f.report, identity: { public_route_slug: "sample" }, design_source_package: { material_fingerprint: computeDesignSourcePackageMaterialFingerprint(dsp) } };
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:1234" });
  const subject = { build_fingerprint: report.stages.assembly.build_fingerprint, campaign_slug: "sample", route_scope: "all",
    routes: ["/sample/page/"], viewports: ["desktop", "mobile"] };
  return { packet, report, packetPath: resolve(f.targetRepo, "packet.json"), targetRepo: f.targetRepo, frozen: { plan, page_load: { subject } }, now: "2026-01-01T00:00:00.000Z" };
}
function fakeVisualAdapter({ consume = () => {} } = {}) {
  return { async close() {}, async renderForCompare({ viewport, probes }) {
    consume();
    const readings = {};
    for (const probe of probes) {
      if (probe.select && !probe.select()) continue;
      readings[probe.name] = { status: "measured", value: probe.name === "visual_sections" ? { status: "no_section_keys", bands: [], capped: false } : { synthetic: true }, elapsed_ms: 7 };
      probe.onResult?.(readings[probe.name]);
    }
    const shot = { status: "captured", bytes: createRgbaPng(viewport.width, viewport.height),
      crop: { x: 0, y: 0, width: viewport.width, height: viewport.height }, full_height_css: viewport.height, truncated: false };
    return { status: "rendered", readiness: { fonts: { status: "settled", failed_faces: 0, waited_ms: 0 }, await: { status: "not_present", remaining_count: 0, waited_ms: 0 } },
      probes: readings,
      actual: shot, stabilized: { ...shot, treatment: { animations: "disabled", caret: "hide", mask_color: "#ff00ff", mask_selectors: "visual-masks/v1", masks: [], mask_cap_reached: false } } };
  } };
}
test("RC-1 and RC-2: select skips only its side/cell and onResult delivers the timed probe result in order", async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup); const input = visualInputs(f);
  const selected = [], observed = [];
  const plan = planVisualCapture(input.frozen.plan);
  const sources = new Map([["page", { url_path: "/page.html" }]]);
  const cells = await runVisualCells({ pairs: plan, sourceOrigin: "http://127.0.0.1:2345", sources,
    buildAdapter: fakeVisualAdapter(), sourceAdapter: fakeVisualAdapter(), writePng: (bytes) => writePolishPng(f.targetRepo, "captures", bytes),
    probes: [{ name: "parity", source: "function() {}", boundMs: 10,
      select(cell) { selected.push([cell.side, cell.viewport]); return cell.side === "build"; },
      onResult(cell, result) { observed.push([cell.side, cell.viewport, result]); } }] });
  assert.deepEqual(selected, [["build", "desktop"], ["source_html", "desktop"], ["build", "mobile"], ["source_html", "mobile"]]);
  assert.deepEqual(observed.map(([side, viewport]) => [side, viewport]), [["build", "desktop"], ["build", "mobile"]]);
  assert.ok(observed.every(([, , r]) => r.status === "measured" && r.elapsed_ms === 7));
  assert.ok(cells.filter((c) => c.side === "source_html").every((c) => c.probes.parity === undefined));
});
// The run executes in a child so that a blocking open fails this test by its
// kill timer instead of holding the test runner forever.
const visualPassChild = (input) => new Promise((done) => {
  const code = `import { runVisualPass } from ${JSON.stringify(new URL("./polish-visual.mjs", import.meta.url).href)};
    import { createRgbaPng } from ${JSON.stringify(new URL("./polish-visual-fixtures.mjs", import.meta.url).href)};
    const input = JSON.parse(process.argv[1]);
    const adapter = { async close() {}, async renderForCompare({ viewport }) {
      const shot = { status: "captured", bytes: createRgbaPng(viewport.width, viewport.height), full_height_css: viewport.height,
        crop: { x: 0, y: 0, width: viewport.width, height: viewport.height }, truncated: false };
      return { status: "rendered", readiness: { fonts: { status: "settled", failed_faces: 0, waited_ms: 0 }, await: { status: "not_present", remaining_count: 0, waited_ms: 0 } },
        probes: {}, actual: shot, stabilized: { ...shot, treatment: { mask_selectors: "visual-masks/v1", masks: [], mask_cap_reached: false } } };
    } };
    const started = performance.now();
    const record = await runVisualPass({ ...input, createBrowserAdapter: async () => adapter });
    console.log(JSON.stringify({ elapsed_ms: performance.now() - started, record }));`;
  execFile(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(input)], { timeout: 60_000, maxBuffer: 64 << 20 },
    (error, stdout) => done({ error, result: error ? null : JSON.parse(stdout) }));
});
test("C2 declared inputs: a FIFO or directory at a source, reference, built page, DSP or capture content address is refused without blocking, inside the added budget", { skip: process.platform === "win32" }, async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup); const input = visualInputs(f);
  const budget = { captureMs: 20_000, diffMs: 20_000, addedMs: 20_000 };
  const fifo = (path) => { rmSync(path, { recursive: true, force: true }); mkdirSync(resolve(path, ".."), { recursive: true }); execFileSync("mkfifo", [path]); };
  fifo(resolve(f.sourceRoot, "page.html"));
  fifo(resolve(f.sourceRoot, "desktop.png"));
  rmSync(resolve(f.sourceRoot, "mobile.png")); mkdirSync(resolve(f.sourceRoot, "mobile.png"));
  fifo(resolve(f.targetRepo, "_site/sample/page/index.html"));
  // The content address the desktop shots will be written to.
  fifo(resolve(f.targetRepo, `.campaign-runtime/polish/captures/${sha256Hex(createRgbaPng(1440, 1200))}.png`));
  const { error, result } = await visualPassChild({ ...input, budget });
  assert.equal(error, null);
  assert.ok(result.elapsed_ms < budget.addedMs);
  const { record } = result;
  const byRef = Object.fromEntries(record.references.map((r) => [r.ref_id, r]));
  // path_rel keeps verifyReference's own formula (relative to the target, from the realpath).
  assert.equal(byRef.source_html.verification.reason, "file_missing"); assert.match(byRef.source_html.path_rel, /source\/page\.html$/);
  assert.equal(byRef.desktop.verification.reason, "file_missing"); assert.match(byRef.desktop.path_rel, /source\/desktop\.png$/);
  assert.equal(byRef.mobile.verification.reason, "file_missing");
  assert.ok(record.cells.filter((c) => c.side === "source_html").every((c) => c.status === "source_html_missing"));
  const builds = Object.fromEntries(record.cells.filter((c) => c.side === "build").map((c) => [c.viewport, c]));
  assert.equal(builds.desktop.actual.status, "failed"); assert.equal(builds.desktop.actual.png, null);
  assert.equal(builds.mobile.actual.status, "captured");

  // The Design Source Package itself (the capture binding's read is covered in polish-node.test.mjs).
  const g = syntheticVisualFixture(); t.after(g.cleanup); const second = visualInputs(g);
  fifo(resolve(g.targetRepo, "dsp.json"));
  const run = await visualPassChild({ ...second, budget });
  assert.equal(run.error, null); assert.ok(run.result.elapsed_ms < budget.addedMs);
  assert.deepEqual(run.result.record.references.map((r) => r.ref_id), ["source_html"]);
});
// A report whose gate reads the Polish evidence (polish.evidence_current), so
// gate invariance is not vacuous.
function completedPolishReport(report) {
  const fingerprint = report.design_source_package.material_fingerprint;
  return { ...report, stages: { ...report.stages,
    assembly: { ...report.stages.assembly, status: "completed", source_package_material_fingerprint: fingerprint },
    polish: { stage: "polish", status: "completed_with_warnings", performed_by: POLISH_PRODUCER, source_build_fingerprint: report.stages.assembly.build_fingerprint,
      source_package_material_fingerprint: fingerprint, completed_at: "2026-01-01T00:00:00.000Z", evidence: {
        visual_review: { screenshots: ["qa-output/page-desktop.png"] },
        brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: { cleared: true, promo_codes: "none", fonts: "design fonts only", colors: "tokenized" } },
        checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
        template_residue_review: { next_blue: "not found", starter_favicon: "not found", lorem: "not found" },
        commerce_flow_review: { shop_single_step: "synthetic review" }, issues: [], commands: ["next-campaigns-polish"] } } } };
}
test("F3C-I5: unavailable source root preserves build captures and distinguishes source and image comparisons", async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup); const input = visualInputs(f);
  input.packet.source_html.root = "missing";
  const record = await runVisualPass({ ...input, createBrowserAdapter: async () => fakeVisualAdapter() });
  assert.equal(record.source.status, "missing");
  const builds = record.cells.filter((c) => c.side === "build");
  assert.equal(builds.length, 2);
  assert.ok(builds.every((c) => c.status === "rendered" && c.actual.status === "captured" && c.stabilized.status === "captured"));
  assert.ok(builds.every((c) => existsSync(resolve(f.targetRepo, c.actual.png.path))));
  assert.ok(record.cells.filter((c) => c.side === "source_html").every((c) => c.status === "source_root_unavailable"));
  const rows = VISUAL_QC_RULES.evaluate(record);
  const references = rows.filter((r) => r.check === "visual.reference");
  // source_html plus one image reference per viewport.
  assert.deepEqual(references.map((r) => [r.subject.key, r.subject.viewport ?? null]).sort(),
    [["ref:desktop", "desktop"], ["ref:mobile", "mobile"], ["source_html", null]]);
  assert.ok(references.every((r) => r.result === "unexercised" && r.reason_code === "source_root_unavailable"));
  const diffs = rows.filter((r) => r.check === "visual.diff");
  assert.deepEqual(diffs.map((r) => [r.subject.key, r.subject.viewport]).sort(),
    [["ref:desktop", "desktop"], ["ref:mobile", "mobile"], ["source_html", "desktop"], ["source_html", "mobile"]]);
  for (const row of diffs) {
    assert.deepEqual([row.result, row.reason_code], ["unexercised", row.subject.key === "source_html" ? "capture_unavailable" : "reference_not_usable"]);
  }
  // Gate: identical field for field with and without the captures record.
  const report = completedPolishReport(input.report);
  const withCaptures = structuredClone(report); withCaptures.stages.polish.evidence.visual_review.captures = record;
  const gate = (value) => { const { screenshot_evidence: _ignored, ...rest } = evaluatePolishGate({ report: value }); return rest; };
  assert.equal(gate(report).code, "polish.evidence_current");
  assert.deepEqual(gate(withCaptures), gate(report));
});
test("A source cell that fails before its shots keeps the recorded treatment, so its diff reads capture_unavailable", async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup); const input = visualInputs(f);
  // The real adapter returns skipped shots without a treatment when navigation fails.
  const skipped = { status: "skipped", bytes: null, full_height_css: null, crop: null, truncated: false };
  const failing = { async close() {}, async renderForCompare() { return { status: "navigation_failed", probes: {}, actual: skipped, stabilized: skipped }; } };
  const record = await runVisualPass({ ...input, createBrowserAdapter: async ({ seal }) => seal ? failing : fakeVisualAdapter() });
  const sources = record.cells.filter((c) => c.side === "source_html");
  assert.ok(sources.every((c) => c.status === "navigation_failed" && c.stabilized.treatment.mask_selectors === "visual-masks/v1"));
  const rows = VISUAL_QC_RULES.evaluate(record).filter((r) => r.check === "visual.diff" && r.subject.key === "source_html");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.reason_code === "capture_unavailable" && r.members.some((m) => m.key === "source_html" && m.reason_code === "navigation_failed")));
});
test("F3C-I8: visual run budget includes launches and marks every remaining cell run_budget_exhausted", async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup); const input = visualInputs(f);
  const diffs = (record) => VISUAL_QC_RULES.evaluate(record).filter((r) => r.check === "visual.diff");
  // (a) The first cell consumes the 240 s run budget.
  let time = 0;
  const record = await runVisualPass({ ...input, clock: { now: () => time }, createBrowserAdapter: async () => fakeVisualAdapter({ consume() { time += 240_000; } }) });
  assert.equal(record.cells[0].status, "rendered");
  assert.ok(record.cells.slice(1).every((c) => c.status === "run_budget_exhausted"));
  // Every comparison needs an exhausted cell: the source_html diffs miss their basis, the mobile image diff its build.
  const rows = diffs(record).filter((r) => r.subject.key === "source_html" || r.subject.viewport === "mobile");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.result === "unexercised" && r.reason_code === "capture_unavailable"));
  assert.ok(diffs(record).every((r) => r.result !== "pass"));
  // (b) Launches are charged to the same budget: the clock advances only while
  // the build adapter starts, so the source adapter is never launched and no cell renders.
  time = 0;
  const launched = [], rendered = [];
  const charged = await runVisualPass({ ...input, clock: { now: () => time }, createBrowserAdapter: async ({ seal }) => {
    launched.push(seal ? "source" : "build"); time += 240_000;
    return fakeVisualAdapter({ consume() { rendered.push(true); } });
  } });
  assert.deepEqual(launched, ["build"]); assert.deepEqual(rendered, []);
  assert.equal(charged.adapters.build.startup, "ok");
  assert.ok(charged.cells.length === 4 && charged.cells.every((c) => c.status === "run_budget_exhausted"));
  assert.equal(diffs(charged).length, 4);
  assert.ok(diffs(charged).every((r) => r.result === "unexercised" && r.reason_code === "capture_unavailable"));
});
test("F3C-W10: direct capture on an upgraded target ignores captures and diffs without changing root or operator ignore files", async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup); const input = visualInputs(f);
  execFileSync("git", ["init", "-q", f.targetRepo]);
  const rootIgnore = "# BEGIN campaigns-os runtime state\n.campaign-runtime/assembly-report.json\n# END campaigns-os runtime state\n";
  writeFileSync(resolve(f.targetRepo, ".gitignore"), rootIgnore);
  const record = await runVisualPass({ ...input, createBrowserAdapter: async () => fakeVisualAdapter() });
  const diff = writePolishPng(f.targetRepo, "diff", createRgbaPng(4, 3));
  const paths = [...record.cells.flatMap((c) => [c.actual.png?.path, c.stabilized.png?.path]), diff.path,
    ".campaign-runtime/polish/captures/.gitignore", ".campaign-runtime/polish/diff/.gitignore"].filter(Boolean);
  for (const path of paths) assert.equal(execFileSync("git", ["check-ignore", path], { cwd: f.targetRepo, encoding: "utf8" }).trim(), path);
  assert.doesNotMatch(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: f.targetRepo, encoding: "utf8" }), /polish\/(captures|diff)/);
  assert.equal(readFileSync(resolve(f.targetRepo, ".gitignore"), "utf8"), rootIgnore);
  const ignore = resolve(f.targetRepo, ".campaign-runtime/polish/captures/.gitignore"); writeFileSync(ignore, "*\n# operator content\n");
  await runVisualPass({ ...input, createBrowserAdapter: async () => fakeVisualAdapter() });
  assert.equal(readFileSync(ignore, "utf8"), "*\n# operator content\n");
});

test("F3C-B14: incorrect mask label refuses every QC row after integrity is recomputed", (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const record = syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo });
  record.cells.find((cell) => cell.side === "source_html").stabilized.treatment.mask_selectors = "visual-masks/v0";
  record.references = [{ route: "/page/", viewport: null, ref_id: "source_html", verification: { level: "decoded" }, provenance: { class: "declared_source" } }];
  record.comparisons = [{ route: "/page/", viewport: "desktop", basis: "source_html", ref_id: null, page: { status: "compared", mismatch_ratio: 0 }, bands: [] }];
  record.integrity = capturesIntegrity(record);
  const rows = VISUAL_QC_RULES.evaluate(record);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.result === "unexercised"));
  assert.ok(rows.every((row) => row.reason_code === "evidence_not_reproducible"));
  assert.ok(rows.every((row) => row.members[0].reason_code === "treatment_invalid"));
});
test("Reference members aggregate independently; a cap prevents accepting self-reference", () => {
  const reference = { verification: { level: "decoded" }, provenance: { class: "self_referential" }, reference_cap_reached: true };
  const row = evaluateVisualReference(reference);
  assert.equal(row.result, "warning"); assert.equal(row.reason_code, "self_referential"); assert.equal(row.accept_eligible, false);
  assert.equal(row.members[2].reason_code, "reference_cap_reached");
  const record = buildCapturesRecord({ buildFingerprint: "build", slug: "sample", references: Array.from({ length: 5 }, (_, i) => ({
    ...reference, reference_cap_reached: false, page_id: "page", route: "/page/", viewport: "desktop", ref_id: `image-${i}`,
  })) });
  const rows = VISUAL_QC_RULES.evaluate(record);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.result === "warning" && !row.accept_eligible && row.members.some((m) => m.reason_code === "reference_cap_reached")));
});
test("Visual plan uses the supplied page_load plan and crosses both sides without mutating it", () => {
  const plan = { route_scope: "selected", routes: [{ page_id: "page", requested_route: "/page/" }], viewports: VISUAL_VIEWPORTS };
  assert.equal(planVisualCapture(null), null);
  const visual = planVisualCapture(plan);
  assert.equal(visual.cells.length, 4); assert.equal(visual.route_scope, "selected");
  assert.deepEqual(visual.cells.map((cell) => [cell.viewport, cell.side]), [["desktop", "build"], ["desktop", "source_html"], ["mobile", "build"], ["mobile", "source_html"]]);
  visual.routes[0].page_id = "other"; assert.equal(plan.routes[0].page_id, "page");
});
test("Record builder snapshots inputs, drops dependency functions and keeps only persisted comparison metrics", async () => {
  const dependencies = await loadVisualDependencies(), cells = [{ status: "synthetic" }];
  const record = buildCapturesRecord({ buildFingerprint: "build", slug: "sample", cells, dependencies,
    comparisons: [{ page: { status: "compared", heatmap: { data: Buffer.from("synthetic") }, mismatch_ratio: 0 }, bands: [] }],
    measuredAt: "2026-01-01T00:00:00.000Z" });
  cells[0].status = "changed";
  assert.equal(record.cells[0].status, "synthetic"); assert.equal(record.integrity, capturesIntegrity(record));
  assert.equal(record.dependencies.decoder.status, "available"); assert.equal(record.dependencies.decoder.decode, undefined);
  assert.equal(record.comparisons[0].page.heatmap, undefined);
});
test("PNG writer records content-addressed bytes and IHDR, preserves an existing ignore file", (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const bytes = createRgbaPng(4, 3), png = writePolishPng(f.targetRepo, "captures", bytes);
  assert.deepEqual(readFileSync(resolve(f.targetRepo, png.path)), bytes);
  assert.equal(png.width_px, 4); assert.equal(png.height_px, 3);
  assert.equal(readFileSync(resolve(f.targetRepo, ".campaign-runtime/polish/captures/.gitignore"), "utf8"), "*\n");
  writeFileSync(resolve(f.targetRepo, ".campaign-runtime/polish/captures/.gitignore"), "operator content\n");
  assert.deepEqual(writePolishPng(f.targetRepo, "captures", bytes), png);
  assert.equal(readFileSync(resolve(f.targetRepo, ".campaign-runtime/polish/captures/.gitignore"), "utf8"), "operator content\n");
  assert.throws(() => writePolishPng(f.targetRepo, "../elsewhere", bytes), /Invalid/);
  assert.throws(() => writePolishPng(f.targetRepo, "diff", bytes.subarray(0, 33)), /truncated/);
});
test("One diff precedence table covers all twelve steps and never depends on score", async (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const record = syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo });
  const build = record.cells[0], basis = record.cells[1];
  const reference = { viewport: "desktop", css_width: 1440, dpr: 1, verification: { level: "decoded" }, provenance: { class: "declared_source" } };
  const comparison = { basis: "reference", page: { status: "compared", mismatch_ratio: 0 }, bands: [] };
  const context = { record, build, basis, reference };
  const cases = [
    [{ ...context, readerFailure: "packet_unavailable", staleBinding: true }, "evidence_not_reproducible"],
    [{ ...context, staleBinding: true, pageMissing: true }, "stale_binding"],
    [{ ...context, pageMissing: true }, "page_not_captured"],
    [{ ...context, reference: { ...reference, viewport: "tablet" } }, "comparison_unsupported"],
    [{ ...context, record: { dependencies: { decoder: { status: "missing" } } }, build: { ...build, status: "browser_unavailable" } }, "diff_unavailable"],
    [{ ...context, build: { ...build, status: "browser_unavailable" }, reference: { ...reference, verification: { level: "unverifiable" } } }, "capture_unavailable"],
    [{ ...context, reference: { ...reference, verification: { level: "unverifiable" } } }, "reference_not_usable"],
    [{ ...context, reference: { ...reference, css_width: 375 } }, "comparison_unsupported"],
    [{ ...context, fileAbsent: true }, "capture_file_absent"],
    [{ ...context, build: { ...build, readiness: { fonts: { status: "timeout" } } } }, "readiness_incomplete"],
    [{ ...context, budgetExhausted: true }, "diff_unavailable"],
    [context, "visual_diff_diagnostic"],
  ];
  for (const [options, reason] of cases) {
    const row = evaluateVisualDiff(comparison, options); assert.equal(row.reason_code, reason);
    assert.ok(!["pass", "warning"].includes(row.result)); assert.equal(row.accept_eligible, false);
  }
  for (const mismatch_ratio of [0, 0.01, 0.5, 1]) assert.equal(evaluateVisualDiff({ ...comparison, page: { status: "compared", mismatch_ratio } }, context).result, "review");
  const incompatible = compareVisualPair({ build, reference: { ...reference, css_width: 375 } });
  assert.equal(incompatible.status, "unsupported"); assert.equal(incompatible.reason, "width_mismatch"); assert.deepEqual(incompatible.artifacts, []);
  const dependencies = await loadVisualDependencies();
  const realComparison = compareVisualPair({ build, basis, basisImage: createRgba(4, 3), buildImage: createRgba(4, 3), diff: dependencies.diff });
  assert.equal(realComparison.page.mismatch_ratio, 0);
});
test("Visual module has no load-time import of the browser adapter or node runner", () => {
  const source = readFileSync(new URL("./polish-visual.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from|import\()\s*["']\.\/polish-(?:node|browser)\.mjs/);
});

test("Every PNG write refuses escaping runtime, intermediate, directory and file symlinks before mutation", (t) => {
  for (const dir of ["captures", "diff"]) for (const component of [".campaign-runtime", ".campaign-runtime/polish", `.campaign-runtime/polish/${dir}`]) {
    const f = syntheticVisualFixture(), outside = syntheticVisualFixture(); t.after(f.cleanup); t.after(outside.cleanup);
    const before = readdirSync(outside.targetRepo, { recursive: true });
    mkdirSync(resolve(f.targetRepo, component, ".."), { recursive: true });
    symlinkSync(outside.targetRepo, resolve(f.targetRepo, component));
    assert.throws(() => writePolishPng(f.targetRepo, dir, createRgbaPng(4, 3)), /path_outside_target/);
    assert.deepEqual(readdirSync(outside.targetRepo, { recursive: true }), before);
    assert.equal(existsSync(resolve(outside.targetRepo, "polish")), false);
  }
  for (const leaf of [".gitignore", "png"]) {
    const f = syntheticVisualFixture(), outside = syntheticVisualFixture(); t.after(f.cleanup); t.after(outside.cleanup);
    const png = writePolishPng(outside.targetRepo, "captures", createRgbaPng(4, 3));
    const directory = resolve(f.targetRepo, ".campaign-runtime/polish/captures"); mkdirSync(directory, { recursive: true });
    const name = leaf === "png" ? png.path.split("/").at(-1) : leaf;
    symlinkSync(resolve(outside.targetRepo, png.path), resolve(directory, name));
    const before = readdirSync(outside.targetRepo, { recursive: true });
    assert.throws(() => writePolishPng(f.targetRepo, "captures", createRgbaPng(4, 3)), /path_outside_target/);
    assert.deepEqual(readdirSync(outside.targetRepo, { recursive: true }), before);
    assert.deepEqual(readdirSync(directory), [name]);
  }
});
test("Record-valued null cells and inherited dependency/shot names produce refusals", (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const original = syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo });
  original.references = [{ route: "/page/", ref_id: "source_html", verification: { level: "decoded" }, provenance: { class: "declared_source" } }];
  original.comparisons = [{ route: "/page/", viewport: "desktop", basis: "source_html", page: { status: "compared" }, bands: [] }];
  for (const value of [null, 0, [], "cell"]) {
    const record = structuredClone(original); record.cells[0] = value; record.integrity = capturesIntegrity(record);
    const rows = VISUAL_QC_RULES.evaluate(record);
    assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.result === "unexercised" && row.reason_code === "evidence_not_reproducible"));
  }
  const build = original.cells[0], basis = original.cells[1], reference = original.references[0];
  const row = evaluateVisualDiff(original.comparisons[0], { build, basis, reference, record: { dependencies: Object.create(original.dependencies) } });
  assert.equal(row.result, "unexercised"); assert.equal(row.reason_code, "diff_unavailable");
  const metadata = buildCapturesRecord({ dependencies: { decoder: null, diff: false } }).dependencies;
  assert.deepEqual(metadata, { decoder: { status: "missing", version: null }, diff: { status: "missing", version: null } });
  assert.equal(evaluateVisualReference(null).reason_code, "evidence_not_reproducible");
  assert.equal(compareVisualPair({ build: null }).reason, "capture_unavailable");
  assert.equal(planVisualCapture({ routes: [null], viewports: VISUAL_VIEWPORTS }), null);
  assert.equal(planVisualCapture({ routes: [{}], viewports: [null] }), null);
  for (const label of ["__proto__", "constructor", "toString"]) {
    const record = structuredClone(original); record.cells[0].stabilized.treatment.mask_selectors = label;
    record.integrity = capturesIntegrity(record);
    assert.ok(VISUAL_QC_RULES.evaluate(record).every((row) => row.result === "unexercised" && row.reason_code === "evidence_not_reproducible"));
  }
  for (const value of [null, 0, [], "cell"]) {
    assert.equal(evaluateVisualReference(value).reason_code, "evidence_not_reproducible");
    assert.equal(evaluateVisualDiff({ ...original.comparisons[0], bands: [value] }, { record: original, build, basis, reference }).reason_code, "evidence_not_reproducible");
  }
  const malformed = buildCapturesRecord({ comparisons: [null], cells: [null] });
  assert.deepEqual(malformed.comparisons, [null]);
  const inheritedShot = Object.assign(Object.create({ stabilized: build.stabilized }), { status: "rendered" });
  assert.equal(evaluateVisualDiff(original.comparisons[0], { record: original, build: inheritedShot, basis, reference }).reason_code, "evidence_not_reproducible");
  const invalidMask = structuredClone(build); invalidMask.stabilized.treatment.masks = [{ group: "__proto__", rects: [] }];
  assert.equal(compareVisualPair({ build: invalidMask, basis }).reason, "evidence_not_reproducible");
});
