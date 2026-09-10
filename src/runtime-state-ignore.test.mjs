import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ensureRuntimeStateIgnored,
  RUNTIME_STATE_IGNORE_BLOCK,
  RUNTIME_STATE_IGNORE_MARKER,
  RUNTIME_STATE_IGNORED_PATHS,
} from "./runtime-state-ignore.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-runtime-ignore-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The commit-set decision, pinned: telemetry/session/cache/evidence entries
// are ignored; the readback bundle, inputs, theme, and agent context are not.
test("the ignore list names the machine-local set and never the readback bundle", () => {
  for (const ignored of [
    ".campaign-runtime/run-session.json",
    ".campaign-runtime/command-lifecycle.jsonl",
    ".campaign-runtime/agent-deviations.jsonl",
    ".campaign-runtime/run-records/",
    ".campaign-runtime/fetched-specs/",
  ]) {
    assert.ok(RUNTIME_STATE_IGNORED_PATHS.includes(ignored), ignored);
  }
  for (const committed of ["build-context.json", "assembly-report.json", "doctor-output.json", "qa-verdict.json", "input/", "theme/", "agent-context/", "setup-handoff.json"]) {
    assert.ok(!RUNTIME_STATE_IGNORED_PATHS.some((entry) => entry.includes(committed)), `${committed} must stay committable`);
  }
  assert.ok(!RUNTIME_STATE_IGNORED_PATHS.includes(".campaign-runtime/"), "never ignore the whole directory");
});

test("ensureRuntimeStateIgnored creates .gitignore, is idempotent on the marker, and preserves existing content", () => {
  withTempDir((dir) => {
    const first = ensureRuntimeStateIgnored(dir);
    assert.equal(first.action, "added");
    const text = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(text.startsWith(RUNTIME_STATE_IGNORE_MARKER));
    assert.ok(text.includes("run-records/"));
    assert.equal(ensureRuntimeStateIgnored(dir).action, "present");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), text, "a second call writes nothing");
  });
  withTempDir((dir) => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n_site/");
    ensureRuntimeStateIgnored(dir);
    const text = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(text.startsWith("node_modules/\n_site/\n\n"), "existing rules kept, block separated by a blank line");
    assert.ok(text.endsWith(`${RUNTIME_STATE_IGNORE_BLOCK}\n`));
    // an operator who edits the list beneath the marker is left alone
    writeFileSync(join(dir, ".gitignore"), text.replace(".campaign-runtime/workflow-findings.jsonl\n", ""));
    assert.equal(ensureRuntimeStateIgnored(dir).action, "present");
    assert.ok(!readFileSync(join(dir, ".gitignore"), "utf8").includes("workflow-findings.jsonl"));
  });
});

test("ensureRuntimeStateIgnored reports an unwritable target instead of throwing", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".gitignore"), "");
    chmodSync(join(dir, ".gitignore"), 0o444);
    try {
      const result = ensureRuntimeStateIgnored(dir);
      // root can write through 0444; either outcome is acceptable, but never a throw
      assert.ok(["added", "skipped"].includes(result.action), result.action);
      if (result.action === "skipped") assert.match(result.reason, /unwritable/);
    } finally {
      chmodSync(join(dir, ".gitignore"), 0o644);
    }
    assert.equal(ensureRuntimeStateIgnored(dir, { dryRun: true }).dry_run, true);
    assert.equal(existsSync(join(dir, "nope", ".gitignore")), false);
  });
});

test("CLI: install-agent-context writes the ignore block into the target and reports it", () => {
  withTempDir((dir) => {
    const out = JSON.parse(execFileSync("node", [CLI, "install-agent-context", "--target", dir, "--json"], { encoding: "utf8" }));
    assert.equal(out.gitignore.action, "added");
    assert.ok(readFileSync(join(dir, ".gitignore"), "utf8").includes(RUNTIME_STATE_IGNORE_MARKER));
    const dry = JSON.parse(execFileSync("node", [CLI, "install-agent-context", "--target", join(dir, "other"), "--dry-run", "--json"], { encoding: "utf8" }));
    assert.equal(dry.gitignore.dry_run, true);
    assert.equal(existsSync(join(dir, "other", ".gitignore")), false, "dry run writes nothing");
  });
});

test("CLI: run start writes the ignore block into the project it opens a session in", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "package.json"), "{}\n");
    execFileSync("node", [CLI, "run", "start", "--json"], { encoding: "utf8", cwd: dir, env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" } });
    const text = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(text.includes(".campaign-runtime/run-session.json"));
    // and git agrees: the session file is ignored, the bundle is not
    execFileSync("git", ["init", "-q"], { cwd: dir });
    assert.equal(execFileSync("git", ["check-ignore", "-q", ".campaign-runtime/run-session.json"], { cwd: dir, stdio: "pipe" }).length, 0);
    let ignoredBundle = true;
    try {
      execFileSync("git", ["check-ignore", "-q", ".campaign-runtime/assembly-report.json"], { cwd: dir, stdio: "pipe" });
    } catch {
      ignoredBundle = false;
    }
    assert.equal(ignoredBundle, false, "the readback bundle stays committable");
  });
});
