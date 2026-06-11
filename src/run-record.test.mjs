import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  assembleRunRecord,
  mintRunId,
  resolveRunRecordPath,
  RUN_RECORD_SCHEMA,
  selectRunFindingIds,
  validateRunRecord,
  writeRunRecord,
} from "./run-record.mjs";
import { readLifecycleJournal } from "./lifecycle.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-run-record-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function minimalRecord(overrides = {}) {
  return {
    schema_version: RUN_RECORD_SCHEMA,
    run_id: "run_1700000000000_abcd1234",
    package_version: "0.1.0-alpha.0",
    command: "run-record",
    argv_shape: ["--packet", "--write"],
    created_at: "2026-06-07T00:00:00.000Z",
    consent_state: "off",
    consent_source: "default",
    remit_attempted: false,
    remit_state: "skipped",
    remit_ok: null,
    remit_error: null,
    remit_endpoint: null,
    ...overrides,
  };
}

test("validator accepts a minimal valid record", () => {
  const result = validateRunRecord(minimalRecord());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validator accepts a fully-populated record", () => {
  const record = minimalRecord({
    consent_state: "on",
    consent_source: "env",
    remit_attempted: true,
    remit_state: "ok",
    remit_ok: true,
    remit_endpoint: "/api/runs",
    identity: {
      map_id: "veyra-v1-knp4",
      campaign_slug: "veyra",
      template_family: "olympus",
      entry_point_shape: "packet",
    },
    artifacts: [
      { kind: "build_packet", path: "./campaign-runtime.build.json", schema_version: "campaign-runtime-build-packet/v0", sha256: "deadbeef" },
      { kind: "findings_journal", path: ".campaign-runtime/workflow-findings.jsonl", schema_version: "campaigns-os-workflow-finding/v0", sha256: null },
    ],
    observations: {
      doctor: { status: "ready_with_warnings", error_codes: [], warning_codes: ["adapter.contract"], ready_count: 5 },
      spec_validation_rule_ids: ["StoreProfileRequired"],
      adapter_decisions: { source_asset_strategy: "pagekit_campaign_asset_root" },
      qa: { disposition: "ready", gap_classes: ["funnel-flow"] },
      finding_ids: ["wf_1_aaaa", "wf_2_bbbb"],
    },
    surfaces: ["template", "cli"],
    primary_surface: "template",
    surface_confidence: "low",
    agent_usage: {
      total_tokens: 1234,
      elapsed_ms: 5000,
      model: "test-model",
      source: "fixture",
    },
  });
  const result = validateRunRecord(record);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validator rejects missing core fields", () => {
  const result = validateRunRecord({ schema_version: RUN_RECORD_SCHEMA });
  assert.equal(result.ok, false);
  const codes = result.errors.map((error) => error.code);
  assert.ok(codes.includes("record.run_id"));
  assert.ok(codes.includes("record.package_version"));
  assert.ok(codes.includes("record.command"));
  assert.ok(codes.includes("record.created_at"));
  assert.ok(codes.includes("record.argv_shape"));
  assert.ok(codes.includes("record.consent_state"));
  assert.ok(codes.includes("record.remit_attempted"));
});

test("validator rejects a bad schema_version", () => {
  const result = validateRunRecord(minimalRecord({ schema_version: "campaigns-os-run-record/v9" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "record.schema_version"));
});

test("validator rejects a non-object record", () => {
  assert.equal(validateRunRecord(null).ok, false);
  assert.equal(validateRunRecord([]).ok, false);
  assert.equal(validateRunRecord("nope").ok, false);
});

test("validator requires consent_state to be on|off and fails closed on anything else", () => {
  assert.equal(validateRunRecord(minimalRecord({ consent_state: "maybe" })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ consent_state: undefined })).ok, false);
});

