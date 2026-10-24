import { normalizeDesignFileReference, resolveDesignFileReferences } from "../design-file-reference.mjs";
import { buildQcResult } from "../qc-results.mjs";

const array = (value) => Array.isArray(value) ? value : [];

function recordedType(contribution, fileRef) {
  const type = fileRef?.design_file_type;
  if (typeof type === "string" && type.trim()) return type;
  return ["figma_frames", "figma_sections"].includes(contribution?.kind) ? "figma" : "other";
}

// Recomputed from declarations and package records; a named file never proves
// access. In particular this evaluator has no pass or accept-eligible path.
export function evaluateDesignAccess({ activePages = [], mappings = [], manifest = null, designSourcePackage = null, measured_at } = {}) {
  const contributions = Array.isArray(designSourcePackage?.contributions) ? designSourcePackage.contributions : [];
  const surfaces = Array.isArray(designSourcePackage?.surface_identity) ? designSourcePackage.surface_identity : [];
  const recordedPageIds = new Set();
  const recordedByPage = new Map(activePages.map((page) => {
    const surfaceIds = new Set(surfaces.filter((surface) => surface?.kind === "page" && surface.mappings?.campaign_spec_page_id === page.id).map((surface) => surface.id));
    const recorded = contributions.find((contribution) => contribution?.provenance?.source_type === "design_file" && array(contribution.mappings).some((mapping) => surfaceIds.has(mapping?.surface_id)));
    if (recorded && contributions.some((contribution) => array(contribution?.mappings).some((mapping) => surfaceIds.has(mapping?.surface_id) && mapping?.derived_from === recorded.id))) {
      recordedPageIds.add(page.id);
    }
    return [page.id, recorded];
  }));
  const resolved = resolveDesignFileReferences({ activePages, mappings, manifest, specChannel: {
    mode: "doctor",
    recordedPageIds,
  } });
  const rows = [];
  for (const page of activePages) {
    const current = resolved.pages.find((entry) => entry.page_id === page.id);
    const recorded = recordedByPage.get(page.id);
    if (!current && !recorded) continue;
    const fileRef = array(recorded?.source_refs).find((ref) => ref?.role === "design_file");
    const previous = normalizeDesignFileReference({ type: recordedType(recorded, fileRef), file_url: fileRef?.url }).declaration;
    const declaredSha = current?.declaration.file_identity_sha256 ?? null;
    const recordedSha = previous?.file_identity_sha256 ?? null;
    const reason_code = current?.conflict ? "design_reference_conflict"
      : recorded && !current ? "design_reference_missing"
        : recorded && declaredSha !== recordedSha ? "design_reference_changed"
        : !recorded ? "design_reference_not_recorded" : "design_access_missing";
    const result = ["design_reference_conflict", "design_reference_missing", "design_reference_changed"].includes(reason_code) ? "review" : "unexercised";
    const state = { reason_code, recorded_identity_sha256: recordedSha, declared_identity_sha256: declaredSha, conflict_identities: [...(current?.conflict?.identities || [])].sort(), conflict_frames: [...(current?.conflict?.frames || [])].sort() };
    const observation = {
      type: current?.declaration.type ?? previous?.type ?? null,
      kind: current?.conflict?.kind ?? null,
      declared_by: current?.declared_by ?? null,
      frames_declared: Object.keys(current?.declaration.frames || {}).sort(), reader: "none", recorded_contribution_id: recorded?.id ?? null,
    };
    rows.push({ ...buildQcResult({ check: "design.access", leg: "doctor", subject: { check: "design.access", page: page.id, key: "file" }, result, reason_code, state, observation, accept_eligible: false, measured_at }), state });
  }
  return rows;
}
