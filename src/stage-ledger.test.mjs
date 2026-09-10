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
