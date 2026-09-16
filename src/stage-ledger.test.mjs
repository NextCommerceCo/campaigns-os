import assert from "node:assert/strict";
import { test } from "node:test";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assemblyReportMatchesPacket,
  commitAssemblyReport,
  deriveAssemblyReportSummary,
  producerStageOutcomeUnchanged,
  recordProducerStageOutcome,
  withDerivedAssemblyReportSummary,
} from "./stage-ledger.mjs";

function report() {
  return {
    stages: {
      doctor: { stage: "doctor", status: "pending", inputs: [], outputs: [], commands: [], blockers: [], warnings: [] },
      qa: { stage: "qa", status: "pending", inputs: [], outputs: [], commands: [], blockers: [], warnings: [] },
    },
  };
}

test("recordProducerStageOutcome completes a passing producer with owned evidence and timestamp", () => {
  const updated = recordProducerStageOutcome(report(), {
    stage: "doctor",
    disposition: "ready_with_warnings",
    timestamp: "2026-09-10T01:02:03.000Z",
    command: "campaigns-os doctor",
    outputs: [".campaign-runtime/doctor-output.json"],
    warnings: ["store profile warning"],
  });
  assert.deepEqual(updated.stages.doctor, {
    stage: "doctor",
    status: "completed_with_warnings",
    inputs: [],
    outputs: [".campaign-runtime/doctor-output.json"],
    commands: ["campaigns-os doctor"],
    blockers: [],
    warnings: ["store profile warning"],
    checked_at: "2026-09-10T01:02:03.000Z",
    completed_at: "2026-09-10T01:02:03.000Z",
  });
});

test("recordProducerStageOutcome records a blocker and removes stale completion", () => {
  const input = report();
  input.stages.qa.completed_at = "2026-09-09T00:00:00.000Z";
  const updated = recordProducerStageOutcome(input, {
    stage: "qa",
    disposition: "blocked",
    timestamp: "2026-09-10T02:00:00.000Z",
    command: "campaigns-os qa run",
    outputs: ["qa-output/qa_2.json"],
    blockers: ["checkout assertion failed"],
  });
  assert.equal(updated.stages.qa.status, "blocked");
  assert.equal(updated.stages.qa.completed_at, undefined);
  assert.equal(updated.stages.qa.checked_at, "2026-09-10T02:00:00.000Z");
  assert.deepEqual(updated.stages.qa.blockers, ["checkout assertion failed"]);
});

test("recordProducerStageOutcome rejects unknown stages and non-producer timestamps", () => {
  assert.throws(() => recordProducerStageOutcome(report(), { stage: "deploy", disposition: "ready", timestamp: "2026-09-10T00:00:00.000Z" }), /doctor or qa/);
  assert.throws(() => recordProducerStageOutcome(report(), { stage: "qa", disposition: "ready", timestamp: "not-a-time" }), /timestamp/);
});

// Producer-owned identity (#313 follow-up). Before this, the canonical keys
// refreshed while hand-authored `verdict_run_id` / `evidence` survived the
// spread untouched, so a report could carry today's status and output links
// beside yesterday's failed run id and an already-fixed "remaining blocker".

function reportWithHandAuthoredQa(extra = {}) {
  const input = report();
  input.stages.qa = {
    ...input.stages.qa,
    status: "blocked",
    checked_at: "2026-09-10T09:00:00.000Z",
    completed_at: "2026-09-10T09:00:00.000Z",
    verdict_run_id: "YESTERDAY_RUN",
    evidence: { remaining_blocker: "a bug that has since been fixed" },
    waivers: ["operator-approved exception"],
    ...extra,
  };
  return input;
}

test("producer identity replaces the previous pair and archives it with its own timestamps", () => {
  const updated = recordProducerStageOutcome(reportWithHandAuthoredQa(), {
    stage: "qa",
    disposition: "ready_with_exceptions",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    outputs: ["qa-output/TODAY_RUN.json"],
    identity: { verdict_run_id: "TODAY_RUN" },
    evidence: { runtime_result: "all persisted cases verified" },
  });
  const qa = updated.stages.qa;
  assert.equal(qa.verdict_run_id, "TODAY_RUN");
  assert.deepEqual(qa.evidence, { runtime_result: "all persisted cases verified" });
  assert.equal(Array.isArray(qa.history), true);
  assert.equal(qa.history.length, 1);
  assert.deepEqual(qa.history[0], {
    status: "blocked",
    checked_at: "2026-09-10T09:00:00.000Z",
    verdict_run_id: "YESTERDAY_RUN",
    evidence: { remaining_blocker: "a bug that has since been fixed" },
  });
});

