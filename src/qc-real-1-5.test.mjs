// The shared QC accept and handoff rows whose setup needs a doctor check, run
// end to end with the real `built_output.cart_placeholders`
// check in place of the stand-in. No doctor stand-in is passed: the warning
// comes from a real built page under the packet's _site/, through doctor,
// `next`, the doctor sidecar and `checkpoint accept`. F1.0-W2 re-runs its
// doctor half only; its QA warning still comes from the phase-0 QA stand-in
// until a QA producer lands.
//
// Every row asserts the exact set of 1.5 results its setup produces (complete
// rows: id, check, subject, result, reason_code, members), the next status, and
// every qc_handoff section (open, review, lapsed, coverage, accepted,
// inert_accepts and the refs accept_command lists) exactly.
//
// API assumption (every row): the real 1.5 result id is
// `cart_placeholders:<built page path relative to the target repo>:<token>`,
// e.g. `cart_placeholders:_site/runtime-packet-demo/landing/index.html:{item.name}`;
// a page with no token result has one page-level `pass` row keyed "page"; every
// row's subject is exactly {check, page, key} and its members[] is [] (see
// src/cart-placeholders.test.mjs).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  OPERATOR,
  SLUG,
  assertAccepted,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  countReportWrites,
  delay,
  doctorOf,
  fp12,
  handoffOf,
  installQaStage,
  mutateReport,
  qaObservation,
  qaStandIns,
  readJson,
  refOf,
  resultsOf,
  runAccept,
  runCli,
  runNext,
  snapshot,
  writeJson,
} from "./qc-test-factories.mjs";

// No network: importing qc-test-factories.mjs (the only non-builtin static
// import) installs the guard before any module under test loads, so the
// modules below, imported dynamically after it, capture only the guarded fetch
// and http/https. Any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const { computeBuildFingerprint } = await import("./built-site-scope.mjs");

const NAME = "{item.name}";
const PRICE = "{item.price}";
const CHECK = "cart_placeholders";
const GATE = "built_output.cart_placeholders";
const REASON = "known synthetic";
const ROUTES = ["landing", "checkout", "upsell", "receipt"];
const pageRel = (route) => `_site/${SLUG}/${route}/index.html`;
const LANDING = pageRel("landing");
const rowId = (page, key) => `${CHECK}:${page}:${key}`;
const idOf = (token) => rowId(LANDING, token);

// A real built page per CampaignSpec route, loading campaign-cart at a
// verified pin from a synthetic host.
const pageHtml = (route, body) => `<!doctype html><html><head><title>Synthetic</title><meta name="next-page-type" content="${route}"><script src="https://cdn.example.invalid/campaign-cart@v0.4.38/dist/loader.js"></script></head><body>${body}</body></html>\n`;
const PLAIN = "<p class=\"cart-line\">Synthetic cart line</p>";
const tokensBody = (...tokens) => tokens.map((token) => `<p class="cart-line">${token}</p>`).join("");

function writePage(f, route, body) {
  const path = join(f.targetRepo, pageRel(route));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pageHtml(route, body));
}

// The Page Kit build summary, as `campaign-build --json` captures it, dated no
// earlier than every built page.
function writeBuildSummary(f) {
  const path = join(f.targetRepo, ".campaign-runtime/page-kit-build-summary.json");
  writeJson(path, {
    pages: ROUTES.map((route) => ({ campaignSlug: SLUG, status: "ok", inputFile: `src/${SLUG}/${route}.html`, url: `/${SLUG}/${route}/`, warnings: [] })),
  });
  const newest = Math.max(...ROUTES.map((route) => statSync(join(f.targetRepo, pageRel(route))).mtimeMs));
  const stamp = new Date(newest + 1000);
  utimesSync(path, stamp, stamp);
}

// The build is recorded for the current output, as after a rebuild, so the
// only doctor finding a page edit can add is the 1.5 one.
function stampBuild(f) {
  const fingerprint = computeBuildFingerprint(join(f.targetRepo, "_site", SLUG)).fingerprint;
  mutateReport(f, (report) => {
    report.stages.assembly.build_fingerprint = fingerprint;
  });
}

