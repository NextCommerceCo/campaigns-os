/**
 * PageCount — requires at least one page somewhere in the spec (aggregated
 * across all funnels). When this fails, every downstream page-level rule
 * has nothing to check, so this is the first signal operators see.
 *
 * Message wording: "Funnel must have at least 1 page." Inherited verbatim
 * from the pre-#110 validator. Reads as singular but the check is across
 * the union of funnels.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const PageCount: Rule = {
  id: 'PageCount',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    let total = 0
    for (const funnel of spec.funnels) {
      total += funnel.pages?.length ?? 0
    }
    if (total > 0) return []
    return [
      {
        ruleId: 'PageCount',
        severity: 'error',
        message: 'Funnel must have at least 1 page.',
        path: '/funnels',
        data: { totalPages: 0 },
      },
    ]
  },
}