test("producer identity never launders a historical timestamp it does not have", () => {
  const input = reportWithHandAuthoredQa();
  delete input.stages.qa.checked_at;
  delete input.stages.qa.completed_at;
  const updated = recordProducerStageOutcome(input, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
  });
  const entry = updated.stages.qa.history[0];
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "checked_at"), false);
  assert.equal(entry.verdict_run_id, "YESTERDAY_RUN");
});

test("unrelated extension fields survive a producer write verbatim", () => {
  const updated = recordProducerStageOutcome(reportWithHandAuthoredQa({ custom_note: { by: "ops", n: 3 } }), {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
  });
  assert.deepEqual(updated.stages.qa.waivers, ["operator-approved exception"]);
  assert.deepEqual(updated.stages.qa.custom_note, { by: "ops", n: 3 });
});

test("a producer write with no identity clears a stale pair rather than keeping it beside fresh status", () => {
  const updated = recordProducerStageOutcome(reportWithHandAuthoredQa(), {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(updated.stages.qa, "verdict_run_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updated.stages.qa, "evidence"), false);
  assert.equal(updated.stages.qa.history.length, 1);
});

test("re-recording the same verdict does not duplicate history", () => {
  const args = {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
    evidence: { runtime_result: "ok" },
  };
  const once = recordProducerStageOutcome(reportWithHandAuthoredQa(), args);
  const twice = recordProducerStageOutcome(once, { ...args, timestamp: "2026-09-11T03:30:00.000Z" });
  assert.equal(twice.stages.qa.history.length, 1);
  assert.equal(twice.stages.qa.verdict_run_id, "TODAY_RUN");
});

test("history is bounded oldest-first and drops the oldest entries", () => {
  let current = reportWithHandAuthoredQa();
  for (let i = 1; i <= 8; i += 1) {
    current = recordProducerStageOutcome(current, {
      stage: "qa",
      disposition: "ready",
      timestamp: `2026-09-11T0${i}:00:00.000Z`,
      command: "campaigns-os qa run",
      identity: { verdict_run_id: `RUN_${i}` },
    });
  }
  const history = current.stages.qa.history;
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((entry) => entry.verdict_run_id), ["RUN_3", "RUN_4", "RUN_5", "RUN_6", "RUN_7"]);
  assert.equal(current.stages.qa.verdict_run_id, "RUN_8");
});

test("a purchase-proof summary is producer-owned and counts-only", () => {
  const updated = recordProducerStageOutcome(report(), {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    proof: { declared_order_path_depth: "common", order_paths_executed: 3, orders_created: 3, orders_verified: 3, all_orders_test_mode: true },
  });
  assert.deepEqual(updated.stages.qa.purchase_proof, {
    declared_order_path_depth: "common",
    order_paths_executed: 3,
    orders_created: 3,
    orders_verified: 3,
    all_orders_test_mode: true,
  });
});

test("the doctor stage never carries QA-owned identity", () => {
  const updated = recordProducerStageOutcome(report(), {
    stage: "doctor",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os doctor",
    identity: { verdict_run_id: "TODAY_RUN" },
    proof: { order_paths_executed: 1 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(updated.stages.doctor, "verdict_run_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updated.stages.doctor, "purchase_proof"), false);
});

// `$defs.stage.evidence` in schemas/campaign-runtime-assembly-report.v0.schema.json
// is `oneOf: [array, object]`. The object branch archived; the array branch was
// deleted with no history entry at all, so operator notes written in the legal
// array shape left the report entirely on the next producer write.

test("array-shaped previous evidence is archived, not deleted", () => {
  const input = report();
  input.stages.qa = {
    ...input.stages.qa,
    status: "completed_with_warnings",
    checked_at: "2026-09-10T09:00:00.000Z",
    evidence: [{ note: "operator note A" }, { note: "operator note B" }],
  };
  const updated = recordProducerStageOutcome(input, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
    evidence: { runtime_result: "all persisted cases verified" },
  });
  const qa = updated.stages.qa;
  assert.deepEqual(qa.evidence, { runtime_result: "all persisted cases verified" });
  assert.equal(qa.history.length, 1);
  assert.deepEqual(qa.history[0], {
    status: "completed_with_warnings",
    checked_at: "2026-09-10T09:00:00.000Z",
    evidence: [{ note: "operator note A" }, { note: "operator note B" }],
  });
});

test("array-shaped evidence survives a producer write that carries no evidence of its own", () => {
  const input = report();
  input.stages.qa = { ...input.stages.qa, status: "blocked", evidence: [{ note: "operator note A" }] };
  const updated = recordProducerStageOutcome(input, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
  });
  const qa = updated.stages.qa;
  assert.equal(Object.prototype.hasOwnProperty.call(qa, "evidence"), false);
  assert.deepEqual(qa.history, [{ status: "blocked", evidence: [{ note: "operator note A" }] }]);
});

test("an archived array is a copy, not a live reference into the caller's report", () => {
  const input = report();
  const notes = [{ note: "operator note A" }];
  input.stages.qa = { ...input.stages.qa, status: "blocked", evidence: notes };
  const updated = recordProducerStageOutcome(input, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
  });
  notes[0].note = "mutated after the write";
  assert.deepEqual(updated.stages.qa.history[0].evidence, [{ note: "operator note A" }]);
});

test("re-recording identical array evidence does not grow history", () => {
  const args = {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
    evidence: [{ note: "operator note A" }],
  };
  const once = recordProducerStageOutcome(report(), args);
  assert.deepEqual(once.stages.qa.evidence, [{ note: "operator note A" }]);
  const twice = recordProducerStageOutcome(once, { ...args, timestamp: "2026-09-11T03:30:00.000Z" });
  assert.equal(Object.prototype.hasOwnProperty.call(twice.stages.qa, "history"), false);
});

// Kilo review, PR #315: the dedup compared evidence with a plain
// JSON.stringify, which is key-order sensitive. `previous` comes back from disk
// in whatever order it was serialized in; the producer builds the incoming copy
// in its own order. Equal evidence written twice must stay one chapter.
test("evidence that differs only in key order is a re-record, not a new chapter", () => {
  const first = recordProducerStageOutcome(report(), {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
    evidence: { checked: ["cart", "upsell"], summary: "clean", counts: { fail: 0, warn: 1 } },
  });
  // A disk round-trip with the keys reordered, exactly as a reserializer or a
  // hand-edit would leave them.
  const roundTripped = JSON.parse(JSON.stringify(first));
  roundTripped.stages.qa.evidence = { counts: { warn: 1, fail: 0 }, summary: "clean", checked: ["cart", "upsell"] };

  const second = recordProducerStageOutcome(roundTripped, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T03:30:00.000Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
    evidence: { checked: ["cart", "upsell"], summary: "clean", counts: { fail: 0, warn: 1 } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(second.stages.qa, "history"), false);
});

test("array evidence keeps its order as meaning even though object keys do not", () => {
  const first = recordProducerStageOutcome(report(), {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    evidence: [{ note: "A" }, { note: "B" }],
  });
  const second = recordProducerStageOutcome(first, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T03:30:00.000Z",
    command: "campaigns-os qa run",
    evidence: [{ note: "B" }, { note: "A" }],
  });
  assert.deepEqual(second.stages.qa.history, [{ status: "completed", checked_at: "2026-09-11T02:59:06.305Z", evidence: [{ note: "A" }, { note: "B" }] }]);
});

// Kilo review, PR #315: an empty object or array passed the truthiness check
// and produced a history entry carrying nothing, evicting a real entry from the
// bounded window.
test("empty prior evidence archives nothing", () => {
  for (const empty of [{}, []]) {
    const input = report();
    input.stages.qa = { ...input.stages.qa, status: "blocked", evidence: empty };
    const updated = recordProducerStageOutcome(input, {
      stage: "qa",
      disposition: "ready",
      timestamp: "2026-09-11T02:59:06.305Z",
      command: "campaigns-os qa run",
      identity: { verdict_run_id: "TODAY_RUN" },
      evidence: [{ note: "operator note A" }],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(updated.stages.qa, "history"), false, `empty ${JSON.stringify(empty)} must not archive`);
  }
});

test("empty prior evidence beside a real prior identity archives the identity alone", () => {
  const input = report();
  input.stages.qa = { ...input.stages.qa, status: "blocked", checked_at: "2026-09-10T00:00:00.000Z", verdict_run_id: "YESTERDAY_RUN", evidence: {} };
  const updated = recordProducerStageOutcome(input, {
    stage: "qa",
    disposition: "ready",
    timestamp: "2026-09-11T02:59:06.305Z",
    command: "campaigns-os qa run",
    identity: { verdict_run_id: "TODAY_RUN" },
  });
  assert.deepEqual(updated.stages.qa.history, [{ status: "blocked", checked_at: "2026-09-10T00:00:00.000Z", verdict_run_id: "YESTERDAY_RUN" }]);
});

test("producerStageOutcomeUnchanged ignores only the stage's own timestamps", () => {
  const base = recordProducerStageOutcome(report(), {
    stage: "doctor", disposition: "blocked", timestamp: "2026-09-13T10:00:00.000Z",
    command: "campaigns-os doctor", outputs: ["/out/doctor-output.json"], blockers: ["one"], warnings: [],
  });
  const rerun = recordProducerStageOutcome(base, {
    stage: "doctor", disposition: "blocked", timestamp: "2026-09-13T10:05:00.000Z",
    command: "campaigns-os doctor", outputs: ["/out/doctor-output.json"], blockers: ["one"], warnings: [],
  });
  assert.equal(producerStageOutcomeUnchanged(base, rerun, "doctor"), true);

  const changed = recordProducerStageOutcome(base, {
    stage: "doctor", disposition: "ready", timestamp: "2026-09-13T10:05:00.000Z",
    command: "campaigns-os doctor", outputs: ["/out/doctor-output.json"], blockers: [], warnings: [],
  });
  assert.equal(producerStageOutcomeUnchanged(base, changed, "doctor"), false);

  // A timestamp on the OTHER stage is someone else's data and still counts as a change.
  const otherStage = JSON.parse(JSON.stringify(rerun));
  otherStage.stages.qa.checked_at = "2026-09-13T10:05:00.000Z";
  assert.equal(producerStageOutcomeUnchanged(base, otherStage, "doctor"), false);
  assert.throws(() => producerStageOutcomeUnchanged(base, rerun, "build"), /doctor or qa/);
});

// commitAssemblyReport: the one load -> identity -> mutate -> write -> keep the
// doctor sidecar honest step every report-editing command runs.

function workspaceFixture({ report = { identity: { map_id: "map_1", public_route_slug: "demo" }, stages: {} }, sidecar = { ok: true, status: "ready" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "commit-report-"));
  const targetRepo = join(dir, "target");
  mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const doctorOutPath = join(targetRepo, ".campaign-runtime/doctor-output.json");
  if (report) writeFileSync(reportPath, JSON.stringify(report));
  if (sidecar) writeFileSync(doctorOutPath, JSON.stringify(sidecar));
  const packet = { spec: { map_id: "map_1" }, campaign: { public_route_slug: "demo" } };
  return { dir, workspace: { packet, packetPath: join(dir, "packet.json"), targetRepo, reportPath, doctorOutPath } };
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("commitAssemblyReport writes the mutated report atomically and stamps the retained sidecar stale", () => {
  const { dir, workspace } = workspaceFixture();
  const before = statSync(workspace.reportPath).ino;
  const outcome = commitAssemblyReport(workspace, (report) => ({ ...report, note: "edited" }), {
    command: "unit waive",
    staleReason: "unit reason",
  });
  assert.equal(outcome.written, true);
  assert.equal(outcome.skipped, null);
  assert.equal(readJson(workspace.reportPath).note, "edited");
  assert.deepEqual(outcome.report, readJson(workspace.reportPath));
  // tmp + rename: the path now names a new file, and no tmp file is left behind.
  assert.notEqual(statSync(workspace.reportPath).ino, before);
  assert.equal(existsSync(`${workspace.reportPath}.tmp`), false);
  const sidecar = readJson(workspace.doctorOutPath);
  assert.equal(sidecar.stale, true);
  assert.equal(sidecar.stale_marked_by, "unit waive");
  assert.equal(sidecar.stale_reason, "unit reason");
  assert.equal(sidecar.status, "ready", "the stamp preserves the snapshot's fields");
  rmSync(dir, { recursive: true, force: true });
});

test("commitAssemblyReport refreshes the doctor sidecar wholesale, atomically, clearing a stale stamp", () => {
  const { dir, workspace } = workspaceFixture({ sidecar: { ok: true, status: "ancient", stale: true } });
  const before = statSync(workspace.doctorOutPath).ino;
  const outcome = commitAssemblyReport(workspace, (report) => ({ ...report, note: "edited" }), {
    refreshDoctor: ({ written }) => ({ ok: true, status: written ? "fresh" : "unexpected" }),
  });
  assert.equal(outcome.written, true);
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: true, status: "fresh" });
  assert.notEqual(statSync(workspace.doctorOutPath).ino, before, "the sidecar is replaced, never rewritten in place");
  rmSync(dir, { recursive: true, force: true });
});

test("commitAssemblyReport creates the sidecar directory a refresh needs", () => {
  const { dir, workspace } = workspaceFixture();
  const doctorOutPath = join(dir, "elsewhere/nested/doctor-output.json");
  commitAssemblyReport({ ...workspace, doctorOutPath }, (report) => report, { refreshDoctor: () => ({ ok: true }) });
  assert.deepEqual(readJson(doctorOutPath), { ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test("a null mutation leaves the report's bytes alone: no stale stamp, but a refresh still lands", () => {
  const { dir, workspace } = workspaceFixture();
  const bytes = readFileSync(workspace.reportPath, "utf8");
  const stale = commitAssemblyReport(workspace, () => null, { command: "unit", staleReason: "unit" });
  assert.deepEqual([stale.written, stale.skipped], [false, "unchanged"]);
  assert.equal(readFileSync(workspace.reportPath, "utf8"), bytes);
  assert.notEqual(readJson(workspace.doctorOutPath).stale, true, "nothing changed, so nothing went stale");
  let seen = null;
  const refreshed = commitAssemblyReport(workspace, () => null, { refreshDoctor: (outcome) => { seen = outcome; return { ok: false, status: "current" }; } });
  assert.deepEqual([refreshed.written, refreshed.skipped], [false, "unchanged"]);
  assert.equal(seen.written, false);
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: false, status: "current" });
  assert.equal(readFileSync(workspace.reportPath, "utf8"), bytes);
  rmSync(dir, { recursive: true, force: true });
});

test("a refresh returning null leaves the sidecar as it is", () => {
  const { dir, workspace } = workspaceFixture({ sidecar: { ok: true, status: "kept" } });
  commitAssemblyReport(workspace, (report) => ({ ...report, note: "edited" }), { refreshDoctor: () => null });
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: true, status: "kept" });
  rmSync(dir, { recursive: true, force: true });
});

test("a producer stage write is skipped when only its timestamps would move, and the refresh still runs", () => {
  const { dir, workspace } = workspaceFixture();
  const restate = (timestamp) => (report) => recordProducerStageOutcome(report, {
    stage: "doctor",
    disposition: "ready",
    timestamp,
    command: "campaigns-os doctor",
    outputs: [workspace.doctorOutPath],
  });
  const first = commitAssemblyReport(workspace, restate("2026-09-14T00:00:00.000Z"), { stage: "doctor", refreshDoctor: () => ({ ok: true, run: 1 }) });
  assert.equal(first.written, true);
  const bytes = readFileSync(workspace.reportPath, "utf8");
  const rerun = commitAssemblyReport(workspace, restate("2026-09-14T00:05:00.000Z"), { stage: "doctor", refreshDoctor: () => ({ ok: true, run: 2 }) });
  assert.deepEqual([rerun.written, rerun.skipped], [false, "unchanged"]);
  assert.equal(readFileSync(workspace.reportPath, "utf8"), bytes, "a re-record does not move the report's digest");
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: true, run: 2 }, "the sidecar is this run's");
  rmSync(dir, { recursive: true, force: true });
});

test("a producer never restates its outcome into another campaign's report, or into no report", () => {
  const { dir, workspace } = workspaceFixture({ report: { identity: { map_id: "map_other", public_route_slug: "demo" }, stages: {} } });
  const bytes = readFileSync(workspace.reportPath, "utf8");
  let called = false;
  const foreign = commitAssemblyReport(workspace, () => { called = true; return {}; }, { stage: "qa", refreshDoctor: ({ written }) => (written ? { ok: true } : null) });
  assert.deepEqual([foreign.written, foreign.skipped, called], [false, "identity", false]);
  assert.equal(readFileSync(workspace.reportPath, "utf8"), bytes);
  assert.deepEqual(foreign.report, JSON.parse(bytes), "the report read is reported back");

  rmSync(workspace.reportPath);
  const absent = commitAssemblyReport(workspace, () => { called = true; return {}; }, { stage: "doctor", refreshDoctor: () => ({ ok: true, status: "written-anyway" }) });
  assert.deepEqual([absent.written, absent.skipped, absent.report, called], [false, "absent", null, false]);
  assert.equal(existsSync(workspace.reportPath), false);
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: true, status: "written-anyway" }, "a producer without a ledger still keeps the sidecar current");
  rmSync(dir, { recursive: true, force: true });
});

