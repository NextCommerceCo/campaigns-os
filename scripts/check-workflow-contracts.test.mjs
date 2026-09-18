import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflow, validateRefreshWorkflow, validateCiWorkflow } from "./check-workflow-contracts.mjs";

const clone = (value) => structuredClone(value);

test("the shipped catalog refresh workflow satisfies its reliability contract", () => {
  assert.deepEqual(validateRefreshWorkflow(loadWorkflow()), []);
});

test("missing dependency installation fails the workflow contract", () => {
  const workflow = clone(loadWorkflow());
  workflow.jobs.refresh.steps = workflow.jobs.refresh.steps.filter((step) => step.run?.trim() !== "npm ci");
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("npm ci")));
});

test("installing dependencies after validation fails the workflow contract", () => {
  const workflow = clone(loadWorkflow());
  const steps = workflow.jobs.refresh.steps;
  const installIndex = steps.findIndex((step) => step.run?.trim() === "npm ci");
  const [install] = steps.splice(installIndex, 1);
  steps.push(install);
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("before the catalog refresh")));
  assert.ok(errors.some((error) => error.includes("before npm run check")));
});

test("npm ci flags remain a valid locked dependency installation", () => {
  const workflow = clone(loadWorkflow());
  const install = workflow.jobs.refresh.steps.find((step) => step.run?.trim() === "npm ci");
  install.run = "npm ci --no-audit";
  assert.deepEqual(validateRefreshWorkflow(workflow), []);
});

test("dropping exact-SHA provenance or the human recovery path fails closed", () => {
  const workflow = clone(loadWorkflow());
  const steps = workflow.jobs.refresh.steps;
  const refresh = steps.find((step) => step.run?.includes("refresh-starter-template-catalog.mjs"));
  refresh.run = refresh.run.replace("--synced-from-sha", "--discarded-sha");
  const pr = steps.find((step) => step.run?.includes("gh pr create"));
  pr.run = pr.run.replace("gh issue create", "echo no-issue");
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("exact dispatch SHA")));
  assert.ok(errors.some((error) => error.includes("gh issue create")));
});

test("ignoring untracked fixture additions fails the workflow contract", () => {
  const workflow = clone(loadWorkflow());
  const pr = workflow.jobs.refresh.steps.find((step) => step.run?.includes("gh pr create"));
  pr.run = pr.run.replace("git status --porcelain --untracked-files=all", "git diff --quiet");
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("git status --porcelain --untracked-files=all")));
});

test("omitting the exact source checkout or its validation path fails the workflow contract", () => {
  const missingCheckout = clone(loadWorkflow());
  missingCheckout.jobs.refresh.steps = missingCheckout.jobs.refresh.steps.filter(
    (step) => !step.run?.includes("campaign-cart-starter-templates.git"),
  );
  assert.ok(
    validateRefreshWorkflow(missingCheckout).some((error) => error.includes("exact refreshed templates SHA")),
  );

  const missingPath = clone(loadWorkflow());
  const validate = missingPath.jobs.refresh.steps.find((step) => step.run?.trim() === "npm run check");
  delete validate.env.STARTER_TEMPLATES_PATH;
  assert.ok(
    validateRefreshWorkflow(missingPath).some((error) => error.includes("STARTER_TEMPLATES_PATH")),
  );

  const mismatchedPath = clone(loadWorkflow());
  const mismatchedValidate = mismatchedPath.jobs.refresh.steps.find((step) => step.run?.trim() === "npm run check");
  mismatchedValidate.env.STARTER_TEMPLATES_PATH = "${{ runner.temp }}/different-templates-checkout";
  assert.ok(
    validateRefreshWorkflow(mismatchedPath).some((error) => error.includes("same canonical STARTER_TEMPLATES_PATH")),
  );
});

test("stale PR metadata or an orphaned recovery issue fails the workflow contract", () => {
  const workflow = clone(loadWorkflow());
  const pr = workflow.jobs.refresh.steps.find((step) => step.run?.includes("gh pr create"));
  pr.run = pr.run.replace("gh pr edit", "echo stale-pr").replace("gh issue close", "echo orphaned-issue");
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("gh pr edit")));
  assert.ok(errors.some((error) => error.includes("gh issue close")));
});

test("opening the human-generated PR must resolve its recovery issue", () => {
  const workflow = clone(loadWorkflow());
  delete workflow.jobs["close-recovery-issue"];
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("generated PR lifecycle")));
});

test("collapsing the dispatch ref back into its SHA fails the workflow contract", () => {
  const workflow = clone(loadWorkflow());
  const resolve = workflow.jobs.refresh.steps.find((step) => step.id === "source");
  resolve.run = resolve.run.replace('source_ref="$DISPATCH_SOURCE_REF"', 'source_ref="$DISPATCH_SOURCE_SHA"');
  const errors = validateRefreshWorkflow(workflow);
  assert.ok(errors.some((error) => error.includes("named source ref separately")));
});

const ci = () => loadWorkflow(new URL("../.github/workflows/ci.yml", import.meta.url));
test("CI keeps independent validation and a fail-closed aggregate status", () => {
  assert.deepEqual(validateCiWorkflow(ci()), []);
  for (const mutate of [
    (w) => { w.jobs.validate.strategy["fail-fast"] = true; },
    (w) => { w.jobs.validate.strategy.matrix.lane = ["unit"]; },
    (w) => { w.jobs.check.if = "success()"; },
    (w) => { w.jobs.check.steps[0].run = "true"; },
    (w) => { w.jobs.validate.steps = w.jobs.validate.steps.filter((s) => !s.run?.includes("--with-deps")); },
    (w) => { w.jobs.validate.steps.find((s) => s.run === "npm run check:browser")["continue-on-error"] = true; },
  ]) {
    const workflow = ci();
    mutate(workflow);
    assert.ok(validateCiWorkflow(workflow).length > 0);
  }
});

test("CI command matching accepts comments/multiline and --silent without accepting other script names", () => {
  for (const command of ["npm run check:browser # browser proof", "# required proof\nnpm run --silent check:browser\n", "npm run -s check:browser"]) {
    const workflow = ci();
    workflow.jobs.validate.steps.find((s) => s.run === "npm run check:browser").run = command;
    assert.deepEqual(validateCiWorkflow(workflow), [], command);
  }
  for (const command of ["npm run check:browser-headed", "echo npm run check:browser", "# npm run check:browser"]) {
    const workflow = ci();
    workflow.jobs.validate.steps.find((s) => s.run === "npm run check:browser").run = command;
    assert.ok(validateCiWorkflow(workflow).some((error) => error.includes("must require check:browser")), command);
  }
});

test("CI requires a PR trigger and Chromium setup in the same browser lane", () => {
  const withoutTrigger = ci();
  delete withoutTrigger.on.pull_request;
  assert.ok(validateCiWorkflow(withoutTrigger).some((error) => error.includes("pull requests")));
  for (const change of [
    (w, step) => { step.if = "matrix.lane == 'unit'"; },
    (w, step) => { step["continue-on-error"] = true; },
    (w, step) => {
      w.jobs.setup = { steps: [step] };
      w.jobs.validate.steps = w.jobs.validate.steps.filter((s) => s !== step);
    },
  ]) {
    const workflow = ci();
    change(workflow, workflow.jobs.validate.steps.find((s) => s.run?.includes("--with-deps")));
    assert.ok(validateCiWorkflow(workflow).some((error) => error.includes("Chromium")));
  }
});
