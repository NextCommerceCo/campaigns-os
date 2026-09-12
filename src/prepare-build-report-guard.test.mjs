import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const SPEC = resolve(ROOT, "examples/campaignspec.v42.basic.json");
const SOURCE = resolve(ROOT, "examples/source-html");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-report-guard-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Run prepare-build (or start) against the in-repo example fixtures into a
// temp target. spawnSync (not execFileSync) so stderr is captured on success
// too — the --force path prints the cleared stage keys on stderr.
function runPrepare(dir, extraArgs = [], { command = "prepare-build" } = {}) {
  const target = join(dir, "target");
  if (!existsSync(target)) cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
  const result = spawnSync("node", [
    CLI, command,
    "--spec", SPEC,
    "--source", SOURCE,
    "--target", target,
    "--template-family", "olympus",
    "--no-run-session",
    ...extraArgs,
    "--json",
  ], { encoding: "utf8", cwd: dir });
  return { status: result.status, target, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function reportPathFor(target) {
  return join(target, ".campaign-runtime/assembly-report.json");
}

// Hand-advance stages.assembly the way a build agent records completed work.
function recordAssemblyEvidence(target) {
  const reportPath = reportPathFor(target);
  const report = readJson(reportPath);
  report.stages.assembly.status = "completed";
  report.stages.assembly.outputs = ["_site/checkout/index.html"];
  report.stages.assembly.commands = ["page-kit build"];
  report.stages.assembly.evidence = ["page-kit build log: 4 pages built"];
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

test("prepare-build refuses to overwrite an assembly report that carries stage evidence", () => {
  withTempDir((dir) => {
    const first = runPrepare(dir);
    assert.equal(first.status, 0, first.stderr);
    const reportPath = recordAssemblyEvidence(first.target);
    const bytesBefore = readFileSync(reportPath);

    const rerun = runPrepare(dir);
    assert.notEqual(rerun.status, 0, "rerun without --force must refuse");
    assert.match(rerun.stderr, /stage evidence/i);
    assert.match(rerun.stderr, /\bassembly\b/, "the refusal must name the stage keys it would clear");
    assert.match(rerun.stderr, /--force/);
    assert.ok(bytesBefore.equals(readFileSync(reportPath)), "the refused rerun must leave the report byte-identical");
  });
});

test("prepare-build --force reproduces the overwrite and prints the cleared stage keys", () => {
  withTempDir((dir) => {
    const first = runPrepare(dir);
    assert.equal(first.status, 0, first.stderr);
    const reportPath = recordAssemblyEvidence(first.target);

    const forced = runPrepare(dir, ["--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stderr, /clearing stage evidence/i);
    assert.match(forced.stderr, /\bassembly\b/, "--force must print the stage keys it cleared");
    const report = readJson(reportPath);
    assert.equal(report.stages.assembly.status, "pending", "--force reproduces today's full regeneration");
    assert.deepEqual(report.stages.assembly.outputs, []);
    assert.deepEqual(report.stages.assembly.commands, []);
  });
});

test("prepare-build on a fresh repository succeeds with no flag", () => {
  withTempDir((dir) => {
    const result = runPrepare(dir);
    assert.equal(result.status, 0, result.stderr);
    const report = readJson(reportPathFor(result.target));
    assert.equal(report.stages.prepare_build.status, "blocked");
    assert.equal(report.stages.assembly.status, "pending");
  });
});

test("an existing report with all stages still at seed states does not trigger the guard", () => {
  withTempDir((dir) => {
    // A real re-prepare before any work: the first run's report exists but no
    // agent has recorded anything. The guard keys on evidence, not file
    // existence, so the rerun must succeed with no flag.
    const first = runPrepare(dir);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(reportPathFor(first.target)));

    const rerun = runPrepare(dir);
    assert.equal(rerun.status, 0, `rerun over an evidence-free report must not need --force: ${rerun.stderr}`);
    const report = readJson(reportPathFor(rerun.target));
    assert.equal(report.stages.assembly.status, "pending");
  });
});

test("start shares the guard: it refuses to overwrite recorded stage evidence", () => {
  withTempDir((dir) => {
    const first = runPrepare(dir);
    assert.equal(first.status, 0, first.stderr);
    const reportPath = recordAssemblyEvidence(first.target);
    const bytesBefore = readFileSync(reportPath);

    const rerun = runPrepare(dir, [], { command: "start" });
    assert.notEqual(rerun.status, 0, "start without --force must refuse");
    assert.match(rerun.stderr, /stage evidence/i);
    assert.match(rerun.stderr, /\bassembly\b/);
    assert.match(rerun.stderr, /--force/);
    assert.ok(bytesBefore.equals(readFileSync(reportPath)), "the refused start must leave the report byte-identical");
  });
});

// The three intake commands share one dispatch body parameterised by mode.
// Pin the mode table so a refactor cannot silently swap which command runs
// doctor or installs agent context: start = doctor + context, build = doctor
// only, prepare-build = neither.
test("start, build, and prepare-build keep their doctor / agent-context modes", () => {
  const expected = [
    { command: "start", runDoctor: true, installContext: true },
    { command: "build", runDoctor: true, installContext: false },
    { command: "prepare-build", runDoctor: false, installContext: false },
  ];
  for (const { command, runDoctor, installContext } of expected) {
    withTempDir((dir) => {
      // Seed a placeholder doctor sidecar so presence cannot tell the modes
      // apart (a local checkout may carry a gitignored one; CI does not): a
      // doctor run rewrites it, no-doctor leaves it byte-identical.
      const target = join(dir, "target");
      cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
      const sidecar = join(target, ".campaign-runtime/doctor-output.json");
      mkdirSync(dirname(sidecar), { recursive: true });
      writeFileSync(sidecar, "{\"placeholder\":true}\n");
      const sidecarBefore = readFileSync(sidecar);
      const run = runPrepare(dir, [], { command });
      const result = JSON.parse(run.stdout);
      assert.equal(result.doctor !== null && typeof result.doctor === "object", runDoctor, `${command}: result.doctor`);
      assert.equal(!sidecarBefore.equals(readFileSync(sidecar)), runDoctor, `${command}: doctor-output.json rewritten`);
      assert.equal(existsSync(join(run.target, ".campaign-runtime/agent-context/CLAUDE.md")), installContext, `${command}: agent context install`);
    });
  }
});
