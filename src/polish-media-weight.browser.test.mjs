// F1.3 frozen fixture rows, leg P: unit 1.3 media weight and hosting, proved
// in real Chromium against loopback stub origins (contract §1.3, Frozen
// fixture table F1.3-*). The harness, the no-network guards and the
// CAMPAIGNS_OS_REQUIRE_BROWSER gate live in
// src/polish-media-weight-harness.browser.test.mjs. F1.3-I1 is leg D/CLI
// and lives in src/polish-media-weight.test.mjs.
//
// Each row:
// 1. serves its synthetic setup and runs the real producer
//    (capturePolishPageLoad with the package browser adapter);
// 2. checks the setup held in the existing page_load capture (ledger URLs,
//    bytes, status, cancel/fail/cross-origin counts) and compares each stub
//    origin's complete request log with the exact list the setup implies, so
//    a setup that did not take, or a probe that adds a request, is caught;
// 3. reads the 1.3 results through the 1.0 Polish reader site
//    (readMediaWeight with the registry's real 1.3 rules) and asserts the
//    exact full result set of every captured cell: both checks, every
//    subject by its exact key, each result and reason code.
//
// Byte figures: a complete transfer is served so that its measured wire bytes
// (status line + headers + body, contract 1.3 Inputs) equal the row's figure
// exactly. A canceled transfer's lower bound is what Chrome reported before
// the window closed, in coarse steps: those rows assert
// that the record's bytes equal the page_load ledger entry's exactly, the
// measurement class, the side of 500,000 B the row requires, and a measured
// (> 0 B) bound.
//
// Subject keys, element paths and the document's own weight result: see the
// API assumptions above assertResultSet in the harness.
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  BUILD_FP,
  NO_IMAGE_KEY,
  VIEWPORTS,
  assertLedgerLowerBound,
  assertLedgerUrls,
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
  origins,
  originPath,
  oversizeKey,
  page,
  pageLoadCapture,
  png,
  pngFile,
  pngWire,
  readResults,
  recordImage,
  recordOf,
  recordResource,
  redirect,
  requests,
  respond,
  resultRow,
  rid,
  route,
  stalled,
  svg,
  unledgeredImageKey,
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
  runNext,
} from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());
if (browserUnavailableNote) test.skip(browserUnavailableNote, () => {});

const doc = (origin, name) => rid(origin.url(route(name)));
const img = (attributes) => `<img alt="" ${attributes}>`;
const FIRST_IMG = imgPath(1);

// One route captured in both viewports; `serve` installs the setup.
async function captureOne(t, name, serve) {
  const { same, other } = await origins(t);
  serve({ same, other });
  const output = await capture(same, { routes: [name] });
  return { same, other, output };
}

// The setup check against the existing page_load capture, per viewport.
function eachCapture(output, name, check) {
  for (const viewport of VIEWPORTS) check(pageLoadCapture(output.page_load, route(name), viewport), viewport);
}

function assertEntry(entry, expected, label) {
  assert.ok(entry, `setup (${label}): the page_load ledger holds the resource`);
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(entry[field], value, `setup (${label}): page_load ledger ${field} is ${JSON.stringify(value)}`);
  }
}

// The record, then the 1.3 results read through the reader site.
async function readCells(output) {
  const record = recordOf(output);
  const results = await readResults(output);
  return { record, results };
}

// A same-origin image row: one 40×30 <img> (natural area 1,200 px, under the
// 250,000 px floor, so a loaded one is never oversized), its weight result
// `weight` and its oversize result `oversize` in both cells, beside the
// document's weight pass. `side` marks a lower-bound row (D2).
async function sameOriginWeightRow(t, name, serveImage, { weight, oversize, entry, measurement, side = null }) {
  const path = `/img/${name}.png`;
  const { same, other, output } = await captureOne(t, name, ({ same: origin }) => {
    origin.serve(route(name), page(img(`src="${path}" width="40" height="30"`)));
    origin.serve(path, serveImage);
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup");
  eachCapture(output, name, (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route(name)), url], viewport);
    entry(ledgerEntry(part, url), viewport);
  });
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const label = `${route(name)} ${viewport}`;
    const resource = recordResource(mediaWeightCell(record, route(name), viewport), url);
    assert.equal(resource.final_origin_equal, true, `${label}: the image's final origin is the document's`);
    assert.equal(resource.measurement, measurement, `${label}: measurement is ${measurement}`);
    if (side) assertRecordLowerBound(resource, ledgerEntry(pageLoadCapture(output.page_load, route(name), viewport), url), side, label);
    else assert.equal(resource.transferred_bytes, ledgerEntry(pageLoadCapture(output.page_load, route(name), viewport), url).transferred_bytes, `${label}: the media_weight bytes equal the page_load ledger entry's`);
  }
  assertResultSet(results, bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(url), ...weight]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), ...oversize]],
  }), route(name));
  return { same, output, url };
}

// A geometry row: one <img> styled into a box, its oversize result and the
// probed geometry in both cells. The image file is small and complete, so
// its weight result is pass.
async function oversizeRow(t, name, { natural, style, result, reasonCode, rendered, objectFit }) {
  const path = `/img/${name}.png`;
  const { same, other, output } = await captureOne(t, name, ({ same: origin }) => {
    origin.serve(route(name), page(img(`src="${path}" style="${style}"`)));
    origin.serve(path, pngFile(...natural));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup");
  eachCapture(output, name, (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route(name)), url], viewport);
    assertEntry(ledgerEntry(part, url), { failed_request_count: 0, canceled_request_count: 0, statuses: [200] }, viewport);
  });
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const label = `${route(name)} ${viewport}`;
    const cell = mediaWeightCell(record, route(name), viewport);
    assert.equal(cell.dpr, 1, `${label}: the observed devicePixelRatio is recorded (1: Polish sets none)`);
    assert.equal(cell.probe_status, "complete", `${label}: the probe completed`);
    const probed = recordImage(cell, url);
    assert.equal(probed.element_path, FIRST_IMG, `${label}: element path`);
    assert.deepEqual(probed.natural, natural, `${label}: natural size`);
    assert.deepEqual(probed.rendered, rendered, `${label}: rendered size in CSS px`);
    assert.equal(probed.object_fit, objectFit, `${label}: computed object-fit`);
  }
  assertResultSet(results, bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(url), "pass"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), result, reasonCode]],
  }), route(name));
}

const busyLoop = (ms) => `const until = performance.now() + ${ms}; while (performance.now() < until) {}`;
// A page script that keeps the main thread busy once loaded: after `load`
// (in a setTimeout 0) it runs `ms` busy loops back to back, each posted as
// the next message, so every probe step, which runs on the main thread in
// its own world, waits behind one. The page cannot see the probe (it reads
// in an isolated world), so it holds every main-thread task the same way.
const busyAfterLoad = (ms) => `<script>addEventListener("load", () => setTimeout(() => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { ${busyLoop(ms)} channel.port2.postMessage(null); };
  channel.port2.postMessage(null);
}, 0));</script>`;

// The F1.3-B3 image: 2400×1800 natural in a 300×225 `fill` box (F = 8). Any
// probe that completed would read it as image_oversized.
const OVERSIZED = { natural: [2400, 1800], style: "width:300px;height:225px;object-fit:fill" };

// A discarded probe (contract 1.3 Evaluation order step 3) on a page with one
// OVERSIZED <img> served small and complete: the cell records the probe
// status. The probe was discarded before its one read returned (or, for a
// cell the run budget ended before, started no step), so the cell lists no
// <img> and its one oversize result, keyed "cell", reads unexercised with the
// probe status. Where a probe cost cap ended the probe (contract :154-155,
// :1670), every result of the cell carries the page_coverage member with the
// cap code, so the document and the image read weight unexercised with it;
// otherwise they read weight pass.
const PROBE_COST_CAPS = ["probe_timeout", "image_cap_reached", "probe_budget_exhausted"];
const weightUnderCap = (status) => (PROBE_COST_CAPS.includes(status) ? ["unexercised", status] : ["pass"]);
const oversizeUnderCap = (status) => ["cell", "unexercised", status];

function discardedProbeCells(same, name, imagePath, status) {
  return bothCells(route(name), {
    weight: [[doc(same, name), ...weightUnderCap(status)], [rid(same.url(imagePath)), ...weightUnderCap(status)]],
    oversize: [oversizeUnderCap(status)],
    capCode: PROBE_COST_CAPS.includes(status) ? status : null,
  });
}

function assertProbeStatus(record, routePath, status) {
  for (const viewport of VIEWPORTS) {
    assert.equal(mediaWeightCell(record, routePath, viewport).probe_status, status, `${routePath} ${viewport}: probe_status is ${status}`);
  }
}

// --- accept rows -----------------------------------------------------------
//
// Each lapse row changes exactly one measured state field
// (contract 1.3 Accepts, State) and holds the others equal, and a control
// re-capture of the unchanged setup keeps the accept active. A fingerprint
// over anything a re-capture changes besides the measured state (measured_at,
// the page_load integrity) lapses the control; a fingerprint that omits the
// changed field keeps the changed capture active.

