// Agent deviation telemetry: makes "the agent ignored Campaigns OS and
// wandered" measurable instead of anecdotal.
//
// `campaigns-os next` records its recommendation (stage + the commands it
// expects next) on the active run session. When a later pipeline-advancing
// command does not match that recommendation, a deviation entry is appended to
// a sidecar journal. Deviations are TELEMETRY, not blocks — hard gates live in
// `next`/doctor/qa. An agent can declare intent with --deviation-reason so an
// intentional detour is distinguishable from drift.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEVIATION_SCHEMA = "campaigns-os-agent-deviation/v0";
export const DEVIATION_JOURNAL_REL_PATH = ".campaign-runtime/agent-deviations.jsonl";

// Commands that advance the pipeline. Read-only / bookkeeping commands
// (doctor, next, findings, telemetry, run, validate-*) never deviate.
export const TRACKED_STAGE_COMMANDS = Object.freeze(new Set(["start", "prepare-build", "theme", "qa", "run-record"]));

// Commands every recommendation implicitly allows for its stage. Stage work is
// agent/skill work, so the expected command set is small and explicit.
const EXPECTED_COMMANDS_BY_STAGE = Object.freeze({
  "prepare-build": ["prepare-build", "start"],
  setup: ["theme"],
  build: ["theme"],
  polish: ["theme"],
  deploy: [],
  qa: ["qa", "theme"],
  done: ["run-record"],
});

export function expectedCommandsForStage(stage, requiredActions = []) {
  const base = EXPECTED_COMMANDS_BY_STAGE[stage] || [];
  // Gate required_actions name exact commands ("campaigns-os theme generate
  // ..."); their command words are expected too.
  const fromActions = requiredActions
    .map((action) => (typeof action?.command === "string" ? action.command.match(/^campaigns-os\s+([a-z-]+)/)?.[1] : null))
    .filter(Boolean);
  return [...new Set([...base, ...fromActions])];
}

export function buildRecommendation({ stage, status, expectedCommands, now = new Date() }) {
  return {
    stage,
    status,
    expected_commands: expectedCommands,
    issued_at: now.toISOString(),
  };
}

/**
 * Compare a pipeline-advancing command against the session's last
 * recommendation. Returns a deviation entry or null.
 */
export function detectDeviation({ lastRecommendation, command, argvShape = [], runId = null, deviationReason = null, now = new Date() }) {
  if (!TRACKED_STAGE_COMMANDS.has(command)) return null;
  if (!lastRecommendation || !Array.isArray(lastRecommendation.expected_commands)) return null;
  if (lastRecommendation.expected_commands.includes(command)) return null;
  return {
    schema_version: DEVIATION_SCHEMA,
    observed_at: now.toISOString(),
    run_id: runId,
    recommended_stage: lastRecommendation.stage || null,
    recommended_status: lastRecommendation.status || null,
    recommended_commands: lastRecommendation.expected_commands,
    recommendation_issued_at: lastRecommendation.issued_at || null,
    actual_command: command,
    actual_argv_shape: argvShape,
    deviation_reason: typeof deviationReason === "string" && deviationReason.trim() ? deviationReason.trim() : null,
  };
}

export function appendDeviation(journalPath, entry) {
  const path = resolve(journalPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Best-effort read; malformed lines are skipped, a missing journal is empty. */
export function readDeviations(journalPath) {
  const path = resolve(journalPath);
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && entry.schema_version === DEVIATION_SCHEMA) entries.push(entry);
    } catch {
      // tolerate a torn line; telemetry must never block reads
    }
  }
  return entries;
}
