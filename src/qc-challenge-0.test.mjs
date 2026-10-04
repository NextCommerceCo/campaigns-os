// Regression tests for the phase-0 challenge findings on the 1.0 QC readers
// and `checkpoint accept` (contract §1.0 Inputs, Reader sites, "Polish
// media_weight reader checks", Silence, Accepts). Each test is a negative
// control for one defect class: it fails when that defect is seeded and passes
// on the real implementation. Every setup is synthetic and uses the F1.0
// factory unchanged; expected values come from the contract, never from the
// code under test.
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  OPERATOR,
  ORIGIN,
  OTHER_BUILD_FP,
  QA_RUN_ID,
  ROUTES,
  VIEWPORT,
  assertAccepted,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  delay,
  doctorOf,
  fullVerdict,
  handoffOf,
  installPolishEvidence,
  installQaStage,
  liveTokenId,
  liveTokenStandIn,
  mediaWeightFixture,
  mutateReport,
  polishStandIn,
  qaAssertionFor,
  qaObservation,
  qaRowFor,
  qaStandIns,
  readBytes,
  readJson,
  refOf,
  resourceIdOf,
  runAccept,
  runNext,
  setBuiltPage,
  snapshot,
  twoCellFixture,
  withRecomputedIntegrity,
  writeJson,
} from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const E = "evidence_not_reproducible";
const STALE = "stale_binding";
const HERO = "/runtime-packet-demo/img/hero.jpg";
const HERO_KEY = resourceIdOf(`${ORIGIN}${HERO}`);
const CONTROL_KEY = resourceIdOf(`${ORIGIN}/runtime-packet-demo/img/control.jpg`);
const POLISH_CHECKS = ["media.oversize", "media.weight"];

const clone = (value) => JSON.parse(JSON.stringify(value));
const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

async function readMw({ record, pageLoad }, currentBuild = BUILD_FP, rules = { qcStandIns: { polish: polishStandIn() } }) {
  const { readMediaWeight } = await import("./qc-results.mjs");
  const results = readMediaWeight({ record, pageLoad, currentBuild, ...rules });
  assert.ok(Array.isArray(results), "readMediaWeight returns the read 1.3 results");
  return results;
}

const onPage = (results, route) => results.filter((row) => row.subject?.page === route);
const weightRow = (results, route, key) => results.find((row) => row.check === "media.weight" && row.subject?.page === route && row.subject?.key === key);

// Every listed row reads unexercised / reasonCode and is never accept-eligible.
function assertEvery(rows, reasonCode, label) {
  assert.ok(rows.length > 0, `${label}: results are listed`);
  for (const row of rows) {
    assert.equal(row.result, "unexercised", `${label}: ${row.id} reads unexercised, never pass or warning`);
    assert.equal(row.reason_code, reasonCode, `${label}: ${row.id} reads ${reasonCode}`);
    assert.equal(row.accept_eligible, false, `${label}: ${row.id} is never accept-eligible`);
  }
}

// The untouched second cell keeps its re-derived 600,000 B warning.
function assertControlWarning(results, label) {
  const control = weightRow(results, ROUTES[1], CONTROL_KEY);
  assert.ok(control, `${label}: the control cell is listed`);
  assert.equal(control.result, "warning", `${label}: the control cell keeps its warning`);
  assert.equal(control.reason_code, "image_over_threshold");
}

// Every 1.3 check is listed on `route`, so a missing route is never silent.
function assertRouteNamed(results, route, label) {
  const checks = [...new Set(onPage(results, route).map((row) => row.check))].sort();
  assert.deepEqual(checks, POLISH_CHECKS, `${label}: both 1.3 checks are listed on ${route}: ${JSON.stringify(results.map((row) => [row.subject?.page, row.check, row.result, row.reason_code]))}`);
  assertEvery(onPage(results, route), E, `${label}: ${route}`);
}

// A capture edited in place, its integrity and the cell's binding to it
// recomputed, and the media_weight integrity recomputed: a consistent rewrite
// of every checksum, with only the edited field disagreeing.
async function rebindCapture(evidence, index, edit) {
  const { buildPolishCaptureIntegrity } = await import("./polish-capture.mjs");
  const pageLoad = clone(evidence.pageLoad);
  const record = clone(evidence.record);
  const capture = pageLoad.captures[index];
  edit(capture);
  capture.integrity = buildPolishCaptureIntegrity(capture);
  record.cells[index].page_load_integrity = capture.integrity.projection_fingerprint;
  return { pageLoad, record: withRecomputedIntegrity(record) };
}

