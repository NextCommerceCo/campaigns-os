/**
 * ThankYouRequirement — every spec must include at least one thank-you page
 * (terminal node of the funnel topology). Downgrades to a warning when the
 * spec is a partial build (build_scope.mode === 'partial'), because partial
 * builds may legitimately end on a non-terminal page that routes into an
 * existing downstream campaign.
 *
 * Only fires when the spec has at least one page — if there are zero pages
 * altogether, PageCount handles that signal and this rule stays silent to
 * avoid double-reporting.
 *
 * Message text and the partial-scope severity downgrade are inherited
 * verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const ThankYouRequirement: Rule = {
  id: 'ThankYouRequirement',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    let hasThankYou = false
    let totalPages = 0
    for (const funnel of spec.funnels) {
      const pages = funnel.pages ?? []
      totalPages += pages.length
      for (const page of pages) {
        if (page.type === 'thankyou') {
          hasThankYou = true
          break
        }
      }
      if (hasThankYou) break
    }

    // Silent when zero pages — PageCount already speaks to that.
    if (hasThankYou || totalPages === 0) return []

    const isPartialScope = spec.build_scope?.mode === 'partial'

    return [
      {
        ruleId: 'ThankYouRequirement',
        severity: isPartialScope ? 'warning' : 'error',
        message: isPartialScope
          ? 'Spec has no Thank You page. Valid for partial builds when traffic continues to an existing downstream route.'
          : 'Funnel must end with a Thank You page.',
        path: '/funnels',
        data: { isPartialScope },
      },
    ]
  },
}
