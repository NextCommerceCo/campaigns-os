/**
 * CheckoutHasSuccessUrl — when the spec includes any upsell page, every
 * checkout must declare SOME forward route so the runtime knows where to send
 * the shopper after order placement.
 *
 * The check is on the shopper being able to continue, NOT on which field
 * carried that intent. `success_url` and `next_page` express the same edge, and
 * nine certified family fixtures use `next_page` on their checkout — warning at
 * those told authors to rename a field they had already filled in correctly. A
 * campaign is a free-form journey; the tool has no business having an opinion
 * about the field name when the route is unambiguous.
 *
 * The "any upsell present" precondition is the legacy heuristic for
 * "this spec needs a multi-step post-checkout flow." Specs without upsells
 * route to thankyou via the default thankyou path and don't need a
 * checkout-level forward route declared.
 *
 * Pairs with type-agnostic forward-link resolution in
 * src/source-html-intake.mjs: narrowing this rule is only safe because that
 * edge now actually wires. Narrowed alone it would have removed the sole
 * signal on a still-dropped edge.
 *
 * Warning severity (not error) — preserves legacy classification.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'

/**
 * Any declared forward edge counts. Mirrors the precedence list in
 * src/source-html-intake.mjs — if the wiring can resolve a link from the page,
 * the shopper can continue and there is nothing to warn about.
 */
function hasForwardRoute(page: Page): boolean {
  return Boolean(page.success_url || page.next_page || page.on_accept)
}

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
        if (hasForwardRoute(page)) return
        violations.push({
          ruleId: 'CheckoutHasSuccessUrl',
          severity: 'warning',
          message: 'Checkout has no forward route (set success_url or next_page to reach the first upsell).',
          path: `/funnels/${funnelIdx}/pages/${pageIdx}/success_url`,
          data: { pageId: page.id },
        })
      })
    })

    return violations
  },
}
