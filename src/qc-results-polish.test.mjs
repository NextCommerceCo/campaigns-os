// F1.0 frozen fixture rows for the Polish media_weight reader site, the
// package-owned visual_review keys and the Polish side of the QC handoff
// (contract §1.0 Reader sites "Polish media_weight", Agent-written evidence).
//
// Test-only stand-in checks, passed in-process only (no environment variable, flag or file can install one):
//   readMediaWeight({ record, pageLoad, currentBuild, qcStandIns }) and
//   main(argv, { qcStandIns }), with qcStandIns.polish =
//   { thresholds, vocabulary, evaluate(cell, thresholds) => Derived[] }
//   (synthetic 1.3 thresholds, record vocabulary and rules; see
//   src/qc-test-factories.mjs). The media_weight and page_load records are
//   synthetic stand-ins shaped like contract 1.3 Observations.
//
// API assumptions (all rows here):
// - readMediaWeight takes the stored page_load evidence block as `pageLoad` and
//   returns the read 1.3 results (an array, or { results }); each result's
//   subject.page is the cell's route.
// - media_weight `integrity` is "sha256:" + sha256(canonicalJson(record minus
//   integrity)), and a cell's page_load_integrity is the page_load capture's
//   integrity.projection_fingerprint (mediaWeightIntegrity in the factory).
// - A cell or record that fails its checks still lists one media.weight result
//   per resources[] entry (subject.key = its resource_id, the first hop's) and
//   one per videos[] entry with no resource_ids (subject.key =
//   "video:<element_index>", the stand-in rules' key), each with the failure
//   result. Rows are matched on subject {check, page, key}, not on the id.
import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  ORIGIN,
  OTHER_BUILD_FP,
  OTHER_ORIGIN,
  ROOT,
  ROUTES,
  assertIngestRefused,
  assertNoNetworkAttempts,
  assertNothingWritten,
  campaignFixture,
  handoffOf,
  installPolishEvidence,
  mediaWeightFixture,
  polishStandIn,
  readJson,
  resourceIdOf,
  resultsOf,
  runCli,
  runNext,
  snapshot,
  twoCellFixture,
  withRecomputedIntegrity,
  writeJson,
} from "./qc-test-factories.mjs";

// No network: any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const HERO = "/runtime-packet-demo/img/hero.jpg";
const HERO_KEY = resourceIdOf(`${ORIGIN}${HERO}`);
const REDIRECT_FROM = `${OTHER_ORIGIN}/img/hero.jpg`;
const REDIRECT_KEY = resourceIdOf(REDIRECT_FROM);
const CONTROL_KEY = resourceIdOf(`${ORIGIN}/runtime-packet-demo/img/control.jpg`);
const E = "evidence_not_reproducible";

async function readMw({ record, pageLoad }, currentBuild = BUILD_FP) {
  const { readMediaWeight } = await import("./qc-results.mjs");
  const results = resultsOf(readMediaWeight({ record, pageLoad, currentBuild, qcStandIns: { polish: polishStandIn() } }));
  assert.ok(Array.isArray(results), "readMediaWeight returns the read 1.3 results");
  return results;
}

const onPage = (results, route) => results.filter((row) => row.subject?.page === route);

// The media.weight subjects listed for a cell, exactly: one per resource and
// one per unfetched same-origin <video> the setup created, none omitted.
function assertWeightKeys(results, route, keys, label) {
  const listed = onPage(results, route).filter((row) => row.check === "media.weight").map((row) => row.subject?.key).sort();
  assert.deepEqual(listed, [...keys].sort(), `${label}: the cell's media.weight results are exactly the setup's subjects`);
}

// Every listed result of the cell reads result / reasonCode.
function assertEvery(rows, result, reasonCode, label) {
  assert.ok(rows.length > 0, `${label}: the cell's 1.3 results are listed`);
  for (const row of rows) {
    assert.equal(row.result, result, `${label}: ${row.id} reads ${result}`);
    assert.equal(row.reason_code, reasonCode, `${label}: ${row.id} reads ${reasonCode}`);
  }
}

// The control cell keeps exactly its re-derived F1.3-B2 warning.
function assertControl(results) {
  assertWeightKeys(results, ROUTES[1], [CONTROL_KEY], "control cell");
  const [control] = onPage(results, ROUTES[1]).filter((row) => row.check === "media.weight");
  assert.equal(control.result, "warning", "the control cell keeps its warning");
  assert.equal(control.reason_code, "image_over_threshold");
  assert.equal(onPage(results, ROUTES[1]).some((row) => row.reason_code === E), false, "the control cell is unaffected");
}

function assertOnlyRoutes(results) {
  assert.deepEqual([...new Set(results.map((row) => row.subject?.page))].sort(), [...ROUTES].sort(), "results are listed for both cells and no other page");
}

// Record-level failure: every result of the record, across both cells.
function assertRecordNotReproducible(results, firstCellKeys = [HERO_KEY]) {
  assertOnlyRoutes(results);
  assertWeightKeys(results, ROUTES[0], firstCellKeys, "first cell");
  assertWeightKeys(results, ROUTES[1], [CONTROL_KEY], "control cell");
  assertEvery(results, "unexercised", E, "record");
}

// Cell-level failure: the tampered cell's results only; the control cell
// keeps its re-derived F1.3-B2 warning.
function assertCellNotReproducible(results, firstCellKeys = [HERO_KEY]) {
  assertOnlyRoutes(results);
  assertWeightKeys(results, ROUTES[0], firstCellKeys, "tampered cell");
  assertEvery(onPage(results, ROUTES[0]), "unexercised", E, "tampered cell");
  assertControl(results);
}

const firstResource = (record) => record.cells[0].resources[0];

// ---------------------------------------------------------------------------
// Broken rows

test("F1.0-B2 [stand-in: 1.3 media_weight record] record polish --evidence carrying visual_review.media_weight: refused; report unchanged (package_owned_key)", async (t) => {
  const f = campaignFixture({ setupCompleted: true, site: true });
  t.after(f.cleanup);
  const built = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(built.exitCode, 0, built.error?.message);
  const evidence = readJson(join(ROOT, "fixtures/stage-record/polish-evidence.json"));
  evidence.evidence.visual_review.media_weight = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 300_000 }] }] }).record;
  const evidencePath = join(f.dir, "polish-evidence.json");
  writeJson(evidencePath, evidence);
  const before = snapshot(f);
  const res = await runCli(["record", "polish", "--packet", f.packetPath, "--evidence", evidencePath, "--json"]);
  assertIngestRefused(res, { names: ["media_weight"] });
  assertNothingWritten(f, before);
});

test("F1.0-B20 [stand-in: 1.3 media_weight] transferred_bytes lowered with the integrity left unchanged: every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  firstResource(evidence.record).transferred_bytes = 400_000;
  assertRecordNotReproducible(await readMw(evidence));
});

test("F1.0-B21 [stand-in: 1.3 media_weight] transferred_bytes edited and integrity recomputed, now differing from the page_load ledger entry: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  firstResource(evidence.record).transferred_bytes = 400_000;
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B22 [stand-in: 1.3 media_weight] media_weight with performed_by \"agent\": every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  evidence.record = withRecomputedIntegrity({ ...evidence.record, performed_by: "agent" });
  assertRecordNotReproducible(await readMw(evidence));
});

