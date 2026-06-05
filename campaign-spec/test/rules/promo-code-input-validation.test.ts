import { describe, expect, test } from '../harness.ts'
import { PromoCodeInputValidation } from '../../rules/promo-code-input-validation.ts'
import { normalize } from '../../normalize.ts'
import type { CampaignSpec } from '../../types.ts'

function specWithCheckout(promoCodeInput: Record<string, unknown>): CampaignSpec {
  return {
    schema_version: '4.3',
    offers: [{ ref_id: 'offer-a', code: 'PROMO' }],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'checkout with promo-code input for rule testing',
        weight: 100,
        pages: [
          { id: 'l', type: 'landing', next_page: 'c' },
          {
            id: 'c',
            type: 'checkout',
            label: 'Checkout',
            success_url: 'ty',
            promo_code_input: promoCodeInput,
          },
          { id: 'ty', type: 'thankyou' },
        ],
      },
    ],
  }
}

describe('PromoCodeInputValidation rule', () => {
  test('silent when promo_code_input is not enabled', () => {
    const spec = specWithCheckout({ enabled: false })
    expect(PromoCodeInputValidation.check(normalize(spec))).toEqual([])
  })

  test('missing ref + missing code each fire their own violation', () => {
    const spec = specWithCheckout({ enabled: true })
    const violations = PromoCodeInputValidation.check(normalize(spec))
    const checks = violations.map((v) => v.data?.check).sort()
    expect(checks).toEqual(['missing_code', 'missing_ref'])
  })

  test('placement check fires on non-checkout pages', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [{ ref_id: 'offer-a', code: 'PROMO' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'promo-code input placed on landing page',
          weight: 100,
          pages: [
            {
              id: 'l',
              type: 'landing',
              label: 'Landing',
              promo_code_input: {
                enabled: true,
                offer_ref_id: 'offer-a',
                offer_code: 'PROMO',
              },
            },
          ],
        },
      ],
    }
    const violations = PromoCodeInputValidation.check(normalize(spec))
    expect(violations.map((v) => v.data?.check)).toContain('placement')
  })

  test('code-vs-ref mismatch fires when codes diverge', () => {
    const spec = specWithCheckout({
      enabled: true,
      offer_ref_id: 'offer-a',
      offer_code: 'WRONG',
    })
    const violations = PromoCodeInputValidation.check(normalize(spec))
    const mismatch = violations.find((v) => v.data?.check === 'code_ref_mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch?.path).toBe('/funnels/0/pages/1/promo_code_input/offer_code')
  })

  test('empty catalog warning fires when offers array is empty', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'promo-code input with empty offer catalog',
          weight: 100,
          pages: [
            {
              id: 'c',
              type: 'checkout',
              label: 'C',
              success_url: 'ty',
              promo_code_input: {
                enabled: true,
                offer_ref_id: 'whatever',
                offer_code: 'WHATEVER',
              },
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = PromoCodeInputValidation.check(normalize(spec))
    const emptyCatalog = violations.find((v) => v.data?.check === 'empty_catalog')
    expect(emptyCatalog).toBeDefined()
    expect(emptyCatalog?.severity).toBe('warning')
  })

  test('ref offer without a code fires the lacks_code check', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [{ ref_id: 'no-code-offer', name: 'No Code' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'promo-code input points to offer with no voucher code',
          weight: 100,
          pages: [
            {
              id: 'c',
              type: 'checkout',
              label: 'C',
              success_url: 'ty',
              promo_code_input: {
                enabled: true,
                offer_ref_id: 'no-code-offer',
                offer_code: 'STILLNEEDED',
              },
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = PromoCodeInputValidation.check(normalize(spec))
    const lacksCode = violations.find((v) => v.data?.check === 'ref_offer_lacks_code')
    expect(lacksCode).toBeDefined()
  })

  test('case-insensitive code matching (DISCOUNT === discount)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [{ ref_id: 'o', code: 'discount' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'casing differs but uppercase comparison still matches',
          weight: 100,
          pages: [
            {
              id: 'c',
              type: 'checkout',
              label: 'C',
              success_url: 'ty',
              promo_code_input: {
                enabled: true,
                offer_ref_id: 'o',
                offer_code: 'DISCOUNT',
              },
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(PromoCodeInputValidation.check(normalize(spec))).toEqual([])
  })
})
