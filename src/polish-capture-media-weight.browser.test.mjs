// `polish capture` through its CLI report path attaches media_weight beside
// page_load. The 1.3 browser rows in src/polish-media-weight.browser.test.mjs
// and src/qc-real-1-3.browser.test.mjs call the producer and install its
// output on the report themselves; here the report is written only by the
// command: polishCaptureCommand on the arguments parseArgs gives it, the call
// `main` dispatches for `polish capture`, with real Chromium against a
// loopback stub origin. Results are then read the way every reader reads them
// (the registry's real 1.3 rules) and through `next`'s QC handoff.
//
// The campaign fixture (src/qc-test-factories.mjs) maps four routes. Only the
// landing route holds an image: one same-origin 600,000 B complete PNG
// (F1.3-B2), 40×30 natural pixels, under the 250,000 px area floor, so its
// oversize result passes. The other routes are text pages: the document's
// weight passes and oversize lists one "cell" result that passes. The built
// site is the one root page the fixture writes; `polish capture` measures its
// readability as well (every built page, at both widths), so the stub serves
// it too.
//
// No network beyond loopback: src/qc-test-factories.mjs is imported first and
// installs its Node-side guard before any module under test loads (the CLI is
// imported dynamically below); every capture runs Chromium through the
// harness's loopback-watched launcher, the only option given to the command;
// and the stub origin's complete request log up to the frozen measurement is
// compared with the setup's.
import assert from "node:assert/strict";
import { relative } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  OTHER_BUILD_FP,
  SLUG,
  assertAccepted,
  assertNoNetworkAttempts,
  campaignFixture,
  countReportWrites,
  delay,
  doctorOf,
  handoffOf,
  mutateReport,
  readBytes,
  readJson,
  refOf,
  runAccept,
  runCli,
  runNext,
  writeSitePage,
} from "./qc-test-factories.mjs";
import {
  NO_IMAGE_KEY,
  VIEWPORTS,
  assertResultSet,
  bothCells,
  browserTest,
  browserUnavailableNote,
  imgPath,
  ledgerEntry,
  loopbackGuard,
  oversizeKey,
  page,
  pageLoadCapture,
  pngWire,
  readResults,
  requests,
  resultRow,
  rid,
  route,
  stubOrigin,
} from "./polish-media-weight-harness.browser.test.mjs";

const { parseArgs, polishCaptureCommand } = await import("./cli.mjs");

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());
if (browserUnavailableNote) test.skip(browserUnavailableNote, () => {});

const LANDING = route("landing");
const TEXT_ROUTES = Object.freeze(["checkout", "receipt", "upsell"].map(route));
const IMAGE_PATH = "/img/landing-hero.png";
const BUILT_ROOT = `/${SLUG}/`;

// A campaign whose report names its packet (`polish capture` binds to it) and
// records the build `record build` measured, and a stub origin serving every
// route the packet maps.
async function campaign(t) {
  const f = campaignFixture({ setupCompleted: true, site: true });
  t.after(f.cleanup);
  mutateReport(f, (report) => {
    report.inputs.packet_path = relative(f.targetRepo, f.packetPath);
  });
  const built = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(built.exitCode, 0, built.error?.message);
  const same = await stubOrigin();
  t.after(() => same.close());
  same.serve(LANDING, page(`<img alt="" src="${IMAGE_PATH}" width="40" height="30">`));
  same.serve(IMAGE_PATH, pngWire(40, 30, 600_000));
  for (const path of TEXT_ROUTES) same.serve(path, page("<p>Synthetic copy</p>"));
  same.serve(BUILT_ROOT, page("<p>synthetic build one</p>"));
  return { f, same, image: same.url(IMAGE_PATH), buildOne: readJson(f.reportPath).stages.assembly.build_fingerprint };
}