// The accepted weight result's measured state on the record (desktop cell).
const weightState = (output, name, url) => {
  const resource = recordResource(mediaWeightCell(output.media_weight, route(name), "desktop"), url);
  return {
    measurement: resource.measurement,
    transferred_bytes: resource.transferred_bytes,
    declared_bytes: resource.declared_bytes,
    final_url: resource.chain.at(-1).url,
    final_origin_equal: resource.final_origin_equal,
    chain: resource.chain,
  };
};
// The accepted oversize result's measured state on the record (desktop cell).
const oversizeState = (output, name, url) => {
  const cell = mediaWeightCell(output.media_weight, route(name), "desktop");
  const image = recordImage(cell, url);
  return {
    natural: image.natural,
    rendered: image.rendered,
    object_fit: image.object_fit,
    dpr: cell.dpr,
    final_url: recordResource(cell, url).chain.at(-1).url,
  };
};

function assertLapsedListed(handoff, id, why) {
  const entries = (handoff.lapsed || []).filter((entry) => entry.result_id === id);
  assert.equal(entries.length, 1, `qc_handoff.lapsed lists ${id} once: ${JSON.stringify(handoff.lapsed)}`);
  assert.equal(entries[0].why, why, `qc_handoff.lapsed gives ${id} why ${why}`);
}

// Accept the warning `subject` names on the first capture through
// `checkpoint accept` (the operator path, real 1.3 rules); read it against
// the control re-capture (active, same fingerprint) and against the changed
// capture (lapsed / state_changed, same result and reason, in the library
// assessment and in the `next` handoff). `expected(which)` is the exact
// result set of each capture; `state` reads the accepted subject's measured
// state, in which exactly `changed` differs.
async function assertAcceptLapses(t, { first, control, second, name, subject, expected, state, changed, label }) {
  recordOf(first);
  recordOf(control);
  recordOf(second);
  const before = state(first);
  const changedFields = Object.keys(before).filter((field) => !isDeepStrictEqual(before[field], state(second)[field]));
  assert.deepEqual(state(control), before, `${label}: the control re-capture measured the same state`);
  assert.deepEqual(changedFields, [changed], `${label}: exactly ${changed} changed (${JSON.stringify(before)} → ${JSON.stringify(state(second))})`);

  const firstResults = await readResults(first);
  assertResultSet(firstResults, expected("first"), `${label} first capture`);
  const accepted = resultRow(firstResults, subject.check, route(name), "desktop", subject.key);
  assert.equal(accepted.result, "warning", `${label}: the accepted result is a warning`);

  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, { pageLoad: first.page_load, record: first.media_weight }, { buildFingerprint: BUILD_FP });
  await delay(5);
  assertAccepted(await runAccept(f, [refOf(accepted)]));
  const records = readJson(f.reportPath).qc_accepts;
  assert.deepEqual(records.map((record) => record.result_id), [accepted.id], `${label}: one accept recorded, for ${accepted.id}`);
  assert.equal(records[0].measured_source, "polish_media_weight", `${label}: the accept names the media_weight record as its measurement`);
  const { assessQcAccepts } = await import("./qc-accept.mjs");

  installPolishEvidence(f, { pageLoad: control.page_load, record: control.media_weight }, { buildFingerprint: BUILD_FP });
  const controlResults = await readResults(control);
  assertResultSet(controlResults, expected("first"), `${label} control re-capture`);
  const same = resultRow(controlResults, subject.check, route(name), "desktop", subject.key);
  assert.equal(same.state_fingerprint, accepted.state_fingerprint, `${label}: the control re-capture keeps the accepted state fingerprint`);
  const [controlAssessment] = assessQcAccepts(records, controlResults, { now: new Date().toISOString() });
  assert.equal(controlAssessment.status, "active", `${label}: the accept stays active on the unchanged re-capture (${controlAssessment.status} / ${controlAssessment.why})`);
  assert.deepEqual((handoffOf(await runNext(f)).accepted || []).map((entry) => entry.result_ref), [refOf(accepted)], `${label}: the handoff lists the accept as applied on the control`);

  installPolishEvidence(f, { pageLoad: second.page_load, record: second.media_weight }, { buildFingerprint: BUILD_FP });
  const current = await readResults(second);
  assertResultSet(current, expected("second"), `${label} changed capture`);
  const changedRow = resultRow(current, subject.check, route(name), "desktop", subject.key);
  assert.equal(changedRow.id, accepted.id, `${label}: the re-captured result keeps the accepted id`);
  assert.deepEqual([changedRow.result, changedRow.reason_code], [accepted.result, accepted.reason_code], `${label}: the result and reason are unchanged; only the measured state moved`);
  const [assessment] = assessQcAccepts(records, current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "lapsed", `${label}: accept lapsed`);
  assert.equal(assessment.why, "state_changed", `${label}: why state_changed`);
  assertLapsedListed(handoffOf(await runNext(f)), accepted.id, "state_changed");
}

// ---------------------------------------------------------------------------
// Working rows

browserTest("F1.3-W1 same-origin image, 300,000 B complete: weight pass", async (t) => {
  await sameOriginWeightRow(t, "w1", pngWire(40, 30, 300_000), {
    weight: ["pass"],
    oversize: ["pass"],
    measurement: "complete",
    entry: (entry, viewport) => assertEntry(entry, { transferred_bytes: 300_000, canceled_request_count: 0, failed_request_count: 0, cross_origin_request_count: 0 }, viewport),
  });
});

browserTest("F1.3-W2 natural 800×600 rendered 600×450 fill at DPR 1 (F = 1.33): oversize pass", async (t) => {
  await oversizeRow(t, "w2", { natural: [800, 600], style: "width:600px;height:450px;object-fit:fill", rendered: [600, 450], objectFit: "fill", result: "pass", reasonCode: null });
});

browserTest("F1.3-W3 other-origin image, 900,000 B complete: weight pass (other_origin recorded)", async (t) => {
  const { same, other, output } = await captureOne(t, "w3", ({ same: origin, other: cdn }) => {
    origin.serve(route("w3"), page(img(`src="${cdn.url("/img/w3.png")}" width="40" height="30"`)));
    cdn.serve("/img/w3.png", pngWire(40, 30, 900_000));
  });
  const url = other.url("/img/w3.png");
  assertRequestLog({ same, other }, { same: requests([route("w3")]), other: requests(["/img/w3.png"]) }, "setup");
  eachCapture(output, "w3", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("w3")), url], viewport);
    assertEntry(ledgerEntry(part, url), { transferred_bytes: 900_000, canceled_request_count: 0, failed_request_count: 0, cross_origin_request_count: 1, statuses: [200] }, viewport);
  });
  const { record, results } = await readCells(output);
  const chain = [{ url: originPath(url), resource_id: rid(url), status: 200 }];
  for (const viewport of VIEWPORTS) {
    const label = `${route("w3")} ${viewport}`;
    const resource = recordResource(mediaWeightCell(record, route("w3"), viewport), url);
    assert.equal(resource.final_origin_equal, false, `${label}: the final origin is another origin`);
    assert.deepEqual(resource.chain, chain, `${label}: the one-hop chain is recorded`);
    const row = resultRow(results, "media.weight", route("w3"), viewport, rid(url));
    // API assumption: the observation keeps the origin relation as the value
    // "other_origin", plus final_origin_equal and the chain (contract 1.3
    // Origin and weight rule 2).
    assert.ok(JSON.stringify(row.observation).includes('"other_origin"'), `${label}: other_origin is recorded in the observation: ${JSON.stringify(row.observation)}`);
    assert.equal(row.observation.final_origin_equal, false, `${label}: the observation keeps the origin equality`);
    assert.deepEqual(row.observation.chain, chain, `${label}: the observation keeps the chain`);
  }
  assertResultSet(results, bothCells(route("w3"), {
    weight: [[doc(same, "w3"), "pass"], [rid(url), "pass"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "pass"]],
  }), route("w3"));
});

browserTest("F1.3-W4 natural 1600×400 rendered 400×400 cover at DPR 1 (F = 1.0): oversize pass", async (t) => {
  await oversizeRow(t, "w4", { natural: [1600, 400], style: "width:400px;height:400px;object-fit:cover", rendered: [400, 400], objectFit: "cover", result: "pass", reasonCode: null });
});

// ---------------------------------------------------------------------------
// Broken rows

browserTest("F1.3-B1 same-origin <video> fetched: warning (video_from_document_origin)", async (t) => {
  const path = "/media/b1.mp4";
  const { same, other, output } = await captureOne(t, "b1", ({ same: origin }) => {
    origin.serve(route("b1"), page(`<video src="${path}" preload="auto" muted width="320" height="180"></video>`));
    origin.serve(path, respond("200 OK", "video/mp4", Buffer.alloc(4_096, 7)));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route("b1"), path]) }, "setup");
  eachCapture(output, "b1", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("b1")), url], viewport);
    assertEntry(ledgerEntry(part, url), { failed_request_count: 0, cross_origin_request_count: 0 }, viewport);
    assert.deepEqual(part.media.map((element) => element.tag_name), ["video"], `setup (${viewport}): one <video> element`);
  });
  const { results } = await readCells(output);
  assertResultSet(results, bothCells(route("b1"), {
    weight: [[doc(same, "b1"), "pass"], [rid(url), "warning", "video_from_document_origin"]],
    oversize: [[NO_IMAGE_KEY, "pass"]],
  }), route("b1"));
});

