import { describe, expect, test } from '../harness.ts'
import { FunnelIdentity } from '../../rules/funnel-identity.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('FunnelIdentity rule', () => {
  test('flags duplicate funnel ids at the duplicate location', () => {
    const fixture = fixtureByName('duplicate-funnel-ids')
    const violations = FunnelIdentity.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('flags missing funnel id', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: '',
          name: 'No ID',
          hypothesis: 'funnel without an id',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = FunnelIdentity.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toBe('Funnel is missing an id.')
    expect(violations[0].path).toBe('/funnels/0/id')
  })

  test('flags missing funnel name', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: '   ',
          hypothesis: 'funnel with whitespace-only name',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = FunnelIdentity.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toBe('Funnel "f" — name is required.')
    expect(violations[0].path).toBe('/funnels/0/name')
  })

  test('passes valid identity', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(FunnelIdentity.check(normalize(spec))).toEqual([])
  })
})
