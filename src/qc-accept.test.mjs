// F1.0 frozen fixture rows for `checkpoint accept`, the accept assessment and
// readiness (contract §1.0 Accepts, Accept assessment, Surfaces).
//
// Test-only stand-in checks, passed in-process only (no environment variable, flag or file can install one):
//   main(argv, { qcStandIns }) and doctorPacket(path, { qcStandIns }) (through doctorOf), with
//   qcStandIns = { doctor: [() => QcResult[]], qa: { "<check>": (observation) => Derived | null },
//                  polish: { thresholds, vocabulary, evaluate(cell, thresholds) => Derived[] } }.
//   See src/qc-test-factories.mjs for the full shape.
//
// API assumption (accept status rows): assessQcAccepts(records, currentResults, { now })
// returns one assessment per record, in input order, each { status, why }.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  OPERATOR,
  OTHER_BUILD_FP,
  ROUTES,
  appendAccept,
  assertAccepted,
  assertNoOtherRefusalCode,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  countReportWrites,
  delay,
  doctorOf,
  fixedDoctorId,
  fixedDoctorStandIn,
  handAccept,
  handoffOf,
  installPolishEvidence,
  installQaStage,
  liveTokenId,
  liveTokenStandIn,
  mediaWeightFixture,
  polishStandIn,
  qaObservation,
  qaStandIns,
  readJson,
  refOf,
  resultsOf,
  runAccept,
  runCli,
  runNext,
  setBuiltPage,
  sidecarRow,
  snapshot,
  writeJson,
  writeSitePage,
} from "./qc-test-factories.mjs";

// No network: any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const NAME = "{item.name}";
const PRICE = "{item.price}";
const tokensBody = (...tokens) => tokens.map((token) => `<p class="cart-line">${token}</p>`).join("");

function liveTokenSetup(t, body = tokensBody(NAME)) {
  const f = campaignFixture();
  t.after(f.cleanup);
  setBuiltPage(f, body);
  return { f, qcStandIns: { doctor: [liveTokenStandIn(f)] } };
}

function openEntry(handoff, id) {
  const entry = (handoff.open || []).find((candidate) => String(candidate.result_ref).startsWith(`${id}@`));
  assert.ok(entry, `qc_handoff.open lists ${id}`);
  return entry;
}

function doctorRow(f, qcStandIns, id) {
  const doctor = doctorOf(f.packetPath, { qcStandIns });
  assert.ok(Array.isArray(doctor.derived?.qc_results), "doctor derived.qc_results[] is present");
  return { doctor, row: doctor.derived.qc_results.find((row) => row.id === id) || null };
}

async function acceptLiveToken(f, qcStandIns, id = liveTokenId(NAME), options = {}) {
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const entry = openEntry(handoff, id);
  await delay(5);
  const res = await runAccept(f, [entry.result_ref], { qcStandIns, ...options });
  assertAccepted(res);
  return entry;
}

function assertInertListed(handoff, id, why) {
  assert.ok(
    (handoff.inert_accepts || []).some((entry) => entry.result_id === id && entry.why === why),
    `qc_handoff.inert_accepts lists ${id} with why ${why}: ${JSON.stringify(handoff.inert_accepts)}`,
  );
  assert.equal((handoff.accepted || []).some((entry) => String(entry.result_ref).startsWith(`${id}@`)), false, "an inert accept is never listed as accepted");
}

function assertLapsedListed(handoff, id, why) {
  assert.ok(
    (handoff.lapsed || []).some((entry) => entry.why === why && JSON.stringify(entry).includes(id)),
    `qc_handoff.lapsed lists ${id} with why ${why}: ${JSON.stringify(handoff.lapsed)}`,
  );
}

function assertAcceptedListed(handoff, ref) {
  assert.ok(
    (handoff.accepted || []).some((entry) => entry.result_ref === ref && entry.accepted_by === OPERATOR),
    `qc_handoff.accepted lists ${ref} accepted by ${OPERATOR}: ${JSON.stringify(handoff.accepted)}`,
  );
}

// ---------------------------------------------------------------------------
// Working rows

