// The cause labels must survive every producer that persists the doctor
// artifact, not just the `doctor` command. Four call sites write
// .campaign-runtime/doctor-output.json from a doctorPacket result — `doctor`,
// `next`, prepare-build/start, and the QA stage refresh — so classification
// belongs at the shared boundary. Annotating only the command means running QA
// after doctor silently strips the labels back out of the retained artifact.

import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { doctorCommand, doctorPacket, recordQaStageOutcome } from "./cli.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(repoRoot, "contracts/fixtures/sidecar-bundle/production-shaped");
const MAP_ID = "runtime-packet-demo-k9x2";

function stagedPacket({ priorErrorCodes = [], priorWarningCodes = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-doctor-boundary-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const recordsDir = join(dir, ".campaign-runtime/run-records");
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(
    join(recordsDir, "run_1757000000000_aaaaaaaa.json"),
    `${JSON.stringify({
      schema_version: "campaigns-os-run-record/v0",
      run_id: "run_1757000000000_aaaaaaaa",
      identity: { map_id: MAP_ID },
      artifacts: [],
      observations: {
        doctor: { status: "blocked", error_codes: priorErrorCodes, warning_codes: priorWarningCodes, ready_count: 0 },
      },
    }, null, 2)}\n`,
  );
  return { dir, packetPath: join(dir, "campaign-runtime.build.json") };
}

function readDoctorArtifact(dir) {
  return JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
}

test("doctorPacket annotates its result at the shared boundary, before any writer sees it", () => {
  const { packetPath } = stagedPacket({ priorErrorCodes: ["source_html.root"] });
  const result = doctorPacket(packetPath);
  assert.ok(result.cause_summary, "doctorPacket result carries a cause summary");
  assert.equal(result.cause_summary.prior_run_id, "run_1757000000000_aaaaaaaa");
  assert.equal(result.cause_summary.comparison, "prior_run");
  for (const issue of [...result.errors, ...result.warnings]) {
    assert.ok(issue.cause, `doctor issue ${issue.code} carries a cause`);
    assert.ok(issue.cause_reason, `doctor issue ${issue.code} carries a cause reason`);
  }
  const carried = result.errors.find((issue) => issue.code === "source_html.root");
  assert.equal(carried.cause, "pre_existing");
});

test("the QA stage refresh keeps the labels on the retained doctor artifact", () => {
  const { dir, packetPath } = stagedPacket({ priorErrorCodes: ["source_html.root"] });

  // 1. doctor writes the artifact, labels and all.
  doctorCommand({ _: ["doctor"], packet: packetPath });
  const afterDoctor = readDoctorArtifact(dir);
  assert.ok(afterDoctor.cause_summary, "doctor wrote a cause summary");
  assert.ok(afterDoctor.errors.every((issue) => issue.cause), "doctor labelled every error");

  // 2. The QA stage update refreshes the same artifact from its own
  //    doctorPacket call. Before the classification moved to the shared
  //    boundary this write replaced the labelled artifact with an unlabelled
  //    one — running QA after doctor removed the answer from the file.
  const refreshed = recordQaStageOutcome({ packet: packetPath }, {
    verdict: {
      schema_version: "1.0",
      run_id: "qa_probe",
      disposition: "ready",
      completed_at: "2026-09-12T00:00:00.000Z",
      assertions: [],
      test_orders: [],
      exceptions: [],
    },
    local_path: join(dir, "qa-output/probe.json"),
  });
  assert.equal(refreshed, true, "the QA stage update ran against this packet");

  const afterQa = readDoctorArtifact(dir);
  assert.ok(afterQa.cause_summary, "the refreshed artifact still carries a cause summary");
  assert.equal(afterQa.cause_summary.prior_run_id, "run_1757000000000_aaaaaaaa");
  assert.ok(afterQa.errors.length, "the refreshed artifact still reports errors");
  for (const issue of [...afterQa.errors, ...afterQa.warnings]) {
    assert.ok(issue.cause, `refreshed doctor issue ${issue.code} still carries a cause`);
  }
  assert.equal(afterQa.errors.find((issue) => issue.code === "source_html.root").cause, "pre_existing");
});
