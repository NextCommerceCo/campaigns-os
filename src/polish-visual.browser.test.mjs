import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { createPolishBrowserAdapter } from "./polish-browser.mjs";
import { runVisualPass, VISUAL_QC_RULES } from "./polish-visual.mjs";
import { capturePolishPageLoad, mergePolishCaptureEvidence, planPolishCapture, evaluateRecordedHiddenEagerMediaCheckpoint } from "./polish-node.mjs";
import { evaluatePolishGate, POLISH_PRODUCER } from "./polish-gate.mjs";
import { main, nextStage } from "./cli.mjs";
import { computeBuildFingerprint } from "./built-site-scope.mjs";
import { syntheticVisualFixture } from "./polish-visual-fixtures.mjs";
import { sha256Hex, readPngStructure } from "./png-header.mjs";
import { computeDesignSourcePackageMaterialFingerprint } from "./design-source-package.mjs";
import { loadVisualDependencies } from "./visual-diff.mjs";
import { startSourceHtmlServer } from "./source-html-server.mjs";

// Deliberately no Chromium attempt in the builder sandbox. The inspection
// lane sets this variable; there a missing package/binary is a test failure.
const browserTest = process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1" ? test : test.skip;
const fixtureBytes = (name) => readFileSync(new URL(`../fixtures/polish-visual/${name}`, import.meta.url));
async function listen(t, handler) {
  const server = createServer(handler), sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.close(done); for (const socket of sockets) socket.destroy(); }));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function scenario(t, sourceName = "identical-source.html", buildName = "identical-build.html", { stallFont = false } = {}) {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const sourceBytes = fixtureBytes(sourceName), buildBytes = fixtureBytes(buildName);
  f.write("page.html", sourceBytes); f.write("art.svg", fixtureBytes("art.svg"));
  const buildServer = await listen(t, (req, res) => {
    if (req.url.endsWith("/stalled.woff2")) {
      // Each cell requests the font. It stays loading 3.5 s past the 3 s
      // readiness bound (which starts after this request), then settles 3.5 s
      // inside the 10 s screenshot bound, whose font wait it would otherwise hold.
      const timer = setTimeout(() => { if (!res.destroyed) res.end("synthetic invalid font"); }, 6500);
      timer.unref(); return;
    }
    res.setHeader("content-type", req.url.endsWith(".svg") ? "image/svg+xml" : "text/html");
    res.end(req.url.endsWith(".svg") ? fixtureBytes("art.svg") : stallFont
      ? Buffer.from('<!doctype html><style>@font-face{font-family:Stalled;src:url("stalled.woff2");font-display:block}p{font-family:Stalled}</style><section id="hero"><p>Synthetic stalled font</p></section>') : buildBytes);
  });
  const packetPath = resolve(f.targetRepo, "packet.json");
  const packet = { campaign: { public_route_slug: "sample", route_root: "/sample/" }, source_html: { root: "source", pages: [
    { page_id: "page", path: "page.html", page_kit: { public_route: "/sample/page/", spec_route: "page/", target_path: "src/different.html" } },
  ] }, design_source_package: { path: "dsp.json" } };
  const dsp = { surface_identity: [{ id: "page", mappings: { campaign_spec_page_id: "page", source_page_id: "page" } }], contributions: [{ kind: "html_funnel",
    source_refs: [{ id: "html", kind: "html_file", path: "page.html", sha256: `sha256:${sha256Hex(sourceBytes)}` }],
    mappings: [{ surface_id: "page", source_refs: ["html"], screenshot_refs: [] }], screenshot_refs: [] }] };
  writeFileSync(resolve(f.targetRepo, "dsp.json"), JSON.stringify(dsp));
  mkdirSync(resolve(f.targetRepo, "_site/sample/page"), { recursive: true });
  writeFileSync(resolve(f.targetRepo, "_site/sample/page/index.html"), buildBytes);
  const report = { ...f.report, identity: { public_route_slug: "sample" }, design_source_package: { material_fingerprint: computeDesignSourcePackageMaterialFingerprint(dsp) },
    stages: { ...f.report.stages, assembly: { ...f.report.stages.assembly, status: "completed" },
      polish: { status: "pending", evidence: { visual_review: { screenshots: ["legacy-synthetic.png"] } } } } };
  const plan = planPolishCapture({ packet, baseUrl: buildServer.origin });
  const subject = { build_fingerprint: report.stages.assembly.build_fingerprint, campaign_slug: "sample", route_scope: "all", routes: ["/sample/page/"], viewports: ["desktop", "mobile"] };
  const createBrowserAdapter = (options) => createPolishBrowserAdapter({ ...options, networkIdleTimeoutMs: 100 });
  const input = { packet, packetPath, report, targetRepo: f.targetRepo, createBrowserAdapter, frozen: { plan, page_load: { subject } } };
  return { ...f, input, baseUrl: buildServer.origin };
}
const diffRows = (record) => VISUAL_QC_RULES.evaluate(record).filter((row) => row.check === "visual.diff");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const withoutCaptures = (report) => { const copy = structuredClone(report); delete copy.stages.polish.evidence.visual_review.captures; return copy; };
// The gate result with captures equals the one without, field for field; only
// screenshot_evidence (C3) may differ.
function unchangedGate(report, record) {
  const gate = (value) => { const { screenshot_evidence: _ignored, ...rest } = evaluatePolishGate({ report: value }); return rest; };
  const withCaptures = structuredClone(report); withCaptures.stages.polish.evidence.visual_review.captures = record;
  const captured = gate(withCaptures);
  assert.deepEqual(captured, gate(withoutCaptures(withCaptures)));
  return captured;
}