test("an operator edit requires the report to exist and binds no identity", () => {
  const { dir, workspace } = workspaceFixture({ report: { stages: {} } });
  const outcome = commitAssemblyReport(workspace, (report) => ({ ...report, waived: true }), { command: "unit", staleReason: "unit" });
  assert.equal(outcome.written, true, "a report with no identity is edited as it always was");
  assert.equal(readJson(workspace.doctorOutPath).stale, true);
  writeFileSync(workspace.doctorOutPath, JSON.stringify({ ok: true, status: "ready" }));
  rmSync(workspace.reportPath);
  assert.throws(
    () => commitAssemblyReport(workspace, (report) => report, { command: "unit", staleReason: "unit" }),
    /Assembly Report not found at .*assembly-report\.json; run prepare-build\/start first\./,
  );
  assert.notEqual(readJson(workspace.doctorOutPath).stale, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a malformed report fails by name and path, and stamps nothing", () => {
  const { dir, workspace } = workspaceFixture();
  writeFileSync(workspace.reportPath, "{ \"identity\": ");
  let called = false;
  for (const options of [
    { command: "unit", staleReason: "unit" },
    { stage: "doctor", refreshDoctor: () => ({ ok: true, status: "written-anyway" }) },
  ]) {
    assert.throws(
      () => commitAssemblyReport(workspace, () => { called = true; return {}; }, options),
      (error) => error instanceof Error && !(error instanceof SyntaxError)
        && /^Assembly Report at .*assembly-report\.json is not valid JSON: /.test(error.message),
      JSON.stringify(options),
    );
  }
  assert.equal(called, false, "the mutation never sees a report that did not parse");
  assert.equal(readFileSync(workspace.reportPath, "utf8"), "{ \"identity\": ", "the torn bytes are left for inspection");
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: true, status: "ready" }, "neither a stale stamp nor a refresh lands");
  rmSync(dir, { recursive: true, force: true });
});