test("F1.0-B26 [stand-in: 1.3 media_weight] media_weight with schema_version campaigns-os-polish-media-weight/v9: every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  evidence.record = withRecomputedIntegrity({ ...evidence.record, schema_version: "campaigns-os-polish-media-weight/v9" });
  assertRecordNotReproducible(await readMw(evidence));
});

test("F1.0-B27 [stand-in: 1.3 media_weight] canceled same-origin image (300,000 B lower bound) relabelled measurement complete, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 300_000, canceled: 1 }]);
  assert.equal(firstResource(evidence.record).measurement, "lower_bound", "precondition: the ledger entry is a lower bound");
  firstResource(evidence.record).measurement = "complete";
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B28 [stand-in: 1.3 media_weight] page_load capture incomplete but media_weight capture_status complete, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }], { firstCell: { captureStatus: "incomplete" } });
  assert.equal(evidence.record.cells[0].capture_status, "incomplete", "precondition: the capture is incomplete");
  evidence.record.cells[0].capture_status = "complete";
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B29 [stand-in: 1.3 media_weight] same-origin 900,000 B complete image with final_origin_equal set false, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 900_000 }]);
  firstResource(evidence.record).final_origin_equal = false;
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B30 [stand-in: 1.3 media_weight] cell document_origin changed to another origin, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  evidence.record.cells[0].document_origin = "https://other.example.invalid";
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B31 [stand-in: 1.3 media_weight] image resource type changed from image to fetch, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  firstResource(evidence.record).type = "fetch";
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B32 [stand-in: 1.3 media_weight F1.3-B4] first hop status changed from 302 to 200, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000, redirectFrom: REDIRECT_FROM }]);
  assert.equal(firstResource(evidence.record).chain[0].status, 302, "precondition: the first hop is the 302");
  firstResource(evidence.record).chain[0].status = 200;
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence), [REDIRECT_KEY]);
});

test("F1.0-B33 [stand-in: 1.3 media_weight] same-origin image with failed_request_count 1 relabelled failed false, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 0, failed: 1 }]);
  assert.equal(firstResource(evidence.record).failed, true, "precondition: the ledger entry failed");
  firstResource(evidence.record).failed = false;
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence));
});

test("F1.0-B34 [stand-in: 1.3 media_weight F1.3-B4] resource transferred_bytes set to the 302 hop's ledger bytes, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000, redirectFrom: REDIRECT_FROM }]);
  const hopEntry = evidence.pageLoad.captures[0].resource_ledger.entries.find((entry) => entry.statuses.includes(302));
  assert.ok(hopEntry, "precondition: the 302 hop has its own ledger entry");
  firstResource(evidence.record).transferred_bytes = hopEntry.transferred_bytes;
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertCellNotReproducible(await readMw(evidence), [REDIRECT_KEY]);
});

test("F1.0-B35 [stand-in: 1.3 media_weight] same-origin <video preload=\"none\"> never fetched, declared_origin_equal set false, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 300_000 }], { firstCell: { videos: [{ path: "/runtime-packet-demo/media/intro.mp4" }] } });
  assert.deepEqual(evidence.record.cells[0].videos[0].resource_ids, [], "precondition: the video was never fetched");
  assert.equal(evidence.record.cells[0].videos[0].declared_origin_equal, true, "setup: the video's declared source has the document origin");
  evidence.record.cells[0].videos[0].declared_origin_equal = false;
  evidence.record = withRecomputedIntegrity(evidence.record);
  // API assumption: the cell's 1.3 results include the unloaded video
  // (F1.3-I6) under subject key "video:0", tampered field or not.
  assertCellNotReproducible(await readMw(evidence), [HERO_KEY, "video:0"]);
});

test("F1.0-B40 [stand-in: 1.3 media_weight F1.3-B2] thresholds.image_bytes raised to 10,000,000, integrity recomputed: every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  evidence.record = withRecomputedIntegrity({ ...evidence.record, thresholds: { ...evidence.record.thresholds, image_bytes: 10_000_000 } });
  assertRecordNotReproducible(await readMw(evidence));
});

// ---------------------------------------------------------------------------
// Incomplete rows

test("F1.0-I8 [stand-in: 1.3 media_weight] media_weight bound to an older build fingerprint: result unexercised (stale_binding)", async (t) => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }], { buildFingerprint: OTHER_BUILD_FP });
  assert.notEqual(evidence.record.subject.build_fingerprint, BUILD_FP, "setup: the record is bound to an older build");
  const results = await readMw(evidence, BUILD_FP);
  assertOnlyRoutes(results);
  assertWeightKeys(results, ROUTES[0], [HERO_KEY], "first cell");
  assertWeightKeys(results, ROUTES[1], [CONTROL_KEY], "second cell");
  assertEvery(results, "unexercised", "stale_binding", "stale record");

  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, evidence, { buildFingerprint: BUILD_FP });
  const handoff = handoffOf(await runNext(f, { polish: polishStandIn() }));
  assert.ok(
    (handoff.coverage || []).some((entry) => entry.check === "media.weight" && entry.leg === "polish" && entry.result === "unexercised" && entry.reason_code === "stale_binding"),
    `qc_handoff.coverage lists media.weight unexercised / stale_binding: ${JSON.stringify(handoff.coverage)}`,
  );
  assert.equal((handoff.open || []).some((entry) => entry.leg === "polish"), false, "a stale Polish result is never open");
});

test("F1.0-I20 no Polish capture on the report: handoff coverage lists 1.3 unexercised (leg_not_run); the mapped campaign also lists parity.element", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  assert.equal(readJson(f.reportPath).stages.polish?.evidence, undefined, "precondition: no Polish capture");
  const handoff = handoffOf(await runNext(f, {}));
  const coverage = (handoff.coverage || []).filter((entry) => entry.leg === "polish");
  const tuples = [...new Set(coverage.map((entry) => JSON.stringify([entry.check, entry.result, entry.reason_code])))].map((text) => JSON.parse(text)).sort();
  assert.deepEqual(
    tuples,
    [["media.oversize", "unexercised", "leg_not_run"], ["media.weight", "unexercised", "leg_not_run"], ["parity.element", "unexercised", "leg_not_run"], ["readability.contrast", "unexercised", "leg_not_run"], ["visual.diff", "unexercised", "leg_not_run"], ["visual.reference", "unexercised", "leg_not_run"]],
    `qc_handoff.coverage lists both 1.3 checks, each unexercised / leg_not_run, and nothing else for Polish: ${JSON.stringify(handoff.coverage)}`,
  );
});

// Stream C3: stored package captures, never a second browser or decoder run.
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { syntheticCapturesRecord, createRgbaPng } from "./polish-visual-fixtures.mjs";
import { capturesIntegrity, writePolishPng } from "./polish-visual.mjs";
import { readCaptures, readCurrentQcResults, qcResultRef, buildQcResult, packetCampaignSlug, handoffCoverage } from "./qc-results.mjs";
import { loadQcRederivers } from "./qc-check-registry.mjs";
import { buildQcHandoff, createQcAccept, qcAcceptAttribution, planQcAccepts, assessQcAccepts } from "./qc-accept.mjs";
import { evaluatePolishGate } from "./polish-gate.mjs";

