import {
  assessCheckpointWaivers,
  checkpointStateFingerprint,
  projectCheckpointWaiverAssessment,
} from "./checkpoint-waiver.mjs";
import { PAGE_KIT_CAMPAIGNS_REL_PATH } from "./page-kit-campaign-config.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";

// The canonical bare spelling of the reconcile command both page-kit gates
// name as their target repair (implemented in page-kit-sync.mjs, which imports
// this module and so cannot be imported here). Printers spell it for the
// running install (gate-actions.mjs).
export const PAGE_KIT_SYNC_COMMAND = "campaigns-os page-kit sync --packet <packet>";

export const PAGE_KIT_STORE_PROFILE_SCOPE = "page_kit.store_profile";
export const PAGE_KIT_STORE_PROFILE_FIELDS = Object.freeze([
  "store_name",
  "store_url",
  "store_terms",
  "store_privacy",
  "store_contact",
  "store_returns",
  "store_shipping",
  "store_phone",
  "store_phone_tel",
]);

const URL_FIELDS = new Set([
  "store_url",
  "store_terms",
  "store_privacy",
  "store_contact",
  "store_returns",
  "store_shipping",
]);
const PHONE_FIELDS = new Set(["store_phone", "store_phone_tel"]);
const MISSING_TARGET_STATUSES = new Set(["target_repo_missing", "file_missing", "entry_missing"]);

// The comparison form of a Store Profile string: NFC-normalized and trimmed.
// `page-kit sync` writes exactly this form, so what it writes is what the
// matrix below reads back as a match.
export function normalizeStoreProfileValue(value) {
  return value.normalize("NFC").trim();
}

function normalizeFieldValue(value) {
  if (value == null) return { valid: true, value: "" };
  if (typeof value !== "string") {
    const type = Array.isArray(value) ? "array" : typeof value;
    return { valid: false, value: `[invalid:${type}]` };
  }
  return { valid: true, value: normalizeStoreProfileValue(value) };
}

export function isDemoResidue(field, value) {
  if (!value) return false;
  if (URL_FIELDS.has(field)) {
    try {
      return new URL(value).hostname.toLocaleLowerCase("en-US") === "demo.29next.com";
    } catch {
      return false;
    }
  }
  return PHONE_FIELDS.has(field) && value.replace(/\D/g, "") === "18888316810";
}

// A waiver records a named human accepting one of the ratified known
// divergences. Keep this as a positive allowlist: any future blocker kind is
// non-waivable until its policy and reachability proof are explicitly added.
// Starter demo residue (a demo storefront URL or phone still in the target) is
// deliberately absent: the gate exists to keep those values from shipping, so
// no named human can switch it off — the value must be replaced.
const WAIVABLE_DISCREPANCY_KINDS = new Set([
  "target_missing",
  "mismatch",
]);

// Blocker kinds `page-kit sync` repairs by writing the spec's value over the
// target's: the target is wrong, missing, malformed, or still the starter
// demo value. A spec-side defect (spec_invalid_type, both_invalid_type) is
// repaired in the spec, not the target, so sync is not the recovery there;
// neither is demo residue in a field the spec does not carry, because sync
// has nothing to write over it (see syncRepairsRow).
const SYNC_REPAIRABLE_KINDS = new Set([
  "demo_residue",
  "target_missing",
  "mismatch",
  "target_invalid_type",
]);

// The tel: shape the campaign-spec StoreProfileShape rule accepts (optional
// +, then digits / space / dash / parens / dot); anything else, including an
// alternative scheme, is refused as a value for an <a href>.
const TEL_URI_REGEX = /^tel:\+?[0-9 .()\-]{4,}$/i;

