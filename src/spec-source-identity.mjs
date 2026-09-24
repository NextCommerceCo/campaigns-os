// Stable campaign identity is separate from both the public route and the
// material spec hash. Local IDs never identify a saved Map or a portal URL.
export const LOCAL_SPEC_ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";
const localIdPattern = new RegExp(LOCAL_SPEC_ID_PATTERN);
const text = value => typeof value === "string" && value.trim() ? value.trim() : null;

export function campaignSpecIdentity(spec) {
  return {
    map_id: spec?.spec_identity?.map_id ?? spec?.map_id ?? null,
    local_spec_id: spec?.spec_identity?.local_spec_id ?? null,
  };
}

export function resolveCampaignIdentity(fields) {
  // Saved Map IDs retain their existing whitespace normalization. Local IDs
  // are canonical, repository-owned tokens: never trim one into another ID.
  const mapId = text(fields?.map_id);
  const localId = fields?.local_spec_id;
  if (localId != null) {
    if (fields?.map_id != null || typeof localId !== "string" || !localIdPattern.test(localId)) return null;
    return { kind: "local_spec", id: localId };
  }
  return mapId ? { kind: "saved_map", id: mapId } : null;
}

export function campaignIdentitiesMatch(left, right) {
  const a = resolveCampaignIdentity(left);
  const b = resolveCampaignIdentity(right);
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

export function localSpecIdentityFields(fields) {
  if (fields?.local_spec_id == null) return {};
  const identity = resolveCampaignIdentity(fields);
  // Omitting a malformed marker would let a conflicting identity fall back to
  // its Map ID. Writers must refuse it rather than silently change its kind.
  if (identity?.kind !== "local_spec") throw new Error("Invalid local_spec_id or conflicting saved Map identity.");
  return { local_spec_id: identity.id };
}

export function localQaIdentifier(localSpecId) {
  if (typeof localSpecId !== "string" || !localIdPattern.test(localSpecId)) throw new Error("Invalid local_spec_id.");
  return `local-spec-${localSpecId}`;
}