test("a mutation that throws writes nothing and stamps nothing", () => {
  const { dir, workspace } = workspaceFixture();
  const bytes = readFileSync(workspace.reportPath, "utf8");
  assert.throws(() => commitAssemblyReport(workspace, () => { throw new Error("gate is not blocked"); }, { command: "unit", staleReason: "unit" }), /gate is not blocked/);
  assert.equal(readFileSync(workspace.reportPath, "utf8"), bytes);
  assert.notEqual(readJson(workspace.doctorOutPath).stale, true);
  assert.throws(() => commitAssemblyReport(workspace, () => { throw new Error("bad timestamp"); }, { stage: "qa", refreshDoctor: () => ({ ok: true }) }), /bad timestamp/);
  assert.deepEqual(readJson(workspace.doctorOutPath), { ok: true, status: "ready" }, "no refresh after a failed mutation");
  rmSync(dir, { recursive: true, force: true });
});

test("commitAssemblyReport names exactly one doctor-freshness strategy and a complete workspace", () => {
  const { dir, workspace } = workspaceFixture();
  const edit = (report) => report;
  assert.throws(() => commitAssemblyReport(workspace, edit, {}), /exactly one of refreshDoctor .* or staleReason/);
  assert.throws(() => commitAssemblyReport(workspace, edit, { refreshDoctor: () => null, staleReason: "both", command: "unit" }), /exactly one of/);
  assert.throws(() => commitAssemblyReport(workspace, edit, { staleReason: "no command" }), /requires command with staleReason/);
  assert.throws(() => commitAssemblyReport(workspace, edit, { stage: "polish", refreshDoctor: () => null }), /Producer stage must be doctor or qa/);
  assert.throws(() => commitAssemblyReport(workspace, "not a function", { refreshDoctor: () => null }), /mutate\(report\) function/);
  assert.throws(() => commitAssemblyReport({ ...workspace, reportPath: "" }, edit, { refreshDoctor: () => null }), /workspace with reportPath/);
  assert.throws(() => commitAssemblyReport({ ...workspace, doctorOutPath: null }, edit, { refreshDoctor: () => null }), /workspace with doctorOutPath/);
  assert.throws(() => commitAssemblyReport({ ...workspace, targetRepo: null }, edit, { command: "unit", staleReason: "unit" }), /workspace with targetRepo/);
  assert.equal(readFileSync(workspace.reportPath, "utf8"), JSON.stringify({ identity: { map_id: "map_1", public_route_slug: "demo" }, stages: {} }));
  rmSync(dir, { recursive: true, force: true });
});

