/**
 * SdkVersion — requires a strict released SDK version on the spec for export.
 *
 * Two acceptable locations: spec.global_config.sdk_version (CANONICAL —
 * 33/33 real Map Builder exports declare it there) or
 * spec.runtime.sdk_version (accepted alias, seen only in local drafts and
 * always redundant there). Either being present satisfies the presence
 * requirement; the missing-everywhere violation path points at the canonical
 * home.
 *
 * Strictness mirrors the downstream Page Kit SDK-version checkpoint
 * (src/page-kit-sdk-version.mjs) via the shared parser in
 * ../sdk-version-parse.ts, so external authors get the same rejection at
 * authoring/export time that the checkpoint would deliver after Build Packet
 * preparation:
 *   - missing everywhere            → error (message unchanged — the "SDK
 *     version is required" substring is matched by caller tests)
 *   - non-string / empty / padded / prerelease / non-canonical → error at the
 *     location carrying the bad value (one violation per bad location)
 *   - conflicting dual declarations → error (escalated from the former
 *     warning; the checkpoint already treats conflicts as non-waivable, and
 *     every real dual-declaration spec in the corpus agrees)
 *   - both present and equal        → passes (real drafts do this)
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { describeSdkVersionRejection, parseSdkVersion } from '../sdk-version-parse.ts'

function displayValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return String(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

export const SdkVersion: Rule = {
  id: 'SdkVersion',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const globalConfig = spec.global_config
    const runtime = spec.runtime
    const hasCanonical = globalConfig != null && Object.hasOwn(globalConfig, 'sdk_version')
    const hasAlias = runtime != null && Object.hasOwn(runtime, 'sdk_version')

    if (!hasCanonical && !hasAlias) {
      return [
        {
          ruleId: 'SdkVersion',
          severity: 'error',
          message: 'SDK version is required for spec export.',
          path: '/global_config/sdk_version',
        },
      ]
    }

    const violations: Violation[] = []
    const declarations = [
      ...(hasCanonical
        ? [{ location: 'global_config.sdk_version', path: '/global_config/sdk_version', value: globalConfig.sdk_version }]
        : []),
      ...(hasAlias
        ? [{ location: 'runtime.sdk_version', path: '/runtime/sdk_version', value: runtime.sdk_version }]
        : []),
    ]
    for (const declaration of declarations) {
      const parsed = parseSdkVersion(declaration.value)
      if (parsed.ok) continue
      violations.push({
        ruleId: 'SdkVersion',
        severity: 'error',
        message:
          `${declaration.location} must be a released semantic version in canonical ` +
          `MAJOR.MINOR.PATCH form; got ${displayValue(declaration.value)} ` +
          `(${describeSdkVersionRejection(parsed.reason)}).`,
        path: declaration.path,
        data: { value: declaration.value, reason: parsed.reason, check: 'sdk-version-strict' },
      })
    }
    if (violations.length > 0) return violations

    const canonical = globalConfig?.sdk_version
    const alias = runtime?.sdk_version
    if (hasCanonical && hasAlias && canonical !== alias) {
      return [
        {
          ruleId: 'SdkVersion',
          severity: 'error',
          message:
            `Conflicting SDK version declarations: global_config.sdk_version=${canonical} vs ` +
            `runtime.sdk_version=${alias}. global_config is canonical — align or remove the runtime alias.`,
          path: '/runtime/sdk_version',
          data: { global_config: canonical, runtime: alias, check: 'sdk-version-conflict' },
        },
      ]
    }
    return []
  },
}
