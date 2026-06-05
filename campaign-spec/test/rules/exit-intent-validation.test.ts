import { describe, expect, test } from '../harness.ts'
import { ExitIntentValidation } from '../../rules/exit-intent-validation.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

function specWithCheckout(exitIntent: Record<string, unknown>): CampaignSpec {
  return {
    schema_version: '4.3',
    offers: [{ ref_id: 'offer-a', code: 'PROMO' }],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'checkout with exit-intent for rule testing',
        weight: 100,
        pages: [
          { id: 'l', type: 'landing', next_page: 'c' },
          {
            id: 'c',
            type: 'checkout',
            label: 'Checkout',
            success_url: 'ty',
            exit_intent: exitIntent,
          },
          { id: 'ty', type: 'thankyou' },
        ],
      },
    ],
  }
}

describe('ExitIntentValidation rule', () => {
  test('placement check fires on non-checkout pages', () => {
    const fixture = fixtureByName('exit-intent-non-checkout')
    const violations = ExitIntentValidation.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('code-vs-ref mismatch fires when codes diverge', () => {
    const fixture = fixtureByName('exit-intent-code-mismatch')
    const violations = ExitIntentValidation.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('silent when exit_intent is not enabled', () => {
    const spec = specWithCheckout({ enabled: false })
    expect(ExitIntentValidation.check(normalize(spec))).toEqual([])
  })

  test('missing ref + missing code each fire their own violation', () => {
    const spec = specWithCheckout({ enabled: true })
    const violations = ExitIntentValidation.check(normalize(spec))
    const checks = violations.map((v) => v.data?.check).sort()
    // empty_catalog does not fire (catalog has offer-a). But missing_ref and missing_code do.
    expect(checks).toEqual(['missing_code', 'missing_ref'])
  })

  test('empty catalog warning fires when offers array is empty', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'exit-intent with empty offer catalog',
          weight: 100,
          pages: [
            {
              id: 'c',
              type: 'checkout',
              label: 'C',
              success_url: 'ty',
              exit_intent: {
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
    const violations = ExitIntentValidation.check(normalize(spec))
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
          hypothesis: 'exit intent points to offer with no voucher code',
          weight: 100,
          pages: [
            {
              id: 'c',
              type: 'checkout',
              label: 'C',
              success_url: 'ty',
              exit_intent: {
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
    const violations = ExitIntentValidation.check(normalize(spec))
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
              exit_intent: {
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
    expect(ExitIntentValidation.check(normalize(spec))).toEqual([])
  })
})
