/**
 * SchemaVersion — flags a missing spec.schema_version.
 *
 * Behaviour and message text inherited verbatim from the pre-#110 validator
 * at migration time so the strangler swap was bit-for-bit invisible to
 * callers. The wording is now canonical.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const SchemaVersion: Rule = {
  id: 'SchemaVersion',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    if (spec.schema_version) return []
    return [
      {
        ruleId: 'SchemaVersion',
        severity: 'error',
        message: 'Missing schema_version',
        path: '/schema_version',
      },
    ]
  },
}
