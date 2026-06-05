import { describe, expect, test } from 'bun:test'
import { CheckoutHasSuccessUrl } from '../../rules/checkout-has-success-url.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('CheckoutHasSuccessUrl rule', () => {
  test('flags when upsell exists but checkout success_url is missing', () => {
    const fixture = fixtureByName('checkout-missing-success-url')
    const violations = CheckoutHasSuccessUrl.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('silent when there is no upsell in the spec (rule precondition)', () => {
    // Checkout has no success_url and no upsell present — rule should stay quiet.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'checkout-only without upsell, success_url not required',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'c' },
            { id: 'c', type: 'checkout' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(CheckoutHasSuccessUrl.check(normalize(spec))).toEqual([])
  })

  test('passes when checkout has success_url and upsell exists', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(CheckoutHasSuccessUrl.check(normalize(spec))).toEqual([])
  })
})
