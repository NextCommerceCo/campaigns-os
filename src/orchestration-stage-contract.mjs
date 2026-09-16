export const ASSEMBLY_REPORT_STAGE_KEYS = Object.freeze([
  "prepare_build",
  "doctor",
  "setup",
  "assembly",
  "polish",
  "deploy",
  "qa",
]);

export const NEXT_STAGE_CONTRACTS = Object.freeze([
  Object.freeze({
    cliStage: "setup",
    reportKey: "setup",
  }),
  Object.freeze({
    cliStage: "build",
    reportKey: "assembly",
  }),
  Object.freeze({
    cliStage: "polish",
    reportKey: "polish",
  }),
  Object.freeze({
    cliStage: "deploy",
    reportKey: "deploy",
  }),
  Object.freeze({
    cliStage: "qa",
    reportKey: "qa",
  }),
]);

export const NEXT_STAGE_ORDER = Object.freeze(NEXT_STAGE_CONTRACTS.map((contract) => contract.cliStage));

const NEXT_STAGE_BY_CLI_STAGE = new Map(
  NEXT_STAGE_CONTRACTS.map((contract) => [contract.cliStage, contract])
);

export function nextStageContractForCliStage(cliStage) {
  return NEXT_STAGE_BY_CLI_STAGE.get(String(cliStage || "")) || null;
}

export function reportKeyForCliStage(cliStage) {
  return nextStageContractForCliStage(cliStage)?.reportKey || null;
}

/**
 * Status values that count as terminal under PREFIX matching — so
 * "completed", "completed_with_warnings", and "completed_partial" all
 * count as terminal under "completed". This matches how the existing
 * stages already report sub-statuses (see report.stages.assembly.status
 * shapes in src/cli.mjs and qa/shared/qa-verdict.js). Shared here so the
 * `next` picker, the session progress summary and the Assembly Report's own
 * derived summary (src/stage-ledger.mjs) read one definition of "done".
 */
export const STAGE_TERMINAL_STATUS_PREFIXES = Object.freeze(["completed", "skipped"]);

export function stageIsTerminal(status) {
  const normalized = String(status || "");
  return STAGE_TERMINAL_STATUS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function stageIsBlocked(status) {
  return String(status || "") === "blocked";
}

// Owner and skill for each stage the picker can name. The doctor's `next`
// block and the Assembly Report's `next` block are both projections of the
// same ladder the `next` command walks, so all three spell a stage, its owner
// and its skill the same way.
export const NEXT_STAGE_OWNERS = Object.freeze({
  "prepare-build": Object.freeze({ owner: "operator", default_skill: "next-campaigns-os" }),
  "doctor-blocked": Object.freeze({ owner: "operator", default_skill: "next-campaigns-os" }),
  setup: Object.freeze({ owner: "setup", default_skill: "next-campaigns-os-setup" }),
  build: Object.freeze({ owner: "build", default_skill: "next-campaigns-build" }),
  polish: Object.freeze({ owner: "polish", default_skill: "next-campaigns-polish" }),
  deploy: Object.freeze({ owner: "operator", default_skill: "next-campaigns-os" }),
  qa: Object.freeze({ owner: "qa", default_skill: "next-campaigns-qa" }),
  done: Object.freeze({ owner: "qa", default_skill: "next-campaigns-os" }),
});
