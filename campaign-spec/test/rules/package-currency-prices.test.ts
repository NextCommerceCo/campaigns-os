import { describe, expect, test } from '../harness.ts'
import { PackageCurrencyPrices } from '../../rules/package-currency-prices.ts'
import { fastRules, specOnlyRules } from '../../rules/index.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

function baseSpec(campaign: Record<string, unknown>, pkg: Record<string, unknown>): CampaignSpec {
  return {
    schema_version: '5.0',
    campaign: campaign as CampaignSpec['campaign'],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'package currency price rule testing',
        weight: 100,
        // The rows pass the wrong shapes a hand-written or API-copied spec can carry.
        pages: [{ id: 'p', type: 'checkout', label: 'Checkout', packages: [pkg as never] }, { id: 'ty', type: 'thankyou' }],
      },
    ],
  }
}

function check(campaign: Record<string, unknown>, pkg: Record<string, unknown>) {
  return PackageCurrencyPrices.check(normalize(baseSpec(campaign, pkg)))
}

const usdEur = { currency: 'USD', available_currencies: ['USD', 'EUR'] }

describe('PackageCurrencyPrices rule', () => {
  test('reports malformed, repeated and missing currency prices as warnings', () => {
    const fixture = fixtureByName('package-currency-prices')
    expect(PackageCurrencyPrices.check(normalize(fixture.spec))).toEqual(fixture.expected.violations)
  })

  test('accepts a row priced in every currency the campaign sells in', () => {
    const prices = [{ currency: 'USD', price: '49.99' }, { currency: 'EUR', price: 46.99, price_retail: null }]
    expect(check(usdEur, { ref_id: 1, qty: 1, prices })).toEqual([])
  })

  test('is silent for a row without prices', () => {
    expect(check(usdEur, { ref_id: 1, qty: 1, price: '49.99' })).toEqual([])
    expect(check(usdEur, { ref_id: 1, qty: 1, prices: null })).toEqual([])
  })

  test('the default currency counts as sold in when the list is empty or omits it', () => {
    expect(check({ currency: 'EUR', available_currencies: [] }, { ref_id: 1, prices: [] }).map((v) => v.data?.missing)).toEqual([['EUR']])
    expect(check({ currency: 'USD', available_currencies: ['EUR'] }, { ref_id: 1, prices: [{ currency: 'EUR', price: '1' }] }).map((v) => v.data?.missing)).toEqual([['USD']])
  })

  test('leaves malformed campaign currency codes to CampaignCurrencies', () => {
    expect(check({ currency: 'usd', available_currencies: ['EURO'] }, { ref_id: 1, prices: [] })).toEqual([])
  })

  test('prices that is not an array is reported once', () => {
    const violations = check(usdEur, { ref_id: 1, prices: { USD: '49.99' } })
    expect(violations.map((v) => [v.path, v.severity, v.data?.check])).toEqual([
      ['/funnels/0/pages/0/packages/0/prices', 'warning', 'prices_shape'],
    ])
  })

  test('a negative or non-numeric price is malformed', () => {
    const violations = check(usdEur, { ref_id: 1, prices: [{ currency: 'USD', price: '-1' }, { currency: 'EUR', price: 'free' }] })
    expect(violations.map((v) => v.data?.check)).toEqual(['price_entry_shape', 'price_entry_shape'])
  })

  test('runs in the fast and spec-only presets', () => {
    expect(fastRules.includes(PackageCurrencyPrices)).toBe(true)
    expect(specOnlyRules.includes(PackageCurrencyPrices)).toBe(true)
  })
})