test("validator rejects unknown surfaces and artifact kinds", () => {
  assert.equal(validateRunRecord(minimalRecord({ surfaces: ["template", "moon"] })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ primary_surface: "moon" })).ok, false);
  const badKind = validateRunRecord(minimalRecord({ artifacts: [{ kind: "mystery", path: "x" }] }));
  assert.equal(badKind.ok, false);
  const noPath = validateRunRecord(minimalRecord({ artifacts: [{ kind: "build_packet" }] }));
  assert.equal(noPath.ok, false);
});

test("validator rejects malformed observation arrays", () => {
  assert.equal(validateRunRecord(minimalRecord({ observations: { finding_ids: "wf_1" } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ observations: { spec_validation_rule_ids: [1, 2] } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ observations: { qa: { gap_classes: "funnel-flow" } } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ observations: { findings_journal: { malformed_lines: ["1"] } } })).ok, false);
});

test("validator rejects malformed agent usage fields", () => {
  assert.equal(validateRunRecord(minimalRecord({ agent_usage: "nope" })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ agent_usage: { total_tokens: -1 } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ agent_usage: { elapsed_ms: 1.5 } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ agent_usage: { model: 7 } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ agent_usage: { total_tokens: 12, elapsed_ms: 50 } })).ok, true);
});

test("validator rejects invalid remit status fields", () => {
  assert.equal(validateRunRecord(minimalRecord({ remit_state: "maybe" })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ remit_endpoint: "api/runs" })).ok, false);
});

test("the published JSON Schema doc and the validator agree on the schema_version const", () => {
  const schema = JSON.parse(readFileSync(resolve(ROOT, "schemas/campaigns-os-run-record.v0.schema.json"), "utf8"));
  assert.equal(schema.properties.schema_version.const, RUN_RECORD_SCHEMA);
  for (const field of ["schema_version", "run_id", "package_version", "command", "argv_shape", "created_at", "consent_state", "remit_attempted"]) {
    assert.ok(schema.required.includes(field), `schema.required should include ${field}`);
  }
});

// --- T2: capture ----------------------------------------------------------

const FIXED_NOW = new Date("2026-06-07T00:00:00.000Z");

function assembleArgs(overrides = {}) {
  return {
    runId: "run_1_test",
    packageVersion: "0.1.0-alpha.0",
    command: "run-record",
    argvShape: ["--packet"],
    now: FIXED_NOW,
    ...overrides,
  };
}

test("mintRunId is correctly shaped and unique per call", () => {
  const a = mintRunId(FIXED_NOW);
  const b = mintRunId(FIXED_NOW);
  assert.match(a, /^run_\d+_[0-9a-f]+$/);
  assert.notEqual(a, b); // random suffix differs even at the same instant
});

test("resolveRunRecordPath nests under .campaign-runtime/run-records and sanitizes the id", () => {
  assert.equal(
    resolveRunRecordPath("run_1_abc", "/tmp/repo"),
    resolve("/tmp/repo/.campaign-runtime/run-records/run_1_abc.json"),
  );
  // path traversal characters are scrubbed, never honored
  assert.equal(
    resolveRunRecordPath("../../etc/passwd", "/tmp/repo"),
    resolve("/tmp/repo/.campaign-runtime/run-records/______etc_passwd.json"),
  );
});

