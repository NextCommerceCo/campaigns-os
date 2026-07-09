/**
 * Analytics dl_* event vocabulary — SYNCED SNAPSHOT from the Campaign Cart SDK.
 *
 * SOURCE OF TRUTH: campaign-cart `src/utils/analytics/schemas/events.ts`
 * (`DL_EVENTS`), carried via its generated `events.manifest.json`.
 * Synced from SDK v0.4.30 (manifest event list unchanged since v0.4.28).
 *
 * Why a snapshot, not an import: campaigns-os is the public toolkit and takes
 * no dependency on the browser SDK bundle (wrong direction, heavy). This module
 * is the canonical CONSUMABLE the validator (AnalyticsContractShape) and the Map
 * Builder picker (via the campaign-spec.js shim) both read, so they validate /
 * autocomplete against exactly one list (cf. ADR-003, one rule registry).
 *
 * RESYNC when the SDK adds/removes a dl_* event: copy the manifest events array
 * here verbatim and bump the SDK version line above. The accompanying test
 * (analytics-vocabulary.test.ts) guards internal consistency.
 *
 * The vocabulary is the SDK FIRABLE SUPERSET (~35), not just the schema-bearing
 * events: blockedEvents matches by exact event name against everything the SDK
 * dispatches, so any fired event must be a known/blockable member.
 */

export type DlEventCategory =
  | 'ecommerce'
  | 'user'
  | 'upsell'
  | 'cart'
  | 'navigation'
  | 'engagement'

export interface DlEventDefinition {
  /** Exact dataLayer event name the SDK pushes — matched verbatim by blockedEvents. */
  name: string
  /** Coarse grouping for picker UIs. */
  category: DlEventCategory
  /** True when the SDK defines a field-level validation schema for this event. */
  hasSchema: boolean
  /** Human label for picker UIs and repair prompts. */
  description: string
}

/** SDK version whose manifest this snapshot was last checked against. */
export const CAMPAIGN_CART_ANALYTICS_VOCABULARY_SDK_VERSION = '0.4.30'

/**
 * First Campaign Cart SDK version that stamps campaign_* and ncsid-derived
 * campaign_session_id identifiers on every analytics event.
 */
export const CAMPAIGN_CART_ANALYTICS_IDENTITY_MIN_SDK_VERSION = '0.4.30'

/** The canonical vocabulary, category-grouped (mirrors the SDK manifest order). */
export const DL_EVENTS: readonly DlEventDefinition[] = [
  { name: 'dl_view_item_list', category: 'ecommerce', hasSchema: true, description: 'Product list / collection impression' },
  { name: 'dl_view_item', category: 'ecommerce', hasSchema: true, description: 'Product detail view' },
  { name: 'dl_select_item', category: 'ecommerce', hasSchema: true, description: 'Product clicked from a list' },
  { name: 'dl_view_search_results', category: 'ecommerce', hasSchema: true, description: 'Search results viewed' },
  { name: 'dl_search', category: 'ecommerce', hasSchema: false, description: 'Search performed (Meta Search)' },
  { name: 'dl_add_to_cart', category: 'ecommerce', hasSchema: true, description: 'Item added to cart' },
  { name: 'dl_remove_from_cart', category: 'ecommerce', hasSchema: true, description: 'Item removed from cart' },
  { name: 'dl_add_to_wishlist', category: 'ecommerce', hasSchema: false, description: 'Item added to wishlist' },
  { name: 'dl_view_cart', category: 'ecommerce', hasSchema: true, description: 'Cart viewed' },
  { name: 'dl_begin_checkout', category: 'ecommerce', hasSchema: true, description: 'Checkout started' },
  { name: 'dl_add_shipping_info', category: 'ecommerce', hasSchema: true, description: 'Shipping info added' },
  { name: 'dl_add_payment_info', category: 'ecommerce', hasSchema: true, description: 'Payment info added' },
  { name: 'dl_purchase', category: 'ecommerce', hasSchema: true, description: 'Main order purchase' },
  { name: 'dl_refund', category: 'ecommerce', hasSchema: false, description: 'Order refunded (adapter-mapped)' },
  { name: 'dl_view_promotion', category: 'ecommerce', hasSchema: false, description: 'Promotion impression' },
  { name: 'dl_select_promotion', category: 'ecommerce', hasSchema: false, description: 'Promotion clicked' },
  { name: 'dl_user_data', category: 'user', hasSchema: true, description: 'User + cart context (fired first)' },
  { name: 'dl_sign_up', category: 'user', hasSchema: true, description: 'Account sign-up' },
  { name: 'dl_login', category: 'user', hasSchema: true, description: 'Account login' },
  { name: 'dl_subscribe', category: 'user', hasSchema: true, description: 'Subscription created' },
  { name: 'dl_start_trial', category: 'user', hasSchema: false, description: 'Trial started (Meta StartTrial)' },
  { name: 'dl_viewed_upsell', category: 'upsell', hasSchema: true, description: 'Upsell offer viewed' },
  { name: 'dl_accepted_upsell', category: 'upsell', hasSchema: true, description: 'Upsell accepted' },
  { name: 'dl_skipped_upsell', category: 'upsell', hasSchema: true, description: 'Upsell skipped' },
  { name: 'dl_upsell_purchase', category: 'upsell', hasSchema: true, description: 'Accepted upsell in GA4 purchase format' },
  { name: 'dl_cart_updated', category: 'cart', hasSchema: false, description: 'Cart contents changed' },
  { name: 'dl_package_swapped', category: 'cart', hasSchema: false, description: 'Package variant swapped' },
  { name: 'dl_page_view', category: 'navigation', hasSchema: false, description: 'SDK page view' },
  { name: 'dl_route_changed', category: 'navigation', hasSchema: false, description: 'Funnel route changed' },
  { name: 'dl_scroll_depth', category: 'engagement', hasSchema: false, description: 'Scroll-depth milestone reached' },
  { name: 'dl_exit_intent_shown', category: 'engagement', hasSchema: false, description: 'Exit-intent offer shown' },
  { name: 'dl_exit_intent_accepted', category: 'engagement', hasSchema: false, description: 'Exit-intent offer accepted' },
  { name: 'dl_exit_intent_dismissed', category: 'engagement', hasSchema: false, description: 'Exit-intent offer dismissed' },
  { name: 'dl_exit_intent_closed', category: 'engagement', hasSchema: false, description: 'Exit-intent modal closed' },
  { name: 'dl_exit_intent_action', category: 'engagement', hasSchema: false, description: 'Exit-intent CTA/action clicked' },
]

/** Flat list of canonical event names. */
export const DL_EVENT_NAMES: readonly string[] = DL_EVENTS.map((e) => e.name)

/** O(1) membership set for validation. */
export const DL_EVENT_NAME_SET: ReadonlySet<string> = new Set(DL_EVENT_NAMES)

/** True when name is a known canonical SDK dl_* event. */
export function isKnownDlEvent(name: string): boolean {
  return DL_EVENT_NAME_SET.has(name)
}
