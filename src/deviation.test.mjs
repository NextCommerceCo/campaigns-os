import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendDeviation,
  buildRecommendation,
  detectDeviation,
  DEVIATION_SCHEMA,
  expectedCommandsForStage,
  readDeviations,
} from "./deviation.mjs";

test("expectedCommandsForStage merges stage defaults with gate action commands", () => {
  assert.deepEqual(expectedCommandsForStage("qa"), ["qa", "theme"]);
  assert.deepEqual(expectedCommandsForStage("deploy"), []);
  const withActions = expectedCommandsForStage("polish", [
    { command: "campaigns-os theme generate --packet p.json" },
    { command: "npm run qa:install-browser" },
    { command: null },
  ]);
  assert.deepEqual(withActions, ["theme"]);
});

test("detectDeviation flags a tracked command outside the recommendation", () => {
  const rec = buildRecommendation({ stage: "polish", status: "ready", expectedCommands: ["theme"], now: new Date("2026-06-11T00:00:00Z") });
  const entry = detectDeviation({
    lastRecommendation: rec,
    command: "qa",
    argvShape: ["qa", "run"],
    runId: "run_x",
    now: new Date("2026-06-11T00:05:00Z"),
  });
  assert.equal(entry.schema_version, DEVIATION_SCHEMA);
  assert.equal(entry.recommended_stage, "polish");
  assert.equal(entry.actual_command, "qa");
  assert.equal(entry.deviation_reason, null);
});

test("detectDeviation stays quiet for expected, untracked, or unrecommended states", () => {
  const rec = buildRecommendation({ stage: "qa", status: "ready", expectedCommands: ["qa", "theme"] });
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa" }), null, "expected command");
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "doctor" }), null, "untracked command");
  assert.equal(detectDeviation({ lastRecommendation: null, command: "qa" }), null, "no recommendation yet");
});

test("deviation journal round-trips and tolerates junk lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-deviation-"));
  try {
    const journal = join(dir, ".campaign-runtime/agent-deviations.jsonl");
    const rec = buildRecommendation({ stage: "polish", status: "ready", expectedCommands: ["theme"] });
    const entry = detectDeviation({ lastRecommendation: rec, command: "qa", deviationReason: "operator asked for early QA" });
    appendDeviation(journal, entry);
    appendDeviation(journal, { ...entry, deviation_reason: null });
    const entries = readDeviations(journal);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].deviation_reason, "operator asked for early QA");
    assert.deepEqual(readDeviations(join(dir, "missing.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