test("R4-4: unreadable packet and failing parity reader keep recorded parity in coverage", () => {
  const record = { cells: [] };
  const report = { stages: { polish: { status: "completed", evidence: { visual_review: { element_parity: record } } } } };
  const rederivers = { "parity.element": { status: "failed" } };
  const current = readCurrentQcResults({ report, doctor: {}, packetPath: "/unreadable-r4-packet.json", rederivers });
  assert.ok(current.results.some((row) => row.check === "parity.element" && row.reason_code === E));
  // If no reader row survives, the silence rule must still name the record.
  const coverage = handoffCoverage({ report, spec: null, results: [], packet: null, rederivers });
  assert.ok(coverage.some((row) => row.check === "parity.element" && row.reason_code === E));
  const noRecord = { stages: { polish: { status: "completed", evidence: { visual_review: {} } } } };
  assert.equal(handoffCoverage({ report: noRecord, spec: null, packet: null }).some((row) => row.check === "parity.element"), false);
  assert.equal(handoffCoverage({ report: { stages: {} }, spec: null, packet: null }).some((row) => row.check === "parity.element"), false);
  assert.ok(handoffCoverage({ report: { stages: { polish: { ...report.stages.polish, status: "pending" } } }, spec: null, packet: null })
    .some((row) => row.check === "parity.element"));
});
async function c3Fixture(t) {
  const targetRepo = mkdtempSync(join(tmpdir(), "c3-reader-"));
  t.after(() => rmSync(targetRepo, { recursive: true, force: true }));
  const report = { identity: { public_route_slug: "sample" }, stages: { assembly: { status: "completed", build_fingerprint: BUILD_FP } } };
  const packet = { campaign: { public_route_slug: "sample" }, source_html: { root: "source", pages: [{ page_id: "page", path: "page.html", page_kit: { public_route: "/sample/page/", spec_route: "page/" } }] } };
  const routes = [{ page_id: "page", requested_route: "/sample/page/" }];
  const record = syntheticCapturesRecord(report, { routes, targetRepo });
  record.subject.routes = ["/sample/page/"];
  record.references = [{ page_id: "page", route: "/sample/page/", viewport: null, ref_id: "source_html", kind: "html_file",
    verification: { level: "decoded", reason: null }, identity: { sha256: BUILD_FP }, provenance: { class: "declared_source", reasons: [] } }];
  record.comparisons = ["desktop", "mobile"].map((viewport) => ({ page_id: "page", route: "/sample/page/", viewport, basis: "source_html", ref_id: null,
    build_shot: "stabilized", basis_shot: "stabilized", status: "compared", reason: null, members: [], artifacts: [], bands: [], limits: [], diff_options: { threshold: 0.1, include_aa: false, alpha: 0.1 },
    page: { status: "compared", mismatch_ratio: 0, mismatch_pixels: 0, compared_pixels: 10, masked_pixels: 0, canvas: { width: viewport === "desktop" ? 1440 : 390, height: viewport === "desktop" ? 1200 : 844 }, height_delta_px: 0 } }));
  const rederivers = await loadQcRederivers();
  const seal = () => { record.integrity = capturesIntegrity(record); };
  seal();
  report.stages.polish = { status: "completed", performed_by: "next-campaigns-polish", source_build_fingerprint: BUILD_FP,
    completed_at: "2026-01-01T00:00:00.000Z", evidence: { ...readJson(join(ROOT, "fixtures/stage-record/polish-evidence.json")).evidence, visual_review: { captures: record } } };
  const read = (extra = {}) => { seal(); return readCaptures({ record, packet, currentBuild: BUILD_FP, currentSource: null,
    buildOutput: { status: "pass" }, campaignSlug: "sample", targetRepo, rederivers, ...extra }); };
  const packetPath = join(targetRepo, "packet.json"); writeJson(packetPath, packet);
  return { record, report, packet, targetRepo, packetPath, rederivers, read, seal };
}
const c3Diffs = (rows) => rows.filter((r) => r.check === "visual.diff");
const hasMember = (row, reason) => row.members.some((m) => m.reason_code === reason);
test("F3C-B7 wrong capture bytes and absent capture files never produce metrics", async (t) => {
  const f = await c3Fixture(t);
  writeFileSync(join(f.targetRepo, f.record.cells[0].actual.png.path), "changed");
  unlinkSync(join(f.targetRepo, f.record.cells[2].actual.png.path));
  assertCapturesRefused(f.read(), "png_hash_mismatch");
  // Wrong bytes outrank an absent file whichever is read first (§5.3 step 1 before step 9).
  const reversed = await c3Fixture(t);
  unlinkSync(join(reversed.targetRepo, reversed.record.cells[0].actual.png.path));
  writeFileSync(join(reversed.targetRepo, reversed.record.cells[2].actual.png.path), "changed");
  assertCapturesRefused(reversed.read(), "png_hash_mismatch");
  // A clone without the git-ignored captures reads capture_file_absent, not tampering.
  const fresh = await c3Fixture(t);
  unlinkSync(join(fresh.targetRepo, fresh.record.cells[2].actual.png.path));
  assertCapturesRefused(fresh.read(), "capture_file_absent");
});
test("A capture file replaced by a symlink or a directory names that, not a corrupt PNG or an absent file", async (t) => {
  for (const replace of [
    (path, f) => { const real = join(f.targetRepo, "elsewhere.png"); writeFileSync(real, "x"); unlinkSync(path); symlinkSync(real, path); },
    (path) => { unlinkSync(path); mkdirSync(path); },
  ]) {
    const f = await c3Fixture(t);
    replace(join(f.targetRepo, f.record.cells[0].actual.png.path), f);
    assertCapturesRefused(f.read(), "capture_file_not_regular");
  }
});
test("A caller that passes no build output reads the captures without the output check", async (t) => {
  const f = await c3Fixture(t);
  assert.ok(f.read({ buildOutput: undefined }).every((row) => row.reason_code !== "stale_binding"));
  assert.ok(f.read({ buildOutput: null }).every((row) => row.reason_code === "stale_binding"));
});
for (const [id, mutate, member, detail] of [
  ["F3C-B8", (bytes) => { bytes[45] ^= 1; return bytes; }, "png_structure_invalid", "chunk_crc_mismatch"],
  ["F3C-B8b capture half", () => Buffer.from("not a png"), "png_structure_invalid", "not_png"],
  ["F3C-B9b", () => createRgbaPng(2880, 1200), "png_dimensions_mismatch", null],
]) test(`${id} reader reaches the file check after recomputed content address and integrity`, async (t) => {
  const f = await c3Fixture(t);
  const bytes = mutate(createRgbaPng(1440, 1200));
  // Deliberately bypass the writer's structure guard to model tampered disk evidence.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const png = { ...f.record.cells[0].actual.png, path: `.campaign-runtime/polish/captures/${hash}.png`, sha256: `sha256:${hash}`, bytes: bytes.length };
  writeFileSync(join(f.targetRepo, png.path), bytes);
  f.record.cells[0].actual.png = png;
  const rows = f.read();
  assertCapturesRefused(rows, member);
  assert.ok(rows.every((row) => row.observation.reader_detail === detail));
  assert.equal(evaluatePolishGate({ report: f.report }).code, "polish.evidence_current", "file checks never enter the data-only gate");
});
// §10 B9: “Record with integrity recomputed, in which a `captured` desktop cell
// has `png.width_px: 2880` with DPR 1 and crop width 1440” → “Gate
// `polish.evidence_incomplete` (§5.4 condition 5). Reader
// `evidence_not_reproducible` (`png_dimensions_mismatch`, step 1).
// Inc3 "viewport/pixel-ratio mismatch cannot clear a claimed capture"”.
// §5.5 step 1: “Any failure makes every row `evidence_not_reproducible`”.
test("F3C-B9 metadata dimensions disagree with crop before file checks", async (t) => {
  const f = await c3Fixture(t); f.record.cells[0].actual.png.width_px = 2880;
  const rows = f.read(); assertCapturesRefused(rows, "png_dimensions_mismatch");
  assert.equal(evaluatePolishGate({ report: f.report }).code, "polish.evidence_incomplete");
});
test("F3C-B18a crop origin and F3C-B19 record state cannot be reconstructed as a pass", async (t) => {
  const f = await c3Fixture(t);
  for (const [axis, value] of [["y", 200], ["x", 10]]) {
    f.record.cells[0].actual.crop[axis] = value;
    assertCapturesRefused(f.read(), "crop_not_full_page");
    assert.equal(evaluatePolishGate({ report: f.report }).code, "polish.evidence_incomplete");
    f.record.cells[0].actual.crop[axis] = 0;
  }
  f.record.cells[0].state = "scrolled";
  assertCapturesRefused(f.read(), "treatment_invalid");
});
test("F3C-I9 older capture binding stays stale even if the stage is current", async (t) => {
  const f = await c3Fixture(t); f.record.subject.build_fingerprint = OTHER_BUILD_FP;
  assertCapturesRefused(f.read(), "stale_binding");
  assert.equal(evaluatePolishGate({ report: f.report }).code, "polish.evidence_incomplete");
});
test("F3C-I10 pre-C Polish handoff reports not_captured_by_this_version", async (t) => {
  const f = await c3Fixture(t); delete f.report.stages.polish.evidence.visual_review.captures;
  const current = readCurrentQcResults({ ...f, doctor: { derived: { build_output_fingerprint: { status: "pass" } } } });
  assert.deepEqual(current.coverage.filter((c) => c.check.startsWith("visual.")).map((c) => c.reason_code), ["not_captured_by_this_version", "not_captured_by_this_version"]);
});
test("F3C-I16 caller packet snapshot beats a default-path decoy; unavailable packet never uses claimed routes", async (t) => {
  const f = await c3Fixture(t);
  const directory = join(f.targetRepo, "elsewhere"); mkdirSync(directory);
  const packetPath = join(directory, "campaign-packet.json"); writeJson(packetPath, f.packet);
  mkdirSync(join(directory, "source")); writeFileSync(join(directory, "source/page.html"), "<!doctype html><p>synthetic custom source</p>");
  const { planPolishCapture } = await import("./polish-node.mjs");
  const { runVisualPass } = await import("./polish-visual.mjs");
  const captured = await runVisualPass({ packet: f.packet, packetPath, report: f.report, targetRepo: f.targetRepo,
    frozen: { plan: planPolishCapture({ packet: f.packet, baseUrl: "http://127.0.0.1" }), page_load: { subject: f.record.subject } },
    createBrowserAdapter: async () => ({ async close() {}, async renderForCompare({ viewport }) {
      const shot = { status: "captured", bytes: createRgbaPng(viewport.width, viewport.height), full_height_css: viewport.height,
        crop: { x: 0, y: 0, width: viewport.width, height: viewport.height }, truncated: false };
      return { status: "rendered", readiness: { fonts: { status: "settled", failed_faces: 0, waited_ms: 0 }, await: { status: "not_present", remaining_count: 0, waited_ms: 0 } },
        actual: shot, stabilized: shot, probes: { visual_sections: { status: "measured", value: { status: "no_section_keys", bands: [], capped: false } } } };
    } }), now: "2026-01-01T00:00:00.000Z" });
  assert.equal(captured.source.root_rel, "elsewhere/source");
  assert.equal(captured.source.status, "available");
  const capturedRows = readCaptures({ record: captured, packet: f.packet, currentBuild: BUILD_FP, currentSource: null,
    buildOutput: { status: "pass" }, campaignSlug: "sample", targetRepo: f.targetRepo, rederivers: f.rederivers });
  assert.ok(capturedRows.length > 0 && capturedRows.every((r) => r.reason_code !== E), JSON.stringify(capturedRows));
  assert.ok(captured.cells.filter((c) => c.side === "source_html").every((c) => realpathSync(join(f.targetRepo, c.source_path_rel)) === realpathSync(join(directory, "source/page.html"))));
  const decoy = structuredClone(f.packet); decoy.source_html.pages[0].page_kit.public_route = "/decoy/";
  writeJson(join(f.targetRepo, "campaign-runtime.build.json"), decoy);
  const read = (path = packetPath) => { f.seal(); return readCurrentQcResults({ ...f, packetPath: path, doctor: { derived: { build_output_fingerprint: { status: "pass" } } } }).results.filter((r) => r.check.startsWith("visual.")); };
  assert.ok(c3Diffs(read()).every((r) => r.result === "review"));
  f.record.subject.routes[0] = "/decoy/";
  for (const item of [...f.record.cells, ...f.record.references, ...f.record.comparisons]) item.route = "/decoy/";
  assert.ok(read().every((r) => r.reason_code === E && hasMember(r, "route_outside_plan")));
  assert.ok(read(null).every((r) => r.reason_code === E && hasMember(r, "packet_unavailable")));
});
test("F3C-B15 near-zero diff cannot override readability or self-reference warnings or handoff placement", async (t) => {
  const f = await c3Fixture(t); f.record.references[0].provenance = { class: "self_referential", reasons: ["hash_equals_built_html"] };
  const readability = buildQcResult({ check: "readability.contrast", leg: "polish", subject: { check: "readability.contrast", page: "/sample/page/", key: "text" }, result: "warning", reason_code: "contrast_low", state: {} });
  const rows = f.read(); const handoff = buildQcHandoff({ results: [...rows, readability] });
  assert.ok(c3Diffs(rows).every((r) => r.result === "review" && !r.accept_eligible));
  assert.equal(handoff.review.length, 2); assert.equal(handoff.open.length, 2);
  assert.ok(handoff.open.some((r) => r.check === readability.check));
  assert.ok(handoff.open.some((r) => r.reason_code === "self_referential"));
});
test("F3C-W7 checkpoint accept keeps a self-referential result warning and lists an active revision baseline", async (t) => {
  const f = await c3Fixture(t); f.record.references[0].provenance = { class: "self_referential", reasons: ["hash_equals_built_html"] };
  const rows = f.read(), warning = rows.find((r) => r.check === "visual.reference");
  const now = "2026-10-23T00:00:00.000Z";
  const attribution = qcAcceptAttribution({ reason: "Use current output as the revision baseline", acceptedBy: "Casey Morgan", now });
  const ref = qcResultRef(warning), [id, prefix] = ref.split("@");
  const accepts = planQcAccepts({ refs: [{ ref, id, prefix }], results: rows, now, attribution });
  assert.equal(accepts[0].measured_source, "polish_captures");
  assert.equal(assessQcAccepts(accepts, rows, { now })[0].status, "active");
  const handoff = buildQcHandoff({ results: rows, accepts, now });
  assert.equal(handoff.accepted[0].result, "warning"); assert.equal(handoff.accepted[0].disposition, "operator_accepted");
  assert.equal(handoff.review.length, 2);
  assert.ok(c3Diffs(rows).every((r) => hasMember(r, "basis_not_independent")));
  f.record.measured_at = "2026-10-22T00:00:00.000Z";
  assert.equal(assessQcAccepts(accepts, f.read(), { now })[0].status, "active", "recapture with same bytes and provenance retains baseline");
  f.record.subject.build_fingerprint = OTHER_BUILD_FP;
  assert.equal(assessQcAccepts(accepts, f.read(), { now })[0].status, "lapsed");
});
async function c3CliFixture(t) {
  const f = campaignFixture({ setupCompleted: true, site: true }); t.after(f.cleanup);
  const built = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(built.exitCode, 0, built.error?.message);
  const packet = readJson(f.packetPath), report = readJson(f.reportPath);
  const { planPolishCapture } = await import("./polish-node.mjs");
  const { currentSourcePackageMaterialFingerprint } = await import("./polish-gate.mjs");
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1" });
  const record = syntheticCapturesRecord(report, { routes: plan.routes, targetRepo: f.targetRepo });
  record.subject = { ...record.subject, campaign_slug: packet.campaign.public_route_slug, routes: plan.routes.map((r) => r.requested_route),
    route_scope: plan.route_scope, source_package_material_fingerprint: currentSourcePackageMaterialFingerprint(report) };
  record.references = plan.routes.map((r) => ({ page_id: r.page_id, route: r.requested_route, viewport: null, ref_id: "source_html", kind: "html_file",
    verification: { level: "decoded", reason: null }, identity: { sha256: BUILD_FP }, provenance: { class: "self_referential", reasons: ["hash_equals_built_html"] } }));
  record.comparisons = plan.routes.flatMap((r) => plan.viewports.map((v) => ({ page_id: r.page_id, route: r.requested_route, viewport: v.key, basis: "source_html", ref_id: null,
    build_shot: "stabilized", basis_shot: "stabilized", status: "compared", reason: null, members: [], artifacts: [], bands: [], limits: [], diff_options: { threshold: 0.1, include_aa: false, alpha: 0.1 },
    page: { status: "compared", mismatch_ratio: 0, mismatch_pixels: 0, compared_pixels: v.width * v.height, masked_pixels: 0, canvas: { width: v.width, height: v.height }, height_delta_px: 0 } })));
  record.integrity = capturesIntegrity(record);
  report.stages.polish.evidence = { visual_review: { captures: record } }; writeJson(f.reportPath, report);
  return { ...f, record, report };
}
test("F3C-W7 CLI next and checkpoint accept read the same package reference and preserve next status", async (t) => {
  const f = await c3CliFixture(t);
  const before = await runNext(f);
  const warning = handoffOf(before).open.find((r) => r.check === "visual.reference");
  assert.ok(warning?.accept_eligible, JSON.stringify(handoffOf(before)));
  const result = await runCli(["checkpoint", "accept", "--packet", f.packetPath, "--result", warning.result_ref,
    "--reason", "Use this output as the revision baseline", "--accepted-by", "Casey Morgan", "--json"]);
  assert.equal(result.exitCode, 0, result.error?.message || result.stderr);
  const after = await runNext(f);
  assert.equal(after.status, before.status);
  const accepted = handoffOf(after).accepted.find((r) => r.result_ref === warning.result_ref);
  assert.equal(accepted?.result, "warning"); assert.equal(accepted?.disposition, "operator_accepted");
});
test("F3C-B16 fully reconstructed consistent records read as recorded: A1 residual", async (t) => {
  const f = await c3Fixture(t);
  f.record.comparisons[0].page.mismatch_ratio = 0.5;
  f.record.comparisons[0].page.mismatch_pixels = 5;
  assert.equal(c3Diffs(f.read())[0].observation.page.mismatch_ratio, 0.5);
  assert.equal(c3Diffs(f.read())[0].result, "review");
  assert.equal(evaluatePolishGate({ report: f.report }).code, "polish.evidence_current");
});

