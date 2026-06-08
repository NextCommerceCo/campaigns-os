// Run Telemetry — per-run Run Record capture for Campaigns OS.
// See docs/workflow-findings-sidecar.md (Run Telemetry).
//
// A Run Record is a per-run MANIFEST keyed by one canonical run_id. It
// REFERENCES source artifacts by {path, schema_version, sha256} and carries
// normalized observation arrays; it never re-embeds full artifact bodies, so
// it survives upstream schema drift. Capture is ALWAYS local — consent gates
// remit only (see consent.mjs). This module owns the schema validator and the
// local assemble/write surface; it has no network or credential dependencies.

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ADAPTER_DECISION_STRATEGY_FIELDS } from "./adapter-decision-contract.mjs";

export const RUN_RECORD_SCHEMA = "campaigns-os-run-record/v0";
export const RUN_RECORDS_DIR_REL_PATH = ".campaign-runtime/run-records";

// Improvement-surface taxonomy: a list, not an enum — real signal is rarely
// one surface (see Improvement-Surface Taxonomy in the design).
export const RUN_RECORD_SURFACES = [
  "skill",
  "cli",
  "template",
  "design-source",
  "docs",
  "spec-rule",
  "platform",
];

export const RUN_RECORD_ARTIFACT_KINDS = [
  "build_packet",
  "build_context",
  "assembly_report",
  "qa_verdict",
  "findings_journal",
];

export const RUN_RECORD_CONSENT_STATES = ["on", "off"];
export const RUN_RECORD_REMIT_STATES = ["skipped", "pending", "ok", "failed"];