test("F1.0-W1 [stand-in: 1.5 live_token] accept active; result stays warning, status stays ready_with_warnings (live_token)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  const before = await runNext(f, qcStandIns);
  assert.equal(before.status, "ready_with_warnings");
  const entry = openEntry(handoffOf(before), id);
  assert.equal(entry.result, "warning");
  assert.equal(entry.reason_code, "live_token");
  assert.equal(entry.accept_eligible, true);
  await delay(5);
  assertAccepted(await runAccept(f, [entry.result_ref], { qcStandIns }));

  const after = await runNext(f, qcStandIns);
  assert.equal(after.status, "ready_with_warnings", "next status stays ready_with_warnings");
  assertAcceptedListed(handoffOf(after), entry.result_ref);
  const { doctor, row } = doctorRow(f, qcStandIns, id);
  assert.equal(row.result, "warning", "the result stays warning");
  assert.equal(row.reason_code, "live_token");
  assert.equal(doctor.status, "ready_with_warnings", "doctor status stays ready_with_warnings");
  assert.ok(doctor.warnings.some((issue) => issue.detail?.qc_result?.id === id), "the doctor warning issue is still there");
  const records = readJson(f.reportPath).qc_accepts;
  assert.equal(records.length, 1);
  const [assessment] = assessQcAccepts(records, doctor.derived.qc_results, { now: new Date().toISOString() });
  assert.equal(assessment.status, "active");
});

test("F1.0-W2 [stand-in: 1.5 live_token + QA policy.availability] doctor and QA warnings accepted in one command: both accepts active; one report write", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const f = campaignFixture();
  t.after(f.cleanup);
  setBuiltPage(f, tokensBody(NAME));
  installQaStage(f, { observations: [qaObservation({ outcome: "unreachable" })] });
  const qcStandIns = { doctor: [liveTokenStandIn(f)], qa: qaStandIns() };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const doctorRef = openEntry(handoff, liveTokenId(NAME)).result_ref;
  const qaRef = openEntry(handoff, "policy.availability:campaign:store_terms").result_ref;
  await delay(5);
  const { value: res, count } = await countReportWrites(f, () => runAccept(f, [doctorRef, qaRef], { qcStandIns }));
  assertAccepted(res);
  assert.equal(count, 1, "exactly one Assembly Report write");
  const records = readJson(f.reportPath).qc_accepts;
  assert.equal(records.length, 2);
  const after = handoffOf(await runNext(f, qcStandIns));
  assertAcceptedListed(after, doctorRef);
  assertAcceptedListed(after, qaRef);
  const doctorResults = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const { readQaResults } = await import("./qc-results.mjs");
  const report = readJson(f.reportPath);
  const qaResults = resultsOf(readQaResults({
    stageEvidence: report.stages.qa.evidence,
    stage: report.stages.qa,
    fullVerdict: readJson(report.stages.qa.outputs[0]),
    currentBuild: BUILD_FP,
    qcStandIns,
  }));
  const assessed = assessQcAccepts(records, [...doctorResults, ...qaResults], { now: new Date().toISOString() });
  assert.deepEqual(assessed.map((entry) => entry.status), ["active", "active"]);
});

test("F1.0-W3 [stand-in: QA policy.availability] next status identical before and after the accept", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  installQaStage(f, { observations: [qaObservation({ outcome: "unreachable" })] });
  const qcStandIns = { qa: qaStandIns() };
  assert.deepEqual(doctorOf(f.packetPath, { qcStandIns }).warnings, [], "doctor has no warnings");
  const before = await runNext(f, qcStandIns);
  const entry = openEntry(handoffOf(before), "policy.availability:campaign:store_terms");
  await delay(5);
  assertAccepted(await runAccept(f, [entry.result_ref], { qcStandIns }));
  const after = await runNext(f, qcStandIns);
  assertAcceptedListed(handoffOf(after), entry.result_ref);
  assert.equal(after.status, before.status, "next status is identical before and after the accept");
});

test("F1.0-W4 [stand-in: 1.5 live_token] accept B after accepting A, without re-running next: accept B active", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t, tokensBody(NAME, PRICE));
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const refA = openEntry(handoff, liveTokenId(NAME)).result_ref;
  const refB = openEntry(handoff, liveTokenId(PRICE)).result_ref;
  await delay(5);
  assertAccepted(await runAccept(f, [refA], { qcStandIns }));
  assert.equal(readJson(f.sidecarPath).stale, true, "accepting A stale-stamps the doctor sidecar");
  assertAccepted(await runAccept(f, [refB], { qcStandIns }));
  const records = readJson(f.reportPath).qc_accepts;
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const assessed = assessQcAccepts(records, current, { now: new Date().toISOString() });
  const indexB = records.findIndex((record) => record.result_id === liveTokenId(PRICE));
  assert.ok(indexB >= 0, "accept B was recorded");
  assert.equal(assessed[indexB].status, "active");
  assertAcceptedListed(handoffOf(await runNext(f, qcStandIns)), refB);
});

