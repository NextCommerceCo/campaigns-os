import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Increment 2, 2.1 intake guard (contract 2.1 "Intake guard (refusal only)"):
// F2.1-B7, B8, B13, B19-B23, B26, B27. Without --force, intake also refuses
// to discard recorded waivers, warning accepts, stage history, an applied
// theme, non-host-strip report evidence, and deploy or order-path settings
// the run would change. Every command runs under the no-network guard
// (src/input-test-factories.mjs), which also reaches the child processes.
//
// A refused intake writes nothing: every file under the fixture directory
// (the target, which holds the packet, context, report, normalized brief,
// doctor sidecar and agent context) is byte-compared before and after the
// refused run. No lifecycle journal is selected: an intake refusal appends
// its lifecycle entry to a selected journal, as the stage-evidence refusal
// above does.

async function guarded(run) {
  const factories = await import("./input-test-factories.mjs");
  return factories.withNetworkGuard(() => withTempDir((dir) => run(dir, factories)));
}

// A fresh intake whose report then gains one piece of operator state and no
// stage evidence. Returns the report path and its bytes after the edit.
function intakeWithOperatorState(dir, edit) {
  const first = runPrepare(dir);
  assert.equal(first.status, 0, `setup: the first intake succeeds: ${first.stderr}`);
  const reportPath = reportPathFor(first.target);
  const report = readJson(reportPath);
  edit(report);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const key of ["setup", "assembly", "polish", "deploy", "qa"]) {
    const stage = report.stages[key];
    assert.ok(["pending", "skipped"].includes(stage.status), `setup: stages.${key} is at its seed status (${stage.status})`);
    for (const field of ["inputs", "outputs", "commands", "blockers", "warnings"]) {
      assert.equal(Array.isArray(stage[field]) && stage[field].length > 0, false, `setup: stages.${key}.${field} records no stage evidence`);
    }
  }
  return { target: first.target, reportPath, bytes: readFileSync(reportPath) };
}

const QC_ACCEPT = Object.freeze({
  schema: "campaigns-os-qc-accept/v0",
  scope: "qc_accept",
  result_id: "policy.availability:campaign:store_terms",
  check: "policy.availability",
  leg: "qa",
  subject: { check: "policy.availability", page: "campaign", key: "store_terms" },
  state_fingerprint: `sha256:${"a".repeat(64)}`,
  result_at_accept: "warning",
  measured_at: "2026-10-01T10:00:00.000Z",
  measured_source: "qa_verdict",
  reason: "synthetic accept kept across intake",
  accepted_by: "Jordan Lee",
  accepted_at: "2026-10-01T10:05:00.000Z",
  recorded_by: "campaigns-os checkpoint accept",
});
const withQcAccept = (report) => {
  report.qc_accepts = [{ ...QC_ACCEPT }];
};

test("F2.1-B7: start without --force refuses (exit 1) a report with no stage evidence and one qc_accepts[] entry", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    intakeWithOperatorState(dir, withQcAccept);
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `start exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused start");
  });
});

test("F2.1-B26: the start refused over a report holding one qc_accepts[] entry leaves the Assembly Report sha256 unchanged", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    const { reportPath, bytes } = intakeWithOperatorState(dir, withQcAccept);
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `setup: start ran and was refused (exit 1): ${rerun.stderr.slice(0, 400)}`);
    assert.equal(createHash("sha256").update(readFileSync(reportPath)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assertNothingWritten(dir, before, "the refused start");
  });
});

test("F2.1-B27: the start refused over a report holding one qc_accepts[] entry names qc_accepts in its refusal message", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    intakeWithOperatorState(dir, withQcAccept);
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `setup: start ran and was refused (exit 1): ${rerun.stderr.slice(0, 400)}`);
    assert.equal(rerun.stderr.includes("qc_accepts"), true, rerun.stderr.slice(0, 600));
    assertNothingWritten(dir, before, "the refused start");
  });
});

test("F2.1-B13: start without --force refuses (exit 1) a report with no stage evidence and a non-empty stages.qa.history[]", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    intakeWithOperatorState(dir, (report) => {
      report.stages.qa = {
        ...report.stages.qa,
        history: [{
          archived_at: "2026-10-01T10:00:00.000Z",
          archived_by: "qa run",
          reason_code: "rerecorded",
          status: "completed",
          completed_at: "2026-10-01T09:00:00.000Z",
          verdict_run_id: "qa-synthetic-run-0001",
        }],
      };
    });
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `start exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused start");
  });
});

