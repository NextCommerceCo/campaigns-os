// Stream P2 unit rows: the element_parity record, its probe files and the
// parity.element reader, with C's fake adapters and an injected comparator
// stand-in (the shipped comparator is the P3 stub). Every page is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { computeDesignSourcePackageMaterialFingerprint } from "../design-source-package.mjs";
import { capturePolishPageLoad, capturePolishReadability, mergePolishCaptureEvidence, planPolishCapture } from "../polish-node.mjs";
import { buildCapturesRecord, planVisualCapture, runVisualCells } from "../polish-visual.mjs";
import { assessQcAccepts, buildQcHandoff, createQcAccept, qcAcceptAttribution, qcHandoffTextLines } from "../qc-accept.mjs";
import { handoffCoverage, polishRecordIntegrity, readCurrentQcResults, readElementParity } from "../qc-results.mjs";
import { loadQcRederivers } from "../qc-check-registry.mjs";
import { compareElementParity } from "./compare.mjs";
import { ELEMENT_PARITY_QC_RULES, buildElementParityRecord, PARITY_LIMITS } from "./element-parity-record.mjs";
import { createParityProbeRun } from "./probe.mjs";
import { readParityFile, readParityFileForIdentity, writeParityFile } from "./snapshot.mjs";

const BUILD = `sha256:${"b".repeat(64)}`;
const OTHER_BUILD = `sha256:${"c".repeat(64)}`;
const sha = (char) => `sha256:${char.repeat(64)}`;
const MEASURED_AT = "2026-01-01T00:00:00.000Z";
const VIEWPORTS = { desktop: { width: 1440, height: 1200 }, mobile: { width: 390, height: 844 } };

const element = (index, text, extra = {}) => ({ index, selector_path: `body>p:nth-of-type(${index + 1})`, text, ftext: text,
  box: { x: 40, y: 40 + index * 40, w: 600, h: 24 }, font_family: "Synthetic Sans, sans-serif", font_size_px: 16, font_weight: 400,
  font_style: "normal", line_height: 24, letter_spacing: "normal", text_transform: "none", fg_srgb: [0.1, 0.1, 0.1], bg_srgb: [1, 1, 1],
  color_review: null, ...extra });
const probeOutput = (viewport, { elements = [element(0, "Synthetic headline"), element(1, "Body copy after hero")], coverage = {}, size = VIEWPORTS[viewport], dpr = 1 } = {}) => ({
  viewport: { ...size }, dpr, elements, page_text: elements.map((e) => e.text).join(" "), font_faces: [],
  coverage: { elements_capped: false, time_capped: false, page_text_truncated: false, font_faces_capped: false, closed_shadow_roots: 0, frames_not_read: 0, ...coverage },
});

// The comparator stand-in: a minimal, deterministic Comparison. Viewport and
// DPR mismatch, no design text, else pairs by exact text with a copy finding
// for a missing text and a typography finding for a font-size change.
function standInCompare(design, build) {
  const counts = (d, b, matched = 0, missing = 0) => ({ design: d, build: b, matched, by_pass: { exact_unique: matched, exact_nearest: 0, subtree: 0, fuzzy: 0 },
    unmatched_present: 0, unmatched_missing: missing, unmatched_unverified: 0, below_min_chars: 0 });
  const base = { comparator_version: "parity-compare/v1", invalid: null, drift: { dx: 0, dy: 0, samples: 0 }, pairs: [], findings: [] };
  if (design.viewport.width !== build.viewport.width || design.viewport.height !== build.viewport.height || design.dpr !== build.dpr) {
    return { ...base, status: "viewport_mismatch", counts: counts(0, build.elements.length) };
  }
  const D = design.elements.filter((e) => e.text.trim());
  if (!D.length) return { ...base, status: "design_elements_unavailable", counts: counts(0, build.elements.length) };
  const findings = [];
  let matched = 0, missing = 0;
  for (const d of D) {
    const identity = { text: d.text.toLowerCase(), selector_path: d.selector_path, ordinal: 0 };
    const b = build.elements.find((e) => e.text === d.text);
    if (!b) {
      missing += 1;
      findings.push({ category: "copy", design: d.index, build: null, design_identity: identity,
        members: [{ property: "copy", result: "warning", reason_code: "copy_missing", design: d.text.toLowerCase(), build: null, delta: null }] });
      continue;
    }
    matched += 1;
    if (Math.abs(b.font_size_px - d.font_size_px) - 0.6 > 1e-9) {
      findings.push({ category: "typography", design: d.index, build: b.index, design_identity: identity,
        members: [{ property: "font_size", result: "warning", reason_code: "font_size_differs", design: d.font_size_px, build: b.font_size_px, delta: b.font_size_px - d.font_size_px }] });
    }
  }
  return { ...base, status: "compared", counts: counts(D.length, build.elements.length, matched, missing), findings };
}
const standInRules = (compare = standInCompare) => ({ ...ELEMENT_PARITY_QC_RULES, plan: planPolishCapture, readFile: readParityFile, readFileForIdentity: readParityFileForIdentity, compare });

const page = (id) => ({ page_id: id, path: `${id}.html`, page_kit: { public_route: `/sample/${id}/`, spec_route: `${id}/` } });
function dspFor(pages, recorded) {
  return {
    surface_identity: pages.map((id) => ({ id, kind: "page", mappings: { campaign_spec_page_id: id } })),
    contributions: [{ id: "html-funnel", kind: "html_funnel", source_refs: pages.map((id) => ({ id: `source-${id}-html`, kind: "html_file", path: `${id}.html`,
      ...(recorded[id] === null ? {} : { sha256: recorded[id] ?? sha(id === "landing" ? "1" : "2") }) })) }],
  };
}