test("F1.0-W5 [stand-in: 1.5 live_token] a ready packet gains one live {item.name}: next status ready_with_warnings (live_token)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t, "<p>Synthetic cart line</p>");
  const before = await runNext(f, qcStandIns);
  assert.equal(before.status, "ready", "precondition: next status is ready");
  setBuiltPage(f, tokensBody(NAME));
  const after = await runNext(f, qcStandIns);
  assert.equal(after.status, "ready_with_warnings");
  const issue = (after.warnings || []).find((candidate) => candidate.detail?.qc_result?.id === liveTokenId(NAME));
  assert.ok(issue, "next carries the doctor warning issue for the live token");
  assert.equal(issue.detail.qc_result.reason_code, "live_token");
});

// ---------------------------------------------------------------------------
// Broken rows

test("F1.0-B1 [stand-in: 1.5 live_token] hand-written accept with a copied fingerprint and a wrong integrity checksum: accept inert (integrity_mismatch)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  await runNext(f, qcStandIns);
  const record = { ...handAccept(sidecarRow(f, id)), integrity: `sha256:${"0".repeat(64)}` };
  appendAccept(f, record);
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts([record], current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "inert");
  assert.equal(assessment.why, "integrity_mismatch");
  assertInertListed(handoffOf(await runNext(f, qcStandIns)), id, "integrity_mismatch");
});

test("F1.0-B3 [stand-in: 1.5 live_token] accept, then a second {item.name} on the same page: accept lapsed (state_changed)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  await acceptLiveToken(f, qcStandIns, id);
  setBuiltPage(f, tokensBody(NAME, NAME));
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts(readJson(f.reportPath).qc_accepts, current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "lapsed");
  assert.equal(assessment.why, "state_changed");
  assertLapsedListed(handoffOf(await runNext(f, qcStandIns)), id, "state_changed");
});

test("F1.0-B4 [stand-in: 1.5 live_token] --accepted-by \"agent\": refused; nothing written (attribution_invalid)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t);
  const entry = openEntry(handoffOf(await runNext(f, qcStandIns)), liveTokenId(NAME));
  await delay(5);
  const before = snapshot(f);
  const res = await runAccept(f, [entry.result_ref], { qcStandIns, acceptedBy: "agent" });
  assertRefused(res, "attribution_invalid");
  assertNothingWritten(f, before);
});

test("F1.0-B5 [stand-in: 1.5 live_token] --accepted-by omitted: refused; nothing written (accepted_by_required)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t);
  const entry = openEntry(handoffOf(await runNext(f, qcStandIns)), liveTokenId(NAME));
  await delay(5);
  const before = snapshot(f);
  const res = await runAccept(f, [entry.result_ref], { qcStandIns, acceptedBy: null });
  assertRefused(res, "accepted_by_required");
  assertNothingWritten(f, before);
});

// These checks are tamper evidence, not authorship proof: a full reconstruction reads as valid, and this test pins that documented outcome.
test("F1.0-B7 [stand-in: 1.5 live_token] fully reconstructed hand-written accept on a current warning: accept active (documented tamper-evidence limit)", async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  await runNext(f, qcStandIns);
  const row = sidecarRow(f, id);
  const unsigned = handAccept(row, { acceptedAt: new Date(Date.parse(row.measured_at) + 1000).toISOString() });
  // API assumption: qcAcceptIntegrity(record) returns the "sha256:…" checksum over every field but integrity.
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  appendAccept(f, record);
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts([record], current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "active");
  assertAcceptedListed(handoffOf(await runNext(f, qcStandIns)), refOf(row));
});

