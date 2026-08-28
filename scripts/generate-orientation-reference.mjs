#!/usr/bin/env node

/**
 * Generates the normative orientation-contract reference AND the per-outcome
 * envelope fixtures from the contract files themselves.
 *
 * Generated, not merely validated: the build plan permits either, and generated
 * is the stronger choice because staleness becomes a CI failure rather than a
 * documentation review someone has to remember to do. Nobody hand-edits
 * docs/orientation-contract-reference.md; you change the contract and rerun
 * this script.
 *
 *   node ./scripts/generate-orientation-reference.mjs --write
 *   node ./scripts/generate-orientation-reference.mjs --check   (CI; default)
 *
 * The envelope fixtures under contracts/fixtures/orientation/envelope/ are
 * consumer-facing: campaigns-agent's parser validates against exactly these
 * bytes, so they are supported surface and are regenerated here rather than
 * drifting as hand-maintained copies of the schema.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  LEDGER_SCHEMA_PATH,
  LIMITS_PATH,
  ORIENTATION_SCHEMA_PATH,
  POLICY_PATH,
  REASON_CODES_PATH,
  SURFACE_PATH,
  sha256Hex,
} from "./orientation-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REFERENCE_PATH = "docs/orientation-contract-reference.md";
export const ENVELOPE_FIXTURE_DIR = "contracts/fixtures/orientation/envelope";

const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const OID_A = "1".repeat(40);
const OID_B = "2".repeat(40);
const DIGEST = "3".repeat(64);

/* ------------------------------------------------------------------ */
/* Envelope fixtures                                                   */
/* ------------------------------------------------------------------ */

function baseEnvelope(limits) {
  return {
    schema_version: "campaigns-os-tooling-orientation/v1",
    request: {
      run_id: "run-example-0001",
      checkout_mode: "managed",
      mutation_policy: "observe_only",
      baseline: { kind: "supported_surface", commit: OID_A, surface_version: "1.13.0" },
      accepted_orientation_schemas: ["campaigns-os-tooling-orientation/v1"],
      accepted_surface_range: ">=1.13.0 <2.0.0",
      manifest_sha256: DIGEST,
    },
    repository: {
      owner: "NextCommerceCo",
      repository: "campaigns-os",
      branch: "main",
      upstream: "origin/main",
      clean: true,
      shallow: false,
      graph_relation: "identical",
      common_git_identity: "managed-store-0001",
      worktree_identity: "generation-0001",
      commit_before: OID_A,
      commit_fetched: OID_A,
      commit_after: OID_A,
    },
    freshness: {
      state: "current",
      observed_at: "2026-08-28T00:00:00Z",
      fetch_result: { attempted: true, succeeded: true, duration_ms: 420 },
    },
    surface: {
      reviewed_version: "1.13.0",
      target_version: "1.13.0",
      current_version: "1.13.0",
      compatibility_result: "compatible",
      compatibility_rule: "target surface_version is inside the consumer's accepted_surface_range",
      transitions: [],
    },
    release_ledger: { ledger_schema_version: "campaigns-os-release-ledger/v1", entries: [] },
    changelog: { sections: [] },
    runtime: {
      recipe_id: null,
      source_fingerprint: DIGEST,
      generated_state: "fresh",
      emitter_commit: OID_A,
      refresh_action: "none",
      ready: true,
    },
    transaction: {
      state: "none",
      commit_before: OID_A,
      commit_target: OID_A,
      commit_observed: OID_A,
      recovered_interrupted_update: false,
    },
    outcome: {
      disposition: "current",
      reason_code: "already_current",
      active_generation_changed: false,
      fresh_exec_required: false,
      next_actions: ["proceed"],
    },
    limits: limitsBlock(limits, {
      source_bytes: 22024,
      section_count: 8,
      max_observed_section_bytes: 3903,
      envelope_bytes: 4096,
      ledger_entries: 1,
    }),
  };
}

function limitsBlock(limits, applied) {
  return {
    limits_version: limits.limits_version,
    max_source_bytes: limits.limits.max_source_bytes.value,
    max_section_count: limits.limits.max_section_count.value,
    max_section_bytes: limits.limits.max_section_bytes.value,
    max_envelope_bytes: limits.limits.max_envelope_bytes.value,
    max_ledger_entries: limits.limits.max_ledger_entries.value,
    applied,
  };
}

