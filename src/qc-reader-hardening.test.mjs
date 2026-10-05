// Regression tests that harden the QC readers and `checkpoint accept`: every
// set a reader consumes is derived from the raw capture, the full verdict never
// resolves to the committed sidecar, no applicable check is silent, a refusal
// writes nothing, and the QC handoff lists a shared warning once. One test per
// defect class; every setup is synthetic and uses the shared QC test factory
// unchanged.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  OPERATOR,
  ORIGIN,
  OTHER_ORIGIN,
  ROUTES,
  SLUG,
  assertAccepted,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  delay,
  fixedDoctorId,
  fixedDoctorStandIn,
  fullVerdict,
  handoffOf,
  installPolishEvidence,
  installQaStage,
  liveTokenId,
  liveTokenStandIn,
  mutateReport,
  polishStandIn,
  QA_RUN_ID,
  qaAssertionFor,
  qaObservation,
  qaRederive,
  qaRowFor,
  qaStandIns,
  qcRow,
  readJson,
  resourceIdOf,
  runAccept,
  runCli,
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
const NOT_CAPTURED = "not_captured_by_this_version";
const HERO = "/runtime-packet-demo/img/hero.jpg";
const HERO_KEY = resourceIdOf(`${ORIGIN}${HERO}`);
const SMALL = "/runtime-packet-demo/img/small.jpg";
const SMALL_KEY = resourceIdOf(`${ORIGIN}${SMALL}`);
const REDIRECT_FROM = `${OTHER_ORIGIN}/img/hero.jpg`;
const REDIRECT_KEY = resourceIdOf(REDIRECT_FROM);
const CONTROL_KEY = resourceIdOf(`${ORIGIN}/runtime-packet-demo/img/control.jpg`);

const clone = (value) => JSON.parse(JSON.stringify(value));

async function readMw({ record, pageLoad }) {
  const { readMediaWeight } = await import("./qc-results.mjs");
  return readMediaWeight({ record, pageLoad, currentBuild: BUILD_FP, qcStandIns: { polish: polishStandIn() } });
}

const weightRow = (results, route, key) => results.find((row) => row.check === "media.weight" && row.subject?.page === route && row.subject?.key === key);

function assertReads(results, route, key, result, reasonCode, label) {
  const row = weightRow(results, route, key);
  assert.ok(row, `${label}: ${route} ${key} is listed`);
  assert.equal(row.result, result, `${label}: ${route} ${key} reads ${result}`);
  assert.equal(row.reason_code, reasonCode, `${label}: ${route} ${key} reads ${reasonCode}`);
}

function assertNoPass(results, route, label) {
  const rows = results.filter((row) => route == null || row.subject?.page === route);
  assert.ok(rows.length > 0, `${label}: results are listed`);
  for (const row of rows) {
    assert.equal(row.result, "unexercised", `${label}: ${row.id} is never pass or warning`);
    assert.equal(row.reason_code, E, `${label}: ${row.id} reads ${E}`);
  }
}

// ---------------------------------------------------------------------------
// Every set the media_weight reader consumes is derived from page_load.