test("assemblyReportMatchesPacket compares map id and public route slug, absent on both sides included", () => {
  const packet = { spec: { map_id: "map_1" }, campaign: { public_route_slug: "demo" } };
  assert.equal(assemblyReportMatchesPacket({ identity: { map_id: "map_1", public_route_slug: "demo" } }, packet), true);
  assert.equal(assemblyReportMatchesPacket({ identity: { map_id: "map_1", public_route_slug: "other" } }, packet), false);
  assert.equal(assemblyReportMatchesPacket({ identity: { map_id: " map_1 ", public_route_slug: "demo" } }, packet), true, "identity is trimmed");
  assert.equal(assemblyReportMatchesPacket({ stages: {} }, packet), false);
  assert.equal(assemblyReportMatchesPacket({ stages: {} }, { campaign: {} }), true);
  assert.equal(assemblyReportMatchesPacket(null, packet), false);
  assert.equal(assemblyReportMatchesPacket([], packet), false);
});

// The report's top-level status / next / blockers are derived from its stages
// on every write, so they can never lag the ladder.

const LADDER = ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"];

function ladderReport(statuses = {}, { status = "prepared", next = { stage: "setup", owner: "next-campaigns-os-setup", action: "Run setup before build." } } = {}) {
  const stages = Object.fromEntries(LADDER.map((stage) => [stage, {
    stage,
    status: statuses[stage] ?? "completed",
    inputs: [],
    outputs: [],
    commands: [],
    blockers: [],
    warnings: [],
  }]));
  return { identity: { map_id: "map_1", public_route_slug: "demo" }, status, blockers: [], evidence: [], stages, next };
}