// A campaign target with the record of one capture. `probe(side, route,
// viewport)` gives each side's probe result; `editCell(cell)` edits C's cells;
// `served` and `recorded` give per-page source hashes.
function fixture(t, { pages = ["landing", "checkout"], probe = null, editCell = () => {}, editDsp = () => {}, served = {}, recorded = {}, run = null, plan: planOverride = null } = {}) {
  const targetRepo = mkdtempSync(join(tmpdir(), "parity-p2-"));
  t.after(() => rmSync(targetRepo, { recursive: true, force: true }));
  const packetPath = resolve(targetRepo, "packet.json");
  const packet = { schema_version: "campaign-runtime-build-packet/v0", campaign: { public_route_slug: "sample" },
    source_html: { root: "source", pages: pages.map(page) }, design_source_package: { path: "dsp.json" } };
  writeFileSync(packetPath, JSON.stringify(packet));
  const dsp = dspFor(pages, recorded);
  editDsp(dsp);
  writeFileSync(resolve(targetRepo, "dsp.json"), JSON.stringify(dsp));
  const sourceFp = computeDesignSourcePackageMaterialFingerprint(dsp);
  const report = { identity: { public_route_slug: "sample" }, design_source_package: { material_fingerprint: sourceFp },
    stages: { assembly: { status: "completed", build_fingerprint: BUILD } } };
  const plan = planOverride ?? planPolishCapture({ packet, baseUrl: "http://127.0.0.1:9" });
  const servedOf = (id) => (Object.hasOwn(served, id) ? served[id] : sha(id === "landing" ? "1" : "2"));
  const cells = planVisualCapture(plan).cells.map((cell) => ({ ...cell, status: "rendered", source_sha256: cell.side === "source_html" ? servedOf(cell.page_id) : null,
    readiness: { fonts: { status: "settled", failed_faces: 0, waited_ms: 0 }, await: { status: "not_present", remaining_count: 0, waited_ms: 0 } } }));
  cells.forEach(editCell);
  const captures = buildCapturesRecord({ buildFingerprint: BUILD, sourceFingerprint: sourceFp, slug: "sample", routes: plan.routes.map((r) => r.requested_route), cells, measuredAt: MEASURED_AT });
  const result = probe ?? ((side, route, viewport) => ({ status: "measured", value: probeOutput(viewport), elapsed_ms: 5 }));
  const probeRun = run ?? { result, exhausted: () => false };
  const record = buildElementParityRecord({ plan, captures, run: probeRun, packet, packetPath, buildFingerprint: BUILD, sourceFingerprint: sourceFp,
    writeFile: (value) => writeParityFile(targetRepo, value), measuredAt: MEASURED_AT });
  return { targetRepo, packetPath, packet, dsp, sourceFp, report, plan, captures, record };
}
const read = (f, overrides = {}) => readElementParity({ record: f.record, captures: f.captures, packet: f.packet, packetPath: f.packetPath,
  currentBuild: BUILD, currentSource: f.sourceFp, buildOutput: { status: "pass" }, campaignSlug: "sample", targetRepo: f.targetRepo,
  qcStandIns: { polish: { "parity.element": standInRules(overrides.compare) } }, ...overrides });
const rowOf = (rows, pageId, viewport, key) => rows.find((row) => row.id === `parity.element:${pageId}:${viewport}:${key}`);
const comparisons = (rows) => rows.filter((row) => row.subject.key === "comparison");
const reseal = (record) => { const { integrity: _i, ...rest } = record; return { ...rest, integrity: polishRecordIntegrity(rest) }; };
const resealCaptures = (captures) => buildCapturesRecord({ subject: captures.subject, cells: captures.cells, references: captures.references,
  comparisons: captures.comparisons, environment: captures.environment, dependencies: captures.dependencies, adapters: captures.adapters,
  source: captures.source, measuredAt: captures.measured_at });
const cellOf = (record, pageId, viewport) => record.cells.find((c) => c.page_id === pageId && c.viewport === viewport);
const fileOf = (f, ref) => JSON.parse(readFileSync(resolve(f.targetRepo, ref.path), "utf8"));
const unexercisedAll = (rows, reason) => rows.length > 0 && rows.every((row) => row.result === "unexercised" && row.reason_code === reason);
// A typography warning on the landing heading at both viewports.
const headingDrift = (side, route, viewport) => ({ status: "measured", elapsed_ms: 5, value: probeOutput(viewport, side === "build"
  ? { elements: [element(0, "Synthetic headline", { font_size_px: 30 }), element(1, "Body copy after hero")] }
  : { elements: [element(0, "Synthetic headline", { font_size_px: 32 }), element(1, "Body copy after hero")] }) });

test("P2 baseline: matching probes read comparison pass with font_usage_not_observed and no element rows", (t) => {
  const f = fixture(t);
  const rows = read(f);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.subject.key, "comparison"); assert.equal(row.result, "pass"); assert.equal(row.accept_eligible, false);
    assert.deepEqual(row.coverage, { observed: 2, expected: 2, limits: ["font_usage_not_observed"] });
  }
  // No page text, styles or HTML in the record.
  const text = JSON.stringify(f.record);
  assert.doesNotMatch(text, /Synthetic headline|Body copy|font_family|Synthetic Sans/);
  assert.equal(f.record.cells.length, 4);
  for (const cell of f.record.cells) {
    for (const ref of [cell.source_html.snapshot_ref, cell.build.probe_ref]) assert.equal(readParityFile(ref, f.targetRepo).status, "ok");
  }
});

test("P2 stub: the shipped comparator throws, so a compared cell reads comparator_failed until P3", (t) => {
  const f = fixture(t);
  assert.throws(() => compareElementParity({}, {}));
  const rows = read(f, { compare: compareElementParity });
  assert.ok(unexercisedAll(comparisons(rows), "comparator_failed"));
});

test("P2-W3: an edited, re-intaken source gives a new snapshot sha and the new intake hash as recorded_sha256", (t) => {
  const before = fixture(t);
  const after = fixture(t, { served: { landing: sha("9") }, recorded: { landing: sha("9") },
    probe: (side, route, viewport) => ({ status: "measured", elapsed_ms: 5, value: probeOutput(viewport, { elements: [element(0, side === "source_html" ? "Edited synthetic headline" : "Synthetic headline")] }) }) });
  for (const viewport of ["desktop", "mobile"]) {
    const a = cellOf(before.record, "landing", viewport), b = cellOf(after.record, "landing", viewport);
    assert.notEqual(a.source_html.snapshot_ref.sha256, b.source_html.snapshot_ref.sha256);
    assert.equal(b.source_html.source_identity.recorded_sha256, sha("9"));
    assert.equal(b.source_html.source_identity.served_sha256, sha("9"));
  }
});