test("assembleRunRecord with doctor + report + verdict populates observation arrays", () => {
  const record = assembleRunRecord(assembleArgs({
    doctor: {
      status: "ready_with_warnings",
      errors: [],
      warnings: [
        { code: "adapter.contract", message: "x" },
        { code: "spec.validation", message: "y", detail: { ruleId: "StoreProfileRequired", path: "/store" } },
      ],
      ready: ["a", "b", "c"],
    },
    report: {
      adapter_decisions: {
        source_asset_strategy: "external_cdn",
        route_rewrite_policy: "raw_passthrough",
        wrapper_policy: "strip_document_wrappers",
        frontmatter_policy: "pagekit_yaml_frontmatter",
        script_style_reference_policy: "frontmatter_or_campaign_asset",
        cta_rewrite_policy: "campaignspec_routes_via_campaign_link",
        layout_choice: "campaign_layout",
        template_files_copied: { status: "complete" },
      },
    },
    qaVerdict: {
      disposition: "ready_with_exceptions",
      exceptions: [
        { family: "funnel-flow", status: "warn" },
        { family: "meta-tags", status: "fail" },
        { family: "funnel-flow", status: "fail" },
      ],
    },
    journal: { findings: [{ id: "wf_a", run_id: "run_1_test" }, { id: "wf_b", run_id: "other" }] },
  }));

  assert.equal(validateRunRecord(record).ok, true, JSON.stringify(validateRunRecord(record).errors));
  assert.deepEqual(record.observations.doctor.warning_codes, ["adapter.contract", "spec.validation"]);
  assert.equal(record.observations.doctor.ready_count, 3);
  assert.deepEqual(record.observations.spec_validation_rule_ids, ["StoreProfileRequired"]);
  assert.equal(record.observations.adapter_decisions.source_asset_strategy, "external_cdn");
  assert.equal(record.observations.adapter_decisions.wrapper_policy, "strip_document_wrappers");
  assert.equal(record.observations.adapter_decisions.frontmatter_policy, "pagekit_yaml_frontmatter");
  assert.equal(record.observations.adapter_decisions.script_style_reference_policy, "frontmatter_or_campaign_asset");
  assert.equal(record.observations.adapter_decisions.cta_rewrite_policy, "campaignspec_routes_via_campaign_link");
  assert.equal(record.observations.adapter_decisions.layout_choice, "campaign_layout");
  assert.equal(record.observations.adapter_decisions.template_files_copied_status, "complete");
  assert.equal(record.observations.qa.disposition, "ready_with_exceptions");
  assert.deepEqual(record.observations.qa.gap_classes, ["funnel-flow", "meta-tags"]); // distinct families
  assert.deepEqual(record.observations.finding_ids, ["wf_a"]); // exact: only this run's findings
});

test("assembleRunRecord with all signal absent is still a minimal valid record", () => {
  const record = assembleRunRecord(assembleArgs());
  assert.equal(validateRunRecord(record).ok, true, JSON.stringify(validateRunRecord(record).errors));
  assert.equal(record.observations.doctor, undefined); // no doctor => no claim
  assert.equal(record.observations.qa, undefined);
  assert.equal(record.observations.adapter_decisions, undefined);
  assert.deepEqual(record.observations.finding_ids, []); // always exact, empty here
  assert.equal(record.consent_state, "off"); // defaults safe
  assert.equal(record.remit_attempted, false);
  assert.equal(record.remit_state, "skipped");
});

test("assembleRunRecord carries an explicit pending remit sentinel", () => {
  const record = assembleRunRecord(assembleArgs({
    consent: { state: "on", source: "env" },
    remit: { state: "pending", attempted: false, ok: null, error: null, endpoint: null },
  }));
  assert.equal(record.remit_state, "pending");
  assert.equal(record.remit_attempted, false);
  assert.equal(record.remit_ok, null);
  assert.equal(validateRunRecord(record).ok, true, JSON.stringify(validateRunRecord(record).errors));
});

test("assembleRunRecord tolerates partial identity (missing fields -> null)", () => {
  const record = assembleRunRecord(assembleArgs({ identity: { map_id: "m1", entry_point_shape: "map-id" } }));
  assert.equal(validateRunRecord(record).ok, true);
  assert.equal(record.identity.map_id, "m1");
  assert.equal(record.identity.campaign_slug, null);
  assert.equal(record.identity.template_family, null);
  assert.equal(record.identity.entry_point_shape, "map-id");
});

test("selectRunFindingIds matches on exact run_id, never timestamps", () => {
  const journal = { findings: [
    { id: "wf_1", run_id: "R" },
    { id: "wf_2", run_id: "R" },
    { id: "wf_3", run_id: "OTHER" },
    { id: "wf_4" }, // legacy finding, no run_id
    { run_id: "R" }, // no id, ignored
  ] };
  assert.deepEqual(selectRunFindingIds(journal, "R"), ["wf_1", "wf_2"]);
  assert.deepEqual(selectRunFindingIds({ findings: [] }, "R"), []); // empty journal
  assert.deepEqual(selectRunFindingIds(null, "R"), []);
});

