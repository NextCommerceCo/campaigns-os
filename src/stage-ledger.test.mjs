import assert from "node:assert/strict";
import { test } from "node:test";

import { recordProducerStageOutcome } from "./stage-ledger.mjs";

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