browserTest("F1.3-B2 same-origin image, 600,000 B complete: warning (image_over_threshold)", async (t) => {
  await sameOriginWeightRow(t, "b2", pngWire(40, 30, 600_000), {
    weight: ["warning", "image_over_threshold"],
    oversize: ["pass"],
    measurement: "complete",
    entry: (entry, viewport) => assertEntry(entry, { transferred_bytes: 600_000, canceled_request_count: 0, failed_request_count: 0, cross_origin_request_count: 0 }, viewport),
  });
});

browserTest("F1.3-B3 natural 2400×1800 rendered 300×225 fill at DPR 1 (F = 8): warning (image_oversized)", async (t) => {
  await oversizeRow(t, "b3", { ...OVERSIZED, rendered: [300, 225], objectFit: "fill", result: "warning", reasonCode: "image_oversized" });
});

browserTest("F1.3-B4 other-origin URL 302s to a same-origin 600,000 B image: warning on the final origin, chain persisted in order (image_over_threshold)", async (t) => {
  const { same, other, output } = await captureOne(t, "b4", ({ same: origin, other: cdn }) => {
    origin.serve(route("b4"), page(img(`src="${cdn.url("/img/b4.png")}" width="40" height="30"`)));
    cdn.serve("/img/b4.png", redirect(cdn.url("/hop?v=1")));
    cdn.serve("/hop?v=1", redirect(origin.url("/img/b4.png")));
    origin.serve("/img/b4.png", pngWire(40, 30, 600_000));
  });
  const requested = other.url("/img/b4.png");
  const hop = other.url("/hop?v=1");
  const final = same.url("/img/b4.png");
  assertRequestLog({ same, other }, { same: requests([route("b4"), "/img/b4.png"]), other: requests(["/img/b4.png", "/hop?v=1"]) }, "setup");
  eachCapture(output, "b4", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("b4")), requested, hop, final], viewport);
    assertEntry(ledgerEntry(part, requested), { statuses: [302], cross_origin_request_count: 1 }, `${viewport} first hop`);
    assertEntry(ledgerEntry(part, hop), { statuses: [302], cross_origin_request_count: 1 }, `${viewport} middle hop`);
    assertEntry(ledgerEntry(part, final), { statuses: [200], transferred_bytes: 600_000, cross_origin_request_count: 0, canceled_request_count: 0 }, `${viewport} final hop`);
  });
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const label = `${route("b4")} ${viewport}`;
    const cell = mediaWeightCell(record, route("b4"), viewport);
    assert.deepEqual(cell.resources.map((resource) => resource.resource_id).sort(), [doc(same, "b4"), rid(requested)].sort(), `${label}: the hops are one resource, keyed by the requested href`);
    const resource = recordResource(cell, requested);
    assert.deepEqual(resource.chain, [
      { url: originPath(requested), resource_id: rid(requested), status: 302 },
      { url: originPath(hop), resource_id: rid(hop), status: 302 },
      { url: originPath(final), resource_id: rid(final), status: 200 },
    ], `${label}: the redirect chain is persisted in order, requested href first`);
    assert.equal(resource.final_origin_equal, true, `${label}: same origin is judged on the final hop`);
    assert.equal(resource.transferred_bytes, 600_000, `${label}: the bytes are the final hop's`);
  }
  assertResultSet(results, bothCells(route("b4"), {
    weight: [[doc(same, "b4"), "pass"], [rid(requested), "warning", "image_over_threshold"]],
    oversize: [[oversizeKey(rid(requested), FIRST_IMG), "pass"]],
  }), route("b4"));
});

browserTest("F1.3-B5 canceled same-origin image, lower bound 600,000 B: warning (image_over_threshold)", async (t) => {
  // The transfer never completes, so the <img> is not loaded (oversize
  // not_loaded).
  await sameOriginWeightRow(t, "b5", stalled({ sendBytes: 600_000 }), {
    weight: ["warning", "image_over_threshold"],
    oversize: ["unexercised", "not_loaded"],
    measurement: "lower_bound",
    side: "over",
    entry: (entry, viewport) => {
      assertEntry(entry, { declared_request_count: 0, failed_request_count: 0, cross_origin_request_count: 0 }, viewport);
      assertLedgerLowerBound(entry, "over", viewport);
    },
  });
});

browserTest("F1.3-B6 same-origin image, 500,001 B complete: warning (image_over_threshold)", async (t) => {
  await sameOriginWeightRow(t, "b6", pngWire(40, 30, 500_001), {
    weight: ["warning", "image_over_threshold"],
    oversize: ["pass"],
    measurement: "complete",
    entry: (entry, viewport) => assertEntry(entry, { transferred_bytes: 500_001, canceled_request_count: 0, failed_request_count: 0, cross_origin_request_count: 0 }, viewport),
  });
});

// Three captures of one route: `serveFirst` for the accepted capture and the
// control, then `serveSecond`. Each capture's request log is compared with
// `log(which)`.
async function threeCaptures(t, name, { serveFirst, serveSecond, log }) {
  const { same, other } = await origins(t);
  serveFirst({ same, other });
  const first = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, log("first", { same, other }), "setup (first capture)");
  const control = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, log("first", { same, other }), "setup (control re-capture)");
  serveSecond({ same, other });
  const second = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, log("second", { same, other }), "setup (changed capture)");
  return { same, other, first, control, second };
}
const desktopEntry = (output, name, url) => ledgerEntry(pageLoadCapture(output.page_load, route(name), "desktop"), url);

browserTest("F1.3-B7 accepted F1.3-B2, image re-served at 600,100 B: accept lapsed (state_changed)", async (t) => {
  const path = "/img/b7.png";
  const { same, first, control, second } = await threeCaptures(t, "b7", {
    serveFirst: ({ same: origin }) => {
      origin.serve(route("b7"), page(img(`src="${path}" width="40" height="30"`)));
      origin.serve(path, pngWire(40, 30, 600_000));
    },
    serveSecond: ({ same: origin }) => origin.serve(path, pngWire(40, 30, 600_100)),
    log: () => ({ same: requests([route("b7"), path]) }),
  });
  const url = same.url(path);
  assert.equal(desktopEntry(first, "b7", url)?.transferred_bytes, 600_000, "setup: first served at 600,000 B");
  assert.equal(desktopEntry(control, "b7", url)?.transferred_bytes, 600_000, "setup: the control is served at 600,000 B");
  assert.equal(desktopEntry(second, "b7", url)?.transferred_bytes, 600_100, "setup: re-served at 600,100 B");
  const cells = bothCells(route("b7"), {
    weight: [[doc(same, "b7"), "pass"], [rid(url), "warning", "image_over_threshold"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "pass"]],
  });
  await assertAcceptLapses(t, {
    first, control, second, name: "b7", label: "F1.3-B7",
    subject: { check: "media.weight", key: rid(url) },
    expected: () => cells,
    state: (output) => weightState(output, "b7", url),
    changed: "transferred_bytes",
  });
});

browserTest("F1.3-B8 accepted F1.3-B4, the other-origin hop now redirects through /hop?v=2 instead of /hop?v=1: accept lapsed (state_changed)", async (t) => {
  const { same, other, first, control, second } = await threeCaptures(t, "b8", {
    serveFirst: ({ same: origin, other: cdn }) => {
      origin.serve(route("b8"), page(img(`src="${cdn.url("/img/b8.png")}" width="40" height="30"`)));
      origin.serve("/img/b8.png", pngWire(40, 30, 600_000));
      cdn.serve("/hop?v=1", redirect(origin.url("/img/b8.png")));
      cdn.serve("/hop?v=2", redirect(origin.url("/img/b8.png")));
      cdn.serve("/img/b8.png", redirect(cdn.url("/hop?v=1")));
    },
    serveSecond: ({ other: cdn }) => cdn.serve("/img/b8.png", redirect(cdn.url("/hop?v=2"))),
    log: (which) => ({ same: requests([route("b8"), "/img/b8.png"]), other: requests(["/img/b8.png", which === "first" ? "/hop?v=1" : "/hop?v=2"]) }),
  });
  const requested = other.url("/img/b8.png");
  const final = same.url("/img/b8.png");
  for (const [output, hop] of [[first, "/hop?v=1"], [control, "/hop?v=1"], [second, "/hop?v=2"]]) {
    assertLedgerUrls(pageLoadCapture(output.page_load, route("b8"), "desktop"), [same.url(route("b8")), requested, other.url(hop), final], `chain through ${hop}`);
    assert.equal(desktopEntry(output, "b8", final)?.transferred_bytes, 600_000, "setup: the same final image");
  }
  const cells = bothCells(route("b8"), {
    weight: [[doc(same, "b8"), "pass"], [rid(requested), "warning", "image_over_threshold"]],
    oversize: [[oversizeKey(rid(requested), FIRST_IMG), "pass"]],
  });
  await assertAcceptLapses(t, {
    first, control, second, name: "b8", label: "F1.3-B8",
    subject: { check: "media.weight", key: rid(requested) },
    expected: () => cells,
    state: (output) => weightState(output, "b8", requested),
    changed: "chain",
  });
});

