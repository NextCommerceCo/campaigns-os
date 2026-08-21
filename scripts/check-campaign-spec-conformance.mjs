#!/usr/bin/env node

/**
 * Conformance gate: every public agent-contract fixture in
 * contracts/fixtures/campaign-specs/ must pass validateSpec with zero
 * error-severity violations.
 *
 * Why it exists: these fixtures are the contract examples agents reason from,
 * but until this gate nothing ran them through the validator — they could
 * (and did) drift into shapes the CampaignSpec module itself rejects.
 *
 * Semantics:
 *   - error-severity violations  → gate FAILS (non-zero exit);
 *   - warning-severity violations → printed per fixture, every one of them
 *     (no truncation — the report must read honestly), but allowed.
 *
 * Imports the compiled campaign-spec/dist build, same as src/cli.mjs; run
 * `npm run build:spec` first on a fresh clone. In the root `check` chain this
 * script runs after build:spec, so dist is always present there.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Dynamic import so a fresh clone gets an actionable message instead of a
// module-resolution crash: static imports hoist above any existence check.
const distEntry = new URL("../campaign-spec/dist/index.js", import.meta.url);
if (!existsSync(distEntry)) {
  console.error(
    "check-campaign-spec-conformance: campaign-spec/dist/index.js not found — run `npm run build:spec` first.",
  );
  process.exit(1);
}
const { validateSpec } = await import(distEntry.href);

const root = resolve(new URL("..", import.meta.url).pathname);
export const FIXTURES_DIR = join(root, "contracts", "fixtures", "campaign-specs");

/** Run validateSpec on one parsed fixture and split violations by severity. */
export function evaluateFixture(spec) {
  const violations = validateSpec(spec);
  return {
    errors: violations.filter((v) => v.severity === "error"),
    warnings: violations.filter((v) => v.severity === "warning"),
  };
}

/** Load and evaluate every *.json fixture in a directory (sorted, stable order). */
export function evaluateFixtureDir(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return names.map((name) => {
    const path = join(dir, name);
    let spec;
    try {
      spec = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      // Same shape as a real Violation (path + data present) so consumers can
      // iterate errors[] uniformly.
      return {
        name,
        errors: [{ ruleId: "ParseError", severity: "error", message: `not valid JSON: ${error.message}`, path: "", data: { file: name } }],
        warnings: [],
      };
    }
    return { name, ...evaluateFixture(spec) };
  });
}

function formatViolation(v) {
  return `[${v.ruleId}] ${v.message}${v.path ? ` (${v.path})` : ""}`;
}

function main() {
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`check-campaign-spec-conformance: fixtures directory missing: ${relative(root, FIXTURES_DIR)}`);
    process.exit(1);
  }
  const results = evaluateFixtureDir(FIXTURES_DIR);
  if (results.length === 0) {
    console.error(`check-campaign-spec-conformance: no fixtures found in ${relative(root, FIXTURES_DIR)} — nothing was checked.`);
    process.exit(1);
  }

  let errorCount = 0;
  let warningCount = 0;
  for (const { name, errors, warnings } of results) {
    errorCount += errors.length;
    warningCount += warnings.length;
    for (const v of errors) console.error(`  ${name}: ERROR ${formatViolation(v)}`);
    for (const v of warnings) console.log(`  ${name}: warning ${formatViolation(v)}`);
  }

  if (errorCount > 0) {
    console.error(
      `\ncheck-campaign-spec-conformance: ${errorCount} error-severity violation(s) across ${results.length} fixture(s). ` +
        `Public contract fixtures must pass validateSpec with zero errors.`,
    );
    process.exit(1);
  }

  console.log(
    `Campaign-spec conformance check passed (${results.length} fixtures, 0 errors, ${warningCount} warning(s) listed above).`,
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
