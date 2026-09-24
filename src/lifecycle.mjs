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

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const LIFECYCLE_SCHEMA = "campaigns-os-command-lifecycle/v0";
export const LIFECYCLE_JOURNAL_REL_PATH = ".campaign-runtime/command-lifecycle.jsonl";

// A refusal raised BEFORE the command's handler ran: an unknown top-level
// command, an unknown subcommand, or a flag the command refuses up front.
// Every such throw site builds its error here so the lifecycle journal can
// recognize a refusal from ONE place (the CLI's persist step) instead of
// matching messages — a typo must not materialize a file under the target.
// Only the tag is added: the message is passed through and the exit code is
// untouched, because bin/campaigns-os.mjs special-cases filesystem errno codes
// only and falls through to the same `campaigns-os: <message>` / exit 1 path.
// One mechanism, read two ways. The tag travels on the thrown error for the
// usual path (onFinish is handed the error), and `refusalSeen()` records the
// same verdict for the paths that CATCH a refusal to render it — the CLI's
// `waiveOrRefuse` prints the `{ ok: false, error }` body under --json and
// returns, so onFinish gets no `thrown` at all.
//
// That caught-refusal verdict is per INVOCATION, not per module. main() runs
// its body inside `runWithRefusalScope`, which puts a fresh `{ seen: false }`
// in an AsyncLocalStorage store; `refused()` marks the store that is active
// where the refusal is raised and `refusalSeen()` reads the store active where
// persistence runs. A module-global flag was wrong: two in-process main() calls
// interleave (the second one's reset cleared the first one's verdict before its
// onFinish ran, and the refused invocation journaled an entry). AsyncLocalStorage
// follows the await chain, so each invocation sees only its own verdict without
// threading a holder through every throw site. Outside any scope — a command
// module calling `refused()` directly in a unit test — there is no store and
// `refusalSeen()` is false; the error tag is added either way.
//
// LIMITATION, stated so it is not mistaken for a bug: AsyncLocalStorage
// propagates the store into callbacks scheduled inside the scope (a
// setImmediate/setTimeout/unawaited callback still sees it), so a deferred
// `refused()` does mark the store — but it may do so AFTER the invocation's
// persistence step has already run and read `refusalSeen()` as false, so the
// journal entry would already be written while the error carries the tag.
// This is not defended against, because refusals are synchronous BY CONTRACT:
// they are raised up front, before the handler runs, on the same tick as the
// argv check that rejects the invocation. A refusal that needs to be deferred
// is not an up-front refusal and should be a handler failure instead — which is
// journaled, as it should be.
//
// This lives here, not in the CLI, because refusals are raised in command
// modules too (`qa`'s unknown subcommand) and those modules are imported BY
// cli.mjs: importing the factory back out of cli.mjs would be circular, and
// re-listing the subcommands anywhere else would be a second command list.
// lifecycle.mjs imports nothing from this repository, so it is safe to import
// from anywhere.
export const REFUSED_INVOCATION = "refused_invocation";
const refusalScope = new AsyncLocalStorage();

/** Run `fn` with its own refusal verdict. Returns whatever `fn` returns. */
export function runWithRefusalScope(fn) {
  return refusalScope.run({ seen: false }, fn);
}

/**
 * Build a tagged refusal. INVARIANT: a refusal must be thrown or rendered —
 * never built and swallowed. The scope is marked HERE, at construction, not at
 * the throw, because the paths that catch a refusal to render it (waiveOrRefuse)
 * hand onFinish no error to inspect. The cost of marking early is that a
 * `refused()` built inside a `try` that discards it would suppress the journal
 * entry for an invocation whose handler did run. The optional QA progress
 * probe checks for a packet before its swallowing `try`; closeRunSession runs
 * its nested run-record attempt in a separate refusal scope. Keep those
 * boundaries: if you need to probe an argument, test for it rather than
 * constructing a refusal speculatively.
 */
export function refused(message) {
  const store = refusalScope.getStore();
  if (store) store.seen = true;
  const error = new Error(message);
  error.code = REFUSED_INVOCATION;
  return error;
}

export function refusalSeen() {
  return refusalScope.getStore()?.seen === true;
}

/**
 * Run `fn()` and re-throw anything it throws as a tagged refusal, message
 * byte-identical. The contract it encodes: THE TAG IS APPLIED AT THE UP-FRONT
 * CALL SITE, NOT INSIDE THE VALIDATOR. The validators this wraps are shared —
 * `assertSecureProxyBase` also runs mid-handler on the remit rail, and the
 * order-creation limit is re-checked after a browser has launched — and a throw
 * from those positions is a handler failure, the most valuable lifecycle entry
 * there is. Only the caller knows it is checking argv before anything has been
 * resolved, read, written, or launched, so only the caller may say "refusal".
 * Wrap the up-front call; leave the shared validator untagged.
 */
export function refusing(fn) {
  try {
    return fn();
  } catch (error) {
    throw refused(error.message);
  }
}

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
      await onFinish(lifecycle, thrown);
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
 * loop: doctor -> fix -> doctor). Run-level duration is summed active command
 * time, while started_at/completed_at preserve the outer observed bounds.
 * Returns null when no entry matches, so embedding stays best-effort and
 * backward-compatible.
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

  // Duration is active work, not the idle wall-clock gap between separate
  // invocations. Report the full run span separately so operator/review/idle
  // time remains visible without inflating command execution time.
  const durationMs = durationSum;
  const wallClockDurationMs = earliest && latest
    ? Math.max(0, Date.parse(latest) - Date.parse(earliest))
    : null;

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
    wall_clock_duration_ms: wallClockDurationMs == null ? null : Math.round(wallClockDurationMs),
    stages,
    repair_loop_count: repairLoopCount,
  };
}
