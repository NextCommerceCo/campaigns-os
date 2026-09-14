import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { doctorCommand, doctorPacket, recordQaStageOutcome } from "./cli.mjs";

// NEXT-114 dogfood finding wf_1785566917680: only prepare-build/start wrote
// .campaign-runtime/doctor-output.json, so every later standalone doctor run
// left the retained sidecar frozen at the intake snapshot while reporting
// fresh state on stdout. Standalone packet-mode doctor now refreshes the
// sidecar (opt out with --no-write).

function packetFixture() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-sidecar-"));
  cpSync(new URL("../examples/build-packet.basic.json", import.meta.url).pathname, join(dir, "campaign-runtime.build.json"));
  return dir;
}

test("standalone doctor refreshes the doctor-output.json sidecar", () => {
  const dir = packetFixture();
  // The example packet declares target_repo "target-page-kit"; the sidecar
  // lives under the target repo, where prepare-build and next write it.
  const sidecar = join(dir, "target-page-kit/.campaign-runtime/doctor-output.json");
  assert.equal(existsSync(sidecar), false);
  const result = doctorCommand({ packet: join(dir, "campaign-runtime.build.json") });
  assert.equal(existsSync(sidecar), true);
  const written = JSON.parse(readFileSync(sidecar, "utf8"));
  assert.equal(written.ok, result.ok);
  assert.equal(written.status, result.status);
  rmSync(dir, { recursive: true, force: true });
});

