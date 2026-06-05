import { describe, expect, test } from 'bun:test'
import { UpsellHasPackages } from '../../rules/upsell-has-packages.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('UpsellHasPackages rule', () => {
  test('flags upsell with no packages array', () => {
    const fixture = fixtureByName('upsell-missing-packages')
    const violations = UpsellHasPackages.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('flags downsell with empty packages array', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'downsell with empty packages',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'c' },
            { id: 'c', type: 'checkout', success_url: 'd' },
            {
              id: 'd',
              type: 'downsell',
              label: 'D',
              on_accept: 'ty',
              on_decline: 'ty',
              packages: [],
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = UpsellHasPackages.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.pageType).toBe('downsell')
  })

  test('does not fire on non-offer page types', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(UpsellHasPackages.check(normalize(spec))).toEqual([])
  })
})