// Why a spec value cannot be written into the target as it stands, or null
// when it can. `page-kit sync` refuses these and the gate does not name sync
// as the repair for them: a URL field must be an http(s) URL and the tel
// field a tel: URI, because templates put both into href attributes where
// escaping does not neutralize an executable scheme; no field may carry
// control characters; and the starter demo value is never a repair.
export function storeProfileSpecValueProblem(field, value) {
  if (typeof value !== "string" || !value.trim()) return "missing";
  const normalized = normalizeStoreProfileValue(value);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return "control_characters";
  if (isDemoResidue(field, normalized)) return "demo_residue";
  if (URL_FIELDS.has(field)) {
    try {
      const url = new URL(normalized);
      // store_contact is the one field templates render as a contact link,
      // where a mailto: address is an ordinary value.
      const allowed = url.protocol === "https:" || url.protocol === "http:" || (field === "store_contact" && url.protocol === "mailto:");
      if (!allowed) return "not_http_url";
    } catch {
      return "not_http_url";
    }
  }
  if (field === "store_phone_tel" && !TEL_URI_REGEX.test(normalized)) return "not_tel_uri";
  return null;
}

// The edit a blocked row needs when sync cannot make it: a target-side
// defect with no spec value behind it (a demo or malformed target value in a
// field the spec does not carry) is corrected in the target, or the field is
// added to the spec and synced; a present-but-unusable spec value is
// corrected in the spec.
function repairDescriptionForUnsyncableRows(rows, subject) {
  const where = `${subject.target_path}[${subject.public_route_slug}]`;
  const targetSide = rows.filter((row) => storeProfileSpecValueProblem(row.field, row.spec) === "missing");
  const specSide = rows.filter((row) => storeProfileSpecValueProblem(row.field, row.spec) !== "missing");
  const parts = [];
  if (targetSide.length) {
    parts.push(`Remove or correct ${where}.${targetSide.map((row) => row.field).join(", ")} (the CampaignSpec does not carry ${targetSide.length === 1 ? "this field" : "these fields"}, so page-kit sync has nothing to write over the target), or add campaign.${targetSide.map((row) => row.field).join(", campaign.")} to the spec and run page-kit sync.`);
  }
  if (specSide.length) {
    parts.push(`Repair the CampaignSpec Store Profile field(s) ${specSide.map((row) => `${row.field} (${storeProfileSpecValueProblem(row.field, row.spec)})`).join(", ")}: page-kit sync writes only a well-shaped, non-demo spec value over the target. Fix the spec, then run page-kit sync.`);
  }
  return `${parts.join(" ")} Then re-run doctor.`;
}

// Sync repairs a row by writing the spec's value over the target's, so it
// needs a usable spec value: present, well-shaped for its field, and not the
// starter demo value itself. matrixRow puts demo_residue ahead of the spec
// comparison, so a residue row may have an empty (or itself demo) spec value.
function syncRepairsRow(row) {
  return SYNC_REPAIRABLE_KINDS.has(row.kind) && storeProfileSpecValueProblem(row.field, row.spec) === null;
}

export function storeProfileDemoResidueFields(gate) {
  const discrepancies = Array.isArray(gate?.state?.discrepancies) ? gate.state.discrepancies : [];
  return discrepancies.filter((row) => row?.kind === "demo_residue").map((row) => row.field);
}

export function isStoreProfileDiscrepancyWaivable(kind) {
  return typeof kind === "string" && WAIVABLE_DISCREPANCY_KINDS.has(kind);
}

function matrixRow(field, rawSpec, rawTarget) {
  const spec = normalizeFieldValue(rawSpec);
  const target = normalizeFieldValue(rawTarget);
  if (!spec.valid && !target.valid) {
    return { field, kind: "both_invalid_type", spec: spec.value, target: target.value, severity: "blocker" };
  }
  if (!spec.valid) {
    return { field, kind: "spec_invalid_type", spec: spec.value, target: target.value, severity: "blocker" };
  }
  if (!target.valid) {
    return { field, kind: "target_invalid_type", spec: spec.value, target: target.value, severity: "blocker" };
  }
  if (isDemoResidue(field, target.value)) {
    return { field, kind: "demo_residue", spec: spec.value, target: target.value, severity: "blocker" };
  }
  if (spec.value && !target.value) {
    return { field, kind: "target_missing", spec: spec.value, target: target.value, severity: "blocker" };
  }
  if (spec.value && target.value && spec.value !== target.value) {
    return { field, kind: "mismatch", spec: spec.value, target: target.value, severity: "blocker" };
  }
  if (!spec.value && target.value) {
    return { field, kind: "target_only", spec: spec.value, target: target.value, severity: "warning" };
  }
  if (spec.value && target.value) {
    return { field, kind: "match", spec: spec.value, target: target.value, severity: "clean" };
  }
  return { field, kind: "both_empty", spec: spec.value, target: target.value, severity: "clean" };
}