test("P2-W4: all-stock plan passes no probe and imports no parity module; an earlier record stays as it is; no parity coverage line", async (t) => {
  const f = fixture(t);
  let imported = 0;
  const parityImporter = async () => { imported += 1; throw new Error("must not import"); };
  const stock = { ...f.packet, source_html: { root: "source", pages: [{ page_id: "landing", skip_reason: "template stock" }] } };
  await assert.rejects(capturePolishPageLoad({ packet: stock, report: f.report, baseUrl: "http://127.0.0.1:9", visual: { packetPath: f.packetPath, parityImporter } }),
    (error) => error.code === "no_capturable_routes");
  const readability = await capturePolishReadability({ packet: stock, report: f.report, baseUrl: "http://127.0.0.1:9", targetRepo: f.targetRepo,
    createBrowserAdapter: async () => { throw new Error("no browser in this row"); }, visual: { packetPath: f.packetPath, parityImporter } });
  assert.equal(imported, 0);
  assert.equal(Object.hasOwn(readability, "element_parity"), false);
  const report = { ...f.report, stages: { ...f.report.stages, polish: { status: "pending", evidence: { visual_review: { element_parity: f.record } } } } };
  const merged = mergePolishCaptureEvidence(report, { pageLoad: null, readability: null });
  assert.deepEqual(merged.stages.polish.evidence.visual_review.element_parity, f.record);
  assert.deepEqual(readElementParity({ record: f.record, captures: f.captures, packet: stock, packetPath: f.packetPath }), []);
  const coverage = handoffCoverage({ report, spec: null, results: [], packet: stock });
  assert.equal(coverage.some((entry) => entry.check === "parity.element"), false);
  const unstarted = handoffCoverage({ report: { stages: {} }, spec: null, results: [], packet: stock });
  assert.equal(unstarted.some((entry) => entry.check === "parity.element"), false);
});

