import { describe, expect, test } from 'bun:test'
import { OfferRefIntegrity } from '../../rules/offer-ref-integrity.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('OfferRefIntegrity rule', () => {
  test('flags page-level offer ref not in spec catalog', () => {
    const fixture = fixtureByName('orphan-offer-ref')
    const violations = OfferRefIntegrity.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('passes when page-level offer refs resolve in catalog', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [{ ref_id: 'offer-a', code: 'PROMO' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'page-level offer ref resolves in catalog',
          weight: 100,
          pages: [
            {
              id: 'l',
              type: 'landing',
              next_page: 'ty',
              offers: [{ ref_id: 'offer-a' }],
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(OfferRefIntegrity.check(normalize(spec))).toEqual([])
  })

  test('emits one violation per orphaned ref, not deduped across pages', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      offers: [],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'two pages both reference the same missing offer',
          weight: 100,
          pages: [
            {
              id: 'l1',
              type: 'landing',
              next_page: 'l2',
              offers: [{ ref_id: 'ghost' }],
            },
            {
              id: 'l2',
              type: 'landing',
              next_page: 'ty',
              offers: [{ ref_id: 'ghost' }],
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = OfferRefIntegrity.check(normalize(spec))
    expect(violations).toHaveLength(2)
  })

  test('silent when page has no offers array', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(OfferRefIntegrity.check(normalize(spec))).toEqual([])
  })
})
