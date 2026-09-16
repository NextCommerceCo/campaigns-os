// `campaigns-os page-kit sync`: reconcile the target's `_data/campaigns.json`
// entry from the CampaignSpec.
//
// A fresh page-kit scaffold (`campaign-init`) seeds the route's entry with the
// starter family's demo store profile and the family's SDK pin, so doctor
// blocks on `page_kit.store_profile` (demo residue, unwaivable by design) and
// `page_kit.sdk_version` on every first run. The spec already holds every
// value those gates compare against and the gate knows the exact mismatch, so
// the repair is a command rather than a hand edit.
//
// The CampaignSpec is the authority. Exactly the fields the two gates govern
// are written — the nine Store Profile fields and `sdk_version` — and only
// those the spec carries. Everything else in the entry, every other entry, and
// every other file are left as they are. This module is pure: the CLI does
// the reading, the writing, and the printing.
import {
  isDemoResidue,
  normalizeStoreProfileValue,
  PAGE_KIT_STORE_PROFILE_FIELDS,
  storeProfileSpecValueProblem,
} from "./page-kit-store-profile.mjs";
import { resolveSpecSdkPin, sdkPinWriteDecision } from "./page-kit-sdk-version.mjs";

export const PAGE_KIT_SYNC_FIELDS = Object.freeze([...PAGE_KIT_STORE_PROFILE_FIELDS, "sdk_version"]);

