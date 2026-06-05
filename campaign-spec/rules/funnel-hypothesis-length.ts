/**
 * FunnelHypothesisLength — enforces the [10, 500] character bound on each
 * funnel's `hypothesis` field. Short hypotheses signal a draft funnel that
 * hasn't been thought through; long ones suggest the wrong field is being
 * used.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration
 * time — substrings ("at least 10 chars", "at most 500 chars") are matched
 * by caller tests.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const MIN_LENGTH = 10
const MAX_LENGTH = 500

export const FunnelHypothesisLength: Rule = {
  id: 'FunnelHypothesisLength',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, idx) => {
      const fid = funnel.id || '(unnamed)'
      const hyp = funnel.hypothesis == null ? '' : String(funnel.hypothesis)
      const path = `/funnels/${idx}/hypothesis`

      if (hyp.length < MIN_LENGTH) {
        violations.push({
          ruleId: 'FunnelHypothesisLength',
          severity: 'error',
          message: `Funnel "${fid}" — hypothesis must be at least ${MIN_LENGTH} chars (got ${hyp.length}).`,
          path,
          data: { funnelId: fid, length: hyp.length, min: MIN_LENGTH },
        })
      } else if (hyp.length > MAX_LENGTH) {
        violations.push({
          ruleId: 'FunnelHypothesisLength',
          severity: 'error',
          message: `Funnel "${fid}" — hypothesis must be at most ${MAX_LENGTH} chars (got ${hyp.length}).`,
          path,
          data: { funnelId: fid, length: hyp.length, max: MAX_LENGTH },
        })
      }
    })

    return violations
  },
}