test("media_weight: a truncated chain, a dropped resource, a dropped cell and a dropped video read evidence_not_reproducible", async () => {
  // Truncated chain: only the requested 302 hop kept, its ledger fields copied
  // in, integrity recomputed. Untampered, the final hop is a same-origin
  // 600,000 B image (F1.3-B4) and reads a warning.
  const redirected = twoCellFixture([{ path: HERO, bytes: 600_000, redirectFrom: REDIRECT_FROM }]);
  assertReads(await readMw(redirected), ROUTES[0], REDIRECT_KEY, "warning", "image_over_threshold", "control: untampered chain");
  const truncated = clone(redirected.record);
  const resource = truncated.cells[0].resources[0];
  const hop = redirected.pageLoad.captures[0].resource_ledger.entries.find((entry) => entry.resource_id === resource.chain[0].resource_id);
  Object.assign(resource, {
    chain: [resource.chain[0]],
    type: hop.resource_type,
    transferred_bytes: hop.transferred_bytes,
    declared_bytes: null,
    measurement: "complete",
    failed: false,
    final_origin_equal: hop.cross_origin_request_count === 0,
  });
  const truncatedResults = await readMw({ record: withRecomputedIntegrity(truncated), pageLoad: redirected.pageLoad });
  assertReads(truncatedResults, ROUTES[0], REDIRECT_KEY, "unexercised", E, "truncated chain");
  assertReads(truncatedResults, ROUTES[1], CONTROL_KEY, "warning", "image_over_threshold", "truncated chain: control cell");

  // Dropped resource: the 600,000 B image removed from its cell.
  const two = twoCellFixture([{ path: HERO, bytes: 600_000 }, { path: SMALL, bytes: 1_000 }]);
  assertReads(await readMw(two), ROUTES[0], SMALL_KEY, "pass", null, "control: both resources listed");
  const dropped = clone(two.record);
  dropped.cells[0].resources = dropped.cells[0].resources.filter((entry) => entry.resource_id !== HERO_KEY);
  dropped.cells[0].images = dropped.cells[0].images.filter((image) => image.resource_id !== HERO_KEY);
  const droppedResults = await readMw({ record: withRecomputedIntegrity(dropped), pageLoad: two.pageLoad });
  assertNoPass(droppedResults, ROUTES[0], "dropped resource");
  assertReads(droppedResults, ROUTES[1], CONTROL_KEY, "warning", "image_over_threshold", "dropped resource: control cell");

  // Dropped cell: the record lists one of the two captured cells.
  const cells = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  const droppedCell = clone(cells.record);
  droppedCell.cells = [droppedCell.cells[0]];
  assertNoPass(await readMw({ record: withRecomputedIntegrity(droppedCell), pageLoad: cells.pageLoad }), null, "dropped cell");

  // Dropped video: the cell's <video> entry removed.
  const withVideo = twoCellFixture([{ path: HERO, bytes: 600_000 }], { firstCell: { videos: [{ path: "/runtime-packet-demo/media/intro.mp4" }] } });
  const videoControl = await readMw(withVideo);
  assertReads(videoControl, ROUTES[0], "video:0", "unexercised", "not_loaded", "control: the video is listed");
  assertReads(videoControl, ROUTES[0], HERO_KEY, "warning", "image_over_threshold", "control: the image warning");
  const droppedVideo = clone(withVideo.record);
  droppedVideo.cells[0].videos = [];
  const droppedVideoResults = await readMw({ record: withRecomputedIntegrity(droppedVideo), pageLoad: withVideo.pageLoad });
  assertNoPass(droppedVideoResults, ROUTES[0], "dropped video");
  assertReads(droppedVideoResults, ROUTES[1], CONTROL_KEY, "warning", "image_over_threshold", "dropped video: control cell");
});

// ---------------------------------------------------------------------------
// The full verdict never resolves to the committed sidecar or the report.

const qaWarningOpen = (handoff) => (handoff.open || []).some((entry) => entry.leg === "qa");
const qaCoverage = (handoff, check) => (handoff.coverage || []).filter((entry) => entry.leg === "qa" && entry.check === check).map((entry) => [entry.result, entry.reason_code]);

test("full verdict self-reference: a directory alias or a hard link onto the committed QA sidecar reads evidence_not_reproducible", async (t) => {
  const { readQaFullVerdict } = await import("./qc-results.mjs");
  const qcStandIns = { qa: qaStandIns() };

  // Control: the installed verdict reads, and its warning is open.
  const control = campaignFixture();
  t.after(control.cleanup);
  installQaStage(control);
  assert.ok(qaWarningOpen(handoffOf(await runNext(control, qcStandIns))), "control: the QA warning is open");

  // qa-output/ is a symlink to the committed sidecar's directory, and the
  // stage names only qa-output/qa-verdict.json, which is the sidecar file
  // holding a full-verdict-shaped copy.
  const aliased = campaignFixture();
  t.after(aliased.cleanup);
  const installed = installQaStage(aliased);
  const verdict = readJson(installed.verdictPath);
  const outputDir = join(aliased.targetRepo, "qa-output");
  rmSync(outputDir, { recursive: true, force: true });
  symlinkSync(dirname(aliased.qaSidecarPath), outputDir, "dir");
  writeJson(aliased.qaSidecarPath, verdict);
  mutateReport(aliased, (report) => {
    report.stages.qa.outputs = [join(outputDir, "qa-verdict.json")];
  });
  const aliasedStage = readJson(aliased.reportPath).stages.qa;
  assert.equal(readQaFullVerdict({ stage: aliasedStage, targetRepo: aliased.targetRepo, packetPath: aliased.packetPath, reportPath: aliased.reportPath }), null, "the aliased sidecar is never read as the full verdict");
  const aliasedHandoff = handoffOf(await runNext(aliased, qcStandIns));
  assert.equal(qaWarningOpen(aliasedHandoff), false, "directory alias: no QA result is open");
  assert.deepEqual(qaCoverage(aliasedHandoff, "policy.availability"), [["unexercised", E]], `directory alias: ${JSON.stringify(aliasedHandoff.coverage)}`);

  // The stage's verdict path is a hard link to the committed sidecar file.
  const linked = campaignFixture();
  t.after(linked.cleanup);
  const linkedInstall = installQaStage(linked);
  writeJson(linked.qaSidecarPath, readJson(linkedInstall.verdictPath));
  rmSync(linkedInstall.verdictPath);
  linkSync(linked.qaSidecarPath, linkedInstall.verdictPath);
  mutateReport(linked, (report) => {
    report.stages.qa.outputs = [linkedInstall.verdictPath];
  });
  const linkedHandoff = handoffOf(await runNext(linked, qcStandIns));
  assert.equal(qaWarningOpen(linkedHandoff), false, "hard link: no QA result is open");
  assert.deepEqual(qaCoverage(linkedHandoff, "policy.availability"), [["unexercised", E]], `hard link: ${JSON.stringify(linkedHandoff.coverage)}`);
});