test("F1.0-B8 [stand-in: 1.5 live_token] --result A --result B where B changed after next: refused atomically; zero accepts written (changed_since_handoff)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t, tokensBody(NAME, PRICE));
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const refA = openEntry(handoff, liveTokenId(NAME)).result_ref;
  const refB = openEntry(handoff, liveTokenId(PRICE)).result_ref;
  setBuiltPage(f, tokensBody(NAME, PRICE, PRICE));
  await delay(5);
  const before = snapshot(f);
  const res = await runAccept(f, [refA, refB], { qcStandIns });
  assertRefused(res, "changed_since_handoff", { names: [liveTokenId(PRICE)] });
  assertNothingWritten(f, before);
  assert.equal(readJson(f.reportPath).qc_accepts, undefined, "zero accepts written");
});

test("F1.0-B9 [stand-in: 1.3 media_weight F1.3-B2] accepted, then record build records a new build fingerprint: accept lapsed (stale_binding)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { readMediaWeight } = await import("./qc-results.mjs");
  const f = campaignFixture({ setupCompleted: true, site: true });
  t.after(f.cleanup);
  const qcStandIns = { polish: polishStandIn() };
  const first = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(first.exitCode, 0, first.error?.message);
  const buildOne = readJson(f.reportPath).stages.assembly.build_fingerprint;
  const evidence = mediaWeightFixture({ buildFingerprint: buildOne, cells: [{ route: ROUTES[0], resources: [{ path: "/runtime-packet-demo/img/hero.jpg", bytes: 600_000 }] }] });
  installPolishEvidence(f, evidence);
  // next is blocked here by the unrelated route-drift and Polish gates of this
  // synthetic build, so the ref is read from the reader site directly.
  const warning = resultsOf(readMediaWeight({ record: evidence.record, pageLoad: evidence.pageLoad, currentBuild: buildOne, qcStandIns }))
    .find((row) => row.check === "media.weight" && row.result === "warning" && row.reason_code === "image_over_threshold");
  assert.ok(warning, "the F1.3-B2 media.weight result reads warning on the first build");
  await delay(5);
  assertAccepted(await runAccept(f, [refOf(warning)], { qcStandIns }));

  writeSitePage(f, "<p>synthetic build two</p>");
  const second = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(second.exitCode, 0, second.error?.message);
  const report = readJson(f.reportPath);
  const buildTwo = report.stages.assembly.build_fingerprint;
  assert.notEqual(buildTwo, buildOne, "record build recorded a new build fingerprint");
  const visual = report.stages.polish.evidence.visual_review;
  const current = resultsOf(readMediaWeight({ record: visual.media_weight, pageLoad: visual.page_load, currentBuild: buildTwo, qcStandIns }));
  const [assessment] = assessQcAccepts(report.qc_accepts, current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "lapsed");
  assert.equal(assessment.why, "stale_binding");
  const resultId = report.qc_accepts[0].result_id;
  assertLapsedListed(handoffOf(await runNext(f, qcStandIns)), resultId, "stale_binding");
});

test("F1.0-B11 [stand-in: 1.5 live_token] hand-written accept with no state_fingerprint: accept inert (malformed)", async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  await runNext(f, qcStandIns);
  const unsigned = handAccept(sidecarRow(f, id), { drop: ["state_fingerprint"] });
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  appendAccept(f, record);
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts([record], current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "inert");
  assert.equal(assessment.why, "malformed");
  assertInertListed(handoffOf(await runNext(f, qcStandIns)), id, "malformed");
});

test("F1.0-B12 [stand-in: 1.5 live_token] accept with --expires-at one minute ahead, read two minutes later, state unchanged: accept expired (expired)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await acceptLiveToken(f, qcStandIns, liveTokenId(NAME), { extra: ["--expires-at", expiresAt] });
  const records = readJson(f.reportPath).qc_accepts;
  assert.equal(records[0].expires_at, expiresAt);
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts(records, current, { now: new Date(Date.now() + 120_000).toISOString() });
  assert.equal(assessment.status, "expired");
  assert.equal(assessment.why, "expired");
});

test("F1.0-B13 [stand-in: 1.5 live_token] accept, then the live {item.name} text is removed: accept orphaned (no_current_result)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  await acceptLiveToken(f, qcStandIns);
  setBuiltPage(f, "<p>Synthetic cart line</p>");
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  assert.equal(current.some((row) => row.id === liveTokenId(NAME)), false, "no current result has that id");
  const [assessment] = assessQcAccepts(readJson(f.reportPath).qc_accepts, current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "orphaned");
  assert.equal(assessment.why, "no_current_result");
});

