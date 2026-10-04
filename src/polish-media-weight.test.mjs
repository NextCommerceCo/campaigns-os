// F1.3 frozen fixture rows, leg D/CLI: a stored media_weight record
// re-evaluated (contract §1.3, Frozen fixture table F1.3-B11, I9, I18, I20,
// I21, I22). The browser rows are in src/polish-media-weight.browser.test.mjs.
//
// The stored records are synthetic, package-shaped media_weight records and
// their page_load captures, built by src/qc-test-factories.mjs
// (mediaWeightFixture, twoCellFixture) and edited here the way each row's
// setup states, with every checksum recomputed. They are read with the real
// 1.3 rules: the registry's polish-media-weight.mjs through readMediaWeight,
// the 1.0 Polish reader site. No stand-in rules are passed.
//
// API assumptions (all rows): readMediaWeight returns the read results;
// media.weight subjects are keyed by the resource's resource_id and
// media.oversize subjects by "<resource_id>:<element_path>" (the 1.0
// reader's cellSubjects).
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  ORIGIN,
  ROUTES,
  VIEWPORT,
  assertAccepted,
  assertNoNetworkAttempts,
  campaignFixture,
  delay,
  handoffOf,
  installPolishEvidence,
  mediaWeightFixture,
  mutateReport,
  readJson,
  refOf,
  resourceIdOf,
  resultsOf,
  runAccept,
  runNext,
  twoCellFixture,
  withRecomputedIntegrity,
} from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const HERO = "/runtime-packet-demo/img/hero.jpg";
const HERO_KEY = resourceIdOf(`${ORIGIN}${HERO}`);
const CONTROL_KEY = resourceIdOf(`${ORIGIN}/runtime-packet-demo/img/control.jpg`);
// The factory's first <img> in a cell.
const HERO_IMAGE_KEY = `${HERO_KEY}:body>img:nth-of-type(1)`;
const CONTROL_IMAGE_KEY = `${CONTROL_KEY}:body>img:nth-of-type(1)`;
const E = "evidence_not_reproducible";

async function readReal({ record, pageLoad }, currentBuild = BUILD_FP) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const rederivers = await loadQcRederivers({ legs: ["polish"] });
  assert.equal(rederivers["media.weight"]?.status, "loaded", `the registry loads the 1.3 rules module (media.weight: ${JSON.stringify(rederivers["media.weight"])})`);
  const { readMediaWeight } = await import("./qc-results.mjs");
  const results = resultsOf(readMediaWeight({ record, pageLoad, currentBuild, rederivers }));
  assert.ok(Array.isArray(results), "readMediaWeight returns the read 1.3 results");
  return results;
}

// One expected result: [check, route, key, result, reasonCode].
const row = (check, route, key, result, reasonCode = null) => ({ check, route, key, result, reason_code: result === "pass" ? null : reasonCode });
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

// The complete members of a result, as a set (order-free); anything but an
// array is kept as is, so it fails the comparison.
const membersOf = (item) => (Array.isArray(item?.members)
  ? [...item.members].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : item?.members);

// The read results are exactly `expected`: the same ids (check:page:
// viewport:key), exact subjects, the Polish leg, each result and reason
// code, accept-eligibility (a warning is eligible, nothing else is), and the
// complete members of every result (none: no page in these records is
// capped). One missing, extra or wrong result or member fails the row.
function assertResultSet(results, expected, label) {
  const actual = results.map((item) => ({
    id: item?.id,
    leg: item?.leg,
    subject: item?.subject,
    result: item?.result,
    reason_code: item?.reason_code,
    accept_eligible: item?.accept_eligible,
    members: membersOf(item),
  })).sort(byId);
  const wanted = expected.map((item) => ({
    id: `${item.check}:${item.route}:${VIEWPORT}:${item.key}`,
    leg: "polish",
    subject: { check: item.check, page: item.route, viewport: VIEWPORT, key: item.key },
    result: item.result,
    reason_code: item.reason_code,
    accept_eligible: item.result === "warning",
    members: [],
  })).sort(byId);
  assert.deepEqual(actual, wanted, `${label}: the 1.3 results are exactly the setup's`);
}

// The untouched control cell (factory route 1: a same-origin 600,000 B
// complete image, F1.3-B2, 1200×800 shown at 1200×800, F = 1): weight
// warning, oversize pass.
const CONTROL_CELL = Object.freeze([
  row("media.weight", ROUTES[1], CONTROL_KEY, "warning", "image_over_threshold"),
  row("media.oversize", ROUTES[1], CONTROL_IMAGE_KEY, "pass"),
]);

// The handoff coverage entries this campaign fixture always carries besides
// Polish: its QA stage is the pending placeholder (leg_not_run), and its spec
// makes 1.1 and 1.4 applicable (store policy fields set, no content params).
const QA_LEG_NOT_RUN = Object.freeze(["policy.availability", "policy.presence", "tracking.order", "tracking.tag", "tracking.url"]
  .map((check) => ({ check, leg: "qa", result: "unexercised", reason_code: "leg_not_run", count: 0, pages: [] })));

