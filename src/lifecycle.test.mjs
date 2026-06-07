import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  appendLifecycleEntry,
  LIFECYCLE_SCHEMA,
  lifecycleForRunRecord,
  readLifecycleJournal,
  resolveLifecycleJournalPath,
  selectLifecycleForRun,
  validateLifecycle,
  withCommandLifecycle,
} from "./lifecycle.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-lifecycle-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Deterministic clock: monotonic() walks a queue (last value sticks); now() is fixed.
function fakeClock(monotonicSeq = [100, 142]) {
  let i = 0;
  return {
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    monotonic: () => monotonicSeq[Math.min(i++, monotonicSeq.length - 1)],
  };
}

test("withCommandLifecycle captures command, argv_shape, exit_status, and timing", async () => {
  const { result, lifecycle } = await withCommandLifecycle(
    { command: "doctor", argvShape: ["--packet", "--json"], runId: "R1", clock: fakeClock([100, 142]), readExitStatus: () => 0 },
    async () => "ok",
  );
  assert.equal(result, "ok");
  assert.equal(lifecycle.schema_version, LIFECYCLE_SCHEMA);
  assert.equal(lifecycle.command, "doctor");
  assert.deepEqual(lifecycle.argv_shape, ["--packet", "--json"]);
  assert.equal(lifecycle.run_id, "R1");
  assert.equal(lifecycle.exit_status, 0);
  assert.equal(lifecycle.duration_ms, 42);
  assert.equal(lifecycle.started_at, "2026-06-07T00:00:00.000Z");
  assert.deepEqual(lifecycle.stages, []);
  assert.equal(lifecycle.repair_loop_count, 0);
});

test("withCommandLifecycle reads a non-zero exit status from the command", async () => {
  const { lifecycle } = await withCommandLifecycle(
    { command: "doctor", argvShape: [], clock: fakeClock(), readExitStatus: () => 2 },
    async () => {},
  );
  assert.equal(lifecycle.exit_status, 2);
});

test("withCommandLifecycle records exit_status from a thrown error and re-throws", async () => {
  let finished = null;
  const boom = Object.assign(new Error("kaboom"), { exitCode: 7 });
  await assert.rejects(
    () => withCommandLifecycle(
      { command: "qa", argvShape: ["--packet"], clock: fakeClock(), onFinish: (lc) => { finished = lc; } },
      async () => { throw boom; },
    ),
    /kaboom/,
  );
  // onFinish still ran on the error path, with the captured exit status
  assert.equal(finished.exit_status, 7);
  assert.equal(finished.command, "qa");
});

test("withCommandLifecycle prefers process.exitCode over a thrown error's exitCode (symmetric paths)", async () => {
  // A command set process.exitCode = 5 then threw: record 5, not the error's code or 1.
  let finished = null;
  await assert.rejects(
    () => withCommandLifecycle(
      { command: "doctor", argvShape: [], clock: fakeClock(), readExitStatus: () => 5, onFinish: (lc) => { finished = lc; } },
      async () => { throw Object.assign(new Error("x"), { exitCode: 9 }); },
    ),
  );
  assert.equal(finished.exit_status, 5);
});

test("withCommandLifecycle defaults a thrown error without exitCode to status 1", async () => {
  let finished = null;
  await assert.rejects(
    () => withCommandLifecycle(
      { command: "start", argvShape: [], clock: fakeClock(), onFinish: (lc) => { finished = lc; } },
      async () => { throw new Error("plain"); },
    ),
  );
  assert.equal(finished.exit_status, 1);
});

test("withCommandLifecycle: a throwing onFinish never masks the command result", async () => {
  const { result } = await withCommandLifecycle(
    { command: "doctor", argvShape: [], clock: fakeClock(), readExitStatus: () => 0, onFinish: () => { throw new Error("persist failed"); } },
    async () => "still-ok",
  );
  assert.equal(result, "still-ok");
});

test("recorder hooks populate stages[] and repair_loop_count (the deferred-field hooks)", async () => {
  const { lifecycle } = await withCommandLifecycle(
    { command: "next", argvShape: [], clock: fakeClock([0, 5, 12, 40]), readExitStatus: () => 0 },
    async (recorder) => {
      const stop = recorder.stage("build"); // stage start reads monotonic
      stop(); // stage end reads monotonic
      recorder.recordRepairLoop();
      recorder.recordRepairLoop();
    },
  );
  assert.equal(lifecycle.stages.length, 1);
  assert.equal(lifecycle.stages[0].name, "build");
  assert.equal(typeof lifecycle.stages[0].duration_ms, "number");
  assert.equal(lifecycle.repair_loop_count, 2);
});

test("validateLifecycle accepts a valid entry and rejects bad shapes", () => {
  const good = { schema_version: LIFECYCLE_SCHEMA, command: "doctor", argv_shape: ["--packet"], exit_status: 0, duration_ms: 5, stages: [], repair_loop_count: 0 };
  assert.equal(validateLifecycle(good).ok, true);
  assert.equal(validateLifecycle({ command: "", argv_shape: [] }).ok, false); // empty command
  assert.equal(validateLifecycle({ command: "x", argv_shape: "nope" }).ok, false); // argv_shape not array
  assert.equal(validateLifecycle({ command: "x", argv_shape: [], exit_status: "2" }).ok, false); // non-integer status
  assert.equal(validateLifecycle({ command: "x", argv_shape: [], stages: [{ duration_ms: 1 }] }).ok, false); // stage missing name
});