// ---------------------------------------------------------------------------
// F1: the media_weight reader binds every identity field of the raw capture.

test("C0-F1a media_weight relabelled to the current build over a page_load capture still bound to an older build: unexercised (stale_binding), never pass, and checkpoint accept refuses it", async (t) => {
  // The challenger's setup: produced on the older build, then only the two
  // enclosing subjects relabelled to the current build and the media_weight
  // integrity recomputed. The raw capture still names the older build.
  const relabel = (bytes) => {
    const evidence = mediaWeightFixture({ buildFingerprint: OTHER_BUILD_FP, cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes }] }] });
    const pageLoad = clone(evidence.pageLoad);
    const record = clone(evidence.record);
    pageLoad.subject.build_fingerprint = BUILD_FP;
    record.subject.build_fingerprint = BUILD_FP;
    assert.equal(pageLoad.captures[0].subject.build_fingerprint, OTHER_BUILD_FP, "setup: the raw capture keeps the older build");
    return { pageLoad, record: withRecomputedIntegrity(record) };
  };

  const passing = relabel(100_000);
  assertEvery(await readMw(passing), STALE, "relabelled 100,000 B record");

  const warning = relabel(600_000);
  const rows = await readMw(warning);
  assertEvery(rows, STALE, "relabelled 600,000 B record");

  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, warning, { buildFingerprint: BUILD_FP });
  const qcStandIns = { polish: polishStandIn() };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  assert.equal((handoff.open || []).some((entry) => entry.leg === "polish"), false, "a capture bound to an older build is never open");
  assert.ok(
    (handoff.coverage || []).some((entry) => entry.leg === "polish" && entry.check === "media.weight" && entry.result === "unexercised" && entry.reason_code === STALE),
    `qc_handoff.coverage lists media.weight unexercised / stale_binding: ${JSON.stringify(handoff.coverage)}`,
  );
  const ref = refOf(weightRow(rows, ROUTES[0], HERO_KEY));
  const before = snapshot(f);
  await delay(5);
  assertRefused(await runAccept(f, [ref], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
  assert.equal(readJson(f.reportPath).qc_accepts, undefined, "zero accepts written");
});

test("C0-F1b every identity field of a page_load capture is bound: build, campaign, document route, subject field set, producer and schema", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  const untouched = await readMw(evidence);
  assert.equal(weightRow(untouched, ROUTES[0], HERO_KEY).result, "warning", "control: the untouched first cell reads its warning");
  assertControlWarning(untouched, "control");

  // Only the capture's build differs from the current build: a build mismatch.
  const olderBuild = await readMw(await rebindCapture(evidence, 0, (capture) => { capture.subject.build_fingerprint = OTHER_BUILD_FP; }));
  assertEvery(onPage(olderBuild, ROUTES[0]), STALE, "capture build_fingerprint older");
  assertControlWarning(olderBuild, "capture build_fingerprint older");
  const noBuild = await readMw(await rebindCapture(evidence, 0, (capture) => { capture.subject.build_fingerprint = null; }));
  assertEvery(onPage(noBuild, ROUTES[0]), STALE, "capture build_fingerprint absent");

  // Any other identity field that disagrees: the evidence is not reproducible.
  const edits = {
    "campaign_slug of another campaign": (capture) => { capture.subject.campaign_slug = "another-campaign"; },
    "final_document_route off the requested route": (capture) => { capture.subject.final_document_route = ROUTES[1]; },
    "an extra subject field": (capture) => { capture.subject.store = "another-store"; },
    "subject without final_document_route": (capture) => { delete capture.subject.final_document_route; },
    "performed_by agent": (capture) => { capture.performed_by = "agent"; },
    "schema_version v9": (capture) => { capture.schema_version = "campaigns-os-polish-route-capture/v9"; },
  };
  for (const [label, edit] of Object.entries(edits)) {
    const results = await readMw(await rebindCapture(evidence, 0, edit));
    assertEvery(onPage(results, ROUTES[0]), E, `capture ${label}`);
    assert.ok(weightRow(results, ROUTES[0], HERO_KEY), `capture ${label}: the cell's resource stays listed`);
    assertControlWarning(results, `capture ${label}`);
  }

  // The declared subject itself: an extra field in both subjects, or a
  // campaign slug changed in both subjects only (the captures keep theirs).
  const extra = clone(evidence);
  extra.pageLoad.subject = { ...extra.pageLoad.subject, store: "another-store" };
  extra.record = withRecomputedIntegrity({ ...extra.record, subject: { ...extra.record.subject, store: "another-store" } });
  assertEvery(await readMw(extra), E, "declared subject with an extra field");
  const slug = clone(evidence);
  slug.pageLoad.subject = { ...slug.pageLoad.subject, campaign_slug: "another-campaign" };
  slug.record = withRecomputedIntegrity({ ...slug.record, subject: { ...slug.record.subject, campaign_slug: "another-campaign" } });
  assertEvery(await readMw(slug), E, "declared campaign_slug differing from every capture");
});