// ---------------------------------------------------------------------------
// An accept never discards report state.

test("checkpoint accept: a qc_accepts or evidence value that is not an array is refused, untyped, and left byte-for-byte", async (t) => {
  for (const [field, value] of [["qc_accepts", { note: "synthetic malformed history" }], ["qc_accepts", null], ["evidence", "synthetic evidence text"]]) {
    const f = campaignFixture();
    t.after(f.cleanup);
    setBuiltPage(f, '<p class="cart-line">{item.name}</p>');
    const qcStandIns = { doctor: [liveTokenStandIn(f)] };
    const entry = (handoffOf(await runNext(f, qcStandIns)).open || []).find((candidate) => String(candidate.result_ref).startsWith(`${liveTokenId("{item.name}")}@`));
    assert.ok(entry, "setup: the live-token warning is open");
    mutateReport(f, (report) => {
      report[field] = value;
    });
    await delay(5);
    const before = snapshot(f);
    const res = await runAccept(f, [entry.result_ref], { qcStandIns });
    assert.notEqual(res.exitCode, 0, `${field}: refused`);
    assert.equal(res.json?.ok, false, `${field}: reports ok false`);
    assert.equal(res.json?.refusal_code, undefined, `${field}: no typed refusal code`);
    assert.match(res.json?.error || "", new RegExp(`report\\.${field}`), `${field}: the refusal names the field`);
    assertNothingWritten(f, before);
    assert.deepEqual(readJson(f.reportPath)[field], value, `${field}: the existing value stays`);
  }
});

// ---------------------------------------------------------------------------
// Every refusal writes nothing, the selected lifecycle journal included.

function acceptArgv(f, refs, { reason = "known synthetic", acceptedBy = "Jordan Lee", journal, json = true }) {
  const argv = ["checkpoint", "accept", "--packet", f.packetPath];
  for (const ref of refs) argv.push("--result", ref);
  if (reason != null) argv.push("--reason", reason);
  if (acceptedBy != null) argv.push("--accepted-by", acceptedBy);
  argv.push("--lifecycle-journal", journal);
  if (json) argv.push("--json");
  return argv;
}

test("checkpoint accept: every typed and untyped refusal creates no lifecycle journal and writes nothing", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  const specs = [
    { key: "plain", result: "warning", reason_code: "live_token" },
    { key: "unclear", result: "review", reason_code: "ambiguous_token" },
    { key: "mixed", result: "warning", reason_code: "live_token", accept_eligible: false, members: [{ key: "a", result: "warning", reason_code: "live_token" }, { key: "b", result: "review", reason_code: "ambiguous_token" }] },
  ];
  const qcStandIns = { doctor: [fixedDoctorStandIn(specs)] };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const refFor = (list, key) => {
    const entry = (handoff[list] || []).find((candidate) => String(candidate.result_ref).startsWith(`${fixedDoctorId(key)}@`));
    assert.ok(entry, `setup: ${key} is listed under ${list}`);
    return entry.result_ref;
  };
  const plain = refFor("open", "plain");
  const unclear = refFor("review", "unclear");
  const mixed = refFor("open", "mixed");
  await delay(5);

  // Control: a recorded accept does journal, so the probe can see a journal.
  const controlJournal = join(f.dir, "journals", "control.jsonl");
  const control = await runCli(acceptArgv(f, [plain], { journal: controlJournal }), { qcStandIns });
  assertAccepted(control);
  assert.ok(existsSync(controlJournal), "control: a recorded accept appends to the selected journal");

  const cases = [
    { label: "accepted_by_required", code: "accepted_by_required", refs: [plain], options: { acceptedBy: null } },
    { label: "attribution_invalid", code: "attribution_invalid", refs: [plain], options: { acceptedBy: "agent" } },
    { label: "attribution_invalid (no reason)", code: "attribution_invalid", refs: [plain], options: { reason: null } },
    { label: "changed_since_handoff", code: "changed_since_handoff", refs: [`${fixedDoctorId("plain")}@000000000000`] },
    { label: "target_not_warning", code: "target_not_warning", refs: [unclear] },
    { label: "members_unresolved", code: "members_unresolved", refs: [mixed] },
    { label: "no --result", refs: [] },
    { label: "malformed ref", refs: ["not-a-ref"] },
    { label: "duplicate ref", refs: [plain, plain] },
    { label: "two --accepted-by", refs: [plain], extra: ["--accepted-by", "Sam Rivera"] },
  ];
  let index = 0;
  const probe = async ({ label, code = null, refs, options = {}, extra = [] }, json) => {
    index += 1;
    const journal = join(f.dir, "journals", `refused-${index}.jsonl`);
    const before = snapshot(f);
    const argv = [...acceptArgv(f, refs, { ...options, journal, json }), ...extra];
    const res = await runCli(argv, { qcStandIns });
    assert.notEqual(res.exitCode, 0, `${label} (${json ? "json" : "text"}): refused`);
    if (json && code) assertRefused(res, code);
    if (!json && code) assert.match(res.error?.message || "", new RegExp(`\\(${code}\\)`), `${label} (text): names ${code}`);
    assert.equal(existsSync(journal), false, `${label} (${json ? "json" : "text"}): no lifecycle journal was created`);
    assertNothingWritten(f, before);
  };
  for (const entry of cases) {
    await probe(entry, true);
    await probe(entry, false);
  }

  // no_persisted_finding: the doctor sidecar `next` wrote is gone.
  rmSync(f.sidecarPath);
  await probe({ label: "no_persisted_finding", code: "no_persisted_finding", refs: [plain] }, true);
  await probe({ label: "no_persisted_finding", code: "no_persisted_finding", refs: [plain] }, false);

  // Untyped: a malformed qc_accepts value.
  mutateReport(f, (report) => {
    report.qc_accepts = "synthetic malformed";
  });
  await probe({ label: "malformed qc_accepts", refs: [plain] }, true);
  await probe({ label: "malformed qc_accepts", refs: [plain] }, false);
});

