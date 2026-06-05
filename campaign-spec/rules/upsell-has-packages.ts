/**
 * UpsellHasPackages — upsell and downsell pages must declare at least one
 * package, since the runtime renders a bundle/offer selector for these page
 * types and an empty packages array has nothing to show.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'

function needsPackages(page: Page): boolean {
  return page.type === 'upsell' || page.type === 'downsell'
}

export const UpsellHasPackages: Rule = {
  id: 'UpsellHasPackages',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!needsPackages(page)) return
        if (page.packages && page.packages.length > 0) return
        violations.push({
          ruleId: 'UpsellHasPackages',
          severity: 'error',
          message: `"${page.label}" has no packages assigned.`,
          path: `/funnels/${funnelIdx}/pages/${pageIdx}/packages`,
          data: { pageId: page.id, pageType: page.type },
        })
      })
    })

    return violations
  },
}
