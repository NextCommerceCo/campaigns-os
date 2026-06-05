import { describe, expect, test } from '../harness.ts'
import { StoreProfileShape } from '../../rules/store-profile-shape.ts'
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
        hypothesis: 'Test funnel for store profile.',
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

describe('StoreProfileShape rule', () => {
  test('silent when neither field is set', () => {
    expect(StoreProfileShape.check(normalize(baseSpec()))).toEqual([])
  })

  test('matches corpus fixture violations', () => {
    const fixture = fixtureByName('store-profile-malformed')
    const violations = StoreProfileShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('accepts a tel: URI', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'tel:+18005551234'
    expect(StoreProfileShape.check(normalize(spec))).toEqual([])
  })

  test('accepts a tel: URI case-insensitively', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'TEL:+18005551234'
    expect(StoreProfileShape.check(normalize(spec))).toEqual([])
  })

  test('flags bare phone number without scheme', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = '+1-800-555-1234'
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-missing-scheme')
  })

  test('flags empty store_phone_tel string', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = ''
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-empty')
  })

  test('flags non-string store_phone_tel', () => {
    const spec = baseSpec()
    ;(spec.campaign as Record<string, unknown>).store_phone_tel = 18005551234
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-bad-type')
  })

  // Slice 4f follow-up: tel: content validation (defense-in-depth).

  test('accepts international tel: numbers with spaces and parens', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'tel:+44 (0)20 7946 0958'
    expect(StoreProfileShape.check(normalize(spec))).toEqual([])
  })

  test('flags tel: with javascript: scheme injection', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'tel:javascript:alert(1)'
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-bad-content')
  })

  test('flags tel: with HTML metacharacters', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'tel:<img src=x>'
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-bad-content')
  })

  test('flags tel: with control characters', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'tel:+1\n800\n5551234'
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-bad-content')
  })

  test('flags too-short tel: number', () => {
    const spec = baseSpec()
    spec.campaign!.store_phone_tel = 'tel:+1'
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('store-phone-tel-bad-content')
  })

  test('absent allowed_domains is silent (shape rule does not warn on absence)', () => {
    expect(StoreProfileShape.check(normalize(baseSpec()))).toEqual([])
  })

  test('accepts a valid allowed_domains array', () => {
    const spec = baseSpec()
    spec.campaign!.allowed_domains = ['store.example.com', 'campaign.example.com']
    expect(StoreProfileShape.check(normalize(spec))).toEqual([])
  })

  test('flags non-array allowed_domains', () => {
    const spec = baseSpec()
    ;(spec.campaign as Record<string, unknown>).allowed_domains = 'store.example.com'
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('allowed-domains-bad-shape')
  })

  test('flags empty allowed_domains array', () => {
    const spec = baseSpec()
    spec.campaign!.allowed_domains = []
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('allowed-domains-empty')
  })

  test('flags bad entries in allowed_domains', () => {
    const spec = baseSpec()
    ;(spec.campaign as Record<string, unknown>).allowed_domains = ['', 'good.example.com', 42]
    const violations = StoreProfileShape.check(normalize(spec))
    expect(violations).toHaveLength(2)
    expect(violations.every((v) => v.data?.check === 'allowed-domain-bad-entry')).toBe(true)
  })

  test('rule severity is warning', () => {
    expect(StoreProfileShape.severity).toBe('warning')
  })

  test('rule has fast + spec-only tags', () => {
    expect(StoreProfileShape.tags).toContain('fast')
    expect(StoreProfileShape.tags).toContain('spec-only')
  })
})