test("appendLifecycleEntry + readLifecycleJournal round-trip; malformed lines preserved", () => {
  withTempDir((dir) => {
    const journal = join(dir, "lc.jsonl");
    appendLifecycleEntry(journal, { command: "doctor", argv_shape: ["--packet"], exit_status: 0, run_id: "R" });
    appendLifecycleEntry(journal, { command: "qa", argv_shape: [], exit_status: 4, run_id: "R" });
    writeFileSync(journal, `${readFileSync(journal, "utf8")}{bad json}\n`);
    const { entries, malformed } = readLifecycleJournal(journal);
    assert.equal(entries.length, 2);
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].line, 3);
  });
});

test("appendLifecycleEntry refuses an invalid entry", () => {
  withTempDir((dir) => {
    assert.throws(() => appendLifecycleEntry(join(dir, "lc.jsonl"), { command: "", argv_shape: [] }), /failed validation/);
  });
});

test("selectLifecycleForRun returns the LAST matching run_id entry, stripped of schema_version", () => {
  const journal = { entries: [
    { schema_version: LIFECYCLE_SCHEMA, command: "doctor", argv_shape: [], run_id: "R", exit_status: 2 },
    { schema_version: LIFECYCLE_SCHEMA, command: "qa", argv_shape: [], run_id: "OTHER", exit_status: 0 },
    { schema_version: LIFECYCLE_SCHEMA, command: "qa", argv_shape: [], run_id: "R", exit_status: 0 }, // latest for R
  ] };
  const lc = selectLifecycleForRun(journal, "R");
  assert.equal(lc.command, "qa");
  assert.equal(lc.exit_status, 0);
  assert.equal("schema_version" in lc, false); // journal schema doesn't leak into the run-record block
  assert.equal(selectLifecycleForRun(journal, "MISSING"), null);
  assert.equal(selectLifecycleForRun({ entries: [] }, "R"), null);
});

test("resolveLifecycleJournalPath: explicit flag > env > baseDir default", () => {
  // flag wins over everything
  assert.equal(
    resolveLifecycleJournalPath({ "lifecycle-journal": "/tmp/x.jsonl" }, "/tmp/run-root", { CAMPAIGNS_OS_LIFECYCLE_LOG: "/tmp/env.jsonl" }),
    resolve("/tmp/x.jsonl"),
  );
  // env beats the baseDir default (so a writer's env path == run-record's read path)
  assert.equal(
    resolveLifecycleJournalPath({}, "/tmp/run-root", { CAMPAIGNS_OS_LIFECYCLE_LOG: "/tmp/env.jsonl" }),
    resolve("/tmp/env.jsonl"),
  );
  // nothing set => baseDir default
  assert.equal(
    resolveLifecycleJournalPath({}, "/tmp/run-root", {}),
    resolve("/tmp/run-root/.campaign-runtime/command-lifecycle.jsonl"),
  );
});

test("selectLifecycleForRun: excludeCommands skips the assembling command's own entries", () => {
  const journal = { entries: [
    { command: "doctor", argv_shape: [], run_id: "R", exit_status: 2 },
    { command: "run-record", argv_shape: [], run_id: "R", exit_status: 0 }, // self-entry, later
  ] };
  // Without exclusion, last-wins picks run-record (the shadow bug).
  assert.equal(selectLifecycleForRun(journal, "R").command, "run-record");
  // With exclusion, the real build command survives.
  assert.equal(selectLifecycleForRun(journal, "R", { excludeCommands: ["run-record"] }).command, "doctor");
});

test("lifecycleForRunRecord allowlists schema fields (drops schema_version and unknown keys)", () => {
  const embedded = lifecycleForRunRecord({
    schema_version: LIFECYCLE_SCHEMA,
    command: "doctor",
    argv_shape: ["--packet"],
    exit_status: 2,
    run_id: "R",
    evil_extra_key: "should not survive",
    stages: [],
    repair_loop_count: 0,
  });
  assert.equal("schema_version" in embedded, false);
  assert.equal("evil_extra_key" in embedded, false); // additionalProperties:false stays satisfiable
  assert.equal(embedded.command, "doctor");
  assert.equal(embedded.run_id, "R");
});

test("lifecycleForRunRecord DROPS a stage missing its required name (never emits an invalid {} stage)", () => {
  const embedded = lifecycleForRunRecord({
    command: "start",
    argv_shape: [],
    stages: [
      { name: "resolve-spec", duration_ms: 5 },
      { duration_ms: 9 }, // no name — must be dropped, not kept as {}
      { name: "assembly", duration_ms: 12, junk: "x" }, // unknown key stripped
    ],
  });
  assert.deepEqual(embedded.stages, [
    { name: "resolve-spec", duration_ms: 5 },
    { name: "assembly", duration_ms: 12 },
  ]);
  // every emitted stage satisfies the schema's required:["name"]
  assert.ok(embedded.stages.every((s) => typeof s.name === "string"));
});
