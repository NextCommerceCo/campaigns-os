/**
 * FunnelIdentity — enforces per-funnel identity invariants:
 *   - id is present
 *   - id is globally unique across funnels
 *   - name is present (non-empty after trim)
 *
 * One rule, multiple potential violations. Message text was preserved
 * verbatim from the pre-#110 validator at migration time and is now the
 * canonical wording — caller tests across the repo match these substrings.
 *
 * Note: hypothesis length is a separate concern (FunnelHypothesisLength) so
 * each can be filtered independently by tag.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const FunnelIdentity: Rule = {
  id: 'FunnelIdentity',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const seenIds = new Set<string>()

    spec.funnels.forEach((funnel, idx) => {
      const fid = funnel.id || '(unnamed)'
      const path = `/funnels/${idx}`

      if (!funnel.id) {
        violations.push({
          ruleId: 'FunnelIdentity',
          severity: 'error',
          message: 'Funnel is missing an id.',
          path: `${path}/id`,
          data: { funnelId: fid, funnelIdx: idx },
        })
      } else if (seenIds.has(funnel.id)) {
        violations.push({
          ruleId: 'FunnelIdentity',
          severity: 'error',
          message: `Duplicate funnel id "${funnel.id}".`,
          path: `${path}/id`,
          data: { funnelId: funnel.id, funnelIdx: idx },
        })
      } else {
        seenIds.add(funnel.id)
      }

      if (!funnel.name || String(funnel.name).trim() === '') {
        violations.push({
          ruleId: 'FunnelIdentity',
          severity: 'error',
          message: `Funnel "${fid}" — name is required.`,
          path: `${path}/name`,
          data: { funnelId: fid, funnelIdx: idx },
        })
      }
    })

    return violations
  },
}