function setLanding(f, body) {
  writePage(f, "landing", body);
  writeBuildSummary(f);
  stampBuild(f);
}

// A packet whose `next` status is `ready` before the landing body is set.
function builtPacket(t, landingBody = tokensBody(NAME)) {
  const f = campaignFixture();
  t.after(f.cleanup);
  for (const route of ROUTES) writePage(f, route, route === "landing" ? landingBody : PLAIN);
  writeBuildSummary(f);
  stampBuild(f);
  return f;
}

// ---------------------------------------------------------------------------
// The exact 1.5 result set, as complete rows.

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const summarize = (row) => ({ id: row.id, check: row.check, subject: row.subject, result: row.result, reason_code: row.reason_code, members: row.members });
const expectRow = (page, key, result, reasonCode = null, members = []) => ({ id: rowId(page, key), check: CHECK, subject: { check: CHECK, page, key }, result, reason_code: reasonCode, members });
const liveRow = (token) => expectRow(LANDING, token, "warning", "live_token");
const pagePass = (route) => expectRow(pageRel(route), "page", "pass");
const OTHERS_PASS = ["checkout", "upsell", "receipt"].map(pagePass);

// `source` is a doctor result, plain doctor JSON or the persisted sidecar.
function assertCartRows(source, expected, label) {
  assert.ok(Array.isArray(source?.derived?.qc_results), `${label}: derived.qc_results[] is present`);
  const rows = source.derived.qc_results.filter((row) => row.check === CHECK);
  assert.deepEqual(rows.map(summarize).sort(byId), [...expected].sort(byId), `${label}: the exact set of cart_placeholders results, complete rows`);
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

// The exact 1.5 issues in a doctor or next warnings[] (one live_token issue
// per warning id), and none in errors[].
function assertGateIssues(result, ids, label) {
  assert.deepEqual(
    (result.warnings || []).filter((issue) => String(issue?.code).startsWith(`${GATE}.`)).map((issue) => [issue.code, issue.detail?.qc_result?.id]).sort(),
    ids.map((id) => [`${GATE}.live_token`, id]).sort(),
    `${label}: the exact cart_placeholders issues in warnings[]`,
  );
  assert.deepEqual((result.errors || []).filter((issue) => String(issue?.code).startsWith(GATE)), [], `${label}: ${GATE} never raises an error`);
}

const currentDoctor = (f, qcStandIns) => doctorOf(f.packetPath, qcStandIns ? { qcStandIns } : {});

// ---------------------------------------------------------------------------
// The complete qc_handoff.

const REF = /^(.+)@([0-9a-f]{12})$/;
const idOfRef = (ref) => {
  assert.match(String(ref), REF, `${ref} is <id>@<fp12>`);
  return String(ref).match(REF)[1];
};
const entryView = (entry) => ({ id: idOfRef(entry.result_ref), check: entry.check, leg: entry.leg, page: entry.page, key: entry.key, result: entry.result, reason_code: entry.reason_code, accept_eligible: entry.accept_eligible, members: entry.members });
const sortById = (entries) => [...entries].sort(byId);
const coverageOrder = (a, b) => `${a.leg} ${a.check} ${a.reason_code}`.localeCompare(`${b.leg} ${b.check} ${b.reason_code}`);
const acceptRefsOf = (command) => [...String(command ?? "").matchAll(/--result (?:'([^']*)'|(\S+))/g)].map((match) => match[1] ?? match[2]);

const liveEntry = (token) => ({ id: idOf(token), check: CHECK, leg: "doctor", page: LANDING, key: token, result: "warning", reason_code: "live_token", accept_eligible: true, members: [] });
const QA_TERMS = { id: "policy.availability:campaign:store_terms", check: "policy.availability", leg: "qa", page: "campaign", key: "store_terms", result: "warning", reason_code: "policy_unreachable", accept_eligible: true, members: [] };
const acceptedEntry = (entry) => ({ ...entry, accepted_by: OPERATOR, reason: REASON });
const lapsedEntry = (entry, why) => ({ ...entry, result_id: entry.id, accepted_by: OPERATOR, why });

// Phase-0 coverage for this packet: no Polish or QA leg recorded, or the
// phase-0 QA stand-in stage (policy.availability captured). 1.5 adds no
// coverage entry: every page here has a verified pin and no cap.
const legCoverage = (leg, check, reasonCode) => ({ check, leg, result: "unexercised", reason_code: reasonCode, count: 0, pages: [] });
const NO_LEGS_COVERAGE = [
  legCoverage("polish", "media.oversize", "leg_not_run"),
  legCoverage("polish", "media.weight", "leg_not_run"),
  ...["policy.availability", "policy.presence", "tracking.order", "tracking.tag", "tracking.url"].map((check) => legCoverage("qa", check, "leg_not_run")),
];
const QA_STAGE_COVERAGE = [
  legCoverage("polish", "media.oversize", "leg_not_run"),
  legCoverage("polish", "media.weight", "leg_not_run"),
  ...["policy.presence", "tracking.order", "tracking.tag", "tracking.url"].map((check) => legCoverage("qa", check, "not_captured_by_this_version")),
];

// Asserts every handoff section exactly (entries compared by id, refs checked
// as <id>@<fp12>) and returns the ref of each listed result by id.
function assertHandoff(handoff, { open = [], review = [], lapsed = [], coverage = NO_LEGS_COVERAGE, accepted = [], inert = [] } = {}, label = "qc_handoff") {
  const openResults = (handoff.open || []).flatMap((group) => group.results || []);
  assert.deepEqual(
    {
      open_groups: sortById((handoff.open || []).map((group) => ({ id: `${group.check}:${group.key}`, pages: group.pages }))),
      open: sortById(openResults.map(entryView)),
      review: sortById((handoff.review || []).map(entryView)),
      lapsed: sortById((handoff.lapsed || []).map((entry) => ({ ...entryView(entry), result_id: entry.result_id, accepted_by: entry.accepted_by, why: entry.why }))),
      coverage: [...(handoff.coverage || [])].sort(coverageOrder),
      accepted: sortById((handoff.accepted || []).map((entry) => ({ ...entryView(entry), accepted_by: entry.accepted_by, reason: entry.reason }))),
      inert_accepts: handoff.inert_accepts,
      accept_command: acceptRefsOf(handoff.accept_command).map(idOfRef).sort(),
    },
    {
      open_groups: sortById(open.map((entry) => ({ id: `${entry.check}:${entry.key}`, pages: [entry.page] }))),
      open: sortById(open),
      review: sortById(review),
      lapsed: sortById(lapsed),
      coverage: [...coverage].sort(coverageOrder),
      accepted: sortById(accepted),
      inert_accepts: inert,
      accept_command: open.filter((entry) => entry.accept_eligible).map((entry) => entry.id).sort(),
    },
    `${label}: every qc_handoff section, exactly`,
  );
  const refs = {};
  for (const entry of [...openResults, ...(handoff.review || []), ...(handoff.accepted || []), ...(handoff.lapsed || [])]) refs[idOfRef(entry.result_ref)] = entry.result_ref;
  return refs;
}

// The accept records on the report, exactly.
const recordView = (record) => ({ result_id: record.result_id, check: record.check, leg: record.leg, subject: record.subject, result_at_accept: record.result_at_accept, measured_source: record.measured_source, accepted_by: record.accepted_by, reason: record.reason });
const doctorRecord = (token) => ({ result_id: idOf(token), check: CHECK, leg: "doctor", subject: { check: CHECK, page: LANDING, key: token }, result_at_accept: "warning", measured_source: "doctor_sidecar", accepted_by: OPERATOR, reason: REASON });
function assertRecords(f, expected, refs) {
  const records = readJson(f.reportPath).qc_accepts;
  assert.deepEqual(sortById((records || []).map((record) => ({ id: record.result_id, ...recordView(record) }))), sortById(expected.map((record) => ({ id: record.result_id, ...record }))), "the exact qc_accepts[] records");
  for (const record of records) assert.equal(`${record.result_id}@${fp12(record.state_fingerprint)}`, refs[record.result_id], `${record.result_id} is bound to the accepted ref`);
  return records;
}

const statusesOf = (assessed) => assessed.map(({ status, why }) => [status, why]);

// next on the F1.0-W1 packet (one live {item.name} on the landing page), then
// checkpoint accept on that warning. Returns the accepted ref.
async function acceptLiveToken(f) {
  const next = await runNext(f);
  assert.equal(next.status, "ready_with_warnings");
  assertCartRows(readJson(f.sidecarPath), [liveRow(NAME), ...OTHERS_PASS], "sidecar before the accept");
  const ref = assertHandoff(handoffOf(next), { open: [liveEntry(NAME)] }, "handoff before the accept")[idOf(NAME)];
  await delay(5);
  assertAccepted(await runAccept(f, [ref]));
  assertRecords(f, [doctorRecord(NAME)], { [idOf(NAME)]: ref });
  return ref;
}

// ---------------------------------------------------------------------------
// Working rows

test("F1.0-W1 [real: 1.5] built page with live {item.name}; next, then checkpoint accept: accept active; result stays warning, status stays ready_with_warnings (live_token)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const f = builtPacket(t);
  const id = idOf(NAME);
  const before = await runNext(f);
  assert.equal(before.status, "ready_with_warnings");
  assertGateIssues(before, [id], "next before the accept");
  assertCartRows(readJson(f.sidecarPath), [liveRow(NAME), ...OTHERS_PASS], "sidecar");
  const ref = assertHandoff(handoffOf(before), { open: [liveEntry(NAME)] }, "handoff before the accept")[id];
  await delay(5);
  assertAccepted(await runAccept(f, [ref]));

  const after = await runNext(f);
  assert.equal(after.status, "ready_with_warnings", "next status stays ready_with_warnings");
  assertGateIssues(after, [id], "next after the accept");
  const refsAfter = assertHandoff(handoffOf(after), { accepted: [acceptedEntry(liveEntry(NAME))] }, "handoff after the accept");
  assert.equal(refsAfter[id], ref, "the accepted entry carries the accepted ref");
  const doctor = currentDoctor(f);
  assertCartRows(doctor, [liveRow(NAME), ...OTHERS_PASS], "doctor after the accept: the result stays warning");
  assert.equal(doctor.status, "ready_with_warnings", "doctor status stays ready_with_warnings");
  assertGateIssues(doctor, [id], "doctor after the accept");
  const records = assertRecords(f, [doctorRecord(NAME)], { [id]: ref });
  assert.deepEqual(statusesOf(assessQcAccepts(records, doctor.derived.qc_results)), [["active", null]]);
});

test("F1.0-W2 [real: 1.5] doctor half: a real 1.5 doctor warning and a QA qc_results warning (full verdict present) accepted in one command: both accepts active; one report write", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const f = builtPacket(t);
  // installQaStage stamps the assembly build fingerprint with its synthetic
  // build; the QA rows are bound to that same build.
  installQaStage(f, { observations: [qaObservation({ outcome: "unreachable" })] });
  const qcStandIns = { qa: qaStandIns() };
  const before = await runNext(f, qcStandIns);
  assert.equal(before.status, "ready_with_warnings");
  assertGateIssues(before, [idOf(NAME)], "next before the accept");
  assertCartRows(readJson(f.sidecarPath), [liveRow(NAME), ...OTHERS_PASS], "sidecar");
  const refs = assertHandoff(handoffOf(before), { open: [liveEntry(NAME), QA_TERMS], coverage: QA_STAGE_COVERAGE }, "handoff before the accept");
  const doctorRef = refs[idOf(NAME)];
  const qaRef = refs[QA_TERMS.id];
  await delay(5);
  const { value: res, count } = await countReportWrites(f, () => runAccept(f, [doctorRef, qaRef], { qcStandIns }));
  assertAccepted(res);
  assert.equal(count, 1, "exactly one Assembly Report write");
  const records = assertRecords(f, [
    doctorRecord(NAME),
    { result_id: QA_TERMS.id, check: QA_TERMS.check, leg: "qa", subject: { check: QA_TERMS.check, page: QA_TERMS.page, key: QA_TERMS.key }, result_at_accept: "warning", measured_source: "qa_full_verdict", accepted_by: OPERATOR, reason: REASON },
  ], refs);

  const after = await runNext(f, qcStandIns);
  assert.equal(after.status, "ready_with_warnings");
  const refsAfter = assertHandoff(handoffOf(after), { accepted: [acceptedEntry(liveEntry(NAME)), acceptedEntry(QA_TERMS)], coverage: QA_STAGE_COVERAGE }, "handoff after the accept");
  assert.deepEqual([refsAfter[idOf(NAME)], refsAfter[QA_TERMS.id]], [doctorRef, qaRef], "the accepted entries carry the accepted refs");
  const doctor = currentDoctor(f, qcStandIns);
  assertCartRows(doctor, [liveRow(NAME), ...OTHERS_PASS], "doctor after the accept");
  const report = readJson(f.reportPath);
  const qaResults = resultsOf(readQaResults({
    stageEvidence: report.stages.qa.evidence,
    stage: report.stages.qa,
    fullVerdict: readJson(report.stages.qa.outputs[0]),
    currentBuild: BUILD_FP,
    qcStandIns,
  }));
  assert.deepEqual(statusesOf(assessQcAccepts(records, [...doctor.derived.qc_results, ...qaResults])), [["active", null], ["active", null]]);
});