// Accepted F1.3-B3, re-captured with the box style or the file changed. The
// image stays small and complete (weight pass) and oversized (F ≥ 2.0 and
// area ≥ 250,000 in every variant), so the oversize result stays a warning.
async function acceptedB3Recaptured(t, name, { secondStyle = OVERSIZED.style, secondNatural = OVERSIZED.natural, changed, label }) {
  const path = `/img/${name}.png`;
  const { same, first, control, second } = await threeCaptures(t, name, {
    serveFirst: ({ same: origin }) => {
      origin.serve(route(name), page(img(`src="${path}" style="${OVERSIZED.style}"`)));
      origin.serve(path, pngFile(...OVERSIZED.natural));
    },
    serveSecond: ({ same: origin }) => {
      origin.serve(route(name), page(img(`src="${path}" style="${secondStyle}"`)));
      origin.serve(path, pngFile(...secondNatural));
    },
    log: () => ({ same: requests([route(name), path]) }),
  });
  const url = same.url(path);
  for (const output of [first, control, second]) {
    assert.equal(pageLoadCapture(output.page_load, route(name), "desktop").measurement_status, "complete", "setup: the capture is complete");
    assertLedgerUrls(pageLoadCapture(output.page_load, route(name), "desktop"), [same.url(route(name)), url], "desktop");
  }
  const cells = bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(url), "pass"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "warning", "image_oversized"]],
  });
  await assertAcceptLapses(t, {
    first, control, second, name, label,
    subject: { check: "media.oversize", key: oversizeKey(rid(url), FIRST_IMG) },
    expected: () => cells,
    state: (output) => oversizeState(output, name, url),
    changed,
  });
}

browserTest("F1.3-B9 accepted F1.3-B3, rendered box changes to 320×240: accept lapsed (state_changed)", async (t) => {
  await acceptedB3Recaptured(t, "b9", { secondStyle: "width:320px;height:240px;object-fit:fill", changed: "rendered", label: "F1.3-B9" });
});

browserTest("F1.3-B10 accepted F1.3-B3, object-fit changes from fill to contain (same box): accept lapsed (state_changed)", async (t) => {
  await acceptedB3Recaptured(t, "b10", { secondStyle: "width:300px;height:225px;object-fit:contain", changed: "object_fit", label: "F1.3-B10" });
});

// The F1.3-B5 transfer for the accepted capture and its control: 600,000 B
// sent, no Content-Length. The pad header has the length of B13's
// "Content-Length: 1300000" line, so all three captures send header blocks of
// one length and the same bytes before the cut.
const B5_PAD = [`X-Synthetic-Pad: ${"0".repeat("Content-Length: 1300000".length - "X-Synthetic-Pad: ".length)}`];
const b5Stalled = () => stalled({ sendBytes: 600_000, extra: B5_PAD });

// Chrome reports the bytes of a transfer still in flight in coarse steps, so
// two captures of one stalled transfer can read different lower bounds (for
// example 589,824 and 600,000 B). A row that needs the accepted capture's
// lower bound in a later capture re-captures it, at most
// LOWER_BOUND_ATTEMPTS times, until its desktop entry reads that bound; the
// setup fails only after the last attempt.
const LOWER_BOUND_ATTEMPTS = 5;

// Each capture of a page whose transfer is held open waits the 5 s
// network-idle bound on both viewports (about 10 s per capture). The rows
// below run several captures, so they carry an explicit timeout sized to
// their worst case instead of relying on the runner's default (none).
const CAPTURE_MS = 10_000;
const B12_TIMEOUT_MS = (1 + LOWER_BOUND_ATTEMPTS + 1) * CAPTURE_MS + 50_000; // accepted, control re-captures, complete re-serve
const B13_TIMEOUT_MS = (1 + 2 * LOWER_BOUND_ATTEMPTS) * CAPTURE_MS + 40_000; // accepted, control and re-serve re-captures
const I16_TIMEOUT_MS = 90_000; // twelve routes on two viewports, eleven of them with a slow probe, about 40 s
async function captureAtLowerBound({ same, other }, name, path, bound, label) {
  const seen = [];
  for (let attempt = 1; attempt <= LOWER_BOUND_ATTEMPTS; attempt += 1) {
    const output = await capture(same, { routes: [name] });
    assertRequestLog({ same, other }, { same: requests([route(name), path]) }, `setup (${label}, attempt ${attempt})`);
    const bytes = desktopEntry(output, name, same.url(path))?.transferred_bytes;
    if (bytes === bound) return output;
    seen.push(bytes);
  }
  return assert.fail(`setup (${label}): no capture in ${LOWER_BOUND_ATTEMPTS} read the accepted lower bound ${bound} B (read ${seen.join(", ")} B)`);
}

// Accepted F1.3-B5, re-served by `secondHandler`. The control and the
// re-serve are each captured at the accepted capture's lower bound.
async function acceptedB5Recaptured(t, name, { secondHandler, check, changed, secondOversize, label }) {
  const path = `/img/${name}.png`;
  const { same, other } = await origins(t);
  same.serve(route(name), page(img(`src="${path}" width="40" height="30"`)));
  same.serve(path, b5Stalled());
  const first = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup (first capture)");
  const bound = desktopEntry(first, name, same.url(path))?.transferred_bytes;
  const control = await captureAtLowerBound({ same, other }, name, path, bound, "control re-capture");
  same.serve(path, secondHandler);
  const second = await captureAtLowerBound({ same, other }, name, path, bound, "changed capture");
  const url = same.url(path);
  const firstEntry = desktopEntry(first, name, url);
  assertLedgerLowerBound(firstEntry, "over", "first capture");
  assertEntry(firstEntry, { declared_request_count: 0 }, "first capture");
  assertEntry(desktopEntry(control, name, url), { canceled_request_count: 1, declared_request_count: 0, transferred_bytes: firstEntry.transferred_bytes }, "control re-capture: the same lower bound");
  check(firstEntry, desktopEntry(second, name, url));
  for (const output of [first, control, second]) {
    for (const viewport of VIEWPORTS) {
      assertRecordLowerBound(recordResource(mediaWeightCell(recordOf(output), route(name), viewport), url), ledgerEntry(pageLoadCapture(output.page_load, route(name), viewport), url), "over", `${route(name)} ${viewport}`);
    }
  }
  const cells = (oversize) => bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(url), "warning", "image_over_threshold"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), ...oversize]],
  });
  await assertAcceptLapses(t, {
    first, control, second, name, label,
    subject: { check: "media.weight", key: rid(url) },
    expected: (which) => cells(which === "first" ? ["unexercised", "not_loaded"] : secondOversize),
    state: (output) => weightState(output, name, url),
    changed,
  });
}

browserTest("F1.3-B12 accepted F1.3-B5, image re-served complete at 600,000 B: accept lapsed (state_changed)", { timeout: B12_TIMEOUT_MS }, async (t) => {
  // D2: the complete re-serve carries exactly the bytes Chrome measured as
  // the accepted lower bound (the 600,000 B figure in Chrome's coarse step),
  // so the two captures' bytes are equal and only the measurement class
  // moves from lower_bound to complete.
  const name = "b12";
  const path = `/img/${name}.png`;
  const { same, first, control, second } = await threeCapturesB12(t, name, path);
  const url = same.url(path);
  const firstEntry = desktopEntry(first, name, url);
  assertLedgerLowerBound(firstEntry, "over", "first capture");
  assertEntry(desktopEntry(control, name, url), { canceled_request_count: 1, declared_request_count: 0, transferred_bytes: firstEntry.transferred_bytes }, "control re-capture: the same lower bound");
  assertEntry(desktopEntry(second, name, url), { canceled_request_count: 0, declared_request_count: 0, transferred_bytes: firstEntry.transferred_bytes }, "re-served complete with the same bytes");
  for (const output of [first, control]) {
    for (const viewport of VIEWPORTS) {
      assertRecordLowerBound(recordResource(mediaWeightCell(recordOf(output), route(name), viewport), url), ledgerEntry(pageLoadCapture(output.page_load, route(name), viewport), url), "over", `${route(name)} ${viewport}`);
    }
  }
  for (const viewport of VIEWPORTS) {
    const resource = recordResource(mediaWeightCell(recordOf(second), route(name), viewport), url);
    assert.equal(resource.measurement, "complete", `${route(name)} ${viewport}: the re-serve is measured complete`);
    assert.equal(resource.transferred_bytes, ledgerEntry(pageLoadCapture(second.page_load, route(name), viewport), url).transferred_bytes, `${route(name)} ${viewport}: the media_weight bytes equal the page_load ledger entry's exactly`);
  }
  const cells = (oversize) => bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(url), "warning", "image_over_threshold"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), ...oversize]],
  });
  await assertAcceptLapses(t, {
    first, control, second, name, label: "F1.3-B12",
    subject: { check: "media.weight", key: rid(url) },
    // The complete 40×30 image loads in the changed capture (oversize pass).
    expected: (which) => cells(which === "first" ? ["unexercised", "not_loaded"] : ["pass"]),
    state: (output) => weightState(output, name, url),
    changed: "measurement",
  });
});

