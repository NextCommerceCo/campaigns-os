import { describe, expect, test } from '../harness.ts'
import { VariantLabelsShape } from '../../rules/variant-labels-shape.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

function baseSpec(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    schema_version: '4.3',
    runtime: { sdk_version: '0.4.0' },
    campaign: { ref_id: 1, slug: 'test', payment_env_key: 'test_key' },
    shipping_methods: [{ ref_id: 'ship-standard' }],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'Test funnel for variant labels.',
        weight: 100,
        pages: [
          { id: 'p-l', type: 'landing', label: 'Landing', next_page: 'p-up' },
          { id: 'p-up', type: 'upsell', label: 'Upsell', on_accept: 'p-ty', on_decline: 'p-ty' },
          { id: 'p-ty', type: 'thankyou', label: 'Thank You' },
        ],
      },
    ],
    ...overrides,
  }
}

describe('VariantLabelsShape rule', () => {
  test('silent when variant_labels is not set', () => {
    expect(VariantLabelsShape.check(normalize(baseSpec()))).toEqual([])
  })

  test('matches corpus fixture violations', () => {
    const fixture = fixtureByName('variant-labels-malformed')
    const violations = VariantLabelsShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('accepts primary-only on an upsell page (single-attribute product)', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].variant_labels = { primary: 'Size' }
    expect(VariantLabelsShape.check(normalize(spec))).toEqual([])
  })

  test('accepts primary + secondary on an upsell page', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].variant_labels = { primary: 'Size', secondary: 'Color' }
    expect(VariantLabelsShape.check(normalize(spec))).toEqual([])
  })

  test('flags variant_labels on non-upsell page', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].variant_labels = { primary: 'Size' }
    const violations = VariantLabelsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('labels-on-non-upsell')
    expect(violations[0].data?.pageType).toBe('landing')
  })

  test('flags empty primary', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].variant_labels = { primary: '' }
    const violations = VariantLabelsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('labels-primary-missing')
  })

  test('flags non-string secondary', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).variant_labels = { primary: 'Size', secondary: 42 }
    const violations = VariantLabelsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('labels-secondary-bad-type')
  })

  test('flags array shape (early return, no further checks)', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).variant_labels = ['Size', 'Color']
    const violations = VariantLabelsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('labels-bad-shape')
  })

  test('flags null shape', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).variant_labels = null
    const violations = VariantLabelsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('labels-bad-shape')
  })

  test('omitting secondary is allowed (single-attribute case)', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].variant_labels = { primary: 'Flavor' }
    expect(VariantLabelsShape.check(normalize(spec))).toEqual([])
  })

  test('secondary=null is allowed (explicit single-attribute marker)', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).variant_labels = { primary: 'Flavor', secondary: null }
    expect(VariantLabelsShape.check(normalize(spec))).toEqual([])
  })

  test('rule severity is warning', () => {
    expect(VariantLabelsShape.severity).toBe('warning')
  })

  test('rule has fast + spec-only tags', () => {
    expect(VariantLabelsShape.tags).toContain('fast')
    expect(VariantLabelsShape.tags).toContain('spec-only')
  })
})
