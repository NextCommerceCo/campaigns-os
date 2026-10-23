// Stream P2 browser rows: the element parity probe on C's real visual cells
// (package Chromium, the sealed source browser, local synthetic pages). The
// shipped comparator is the P3 stub, so rows that need a comparison inject
// the stand-in below; rows read through the shipped rules say so.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { computeBuildFingerprint } from "../built-site-scope.mjs";
import { main } from "../cli.mjs";
import { computeDesignSourcePackageMaterialFingerprint } from "../design-source-package.mjs";
import { createPolishBrowserAdapter } from "../polish-browser.mjs";
import { POLISH_PRODUCER } from "../polish-gate.mjs";
import { planPolishCapture } from "../polish-node.mjs";
import { runVisualPass } from "../polish-visual.mjs";
import { sha256Hex } from "../png-header.mjs";
import { buildQcHandoff, qcHandoffTextLines } from "../qc-accept.mjs";
import { readCurrentQcResults, readElementParity } from "../qc-results.mjs";
import { ELEMENT_PARITY_QC_RULES, buildElementParityRecord } from "./element-parity-record.mjs";
import { createParityProbeRun } from "./probe.mjs";
import { PARITY_DIR, readParityFile, readParityFileForIdentity, writeParityFile } from "./snapshot.mjs";