test("assembleRunRecord marks malformed findings journal lines so snapshots are visibly incomplete", () => {
  const record = assembleRunRecord(assembleArgs({
    journal: {
      findings: [{ id: "wf_a", run_id: "run_1_test" }],
      malformed: [{ line: 2, raw: "{bad", error: "Unexpected token" }],
    },
  }));
  assert.deepEqual(record.observations.finding_ids, ["wf_a"]);
  assert.deepEqual(record.observations.findings_journal, {
    malformed_count: 1,
    malformed_lines: [2],
  });
  assert.equal(validateRunRecord(record).ok, true, JSON.stringify(validateRunRecord(record).errors));
});

test("writeRunRecord writes a valid record to the canonical path and round-trips", () => {
  withTempDir((dir) => {
    const record = assembleRunRecord(assembleArgs({ runId: "run_42_zz" }));
    const path = writeRunRecord(record, { baseDir: dir });
    assert.equal(path, resolveRunRecordPath("run_42_zz", dir));
    assert.ok(existsSync(path));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(validateRunRecord(onDisk).ok, true);
    assert.equal(onDisk.run_id, "run_42_zz");
  });
});

test("writeRunRecord refuses to write an invalid record", () => {
  withTempDir((dir) => {
    const bad = assembleRunRecord(assembleArgs());
    delete bad.run_id;
    assert.throws(() => writeRunRecord(bad, { baseDir: dir }), /failed validation/);
  });
});

test("CLI: run-record assembles a valid record from a real packet (argv shape, no values)", () => {
  // Dry run against the in-repo example packet — exercises the full wiring
  // (doctor read, artifact refs, assembly) without writing into the repo.
  // Consent resolution is isolated from the operator's machine (empty
  // XDG_CONFIG_HOME, env override cleared) so the asserted default-OFF state
  // holds even on a machine that opted into telemetry.
  const isolatedConfigHome = mkdtempSync(join(tmpdir(), "campaigns-os-consent-isolation-"));
  let out;
  try {
    out = JSON.parse(execFileSync("node", [
      CLI, "run-record",
      "--packet", resolve(ROOT, "examples/build-packet.basic.json"),
      "--no-write", "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: isolatedConfigHome, CAMPAIGNS_OS_TELEMETRY: "" },
    }));
  } finally {
    rmSync(isolatedConfigHome, { recursive: true, force: true });
  }

  assert.equal(out.ok, true);
  assert.equal(out.written, false);
  assert.equal(out.record_path, null);
  const record = out.record;
  assert.equal(validateRunRecord(record).ok, true, JSON.stringify(validateRunRecord(record).errors));
  assert.equal(record.identity.template_family, "olympus");
  assert.equal(record.identity.entry_point_shape, "packet");
  assert.ok(record.artifacts.some((ref) => ref.kind === "build_packet"));
  // argv_shape carries flag NAMES only — never the packet path value.
  assert.ok(record.argv_shape.includes("--packet"));
  assert.ok(!record.argv_shape.some((flag) => flag.includes("build-packet.basic.json")));
  assert.equal(record.argv_shape.includes("--no-write"), false);
  // capture is always local; consent defaults OFF (safe) in v0 wiring.
  assert.equal(record.consent_state, "off");
});