// A complete campaign target: `polish capture` through main(), with the real
// browser, one synthetic page, and a Polish stage the gate can read as current.
async function cliCapture(t, sourceName, buildName) {
  const dir = mkdtempSync(resolve(tmpdir(), "campaigns-os-visual-cli-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const buildBytes = fixtureBytes(buildName);
  const buildServer = await listen(t, (req, res) => {
    res.setHeader("content-type", req.url.endsWith(".svg") ? "image/svg+xml" : "text/html");
    res.end(req.url.endsWith(".svg") ? fixtureBytes("art.svg") : buildBytes);
  });
  const examples = new URL("../examples/", import.meta.url);
  const targetRepo = resolve(dir, "target"), packetPath = resolve(dir, "campaign-runtime.build.json");
  const reportPath = resolve(targetRepo, ".campaign-runtime/assembly-report.json");
  const packet = readJson(new URL("build-packet.basic.json", examples));
  packet.campaign.route_root = `/${packet.campaign.public_route_slug}/`; packet.assembly.target_repo = "target";
  packet.source_html.pages = [packet.source_html.pages[0]];
  writeJson(packetPath, packet);
  const sourceRoot = resolve(dir, packet.source_html.root); mkdirSync(sourceRoot);
  writeFileSync(resolve(sourceRoot, packet.source_html.pages[0].path), fixtureBytes(sourceName)); writeFileSync(resolve(sourceRoot, "art.svg"), fixtureBytes("art.svg"));
  const builtRoot = resolve(targetRepo, "_site", packet.campaign.public_route_slug);
  mkdirSync(resolve(builtRoot, "landing"), { recursive: true }); writeFileSync(resolve(builtRoot, "landing/index.html"), buildBytes);
  const fingerprint = computeBuildFingerprint(builtRoot).fingerprint;
  const report = readJson(new URL("assembly-report.example.json", examples));
  Object.assign(report.identity, { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug });
  report.inputs.packet_path = "../campaign-runtime.build.json"; report.evidence = [];
  Object.assign(report.stages.assembly, { status: "completed", build_fingerprint: fingerprint });
  report.stages.polish = { stage: "polish", status: "completed_with_warnings", performed_by: POLISH_PRODUCER,
    source_build_fingerprint: fingerprint, completed_at: "2026-01-01T00:00:00.000Z", evidence: {
      visual_review: { screenshots: ["qa-output/landing-desktop.png"] },
      brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: { cleared: true, promo_codes: "none", fonts: "design fonts only", colors: "tokenized" } },
      checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
      template_residue_review: { next_blue: "not found", starter_favicon: "not found", lorem: "not found" },
      commerce_flow_review: { shop_single_step: "synthetic review" }, issues: [], commands: ["next-campaigns-polish"] } };
  writeJson(reportPath, report);
  writeJson(resolve(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready", retained: "preserve" });
  const output = [], log = console.log, exitCode = process.exitCode;
  console.log = (...values) => output.push(values.join(" ")); process.exitCode = undefined;
  let exit;
  try {
    await main(["polish", "capture", "--packet", packetPath, "--base-url", `${buildServer.origin}/`, "--json"]);
    exit = process.exitCode ?? 0;
  } finally { console.log = log; process.exitCode = exitCode; }
  const written = readJson(reportPath);
  // `next` over the written report, then over the same report without captures.
  const nextStatus = () => { const { ok, status, stage, ready } = nextStage(null, { packet: packetPath, _: [], "no-write": true }); return { ok, status, stage, ready }; };
  const next = nextStatus();
  writeJson(reportPath, withoutCaptures(written));
  const nextWithout = nextStatus();
  writeJson(reportPath, written);
  // Exit status without the visual pass: `polish capture` exits 2 unless its
  // hidden-eager-media checkpoint over the merged report passes or is waived.
  const checkpoint = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: withoutCaptures(written) });
  return { exit, expectedExit: ["pass", "waived"].includes(checkpoint.status) ? 0 : 2, result: JSON.parse(output.join("\n")),
    report: written, captures: written.stages.polish.evidence.visual_review.captures, next, nextWithout };
}
function unchangedProgression(cli) {
  assert.equal(cli.exit, cli.expectedExit); assert.equal(cli.exit, 0); assert.equal(cli.result.status, "ready");
  assert.deepEqual(cli.next, cli.nextWithout);
  const gate = unchangedGate(withoutCaptures(cli.report), cli.captures);
  assert.equal(gate.code, "polish.evidence_current");
  return gate;
}

browserTest("F3C-W1: byte-distinct unchanged source/build render at both viewports with diagnostic near-zero page and bands", async (t) => {
  const f = await scenario(t); const record = await runVisualPass(f.input);
  assert.deepEqual(record.cells.map((c) => [c.side, c.viewport]), [["build", "desktop"], ["source_html", "desktop"], ["build", "mobile"], ["source_html", "mobile"]]);
  assert.ok(record.cells.every((c) => c.status === "rendered" && c.actual.status === "captured" && c.stabilized.status === "captured"));
  assert.ok(record.cells.every((c) => c.readiness.fonts.status === "settled" && c.readiness.await.status === "not_present"));
  const references = VISUAL_QC_RULES.evaluate(record).filter((r) => r.check === "visual.reference");
  assert.equal(references.length, 1); assert.equal(references[0].subject.key, "source_html");
  assert.equal(references[0].result, "pass");
  assert.deepEqual(references[0].members.map((m) => [m.key, m.result]), [["verification", "pass"], ["provenance", "pass"]]);
  assert.deepEqual(record.references[0].provenance, { class: "declared_source", reasons: [] });
  assert.equal(record.comparisons.length, 2);
  for (const comparison of record.comparisons) {
    assert.ok(comparison.page.mismatch_ratio < 0.001);
    // Bands are ranked, not in document order.
    assert.deepEqual(comparison.bands.map((b) => b.key).sort(), ["#benefits", "#hero", "#reviews"]);
    assert.ok(comparison.bands.every((b) => b.status === "compared"));
  }
  const rows = diffRows(record); assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.result === "review" && r.reason_code === "visual_diff_diagnostic" && r.members.length === 0));
  unchangedGate(f.input.report, record);
  // The same pages through `polish capture`: exit status, gate and `next` are those without captures.
  const cli = await cliCapture(t, "identical-source.html", "identical-build.html");
  assert.ok(cli.captures.cells.length === 4 && cli.captures.cells.every((c) => c.status === "rendered"));
  unchangedProgression(cli);
});
browserTest("F3C-W2: hero rework ranks first; taller hero does not shift reviews and artifact triples rehash", async (t) => {
  const f = await scenario(t, "hero-source.html", "hero-build.html"), record = await runVisualPass(f.input);
  const rows = diffRows(record); assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.result === "review" && r.reason_code === "visual_diff_diagnostic"));
  assert.equal(record.comparisons.length, 2);
  for (const comparison of record.comparisons) {
    assert.equal(comparison.bands[0].key, "#hero"); assert.equal(comparison.bands[0].height_delta_px, 156);
    const reviews = comparison.bands.find((b) => b.key === "#reviews");
    assert.equal(reviews.status, "compared"); assert.ok(reviews.mismatch_ratio < 0.001);
    const triple = comparison.artifacts.find((a) => a.band_key === "#hero"); assert.ok(triple);
    for (const kind of ["basis_crop", "build_crop", "heatmap"]) {
      const png = triple[kind], bytes = readFileSync(resolve(f.targetRepo, png.path));
      assert.match(png.path, /^\.campaign-runtime\/polish\/diff\//);
      assert.equal(`sha256:${sha256Hex(bytes)}`, png.sha256); assert.equal(bytes.length, png.bytes);
      const header = readPngStructure(bytes); assert.ok(header.ok);
      assert.equal(header.ihdr.width_px, png.width_px); assert.equal(header.ihdr.height_px, png.height_px);
    }
  }
  unchangedGate(f.input.report, record);
  // Gate and `next` status versus W1: the same command over the unchanged pages.
  const hero = await cliCapture(t, "hero-source.html", "hero-build.html");
  const unchanged = await cliCapture(t, "identical-source.html", "identical-build.html");
  assert.ok(hero.captures.comparisons.some((c) => c.bands[0]?.key === "#hero" && c.bands[0].height_delta_px > 0));
  const heroGate = unchangedProgression(hero), unchangedGateResult = unchangedProgression(unchanged);
  assert.deepEqual([heroGate.status, heroGate.code], [unchangedGateResult.status, unchangedGateResult.code]);
  assert.deepEqual(hero.next, unchanged.next); assert.equal(hero.exit, unchanged.exit);
});
browserTest("F3C-W6: actual price and timer stay visible; stabilized pixels are magenta and masks are recorded", async (t) => {
  const f = await scenario(t, "masks.html", "masks.html"), record = await runVisualPass(f.input), deps = await loadVisualDependencies();
  for (const cell of record.cells) {
    const actual = deps.decoder.decode(readFileSync(resolve(f.targetRepo, cell.actual.png.path)));
    const stable = deps.decoder.decode(readFileSync(resolve(f.targetRepo, cell.stabilized.png.path)));
    assert.deepEqual(cell.stabilized.treatment.masks.map((m) => m.group).sort(), ["price", "timer"]);
    for (const group of cell.stabilized.treatment.masks) {
      assert.equal(group.count, 1);
      for (const r of group.rects) {
        const p = (Math.floor(r.y + 2) * stable.width + Math.floor(r.x + 2)) * 4;
        assert.notDeepEqual([...actual.data.subarray(p, p + 4)], [255, 0, 255, 255]);
        assert.deepEqual([...stable.data.subarray(p, p + 4)], [255, 0, 255, 255]);
      }
    }
  }
});
browserTest("F3C-W9: real-browser frozen records remain byte-identical after visual capture and merge", async (t) => {
  const f = await scenario(t); let snapshot;
  const project = (value) => JSON.stringify([value.page_load, value.media_weight, value.readability]);
  const capture = await capturePolishPageLoad({ ...f.input, baseUrl: f.baseUrl,
    visual: { packetPath: f.input.packetPath }, onFrozen(value) { snapshot = project(value); } });
  assert.equal(project(capture), snapshot);
  const merged = mergePolishCaptureEvidence(f.input.report, { pageLoad: capture.page_load, mediaWeight: capture.media_weight, readability: capture.readability, captures: capture.captures });
  const visual = merged.stages.polish.evidence.visual_review;
  assert.equal(project({ page_load: visual.page_load, media_weight: visual.media_weight, readability: visual.readability }), snapshot);
  assert.ok(capture.captures.cells.every((c) => c.status === "rendered"));
  const checkpoint = evaluateRecordedHiddenEagerMediaCheckpoint({ packet: f.input.packet, report: merged });
  assert.equal(checkpoint.status, "pass");
});
browserTest("F3C-I1: unresolved data-next-await times out within five seconds and keeps shots", async (t) => {
  // One `polish capture` run: its written record carries the row, and its exit status and gate are checked.
  const cli = await cliCapture(t, "identical-source.html", "await.html"), record = cli.captures;
  const builds = record.cells.filter((c) => c.side === "build");
  assert.equal(builds.length, 2);
  assert.ok(builds.every((c) => c.readiness.await.status === "timeout" && c.readiness.await.remaining_count === 1 && c.readiness.await.waited_ms <= 5000));
  assert.ok(builds.every((c) => c.status === "rendered" && c.actual.status === "captured" && c.stabilized.status === "captured"));
  assert.ok(record.cells.filter((c) => c.side === "source_html").every((c) => c.readiness.await.status === "not_present"));
  const rows = diffRows(record); assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual([row.result, row.reason_code], ["unexercised", "readiness_incomplete"]);
    assert.deepEqual(row.members.map((m) => [m.key, m.reason_code]), [["build", "await_timeout"]]);
  }
  unchangedProgression(cli);
});
browserTest("F3C-I2: stalled loopback font exposes fonts_timeout within three seconds", async (t) => {
  const f = await scenario(t, "identical-source.html", "identical-build.html", { stallFont: true });
  const record = await runVisualPass(f.input);
  const builds = record.cells.filter((c) => c.side === "build");
  assert.equal(builds.length, 2);
  assert.ok(builds.every((c) => c.readiness.fonts.status === "timeout" && c.readiness.fonts.waited_ms <= 3000));
  assert.ok(record.cells.filter((c) => c.side === "source_html").every((c) => c.readiness.fonts.status === "settled"));
  const rows = diffRows(record); assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual([row.result, row.reason_code], ["unexercised", "readiness_incomplete"]);
    assert.deepEqual(row.members.map((m) => [m.key, m.reason_code]), [["build", "fonts_timeout"]]);
  }
});
browserTest("F3C-I12: source fetch, beacon, image, fonts, WebSocket, preconnect and worker fetches reach zero receiver TCP connections", async (t) => {
  let connections = 0, frames = 0;
  const receiver = await listen(t, (req, res) => { frames++; res.end(); });
  receiver.server.on("connection", () => { connections++; });
  receiver.server.on("upgrade", (req, socket) => { frames++; socket.destroy(); });
  const f = await scenario(t);
  const offline = (name) => fixtureBytes(name).toString().replaceAll("RECEIVER_WS", receiver.origin.replace("http:", "ws:")).replaceAll("RECEIVER", receiver.origin);
  f.write("page.html", offline("offline.html"));
  // A SharedWorker's fetch is outside the per-context routes: only the launch proxy refuses it.
  f.write("offline-worker.js", offline("offline-worker.js"));
  const server = await startSourceHtmlServer({ root: f.sourceRoot }); t.after(() => server.close());
  const adapter = await createPolishBrowserAdapter({ seal: { origin: server.origin, port: server.port }, networkIdleTimeoutMs: 100 }); t.after(() => adapter.close());
  const result = await adapter.renderForCompare({ url: `${server.origin}/page.html`, viewport: { key: "desktop", width: 1440, height: 1200 } });
  // Both workers ran and their fetches settled before the shots: the page's
  // static [data-next-await] marker is gone (a worker that never ran reads timeout).
  const workersSettled = (readiness) => ["settled", "not_present"].includes(readiness.await.status);
  assert.ok(workersSettled(result.readiness), JSON.stringify(result.readiness));
  assert.equal(result.status, "rendered"); assert.equal(connections, 0); assert.equal(frames, 0);
  assert.equal(result.external.blocked_websocket_count, 1); assert.ok(result.external.blocked_count >= 5);
  assert.ok(result.external.blocked_origins.includes(receiver.origin)); assert.ok(result.external.blocked_origins.includes("https://example.invalid"));
  assert.ok(server.refused().every((r) => r.count > 0 && !r.origin.includes("?")));
  assert.ok(server.refused().some((r) => r.origin === receiver.origin), JSON.stringify(server.refused()));
  const record = await runVisualPass(f.input);
  // Blocked requests and proxy refusals are recorded as a limit; both viewport comparisons still run to a result.
  const sources = record.cells.filter((c) => c.side === "source_html");
  assert.ok(sources.every((c) => c.status === "rendered" && workersSettled(c.readiness) && c.external.blocked_origins.includes(receiver.origin)));
  // The cell's count is the routed blocks plus the refusals (the SharedWorker fetch) of that render.
  assert.ok(sources.every((c) => c.external.blocked_count > result.external.blocked_count), JSON.stringify(sources.map((c) => c.external)));
  assert.deepEqual(record.comparisons.map((c) => [c.viewport, c.basis]).sort(), [["desktop", "source_html"], ["mobile", "source_html"]]);
  for (const comparison of record.comparisons) {
    assert.equal(comparison.status, "compared", comparison.viewport); assert.equal(comparison.reason, null);
    assert.equal(comparison.page.status, "compared");
    assert.ok(comparison.page.compared_pixels > 0 && Number.isFinite(comparison.page.mismatch_ratio));
    assert.ok(comparison.limits.includes("source_external_blocked"), comparison.viewport);
  }
  assert.equal(connections, 0);
});
