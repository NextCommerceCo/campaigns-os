import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RUN_RECORD_SCHEMA,
  validateRunRecord,
} from "./run-record.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

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
});

test("the published JSON Schema doc and the validator agree on the schema_version const", () => {
  const schema = JSON.parse(readFileSync(resolve(ROOT, "schemas/campaigns-os-run-record.v0.schema.json"), "utf8"));
  assert.equal(schema.properties.schema_version.const, RUN_RECORD_SCHEMA);
  for (const field of ["schema_version", "run_id", "package_version", "command", "argv_shape", "created_at", "consent_state", "remit_attempted"]) {
    assert.ok(schema.required.includes(field), `schema.required should include ${field}`);
  }
});
