/**
 * RouteTargetResolves — every declared routing target must name a page that
 * exists in the same funnel.
 *
 * Nothing checked this before, and the cost was real: six certified fixtures
 * declared `next_page: "upsell-bundle-stepper.html"` on a checkout whose funnel
 * has no such page (its upsell is `upsell-stepper` — the name was copied from
 * the MV families, which do have that page). Source intake resolves an unknown
 * target by falling back to treating the raw string as a route, so those six
 * emitted a confident `next_url` to a route nothing serves: a shopper reaching
 * the end of checkout would land on a 404.
 *
 * The old CheckoutHasSuccessUrl covered this only by accident — it demanded
 * `success_url`, and these pages had none — so narrowing that rule to "has any
 * forward route" removed the last signal. This rule is the deliberate
 * replacement, and it checks the thing that actually matters: not which field
 * carried the intent, but whether the shopper can get where it points.
 *
 * Warning, not error. A campaign is a free-form journey and the resolver
 * intentionally passes through absolute URLs and fragments; a target this rule
 * cannot resolve is worth surfacing, but blocking a build on it would strand
 * exactly the unconventional authors the routing work exists to support.
 *
 * Targets are matched against page IDs and against the routes pages actually
 * serve (`page_url`), tolerating the corpus's `.html` suffix dialect
 * (`upsell-stepper.html` matches page `upsell-stepper`) because intake's route
 * fallback resolves that shape correctly. Absolute http(s) URLs, `#`
 * fragments and rooted paths are deliberate off-graph destinations and are
 * never flagged.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'
import { ROUTE_FIELDS } from '../routing.ts'

/**
 * Destinations that deliberately leave this spec's page graph. A rooted path is
 * the partial-scope pattern ThankYouRequirement documents — "traffic continues
 * to an existing downstream route" — and flagging it would fire this rule on a
 * legitimate, supported shape.
 */
function isOffGraphTarget(target: string): boolean {
  return target.startsWith('#') || target.startsWith('/') || /^https?:\/\//i.test(target)
}

/**
 * Strip the surrounding slashes and any `.html` suffix, so a target, a page ID
 * and a declared `page_url` can be compared on equal terms. Case is preserved
 * deliberately: intake's lookup is case-sensitive, and folding case here would
 * make the rule PASS targets the build then fails to resolve — a false negative
 * is worse than the false positive it would avoid.
 */
function normalizeRouteish(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed.toLowerCase().endsWith('.html') ? trimmed.slice(0, -'.html'.length) : trimmed
}

/**
 * Everything a target may legitimately name: a page's ID, or the route it
 * actually serves. Matching IDs alone flagged a working link — a page with an
 * explicit `page_url` is reached at that route, and intake resolves a target
 * naming it correctly, so the rule must too.
 */
function resolvableNames(pages: Page[]): Set<string> {
  const names = new Set<string>()
  for (const page of pages) {
    if (page.id) {
      names.add(page.id)
      names.add(normalizeRouteish(page.id))
    }
    const route = page.page_url
    if (typeof route === 'string' && route.trim()) names.add(normalizeRouteish(route))
  }
  names.delete('')
  return names
}

export const RouteTargetResolves: Rule = {
  id: 'RouteTargetResolves',
  severity: 'warning',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      const known = resolvableNames(pages)

      pages.forEach((page: Page, pageIdx: number) => {
        for (const field of ROUTE_FIELDS) {
          const raw = (page as Record<string, unknown>)[field]
          if (typeof raw !== 'string') continue
          const target = raw.trim()
          if (!target || isOffGraphTarget(target)) continue
          if (known.has(target) || known.has(normalizeRouteish(target))) continue

          violations.push({
            ruleId: 'RouteTargetResolves',
            severity: 'warning',
            message: `Routing target "${target}" resolves to no page in this funnel; the built page would link to a route nothing serves.`,
            path: `/funnels/${funnelIdx}/pages/${pageIdx}/${field}`,
            data: { pageId: page.id, field, target },
          })
        }
      })
    })

    return violations
  },
}