// ---------------------------------------------------------------------------
// Broken rows

test("F1.3-B11 accepted F1.3-B3, stored record re-evaluated with dpr 2: accept lapsed (state_changed)", async (t) => {
  // The stored F1.3-B3 cell: 2400×1800 natural in a 300×225 `fill` box,
  // observed at DPR 1 (F = 8); the image is 300,000 B complete (weight pass).
  // At DPR 2, F = 4: still image_oversized, so only the measured state moves.
  const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 300_000 }] }] });
  Object.assign(evidence.record.cells[0].images[0], { natural: [2400, 1800], rendered: [300, 225], object_fit: "fill" });
  evidence.record = withRecomputedIntegrity(evidence.record);
  const cell = [
    row("media.weight", ROUTES[0], HERO_KEY, "pass"),
    row("media.oversize", ROUTES[0], HERO_IMAGE_KEY, "warning", "image_oversized"),
  ];
  const first = await readReal(evidence);
  assertResultSet(first, cell, "stored F1.3-B3 cell");
  const accepted = first.find((item) => item.subject.key === HERO_IMAGE_KEY);

  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, evidence, { buildFingerprint: BUILD_FP });
  await delay(5);
  assertAccepted(await runAccept(f, [refOf(accepted)]));
  const records = readJson(f.reportPath).qc_accepts;
  assert.deepEqual(records.map((record) => record.result_id), [accepted.id], "one accept recorded");
  const { assessQcAccepts } = await import("./qc-accept.mjs");

  // Director ruling K5. Control: the same cell re-stamped with a later
  // measured_at (no measured state changes) keeps the accept active, so a
  // fingerprint over the timestamp cannot produce the lapse below.
  const control = { pageLoad: evidence.pageLoad, record: withRecomputedIntegrity({ ...structuredClone(evidence.record), measured_at: new Date(Date.parse(evidence.record.measured_at) + 30_000).toISOString() }) };
  const controlResults = await readReal(control);
  assertResultSet(controlResults, cell, "control (measured_at only)");
  assert.equal(controlResults.find((item) => item.id === accepted.id).state_fingerprint, accepted.state_fingerprint, "the control keeps the accepted fingerprint");
  assert.equal(assessQcAccepts(records, controlResults, { now: new Date().toISOString() })[0].status, "active", "the accept stays active on the control");

  // The re-evaluated record differs from the accepted one in dpr alone.
  const reevaluated = { pageLoad: evidence.pageLoad, record: structuredClone(evidence.record) };
  reevaluated.record.cells[0].dpr = 2;
  reevaluated.record = withRecomputedIntegrity(reevaluated.record);
  const withoutDpr = (record) => ({ ...record, integrity: null, cells: record.cells.map(({ dpr: _dpr, ...rest }) => rest) });
  assert.deepEqual(withoutDpr(reevaluated.record), withoutDpr(evidence.record), "setup: only the cell's dpr changed");
  assert.deepEqual([evidence.record.cells[0].dpr, reevaluated.record.cells[0].dpr], [1, 2], "setup: dpr 1 → 2");
  installPolishEvidence(f, reevaluated, { buildFingerprint: BUILD_FP });
  const current = await readReal(reevaluated);
  assertResultSet(current, cell, "re-evaluated at dpr 2");
  const weightBefore = first.find((item) => item.subject.key === HERO_KEY);
  assert.equal(current.find((item) => item.subject.key === HERO_KEY).state_fingerprint, weightBefore.state_fingerprint, "the weight state, which has no dpr, is unchanged");
  const [assessment] = assessQcAccepts(records, current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "lapsed");
  assert.equal(assessment.why, "state_changed");
  const lapsed = (handoffOf(await runNext(f)).lapsed || []).filter((entry) => entry.result_id === accepted.id);
  assert.equal(lapsed.length, 1, "qc_handoff.lapsed lists the accepted result once");
  assert.equal(lapsed[0].why, "state_changed");
});

// ---------------------------------------------------------------------------
// Incomplete rows