test("CLI: run-record infers the latest local QA verdict and records optional agent usage", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const packet = JSON.parse(readFileSync(packetPath, "utf8"));
    const targetRepo = join(dir, packet.assembly.target_repo);
    const verdictDir = join(targetRepo, "qa-output", packet.spec.map_id);
    mkdirSync(verdictDir, { recursive: true });
    writeFileSync(join(verdictDir, "qa_run_latest.json"), JSON.stringify({
      schema_version: "1.0",
      run_id: "qa_run_latest",
      campaign_slug: packet.spec.map_id,
      completed_at: "2026-06-08T00:00:00.000Z",
      disposition: "ready_with_exceptions",
      assertions: [{ id: "browser-primary-cta:presell", family: "browser-runtime", status: "fail", severity: "warn", url: "https://preview.example/runtime-packet-demo/" }],
      exceptions: [{ id: "browser-primary-cta:presell", family: "browser-runtime", status: "fail", severity: "warn" }],
    }, null, 2));

    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record",
      "--packet", packetPath,
      "--run-id", "run_auto_qa",
      "--agent-total-tokens", "9876",
      "--agent-elapsed-ms", "123456",
      "--agent-model", "gpt-test",
      "--agent-usage-source", "fixture",
      "--no-write", "--json",
    ], { encoding: "utf8" }));

    const qaRef = out.record.artifacts.find((ref) => ref.kind === "qa_verdict");
    assert.ok(qaRef);
    assert.match(qaRef.path, /qa-output\/runtime-packet-demo-k9x2\/qa_run_latest\.json$/);
    assert.equal(out.record.observations.qa.disposition, "ready_with_exceptions");
    assert.deepEqual(out.record.observations.qa.gap_classes, ["browser-runtime"]);
    assert.deepEqual(out.record.agent_usage, {
      total_tokens: 9876,
      elapsed_ms: 123456,
      model: "gpt-test",
      source: "fixture",
    });
  });
});

test("CLI: run-record writes the manifest to .campaign-runtime/run-records by default", () => {
  withTempDir((dir) => {
    // Copy the packet into the tmp dir so the record (baseDir = packet dir)
    // is written under tmp and cleaned up — never into the repo.
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);

    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record",
      "--packet", packetPath,
      "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_cli_test",
      "--json",
    ], { encoding: "utf8" }));

    assert.equal(out.written, true);
    const expected = resolveRunRecordPath("run_cli_test", dir);
    assert.equal(out.record_path, expected);
    assert.ok(existsSync(expected));
    const onDisk = JSON.parse(readFileSync(expected, "utf8"));
    assert.equal(validateRunRecord(onDisk).ok, true);
    assert.equal(onDisk.run_id, "run_cli_test");
  });
});

test("CLI: run-record rejects invalid surfaces before writing or remitting", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const env = { ...process.env, XDG_CONFIG_HOME: dir, CAMPAIGNS_OS_TELEMETRY: "on" };
    let stderr = "";
    try {
      execFileSync("node", [
        CLI, "run-record",
        "--packet", packetPath,
        "--run-id", "run_bad_surface",
        "--surfaces", "bad",
        "--proxy-base", "http://127.0.0.1:1",
        "--json",
      ], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
      assert.fail("expected run-record to reject invalid surfaces");
    } catch (error) {
      stderr = String(error.stderr || "");
    }
    assert.match(stderr, /record\.surfaces/);
    assert.equal(existsSync(resolveRunRecordPath("run_bad_surface", dir)), false);
  });
});