test("F1.0-W4 [real: 1.5] accept doctor warning A (sidecar stale-stamped), then accept doctor warning B without re-running next: accept B active", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const f = builtPacket(t, tokensBody(NAME, PRICE));
  const before = await runNext(f);
  assert.equal(before.status, "ready_with_warnings");
  assertCartRows(readJson(f.sidecarPath), [liveRow(NAME), liveRow(PRICE), ...OTHERS_PASS], "sidecar");
  const refs = assertHandoff(handoffOf(before), { open: [liveEntry(NAME), liveEntry(PRICE)] }, "handoff before the accepts");
  const refA = refs[idOf(NAME)];
  const refB = refs[idOf(PRICE)];
  await delay(5);
  assertAccepted(await runAccept(f, [refA]));
  assert.equal(readJson(f.sidecarPath).stale, true, "accepting A stale-stamps the doctor sidecar");
  assertAccepted(await runAccept(f, [refB]));
  const records = assertRecords(f, [doctorRecord(NAME), doctorRecord(PRICE)], refs);
  assert.deepEqual(records.map((record) => record.result_id), [idOf(NAME), idOf(PRICE)], "A then B");
  const doctor = currentDoctor(f);
  assertCartRows(doctor, [liveRow(NAME), liveRow(PRICE), ...OTHERS_PASS], "doctor after the accepts");
  assert.deepEqual(statusesOf(assessQcAccepts(records, doctor.derived.qc_results)), [["active", null], ["active", null]]);
  const after = await runNext(f);
  assert.equal(after.status, "ready_with_warnings");
  const refsAfter = assertHandoff(handoffOf(after), { accepted: [acceptedEntry(liveEntry(NAME)), acceptedEntry(liveEntry(PRICE))] }, "handoff after the accepts");
  assert.deepEqual([refsAfter[idOf(NAME)], refsAfter[idOf(PRICE)]], [refA, refB], "the accepted entries carry the accepted refs");
});