const browserTest = process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1" ? test : test.skip;
const fixture = (name) => readFileSync(new URL(`../../fixtures/parity/${name}`, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

async function listen(t, handler) {
  const server = createServer(handler), sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.close(done); for (const socket of sockets) socket.destroy(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const contentType = (url) => (url.endsWith(".css") ? "text/css" : url.endsWith(".svg") ? "image/svg+xml" : "text/html");
// Serves `pages` (route suffix → bytes) and every fixture asset by name.
const buildServer = (t, pages) => listen(t, (req, res) => {
  const name = req.url.split("?")[0].split("/").pop();
  res.setHeader("content-type", contentType(req.url));
  if (/\.(css|svg)$/.test(name) || name === "parity-frame.html") return res.end(pages[name] ?? fixture(name));
  res.end(pages.page);
});

// The comparator stand-in (P3 replaces the stub): exact-text pairing, a
// font-size typography finding, and a copy finding for a missing text that
// reads review / build_text_not_read where the build had unread text.
function standInCompare(design, build) {
  const counts = (d, matched, missing, unverified) => ({ design: d, build: build.elements.length, matched,
    by_pass: { exact_unique: matched, exact_nearest: 0, subtree: 0, fuzzy: 0 }, unmatched_present: 0, unmatched_missing: missing, unmatched_unverified: unverified, below_min_chars: 0 });
  const base = { comparator_version: "parity-compare/v1", invalid: null, drift: { dx: 0, dy: 0, samples: 0 }, pairs: [], findings: [] };
  if (design.viewport.width !== build.viewport.width || design.viewport.height !== build.viewport.height || design.dpr !== build.dpr) return { ...base, status: "viewport_mismatch", counts: counts(0, 0, 0, 0) };
  const D = design.elements.filter((e) => e.text.trim());
  if (!D.length) return { ...base, status: "design_elements_unavailable", counts: counts(0, 0, 0, 0) };
  const unread = build.coverage.closed_shadow_roots > 0 || build.coverage.frames_not_read > 0;
  const findings = [];
  let matched = 0, missing = 0, unverified = 0;
  for (const d of D) {
    const identity = { text: d.text.toLowerCase(), selector_path: d.selector_path, ordinal: 0 };
    const b = build.elements.find((e) => e.text === d.text);
    if (!b) {
      if (build.page_text.includes(d.text)) continue;
      if (unread) unverified += 1; else missing += 1;
      findings.push({ category: "copy", design: d.index, build: null, design_identity: identity, members: [{ property: "copy",
        result: unread ? "review" : "warning", reason_code: unread ? "build_text_not_read" : "copy_missing", design: d.text.toLowerCase(), build: null, delta: null }] });
      continue;
    }
    matched += 1;
    if (Math.abs(b.font_size_px - d.font_size_px) - 0.6 > 1e-9) findings.push({ category: "typography", design: d.index, build: b.index, design_identity: identity,
      members: [{ property: "font_size", result: "warning", reason_code: "font_size_differs", design: d.font_size_px, build: b.font_size_px, delta: b.font_size_px - d.font_size_px }] });
  }
  return { ...base, status: "compared", counts: counts(D.length, matched, missing, unverified), findings };
}
const standInRules = () => ({ ...ELEMENT_PARITY_QC_RULES, plan: planPolishCapture, readFile: readParityFile, readFileForIdentity: readParityFileForIdentity, compare: standInCompare });

// One synthetic page, captured by C's visual pass with P's probe. `source`
// and `build` are page bytes; `sourceFiles` are extra files in the source root.
async function scenario(t, { source = fixture("parity-source.html"), build = fixture("parity-build.html"), sourceFiles = {}, buildFiles = {} } = {}) {
  const targetRepo = mkdtempSync(resolve(tmpdir(), "parity-browser-"));
  t.after(() => rmSync(targetRepo, { recursive: true, force: true }));
  const sourceRoot = resolve(targetRepo, "source");
  mkdirSync(sourceRoot);
  const writeSource = (files) => {
    writeFileSync(resolve(sourceRoot, "page.html"), files.page ?? source);
    for (const name of ["parity.css", "parity-art.svg"]) writeFileSync(resolve(sourceRoot, name), files[name] ?? fixture(name));
  };
  writeSource(sourceFiles);
  const origin = await buildServer(t, { page: build, ...buildFiles });
  const packetPath = resolve(targetRepo, "packet.json");
  const packet = { campaign: { public_route_slug: "sample", route_root: "/sample/" }, source_html: { root: "source", pages: [
    { page_id: "page", path: "page.html", page_kit: { public_route: "/sample/page/", spec_route: "page/", target_path: "src/different.html" } },
  ] }, design_source_package: { path: "dsp.json" } };
  writeJson(packetPath, packet);
  const sourceBytes = readFileSync(resolve(sourceRoot, "page.html"));
  const dsp = { surface_identity: [{ id: "page", kind: "page", mappings: { campaign_spec_page_id: "page" } }], contributions: [{ id: "html-funnel", kind: "html_funnel",
    source_refs: [{ id: "source-page-html", kind: "html_file", path: "page.html", sha256: `sha256:${sha256Hex(sourceBytes)}` }],
    mappings: [{ surface_id: "page", source_refs: ["source-page-html"], screenshot_refs: [] }], screenshot_refs: [] }] };
  writeJson(resolve(targetRepo, "dsp.json"), dsp);
  mkdirSync(resolve(targetRepo, "_site/sample/page"), { recursive: true });
  writeFileSync(resolve(targetRepo, "_site/sample/page/index.html"), build);
  const sourceFp = computeDesignSourcePackageMaterialFingerprint(dsp);
  const report = { identity: { public_route_slug: "sample" }, design_source_package: { material_fingerprint: sourceFp },
    stages: { assembly: { status: "completed", build_fingerprint: `sha256:${"a".repeat(64)}` } } };
  const plan = planPolishCapture({ packet, baseUrl: origin });
  const subject = { build_fingerprint: report.stages.assembly.build_fingerprint, campaign_slug: "sample", route_scope: "all", routes: ["/sample/page/"], viewports: ["desktop", "mobile"] };
  const capture = async () => {
    const run = createParityProbeRun({ routes: plan.routes });
    const calls = [];
    const probe = { ...run.probe, onResult(cell, result) { calls.push([cell.side, cell.viewport, result.status]); run.probe.onResult(cell, result); } };
    const captures = await runVisualPass({ packet, packetPath, report, targetRepo, frozen: { plan, page_load: { subject } }, probes: [probe],
      createBrowserAdapter: (options) => createPolishBrowserAdapter({ ...options, networkIdleTimeoutMs: 100 }) });
    const record = buildElementParityRecord({ plan, captures, run, packet, packetPath, buildFingerprint: report.stages.assembly.build_fingerprint,
      sourceFingerprint: sourceFp, writeFile: (value) => writeParityFile(targetRepo, value), measuredAt: "2026-01-01T00:00:00.000Z" });
    const rows = readElementParity({ record, captures, packet, packetPath, currentBuild: report.stages.assembly.build_fingerprint, currentSource: sourceFp,
      buildOutput: { status: "pass" }, campaignSlug: "sample", targetRepo, qcStandIns: { polish: { "parity.element": standInRules() } } });
    const probeOf = (side, viewport) => readParityFile(record.cells.find((c) => c.viewport === viewport)[side === "build" ? "build" : "source_html"][side === "build" ? "probe_ref" : "snapshot_ref"], targetRepo).value?.probe;
    return { run, calls, captures, record, rows, probeOf };
  };
  return { targetRepo, sourceRoot, writeSource, capture };
}
const rowOf = (rows, viewport, key) => rows.find((row) => row.id === `parity.element:page:${viewport}:${key}`);

// A complete campaign target: `polish capture` through main() with the real
// browser and one synthetic page, then `next`.
async function cliCapture(t) {
  const dir = mkdtempSync(resolve(tmpdir(), "parity-cli-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const buildBytes = fixture("parity-build.html");
  const origin = await buildServer(t, { page: buildBytes });
  const examples = new URL("../../examples/", import.meta.url);
  const targetRepo = resolve(dir, "target"), packetPath = resolve(dir, "campaign-runtime.build.json");
  const reportPath = resolve(targetRepo, ".campaign-runtime/assembly-report.json");
  const packet = readJson(new URL("build-packet.basic.json", examples));
  packet.campaign.route_root = `/${packet.campaign.public_route_slug}/`; packet.assembly.target_repo = "target";
  packet.source_html.pages = [packet.source_html.pages[0]];
  packet.design_source_package = { path: "dsp.json" };
  writeJson(packetPath, packet);
  const sourceRoot = resolve(dir, packet.source_html.root); mkdirSync(sourceRoot);
  const sourceBytes = fixture("parity-source.html");
  writeFileSync(resolve(sourceRoot, packet.source_html.pages[0].path), sourceBytes); writeFileSync(resolve(sourceRoot, "parity.css"), fixture("parity.css"));
  const dsp = { surface_identity: [{ id: "landing", kind: "page", mappings: { campaign_spec_page_id: "landing" } }], contributions: [{ id: "html-funnel", kind: "html_funnel",
    source_refs: [{ id: "source-landing-html", kind: "html_file", path: "landing.html", sha256: `sha256:${sha256Hex(sourceBytes)}` }],
    mappings: [{ surface_id: "landing", source_refs: ["source-landing-html"], screenshot_refs: [] }], screenshot_refs: [] }] };
  writeJson(resolve(dir, "dsp.json"), dsp);
  const builtRoot = resolve(targetRepo, "_site", packet.campaign.public_route_slug);
  mkdirSync(resolve(builtRoot, "landing"), { recursive: true }); writeFileSync(resolve(builtRoot, "landing/index.html"), buildBytes);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRepo }).status, 0);
  const fingerprint = computeBuildFingerprint(builtRoot).fingerprint;
  const report = readJson(new URL("assembly-report.example.json", examples));
  Object.assign(report.identity, { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug });
  report.inputs.packet_path = "../campaign-runtime.build.json"; report.evidence = [];
  report.design_source_package = { material_fingerprint: computeDesignSourcePackageMaterialFingerprint(dsp) };
  Object.assign(report.stages.assembly, { status: "completed", build_fingerprint: fingerprint });
  report.stages.polish = { stage: "polish", status: "completed_with_warnings", performed_by: POLISH_PRODUCER,
    source_build_fingerprint: fingerprint, completed_at: "2026-01-01T00:00:00.000Z", evidence: { visual_review: { screenshots: ["qa-output/landing-desktop.png"] } } };
  writeJson(reportPath, report);
  writeJson(resolve(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready", retained: "preserve" });
  const run = async (argv) => {
    const output = [], log = console.log, error = console.error, exitCode = process.exitCode;
    console.log = (...values) => output.push(values.join(" ")); console.error = () => {}; process.exitCode = undefined;
    try { await main(argv); } finally { console.log = log; console.error = error; process.exitCode = exitCode; }
    return output.join("\n");
  };
  await run(["polish", "capture", "--packet", packetPath, "--base-url", `${origin}/`, "--json"]);
  const written = readJson(reportPath);
  const nextText = await run(["next", "--packet", packetPath]);
  return { dir, targetRepo, packetPath, reportPath, report: written, nextText };
}

browserTest("P2-W1: polish capture probes both sides of both cells, writes ignored re-hashing files, attaches element_parity; next shows the font-usage limit line", async (t) => {
  const cli = await cliCapture(t);
  const visual = cli.report.stages.polish.evidence.visual_review;
  const record = visual.element_parity;
  assert.ok(record, "element_parity is attached through the real command (CLI forwarding)");
  assert.equal(record.subject.captures_integrity, visual.captures.integrity);
  assert.deepEqual(record.cells.map((c) => [c.page_id, c.viewport]), [["landing", "desktop"], ["landing", "mobile"]]);
  for (const cell of record.cells) {
    assert.deepEqual([cell.source_html.probe_status, cell.build.probe_status], ["measured", "measured"]);
    for (const ref of [cell.source_html.snapshot_ref, cell.build.probe_ref]) {
      assert.match(ref.path, /^\.campaign-runtime\/polish\/parity\/[a-f0-9]{64}\.json$/);
      assert.equal(readParityFile(ref, cli.targetRepo).status, "ok");
      assert.equal(spawnSync("git", ["check-ignore", "-q", ref.path], { cwd: cli.targetRepo }).status, 0, `${ref.path} is git-ignored`);
    }
  }
  assert.doesNotMatch(JSON.stringify(record), /Synthetic headline|font-family|<h1/);
  assert.ok(cli.nextText.includes("polish parity.element: limit (font_usage_not_observed) x2 on landing — The font each glyph was drawn with is not read; a web font that loaded is assumed used."), cli.nextText);
  // With a comparator (the stand-in until P3), the unchanged pair reads pass with the limit.
  const { results } = readCurrentQcResults({ report: cli.report, doctor: { derived: { build_output_fingerprint: { status: "pass" } } }, targetRepo: cli.targetRepo,
    packetPath: cli.packetPath, qcStandIns: { polish: { "parity.element": standInRules() } } });
  const parity = results.filter((row) => row.check === "parity.element");
  assert.deepEqual(parity.map((row) => [row.subject.viewport, row.subject.key, row.result]), [["desktop", "comparison", "pass"], ["mobile", "comparison", "pass"]]);
  assert.ok(parity.every((row) => row.coverage.limits.includes("font_usage_not_observed")));
  const lines = qcHandoffTextLines(buildQcHandoff({ results, accepts: [] }));
  assert.ok(lines.includes("  - polish parity.element: limit (font_usage_not_observed) x2 on landing — The font each glyph was drawn with is not read; a web font that loaded is assumed used."));
});

browserTest("P2-W2: a rerun over an unchanged static source probes again (one P probe per side per cell) and keeps every snapshot sha", async (t) => {
  const f = await scenario(t);
  const first = await f.capture();
  const second = await f.capture();
  for (const run of [first, second]) {
    assert.deepEqual(run.calls.map(([side, viewport, status]) => [side, viewport, status]).sort(),
      [["build", "desktop", "measured"], ["build", "mobile", "measured"], ["source_html", "desktop", "measured"], ["source_html", "mobile", "measured"]]);
  }
  assert.deepEqual(second.record.cells.map((c) => c.source_html.snapshot_ref), first.record.cells.map((c) => c.source_html.snapshot_ref));
  assert.ok(second.rows.filter((r) => r.subject.key === "comparison").every((r) => r.result === "pass"));
  // The probe read what the page shows, within the contract's shape.
  const probe = first.probeOf("source_html", "desktop");
  assert.deepEqual(probe.viewport, { width: 1440, height: 1200 }); assert.equal(probe.dpr, 1);
  assert.deepEqual(probe.elements.map((e) => e.text), ["Synthetic headline", "Body copy after hero.", "Synthetic action", "Closed synthetic text", "Synthetic footer line."]);
  const heading = probe.elements[0];
  assert.equal(heading.font_size_px, 32); assert.equal(heading.line_height, 40); assert.equal(heading.font_weight, 700);
  assert.match(heading.selector_path, /h1/); assert.deepEqual(heading.fg_srgb.map((c) => Math.round(c * 255)), [20, 20, 20]);
  assert.equal(heading.color_review, null);
  assert.match(probe.page_text, /^Synthetic headline Body copy after hero\. Synthetic action/);
  assert.deepEqual(probe.coverage, { elements_capped: false, time_capped: false, page_text_truncated: false, font_faces_capped: false, closed_shadow_roots: 0, frames_not_read: 0 });
  assert.equal(first.probeOf("build", "mobile").viewport.width, 390);
});

browserTest("P2-W3b: a source stylesheet change alone (32 px → 30 px) is measured on the next capture; new snapshot sha, unchanged source_identity", async (t) => {
  const f = await scenario(t);
  const first = await f.capture();
  f.writeSource({ "parity.css": Buffer.from(fixture("parity.css").toString().replace("font-size: 32px", "font-size: 30px")) });
  const second = await f.capture();
  for (const viewport of ["desktop", "mobile"]) {
    const a = first.record.cells.find((c) => c.viewport === viewport), b = second.record.cells.find((c) => c.viewport === viewport);
    assert.notEqual(a.source_html.snapshot_ref.sha256, b.source_html.snapshot_ref.sha256);
    assert.deepEqual(a.source_html.source_identity, b.source_html.source_identity);
    assert.equal(second.probeOf("source_html", viewport).elements[0].font_size_px, 30);
    const type = second.rows.find((r) => r.subject.viewport === viewport && r.subject.key.startsWith("type:"));
    assert.deepEqual([type.result, type.reason_code, type.observation.members[0].design, type.observation.members[0].build], ["warning", "font_size_differs", 30, 32]);
  }
});

browserTest("P2-I10: a closed shadow root with text and a visible same-origin iframe are counted, not read; copy there reads review, and next shows the coverage text", async (t) => {
  const f = await scenario(t, { build: fixture("parity-closed-build.html") });
  const { rows, probeOf } = await f.capture();
  for (const viewport of ["desktop", "mobile"]) {
    const build = probeOf("build", viewport);
    assert.equal(build.coverage.closed_shadow_roots, 1); assert.equal(build.coverage.frames_not_read, 1);
    assert.equal(build.elements.some((e) => /Closed synthetic|Framed synthetic/.test(e.text)), false);
    const comparison = rowOf(rows, viewport, "comparison");
    assert.deepEqual([comparison.result, comparison.reason_code], ["unexercised", "closed_shadow_root_not_read"]);
    assert.deepEqual(comparison.members.map((m) => m.key), ["build:closed_shadow_root_not_read", "build:frame_not_read"]);
    const copy = rows.find((r) => r.subject.viewport === viewport && r.subject.key.startsWith("copy:"));
    assert.deepEqual([copy.result, copy.reason_code], ["review", "build_text_not_read"]);
  }
  const lines = qcHandoffTextLines(buildQcHandoff({ results: rows, accepts: [] }));
  assert.ok(lines.includes("  - polish parity.element: unexercised (closed_shadow_root_not_read) x2 on page — Some page text was not read (long text, closed components or frames). On the built page, copy is not called missing there; on the source page, those parts were not compared."), lines.join("\n"));
});

browserTest("P2-I11: a build page declaring 250 @font-face rules is capped at 200 faces and reads font_face_cap_reached", async (t) => {
  const faces = Array.from({ length: 250 }, (_, i) => `@font-face { font-family: "Synthetic Face ${i}"; src: local("Synthetic Face ${i}"); }`).join("\n");
  const build = Buffer.from(fixture("parity-build.html").toString().replace("</head>", `<style>${faces}</style></head>`));
  const f = await scenario(t, { build });
  const { rows, probeOf } = await f.capture();
  const probe = probeOf("build", "desktop");
  assert.equal(probe.font_faces.length, 200); assert.equal(probe.coverage.font_faces_capped, true);
  assert.equal(probe.font_faces[0].family, "Synthetic Face 0");
  assert.deepEqual([rowOf(rows, "desktop", "comparison").result, rowOf(rows, "desktop", "comparison").reason_code], ["unexercised", "font_face_cap_reached"]);
});

browserTest("P2-I1 and P2-I4 (probe side): 1 600 text elements stop at the probe's bounds; an image-only source has no elements and reads design_elements_unavailable", async (t) => {
  const many = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic many</title></head><body>${Array.from({ length: 1600 }, (_, i) => `<p>Synthetic line ${i}</p>`).join("")}</body></html>`);
  const capped = await (await scenario(t, { build: many })).capture();
  const build = capped.probeOf("build", "desktop");
  assert.ok(build.elements.length <= 1500);
  assert.ok(build.coverage.elements_capped || build.coverage.time_capped, JSON.stringify(build.coverage));
  const reason = rowOf(capped.rows, "desktop", "comparison").reason_code;
  assert.ok(["element_cap_reached", "probe_time_cap_reached"].includes(reason), reason);
  assert.equal(build.page_text.includes("Synthetic line 1599"), true, "page text is assembled before the walk bounds");
  const image = await (await scenario(t, { source: fixture("parity-image-only.html") })).capture();
  assert.deepEqual(image.probeOf("source_html", "desktop").elements, []);
  assert.deepEqual([rowOf(image.rows, "desktop", "comparison").result, rowOf(image.rows, "desktop", "comparison").reason_code], ["unexercised", "design_elements_unavailable"]);
  assert.ok(PARITY_DIR);
});