// One `polish capture` run, counting every write that lands on the Assembly
// Report. `afterCapture` is the command's own hook, called with the capture
// once the browser pass ends and before the report commit.
//
// The request log is split at the command's `onFrozen` hook, called once the
// page_load (and media_weight) measurement is frozen. Everything before it is
// the measurement and must be exactly the setup's requests; the always-on
// visual pass (contract §2.1) renders the measured routes again afterwards,
// and those requests may only re-read what page_load measured.
async function polishCapture({ f, same }, { afterCapture } = {}) {
  const { createPolishBrowserAdapter } = await import("./polish-browser.mjs");
  const guard = loopbackGuard();
  const chromium = {
    async launch(options) {
      const { chromium: real } = await import("playwright");
      return guard.instrument(await real.launch(options));
    },
  };
  const args = parseArgs(["polish", "capture", "--packet", f.packetPath, "--base-url", `${same.origin}/`, "--json"]);
  let failure = null;
  let measured = null;
  let frozenMediaWeight = null;
  const { value: result, count: reportWrites } = await countReportWrites(f, async () => {
    try {
      return await polishCaptureCommand(args, {
        createBrowserAdapter: (options) => createPolishBrowserAdapter({ ...options, chromium }),
        onFrozen(frozen) {
          measured = same.takeLog();
          frozenMediaWeight = frozen.media_weight === undefined ? undefined : JSON.parse(JSON.stringify(frozen.media_weight));
        },
        ...(afterCapture ? { afterCapture } : {}),
      });
    } catch (error) {
      failure = error;
      return null;
    }
  });
  guard.assertLoopbackOnly();
  assertNoNetworkAttempts();
  const label = `setup (the command ${failure ? `threw: ${failure.message}` : "returned"})`;
  assert.ok(measured, `${label}: the page_load measurement was frozen`);
  assert.deepEqual(measured, requests([LANDING, ...TEXT_ROUTES, BUILT_ROOT, IMAGE_PATH]), `${label}: up to the freeze, the same origin received exactly the requests the page_load measurement implies, nothing more`);
  const remeasured = new Set([LANDING, ...TEXT_ROUTES, IMAGE_PATH].map((path) => `GET ${path}`));
  const afterFreeze = same.takeLog();
  assert.deepEqual(afterFreeze.filter((line) => !remeasured.has(line)), [], `${label}: after the freeze, the visual pass requests only what page_load measured`);
  return { result, failure, reportWrites, frozenMediaWeight };
}

// Every 1.3 result the setup implies, by subject.
function expectedResults({ same, image }) {
  const textCell = (path) => bothCells(path, { weight: [[rid(same.url(path)), "pass"]], oversize: [[NO_IMAGE_KEY, "pass"]] });
  return [
    ...bothCells(LANDING, {
      weight: [[rid(same.url(LANDING)), "pass"], [rid(image), "warning", "image_over_threshold"]],
      oversize: [[oversizeKey(rid(image), imgPath(1)), "pass"]],
    }),
    ...TEXT_ROUTES.flatMap(textCell),
  ];
}

// The handoff's Polish view, every field a reader acts on.
const polishOpen = (handoff) => (handoff.open || []).filter((entry) => entry.leg === "polish").map((entry) => ({
  check: entry.check,
  key: entry.key,
  pages: entry.pages,
  result: entry.result,
  reason_code: entry.reason_code,
  accept_eligible: entry.accept_eligible,
  members: entry.members,
  results: entry.results.map((row) => ({
    result_ref: row.result_ref,
    page: row.page,
    viewport: row.viewport,
    result: row.result,
    reason_code: row.reason_code,
    accept_eligible: row.accept_eligible,
    members: row.members,
  })),
}));

// Every parity.element row as `next` reads it: readCurrentQcResults with the
// registry's real rules and the real doctor run.
async function parityRowsOf(f) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readCurrentQcResults } = await import("./qc-results.mjs");
  const { results } = readCurrentQcResults({
    report: readJson(f.reportPath),
    doctor: doctorOf(f.packetPath),
    spec: readJson(f.specPath),
    targetRepo: f.targetRepo,
    packetPath: f.packetPath,
    rederivers: await loadQcRederivers(),
  });
  return results.filter((row) => row?.check === "parity.element");
}

// The shared run: one capture on a fresh campaign, and what the report and
// `next` show right after it. T2 continues on the same campaign; this
// snapshot is taken before it changes anything.
let shared = null;
const sharedCleanup = [];
after(async () => {
  for (const cleanup of sharedCleanup.reverse()) await cleanup();
});
function capturedCampaign() {
  shared ??= (async () => {
    const state = await campaign({ after: (cleanup) => sharedCleanup.push(cleanup) });
    const before = readJson(state.f.reportPath).stages.polish?.evidence?.visual_review || {};
    const run = await polishCapture(state);
    const report = readJson(state.f.reportPath);
    const handoff = handoffOf(await runNext(state.f));
    return { ...state, before, run, report, handoff, parityRows: await parityRowsOf(state.f) };
  })();
  return shared;
}