test("F1.0-W5 [real: 1.5] a packet whose next status is ready gains one live {item.name} on a built page; run next: next status ready_with_warnings (live_token)", async (t) => {
  const f = builtPacket(t, PLAIN);
  const before = await runNext(f);
  assert.equal(before.status, "ready", `precondition: next status is ready: ${JSON.stringify((before.warnings || []).map((issue) => issue.code))}`);
  assert.deepEqual(before.warnings || [], [], "precondition: next has no warnings");
  assertCartRows(readJson(f.sidecarPath), [pagePass("landing"), ...OTHERS_PASS], "sidecar before the edit: a page pass per route");
  assertHandoff(handoffOf(before), {}, "handoff before the edit");
  setLanding(f, tokensBody(NAME));
  const after = await runNext(f);
  assert.equal(after.status, "ready_with_warnings");
  assert.deepEqual((after.warnings || []).map((issue) => issue.code), [`${GATE}.live_token`], "the only new warning is the 1.5 live_token issue");
  const issue = after.warnings[0];
  assert.equal(issue.detail?.qc_result?.id, idOf(NAME));
  assert.equal(issue.detail.qc_result.result, "warning");
  assert.equal(issue.detail.qc_result.reason_code, "live_token");
  assertCartRows(readJson(f.sidecarPath), [liveRow(NAME), ...OTHERS_PASS], "sidecar after the edit");
  assertHandoff(handoffOf(after), { open: [liveEntry(NAME)] }, "handoff after the edit");
});

