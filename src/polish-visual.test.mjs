import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VISUAL_QC_RULES, planVisualCapture, buildCapturesRecord, capturesIntegrity, writePolishPng,
  evaluateVisualReference, evaluateVisualDiff, VISUAL_VIEWPORTS, compareVisualPair } from "./polish-visual.mjs";
import { createRgbaPng, createRgba, syntheticCapturesRecord, syntheticVisualFixture } from "./polish-visual-fixtures.mjs";
import { loadVisualDependencies } from "./visual-diff.mjs";

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