const ledgerExample = (limits) => ({
  ledger_schema_version: "campaigns-os-release-ledger/v1",
  entries: [
    {
      id: "RL-0001",
      sequence: 1,
      date: "2026-08-28",
      kind: "release",
      surface_version: "1.14.0",
      changelog_section: "1.14.0",
      changelog_sha256: DIGEST,
      agent_impact: "A consumer may now read the orientation contract and release ledger from Git objects.",
      compatibility: "additive",
      migration: "none",
      affected_surface_entries: ["contracts/release-ledger.json"],
      changes: [
        {
          class: "named_surface",
          path: "contracts/release-ledger.json",
          surface_entry: "contracts/release-ledger.json",
          summary: "The append-only agent-relevant release ledger was introduced.",
        },
      ],
      entry_sha256: DIGEST,
      introducing_commit: OID_B,
    },
  ],
});

const changelogExample = () => ({
  sections: [
    {
      section_id: "1.14.0",
      date: "2026-08-28",
      agent_impact: "A consumer may now read the orientation contract and release ledger from Git objects.",
      migration_action: "none",
      body_markdown: "## [1.14.0] - 2026-08-28\n\n### Added\n\n- The orientation contract and the agent-relevant release ledger.",
      body_sha256: DIGEST,
    },
  ],
});

/**
 * One envelope per terminal outcome. Each override changes only the axes that a
 * real run of that shape would change, so the fixtures teach the independence
 * of the axes rather than restating one shape eight times.
 */
