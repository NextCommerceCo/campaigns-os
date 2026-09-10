import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
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
  const sidecar = join(dir, ".campaign-runtime/doctor-output.json");
  assert.equal(existsSync(sidecar), false);
  const result = doctorCommand({ packet: join(dir, "campaign-runtime.build.json") });
  assert.equal(existsSync(sidecar), true);
  const written = JSON.parse(readFileSync(sidecar, "utf8"));
  assert.equal(written.ok, result.ok);
  assert.equal(written.status, result.status);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor honors --no-write", () => {
  const dir = packetFixture();
  doctorCommand({ packet: join(dir, "campaign-runtime.build.json"), "no-write": true });
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor honors --doctor-out override", () => {
  const dir = packetFixture();
  const out = join(dir, "custom-doctor.json");
  doctorCommand({ packet: join(dir, "campaign-runtime.build.json"), "doctor-out": out });
  assert.equal(existsSync(out), true);
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