test("P2-W4 repair: a fresh-process module-load spy catches the registry path with no packet and an all-stock packet", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "parity-import-spy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = resolve(dir, "snapshot-loaded");
  const loader = `import { appendFileSync } from 'node:fs';
    export async function load(url, context, nextLoad) {
      if (/\\/parity\\/(snapshot|probe)\\.mjs$/.test(url)) appendFileSync(${JSON.stringify(marker)}, url + '\\n');
      return nextLoad(url, context);
    }`;
  const script = `import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
    const { loadQcRederivers } = await import(${JSON.stringify(new URL("../qc-check-registry.mjs", import.meta.url).href)});
    const { readElementParity } = await import(${JSON.stringify(new URL("../qc-results.mjs", import.meta.url).href)});
    const rederivers = await loadQcRederivers({legs: ['polish']});
    readElementParity({rederivers, record: {cells: []}});
    readElementParity({rederivers, packet: {source_html: {pages: [{page_id: 'landing', skip_reason: 'stock'}]}}, record: {cells: []}});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(marker), false, "registry-only and inapplicable reads load neither snapshot nor probe");
});

function fakeAdapter(calls) {
  return { async close() {}, async renderForCompare({ url, viewport, probes }) {
    const readings = {};
    for (const probe of probes) {
      if (probe.select && !probe.select()) { calls.push({ url, viewport: viewport.key, name: probe.name, selected: false }); continue; }
      readings[probe.name] = probe.name === "visual_sections"
        ? { status: "measured", value: { status: "no_section_keys", bands: [], capped: false }, elapsed_ms: 1 }
        : { status: "measured", value: probeOutput(viewport.key), elapsed_ms: calls.elapsed ?? 5 };
      if (probe.name !== "visual_sections") calls.push({ url, viewport: viewport.key, name: probe.name, selected: true });
      probe.onResult?.(readings[probe.name]);
    }
    const skipped = { status: "skipped", bytes: null, full_height_css: null, crop: null, truncated: false };
    return { status: "rendered", readiness: { fonts: { status: "settled", failed_faces: 0, waited_ms: 0 }, await: { status: "not_present", remaining_count: 0, waited_ms: 0 } },
      probes: readings, actual: skipped, stabilized: skipped };
  } };
}
async function runCells(plan, calls) {
  const run = createParityProbeRun({ routes: plan.routes });
  const sources = new Map(plan.routes.map((r) => [r.page_id, { url_path: `/${r.page_id}.html`, identity: { sha256: sha(r.page_id === "landing" ? "1" : "2") } }]));
  const cells = await runVisualCells({ buildAdapter: fakeAdapter(calls), sourceAdapter: fakeAdapter(calls), pairs: planVisualCapture(plan),
    sourceOrigin: "http://127.0.0.1:9", sources, probes: [run.probe], writePng: () => { throw new Error("no shots"); } });
  return { run, cells };
}

test("P2-W5: 33 mapped routes probe routes 1-32 only (64 cells); route 33 is uncaptured, select refuses its four C cells, and reads page_not_captured", async (t) => {
  const ids = Array.from({ length: 33 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);
  const packet = { campaign: { public_route_slug: "sample" }, source_html: { root: "source", pages: ids.map(page) } };
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:9" });
  const calls = [];
  const { run, cells } = await runCells(plan, calls);
  const last = plan.routes[32];
  const lastCalls = calls.filter((c) => c.url.includes(`/${last.page_id}`));
  assert.equal(lastCalls.length, 4); assert.ok(lastCalls.every((c) => !c.selected));
  assert.equal(calls.filter((c) => c.selected).length, 128);
  assert.ok(cells.every((cell) => cell.status === "rendered"));
  const f = fixture(t, { pages: ids, plan, run });
  assert.equal(f.record.cells.length, 64);
  assert.deepEqual(f.record.uncaptured_routes, [last.requested_route]);
  assert.equal(f.record.subject.routes.length, PARITY_LIMITS.routes);
  const rows = read(f);
  for (const viewport of ["desktop", "mobile"]) {
    const row = rowOf(rows, last.page_id, viewport, "cell");
    assert.equal(row.result, "unexercised"); assert.equal(row.reason_code, "page_not_captured");
  }
  assert.equal(comparisons(rows).length, 64);
  assert.ok(comparisons(rows).every((row) => row.result === "pass"));
});

test("P2-I5: probes reporting 25 s each run three times, then select refuses and the rest read run_budget_exhausted", async (t) => {
  const packet = { campaign: { public_route_slug: "sample" }, source_html: { root: "source", pages: [page("landing")] } };
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:9" });
  const calls = []; calls.elapsed = 25_000;
  const { run } = await runCells(plan, calls);
  assert.deepEqual(calls.map((c) => c.selected), [true, true, true, false]);
  assert.equal(run.spentMs(), 75_000);
  const f = fixture(t, { pages: ["landing"], run });
  assert.equal(cellOf(f.record, "landing", "mobile").source_html.probe_status, "run_budget_exhausted");
  const rows = read(f);
  assert.equal(rowOf(rows, "landing", "desktop", "comparison").result, "pass");
  assert.deepEqual([rowOf(rows, "landing", "mobile", "comparison").result, rowOf(rows, "landing", "mobile", "comparison").reason_code], ["unexercised", "run_budget_exhausted"]);
});

test("P2-B2: one flipped byte in a snapshot refuses only that cell (evidence_not_reproducible)", (t) => {
  const f = fixture(t);
  const ref = cellOf(f.record, "landing", "desktop").source_html.snapshot_ref;
  const path = resolve(f.targetRepo, ref.path), bytes = readFileSync(path);
  bytes[bytes.length - 2] ^= 1; writeFileSync(path, bytes);
  const rows = read(f);
  assert.equal(rowOf(rows, "landing", "desktop", "comparison").reason_code, "evidence_not_reproducible");
  for (const [pageId, viewport] of [["landing", "mobile"], ["checkout", "desktop"], ["checkout", "mobile"]]) assert.equal(rowOf(rows, pageId, viewport, "comparison").result, "pass");
});

test("P2-B3: a rebuild reads every row stale_binding and a prior accept lapses", (t) => {
  const f = fixture(t, { probe: headingDrift });
  const rows = read(f);
  const warning = rows.find((row) => row.result === "warning");
  assert.ok(warning && warning.subject.key.startsWith("type:el-") && warning.accept_eligible);
  const accept = createQcAccept(warning, { measuredAt: MEASURED_AT, attribution: qcAcceptAttribution({ reason: "synthetic accept", acceptedBy: "Jordan Lee", now: "2026-02-01T00:00:00.000Z" }) });
  assert.equal(assessQcAccepts([accept], rows, { now: "2026-02-02T00:00:00.000Z" })[0].status, "active");
  const stale = read(f, { currentBuild: OTHER_BUILD });
  assert.ok(unexercisedAll(stale, "stale_binding"));
  assert.ok(stale.some((row) => row.id === warning.id), "the warning row keeps its identity");
  assert.deepEqual(assessQcAccepts([accept], stale, { now: "2026-02-02T00:00:00.000Z" })[0], { status: "lapsed", why: "stale_binding", applied: false });
  // Output drift reads the same.
  assert.ok(unexercisedAll(read(f, { buildOutput: { status: "fail" } }), "stale_binding"));
});

test("P2-B3b: a changed source package material fingerprint alone reads every row stale_binding", (t) => {
  const f = fixture(t);
  assert.ok(unexercisedAll(read(f, { currentSource: sha("d") }), "stale_binding"));
});

test("P2-B4: source bytes that differ from the DSP-recorded sha read comparison review source_identity_mismatch with no element rows", (t) => {
  const f = fixture(t, { served: { landing: sha("7") }, probe: headingDrift });
  const rows = read(f);
  for (const viewport of ["desktop", "mobile"]) {
    const row = rowOf(rows, "landing", viewport, "comparison");
    assert.deepEqual([row.result, row.reason_code], ["review", "source_identity_mismatch"]);
    assert.equal(rows.filter((r) => r.subject.page === "landing" && r.subject.viewport === viewport).length, 1);
  }
  assert.equal(rowOf(rows, "checkout", "desktop", "comparison").result, "pass");
  // The unrecorded variant.
  const unrecorded = fixture(t, { recorded: { landing: null } });
  assert.equal(rowOf(read(unrecorded), "landing", "desktop", "comparison").reason_code, "source_identity_unrecorded");
});

function collidingSurface(dsp) {
  const other = dsp.surface_identity.find((surface) => surface.mappings.campaign_spec_page_id === "checkout");
  other.id = "other-surface";
  other.mappings.source_page_id = "landing";
  dsp.surface_identity = [other, ...dsp.surface_identity.filter((surface) => surface !== other)];
  dsp.contributions[0].source_refs.find((ref) => ref.id === "source-checkout-html").id = "source-other-surface-html";
}

test("P2 repair: a source-page collision cannot override landing's CampaignSpec surface in the producer or reader", (t) => {
  // Both refs deliberately have the same digest: binding to the wrong surface
  // used to pass both viewport comparisons with the comparator stand-in.
  const f = fixture(t, { editDsp: collidingSurface, recorded: { checkout: sha("1") }, served: { checkout: sha("1") } });
  const rows = read(f);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.result === "pass"));
  for (const viewport of ["desktop", "mobile"]) {
    const cell = cellOf(f.record, "landing", viewport);
    assert.equal(cell.surface_id, "landing");
    assert.equal(cell.source_html.source_identity.source_ref_id, "source-landing-html");
    const snapshot = fileOf(f, cell.source_html.snapshot_ref);
    assert.equal(snapshot.surface_id, "landing");
    assert.equal(snapshot.source_identity.source_ref_id, "source-landing-html");
    // A self-consistent old-style record must also fail the reader's binding.
    cell.surface_id = snapshot.surface_id = "other-surface";
    cell.source_html.source_identity.source_ref_id = snapshot.source_identity.source_ref_id = "source-other-surface-html";
    cell.source_html.snapshot_ref = writeParityFile(f.targetRepo, snapshot);
  }
  f.record = reseal(f.record);
  const refused = read(f);
  for (const viewport of ["desktop", "mobile"]) {
    const row = rowOf(refused, "landing", viewport, "comparison");
    assert.deepEqual([row.result, row.reason_code], ["unexercised", "evidence_not_reproducible"]);
    assert.equal(row.members[0].reason_code, "source_identity_unbound");
  }
});

test("P2 repair: no CampaignSpec mapping leaves landing unexercised despite another surface's matching source page", (t) => {
  const f = fixture(t, { recorded: { checkout: sha("1") }, served: { checkout: sha("1") }, editDsp: (dsp) => {
    collidingSurface(dsp);
    dsp.surface_identity = dsp.surface_identity.filter((surface) => surface.mappings.campaign_spec_page_id !== "landing");
  } });
  const rows = read(f);
  assert.equal(rows.length, 4);
  for (const viewport of ["desktop", "mobile"]) {
    const cell = cellOf(f.record, "landing", viewport);
    assert.equal(cell.surface_id, null);
    assert.equal(cell.source_html.source_identity.source_ref_id, null);
    assert.equal(cell.source_html.source_identity.recorded_sha256, null);
    assert.equal(fileOf(f, cell.source_html.snapshot_ref).surface_id, null);
    const row = rowOf(rows, "landing", viewport, "comparison");
    assert.deepEqual([row.result, row.reason_code], ["unexercised", "source_identity_unrecorded"]);
    assert.equal(row.accept_eligible, false);
    assert.equal(rowOf(rows, "checkout", viewport, "comparison").result, "pass");
  }
});

test("P2-B5 and P2-B5b: a size-only or DPR-only viewport mismatch reads viewport_mismatch; nothing is resized", (t) => {
  const size = fixture(t, { probe: (side, route, viewport) => ({ status: "measured", elapsed_ms: 5,
    value: probeOutput(viewport, viewport === "mobile" && side === "source_html" ? { size: { width: 375, height: 844 } } : {}) }) });
  const sizeRow = rowOf(read(size), "landing", "mobile", "comparison");
  assert.deepEqual([sizeRow.result, sizeRow.reason_code], ["unexercised", "viewport_mismatch"]);
  const dpr = fixture(t, { probe: (side, route, viewport) => ({ status: "measured", elapsed_ms: 5,
    value: probeOutput(viewport, viewport === "mobile" && side === "build" ? { dpr: 2 } : {}) }) });
  const dprRow = rowOf(read(dpr), "landing", "mobile", "comparison");
  assert.deepEqual([dprRow.result, dprRow.reason_code], ["unexercised", "viewport_mismatch"]);
  assert.equal(cellOf(dpr.record, "landing", "mobile").width, 390);
});

test("P2-B6 †: a resealed record whose tolerances.font_size_px is 2 reads every row evidence_not_reproducible", (t) => {
  const f = fixture(t, { probe: headingDrift });
  const tampered = reseal({ ...f.record, tolerances: { ...f.record.tolerances, font_size_px: 2 } });
  const rows = read({ ...f, record: tampered });
  assert.ok(unexercisedAll(rows, "evidence_not_reproducible"));
  assert.ok(rows.some((row) => row.subject.key.startsWith("type:")), "element identities are kept");
});

test("P2-B7 †: a cell pointing at another page's valid snapshot is refused by the envelope check", (t) => {
  const f = fixture(t);
  const record = structuredClone(f.record);
  cellOf(record, "landing", "desktop").source_html.snapshot_ref = cellOf(record, "checkout", "desktop").source_html.snapshot_ref;
  const rows = read({ ...f, record: reseal(record) });
  const row = rowOf(rows, "landing", "desktop", "comparison");
  assert.equal(row.reason_code, "evidence_not_reproducible"); assert.equal(row.members[0].reason_code, "probe_envelope_mismatch");
  assert.equal(rowOf(rows, "checkout", "desktop", "comparison").result, "pass");
});

test("P2-B7b †: a foreign snapshot rewritten to the cell's identity, with checkout's hashes, is refused by the identity check", (t) => {
  const f = fixture(t);
  const record = structuredClone(f.record);
  const foreign = fileOf(f, cellOf(record, "checkout", "desktop").source_html.snapshot_ref);
  const cell = cellOf(record, "landing", "desktop");
  Object.assign(foreign, { page_id: "landing", surface_id: "landing", route: cell.route });
  foreign.source_identity = { ...foreign.source_identity, source_ref_id: "source-landing-html" };
  cell.source_html.snapshot_ref = writeParityFile(f.targetRepo, foreign);
  cell.source_html.source_identity = foreign.source_identity;
  const row = rowOf(read({ ...f, record: reseal(record) }), "landing", "desktop", "comparison");
  assert.equal(row.reason_code, "evidence_not_reproducible"); assert.equal(row.members[0].reason_code, "source_identity_unbound");
});

test("P2-B8 †: a build probe file from an earlier build is refused by its build_fingerprint", (t) => {
  const f = fixture(t);
  const record = structuredClone(f.record);
  const cell = cellOf(record, "landing", "desktop");
  const old = { ...fileOf(f, cell.build.probe_ref), build_fingerprint: OTHER_BUILD };
  cell.build.probe_ref = writeParityFile(f.targetRepo, old);
  const row = rowOf(read({ ...f, record: reseal(record) }), "landing", "desktop", "comparison");
  assert.equal(row.reason_code, "evidence_not_reproducible"); assert.equal(row.members[0].reason_code, "source_identity_unbound");
});

test("P2-B9 †: an authored snapshot claiming the DSP's sha as served, against C's different served bytes, is refused", (t) => {
  const f = fixture(t, { served: { landing: sha("7") } });
  const record = structuredClone(f.record);
  const cell = cellOf(record, "landing", "desktop");
  const authored = { ...fileOf(f, cell.source_html.snapshot_ref) };
  authored.source_identity = { ...authored.source_identity, served_sha256: authored.source_identity.recorded_sha256 };
  authored.probe = probeOutput("desktop", { elements: [element(0, "Hand written")] });
  cell.source_html.snapshot_ref = writeParityFile(f.targetRepo, authored);
  cell.source_html.source_identity = authored.source_identity;
  const row = rowOf(read({ ...f, record: reseal(record) }), "landing", "desktop", "comparison");
  assert.equal(row.reason_code, "evidence_not_reproducible");
});

test("P2-B10 † (A1 residual, accepted): consistently rewritten files, P's record and C's record read as recorded", (t) => {
  const f = fixture(t);
  const record = structuredClone(f.record);
  const captures = structuredClone(f.captures);
  for (const cell of record.cells) {
    const snapshot = { ...fileOf(f, cell.source_html.snapshot_ref), probe: probeOutput(cell.viewport, { elements: [element(0, "Fabricated text")] }) };
    const probe = { ...fileOf(f, cell.build.probe_ref), probe: probeOutput(cell.viewport, { elements: [element(0, "Fabricated text")] }) };
    cell.source_html.snapshot_ref = writeParityFile(f.targetRepo, snapshot);
    cell.build.probe_ref = writeParityFile(f.targetRepo, probe);
  }
  const resealed = resealCaptures(captures);
  record.subject.captures_integrity = resealed.integrity;
  const rows = read({ ...f, record: reseal(record), captures: resealed });
  assert.equal(comparisons(rows).length, 4);
  assert.ok(comparisons(rows).every((row) => row.result === "pass"), "documented A1 residual: probe files are tamper-evident only");
});

test("P2-B11 †: a captures record replaced by another capture's (valid integrity) reads every row evidence_not_reproducible", (t) => {
  const f = fixture(t);
  const other = resealCaptures({ ...f.captures, measured_at: "2026-01-02T00:00:00.000Z" });
  const rows = read({ ...f, captures: other });
  assert.ok(unexercisedAll(rows, "evidence_not_reproducible"));
  assert.equal(rows[0].members[0].reason_code, "captures_integrity_mismatch");
});

test("P2-B12 †: a cell removed from cells with subject.routes intact reads every row evidence_not_reproducible", (t) => {
  const f = fixture(t);
  const record = structuredClone(f.record);
  record.cells = record.cells.filter((c) => !(c.page_id === "checkout" && c.viewport === "mobile"));
  const rows = read({ ...f, record: reseal(record) });
  assert.ok(unexercisedAll(rows, "evidence_not_reproducible"));
  assert.equal(rows[0].members[0].reason_code, "grid_invalid");
  assert.equal(comparisons(rows).length, 4);
  assert.equal(rowOf(rows, "checkout", "mobile", "comparison")?.reason_code, "evidence_not_reproducible", "the removed cell survives as a refused comparison");
});

for (const damage of ["source_null", "build_ref_missing", "cell_missing", "cells_missing", "tolerances", "files_missing"]) {
  test(`P2-B12 repair: ${damage} retains accepted element identities and lapses their accepts`, (t) => {
    const f = fixture(t, { probe: headingDrift });
    const original = read(f);
    const warning = original.find((row) => row.subject.page === "checkout" && row.subject.viewport === "mobile" && row.result === "warning");
    assert.ok(warning);
    const accept = createQcAccept(warning, { measuredAt: MEASURED_AT, attribution: qcAcceptAttribution({ reason: "synthetic accept", acceptedBy: "Jordan Lee", now: "2026-02-01T00:00:00.000Z" }) });
    assert.equal(assessQcAccepts([accept], original)[0].status, "active");
    const record = structuredClone(f.record), cell = cellOf(record, "checkout", "mobile");
    if (damage === "source_null") cell.source_html = null;
    if (damage === "build_ref_missing") delete cell.build.probe_ref;
    if (damage === "cell_missing") record.cells = record.cells.filter((c) => c !== cell);
    if (damage === "cells_missing") record.cells = null;
    if (damage === "tolerances") record.tolerances.font_size_px = 99;
    if (damage === "files_missing") {
      unlinkSync(resolve(f.targetRepo, cell.source_html.snapshot_ref.path));
      unlinkSync(resolve(f.targetRepo, cell.build.probe_ref.path));
    }
    f.record = reseal(record);
    const rows = read(f, { qcAccepts: [accept] });
    const reason = damage === "files_missing" ? "probe_file_absent" : "evidence_not_reproducible";
    assert.equal(rows.find((row) => row.id === warning.id)?.reason_code, reason, "the prior warning ID survives unreadable evidence");
    assert.equal(rowOf(rows, "checkout", "mobile", "comparison")?.reason_code, reason);
    const assessment = assessQcAccepts([accept], rows)[0];
    assert.equal(assessment.status, "lapsed");
    assert.equal(assessment.why, damage === "files_missing" ? "state_changed" : reason);
    const report = { ...f.report, qc_accepts: [accept], stages: { ...f.report.stages,
      polish: { status: "completed", evidence: { visual_review: { captures: f.captures, element_parity: f.record } } } } };
    const current = readCurrentQcResults({ report, doctor: { derived: { build_output_fingerprint: { status: "pass" } } }, targetRepo: f.targetRepo,
      packetPath: f.packetPath, qcStandIns: { polish: { "parity.element": standInRules() } } });
    assert.equal(current.results.find((row) => row.id === warning.id)?.reason_code, reason, "report accepts reach the parity reader");
    assert.equal(assessQcAccepts([accept], current.results)[0].status, "lapsed");
  });
}

test("P2-W6 repair: an invalid self-ignore records the write refusal and produces no probe files", (t) => {
  const f = fixture(t);
  rmSync(resolve(f.targetRepo, ".campaign-runtime/polish/parity"), { recursive: true });
  mkdirSync(resolve(f.targetRepo, ".campaign-runtime/polish/parity/.gitignore"), { recursive: true });
  const record = buildElementParityRecord({ plan: f.plan, captures: f.captures, run: { result: () => ({ status: "measured", value: probeOutput("desktop") }) },
    packet: f.packet, packetPath: f.packetPath, buildFingerprint: BUILD, sourceFingerprint: f.sourceFp,
    writeFile: (value) => writeParityFile(f.targetRepo, value), measuredAt: MEASURED_AT });
  for (const cell of record.cells) for (const side of [cell.source_html, cell.build]) {
    assert.equal(side.probe_status, "failed");
    assert.equal(side.failure_reason, "parity_ignore_invalid");
  }
  assert.deepEqual(readdirSync(resolve(f.targetRepo, ".campaign-runtime/polish/parity")), [".gitignore"]);
});

test("P2-I1: a capped build probe reads element_cap_reached; every element row carries page_coverage and is not accept-eligible", (t) => {
  const f = fixture(t, { probe: (side, route, viewport) => {
    const result = headingDrift(side, route, viewport);
    if (side === "build") result.value.coverage.elements_capped = true;
    return result;
  } });
  const rows = read(f);
  const comparison = rowOf(rows, "landing", "desktop", "comparison");
  assert.deepEqual([comparison.result, comparison.reason_code], ["unexercised", "element_cap_reached"]);
  assert.deepEqual(comparison.members, [{ key: "build:element_cap_reached", result: "unexercised", reason_code: "element_cap_reached" }]);
  const elements = rows.filter((row) => row.subject.key.startsWith("type:"));
  assert.ok(elements.length > 0);
  for (const row of elements) {
    assert.ok(row.members.some((m) => m.key === "page_coverage" && m.reason_code === "element_cap_reached"));
    assert.equal(row.accept_eligible, false);
  }
});

const statusRow = (t, options) => rowOf(read(fixture(t, options)), "landing", "desktop", "comparison");
test("P2-I2: a build probe timeout reads probe_timeout", (t) => {
  const row = statusRow(t, { probe: (side, route, viewport) => (side === "build" ? { status: "timeout", value: null, elapsed_ms: 2000 } : { status: "measured", value: probeOutput(viewport), elapsed_ms: 5 }) });
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "probe_timeout"]);
});

test("P2-I3: a source readiness font timeout with a measured probe reads readiness_incomplete, and the next Coverage line shows the code and its text", (t) => {
  const f = fixture(t, { editCell: (cell) => { if (cell.side === "source_html" && cell.page_id === "landing") cell.readiness.fonts.status = "timeout"; } });
  const rows = read(f);
  const row = rowOf(rows, "landing", "desktop", "comparison");
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "readiness_incomplete"]);
  assert.deepEqual(row.members, [{ key: "source_html:fonts", result: "unexercised", reason_code: "readiness_timeout" }]);
  const lines = qcHandoffTextLines(buildQcHandoff({ results: rows, accepts: [] }));
  assert.ok(lines.includes("  - polish parity.element: unexercised (readiness_incomplete) x2 on landing — Fonts or awaited content were not ready in time; not compared."), lines.join("\n"));
});

test("P2-I3b: a build cell that failed navigation reads navigation_failed", (t) => {
  const row = statusRow(t, { editCell: (cell) => { if (cell.side === "build" && cell.page_id === "landing") cell.status = "navigation_failed"; } });
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "navigation_failed"]);
});

test("P2-I4: an image-only source (no text elements) reads design_elements_unavailable with its coverage text", (t) => {
  const f = fixture(t, { probe: (side, route, viewport) => ({ status: "measured", elapsed_ms: 5, value: probeOutput(viewport, side === "source_html" ? { elements: [] } : {}) }) });
  const rows = read(f);
  const row = rowOf(rows, "landing", "desktop", "comparison");
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "design_elements_unavailable"]);
  const lines = qcHandoffTextLines(buildQcHandoff({ results: rows, accepts: [] }));
  assert.ok(lines.some((line) => line.includes("(design_elements_unavailable)") && line.endsWith("The source has no text elements (for example an image-only export); element parity is unavailable.")));
});

test("P2-I6: a plan route added after capture reads page_not_captured; the other cells' rows are unchanged", (t) => {
  const f = fixture(t);
  const before = read(f);
  const packet = { ...f.packet, source_html: { ...f.packet.source_html, pages: [...f.packet.source_html.pages, page("thanks")] } };
  writeFileSync(f.packetPath, JSON.stringify(packet));
  const after = read({ ...f, packet });
  for (const viewport of ["desktop", "mobile"]) assert.equal(rowOf(after, "thanks", viewport, "cell").reason_code, "page_not_captured");
  assert.deepEqual(after.filter((row) => row.subject.page !== "thanks"), before);
});

test("P2-I7: Polish evidence without element_parity on a mapped campaign reads not_captured_by_this_version in handoff coverage", (t) => {
  const f = fixture(t);
  const report = { ...f.report, stages: { ...f.report.stages, polish: { status: "completed", evidence: { visual_review: { screenshots: ["synthetic.png"] } } } } };
  const coverage = handoffCoverage({ report, spec: null, results: [], packet: f.packet });
  assert.deepEqual(coverage.filter((e) => e.check === "parity.element"), [{ check: "parity.element", leg: "polish", result: "unexercised", reason_code: "not_captured_by_this_version", count: 0, pages: [] }]);
});

test("P2-I8: a source file absent at capture reads C's source_html_missing", (t) => {
  const row = statusRow(t, { editCell: (cell) => { if (cell.side === "source_html" && cell.page_id === "landing") Object.assign(cell, { status: "source_html_missing", source_sha256: null }); },
    probe: (side, route, viewport) => (side === "source_html" && route === "/sample/landing/" ? null : { status: "measured", value: probeOutput(viewport), elapsed_ms: 5 }) });
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "source_html_missing"]);
});

test("P2-I9: a source probe document_changed reads document_changed", (t) => {
  const row = statusRow(t, { probe: (side, route, viewport) => (side === "source_html" ? { status: "document_changed", value: null, elapsed_ms: 5 } : { status: "measured", value: probeOutput(viewport), elapsed_ms: 5 }) });
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "document_changed"]);
});

test("P2-I12: deleting the parity directory (a clone) reads probe_file_absent, never evidence_not_reproducible", (t) => {
  const f = fixture(t);
  rmSync(resolve(f.targetRepo, ".campaign-runtime/polish/parity"), { recursive: true, force: true });
  assert.ok(unexercisedAll(read(f), "probe_file_absent"));
});

test("P2-I13 and P2-I14: time-capped and page-text-truncated build probes read their coverage reasons; time cap adds page_coverage", (t) => {
  const withCoverage = (coverage) => fixture(t, { probe: (side, route, viewport) => {
    const result = headingDrift(side, route, viewport);
    if (side === "build") Object.assign(result.value.coverage, coverage);
    return result;
  } });
  const timed = read(withCoverage({ time_capped: true }));
  assert.equal(rowOf(timed, "landing", "desktop", "comparison").reason_code, "probe_time_cap_reached");
  assert.ok(timed.filter((r) => r.subject.key.startsWith("type:")).every((r) => r.members.some((m) => m.key === "page_coverage" && m.reason_code === "probe_time_cap_reached")));
  const truncated = read(withCoverage({ page_text_truncated: true }));
  assert.deepEqual([rowOf(truncated, "landing", "desktop", "comparison").result, rowOf(truncated, "landing", "desktop", "comparison").reason_code], ["unexercised", "page_text_truncated"]);
  assert.ok(truncated.filter((r) => r.subject.key.startsWith("type:")).every((r) => !r.members.some((m) => m.key === "page_coverage")));
});

test("P2-I15: a deleted DSP reads every comparison source_package_unavailable", (t) => {
  const f = fixture(t);
  unlinkSync(resolve(f.targetRepo, "dsp.json"));
  assert.ok(unexercisedAll(comparisons(read(f)), "source_package_unavailable"));
  writeFileSync(resolve(f.targetRepo, "dsp.json"), JSON.stringify({ ...f.dsp, surface_identity: [...f.dsp.surface_identity, { id: "extra", kind: "page", mappings: {} }] }));
  assert.ok(unexercisedAll(comparisons(read(f)), "source_package_stale"));
});

test("P2 element rows: id, state and observation follow §5.2 and §6; the warning is accept-eligible and lapses on a changed value", (t) => {
  const f = fixture(t, { probe: headingDrift });
  const rows = read(f);
  const row = rows.find((r) => r.subject.page === "landing" && r.subject.viewport === "desktop" && r.subject.key.startsWith("type:"));
  assert.match(row.id, /^parity\.element:landing:desktop:type:el-[a-f0-9]{12}$/);
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], ["warning", "font_size_differs", true]);
  assert.deepEqual(row.coverage.limits, ["font_usage_not_observed"]);
  assert.deepEqual(row.observation.members, [{ property: "font_size", design: 32, build: 30, delta: -2 }]);
  assert.equal(row.observation.label, "Synthetic headline"); assert.equal(row.observation.basis, "source_html_export");
  const accept = createQcAccept(row, { measuredAt: MEASURED_AT, attribution: qcAcceptAttribution({ reason: "synthetic", acceptedBy: "Jordan Lee", now: "2026-02-01T00:00:00.000Z" }) });
  const changed = read(fixture(t, { probe: (side, route, viewport) => {
    const result = headingDrift(side, route, viewport);
    if (side === "build") result.value.elements[0].font_size_px = 31;
    return result;
  } }));
  assert.deepEqual(assessQcAccepts([accept], changed, { now: "2026-02-02T00:00:00.000Z" })[0], { status: "lapsed", why: "state_changed", applied: false });
});

test("P2 reader never throws on any record shape (generated malformed shapes)", (t) => {
  const f = fixture(t, { probe: headingDrift });
  const values = [null, undefined, 0, 1, -1, "", "x", true, false, [], {}, [null], [{}], { a: 1 }, NaN, Infinity, "sha256:" + "0".repeat(64)];
  const paths = [];
  const walk = (value, path) => {
    paths.push(path);
    if (value && typeof value === "object") for (const key of Object.keys(value)) walk(value[key], [...path, key]);
  };
  walk(f.record, []);
  let checked = 0;
  for (const path of paths) {
    for (const replacement of values) {
      let record = structuredClone(f.record);
      if (path.length === 0) record = replacement;
      else {
        let at = record;
        for (const key of path.slice(0, -1)) at = at[key];
        at[path.at(-1)] = replacement;
      }
      for (const candidate of [record, record && typeof record === "object" && !Array.isArray(record) ? reseal(record) : record]) {
        const rows = read({ ...f, record: candidate });
        assert.ok(Array.isArray(rows) && rows.length > 0, `rows for ${path.join(".")}`);
        assert.ok(rows.every((row) => row.result !== "pass" || path.length > 0), path.join("."));
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1000);
  // Captures and packet shapes too.
  for (const captures of values) assert.ok(Array.isArray(read({ ...f, captures })));
  for (const packet of values.filter((v) => v !== undefined)) assert.ok(Array.isArray(read({ ...f, packet })));
});

test("P2 registry: parity.element loads its rules with the plan and the probe file reads; readCurrentQcResults reads the record from the report", async (t) => {
  const rederivers = await loadQcRederivers();
  assert.equal(rederivers["parity.element"].status, "loaded");
  assert.equal(typeof rederivers["parity.element"].rederive.read, "function");
  assert.equal(rederivers["parity.element"].rederive.readFile, undefined, "probe files load only on an applicable read");
  const f = fixture(t);
  const report = { ...f.report, stages: { ...f.report.stages, polish: { status: "completed", evidence: { visual_review: { captures: f.captures, element_parity: f.record } } } } };
  const { results, coverage } = readCurrentQcResults({ report, doctor: { derived: { build_output_fingerprint: { status: "pass" } } }, targetRepo: f.targetRepo,
    packetPath: f.packetPath, qcStandIns: { polish: { "parity.element": standInRules(), "visual.diff": { thresholds: {}, vocabulary: {}, evaluate: () => [] } } } });
  const parity = results.filter((row) => row.check === "parity.element");
  assert.equal(parity.length, 4); assert.ok(parity.every((row) => row.result === "pass"));
  assert.equal(coverage.some((entry) => entry.check === "parity.element"), false);
  // The shipped rules (comparator stub) read comparator_failed.
  const shipped = readCurrentQcResults({ report, doctor: { derived: { build_output_fingerprint: { status: "pass" } } }, targetRepo: f.targetRepo, packetPath: f.packetPath });
  assert.ok(unexercisedAll(shipped.results.filter((row) => row.check === "parity.element"), "comparator_failed"));
  // This process imported snapshot above; exercise the first mapped read in
  // a cold process too, including the synchronous ESM dependency graph.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { loadQcRederivers } from ${JSON.stringify(new URL("../qc-check-registry.mjs", import.meta.url).href)};
    import { readCurrentQcResults } from ${JSON.stringify(new URL("../qc-results.mjs", import.meta.url).href)};
    const rederivers = await loadQcRederivers();
    const result = readCurrentQcResults(${JSON.stringify({ report, doctor: { derived: { build_output_fingerprint: { status: "pass" } } }, targetRepo: f.targetRepo, packetPath: f.packetPath })});
    console.log(JSON.stringify(result.results.filter(row => row.check === 'parity.element')));
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const coldRows = JSON.parse(child.stdout);
  assert.equal(coldRows.length, 4);
  assert.ok(unexercisedAll(coldRows, "comparator_failed"));
  const lines = qcHandoffTextLines(buildQcHandoff({ results: shipped.results, coverage: shipped.coverage, accepts: [] }));
  assert.ok(lines.includes("  - polish parity.element: limit (font_usage_not_observed) x4 on checkout, landing — The font each glyph was drawn with is not read; a web font that loaded is assumed used."), lines.join("\n"));
});

test("P2 attach: element_parity attaches only beside the captures record of the same merge and the current build; otherwise an earlier one is removed", (t) => {
  const f = fixture(t);
  const pageLoad = { schema_version: "campaigns-os-polish-page-load/v0", performed_by: "campaigns-os polish capture", subject: { routes: [], route_scope: "all", viewports: [] } };
  const report = { ...f.report, stages: { ...f.report.stages, polish: { status: "pending", evidence: { visual_review: { element_parity: { stale: true } } } } } };
  const captures = { ...f.captures, subject: { ...f.captures.subject, ...pageLoad.subject } };
  const resealed = resealCaptures(captures);
  const record = reseal({ ...f.record, subject: { ...f.record.subject, captures_integrity: resealed.integrity } });
  const attached = mergePolishCaptureEvidence(report, { pageLoad, captures: resealed, elementParity: record }).stages.polish.evidence.visual_review;
  assert.deepEqual(attached.element_parity, record);
  const unbound = mergePolishCaptureEvidence(report, { pageLoad, captures: resealed, elementParity: f.record }).stages.polish.evidence.visual_review;
  assert.equal(Object.hasOwn(unbound, "element_parity"), false);
  const noCaptures = mergePolishCaptureEvidence(report, { pageLoad, elementParity: record }).stages.polish.evidence.visual_review;
  assert.equal(Object.hasOwn(noCaptures, "element_parity"), false);
  const otherBuild = mergePolishCaptureEvidence({ ...report, stages: { ...report.stages, assembly: { status: "completed", build_fingerprint: OTHER_BUILD } } },
    { pageLoad, captures: { ...resealed, subject: { ...resealed.subject, build_fingerprint: OTHER_BUILD } }, elementParity: record }).stages.polish.evidence.visual_review;
  assert.equal(Object.hasOwn(otherBuild, "element_parity"), false);
});

test("P2 producer: no probe file is written for an unmeasured side, and files carry no timestamp", (t) => {
  const f = fixture(t, { probe: (side, route, viewport) => (side === "build" && viewport === "mobile" ? { status: "failed", value: null, elapsed_ms: 5 } : { status: "measured", value: probeOutput(viewport), elapsed_ms: 5 }) });
  const files = readdirSync(resolve(f.targetRepo, ".campaign-runtime/polish/parity")).filter((name) => name.endsWith(".json"));
  const refs = f.record.cells.flatMap((c) => [c.source_html.snapshot_ref, c.build.probe_ref]).filter(Boolean);
  assert.equal(new Set(refs.map((r) => r.path)).size, files.length);
  assert.ok(f.record.cells.filter((c) => c.viewport === "mobile").every((c) => c.build.probe_status === "failed" && c.build.probe_ref === null));
  for (const ref of refs) assert.doesNotMatch(readFileSync(resolve(f.targetRepo, ref.path), "utf8"), /measured_at|captured_at|20\d\d-\d\d-\d\dT/);
});