// F1.3-B12's captures: the accepted B5 capture and its control, then a
// complete re-serve sized to the first capture's measured lower bound.
async function threeCapturesB12(t, name, path) {
  const { same, other } = await origins(t);
  same.serve(route(name), page(img(`src="${path}" width="40" height="30"`)));
  same.serve(path, b5Stalled());
  const first = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup (first capture)");
  const control = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup (control re-capture)");
  const lowerBound = desktopEntry(first, name, same.url(path))?.transferred_bytes;
  assert.ok(lowerBound > 500_000, `setup: the accepted lower bound is over 500,000 B (${lowerBound})`);
  same.serve(path, pngWire(40, 30, lowerBound));
  const second = await capture(same, { routes: [name] });
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup (changed capture)");
  return { same, other, first, control, second };
}

browserTest("F1.3-B13 accepted F1.3-B5, re-served with the same lower bound and a declared length of 1,300,000 B: accept lapsed (state_changed)", { timeout: B13_TIMEOUT_MS }, async (t) => {
  await acceptedB5Recaptured(t, "b13", {
    secondHandler: stalled({ sendBytes: 600_000, declared: 1_300_000 }),
    check: (first, second) => {
      assertEntry(second, { canceled_request_count: 1, declared_request_count: 1, declared_bytes: 1_300_000 }, "re-served with a declared length");
      assert.equal(second.transferred_bytes, first.transferred_bytes, "setup: the same lower bound as the accepted capture");
    },
    changed: "declared_bytes",
    secondOversize: ["unexercised", "not_loaded"],
    label: "F1.3-B13",
  });
});

browserTest("F1.3-B14 accepted F1.3-B3, image replaced by a 2000×1500 file in the same 300×225 fill box: accept lapsed (state_changed)", async (t) => {
  await acceptedB3Recaptured(t, "b14", { secondNatural: [2000, 1500], changed: "natural", label: "F1.3-B14" });
});

// ---------------------------------------------------------------------------
// Incomplete rows

// A canceled same-origin transfer with a declared length: 100,000 B sent
// (Chrome reports the lower bound in its coarse step, at most 100,000 B).
async function declaredLowerBoundRow(t, name, declared, weight) {
  await sameOriginWeightRow(t, name, stalled({ sendBytes: 100_000, declared }), {
    weight,
    oversize: ["unexercised", "not_loaded"],
    measurement: "lower_bound",
    side: "under",
    entry: (entry, viewport) => {
      assertEntry(entry, { declared_request_count: 1, declared_bytes: declared, failed_request_count: 0, cross_origin_request_count: 0 }, viewport);
      assertLedgerLowerBound(entry, "under", viewport);
    },
  });
}

browserTest("F1.3-I2 canceled, lower bound 100,000 B, declared 900,000 B: review (declared_over_threshold_unmeasured)", async (t) => {
  await declaredLowerBoundRow(t, "i2", 900_000, ["review", "declared_over_threshold_unmeasured"]);
});

browserTest("F1.3-I3 canceled, lower bound 100,000 B, declared 200,000 B: unexercised (transfer_partial)", async (t) => {
  await declaredLowerBoundRow(t, "i3", 200_000, ["unexercised", "transfer_partial"]);
});

browserTest("F1.3-I4 loading=lazy image below a 5,000 px spacer: oversize unexercised (lazy_not_requested)", async (t) => {
  const path = "/img/i4.png";
  const { same, other, output } = await captureOne(t, "i4", ({ same: origin }) => {
    origin.serve(route("i4"), page(`<div style="height:5000px"></div>${img(`src="${path}" loading="lazy" style="${OVERSIZED.style}"`)}`));
    origin.serve(path, pngFile(...OVERSIZED.natural));
  });
  assertRequestLog({ same, other }, { same: requests([route("i4")]) }, "setup: the lazy image was never requested");
  eachCapture(output, "i4", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i4"))], viewport);
  });
  const { results } = await readCells(output);
  // The never-selected lazy <img> has an empty currentSrc (resource_id null);
  // with no ledger entry it reads weight not_in_ledger (contract 1.3: "a
  // probed <img> whose currentSrc has no ledger entry").
  assertResultSet(results, bothCells(route("i4"), {
    weight: [[doc(same, "i4"), "pass"], [unledgeredImageKey(FIRST_IMG), "unexercised", "not_in_ledger"]],
    oversize: [[oversizeKey(null, FIRST_IMG), "unexercised", "lazy_not_requested"]],
  }), route("i4"));
});

browserTest("F1.3-I5 image 404 (naturalWidth 0): oversize unexercised (not_loaded)", async (t) => {
  const path = "/img/i5-missing.png";
  const { same, other, output } = await captureOne(t, "i5", ({ same: origin }) => {
    origin.serve(route("i5"), page(img(`src="${path}" style="${OVERSIZED.style}"`)));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route("i5"), path]) }, "setup");
  eachCapture(output, "i5", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i5")), url], viewport);
    assertEntry(ledgerEntry(part, url), { statuses: [404], failed_request_count: 0, canceled_request_count: 0 }, viewport);
  });
  const { results } = await readCells(output);
  // The 404 answer is a complete, small, same-origin image-type transfer: by
  // the byte table its weight reads pass.
  assertResultSet(results, bothCells(route("i5"), {
    weight: [[doc(same, "i5"), "pass"], [rid(url), "pass"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "unexercised", "not_loaded"]],
  }), route("i5"));
});

browserTest("F1.3-I6 same-origin <video preload=\"none\"> never fetched: unexercised (not_loaded)", async (t) => {
  const path = "/media/i6.mp4";
  const { same, other, output } = await captureOne(t, "i6", ({ same: origin }) => {
    origin.serve(route("i6"), page(`<video src="${path}" preload="none" width="320" height="180"></video>`));
    origin.serve(path, respond("200 OK", "video/mp4", Buffer.alloc(4_096, 7)));
  });
  assertRequestLog({ same, other }, { same: requests([route("i6")]) }, "setup: the video was never fetched");
  eachCapture(output, "i6", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i6"))], viewport);
    assert.deepEqual(part.media.map((element) => [element.tag_name, element.element_index]), [["video", 0]], `setup (${viewport}): one <video>, element_index 0`);
  });
  const { results } = await readCells(output);
  assertResultSet(results, bothCells(route("i6"), {
    weight: [[doc(same, "i6"), "pass"], ["video:0", "unexercised", "not_loaded"]],
    oversize: [[NO_IMAGE_KEY, "pass"]],
  }), route("i6"));
});

browserTest("F1.3-I7 SVG image: oversize unexercised (vector_image)", async (t) => {
  const path = "/img/i7.svg";
  const { same, other, output } = await captureOne(t, "i7", ({ same: origin }) => {
    origin.serve(route("i7"), page(img(`src="${path}" style="${OVERSIZED.style}"`)));
    origin.serve(path, respond("200 OK", "image/svg+xml", svg(2400, 1800)));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route("i7"), path]) }, "setup");
  eachCapture(output, "i7", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i7")), url], viewport);
    assertEntry(ledgerEntry(part, url), { statuses: [200], failed_request_count: 0, canceled_request_count: 0 }, viewport);
  });
  const { results } = await readCells(output);
  assertResultSet(results, bothCells(route("i7"), {
    weight: [[doc(same, "i7"), "pass"], [rid(url), "pass"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "unexercised", "vector_image"]],
  }), route("i7"));
});

browserTest("F1.3-I8 spec page with no source mapping: unexercised (page_not_captured)", async (t) => {
  const { same, other } = await origins(t);
  same.serve(route("i8-mapped"), page(img(`src="/img/i8.png" width="40" height="30"`)));
  same.serve("/img/i8.png", pngFile(40, 30));
  const output = await capture(same, { routes: ["i8-mapped"], skipped: ["i8-unmapped"] });
  assertRequestLog({ same, other }, { same: requests([route("i8-mapped"), "/img/i8.png"]) }, "setup: the unmapped page was never requested");
  assert.deepEqual(output.page_load.subject.routes, [route("i8-mapped")], "setup: only the mapped page is captured");
  assert.equal(output.page_load.subject.route_scope, "selected", "setup: the capture covers a selected route scope");
  recordOf(output);
  // Read through the reader site. API assumption: the
  // uncaptured page lists, per viewport, one result per 1.3 check keyed
  // "cell" (the 1.0 reader's key for a route × viewport no cell covers),
  // unexercised / page_not_captured; the mapped page reads as captured.
  const results = await readResults(output);
  assertResultSet(results, [
    ...bothCells(route("i8-mapped"), {
      weight: [[doc(same, "i8-mapped"), "pass"], [rid(same.url("/img/i8.png")), "pass"]],
      oversize: [[oversizeKey(rid(same.url("/img/i8.png")), FIRST_IMG), "pass"]],
    }),
    ...bothCells(route("i8-unmapped"), {
      weight: [["cell", "unexercised", "page_not_captured"]],
      oversize: [["cell", "unexercised", "page_not_captured"]],
    }),
  ], "mapped and unmapped pages");
});

