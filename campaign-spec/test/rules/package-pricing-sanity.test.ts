import { describe, expect, test } from 'bun:test'
import { PackagePricingSanity } from '../../rules/package-pricing-sanity.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('PackagePricingSanity rule', () => {
  test('flags retail $0 with non-zero price', () => {
    const fixture = fixtureByName('bad-package-pricing')
    const violations = PackagePricingSanity.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('silent when price_retail is undefined (only fires when explicitly zero)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'package without price_retail set',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'ty' },
            {
              id: 'ty',
              type: 'thankyou',
              packages: [{ ref_id: 1, name: 'Pkg', price: 19 }],
            },
          ],
        },
      ],
    }
    expect(PackagePricingSanity.check(normalize(spec))).toEqual([])
  })

  test('silent when both price and retail are zero (consistent state)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'free package — both prices zero',
          weight: 100,
          pages: [
            {
              id: 'ty',
              type: 'thankyou',
              packages: [{ ref_id: 1, name: 'Free', price: 0, price_retail: 0 }],
            },
          ],
        },
      ],
    }
    expect(PackagePricingSanity.check(normalize(spec))).toEqual([])
  })

  test('coerces string prices through parseFloat', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'package with string-typed prices',
          weight: 100,
          pages: [
            {
              id: 'ty',
              type: 'thankyou',
              packages: [
                { ref_id: 1, name: 'Stringy', price: '29.99', price_retail: '0.00' },
              ],
            },
          ],
        },
      ],
    }
    const violations = PackagePricingSanity.check(normalize(spec))
    expect(violations).toHaveLength(1)
  })

  test('passes when retail > 0', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(PackagePricingSanity.check(normalize(spec))).toEqual([])
  })
})