test("F2.1-B19: start without --force refuses (exit 1) a report with no stage evidence and one waivers[] entry", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    intakeWithOperatorState(dir, (report) => {
      report.waivers = [{
        scope: "polish.synthetic_scope",
        reason: "synthetic waiver kept across intake",
        applies_to: [],
        waived_by: "Jordan Lee",
        waived_at: "2026-10-01T10:00:00.000Z",
        evidence_refs: [],
      }];
    });
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `start exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused start");
  });
});

test("F2.1-B20: start without --force refuses (exit 1) a report with no stage evidence and theme.status applied", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    intakeWithOperatorState(dir, (report) => {
      report.theme = { ...(report.theme || {}), status: "applied" };
    });
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `start exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused start");
  });
});

test("F2.1-B21: start without --force refuses (exit 1) a report with no stage evidence and one non-host-strip evidence[] line", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    intakeWithOperatorState(dir, (report) => {
      report.evidence = [...(Array.isArray(report.evidence) ? report.evidence : []), "operator note: synthetic evidence line kept across intake"];
    });
    const before = treeDigest(dir);
    const rerun = runPrepare(dir, [], { command: "start" });
    assert.equal(rerun.status, 1, `start exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused start");
  });
});

// `qa policy set` changes a packet setting the next intake would rewrite.
function intakeThenPolicySet(dir, policyArgs) {
  const first = runPrepare(dir);
  assert.equal(first.status, 0, `setup: the first intake succeeds: ${first.stderr}`);
  const packetPath = join(first.target, "campaign-runtime.build.json");
  const before = readFileSync(packetPath, "utf8");
  const set = spawnSync("node", [CLI, "qa", "policy", "set", "--packet", packetPath, ...policyArgs, "--json"], { encoding: "utf8", cwd: dir });
  assert.equal(set.status, 0, `setup: qa policy set succeeds: ${set.stderr}`);
  assert.notEqual(readFileSync(packetPath, "utf8"), before, "setup: qa policy set changed the packet");
  return packetPath;
}

test("F2.1-B8: after qa policy set --preview-url on a loopback URL, re-running intake with the original args exits 1", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    const packetPath = intakeThenPolicySet(dir, ["--preview-url", "http://127.0.0.1:4173/x/"]);
    assert.equal(readJson(packetPath).deploy.preview_url, "http://127.0.0.1:4173/x/", "setup: the packet records the preview URL");
    const before = treeDigest(dir);
    const rerun = runPrepare(dir);
    assert.equal(rerun.status, 1, `intake exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused intake");
  });
});

test("F2.1-B22: after qa policy set --deploy-target local-serve, re-running intake with the original args exits 1", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    const packetPath = intakeThenPolicySet(dir, ["--deploy-target", "local-serve"]);
    assert.equal(readJson(packetPath).deploy.target, "local-serve", "setup: the packet records the deploy target");
    const before = treeDigest(dir);
    const rerun = runPrepare(dir);
    assert.equal(rerun.status, 1, `intake exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused intake");
  });
});

test("F2.1-B23: after qa policy set --order-path-depth full, re-running intake with the original args exits 1", async () => {
  await guarded((dir, { treeDigest, assertNothingWritten }) => {
    const packetPath = intakeThenPolicySet(dir, ["--order-path-depth", "full"]);
    assert.equal(readJson(packetPath).qa.proof_policy.order_path_depth, "full", "setup: the packet records the order-path depth");
    const before = treeDigest(dir);
    const rerun = runPrepare(dir);
    assert.equal(rerun.status, 1, `intake exits 1: ${rerun.stderr.slice(0, 400)}`);
    assertNothingWritten(dir, before, "the refused intake");
  });
});