export function buildEnvelopeFixtures(limits) {
  const fixtures = {};

  fixtures.current = baseEnvelope(limits);

  fixtures.orientation_available = {
    ...baseEnvelope(limits),
    freshness: { state: "available", observed_at: "2026-08-28T00:00:00Z", fetch_result: { attempted: true, succeeded: true, duration_ms: 610 } },
    surface: {
      reviewed_version: "1.13.0",
      target_version: "1.14.0",
      current_version: "1.13.0",
      compatibility_result: "compatible",
      compatibility_rule: "target surface_version is inside the consumer's accepted_surface_range",
      transitions: [{ from: "1.13.0", to: "1.14.0" }],
    },
    release_ledger: ledgerExample(limits),
    changelog: changelogExample(),
    outcome: {
      disposition: "orientation_available",
      reason_code: "orientation_rendered",
      active_generation_changed: false,
      fresh_exec_required: false,
      next_actions: ["review the release ledger", "request a managed update"],
    },
  };

  fixtures.updated = {
    ...fixtures.orientation_available,
    request: { ...baseEnvelope(limits).request, mutation_policy: "managed_update" },
    repository: { ...baseEnvelope(limits).repository, commit_fetched: OID_B, commit_after: OID_B },
    freshness: { state: "updated", observed_at: "2026-08-28T00:00:00Z", fetch_result: { attempted: true, succeeded: true, duration_ms: 610 } },
    transaction: { state: "finalized", commit_before: OID_A, commit_target: OID_B, commit_observed: OID_B, recovered_interrupted_update: false },
    outcome: {
      disposition: "updated",
      reason_code: "orientation_rendered",
      active_generation_changed: true,
      fresh_exec_required: true,
      next_actions: ["start a fresh session against the promoted generation"],
    },
  };

  fixtures.restart_required = {
    ...fixtures.orientation_available,
    runtime: { recipe_id: null, source_fingerprint: DIGEST, generated_state: "stale", emitter_commit: OID_A, refresh_action: "prepare_new_generation", ready: false, reason_code: "runtime_refresh_required" },
    outcome: {
      disposition: "restart_required",
      reason_code: "runtime_refresh_required",
      active_generation_changed: false,
      fresh_exec_required: true,
      next_actions: ["prepare a new generation", "start a fresh session"],
    },
  };

  fixtures.recovered_interrupted_update = {
    ...fixtures.updated,
    transaction: { state: "reconciled", commit_before: OID_A, commit_target: OID_B, commit_observed: OID_B, recovered_interrupted_update: true, reason_code: "transaction_reconciled" },
    outcome: {
      disposition: "recovered_interrupted_update",
      reason_code: "transaction_reconciled",
      active_generation_changed: true,
      fresh_exec_required: true,
      next_actions: ["start a fresh session against the reconciled generation"],
    },
  };

  fixtures.legacy_baseline = {
    ...baseEnvelope(limits),
    request: {
      ...baseEnvelope(limits).request,
      checkout_mode: "operator_supplied",
      baseline: { kind: "legacy_commit", commit: OID_A },
    },
    surface: {
      reviewed_version: null,
      target_version: null,
      current_version: null,
      compatibility_result: "unknown",
      compatibility_rule: "the reviewed baseline predates supported surfaces; no version is fabricated for it",
      transitions: [],
    },
    runtime: { recipe_id: null, source_fingerprint: null, generated_state: "unknown", emitter_commit: null, refresh_action: "none", ready: false },
    outcome: {
      disposition: "legacy_baseline",
      reason_code: "orientation_rendered",
      active_generation_changed: false,
      fresh_exec_required: false,
      next_actions: ["launch only the already verified operator-supplied checkout", "adopt a supported-surface baseline"],
    },
  };

  fixtures.freshness_unknown = {
    ...baseEnvelope(limits),
    freshness: {
      state: "unknown",
      observed_at: "2026-08-28T00:00:00Z",
      fetch_result: { attempted: true, succeeded: false, duration_ms: 30000, reason_code: "fetch_failed" },
    },
    repository: { ...baseEnvelope(limits).repository, commit_fetched: null, graph_relation: "unknown" },
    surface: { ...baseEnvelope(limits).surface, target_version: null, compatibility_result: "unknown", compatibility_rule: "no target was observed, so compatibility is not decidable" },
    outcome: {
      disposition: "freshness_unknown",
      reason_code: "fetch_failed",
      active_generation_changed: false,
      fresh_exec_required: false,
      next_actions: ["restore network access and rerun"],
      refusal_remedy: "Restore network access and rerun. The prior verified generation is left intact and no launch proceeds under strict-latest policy.",
    },
  };

  const overLimit = baseEnvelope(limits);
  fixtures.refused = {
    ...overLimit,
    freshness: { state: "refused", observed_at: "2026-08-28T00:00:00Z", fetch_result: { attempted: true, succeeded: true, duration_ms: 610 } },
    limits: {
      ...limitsBlock(limits, {
        source_bytes: limits.limits.max_source_bytes.value + 1,
        section_count: 8,
        max_observed_section_bytes: 3903,
        envelope_bytes: 4096,
        ledger_entries: 1,
      }),
      exceeded: ["max_source_bytes"],
    },
    outcome: {
      disposition: "refused",
      reason_code: "orientation_too_large",
      active_generation_changed: false,
      fresh_exec_required: false,
      next_actions: ["adopt a newer reviewed baseline", "raise the limit as a reviewed policy change"],
      refusal_remedy:
        "Adopt a newer reviewed baseline so the window is smaller, or raise the limit as a reviewed policy change that advances limits_version and carries its own ledger entry. Orientation refuses; it never truncates.",
    },
  };

  return fixtures;
}

/* ------------------------------------------------------------------ */
/* Reference document                                                  */
/* ------------------------------------------------------------------ */

function collectEnums(schema, path = "", found = []) {
  if (!schema || typeof schema !== "object") return found;
  if (Array.isArray(schema.enum)) found.push({ path: path || "(root)", values: schema.enum });
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum") continue;
    if (value && typeof value === "object") collectEnums(value, path ? `${path}.${key}` : key, found);
  }
  return found;
}

const escapeCell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