browserTest("polish capture commits media_weight beside page_load in one report write, and the QC handoff reads the F1.3-B2 warning (image_over_threshold)", async () => {
  const state = await capturedCampaign();
  const { run, report, handoff, before, image, buildOne } = state;
  assert.equal(run.failure, null, `polish capture succeeded: ${run.failure?.message}`);
  assert.equal(run.result.ok, true, `polish capture reports ok: ${JSON.stringify(run.result?.checkpoint)}`);
  assert.equal(Object.hasOwn(before, "page_load") || Object.hasOwn(before, "media_weight"), false, "setup: the report held no capture evidence before the run");

  const visual = report.stages.polish.evidence.visual_review;
  assert.ok(visual.page_load, "the report carries page_load");
  for (const viewport of VIEWPORTS) {
    assert.equal(ledgerEntry(pageLoadCapture(visual.page_load, LANDING, viewport), image)?.transferred_bytes, 600_000, `setup (${viewport}): F1.3-B2, 600,000 B complete`);
  }
  assert.ok(
    visual.media_weight && typeof visual.media_weight === "object",
    `the report carries media_weight beside page_load (visual_review keys ${JSON.stringify(Object.keys(visual))}; the handoff's Polish coverage ${JSON.stringify((handoff.coverage || []).filter((entry) => entry.leg === "polish").map((entry) => [entry.check, entry.result, entry.reason_code]))})`,
  );
  assert.equal(run.reportWrites, 1, "page_load and media_weight reach the report in one write");
  assert.deepEqual(visual.media_weight, run.frozenMediaWeight, "the committed media_weight is the record frozen with page_load; the visual pass after it changes nothing");

  // Bound to the page_load it was committed with: the same subject (the
  // build `record build` measured), and each cell stamped with its page_load
  // capture's integrity.
  const mediaWeight = visual.media_weight;
  assert.equal(mediaWeight.schema_version, "campaigns-os-polish-media-weight/v0");
  assert.equal(mediaWeight.performed_by, visual.page_load.performed_by, "both records name the package producer");
  assert.deepEqual(mediaWeight.subject, visual.page_load.subject, "media_weight carries its page_load subject");
  assert.equal(mediaWeight.subject.build_fingerprint, buildOne, "both records are bound to the recorded build");
  assert.deepEqual(
    mediaWeight.cells.map((cell) => [cell.route, cell.viewport, cell.page_load_integrity]).sort(),
    visual.page_load.captures.map((capture) => [capture.subject.requested_route, capture.subject.viewport, capture.integrity.projection_fingerprint]).sort(),
    "one media_weight cell per page_load capture, each stamped with that capture's integrity",
  );

  // The persisted pair reads exactly the setup's results.
  const results = await readResults({ media_weight: mediaWeight, page_load: visual.page_load }, { currentBuild: buildOne });
  assertResultSet(results, expectedResults(state), "the committed record");

  // `next` reads the same: the warning is open in both viewports, nothing
  // Polish sits in coverage, and no result reads as missing evidence.
  const warning = (viewport) => resultRow(results, "media.weight", LANDING, viewport, rid(image));
  assert.deepEqual(polishOpen(handoff), [{
    check: "media.weight",
    key: rid(image),
    pages: [LANDING],
    result: "warning",
    reason_code: "image_over_threshold",
    accept_eligible: true,
    members: [],
    results: VIEWPORTS.map((viewport) => ({
      result_ref: refOf(warning(viewport)),
      page: LANDING,
      viewport,
      result: "warning",
      reason_code: "image_over_threshold",
      accept_eligible: true,
      members: [],
    })).sort((a, b) => a.viewport.localeCompare(b.viewport)),
  }], "qc_handoff.open lists exactly the F1.3-B2 warning, in both viewports");
  // Element parity is applicable (mapped pages) but this example campaign has
  // no Design Source Package, so its comparisons read source_package_unavailable;
  // the element rows the probe files name are refused with them (identities kept).
  // How many element rows there are depends on rendering (font metrics), so
  // only their shape is pinned: one comparison row per page and viewport,
  // and every other row a copy/type/color/geom identity, all refused.
  const parityPages = ["checkout", "landing", "receipt", "upsell"];
  const { parityRows } = state;
  const comparisonRows = parityRows.filter((row) => row.subject?.key === "comparison");
  const elementRows = parityRows.filter((row) => row.subject?.key !== "comparison");
  assert.deepEqual(
    comparisonRows.map((row) => [row.subject.page, row.subject.viewport, row.result, row.reason_code]).sort(),
    parityPages.flatMap((pageId) => VIEWPORTS.map((viewport) => [pageId, viewport, "unexercised", "source_package_unavailable"])).sort(),
    "one comparison row per page and viewport, each source_package_unavailable",
  );
  for (const row of elementRows) {
    assert.match(row.subject?.key ?? "", /^(copy|type|color|geom):el-[a-f0-9]{12}$/, "every other parity row is an element identity row");
    assert.deepEqual([row.result, row.reason_code], ["unexercised", "source_package_unavailable"], `${row.subject.key} is refused with its comparison`);
  }
  // Comparison and type rows carry the font-usage limit.
  const typeRows = elementRows.filter((row) => row.subject.key.startsWith("type:")).length;
  assert.deepEqual((handoff.coverage || []).filter((entry) => entry.leg === "polish"), [
    { check: "parity.element", leg: "polish", result: "limit", reason_code: "font_usage_not_observed", count: comparisonRows.length + typeRows, pages: parityPages,
      text: "The font each glyph was drawn with is not read; a web font that loaded is assumed used." },
    { check: "parity.element", leg: "polish", result: "unexercised", reason_code: "source_package_unavailable", count: parityRows.length, pages: parityPages,
      text: "The Design Source Package on disk does not match the build's; rerun intake or polish capture." },
  ], "no other Polish result is unexercised or excluded");
  // Every comparison that ran reads review (visual_diff_diagnostic, contract
  // §5.3): one visual.diff row per captured page and viewport against the
  // build's own source HTML, so the basis is not independent and the fixture's
  // pages carry no section keys.
  const polishReview = (handoff.review || []).filter((entry) => entry.leg === "polish");
  assert.deepEqual(
    polishReview.filter((entry) => entry.check === "visual.diff").map((entry) => ({
      result_ref: entry.result_ref.replace(/@[0-9a-f]+$/, "@"),
      page: entry.page,
      viewport: entry.viewport,
      key: entry.key,
      result: entry.result,
      reason_code: entry.reason_code,
      accept_eligible: entry.accept_eligible,
      members: entry.members,
    })).sort((a, b) => a.result_ref.localeCompare(b.result_ref)),
    [LANDING, ...TEXT_ROUTES].flatMap((path) => VIEWPORTS.map((viewport) => ({
      result_ref: `visual.diff:${path}:${viewport}:source_html@`,
      page: path,
      viewport,
      key: "source_html",
      result: "review",
      reason_code: "visual_diff_diagnostic",
      accept_eligible: false,
      members: [
        { key: "sections", result: "unexercised", reason_code: "no_section_keys" },
        { key: "basis", result: "review", reason_code: "basis_not_independent" },
      ],
    }))).sort((a, b) => a.result_ref.localeCompare(b.result_ref)),
    "qc_handoff.review lists one visual.diff diagnostic per captured page and viewport",
  );
  // The fixture's source-HTML reference records no sha256, so each page's
  // reference verifies but its provenance is unknown (contract §5.2).
  assert.deepEqual(
    polishReview.filter((entry) => entry.check === "visual.reference").map((entry) => ({
      result_ref: entry.result_ref.replace(/@[0-9a-f]+$/, "@"),
      page: entry.page,
      key: entry.key,
      result: entry.result,
      reason_code: entry.reason_code,
      accept_eligible: entry.accept_eligible,
      members: entry.members,
    })).sort((a, b) => a.result_ref.localeCompare(b.result_ref)),
    [LANDING, ...TEXT_ROUTES].map((path) => ({
      result_ref: `visual.reference:${path}:source_html@`,
      page: path,
      key: "source_html",
      result: "review",
      reason_code: "provenance_unknown",
      accept_eligible: false,
      members: [
        { key: "verification", result: "pass", reason_code: null },
        { key: "provenance", result: "review", reason_code: "provenance_unknown" },
      ],
    })).sort((a, b) => a.result_ref.localeCompare(b.result_ref)),
    "qc_handoff.review lists one visual.reference provenance_unknown row per captured page",
  );
  assert.deepEqual(polishReview.filter((entry) => entry.check !== "visual.diff" && entry.check !== "visual.reference"), [], "no other Polish result is under review");
  assert.equal(JSON.stringify(handoff).includes("not_captured_by_this_version"), false, "the handoff never reads not_captured_by_this_version");
});

