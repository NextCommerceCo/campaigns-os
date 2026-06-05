/**
 * Per-rule unit tests for FunnelWeightSum.
 *
 * Exercises both failure modes: per-funnel out-of-range weights and aggregate
 * sums that miss 100 ± 0.01.
 */

import { describe, expect, test } from 'bun:test'
import { FunnelWeightSum } from '../../rules/funnel-weight-sum.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('FunnelWeightSum rule', () => {
  test('single 100% funnel emits no violations', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(FunnelWeightSum.check(normalize(spec))).toEqual([])
  })

  test('two 50/50 funnels emit no violations', () => {
    const { spec } = fixtureByName('two-funnel-with-cycle')
    expect(FunnelWeightSum.check(normalize(spec))).toEqual([])
  })

  test('50 + 49 = 99 emits aggregate violation at /funnels', () => {
    const fixture = fixtureByName('weight-sum-imbalanced')
    const violations = FunnelWeightSum.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('weight 150 emits per-funnel violation at /funnels/0/weight', () => {
    const fixture = fixtureByName('weight-out-of-range')
    const violations = FunnelWeightSum.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
    expect(violations[0].path).toBe('/funnels/0/weight')
  })

  test('33.33 + 33.33 + 33.34 (= 100 within float tolerance) is accepted', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        { id: 'a', name: 'A', hypothesis: 'thirds', weight: 33.33, pages: [{ id: 'a', type: 'thankyou' }] },
        { id: 'b', name: 'B', hypothesis: 'thirds', weight: 33.33, pages: [{ id: 'b', type: 'thankyou' }] },
        { id: 'c', name: 'C', hypothesis: 'thirds', weight: 33.34, pages: [{ id: 'c', type: 'thankyou' }] },
      ],
    }
    expect(FunnelWeightSum.check(normalize(spec))).toEqual([])
  })

  test('non-numeric weight is treated as out-of-range', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'bad',
          name: 'Bad',
          hypothesis: 'weight is a string',
          weight: 'oops' as unknown as number,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = FunnelWeightSum.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].path).toBe('/funnels/0/weight')
    expect(violations[0].data?.weight).toBe('oops')
  })
})
