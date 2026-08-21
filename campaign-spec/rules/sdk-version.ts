/**
 * SdkVersion — requires an SDK version on the spec for export.
 *
 * Two acceptable locations: spec.global_config.sdk_version (CANONICAL —
 * 33/33 real Map Builder exports declare it there) or
 * spec.runtime.sdk_version (accepted alias, seen only in local drafts and
 * always redundant there). Either being present satisfies the rule; the
 * violation path points at the canonical home. Strict single-location
 * parsing is deliberately NOT enforced here, but conflicting dual
 * declarations are flagged at warning severity so SDK pin drift surfaces
 * before build instead of depending on which location a consumer reads.
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
    const canonical = globalConfig.sdk_version
    const alias = runtime.sdk_version
    if (canonical && alias && canonical !== alias) {
      return [
        {
          ruleId: 'SdkVersion',
          severity: 'warning',
          message:
            `Conflicting SDK version declarations: global_config.sdk_version=${canonical} vs ` +
            `runtime.sdk_version=${alias}. global_config is canonical — align or remove the runtime alias.`,
          path: '/runtime/sdk_version',
          data: { global_config: canonical, runtime: alias, check: 'sdk-version-conflict' },
        },
      ]
    }
    if (canonical || alias) return []
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