// This refusal predates QC accepts; the test pins the existing behaviour.
test("F1.0-B14 qa waive --assertion qc.policy.availability:store_terms: refused by the existing waivable-assertion list", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  const before = snapshot(f);
  const res = await runCli([
    "qa", "waive", "--packet", f.packetPath, "--assertion", "qc.policy.availability:store_terms",
    "--reason", "known synthetic", "--waived-by", OPERATOR, "--json",
  ]);
  assert.notEqual(res.exitCode, 0, "the refusal exits non-zero");
  assert.notEqual(res.json?.ok, true, "the refusal never reports ok");
  assert.ok(res.error instanceof Error, "qa waive refuses by its existing thrown refusal");
  assert.equal(
    res.error.message,
    "qa waive does not accept --assertion \"qc.policy.availability:store_terms\". The waiver lane is scoped to exactly: analytics-correctness:purchase-fires. Extending the lane to another assertion is a design decision, not a flag.",
  );
  assertNoOtherRefusalCode(res);
  assertNothingWritten(f, before);
});

test("F1.0-B23 [stand-in: 1.5 live_token] doctor sidecar row with generated_by \"agent\"; accept attempted: refused (no_persisted_finding)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t);
  const entry = openEntry(handoffOf(await runNext(f, qcStandIns)), liveTokenId(NAME));
  const sidecar = readJson(f.sidecarPath);
  sidecar.generated_by = "agent";
  writeJson(f.sidecarPath, sidecar);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [entry.result_ref], { qcStandIns }), "no_persisted_finding");
  assertNothingWritten(f, before);
});

test("F1.0-B25 [stand-in: 1.5 live_token] doctor sidecar with schema_version campaigns-os-doctor-output/v9; accept attempted: refused (no_persisted_finding)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t);
  const entry = openEntry(handoffOf(await runNext(f, qcStandIns)), liveTokenId(NAME));
  const sidecar = readJson(f.sidecarPath);
  sidecar.schema_version = "campaigns-os-doctor-output/v9";
  writeJson(f.sidecarPath, sidecar);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [entry.result_ref], { qcStandIns }), "no_persisted_finding");
  assertNothingWritten(f, before);
});

test("F1.0-B39 [stand-in: 1.5 live_token] hand-written accept with recorded_by \"agent\" and a recomputed checksum: accept inert (malformed)", async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  await runNext(f, qcStandIns);
  const unsigned = handAccept(sidecarRow(f, id), { patch: { recorded_by: "agent" } });
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  appendAccept(f, record);
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts([record], current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "inert");
  assert.equal(assessment.why, "malformed");
  assertInertListed(handoffOf(await runNext(f, qcStandIns)), id, "malformed");
});

// ---------------------------------------------------------------------------
// Incomplete rows

function fixedSetup(t, specs) {
  const f = campaignFixture();
  t.after(f.cleanup);
  return { f, qcStandIns: { doctor: [fixedDoctorStandIn(specs)] } };
}

test("F1.0-I1 [stand-in: doctor review] checkpoint accept on a review result: refused; result stays review (target_not_warning)", async (t) => {
  const { f, qcStandIns } = fixedSetup(t, [{ key: "unclear", result: "review", reason_code: "ambiguous_token" }]);
  const id = fixedDoctorId("unclear");
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const entry = (handoff.review || []).find((candidate) => String(candidate.result_ref).startsWith(`${id}@`));
  assert.ok(entry, "qc_handoff.review lists the review result");
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [entry.result_ref], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
  const { row } = doctorRow(f, qcStandIns, id);
  assert.equal(row.result, "review", "the result stays review");
  assert.equal(row.reason_code, "ambiguous_token");
});

// API assumption (I2, I14, I15, I16): a ref for a result the handoff does not
// print is `<id>@<first 12 hex of state_fingerprint>`.
test("F1.0-I2 [stand-in: doctor unexercised] checkpoint accept on an unexercised result: refused; result unchanged (target_not_warning)", async (t) => {
  const { f, qcStandIns } = fixedSetup(t, [{ key: "capped", result: "unexercised", reason_code: "candidate_cap_reached" }]);
  const id = fixedDoctorId("capped");
  await runNext(f, qcStandIns);
  const persisted = sidecarRow(f, id);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(persisted)], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
  const { row } = doctorRow(f, qcStandIns, id);
  assert.equal(row.result, "unexercised", "the result is unchanged");
  assert.equal(row.reason_code, "candidate_cap_reached");
  assert.equal(row.state_fingerprint, persisted.state_fingerprint);
});

