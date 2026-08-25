import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflow, validateRefreshWorkflow } from "./check-workflow-contracts.mjs";

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