test("a finished ladder no longer reads prepared/setup: status, next and blockers are re-derived on every commit", () => {
  // The on-disk report carries the summary prepare-build wrote first, and every stage since has completed.
  const stale = ladderReport({ qa: "pending" });
  const { dir, workspace } = workspaceFixture({ report: stale });
  const outcome = commitAssemblyReport(workspace, (report) => recordProducerStageOutcome(report, {
    stage: "qa",
    disposition: "ready_with_warnings",
    timestamp: "2026-09-16T00:00:00.000Z",
    command: "campaigns-os qa run",
  }), { stage: "qa", refreshDoctor: () => null });
  assert.equal(outcome.written, true);
  const written = readJson(workspace.reportPath);
  assert.equal(written.stages.qa.status, "completed_with_warnings");
  assert.equal(written.status, "completed", "every ladder stage is terminal, so the report is completed, not prepared");
  assert.equal(written.next.stage, "done");
  assert.equal(written.next.owner, "next-campaigns-os");
  assert.deepEqual(written.blockers, []);
  rmSync(dir, { recursive: true, force: true });
});

test("a blocked qa stage reads blocked at the top level and names qa next, carrying the stage's blockers", () => {
  const { dir, workspace } = workspaceFixture({ report: ladderReport({ qa: "pending" }) });
  commitAssemblyReport(workspace, (report) => recordProducerStageOutcome(report, {
    stage: "qa",
    disposition: "blocked",
    timestamp: "2026-09-16T00:00:00.000Z",
    command: "campaigns-os qa run",
    blockers: ["checkout assertion failed"],
  }), { stage: "qa", refreshDoctor: () => null });
  const written = readJson(workspace.reportPath);
  assert.equal(written.status, "blocked");
  assert.equal(written.next.stage, "qa");
  assert.equal(written.next.blocked, true);
  assert.deepEqual(written.blockers, ["checkout assertion failed"]);
  rmSync(dir, { recursive: true, force: true });
});