// ---------------------------------------------------------------------------
// Broken rows

test("F1.0-B3 [real: 1.5] accept F1.0-W1, then add a second {item.name} element on the same page: accept lapsed (state_changed)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const f = builtPacket(t);
  const id = idOf(NAME);
  const ref = await acceptLiveToken(f);
  setLanding(f, tokensBody(NAME, NAME));
  const doctor = currentDoctor(f);
  const rows = assertCartRows(doctor, [liveRow(NAME), ...OTHERS_PASS], "doctor after the edit");
  assert.deepEqual(rows[id].observation.occurrences.map((occurrence) => occurrence.where), ["text", "text"], "two occurrences now");
  assert.deepEqual(statusesOf(assessQcAccepts(readJson(f.reportPath).qc_accepts, doctor.derived.qc_results)), [["lapsed", "state_changed"]]);
  const next = await runNext(f);
  assert.equal(next.status, "ready_with_warnings");
  const refs = assertHandoff(handoffOf(next), { open: [liveEntry(NAME)], lapsed: [lapsedEntry(liveEntry(NAME), "state_changed")] }, "handoff after the edit");
  assert.notEqual(refs[id], ref, "the current result has a new state");
});

// These checks are tamper evidence, not authorship proof: a full reconstruction reads as valid, and this test pins that documented outcome.
test("F1.0-B7 [real: 1.5] fully reconstructed hand-written accept on a current warning: copied id@fp, the sidecar's measured_at, a later accepted_at, named human, recomputed checksum: accept active (A1 accepted behaviour)", async (t) => {
  const { assessQcAccepts, qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const f = builtPacket(t);
  const id = idOf(NAME);
  const before = await runNext(f);
  assert.equal(before.status, "ready_with_warnings");
  assertHandoff(handoffOf(before), { open: [liveEntry(NAME)] }, "handoff before the record");
  const row = assertCartRows(readJson(f.sidecarPath), [liveRow(NAME), ...OTHERS_PASS], "sidecar")[id];
  const unsigned = {
    schema: "campaigns-os-qc-accept/v0",
    scope: "qc_accept",
    result_id: row.id,
    check: row.check,
    leg: row.leg,
    subject: row.subject,
    state_fingerprint: row.state_fingerprint,
    result_at_accept: "warning",
    measured_at: row.measured_at,
    measured_source: "doctor_sidecar",
    reason: REASON,
    accepted_by: OPERATOR,
    accepted_at: new Date(Date.parse(row.measured_at) + 1000).toISOString(),
    recorded_by: "campaigns-os checkpoint accept",
  };
  const record = { ...unsigned, integrity: qcAcceptIntegrity(unsigned) };
  mutateReport(f, (report) => {
    report.qc_accepts = [...(Array.isArray(report.qc_accepts) ? report.qc_accepts : []), record];
  });
  const doctor = currentDoctor(f);
  assertCartRows(doctor, [liveRow(NAME), ...OTHERS_PASS], "doctor after the record");
  assert.deepEqual(statusesOf(assessQcAccepts([record], doctor.derived.qc_results)), [["active", null]]);
  const after = await runNext(f);
  assert.equal(after.status, "ready_with_warnings");
  const refs = assertHandoff(handoffOf(after), { accepted: [acceptedEntry(liveEntry(NAME))] }, "handoff after the record");
  assert.equal(refs[id], refOf(row), "the accepted entry carries the copied ref");
});

test("F1.0-B13 [real: 1.5] accept F1.0-W1, then remove the live {item.name} text: accept orphaned (no_current_result)", async (t) => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const f = builtPacket(t);
  await acceptLiveToken(f);
  setLanding(f, PLAIN);
  const doctor = currentDoctor(f);
  assertCartRows(doctor, [pagePass("landing"), ...OTHERS_PASS], "doctor after the edit: no current result has that id");
  assert.deepEqual(statusesOf(assessQcAccepts(readJson(f.reportPath).qc_accepts, doctor.derived.qc_results)), [["orphaned", "no_current_result"]]);
  const next = await runNext(f);
  assert.equal(next.status, "ready", "no doctor warning is left");
  assertHandoff(handoffOf(next), {}, "handoff after the edit: an orphaned accept is listed nowhere");
});

