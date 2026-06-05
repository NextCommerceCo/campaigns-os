import { describe, expect, test } from '../harness.ts'
import { FunnelCount } from '../../rules/funnel-count.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec, Funnel } from '../../types.ts'

function funnel(id: string): Funnel {
  return {
    id,
    name: id,
    hypothesis: `funnel ${id} for count testing`,
    weight: 0,
    pages: [{ id: `${id}-p`, type: 'thankyou' }],
  }
}

describe('FunnelCount rule', () => {
  test('flags 0 funnels', () => {
    const fixture = fixtureByName('empty-funnels')
    const violations = FunnelCount.check(normalize(fixture.spec))
    // Per-rule test asserts only the FunnelCount portion of the fixture's
    // expected violations. (empty-funnels also produces PageCount, which
    // gets exercised in its own per-rule test and in the corpus contract.)
    const funnelCountExpected = fixture.expected.violations.filter(
      (v) => v.ruleId === 'FunnelCount',
    )
    expect(violations).toEqual(funnelCountExpected)
  })

  test('flags > 10 funnels', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: Array.from({ length: 11 }, (_, i) => funnel(`f${i}`)),
    }
    const violations = FunnelCount.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toBe('Spec defines 11 funnels; max is 10.')
    expect(violations[0].path).toBe('/funnels')
  })

  test('accepts 1 funnel', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(FunnelCount.check(normalize(spec))).toEqual([])
  })

  test('accepts 10 funnels', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: Array.from({ length: 10 }, (_, i) => funnel(`f${i}`)),
    }
    expect(FunnelCount.check(normalize(spec))).toEqual([])
  })
})