test("CLI: artifact refs outside the run root use safe labels instead of ../ paths", () => {
  const externalDir = mkdtempSync(join(tmpdir(), "campaigns-os-run-record-external-"));
  try {
    withTempDir((dir) => {
      const packetPath = join(dir, "campaign-runtime.build.json");
      const verdictPath = join(externalDir, "qa-verdict.json");
      cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
      writeFileSync(verdictPath, JSON.stringify({ schema_version: "campaigns-os-qa-verdict/v0", disposition: "ready", exceptions: [] }));

      const out = JSON.parse(execFileSync("node", [
        CLI, "run-record",
        "--packet", packetPath,
        "--qa-verdict", verdictPath,
        "--run-id", "run_external_ref",
        "--proxy-base", "https://proxy.test",
        "--no-remit",
        "--json",
      ], { encoding: "utf8" }));

      const qaRef = out.record.artifacts.find((ref) => ref.kind === "qa_verdict");
      assert.equal(qaRef.path, "external:qa_verdict");
      assert.ok(qaRef.sha256);
      assert.equal(out.record.argv_shape.includes("--no-remit"), false);
      assert.equal(out.record.argv_shape.includes("--proxy-base"), false);
    });
  } finally {
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("CLI: malformed findings journal lines are recorded in Run Record observations", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    const journal = join(dir, "wf.jsonl");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    writeFileSync(journal, `${JSON.stringify({
      schema_version: "campaigns-os-workflow-finding/v0",
      id: "wf_good",
      created_at: "2026-06-07T00:00:00.000Z",
      stage: "qa",
      kind: "friction",
      summary: "slow",
      run_id: "run_malformed",
      author_type: "operator",
      evidence_quality: "operator_report",
    })}\n{not-json}\n`);

    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record",
      "--packet", packetPath,
      "--journal", journal,
      "--run-id", "run_malformed",
      "--no-remit",
      "--json",
    ], { encoding: "utf8" }));

    assert.deepEqual(out.record.observations.finding_ids, ["wf_good"]);
    assert.deepEqual(out.record.observations.findings_journal, {
      malformed_count: 1,
      malformed_lines: [2],
    });
  });
});

// --- T6: lifecycle embedding -----------------------------------------------

test("assembleRunRecord embeds a lifecycle block when provided and validates", () => {
  const record = assembleRunRecord(assembleArgs({
    lifecycle: { run_id: "run_1_test", command: "doctor", argv_shape: ["--packet"], exit_status: 2, started_at: "t0", completed_at: "t1", duration_ms: 12, stages: [], repair_loop_count: 0 },
  }));
  assert.equal(validateRunRecord(record).ok, true, JSON.stringify(validateRunRecord(record).errors));
  assert.equal(record.lifecycle.command, "doctor");
  assert.equal(record.lifecycle.exit_status, 2);
});

test("assembleRunRecord omits lifecycle when none is provided (backward-compatible)", () => {
  const record = assembleRunRecord(assembleArgs());
  assert.equal("lifecycle" in record, false);
  assert.equal(validateRunRecord(record).ok, true);
});

test("validateRunRecord rejects a malformed lifecycle block", () => {
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: "nope" })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { command: 1 } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { exit_status: "2" } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { argv_shape: "x" } })).ok, false);
});

test("validateRunRecord rejects lifecycle fields that the published JSON schema rejects (drift guard)", () => {
  // schema requires stages[].name and types started_at/completed_at as string|null
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { command: "x", argv_shape: [], stages: [{ duration_ms: 5 }] } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { command: "x", argv_shape: [], stages: [{ name: "build", duration_ms: "5" }] } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { command: "x", argv_shape: [], started_at: 12345 } })).ok, false);
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { command: "x", argv_shape: [], run_id: 7 } })).ok, false);
  // a well-formed stage still passes
  assert.equal(validateRunRecord(minimalRecord({ lifecycle: { command: "x", argv_shape: [], stages: [{ name: "build", duration_ms: 5 }] } })).ok, true);
});

test("CLI: an unreadable/directory lifecycle-journal path never breaks run-record (best-effort)", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    // Point --lifecycle-journal at a DIRECTORY — readFileSync would throw EISDIR.
    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_baddir", "--lifecycle-journal", dir, "--no-write", "--json",
    ], { encoding: "utf8" }));
    assert.equal(out.ok, true); // did not crash
    assert.equal("lifecycle" in out.record, false); // embedded nothing
    assert.equal(validateRunRecord(out.record).ok, true);
  });
});