test("the summary follows the latest outcome: a doctor recorded blocked and later passed clears the top level", () => {
  const { dir, workspace } = workspaceFixture({ report: ladderReport({ doctor: "pending", setup: "pending", assembly: "pending", polish: "pending", deploy: "pending", qa: "pending" }) });
  const doctor = (disposition, blockers, timestamp) => (report) => recordProducerStageOutcome(report, {
    stage: "doctor",
    disposition,
    timestamp,
    command: "campaigns-os doctor",
    blockers,
  });
  commitAssemblyReport(workspace, doctor("blocked", ["store profile missing"], "2026-09-16T00:00:00.000Z"), { stage: "doctor", refreshDoctor: () => null });
  const blocked = readJson(workspace.reportPath);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.next.stage, "doctor-blocked");
  assert.deepEqual(blocked.blockers, ["store profile missing"]);

  commitAssemblyReport(workspace, doctor("ready", [], "2026-09-16T00:10:00.000Z"), { stage: "doctor", refreshDoctor: () => null });
  const passed = readJson(workspace.reportPath);
  assert.equal(passed.status, "prepared");
  assert.equal(passed.next.stage, "setup", "the first non-terminal ladder stage, in the order next walks");
  assert.equal(passed.next.owner, "next-campaigns-os-setup");
  assert.deepEqual(passed.blockers, [], "a blocker cleared by the re-run leaves the top level with the stage");
  rmSync(dir, { recursive: true, force: true });
});

