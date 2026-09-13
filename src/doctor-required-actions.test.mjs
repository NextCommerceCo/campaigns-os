import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { doctorRequiredActionLines } from "./cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin/campaigns-os.mjs");

function runDoctorText(packetPath) {
  try {
    return execFileSync(process.execPath, [CLI, "doctor", "--packet", packetPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A blocked doctor exits 2; the human report is still on stdout and is
    // exactly what this test reads.
    return `${error.stdout || ""}`;
  }
}

// The fixture is the shipped example tree with one field changed: the target
// page-kit pins a newer SDK than the CampaignSpec, which is the drift the
// starter families produce whenever a spec keeps an older pin. It blocks
// page_kit.sdk_version and therefore carries required_actions[].
function sdkPinMismatchFixture(targetVersion) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-required-actions-"));
  cpSync(join(ROOT, "examples"), join(dir, "examples"), { recursive: true });
  const campaignsPath = join(dir, "examples/target-page-kit/_data/campaigns.json");
  const campaigns = JSON.parse(readFileSync(campaignsPath, "utf8"));
  campaigns["runtime-packet-demo"].sdk_version = targetVersion;
  writeFileSync(campaignsPath, `${JSON.stringify(campaigns, null, 2)}\n`);
  return { dir, packetPath: join(dir, "examples/build-packet.basic.json") };
}

test("text-mode doctor prints the remediation for a blocked checkpoint gate", () => {
  const { dir, packetPath } = sdkPinMismatchFixture("0.4.38");
  try {
    const text = runDoctorText(packetPath);
    // The blocker itself was always printed; the remediation was not.
    assert.match(text, /\[page_kit\.sdk_version\] Target SDK version 0\.4\.38 does not match/);
    assert.match(text, /^Required actions:$/m);
    assert.match(text, /^- \[page_kit\.sdk_version\] Set _data\/campaigns\.json\[runtime-packet-demo\]\.sdk_version to /m);
    assert.match(text, /^- \[page_kit\.sdk_version\] campaigns-os checkpoint waive --packet /m);
    // The printed waiver command names this run's packet, not the placeholder.
    assert.equal(text.includes("--packet <packet>"), false);
    // Remediation reads under the findings, above the stage picker.
    assert.ok(text.indexOf("Required actions:") > text.indexOf("Errors:"));
    assert.ok(text.indexOf("Required actions:") < text.indexOf("\nNext:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("text-mode doctor prints no required-actions block when every gate is clear", () => {
  const text = runDoctorText(join(ROOT, "examples/build-packet.basic.json"));
  assert.equal(/Required actions/.test(text), false);
});

test("doctorRequiredActionLines renders nothing for an empty or absent gate set", () => {
  assert.deepEqual(doctorRequiredActionLines({}), []);
  assert.deepEqual(doctorRequiredActionLines({ derived: { checkpoint_gates: [] } }), []);
  assert.deepEqual(
    doctorRequiredActionLines({ derived: { checkpoint_gates: [{ id: "g", required_actions: [] }] } }),
    [],
  );
});

test("doctorRequiredActionLines substitutes the packet and falls back to the description", () => {
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: "/srv/example/campaign/campaign-runtime.build.json",
      checkpoint_gates: [{
        id: "page_kit.sdk_version",
        required_actions: [
          { id: "repair_target", kind: "manual", command: null, description: "Repair the target pin." },
          { id: "waive_checkpoint", kind: "command", command: 'campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version' },
        ],
      }],
      polish_checkpoint_gate: {
        id: "polish.hidden_eager_media",
        required_actions: [{ id: "run_polish", kind: "skill", command: "next-campaigns-polish", description: "Run Polish." }],
      },
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    "- [page_kit.sdk_version] Repair the target pin.",
    "- [page_kit.sdk_version] campaigns-os checkpoint waive --packet /srv/example/campaign/campaign-runtime.build.json --gate page_kit.sdk_version",
    "- [polish.hidden_eager_media] next-campaigns-polish",
  ]);
});

test("doctorRequiredActionLines carries a non-default inspected report into packet-scoped commands", () => {
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: "/srv/example/campaign/campaign-runtime.build.json",
      target_repo: "/srv/example/campaign",
      // Not the packet-inferred default, so `checkpoint waive` / `polish
      // capture` would resolve a different report than the one inspected.
      assembly_report_path: "/srv/example/reports/custom-report.json",
      checkpoint_gates: [{
        id: "page_kit.sdk_version",
        required_actions: [
          { id: "repair_target", command: null, description: "Repair the target pin." },
          { id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version" },
        ],
      }],
      polish_checkpoint_gate: {
        id: "polish.hidden_eager_media",
        required_actions: [
          { id: "capture", command: "campaigns-os polish capture --packet <packet> --base-url <url>" },
          { id: "run_polish", command: "next-campaigns-polish", description: "Run Polish." },
        ],
      },
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    // No --packet, so no report sidecar to carry.
    "- [page_kit.sdk_version] Repair the target pin.",
    "- [page_kit.sdk_version] campaigns-os checkpoint waive --packet /srv/example/campaign/campaign-runtime.build.json --gate page_kit.sdk_version --report /srv/example/reports/custom-report.json",
    "- [polish.hidden_eager_media] campaigns-os polish capture --packet /srv/example/campaign/campaign-runtime.build.json --base-url <url> --report /srv/example/reports/custom-report.json",
    // A skill name is not a packet-scoped command.
    "- [polish.hidden_eager_media] next-campaigns-polish",
  ]);
});

test("doctorRequiredActionLines omits the report arg when the inspected report is the inferred default", () => {
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: "/srv/example/campaign/campaign-runtime.build.json",
      target_repo: "/srv/example/campaign",
      assembly_report_path: "/srv/example/campaign/.campaign-runtime/assembly-report.json",
      checkpoint_gates: [{
        id: "page_kit.sdk_version",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet>" }],
      }],
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    "- [page_kit.sdk_version] campaigns-os checkpoint waive --packet /srv/example/campaign/campaign-runtime.build.json",
  ]);
});