test("F1.0-I3 [stand-in: 1.2 readiness_timeout] integrity-valid hand-written accept on a current unexercised/readiness_timeout result: accept inert (target_not_warning)", async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const f = campaignFixture({ mutateSpec: (spec) => { spec.analytics = { ...(spec.analytics || {}), params: { content: [{ name: "hide_promo" }] } }; } });
  t.after(f.cleanup);
  const qcStandIns = { qa: qaStandIns() };
  const { rows, stage, verdict } = installQaStage(f, { observations: [qaObservation({ check: "content_param", page: "index", key: "hide_promo", outcome: "readiness_timeout" })] });
  const [row] = rows;
  assert.equal(row.result, "unexercised");
  assert.equal(row.reason_code, "readiness_timeout");
  const unsigned = handAccept(row, { measuredSource: "qa_full_verdict" });
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  appendAccept(f, record);
  const current = resultsOf(readQaResults({ stageEvidence: stage.evidence, stage, fullVerdict: verdict, currentBuild: BUILD_FP, qcStandIns }));
  const [assessment] = assessQcAccepts([record], current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "inert");
  assert.equal(assessment.why, "target_not_warning");
  assertInertListed(handoffOf(await runNext(f, qcStandIns)), row.id, "target_not_warning");
});

test("F1.0-I4 [stand-in: 1.5 live_token] doctor warning seen only by plain doctor (no sidecar); accept attempted: refused (no_persisted_finding)", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t);
  const doctorRun = await runCli(["doctor", "--packet", f.packetPath, "--json"], { qcStandIns });
  assert.equal(existsSync(f.sidecarPath), false, "plain doctor persisted no sidecar");
  const row = (doctorRun.json?.derived?.qc_results || []).find((candidate) => candidate.id === liveTokenId(NAME));
  assert.ok(row, "plain doctor reports the live-token warning in derived.qc_results");
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(row)], { qcStandIns }), "no_persisted_finding");
  assertNothingWritten(f, before);
});

test("F1.0-I6 [stand-in: 1.5 live_token] hand-written accept with accepted_at equal to measured_at: accept inert (accepted_not_after_measurement)", async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { f, qcStandIns } = liveTokenSetup(t);
  const id = liveTokenId(NAME);
  await runNext(f, qcStandIns);
  const row = sidecarRow(f, id);
  const unsigned = handAccept(row, { acceptedAt: row.measured_at });
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  appendAccept(f, record);
  const current = doctorOf(f.packetPath, { qcStandIns }).derived.qc_results;
  const [assessment] = assessQcAccepts([record], current, { now: new Date().toISOString() });
  assert.equal(assessment.status, "inert");
  assert.equal(assessment.why, "accepted_not_after_measurement");
  assertInertListed(handoffOf(await runNext(f, qcStandIns)), id, "accepted_not_after_measurement");
});

test("F1.0-I7 [stand-in: doctor mixed row] warning + review members offered to the command: refused; row stays warning, both members listed (members_unresolved)", async (t) => {
  const members = [
    { key: "member_a", result: "warning", reason_code: "live_token" },
    { key: "member_b", result: "review", reason_code: "ambiguous_token" },
  ];
  const { f, qcStandIns } = fixedSetup(t, [{ key: "mixed", result: "warning", reason_code: "live_token", members, accept_eligible: false }]);
  const id = fixedDoctorId("mixed");
  const entry = openEntry(handoffOf(await runNext(f, qcStandIns)), id);
  assert.equal(entry.accept_eligible, false);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [entry.result_ref], { qcStandIns }), "members_unresolved");
  assertNothingWritten(f, before);
  const after = openEntry(handoffOf(await runNext(f, qcStandIns)), id);
  assert.equal(after.result, "warning", "the row stays warning");
  assert.deepEqual(
    (after.members || []).map((member) => [member.key, member.result, member.reason_code]).sort(),
    members.map((member) => [member.key, member.result, member.reason_code]).sort(),
    "both members are listed",
  );
});

