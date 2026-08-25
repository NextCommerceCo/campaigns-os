/**
 * RouteFieldIgnoredForPageType — a page declares a forward-route field its
 * type cannot satisfy, so routing skips it.
 *
 * Today that means exactly one shape: `success_url` on a page that is not a
 * checkout. `success_url` means "where the shopper goes after payment
 * succeeds", and only a checkout takes payment, so on a `select` or `landing`
 * page the field names an event that never happens there (campaigns-os#234).
 * Routing therefore ignores it and `next_page` wins.
 *
 * Why this rule exists at all. Before #234 the stray field silently OUTRANKED
 * the page's real next step — a select page declaring `next_page: checkout`
 * and `success_url: upsell` wired the upsell and skipped payment. #234 fixes
 * the routing, but a spec author who wrote the field still gets behaviour they
 * did not ask for, just the safe kind now. RouteTargetResolves only catches
 * this when the target does not resolve; when both targets are real pages it
 * has nothing to say. A comment removed in #233 assumed a rule already covered
 * the case. It did not. This is that rule.
 *
 * Warning, not error. The build is correct either way — the field is inert,
 * not broken — and it is overwhelmingly a copy-paste from the checkout below.
 * Blocking on it would fail builds that ship fine.
 *
 * The set of ignored fields comes from routing.ts via
 * `inapplicableForwardFields`, never re-derived here: a rule that disagreed
 * with the resolver about which fields are live would be worse than no rule.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { forwardRouteTarget, inapplicableForwardFields } from '../routing.ts'

export const RouteFieldIgnoredForPageType: Rule = {
  id: 'RouteFieldIgnoredForPageType',
  severity: 'warning',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []

      pages.forEach((page, pageIdx) => {
        const ignored = inapplicableForwardFields(page)
        if (ignored.length === 0) return

        // Naming the field that actually wins is what makes this actionable:
        // "ignored" alone leaves the author guessing where the shopper goes.
        const winner = forwardRouteTarget(page)
        const outcome = winner
          ? `This page routes forward to "${winner}" instead.`
          : 'This page has no forward route at all as a result.'

        for (const field of ignored) {
          violations.push({
            ruleId: 'RouteFieldIgnoredForPageType',
            severity: 'warning',
            message: `"${field}" is ignored for routing on a "${page.type}" page — only a checkout takes payment, so there is no payment success to route from. ${outcome}`,
            path: `/funnels/${funnelIdx}/pages/${pageIdx}/${field}`,
            data: {
              pageId: page.id,
              pageType: page.type,
              field,
              target: (page as Record<string, unknown>)[field],
              routedTo: winner,
            },
          })
        }
      })
    })

    return violations
  },
}
