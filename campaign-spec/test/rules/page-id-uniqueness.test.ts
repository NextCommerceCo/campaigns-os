import { describe, expect, test } from '../harness.ts'
import { PageIdUniqueness } from '../../rules/page-id-uniqueness.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('PageIdUniqueness rule', () => {
  test('flags cross-funnel duplicate at the second occurrence', () => {
    const fixture = fixtureByName('duplicate-page-ids')
    const violations = PageIdUniqueness.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('reports each duplicated id exactly once, not per occurrence', () => {
    // Same page id appears three times — should still report once.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'a',
          name: 'A',
          hypothesis: 'first occurrence of dup id',
          weight: 33,
          pages: [{ id: 'dup', type: 'thankyou' }],
        },
        {
          id: 'b',
          name: 'B',
          hypothesis: 'second occurrence of dup id',
          weight: 33,
          pages: [{ id: 'dup', type: 'thankyou' }],
        },
        {
          id: 'c',
          name: 'C',
          hypothesis: 'third occurrence of dup id',
          weight: 34,
          pages: [{ id: 'dup', type: 'thankyou' }],
        },
      ],
    }
    const violations = PageIdUniqueness.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.pageId).toBe('dup')
  })

  test('skips pages with missing id (different concern)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'funnel with an id-less page',
          weight: 100,
          pages: [
            { id: '', type: 'landing' } as unknown as CampaignSpec['funnels'][0]['pages'] extends Array<infer P> ? P : never,
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(PageIdUniqueness.check(normalize(spec))).toEqual([])
  })

  test('passes when all page ids are unique', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(PageIdUniqueness.check(normalize(spec))).toEqual([])
  })

  test('passes for cross-funnel routing as long as ids differ', () => {
    const { spec } = fixtureByName('two-funnel-with-cycle')
    expect(PageIdUniqueness.check(normalize(spec))).toEqual([])
  })
})
