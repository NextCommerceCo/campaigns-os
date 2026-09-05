/**
 * FunnelHypothesisLength — enforces the [10, 500] character bound on each
 * funnel's `hypothesis` field. Short hypotheses signal a draft funnel that
 * hasn't been thought through; long ones suggest the wrong field is being
 * used.
 *
 * A hypothesis states what one path is testing against another, so it is
 * required only when the spec has two or more funnels. A single-funnel spec
 * may omit it (#294); when the field is present the length bound still
 * applies regardless of funnel count. The schema already types the field as
 * optional; this rule owns the conditional requirement.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration
 * time — substrings ("at least 10 chars", "at most 500 chars") are matched
 * by caller tests.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const MIN_LENGTH = 10
const MAX_LENGTH = 500
// Below this many funnels there is nothing to compare, so no hypothesis is owed.
const MIN_FUNNELS_FOR_REQUIRED = 2

export const FunnelHypothesisLength: Rule = {
  id: 'FunnelHypothesisLength',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const hypothesisRequired = spec.funnels.length >= MIN_FUNNELS_FOR_REQUIRED

    spec.funnels.forEach((funnel, idx) => {
      const fid = funnel.id || '(unnamed)'
      if (funnel.hypothesis == null && !hypothesisRequired) return
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
