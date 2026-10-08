/**
 * CheckoutStepReachesCheckout — every `checkout_step` page must lie on a path
 * to a Checkout. Following its forward links has to arrive at a `checkout`
 * page; a step that dead-ends, loops, leaves the funnel or reaches an offer
 * first collects the shopper's details and never takes payment
 * (campaigns-os#641).
 *
 * Forward links only: a step has no decline branch that could carry the
 * shopper to payment instead.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { isCheckoutStepPage, paymentPageFrom } from '../checkout-flow.ts'

export const CheckoutStepReachesCheckout: Rule = {
  id: 'CheckoutStepReachesCheckout',
  severity: 'error',
  tags: ['structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!isCheckoutStepPage(page)) return
        if (paymentPageFrom(pages, page)) return
        violations.push({
          ruleId: 'CheckoutStepReachesCheckout',
          severity: 'error',
          message:
            `Checkout step "${page.id}" is not on a path to a Checkout. ` +
            'Follow its next_page links to the page that takes payment (type "checkout").',
          path: `/funnels/${funnelIdx}/pages/${pageIdx}`,
          data: { pageId: page.id },
        })
      })
    })
    return violations
  },
}
