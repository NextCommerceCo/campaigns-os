// Template certification freshness (#263): surface, per certified family, the
// SDK version the family was last verified against and its delta from the
// current SDK — in the places an operator already looks (the certified-template
// gate output and standardization/doctor reporting).
//
// Data source discipline: everything here reads the VENDORED contract set —
// the commerce surface catalog snapshot (which the refresh script now stamps
// with per-family `verification` blocks copied from the starter repo's
// template-verification.json at the same pinned `_synced_from_sha`) and the
// vendored SDK support policy. No live fetches, no new data source.
//
// "Current SDK" definition: the newest released Campaign Cart SDK the vendored
// contracts record — the semver maximum over the SDK support policy's
// `provenance.latest_known_release` and every family verification record's
// `sdk_version` in the catalog snapshot. A verification record itself proves
// that release exists, so the definition can never call a family "ahead" of a
// release the snapshot already documents. The campaign's own pinned SDK is a
// different question (owned by the page_kit.sdk_version checkpoint) and is
// deliberately not folded into this definition.
//
// Doctrine (portal copy + docs): output must say which SDK is current and
// which SDK was last verified; an older evidence record is not current
// certification.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SDK_SUPPORT_POLICY_PATH = "contracts/campaign-cart-sdk-support-policy.v0.json";

// Parse a released "major.minor.patch" SDK version. Returns null for anything
// else (pre-releases, ranges, missing values) — freshness only ever compares
// released versions, mirroring the strict pin the CampaignSpec rule enforces.
export function parseSdkVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Standard semver ordering over released versions. Returns null when either
// side does not parse, so callers degrade to "unknown" instead of guessing.
export function compareSdkVersions(a, b) {
  const left = parseSdkVersion(a);
  const right = parseSdkVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// Best-effort read of the vendored SDK support policy. Absent or malformed
// policy degrades freshness to whatever the catalog verification records
// prove — it never throws, because freshness reporting must not block a gate.
export function defaultSdkSupportPolicy() {
  const path = join(ROOT, ...SDK_SUPPORT_POLICY_PATH.split("/"));
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// The family's verification record as vendored on the catalog snapshot.
// Returns null when the snapshot carries none for this family (private
// families resolved from fragments, or a snapshot predating the verification
// sync) — the caller reports that honestly as unknown freshness.
export function familyVerification(catalog, family) {
  const record = catalog?.families?.[String(family || "")]?.verification;
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (!parseSdkVersion(record.sdk_version)) return null;
  return {
    sdk_version: record.sdk_version,
    verified_at: typeof record.verified_at === "string" ? record.verified_at : null,
    evidence: typeof record.evidence === "string" ? record.evidence : null,
    status: typeof record.status === "string" ? record.status : null,
  };
}

// "Current SDK" per the definition at the top of this file. Returns
// { version, source } or null when the vendored contracts record no released
// SDK at all.
export function resolveCurrentSdkVersion({ catalog, sdkSupportPolicy } = {}) {
  let best = null;
  const consider = (version, source) => {
    if (!parseSdkVersion(version)) return;
    if (!best || compareSdkVersions(version, best.version) === 1) {
      best = { version, source };
    }
  };
  consider(sdkSupportPolicy?.provenance?.latest_known_release, "sdk_support_policy.latest_known_release");
  for (const [family, entry] of Object.entries(catalog?.families || {})) {
    consider(entry?.verification?.sdk_version, `catalog_verification:${family}`);
  }
  return best;
}

// One assessment per family: what the snapshot proves, what "current" is, and
// the relation between them. States:
//   current — last verified against exactly the current SDK
//   stale   — last verified against an OLDER SDK than current
//   ahead   — verified newer than current (defensive: impossible under the
//             default current-SDK definition, reachable with injected inputs)
//   unknown — no verification record, or no current SDK to compare against
export function assessTemplateFreshness({ family, catalog, sdkSupportPolicy } = {}) {
  const verification = familyVerification(catalog, family);
  const current = resolveCurrentSdkVersion({ catalog, sdkSupportPolicy });
  const base = {
    family: String(family || ""),
    verified_sdk_version: verification?.sdk_version || null,
    verified_at: verification?.verified_at || null,
    current_sdk_version: current?.version || null,
    current_sdk_source: current?.source || null,
    delta: null,
  };
  if (!verification || !current) return { ...base, state: "unknown" };
  const order = compareSdkVersions(verification.sdk_version, current.version);
  if (order === null) return { ...base, state: "unknown" };
  const state = order === 0 ? "current" : order < 0 ? "stale" : "ahead";
  return { ...base, state, delta: describeVersionDelta(verification.sdk_version, current.version) };
}

// Human description of the version gap. For a shared major.minor line the
// patch-number gap is exact version arithmetic ("3 patch versions behind");
// across minor/major lines only the two versions themselves are honest.
function describeVersionDelta(verified, current) {
  const from = parseSdkVersion(verified);
  const to = parseSdkVersion(current);
  if (!from || !to) return null;
  if (from[0] === to[0] && from[1] === to[1]) {
    const gap = to[2] - from[2];
    if (gap === 0) return "0 patch versions";
    const magnitude = Math.abs(gap);
    return `${magnitude} patch version${magnitude === 1 ? "" : "s"} ${gap > 0 ? "behind" : "ahead"}`;
  }
  return `${verified} vs ${current}`;
}

// The single freshness line every operator surface prints, so the gate, the
// doctor, and the standardization report can never tell different stories.
export function renderTemplateFreshness(assessment) {
  const { family, state, verified_sdk_version, verified_at, current_sdk_version, delta } = assessment || {};
  const verifiedAtSuffix = verified_at ? ` (${verified_at.slice(0, 10)})` : "";
  switch (state) {
    case "current":
      return `Template family "${family}" certification is current: last verified against SDK ${verified_sdk_version}${verifiedAtSuffix}, the current SDK recorded by the vendored contracts.`;
    case "stale":
      return `Template family "${family}" was last verified against SDK ${verified_sdk_version}${verifiedAtSuffix}; the current SDK is ${current_sdk_version}${delta ? ` (${delta})` : ""}. An older evidence record is not current certification — treat the family as pending re-verification against ${current_sdk_version}.`;
    case "ahead":
      return `Template family "${family}" was last verified against SDK ${verified_sdk_version}${verifiedAtSuffix}, which is newer than the current SDK ${current_sdk_version} recorded by the vendored contracts; refresh the SDK support policy capture.`;
    default:
      return `Template family "${family}" has no verification record in the vendored catalog snapshot${current_sdk_version ? ` (current SDK: ${current_sdk_version})` : ""}; certification freshness is unknown. An older evidence record is not current certification — confirm the family's last-verified SDK before relying on it.`;
  }
}