// Reader failures invalidate every row, including sibling diffs and references.
// A changed build and an absent capture file are the row's own reason (§5.3
// steps 2 and 9); every other failure is evidence_not_reproducible with a member.
const OWN_READER_REASONS = ["stale_binding", "capture_file_absent"];
const readerReasonCode = (reason) => OWN_READER_REASONS.includes(reason) ? reason : E;
function assertCapturesRefused(rows, reason) {
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.check === "visual.reference"));
  assert.ok(c3Diffs(rows).some((r) => r.subject.viewport === "desktop"));
  assert.ok(c3Diffs(rows).some((r) => r.subject.viewport === "mobile"));
  for (const row of rows) {
    assert.equal(row.result, "unexercised", row.id);
    assert.equal(row.reason_code, readerReasonCode(reason), row.id);
    if (OWN_READER_REASONS.includes(reason)) assert.deepEqual(row.members, [], row.id);
    else assert.ok(hasMember(row, reason), `${row.id}: ${reason}`);
    assert.equal(row.accept_eligible, false, row.id);
  }
}

function addC3ImageReference(record) {
  const ref = { ...structuredClone(record.references[0]), viewport: "desktop", ref_id: "image", kind: "source_screenshot",
    css_width: 1440, dpr: 1, verification: { level: "decoded", reason: null, png: { width_px: 1440, height_px: 1200 } },
    provenance: { class: "self_referential", reasons: ["hash_equals_package_capture"] } };
  record.references.push(ref);
  record.comparisons.push({ ...structuredClone(record.comparisons[0]), basis: "reference", ref_id: "image", build_shot: "actual", basis_shot: "image" });
}

