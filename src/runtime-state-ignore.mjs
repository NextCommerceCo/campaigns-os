// Which .campaign-runtime/ entries are meant for the campaign repository's git
// history, and which are not. Three kinds share the directory:
//
//   1. The readback bundle (build-context, assembly-report, doctor-output,
//      qa-verdict) — current readback truth; docs/migration-sidecar-bundle.md
//      names it and `bundle check` validates it. Committed by design.
//   2. Handoff inputs and agent context (input/, theme/, agent-context/,
//      setup-handoff.json) — durable build handoff. Committed by design.
//   3. Telemetry, sessions, caches, and evidence — per-machine, append-only,
//      or carrying live URLs and absolute paths. Never meant for the repo, and
//      nothing wrote a rule for them: three campaign repositories were found
//      carrying another operator's run-session.json (absolute home path and
//      all), lifecycle journals, and deviation logs.
//
// This module writes the rule for kind 3, once, into the target's .gitignore.
// A deny-list by name rather than "ignore the directory, re-include the
// bundle": git cannot re-include a file beneath an ignored directory, and a
// new sidecar should default to visible so someone has to decide about it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RUNTIME_STATE_IGNORE_MARKER = "# campaigns-os: machine-local runtime state (managed block; edit the list, keep the marker)";

export const RUNTIME_STATE_IGNORED_PATHS = [
  ".campaign-runtime/run-session.json",
  ".campaign-runtime/command-lifecycle.jsonl",
  ".campaign-runtime/agent-deviations.jsonl",
  ".campaign-runtime/workflow-findings.jsonl",
  ".campaign-runtime/run-records/",
  ".campaign-runtime/fetched-specs/",
  ".campaign-runtime/polish-evidence/",
  ".campaign-runtime/evidence/",
  ".campaign-runtime/*.log",
  ".campaign-runtime/*.tmp",
  ".campaign-runtime/**/*.tmp",
];

export const RUNTIME_STATE_IGNORE_BLOCK = [
  RUNTIME_STATE_IGNORE_MARKER,
  "# Sessions, journals, Run Records, spec caches, and capture evidence are",
  "# per-machine. The readback bundle (build-context, assembly-report,",
  "# doctor-output, qa-verdict), input/, theme/, and agent-context/ are meant",
  "# to be committed and are deliberately not listed here.",
  ...RUNTIME_STATE_IGNORED_PATHS,
].join("\n");

/**
 * Ensure the target's .gitignore carries the runtime-state block. Idempotent
 * on the marker line: an existing block, however edited beneath it, is left
 * alone. Never throws for an unwritable target — the build must not fail on
 * housekeeping — but reports what happened so callers can surface it.
 * Returns `{ path, action: "added" | "present" | "skipped", reason? }`.
 */
export function ensureRuntimeStateIgnored(targetRepo, { dryRun = false } = {}) {
  const path = join(resolve(targetRepo), ".gitignore");
  let existing = "";
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, "utf8");
    } catch (error) {
      return { path, action: "skipped", reason: `unreadable: ${error.message}` };
    }
    if (existing.includes(RUNTIME_STATE_IGNORE_MARKER)) return { path, action: "present" };
  }
  if (dryRun) return { path, action: "added", dry_run: true };
  const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  try {
    writeFileSync(path, `${existing}${separator}${RUNTIME_STATE_IGNORE_BLOCK}\n`);
  } catch (error) {
    return { path, action: "skipped", reason: `unwritable: ${error.message}` };
  }
  return { path, action: "added" };
}
