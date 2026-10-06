// The F1.0 rows that name 1.3 as producer (F1.0-B9, B20 to B22, B26 to
// B35, B40, I8), end to end with the real producer. The earlier versions in
// src/qc-results-polish.test.mjs and src/qc-accept.test.mjs read stand-in
// records with stand-in rules; here the media_weight record and its page_load
// capture come from a real Polish page-load capture in Chromium against
// loopback stub origins, and the reader uses the registry's real 1.3 rules.
// F1.0-B23, B24 and B25 lie inside the B20 to B35 range
// but are not 1.3-producer rows (their setups are doctor sidecar and QA
// verdict evidence), so they are not re-run here.
//
// One shared capture covers the setups the rows name, one route each (two
// viewports, so two cells per route):
//   pl-hero      same-origin 600,000 B complete image (F1.3-B2)
//   pl-lower     same-origin image canceled at a 300,000 B lower bound
//                (F1.0-B27; Chrome reports it in its coarse step, D2)
//   pl-reset     same-origin image whose connection is reset (failed request;
//                the page_load capture is incomplete)
//   pl-900k      same-origin 900,000 B complete image
//   pl-redirect  other-origin URL 302s via /hop?v=1 to a same-origin
//                600,000 B image (F1.3-B4)
//   pl-video     same-origin <video preload="none">, never fetched
// Each row edits a deep copy. "That cell" is the route's desktop cell. Every
// other cell must read exactly its literal expectation (UNTOUCHED, derived
// from the setup, never from a first read).
//
// API assumptions: as in the harness (capture, readResults, subject keys and
// element paths). A cell the reader fails lists one result per subject the
// cell lists (one media.weight per resources[] entry, the document's
// included, and per unfetched <video>; one media.oversize per <img>) and, for
// a check with no subject, one result keyed "cell" (the 1.0 reader's
// failCell).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  NO_IMAGE_KEY,
  VIEWPORTS,
  assertLedgerLowerBound,
  assertRecordLowerBound,
  assertRequestLog,
  assertResultSet,
  bothCells,
  browserTest,
  browserUnavailableNote,
  capture,
  cellResults,
  connectionReset,
  imgPath,
  ledgerEntry,
  mediaWeightCell,
  oversizeKey,
  page,
  pageLoadCapture,
  pngWire,
  readResults,
  recordOf,
  recordResource,
  redirect,
  requests,
  respond,
  resultRow,
  rid,
  route,
  stalled,
  stubOrigin,
} from "./polish-media-weight-harness.browser.test.mjs";
import {
  assertAccepted,
  assertNoNetworkAttempts,
  campaignFixture,
  delay,
  handoffOf,
  installPolishEvidence,
  readJson,
  refOf,
  runAccept,
  runCli,
  runNext,
  withRecomputedIntegrity,
  writeSitePage,
} from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());
if (browserUnavailableNote) test.skip(browserUnavailableNote, () => {});

const E = "evidence_not_reproducible";
const NEWER_BUILD_FP = `sha256:${createHash("sha256").update("synthetic build two").digest("hex")}`;
const ROUTES = Object.freeze(["pl-900k", "pl-hero", "pl-lower", "pl-redirect", "pl-reset", "pl-video"]);
const FIRST_IMG = imgPath(1);

// The handoff coverage entries the campaign fixture always carries besides
// Polish: its QA stage is the pending placeholder (leg_not_run), and its spec
// makes 1.1 and 1.4 applicable (store policy fields set, no content params).
const QA_LEG_NOT_RUN = Object.freeze(["policy.availability", "policy.presence", "tracking.order", "tracking.tag", "tracking.url"]
  .map((check) => ({ check, leg: "qa", result: "unexercised", reason_code: "leg_not_run", count: 0, pages: [] })));

// ---------------------------------------------------------------------------
// The shared capture

let servers = null;
let shared = null;
after(async () => {
  if (!servers) return;
  await servers.same.close();
  await servers.other.close();
});