// ---------------------------------------------------------------------------
// A recorded leg never makes an applicable check silent.

const QA_UNIT_CHECKS = ["tracking.url", "tracking.order", "tracking.tag", "content_param", "policy.presence", "policy.availability"];
const declareContent = (spec) => { spec.analytics = { ...(spec.analytics || {}), params: { content: [{ name: "hide_promo" }] } }; };

test("silence: recorded QA and Polish legs list every applicable check without a row as not_captured_by_this_version, with every rederiver loaded", async (t) => {
  const f = campaignFixture({ mutateSpec: declareContent });
  t.after(f.cleanup);
  assert.ok(readJson(f.specPath).campaign?.store_terms, "setup: 1.4 applies (campaign.store_terms)");
  // QA (1.1, 1.2, 1.4): a recorded stage holding no rows.
  installQaStage(f, { observations: [] });
  assert.deepEqual(readJson(f.reportPath).stages.qa.evidence.qc_results, [], "setup: QA recorded with qc_results []");
  // Polish (1.3): a record whose loaded rules yield media.weight rows only.
  installPolishEvidence(f, twoCellFixture([{ path: HERO, bytes: 600_000 }]), { buildFingerprint: BUILD_FP });
  // Every QA unit check and the Polish rules are loaded (stand-ins).
  const qcStandIns = { qa: Object.fromEntries(QA_UNIT_CHECKS.map((check) => [check, qaRederive])), polish: polishStandIn() };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const tuples = (leg) => [...new Set((handoff.coverage || []).filter((entry) => entry.leg === leg).map((entry) => JSON.stringify([entry.check, entry.result, entry.reason_code])))].map((text) => JSON.parse(text)).sort();
  assert.deepEqual(tuples("qa"), QA_UNIT_CHECKS.map((check) => [check, "unexercised", NOT_CAPTURED]).sort(), `QA coverage: ${JSON.stringify(handoff.coverage)}`);
  assert.deepEqual(tuples("polish"), [["media.oversize", "unexercised", NOT_CAPTURED], ["readability.contrast", "unexercised", NOT_CAPTURED]], `Polish coverage: ${JSON.stringify(handoff.coverage)}`);
  assert.ok((handoff.open || []).some((entry) => entry.leg === "polish" && entry.check === "media.weight"), "the Polish media.weight warnings stay open");
});

// ---------------------------------------------------------------------------
// The fingerprint prefix is compared before target eligibility.

