/**
 * PrePaymentForwardTarget — a `select` or `checkout_step` page takes no
 * payment, so it must not forward straight to a post-payment page (an upsell,
 * a downsell or a thank-you page). Doing so skips the Checkout: the shopper
 * reaches an offer or a receipt with no order placed (campaigns-os#641).
 *
 * Only the resolved forward link is judged — routing.ts already ignores a
 * `success_url` or `on_accept` on these types, and RouteFieldIgnoredForPageType
 * warns about those separately.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { forwardRouteTarget } from '../routing.ts'
import { POST_PAYMENT_PAGE_TYPES, forwardTargetPage, isPrePaymentPage } from '../checkout-flow.ts'

export const PrePaymentForwardTarget: Rule = {
  id: 'PrePaymentForwardTarget',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!isPrePaymentPage(page)) return
        const target = forwardTargetPage(pages, page)
        if (!target) return
        const targetType = typeof target.type === 'string' ? target.type : ''
        if (!(POST_PAYMENT_PAGE_TYPES as readonly string[]).includes(targetType)) return
        violations.push({
          ruleId: 'PrePaymentForwardTarget',
          severity: 'error',
          message:
            `"${page.type}" page "${page.id}" forwards to "${target.id}" (type "${targetType}") without passing a Checkout. ` +
            'Route it (via next_page) to the next checkout step or to the Checkout that takes payment.',
          path: `/funnels/${funnelIdx}/pages/${pageIdx}/next_page`,
          data: { pageId: page.id, pageType: page.type, target: forwardRouteTarget(page), targetPageId: target.id, targetType },
        })
      })
    })
    return violations
  },
}
