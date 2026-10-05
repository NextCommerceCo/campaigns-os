// Read-time input currency: whether a recorded build, Polish or QA stage was
// made against the brief and CampaignSpec content the campaign holds now.
//
// A stage stamps the inputs it was recorded against (source_brief_material,
// source_spec_material_hash). At read time each stamp is compared with the
// current value; a stage is current only when its raw status is a recognized
// terminal status, every applicable stamp equals the current value, and no
// replay rule holds. A missing or malformed stamp reads unknown, never
// current: nothing else on the report stands in for a stamp. The stage's
// superseded records are display only and are never read here.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { BRIEF_ABSENT, briefMaterialFingerprint } from "./build-brief.mjs";
import { isObject, optionalString, resolveFromFile } from "./cli-helpers.mjs";
import { specMaterialHash } from "./spec-identity.mjs";

// Every raw stage status the lifecycle writes. Any other value reads unknown.
export const RECOGNIZED_STAGE_STATUSES = Object.freeze(["pending", "blocked", "required", "completed", "completed_with_warnings", "completed_partial", "skipped"]);
const COMPLETED_STATUSES = Object.freeze(["completed", "completed_with_warnings", "completed_partial"]);
const NOT_APPLICABLE_STATUSES = Object.freeze(["pending", "blocked", "required", "skipped"]);
const TERMINAL_EFFECTIVE_STATUSES = Object.freeze([...COMPLETED_STATUSES, "skipped"]);

// The stages that carry input stamps, and the inputs each one depends on.
export const STAMPED_STAGES = Object.freeze(["assembly", "polish", "qa"]);
const APPLICABLE_BRIEF_PARTITIONS = Object.freeze({ assembly: ["presentation"], polish: ["presentation"], qa: ["presentation", "qa_policy"] });

export const INPUT_CHANGE_REASONS = Object.freeze(["brief_presentation_changed", "brief_qa_policy_changed", "spec_material_changed"]);

// The frozen stage dependency map: for each changed input, the stages it makes
// owed and what each owed stage is required by and for. prepare_build is
// re-derived by the brief save itself, doctor is recomputed on every read, and
// setup and deploy are kept.
export const INPUT_DEPENDENCY_MAP = Object.freeze({
  presentation: Object.freeze({
    reason: "brief_presentation_changed",
    stages: Object.freeze({
      assembly: Object.freeze({ required_by: "brief", required_for: Object.freeze(["polish", "qa"]) }),
      polish: Object.freeze({ required_by: "brief", required_for: Object.freeze(["qa"]) }),
      qa: Object.freeze({ required_by: "brief", required_for: Object.freeze([]) }),
    }),
  }),
  qa_policy: Object.freeze({
    reason: "brief_qa_policy_changed",
    stages: Object.freeze({
      qa: Object.freeze({ required_by: "brief", required_for: Object.freeze([]) }),
    }),
  }),
  spec: Object.freeze({
    reason: "spec_material_changed",
    stages: Object.freeze({
      assembly: Object.freeze({ required_by: "spec", required_for: Object.freeze(["polish", "qa"]) }),
      polish: Object.freeze({ required_by: "spec", required_for: Object.freeze(["qa"]) }),
      qa: Object.freeze({ required_by: "spec", required_for: Object.freeze([]) }),
    }),
  }),
});
// When several inputs changed at once, the reason recorded is the first here.
const CAUSE_PRECEDENCE = Object.freeze(["spec", "presentation", "qa_policy"]);

const SHA256_STAMP = /^sha256:[0-9a-f]{64}$/;

export const isWellFormedStamp = (value) => typeof value === "string" && (SHA256_STAMP.test(value) || value === BRIEF_ABSENT);
const isFingerprint = (value) => typeof value === "string" && SHA256_STAMP.test(value);
const isCanonicalIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export const absentBriefMaterial = () => ({ presentation: BRIEF_ABSENT, qa_policy: BRIEF_ABSENT });

// A closed shape: an object with exactly these keys, no more and no fewer.
const hasExactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

// Brief material, as bound, stamped or recorded on a verdict: exactly
// {presentation, qa_policy}, each "sha256:<64 hex>" or the absent value.
export function wellFormedBriefMaterial(value) {
  return hasExactKeys(value, ["presentation", "qa_policy"]) && isWellFormedStamp(value.presentation) && isWellFormedStamp(value.qa_policy);
}

