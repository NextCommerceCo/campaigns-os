/**
 * analytics.vendors: the registry mirror, the schema and the rule against the
 * block exactly as the Map Builder emits it (next-campaigns-ops
 * campaign-map-builder/src/lib/spec.js buildAnalyticsContract, registry
 * shared/route-c-vendors.mjs).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from './harness.ts'
import {
  ANALYTICS_VENDORS,
  ANALYTICS_VENDOR_KEYS,
  analyticsVendorByKey,
  isPlaceholderVendorId,
} from '../analytics-vendors.ts'
import { validateSpec } from '../index.ts'
import type { CampaignSpec } from '../types.ts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

// The ops registry at next-campaigns-ops e1f3e83f (shared/route-c-vendors.mjs),
// reduced to the fields that decide campaigns.json keys. A change there is a
// change here: update both in one go.
const OPS_ROUTE_C_VENDORS = [
  { key: 'ga4', idKey: 'ga4_id' },
  { key: 'axon', idKey: 'axon_event_key' },
  { key: 'taboola', idKey: 'taboola_account_id', numericId: true },
  { key: 'triplewhale', idKey: 'triplewhale_name', platformKey: 'triplewhale_platform', piiKey: 'triplewhale_contact_enabled' },
  { key: 'tiktok', idKey: 'tiktok_pixel_id', piiKey: 'tiktok_advanced_matching_enabled' },
  { key: 'northbeam', idKey: 'northbeam_client_id', piiKey: 'northbeam_identity_enabled' },
  { key: 'snap', idKey: 'snap_pixel_id', piiKey: 'snap_advanced_matching_enabled' },
  { key: 'pinterest', idKey: 'pinterest_tag_id', piiKey: 'pinterest_enhanced_match_enabled' },
]

// What the Map Builder saves for a campaign with GTM, Triple Whale on a
// Shopify-synced store, and TikTok with advanced matching.
function mapBuilderSpec(): CampaignSpec {
  return {
    schema_version: '5.0',
    runtime: { sdk_version: '0.4.30' },
    campaign: { ref_id: 1, slug: 'vendors', payment_env_key: 'test_key' },
    shipping_methods: [{ ref_id: 'ship-standard' }],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'Vendor adapters ride the dl_* stream on every page.',
        weight: 100,
        pages: [
          { id: 'p-co', type: 'checkout', label: 'Checkout', success_url: 'p-ty' },
          { id: 'p-ty', type: 'thankyou', label: 'Thank You' },
        ],
      },
    ],
    analytics: {
      enabled: true,
      mode: 'auto',
      providers: { gtm: { enabled: true, containerId: 'GTM-ABC1234' } },
      vendors: {
        triplewhale: { enabled: true, id: 'acme.myshopify.com', platform: 'SHOPIFY', identityEnabled: true, blockedEvents: ['dl_purchase', 'dl_upsell_purchase'] },
        tiktok: { enabled: true, id: 'CABCDEFGHIJ1234567890', identityEnabled: true },
      },
    },
  } as CampaignSpec
}

describe('analytics vendor registry', () => {
  test('mirrors the ops registry key for key', () => {
    expect(ANALYTICS_VENDORS.map(({ key, idKey, platformKey, piiKey, numericId }) => ({ key, idKey, platformKey, piiKey, numericId })))
      .toEqual(OPS_ROUTE_C_VENDORS)
    expect(ANALYTICS_VENDOR_KEYS).toEqual(['ga4', 'axon', 'taboola', 'triplewhale', 'tiktok', 'northbeam', 'snap', 'pinterest'])
    expect(analyticsVendorByKey('northbeam')?.idKey).toBe('northbeam_client_id')
    expect(analyticsVendorByKey('gtm')).toBe(undefined)
  })

  test('recognises the documented placeholders and leaves real ids alone', () => {
    for (const value of ['G-XXXXXXXXXX', 'store.example.com', 'YOUR_PIXEL_ID', '<pixel id>', 'changeme']) {
      expect(isPlaceholderVendorId(value)).toBe(true)
    }
    for (const value of ['G-AB12CD34EF', 'acme.myshopify.com', '1234567', 'CABCDEFGHIJ1234567890']) {
      expect(isPlaceholderVendorId(value)).toBe(false)
    }
  })
})

describe('analytics.vendors in the schema and rules', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schemas', 'campaign-spec.v5.schema.json'), 'utf8'))
  const schemaV4 = JSON.parse(readFileSync(join(root, 'schemas', 'campaign-spec.v4.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true })

  test('the v5 schema types the block, and the v4 schema carries the same definition', () => {
    const vendors = schema.$defs.analyticsContract.properties.vendors
    expect(Object.keys(vendors.additionalProperties.properties)).toEqual(['enabled', 'id', 'platform', 'identityEnabled', 'allowedEvents', 'blockedEvents'])
    expect(schemaV4.$defs.analyticsContract).toEqual(schema.$defs.analyticsContract)
  })

  test('a saved Map with vendors validates against the v5 schema', () => {
    const validate = ajv.compile(schema)
    expect(validate(mapBuilderSpec())).toBe(true)
    const broken = mapBuilderSpec()
    ;(broken.analytics!.vendors!.tiktok as Record<string, unknown>).identityEnabled = 'yes'
    expect(validate(broken)).toBe(false)
  })

  test('a saved Map with vendors draws no warning about the block', () => {
    const violations = validateSpec(mapBuilderSpec())
    expect(violations.filter((v) => String(v.path).startsWith('/analytics') || v.ruleId === 'UnknownTopLevelFields')).toEqual([])
  })

  test('warns on an unknown vendor key, an enabled vendor without an id, and non-array event lists', () => {
    const spec = mapBuilderSpec()
    spec.analytics!.vendors = {
      triplepixel: { enabled: true, id: 'acme' },
      snap: { enabled: true },
      pinterest: { enabled: false },
      ga4: { enabled: true, id: 'G-AB12CD34EF', blockedEvents: 'dl_purchase' as unknown as string[] },
    }
    const found = validateSpec(spec)
      .filter((v) => v.ruleId === 'AnalyticsContractShape')
      .map((v) => [v.data?.check, v.path])
    expect(found).toEqual([
      ['vendor-unknown', '/analytics/vendors/triplepixel'],
      ['vendor-id-missing', '/analytics/vendors/snap/id'],
      ['vendor-events-shape', '/analytics/vendors/ga4/blockedEvents'],
    ])
  })

  test('warns once when vendors is not an object', () => {
    const spec = mapBuilderSpec()
    ;(spec.analytics as Record<string, unknown>).vendors = ['ga4']
    const found = validateSpec(spec).filter((v) => v.ruleId === 'AnalyticsContractShape').map((v) => v.data?.check)
    expect(found).toEqual(['vendors-not-object'])
  })
})
