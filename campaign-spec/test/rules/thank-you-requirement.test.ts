import { describe, expect, test } from '../harness.ts'
import { ThankYouRequirement } from '../../rules/thank-you-requirement.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('ThankYouRequirement rule', () => {
  test('full-scope spec without thank-you is an error', () => {
    const fixture = fixtureByName('missing-thank-you-full-scope')
    const violations = ThankYouRequirement.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('partial-scope spec without thank-you is a warning', () => {
    const fixture = fixtureByName('missing-thank-you-partial-scope')
    const violations = ThankYouRequirement.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
    expect(violations[0].severity).toBe('warning')
  })

  test('silent when there are zero pages (PageCount handles that)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'empty',
          name: 'Empty',
          hypothesis: 'no pages at all',
          weight: 100,
          pages: [],
        },
      ],
    }
    expect(ThankYouRequirement.check(normalize(spec))).toEqual([])
  })

  test('one thankyou page anywhere is sufficient', () => {
    const { spec } = fixtureByName('two-funnel-with-cycle')
    expect(ThankYouRequirement.check(normalize(spec))).toEqual([])
  })
})
