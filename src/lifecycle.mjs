// Run Telemetry — command-lifecycle instrumentation for Campaigns OS.
// See docs/workflow-findings-sidecar.md (Deferred / scope cut).
//
// A thin wrapper that times one command and captures its lifecycle: the
// command name, the argv SHAPE (flag names, never values), the exit status,
// and wall-clock start/end + monotonic duration. This is the instrumentation
// the v0 scope cut said the deferred fields needed first: stage timings and
// repair-loop count have recorder hooks here (stages[]/repair_loop_count) so
// they can be populated as command boundaries are instrumented — v0 captures
// command/argv-shape/exit-status/duration and leaves those hooks empty.
//
// The wrapper never changes a command's behavior: it re-throws after recording
// so the CLI exit code is unchanged, and lifecycle persistence is opt-in and
// non-fatal. No network, no credentials.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LIFECYCLE_SCHEMA = "campaigns-os-command-lifecycle/v0";
export const LIFECYCLE_JOURNAL_REL_PATH = ".campaign-runtime/command-lifecycle.jsonl";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Injectable so tests are deterministic. `now` is wall-clock (ISO source);
// `monotonic` is a steadily-increasing millisecond counter for durations.
const defaultClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
};

function defaultReadExitStatus() {
  return Number.isInteger(process.exitCode) ? process.exitCode : 0;
}

/**
 * A small recorder passed into the wrapped command. `stage(name)` returns a
 * stop() that records that stage's duration; `recordRepairLoop()` bumps the
 * repair-loop counter. v0 commands don't mark stages yet — the hooks exist so
 * the deferred fields can be filled without reshaping the Run Record.
 */
export function createLifecycleRecorder(clock = defaultClock) {
  const stages = [];
  let repairLoopCount = 0;
  return {
    stage(name) {
      const t0 = clock.monotonic();
      let stopped = false;
      return function stop() {
        if (stopped) return;
        stopped = true;
        stages.push({ name: String(name), duration_ms: Math.max(0, Math.round(clock.monotonic() - t0)) });
      };
    },
    recordRepairLoop() {
      repairLoopCount += 1;
    },
    snapshot() {
      return { stages: stages.slice(), repair_loop_count: repairLoopCount };
    },
  };
}

function buildLifecycle({ command, argvShape, runId, exitStatus, startedAt, completedAt, durationMs, recorder }) {
  const recorded = recorder ? recorder.snapshot() : { stages: [], repair_loop_count: 0 };
  return {
    schema_version: LIFECYCLE_SCHEMA,
    run_id: isNonEmptyString(runId) ? runId : null,
    command: String(command || ""),
    argv_shape: isStringArray(argvShape) ? argvShape : [],
    exit_status: Number.isInteger(exitStatus) ? exitStatus : null,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    stages: recorded.stages,
    repair_loop_count: recorded.repair_loop_count,
  };
}

/**
 * Run `fn(recorder)` while capturing its command lifecycle. Returns
 * `{ result, lifecycle }`. `onFinish(lifecycle, error)` runs on BOTH the
 * success and error paths (before re-throw) so persistence happens even when
 * the command fails. Re-throws any error so the CLI's exit behavior is
 * unchanged — the lifecycle just records the resulting exit status.
 */
export async function withCommandLifecycle({
  command,
  argvShape = [],
  runId = null,
  clock = defaultClock,
  readExitStatus = defaultReadExitStatus,
  onFinish = null,
} = {}, fn) {
  const startedAtDate = clock.now();
  const t0 = clock.monotonic();
  const recorder = createLifecycleRecorder(clock);

  let result;
  let thrown = null;
  let exitStatus = 0;
  try {
    result = await fn(recorder);
    exitStatus = readExitStatus();
  } catch (error) {
    thrown = error;
    exitStatus = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }

  const lifecycle = buildLifecycle({
    command,
    argvShape,
    runId,
    exitStatus,
    startedAt: startedAtDate.toISOString(),
    completedAt: clock.now().toISOString(),
    durationMs: clock.monotonic() - t0,
    recorder,
  });

  if (typeof onFinish === "function") {
    try {
      onFinish(lifecycle, thrown);
    } catch {
      // Persistence is non-fatal — never let a lifecycle write mask the command.
    }
  }

  if (thrown) throw thrown;
  return { result, lifecycle };
}

/**
 * Light validator (no AJV), matching the repo convention. Checks the lifecycle
 * envelope shape. Returns `{ ok, errors }`.
 */
