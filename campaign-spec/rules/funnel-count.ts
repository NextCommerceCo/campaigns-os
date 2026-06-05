/**
 * FunnelCount — enforces the funnel cardinality bounds: at least 1, at most 10.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration time. The upper
 * bound (10) is a soft platform cap; revisit in a separate ADR if a real use
 * case needs more.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const MIN_FUNNELS = 1
const MAX_FUNNELS = 10

export const FunnelCount: Rule = {
  id: 'FunnelCount',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const count = spec.funnels?.length ?? 0
    const violations: Violation[] = []

    if (count < MIN_FUNNELS) {
      violations.push({
        ruleId: 'FunnelCount',
        severity: 'error',
        message: 'Spec must define at least 1 funnel.',
        path: '/funnels',
        data: { count, min: MIN_FUNNELS },
      })
    } else if (count > MAX_FUNNELS) {
      violations.push({
        ruleId: 'FunnelCount',
        severity: 'error',
        message: `Spec defines ${count} funnels; max is ${MAX_FUNNELS}.`,
        path: '/funnels',
        data: { count, max: MAX_FUNNELS },
      })
    }

    return violations
  },
}
