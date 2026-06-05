/**
 * SdkVersion — requires an SDK version on the spec for export.
 *
 * Two acceptable locations: spec.runtime.sdk_version (preferred, current
 * topology) or spec.global_config.sdk_version (legacy, still accepted).
 * Either being present satisfies the rule.
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
    if (runtime.sdk_version || globalConfig.sdk_version) return []
    return [
      {
        ruleId: 'SdkVersion',
        severity: 'error',
        message: 'SDK version is required for spec export.',
        path: '/runtime/sdk_version',
      },
    ]
  },
}
