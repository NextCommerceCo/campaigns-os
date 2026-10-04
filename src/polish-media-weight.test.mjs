// F1.3 frozen fixture rows, leg D/CLI: a stored media_weight record
// re-evaluated (contract §1.3, Frozen fixture table F1.3-B11, I1, I9, I18,
// I20, I21, I22). The browser rows are in
// src/polish-media-weight.browser.test.mjs.
//
// The stored records are synthetic, package-shaped media_weight records and
// their page_load captures, built by src/qc-test-factories.mjs
// (mediaWeightFixture, twoCellFixture) and edited here the way each row's
// setup states, with every checksum recomputed; F1.3-I1 builds its own
// through the package's page_load and media_weight builders. They are read
// with the real 1.3 rules: the registry's polish-media-weight.mjs through
// readMediaWeight, the 1.0 Polish reader site. No stand-in rules are passed.
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
  SLUG,
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

  // Control: the same cell re-stamped with a later
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

// F1.3-I1, leg D/CLI. The evidence is built the way the
// producer builds it (src/polish-node.mjs, capturePolishPageLoad): collector
// response records → buildPageLoadCapture → buildPolishPageLoadEvidence, and
// buildMediaWeightCell / buildMediaWeightRecord over the stored captures, so
// every integrity is the builders' own. The unchanged collector drops a
// response with no measured and no declared length before it reaches the
// ledger, so that one response record is written here; the ledger
// aggregation it exercises is the package's. Every assertion of the browser
// leg is kept but its stimulus and request log; the cells cover both of the
// capture plan's viewports, as the browser capture does, so the recorded
// hidden-eager checkpoint reads the capture rather than a stale one.
const I1_SHOWN = "/runtime-packet-demo/img/i1-shown.jpg";
const I1_ZERO = "/runtime-packet-demo/img/i1-zero.png";
const CONTROL = "/runtime-packet-demo/img/control.jpg";
const I1_VIEWPORTS = ["desktop", "mobile"];

// "Hidden-eager unchanged" for the F1.3-I1 setup: the outcome the existing
// rule (src/polish-page-load.mjs, evaluateHiddenEagerMediaCheckpoint) yields
// for the same capture. The row's capture is incomplete (the zero-byte
// transfer has no measured and no declared length), and the existing rule
// blocks any capture whose recomputed measurement is not complete before it
// looks at bytes (nonwaivableBlock): blocked /
// polish.hidden_eager_media.capture_incomplete, no findings. Pinned here,
// not read from a second call to the code under test.
const I1_HIDDEN_EAGER = Object.freeze({
  scope: "polish.hidden_eager_media",
  status: "blocked",
  checkpoint_status: "blocked",
  code: "polish.hidden_eager_media.capture_incomplete",
  findings: [],
});
const hiddenEagerOutcome = (checkpoint) => ({
  scope: checkpoint?.scope,
  status: checkpoint?.status,
  checkpoint_status: checkpoint?.checkpoint_status,
  code: checkpoint?.code,
  findings: checkpoint?.findings,
});

