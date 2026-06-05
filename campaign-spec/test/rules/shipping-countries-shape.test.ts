import { describe, expect, test } from 'bun:test'
import { ShippingCountriesShape } from '../../rules/shipping-countries-shape.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

function baseSpec(countries: unknown): CampaignSpec {
  return {
    schema_version: '4.3',
    campaign: {
      // available_shipping_countries is typed narrowly; tests deliberately
      // exercise the "what if it's wrong" path that the type system normally
      // blocks. Cast lets us pass arbitrary shapes through the rule.
      available_shipping_countries: countries as 'all' | string[],
    },
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'shipping countries shape testing',
        weight: 100,
        pages: [{ id: 'p', type: 'thankyou' }],
      },
    ],
  }
}

describe('ShippingCountriesShape rule', () => {
  test('flags bare string', () => {
    const fixture = fixtureByName('bad-shipping-countries')
    const violations = ShippingCountriesShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('accepts the literal "all"', () => {
    expect(ShippingCountriesShape.check(normalize(baseSpec('all')))).toEqual([])
  })

  test('accepts an array of country codes', () => {
    expect(ShippingCountriesShape.check(normalize(baseSpec(['US', 'CA'])))).toEqual([])
  })

  test('accepts undefined (null is fine, field is optional)', () => {
    expect(ShippingCountriesShape.check(normalize(baseSpec(undefined)))).toEqual([])
  })

  test('flags an object', () => {
    const violations = ShippingCountriesShape.check(normalize(baseSpec({ allowed: ['US'] })))
    expect(violations).toHaveLength(1)
  })
})