// Every URL a row reads, by route.
function urlsOf(same, other) {
  return {
    hero: same.url("/img/pl-hero.png"),
    lower: same.url("/img/pl-lower.png"),
    reset: same.url("/img/pl-reset.png"),
    big: same.url("/img/pl-900k.png"),
    requested: other.url("/img/pl-b4.png"),
    hop: other.url("/hop?v=1"),
    final: same.url("/img/pl-b4.png"),
    video: same.url("/media/pl.mp4"),
    documentOf: (name) => same.url(route(name)),
    otherOrigin: other.origin,
  };
}

// The complete request log of the shared capture: each document and each
// fetched image once per cell; the preload="none" video never.
const SHARED_LOG = Object.freeze({
  same: requests([...ROUTES.map(route), "/img/pl-hero.png", "/img/pl-lower.png", "/img/pl-reset.png", "/img/pl-900k.png", "/img/pl-b4.png"]),
  other: requests(["/img/pl-b4.png", "/hop?v=1"]),
});

// Per route: the cell's weight subjects (every resource, the document
// included, and every unfetched video) and oversize subjects (every <img>,
// or "cell" for a cell with none), keyed as the reader lists them.
function subjectsOf(urls) {
  const doc = (name) => rid(urls.documentOf(name));
  const image = (url) => [oversizeKey(rid(url), FIRST_IMG)];
  return {
    "pl-900k": { weight: [doc("pl-900k"), rid(urls.big)], oversize: image(urls.big) },
    "pl-hero": { weight: [doc("pl-hero"), rid(urls.hero)], oversize: image(urls.hero) },
    "pl-lower": { weight: [doc("pl-lower"), rid(urls.lower)], oversize: image(urls.lower) },
    "pl-redirect": { weight: [doc("pl-redirect"), rid(urls.requested)], oversize: image(urls.requested) },
    "pl-reset": { weight: [doc("pl-reset"), rid(urls.reset)], oversize: image(urls.reset) },
    "pl-video": { weight: [doc("pl-video"), "video:0"], oversize: [NO_IMAGE_KEY] },
  };
}

// What every untampered cell reads, from its setup.
// [weight results], [oversize results], each [result, reasonCode] in the
// order of subjectsOf. The 40×30 images are under the 250,000 px area floor
// (oversize pass once loaded); the document is a small complete same-origin
// resource (pass). pl-lower: a lower bound under 500,000 B with no declared
// length (transfer_partial), never loaded (not_loaded). pl-reset: every
// result of its incomplete cell, the failed image's included, reads
// capture_incomplete (F1.3-I17;
// src/polish-media-weight.browser.test.mjs carries the same literals).
const UNTOUCHED = Object.freeze({
  "pl-900k": [[["pass"], ["warning", "image_over_threshold"]], [["pass"]]],
  "pl-hero": [[["pass"], ["warning", "image_over_threshold"]], [["pass"]]],
  "pl-lower": [[["pass"], ["unexercised", "transfer_partial"]], [["unexercised", "not_loaded"]]],
  "pl-redirect": [[["pass"], ["warning", "image_over_threshold"]], [["pass"]]],
  "pl-reset": [[["unexercised", "capture_incomplete"], ["unexercised", "capture_incomplete"]], [["unexercised", "capture_incomplete"]]],
  "pl-video": [[["pass"], ["unexercised", "not_loaded"]], [["pass"]]],
});

// One cell's expected results: `values(check, index)` gives [result,
// reasonCode] for each subject.
function cellOf(subjects, name, viewport, values) {
  return cellResults(route(name), viewport, {
    weight: subjects[name].weight.map((key, index) => [key, ...values("media.weight", index)]),
    oversize: subjects[name].oversize.map((key, index) => [key, ...values("media.oversize", index)]),
  });
}
const untouchedCell = (subjects, name, viewport) => cellOf(subjects, name, viewport, (check, index) => UNTOUCHED[name][check === "media.weight" ? 0 : 1][index]);
const failedCell = (subjects, name, viewport, reason = E) => cellOf(subjects, name, viewport, () => ["unexercised", reason]);
const allCells = () => ROUTES.flatMap((name) => VIEWPORTS.map((viewport) => [name, viewport]));