test("C0-F1c a build binding that is absent, null or mismatched on either subject or a capture reads unexercised (stale_binding); any other subject mismatch reads evidence_not_reproducible", async (t) => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  const variant = (edit) => {
    const record = clone(evidence.record);
    const pageLoad = clone(evidence.pageLoad);
    edit({ record, pageLoad });
    return { record: withRecomputedIntegrity(record), pageLoad };
  };

  // No build binding on the enclosing subjects (contract: "or that has no
  // build binding"), or a build differing on one of them only.
  const stale = {
    "build_fingerprint absent from both subjects": ({ record, pageLoad }) => {
      delete record.subject.build_fingerprint;
      delete pageLoad.subject.build_fingerprint;
    },
    "build_fingerprint null on both subjects": ({ record, pageLoad }) => {
      record.subject.build_fingerprint = null;
      pageLoad.subject.build_fingerprint = null;
    },
    "build_fingerprint absent from the media_weight subject only": ({ record }) => { delete record.subject.build_fingerprint; },
    "media_weight subject on an older build": ({ record }) => { record.subject.build_fingerprint = OTHER_BUILD_FP; },
    "page_load subject on an older build": ({ pageLoad }) => { pageLoad.subject.build_fingerprint = OTHER_BUILD_FP; },
  };
  for (const [label, edit] of Object.entries(stale)) assertEvery(await readMw(variant(edit)), STALE, label);

  // A capture whose build_fingerprint field is absent: the build alone.
  const noCaptureBuild = await readMw(await rebindCapture(evidence, 0, (capture) => { delete capture.subject.build_fingerprint; }));
  assertEvery(onPage(noCaptureBuild, ROUTES[0]), STALE, "capture build_fingerprint field absent");
  assertControlWarning(noCaptureBuild, "capture build_fingerprint field absent");

  // Any other field disagreeing between the subjects is not a build mismatch.
  const other = {
    "page_load subject on another campaign": ({ pageLoad }) => { pageLoad.subject.campaign_slug = "another-campaign"; },
    "media_weight subject with route_scope selected": ({ record }) => { record.subject.route_scope = "selected"; },
    "build absent and an extra subject field": ({ record, pageLoad }) => {
      delete record.subject.build_fingerprint;
      delete pageLoad.subject.build_fingerprint;
      record.subject.store = "another-store";
      pageLoad.subject.store = "another-store";
    },
  };
  for (const [label, edit] of Object.entries(other)) assertEvery(await readMw(variant(edit)), E, label);

  // Through `next` and `checkpoint accept`: listed under coverage as
  // stale_binding, never open, and refused.
  const absent = variant(({ record, pageLoad }) => {
    delete record.subject.build_fingerprint;
    delete pageLoad.subject.build_fingerprint;
  });
  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, absent, { buildFingerprint: BUILD_FP });
  const qcStandIns = { polish: polishStandIn() };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  assert.equal((handoff.open || []).some((entry) => entry.leg === "polish"), false, "a record with no build binding is never open");
  assert.ok(
    (handoff.coverage || []).some((entry) => entry.leg === "polish" && entry.check === "media.weight" && entry.result === "unexercised" && entry.reason_code === STALE),
    `qc_handoff.coverage lists media.weight unexercised / stale_binding: ${JSON.stringify(handoff.coverage)}`,
  );
  const before = snapshot(f);
  await delay(5);
  assertRefused(await runAccept(f, [refOf(weightRow(await readMw(absent), ROUTES[0], HERO_KEY))], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
});