// Required core. Strict here; permissive about optional sub-structures (the
// validator checks shapes, not nested artifact bodies — those are referenced
// by hash, not embedded).
const REQUIRED_FIELDS = [
  "schema_version",
  "run_id",
  "package_version",
  "command",
  "created_at",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Hand-rolled validator matching the repo convention (no AJV). Checks the
 * stable envelope + the shapes of the observation arrays and artifact refs;
 * it does NOT re-validate nested artifact bodies (those are referenced by
 * hash, not embedded). Returns `{ ok, errors }` where each error is
 * `{ code, message }`.
 */
export function validateRunRecord(record) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!record || typeof record !== "object" || Array.isArray(record)) {
    add("record.type", "Run Record must be a JSON object.");
    return { ok: false, errors };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!isNonEmptyString(record[field])) {
      add(`record.${field}`, `Missing or empty required field "${field}".`);
    }
  }

  if (record.schema_version != null && record.schema_version !== RUN_RECORD_SCHEMA) {
    add("record.schema_version", `Expected schema_version "${RUN_RECORD_SCHEMA}".`);
  }

  if (record.argv_shape == null || !isStringArray(record.argv_shape)) {
    add("record.argv_shape", "argv_shape is required and must be an array of strings (flag names, never values).");
  }

  if (!RUN_RECORD_CONSENT_STATES.includes(record.consent_state)) {
    add("record.consent_state", `consent_state is required and must be one of: ${RUN_RECORD_CONSENT_STATES.join(", ")}.`);
  }
  if (record.consent_source != null && !["env", "file", "default"].includes(record.consent_source)) {
    add("record.consent_source", 'consent_source must be one of: env, file, default (or omitted).');
  }

  if (typeof record.remit_attempted !== "boolean") {
    add("record.remit_attempted", "remit_attempted is required and must be a boolean.");
  }
  if (record.remit_ok != null && typeof record.remit_ok !== "boolean") {
    add("record.remit_ok", "remit_ok must be a boolean or null.");
  }
  if (record.remit_error != null && typeof record.remit_error !== "string") {
    add("record.remit_error", "remit_error must be a string or null.");
  }
  if (record.remit_endpoint != null && (!isNonEmptyString(record.remit_endpoint) || !record.remit_endpoint.startsWith("/"))) {
    add("record.remit_endpoint", "remit_endpoint must be a path beginning with / or null.");
  }
  if (record.remit_state != null && !RUN_RECORD_REMIT_STATES.includes(record.remit_state)) {
    add("record.remit_state", `remit_state must be one of: ${RUN_RECORD_REMIT_STATES.join(", ")}.`);
  }

  if (record.identity != null) {
    if (typeof record.identity !== "object" || Array.isArray(record.identity)) {
      add("record.identity", "identity must be an object when present.");
    }
  }

  if (record.artifacts != null) {
    if (!Array.isArray(record.artifacts)) {
      add("record.artifacts", "artifacts must be an array when present.");
    } else {
      record.artifacts.forEach((ref, index) => {
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
          add(`record.artifacts[${index}]`, "each artifact ref must be an object.");
          return;
        }
        if (!RUN_RECORD_ARTIFACT_KINDS.includes(ref.kind)) {
          add(`record.artifacts[${index}].kind`, `unknown artifact kind "${ref.kind}". Allowed: ${RUN_RECORD_ARTIFACT_KINDS.join(", ")}.`);
        }
        if (!isNonEmptyString(ref.path)) {
          add(`record.artifacts[${index}].path`, "artifact ref path is required and must be a non-empty string.");
        }
      });
    }
  }

  if (record.observations != null) {
    const obs = record.observations;
    if (typeof obs !== "object" || Array.isArray(obs)) {
      add("record.observations", "observations must be an object when present.");
    } else {
      if (obs.spec_validation_rule_ids != null && !isStringArray(obs.spec_validation_rule_ids)) {
        add("record.observations.spec_validation_rule_ids", "spec_validation_rule_ids must be an array of strings.");
      }
      if (obs.finding_ids != null && !isStringArray(obs.finding_ids)) {
        add("record.observations.finding_ids", "finding_ids must be an array of strings.");
      }
      if (obs.findings_journal != null) {
        const j = obs.findings_journal;
        if (typeof j !== "object" || Array.isArray(j)) {
          add("record.observations.findings_journal", "findings_journal must be an object.");
        } else {
          if (j.malformed_count != null && !Number.isInteger(j.malformed_count)) add("record.observations.findings_journal.malformed_count", "malformed_count must be an integer.");
          if (j.malformed_lines != null && (!Array.isArray(j.malformed_lines) || !j.malformed_lines.every(Number.isInteger))) {
            add("record.observations.findings_journal.malformed_lines", "malformed_lines must be an array of integers.");
          }
        }
      }
      if (obs.doctor != null) {
        const d = obs.doctor;
        if (typeof d !== "object" || Array.isArray(d)) {
          add("record.observations.doctor", "doctor must be an object.");
        } else {
          if (d.error_codes != null && !isStringArray(d.error_codes)) add("record.observations.doctor.error_codes", "error_codes must be an array of strings.");
          if (d.warning_codes != null && !isStringArray(d.warning_codes)) add("record.observations.doctor.warning_codes", "warning_codes must be an array of strings.");
        }
      }
      if (obs.qa != null) {
        const q = obs.qa;
        if (typeof q !== "object" || Array.isArray(q)) {
          add("record.observations.qa", "qa must be an object.");
        } else if (q.gap_classes != null && !isStringArray(q.gap_classes)) {
          add("record.observations.qa.gap_classes", "gap_classes must be an array of strings.");
        }
      }
    }
  }

  if (record.surfaces != null) {
    if (!Array.isArray(record.surfaces)) {
      add("record.surfaces", "surfaces must be an array when present.");
    } else {
      const unknown = record.surfaces.filter((s) => !RUN_RECORD_SURFACES.includes(s));
      if (unknown.length) add("record.surfaces", `unknown surface(s): ${unknown.join(", ")}. Allowed: ${RUN_RECORD_SURFACES.join(", ")}.`);
    }
  }
  if (record.primary_surface != null && !RUN_RECORD_SURFACES.includes(record.primary_surface)) {
    add("record.primary_surface", `unknown primary_surface "${record.primary_surface}". Allowed: ${RUN_RECORD_SURFACES.join(", ")}.`);
  }

  if (record.lifecycle != null) {
    for (const error of validateRunRecordLifecycle(record.lifecycle)) errors.push(error);
  }

  return { ok: errors.length === 0, errors };
}

