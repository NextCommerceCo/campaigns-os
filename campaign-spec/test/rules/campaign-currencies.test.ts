import { describe, expect, test } from '../harness.ts'
import { CampaignCurrencies } from '../../rules/campaign-currencies.ts'
import { fastRules, specOnlyRules } from '../../rules/index.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

function baseSpec(campaign: Record<string, unknown>): CampaignSpec {
  return {
    schema_version: '5.0',
    // The fields are typed as strings; these tests pass the wrong shapes a
    // hand-written or API-copied spec can carry.
    campaign: campaign as CampaignSpec['campaign'],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'campaign currency rule testing',
        weight: 100,
        pages: [{ id: 'p', type: 'thankyou' }],
      },
    ],
  }
}

function check(campaign: Record<string, unknown>) {
  return CampaignCurrencies.check(normalize(baseSpec(campaign)))
}

describe('CampaignCurrencies rule', () => {
  test('flags lower-case and non-ISO codes as errors', () => {
    const fixture = fixtureByName('bad-currency-codes')
    expect(CampaignCurrencies.check(normalize(fixture.spec))).toEqual(fixture.expected.violations)
  })

  test('warns when the default currency is missing from the list', () => {
    const fixture = fixtureByName('currency-not-available')
    expect(CampaignCurrencies.check(normalize(fixture.spec))).toEqual(fixture.expected.violations)
  })

  test('accepts upper-case ISO codes with the default listed', () => {
    expect(check({ currency: 'USD', available_currencies: ['USD', 'EUR', 'GBP'] })).toEqual([])
  })

  test('is silent when the fields are absent, null or empty', () => {
    expect(check({})).toEqual([])
    expect(check({ currency: null, available_currencies: null })).toEqual([])
    expect(check({ currency: '', available_currencies: [] })).toEqual([])
  })

  test('an empty list states nothing, so the default is not reported as missing', () => {
    expect(check({ currency: 'EUR', available_currencies: [] })).toEqual([])
  })

  test('rejects three upper-case letters that are not an ISO 4217 code', () => {
    const violations = check({ currency: 'ABC', available_currencies: ['EURO'] })
    expect(violations.map((v) => [v.path, v.severity, v.data?.check])).toEqual([
      ['/campaign/currency', 'error', 'currency_code'],
      ['/campaign/available_currencies/0', 'error', 'available_currency_code'],
    ])
  })

  test('reports a { code, label } entry with the code to write instead', () => {
    const violations = check({ currency: 'USD', available_currencies: ['USD', { code: 'EUR', label: 'Euro' }] })
    expect(violations).toHaveLength(1)
    expect(violations[0].path).toBe('/campaign/available_currencies/1')
    expect(violations[0].severity).toBe('error')
    expect(violations[0].data?.suggestion).toBe('EUR')
    expect(violations[0].message.includes('Write it as "EUR"')).toBe(true)
  })

  test('a list entry already reported in lower case does not also make the default read as missing', () => {
    const violations = check({ currency: 'USD', available_currencies: ['usd', 'EUR'] })
    expect(violations.map((v) => v.data?.check)).toEqual(['available_currency_code'])
  })

  test('skips the membership check when the default itself is malformed', () => {
    const violations = check({ currency: 'usd', available_currencies: ['EUR'] })
    expect(violations.map((v) => v.data?.check)).toEqual(['currency_code'])
  })

  test('a list that is not an array is an error', () => {
    const violations = check({ currency: 'USD', available_currencies: 'USD,EUR' })
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('available_currencies_shape')
    expect(violations[0].severity).toBe('error')
  })

  test('a non-string default is an error', () => {
    const violations = check({ currency: 840 })
    expect(violations).toHaveLength(1)
    expect(violations[0].path).toBe('/campaign/currency')
  })

  test('runs in the fast and spec-only presets', () => {
    expect(fastRules.includes(CampaignCurrencies)).toBe(true)
    expect(specOnlyRules.includes(CampaignCurrencies)).toBe(true)
  })
})
