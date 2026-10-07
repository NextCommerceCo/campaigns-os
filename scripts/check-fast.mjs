#!/usr/bin/env node
/**
 * The fast local gates: what CI's types and contracts lanes run, plus the three
 * PR-only release gates against origin/main. Together they catch the failures
 * pull requests hit most often (changelog structure, the release ledger, skill
 * versions, supported-surface hashes, generated docs) in under a minute, where
 * a CI run takes about ten. The unit and browser lanes stay in CI.
 *
 *   npm run check:fast                # fetches origin/main first
 *   npm run check:fast -- --no-fetch  # compares against the origin/main you have
 *
 * scripts/pre-push.mjs runs this before every push once `npm run hooks:install`
 * has installed the hook (docs/small-pr-review-path.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveStarterTemplatesRoot } from "./starter-templates-path.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// These read a campaign-cart-starter-templates checkout beside this one.
export const TEMPLATE_CHECKS = ["check:template-doctrine", "check:slot-manifest"];
// CI's PR-only release gates, run with --base (docs/small-pr-review-path.md).
export const RELEASE_GATES = ["check-skill-versions", "check-supported-surface", "check-release-ledger"];

/** The npm scripts `check:contracts` chains, in order. */
export function contractChecks(scripts) {
  const chain = scripts?.["check:contracts"];
  if (typeof chain !== "string") throw new Error("package.json has no check:contracts script");
  return chain.split("&&").map((part) => {
    const match = /^\s*npm run ([\w:.-]+)\s*$/.exec(part);
    if (!match) throw new Error(`check:contracts step is not \`npm run <script>\`: ${part.trim()}`);
    return match[1];
  });
}

/** Every gate as { label, command, args }, in the order CI's lanes run them. */
export function fastChecks({ scripts, base, templatesAvailable }) {
  const npm = (script, ...extra) => ({
    label: [script, ...extra].join(" "),
    command: "npm",
    args: ["run", "--silent", script, ...(extra.length > 0 ? ["--", ...extra] : [])],
  });
  const checks = [npm("build:spec"), npm("check:spec"), npm("check:pack", "--skip-prepare")];
  for (const script of contractChecks(scripts)) {
    if (templatesAvailable || !TEMPLATE_CHECKS.includes(script)) checks.push(npm(script));
  }
  for (const gate of RELEASE_GATES) {
    checks.push({ label: `${gate} --base ${base}`, command: process.execPath, args: [`./scripts/${gate}.mjs`, "--base", base] });
  }
  return checks;
}

const indent = (text) => text.replace(/\s+$/, "").split("\n").map((line) => `     ${line}`).join("\n");

function main(argv) {
  const started = Date.now();
  if (!argv.includes("--no-fetch")) {
    const fetched = spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, stdio: "inherit" });
    if (fetched.status !== 0) console.error("check:fast: could not fetch origin/main; comparing against the copy you have");
  }
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const templatesAvailable = existsSync(resolveStarterTemplatesRoot(root));
  if (!templatesAvailable) {
    console.error(`check:fast: no campaign-cart-starter-templates checkout beside this one, so ${TEMPLATE_CHECKS.join(" and ")} are skipped (CI runs them)`);
  }

  const failures = [];
  for (const check of fastChecks({ scripts, base: "origin/main", templatesAvailable })) {
    const checkStarted = Date.now();
    const result = spawnSync(check.command, check.args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const seconds = ((Date.now() - checkStarted) / 1000).toFixed(1);
    if (result.status === 0) {
      console.log(`ok   ${check.label} (${seconds}s)`);
      continue;
    }
    failures.push(check.label);
    console.log(`FAIL ${check.label} (${seconds}s)`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
    if (output.trim()) console.log(indent(output));
  }

  const total = ((Date.now() - started) / 1000).toFixed(0);
  if (failures.length > 0) {
    console.log(`check:fast: ${failures.length} failed in ${total}s: ${failures.join(", ")}`);
    return 1;
  }
  console.log(`check:fast: all passed in ${total}s`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
