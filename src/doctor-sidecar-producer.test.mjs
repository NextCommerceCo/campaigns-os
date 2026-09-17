// #312: the retained doctor sidecar names the command that persisted it.
// `generated_at` alone could not tell a fresh write from a gitignored copy
// carried into a temp dir by `cp -R`, which is how a read-only command came
// to be accused of writing the file. Every producer stamps its own name on
// the way out — `doctor --write`, `next`, `start`/`build`, the QA stage
// refresh — and the commands that never write (`prepare-build`, `next
// --no-write`, `standardize`) leave whatever is there byte-identical.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { doctorCommand, nextStage, recordQaStageOutcome } from "./cli.mjs";
import { DOCTOR_SIDECAR_REL_PATH, stampDoctorProducer, writeDoctorSidecar } from "./doctor-sidecar.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const SPEC = resolve(ROOT, "examples/campaignspec.v42.basic.json");
const SOURCE = resolve(ROOT, "examples/source-html");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "doctor-sidecar-producer-"));
}

// A packet whose target repo is the packet's own directory, so the sidecar
// lands at <dir>/.campaign-runtime/doctor-output.json.
function selfTargetPacketFixture() {
  const dir = tempDir();
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.target_repo = ".";
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  return { dir, packetPath, sidecarPath: join(dir, DOCTOR_SIDECAR_REL_PATH) };
}

function readSidecar(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("stampDoctorProducer puts generated_by beside generated_at and refuses an anonymous write", () => {
  const stamped = stampDoctorProducer({ schema_version: "v", generated_at: "t", ok: true, generated_by: "earlier" }, "later");
  assert.equal(stamped.generated_by, "later", "a re-persisted result carries the producer that persisted it now");
  assert.equal(Object.keys(stamped).filter((key) => key === "generated_by").length, 1, "one producer, not a history");
  const keys = Object.keys(stamped);
  assert.equal(keys.indexOf("generated_by"), keys.indexOf("generated_at") + 1, "generated_by sits directly beside generated_at");
  assert.deepEqual({ ...stamped, generated_by: undefined }, { schema_version: "v", generated_at: "t", ok: true, generated_by: undefined }, "nothing else moves");
  assert.throws(() => stampDoctorProducer({ ok: true }), /requires command/);
  assert.throws(() => stampDoctorProducer({ ok: true }, "  "), /requires command/);
  for (const bad of ["doc\ntor", "qa\u2028run", "qa\rrun", "Doctor", "--write", ""]) {
    assert.throws(() => stampDoctorProducer({ ok: true }, bad), /requires command|refuses producer name/, JSON.stringify(bad));
  }
  assert.throws(() => stampDoctorProducer(null, "doctor"), /doctor result object/);
  const dir = tempDir();
  const path = join(dir, DOCTOR_SIDECAR_REL_PATH);
  assert.throws(() => writeDoctorSidecar(path, { ok: true }, {}), /requires command/);
  assert.equal(existsSync(path), false, "a refused stamp writes nothing");
  rmSync(dir, { recursive: true, force: true });
});

test("doctor --write stamps the sidecar generated_by: doctor", () => {
  const { dir, packetPath, sidecarPath } = selfTargetPacketFixture();
  const result = doctorCommand({ write: true, packet: packetPath, _: ["doctor"] });
  const sidecar = readSidecar(sidecarPath);
  assert.equal(sidecar.generated_by, "doctor");
  assert.equal(sidecar.generated_at, result.generated_at, "the stamp sits on this run's snapshot");
  rmSync(dir, { recursive: true, force: true });
});

test("doctor without --write leaves a stamped sidecar exactly as it was", () => {
  const { dir, packetPath, sidecarPath } = selfTargetPacketFixture();
  mkdirSync(dirname(sidecarPath), { recursive: true });
  const retained = JSON.stringify({ ok: true, status: "ready", generated_at: "2026-09-15T00:00:00.000Z", generated_by: "doctor" });
  writeFileSync(sidecarPath, retained);
  doctorCommand({ packet: packetPath, _: ["doctor"] });
  assert.equal(readFileSync(sidecarPath, "utf8"), retained);
  rmSync(dir, { recursive: true, force: true });
});

test("next stamps generated_by: next, replacing the previous producer; --no-write writes nothing", () => {
  const { dir, packetPath, sidecarPath } = selfTargetPacketFixture();
  doctorCommand({ write: true, packet: packetPath, _: ["doctor"] });
  assert.equal(readSidecar(sidecarPath).generated_by, "doctor");

  nextStage(null, { packet: packetPath, _: [] });
  const afterNext = readSidecar(sidecarPath);
  assert.equal(afterNext.generated_by, "next");
  assert.equal(Object.keys(afterNext).filter((key) => key === "generated_by").length, 1);

  const bytes = readFileSync(sidecarPath, "utf8");
  nextStage(null, { packet: packetPath, _: [], "no-write": true });
  assert.equal(readFileSync(sidecarPath, "utf8"), bytes, "--no-write leaves the sidecar byte-identical");
  rmSync(dir, { recursive: true, force: true });
});

test("the QA stage refresh stamps generated_by: qa run", () => {
  const { dir, packetPath, sidecarPath } = selfTargetPacketFixture();
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), JSON.stringify({
    identity: { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug },
    stages: {},
  }));
  doctorCommand({ write: true, packet: packetPath, _: ["doctor"] });
  assert.equal(readSidecar(sidecarPath).generated_by, "doctor");

  const recorded = recordQaStageOutcome({ packet: packetPath }, {
    local_path: join(dir, "qa-output/verdict.json"),
    verdict: { run_id: "qa_0001", disposition: "ready", completed_at: "2026-09-17T00:00:00.000Z", assertions: [] },
  });
  assert.equal(recorded, true);
  assert.equal(readSidecar(sidecarPath).generated_by, "qa run");
  rmSync(dir, { recursive: true, force: true });
});

// The three intake commands share one body; only the modes that run doctor
// write the sidecar, and each writes its own name. A placeholder is seeded so
// presence alone cannot pass the prepare-build case.
test("start and build stamp their own names; prepare-build leaves a seeded sidecar byte-identical", () => {
  for (const [command, expected] of [["start", "start"], ["build", "build"], ["prepare-build", null]]) {
    const dir = tempDir();
    const target = join(dir, "target");
    cpSync(join(ROOT, "examples/target-page-kit"), target, { recursive: true });
    const sidecarPath = join(target, DOCTOR_SIDECAR_REL_PATH);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, "{\"placeholder\":true}\n");
    const run = spawnSync(process.execPath, [
      CLI, command, "--spec", SPEC, "--source", SOURCE, "--target", target, "--template-family", "olympus", "--no-run-session", "--json",
    ], { encoding: "utf8", cwd: dir, env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" } });
    // Exit 2 is doctor's own verdict on the example fixture, not a failure;
    // the intake completed and printed its JSON result.
    assert.notEqual(run.status, 1, `${command}: ${run.stderr}`);
    assert.ok(run.stdout.trim().startsWith("{"), `${command}: printed a JSON result`);
    if (expected === null) {
      assert.equal(readFileSync(sidecarPath, "utf8"), "{\"placeholder\":true}\n", `${command}: writes no sidecar`);
    } else {
      const sidecar = readSidecar(sidecarPath);
      assert.equal(sidecar.generated_by, expected, `${command}: generated_by`);
      assert.equal(sidecar.generated_at, JSON.parse(run.stdout).doctor.generated_at, `${command}: the stamp sits on this run's snapshot`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