function unavailableMatrix(specCampaign, required) {
  return PAGE_KIT_STORE_PROFILE_FIELDS.map((field) => {
    const spec = normalizeFieldValue(specCampaign?.[field]);
    return {
      field,
      kind: "target_unavailable",
      spec: spec.value,
      target: null,
      severity: required ? "blocker" : "info",
    };
  });
}

function emptyWaiverAssessment() {
  return {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  };
}

export function evaluatePageKitStoreProfile({
  specCampaign,
  specStatus = "ok",
  targetLoad,
  waivers = [],
  required = true,
  now = new Date().toISOString(),
} = {}) {
  const subject = {
    public_route_slug: normalizePublicRouteSlug(targetLoad?.public_route_slug),
    target_path: targetLoad?.target_path || PAGE_KIT_CAMPAIGNS_REL_PATH,
  };
  const loadStatus = targetLoad?.status || "target_repo_missing";

  if (specStatus !== "ok") {
    return {
      id: PAGE_KIT_STORE_PROFILE_SCOPE,
      scope: PAGE_KIT_STORE_PROFILE_SCOPE,
      status: "blocked",
      code: "page_kit.store_profile.spec_unavailable",
      reason: `Local CampaignSpec Store Profile is unavailable or malformed (${specStatus}); packet QA never fetches around missing local parity evidence.`,
      waivable: false,
      subject,
      state: { spec_status: specStatus, discrepancies: [] },
      state_fingerprint: null,
      matrix: PAGE_KIT_STORE_PROFILE_FIELDS.map((field) => ({
        field,
        kind: "spec_unavailable",
        spec: null,
        target: loadStatus === "ok" ? normalizeFieldValue(targetLoad.entry?.[field]).value : null,
        severity: "blocker",
      })),
      blocker_fields: [...PAGE_KIT_STORE_PROFILE_FIELDS],
      warning_fields: [],
      waiver: null,
      waiver_assessment: emptyWaiverAssessment(),
      required_actions: [{
        id: "repair_spec",
        kind: "edit",
        command: null,
        description: "Restore a valid packet-local CampaignSpec export before QA.",
      }],
    };
  }

  if (loadStatus !== "ok") {
    const optionalMissing = !required && MISSING_TARGET_STATUSES.has(loadStatus);
    return {
      id: PAGE_KIT_STORE_PROFILE_SCOPE,
      scope: PAGE_KIT_STORE_PROFILE_SCOPE,
      status: optionalMissing ? "not_applicable" : "blocked",
      code: optionalMissing ? "page_kit.store_profile.not_applicable" : "page_kit.store_profile.target_unavailable",
      reason: optionalMissing
        ? `Target ${subject.target_path} entry is not present before scaffold; Store Profile parity will become required once the target exists.`
        : `Target ${subject.target_path} entry is unavailable or malformed (${loadStatus}); packet build/QA requires an exact Store Profile target.`,
      waivable: false,
      subject,
      state: { target_status: loadStatus, discrepancies: [] },
      state_fingerprint: null,
      matrix: unavailableMatrix(specCampaign, !optionalMissing),
      blocker_fields: optionalMissing ? [] : [...PAGE_KIT_STORE_PROFILE_FIELDS],
      warning_fields: [],
      waiver: null,
      waiver_assessment: emptyWaiverAssessment(),
      required_actions: optionalMissing ? [] : [{
        id: "repair_target",
        kind: "edit",
        command: null,
        description: `Create or repair ${subject.target_path}[${subject.public_route_slug || "<public-route-slug>"}] before build or QA.`,
      }],
    };
  }

  const matrix = PAGE_KIT_STORE_PROFILE_FIELDS.map((field) => matrixRow(field, specCampaign?.[field], targetLoad.entry?.[field]));
  const discrepancies = matrix
    .filter((row) => row.severity === "blocker" || row.severity === "warning")
    .map(({ field, kind, spec, target }) => ({ field, kind, spec, target }));
  const state = { discrepancies };
  const state_fingerprint = checkpointStateFingerprint({
    scope: PAGE_KIT_STORE_PROFILE_SCOPE,
    subject,
    state,
  });
  const blocker_fields = matrix.filter((row) => row.severity === "blocker").map((row) => row.field);
  const warning_fields = matrix.filter((row) => row.severity === "warning").map((row) => row.field);
  const blockerRows = matrix.filter((row) => row.severity === "blocker");
  const waivable = blockerRows.length > 0
    && blockerRows.every((row) => isStoreProfileDiscrepancyWaivable(row.kind));
  // Waiver history matters only while this exact checkpoint is blocked. Once
  // correction removes every blocker (including a target-only warning state),
  // historical decisions stay in the report but must not become stale-warning
  // evidence on an otherwise clean current gate.
  const checkpoint = {
    scope: PAGE_KIT_STORE_PROFILE_SCOPE,
    subject,
    state_fingerprint,
  };
  const waiver_assessment = blocker_fields.length
    ? projectCheckpointWaiverAssessment(
      assessCheckpointWaivers(waivers, checkpoint, { now }),
      checkpoint,
    )
    : emptyWaiverAssessment();
  const waiver = blocker_fields.length && waivable ? waiver_assessment.active : null;
  const status = blocker_fields.length ? (waiver ? "waived" : "blocked") : "pass";
  const code = status === "waived"
    ? "page_kit.store_profile.waived"
    : status === "blocked"
      ? PAGE_KIT_STORE_PROFILE_SCOPE
      : warning_fields.length
        ? "page_kit.store_profile.target_only"
        : "page_kit.store_profile.pass";
  const demoResidueFields = blockerRows.filter((row) => row.kind === "demo_residue").map((row) => row.field);
  const reason = status === "blocked"
    ? `Target Store Profile differs from the CampaignSpec in blocking field(s): ${blocker_fields.join(", ")}.`
      + (demoResidueFields.length
        ? ` Starter demo residue in ${demoResidueFields.join(", ")} is not waivable; replace the demo value(s).`
        : "")
    : status === "waived"
      ? `Target Store Profile has an active named-human waiver for blocking field(s): ${blocker_fields.join(", ")}.`
      : warning_fields.length
        ? `Target Store Profile has target-only value(s): ${warning_fields.join(", ")}.`
        : "Target Store Profile exactly matches the CampaignSpec for all nine governed fields.";
  return {
    id: PAGE_KIT_STORE_PROFILE_SCOPE,
    scope: PAGE_KIT_STORE_PROFILE_SCOPE,
    status,
    code,
    reason,
    waivable,
    subject,
    state,
    state_fingerprint,
    matrix,
    blocker_fields,
    warning_fields,
    waiver,
    waiver_assessment,
    required_actions: status === "blocked" ? [
      blockerRows.every(syncRepairsRow)
        ? {
          id: "repair_target",
          kind: "command",
          command: PAGE_KIT_SYNC_COMMAND,
          description: `Write the CampaignSpec Store Profile values into ${subject.target_path}[${subject.public_route_slug}] (${blocker_fields.join(", ")}), then re-run doctor.`,
        }
        : {
          id: "repair_target",
          kind: "edit",
          command: null,
          description: repairDescriptionForUnsyncableRows(blockerRows.filter((row) => !syncRepairsRow(row)), subject),
        },
      ...(waivable ? [{
        id: "waive_checkpoint",
        kind: "command",
        command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.store_profile --reason \"<reason>\" --waived-by \"<named human>\" --review-condition \"<re-evaluation trigger>\"",
        description: "Record an explicit bounded named-human I-16 exception for this exact state when correction is intentionally deferred.",
      }] : []),
    ] : [],
  };
}
