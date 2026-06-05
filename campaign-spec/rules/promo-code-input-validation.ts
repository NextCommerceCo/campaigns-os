/**
 * PromoCodeInputValidation — validates checkout-level `promo_code_input`
 * configuration. This mirrors the mapped-offer integrity checks for exit
 * intent because both surfaces apply a voucher/code-backed Offer through the
 * same Campaign Cart SDK/Campaigns API pricing path.
 */

import type { CampaignSpec, Offer, Rule, Violation } from '../types.ts'

function isTruthyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function offerDisplayName(offer: Offer): string {
  return offer.name || offer.code || String(offer.ref_id) || '(unnamed offer)'
}

interface OfferCatalogIndex {
  byRefId: Map<string, Offer>
  byCode: Map<string, Offer>
}

function buildOfferIndex(offers: Offer[]): OfferCatalogIndex {
  const byRefId = new Map<string, Offer>()
  const byCode = new Map<string, Offer>()
  for (const offer of offers) {
    byRefId.set(String(offer.ref_id), offer)
    if (offer.code) byCode.set(String(offer.code).toUpperCase(), offer)
  }
  return { byRefId, byCode }
}

export const PromoCodeInputValidation: Rule = {
  id: 'PromoCodeInputValidation',
  severity: 'error',
  tags: ['fast', 'references', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const catalog = spec.offers ?? []
    const index = buildOfferIndex(catalog)
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        const promo = page.promo_code_input
        if (!promo?.enabled) return

        const path = `/funnels/${funnelIdx}/pages/${pageIdx}/promo_code_input`
        const ref = promo.offer_ref_id
        const code = promo.offer_code
        const refOffer = ref ? index.byRefId.get(String(ref)) : null
        const codeOffer = code ? index.byCode.get(String(code).toUpperCase()) : null

        if (page.type !== 'checkout') {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'warning',
            message: `"${page.label}" — Promo code input is configured on a non-checkout page.`,
            path,
            data: { pageId: page.id, check: 'placement', pageType: page.type },
          })
        }

        if (!ref) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'error',
            message: `"${page.label}" — Promo code input enabled but no offer assigned.`,
            path: `${path}/offer_ref_id`,
            data: { pageId: page.id, check: 'missing_ref' },
          })
        }
        if (!code) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'error',
            message: `"${page.label}" — Promo code input enabled but no offer code assigned.`,
            path: `${path}/offer_code`,
            data: { pageId: page.id, check: 'missing_code' },
          })
        }

        if (catalog.length > 0 && ref && !refOffer) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'error',
            message: `"${page.label}" — Promo code input offer "${ref || code}" is not present in campaign offers. Refresh API data or choose a valid offer.`,
            path: `${path}/offer_ref_id`,
            data: { pageId: page.id, check: 'ref_not_in_catalog', refId: ref },
          })
        }
        if (catalog.length > 0 && code && !codeOffer) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'error',
            message: `"${page.label}" — Promo code input offer code "${code}" is not present in campaign offers. Refresh API data or choose a valid offer.`,
            path: `${path}/offer_code`,
            data: { pageId: page.id, check: 'code_not_in_catalog', code },
          })
        }

        if (refOffer && !isTruthyString(refOffer.code)) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'error',
            message: `"${page.label}" — Promo code input offer "${offerDisplayName(refOffer)}" has no voucher/code to apply at checkout.`,
            path: `${path}/offer_ref_id`,
            data: { pageId: page.id, check: 'ref_offer_lacks_code', refId: ref },
          })
        }

        if (
          refOffer &&
          isTruthyString(code) &&
          isTruthyString(refOffer.code) &&
          String(code).toUpperCase() !== String(refOffer.code).toUpperCase()
        ) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'error',
            message: `"${page.label}" — Promo code input offer code "${code}" does not match campaign offer code "${refOffer.code}".`,
            path: `${path}/offer_code`,
            data: {
              pageId: page.id,
              check: 'code_ref_mismatch',
              providedCode: code,
              expectedCode: refOffer.code,
            },
          })
        }

        if (catalog.length === 0) {
          violations.push({
            ruleId: 'PromoCodeInputValidation',
            severity: 'warning',
            message: `"${page.label}" — Promo code input offer cannot be verified because campaign offers are missing from the spec.`,
            path,
            data: { pageId: page.id, check: 'empty_catalog' },
          })
        }
      })
    })

    return violations
  },
}