async function i1Evidence() {
  const { buildPageLoadCapture, singleResponseRecord } = await import("./polish-capture.mjs");
  const { buildPolishPageLoadEvidence } = await import("./polish-page-load.mjs");
  const { buildMediaWeightCell, buildMediaWeightRecord } = await import("./polish-media-weight.mjs");
  // One collector response record (the polish-browser.mjs projection); no
  // `bytes` leaves encoded_data_length out.
  const response = (id, path, { type = "Image", mime = "image/jpeg", bytes, ...rest } = {}) => singleResponseRecord(id, {
    url: `${ORIGIN}${path}`,
    resource_type: type,
    status: 200,
    mime_type: mime,
    ...(bytes === undefined ? {} : { encoded_data_length: bytes }),
    source_urls: [`${ORIGIN}${path}`],
    from_disk_cache: false,
    from_prefetch_cache: false,
    from_service_worker: false,
    request_served_from_cache: false,
    failed: false,
    ...rest,
  });
  const documentResponse = (route) => response(`${route}:doc`, route, { type: "Document", mime: "text/html", bytes: 4_000, is_final_main_document: true, document_context_fingerprint: `sha256:${"a".repeat(64)}` });
  const image = (path, index, geometry) => ({ current_src: `${ORIGIN}${path}`, element_path: `body>img:nth-of-type(${index})`, loading: "eager", hidden: false, object_fit: "fill", ...geometry });
  const cells = [
    {
      // The cell under test: the document, a 300,000 B complete image
      // (2400×1800 in a 300×225 fill box, F = 8) and the zero-byte image
      // whose one transfer has no measured and no declared length.
      route: ROUTES[0],
      responses: () => [
        documentResponse(ROUTES[0]),
        response("shown", I1_SHOWN, { bytes: 300_000 }),
        response("zero", I1_ZERO, { mime: "image/png" }),
      ],
      images: [
        image(I1_SHOWN, 1, { complete: true, natural: [2400, 1800], rendered: [300, 225] }),
        image(I1_ZERO, 2, { complete: false, natural: [0, 0], rendered: [40, 30] }),
      ],
    },
    {
      // The control cell (F1.3-B2): a 600,000 B complete image, 1200×800
      // shown at 1200×800.
      route: ROUTES[1],
      responses: () => [documentResponse(ROUTES[1]), response("control", CONTROL, { bytes: 600_000 })],
      images: [image(CONTROL, 1, { complete: true, natural: [1200, 800], rendered: [1200, 800] })],
    },
  ];
  const inputs = cells.flatMap(({ route, responses, images }) => I1_VIEWPORTS.map((viewport) => ({
    route,
    viewport,
    observation: { finalDocumentUrl: `${ORIGIN}${route}`, responseCollectionStatus: "complete", networkidle: { status: "settled", duration_ms: 500 }, mediaElements: [], responses: responses() },
    probe: { status: "complete", dpr: 1, images },
  })));
  const captures = inputs.map(({ route, viewport, observation }) => buildPageLoadCapture({
    buildFingerprint: BUILD_FP,
    slug: SLUG,
    requestedRoute: route,
    viewport,
    requestedDocumentUrl: observation.finalDocumentUrl,
    ...observation,
  }));
  const pageLoad = buildPolishPageLoadEvidence({ buildFingerprint: BUILD_FP, slug: SLUG, routeScope: "all", routes: ROUTES, viewports: I1_VIEWPORTS, captures });
  const record = buildMediaWeightRecord({
    pageLoad,
    cells: inputs.map((input) => buildMediaWeightCell({
      ...input,
      capture: pageLoad.captures.find((capture) => capture.subject.requested_route === input.route && capture.subject.viewport === input.viewport),
    })),
    measuredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return { pageLoad, record };
}

// assertResultSet across viewports: rows are [viewport, check, route, key,
// result, reasonCode]; the same projection, exact ids, subjects and members.
function assertI1ResultSet(results, expected, label) {
  const actual = results.map((item) => ({
    id: item?.id,
    leg: item?.leg,
    subject: item?.subject,
    result: item?.result,
    reason_code: item?.reason_code,
    accept_eligible: item?.accept_eligible,
    members: membersOf(item),
  })).sort(byId);
  const wanted = expected.map(([viewport, ...rest]) => {
    const item = row(...rest);
    return {
      id: `${item.check}:${item.route}:${viewport}:${item.key}`,
      leg: "polish",
      subject: { check: item.check, page: item.route, viewport, key: item.key },
      result: item.result,
      reason_code: item.reason_code,
      accept_eligible: item.result === "warning",
      members: [],
    };
  }).sort(byId);
  assert.deepEqual(actual, wanted, `${label}: the 1.3 results are exactly the setup's`);
}

test("F1.3-I1 one zero-byte transfer with no measured and no declared length in the cell: all 1.3 results in the cell unexercised, hidden-eager unchanged (capture_incomplete)", async (t) => {
  const evidence = await i1Evidence();
  const { pageLoad, record } = evidence;
  const captureOf = (route, viewport) => pageLoad.captures.find((capture) => capture.subject.requested_route === route && capture.subject.viewport === viewport);
  const zeroKey = resourceIdOf(`${ORIGIN}${I1_ZERO}`);
  // The route-capture/v0 projection is unchanged: no 1.3 field rides in it.
  const ROUTE_CAPTURE_KEYS = ["document_response", "integrity", "measurement_status", "media", "media_collection", "metrics", "networkidle", "performed_by", "problems", "producer_status", "resource_ledger", "response_collection", "schema_version", "subject"];
  assert.equal(pageLoad.captures.length, ROUTES.length * I1_VIEWPORTS.length, "setup: one capture per route and viewport");
  for (const viewport of I1_VIEWPORTS) {
    const [tested, control] = ROUTES.map((route) => captureOf(route, viewport));
    for (const part of [tested, control]) {
      assert.deepEqual(Object.keys(part).sort(), ROUTE_CAPTURE_KEYS, `setup (${part.subject.requested_route} ${viewport}): the page_load capture keeps exactly its route-capture/v0 fields`);
    }
    const zero = tested.resource_ledger.entries.find((entry) => entry.resource_id === zeroKey);
    assert.deepEqual(
      zero && { transferred_bytes: zero.transferred_bytes, request_count: zero.request_count, unmeasured_request_count: zero.unmeasured_request_count, declared_request_count: zero.declared_request_count, canceled_request_count: zero.canceled_request_count, failed_request_count: zero.failed_request_count },
      { transferred_bytes: 0, request_count: 1, unmeasured_request_count: 1, declared_request_count: 0, canceled_request_count: 0, failed_request_count: 0 },
      `setup (${viewport}): the ledger records the zero-byte transfer with no measured and no declared length`,
    );
    assert.deepEqual([tested.measurement_status, tested.problems], ["incomplete", [{ code: "transfer_size_unavailable", count: 1 }]], `setup (${viewport}): that capture is incomplete for that transfer alone`);
    assert.deepEqual([control.measurement_status, control.problems], ["complete", []], `setup (${viewport}): the control capture is complete`);
  }
  assert.equal(pageLoad.measurement.status, "incomplete", "setup: the page_load measurement is incomplete");
  assert.equal(Object.hasOwn(pageLoad, "media_weight"), false, "media_weight is kept out of the page_load capture");
  assert.deepEqual(record.cells.map((cell) => [cell.route, cell.viewport, cell.capture_status, cell.page_load_integrity]), ROUTES.flatMap((route, index) => I1_VIEWPORTS.map((viewport) => [
    route,
    viewport,
    index === 0 ? "incomplete" : "complete",
    captureOf(route, viewport).integrity.projection_fingerprint,
  ])), "setup: each media_weight cell is stamped with its capture's status and integrity; the cell under test is incomplete in both viewports");
  for (const cell of record.cells.filter((item) => item.route === ROUTES[0])) {
    assert.equal(cell.resources.find((resource) => resource.resource_id === zeroKey)?.measurement, "unmeasured", `setup (${cell.viewport}): the record carries the transfer as unmeasured`);
  }

  // Hidden-eager, unchanged by 1.3, read through the recorded checkpoint the
  // way the CLI reads it: from page_load alone, then with media_weight beside
  // page_load. The packet plans exactly the captured routes (the plan's
  // viewports are both of I1_VIEWPORTS).
  const { evaluateRecordedHiddenEagerMediaCheckpoint, planPolishCapture } = await import("./polish-node.mjs");
  const f = campaignFixture();
  t.after(f.cleanup);
  const fixturePacket = readJson(f.packetPath);
  const [mapping] = fixturePacket.source_html.pages;
  const packet = {
    ...fixturePacket,
    source_html: {
      ...fixturePacket.source_html,
      pages: ROUTES.map((route, index) => ({ ...mapping, page_id: `i1-${index}`, page_kit: { ...mapping.page_kit, public_route: route, spec_route: route } })),
    },
  };
  const plan = planPolishCapture({ packet, baseUrl: ORIGIN });
  assert.deepEqual([plan.route_scope, plan.routes.map((item) => item.requested_route), plan.viewports.map((item) => item.key)], ["all", ROUTES, I1_VIEWPORTS], "setup: the packet plans exactly the captured cells");
  const fixtureReport = readJson(f.reportPath);
  const now = "2026-10-04T12:00:00.000Z";
  const reportWith = (visualReview) => ({
    ...fixtureReport,
    waivers: [],
    stages: {
      ...fixtureReport.stages,
      assembly: { ...fixtureReport.stages.assembly, status: "completed", build_fingerprint: BUILD_FP },
      polish: { stage: "polish", evidence: { visual_review: visualReview } },
    },
  });
  assert.deepEqual(
    hiddenEagerOutcome(evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: reportWith({ page_load: pageLoad }), now })),
    I1_HIDDEN_EAGER,
    "polish.hidden_eager_media reads its literal outcome for this setup from page_load alone",
  );
  // The existing rule, called directly on the same capture, yields that
  // outcome too.
  const { evaluateHiddenEagerMediaCheckpoint } = await import("./polish-page-load.mjs");
  assert.deepEqual(
    hiddenEagerOutcome(evaluateHiddenEagerMediaCheckpoint({ pageLoad, buildFingerprint: BUILD_FP, slug: SLUG, routeScope: "all", routes: ROUTES, viewports: I1_VIEWPORTS, waivers: [], now })),
    I1_HIDDEN_EAGER,
    "the existing rule yields the literal outcome for this capture",
  );

  // API assumption: the zero-byte transfer is a resource of the cell (the
  // row places it "in the cell"), keyed by its resource_id; the document is
  // a resource of its cell, and its weight reads pass where the cell is
  // complete.
  const docKey = (route) => resourceIdOf(`${ORIGIN}${route}`);
  const shownKey = resourceIdOf(`${ORIGIN}${I1_SHOWN}`);
  const controlKey = resourceIdOf(`${ORIGIN}${CONTROL}`);
  assertI1ResultSet(await readReal(evidence), I1_VIEWPORTS.flatMap((viewport) => [
    [viewport, "media.weight", ROUTES[0], docKey(ROUTES[0]), "unexercised", "capture_incomplete"],
    [viewport, "media.weight", ROUTES[0], shownKey, "unexercised", "capture_incomplete"],
    [viewport, "media.weight", ROUTES[0], zeroKey, "unexercised", "capture_incomplete"],
    [viewport, "media.oversize", ROUTES[0], `${shownKey}:body>img:nth-of-type(1)`, "unexercised", "capture_incomplete"],
    [viewport, "media.oversize", ROUTES[0], `${zeroKey}:body>img:nth-of-type(2)`, "unexercised", "capture_incomplete"],
    [viewport, "media.weight", ROUTES[1], docKey(ROUTES[1]), "pass"],
    [viewport, "media.weight", ROUTES[1], controlKey, "warning", "image_over_threshold"],
    [viewport, "media.oversize", ROUTES[1], `${controlKey}:body>img:nth-of-type(1)`, "pass"],
  ]), "unmeasured cell and control cell");
  assert.deepEqual(
    hiddenEagerOutcome(evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: reportWith({ page_load: pageLoad, media_weight: record }), now })),
    I1_HIDDEN_EAGER,
    "polish.hidden_eager_media keeps its literal outcome with media_weight beside page_load",
  );
});

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
  // outcome for this setup: the factory evidence covers one route and
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
// integrity recomputed. The tampered cell reads as the row states.
// The vocabulary check is a record-level reader check (contract
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