test("F1.3-I9 report evidence from before this version (no media_weight), hidden-eager still evaluated: unexercised (not_captured_by_this_version)", async (t) => {
  // This version carries the 1.3 rules; the record is what predates them.
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const rederivers = await loadQcRederivers({ legs: ["polish"] });
  assert.equal(rederivers["media.weight"]?.status, "loaded", `this version ships the 1.3 rules module (media.weight: ${JSON.stringify(rederivers["media.weight"])})`);
  assert.equal(rederivers["media.oversize"]?.status, "loaded", "this version ships the 1.3 rules module (media.oversize)");

  const { pageLoad } = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 600_000 }] }] });
  const f = campaignFixture();
  t.after(f.cleanup);
  const report = mutateReport(f, (draft) => {
    draft.stages.assembly.build_fingerprint = BUILD_FP;
    draft.stages.polish = { ...draft.stages.polish, evidence: { visual_review: { screenshots: [], page_load: pageLoad } } };
  });
  assert.equal(Object.hasOwn(report.stages.polish.evidence.visual_review, "media_weight"), false, "setup: the evidence has no media_weight");

  assert.deepEqual(
    handoffOf(await runNext(f)).coverage,
    [
      { check: "media.oversize", leg: "polish", result: "unexercised", reason_code: "not_captured_by_this_version", count: 0, pages: [] },
      { check: "media.weight", leg: "polish", result: "unexercised", reason_code: "not_captured_by_this_version", count: 0, pages: [] },
      ...QA_LEG_NOT_RUN,
    ],
    "qc_handoff.coverage is exactly both 1.3 checks unexercised / not_captured_by_this_version plus the fixture's QA leg_not_run entries",
  );

  // Hidden-eager is still evaluated from the old page_load evidence. Literal
  // outcome for this setup (K6): the factory evidence covers one route and
  // the desktop viewport while the fixture packet plans four routes and two
  // viewports, so the existing rule judges it a stale capture.
  const { evaluateRecordedHiddenEagerMediaCheckpoint } = await import("./polish-node.mjs");
  const completed = { ...report, stages: { ...report.stages, assembly: { ...report.stages.assembly, status: "completed" } } };
  const checkpoint = evaluateRecordedHiddenEagerMediaCheckpoint({ packet: readJson(f.packetPath), report: completed, now: "2026-10-04T12:00:00.000Z" });
  assert.deepEqual(
    { scope: checkpoint.scope, status: checkpoint.status, checkpoint_status: checkpoint.checkpoint_status, code: checkpoint.code },
    { scope: "polish.hidden_eager_media", status: "blocked", checkpoint_status: "blocked", code: "polish.hidden_eager_media.capture_stale" },
    "hidden-eager evaluates the old evidence",
  );
});

test("F1.3-I18 cell whose page_load capture records one response served from cache (cache_request_count 1): all 1.3 results in the cell unexercised (capture_incomplete)", async () => {
  const { buildPolishCaptureIntegrity } = await import("./polish-capture.mjs");
  const evidence = twoCellFixture([{ path: HERO, bytes: 300_000 }]);
  const capture = evidence.pageLoad.captures[0];
  capture.resource_ledger.entries[0].cache_request_count = 1;
  capture.problems = [{ code: "cache_observed", count: 1 }];
  capture.measurement_status = "incomplete";
  capture.integrity = buildPolishCaptureIntegrity(capture);
  evidence.pageLoad.measurement = { ...evidence.pageLoad.measurement, status: "incomplete", incomplete: [{ route: ROUTES[0], viewport: VIEWPORT }] };
  const cell = evidence.record.cells[0];
  cell.page_load_integrity = capture.integrity.projection_fingerprint;
  cell.capture_status = "incomplete";
  cell.resources[0].measurement = "cached";
  evidence.record = withRecomputedIntegrity(evidence.record);

  assertResultSet(await readReal(evidence), [
    row("media.weight", ROUTES[0], HERO_KEY, "unexercised", "capture_incomplete"),
    row("media.oversize", ROUTES[0], HERO_IMAGE_KEY, "unexercised", "capture_incomplete"),
    ...CONTROL_CELL,
  ], "cached cell and control cell");
});

// Rows I20 to I22: one cell's field set outside the 1.3 record vocabulary,
// integrity recomputed. The tampered cell reads as the row states. Director
// ruling D3: the vocabulary check is a record-level reader check (contract
// :163, :169-174), so every result of the record, the untouched control
// cell's included, reads unexercised / evidence_not_reproducible.
async function vocabularyRow(edit, label) {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  edit(evidence.record.cells[0]);
  evidence.record = withRecomputedIntegrity(evidence.record);
  assertResultSet(await readReal(evidence), [
    row("media.weight", ROUTES[0], HERO_KEY, "unexercised", E),
    row("media.oversize", ROUTES[0], HERO_IMAGE_KEY, "unexercised", E),
    row("media.weight", ROUTES[1], CONTROL_KEY, "unexercised", E),
    row("media.oversize", ROUTES[1], CONTROL_IMAGE_KEY, "unexercised", E),
  ], label);
}

test("F1.3-I20 media_weight cell with capture_status \"bogus\", integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await vocabularyRow((cell) => { cell.capture_status = "bogus"; }, "capture_status bogus");
});

test("F1.3-I21 media_weight cell with probe_status \"bogus\", integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await vocabularyRow((cell) => { cell.probe_status = "bogus"; }, "probe_status bogus");
});

test("F1.3-I22 media_weight resource with measurement \"bogus\", integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await vocabularyRow((cell) => { cell.resources[0].measurement = "bogus"; }, "measurement bogus");
});