test("F3C-R2 comparison-level width mismatch stays scoped to its image diff (§5.3)", async (t) => {
  const f = await c3Fixture(t);
  addC3ImageReference(f.record);
  f.record.references.at(-1).css_width = 375;
  Object.assign(f.record.comparisons.at(-1), { status: "unsupported", reason: "width_mismatch", page: null });
  const rows = f.read();
  const imageDiff = rows.find((r) => r.check === "visual.diff" && r.subject.key === "ref:image");
  assert.equal(imageDiff.reason_code, "comparison_unsupported");
  assert.ok(hasMember(imageDiff, "width_mismatch"));
  assert.ok(c3Diffs(rows).filter((r) => r.subject.key === "source_html").every((r) => r.result === "review"));
  const imageRef = rows.find((r) => r.check === "visual.reference" && r.subject.key === "ref:image");
  assert.equal(imageRef.reason_code, "self_referential");
  assert.equal(imageRef.accept_eligible, true);
});

test("F3C-R2 every reader failure preserves HTML and image identities and lapses their revision baselines", async (t) => {
  const f = await c3Fixture(t);
  f.record.references[0].provenance = { class: "self_referential", reasons: ["hash_equals_built_html"] };
  addC3ImageReference(f.record);
  const originalRows = f.read(), original = structuredClone(f.record);
  const now = "2026-10-23T00:00:00.000Z";
  const attribution = qcAcceptAttribution({ reason: "Use this output as the revision baseline", acceptedBy: "Casey Morgan", now });
  const refs = originalRows.filter((r) => r.check === "visual.reference").map((row) => {
    const ref = qcResultRef(row), [id, prefix] = ref.split("@"); return { ref, id, prefix };
  });
  const accepts = planQcAccepts({ refs, results: originalRows, now, attribution });
  assert.equal(accepts.length, 2);
  assert.ok(assessQcAccepts(accepts, originalRows, { now }).every((a) => a.status === "active"));
  const cases = [
    ["integrity", () => {}, "record_shape_invalid", { brokenIntegrity: true }],
    ["schema", (r) => { r.schema_version = "unknown/v9"; }, "record_shape_invalid"],
    ["dimensions", (r) => { r.cells[0].actual.png.width_px = 2880; }, "png_dimensions_mismatch"],
    ["crop", (r) => { r.cells[0].actual.crop.y = 1; }, "crop_not_full_page"],
    ["state", (r) => { r.cells[0].state = "scrolled"; }, "treatment_invalid"],
    ["null cell", (r) => { r.cells[0] = null; }, "cell_grid_invalid"],
    ["missing cells", (r) => { r.cells = []; }, "cell_grid_invalid"],
    ["duplicate cell", (r) => { r.cells[0] = structuredClone(r.cells[1]); }, "cell_grid_invalid"],
    ["malformed comparison", (r) => { r.comparisons[0].bands = [null]; }, "comparison_shape_invalid"],
    ["outside plan", (r) => {
      r.subject.routes.push("/unplanned/");
      r.cells.push(...r.cells.map((c) => ({ ...structuredClone(c), route: "/unplanned/" })));
    }, "route_outside_plan"],
    ["stale build", (r) => { r.subject.build_fingerprint = OTHER_BUILD_FP; }, "stale_binding"],
    ["stale source", (r) => { r.subject.source_package_material_fingerprint = OTHER_BUILD_FP; }, "stale_binding"],
    ["output drift", () => {}, "stale_binding", { buildOutput: { status: "fail" } }],
    ["packet unavailable", () => {}, "packet_unavailable", { packet: null }],
  ];
  for (const [label, mutate, reason, { brokenIntegrity, ...extra } = {}] of cases) {
    const record = structuredClone(original); mutate(record);
    record.integrity = brokenIntegrity ? "sha256:broken" : capturesIntegrity(record);
    const rows = f.read({ record, ...extra });
    assertCapturesRefused(rows, reason);
    assert.deepEqual(rows.map((r) => r.id).sort(), originalRows.map((r) => r.id).sort(), `${label}: identities survive`);
    assert.deepEqual(assessQcAccepts(accepts, rows, { now }), accepts.map(() => ({ status: "lapsed", why: readerReasonCode(reason), applied: false })), label);
    assert.throws(() => planQcAccepts({ refs, results: rows, now, attribution }), label);
    assert.equal(rows.some((r) => r.subject.page === "/unplanned/"), false);
  }
});

