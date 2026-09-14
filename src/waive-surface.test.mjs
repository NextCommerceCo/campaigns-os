import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkpointWaive, doctorPacket, nextStage, nextTinyPromptLines, resultTextLines, themeWaive } from "./cli.mjs";
import { evaluateThemeGate, themeWaiverFrom } from "./theme-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin/campaigns-os.mjs");
const EXAMPLES = new URL("../examples/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// The shipped example tree with the target page-kit entry edited: an SDK pin
// that differs from the spec blocks page_kit.sdk_version; a store profile
// value edited to a demo storefront URL / phone, or to a plain mismatch,
// blocks page_kit.store_profile with the corresponding discrepancy kind.
function fixture({ specVersion = "0.4.36", targetVersion = "0.4.36", entry = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "waive-surface-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(new URL(file, EXAMPLES), join(dir, file));
  }
  cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
  cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  packet.deploy.preview_url = "https://preview.merchant-shop.com/runtime-packet-demo/";
  const targetRepo = join(dir, "target-page-kit");
  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  spec.runtime = { sdk_version: specVersion };
  delete spec.global_config.sdk_version;
  for (const funnel of spec.funnels || []) {
    for (const page of funnel.pages || []) delete page.sdk_hints;
  }
  writeJson(specPath, spec);

  const briefRelPath = "target-page-kit/.campaign-runtime/input/campaign-build-brief.normalized.json";
  packet.build_brief = { normalized_path: briefRelPath, status: "complete" };
  writeJson(packetPath, packet);
  writeJson(join(dir, briefRelPath), {
    schema_version: "campaigns-os-build-brief/v1",
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: { payment_methods_allowed: ["card"], hidden_payment_methods: [] },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });

  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  Object.assign(campaigns[packet.campaign.public_route_slug], { sdk_version: targetVersion, ...entry });
  writeJson(campaignsPath, campaigns);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.setup.status = "completed";
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  return { dir, packetPath, targetRepo, reportPath, specPath, campaignsPath };
}

function storeGate(result) {
  return result.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile");
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" },
  });
}

