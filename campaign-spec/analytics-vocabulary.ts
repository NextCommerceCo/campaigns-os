/**
 * Analytics dl_* event vocabulary — SYNCED SNAPSHOT from the Campaign Cart SDK.
 *
 * SOURCE OF TRUTH: campaign-cart `src/utils/analytics/schemas/events.ts`
 * (`DL_EVENTS`), carried via its generated `events.manifest.json`.
 * Synced from SDK v0.4.28 (manifest @ campaign-cart#62).
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
}

/** The canonical vocabulary, category-grouped (mirrors the SDK manifest order). */
export const DL_EVENTS: readonly DlEventDefinition[] = [
  { name: 'dl_view_item_list', category: 'ecommerce', hasSchema: true },
  { name: 'dl_view_item', category: 'ecommerce', hasSchema: true },
  { name: 'dl_select_item', category: 'ecommerce', hasSchema: true },
  { name: 'dl_view_search_results', category: 'ecommerce', hasSchema: true },
  { name: 'dl_search', category: 'ecommerce', hasSchema: false },
  { name: 'dl_add_to_cart', category: 'ecommerce', hasSchema: true },
  { name: 'dl_remove_from_cart', category: 'ecommerce', hasSchema: true },
  { name: 'dl_add_to_wishlist', category: 'ecommerce', hasSchema: false },
  { name: 'dl_view_cart', category: 'ecommerce', hasSchema: true },
  { name: 'dl_begin_checkout', category: 'ecommerce', hasSchema: true },
  { name: 'dl_add_shipping_info', category: 'ecommerce', hasSchema: true },
  { name: 'dl_add_payment_info', category: 'ecommerce', hasSchema: true },
  { name: 'dl_purchase', category: 'ecommerce', hasSchema: true },
  { name: 'dl_refund', category: 'ecommerce', hasSchema: false },
  { name: 'dl_view_promotion', category: 'ecommerce', hasSchema: false },
  { name: 'dl_select_promotion', category: 'ecommerce', hasSchema: false },
  { name: 'dl_user_data', category: 'user', hasSchema: true },
  { name: 'dl_sign_up', category: 'user', hasSchema: true },
  { name: 'dl_login', category: 'user', hasSchema: true },
  { name: 'dl_subscribe', category: 'user', hasSchema: true },
  { name: 'dl_start_trial', category: 'user', hasSchema: false },
  { name: 'dl_viewed_upsell', category: 'upsell', hasSchema: true },
  { name: 'dl_accepted_upsell', category: 'upsell', hasSchema: true },
  { name: 'dl_skipped_upsell', category: 'upsell', hasSchema: true },
  { name: 'dl_upsell_purchase', category: 'upsell', hasSchema: true },
  { name: 'dl_cart_updated', category: 'cart', hasSchema: false },
  { name: 'dl_package_swapped', category: 'cart', hasSchema: false },
  { name: 'dl_page_view', category: 'navigation', hasSchema: false },
  { name: 'dl_route_changed', category: 'navigation', hasSchema: false },
  { name: 'dl_scroll_depth', category: 'engagement', hasSchema: false },
  { name: 'dl_exit_intent_shown', category: 'engagement', hasSchema: false },
  { name: 'dl_exit_intent_accepted', category: 'engagement', hasSchema: false },
  { name: 'dl_exit_intent_dismissed', category: 'engagement', hasSchema: false },
  { name: 'dl_exit_intent_closed', category: 'engagement', hasSchema: false },
  { name: 'dl_exit_intent_action', category: 'engagement', hasSchema: false },
]

/** Flat list of canonical event names. */
export const DL_EVENT_NAMES: readonly string[] = DL_EVENTS.map((e) => e.name)

/** O(1) membership set for validation. */
export const DL_EVENT_NAME_SET: ReadonlySet<string> = new Set(DL_EVENT_NAMES)

/** True when name is a known canonical SDK dl_* event. */
export function isKnownDlEvent(name: string): boolean {
  return DL_EVENT_NAME_SET.has(name)
}
