import { describe, expect, test } from '../harness.ts'
import { FunnelHypothesisLength } from '../../rules/funnel-hypothesis-length.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('FunnelHypothesisLength rule', () => {
  test('flags hypothesis shorter than 10 chars', () => {
    const fixture = fixtureByName('hypothesis-too-short')
    const violations = FunnelHypothesisLength.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('flags hypothesis longer than 500 chars', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'verbose',
          name: 'Verbose',
          hypothesis: 'x'.repeat(501),
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = FunnelHypothesisLength.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toBe('Funnel "verbose" — hypothesis must be at most 500 chars (got 501).')
    expect(violations[0].path).toBe('/funnels/0/hypothesis')
  })

  test('accepts exactly 10 chars', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'tight',
          name: 'Tight',
          hypothesis: '1234567890',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    expect(FunnelHypothesisLength.check(normalize(spec))).toEqual([])
  })

  test('accepts exactly 500 chars', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'verbose',
          name: 'Verbose',
          hypothesis: 'x'.repeat(500),
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    expect(FunnelHypothesisLength.check(normalize(spec))).toEqual([])
  })

  test('treats null hypothesis as length 0', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'empty',
          name: 'Empty',
          // hypothesis omitted
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = FunnelHypothesisLength.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.length).toBe(0)
  })
})
