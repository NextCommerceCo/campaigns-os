/**
 * PageIdUniqueness — page IDs must be globally unique across all funnels
 * because routing targets (next_page, success_url, on_accept, on_decline)
 * reference pages by id alone with no funnel scope.
 *
 * Reports each duplicated id exactly once, at the path of the SECOND
 * occurrence (the offender, not the original). Pages without an id are
 * silently skipped — that's a different concern (page identity, not yet
 * extracted as its own rule).
 *
 * Message text inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const PageIdUniqueness: Rule = {
  id: 'PageIdUniqueness',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const seen = new Map<string, { funnelIdx: number; pageIdx: number }>()
    const reported = new Set<string>()
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!page.id) return
        if (seen.has(page.id) && !reported.has(page.id)) {
          reported.add(page.id)
          violations.push({
            ruleId: 'PageIdUniqueness',
            severity: 'error',
            message: `Duplicate page id "${page.id}" across funnels — page IDs must be globally unique.`,
            path: `/funnels/${funnelIdx}/pages/${pageIdx}/id`,
            data: {
              pageId: page.id,
              firstOccurrence: seen.get(page.id),
              secondOccurrence: { funnelIdx, pageIdx },
            },
          })
        } else if (!seen.has(page.id)) {
          seen.set(page.id, { funnelIdx, pageIdx })
        }
      })
    })

    return violations
  },
}
