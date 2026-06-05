import { describe, expect, test } from '../harness.ts'
import { DownsellWithoutUpsell } from '../../rules/downsell-without-upsell.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'

describe('DownsellWithoutUpsell rule', () => {
  test('flags downsell-only flow as warning', () => {
    const fixture = fixtureByName('downsell-without-upsell')
    const violations = DownsellWithoutUpsell.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
    expect(violations[0].severity).toBe('warning')
  })

  test('passes when both upsell and downsell exist', () => {
    const { spec } = fixtureByName('two-funnel-with-cycle')
    // variant funnel has both upsell and downsell
    expect(DownsellWithoutUpsell.check(normalize(spec))).toEqual([])
  })

  test('passes when there is no downsell', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(DownsellWithoutUpsell.check(normalize(spec))).toEqual([])
  })
})
