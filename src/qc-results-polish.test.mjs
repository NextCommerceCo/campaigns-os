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

test("F1.0-I20 no Polish capture on the report: handoff coverage lists 1.3 unexercised (leg_not_run)", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  assert.equal(readJson(f.reportPath).stages.polish?.evidence, undefined, "precondition: no Polish capture");
  const handoff = handoffOf(await runNext(f, {}));
  const coverage = (handoff.coverage || []).filter((entry) => entry.leg === "polish");
  const tuples = [...new Set(coverage.map((entry) => JSON.stringify([entry.check, entry.result, entry.reason_code])))].map((text) => JSON.parse(text)).sort();
  assert.deepEqual(
    tuples,
    [["media.oversize", "unexercised", "leg_not_run"], ["media.weight", "unexercised", "leg_not_run"]],
    `qc_handoff.coverage lists both 1.3 checks, each unexercised / leg_not_run, and nothing else for Polish: ${JSON.stringify(handoff.coverage)}`,
  );
});