browserTest("F1.3-I10 canceled other-origin image, lower bound 300,000 B, not failed, cell otherwise complete: weight unexercised (transfer_partial)", async (t) => {
  const { same, other, output } = await captureOne(t, "i10", ({ same: origin, other: cdn }) => {
    origin.serve(route("i10"), page(img(`src="${cdn.url("/img/i10.png")}" width="40" height="30"`)));
    cdn.serve("/img/i10.png", stalled({ sendBytes: 300_000 }));
  });
  const url = other.url("/img/i10.png");
  assertRequestLog({ same, other }, { same: requests([route("i10")]), other: requests(["/img/i10.png"]) }, "setup");
  eachCapture(output, "i10", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the cell is otherwise complete`);
    assertLedgerUrls(part, [same.url(route("i10")), url], viewport);
    assertEntry(ledgerEntry(part, url), { failed_request_count: 0, cross_origin_request_count: 1, declared_request_count: 0 }, viewport);
    assertLedgerLowerBound(ledgerEntry(part, url), "under", viewport);
  });
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const label = `${route("i10")} ${viewport}`;
    const resource = recordResource(mediaWeightCell(record, route("i10"), viewport), url);
    assert.equal(resource.final_origin_equal, false, `${label}: another origin`);
    assertRecordLowerBound(resource, ledgerEntry(pageLoadCapture(output.page_load, route("i10"), viewport), url), "under", label);
  }
  assertResultSet(results, bothCells(route("i10"), {
    weight: [[doc(same, "i10"), "pass"], [rid(url), "unexercised", "transfer_partial"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "unexercised", "not_loaded"]],
  }), route("i10"));
});

async function notRenderedRow(t, name, markup, elementPath) {
  const path = `/img/${name}.png`;
  const { same, other, output } = await captureOne(t, name, ({ same: origin }) => {
    origin.serve(route(name), page(markup(path)));
    origin.serve(path, pngFile(...OVERSIZED.natural));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup");
  eachCapture(output, name, (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route(name)), url], viewport);
    assertEntry(ledgerEntry(part, url), { statuses: [200], failed_request_count: 0, canceled_request_count: 0 }, `${viewport}: the image loaded`);
  });
  const { results } = await readCells(output);
  assertResultSet(results, bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(url), "pass"]],
    oversize: [[oversizeKey(rid(url), elementPath), "unexercised", "not_rendered"]],
  }), route(name));
}

browserTest("F1.3-I11 loaded image inside a display:none parent: oversize unexercised (not_rendered)", async (t) => {
  await notRenderedRow(t, "i11", (path) => `<div style="display:none">${img(`src="${path}" style="${OVERSIZED.style}"`)}</div>`, imgPath(1, "body>div:nth-of-type(1)"));
});

browserTest("F1.3-I12 <img> whose currentSrc is a data: URL (no ledger entry): weight unexercised (not_in_ledger)", async (t) => {
  const dataUrl = `data:image/png;base64,${png(40, 30).toString("base64")}`;
  const { same, other, output } = await captureOne(t, "i12", ({ same: origin }) => {
    origin.serve(route("i12"), page(img(`src="${dataUrl}" width="40" height="30"`)));
  });
  assertRequestLog({ same, other }, { same: requests([route("i12")]) }, "setup");
  eachCapture(output, "i12", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i12"))], viewport);
  });
  const { results } = await readCells(output);
  // Asserted through the reader site. The data: <img>
  // loads (40×30, under the area floor: oversize pass); its resource_id is
  // null (non-http currentSrc).
  assertResultSet(results, bothCells(route("i12"), {
    weight: [[doc(same, "i12"), "pass"], [unledgeredImageKey(FIRST_IMG), "unexercised", "not_in_ledger"]],
    oversize: [[oversizeKey(null, FIRST_IMG), "pass"]],
  }), route("i12"));
});

browserTest("F1.3-I13 page script navigates the main frame during the probe (setTimeout 0 after load): oversize results in the cell unexercised (document_context_changed)", async (t) => {
  const path = "/img/i13.png";
  const elsewhere = route("i13-elsewhere");
  // The probe reads in an isolated world, so no page script can see it start.
  // The injected probe clock (see F1.3-I16) stands in: as each cell's probe
  // starts it runs location.assign in the page's own world, and it sets no
  // bound, so the probe waits behind the page's busy loops while the
  // navigation commits.
  const { same, other } = await origins(t);
  same.serve(route("i13"), page(img(`src="${path}" style="${OVERSIZED.style}"`), { head: busyAfterLoad(400) }));
  same.serve(path, pngFile(...OVERSIZED.natural));
  same.serve(elsewhere, page("<p>Synthetic navigation target</p>"));
  let browser;
  const probeClock = {
    now: () => 0,
    sleep: () => {
      browser.contexts().at(-1).pages()[0].evaluate((target) => location.assign(target), elsewhere).catch(() => {});
      return new Promise(() => {});
    },
  };
  const output = await capture(same, { routes: ["i13"], probeClock, onLaunch: (launched) => { browser = launched; } });
  const before = { same: same.takeLog(), other: other.takeLog() };
  eachCapture(output, "i13", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the page_load capture closed before the navigation`);
    assertLedgerUrls(part, [same.url(route("i13")), same.url(path)], viewport);
    assert.equal(part.problems.some((problem) => problem.code === "document_context_changed"), false, `setup (${viewport}): no navigation inside the network window`);
  });
  const { record, results } = await readCells(output);
  assertProbeStatus(record, route("i13"), "document_context_changed");
  assertResultSet(results, discardedProbeCells(same, "i13", path, "document_context_changed"), route("i13"));
  // The page script's own navigation (once per cell) is the only request
  // beyond the document and its image.
  assert.deepEqual(before, { same: requests([route("i13"), path, elsewhere]), other: [] }, "the origins received exactly the setup's requests and the script's navigation");
});

browserTest("F1.3-I14 probe slowed past 500 ms by an injected busy loop: oversize results in the cell unexercised (probe_timeout)", async (t) => {
  const path = "/img/i14.png";
  const { same, other, output } = await captureOne(t, "i14", ({ same: origin }) => {
    origin.serve(route("i14"), page(img(`src="${path}" style="${OVERSIZED.style}"`), { head: busyAfterLoad(400) }));
    origin.serve(path, pngFile(...OVERSIZED.natural));
  });
  assertRequestLog({ same, other }, { same: requests([route("i14"), path]) }, "setup");
  eachCapture(output, "i14", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i14")), same.url(path)], viewport);
  });
  const { record, results } = await readCells(output);
  assertProbeStatus(record, route("i14"), "probe_timeout");
  assertResultSet(results, discardedProbeCells(same, "i14", path, "probe_timeout"), route("i14"));
});

browserTest("F1.3-I15 page with 513 <img> elements: oversize results in the cell unexercised (image_cap_reached)", async (t) => {
  const path = "/img/i15.png";
  const { same, other, output } = await captureOne(t, "i15", ({ same: origin }) => {
    origin.serve(route("i15"), page(img(`src="${path}" style="${OVERSIZED.style}"`).repeat(513)));
    origin.serve(path, pngFile(...OVERSIZED.natural));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route("i15"), path]) }, "setup: one image request per cell");
  eachCapture(output, "i15", (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route("i15")), url], viewport);
    assertEntry(ledgerEntry(part, url), { request_count: 1, cache_request_count: 0 }, viewport);
  });
  const { record, results } = await readCells(output);
  assertProbeStatus(record, route("i15"), "image_cap_reached");
  // API assumption (contract :150-155, 1.3 Cost): the probe keeps the first
  // 512 <img>; the page reached its candidate cap, so every result kept for
  // it carries the page_coverage member with the cap code, and members
  // aggregate warning > review > unexercised > pass, so each result reads
  // unexercised / image_cap_reached and none is accept-eligible.
  const kept = Array.from({ length: 512 }, (_, index) => [oversizeKey(rid(url), imgPath(index + 1)), "unexercised", "image_cap_reached"]);
  assertResultSet(results, bothCells(route("i15"), {
    weight: [[doc(same, "i15"), "unexercised", "image_cap_reached"], [rid(url), "unexercised", "image_cap_reached"]],
    oversize: kept,
    capCode: "image_cap_reached",
  }), route("i15"));
});

// API assumption (F1.3-I16): capturePolishPageLoad takes an in-process
// options field `probeClock` ({ now(), sleep(ms) }; never env, argv or a
// file) and, when given, uses it for both 1.3 probe bounds: the 500 ms cell
// bound ends when `sleep(500)` (or a shorter remaining-budget bound) resolves,
// and the 10 s run budget is the clock time `now()` advanced while probes ran.
// Wall-clock overhead (contexts, CDP round trips, the busy loop) never
// reaches it. This clock is virtual: `now()` starts at 0 and only moves when
// a `sleep` resolves, to exactly the sleep's own deadline (call time + ms),
// one macrotask after the call, so a probe still held by the page loses the
// race to its bound and spends exactly the bound.
function virtualProbeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms) => {
      const deadline = time + ms;
      return new Promise((resolve) => setImmediate(() => {
        time = Math.max(time, deadline);
        resolve();
      }));
    },
  };
}