// Validate the embedded lifecycle block against the SAME rules the published
// JSON schema enforces (types + stages[].name + numeric duration_ms). Exported
// so the CLI can drop a corrupt/foreign lifecycle journal entry BEFORE assembly
// rather than fail the whole Run Record at write time. Returns an error array.
export function validateRunRecordLifecycle(lc) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (typeof lc !== "object" || lc === null || Array.isArray(lc)) {
    add("record.lifecycle", "lifecycle must be an object when present.");
    return errors;
  }
  if (lc.command != null && typeof lc.command !== "string") add("record.lifecycle.command", "command must be a string.");
  if (lc.run_id != null && typeof lc.run_id !== "string") add("record.lifecycle.run_id", "run_id must be a string or null.");
  if (lc.argv_shape != null && !isStringArray(lc.argv_shape)) add("record.lifecycle.argv_shape", "argv_shape must be an array of strings.");
  if (lc.exit_status != null && !Number.isInteger(lc.exit_status)) add("record.lifecycle.exit_status", "exit_status must be an integer or null.");
  if (lc.started_at != null && typeof lc.started_at !== "string") add("record.lifecycle.started_at", "started_at must be a string or null.");
  if (lc.completed_at != null && typeof lc.completed_at !== "string") add("record.lifecycle.completed_at", "completed_at must be a string or null.");
  if (lc.duration_ms != null && typeof lc.duration_ms !== "number") add("record.lifecycle.duration_ms", "duration_ms must be a number or null.");
  if (lc.repair_loop_count != null && !Number.isInteger(lc.repair_loop_count)) add("record.lifecycle.repair_loop_count", "repair_loop_count must be an integer or null.");
  if (lc.stages != null) {
    if (!Array.isArray(lc.stages)) {
      add("record.lifecycle.stages", "stages must be an array when present.");
    } else {
      lc.stages.forEach((stage, index) => {
        if (!stage || typeof stage !== "object" || Array.isArray(stage) || typeof stage.name !== "string") {
          add(`record.lifecycle.stages[${index}].name`, "each stage requires a string name (matches the published schema).");
        } else {
          if (stage.duration_ms != null && typeof stage.duration_ms !== "number") add(`record.lifecycle.stages[${index}].duration_ms`, "stage duration_ms must be a number or null.");
          if (stage.exit_status != null && !Number.isInteger(stage.exit_status)) add(`record.lifecycle.stages[${index}].exit_status`, "stage exit_status must be an integer or null.");
        }
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Capture: mint a canonical run_id, assemble the manifest from already-read
// artifacts (the CLI reuses the same readers `findings harvest` uses), and
// write it to .campaign-runtime/run-records/<run_id>.json. Assembly is a pure
// function over inputs so it is unit-testable without a packet on disk.
// ---------------------------------------------------------------------------

/**
 * Mint the single canonical run_id at the run boundary. Threaded through the
 * run so every artifact and finding correlates, and used as the remit
 * idempotency key.
 */
export function mintRunId(now = new Date()) {
  return `run_${now.getTime()}_${randomBytes(4).toString("hex")}`;
}

function sanitizeRunId(runId) {
  return String(runId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "unnamed";
}

/**
 * Resolve where a Run Record is written: <baseDir>/.campaign-runtime/
 * run-records/<run_id>.json. baseDir is the run root (the CLI passes the
 * packet's directory) so the records sit next to the findings journal.
 */
export function resolveRunRecordPath(runId, baseDir = process.cwd()) {
  return join(resolve(baseDir), RUN_RECORDS_DIR_REL_PATH, `${sanitizeRunId(runId)}.json`);
}

function extractDoctorObservations(doctor) {
  if (!doctor || typeof doctor !== "object") return null;
  const codes = (issues) => (Array.isArray(issues) ? issues : []).map((issue) => issue?.code).filter((code) => typeof code === "string");
  return {
    status: typeof doctor.status === "string" ? doctor.status : null,
    error_codes: codes(doctor.errors),
    warning_codes: codes(doctor.warnings),
    ready_count: Array.isArray(doctor.ready) ? doctor.ready.length : null,
  };
}

// spec.validation issues carry the per-violation rule identity in `detail`
// (ruleId + path + data). Pull the rule IDs so a finding maps back to the
// exact rule that fired.
function extractSpecValidationRuleIds(doctor) {
  if (!doctor || typeof doctor !== "object") return [];
  const ids = [];
  for (const issue of [...(doctor.errors || []), ...(doctor.warnings || [])]) {
    if (issue?.code === "spec.validation" && typeof issue.detail?.ruleId === "string") {
      ids.push(issue.detail.ruleId);
    }
  }
  return [...new Set(ids)];
}

function extractQaObservations(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  const families = new Set();
  for (const exception of Array.isArray(verdict.exceptions) ? verdict.exceptions : []) {
    if (typeof exception?.family === "string") families.add(exception.family);
  }
  return {
    disposition: typeof verdict.disposition === "string" ? verdict.disposition : null,
    gap_classes: [...families],
  };
}

// Adapter decisions live in (precedence): report.adapter_decisions ->
// context.adapter_decisions -> packet.source_html.adapter_contract — the same
// precedence the doctor uses when it validates them.
function selectAdapterDecisions({ packet, report, context }) {
  return (
    report?.adapter_decisions
    || context?.adapter_decisions
    || packet?.source_html?.adapter_contract
    || null
  );
}

function extractAdapterDecisions(decisions) {
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) return null;
  const out = {};
  for (const key of ADAPTER_DECISION_STRATEGY_FIELDS) {
    if (typeof decisions[key] === "string") out[key] = decisions[key];
  }
  if (typeof decisions.template_files_copied?.status === "string") {
    out.template_files_copied_status = decisions.template_files_copied.status;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The per-run findings snapshot, by ID. Exact (not time-inferred): only
 * findings explicitly stamped with this run_id are included. Findings
 * captured before Run Telemetry (no run_id) are correctly excluded.
 */
export function selectRunFindingIds(journal, runId) {
  const findings = Array.isArray(journal?.findings)
    ? journal.findings
    : Array.isArray(journal)
      ? journal
      : [];
  return findings
    .filter((finding) => typeof finding?.id === "string" && finding.run_id === runId)
    .map((finding) => finding.id);
}

function normalizeIdentity(identity = {}) {
  return {
    map_id: identity.map_id ?? null,
    campaign_slug: identity.campaign_slug ?? null,
    template_family: identity.template_family ?? null,
    entry_point_shape: identity.entry_point_shape ?? null,
  };
}

function normalizeRemitState(remit) {
  if (RUN_RECORD_REMIT_STATES.includes(remit?.state)) return remit.state;
  if (remit?.attempted) return remit.ok === true ? "ok" : "failed";
  return "skipped";
}

/**
 * Assemble a Run Record manifest from already-read inputs. Pure: the caller
 * does the file reading (reusing the doctor / packet / report / verdict /
 * journal readers) and passes the parsed structures in. Missing identity or
 * absent artifacts never throw — capture is best-effort.
 */
export function assembleRunRecord({
  runId,
  packageVersion,
  command,
  argvShape = [],
  consent = { state: "off", source: "default" },
  remit = { attempted: false, ok: null, error: null, endpoint: null },
  identity = {},
  artifacts = [],
  packet = null,
  doctor = null,
  report = null,
  context = null,
  qaVerdict = null,
  journal = { findings: [] },
  surfaces = [],
  primarySurface = null,
  surfaceConfidence = null,
  lifecycle = null,
  now = new Date(),
} = {}) {
  const observations = {};
  const doctorObs = extractDoctorObservations(doctor);
  if (doctorObs) {
    observations.doctor = doctorObs;
    observations.spec_validation_rule_ids = extractSpecValidationRuleIds(doctor);
  }
  const adapter = extractAdapterDecisions(selectAdapterDecisions({ packet, report, context }));
  if (adapter) observations.adapter_decisions = adapter;
  const qaObs = extractQaObservations(qaVerdict);
  if (qaObs) observations.qa = qaObs;
  observations.finding_ids = selectRunFindingIds(journal, runId);
  const malformedJournalLines = Array.isArray(journal?.malformed)
    ? journal.malformed.map((entry) => entry?.line).filter(Number.isInteger)
    : [];
  if (malformedJournalLines.length) {
    observations.findings_journal = {
      malformed_count: malformedJournalLines.length,
      malformed_lines: malformedJournalLines,
    };
  }

  const record = {
    schema_version: RUN_RECORD_SCHEMA,
    run_id: runId,
    package_version: packageVersion,
    command,
    argv_shape: Array.isArray(argvShape) ? argvShape : [],
    created_at: now.toISOString(),
    consent_state: consent?.state === "on" ? "on" : "off",
    consent_source: consent?.source ?? null,
    remit_attempted: Boolean(remit?.attempted),
    remit_ok: remit?.ok ?? null,
    remit_error: remit?.error ?? null,
    remit_endpoint: remit?.endpoint ?? null,
    remit_state: normalizeRemitState(remit),
    identity: normalizeIdentity(identity),
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    observations,
  };

  const cleanSurfaces = Array.isArray(surfaces) ? surfaces.filter(Boolean) : [];
  if (cleanSurfaces.length) record.surfaces = cleanSurfaces;
  if (primarySurface) record.primary_surface = primarySurface;
  if (surfaceConfidence) record.surface_confidence = surfaceConfidence;
  if (lifecycle && typeof lifecycle === "object" && !Array.isArray(lifecycle)) record.lifecycle = lifecycle;

  return record;
}

/**
 * Validate then write a Run Record to its canonical path. Throws on an
 * invalid record (a malformed manifest is a build-tooling bug, not run state
 * to swallow). Returns the written path.
 */
export function writeRunRecord(record, { baseDir = process.cwd() } = {}) {
  const validation = validateRunRecord(record);
  if (!validation.ok) {
    const detail = validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    throw new Error(`Run Record failed validation; refusing to write: ${detail}`);
  }
  const path = resolveRunRecordPath(record.run_id, baseDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmpPath, path);
  return path;
}
