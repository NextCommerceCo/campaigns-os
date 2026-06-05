import { describe, expect, test } from '../harness.ts'
import { PromoCodesShape } from '../../rules/promo-codes-shape.ts'
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
        hypothesis: 'Test funnel for promo codes.',
        weight: 100,
        pages: [
          { id: 'p-l', type: 'landing', label: 'Landing', next_page: 'p-co' },
          { id: 'p-co', type: 'checkout', label: 'Checkout', success_url: 'p-ty' },
          { id: 'p-ty', type: 'thankyou', label: 'Thank You' },
        ],
      },
    ],
    ...overrides,
  }
}

describe('PromoCodesShape rule', () => {
  test('silent when no promo_codes are set', () => {
    expect(PromoCodesShape.check(normalize(baseSpec()))).toEqual([])
  })

  test('matches corpus fixture violations', () => {
    const fixture = fixtureByName('promo-codes-malformed')
    const violations = PromoCodesShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('accepts a single valid promo code', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [
      { id: 'summer', code: 'SUMMER26', starts_at: '2026-06-15', ends_at: '2026-08-31' },
    ]
    expect(PromoCodesShape.check(normalize(spec))).toEqual([])
  })

  test('accepts a code with no schedule (always active)', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [{ id: 'evergreen', code: 'WELCOME' }]
    expect(PromoCodesShape.check(normalize(spec))).toEqual([])
  })

  test('flags non-array promo_codes', () => {
    const spec = baseSpec()
    ;(spec.funnels[0] as Record<string, unknown>).promo_codes = { id: 'x', code: 'Y' }
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('promo-codes-bad-shape')
  })

  test('flags non-object entries inside promo_codes array', () => {
    const spec = baseSpec()
    ;(spec.funnels[0] as Record<string, unknown>).promo_codes = [
      null,
      'SUMMER26',
      ['x'],
    ]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(3)
    expect(violations.every((v) => v.data?.check === 'promo-entry-bad-shape')).toBe(true)
    expect(violations.map((v) => v.data?.index)).toEqual([0, 1, 2])
  })

  test('silent on empty promo_codes array', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = []
    expect(PromoCodesShape.check(normalize(spec))).toEqual([])
  })

  test('flags duplicate ids', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [
      { id: 'dup', code: 'A' },
      { id: 'dup', code: 'B' },
    ]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('promo-id-duplicate')
  })

  test('flags case-insensitive code duplicates', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [
      { id: 'a', code: 'WELCOME' },
      { id: 'b', code: 'welcome' },
    ]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('promo-code-duplicate')
  })

  test('flags missing id and missing code separately', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [
      { id: '', code: 'NOID' },
      { id: 'nocode', code: '' },
    ]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => v.data?.check)).toEqual(['promo-id-missing', 'promo-code-missing'])
  })

  test('flags invalid date strings', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [{ id: 'x', code: 'X', starts_at: 'tomorrow' }]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('promo-starts-at-bad')
  })

  test('flags inverted ranges', () => {
    const spec = baseSpec()
    spec.funnels[0].promo_codes = [
      { id: 'x', code: 'X', starts_at: '2026-12-01', ends_at: '2026-01-01' },
    ]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('promo-range-inverted')
  })

  test('flags non-string visual fields', () => {
    const spec = baseSpec()
    ;(spec.funnels[0] as Record<string, unknown>).promo_codes = [
      { id: 'x', code: 'X', emoji: 42, title: ['hi'] },
    ]
    const violations = PromoCodesShape.check(normalize(spec))
    expect(violations).toHaveLength(2)
    expect(violations.every((v) => v.data?.check === 'promo-visual-bad-type')).toBe(true)
  })

  test('rule severity is warning', () => {
    expect(PromoCodesShape.severity).toBe('warning')
  })

  test('rule has fast + spec-only tags', () => {
    expect(PromoCodesShape.tags).toContain('fast')
    expect(PromoCodesShape.tags).toContain('spec-only')
  })
})
