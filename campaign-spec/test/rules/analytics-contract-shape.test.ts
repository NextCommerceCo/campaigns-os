import { describe, expect, test } from '../harness.ts'
import { AnalyticsContractShape } from '../../rules/analytics-contract-shape.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { AnalyticsContract, CampaignSpec } from '../../types.ts'

function baseSpec(analytics?: AnalyticsContract): CampaignSpec {
  return {
    schema_version: '4.3',
    runtime: { sdk_version: '0.4.27' },
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

  test('matches corpus fixture violations', () => {
    const fixture = fixtureByName('analytics-contract-malformed')
    const violations = AnalyticsContractShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
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

  test('flags a content param whose pages is a scalar instead of an array', () => {
    // Guards against char-by-char iteration of a stray string producing
    // spurious content-page-unknown noise.
    const c = checks(baseSpec({ params: { content: [{ name: 'reviews', pages: 'p-l' as unknown as string[] }] } }))
    expect(c).toContain('content-pages-shape')
    expect(c.includes('content-page-unknown')).toBe(false)
  })
})