test("checkpoint accept: a handed-off warning that now reads pass refuses changed_since_handoff", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  let result = "warning";
  const qcStandIns = { doctor: [() => fixedDoctorStandIn([{ key: "flip", result, reason_code: result === "warning" ? "live_token" : null }])()] };
  const entry = (handoffOf(await runNext(f, qcStandIns)).open || []).find((candidate) => String(candidate.result_ref).startsWith(`${fixedDoctorId("flip")}@`));
  assert.ok(entry, "setup: the warning is open");
  result = "pass";
  await delay(5);
  const before = snapshot(f);
  const res = await runAccept(f, [entry.result_ref], { qcStandIns });
  assertRefused(res, "changed_since_handoff");
  assert.ok(res.json.error.includes("changed since the handoff; re-run `next`"), `the message: ${res.json.error}`);
  assertNothingWritten(f, before);
});

// ---------------------------------------------------------------------------
// Open warnings sharing a check and key are one entry with their pages.

test("QC handoff: one check and key warned on two pages is listed once with both pages, every result and member kept", async () => {
  const { buildQcHandoff } = await import("./qc-accept.mjs");
  const members = [{ key: "slot", result: "warning", reason_code: "live_token" }];
  const rows = ["checkout", "index"].map((page) => qcRow({ check: "standin_doctor", leg: "doctor", page, key: "shared", result: "warning", reason_code: "live_token", state: { page }, members, producer: "campaigns-os doctor" }));
  const other = qcRow({ check: "standin_doctor", leg: "doctor", page: "index", key: "solo", result: "warning", reason_code: "live_token", state: {}, producer: "campaigns-os doctor" });
  const handoff = buildQcHandoff({ results: [...rows, other], accepts: [] });
  assert.equal(handoff.open.length, 2, "two open entries: the shared defect and the solo one");
  const shared = handoff.open.find((entry) => entry.key === "shared");
  assert.deepEqual(shared.pages, ["checkout", "index"], "the shared defect lists its pages");
  assert.deepEqual(shared.results.map((entry) => [entry.page, entry.result_ref.split("@")[0], entry.members]), [
    ["checkout", "standin_doctor:checkout:shared", members],
    ["index", "standin_doctor:index:shared", members],
  ], "every page's result and members stay visible");
  for (const row of [...rows, other]) {
    assert.ok(handoff.accept_command.includes(`${row.id}@`), `accept_command lists ${row.id}`);
  }
});

// ---------------------------------------------------------------------------
// Every qc.* assertion takes part in pairing; none is skipped.

test("QA pairing: a qc.* assertion with malformed evidence.qc beside a healthy pair fails the full verdict, so every QA row reads evidence_not_reproducible", async (t) => {
  const { readQaResults } = await import("./qc-results.mjs");
  const qcStandIns = { qa: qaStandIns() };
  const measuredAt = new Date(Date.now() - 60_000).toISOString();
  const healthyRow = qaRowFor(qaObservation({ key: "store_privacy", outcome: "reachable" }), { measured_at: measuredAt });
  const warningRow = qaRowFor(qaObservation({ key: "store_terms", outcome: "unreachable" }), { measured_at: measuredAt });
  const stage = { identity: { verdict_run_id: QA_RUN_ID } };
  const read = (rows, assertions) => readQaResults({ stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD_FP }, stage, fullVerdict: fullVerdict({ assertions, measuredAt }), currentBuild: BUILD_FP, qcStandIns });

  // Control: both pairs intact read pass and warning.
  const control = read([healthyRow, warningRow], [qaAssertionFor(healthyRow), qaAssertionFor(warningRow)]);
  assert.deepEqual(control.map((row) => [row.id, row.result]), [[healthyRow.id, "pass"], [warningRow.id, "warning"]], "control: both pairs re-derive");

  // The warning's stored row is removed and its assertion's evidence.qc is
  // malformed; the healthy pair is untouched.
  const variants = [
    ["no result_id", (qc) => { delete qc.evidence.qc.result_id; }],
    ["empty result_id", (qc) => { qc.evidence.qc.result_id = ""; }],
    ["non-string result_id", (qc) => { qc.evidence.qc.result_id = 7; }],
    ["no evidence.qc", (qc) => { delete qc.evidence.qc; }],
    ["evidence.qc not an object", (qc) => { qc.evidence.qc = "synthetic"; }],
    ["observation not an object", (qc) => { qc.evidence.qc.observation = "synthetic"; }],
    ["QC evidence on an assertion whose id is not qc.*", (qc) => { qc.id = "browser.policy_terms"; }],
  ];
  for (const [label, tamper] of variants) {
    const malformed = clone(qaAssertionFor(warningRow));
    tamper(malformed);
    const results = read([healthyRow], [qaAssertionFor(healthyRow), malformed]);
    assert.ok(results.length > 0, `${label}: the stored row is still listed`);
    for (const row of results) {
      assert.deepEqual([row.result, row.reason_code], ["unexercised", E], `${label}: ${row.id} reads unexercised / ${E}`);
    }
  }

  // Through `next`: the reported probe (result_id deleted) leaves no pass and
  // the check is listed in coverage, never silent.
  const f = campaignFixture();
  t.after(f.cleanup);
  const malformed = clone(qaAssertionFor(warningRow));
  delete malformed.evidence.qc.result_id;
  installQaStage(f, { rows: [healthyRow], assertions: [qaAssertionFor(healthyRow), malformed], measuredAt });
  const handoff = handoffOf(await runNext(f, qcStandIns));
  assert.equal(qaWarningOpen(handoff), false, "no QA result is open");
  assert.deepEqual(qaCoverage(handoff, "policy.availability"), [["unexercised", E]], `policy.availability coverage: ${JSON.stringify(handoff.coverage)}`);
});