export function renderReference({ orientationSchema, ledgerSchema, policy, reasonCodes, limits, surface, fixtures }) {
  const lines = [];
  const push = (...text) => lines.push(...text);

  push(
    "# Orientation contract reference",
    "",
    "<!--",
    "  GENERATED FILE — do not edit by hand.",
    "  Source: scripts/generate-orientation-reference.mjs, from",
    `    ${ORIENTATION_SCHEMA_PATH}`,
    `    ${LEDGER_SCHEMA_PATH}`,
    `    ${POLICY_PATH}`,
    `    ${REASON_CODES_PATH}`,
    `    ${LIMITS_PATH}`,
    `    ${SURFACE_PATH}`,
    "  Regenerate: node ./scripts/generate-orientation-reference.mjs --write",
    "  CI runs the same script with --check, so a stale copy of this file fails the build.",
    "-->",
    "",
    "This is the normative reference for `campaigns-os-tooling-orientation/v1`: every enum,",
    "stable reason code, deterministic remedy, size bound, and terminal-outcome example a",
    "consumer needs in order to orient on a Campaigns OS commit **without executing any",
    "Campaigns OS code**. Start at [`AGENTS.md`](../AGENTS.md) for the reading order and the",
    "supported-versus-internal boundary; this file is the field guide.",
    "",
    `Schema id: \`${orientationSchema.properties.schema_version.const}\`  `,
    `Ledger schema id: \`${ledgerSchema.properties.schema_version.const}\`  `,
    `Change policy version: \`${policy.policy_version}\`  `,
    `Reason-code vocabulary version: \`${reasonCodes.vocabulary_version}\`  `,
    `Limits version: \`${limits.limits_version}\`  `,
    `Supported surface at generation time: \`${surface.surface_version}\``,
    "",
  );

  push(
    "## Terminal outcomes",
    "",
    "Every orientation run ends on exactly one disposition. The eight below are the complete set;",
    "an unknown value fails closed at the consumer.",
    "",
    "| Disposition | Example envelope |",
    "|---|---|",
  );
  for (const disposition of orientationSchema.$defs.disposition.enum) {
    push(`| \`${disposition}\` | [\`${ENVELOPE_FIXTURE_DIR}/${disposition}.json\`](../${ENVELOPE_FIXTURE_DIR}/${disposition}.json) |`);
  }
  push("");

  push(
    "## Stable reason codes",
    "",
    "Append-only vocabulary. Each code has one meaning, one deterministic remedy, and one owning",
    "test id. `owner` says which repository's suite is obliged to exercise it: a `campaigns-os`",
    "code is exercised by this repository's contract tests, a `campaigns-agent` code by the",
    "consumer's parser tests.",
    "",
    "| Reason code | Outcomes | Owner | Test id | Meaning | Remedy |",
    "|---|---|---|---|---|---|",
  );
  for (const code of Object.keys(reasonCodes.codes).sort()) {
    const definition = reasonCodes.codes[code];
    push(
      `| \`${code}\` | ${(definition.outcomes ?? []).map((o) => `\`${o}\``).join(", ")} | ${definition.owner} | \`${definition.test_id}\` | ` +
        `${escapeCell(definition.meaning)} | ${escapeCell(definition.remedy)} |`,
    );
  }
  push("");

  push(
    "## Size bounds",
    "",
    `Declared in [\`${LIMITS_PATH}\`](../${LIMITS_PATH}). Exceeding any bound is a refusal with`,
    `reason code \`${limits.refusal_reason_code}\`. Orientation **never truncates** — a partial view of a`,
    "release is worse than a refusal, because the consumer cannot tell which part it is missing.",
    "",
    "| Limit | Value | Unit | Applies to | Rationale |",
    "|---|---|---|---|---|",
  );
  for (const [name, limit] of Object.entries(limits.limits)) {
    push(`| \`${name}\` | ${limit.value} | ${limit.unit} | ${escapeCell(limit.applies_to)} | ${escapeCell(limit.rationale)} |`);
  }
  push("");

  push(
    "## Semantic change classes",
    "",
    `Defined once in [\`${POLICY_PATH}\`](../${POLICY_PATH}). Every agent-relevant change is recorded`,
    "under exactly one of these, and the classifier fails closed on a path that matches nothing.",
    "",
    "| Class | Description |",
    "|---|---|",
  );
  for (const [name, definition] of Object.entries(policy.semantic_classes)) {
    push(`| \`${name}\` | ${escapeCell(definition.description)} |`);
  }
  push("", "Classifier evaluation order:", "", `> ${policy._evaluation_note}`, "");

  push(
    "## Schema enum inventory",
    "",
    "Every enumerated value in both schemas, listed exactly once. A value that appears here and",
    "nowhere in the schemas, or in the schemas and not here, is a generation failure.",
    "",
  );
  for (const [label, schema] of [
    [ORIENTATION_SCHEMA_PATH, orientationSchema],
    [LEDGER_SCHEMA_PATH, ledgerSchema],
  ]) {
    push(`### \`${label}\``, "", "| Location | Values |", "|---|---|");
    for (const found of collectEnums(schema)) {
      push(`| \`${found.path}\` | ${found.values.map((value) => `\`${value}\``).join(", ")} |`);
    }
    push("");
  }

  push(
    "## Supported CLI commands",
    "",
    `The argv surface declared in [\`${SURFACE_PATH}\`](../${SURFACE_PATH}). Every command listed here`,
    "resolves in the CLI dispatch; the contract test asserts that against the real dispatch table,",
    "so a renamed command fails here as well as at the supported-surface gate.",
    "",
  );
  for (const command of surface.cli_commands) push(`- \`campaigns-os ${command}\``);
  push("");

  push(
    "## Terminal outcome examples",
    "",
    "Generated from the same fixtures the contract tests validate, so an example can never drift",
    "from the schema it claims to satisfy.",
    "",
  );
  for (const disposition of orientationSchema.$defs.disposition.enum) {
    push(`### \`${disposition}\``, "", "```json", JSON.stringify(fixtures[disposition], null, 2), "```", "");
  }

  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function generate() {
  const orientationSchema = readJson(ORIENTATION_SCHEMA_PATH);
  const ledgerSchema = readJson(LEDGER_SCHEMA_PATH);
  const policy = readJson(POLICY_PATH);
  const reasonCodes = readJson(REASON_CODES_PATH);
  const limits = readJson(LIMITS_PATH);
  const surface = readJson(SURFACE_PATH);

  const fixtures = buildEnvelopeFixtures(limits);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(orientationSchema);
  const errors = [];
  for (const [disposition, envelope] of Object.entries(fixtures)) {
    if (!validate(envelope)) {
      errors.push(`${disposition}: ${validate.errors.map((e) => `${e.instancePath} ${e.message}`).join("; ")}`);
    }
  }
  if (errors.length) throw new Error(`generated envelope fixtures do not validate:\n  - ${errors.join("\n  - ")}`);

  const files = new Map();
  for (const [disposition, envelope] of Object.entries(fixtures)) {
    files.set(`${ENVELOPE_FIXTURE_DIR}/${disposition}.json`, `${JSON.stringify(envelope, null, 2)}\n`);
  }
  files.set(REFERENCE_PATH, renderReference({ orientationSchema, ledgerSchema, policy, reasonCodes, limits, surface, fixtures }));
  return files;
}

function write(files) {
  for (const [path, content] of files) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function check(files) {
  const errors = [];
  for (const [path, expected] of files) {
    let actual = null;
    try {
      actual = readFileSync(join(root, path), "utf8");
    } catch {
      errors.push(`${path}: generated file is missing — run \`node ./scripts/generate-orientation-reference.mjs --write\``);
      continue;
    }
    if (actual !== expected) {
      errors.push(
        `${path}: generated file is stale (on disk ${sha256Hex(actual).slice(0, 12)}, expected ${sha256Hex(expected).slice(0, 12)}) — ` +
          `run \`node ./scripts/generate-orientation-reference.mjs --write\` and commit the result`,
      );
    }
  }
  // A stray fixture nobody generates is a supported-surface path with no source.
  try {
    for (const name of readdirSync(join(root, ENVELOPE_FIXTURE_DIR))) {
      const path = `${ENVELOPE_FIXTURE_DIR}/${name}`;
      if (!files.has(path)) errors.push(`${path}: fixture is not produced by the generator — remove it or add its outcome to the contract`);
    }
  } catch {
    /* directory absence is already reported per-file above */
  }
  return errors;
}

function main(argv) {
  const files = generate();
  if (argv.includes("--write")) {
    write(files);
    console.log(`Wrote ${files.size} generated orientation files.`);
    return 0;
  }
  const errors = check(files);
  if (errors.length) {
    console.error("Generated orientation documentation is stale:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`Generated orientation documentation is current (${files.size} files).`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exit(main(process.argv.slice(2)));
}
