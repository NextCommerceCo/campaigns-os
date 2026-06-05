/**
 * CheckoutHasSuccessUrl — when the spec includes any upsell page, every
 * checkout must declare success_url so the runtime knows where to route
 * after order placement.
 *
 * The "any upsell present" precondition is the legacy heuristic for
 * "this spec needs a multi-step post-checkout flow." Specs without upsells
 * route to thankyou via the default thankyou path and don't need a
 * checkout-level success_url declared.
 *
 * Warning severity (not error) — preserves legacy classification.
 * Message text preserved verbatim.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

function specHasUpsell(spec: CampaignSpec): boolean {
  for (const funnel of spec.funnels) {
    for (const page of funnel.pages ?? []) {
      if (page.type === 'upsell') return true
    }
  }
  return false
}

export const CheckoutHasSuccessUrl: Rule = {
  id: 'CheckoutHasSuccessUrl',
  severity: 'warning',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    if (!specHasUpsell(spec)) return []

    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (page.type !== 'checkout') return
        if (page.success_url) return
        violations.push({
          ruleId: 'CheckoutHasSuccessUrl',
          severity: 'warning',
          message: 'Checkout success URL not set (needed to route to first upsell).',
          path: `/funnels/${funnelIdx}/pages/${pageIdx}/success_url`,
          data: { pageId: page.id },
        })
      })
    })

    return violations
  },
}
