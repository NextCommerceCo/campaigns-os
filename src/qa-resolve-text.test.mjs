import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkpointGateLines, themeGateLines, __qaNodeTestHooks } from "./qa-node.mjs";

const { resolvePayload } = __qaNodeTestHooks;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin/campaigns-os.mjs");

// The checkpoint and theme-gate blocks of the `qa resolve` text report, as
// lines: assertable without a subprocess, and rendered by the one action rule
// doctor uses.
test("checkpointGateLines renders each gate, its waiver state and its actions with the packet substituted", () => {
  const gates = [{
    id: "page_kit.sdk_version",
    status: "blocked",
    code: "page_kit.sdk_version.mismatch",
    reason: "Target SDK version 0.4.38 does not match the CampaignSpec pin 0.4.18.",
    waiver: { waived_by: "ops@local", waived_at: "2026-09-14T00:00:00.000Z", reason: "known drift", expires_at: "2026-10-01T00:00:00.000Z", review_condition: "next release" },
    waiver_assessment: { inert_counts: { stale: 1, foreign: 0, malformed: 0, expired: 2 } },
    required_actions: [
      { id: "repair", kind: "edit", command: null, description: "Set the pin, then re-run doctor." },
      { id: "waive", kind: "command", command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version", description: "Waive it." },
    ],
  }, {
    id: "page_kit.store_profile",
    status: "pass",
    code: "page_kit.store_profile.pass",
    reason: "Store profile is complete.",
    waiver: null,
    waiver_assessment: { inert_counts: {} },
    required_actions: [],
  }];
  assert.deepEqual(checkpointGateLines(gates, "/w/my packet.json"), [
    "Checkpoint page_kit.sdk_version: blocked (page_kit.sdk_version.mismatch) — Target SDK version 0.4.38 does not match the CampaignSpec pin 0.4.18.",
    "  Waiver: ops@local at 2026-09-14T00:00:00.000Z — known drift",
    "  Expires: 2026-10-01T00:00:00.000Z",
    "  Review condition: next release",
    "  Inert waiver decisions: stale=1, foreign=0, malformed=0, expired=2",
    "  Required actions:",
    "    - Set the pin, then re-run doctor.",
    "    - campaigns-os checkpoint waive --packet '/w/my packet.json' --gate page_kit.sdk_version",
    "Checkpoint page_kit.store_profile: pass (page_kit.store_profile.pass) — Store profile is complete.",
    "  Inert waiver decisions: stale=0, foreign=0, malformed=0, expired=0",
  ]);
  // No packet (a --site run): the template is printed as published.
  assert.equal(checkpointGateLines(gates, null)[7], "    - campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version");
  assert.deepEqual(checkpointGateLines([], "/w/p.json"), []);
  assert.deepEqual(checkpointGateLines(undefined, "/w/p.json"), []);
});

test("themeGateLines prints the actions and the ephemeral-waiver hint only for a blocked gate", () => {
  const blocked = {
    status: "blocked",
    code: "theme_gate.starter_palette",
    reason: "The starter palette is still applied.",
    required_actions: [{ id: "generate", kind: "command", command: "campaigns-os theme generate --packet <packet>", description: "Generate the brand theme." }, { id: "manual", command: null, description: "Apply the brand tokens by hand." }],
  };
  assert.deepEqual(themeGateLines(blocked, "/w/p.json"), [
    "Theme gate: blocked (theme_gate.starter_palette) — The starter palette is still applied.",
    "Required actions:",
    "  - campaigns-os theme generate --packet /w/p.json",
    "  - Apply the brand tokens by hand.",
    'Or rerun with --theme-waive "<reason>" to record an ephemeral waiver for this run.',
  ]);
  // The gate bakes the packet in when it is evaluated; the same rule applied
  // here changes nothing for such a command, with or without a packet.
  const baked = { ...blocked, required_actions: [{ id: "waive", kind: "command", command: "campaigns-os theme waive --packet /w/p.json --reason \"<why>\"", description: "Waive." }] };
  assert.equal(themeGateLines(baked, "/w/p.json")[2], "  - campaigns-os theme waive --packet /w/p.json --reason \"<why>\"");
  assert.equal(themeGateLines(baked)[2], "  - campaigns-os theme waive --packet /w/p.json --reason \"<why>\"");
  assert.deepEqual(themeGateLines({ status: "pass", code: "theme_gate.pass", reason: "Brand theme applied." }), [
    "Theme gate: pass (theme_gate.pass) — Brand theme applied.",
  ]);
  assert.deepEqual(themeGateLines(null), []);
});

// A report evaluated somewhere other than the packet-inferred default: the
// printed remediation carries `--report <path>` exactly as doctor's does for
// the same gate, so the pasted `checkpoint waive` acts on the report QA read
// rather than on a default sidecar that may not exist.
test("the gate lines carry a non-default report into packet-scoped commands, like doctor", () => {
  const gates = [{
    id: "page_kit.sdk_version",
    status: "blocked",
    code: "page_kit.sdk_version.mismatch",
    reason: "Target SDK version 0.4.38 does not match the CampaignSpec pin 0.4.18.",
    waiver: null,
    waiver_assessment: { inert_counts: {} },
    required_actions: [
      { id: "repair", kind: "edit", command: null, description: "Set the pin, then re-run doctor." },
      { id: "waive", kind: "command", command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version", description: "Waive it." },
    ],
  }];
  const reportPath = "/w/reports/custom report.json";
  assert.equal(
    checkpointGateLines(gates, "/w/p.json", reportPath)[4],
    "    - campaigns-os checkpoint waive --packet /w/p.json --gate page_kit.sdk_version --report '/w/reports/custom report.json'",
  );
  // The manual step is not a command and gains nothing.
  assert.equal(checkpointGateLines(gates, "/w/p.json", reportPath)[3], "    - Set the pin, then re-run doctor.");
  // No report (the default sidecar) prints as before.
  assert.equal(
    checkpointGateLines(gates, "/w/p.json")[4],
    "    - campaigns-os checkpoint waive --packet /w/p.json --gate page_kit.sdk_version",
  );
  const blocked = {
    status: "blocked",
    code: "theme_gate.starter_palette",
    reason: "The starter palette is still applied.",
    required_actions: [{ id: "waive", kind: "command", command: "campaigns-os theme waive --packet /w/p.json --reason \"<why>\"", description: "Waive." }],
  };
  assert.equal(themeGateLines(blocked, "/w/p.json", reportPath)[2], "  - campaigns-os theme waive --packet /w/p.json --reason \"<why>\" --report '/w/reports/custom report.json'");
  assert.equal(themeGateLines(blocked, "/w/p.json")[2], "  - campaigns-os theme waive --packet /w/p.json --reason \"<why>\"");
});

// The resolve payload names the report only when it is not the target repo's
// default sidecar (doctor's `derived.assembly_report_path` rule), so a
// default-report campaign's JSON is unchanged and the text printer can read
// the path back from the same payload it prints.
test("resolvePayload carries report_path only for a non-default report", () => {
  const base = {
    mapId: "map_1",
    packetPath: "/w/campaign/campaign-runtime.build.json",
    targetRepo: "/w/campaign",
    specSource: "packet_local",
    specVersion: "42",
    specHash: "sha256:x",
    baseUrl: "https://example.test/",
    spec: { campaign: {} },
    topologies: [],
    checkpointGates: [],
    themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "No theme context.", required_actions: [] },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Not yet.", required_actions: [] },
  };
  assert.equal("report_path" in resolvePayload({ ...base, reportPath: "/w/campaign/.campaign-runtime/assembly-report.json" }), false);
  assert.equal("report_path" in resolvePayload({ ...base, reportPath: null }), false);
  assert.equal(resolvePayload({ ...base, reportPath: "/w/reports/custom.json" }).report_path, "/w/reports/custom.json");
  // An unknown target repo cannot rule the default out, so the report is named.
  assert.equal(resolvePayload({ ...base, targetRepo: null, reportPath: "/w/campaign/.campaign-runtime/assembly-report.json" }).report_path, "/w/campaign/.campaign-runtime/assembly-report.json");
});

// End to end: the shipped example tree with the target's SDK pin drifted from
// the spec blocks page_kit.sdk_version; `qa resolve --report <elsewhere>`
// prints the waiver command against that report, and without --report the
// text is what it always was.
test("qa resolve text prints the waiver command against the --report it evaluated", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-resolve-report-"));
  try {
    cpSync(join(ROOT, "examples"), join(dir, "examples"), { recursive: true });
    const campaignsPath = join(dir, "examples/target-page-kit/_data/campaigns.json");
    const campaigns = JSON.parse(readFileSync(campaignsPath, "utf8"));
    campaigns["runtime-packet-demo"].sdk_version = "0.4.17";
    writeFileSync(campaignsPath, `${JSON.stringify(campaigns, null, 2)}\n`);
    const packetPath = join(dir, "examples/build-packet.basic.json");
    const reportPath = join(dir, "reports/custom-report.json");
    const run = (extra) => {
      const result = spawnSync(process.execPath, [CLI, "qa", "resolve", "--packet", packetPath, ...extra], {
        encoding: "utf8",
        env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" },
      });
      return `${result.stdout}`;
    };
    const bound = run(["--report", reportPath]);
    assert.match(bound, /^Checkpoint page_kit\.sdk_version: blocked/m);
    assert.match(bound, new RegExp(`^    - campaigns-os checkpoint waive --packet ${packetPath} --gate page_kit\\.sdk_version .* --report ${reportPath}$`, "m"));
    const plain = run([]);
    assert.match(plain, new RegExp(`^    - campaigns-os checkpoint waive --packet ${packetPath} --gate page_kit\\.sdk_version .*"$`, "m"));
    assert.equal(plain.includes("--report"), false);
    const json = JSON.parse(run(["--report", reportPath, "--json"]));
    assert.equal(json.report_path, reportPath);
    assert.equal("report_path" in JSON.parse(run(["--json"])), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
