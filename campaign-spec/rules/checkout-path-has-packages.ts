/**
 * CheckoutPathHasPackages — every path from an entry page to a Checkout passes
 * at least one page that sells a main-cart package (campaigns-os#711, #206).
 *
 * A Checkout the shopper reaches with nothing in the cart cannot take an
 * order, and until this rule nothing said so before a test order failed. The
 * selling page may be any page on the path up to and including the Checkout:
 * a select page's bundle picker, a landing page's package cards, a checkout
 * step, or the Checkout's own selector. So the rule counts per path, never per
 * page: a Checkout with no packages of its own passes when every path into it
 * sells first.
 *
 * "Main-cart package" is the ratified #206 contract (checkout-flow.ts
 * `isMainCartPackage`, docs/template-family-contracts.md "Main-cart entry"):
 * an entry with neither `is_upsell: true` nor `is_order_bump: true`. Bump rows
 * alone sell nothing, `default_selected` never changes the role, and entries
 * on upsell, downsell or thank-you pages never count.
 *
 * Paths are walked the way OneCheckoutPerPath walks them: both edges a page
 * can traverse (routing.ts), starting at the funnel's entry pages
 * (checkout-flow.ts `entryPages`). No page order or name is consulted. The
 * search runs, per entry page, over (page, sold yet) states and stops at the
 * first Checkout, so each empty Checkout is reported once per entry however
 * many of that entry's paths reach it. A second Checkout on one path is
 * OneCheckoutPerPath's to report.
 *
 * With build_scope.mode === 'partial' the finding is a warning: a partial
 * build may ship a Checkout that a page outside the build fills.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'
import { outgoingEdgeIds } from '../routing.ts'
import { entryPages, isPaymentPage, resolveRouteTargetPage, sellsMainCartPackage } from '../checkout-flow.ts'

export const CheckoutPathHasPackages: Rule = {
  id: 'CheckoutPathHasPackages',
  severity: 'error',
  tags: ['structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const partial = spec.build_scope?.mode === 'partial'

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = (funnel.pages ?? []).filter(
        (page) => page && (page as Record<string, unknown>).enabled !== false,
      )
      const indexOf = new Map<Page, number>()
      ;(funnel.pages ?? []).forEach((page, idx) => indexOf.set(page, idx))

      for (const entry of entryPages(funnel)) {
        const seen = new Set<string>()
        const reported = new Set<Page>()
        const stack: Array<[Page, boolean]> = [[entry, false]]
        while (stack.length) {
          const [page, before] = stack.pop() as [Page, boolean]
          const sold = before || sellsMainCartPackage(page)
          const key = `${indexOf.get(page)}:${sold}`
          if (seen.has(key)) continue
          seen.add(key)

          if (isPaymentPage(page)) {
            if (!sold && !reported.has(page)) {
              reported.add(page)
              violations.push({
                ruleId: 'CheckoutPathHasPackages',
                severity: partial ? 'warning' : 'error',
                message:
                  `A path from entry page "${entry.id}" reaches Checkout "${page.id}" without passing a page that sells a main-cart package, so the cart is empty and no order can be placed. ` +
                  'Add a package entry not marked is_upsell or is_order_bump to the Checkout or a page before it on this path.' +
                  (partial ? ' Valid for partial builds when a page outside this build fills the cart.' : ''),
                path: `/funnels/${funnelIdx}/pages/${indexOf.get(page)}`,
                data: { pageId: page.id, entryPageId: entry.id, isPartialScope: partial },
              })
            }
            continue
          }

          for (const target of outgoingEdgeIds(page)) {
            const next = resolveRouteTargetPage(pages, target)
            if (next) stack.push([next, sold])
          }
        }
      }
    })
    return violations
  },
}
