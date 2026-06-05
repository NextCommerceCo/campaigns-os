import { describe, expect, test } from '../harness.ts'
import { UpsellWithoutCheckout } from '../../rules/upsell-without-checkout.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('UpsellWithoutCheckout rule', () => {
  test('full-scope spec with upsell but no checkout is an error', () => {
    const fixture = fixtureByName('upsell-without-checkout')
    const violations = UpsellWithoutCheckout.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('partial-scope spec with same shape downgrades to warning', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      build_scope: { mode: 'partial' },
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'partial upsell build routes from an existing upstream checkout',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'u' },
            {
              id: 'u',
              type: 'upsell',
              label: 'U',
              on_accept: 'ty',
              on_decline: 'ty',
              packages: [{ ref_id: 1, name: 'B', price: 19 }],
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = UpsellWithoutCheckout.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
  })

  test('passes when both upsell and checkout exist', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(UpsellWithoutCheckout.check(normalize(spec))).toEqual([])
  })

  test('passes when neither upsell nor checkout exist', () => {
    const { spec } = fixtureByName('missing-thank-you-full-scope')
    // landing + checkout only, no upsell — rule has nothing to flag.
    expect(UpsellWithoutCheckout.check(normalize(spec))).toEqual([])
  })
})