test("C0-F1d a derived result whose subject is not the cell it was evaluated for (viewport, page, key or field set): that cell reads unexercised (evidence_not_reproducible)", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 100_000 }]);
  const base = polishStandIn();
  // A faulty evaluator that rewrites the subjects it derives for the first
  // cell only; the second cell is evaluated faithfully.
  const relabelling = (edit) => ({
    qcStandIns: {
      polish: { ...base, evaluate: (cell, thresholds) => base.evaluate(cell, thresholds).map((item) => (cell.route === ROUTES[0] ? { ...item, subject: edit({ ...item.subject }) } : item)) },
    },
  });
  const control = await readMw(evidence, BUILD_FP, relabelling((subject) => subject));
  assert.equal(weightRow(control, ROUTES[0], HERO_KEY).result, "pass", "control: a faithful evaluator reads pass on the first cell");

  const edits = {
    "desktop measurement labelled mobile": (subject) => ({ ...subject, viewport: "mobile" }),
    "viewport dropped": ({ viewport: _dropped, ...subject }) => subject,
    "page of the other route": (subject) => ({ ...subject, page: ROUTES[1] }),
    "key of a resource the cell does not list": (subject) => ({ ...subject, key: CONTROL_KEY }),
    "an extra subject field": (subject) => ({ ...subject, build_fingerprint: BUILD_FP }),
  };
  for (const [label, edit] of Object.entries(edits)) {
    const results = await readMw(evidence, BUILD_FP, relabelling(edit));
    assert.equal(results.some((row) => row.result === "pass" && row.subject?.viewport === "mobile"), false, `${label}: no mobile pass from desktop measurements`);
    const first = results.filter((row) => !(row.subject?.page === ROUTES[1] && row.subject?.viewport === VIEWPORT && row.subject?.key === CONTROL_KEY));
    assertEvery(first, E, `${label}: the first cell`);
    assert.ok(weightRow(results, ROUTES[0], HERO_KEY), `${label}: the first cell's resource stays listed under its own subject`);
    assertControlWarning(results, label);
  }
});

// ---------------------------------------------------------------------------
// F2: every declared route and route × viewport cell is present.

test("C0-F2a a declared route with no page_load capture and no media_weight cell: every result unexercised (evidence_not_reproducible) and the route listed in handoff coverage", async (t) => {
  // The challenger's setup: the second cell and its capture deleted, both
  // subjects and the capture summary still declaring two routes, only the
  // media_weight integrity recomputed.
  const evidence = twoCellFixture([{ path: HERO, bytes: 100_000 }]);
  const record = clone(evidence.record);
  const pageLoad = clone(evidence.pageLoad);
  record.cells.pop();
  pageLoad.captures.pop();
  assert.deepEqual(record.subject.routes, ROUTES, "setup: both routes stay declared");
  const missing = { record: withRecomputedIntegrity(record), pageLoad };
  const results = await readMw(missing);
  assertEvery(results, E, "missing route");
  assert.ok(weightRow(results, ROUTES[0], HERO_KEY), "the surviving resource stays listed");
  assertRouteNamed(results, ROUTES[1], "missing route");

  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, missing, { buildFingerprint: BUILD_FP });
  const handoff = handoffOf(await runNext(f, { polish: polishStandIn() }));
  assert.equal((handoff.open || []).some((entry) => entry.leg === "polish"), false, "no Polish result is open");
  for (const check of POLISH_CHECKS) {
    assert.ok(
      (handoff.coverage || []).some((entry) => entry.leg === "polish" && entry.check === check && entry.result === "unexercised" && entry.reason_code === E && entry.pages.includes(ROUTES[1])),
      `qc_handoff.coverage lists ${check} unexercised / ${E} on ${ROUTES[1]}: ${JSON.stringify(handoff.coverage)}`,
    );
  }
});