// The spec material as a stamp ("sha256:<64 hex>"), or null.
export function specMaterialStamp(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/**
 * The brief material the packet's inputs hold now: {presentation, qa_policy}
 * fingerprinted from the normalized brief, the absent value for both when the
 * packet records no Campaign Build Brief, or null when the normalized brief
 * cannot be read.
 */
export function currentBriefMaterial({ packet, packetPath }) {
  if (!isObject(packet?.build_brief)) return absentBriefMaterial();
  const normalizedPath = optionalString(packet.build_brief.normalized_path);
  const resolved = normalizedPath && packetPath ? resolveFromFile(packetPath, normalizedPath) : null;
  if (!resolved || !existsSync(resolved)) return null;
  try {
    const brief = JSON.parse(readFileSync(resolved, "utf8"));
    return isObject(brief) ? briefMaterialFingerprint(brief) : null;
  } catch {
    return null;
  }
}

// The current spec material of a parsed CampaignSpec, or null.
export function currentSpecMaterial(spec) {
  return isObject(spec) ? specMaterialHash(spec) : null;
}

// The current inputs a record stamps, in stamp shape.
export function inputStamps({ briefMaterial, specMaterial }) {
  return {
    source_brief_material: wellFormedBriefMaterial(briefMaterial) ? { presentation: briefMaterial.presentation, qa_policy: briefMaterial.qa_policy } : null,
    source_spec_material_hash: specMaterialStamp(specMaterial),
  };
}

// input_change: exactly {at, reason, superseded_build_fingerprint,
// superseded_inputs: {brief_material, spec_material_hash}}.
export function inputChangeWellFormed(change) {
  if (!hasExactKeys(change, ["at", "reason", "superseded_build_fingerprint", "superseded_inputs"])) return false;
  if (!isCanonicalIso(change.at) || !INPUT_CHANGE_REASONS.includes(change.reason)) return false;
  if (change.superseded_build_fingerprint !== null && !isFingerprint(change.superseded_build_fingerprint)) return false;
  const inputs = change.superseded_inputs;
  if (!hasExactKeys(inputs, ["brief_material", "spec_material_hash"])) return false;
  if (inputs.brief_material !== null && !wellFormedBriefMaterial(inputs.brief_material)) return false;
  return inputs.spec_material_hash === null || isFingerprint(inputs.spec_material_hash);
}

// unchanged_output_reason: exactly {text, for_inputs: {brief_material,
// spec_material_hash}}, with non-empty text and the stamps the record wrote.
export function unchangedOutputReasonWellFormed(reason) {
  if (!hasExactKeys(reason, ["text", "for_inputs"]) || typeof reason.text !== "string" || !reason.text.trim()) return false;
  const inputs = reason.for_inputs;
  return hasExactKeys(inputs, ["brief_material", "spec_material_hash"]) && wellFormedBriefMaterial(inputs.brief_material) && isFingerprint(inputs.spec_material_hash);
}

// The partitions and spec a stage depends on, compared stamp by stamp. Returns
// "unknown" when a stamp or a current value is missing or malformed, the name
// of the first changed input ("spec" before the brief), or null when equal.
function compareStamps(key, stage, current) {
  const partitions = APPLICABLE_BRIEF_PARTITIONS[key];
  const stamp = stage.source_brief_material;
  const specStamp = stage.source_spec_material_hash;
  if (!wellFormedBriefMaterial(stamp)) return "unknown";
  if (!isFingerprint(specStamp)) return "unknown";
  if (!wellFormedBriefMaterial(current.brief)) return "unknown";
  if (!isFingerprint(current.spec)) return "unknown";
  if (specStamp !== current.spec) return "spec";
  return partitions.find((partition) => stamp[partition] !== current.brief[partition]) || null;
}

// Assembly's unchanged_output_reason holds for the current inputs when its
// for_inputs equal them on every input assembly depends on.
function operatorKeptOutput(stage, current) {
  const inputs = stage.unchanged_output_reason?.for_inputs;
  return isObject(inputs)
    && inputs.spec_material_hash === current.spec
    && APPLICABLE_BRIEF_PARTITIONS.assembly.every((partition) => inputs.brief_material?.[partition] === current.brief?.[partition]);
}

// The capture time of the package page_load attached to Polish, or null.
function polishCaptureTime(stage) {
  const capturedAt = stage.evidence?.visual_review?.page_load?.captured_at;
  return typeof capturedAt === "string" && Number.isFinite(Date.parse(capturedAt)) ? capturedAt : null;
}

/**
 * One stamped stage's currency at read time, by the first rule that holds:
 * an unrecognized status reads unknown; a non-completed status is not
 * applicable; a completed stage with a missing or malformed stamp, an input
 * that cannot be computed, or a malformed input_change or
 * unchanged_output_reason reads unknown; a stamp unequal to the current value
 * reads owed; an assembly whose output is still the build the input change
 * superseded (and no operator decision for these inputs), or a Polish whose
 * capture does not postdate the input change, reads owed; otherwise current.
 */
export function assessStageCurrency(key, stage, current) {
  const record = isObject(stage) ? stage : {};
  const status = typeof record.status === "string" ? record.status : "";
  if (!RECOGNIZED_STAGE_STATUSES.includes(status)) return { currency: "unknown", reason: "status_unrecognized" };
  if (NOT_APPLICABLE_STATUSES.includes(status)) return { currency: "not_applicable", reason: null };
  const compared = compareStamps(key, record, current);
  const malformedChange = Object.hasOwn(record, "input_change") && !inputChangeWellFormed(record.input_change);
  const malformedReason = key === "assembly" && Object.hasOwn(record, "unchanged_output_reason") && !unchangedOutputReasonWellFormed(record.unchanged_output_reason);
  if (compared === "unknown" || malformedChange || malformedReason) return { currency: "unknown", reason: "input_binding_unknown" };
  if (compared) return { currency: "owed", reason: compared === "spec" ? "spec_material_changed" : "brief_material_changed" };
  const change = record.input_change;
  if (key === "assembly" && change
    && optionalString(record.build_fingerprint) === change.superseded_build_fingerprint
    && !operatorKeptOutput(record, current)) {
    return { currency: "owed", reason: "output_unchanged_after_input_change" };
  }
  if (key === "polish" && change) {
    const capturedAt = polishCaptureTime(record);
    if (!capturedAt || Date.parse(capturedAt) <= Date.parse(change.at)) return { currency: "owed", reason: "polish_capture_predates_input_change" };
  }
  return { currency: "current", reason: null };
}

function briefStatus(bound, current) {
  if (isObject(current) && current.presentation === BRIEF_ABSENT && current.qa_policy === BRIEF_ABSENT) return "absent";
  if (!wellFormedBriefMaterial(bound) || !wellFormedBriefMaterial(current)) return "unknown";
  return bound.presentation === current.presentation && bound.qa_policy === current.qa_policy ? "current" : "owed";
}

/**
 * derived.input_currency for a report, given the current inputs:
 * `briefMaterial` = {presentation, qa_policy} (each "sha256:<64 hex>", or the
 * absent value for a packet with no brief; null when it cannot be computed)
 * and `specMaterial` = "sha256:<64 hex>" (null when it cannot be computed).
 */
export function assessInputCurrency({ report, briefMaterial = null, specMaterial = null } = {}) {
  const current = {
    brief: wellFormedBriefMaterial(briefMaterial) ? { presentation: briefMaterial.presentation, qa_policy: briefMaterial.qa_policy } : null,
    spec: specMaterialStamp(specMaterial),
  };
  const boundBrief = isObject(report?.build_brief?.material) ? report.build_brief.material : null;
  const stages = {};
  const reasons = {};
  for (const key of STAMPED_STAGES) {
    const assessed = assessStageCurrency(key, report?.stages?.[key], current);
    stages[key] = assessed.currency;
    reasons[key] = assessed.reason;
  }
  return {
    brief: {
      bound: boundBrief ? JSON.parse(JSON.stringify(boundBrief)) : null,
      current: current.brief,
      status: briefStatus(boundBrief, current.brief),
    },
    spec: {
      bound: optionalString(report?.identity?.spec_material_hash) || null,
      current: current.spec,
    },
    stages,
    reasons,
  };
}

/**
 * The status every effective-status reader uses for a stage. For assembly,
 * polish and qa: the recorded status when the stage is current or not
 * applicable, `required` when owed, `unknown` when unknown. For the other
 * stages, which carry no stamps: the recorded status when it is recognized,
 * otherwise `unknown`.
 */
export function effectiveStageStatus(key, stage, inputCurrency = null) {
  const status = typeof stage?.status === "string" ? stage.status : "";
  if (!STAMPED_STAGES.includes(key)) return RECOGNIZED_STAGE_STATUSES.includes(status) ? status : "unknown";
  const currency = inputCurrency?.stages?.[key];
  if (currency === "current" || currency === "not_applicable") return status;
  if (currency === "owed") return "required";
  return "unknown";
}

export const effectiveStatusIsTerminal = (status) => TERMINAL_EFFECTIVE_STATUSES.includes(status);

// The change a stage's stamps show against the current inputs, as the
// dependency-map cause that wins ("spec", "presentation", "qa_policy"), or
// null. A missing or malformed stamp is not a detected change.
export function detectedStageChange(key, stage, { briefMaterial, specMaterial }) {
  const stamp = stage?.source_brief_material;
  const changed = [];
  const spec = specMaterialStamp(specMaterial);
  if (isFingerprint(stage?.source_spec_material_hash) && spec && stage.source_spec_material_hash !== spec) changed.push("spec");
  if (wellFormedBriefMaterial(stamp) && wellFormedBriefMaterial(briefMaterial)) {
    for (const partition of APPLICABLE_BRIEF_PARTITIONS[key] || []) {
      if (stamp[partition] !== briefMaterial[partition]) changed.push(partition);
    }
  }
  return CAUSE_PRECEDENCE.find((cause) => changed.includes(cause)) || null;
}

// The reason recorded for a set of changed inputs (spec first, then presentation).
export function changeReason(causes) {
  const cause = CAUSE_PRECEDENCE.find((candidate) => causes.includes(candidate));
  return cause ? INPUT_DEPENDENCY_MAP[cause].reason : null;
}

/**
 * The current inputs of a packet, read from disk: the normalized brief's
 * material and the material of the CampaignSpec at spec.local_path (null when
 * it cannot be read).
 */
export function currentPacketInputs({ packet, packetPath }) {
  const localPath = optionalString(packet?.spec?.local_path);
  const specPath = localPath && packetPath ? resolveFromFile(packetPath, localPath) : null;
  let spec = null;
  try {
    spec = specPath && existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) : null;
  } catch {
    spec = null;
  }
  return { briefMaterial: currentBriefMaterial({ packet, packetPath }), specMaterial: currentSpecMaterial(spec) };
}