test("F3C-B7 a capture file absent on this machine reads capture_file_absent on every row; the baseline is not applied until the file is back", async (t) => {
  const f = await c3Fixture(t);
  f.record.references[0].provenance = { class: "self_referential", reasons: ["hash_equals_built_html"] };
  const rows = f.read(), warning = rows.find((r) => r.check === "visual.reference");
  const now = "2026-10-23T00:00:00.000Z";
  const attribution = qcAcceptAttribution({ reason: "Use this output as the revision baseline", acceptedBy: "Casey Morgan", now });
  const ref = qcResultRef(warning), [id, prefix] = ref.split("@");
  const accepts = planQcAccepts({ refs: [{ ref, id, prefix }], results: rows, now, attribution });
  assert.equal(assessQcAccepts(accepts, rows, { now })[0].status, "active");
  const path = join(f.targetRepo, f.record.cells[2].actual.png.path);
  unlinkSync(path);
  const absent = f.read();
  assertCapturesRefused(absent, "capture_file_absent");
  assert.deepEqual(absent.map((r) => r.id).sort(), rows.map((r) => r.id).sort());
  const [assessment] = assessQcAccepts(accepts, absent, { now });
  assert.equal(assessment.applied, false); assert.equal(assessment.status, "lapsed"); assert.equal(assessment.why, "capture_file_absent");
  assert.throws(() => planQcAccepts({ refs: [{ ref, id, prefix }], results: absent, now, attribution }));
  writeFileSync(path, createRgbaPng(390, 844));
  assert.equal(assessQcAccepts(accepts, f.read(), { now })[0].status, "active", "the same bytes back restore the baseline");
});

test("F3C-R2 CLI refuses a new accept and lapses accepted image and HTML references after tampering", async (t) => {
  const f = await c3CliFixture(t);
  addC3ImageReference(f.record);
  f.record.integrity = capturesIntegrity(f.record); writeJson(f.reportPath, f.report);
  const before = await runNext(f);
  const warnings = handoffOf(before).open.flatMap((group) => group.results).filter((r) => r.check === "visual.reference"
    && r.page === f.record.references[0].route);
  assert.equal(warnings.length, 2);
  for (const warning of warnings) {
    const accepted = await runCli(["checkpoint", "accept", "--packet", f.packetPath, "--result", warning.result_ref,
      "--reason", "Use this output as the revision baseline", "--accepted-by", "Casey Morgan", "--json"]);
    assert.equal(accepted.exitCode, 0, accepted.stderr);
  }
  const report = readJson(f.reportPath), original = structuredClone(f.record);
  for (const brokenIntegrity of [false, true]) {
    const record = structuredClone(original);
    if (brokenIntegrity) record.integrity = "sha256:broken";
    else { record.cells[0].actual.png.width_px = 2880; record.integrity = capturesIntegrity(record); }
    report.stages.polish.evidence.visual_review.captures = record; writeJson(f.reportPath, report);
    const next = await runNext(f), handoff = handoffOf(next);
    for (const warning of warnings) {
      assert.ok(handoff.lapsed.some((r) => r.result_id === warning.result_ref.split("@")[0] && r.why === E), JSON.stringify(handoff));
      const refused = await runCli(["checkpoint", "accept", "--packet", f.packetPath, "--result", warning.result_ref,
        "--reason", "Use this output as the revision baseline", "--accepted-by", "Casey Morgan", "--json"]);
      assert.equal(refused.error, null); assert.equal(refused.exitCode, 1);
      assert.equal(refused.json?.refusal_code, "changed_since_handoff");
    }
    assert.deepEqual(readJson(f.reportPath).qc_accepts, report.qc_accepts, "refusals never append accepts");
  }
});

test("F3C-R1 accept becomes inert/target_not_warning when self-reference disappears before fingerprint comparison", async (t) => {
  const f = await c3Fixture(t);
  f.record.references[0].provenance = { class: "self_referential", reasons: ["hash_equals_built_html"] };
  const warning = f.read().find((r) => r.check === "visual.reference");
  const now = "2026-10-23T00:00:00.000Z";
  const attribution = qcAcceptAttribution({ reason: "Use this output as the revision baseline", acceptedBy: "Casey Morgan", now });
  const ref = qcResultRef(warning), [id, prefix] = ref.split("@");
  const accepts = planQcAccepts({ refs: [{ ref, id, prefix }], results: f.read(), now, attribution });
  f.record.references[0].provenance = { class: "declared_source", reasons: [] };
  const rows = f.read(), current = rows.find((r) => r.id === warning.id);
  assert.equal(current.result, "pass");
  assert.notEqual(current.state_fingerprint, warning.state_fingerprint);
  assert.deepEqual(assessQcAccepts(accepts, rows, { now }), [{ status: "inert", why: "target_not_warning", applied: false }]);
  const handoff = buildQcHandoff({ results: rows, accepts, now });
  assert.ok(handoff.inert_accepts.some((r) => r.result_id === warning.id && r.why === "target_not_warning"));
});

