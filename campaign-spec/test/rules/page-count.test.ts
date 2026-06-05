import { describe, expect, test } from 'bun:test'
import { PageCount } from '../../rules/page-count.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('PageCount rule', () => {
  test('flags when no funnel has any pages', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'empty',
          name: 'Empty',
          hypothesis: 'funnel with no pages',
          weight: 100,
          pages: [],
        },
      ],
    }
    const violations = PageCount.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toBe('Funnel must have at least 1 page.')
    expect(violations[0].path).toBe('/funnels')
  })

  test('flags when funnels array is empty', () => {
    const { spec } = fixtureByName('empty-funnels')
    const violations = PageCount.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.totalPages).toBe(0)
  })

  test('passes when at least one funnel has at least one page', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(PageCount.check(normalize(spec))).toEqual([])
  })
})
