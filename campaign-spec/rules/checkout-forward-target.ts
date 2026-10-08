/**
 * CheckoutForwardTarget — a Checkout takes payment, so where it sends the
 * shopper next must be a post-payment page: an upsell, a downsell or a
 * thank-you page (campaigns-os#641).
 *
 * A `checkout` forwarding to another checkout-shaped page, a landing page or a
 * select page means one of two things, both wrong: the page is really a step
 * that collects details and moves on (type it `checkout_step`), or the order
 * would be placed before the shopper reaches the page meant to take payment.
 *
 * Only a target this funnel resolves is judged. An off-graph destination (a
 * rooted path into an existing downstream campaign, an absolute URL) is the
 * partial-scope shape and passes; an unresolved typo is RouteTargetResolves';
 * a Checkout with no forward route at all is CheckoutHasSuccessUrl's.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { forwardRouteTarget } from '../routing.ts'
import { POST_PAYMENT_PAGE_TYPES, forwardTargetPage, isPaymentPage } from '../checkout-flow.ts'

export const CheckoutForwardTarget: Rule = {
  id: 'CheckoutForwardTarget',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!isPaymentPage(page)) return
        const target = forwardTargetPage(pages, page)
        if (!target) return
        const targetType = typeof target.type === 'string' ? target.type : ''
        if ((POST_PAYMENT_PAGE_TYPES as readonly string[]).includes(targetType)) return
        violations.push({
          ruleId: 'CheckoutForwardTarget',
          severity: 'error',
          message:
            `Checkout "${page.id}" forwards to "${target.id}" (type "${targetType || 'none'}"). ` +
            'A Checkout takes payment, so it must forward to an upsell, downsell or thank-you page. ' +
            'If this page collects details and moves on without placing an order, type it "checkout_step".',
          path: `/funnels/${funnelIdx}/pages/${pageIdx}`,
          data: { pageId: page.id, target: forwardRouteTarget(page), targetPageId: target.id, targetType },
        })
      })
    })
    return violations
  },
}