test("CLI: a corrupt-but-parseable lifecycle entry is coerced into a schema-valid block, never crashes the record", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const lcJournal = join(dir, "lc.jsonl");
    // Valid JSON line, but argv_shape is the wrong type and a stage lacks a name.
    writeFileSync(lcJournal, `${JSON.stringify({ command: "doctor", run_id: "run_corrupt", argv_shape: "not-an-array", stages: [{ duration_ms: 5 }] })}\n`);
    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_corrupt", "--lifecycle-journal", lcJournal, "--no-write", "--json",
    ], { encoding: "utf8" }));
    // Aggregation coerces the bad fields rather than dropping good signal; the
    // record stays schema-valid (the real safety property).
    assert.equal(validateRunRecord(out.record).ok, true);
    assert.deepEqual(out.record.lifecycle.argv_shape, []); // non-array coerced
    assert.equal(out.record.lifecycle.stages[0].name, "doctor:stage"); // nameless sub-phase named
  });
});

test("CLI: prepare-build sub-phases flow through the journal into the aggregated Run Record (Tier 2)", () => {
  withTempDir((dir) => {
    const lcJournal = join(dir, "lc.jsonl");
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });

    // prepare-build marks resolve-spec + prepare-build sub-phases (Tier 2).
    try {
      execFileSync("node", [
        CLI, "prepare-build",
        "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"),
        "--source", resolve(ROOT, "examples/source-html"),
        "--target", target,
        "--template-family", "olympus",
        "--run-id", "run_phases", "--lifecycle-journal", lcJournal,
      ], { encoding: "utf8", stdio: "pipe" });
    } catch { /* even on non-zero exit, the lifecycle entry (with stages) persists */ }

    const { entries } = readLifecycleJournal(lcJournal);
    const entry = entries.find((e) => e.command === "prepare-build");
    assert.ok(entry, "expected a prepare-build lifecycle entry");
    assert.deepEqual(entry.stages.map((s) => s.name), ["resolve-spec", "prepare-build"]);

    // Tier 1 aggregation flattens them into `prepare-build:<phase>` Run Record stages.
    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", join(target, "campaign-runtime.build.json"),
      "--journal", join(dir, "wf.jsonl"), "--run-id", "run_phases",
      "--lifecycle-journal", lcJournal, "--no-write", "--no-remit", "--json",
    ], { encoding: "utf8" }));
    const stageNames = out.record.lifecycle.stages.map((s) => s.name);
    assert.ok(stageNames.includes("prepare-build:resolve-spec"), JSON.stringify(stageNames));
    assert.ok(stageNames.includes("prepare-build:prepare-build"), JSON.stringify(stageNames));
    assert.equal(validateRunRecord(out.record).ok, true);
  });
});

test("CLI: lifecycle persists on the THROW path (failure telemetry is captured, not dropped)", () => {
  withTempDir((dir) => {
    const lcJournal = join(dir, "lc.jsonl");
    // `doctor` with no --packet throws (Missing required --packet) and exits non-zero.
    let threw = false;
    try {
      execFileSync("node", [CLI, "doctor", "--run-id", "run_throw", "--lifecycle-journal", lcJournal], { encoding: "utf8", stdio: "pipe" });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    const { entries } = readLifecycleJournal(lcJournal);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].run_id, "run_throw");
    assert.equal(entries[0].command, "doctor");
    assert.equal(entries[0].exit_status, 1); // thrown error => status 1, still recorded
  });
});

test("CLI: lifecycle persistence honors the CAMPAIGNS_OS_LIFECYCLE_LOG env var", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const lcJournal = join(dir, "env-lc.jsonl");
    const env = { ...process.env, CAMPAIGNS_OS_LIFECYCLE_LOG: lcJournal };
    try {
      execFileSync("node", [CLI, "doctor", "--packet", packetPath, "--run-id", "run_env"], { encoding: "utf8", env, stdio: "pipe" });
    } catch { /* doctor flags the synthetic packet (exit 2) */ }
    const { entries } = readLifecycleJournal(lcJournal);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].run_id, "run_env");
    assert.equal(entries[0].exit_status, 2);
  });
});