browserTest("F1.3-I16 run whose earlier cells consume the 10 s probe budget (injected slow probe): next cell's oversize results unexercised (probe_budget_exhausted)", { timeout: I16_TIMEOUT_MS }, async (t) => {
  // Eleven slow routes (22 cells) sort before the target. Each slow probe is
  // held by the page's busy loops (the F1.3-I14 stimulus); the injected clock ends
  // its 500 ms bound one macrotask after the probe starts, so every slow cell
  // that starts while budget remains is cut at the bound and spends exactly
  // 500 ms of clock time.
  const slow = Array.from({ length: 11 }, (_, index) => `i16-slow-${String(index + 1).padStart(2, "0")}`);
  const target = "i16-target";
  const { same, other } = await origins(t);
  for (const name of slow) {
    same.serve(route(name), page(img(`src="/img/i16-small.png" width="40" height="30"`), { head: busyAfterLoad(400) }));
  }
  same.serve("/img/i16-small.png", pngFile(40, 30));
  same.serve(route(target), page(img(`src="/img/i16.png" style="${OVERSIZED.style}"`)));
  same.serve("/img/i16.png", pngFile(...OVERSIZED.natural));
  const probeClock = virtualProbeClock();
  const output = await capture(same, { routes: [...slow, target], probeClock });
  assertRequestLog({ same, other }, {
    same: [...requests([...slow.map(route), route(target), "/img/i16.png"]), ...requests(["/img/i16-small.png"], slow.length * VIEWPORTS.length)],
  }, "setup");
  assert.deepEqual(output.plan.routes.map((entry) => entry.requested_route).at(-1), route(target), "setup: the target route is captured last");
  eachCapture(output, target, (part, viewport) => assert.equal(part.measurement_status, "complete", `setup (${viewport}): the target capture is complete`));
  const { record, results } = await readCells(output);
  assertProbeStatus(record, route(target), "probe_budget_exhausted");

  // The slow cells in capture order, each reason a literal from the setup.
  // On the injected clock each cut probe spends exactly 500 ms and nothing
  // else spends any, so cell n (0-based) starts at exactly n × 500 ms:
  // - cells 0 to 18 start at 0 to 9,000 ms and end at their bound inside
  //   the budget (probe_timeout);
  // - cell 19 starts at 9,500 ms with 500 ms of budget left, so the budget
  //   did not end before it; its 500 ms bound ends it at exactly 10,000 ms,
  //   the end of the budget (probe_timeout, the cell bound ended);
  // - cells 20 and 21 (i16-slow-11) start at 10,000 ms, after the budget
  //   ended (probe_budget_exhausted), like the target.
  const REASONS = [...Array(20).fill("probe_timeout"), ...Array(2).fill("probe_budget_exhausted")];
  assert.equal(probeClock.now(), 10_000, "setup: the injected clock advanced exactly 20 cut-probe bounds of 500 ms");
  const viewports = output.plan.viewports.map((viewport) => viewport.key);
  const order = slow.flatMap((name) => viewports.map((viewport) => [name, viewport]));
  assert.equal(order.length, 22, "setup: 22 slow cells before the target");
  order.forEach(([name, viewport], index) => {
    assert.equal(mediaWeightCell(record, route(name), viewport).probe_status, REASONS[index], `${route(name)} ${viewport} (cell ${index}): probe_status is ${REASONS[index]}`);
  });
  const slowExpected = order.flatMap(([name, viewport], index) => cellResults(route(name), viewport, {
    weight: [[doc(same, name), ...weightUnderCap(REASONS[index])], [rid(same.url("/img/i16-small.png")), ...weightUnderCap(REASONS[index])]],
    oversize: [oversizeUnderCap(REASONS[index])],
    capCode: REASONS[index],
  }));
  assertResultSet(results, [...slowExpected, ...discardedProbeCells(same, target, "/img/i16.png", "probe_budget_exhausted")], "the run");
});

browserTest("F1.3-I17 same-origin image request fails (connection reset): weight unexercised (capture_incomplete)", async (t) => {
  const path = "/img/i17.png";
  const { same, other, output } = await captureOne(t, "i17", ({ same: origin }) => {
    origin.serve(route("i17"), page(img(`src="${path}" width="40" height="30"`)));
    origin.serve(path, connectionReset());
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route("i17"), path]) }, "setup");
  eachCapture(output, "i17", (part, viewport) => {
    assertLedgerUrls(part, [same.url(route("i17")), url], viewport);
    assertEntry(ledgerEntry(part, url), { failed_request_count: 1, cross_origin_request_count: 0 }, `${viewport}: the request failed`);
    // The existing capture counts a failed same-origin dependency as
    // incomplete (dependency_request_failed).
    assert.equal(part.measurement_status, "incomplete", `setup (${viewport}): the failed request leaves the capture incomplete`);
  });
  const { results } = await readCells(output);
  // The failed image's weight reads
  // unexercised / capture_incomplete, as do the other results of the
  // incomplete cell (Evaluation order step 2). The pl-reset cells in
  // src/qc-real-1-3.browser.test.mjs carry the same literals.
  assertResultSet(results, bothCells(route("i17"), {
    weight: [[doc(same, "i17"), "unexercised", "capture_incomplete"], [rid(url), "unexercised", "capture_incomplete"]],
    oversize: [[oversizeKey(rid(url), FIRST_IMG), "unexercised", "capture_incomplete"]],
  }), route("i17"));
});

browserTest("F1.3-I19 loaded image styled width:0;height:0 with no hidden ancestor: oversize unexercised (not_rendered)", async (t) => {
  await notRenderedRow(t, "i19", (path) => img(`src="${path}" style="width:0;height:0"`), FIRST_IMG);
});

// ---------------------------------------------------------------------------
// Repair rows after challenge round 2 (classes I and S)

// A handler that answers each request for its path in turn within a cell:
// the n-th request gets handlers[n] (the last one repeats). The page handler
// calls reset() so each viewport's cell starts again at the first.
function inTurn(handlers) {
  let count = 0;
  const handler = (socket) => handlers[Math.min(count++, handlers.length - 1)](socket);
  handler.reset = () => { count = 0; };
  return handler;
}

const NO_STORE = ["Cache-Control: no-store"];

// Challenge P1-1, browser leg. Two <img> name one URL; the second
// (crossorigin, so the document cannot reuse the first one's response) is
// inserted when the first loads, so the stub sees two image requests for
// /img/p1.png in a known order. One request is answered 200 directly, the
// other 302 to /img/p1-final.png. Both <img> keep currentSrc /img/p1.png.
// `order` names which answer comes first. The ledger's /img/p1.png entry
// mixes a redirect and a non-redirect status, so the URL is bound to two
// request chains: no result of the cell may pass or be accept-eligible, and
// both orders read the same.
async function twoChainRow(t, name, order) {
  const path = `/img/${name}.png`;
  const finalPath = `/img/${name}-final.png`;
  const direct = respond("200 OK", "image/png", png(40, 30), NO_STORE);
  const redirected = respond("302 Found", null, Buffer.alloc(0), [`Location: ${finalPath}`, ...NO_STORE]);
  const image = inTurn(order === "direct-first" ? [direct, redirected] : [redirected, direct]);
  const document = page(img(`src="${path}" width="40" height="30" onload="if(!window.second){window.second=1;document.body.insertAdjacentHTML('beforeend','<img alt=&quot;&quot; src=&quot;${path}&quot; crossorigin=&quot;anonymous&quot; width=&quot;40&quot; height=&quot;30&quot;>')}"`));
  const { same, other, output } = await captureOne(t, name, ({ same: origin }) => {
    origin.serve(route(name), (socket) => {
      image.reset();
      document(socket);
    });
    origin.serve(path, image);
    origin.serve(finalPath, respond("200 OK", "image/png", png(40, 30), NO_STORE));
  });
  const url = same.url(path);
  assertRequestLog({ same, other }, { same: requests([route(name), path, path, finalPath]) }, `setup (${order})`);
  eachCapture(output, name, (part, viewport) => {
    assert.equal(part.measurement_status, "complete", `setup (${order} ${viewport}): the capture is complete`);
    assertLedgerUrls(part, [same.url(route(name)), url, same.url(finalPath)], `${order} ${viewport}`);
    assertEntry(ledgerEntry(part, url), { request_count: 2, statuses: [200, 302], resource_type: "image" }, `${order} ${viewport}: one URL, a direct and a redirected request`);
  });
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const images = mediaWeightCell(record, route(name), viewport).images;
    assert.deepEqual(images.map((entry) => entry.resource_id), [rid(url), rid(url)], `setup (${order} ${viewport}): both <img> name /img/${name}.png`);
  }
  for (const row of results) {
    assert.notEqual(row.result, "pass", `${order} ${row.check} ${row.subject.key}: never pass from one of two chains`);
    assert.equal(row.accept_eligible, false, `${order} ${row.check} ${row.subject.key}: not accept-eligible`);
  }
  return { same, results };
}

browserTest("P1-1 one image URL requested twice, once direct and once redirected: no 1.3 result passes and both request orders read the same", async (t) => {
  // Each order's full result set, with the route's own names masked so the
  // two orders compare.
  const expected = (same, name) => bothCells(route(name), {
    weight: [doc(same, name), rid(same.url(`/img/${name}.png`)), rid(same.url(`/img/${name}-final.png`))].map((key) => [key, "unexercised", "evidence_not_reproducible"]),
    oversize: [FIRST_IMG, imgPath(2)].map((path) => [oversizeKey(rid(same.url(`/img/${name}.png`)), path), "unexercised", "evidence_not_reproducible"]),
  });
  for (const [name, order] of [["p1-direct", "direct-first"], ["p1-redirect", "redirect-first"]]) {
    const { same, results } = await twoChainRow(t, name, order);
    assertResultSet(results, expected(same, name), `${route(name)} (${order})`);
  }
});

