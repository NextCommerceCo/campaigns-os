import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import { RELEASE_GATES, TEMPLATE_CHECKS, contractChecks, fastChecks } from "./check-fast.mjs";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const names = (checks) => checks.map((check) => check.label.split(" ")[0]);

test("check:contracts expands into the npm scripts it chains", () => {
  const checks = contractChecks(scripts);
  assert.ok(checks.length > 10);
  for (const script of checks) assert.equal(typeof scripts[script], "string", script);
  assert.ok(TEMPLATE_CHECKS.every((script) => checks.includes(script)));
  assert.throws(() => contractChecks({ "check:contracts": "npm run check:a && node x.mjs" }), /not `npm run <script>`: node x.mjs/);
  assert.throws(() => contractChecks({}), /no check:contracts script/);
});

test("the fast gates cover everything CI's types and contracts lanes run", () => {
  // A check added to either lane, or to check:contracts, must not be one the
  // local gate silently skips.
  const fast = names(fastChecks({ scripts, base: "origin/main", templatesAvailable: true }));
  const laneSteps = ci.jobs.validate.steps.filter((step) => !step.if || /'(types|contracts)'/.test(step.if));
  const ciScripts = laneSteps.flatMap((step) => [...String(step.run ?? "").matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]));
  const ciGates = laneSteps.flatMap((step) => [...String(step.run ?? "").matchAll(/node \.\/scripts\/([\w-]+)\.mjs/g)].map((m) => m[1]));
  assert.ok(ciScripts.includes("check:contracts") && ciGates.length === RELEASE_GATES.length);
  for (const script of [...ciScripts.filter((s) => s !== "check:contracts"), ...contractChecks(scripts), ...ciGates]) {
    assert.ok(fast.includes(script), `check:fast does not run ${script}`);
  }
});

test("the template checks are skipped only when no starter-templates checkout exists", () => {
  const withTemplates = names(fastChecks({ scripts, base: "origin/main", templatesAvailable: true }));
  const without = names(fastChecks({ scripts, base: "origin/main", templatesAvailable: false }));
  for (const script of TEMPLATE_CHECKS) {
    assert.ok(withTemplates.includes(script));
    assert.ok(!without.includes(script));
  }
  assert.equal(withTemplates.length - without.length, TEMPLATE_CHECKS.length);
});

test("the release gates compare against the given base", () => {
  const gates = fastChecks({ scripts, base: "abc123", templatesAvailable: true }).filter((check) => check.command === process.execPath);
  assert.deepEqual(gates.map((gate) => gate.args), RELEASE_GATES.map((gate) => [`./scripts/${gate}.mjs`, "--base", "abc123"]));
});
