/**
 * OneCheckoutPerPath — every path from an entry page to an upsell or downsell
 * passes exactly one Checkout (campaigns-os#641).
 *
 * None means the shopper reaches a post-purchase offer with no order placed;
 * two means the path takes payment twice. A campaign may hold several
 * Checkouts — split-test paths each reach their own — so the rule counts per
 * path, never per spec.
 *
 * Paths follow both edges a page can traverse (forward and decline, from
 * routing.ts) and start at the funnel's entry pages (checkout-flow.ts
 * `entryPages`): pages flagged `is_entry`, else those nothing routes to. No
 * page order or name is consulted. The search runs over (page, checkouts
 * passed so far: 0, 1, 2+) states, so each bad page is reported once per count
 * however many paths reach it.
 *
 * A spec with no Checkout anywhere is left to UpsellWithoutCheckout, so the
 * two never report one defect twice.
 *
 * With build_scope.mode === 'partial' a path that reaches an offer with no
 * Checkout is a warning, as in UpsellWithoutCheckout: a partial upsell build
 * may ship an offer an existing checkout elsewhere routes into.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'
import { outgoingEdgeIds } from '../routing.ts'
import { POST_PURCHASE_OFFER_PAGE_TYPES, entryPages, isPaymentPage, resolveRouteTargetPage } from '../checkout-flow.ts'

function isOffer(page: Page): boolean {
  const type = typeof page.type === 'string' ? page.type.trim().toLowerCase() : ''
  return (POST_PURCHASE_OFFER_PAGE_TYPES as readonly string[]).includes(type)
}

export const OneCheckoutPerPath: Rule = {
  id: 'OneCheckoutPerPath',
  severity: 'error',
  tags: ['structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const partial = spec.build_scope?.mode === 'partial'
    // A spec with no Checkout at all is UpsellWithoutCheckout's to report; this
    // rule speaks only when Checkouts exist and some path misses or doubles one.
    const anyCheckout = spec.funnels.some((funnel) => (funnel.pages ?? []).some((page) => isPaymentPage(page)))

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = (funnel.pages ?? []).filter(
        (page) => page && (page as Record<string, unknown>).enabled !== false,
      )
      const indexOf = new Map<Page, number>()
      ;(funnel.pages ?? []).forEach((page, idx) => indexOf.set(page, idx))

      const seen = new Set<string>()
      const reported = new Set<string>()
      for (const entry of entryPages(funnel)) {
        const stack: Array<[Page, number]> = [[entry, 0]]
        while (stack.length) {
          const [page, before] = stack.pop() as [Page, number]
          const passed = Math.min(before + (isPaymentPage(page) ? 1 : 0), 2)
          const key = `${indexOf.get(page)}:${passed}`
          if (seen.has(key)) continue
          seen.add(key)

          if (isOffer(page) && passed !== 1 && (passed > 1 || anyCheckout)) {
            const reportKey = `${indexOf.get(page)}:${passed === 0 ? 0 : 2}`
            if (!reported.has(reportKey)) {
              reported.add(reportKey)
              const none = passed === 0
              violations.push({
                ruleId: 'OneCheckoutPerPath',
                severity: none && partial ? 'warning' : 'error',
                message: none
                  ? `A path from entry page "${entry.id}" reaches "${page.id}" (${page.type}) without passing a Checkout, so no order has been placed.` +
                    (partial ? ' Valid for partial upsell builds when an existing checkout routes into this page.' : '')
                  : `A path from entry page "${entry.id}" reaches "${page.id}" (${page.type}) after passing more than one Checkout, so it takes payment twice.`,
                path: `/funnels/${funnelIdx}/pages/${indexOf.get(page)}`,
                data: { pageId: page.id, entryPageId: entry.id, checkoutsPassed: none ? 0 : 2, isPartialScope: partial },
              })
            }
          }

          for (const target of outgoingEdgeIds(page)) {
            const next = resolveRouteTargetPage(pages, target)
            if (next) stack.push([next, passed])
          }
        }
      }
    })
    return violations
  },
}
