/**
 * sdk-version-parse — the ONE strict released-SDK-version parser.
 *
 * Extracted from the Page Kit SDK-version checkpoint (src/page-kit-sdk-version.mjs)
 * so authoring-time validation (the SdkVersion rule) and build-time gating
 * (the checkpoint) reject exactly the same values. The acceptance predicate is
 * the checkpoint's original one, unchanged: a plain string in canonical
 * released `MAJOR.MINOR.PATCH` form — no leading zeros, no `v` prefix, no
 * surrounding whitespace, no prerelease or build-metadata suffix, nothing but
 * the three dot-separated numeric components.
 *
 * Dependency-free and browser-bundle-safe on purpose: the Map Builder bundles
 * the campaign-spec module via esbuild, so nothing in here may import node
 * builtins.
 */

/**
 * Canonical released semver: MAJOR.MINOR.PATCH, each component `0` or a
 * non-zero-leading integer. Identical to the pattern the Page Kit checkpoint
 * shipped with — this constant is now its single home.
 */
export const RELEASED_SDK_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Why a value was rejected. Diagnostic detail only — every reason is equally fatal. */
export type SdkVersionRejectionReason =
  | 'non-string' // numbers, null, objects, booleans — anything not a string
  | 'empty' // "" or whitespace-only
  | 'padded' // would be canonical after trimming (" 0.4.37 ")
  | 'prerelease-or-build' // canonical core with a -prerelease or +build suffix ("0.4.37-beta.1")
  | 'non-canonical' // everything else: "v" prefix, leading zeros, missing components, garbage

export type SdkVersionParseResult =
  | { ok: true; version: string }
  | { ok: false; reason: SdkVersionRejectionReason }

/**
 * Parse a candidate SDK version strictly. Never normalizes: a value either IS
 * the canonical released form or it is rejected — the reason is diagnostic
 * classification for error messages, not a repair hint the parser acts on.
 */
export function parseSdkVersion(value: unknown): SdkVersionParseResult {
  if (typeof value !== 'string') return { ok: false, reason: 'non-string' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (RELEASED_SDK_VERSION_PATTERN.test(value)) return { ok: true, version: value }
  if (value !== trimmed && RELEASED_SDK_VERSION_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'padded' }
  }
  // Classify against the trimmed form so a padded prerelease ("  0.4.37-beta.1 ")
  // reports the substantive rejection (the suffix) rather than 'non-canonical'.
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)[-+]/.test(trimmed)) {
    return { ok: false, reason: 'prerelease-or-build' }
  }
  return { ok: false, reason: 'non-canonical' }
}

/**
 * Boolean form of parseSdkVersion — drop-in for the checkpoint's original
 * `isReleasedSemver` predicate.
 */
export function isReleasedSdkVersion(value: unknown): value is string {
  return typeof value === 'string' && RELEASED_SDK_VERSION_PATTERN.test(value)
}

const REJECTION_DETAIL: Record<SdkVersionRejectionReason, string> = {
  'non-string': 'value is not a string',
  empty: 'value is empty',
  padded: 'value has surrounding whitespace',
  'prerelease-or-build': 'prerelease/build suffixes are not released versions',
  'non-canonical': 'value is not in canonical released form',
}

/** Human-readable fragment for a rejection reason, for composing error messages. */
export function describeSdkVersionRejection(reason: SdkVersionRejectionReason): string {
  return REJECTION_DETAIL[reason]
}
