// Run Telemetry — per-run Run Record capture for Campaigns OS.
// See docs/workflow-findings-sidecar.md (Run Telemetry).
//
// A Run Record is a per-run MANIFEST keyed by one canonical run_id. It
// REFERENCES source artifacts by {path, schema_version, sha256} and carries
// normalized observation arrays; it never re-embeds full artifact bodies, so
// it survives upstream schema drift. Capture is ALWAYS local — consent gates
// remit only (see consent.mjs). This module owns the schema validator and the
// local assemble/write surface; it has no network or credential dependencies.

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

  return { ok: errors.length === 0, errors };
}