test("theme waive applies the checkpoint attribution rule: named human required, placeholders refused", () => {
  const { dir, packetPath, reportPath } = fixture();
  try {
    assert.throws(
      () => themeWaive({ _: ["theme", "waive"], packet: packetPath, reason: "starter palette accepted" }),
      /theme waive requires --waived-by with the named human who approved it; placeholders are not accepted/,
    );
    for (const placeholder of ["operator", "dogfood operator", "claude code", "ci"]) {
      assert.throws(
        () => themeWaive({ _: ["theme", "waive"], packet: packetPath, reason: "starter palette accepted", "waived-by": placeholder }),
        /placeholders are not accepted/,
        placeholder,
      );
    }
    assert.equal(readJson(reportPath).theme?.waiver ?? null, null, "a refused waive writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("theme waive names the report when it is not valid JSON", () => {
  const { dir, packetPath, reportPath } = fixture();
  try {
    writeFileSync(reportPath, "{ \"identity\": ");
    assert.throws(
      () => themeWaive({ _: ["theme", "waive"], packet: packetPath, reason: "starter palette accepted", "waived-by": "Jordan Lee" }),
      (error) => !(error instanceof SyntaxError)
        && error.message.startsWith(`Assembly Report at ${reportPath} is not valid JSON: `),
    );
    assert.equal(readFileSync(reportPath, "utf8"), "{ \"identity\": ", "a refused waive writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("theme waive records --expires-at, refuses a past expiry, and reports doctor's readiness", () => {
  const { dir, packetPath, reportPath } = fixture();
  try {
    assert.throws(
      () => themeWaive({ _: ["theme", "waive"], packet: packetPath, reason: "starter palette accepted", "waived-by": "Jordan Lee", "expires-at": "2020-01-01T00:00:00.000Z" }),
      /theme waive expires_at must be later than waived_at/,
    );
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const result = themeWaive({ _: ["theme", "waive"], packet: packetPath, reason: "starter palette accepted", "waived-by": "Jordan Lee", "expires-at": expiresAt });
    assert.equal(result.ok, true);
    assert.equal(result.gate, "theme_gate");
    assert.equal(result.waiver.waived_by, "Jordan Lee");
    assert.equal(result.waiver.expires_at, expiresAt);
    assert.equal(readJson(reportPath).theme.waiver.expires_at, expiresAt);
    assert.ok(["ready", "ready_with_warnings", "ready_with_waivers", "blocked"].includes(result.status), result.status);
    const lines = resultTextLines(result);
    assert.equal(lines[0], `Status: ${result.status.toUpperCase()}`);
    assert.equal(lines[1], `Waived: theme_gate by Jordan Lee until ${expiresAt}`);
    assert.equal(lines.some((line) => line === "Status: UNKNOWN"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired theme waiver no longer waives the gate", () => {
  const reportTheme = { status: "needs_review", waiver: { reason: "accepted", waived_by: "Jordan Lee", waived_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-02-01T00:00:00.000Z" } };
  const scope = { built_pages: [{ page_id: "checkout", type: "checkout" }] };
  assert.equal(themeWaiverFrom(reportTheme, null, { now: "2026-01-15T00:00:00.000Z" }).reason, "accepted");
  assert.equal(themeWaiverFrom(reportTheme, null, { now: "2026-02-01T00:00:00.000Z" }), null);
  assert.equal(evaluateThemeGate({ reportTheme, scope, now: "2026-01-15T00:00:00.000Z" }).status, "waived");
  const expired = evaluateThemeGate({ reportTheme, scope, now: "2026-03-01T00:00:00.000Z" });
  assert.equal(expired.status, "blocked");
  assert.ok(expired.required_actions.some((action) => action.id === "waive_theme" && action.command.includes("--waived-by \"<named human>\"")));
});

test("checkpoint waive prints a real status line and names what it waived", () => {
  const { dir, packetPath } = fixture({ specVersion: "0.4.36", targetVersion: "0.4.37" });
  try {
    const result = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional pin for compatibility testing",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    assert.equal(result.status, "ready_with_waivers");
    const lines = resultTextLines(result);
    assert.equal(lines[0], "Status: READY_WITH_WAIVERS");
    assert.equal(lines[1], "Waived: page_kit.sdk_version by Jordan Lee");
    assert.equal(doctorPacket(packetPath).status, "ready_with_waivers", "the status printed is doctor's verdict on the report just written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint waive refuses page_kit.store_profile while any field carries demo residue, naming the fields", () => {
  const { dir, packetPath, reportPath } = fixture({
    entry: { store_url: "https://demo.29next.com/", store_phone: "+1 (888) 831-6810", store_name: "Other Merchant" },
  });
  try {
    const gate = storeGate(doctorPacket(packetPath));
    assert.equal(gate.status, "blocked");
    assert.equal(gate.waivable, false);
    assert.equal(gate.required_actions.some((action) => action.id === "waive_checkpoint"), false, "doctor offers no waive command for residue");
    assert.match(gate.reason, /Starter demo residue in store_url, store_phone is not waivable/);
    assert.throws(
      () => checkpointWaive({
        _: ["checkpoint", "waive"],
        packet: packetPath,
        gate: "page_kit.store_profile",
        reason: "merchant URLs not yet supplied",
        "waived-by": "Jordan Lee",
        "review-condition": "when the merchant supplies its legal URLs",
      }),
      /cannot be waived: store_url, store_phone still carry starter demo residue .* _data\/campaigns\.json\[runtime-packet-demo\]/,
    );
    assert.equal(Array.isArray(readJson(reportPath).waivers) ? readJson(reportPath).waivers.length : 0, 0, "nothing recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const mismatchOnly = fixture({ entry: { store_url: "https://wrong-merchant.test/" } });
  try {
    assert.equal(storeGate(doctorPacket(mismatchOnly.packetPath)).waivable, true);
    const recorded = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: mismatchOnly.packetPath,
      gate: "page_kit.store_profile",
      reason: "spec URL is being corrected upstream",
      "waived-by": "Jordan Lee",
      "review-condition": "when the spec is re-exported",
    });
    assert.equal(recorded.status, "ready_with_waivers");
    assert.equal(storeGate(doctorPacket(mismatchOnly.packetPath)).status, "waived");
  } finally {
    rmSync(mismatchOnly.dir, { recursive: true, force: true });
  }
});

test("an unknown checkpoint gate is refused with the registered gate list", () => {
  const { dir, packetPath } = fixture();
  try {
    assert.throws(
      () => checkpointWaive({ _: ["checkpoint", "waive"], packet: packetPath, gate: "polish.evidence_missing", reason: "x", "waived-by": "Jordan Lee", "review-condition": "never" }),
      /Unknown checkpoint gate "polish\.evidence_missing"; registered gates: page_kit\.sdk_version, page_kit\.store_profile, built_output\.upsell_selector_scope, polish\.hidden_eager_media\./,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json refusals of both waive commands return an envelope on stdout with exit 1", () => {
  const { dir, packetPath } = fixture({ specVersion: "0.4.36", targetVersion: "0.4.37" });
  try {
    const unknown = runCli(["checkpoint", "waive", "--packet", packetPath, "--gate", "polish.evidence_missing", "--reason", "x", "--waived-by", "Jordan Lee", "--review-condition", "never", "--json"], dir);
    assert.equal(unknown.status, 1);
    const envelope = JSON.parse(unknown.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.gate, "polish.evidence_missing");
    assert.deepEqual(envelope.registered_gates, ["page_kit.sdk_version", "page_kit.store_profile", "built_output.upsell_selector_scope", "polish.hidden_eager_media"]);
    assert.match(envelope.error, /Unknown checkpoint gate/);
    assert.match(unknown.stderr, /campaigns-os: Unknown checkpoint gate/);

    const noGate = runCli(["checkpoint", "waive", "--packet", packetPath, "--reason", "x", "--waived-by", "Jordan Lee", "--review-condition", "never", "--json"], dir);
    assert.equal(noGate.status, 1);
    const noGateEnvelope = JSON.parse(noGate.stdout);
    assert.equal(noGateEnvelope.ok, false);
    assert.equal("gate" in noGateEnvelope, false, "no --gate given: the key is omitted, not null");
    assert.match(noGateEnvelope.error, /--gate/);
    assert.deepEqual(noGateEnvelope.registered_gates, ["page_kit.sdk_version", "page_kit.store_profile", "built_output.upsell_selector_scope", "polish.hidden_eager_media"]);

    const noBound = runCli(["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", "--reason", "x", "--waived-by", "Jordan Lee", "--json"], dir);
    assert.equal(noBound.status, 1);
    assert.match(JSON.parse(noBound.stdout).error, /requires at least one of expires_at or review_condition/);

    const theme = runCli(["theme", "waive", "--packet", packetPath, "--reason", "x", "--waived-by", "operator", "--json"], dir);
    assert.equal(theme.status, 1);
    const themeEnvelope = JSON.parse(theme.stdout);
    assert.equal(themeEnvelope.ok, false);
    assert.equal(themeEnvelope.gate, "theme_gate");
    assert.deepEqual(themeEnvelope.registered_gates, ["theme_gate"]);
    assert.match(themeEnvelope.error, /placeholders are not accepted/);

    // Text mode is unchanged: stderr line, empty stdout, exit 1.
    const text = runCli(["theme", "waive", "--packet", packetPath, "--reason", "x", "--waived-by", "operator"], dir);
    assert.equal(text.status, 1);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /campaigns-os: theme waive requires --waived-by/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("next files each blocked gate's actions under its own heading and prints them without the theme gate", () => {
  const checkpointActions = [
    { id: "checkpoint.page_kit.sdk_version.repair_target", kind: "edit", command: null, description: "Set sdk_version to 0.4.36, then re-run doctor." },
    { id: "checkpoint.page_kit.sdk_version.waive", kind: "command", command: "campaigns-os checkpoint waive --packet /w/p.json --gate page_kit.sdk_version --reason \"<reason>\" --waived-by \"<named human>\" --review-condition \"<re-evaluation trigger>\"", description: "Waive." },
    { id: "checkpoint.page_kit.store_profile.repair_target", kind: "edit", command: null, description: "Update the store profile, then re-run doctor." },
    { id: "doctor_recheck", kind: "command", command: "campaigns-os doctor --packet /w/p.json --json", description: "Re-run the doctor." },
  ];
  const gates = (themeStatus) => [
    { id: "doctor", status: "blocked" },
    { id: "page_kit.sdk_version", status: "blocked" },
    { id: "page_kit.store_profile", status: "blocked" },
    { id: "polish.hidden_eager_media", status: "not_applicable" },
    { id: "theme_gate", status: themeStatus },
  ];

  const withThemeBlocked = nextTinyPromptLines({ stage: "doctor-blocked", gates: gates("blocked"), next_actions: checkpointActions });
  assert.deepEqual(withThemeBlocked, [
    "",
    "Checkpoint gate page_kit.sdk_version is BLOCKING this stage. Resolve it with:",
    "  - Set sdk_version to 0.4.36, then re-run doctor.",
    "  - campaigns-os checkpoint waive --packet /w/p.json --gate page_kit.sdk_version --reason \"<reason>\" --waived-by \"<named human>\" --review-condition \"<re-evaluation trigger>\"",
    "",
    "Checkpoint gate page_kit.store_profile is BLOCKING this stage. Resolve it with:",
    "  - Update the store profile, then re-run doctor.",
    "",
    "Then:",
    "  - campaigns-os doctor --packet /w/p.json --json",
  ]);
  assert.equal(withThemeBlocked.some((line) => line.startsWith("Theme gate is BLOCKING")), false, "no theme action, no theme heading");

  const withThemeWaived = nextTinyPromptLines({ stage: "doctor-blocked", gates: gates("waived"), next_actions: checkpointActions });
  assert.deepEqual(withThemeWaived, withThemeBlocked, "checkpoint actions print whether or not the theme gate is blocked");

  // A blocked theme gate still owns its own actions, under its own heading.
  const themeActions = [
    { id: "theme_gate.theme_generate", kind: "command", command: "campaigns-os theme generate --packet /w/p.json", description: "Generate." },
    { id: "recheck", kind: "command", command: "campaigns-os next --packet /w/p.json --json", description: "Re-run next." },
  ];
  assert.deepEqual(nextTinyPromptLines({ stage: "polish", gates: [{ id: "theme_gate", status: "blocked" }], next_actions: themeActions }), [
    "",
    "Theme gate is BLOCKING this stage. Resolve it with:",
    "  - campaigns-os theme generate --packet /w/p.json",
    "",
    "Then:",
    "  - campaigns-os next --packet /w/p.json --json",
  ]);

  // The doctor gate has its own heading and is never labelled a checkpoint;
  // with nothing claiming it (today's case) it prints no heading at all.
  const doctorOnly = nextTinyPromptLines({ stage: "doctor-blocked", gates: [{ id: "doctor", status: "blocked" }, { id: "theme_gate", status: "pass" }], next_actions: [{ id: "doctor_recheck", kind: "command", command: "campaigns-os doctor --packet /w/p.json --json", description: "Re-run the doctor." }] });
  assert.deepEqual(doctorOnly, ["", "This stage is BLOCKED. Resolve it with:", "  - campaigns-os doctor --packet /w/p.json --json"]);
  assert.equal(doctorOnly.some((line) => line.includes("Checkpoint gate doctor")), false);

  // Nothing blocked: nothing printed, as before.
  assert.deepEqual(nextTinyPromptLines({ stage: "setup", gates: [{ id: "theme_gate", status: "pass" }], next_actions: [{ id: "run_setup", kind: "manual", command: null, description: "Scaffold." }] }), []);
});

test("next --json substitutes the packet into the gate objects it copies from doctor", () => {
  const { dir, packetPath } = fixture({ specVersion: "0.4.36", targetVersion: "0.4.37", entry: { store_url: "https://wrong-merchant.test/" } });
  try {
    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.stage, "doctor-blocked");
    const serialized = JSON.stringify(next);
    assert.equal(serialized.includes("--packet <packet>"), false, serialized.slice(0, 400));
    const gate = next.gates.find((entry) => entry.id === "page_kit.sdk_version");
    const waive = gate.required_actions.find((action) => action.id === "waive_checkpoint");
    assert.ok(waive.command.includes(`--packet ${packetPath}`), waive.command);
    const issue = next.errors.find((entry) => entry.code === "page_kit.store_profile");
    assert.ok(issue.detail.checkpoint_gate.required_actions.find((action) => action.id === "waive_checkpoint").command.includes(`--packet ${packetPath}`));
    // Doctor's own result keeps the template: the substitution is on a copy.
    const doctor = doctorPacket(packetPath);
    assert.ok(doctor.derived.checkpoint_gates.find((entry) => entry.id === "page_kit.sdk_version").required_actions.some((action) => String(action.command).includes("--packet <packet>")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
