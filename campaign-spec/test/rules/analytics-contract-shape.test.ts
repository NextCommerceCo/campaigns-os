import { describe, expect, test } from '../harness.ts'
import { AnalyticsContractShape } from '../../rules/analytics-contract-shape.ts'
import { allRules, fastRules, specOnlyRules } from '../../rules/index.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { AnalyticsContract, CampaignSpec } from '../../types.ts'

function baseSpec(analytics?: AnalyticsContract, sdkVersion = '0.4.30'): CampaignSpec {
  return {
    schema_version: '4.3',
    runtime: { sdk_version: sdkVersion },
    campaign: { ref_id: 1, slug: 'test', payment_env_key: 'test_key' },
    shipping_methods: [{ ref_id: 'ship-standard' }],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'Test funnel for the analytics contract rule.',
        weight: 100,
        pages: [
          { id: 'p-l', type: 'landing', label: 'Landing', next_page: 'p-co' },
          { id: 'p-co', type: 'checkout', label: 'Checkout', success_url: 'p-u1' },
          { id: 'p-u1', type: 'upsell', label: 'Upsell 1', on_accept: 'p-ty', on_decline: 'p-ty' },
          { id: 'p-ty', type: 'thankyou', label: 'Thank You' },
        ],
      },
    ],
    ...(analytics ? { analytics } : {}),
  }
}

const checks = (spec: CampaignSpec): string[] =>
  AnalyticsContractShape.check(normalize(spec)).map((v) => String(v.data?.check))