// The field-by-field plan: what the entry holds, what the spec says, and
// whether a write is owed. `changes` are the fields whose value will move,
// `unchanged` already match, `not_in_spec` are governed fields the spec does
// not carry (left as they are; doctor's `target_only` warning still applies),
// and `not_synced` are fields the target cannot be made authoritative for: an
// invalid or conflicting spec SDK pin, a spec value of the wrong type or
// shape (or the demo value itself), or starter demo residue in a field the
// spec does not carry. Absent, null and blank spec values are "not carried".
export function planPageKitSync({ spec, entry, waivedGates = [] } = {}) {
  const target = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const changes = [];
  const unchanged = [];
  const notInSpec = [];
  const notSynced = [];
  // A gate under an ACTIVE named-human waiver recorded a human accepting the
  // target's current values; sync must not silently reverse that decision.
  // Its fields are reported as not synced (naming who waived) and left as
  // they are; the waiver stays in force.
  const waivedBy = new Map(
    (Array.isArray(waivedGates) ? waivedGates : [])
      .filter((gate) => gate && typeof gate === "object" && typeof gate.scope === "string")
      .map((gate) => [gate.scope, gate.waived_by || "a named human"]),
  );
  const storeProfileWaiver = waivedBy.get("page_kit.store_profile") || null;
  const sdkWaiver = waivedBy.get("page_kit.sdk_version") || null;
  const waivedDetail = (field, who, scope) => `${field} is covered by an active ${scope} waiver recorded by ${who}; page-kit sync leaves the target as the waiver accepted it. Withdraw the waiver on the Assembly Report (waivers[]) to let sync write the spec value.`;

  const NOT_SYNCED_DETAIL = {
    spec_invalid_type: (field, raw) => `CampaignSpec campaign.${field} is ${Array.isArray(raw) ? "an array" : `a ${raw === null ? "null" : typeof raw}`}, not a string; doctor blocks on it as spec_invalid_type. Fix the spec, then sync again.`,
    control_characters: (field) => `CampaignSpec campaign.${field} contains control characters; remove them, then sync again.`,
    demo_residue: (field, raw) => `CampaignSpec campaign.${field} is itself the starter demo value ${JSON.stringify(raw)}; doctor blocks on demo residue without a waiver. Replace it in the spec, then sync again.`,
    not_http_url: (field, raw) => `CampaignSpec campaign.${field} ${JSON.stringify(raw)} is not an http(s) URL${field === "store_contact" ? " or mailto: address" : ""}; templates place it in an href, so no other scheme is written. Fix the spec, then sync again.`,
    not_tel_uri: (field, raw) => `CampaignSpec campaign.${field} ${JSON.stringify(raw)} is not a tel: URI of digits, spaces, dashes, parens and dots (e.g. "tel:+18005551234"). Fix the spec, then sync again.`,
  };

  for (const field of PAGE_KIT_STORE_PROFILE_FIELDS) {
    const raw = spec?.campaign?.[field];
    const current = Object.hasOwn(target, field) ? target[field] : undefined;
    const carried = raw !== undefined && raw !== null && !(typeof raw === "string" && !raw.trim());
    if (!carried) {
      // Starter demo residue in a field the spec does not carry is the one
      // state sync cannot end: doctor blocks on it without a waiver and there
      // is no spec value to write over it. Say so instead of reporting a
      // clean "left as it is".
      if (typeof current === "string" && isDemoResidue(field, normalizeStoreProfileValue(current))) {
        notSynced.push({
          field,
          reason: "demo_residue_not_in_spec",
          detail: `the target still holds the starter demo value ${JSON.stringify(current)} and the CampaignSpec does not carry campaign.${field}; add it to the spec (doctor blocks on demo residue without a waiver), then sync again.`,
        });
      } else {
        notInSpec.push(field);
      }
      continue;
    }
    // A carried value the target cannot be made authoritative for: the wrong
    // type (doctor's spec_invalid_type), the demo value itself, or a shape a
    // template would put into an href unescaped.
    const problem = typeof raw !== "string" ? "spec_invalid_type" : storeProfileSpecValueProblem(field, raw);
    if (problem) {
      notSynced.push({ field, reason: problem, detail: NOT_SYNCED_DETAIL[problem](field, raw) });
      continue;
    }
    const after = normalizeStoreProfileValue(raw);
    const before = current;
    const row = { field, before, after, source: `campaign.${field}` };
    // The gate compares normalized forms, so a target that differs only in
    // surrounding whitespace or Unicode normalization already passes; a
    // rewrite would report a change doctor never saw.
    const alreadyMatches = before === after
      || (typeof before === "string" && normalizeStoreProfileValue(before) === after);
    if (alreadyMatches) unchanged.push(row);
    else if (storeProfileWaiver) notSynced.push({ field, reason: "waived", detail: waivedDetail(field, storeProfileWaiver, "page_kit.store_profile") });
    else changes.push(row);
  }

  // A conflicting canonical/alias pair or a non-released pin is a spec defect
  // the gate blocks on without a waiver; the target cannot be made
  // authoritative for it, so it is reported as not synced, never written.
  const sdk = resolveSpecSdkPin(spec);
  if (sdk.status === "ok") {
    const before = Object.hasOwn(target, "sdk_version") ? target.sdk_version : undefined;
    const row = { field: "sdk_version", before, after: sdk.value, source: sdk.source };
    if (before === sdk.value) unchanged.push(row);
    else if (sdkWaiver) notSynced.push({ field: "sdk_version", reason: "waived", detail: waivedDetail("sdk_version", sdkWaiver, "page_kit.sdk_version") });
    else if (sdkPinWriteDecision({ expected: sdk.value, observed: before, entry: target }) === "target_newer") {
      // A configured campaign whose repo pin is ahead of the spec: the bump
      // happened in the repo and the Map/spec is stale. Writing the spec's
      // pin would undo it silently.
      notSynced.push({
        field: "sdk_version",
        reason: "target_newer",
        detail: `the target pin ${before} is newer than the CampaignSpec pin ${sdk.value} and the entry is no longer in scaffold state; the repo pin moved and the Map/spec is stale. Doctor treats the repo pin as what ships and reports this as a warning, not a blocker; re-save the Map (or edit the spec) to ${before} to clear it. page-kit sync only seeds the pin after a scaffold and never moves a configured campaign's pin backwards.`,
      });
    } else changes.push(row);
  } else if (sdk.status === "spec_missing") {
    notInSpec.push("sdk_version");
  } else {
    notSynced.push({
      field: "sdk_version",
      reason: sdk.status,
      detail: sdk.status === "spec_conflict"
        ? "CampaignSpec global_config.sdk_version and runtime.sdk_version disagree; resolve the spec (global_config is canonical), then sync again."
        : "CampaignSpec SDK pin is not a released MAJOR.MINOR.PATCH version; correct the spec, then sync again.",
    });
  }

  return { changes, unchanged, not_in_spec: notInSpec, not_synced: notSynced };
}

// Apply a plan to the parsed campaigns.json document. Mutates ONLY the
// governed fields on the named entry, in place, so the entry's key order and
// every other key survive; a field the entry lacks is appended. Returns the
// same document object.
export function applyPageKitSync(campaigns, publicRouteSlug, plan) {
  if (!campaigns || typeof campaigns !== "object" || Array.isArray(campaigns)) {
    throw new Error("campaigns.json root must be an object keyed by public route slug.");
  }
  const entry = campaigns[publicRouteSlug];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`campaigns.json has no object entry for "${publicRouteSlug}".`);
  }
  for (const change of plan.changes) {
    if (!PAGE_KIT_SYNC_FIELDS.includes(change.field)) {
      throw new Error(`Refusing to write "${change.field}": page-kit sync governs only ${PAGE_KIT_SYNC_FIELDS.join(", ")}.`);
    }
    entry[change.field] = change.after;
  }
  return campaigns;
}

// One line per field for the printed diff. `undefined` (the entry had no such
// key) prints as (absent); everything else is JSON so a string that merely
// looks empty is visibly quoted.
export function formatSyncValue(value) {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}