async function sharedCapture() {
  shared ??= (async () => {
    servers = { same: await stubOrigin(), other: await stubOrigin() };
    const { same, other } = servers;
    const urls = urlsOf(same, other);
    const image = (src) => page(`<img alt="" src="${src}" width="40" height="30">`);
    same.serve(route("pl-hero"), image("/img/pl-hero.png"));
    same.serve("/img/pl-hero.png", pngWire(40, 30, 600_000));
    same.serve(route("pl-lower"), image("/img/pl-lower.png"));
    same.serve("/img/pl-lower.png", stalled({ sendBytes: 300_000 }));
    same.serve(route("pl-reset"), image("/img/pl-reset.png"));
    same.serve("/img/pl-reset.png", connectionReset());
    same.serve(route("pl-900k"), image("/img/pl-900k.png"));
    same.serve("/img/pl-900k.png", pngWire(40, 30, 900_000));
    same.serve(route("pl-redirect"), image(urls.requested));
    other.serve("/img/pl-b4.png", redirect(urls.hop));
    other.serve("/hop?v=1", redirect(urls.final));
    same.serve("/img/pl-b4.png", pngWire(40, 30, 600_000));
    same.serve(route("pl-video"), page(`<video src="/media/pl.mp4" preload="none" width="320" height="180"></video>`));
    same.serve("/media/pl.mp4", respond("200 OK", "video/mp4", Buffer.alloc(4_096, 7)));
    const output = await capture(same, { routes: ROUTES });
    const log = { same: same.takeLog(), other: other.takeLog() };
    return { output, urls, log, subjects: subjectsOf(urls) };
  })();
  return shared;
}

// The setups held in the page_load capture (checked before the record), and
// the shared capture's complete request log.
function assertSharedSetup({ output, urls, log }) {
  assert.deepEqual(log, SHARED_LOG, "setup: the origins received exactly the requests the setups imply, nothing more");
  const part = (name, viewport) => pageLoadCapture(output.page_load, route(name), viewport);
  for (const viewport of VIEWPORTS) {
    const label = (name) => `setup (${name} ${viewport})`;
    const ledger = (name, list) => assert.deepEqual(part(name, viewport).resource_ledger.entries.map((entry) => entry.resource_id).sort(), [urls.documentOf(name), ...list].map(rid).sort(), `${label(name)}: the ledger lists exactly the document and the setup's transfers`);
    ledger("pl-hero", [urls.hero]);
    ledger("pl-lower", [urls.lower]);
    ledger("pl-reset", [urls.reset]);
    ledger("pl-900k", [urls.big]);
    ledger("pl-redirect", [urls.requested, urls.hop, urls.final]);
    ledger("pl-video", []);
    assert.equal(ledgerEntry(part("pl-hero", viewport), urls.hero)?.transferred_bytes, 600_000, `${label("pl-hero")}: 600,000 B complete`);
    const lower = ledgerEntry(part("pl-lower", viewport), urls.lower);
    assert.equal(lower?.declared_request_count, 0, `${label("pl-lower")}: no declared length`);
    assertLedgerLowerBound(lower, "under", label("pl-lower"));
    assert.equal(ledgerEntry(part("pl-reset", viewport), urls.reset)?.failed_request_count, 1, `${label("pl-reset")}: failed_request_count 1`);
    assert.equal(part("pl-reset", viewport).measurement_status, "incomplete", `${label("pl-reset")}: the capture is incomplete`);
    assert.equal(ledgerEntry(part("pl-900k", viewport), urls.big)?.transferred_bytes, 900_000, `${label("pl-900k")}: 900,000 B complete`);
    assert.deepEqual(ledgerEntry(part("pl-redirect", viewport), urls.requested)?.statuses, [302], `${label("pl-redirect")}: the first hop 302s`);
    assert.equal(ledgerEntry(part("pl-redirect", viewport), urls.final)?.transferred_bytes, 600_000, `${label("pl-redirect")}: the final image is 600,000 B`);
    for (const name of ["pl-hero", "pl-lower", "pl-900k", "pl-redirect", "pl-video"]) {
      assert.equal(part(name, viewport).measurement_status, "complete", `${label(name)}: the capture is complete`);
    }
  }
}

