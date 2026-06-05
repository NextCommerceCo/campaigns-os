/**
 * UpsellRoutingComplete — upsell and downsell pages must declare both
 * on_accept and on_decline routes. A missing route means the funnel
 * topology has a dead-end at the offer.
 *
 * One rule, two potential violations per offending page. Message text
 * inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'

function needsAcceptDecline(page: Page): boolean {
  return page.type === 'upsell' || page.type === 'downsell'
}

export const UpsellRoutingComplete: Rule = {
  id: 'UpsellRoutingComplete',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!needsAcceptDecline(page)) return

        if (!page.on_accept) {
          violations.push({
            ruleId: 'UpsellRoutingComplete',
            severity: 'error',
            message: `"${page.label}" — Accept path not set.`,
            path: `/funnels/${funnelIdx}/pages/${pageIdx}/on_accept`,
            data: { pageId: page.id, missing: 'on_accept' },
          })
        }
        if (!page.on_decline) {
          violations.push({
            ruleId: 'UpsellRoutingComplete',
            severity: 'error',
            message: `"${page.label}" — Decline path not set.`,
            path: `/funnels/${funnelIdx}/pages/${pageIdx}/on_decline`,
            data: { pageId: page.id, missing: 'on_decline' },
          })
        }
      })
    })

    return violations
  },
}
