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

// Raw process.exitCode: an integer when a command set it (INCLUDING 0), or
// undefined when unset. The wrapper coerces per path so an explicit 0 is
// distinguishable from "unset" (the bug a plain `|| 0` / `|| 1` would hide).
function defaultReadExitStatus() {
  return process.exitCode;
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
  function stage(name) {
    const t0 = clock.monotonic();
    let stopped = false;
    return function stop() {
      if (stopped) return;
      stopped = true;
      stages.push({ name: String(name), duration_ms: Math.max(0, Math.round(clock.monotonic() - t0)) });
    };
  }
  // Convenience: time `fn` as a named sub-phase. Records the stage even if fn
  // throws (the phase still ran), then re-throws. Async-aware.
  async function time(name, fn) {
    const stop = stage(name);
    try {
      return await fn();
    } finally {
      stop();
    }
  }
  return {
    stage,
    time,
    recordRepairLoop() {
      repairLoopCount += 1;
    },
    snapshot() {
      return { stages: stages.slice(), repair_loop_count: repairLoopCount };
    },
  };
}

// A no-op recorder for callers that run a command without lifecycle capture.
// Same surface as createLifecycleRecorder(); records nothing.
export const NOOP_RECORDER = {
  stage: () => () => {},
  time: async (_name, fn) => fn(),
  recordRepairLoop: () => {},
  snapshot: () => ({ stages: [], repair_loop_count: 0 }),
};

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
    // A clean return is exit 0 unless the command set process.exitCode.
    const raw = readExitStatus();
    exitStatus = Number.isInteger(raw) ? raw : 0;
  } catch (error) {
    thrown = error;
    // Symmetric with the success path, but using an integer test (not `||`) so an
    // explicit process.exitCode = 0 set before throwing is preserved rather than
    // treated as falsy. An integer (incl. 0) wins; else the error's own exitCode;
    // else 1.
    const raw = readExitStatus();
    exitStatus = Number.isInteger(raw) ? raw : (Number.isInteger(error?.exitCode) ? error.exitCode : 1);
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
  // Normalize stage items to exactly {name, duration_ms}. FILTER (not map) so a
  // stage missing its required `name` is dropped entirely rather than kept as an
  // invalid `{}` — the schema requires `name`, and an unknown key can't survive.
  if (Array.isArray(out.stages)) {
    out.stages = out.stages
      .filter((stage) => stage && typeof stage === "object" && !Array.isArray(stage) && typeof stage.name === "string")
      .map((stage) => {
        const normalized = { name: stage.name };
        if (typeof stage.duration_ms === "number") normalized.duration_ms = stage.duration_ms;
        return normalized;
      });
  }
  return out;
}

// Flag > env > cwd-default journal path. NOTE: the CLI uses a session-aware
// resolver (resolveLifecycleJournal in cli.mjs) that also consults the active
// run session; this base resolver is retained for direct programmatic use.
export function resolveLifecycleJournalPath(args = {}, cwd = process.cwd(), env = process.env) {
  if (isNonEmptyString(args["lifecycle-journal"])) return resolve(args["lifecycle-journal"]);
  // Honor the env opt-in so the journal a command WRITES (via the same resolver)
  // is the journal run-record READS, even without an explicit flag.
  if (isNonEmptyString(env?.CAMPAIGNS_OS_LIFECYCLE_LOG)) return resolve(env.CAMPAIGNS_OS_LIFECYCLE_LOG);
  return join(resolve(cwd), LIFECYCLE_JOURNAL_REL_PATH);
}

/**
 * Append one validated lifecycle entry as one JSONL line. Throws on an invalid
 * entry so a bug is caught; callers that want non-fatal behavior (the CLI) wrap
 * this.
 *
 * Single-writer-per-run assumption: each entry is one append, but appendFileSync
 * is only atomic for writes under PIPE_BUF, so two processes appending to the
 * SAME journal concurrently can interleave. A journal is scoped to one run
 * (one run-id, cleared by `run end`), so the normal path is a single writer.
 * readLifecycleJournal tolerates the rare malformed line either way.
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
 * Reads the whole file: journals are per-run and short-lived (a run session
 * clears on `run end`), and run-record aggregation needs every entry for the
 * run_id, so there is no last-N shortcut. Callers treat read failures as
 * "no journal" (best-effort) — see the run-record embed path.
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
 * Select a single lifecycle entry for `runId`: the LAST matching journal entry
 * (most recent wins), skipping any command in `excludeCommands`. Returns null
 * when none match.
 *
 * NOTE: run-record now embeds the multi-entry AGGREGATE (aggregateLifecycleForRun)
 * rather than a single entry, so this single-entry selector is no longer on the
 * Run Record embed path; it (and lifecycleForRunRecord) are retained for direct
 * programmatic use and are covered by their own tests.
 */
