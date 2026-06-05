/**
 * OfferRefIntegrity — page-level `offers[]` entries must reference ref_ids
 * that exist in the spec's `offers[]` catalog. If an offer ref doesn't
 * resolve, the runtime can't render the offer and the page silently degrades.
 *
 * Warning severity (not error) — preserves legacy classification. The
 * mismatch usually means the spec is stale relative to the upstream API and
 * needs a refresh.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Offer, Rule, Violation } from '../types.ts'

function buildRefIdIndex(catalog: Offer[]): Set<string> {
  const set = new Set<string>()
  for (const offer of catalog) {
    set.add(String(offer.ref_id))
  }
  return set
}

export const OfferRefIntegrity: Rule = {
  id: 'OfferRefIntegrity',
  severity: 'warning',
  tags: ['fast', 'references', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const catalog = spec.offers ?? []
    const refIds = buildRefIdIndex(catalog)
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!page.offers || page.offers.length === 0) return
        page.offers.forEach((offer, offerIdx) => {
          if (!refIds.has(String(offer.ref_id))) {
            violations.push({
              ruleId: 'OfferRefIntegrity',
              severity: 'warning',
              message: `"${page.label}" — Offer ref ${offer.ref_id} not found in campaign offers. Refresh API data to sync.`,
              path: `/funnels/${funnelIdx}/pages/${pageIdx}/offers/${offerIdx}/ref_id`,
              data: { pageId: page.id, refId: offer.ref_id },
            })
          }
        })
      })
    })

    return violations
  },
}