describe('AnalyticsContractShape rule', () => {
  test('silent when no analytics block is present', () => {
    expect(AnalyticsContractShape.check(normalize(baseSpec()))).toEqual([])
  })

  // Fix #2 (downstream consumer-PR review): a present-but-non-object
  // analytics value used to silently pass. It must now warn once.
  test('warns when analytics is a string instead of an object', () => {
    const spec = baseSpec()
    ;(spec as { analytics?: unknown }).analytics = 'auto'
    const c = checks(spec)
    expect(c).toEqual(['analytics-shape'])
  })

  test('warns when analytics is an array instead of an object', () => {
    const spec = baseSpec()
    ;(spec as { analytics?: unknown }).analytics = [{ mode: 'auto' }]
    const c = checks(spec)
    expect(c).toEqual(['analytics-shape'])
  })

  test('warns when analytics is a number instead of an object', () => {
    const spec = baseSpec()
    ;(spec as { analytics?: unknown }).analytics = 1
    expect(checks(spec)).toEqual(['analytics-shape'])
  })

  test('warns when analytics is a boolean true instead of an object', () => {
    const spec = baseSpec()
    ;(spec as { analytics?: unknown }).analytics = true
    expect(checks(spec)).toEqual(['analytics-shape'])
  })

  test('warns when analytics is a boolean false instead of an object', () => {
    // Pins the guard against future refactors that add `!analytics` and
    // accidentally swallow false (false is falsy but not a valid contract block).
    const spec = baseSpec()
    ;(spec as { analytics?: unknown }).analytics = false
    expect(checks(spec)).toEqual(['analytics-shape'])
  })

  test('warns when analytics is a boxed primitive instead of a plain object', () => {
    // new String("auto") passes typeof === 'object' but is not a plain contract
    // block; the prototype guard must catch it.
    const spec = baseSpec()
    ;(spec as { analytics?: unknown }).analytics = new String('auto')
    expect(checks(spec)).toEqual(['analytics-shape'])
  })

  test('genuinely-absent analytics stays silent (null or undefined)', () => {
    const undef = baseSpec()
    expect(AnalyticsContractShape.check(normalize(undef))).toEqual([])
    const nul = baseSpec()
    ;(nul as { analytics?: unknown }).analytics = null
    expect(AnalyticsContractShape.check(normalize(nul))).toEqual([])
  })

  // Fix #1 (downstream consumer-PR review): the rule is dual-tagged
  // ['fast', 'spec-only']. fastRules / specOnlyRules are mutually-exclusive
  // FILTERED VIEWS of allRules — a pass runs one RuleSet, so the rule never
  // double-runs. Guard that each preset lists it exactly once (no duplicates).
  test('rule appears exactly once in each preset (no double-run)', () => {
    const count = (set: typeof allRules) =>
      set.filter((r) => r.id === 'AnalyticsContractShape').length
    expect(count(allRules)).toBe(1)
    expect(count(fastRules)).toBe(1)
    expect(count(specOnlyRules)).toBe(1)
  })

  test('running fastRules then specOnlyRules each yields one set of analytics warnings', () => {
    const spec = normalize(baseSpec({ mode: 'on' as never }))
    const fastWarnings = fastRules
      .flatMap((r) => r.check(spec))
      .filter((v) => v.ruleId === 'AnalyticsContractShape')
    const specWarnings = specOnlyRules
      .flatMap((r) => r.check(spec))
      .filter((v) => v.ruleId === 'AnalyticsContractShape')
    // Same single warning in each view — not doubled within a pass.
    expect(fastWarnings.length).toBe(1)
    expect(specWarnings.length).toBe(1)
    expect(fastWarnings).toEqual(specWarnings)
  })

  test('declared fixture passes while malformed fixture retains its known violations', () => {
    const declared = fixtureByName('analytics-contract-declared')
    const malformed = fixtureByName('analytics-contract-malformed')

    expect(AnalyticsContractShape.check(normalize(declared.spec))).toEqual([])
    expect(AnalyticsContractShape.check(normalize(malformed.spec))).toEqual(malformed.expected.violations)
  })

  test('accepts a well-formed analytics block (the worked example shape)', () => {
    const spec = baseSpec({
      mode: 'auto',
      providers: {
        gtm: { enabled: true, containerId: 'GTM-ABC123' },
        facebook: { enabled: true, pixelId: '998877', blockedEvents: ['dl_begin_checkout'] },
      },
      out_of_band_pixels: [{ vendor: 'everflow', loaded_via: 'gtm' }],
      manual_events: [
        { event: 'dl_begin_checkout', page: 'p-co', trigger: 'field-focus' },
        { event: 'dl_purchase', page: 'p-u1', trigger: 'page-load' },
      ],
      utmTransfer: { enabled: true, applyToExternalLinks: false, paramsToCopy: ['utm_source', 'gclid'] },
      params: {
        content: [{ name: 'reviews', hides: 'reviews', pages: ['p-l'] }],
        tracking: {
          preserve: ['utm_source', 'sub2'],
          across: ['landing', 'checkout', 'upsell', 'thankyou'],
          click_id: { inbound: 'sub2', maps_to: 'subaffiliate2' },
          external_trackers: ['redtrack'],
        },
      },
    })
    expect(AnalyticsContractShape.check(normalize(spec))).toEqual([])
  })

  test('flags an invalid mode', () => {
    expect(checks(baseSpec({ mode: 'on' as never }))).toContain('mode-invalid')
  })

  test('warns when analytics is declared below the SDK identity baseline', () => {
    const spec = baseSpec({ mode: 'auto' }, '0.4.29')
    const violations = AnalyticsContractShape.check(normalize(spec))
    const warning = violations.find((v) => v.data?.check === 'sdk-identity-baseline')
    expect(warning?.path).toBe('/runtime/sdk_version')
    expect(warning?.data?.sdkVersion).toBe('0.4.29')
    expect(warning?.data?.minimumSdkVersion).toBe('0.4.30')
  })

  test('warns when analytics is declared with an unparseable SDK pin', () => {
    for (const sdkVersion of ['^0.4.30', 'latest', '0.4', '1.0', '~0.4.30']) {
      const violations = AnalyticsContractShape.check(normalize(baseSpec({ mode: 'auto' }, sdkVersion)))
      const warning = violations.find((v) => v.data?.check === 'sdk-version-unparseable')
      expect(warning?.path).toBe('/runtime/sdk_version')
      expect(warning?.data?.sdkVersion).toBe(sdkVersion)
      expect(warning?.data?.expectedFormat).toBe('MAJOR.MINOR.PATCH')
    }
  })

  test('warns when analytics is declared with prerelease or build-metadata SDK pins', () => {
    for (const sdkVersion of ['0.4.30-rc.1', '0.4.30-alpha.1', '0.4.30+sha.deadbeef']) {
      const c = checks(baseSpec({ mode: 'auto' }, sdkVersion))
      expect(c).toContain('sdk-version-unparseable')
      expect(c.includes('sdk-identity-baseline')).toBe(false)
    }
  })

  test('does not warn on the SDK identity baseline or when analytics is disabled', () => {
    expect(checks(baseSpec({ mode: 'auto' }, '0.4.30')).includes('sdk-identity-baseline')).toBe(false)
    expect(checks(baseSpec({ mode: 'disabled' }, '0.4.29')).includes('sdk-identity-baseline')).toBe(false)
    expect(checks(baseSpec({ enabled: false, mode: 'auto' }, '0.4.29')).includes('sdk-identity-baseline')).toBe(false)
  })

  test('treats a present analytics block with no mode as active SDK-default intent', () => {
    const c = checks(baseSpec({}, '0.4.29'))
    expect(c).toContain('sdk-identity-baseline')
  })

  test('flags enabled providers missing their binding id', () => {
    const c = checks(baseSpec({
      providers: {
        gtm: { enabled: true },
        facebook: { enabled: true },
        custom: { enabled: true },
      },
    }))
    expect(c).toContain('gtm-container-missing')
    expect(c).toContain('facebook-pixel-missing')
    expect(c).toContain('custom-endpoint-missing')
  })

  test('does not flag a disabled provider missing its id', () => {
    expect(checks(baseSpec({ providers: { gtm: { enabled: false } } }))).toEqual([])
  })

  test('flags non-array blockedEvents', () => {
    expect(checks(baseSpec({ providers: { gtm: { enabled: true, containerId: 'GTM-X', blockedEvents: 'dl_purchase' as never } } })))
      .toContain('blocked-events-shape')
  })

  test('accepts blockedEvents naming known SDK dl_* events', () => {
    const c = checks(baseSpec({ providers: { gtm: { enabled: true, containerId: 'GTM-X', blockedEvents: ['dl_purchase', 'dl_upsell_purchase'] } } }))
    expect(c).toEqual([])
  })

  test('flags a blockedEvent that is not a known dl_* event (the drift bug)', () => {
    // "purchase" (no dl_ prefix) is exactly the silent no-op this keystone closes:
    // blockedEvents matches by exact name, so it would block nothing at runtime.
    const c = checks(baseSpec({ providers: { gtm: { enabled: true, containerId: 'GTM-X', blockedEvents: ['purchase'] } } }))
    expect(c).toContain('blocked-event-unknown')
  })

  test('flags each unknown blockedEvent and leaves known ones alone', () => {
    const c = checks(baseSpec({ providers: { facebook: { enabled: true, pixelId: '1', blockedEvents: ['dl_purchase', 'dl_porchase', 'checkout'] } } }))
    expect(c.filter((x) => x === 'blocked-event-unknown').length).toBe(2)
  })

  test('flags an out-of-band pixel missing its vendor', () => {
    expect(checks(baseSpec({ out_of_band_pixels: [{ vendor: '' }] }))).toContain('oob-vendor-missing')
  })

  test('flags a purchase manual_event with no declared page (the first-upsell footgun)', () => {
    expect(checks(baseSpec({ manual_events: [{ event: 'dl_purchase', trigger: 'page-load' }] })))
      .toContain('manual-purchase-page-missing')
  })

  test('flags a manual_event referencing an unknown page', () => {
    expect(checks(baseSpec({ manual_events: [{ event: 'dl_add_to_cart', page: 'does-not-exist' }] })))
      .toContain('manual-event-page-unknown')
  })

  test('flags a content param referencing an unknown page', () => {
    expect(checks(baseSpec({ params: { content: [{ name: 'reviews', pages: ['ghost-page'] }] } })))
      .toContain('content-page-unknown')
  })

  test('flags a half-declared click_id mapping', () => {
    expect(checks(baseSpec({ params: { tracking: { click_id: { inbound: 'sub2' } } } })))
      .toContain('click-id-incomplete')
  })

  test('flags a purchase manual_event placed on a checkout page (worst-case footgun)', () => {
    // p-co is the checkout page; a purchase beacon there is lost in the
    // checkout -> upsell redirect even though it does declare a page.
    const c = checks(baseSpec({ manual_events: [{ event: 'dl_purchase', page: 'p-co' }] }))
    expect(c).toContain('manual-purchase-on-checkout')
    expect(c.includes('manual-purchase-page-missing')).toBe(false)
  })

  test('does not flag a purchase manual_event on a non-checkout (upsell) page', () => {
    const c = checks(baseSpec({ manual_events: [{ event: 'dl_purchase', page: 'p-u1' }] }))
    expect(c.includes('manual-purchase-on-checkout')).toBe(false)
    expect(c.includes('manual-purchase-page-missing')).toBe(false)
  })

  test('flags a content param with an empty pages array (applies to no page)', () => {
    const c = checks(baseSpec({ params: { content: [{ name: 'reviews', pages: [] }] } }))
    expect(c).toContain('content-pages-empty')
    expect(c.includes('content-page-unknown')).toBe(false)
  })

  test('flags a content param whose pages is a scalar instead of an array', () => {
    // Guards against char-by-char iteration of a stray string producing
    // spurious content-page-unknown noise.
    const c = checks(baseSpec({ params: { content: [{ name: 'reviews', pages: 'p-l' as unknown as string[] }] } }))
    expect(c).toContain('content-pages-shape')
    expect(c.includes('content-page-unknown')).toBe(false)
  })
})