// The "waive refused with the existing message" half is existing behaviour
// that predates QC accepts; it is asserted before the accept half.
test("F1.0-I9 [stand-in: 1.5 live_token] active accepts present; checkpoint waive on a passing gate: waive refused with the existing message; status not ready_with_waivers", async (t) => {
  const { f, qcStandIns } = liveTokenSetup(t);
  const handoff = await runNext(f, qcStandIns).then((next) => next.qc_handoff);
  const ref = (handoff?.open || []).find((candidate) => String(candidate.result_ref).startsWith(`${liveTokenId(NAME)}@`))?.result_ref;
  await delay(5);
  const accept = ref ? await runAccept(f, [ref], { qcStandIns }) : null;

  const beforeWaive = snapshot(f);
  const waive = await runCli([
    "checkpoint", "waive", "--packet", f.packetPath, "--gate", "page_kit.sdk_version",
    "--reason", "known synthetic", "--waived-by", OPERATOR, "--review-condition", "synthetic review", "--json",
  ], { qcStandIns });
  assert.notEqual(waive.exitCode, 0, "the waive refusal exits non-zero");
  assert.equal(waive.error, null, `checkpoint waive --json reports its refusal as JSON: ${waive.error?.message}`);
  assert.equal(waive.json?.ok, false, "the waive refusal reports ok: false");
  // The existing untyped refusal (src/cli.mjs waiveOrRefuse): exact message, no code.
  assert.equal(waive.json.error, "Checkpoint gate \"page_kit.sdk_version\" is not blocked (status=pass); no waiver was recorded.");
  assert.equal(Object.hasOwn(waive.json, "refusal_code"), false, "the untyped waive refusal carries no refusal_code");
  assertNoOtherRefusalCode(waive);
  assertNothingWritten(f, beforeWaive);

  assert.ok(accept, "the live-token warning was offered in qc_handoff.open");
  assertAccepted(accept);
  const next = await runNext(f, qcStandIns);
  assertAcceptedListed(handoffOf(next), ref);
  assert.notEqual(next.status, "ready_with_waivers");
  assert.notEqual(doctorOf(f.packetPath, { qcStandIns }).status, "ready_with_waivers");
});

test("F1.0-I14 [stand-in: doctor pass] checkpoint accept on a pass result: refused; nothing written (target_not_warning)", async (t) => {
  const { f, qcStandIns } = fixedSetup(t, [{ key: "clean", result: "pass", reason_code: null }]);
  await runNext(f, qcStandIns);
  const row = sidecarRow(f, fixedDoctorId("clean"));
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(row)], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
});

test("F1.0-I15 [stand-in: doctor excluded] checkpoint accept on an excluded result: refused; nothing written (target_not_warning)", async (t) => {
  const { f, qcStandIns } = fixedSetup(t, [{ key: "out_of_scope", result: "excluded", reason_code: "excluded_by_spec" }]);
  await runNext(f, qcStandIns);
  const row = sidecarRow(f, fixedDoctorId("out_of_scope"));
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(row)], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
});

test("F1.0-I16 [stand-in: QA policy.availability] checkpoint accept on a result reading stale_binding: refused; nothing written (target_not_warning)", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  const qcStandIns = { qa: qaStandIns() };
  const { rows } = installQaStage(f, { observations: [qaObservation({ outcome: "unreachable" })], qcBuildFingerprint: OTHER_BUILD_FP, buildFingerprint: BUILD_FP });
  await runNext(f, qcStandIns);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(rows[0])], { qcStandIns }), "target_not_warning");
  assertNothingWritten(f, before);
});

test("F1.0-I17 [stand-in: doctor mixed row] warning + unexercised members offered to the command: refused; nothing written (members_unresolved)", async (t) => {
  const members = [
    { key: "member_a", result: "warning", reason_code: "live_token" },
    { key: "member_b", result: "unexercised", reason_code: "candidate_cap_reached" },
  ];
  const { f, qcStandIns } = fixedSetup(t, [{ key: "mixed", result: "warning", reason_code: "live_token", members, accept_eligible: false }]);
  const entry = openEntry(handoffOf(await runNext(f, qcStandIns)), fixedDoctorId("mixed"));
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [entry.result_ref], { qcStandIns }), "members_unresolved");
  assertNothingWritten(f, before);
});
