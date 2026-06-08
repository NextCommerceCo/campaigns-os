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
