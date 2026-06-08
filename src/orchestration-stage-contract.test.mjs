import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSEMBLY_REPORT_STAGE_KEYS,
  NEXT_STAGE_CONTRACTS,
  NEXT_STAGE_ORDER,
  nextStageContractForCliStage,
  reportKeyForCliStage,
} from "./orchestration-stage-contract.mjs";

test("orchestration stage contract maps build CLI stage to assembly report key", () => {
  assert.equal(reportKeyForCliStage("setup"), "setup");
  assert.equal(reportKeyForCliStage("build"), "assembly");
  assert.equal(reportKeyForCliStage("polish"), "polish");
  assert.equal(reportKeyForCliStage("deploy"), "deploy");
  assert.equal(reportKeyForCliStage("qa"), "qa");
});

test("orchestration stage order is derived from named stage contracts", () => {
  assert.deepEqual(NEXT_STAGE_ORDER, ["setup", "build", "polish", "deploy", "qa"]);
  assert.deepEqual(NEXT_STAGE_ORDER, NEXT_STAGE_CONTRACTS.map((contract) => contract.cliStage));
});

test("orchestration next stages all point at declared assembly report stages", () => {
  for (const contract of NEXT_STAGE_CONTRACTS) {
    assert.equal(ASSEMBLY_REPORT_STAGE_KEYS.includes(contract.reportKey), true);
    assert.equal(nextStageContractForCliStage(contract.cliStage), contract);
  }
});

test("orchestration stage contracts are immutable and unique", () => {
  assert.equal(Object.isFrozen(ASSEMBLY_REPORT_STAGE_KEYS), true);
  assert.equal(Object.isFrozen(NEXT_STAGE_CONTRACTS), true);
  assert.equal(Object.isFrozen(NEXT_STAGE_ORDER), true);
  assert.equal(new Set(ASSEMBLY_REPORT_STAGE_KEYS).size, ASSEMBLY_REPORT_STAGE_KEYS.length);
  assert.equal(new Set(NEXT_STAGE_ORDER).size, NEXT_STAGE_ORDER.length);
  assert.equal(new Set(NEXT_STAGE_CONTRACTS.map((contract) => contract.reportKey)).size, NEXT_STAGE_CONTRACTS.length);
  assert.equal(nextStageContractForCliStage("prepare_build"), null);
});