// A deep copy of the shared evidence, after its setup and record are checked
// and the untampered record reads exactly UNTOUCHED.
async function evidence() {
  const state = await sharedCapture();
  assertSharedSetup(state);
  recordOf(state.output);
  if (!state.untouchedChecked) {
    assertResultSet(await readResults(state.output), allCells().flatMap(([name, viewport]) => untouchedCell(state.subjects, name, viewport)), "the untampered record");
    state.untouchedChecked = true;
  }
  return {
    ...state,
    copy: () => ({ page_load: structuredClone(state.output.page_load), media_weight: structuredClone(state.output.media_weight) }),
  };
}

// Cell level: the tampered cell fails; every other cell reads its literal.
function assertOnlyCellFailed(results, { subjects }, name) {
  assertResultSet(results, allCells().flatMap(([other, viewport]) => (other === name && viewport === "desktop"
    ? failedCell(subjects, other, viewport)
    : untouchedCell(subjects, other, viewport))), `only ${route(name)} desktop fails`);
}

// Record level: every cell of the record fails, and no other page is listed.
function assertRecordFailed(results, { subjects }) {
  assertResultSet(results, allCells().flatMap(([name, viewport]) => failedCell(subjects, name, viewport)), "every cell fails");
}

async function tamperCell(name, edit) {
  const state = await evidence();
  const tampered = state.copy();
  const cell = mediaWeightCell(tampered.media_weight, route(name), "desktop");
  edit(cell, state, tampered);
  tampered.media_weight = withRecomputedIntegrity(tampered.media_weight);
  assertOnlyCellFailed(await readResults(tampered), state, name);
}

async function tamperRecord(edit, { recompute = true } = {}) {
  const state = await evidence();
  const tampered = state.copy();
  edit(tampered.media_weight, state, tampered);
  if (recompute) tampered.media_weight = withRecomputedIntegrity(tampered.media_weight);
  assertRecordFailed(await readResults(tampered), state);
}

// ---------------------------------------------------------------------------
// Broken rows

browserTest("F1.0-B9 [real: 1.3] accepted F1.3-B2, then record build records a new build fingerprint: accept lapsed (stale_binding)", async (t) => {
  const f = campaignFixture({ setupCompleted: true, site: true });
  t.after(f.cleanup);
  const first = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(first.exitCode, 0, first.error?.message);
  const buildOne = readJson(f.reportPath).stages.assembly.build_fingerprint;

  const same = await stubOrigin();
  t.after(() => same.close());
  same.serve(route("pl-b9"), page(`<img alt="" src="/img/pl-b9.png" width="40" height="30">`));
  same.serve("/img/pl-b9.png", pngWire(40, 30, 600_000));
  const output = await capture(same, { routes: ["pl-b9"], build: buildOne });
  assertRequestLog({ same }, { same: requests([route("pl-b9"), "/img/pl-b9.png"]) }, "setup");
  const url = same.url("/img/pl-b9.png");
  assert.equal(ledgerEntry(pageLoadCapture(output.page_load, route("pl-b9"), "desktop"), url)?.transferred_bytes, 600_000, "setup: F1.3-B2, 600,000 B complete");
  recordOf(output);
  installPolishEvidence(f, { pageLoad: output.page_load, record: output.media_weight });
  const keys = { weight: [rid(same.url(route("pl-b9"))), rid(url)], oversize: [oversizeKey(rid(url), FIRST_IMG)] };
  const firstRead = await readResults(output, { currentBuild: buildOne });
  assertResultSet(firstRead, bothCells(route("pl-b9"), {
    weight: [[keys.weight[0], "pass"], [keys.weight[1], "warning", "image_over_threshold"]],
    oversize: [[keys.oversize[0], "pass"]],
  }), "first build");
  const warning = resultRow(firstRead, "media.weight", route("pl-b9"), "desktop", rid(url));
  await delay(5);
  assertAccepted(await runAccept(f, [refOf(warning)]));

  writeSitePage(f, "<p>synthetic build two</p>");
  const second = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(second.exitCode, 0, second.error?.message);
  const report = readJson(f.reportPath);
  const buildTwo = report.stages.assembly.build_fingerprint;
  assert.notEqual(buildTwo, buildOne, "record build recorded a new build fingerprint");
  const visual = report.stages.polish.evidence.visual_review;
  const current = await readResults({ media_weight: visual.media_weight, page_load: visual.page_load }, { currentBuild: buildTwo });
  assertResultSet(current, bothCells(route("pl-b9"), {
    weight: keys.weight.map((key) => [key, "unexercised", "stale_binding"]),
    oversize: keys.oversize.map((key) => [key, "unexercised", "stale_binding"]),
  }), "after the new build");
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const [assessment] = assessQcAccepts(report.qc_accepts, current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "lapsed");
  assert.equal(assessment.why, "stale_binding");
  const lapsed = (handoffOf(await runNext(f)).lapsed || []).filter((entry) => entry.result_id === warning.id);
  assert.equal(lapsed.length, 1, "qc_handoff.lapsed lists the accepted result once");
  assert.equal(lapsed[0].why, "stale_binding");
});

