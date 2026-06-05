import { describe, expect, test } from '../harness.ts'
import { UpsellRoutingComplete } from '../../rules/upsell-routing-complete.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('UpsellRoutingComplete rule', () => {
  test('flags missing accept and decline as two violations', () => {
    const fixture = fixtureByName('upsell-missing-routing')
    const violations = UpsellRoutingComplete.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('flags only the missing route when one of the two is set', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'upsell with accept but no decline',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'c' },
            { id: 'c', type: 'checkout', success_url: 'u' },
            {
              id: 'u',
              type: 'upsell',
              label: 'U',
              on_accept: 'ty',
              packages: [{ ref_id: 1, name: 'B', price: 19 }],
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = UpsellRoutingComplete.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.missing).toBe('on_decline')
  })

  test('passes when both routes are set', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(UpsellRoutingComplete.check(normalize(spec))).toEqual([])
  })
})