// §6: the target_not_warning rule fires only when the current row is not a
// warning. A reference that is still self-referential stays a warning, so a
// changed identity reaches the fingerprint comparison and lapses.
test("F3C-R1 accept lapses with state_changed when a still self-referential reference changes identity", async (t) => {
  const f = await c3Fixture(t);
  f.record.references[0].provenance = { class: "self_referential", reasons: ["hash_equals_built_html"] };
  const warning = f.read().find((r) => r.check === "visual.reference");
  const now = "2026-10-23T00:00:00.000Z";
  const attribution = qcAcceptAttribution({ reason: "Use this output as the revision baseline", acceptedBy: "Casey Morgan", now });
  const ref = qcResultRef(warning), [id, prefix] = ref.split("@");
  const accepts = planQcAccepts({ refs: [{ ref, id, prefix }], results: f.read(), now, attribution });
  assert.equal(assessQcAccepts(accepts, f.read(), { now })[0].status, "active");
  for (const change of [
    (r) => { r.identity.sha256 = OTHER_BUILD_FP; },
    (r) => { r.provenance.reasons = ["hash_equals_built_html", "path_in_runtime_dir"]; },
  ]) {
    const original = structuredClone(f.record.references[0]);
    change(f.record.references[0]);
    const rows = f.read(), current = rows.find((r) => r.id === warning.id);
    assert.deepEqual([current.result, current.reason_code], ["warning", "self_referential"]);
    assert.notEqual(current.state_fingerprint, warning.state_fingerprint);
    assert.deepEqual(assessQcAccepts(accepts, rows, { now }), [{ status: "lapsed", why: "state_changed", applied: false }]);
    f.record.references[0] = original;
  }
});

test("Reader: the source HTML's source_hash_unrecorded is in the closed provenance vocabulary", async (t) => {
  const f = await c3Fixture(t);
  f.record.references[0].provenance = { class: "unknown", reasons: ["source_hash_unrecorded"] };
  const row = f.read().find((r) => r.check === "visual.reference");
  assert.deepEqual([row.result, row.reason_code], ["review", "provenance_unknown"]);
});

test("Reader: a loaded cell whose probe failed or whose document changed reads its own status, not navigation_failed", async (t) => {
  for (const status of ["probe_failed", "document_changed"]) {
    const f = await c3Fixture(t);
    const cell = f.record.cells.find((c) => c.side === "build" && c.viewport === "desktop");
    cell.status = status;
    for (const key of ["actual", "stabilized"]) Object.assign(cell[key], { status: "skipped", png: null, full_height_css: null, crop: null, truncated: false });
    const rows = f.read();
    const desktop = c3Diffs(rows).find((r) => r.subject.viewport === "desktop");
    assert.deepEqual([desktop.result, desktop.reason_code, desktop.members], ["unexercised", "capture_unavailable", [{ key: "build", result: "unexercised", reason_code: status }]], status);
    assert.equal(c3Diffs(rows).find((r) => r.subject.viewport === "mobile").result, "review", status);
  }
});

test("Reader: a cell with a missing shot object reads cell_shape_invalid, never a thrown read", async (t) => {
  for (const key of ["actual", "stabilized"]) {
    const f = await c3Fixture(t);
    f.record.cells[0][key] = null;
    assertCapturesRefused(f.read(), "cell_shape_invalid");
  }
});

test("Polish records bind to the readable packet's slug (null when it names none), else to the report's", () => {
  const report = { identity: { public_route_slug: "sample" } };
  for (const [packet, expected] of [
    [{ campaign: { public_route_slug: "packet-slug" } }, "packet-slug"],
    [{ campaign: { public_route_slug: "" } }, null],
    [{ campaign: {} }, null],
  ]) assert.equal(packetCampaignSlug({ packet, packetRead: true, report }), expected, JSON.stringify(packet));
  // A packet file that was read but did not parse to an object names no slug (main's rule).
  for (const parsed of [[], null, false, 7, "text"]) {
    assert.equal(packetCampaignSlug({ packet: parsed, packetRead: true, report }), null, JSON.stringify(parsed));
  }
  assert.equal(packetCampaignSlug({ packet: null, packetRead: false, report }), "sample");
  assert.equal(packetCampaignSlug({ packet: null, report }), "sample");
  assert.equal(packetCampaignSlug({ packet: { campaign: { public_route_slug: "packet-slug" } }, report }), "sample");
  assert.equal(packetCampaignSlug({ packet: { campaign: { public_route_slug: "" } }, packetRead: true, report: { identity: { public_route_slug: "" } } }), null);
});

test("F3C-B15 CLI next status is unchanged with a near-zero diagnostic diff present", async (t) => {
  const f = await c3CliFixture(t);
  const comparisons = f.record.comparisons;
  f.record.comparisons = [];
  f.record.integrity = capturesIntegrity(f.record); writeJson(f.reportPath, f.report);
  const without = await runNext(f);
  assert.equal(handoffOf(without).review.some((r) => r.check === "visual.diff"), false);
  f.record.comparisons = comparisons;
  f.record.integrity = capturesIntegrity(f.record); writeJson(f.reportPath, f.report);
  const withDiff = await runNext(f);
  assert.equal(withDiff.status, without.status);
  assert.ok(handoffOf(withDiff).review.some((r) => r.check === "visual.diff"));
  assert.ok(handoffOf(withDiff).open.some((r) => r.reason_code === "self_referential"));
});

test("F3C-R1 malformed comparison bands, artifacts and worst_tiles refuse every record row", async (t) => {
  const f = await c3Fixture(t), original = structuredClone(f.record.comparisons[0]);
  for (const [key, value] of [["bands", [null]], ["artifacts", [null]], ["page", { ...original.page, worst_tiles: {} }]]) {
    f.record.comparisons[0] = { ...structuredClone(original), [key]: value };
    const rows = f.read();
    const bad = c3Diffs(rows).find((r) => r.subject.viewport === "desktop");
    assert.equal(bad.reason_code, E); assert.ok(bad.members.some((m) => typeof m.reason_code === "string" && m.reason_code.length > 0));
    assertCapturesRefused(rows, bad.members[0].reason_code);
  }
});

test("F3C-R1 next --json keeps its handoff and checkpoint accept gives an evidence refusal for malformed captures", async (t) => {
  const f = await c3CliFixture(t);
  const before = await runNext(f), ref = handoffOf(before).open.find((r) => r.check === "visual.reference").result_ref;
  f.record.references[0].provenance.reasons = [null];
  f.record.comparisons[0].bands = [null];
  f.record.integrity = capturesIntegrity(f.record); writeJson(f.reportPath, f.report);
  const result = await runCli(["next", "--packet", f.packetPath, "--json"]);
  assert.equal(result.error, null, result.stderr);
  assert.ok(handoffOf(result.json).coverage.some((r) => r.reason_code === E));
  const refused = await runCli(["checkpoint", "accept", "--packet", f.packetPath, "--result", ref,
    "--reason", "Use this output as the revision baseline", "--accepted-by", "Casey Morgan", "--json"]);
  assert.equal(refused.error, null);
  assert.equal(refused.exitCode, 1);
  assert.doesNotMatch(refused.stderr, /TypeError/);
  assert.equal(refused.json?.refusal_code, "changed_since_handoff");
});

