/**
 * Template analytics vendors: the eight direct vendor adapters the certified
 * starter templates ship (GA4, AppLovin Axon, Taboola, Triple Whale, TikTok,
 * Northbeam, Snapchat, Pinterest).
 *
 * A vendor is switched on by a flat key in the campaign's page-kit
 * `_data/campaigns.json` entry (`ga4_id`, `triplewhale_name`, …): absent or
 * empty means off. The template then loads the vendor's base snippet, the
 * shared forwarder and the vendor adapter, which maps the SDK's dl_* stream to
 * the vendor. These vendors are separate from the SDK providers in
 * `analytics.providers` (gtm, facebook, rudderstack, custom), which reach the
 * page through config.js.
 *
 * MIRROR of next-campaigns-ops `shared/route-c-vendors.mjs` (ROUTE_C_VENDORS,
 * "Route C" in that repo), which drives the Map Builder `analytics.vendors`
 * emit and the spec compiler's campaigns.json key upsert. The key table itself
 * is the starter templates' `_shared/analytics/README.md`. Keep `key`,
 * `idKey`, `platformKey`, `piiKey` and `numericId` identical to that registry;
 * analytics-vendors.test.ts pins them.
 */

export interface AnalyticsVendorDefinition {
  /** Key under `analytics.vendors` in the CampaignSpec. */
  key: string
  /** Human label. */
  label: string
  /** campaigns.json key that carries the vendor id and switches the vendor on. */
  idKey: string
  /** campaigns.json key for the vendor platform (Triple Whale only). */
  platformKey?: string
  /** campaigns.json key for the vendor's identity / advanced-matching (PII) flag. */
  piiKey?: string
  /** True when the template injects the id unquoted, so it must be digits only. */
  numericId?: boolean
}

export const ANALYTICS_VENDORS: readonly AnalyticsVendorDefinition[] = [
  { key: 'ga4', label: 'GA4', idKey: 'ga4_id' },
  { key: 'axon', label: 'AppLovin Axon', idKey: 'axon_event_key' },
  { key: 'taboola', label: 'Taboola', idKey: 'taboola_account_id', numericId: true },
  { key: 'triplewhale', label: 'Triple Whale', idKey: 'triplewhale_name', platformKey: 'triplewhale_platform', piiKey: 'triplewhale_contact_enabled' },
  { key: 'tiktok', label: 'TikTok', idKey: 'tiktok_pixel_id', piiKey: 'tiktok_advanced_matching_enabled' },
  { key: 'northbeam', label: 'Northbeam', idKey: 'northbeam_client_id', piiKey: 'northbeam_identity_enabled' },
  { key: 'snap', label: 'Snapchat', idKey: 'snap_pixel_id', piiKey: 'snap_advanced_matching_enabled' },
  { key: 'pinterest', label: 'Pinterest', idKey: 'pinterest_tag_id', piiKey: 'pinterest_enhanced_match_enabled' },
]

/** The `analytics.vendors` keys, in registry order. */
export const ANALYTICS_VENDOR_KEYS: readonly string[] = ANALYTICS_VENDORS.map((vendor) => vendor.key)

export function analyticsVendorByKey(key: string): AnalyticsVendorDefinition | undefined {
  return ANALYTICS_VENDORS.find((vendor) => vendor.key === key)
}

// The same pattern the ops registry warns on (route-c-placeholder-id): a
// placeholder-shaped id goes live on any non-development build, because the
// template gate is only "non-empty". Bare XXXX also catches a half-edited
// placeholder such as "G-XXXXABC123".
const PLACEHOLDER_VENDOR_ID = /XXXX|YOUR[_-]|CHANGE[_-]?ME|<[^>]*>|EXAMPLE/i

/** Whether a vendor id looks like a documentation placeholder, not a real id. */
export function isPlaceholderVendorId(value: string): boolean {
  return PLACEHOLDER_VENDOR_ID.test(value)
}