export function validateLifecycle(entry) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    add("lifecycle.type", "Lifecycle must be a JSON object.");
    return { ok: false, errors };
  }
  if (!isNonEmptyString(entry.command)) add("lifecycle.command", "command is required and must be a non-empty string.");
  if (!isStringArray(entry.argv_shape)) add("lifecycle.argv_shape", "argv_shape must be an array of strings.");
  if (entry.exit_status != null && !Number.isInteger(entry.exit_status)) add("lifecycle.exit_status", "exit_status must be an integer or null.");
  if (entry.run_id != null && typeof entry.run_id !== "string") add("lifecycle.run_id", "run_id must be a string or null.");
  if (entry.duration_ms != null && typeof entry.duration_ms !== "number") add("lifecycle.duration_ms", "duration_ms must be a number or null.");
  if (entry.repair_loop_count != null && !Number.isInteger(entry.repair_loop_count)) add("lifecycle.repair_loop_count", "repair_loop_count must be an integer.");
  if (entry.stages != null) {
    if (!Array.isArray(entry.stages)) {
      add("lifecycle.stages", "stages must be an array.");
    } else {
      entry.stages.forEach((stage, index) => {
        if (!stage || typeof stage !== "object" || Array.isArray(stage)) add(`lifecycle.stages[${index}]`, "each stage must be an object.");
        else if (!isNonEmptyString(stage.name)) add(`lifecycle.stages[${index}].name`, "stage name is required.");
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

// The exact fields the Run Record's `lifecycle` block allows (matches the
// schema's lifecycle properties). Allowlisting on embed guarantees no extra
// journal key leaks in and violates the schema's additionalProperties:false.
const RUN_RECORD_LIFECYCLE_KEYS = [
  "run_id",
  "command",
  "argv_shape",
  "exit_status",
  "started_at",
  "completed_at",
  "duration_ms",
  "stages",
  "repair_loop_count",
];

/**
 * Project a journal entry down to exactly the fields the Run Record's
 * `lifecycle` block allows — drops the journal `schema_version` and any other
 * key not in the schema, so an embedded block can never violate the published
 * schema's additionalProperties:false.
 */
export function lifecycleForRunRecord(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  for (const key of RUN_RECORD_LIFECYCLE_KEYS) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  // Normalize stage items to exactly {name, duration_ms} so an unknown key in a
  // hand-edited journal can't violate the schema's nested additionalProperties:false.
  if (Array.isArray(out.stages)) {
    out.stages = out.stages.map((stage) => {
      const normalized = {};
      if (stage && typeof stage === "object" && !Array.isArray(stage)) {
        if (typeof stage.name === "string") normalized.name = stage.name;
        if (typeof stage.duration_ms === "number") normalized.duration_ms = stage.duration_ms;
      }
      return normalized;
    });
  }
  return out;
}

export function resolveLifecycleJournalPath(args = {}, cwd = process.cwd(), env = process.env) {
  if (isNonEmptyString(args["lifecycle-journal"])) return resolve(args["lifecycle-journal"]);
  // Honor the env opt-in so the journal a command WRITES (via the same resolver)
  // is the journal run-record READS, even without an explicit flag.
  if (isNonEmptyString(env?.CAMPAIGNS_OS_LIFECYCLE_LOG)) return resolve(env.CAMPAIGNS_OS_LIFECYCLE_LOG);
  return join(resolve(cwd), LIFECYCLE_JOURNAL_REL_PATH);
}

/**
 * Append one validated lifecycle entry as one JSONL line (append-only, single
 * writer — mirrors the findings journal). Throws on an invalid entry so a bug
 * is caught, but callers that want non-fatal behavior (the CLI) wrap this.
 */
export function appendLifecycleEntry(journalPath, entry) {
  const validation = validateLifecycle(entry);
  if (!validation.ok) {
    const detail = validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    throw new Error(`Command lifecycle failed validation: ${detail}`);
  }
  mkdirSync(dirname(resolve(journalPath)), { recursive: true });
  appendFileSync(resolve(journalPath), `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * Read the lifecycle journal. Returns `{ entries, malformed }`; malformed
 * lines are preserved rather than thrown, so one bad line never blocks the rest.
 */
export function readLifecycleJournal(journalPath) {
  const resolved = resolve(journalPath);
  if (!existsSync(resolved)) return { entries: [], malformed: [] };
  const entries = [];
  const malformed = [];
  const lines = readFileSync(resolved, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    try {
      entries.push(JSON.parse(raw));
    } catch (error) {
      malformed.push({ line: index + 1, raw, error: error.message });
    }
  }
  return { entries, malformed };
}

/**
 * Select the lifecycle to embed in a Run Record for `runId`: the LAST journal
 * entry stamped with that run_id (most recent wins), skipping any command in
 * `excludeCommands`. Returns null when none match — embedding is best-effort
 * and backward-compatible. `excludeCommands` lets run-record skip its OWN
 * entries so it never shadows the build command's lifecycle on a re-run.
 */
export function selectLifecycleForRun(journal, runId, { excludeCommands = [] } = {}) {
  const entries = Array.isArray(journal?.entries) ? journal.entries : Array.isArray(journal) ? journal : [];
  let match = null;
  for (const entry of entries) {
    if (entry && entry.run_id === runId && !excludeCommands.includes(entry.command)) match = entry;
  }
  return match ? lifecycleForRunRecord(match) : null;
}