// ---------------------------------------------------------------------------
// Silence in a recorded leg reads not_captured_by_this_version unless the
// check's module failed to load; leg_not_run only without a stage record.

test("silence: a recorded Polish stage without page_load or media_weight lists 1.3 as not_captured_by_this_version; only a failed module reads evidence_not_reproducible", async (t) => {
  const { handoffCoverage } = await import("./qc-results.mjs");
  const polishTuples = (coverage) => [...new Set(coverage.filter((entry) => entry.leg === "polish").map((entry) => JSON.stringify([entry.check, entry.result, entry.reason_code])))].map((text) => JSON.parse(text)).sort();
  const everyPolish = (reasonCode) => [["media.oversize", "unexercised", reasonCode], ["media.weight", "unexercised", reasonCode], ["readability.contrast", "unexercised", reasonCode]];
  const polishStage = (patch) => ({ stage: "polish", status: "completed", inputs: [], outputs: [], commands: ["campaigns-os polish capture"], blockers: [], warnings: [], ...patch });

  const { pageLoad } = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  const recorded = [
    ["completed, visual_review without page_load", polishStage({ evidence: { visual_review: { screenshots: [] } } })],
    ["completed, no evidence", polishStage({})],
    ["blocked, page_load without media_weight", polishStage({ status: "blocked", evidence: { visual_review: { screenshots: [], page_load: pageLoad } } })],
  ];
  for (const [label, stage] of recorded) {
    const f = campaignFixture();
    t.after(f.cleanup);
    mutateReport(f, (report) => {
      report.stages.polish = stage;
    });
    const handoff = handoffOf(await runNext(f, { polish: polishStandIn() }));
    assert.deepEqual(polishTuples(handoff.coverage || []), everyPolish(NOT_CAPTURED), `${label}: ${JSON.stringify(handoff.coverage)}`);
  }

  // Module status in a recorded leg that holds its QC evidence but no row.
  const report = {
    stages: {
      qa: { stage: "qa", status: "completed", evidence: { qc_results: [] } },
      polish: polishStage({ evidence: { visual_review: { page_load: {}, media_weight: {}, readability: {} } } }),
    },
  };
  const allChecks = ["tracking.url", "tracking.order", "tracking.tag", "media.weight", "media.oversize", "readability.contrast"];
  const reasons = (rederivers) => {
    const coverage = handoffCoverage({ report, spec: {}, results: [], rederivers });
    return [...new Set(coverage.map((entry) => entry.reason_code))];
  };
  assert.deepEqual(reasons({}), [NOT_CAPTURED], "not yet loaded: not_captured_by_this_version");
  assert.deepEqual(reasons(Object.fromEntries(allChecks.map((check) => [check, { status: "missing" }]))), [NOT_CAPTURED], "missing module: not_captured_by_this_version");
  assert.deepEqual(reasons(Object.fromEntries(allChecks.map((check) => [check, { status: "failed", error: "synthetic" }]))), [E], "failed load: evidence_not_reproducible");
});

// ---------------------------------------------------------------------------
// Readability records that fail the reader checks

const READABILITY = "readability.contrast";
const READABILITY_ROUTES = Object.freeze([`/${SLUG}/`, `/${SLUG}/checkout/`]);
const READABILITY_BUILD = `sha256:${"a".repeat(64)}`;
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;

// A built target with the two routes, the registry's real rules, and the
// reader's bound context, so an untouched record reads as recorded.
async function readabilityReader(t) {
  const targetRepo = mkdtempSync(join(tmpdir(), "qc-readability-"));
  t.after(() => rmSync(targetRepo, { recursive: true, force: true }));
  for (const dir of ["", "checkout"]) {
    mkdirSync(join(targetRepo, "_site", SLUG, dir), { recursive: true });
    writeFileSync(join(targetRepo, "_site", SLUG, dir, "index.html"), "<!doctype html><p>Synthetic</p>\n");
  }
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readReadability } = await import("./qc-results.mjs");
  const { contrastToolkit } = await import("./contrast.mjs");
  const rederivers = await loadQcRederivers();
  const context = { currentBuild: READABILITY_BUILD, currentSource: null, buildOutput: { status: "pass" }, campaignSlug: SLUG, targetRepo, rederivers };
  return { read: (record, patch = {}) => readReadability({ ...context, ...patch, record }), kit: contrastToolkit() };
}