browserTest("F1.0-B9 through polish capture: accepted F1.3-B2, then record build records a new build fingerprint: accept lapsed (stale_binding)", async () => {
  const state = await capturedCampaign();
  const { f, image, buildOne } = state;
  assert.equal(state.run.failure, null, `setup: polish capture succeeded: ${state.run.failure?.message}`);
  const visual = () => readJson(f.reportPath).stages.polish.evidence.visual_review;
  assert.ok(visual().media_weight, "setup: polish capture committed media_weight");
  const firstRead = await readResults({ media_weight: visual().media_weight, page_load: visual().page_load }, { currentBuild: buildOne });
  const warning = resultRow(firstRead, "media.weight", LANDING, "desktop", rid(image));
  assert.deepEqual([warning.result, warning.reason_code], ["warning", "image_over_threshold"], "setup: F1.3-B2 reads warning");

  await delay(5);
  assertAccepted(await runAccept(f, [refOf(warning)]));
  const accepted = (handoffOf(await runNext(f)).accepted || []).filter((entry) => entry.result_ref === refOf(warning));
  assert.equal(accepted.length, 1, "the accept applies on the build it was given on");

  writeSitePage(f, "<p>synthetic build two</p>");
  const rebuilt = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(rebuilt.exitCode, 0, rebuilt.error?.message);
  const report = readJson(f.reportPath);
  const buildTwo = report.stages.assembly.build_fingerprint;
  assert.notEqual(buildTwo, buildOne, "record build recorded a new build fingerprint");

  const current = await readResults({ media_weight: report.stages.polish.evidence.visual_review.media_weight, page_load: report.stages.polish.evidence.visual_review.page_load }, { currentBuild: buildTwo });
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const assessments = assessQcAccepts(report.qc_accepts, current, { now: new Date().toISOString() });
  assert.deepEqual(assessments.map((entry) => [entry.status, entry.why]), [["lapsed", "stale_binding"]], "the one accept reads lapsed (stale_binding)");
  const handoff = handoffOf(await runNext(f));
  assert.deepEqual(
    (handoff.lapsed || []).map((entry) => [entry.result_id, entry.why]),
    [[warning.id, "stale_binding"]],
    "qc_handoff.lapsed lists exactly the accepted result, lapsed for stale_binding",
  );
  assert.deepEqual((handoff.accepted || []).filter((entry) => entry.leg === "polish"), [], "the lapsed accept no longer applies");
});