test("F1.0-B23 [real: 1.5] doctor sidecar holding the row with generated_by \"agent\"; accept attempted: refused (no_persisted_finding)", async (t) => {
  const f = builtPacket(t);
  const next = await runNext(f);
  assert.equal(next.status, "ready_with_warnings");
  const ref = assertHandoff(handoffOf(next), { open: [liveEntry(NAME)] })[idOf(NAME)];
  const sidecar = readJson(f.sidecarPath);
  assertCartRows(sidecar, [liveRow(NAME), ...OTHERS_PASS], "setup: the sidecar holds the row");
  sidecar.generated_by = "agent";
  writeJson(f.sidecarPath, sidecar);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [ref]), "no_persisted_finding");
  assertNothingWritten(f, before);
});

test("F1.0-B25 [real: 1.5] doctor sidecar holding the row with schema_version campaigns-os-doctor-output/v9; accept attempted: refused (no_persisted_finding)", async (t) => {
  const f = builtPacket(t);
  const next = await runNext(f);
  assert.equal(next.status, "ready_with_warnings");
  const ref = assertHandoff(handoffOf(next), { open: [liveEntry(NAME)] })[idOf(NAME)];
  const sidecar = readJson(f.sidecarPath);
  assertCartRows(sidecar, [liveRow(NAME), ...OTHERS_PASS], "setup: the sidecar holds the row");
  sidecar.schema_version = "campaigns-os-doctor-output/v9";
  writeJson(f.sidecarPath, sidecar);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [ref]), "no_persisted_finding");
  assertNothingWritten(f, before);
});

// ---------------------------------------------------------------------------
// Incomplete rows

test("F1.0-I4 [real: 1.5] doctor warning seen only by plain doctor (no sidecar); accept attempted: refused (no_persisted_finding)", async (t) => {
  const f = builtPacket(t);
  // --no-live-refs: plain doctor (no --write, so no sidecar) without the
  // live campaign read a built _site/ would otherwise make; no network.
  const doctorRun = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
  assert.equal(existsSync(f.sidecarPath), false, "plain doctor persisted no sidecar");
  const row = assertCartRows(doctorRun.json, [liveRow(NAME), ...OTHERS_PASS], "plain doctor")[idOf(NAME)];
  assert.equal(doctorRun.json.status, "ready_with_warnings");
  assertGateIssues(doctorRun.json, [idOf(NAME)], "plain doctor");
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(row)]), "no_persisted_finding");
  assertNothingWritten(f, before);
});
