import { describe, expect, test } from '../harness.ts'
import { ShippingMethodsPresent } from '../../rules/shipping-methods-present.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('ShippingMethodsPresent rule', () => {
  test('flags an empty shipping_methods array', () => {
    const fixture = fixtureByName('missing-shipping-methods')
    const violations = ShippingMethodsPresent.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('flags missing shipping_methods (undefined)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'shipping_methods omitted entirely',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = ShippingMethodsPresent.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
  })

  test('passes when at least one shipping method is present', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(ShippingMethodsPresent.check(normalize(spec))).toEqual([])
  })
})
