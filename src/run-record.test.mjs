import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    report: { adapter_decisions: { source_asset_strategy: "external_cdn", route_rewrite_policy: "raw_passthrough", template_files_copied: { status: "complete" } } },
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
  const out = JSON.parse(execFileSync("node", [
    CLI, "run-record",
    "--packet", resolve(ROOT, "examples/build-packet.basic.json"),
    "--no-write", "--json",
  ], { encoding: "utf8" }));

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
  // capture is always local; consent defaults OFF (safe) in v0 wiring.
  assert.equal(record.consent_state, "off");
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
        "--no-remit",
        "--json",
      ], { encoding: "utf8" }));

      const qaRef = out.record.artifacts.find((ref) => ref.kind === "qa_verdict");
      assert.equal(qaRef.path, "external:qa_verdict");
      assert.ok(qaRef.sha256);
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