test("C0-F2b every declared-vs-present set: declared grid vs captures, declared grid vs cells, and the capture summary's counts and lists", async () => {
  const evidence = twoCellFixture([{ path: HERO, bytes: 100_000 }]);
  const untouched = await readMw(evidence);
  assert.equal(weightRow(untouched, ROUTES[0], HERO_KEY).result, "pass", "control: the untouched first cell reads pass");

  const variant = (edit) => {
    const record = clone(evidence.record);
    const pageLoad = clone(evidence.pageLoad);
    edit({ record, pageLoad });
    return { record: withRecomputedIntegrity(record), pageLoad };
  };
  const cases = {
    "capture dropped, cell kept": [({ pageLoad }) => { pageLoad.captures.pop(); }, ROUTES[1]],
    "cell dropped, capture kept": [({ record }) => { record.cells.pop(); }, ROUTES[1]],
    "capture and cell dropped, summary counts lowered to match": [({ record, pageLoad }) => {
      record.cells.pop();
      pageLoad.captures.pop();
      pageLoad.measurement.expected_capture_count = 1;
      pageLoad.measurement.captured_count = 1;
    }, ROUTES[1]],
    "capture and cell dropped, summary lists the route missing": [({ record, pageLoad }) => {
      record.cells.pop();
      pageLoad.captures.pop();
      pageLoad.measurement.captured_count = 1;
      pageLoad.measurement.missing = [{ route: ROUTES[1], viewport: VIEWPORT }];
    }, ROUTES[1]],
    "summary expected_capture_count differs from the declared grid": [({ pageLoad }) => { pageLoad.measurement.expected_capture_count = 3; }, null],
    "summary captured_count differs from the captures": [({ pageLoad }) => { pageLoad.measurement.captured_count = 1; }, null],
    "summary lists a duplicate": [({ pageLoad }) => { pageLoad.measurement.duplicate = [{ route: ROUTES[0], viewport: VIEWPORT }]; }, null],
    "summary lists an unexpected capture": [({ pageLoad }) => { pageLoad.measurement.unexpected = [{ route: "/runtime-packet-demo/thanks/", viewport: VIEWPORT }]; }, null],
    "summary calls an undeclared cell incomplete": [({ pageLoad }) => { pageLoad.measurement.incomplete = [{ route: ROUTES[0], viewport: "mobile", problem_codes: [] }]; }, null],
    "summary absent": [({ pageLoad }) => { delete pageLoad.measurement; }, null],
  };
  for (const [label, [edit, namedRoute]] of Object.entries(cases)) {
    const results = await readMw(variant(edit));
    assertEvery(results, E, label);
    assert.ok(weightRow(results, ROUTES[0], HERO_KEY), `${label}: the first cell's resource stays listed`);
    if (namedRoute) assertRouteNamed(results, namedRoute, label);
  }

  // A declared viewport no capture or cell covers: both subjects declare a
  // second viewport, and the summary expects the four cells.
  const mobile = variant(({ record, pageLoad }) => {
    record.subject.viewports = [VIEWPORT, "mobile"];
    pageLoad.subject.viewports = [VIEWPORT, "mobile"];
    pageLoad.measurement.expected_capture_count = 4;
  });
  const mobileResults = await readMw(mobile);
  assertEvery(mobileResults, E, "declared viewport never captured");
  for (const route of ROUTES) {
    const rows = mobileResults.filter((row) => row.subject?.page === route && row.subject?.viewport === "mobile");
    assert.deepEqual([...new Set(rows.map((row) => row.check))].sort(), POLISH_CHECKS, `declared viewport never captured: both 1.3 checks listed on ${route} mobile`);
  }
});