test("doctorRequiredActionLines carries the report when the target repo is unknown", () => {
  // target_repo unresolved: the inferred default cannot be computed, so the
  // inspected report is named rather than assumed.
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: "/srv/example/campaign/campaign-runtime.build.json",
      target_repo: null,
      assembly_report_path: "/srv/example/campaign/.campaign-runtime/assembly-report.json",
      checkpoint_gates: [{
        id: "page_kit.store_profile",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet>" }],
      }],
    },
  });
  assert.match(lines[1], / --report \/srv\/example\/campaign\/\.campaign-runtime\/assembly-report\.json$/);
});

test("doctorRequiredActionLines never appends a second --report to a command that names one", () => {
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: "/srv/example/campaign/campaign-runtime.build.json",
      target_repo: "/srv/example/campaign",
      assembly_report_path: "/srv/example/reports/custom-report.json",
      checkpoint_gates: [{
        id: "page_kit.store_profile",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet> --report /srv/example/reports/custom-report.json" }],
      }],
    },
  });
  assert.equal(lines.filter((line) => line.includes("--report")).length, 1);
  assert.equal(lines[1].match(/--report/g).length, 1);
});

test("doctorRequiredActionLines keeps the placeholder when the report carries no packet path", () => {
  const lines = doctorRequiredActionLines({
    derived: {
      checkpoint_gates: [{
        id: "page_kit.store_profile",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet>" }],
      }],
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    "- [page_kit.store_profile] campaigns-os checkpoint waive --packet <packet>",
  ]);
});

test("doctorRequiredActionLines skips actions that carry neither a command nor a description", () => {
  assert.deepEqual(
    doctorRequiredActionLines({ derived: { checkpoint_gates: [{ id: "g", required_actions: [{ id: "x" }] }] } }),
    [],
  );
});