test("F3C-R1 replacing one cell or comparison with null refuses every record row", async (t) => {
  for (const collection of ["cells", "comparisons"]) {
    const f = await c3Fixture(t); f.record[collection][0] = null;
    const rows = f.read();
    assertCapturesRefused(rows, collection === "cells" ? "cell_grid_invalid" : "comparison_shape_invalid");
  }
});

// Walk a rich valid record, including populated collections, rather than a
// hand-picked list of the three originally reported crash sites.
test("F3C-R1 generated shape mutations of every captures field return current QC rows without throwing", async (t) => {
  const f = await c3Fixture(t), base = structuredClone(f.record);
  const band = { key: "hero", top: 0, left: 0, width: 32, height: 32 };
  for (const cell of base.cells) {
    cell.sections = { status: "measured", bands: [band], duplicated_keys: [], capped: false };
    cell.stabilized.treatment.masks = [{ group: "timer", count: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }] }];
  }
  const image = writePolishPng(f.targetRepo, "diff", createRgbaPng(32, 32));
  for (const comparison of base.comparisons) {
    comparison.bands = [{ key: "hero", status: "compared", mismatch_ratio: 0, mismatch_pixels: 0, compared_pixels: 1024,
      masked_pixels: 0, canvas: { width: 32, height: 32 }, height_delta_px: 0,
      worst_tiles: [{ x: 0, y: 0, width: 32, height: 32, mismatch_ratio: 0 }] }];
    comparison.page.worst_tiles = [];
    comparison.members = [{ key: "sections", result: "unexercised", reason_code: "no_section_keys" }];
    comparison.artifacts = [{ band_key: "hero", basis_crop: image, build_crop: image, heatmap: image }];
  }
  base.references[0].verification.png = { width_px: 1440, height_px: 1200 };
  base.references[0].css_width = 1440; base.references[0].dpr = 1;
  base.references[0].provenance.reasons = ["hash_equals_built_html"];
  const read = (record) => {
    record.integrity = capturesIntegrity(record);
    f.report.stages.polish.evidence.visual_review.captures = record;
    return readCurrentQcResults({ ...f, doctor: { derived: { build_output_fingerprint: { status: "pass" } } } }).results.filter((r) => r.check.startsWith("visual."));
  };
  assert.ok(read(base).every((r) => r.reason_code !== E), "rich control is valid");
  const paths = [];
  const visit = (value, path = []) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 0 && key === "integrity") continue; // always recomputed below
      const next = [...path, key]; paths.push(next); visit(child, next);
    }
  };
  visit(base);
  let mutations = 0;
  for (const path of paths) for (const replacement of [null, {}, [], 42, "invalid"]) {
    const record = structuredClone(base);
    let parent = record; for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = replacement;
    let rows;
    assert.doesNotThrow(() => { rows = read(record); }, `${path.join(".")} = ${JSON.stringify(replacement)}`);
    assert.ok(rows.length > 0, `${path.join(".")} returns rows`);
    const field = path.join(".");
    const objectField = /^(subject|environment|limits|dependencies|dependencies\.(decoder|diff)|adapters|adapters\.(build|source)|source|cells\.\d+|cells\.\d+\.(networkidle|readiness|readiness\.(fonts|await)|sections|actual|stabilized|stabilized\.treatment)|cells\.\d+\.(actual|stabilized)\.(png|crop)|cells\.\d+\.sections\.bands\.\d+|cells\.\d+\.stabilized\.treatment\.masks\.\d+(\.rects\.\d+)?|references\.\d+|references\.\d+\.(identity|verification|provenance)|comparisons\.\d+|comparisons\.\d+\.(diff_options|page|page\.canvas)|comparisons\.\d+\.(bands|artifacts|members)\.\d+|comparisons\.\d+\.bands\.\d+\.(canvas|worst_tiles\.\d+)|comparisons\.\d+\.artifacts\.\d+\.(basis_crop|build_crop|heatmap))$/.test(field);
    const arrayField = /^(cells|references|comparisons|subject\.(routes|viewports)|cells\.\d+\.sections\.(bands|duplicated_keys)|cells\.\d+\.stabilized\.treatment\.masks(\.\d+\.rects)?|references\.\d+\.provenance\.reasons|comparisons\.\d+\.(bands|artifacts|members|limits|page\.worst_tiles)|comparisons\.\d+\.bands\.\d+\.worst_tiles)$/.test(field);
    if ((objectField && (!replacement || typeof replacement !== "object" || Array.isArray(replacement)))
      || (arrayField && !Array.isArray(replacement))) {
      assert.ok(rows.every((r) => r.reason_code === E), `${field} with malformed shape refuses every record row`);
    }
    assert.ok(rows.every((r) => r.reason_code !== E || r.members.some((m) => typeof m.reason_code === "string" && m.reason_code.length > 0)), "refusals have a reason");
    mutations++;
  }
  t.diagnostic(`${paths.length} field paths × 5 replacements = ${mutations} integrity-recomputed mutations`);
});


test("F3C-R1 malformed sibling references refuse every row before artifact geometry", async (t) => {
  const f = await c3Fixture(t);
  const ref = { ...structuredClone(f.record.references[0]), viewport: "desktop", ref_id: "image", kind: "source_screenshot", css_width: 1440, dpr: 1 };
  ref.verification.png = { width_px: 1440, height_px: 1200 };
  f.record.references.push(null, ref);
  const comparison = { ...structuredClone(f.record.comparisons[0]), basis: "reference", ref_id: "image", build_shot: "actual", basis_shot: "image" };
  const image = writePolishPng(f.targetRepo, "diff", createRgbaPng(1440, 1200));
  comparison.artifacts = [{ band_key: "page", basis_crop: image, build_crop: image, heatmap: image }];
  f.record.comparisons.push(comparison);
  const rows = f.read();
  assertCapturesRefused(rows, "reference_shape_invalid");
  assert.ok(rows.some((r) => r.check === "visual.reference" && r.subject.key === "ref:image"));
});

test("F3C-R1 reader preserves reference caps while isolating malformed evidence", async (t) => {
  const f = await c3Fixture(t);
  for (let i = 0; i < 5; i++) {
    f.record.references.push({ ...structuredClone(f.record.references[0]), ref_id: `image-${i}`, viewport: "desktop", kind: "source_screenshot", css_width: 1440, dpr: 1 });
    f.record.comparisons.push({ ...structuredClone(f.record.comparisons[0]), basis: "reference", ref_id: `image-${i}`, build_shot: "actual", basis_shot: "image" });
  }
  const rows = f.read();
  assert.equal(rows.filter((r) => r.subject.key.startsWith("ref:")).length, 8);
  assert.equal(rows.some((r) => r.subject.key === "ref:image-4"), false);
  assert.ok(rows.filter((r) => r.check === "visual.reference" && r.subject.key.startsWith("ref:")).every((r) => hasMember(r, "reference_cap_reached")));
});
