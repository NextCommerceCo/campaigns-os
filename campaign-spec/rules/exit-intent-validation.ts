/**
 * ExitIntentValidation — the heaviest single rule in the registry. Validates
 * everything about per-page `exit_intent` configuration:
 *
 *   1. Placement: exit intent on a non-checkout page (warning — 0.4.x
 *      runtime contract expects checkout-level exit intent)
 *   2. Presence: enabled but no offer_ref_id (error)
 *   3. Presence: enabled but no offer_code (error)
 *   4. Catalog: offer_ref_id not in spec.offers (error)
 *   5. Catalog: offer_code not in spec.offers (error)
 *   6. Consistency: ref offer has no `code` field (error — nothing to apply)
 *   7. Consistency: offer_code doesn't match ref offer's `code` (error)
 *   8. Catalog: exit intent enabled with no offers in catalog at all (warning)
 *
 * Kept as one rule because every check shares the same precondition
 * (`exit_intent?.enabled`) and the same domain (exit intent integrity).
 * Splitting would force callers to opt in/out 8 ways for one concept. If a
 * caller needs to subset, they filter the resulting violations by `data.check`.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration time.
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

export const ExitIntentValidation: Rule = {
  id: 'ExitIntentValidation',
  severity: 'error',
  tags: ['fast', 'references', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const catalog = spec.offers ?? []
    const index = buildOfferIndex(catalog)
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        const exit = page.exit_intent
        if (!exit?.enabled) return

        const path = `/funnels/${funnelIdx}/pages/${pageIdx}/exit_intent`
        const ref = exit.offer_ref_id
        const code = exit.offer_code
        const refOffer = ref ? index.byRefId.get(String(ref)) : null
        const codeOffer = code ? index.byCode.get(String(code).toUpperCase()) : null

        // 1. Placement
        if (page.type !== 'checkout') {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'warning',
            message: `"${page.label}" — Exit intent is configured on a non-checkout page. The 0.4.x runtime contract expects checkout-level exit intent.`,
            path,
            data: { pageId: page.id, check: 'placement', pageType: page.type },
          })
        }

        // 2 & 3. Presence
        if (!ref) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'error',
            message: `"${page.label}" — Exit intent enabled but no offer assigned.`,
            path: `${path}/offer_ref_id`,
            data: { pageId: page.id, check: 'missing_ref' },
          })
        }
        if (!code) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'error',
            message: `"${page.label}" — Exit intent enabled but no offer code assigned.`,
            path: `${path}/offer_code`,
            data: { pageId: page.id, check: 'missing_code' },
          })
        }

        // 4 & 5. Catalog presence
        if (catalog.length > 0 && ref && !refOffer) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'error',
            message: `"${page.label}" — Exit intent offer "${ref || code}" is not present in campaign offers. Refresh API data or choose a valid offer.`,
            path: `${path}/offer_ref_id`,
            data: { pageId: page.id, check: 'ref_not_in_catalog', refId: ref },
          })
        }
        if (catalog.length > 0 && code && !codeOffer) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'error',
            message: `"${page.label}" — Exit intent offer code "${code}" is not present in campaign offers. Refresh API data or choose a valid offer.`,
            path: `${path}/offer_code`,
            data: { pageId: page.id, check: 'code_not_in_catalog', code },
          })
        }

        // 6. Ref offer has no code
        if (refOffer && !isTruthyString(refOffer.code)) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'error',
            message: `"${page.label}" — Exit intent offer "${offerDisplayName(refOffer)}" has no voucher/code to apply at checkout.`,
            path: `${path}/offer_ref_id`,
            data: { pageId: page.id, check: 'ref_offer_lacks_code', refId: ref },
          })
        }

        // 7. Code mismatch
        if (
          refOffer &&
          isTruthyString(code) &&
          isTruthyString(refOffer.code) &&
          String(code).toUpperCase() !== String(refOffer.code).toUpperCase()
        ) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'error',
            message: `"${page.label}" — Exit intent offer code "${code}" does not match campaign offer code "${refOffer.code}".`,
            path: `${path}/offer_code`,
            data: {
              pageId: page.id,
              check: 'code_ref_mismatch',
              providedCode: code,
              expectedCode: refOffer.code,
            },
          })
        }

        // 8. Empty catalog
        if (catalog.length === 0) {
          violations.push({
            ruleId: 'ExitIntentValidation',
            severity: 'warning',
            message: `"${page.label}" — Exit intent offer cannot be verified because campaign offers are missing from the spec.`,
            path,
            data: { pageId: page.id, check: 'empty_catalog' },
          })
        }
      })
    })

    return violations
  },
}
