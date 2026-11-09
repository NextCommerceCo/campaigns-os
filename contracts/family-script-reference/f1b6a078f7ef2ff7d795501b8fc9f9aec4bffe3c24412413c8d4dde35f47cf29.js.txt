/* GENERATED from _shared/analytics/js/tiktok.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * tiktok.adapter.js — TikTok Pixel adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Maps the SDK's dl_* stream to TikTok events via window.ttq.track(name, props, {event_id}).
 * Generic plumbing (hook, consent ordering, dedup, replay, _willRedirect, toggles, onContact) lives
 * in next-forwarder-core.js — this file is pure TikTok mapping.
 *
 * Load order (all gated on campaign.tiktok_pixel_id, on EVERY page incl. receipt/upsell):
 *   1. TikTok base pixel (analytics-head.snippet.html) — defines window.ttq, fires ttq.page(),
 *      sets window.__tiktokPixelId
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * TikTok specifics:
 *   - Current purchase event is `Purchase` (not the legacy `CompletePayment`).
 *   - Base ttq.page() owns the pageview → dl_user_data NOT mapped (like Taboola).
 *   - Upsell = Approach B: dl_upsell_purchase → `Purchase` with a distinct event_id (`{orderId}-US{n}`),
 *     so upsell revenue counts toward TikTok's Purchase optimization (ROAS). Inflates purchase COUNT
 *     (N upsells = N+1) — brief the media buyer. (TikTok supports custom events, so Approach C is
 *     possible if clean count is preferred over optimization — see README.)
 *   - event_id (3rd arg) enables Pixel + Events-API dedup later; harmless without it.
 *   - Advanced Matching (ttq.identify email/phone) is opt-in via tiktok_advanced_matching_enabled →
 *     the core onContact hook. Default off = zero PII (like GA4/Axon/Taboola).
 *     Keeps the core's DEFAULT contact gate (contactRequiresMarketingConsent true, prospect-cart source
 *     only): TikTok advanced matching is marketing use — it builds the ad platform's identity graph and
 *     audiences — so it stays behind the accepts_marketing checkbox. Attribution vendors (Northbeam,
 *     Triple Whale) opt out of that gate; see next-forwarder-core.js.
 *
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus(). QA with TikTok Pixel Helper.
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[tiktok.adapter] next-forwarder-core.js must load first');
    return;
  }

  // dl_* -> TikTok standard event. No dl_user_data (base ttq.page() owns pageview). No TikTok standard
  // event for view_cart / view_item_list / select_item / remove_from_cart / add_shipping_info / login.
  var MAP = {
    dl_view_item:            'ViewContent',
    dl_add_to_cart:          'AddToCart',
    dl_begin_checkout:       'InitiateCheckout',
    dl_add_payment_info:     'AddPaymentInfo',
    dl_purchase:             'Purchase',
    dl_upsell_purchase:      'Purchase',         // Approach B — distinct event_id keeps it a separate txn
    dl_view_search_results:  'Search',
    dl_sign_up:              'CompleteRegistration',
    dl_subscribe:            'Subscribe'
  };

  var ADV_MATCHING = /^(true|1|yes)$/i.test(window.__tiktokAdvancedMatching || '');

  function str(v) { return (v === undefined || v === null) ? v : String(v); }

  // SDK items -> TikTok `contents` objects.
  function mapContents(items) {
    return (items || []).map(function (it) {
      var c = {};
      if (it.item_id !== undefined && it.item_id !== null && it.item_id !== '') c.content_id = str(it.item_id);
      if (it.item_name) c.content_name = it.item_name;
      if (it.item_category) c.content_category = it.item_category;
      if (it.item_brand) c.brand = it.item_brand;
      if (it.price !== undefined && it.price !== null) c.price = it.price;
      if (it.quantity !== undefined && it.quantity !== null) c.quantity = it.quantity;
      return c;
    });
  }

  // Toggles (comma-separated dl_* or TikTok names).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__tiktokBlockedEvents);
  var allowedRaw = parseList(window.__tiktokAllowedEvents);
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  var reg = {
    name: 'tiktok',
    isActive: function () {
      return !!window.__tiktokPixelId && !!(window.ttq && window.ttq.track);
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      var props = { content_type: 'product' };
      if (ec.currency) props.currency = ec.currency;
      if (ec.value !== undefined && ec.value !== null) props.value = ec.value; // incremental for upsell
      var contents = mapContents(ec.items);
      if (contents.length) props.contents = contents;
      if (name === 'Purchase' && ec.coupon) props.query = ec.coupon;
      if (name === 'Search' && evt.search_term) props.query = evt.search_term;
      // 3rd arg event_id: transaction_id for purchases ({orderId}-US{n} for upsells), else the SDK id.
      var opts = evt.event_id ? { event_id: evt.event_id } : undefined;
      window.ttq.track(name, props, opts);
    }
  };

  // Advanced Matching (opt-in): fire ttq.identify on the core's onContact (prospect-cart source, default
  // accepts_marketing gate — see header).
  // TikTok links the browser via its cookie, so subsequent Purchase attributes to the matched identity.
  if (ADV_MATCHING) {
    reg.onContact = function (c) {
      var id = {};
      if (c.email) id.email = c.email;
      if (c.phone) id.phone_number = c.phone;
      if (id.email || id.phone_number) window.ttq.identify(id);
    };
  }

  window.NextForwarder.register(reg);
})();
