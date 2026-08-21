import { describe, expect, test } from '../harness.ts'
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

  test('still flags a real page ref when the catalog is keyed by package_ref_id only', () => {
    // Regression: catalog offers without ref_id used to be indexed as the
    // string "undefined", which let refs "resolve" against nothing.
    const spec = {
      schema_version: '4.3',
      offers: [{ package_ref_id: 7, code: 'PROMO' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'catalog has no ref_ids, page ref must still be judged',
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
    const violations = OfferRefIntegrity.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('OfferRefIntegrity')
    expect(violations[0].data?.refId).toBe('offer-a')
  })

  test('silent when page and catalog offers both use only package_ref_id', () => {
    // ref_id vs package_ref_id identity canonicalization is deferred to a
    // later decision pass; ref_id-less page offers are skipped, not flagged.
    const spec = {
      schema_version: '4.3',
      offers: [{ package_ref_id: 7, code: 'PROMO' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'package_ref_id on both sides is out of scope for this rule',
          weight: 100,
          pages: [
            {
              id: 'l',
              type: 'landing',
              next_page: 'ty',
              offers: [{ package_ref_id: 7 }],
            },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(OfferRefIntegrity.check(normalize(spec))).toEqual([])
  })
})
