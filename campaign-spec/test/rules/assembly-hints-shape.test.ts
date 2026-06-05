import { describe, expect, test } from 'bun:test'
import { AssemblyHintsShape } from '../../rules/assembly-hints-shape.ts'
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
        hypothesis: 'Test funnel for assembly hints.',
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

describe('AssemblyHintsShape rule', () => {
  test('silent when no hints are set', () => {
    expect(AssemblyHintsShape.check(normalize(baseSpec()))).toEqual([])
  })

  test('matches corpus fixture violations', () => {
    const fixture = fixtureByName('assembly-hints-malformed')
    const violations = AssemblyHintsShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('accepts a recognized template family + upsell pattern', () => {
    const spec = baseSpec()
    spec.campaign!.preferred_template_family = 'olympus-mv-single-step'
    spec.funnels[0].pages![1].upsell_template_pattern = 'mv'
    expect(AssemblyHintsShape.check(normalize(spec))).toEqual([])
  })

  test('flags empty template family string', () => {
    const spec = baseSpec()
    spec.campaign!.preferred_template_family = ''
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('template-family-empty')
  })

  test('flags unknown template family', () => {
    const spec = baseSpec()
    spec.campaign!.preferred_template_family = 'olypmus-typo'
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('template-family-unknown')
    expect(violations[0].data?.value).toBe('olypmus-typo')
  })

  test('flags upsell pattern on non-upsell page', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].upsell_template_pattern = 'mv'
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('pattern-on-non-upsell')
    expect(violations[0].data?.pageType).toBe('landing')
  })

  test('flags unknown upsell pattern', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].upsell_template_pattern = 'wild_variant'
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('pattern-unknown')
    expect(violations[0].data?.value).toBe('wild_variant')
  })

  test('flags both an empty pattern and non-upsell placement only as empty (no double-fire)', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].upsell_template_pattern = ''
    const violations = AssemblyHintsShape.check(normalize(spec))
    // Empty-string short-circuits before placement/known-set checks fire.
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('pattern-empty')
  })

  test('all known template families pass without violation', () => {
    const known = [
      'olympus',
      'limos',
      'demeter',
      'olympus-mv-single-step',
      'olympus-mv-two-step',
      'shop-single-step',
      'shop-three-step',
    ]
    for (const family of known) {
      const spec = baseSpec()
      spec.campaign!.preferred_template_family = family
      expect(AssemblyHintsShape.check(normalize(spec))).toEqual([])
    }
  })

  test('all known upsell patterns pass without violation', () => {
    const known = ['mv', 'bundle_tier_pills', 'bundle_tier_cards', 'single']
    for (const pattern of known) {
      const spec = baseSpec()
      spec.funnels[0].pages![1].upsell_template_pattern = pattern
      expect(AssemblyHintsShape.check(normalize(spec))).toEqual([])
    }
  })

  test('rule severity is warning', () => {
    expect(AssemblyHintsShape.severity).toBe('warning')
  })

  test('rule has fast + spec-only tags', () => {
    expect(AssemblyHintsShape.tags).toContain('fast')
    expect(AssemblyHintsShape.tags).toContain('spec-only')
  })

  // ── Slice 4b: upsell_mv_tiers ────────────────────────────────────────────

  test('accepts valid upsell_mv_tiers on an upsell page', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].upsell_mv_tiers = { min: 1, max: 5 }
    expect(AssemblyHintsShape.check(normalize(spec))).toEqual([])
  })

  test('accepts equal min and max (single-tier range)', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].upsell_mv_tiers = { min: 3, max: 3 }
    expect(AssemblyHintsShape.check(normalize(spec))).toEqual([])
  })

  test('flags upsell_mv_tiers on non-upsell page', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].upsell_mv_tiers = { min: 1, max: 3 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-on-non-upsell')
    expect(violations[0].data?.pageType).toBe('landing')
  })

  test('flags upsell_mv_tiers with bad outer shape (array)', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).upsell_mv_tiers = [1, 5]
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-bad-shape')
  })

  test('flags upsell_mv_tiers with bad outer shape (null)', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).upsell_mv_tiers = null
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-bad-shape')
  })

  test('flags upsell_mv_tiers missing max', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).upsell_mv_tiers = { min: 1 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-missing-field')
    expect(violations[0].data?.hasMin).toBe(true)
    expect(violations[0].data?.hasMax).toBe(false)
  })

  test('flags upsell_mv_tiers missing both fields', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).upsell_mv_tiers = {}
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-missing-field')
    expect(violations[0].data?.hasMin).toBe(false)
    expect(violations[0].data?.hasMax).toBe(false)
  })

  test('flags upsell_mv_tiers with non-integer min', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).upsell_mv_tiers = { min: 1.5, max: 5 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-bad-type')
  })

  test('flags upsell_mv_tiers with zero min (must be >= 1)', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].upsell_mv_tiers = { min: 0, max: 5 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-bad-type')
  })

  test('flags upsell_mv_tiers with string min', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![1] as Record<string, unknown>).upsell_mv_tiers = { min: '1', max: 5 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-bad-type')
  })

  test('flags upsell_mv_tiers with min > max', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![1].upsell_mv_tiers = { min: 5, max: 2 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('tiers-bad-range')
    expect(violations[0].data?.min).toBe(5)
    expect(violations[0].data?.max).toBe(2)
  })

  test('non-upsell page with bad tiers double-fires placement + shape', () => {
    const spec = baseSpec()
    ;(spec.funnels[0].pages![0] as Record<string, unknown>).upsell_mv_tiers = { min: 1 }
    const violations = AssemblyHintsShape.check(normalize(spec))
    // tiers-on-non-upsell + tiers-missing-field — placement is independent of
    // shape, mirroring the pattern-on-non-upsell + pattern-unknown pairing.
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => v.data?.check).sort()).toEqual(['tiers-missing-field', 'tiers-on-non-upsell'])
  })
})