browserTest("F1.0-B20 [real: 1.3] media_weight transferred_bytes lowered with the integrity left unchanged: every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  await tamperRecord((record, { urls }) => {
    recordResource(mediaWeightCell(record, route("pl-hero"), "desktop"), urls.hero).transferred_bytes = 400_000;
  }, { recompute: false });
});

browserTest("F1.0-B21 [real: 1.3] media_weight transferred_bytes edited and integrity recomputed, now differing from the page_load ledger entry: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-hero", (cell, { urls }) => {
    recordResource(cell, urls.hero).transferred_bytes = 400_000;
  });
});

browserTest("F1.0-B22 [real: 1.3] media_weight with performed_by \"agent\": every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  await tamperRecord((record) => {
    record.performed_by = "agent";
  });
});

browserTest("F1.0-B26 [real: 1.3] media_weight with schema_version campaigns-os-polish-media-weight/v9: every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  await tamperRecord((record) => {
    record.schema_version = "campaigns-os-polish-media-weight/v9";
  });
});

browserTest("F1.0-B27 [real: 1.3] same-origin image canceled at a lower bound relabelled measurement complete, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-lower", (cell, { urls }, tampered) => {
    const resource = recordResource(cell, urls.lower);
    // D2: the record's lower bound equals the page_load ledger entry's
    // exactly, under 500,000 B.
    assertRecordLowerBound(resource, ledgerEntry(pageLoadCapture(tampered.page_load, route("pl-lower"), "desktop"), urls.lower), "under", "precondition (pl-lower desktop)");
    resource.measurement = "complete";
  });
});

browserTest("F1.0-B28 [real: 1.3] page_load capture incomplete but media_weight capture_status complete, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-reset", (cell) => {
    assert.equal(cell.capture_status, "incomplete", "precondition: the record holds the incomplete capture");
    cell.capture_status = "complete";
  });
});

browserTest("F1.0-B29 [real: 1.3] same-origin 900,000 B complete image with final_origin_equal set false, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-900k", (cell, { urls }) => {
    const resource = recordResource(cell, urls.big);
    assert.equal(resource.final_origin_equal, true, "precondition: the image is same-origin");
    resource.final_origin_equal = false;
  });
});

browserTest("F1.0-B30 [real: 1.3] cell document_origin changed to another origin, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-hero", (cell, { urls }) => {
    assert.notEqual(cell.document_origin, urls.otherOrigin, "precondition: the cell names its own origin");
    cell.document_origin = urls.otherOrigin;
  });
});

browserTest("F1.0-B31 [real: 1.3] image resource type changed from image to fetch, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-hero", (cell, { urls }) => {
    const resource = recordResource(cell, urls.hero);
    assert.equal(resource.type, "image", "precondition: the resource is an image");
    resource.type = "fetch";
  });
});

browserTest("F1.0-B32 [real: 1.3] F1.3-B4 record with the first hop's status changed from 302 to 200, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-redirect", (cell, { urls }) => {
    const resource = recordResource(cell, urls.requested);
    assert.equal(resource.chain[0].status, 302, "precondition: the first hop is the 302");
    resource.chain[0].status = 200;
  });
});