export function selectLifecycleForRun(journal, runId, { excludeCommands = [] } = {}) {
  const entries = Array.isArray(journal?.entries) ? journal.entries : Array.isArray(journal) ? journal : [];
  let match = null;
  for (const entry of entries) {
    if (entry && entry.run_id === runId && !excludeCommands.includes(entry.command)) match = entry;
  }
  return match ? lifecycleForRunRecord(match) : null;
}

function entriesForRun(journal, runId, excludeCommands) {
  const entries = Array.isArray(journal?.entries) ? journal.entries : Array.isArray(journal) ? journal : [];
  return entries.filter((entry) => entry && entry.run_id === runId && !excludeCommands.includes(entry.command));
}

/**
 * Aggregate ALL lifecycle journal entries for `runId` into one run-level
 * lifecycle block — the populated form of the deferred stage-timings /
 * repair-loop fields. Each command invocation becomes a stage; when a command
 * marked its own sub-phases (Tier 2), those become `command:phase` stages
 * instead. `repair_loop_count` = re-runs of any command (a re-run is a repair
 * loop: doctor -> fix -> doctor). Run-level timing spans the earliest start to
 * the latest finish across commands. Returns null when no entry matches, so
 * embedding stays best-effort and backward-compatible.
 */
export function aggregateLifecycleForRun(journal, runId, { excludeCommands = [] } = {}) {
  const matching = entriesForRun(journal, runId, excludeCommands);
  if (!matching.length) return null;

  const stages = [];
  const commandCounts = new Map();
  let earliest = null;
  let latest = null;
  let durationSum = 0;
  let explicitRepairLoops = 0;

  // Only finite, parseable ISO timestamps participate in span timing; a junk
  // string (e.g. a hand-edited journal) is ignored rather than emitted as a
  // bogus started_at/completed_at.
  const isParseableTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

  for (const entry of matching) {
    const command = typeof entry.command === "string" ? entry.command : "(unknown)";
    commandCounts.set(command, (commandCounts.get(command) || 0) + 1);
    const exitStatus = Number.isInteger(entry.exit_status) ? entry.exit_status : null;
    // A command may have recorded its own repair loops via recordRepairLoop().
    if (Number.isInteger(entry.repair_loop_count)) explicitRepairLoops += entry.repair_loop_count;

    const subStages = Array.isArray(entry.stages) && entry.stages.length
      ? entry.stages.map((stage) => ({
          name: `${command}:${typeof stage?.name === "string" ? stage.name : "stage"}`,
          duration_ms: typeof stage?.duration_ms === "number" ? stage.duration_ms : null,
          exit_status: exitStatus,
        }))
      : [{
          name: command,
          duration_ms: typeof entry.duration_ms === "number" ? entry.duration_ms : null,
          exit_status: exitStatus,
        }];
    stages.push(...subStages);

    if (typeof entry.duration_ms === "number") durationSum += entry.duration_ms;
    if (isParseableTimestamp(entry.started_at) && (!earliest || entry.started_at < earliest)) earliest = entry.started_at;
    if (isParseableTimestamp(entry.completed_at) && (!latest || entry.completed_at > latest)) latest = entry.completed_at;
  }

  // repair_loop_count = command re-runs (doctor -> fix -> doctor) PLUS any loops
  // a command recorded explicitly. Re-runs are the v0 heuristic; explicit loops
  // refine it once commands call recordRepairLoop().
  let repairLoopCount = explicitRepairLoops;
  for (const count of commandCounts.values()) if (count > 1) repairLoopCount += count - 1;

  // Single command: trust its own monotonic duration. Multiple commands: prefer
  // the wall-clock span (it includes the gaps between separate invocations), but
  // never report less than the summed work.
  let durationMs = durationSum;
  if (matching.length > 1 && earliest && latest) {
    const span = Date.parse(latest) - Date.parse(earliest);
    if (Number.isFinite(span) && span >= durationSum) durationMs = span;
  }

  // Top-level command/argv_shape describe the RUN, not its earliest invocation.
  // They are meaningful only when the run is a single distinct command; for a
  // multi-command run (doctor -> start -> qa) they would mislead, so null them
  // and let stages[] carry the per-command detail. exit_status is the LAST
  // command's (the run's final outcome).
  const first = matching[0];
  const last = matching[matching.length - 1];
  const singleCommand = commandCounts.size === 1 && typeof first.command === "string";
  return {
    run_id: runId,
    command: singleCommand ? first.command : null,
    argv_shape: singleCommand && isStringArray(first.argv_shape) ? first.argv_shape : [],
    exit_status: Number.isInteger(last.exit_status) ? last.exit_status : null,
    started_at: earliest,
    completed_at: latest,
    duration_ms: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    stages,
    repair_loop_count: repairLoopCount,
  };
}