// `next` and the QA stage refresh already replaced the sidecar atomically;
// standalone doctor rewrote it in place, so a reader racing a doctor run
// could see a torn snapshot — the one artifact whose freshness contract a
// torn write breaks outright.
test("standalone doctor replaces the doctor-output.json sidecar atomically rather than rewriting it in place", () => {
  const dir = packetFixture();
  const packetPath = join(dir, "campaign-runtime.build.json");
  const sidecar = join(dir, "target-page-kit/.campaign-runtime/doctor-output.json");
  doctorCommand({ packet: packetPath });
  const before = statSync(sidecar).ino;
  const result = doctorCommand({ packet: packetPath });
  assert.notEqual(statSync(sidecar).ino, before, "tmp + rename: the sidecar path names a new file");
  assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).generated_at, result.generated_at);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor honors --no-write", () => {
  const dir = packetFixture();
  doctorCommand({ packet: join(dir, "campaign-runtime.build.json"), "no-write": true });
  assert.equal(existsSync(join(dir, "target-page-kit/.campaign-runtime/doctor-output.json")), false);
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor honors --doctor-out override", () => {
  const dir = packetFixture();
  const out = join(dir, "custom-doctor.json");
  doctorCommand({ packet: join(dir, "campaign-runtime.build.json"), "doctor-out": out });
  assert.equal(existsSync(out), true);
  assert.equal(existsSync(join(dir, "target-page-kit/.campaign-runtime/doctor-output.json")), false);
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor owns the matching Assembly Report stage ledger", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), JSON.stringify({
    schema_version: "campaign-runtime-assembly-report/v0",
    identity: { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug },
    stages: { doctor: { stage: "doctor", status: "pending", inputs: [], outputs: [], commands: [], blockers: [], warnings: [] } },
  }));

  const result = doctorCommand({ packet: packetPath, _: ["doctor"] });
  const report = JSON.parse(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8"));
  assert.equal(report.stages.doctor.status, result.ok ? (result.warnings.length ? "completed_with_warnings" : "completed") : "blocked");
  assert.equal(report.stages.doctor.checked_at, result.generated_at);
  assert.deepEqual(report.stages.doctor.commands, ["campaigns-os doctor"]);
  assert.equal(report.stages.doctor.outputs.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a doctor re-run that restates the same outcome leaves the Assembly Report bytes unchanged", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  const reportPath = join(dir, ".campaign-runtime/assembly-report.json");
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    identity: { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug },
    stages: {},
  }));

  // Two runs settle the report: the first creates the doctor stage, the
  // second no longer finds "doctor stage is required" among its blockers.
  doctorCommand({ packet: packetPath, _: ["doctor"] });
  const settled = doctorCommand({ packet: packetPath, _: ["doctor"] });
  const afterSettled = readFileSync(reportPath, "utf8");
  assert.equal(JSON.parse(afterSettled).stages.doctor.checked_at, settled.generated_at);

  // Same packet, same outcome: the digest a Run Record took of this file
  // must still verify after the re-run.
  const rerun = doctorCommand({ packet: packetPath, _: ["doctor"] });
  assert.deepEqual(rerun.errors.map((issue) => issue.message), settled.errors.map((issue) => issue.message));
  assert.equal(readFileSync(reportPath, "utf8"), afterSettled);

  const afterFirst = afterSettled;

  // A changed outcome is a new chapter and still writes.
  const stale = JSON.parse(afterFirst);
  stale.stages.doctor.blockers = ["a blocker this run no longer finds"];
  writeFileSync(reportPath, JSON.stringify(stale));
  const third = doctorCommand({ packet: packetPath, _: ["doctor"] });
  const afterThird = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.notDeepEqual(afterThird.stages.doctor.blockers, stale.stages.doctor.blockers);
  assert.equal(afterThird.stages.doctor.checked_at, third.generated_at);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor does not restate its outcome into a report it did not inspect", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  const identity = { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug };
  // The context records a custom report; a same-campaign report also sits at the default location.
  writeFileSync(join(dir, ".campaign-runtime/build-context.json"), JSON.stringify({ report_path: "custom-report.json" }));
  writeFileSync(join(dir, "custom-report.json"), JSON.stringify({ identity, stages: {} }));
  const defaultReport = JSON.stringify({ identity, stages: { doctor: { stage: "doctor", status: "pending", inputs: [], outputs: [], commands: [], blockers: [], warnings: [] } } });
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), defaultReport);

  doctorCommand({ packet: packetPath, _: ["doctor"] });
  assert.equal(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8"), defaultReport, "the default report is untouched");
  assert.equal(JSON.parse(readFileSync(join(dir, "custom-report.json"), "utf8")).stages.doctor, undefined, "the inspected custom report is not written either");
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor never opens a default report it did not inspect, malformed or not, and still refreshes the sidecar", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  const identity = { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug };
  writeFileSync(join(dir, ".campaign-runtime/build-context.json"), JSON.stringify({ report_path: "custom-report.json" }));
  writeFileSync(join(dir, "custom-report.json"), JSON.stringify({ identity, stages: {} }));
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "{ not a report\n");

  const result = doctorCommand({ packet: packetPath, _: ["doctor"] });
  assert.equal(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8"), "{ not a report\n", "the default report is untouched");
  assert.equal(JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8")).generated_at, result.generated_at, "the sidecar is this run's");
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor executes its packet inspection once when updating the stage ledger", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), JSON.stringify({
    identity: { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug },
    stages: {},
  }));
  let calls = 0;
  const result = doctorCommand({ packet: packetPath, _: ["doctor"] }, {
    runDoctor(path, options) {
      calls += 1;
      return doctorPacket(path, options);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.generated_at, JSON.parse(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8")).stages.doctor.checked_at);
  rmSync(dir, { recursive: true, force: true });
});

// The doctor sidecar belongs to the target repo, like every other build
// sidecar: prepare-build, next and the QA stage refresh all write it there.
// Standalone doctor used to write it beside the packet instead, so a packet
// kept outside its target (`prepare-build --out`) left two sidecars that
// disagreed and a stale-stamp that never found the one doctor wrote.
test("standalone doctor writes the sidecar under the target repo, not beside a packet kept elsewhere", () => {
  const dir = packetFixture();
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.target_repo = "built";
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  mkdirSync(join(dir, "built"), { recursive: true });

  doctorCommand({ packet: packetPath, _: ["doctor"] });
  assert.equal(existsSync(join(dir, "built/.campaign-runtime/doctor-output.json")), true, "written under the target repo");
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false, "not beside the packet");
  rmSync(dir, { recursive: true, force: true });
});

// The Build Context records where prepare-build wrote the report
// (--report-out). `next` follows that pointer; the QA stage record has to
// land in the same file, or a custom-report run's QA outcome is written
// nowhere (the default report does not exist) while `next` keeps reading a
// report whose QA stage never completes.
test("the QA stage is recorded into the report the Build Context binds", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  const identity = { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug };
  mkdirSync(join(dir, ".campaign-runtime/reports"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/build-context.json"), JSON.stringify({ report_path: ".campaign-runtime/reports/assembly-report.json" }));
  const boundReportPath = join(dir, ".campaign-runtime/reports/assembly-report.json");
  writeFileSync(boundReportPath, JSON.stringify({ identity, stages: {} }));
  assert.equal(existsSync(join(dir, ".campaign-runtime/assembly-report.json")), false, "no default report: the bound one is the campaign's");

  const result = {
    local_path: join(dir, "qa-output/verdict.json"),
    verdict: { run_id: "qa_0001", disposition: "ready", completed_at: "2026-09-14T00:00:00.000Z", assertions: [] },
  };
  assert.equal(recordQaStageOutcome({ packet: packetPath }, result), true);
  const bound = JSON.parse(readFileSync(boundReportPath, "utf8"));
  assert.equal(bound.stages.qa?.status, "completed");
  assert.equal(bound.stages.qa?.verdict_run_id, "qa_0001");
  assert.equal(existsSync(join(dir, ".campaign-runtime/assembly-report.json")), false, "nothing was written to the default location");
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), true, "the doctor sidecar was refreshed in the same transaction");
  rmSync(dir, { recursive: true, force: true });
});