browserTest("F1.0-B33 [real: 1.3] same-origin image with failed_request_count 1 relabelled failed false, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-reset", (cell, { urls }) => {
    const resource = recordResource(cell, urls.reset);
    assert.equal(resource.failed, true, "precondition: the record holds the failed request");
    resource.failed = false;
  });
});

browserTest("F1.0-B34 [real: 1.3] F1.3-B4 record with the resource's transferred_bytes set to the 302 hop's ledger bytes, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-redirect", (cell, { urls }, tampered) => {
    const hopBytes = ledgerEntry(pageLoadCapture(tampered.page_load, route("pl-redirect"), "desktop"), urls.requested).transferred_bytes;
    const resource = recordResource(cell, urls.requested);
    assert.notEqual(resource.transferred_bytes, hopBytes, "precondition: the record holds the final hop's bytes");
    resource.transferred_bytes = hopBytes;
  });
});

browserTest("F1.0-B35 [real: 1.3] same-origin <video preload=\"none\"> never fetched, declared_origin_equal set false, integrity recomputed: that cell's 1.3 results unexercised (evidence_not_reproducible)", async () => {
  await tamperCell("pl-video", (cell) => {
    assert.deepEqual(cell.videos.map((video) => [video.element_index, video.resource_ids, video.declared_origin_equal]), [[0, [], true]], "precondition: one unfetched video declared on the document origin");
    cell.videos[0].declared_origin_equal = false;
  });
});

browserTest("F1.0-B40 [real: 1.3] F1.3-B2 record with thresholds.image_bytes raised to 10,000,000, integrity recomputed: every 1.3 result of the record unexercised (evidence_not_reproducible)", async () => {
  await tamperRecord((record) => {
    assert.equal(record.thresholds.image_bytes, 500_000, "precondition: the record holds the 1.3 threshold");
    record.thresholds = { ...record.thresholds, image_bytes: 10_000_000 };
  });
});

// ---------------------------------------------------------------------------
// Incomplete rows

browserTest("F1.0-I8 [real: 1.3] media_weight bound to an older build fingerprint: result unexercised (stale_binding)", async (t) => {
  const state = await evidence();
  assert.equal(state.output.media_weight.subject.build_fingerprint, BUILD_FP, "setup: the record is bound to the build it was captured on");
  const results = await readResults(state.output, { currentBuild: NEWER_BUILD_FP });
  assertResultSet(results, allCells().flatMap(([name, viewport]) => failedCell(state.subjects, name, viewport, "stale_binding")), "every result of the record");

  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, { pageLoad: state.output.page_load, record: state.output.media_weight }, { buildFingerprint: NEWER_BUILD_FP });
  const handoff = handoffOf(await runNext(f));
  const pages = ROUTES.map(route).sort();
  const cells = ROUTES.length * VIEWPORTS.length;
  const count = (check) => ROUTES.reduce((sum, name) => sum + state.subjects[name][check === "media.weight" ? "weight" : "oversize"].length, 0) * VIEWPORTS.length;
  assert.equal(count("media.oversize"), cells, "setup: one oversize subject per cell");
  assert.deepEqual(handoff.coverage, [
    { check: "media.oversize", leg: "polish", result: "unexercised", reason_code: "stale_binding", count: count("media.oversize"), pages },
    { check: "media.weight", leg: "polish", result: "unexercised", reason_code: "stale_binding", count: count("media.weight"), pages },
    { check: "readability.contrast", leg: "polish", result: "unexercised", reason_code: "not_captured_by_this_version", count: 0, pages: [] },
    ...QA_LEG_NOT_RUN,
  ], "qc_handoff.coverage is exactly both 1.3 checks unexercised / stale_binding on every captured page, plus the fixture's QA leg_not_run entries");
  assert.deepEqual((handoff.open || []).filter((entry) => JSON.stringify(entry).includes("polish")), [], "a stale Polish result is never open");
  assert.deepEqual((handoff.review || []).filter((entry) => entry.leg === "polish"), [], "a stale Polish result is never under review");
});