// True when every stamp `key` depends on equals the current inputs.
export function stampsMatchInputs(key, record, { briefMaterial, specMaterial }) {
  const current = { brief: wellFormedBriefMaterial(briefMaterial) ? briefMaterial : null, spec: specMaterialStamp(specMaterial) };
  return compareStamps(key, isObject(record) ? record : {}, current) === null;
}

// What a stage write needs to detect, carry or clear input_change against
// the current inputs: the reason a replaced record's stamps show a change
// (or null), and whether a record's stamps equal the current inputs.
export function stageWriteInputs(key, inputs) {
  return {
    detectChange: (record) => {
      const cause = detectedStageChange(key, record, inputs);
      return cause ? INPUT_DEPENDENCY_MAP[cause].reason : null;
    },
    stampsCurrent: (record) => stampsMatchInputs(key, record, inputs),
  };
}

/**
 * The bindings intake and record brief write beside a brief result on the
 * packet, the Build Context and the Assembly Report: the material
 * fingerprints, and the sha256 of the brief file's bytes (null for a
 * generated draft).
 */
export function briefIntakeBindings(buildBrief) {
  return {
    material: briefMaterialFingerprint(buildBrief.artifact),
    input_sha256: buildBrief.inputPath ? `sha256:${createHash("sha256").update(readFileSync(buildBrief.inputPath)).digest("hex")}` : null,
  };
}

/**
 * The refresh `next` offers first when a stage reads owed on a stamp:
 * `record brief` for a brief stamp, `record spec` for a spec stamp. Returns
 * the commands (subcommand names) in that order, or [].
 */
export function inputRefreshCommands(inputCurrency) {
  const reasons = Object.values(isObject(inputCurrency?.reasons) ? inputCurrency.reasons : {});
  return [
    ...(reasons.includes("brief_material_changed") ? ["brief"] : []),
    ...(reasons.includes("spec_material_changed") ? ["spec"] : []),
  ];
}

/**
 * derived.input_currency for a doctor read: the report's stamps against the
 * normalized brief and the CampaignSpec on disk now.
 */
export function deriveInputCurrency({ packet, packetPath, report, spec }) {
  return assessInputCurrency({
    report,
    briefMaterial: currentBriefMaterial({ packet, packetPath }),
    specMaterial: currentSpecMaterial(spec),
  });
}
