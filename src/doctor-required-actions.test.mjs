import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { doctorCommand, doctorRequiredActionLines, doctorTinyPromptLines, resultTextLines } from "./cli.mjs";

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
// Every doctor run here reads a staged copy of examples/: doctor writes its
// sidecar into the packet's target, and the checkout is not a scratch dir.
// The packet reaches its catalog at ../contracts/, so that file is staged
// beside the copy; without it doctor blocks on assembly.commerce_catalog.path.
function exampleFixture() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-required-actions-"));
  cpSync(join(ROOT, "examples"), join(dir, "examples"), { recursive: true });
  mkdirSync(join(dir, "contracts"));
  cpSync(join(ROOT, "contracts/commerce-surface-catalog.json"), join(dir, "contracts/commerce-surface-catalog.json"));
  return { dir, packetPath: join(dir, "examples/build-packet.basic.json") };
}

function sdkPinMismatchFixture(targetVersion) {
  const { dir, packetPath } = exampleFixture();
  const campaignsPath = join(dir, "examples/target-page-kit/_data/campaigns.json");
  const campaigns = JSON.parse(readFileSync(campaignsPath, "utf8"));
  campaigns["runtime-packet-demo"].sdk_version = targetVersion;
  writeFileSync(campaignsPath, `${JSON.stringify(campaigns, null, 2)}\n`);
  return { dir, packetPath };
}

test("text-mode doctor prints the remediation for a blocked checkpoint gate", () => {
  const { dir, packetPath } = sdkPinMismatchFixture("0.4.38");
  try {
    const text = runDoctorText(packetPath);
    // The blocker itself was always printed; the remediation was not.
    assert.match(text, /\[page_kit\.sdk_version\] Target SDK version 0\.4\.38 does not match/);
    assert.match(text, /^Required actions:$/m);
    // The target repair is the reconcile command, spelled with this run's packet.
    assert.match(text, /^- \[page_kit\.sdk_version\] campaigns-os page-kit sync --packet /m);
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

// The human doctor report is one walker of the result, returning lines; the
// printer prints exactly those lines and nothing else. Proved against the
// subprocess so the assertable interface and the operator's stdout cannot
// drift apart.
test("text-mode doctor stdout is exactly resultTextLines plus doctorTinyPromptLines", () => {
  const { dir, packetPath } = sdkPinMismatchFixture("0.4.38");
  try {
    const text = runDoctorText(packetPath);
    const result = doctorCommand({ packet: packetPath, "no-write": true });
    assert.equal(text, `${[...resultTextLines(result), ...doctorTinyPromptLines(result)].join("\n")}\n`);
    // The sections this fixture exercises, in order.
    const lines = resultTextLines(result);
    const at = (label) => lines.indexOf(label);
    assert.ok(at("Errors:") >= 0 && at("Required actions:") > at("Errors:") && at("Next:") > at("Required actions:"), lines.join("\n"));
    assert.equal(lines[0], "Status: BLOCKED");
    assert.deepEqual(doctorTinyPromptLines(result).slice(0, 2), ["", "Next expected proof: resolve the blockers above, then re-run doctor."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctorTinyPromptLines names the two proofs and nothing else", () => {
  assert.deepEqual(doctorTinyPromptLines({ status: "ready" }), [
    "",
    "Next expected proof: campaigns-os next to pick the next stage (setup/build), then polish, deploy, and QA.",
    'Found workflow friction here? campaigns-os findings add --stage doctor --kind friction --summary "..."',
  ]);
  assert.equal(doctorTinyPromptLines({ status: "blocked" }).length, 3);
});

test("text-mode doctor prints no required-actions block when every gate is clear", () => {
  const { dir, packetPath } = exampleFixture();
  try {
    const text = runDoctorText(packetPath);
    assert.match(text, /^Status: READY_WITH_WARNINGS$/m, text);
    assert.equal(/Required actions/.test(text), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("doctorRequiredActionLines inserts a packet path containing $ sequences literally", () => {
  // `$&` and `$$` are replacement patterns to String.prototype.replace with a
  // string replacement; the path must survive verbatim inside the quoting.
  const packetPath = "/srv/example/camp$&$$1/campaign-runtime.build.json";
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: packetPath,
      target_repo: "/srv/example/camp$&$$1",
      assembly_report_path: "/srv/example/camp$&$$1/.campaign-runtime/assembly-report.json",
      checkpoint_gates: [{
        id: "page_kit.sdk_version",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version" }],
      }],
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    `- [page_kit.sdk_version] campaigns-os checkpoint waive --packet '${packetPath}' --gate page_kit.sdk_version`,
  ]);
});

test("doctorRequiredActionLines reads the command template, not the substituted path, for --report", () => {
  // A packet directory literally named "...--report-review" must not be read
  // as an action that already declared --report.
  const packetPath = "/srv/example/campaign--report-review/campaign-runtime.build.json";
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: packetPath,
      target_repo: "/srv/example/campaign--report-review",
      assembly_report_path: "/srv/example/reports/custom-report.json",
      checkpoint_gates: [{
        id: "page_kit.sdk_version",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet>" }],
      }],
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    `- [page_kit.sdk_version] campaigns-os checkpoint waive --packet ${packetPath} --report /srv/example/reports/custom-report.json`,
  ]);
});

test("doctorRequiredActionLines matches --report as a whole token, not a prefix", () => {
  // An action whose only report-ish flag is --report-format has not declared
  // --report, so the inspected report is still appended.
  const packetPath = "/srv/example/campaign/campaign-runtime.build.json";
  const lines = doctorRequiredActionLines({
    derived: {
      packet_path: packetPath,
      target_repo: "/srv/example/campaign",
      assembly_report_path: "/srv/example/reports/custom-report.json",
      checkpoint_gates: [{
        id: "page_kit.sdk_version",
        required_actions: [{ id: "waive_checkpoint", command: "campaigns-os checkpoint waive --packet <packet> --report-format json" }],
      }],
    },
  });
  assert.deepEqual(lines, [
    "Required actions:",
    `- [page_kit.sdk_version] campaigns-os checkpoint waive --packet ${packetPath} --report-format json --report /srv/example/reports/custom-report.json`,
  ]);
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