test("C0-F2c a declared cell that lists no resource, image or video and is missing or unreproducible is never silent, on every failure path", async (t) => {
  // The second route's cell is listed and empty: nothing to weigh on it.
  const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 100_000 }] }, { route: ROUTES[1], resources: [] }] });
  assert.deepEqual(evidence.record.cells[1].resources, [], "setup: the second cell lists no resource");
  const untouched = await readMw(evidence);
  assert.equal(weightRow(untouched, ROUTES[0], HERO_KEY).result, "pass", "control: the first cell reads pass");
  assert.deepEqual(onPage(untouched, ROUTES[1]), [], "control: a reproducible empty cell yields no result");

  const variant = (edit) => {
    const record = clone(evidence.record);
    const pageLoad = clone(evidence.pageLoad);
    edit({ record, pageLoad });
    return { record: withRecomputedIntegrity(record), pageLoad };
  };

  // Record-level failures: the empty cell's capture missing (the reviewer's
  // setup), and the 1.3 rules module failing to load.
  const missing = variant(({ pageLoad }) => { pageLoad.captures.pop(); });
  const missingResults = await readMw(missing);
  assertEvery(missingResults, E, "empty cell, capture missing");
  assertRouteNamed(missingResults, ROUTES[1], "empty cell, capture missing");
  const rulesFailed = await readMw(evidence, BUILD_FP, { rederivers: { "media.weight": { status: "failed" } } });
  assertEvery(rulesFailed, E, "1.3 rules failed to load");
  assertRouteNamed(rulesFailed, ROUTES[1], "1.3 rules failed to load");

  // Cell-level failures: the capture's identity, the cell's binding to its
  // capture, and the evaluator. The first cell keeps its pass.
  const cellFailures = {
    "empty cell's capture on another campaign": await rebindCapture(evidence, 1, (capture) => { capture.subject.campaign_slug = "another-campaign"; }),
    "empty cell bound to another capture projection": variant(({ record }) => { record.cells[1].page_load_integrity = `sha256:${"0".repeat(64)}`; }),
  };
  const throwing = polishStandIn();
  const throwOnSecond = { qcStandIns: { polish: { ...throwing, evaluate: (cell, thresholds) => { if (cell.route === ROUTES[1]) throw new Error("synthetic"); return throwing.evaluate(cell, thresholds); } } } };
  for (const [label, results] of [
    ...await Promise.all(Object.entries(cellFailures).map(async ([label, input]) => [label, await readMw(input)])),
    ["evaluator throws on the empty cell", await readMw(evidence, BUILD_FP, throwOnSecond)],
  ]) {
    assertRouteNamed(results, ROUTES[1], label);
    assert.equal(weightRow(results, ROUTES[0], HERO_KEY).result, "pass", `${label}: the first cell keeps its pass`);
  }

  // Through `next`: both 1.3 checks name the missing route in coverage.
  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, missing, { buildFingerprint: BUILD_FP });
  const handoff = handoffOf(await runNext(f, { polish: polishStandIn() }));
  for (const check of POLISH_CHECKS) {
    assert.ok(
      (handoff.coverage || []).some((entry) => entry.leg === "polish" && entry.check === check && entry.result === "unexercised" && entry.reason_code === E && entry.pages.includes(ROUTES[1])),
      `qc_handoff.coverage lists ${check} unexercised / ${E} on ${ROUTES[1]}: ${JSON.stringify(handoff.coverage)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (a) QA: a row's observation equals its paired assertion's observation.

test("C0-a a QA row whose observation differs from its paired assertion's evidence.qc.observation, every other field re-deriving: unexercised (evidence_not_reproducible), and checkpoint accept refuses it", async (t) => {
  const { readQaResults } = await import("./qc-results.mjs");
  const measuredAt = new Date(Date.now() - 60_000).toISOString();
  const observation = qaObservation({ outcome: "unreachable" });
  const read = (row, assertion) => readQaResults({
    stageEvidence: { qc_results: [row], qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: [assertion], measuredAt }),
    currentBuild: BUILD_FP,
    qcStandIns: { qa: qaStandIns() },
  });
  const row = qaRowFor(observation, { measured_at: measuredAt });
  const assertion = qaAssertionFor(row);
  const [control] = read(row, assertion);
  assert.equal(control.result, "warning", "control: the untouched row reads its warning");
  assert.equal(control.accept_eligible, true);

  // Only the row's observation edited; its result, subject, fingerprint and
  // the paired assertion all still re-derive from the assertion's observation.
  const edits = {
    "outcome rewritten": { ...observation, outcome: "reachable" },
    "an extra field": { ...observation, note: "edited" },
    "emptied": {},
  };
  for (const [label, edited] of Object.entries(edits)) {
    const [result] = read({ ...row, observation: edited }, assertion);
    assert.equal(result.result, "unexercised", `row observation ${label}: reads unexercised, not ${result.result}`);
    assert.equal(result.reason_code, E, `row observation ${label}: reads ${E}`);
    assert.equal(result.accept_eligible, false);
  }

  const f = campaignFixture();
  t.after(f.cleanup);
  const installed = installQaStage(f, { observations: [observation], measuredAt });
  mutateReport(f, (report) => {
    report.stages.qa.evidence.qc_results[0].observation = { ...observation, outcome: "reachable" };
  });
  const qcStandIns = { qa: qaStandIns() };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  assert.equal((handoff.open || []).some((entry) => entry.leg === "qa"), false, "the edited row is never open");
  const before = snapshot(f);
  await delay(5);
  assertRefused(await runAccept(f, [refOf(installed.rows[0])], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
});

// ---------------------------------------------------------------------------
// (d) checkpoint accept: measured_at strictly before the command clock.

test("C0-d checkpoint accept refuses a measurement that is not strictly before the command clock, on every leg (no_persisted_finding)", async (t) => {
  const { planQcAccepts, parseQcResultRef } = await import("./qc-accept.mjs");
  const attribution = { reason: "known synthetic", accepted_by: OPERATOR };

  // Equal and later times, against a fixed command clock, on every leg. The
  // doctor leg's time is the persisted sidecar row's.
  const now = "2026-10-04T10:00:00.000Z";
  for (const leg of ["doctor", "polish", "qa"]) {
    for (const [label, measured] of [["equal to", now], ["after", "2026-10-04T10:00:01.000Z"]]) {
      const f = campaignFixture();
      t.after(f.cleanup);
      const row = { ...qaRowFor(qaObservation(), { measured_at: measured }), leg };
      if (leg === "doctor") writeJson(f.sidecarPath, { schema_version: "campaigns-os-doctor-output/v0", generated_by: "next", derived: { qc_results: [row] } });
      assert.throws(
        () => planQcAccepts({ refs: [parseQcResultRef(refOf(row))], results: [row], sidecarPath: f.sidecarPath, now, attribution: { ...attribution, accepted_at: now } }),
        (error) => error.code === "no_persisted_finding",
        `${leg}: measured_at ${label} the command clock is refused with no_persisted_finding`,
      );
    }
  }

  // The real command, with a measurement recorded in the future, per leg.
  const qcStandInsFor = (f) => ({ doctor: [liveTokenStandIn(f)], qa: qaStandIns(), polish: polishStandIn() });
  const future = minutesFromNow(60);

  const qa = campaignFixture();
  t.after(qa.cleanup);
  const installed = installQaStage(qa, { observations: [qaObservation({ outcome: "unreachable" })], measuredAt: future });
  let before = snapshot(qa);
  assertRefused(await runAccept(qa, [refOf(installed.rows[0])], { qcStandIns: qcStandInsFor(qa) }), "no_persisted_finding");
  assertNothingWritten(qa, before);

  const polish = campaignFixture();
  t.after(polish.cleanup);
  const evidence = mediaWeightFixture({ measuredAt: future, cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 600_000 }] }] });
  installPolishEvidence(polish, evidence, { buildFingerprint: BUILD_FP });
  const polishRow = weightRow(await readMw(evidence), ROUTES[0], HERO_KEY);
  assert.equal(polishRow.result, "warning", "setup: the future-measured Polish row reads a warning");
  before = snapshot(polish);
  assertRefused(await runAccept(polish, [refOf(polishRow)], { qcStandIns: qcStandInsFor(polish) }), "no_persisted_finding");
  assertNothingWritten(polish, before);

  const doctor = campaignFixture();
  t.after(doctor.cleanup);
  setBuiltPage(doctor, '<p class="cart-line">{item.name}</p>');
  await runNext(doctor, qcStandInsFor(doctor));
  const sidecar = readJson(doctor.sidecarPath);
  const persisted = sidecar.derived.qc_results.find((row) => row.id === liveTokenId("{item.name}"));
  assert.ok(persisted, "setup: next persisted the doctor warning");
  persisted.measured_at = future;
  writeJson(doctor.sidecarPath, sidecar);
  before = snapshot(doctor);
  assertRefused(await runAccept(doctor, [refOf(persisted)], { qcStandIns: qcStandInsFor(doctor) }), "no_persisted_finding");
  assertNothingWritten(doctor, before);
});

// ---------------------------------------------------------------------------
// (e) an active accept changes only the disposition.

test("C0-e active accepts on a doctor, a Polish and a QA warning change no result value, doctor status, next status, QA disposition or stage status", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { readCurrentQcResults } = await import("./qc-results.mjs");
  const f = campaignFixture();
  t.after(f.cleanup);
  setBuiltPage(f, '<p class="cart-line">{item.name}</p>');
  const installed = installQaStage(f, { observations: [qaObservation({ outcome: "unreachable" })] });
  installPolishEvidence(f, mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 600_000 }] }] }), { buildFingerprint: BUILD_FP });
  const qcStandIns = { doctor: [liveTokenStandIn(f)], qa: qaStandIns(), polish: polishStandIn() };

  const observe = async () => {
    const next = await runNext(f, qcStandIns);
    const doctor = doctorOf(f.packetPath, { qcStandIns });
    const report = readJson(f.reportPath);
    const verdict = readJson(installed.verdictPath);
    const results = readCurrentQcResults({ report, doctor, targetRepo: f.targetRepo, packetPath: f.packetPath, reportPath: f.reportPath, qcStandIns }).results;
    const snapshotOfResults = clone(results);
    const assessed = assessQcAccepts(report.qc_accepts, results, { now: new Date().toISOString() });
    return {
      next,
      handoff: handoffOf(next),
      doctor,
      report,
      verdict,
      verdictBytes: readBytes(installed.verdictPath),
      sidecarBytes: readBytes(f.qaSidecarPath),
      results,
      snapshotOfResults,
      assessed,
    };
  };

  const before = await observe();
  const open = (before.handoff.open || []).flatMap((group) => group.results || [group]);
  const targets = ["doctor", "polish", "qa"].map((leg) => open.find((entry) => entry.leg === leg && entry.result === "warning" && entry.accept_eligible));
  assert.ok(targets.every(Boolean), `setup: one accept-eligible open warning per leg: ${JSON.stringify(open)}`);
  await delay(5);
  assertAccepted(await runAccept(f, targets.map((entry) => entry.result_ref), { qcStandIns }));
  const afterAccept = await observe();

  // Every accept is active and applied.
  assert.equal(afterAccept.report.qc_accepts.length, 3);
  assert.deepEqual(afterAccept.assessed.map((entry) => [entry.status, entry.applied]), [["active", true], ["active", true], ["active", true]]);

  // The result value of every current result, before and after assessing the
  // accepts: identical to the reading without accepts.
  assert.deepEqual(afterAccept.results, afterAccept.snapshotOfResults, "assessing the accepts leaves every current result untouched");
  const valueOf = (rows) => rows.map((row) => [row.id, row.result, row.reason_code, row.accept_eligible, row.state_fingerprint, row.members]).sort();
  assert.deepEqual(valueOf(afterAccept.results), valueOf(before.results), "every result value is the same with and without the accepts");

  // The handoff moves each target from open to accepted, with the same
  // result, reason, eligibility and members.
  for (const target of targets) {
    const accepted = (afterAccept.handoff.accepted || []).find((entry) => entry.result_ref === target.result_ref);
    assert.ok(accepted, `${target.result_ref} is listed as accepted`);
    for (const field of ["result", "reason_code", "accept_eligible", "members", "check", "leg", "page"]) {
      assert.deepEqual(accepted[field], target[field], `${target.result_ref}: accepted ${field} equals the open ${field}`);
    }
    assert.equal(accepted.result, "warning", `${target.result_ref} stays a warning`);
  }

  // Readiness and every status are unchanged.
  assert.equal(afterAccept.doctor.status, before.doctor.status, "doctor status unchanged");
  assert.deepEqual(afterAccept.doctor.warnings.map((issue) => issue.code).sort(), before.doctor.warnings.map((issue) => issue.code).sort(), "doctor warnings unchanged");
  assert.equal(afterAccept.next.status, before.next.status, "next status unchanged");
  assert.equal(afterAccept.verdict.disposition, before.verdict.disposition, "QA disposition unchanged");
  assert.ok(afterAccept.verdictBytes.equals(before.verdictBytes), "the full QA verdict is byte-for-byte unchanged");
  assert.ok(afterAccept.sidecarBytes.equals(before.sidecarBytes), "the committed QA sidecar is byte-for-byte unchanged");
  for (const stage of ["qa", "polish", "assembly"]) {
    assert.equal(afterAccept.report.stages[stage]?.status, before.report.stages[stage]?.status, `${stage} stage status unchanged`);
  }
  assert.deepEqual(afterAccept.report.stages.qa.evidence, before.report.stages.qa.evidence, "QA stage evidence unchanged");
  assert.deepEqual(afterAccept.report.stages.polish.evidence, before.report.stages.polish.evidence, "Polish stage evidence unchanged");
});
