/**
 * SdkVersion — requires an SDK version on the spec for export.
 *
 * Two acceptable locations: spec.global_config.sdk_version (CANONICAL —
 * 33/33 real Map Builder exports declare it there) or
 * spec.runtime.sdk_version (accepted alias, seen only in local drafts and
 * always redundant there). Either being present satisfies the rule; the
 * violation path points at the canonical home. Strict single-location
 * parsing is deliberately NOT enforced here.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration
 * time — the "SDK version is required" substring is matched by caller tests.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const SdkVersion: Rule = {
  id: 'SdkVersion',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const runtime = spec.runtime ?? {}
    const globalConfig = spec.global_config ?? {}
    if (globalConfig.sdk_version || runtime.sdk_version) return []
    return [
      {
        ruleId: 'SdkVersion',
        severity: 'error',
        message: 'SDK version is required for spec export.',
        path: '/global_config/sdk_version',
      },
    ]
  },
}