test("CLI: a --flag=value token never leaks its value into argv_shape", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const lcJournal = join(dir, "lc.jsonl");
    try {
      execFileSync("node", [
        CLI, "doctor", "--packet", packetPath, "--run-id", "run_eq",
        "--auth-cookie=sterling-SECRET-value", "--lifecycle-journal", lcJournal,
      ], { encoding: "utf8", stdio: "pipe" });
    } catch { /* exit 2 */ }
    const { entries } = readLifecycleJournal(lcJournal);
    const shape = entries[0].argv_shape;
    assert.ok(shape.includes("--auth-cookie"), "flag name should appear");
    assert.ok(!shape.some((flag) => flag.includes("=")), "no = in any shape token");
    assert.ok(!shape.some((flag) => flag.includes("SECRET")), "value must never leak");
  });
});

test("CLI: re-running run-record over the same journal does not shadow the build entry with its own", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const lcJournal = join(dir, "lc.jsonl");
    const run = (args) => {
      try {
        return execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        return String(error.stdout || "");
      }
    };
    // Build command writes its lifecycle entry.
    run(["doctor", "--packet", packetPath, "--run-id", "run_shadow", "--lifecycle-journal", lcJournal]);
    // First run-record (also writes its own entry to the journal afterward).
    JSON.parse(run(["run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_shadow", "--lifecycle-journal", lcJournal, "--no-write", "--json"]));
    // Second run-record: must still embed doctor, not run-record's own self-entry.
    const out2 = JSON.parse(run(["run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_shadow", "--lifecycle-journal", lcJournal, "--no-write", "--json"]));
    assert.equal(out2.record.lifecycle.command, "doctor");
  });
});

test("CLI: a lifecycle journal entry is captured then embedded into the Run Record by run_id (T6 loop)", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const lcJournal = join(dir, "lc.jsonl");
    const run = (args) => {
      try {
        return execFileSync("node", [CLI, ...args], { encoding: "utf8" });
      } catch (error) {
        return String(error.stdout || ""); // doctor exits 2 — capture stdout anyway
      }
    };

    // 1) A command runs with opt-in lifecycle persistence, stamped with run_id.
    run(["doctor", "--packet", packetPath, "--run-id", "run_lc", "--lifecycle-journal", lcJournal, "--json"]);

    // 2) run-record embeds the matching lifecycle entry.
    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_lc", "--lifecycle-journal", lcJournal, "--no-write", "--json",
    ], { encoding: "utf8" }));

    assert.ok(out.record.lifecycle, "expected a lifecycle block");
    assert.equal(out.record.lifecycle.command, "doctor");
    assert.equal(out.record.lifecycle.run_id, "run_lc");
    assert.equal(out.record.lifecycle.exit_status, 2); // doctor flagged the synthetic packet
    assert.ok(typeof out.record.lifecycle.duration_ms === "number");
    assert.equal(validateRunRecord(out.record).ok, true);
  });
});

test("CLI: findings stamped with a run_id form an EXACT Run Record snapshot (T2<->T5 loop)", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const journal = join(dir, "wf.jsonl");
    const run = (args) => execFileSync("node", [CLI, ...args], { encoding: "utf8" });

    // Two findings for THIS run, one for another run, one legacy (no run_id).
    run(["findings", "add", "--journal", journal, "--stage", "qa", "--kind", "friction", "--summary", "a", "--run-id", "run_snap"]);
    run(["findings", "add", "--journal", journal, "--stage", "build", "--kind", "idea", "--summary", "b", "--run-id", "run_snap"]);
    run(["findings", "add", "--journal", journal, "--stage", "qa", "--kind", "friction", "--summary", "c", "--run-id", "run_other"]);
    run(["findings", "add", "--journal", journal, "--stage", "overall", "--kind", "positive_signal", "--summary", "legacy"]);

    const out = JSON.parse(run(["run-record", "--packet", packetPath, "--journal", journal, "--run-id", "run_snap", "--json"]));
    const ids = out.record.observations.finding_ids;
    const journalEntries = readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expectedIds = journalEntries.filter((f) => f.run_id === "run_snap").map((f) => f.id);

    assert.equal(ids.length, 2);
    assert.deepEqual([...ids].sort(), [...expectedIds].sort()); // exact, not time-inferred
  });
});