// Candidate S: an SVG served from a blob: URL. Contract 1.3 (:975) makes an
// SVG unexercised / vector_image. The capture cannot read a blob: source's
// type (the probe reads the scheme alone and adds no request), so the image
// may be SVG: its oversize result reads unexercised with the code the
// contract gives an <img> whose currentSrc has no ledger entry
// (not_in_ledger), never pass.
browserTest("S an <img> showing an SVG from a blob: URL: source type unreadable, oversize unexercised (not_in_ledger), weight not_in_ledger", async (t) => {
  const stimulus = `<!doctype html><link rel="icon" href="data:,"><img width="300" height="150"><script>const svg='<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"/>';document.querySelector('img').src=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));</script>`;
  const { same, other, output } = await captureOne(t, "s-blob", ({ same: origin }) => {
    origin.serve(route("s-blob"), respond("200 OK", "text/html; charset=utf-8", stimulus));
  });
  assertRequestLog({ same, other }, { same: requests([route("s-blob")]) }, "setup");
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const [probed] = mediaWeightCell(record, route("s-blob"), viewport).images;
    assert.equal(probed.resource_id, null, `setup (${viewport}): a blob: currentSrc has no ledger identity`);
    assert.equal(probed.complete, true, `setup (${viewport}): the blob: SVG loaded`);
    assert.equal(probed.vector, null, `${viewport}: the source type is recorded as unknown`);
  }
  assertResultSet(results, bothCells(route("s-blob"), {
    weight: [[doc(same, "s-blob"), "pass"], [unledgeredImageKey(FIRST_IMG), "unexercised", "not_in_ledger"]],
    oversize: [[oversizeKey(null, FIRST_IMG), "unexercised", "not_in_ledger"]],
  }), route("s-blob"));
});

// ---------------------------------------------------------------------------
// Every probe read comes from its isolated world: a page script that
// overrides a DOM method, getter or window property the probe could read
// neither changes what it reads nor is ever called by it. Each override
// reports a call with a synchronous request to /called/<name>, which the
// origin's request log would show. Each page shows the OVERSIZED image
// (F = 8), so the true outcome is image_oversized; every override, if read,
// would make it pass.

const reportCall = `const called = (name) => { const xhr = new XMLHttpRequest(); xhr.open("GET", "/called/" + name, false); try { xhr.send(); } catch {} };`;
const PAGE_OVERRIDES = Object.freeze({
  // The <img> listing: an empty list for any query that names img.
  "query-selector-all": `const all = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function querySelectorAll(selector) {
      if (!/img/i.test(selector)) return all.call(this, selector);
      called("querySelectorAll");
      return all.call(this, "#nothing-matches");
    };`,
  // The rendered box: the natural size, so F = 1.
  "bounding-client-rect": `Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      called("getBoundingClientRect");
      return new DOMRect(0, 0, 2400, 1800);
    };`,
  // The device pixel ratio: 8, so F = 1.
  "device-pixel-ratio": `Object.defineProperty(window, "devicePixelRatio", { configurable: true, get() { called("devicePixelRatio"); return 8; } });`,
  // The natural size: the rendered box, under the area floor.
  "natural-size": `for (const [name, value] of [["naturalWidth", 300], ["naturalHeight", 225]]) {
      Object.defineProperty(HTMLImageElement.prototype, name, { configurable: true, get() { called(name); return value; } });
    }`,
  // The computed style: object-fit none, so s = 1 and F = 1.
  "computed-style": `window.getComputedStyle = function getComputedStyle() {
      called("getComputedStyle");
      return { display: "inline", visibility: "visible", objectFit: "none" };
    };`,
});

for (const [name, override] of Object.entries(PAGE_OVERRIDES)) {
  browserTest(`a page script that overrides ${name} neither changes the image probe's read nor is called by it: the oversized image warns (image_oversized)`, async (t) => {
    const key = `override-${name}`;
    const path = `/img/${key}.png`;
    const { same, other, output } = await captureOne(t, key, ({ same: origin }) => {
      origin.serve(route(key), page(img(`src="${path}" style="${OVERSIZED.style}"`), { head: `<script>${reportCall} ${override}</script>` }));
      origin.serve(path, pngFile(...OVERSIZED.natural));
    });
    assertRequestLog({ same, other }, { same: requests([route(key), path]) }, `${name}: no overridden method was called (no /called/ request)`);
    const { record, results } = await readCells(output);
    for (const viewport of VIEWPORTS) {
      const cell = mediaWeightCell(record, route(key), viewport);
      assert.equal(cell.probe_status, "complete", `${name} ${viewport}: the probe completed`);
      assert.equal(cell.dpr, 1, `${name} ${viewport}: the observed device pixel ratio`);
      const probed = recordImage(cell, same.url(path));
      assert.deepEqual([probed.natural, probed.rendered, probed.object_fit], [OVERSIZED.natural, [300, 225], "fill"], `${name} ${viewport}: the true geometry and fit`);
    }
    assertResultSet(results, bothCells(route(key), {
      weight: [[doc(same, key), "pass"], [rid(same.url(path)), "pass"]],
      oversize: [[oversizeKey(rid(same.url(path)), FIRST_IMG), "warning", "image_oversized"]],
    }), route(key));
  });
}

// ---------------------------------------------------------------------------
// Shadow trees and iframes. An <img> inside an open or a closed shadow root
// is part of the page and is listed, with a "#shadow-root" step after its
// host in the element path; a hidden host hides it. An <img> inside an iframe
// belongs to another document: a stated coverage limit, so the cell lists no
// <img> and its oversize result keyed "cell" reads pass.

const LARGE = { natural: [2000, 2000], style: "width:200px;height:200px" };
const SHADOW_IMG = "body>div:nth-of-type(1)>#shadow-root>img:nth-of-type(1)";

async function shadowRow(t, name, body, expected) {
  const path = `/img/${name}.png`;
  const { same, other, output } = await captureOne(t, name, ({ same: origin }) => {
    origin.serve(route(name), page(body(img(`src="${path}" style="${LARGE.style}"`))));
    origin.serve(path, pngFile(...LARGE.natural));
  });
  assertRequestLog({ same, other }, { same: requests([route(name), path]) }, "setup");
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    const cell = mediaWeightCell(record, route(name), viewport);
    assert.equal(cell.probe_status, "complete", `${name} ${viewport}: the probe completed`);
    assert.deepEqual(cell.images.map((image) => image.element_path), [SHADOW_IMG], `${name} ${viewport}: the shadow-tree <img> is listed`);
  }
  assertResultSet(results, bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(same.url(path)), "pass"]],
    oversize: [[oversizeKey(rid(same.url(path)), SHADOW_IMG), ...expected]],
  }), route(name));
}

browserTest("an <img> in a declarative open shadow root, 2000×2000 shown at 200×200: oversize warning (image_oversized), not a cell pass", async (t) => {
  await shadowRow(t, "shadow-open", (image) => `<div><template shadowrootmode="open">${image}</template></div>`, ["warning", "image_oversized"]);
});

browserTest("an <img> in a closed shadow root attached by script, 2000×2000 shown at 200×200: oversize warning (image_oversized), not a cell pass", async (t) => {
  await shadowRow(t, "shadow-closed", (image) => `<div></div><script>document.querySelector("div").attachShadow({ mode: "closed" }).innerHTML = ${JSON.stringify(image)};</script>`, ["warning", "image_oversized"]);
});

browserTest("an <img> in an open shadow root whose host is display:none: oversize unexercised (not_rendered)", async (t) => {
  await shadowRow(t, "shadow-hidden", (image) => `<div style="display:none"><template shadowrootmode="open">${image}</template></div>`, ["unexercised", "not_rendered"]);
});

browserTest("an <img> inside a same-origin iframe is outside the probe (a stated coverage limit): the cell lists no <img> and reads oversize pass keyed cell", async (t) => {
  const name = "iframe-limit";
  const frame = `/frames/${name}.html`;
  const path = `/img/${name}.png`;
  const { same, other, output } = await captureOne(t, name, ({ same: origin }) => {
    origin.serve(route(name), page(`<iframe src="${frame}" style="width:400px;height:400px;border:0"></iframe>`));
    origin.serve(frame, page(img(`src="${path}" style="${LARGE.style}"`)));
    origin.serve(path, pngFile(...LARGE.natural));
  });
  assertRequestLog({ same, other }, { same: requests([route(name), frame, path]) }, "setup: the frame loaded its image");
  const { record, results } = await readCells(output);
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(mediaWeightCell(record, route(name), viewport).images, [], `${name} ${viewport}: the probe does not enter the iframe's document`);
  }
  assertResultSet(results, bothCells(route(name), {
    weight: [[doc(same, name), "pass"], [rid(same.url(frame)), "pass"], [rid(same.url(path)), "pass"]],
    oversize: [[NO_IMAGE_KEY, "pass"]],
  }), route(name));
});