// One element measured by the shared helper from its raw fields.
function readabilityElement(kit, { fg = "#ffffff", bg = "#0080aa", px = 16, weight = 400, ...rest } = {}) {
  const raw = { role: "body_text", selector_path: "html>body>p:nth-of-type(1)", state: "default", disabled: false, rendered: true, font_size_px: px, font_weight: weight, fg_raw: rgbOf(fg), fill_raw: rgbOf(fg), bg_layers_raw: [rgbOf(bg)], review_reason: null, crop_ref: null, crop_reason: "outside_viewport", ...rest };
  const derived = kit.deriveElementMeasurement(raw);
  return { ...raw, size_class: derived.size_class, fg_srgb: derived.fg_srgb, bg_srgb: derived.bg_srgb, gamut_clipped: derived.gamut_clipped, ratio: derived.ratio, required: derived.required };
}

const READABILITY_MEASURED_AT = new Date(Date.now() - 60_000).toISOString();
function readabilityRecord(kit, { elements = () => [readabilityElement(kit)], cell = () => ({}) } = {}) {
  return withRecomputedIntegrity({
    schema_version: "campaigns-os-polish-readability/v0",
    performed_by: "campaigns-os polish capture",
    helper_version: "contrast/v1",
    subject: { build_fingerprint: READABILITY_BUILD, source_package_material_fingerprint: null, campaign_slug: SLUG, route_source: "built_site", routes: [...READABILITY_ROUTES], viewports: ["desktop", "mobile"] },
    thresholds: { normal: 4.5, large: 3, large_px: 24, large_bold_px: 18.66, large_bold_weight: 700 },
    limits: { elements_per_cell: 2000, crops_per_cell: 40, probe_ms_per_cell: 1500, probe_ms_per_run: 120000, crop_ms_per_run: 30000, added_ms_per_run: 300000, routes: 128, route_enumeration: 500 },
    cells: READABILITY_ROUTES.flatMap((route) => ["desktop", "mobile"].map((viewport) => ({ route, viewport, page_load_integrity: null, cell_status: "measured", capped: false, coverage_gaps: [], elements: elements(route, viewport), ...cell(route, viewport) }))),
    uncaptured_routes: [],
    route_enumeration_capped: false,
    measured_at: READABILITY_MEASURED_AT,
  });
}

// One accept per warning pair row of the untouched record, by the synthetic
// operator; each is active before the record is tampered with.
async function pairAccepts(rows) {
  const { createQcAccept, qcAcceptAttribution, assessQcAccepts } = await import("./qc-accept.mjs");
  const warnings = rows.filter((row) => row.check === READABILITY && row.result === "warning" && row.subject.key.startsWith("pair:"));
  assert.equal(warnings.length, 4, "setup: the untouched record reads one warning pair row per route and viewport");
  const attribution = qcAcceptAttribution({ reason: "Synthetic brand colour kept on purpose.", acceptedBy: OPERATOR, now: new Date().toISOString() });
  const accepts = warnings.map((row) => createQcAccept(row, { measuredAt: READABILITY_MEASURED_AT, attribution }));
  assert.deepEqual(assessQcAccepts(accepts, rows).map((entry) => entry.status), ["active", "active", "active", "active"], "setup: every pair accept is active on the untouched record");
  return (current) => assessQcAccepts(accepts, current).map((entry) => [entry.status, entry.why]);
}

const everyLapsed = (count) => Array.from({ length: count }, () => ["lapsed", E]);

async function assertPairAcceptsLapse(t, tamper, label) {
  const { read, kit } = await readabilityReader(t);
  const record = readabilityRecord(kit);
  const assess = await pairAccepts(read(record));
  const tampered = structuredClone(record);
  tamper(tampered);
  const rows = read(withRecomputedIntegrity(tampered));
  assert.ok(rows.length > 0 && rows.every((row) => row.result === "unexercised" && row.reason_code === E), `${label}: every row reads unexercised / ${E}`);
  assert.deepEqual(assess(rows), everyLapsed(4), `${label}: every prior pair accept reads lapsed / ${E}, never orphaned`);
}

test("readability reader: a record whose thresholds differ from the constants still names its pair rows, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.thresholds.normal = 4.4;
  }, "thresholds.normal = 4.4");
});

test("readability reader: a record with a cell_status outside the vocabulary still names its pair rows, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.cells[0].cell_status = "measured_ok";
  }, "cell_status measured_ok");
});