test("an operator edit restates the summary too, and a summary that is already current does not move the file", () => {
  const { dir, workspace } = workspaceFixture({ report: ladderReport() });
  const restate = (timestamp) => (report) => recordProducerStageOutcome(report, {
    stage: "qa",
    disposition: "ready",
    timestamp,
    command: "campaigns-os qa run",
  });
  const first = commitAssemblyReport(workspace, (report) => restate("2026-09-16T00:00:00.000Z")({ ...report, note: "edited" }), { command: "unit waive", staleReason: "unit reason" });
  assert.equal(first.written, true);
  assert.equal(readJson(workspace.reportPath).status, "completed");
  const bytes = readFileSync(workspace.reportPath, "utf8");
  const rerun = commitAssemblyReport(workspace, restate("2026-09-16T01:00:00.000Z"), { stage: "qa", refreshDoctor: () => null });
  assert.deepEqual([rerun.written, rerun.skipped], [false, "unchanged"]);
  assert.equal(readFileSync(workspace.reportPath, "utf8"), bytes);
  rmSync(dir, { recursive: true, force: true });
});

test("deriveAssemblyReportSummary walks the ladder in next's order and collapses duplicate blockers", () => {
  const partway = deriveAssemblyReportSummary(ladderReport({ polish: "pending", deploy: "pending", qa: "pending" }));
  assert.deepEqual([partway.status, partway.next.stage, partway.next.owner], ["prepared", "polish", "next-campaigns-polish"]);
  assert.equal(partway.next.blocked, undefined);

  const skipped = deriveAssemblyReportSummary(ladderReport({ setup: "skipped", assembly: "pending", polish: "pending", deploy: "pending", qa: "pending" }));
  assert.equal(skipped.next.stage, "build", "the report's next uses the next <stage> vocabulary, so assembly is named build");

  const gate = ladderReport({ prepare_build: "blocked", setup: "pending", assembly: "pending", polish: "pending", deploy: "pending", qa: "pending" });
  const blocker = { code: "MISSING_SOURCE_PAGE", message: "no source for checkout" };
  gate.stages.prepare_build.blockers = [blocker, { ...blocker }];
  const blocked = deriveAssemblyReportSummary(gate);
  assert.deepEqual([blocked.status, blocked.next.stage, blocked.next.owner, blocked.next.blocked], ["blocked", "prepare-build", "next-campaigns-os", true]);
  assert.deepEqual(blocked.blockers, [blocker]);

  const completed = withDerivedAssemblyReportSummary(ladderReport());
  assert.deepEqual([completed.status, completed.next.stage], ["completed", "done"]);
  assert.throws(() => deriveAssemblyReportSummary(null), /Assembly Report object/);
});