// The commit never attaches a media_weight the merge refuses. The
// producer's media_weight is replaced in process through the command's
// afterCapture hook, after the browser pass and before the commit, so the
// command runs unchanged on a real capture with a foreign record in hand.
for (const [label, tamper, message] of [
  [
    "an agent-written media_weight (performed_by \"agent\")",
    (record) => ({ ...record, performed_by: "agent" }),
    /package-produced media_weight/,
  ],
  [
    "a media_weight bound to another capture (a different build in its subject)",
    (record) => ({ ...record, subject: { ...record.subject, build_fingerprint: OTHER_BUILD_FP } }),
    /same page_load capture/,
  ],
]) {
  browserTest(`polish capture refuses ${label} and writes neither record`, async (t) => {
    const state = await campaign(t);
    const before = readBytes(state.f.reportPath);
    let produced = null;
    const run = await polishCapture(state, {
      afterCapture({ capture }) {
        produced = capture.media_weight;
        capture.media_weight = tamper(capture.media_weight);
      },
    });
    assert.ok(produced && typeof produced === "object", "setup: the producer returned a media_weight record");
    assert.deepEqual(produced, run.frozenMediaWeight, "setup: afterCapture saw the media_weight frozen with page_load");
    assert.ok(run.failure instanceof Error, `polish capture refuses the record (it returned ${JSON.stringify(run.result?.status ?? null)})`);
    assert.match(run.failure.message, message);
    assert.equal(run.reportWrites, 0, "nothing is written to the report: not page_load alone, not either record");
    assert.ok(readBytes(state.f.reportPath).equals(before), "the Assembly Report bytes are unchanged");
  });
}
