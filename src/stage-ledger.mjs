const PRODUCER_STAGES = new Set(["doctor", "qa"]);

function nonEmptyStrings(values) {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.trim()) : [];
}

function terminalStatus(disposition) {
  if (disposition === "blocked") return "blocked";
  if (disposition === "ready_with_warnings" || disposition === "ready_with_exceptions") return "completed_with_warnings";
  if (disposition === "ready") return "completed";
  throw new Error(`Unsupported producer disposition "${disposition}".`);
}

/**
 * Return an Assembly Report copy with the current doctor/QA producer outcome.
 * The producer supplies its own timestamp and artifact paths; this helper never
 * invents historical completion evidence.
 */
export function recordProducerStageOutcome(report, {
  stage,
  disposition,
  timestamp,
  command,
  outputs = [],
  blockers = [],
  warnings = [],
} = {}) {
  if (!PRODUCER_STAGES.has(stage)) throw new Error("Producer stage must be doctor or qa.");
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("Producer stage timestamp must be a parseable ISO timestamp.");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Assembly Report must be an object.");

  const updated = JSON.parse(JSON.stringify(report));
  const stages = updated.stages && typeof updated.stages === "object" && !Array.isArray(updated.stages)
    ? updated.stages
    : {};
  const previous = stages[stage] && typeof stages[stage] === "object" && !Array.isArray(stages[stage])
    ? stages[stage]
    : {};
  const status = terminalStatus(disposition);
  const next = {
    ...previous,
    stage,
    status,
    inputs: nonEmptyStrings(previous.inputs),
    outputs: nonEmptyStrings(outputs),
    commands: nonEmptyStrings(command ? [command] : []),
    blockers: nonEmptyStrings(blockers),
    warnings: nonEmptyStrings(warnings),
    checked_at: timestamp,
  };
  if (status.startsWith("completed")) next.completed_at = timestamp;
  else delete next.completed_at;
  stages[stage] = next;
  updated.stages = stages;
  return updated;
}