test("readability reader: a record with an element role outside the vocabulary still names its pair rows, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.cells[0].elements[0].role = "hero_text";
  }, "element role hero_text");
});

// An element field that selects a row other than the pair row never hides
// the pair key its raw colours and typography still name.
test("readability reader: an element review_reason outside the vocabulary still names its pair row, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.cells[0].elements[0].review_reason = "foreign";
  }, "element review_reason foreign");
});

test("readability reader: a review_reason background_gradient in a record whose thresholds differ still names its pair row, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.thresholds.normal = 4.4;
    record.cells[0].elements[0].review_reason = "background_gradient";
  }, "thresholds.normal = 4.4 with review_reason background_gradient");
});

test("readability reader: an element rendered:false in a record whose thresholds differ still names its pair row, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.thresholds.normal = 4.4;
    record.cells[0].elements[0].rendered = false;
  }, "thresholds.normal = 4.4 with rendered false");
});

test("readability reader: an element disabled:true in a record whose thresholds differ still names its pair row, so prior pair accepts lapse", async (t) => {
  await assertPairAcceptsLapse(t, (record) => {
    record.thresholds.normal = 4.4;
    record.cells[0].elements[0].disabled = true;
  }, "thresholds.normal = 4.4 with disabled true");
});

test("readability reader: a cell whose rules cannot evaluate it still names its pair row, so the prior pair accept lapses", async (t) => {
  const { read, kit } = await readabilityReader(t);
  const record = readabilityRecord(kit);
  const assess = await pairAccepts(read(record));
  const tampered = structuredClone(record);
  tampered.cells[0].coverage_gaps = [{ reason: "state_not_observed", role: "price", selector_path: "html>body>span:nth-of-type(1)" }];
  const rows = read(withRecomputedIntegrity(tampered));
  const failed = rows.filter((row) => row.subject.page === READABILITY_ROUTES[0] && row.subject.viewport === "desktop");
  assert.ok(failed.length > 0 && failed.every((row) => row.result === "unexercised" && row.reason_code === E), "the failed cell's rows read unexercised / evidence_not_reproducible");
  assert.deepEqual(assess(rows), [["lapsed", E], ["active", null], ["active", null], ["active", null]], "the failed cell's accept lapses; the other cells' accepts stay active");
});

test("readability reader: a record missing a fixed viewport lists a cell row for every route at that viewport, never silence", async (t) => {
  const { read, kit } = await readabilityReader(t);
  const record = readabilityRecord(kit);
  const tampered = structuredClone(record);
  tampered.subject.viewports = ["desktop"];
  tampered.cells = tampered.cells.filter((cell) => cell.viewport === "desktop");
  const rows = read(withRecomputedIntegrity(tampered));
  const mobile = rows.filter((row) => row.subject.viewport === "mobile").map((row) => [row.subject.page, row.subject.key, row.result, row.reason_code]);
  assert.deepEqual(mobile, READABILITY_ROUTES.map((route) => [route, "cell", "unexercised", E]), "one mobile cell row per route reads unexercised / evidence_not_reproducible");
});

test("readability reader: an inactive control in a capped cell stays excluded / inactive_control, with the page_coverage member, and the handoff lists it as excluded", async (t) => {
  const { read, kit } = await readabilityReader(t);
  const disabled = { role: "submit_control", selector_path: "html>body>button:nth-of-type(1)", state: "default", disabled: true, rendered: true, font_size_px: 16, font_weight: 400, size_class: "normal", fg_raw: null, fill_raw: null, bg_layers_raw: null, fg_srgb: null, bg_srgb: null, gamut_clipped: null, ratio: null, required: 4.5, review_reason: null, crop_ref: null, crop_reason: null };
  const record = readabilityRecord(kit, { elements: () => [readabilityElement(kit), disabled], cell: () => ({ capped: true }) });
  const rows = read(record);
  const inactive = rows.filter((row) => row.subject.key === "inactive_control");
  assert.equal(inactive.length, 4, "setup: one inactive_control row per capped cell");
  for (const row of inactive) {
    assert.deepEqual([row.result, row.reason_code, row.accept_eligible], ["excluded", "inactive_control", false], `${row.id} stays excluded / inactive_control`);
    assert.ok(row.members.some((member) => member.key === "page_coverage" && member.result === "unexercised" && member.reason_code === "element_cap_reached"), `${row.id} carries the page_coverage member`);
  }
  const { buildQcHandoff } = await import("./qc-accept.mjs");
  const coverage = buildQcHandoff({ results: rows, accepts: [] }).coverage.filter((entry) => entry.check === READABILITY);
  assert.deepEqual(coverage.filter((entry) => entry.reason_code === "inactive_control").map((entry) => [entry.result, entry.count]), [["excluded", 4]], "the handoff lists the inactive controls as excluded");
});