// The doctor re-record rule now covers the QA stage: a run that restates
// exactly the outcome on disk, differing only in the stage timestamps, leaves
// the report's bytes (and any digest of them) alone. The outcome is still
// recorded — the call reports true and refreshes the sidecar as it always did.
test("a QA re-record that moves only the stage timestamps leaves the report bytes alone, reports true and refreshes the sidecar", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  const reportPath = join(dir, ".campaign-runtime/assembly-report.json");
  const sidecarPath = join(dir, ".campaign-runtime/doctor-output.json");
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    identity: { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug },
    stages: {},
  }));
  const verdict = (completedAt) => ({
    local_path: join(dir, "qa-output/verdict.json"),
    verdict: { run_id: "qa_0001", disposition: "ready", completed_at: completedAt, assertions: [] },
  });
  assert.equal(recordQaStageOutcome({ packet: packetPath }, verdict("2026-09-14T00:00:00.000Z")), true);
  const bytes = readFileSync(reportPath, "utf8");
  writeFileSync(sidecarPath, JSON.stringify({ ok: true, status: "ancient", stale: true }));

  assert.equal(recordQaStageOutcome({ packet: packetPath }, verdict("2026-09-14T00:05:00.000Z")), true, "the outcome is on disk");
  assert.equal(readFileSync(reportPath, "utf8"), bytes, "a re-record does not move the report's digest");
  assert.notEqual(JSON.parse(readFileSync(sidecarPath, "utf8")).stale, true, "the sidecar was refreshed all the same");
  rmSync(dir, { recursive: true, force: true });
});

test("QA stage ledger telemetry skips malformed sidecars and invalid verdict timestamps", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  const reportPath = join(dir, ".campaign-runtime/assembly-report.json");
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(reportPath, "{ malformed report\n");
  const result = { local_path: join(dir, "qa.json"), verdict: { disposition: "blocked", assertions: [] } };
  assert.equal(recordQaStageOutcome({ packet: packetPath }, result), false);

  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  const validReport = {
    identity: { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug },
    stages: {},
  };
  writeFileSync(reportPath, JSON.stringify(validReport));
  assert.equal(recordQaStageOutcome({ packet: packetPath }, result), false);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), validReport);
  rmSync(dir, { recursive: true, force: true });
});

// #171: stale-green sidecar. Mutating commands stamp the retained snapshot
// stale; `next` refreshes it wholesale on every call.
import { writeFileSync, mkdirSync } from "node:fs";
import { markDoctorSidecarStale } from "./doctor-sidecar.mjs";
import { nextStage, themeWaive } from "./cli.mjs";
import { runQaCli } from "./qa-node.mjs";

function selfTargetPacketFixture() {
  const dir = packetFixture();
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.target_repo = ".";
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  return { dir, packetPath };
}

test("markDoctorSidecarStale stamps an existing sidecar and preserves its fields", () => {
  const { dir } = selfTargetPacketFixture();
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/doctor-output.json"), JSON.stringify({ ok: true, status: "ready" }));
  const path = markDoctorSidecarStale(dir, { command: "unit-test" });
  const sidecar = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(sidecar.stale, true);
  assert.equal(sidecar.stale_marked_by, "unit-test");
  assert.ok(sidecar.stale_reason.includes("doctor"));
  assert.equal(sidecar.ok, true);
  assert.equal(sidecar.status, "ready");
  rmSync(dir, { recursive: true, force: true });
});

test("markDoctorSidecarStale is a no-op when no sidecar exists", () => {
  const { dir } = selfTargetPacketFixture();
  assert.equal(markDoctorSidecarStale(dir, { command: "unit-test" }), null);
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("next refreshes the doctor sidecar so it cannot stay a green lie", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/doctor-output.json"), JSON.stringify({ ok: true, status: "ancient-green-lie", stale: true }));
  nextStage(null, { packet: packetPath, _: [] });
  const sidecar = JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
  assert.notEqual(sidecar.status, "ancient-green-lie");
  assert.notEqual(sidecar.stale, true);
  assert.ok(Array.isArray(sidecar.errors));
  rmSync(dir, { recursive: true, force: true });
});

test("next honors --no-write for the sidecar refresh", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/doctor-output.json"), JSON.stringify({ ok: true, status: "frozen" }));
  nextStage(null, { packet: packetPath, _: [], "no-write": true });
  const sidecar = JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
  assert.equal(sidecar.status, "frozen");
  rmSync(dir, { recursive: true, force: true });
});

test("theme waive marks the retained doctor sidecar stale", () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), JSON.stringify({ stages: {} }));
  writeFileSync(join(dir, ".campaign-runtime/doctor-output.json"), JSON.stringify({ ok: true, status: "ready" }));
  themeWaive({ packet: packetPath, reason: "unit-test waiver", _: [] });
  const sidecar = JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
  assert.equal(sidecar.stale, true);
  assert.equal(sidecar.stale_marked_by, "theme waive");
  rmSync(dir, { recursive: true, force: true });
});

test("qa policy set marks the retained doctor sidecar stale only when the packet changed", async () => {
  const { dir, packetPath } = selfTargetPacketFixture();
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/doctor-output.json"), JSON.stringify({ ok: true, status: "ready" }));
  await runQaCli({ _: ["qa", "policy", "set"], packet: packetPath, json: true });
  let sidecar = JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
  assert.notEqual(sidecar.stale, true);
  await runQaCli({ _: ["qa", "policy", "set"], packet: packetPath, json: true, "preview-url": "https://preview.example.test/demo/" });
  sidecar = JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
  assert.equal(sidecar.stale, true);
  assert.equal(sidecar.stale_marked_by, "qa policy set");
  rmSync(dir, { recursive: true, force: true });
});
