#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = resolve(new URL("..", import.meta.url).pathname);
export const REFRESH_WORKFLOW_PATH = ".github/workflows/refresh-starter-template-catalog.yml";

const runText = (step) => (typeof step?.run === "string" ? step.run : "");
const usesText = (step) => (typeof step?.uses === "string" ? step.uses : "");

export function validateRefreshWorkflow(workflow) {
  const errors = [];
  const steps = workflow?.jobs?.refresh?.steps;
  if (!Array.isArray(steps)) {
    return ["refresh workflow must define jobs.refresh.steps"];
  }

  if (workflow?.concurrency?.group !== "refresh-starter-template-catalog") {
    errors.push("refresh workflow must serialize writers with the refresh-starter-template-catalog concurrency group");
  }
  if (workflow?.concurrency?.["cancel-in-progress"] !== false) {
    errors.push("refresh workflow must not cancel an in-progress catalog writer");
  }
  const pullRequestTypes = workflow?.on?.pull_request?.types;
  if (!Array.isArray(pullRequestTypes) || !["opened", "reopened"].every((type) => pullRequestTypes.includes(type))) {
    errors.push("refresh workflow must close recovery issues when the generated PR is opened or reopened");
  }
  for (const permission of ["contents", "pull-requests", "issues"]) {
    if (workflow?.permissions?.[permission] !== "write") {
      errors.push(`refresh workflow requires ${permission}: write`);
    }
  }

  const checkoutIndex = steps.findIndex((step) => usesText(step).startsWith("actions/checkout@"));
  const setupIndex = steps.findIndex((step) => usesText(step).startsWith("actions/setup-node@"));
  const installIndex = steps.findIndex(
    (step) => !step?.uses && /^npm ci(?:\s|$)/.test(runText(step).trim()),
  );
  const resolveIndex = steps.findIndex((step) => step?.id === "source");
  const refreshIndex = steps.findIndex((step) => runText(step).includes("refresh-starter-template-catalog.mjs"));
  const validateIndex = steps.findIndex((step) => runText(step).trim() === "npm run check");
  const prIndex = steps.findIndex((step) => runText(step).includes("gh pr create"));

  if (checkoutIndex < 0) errors.push("refresh workflow must check out the repository");
  if (setupIndex < 0) errors.push("refresh workflow must set up Node");
  if (installIndex < 0) errors.push("refresh workflow must install locked dependencies with npm ci");
  if (resolveIndex < 0) errors.push("refresh workflow must resolve source ref and SHA separately");
  if (refreshIndex < 0) errors.push("refresh workflow must run the catalog refresh script");
  if (validateIndex < 0) errors.push("refresh workflow must validate the generated snapshot with npm run check");
  if (prIndex < 0) errors.push("refresh workflow must attempt to open a pull request");

  if (installIndex >= 0 && refreshIndex >= 0 && installIndex > refreshIndex) {
    errors.push("npm ci must run before the catalog refresh script");
  }
  if (installIndex >= 0 && validateIndex >= 0 && installIndex > validateIndex) {
    errors.push("npm ci must run before npm run check");
  }

  const checkoutToken = steps[checkoutIndex]?.with?.token;
  if (typeof checkoutToken !== "string" || !checkoutToken.includes("CATALOG_REFRESH_TOKEN")) {
    errors.push("checkout must prefer CATALOG_REFRESH_TOKEN so bot-authored PRs can trigger CI");
  }
  if (steps[setupIndex]?.with?.cache !== "npm") {
    errors.push("setup-node must cache npm dependencies");
  }

  const resolveRun = runText(steps[resolveIndex]);
  if (
    !resolveRun.includes('source_ref="$DISPATCH_SOURCE_REF"') ||
    !resolveRun.includes('source_sha="$DISPATCH_SOURCE_SHA"') ||
    resolveRun.includes('source_ref="$DISPATCH_SOURCE_SHA"')
  ) {
    errors.push("repository dispatch must retain the named source ref separately from its immutable SHA");
  }

  const refreshRun = runText(steps[refreshIndex]);
  if (!refreshRun.includes("--source-ref") || !refreshRun.includes("--synced-from-sha")) {
    errors.push("refresh must preserve the source ref while pinning the exact dispatch SHA");
  }

  const prStep = steps[prIndex];
  if (typeof prStep?.env?.GH_TOKEN !== "string" || !prStep.env.GH_TOKEN.includes("CATALOG_REFRESH_TOKEN")) {
    errors.push("PR creation must prefer CATALOG_REFRESH_TOKEN");
  }
  if (typeof prStep?.env?.FALLBACK_GH_TOKEN !== "string" || !prStep.env.FALLBACK_GH_TOKEN.includes("github.token")) {
    errors.push("human-recovery issue creation must use the repository-scoped Actions token");
  }
  const prRun = runText(prStep);
  for (const required of [
    'branch="automation/refresh-starter-template-catalog"',
    "git status --porcelain --untracked-files=all",
    'git push --force origin "$branch"',
    "gh pr edit",
    "gh pr comment",
    "gh issue create",
    "gh issue close",
    "GITHUB_STEP_SUMMARY",
  ]) {
    if (!prRun.includes(required)) {
      errors.push(`PR step is missing recovery invariant: ${required}`);
    }
  }
  if (prRun.includes("GITHUB_RUN_ID")) {
    errors.push("PR step must reuse one workflow-owned branch instead of leaking a branch per run");
  }

  const closeJob = workflow?.jobs?.["close-recovery-issue"];
  const closeRun = Array.isArray(closeJob?.steps) ? closeJob.steps.map(runText).join("\n") : "";
  if (
    typeof closeJob?.if !== "string" ||
    !closeJob.if.includes("head.repo.full_name == github.repository") ||
    !closeJob.if.includes("automation/refresh-starter-template-catalog") ||
    !closeRun.includes("gh issue close")
  ) {
    errors.push("generated PR lifecycle must close the durable recovery issue");
  }

  return errors;
}

export function loadWorkflow(path = resolve(root, REFRESH_WORKFLOW_PATH)) {
  return parse(readFileSync(path, "utf8"));
}

function main() {
  const errors = validateRefreshWorkflow(loadWorkflow());
  if (errors.length > 0) {
    console.error(`check-workflow-contracts: ${errors.length} error(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log("Workflow contract checks passed.");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();
