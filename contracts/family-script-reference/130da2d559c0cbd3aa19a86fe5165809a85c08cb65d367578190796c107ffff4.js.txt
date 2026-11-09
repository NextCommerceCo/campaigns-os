/* GENERATED from _shared/analytics/js/ga4.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * ga4.adapter.js — GA4 adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Maps the SDK's dl_* ecommerce stream to GA4 recommended events and sends them with gtag().
 * The generic plumbing (hook registration, consent ordering, dedup, replay, debug) lives in
 * next-forwarder-core.js — this file is pure GA4 mapping. GA4 is the reference adapter; TikTok/
 * Snap/Pinterest follow the same shape.
 *
 * Load order (both gated on campaign.ga4_id, on EVERY page incl. receipt/upsell):
 *   1. gtag bootstrap  (analytics-head.snippet.html) — sets window.__ga4MeasurementId
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * Requires campaign-cart SDK >= v0.4.28 (purchase value = product revenue; tax/shipping separate).
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus().
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[ga4.adapter] next-forwarder-core.js must load first');
    return;
  }

  // dl_* event -> GA4 recommended event name (GA4 = the name minus the dl_ prefix, mostly)
  var MAP = {
    dl_user_data:            'page_view', // REQUIRED. gtag send_page_view:false disables the native
                                          // pageview, so GA4 gets none unless we forward one. dl_user_data
                                          // is the SDK's real pageview signal — fired first on every page
                                          // (auto mode) AND on SPA route changes; the SDK's own Facebook
                                          // adapter treats it as PageView too. (dl_page_view is NOT used:
                                          // its `page:viewed` trigger is never emitted by the SDK.)
                                          // Sent bare in send() — its ecommerce cart snapshot is dropped.
    dl_view_item:            'view_item',
    dl_view_item_list:       'view_item_list',
    dl_view_search_results:  'view_search_results',
    dl_select_item:          'select_item',
    dl_add_to_cart:          'add_to_cart',
    dl_remove_from_cart:     'remove_from_cart',
    dl_view_cart:            'view_cart',
    dl_begin_checkout:       'begin_checkout',
    dl_add_shipping_info:    'add_shipping_info',
    dl_add_payment_info:     'add_payment_info',
    dl_purchase:             'purchase',
    dl_upsell_purchase:      'upsell_purchase', // SEPARATE custom event, NOT another `purchase` — see
                                                // send(): flat params, no items. Keeps GA4's purchase
                                                // count/AOV clean (no N+1 inflation) and gives upsells
                                                // their own bucket. transaction_id is `{orderId}-US{n}`.
    dl_sign_up:              'sign_up',
    dl_login:                'login'
  };

  // GA4 item keys we forward. The SDK already emits GA4-shaped item field names, so this is a
  // whitelist/pass-through rather than a rename.
  var ITEM_KEYS = [
    'item_id', 'item_name', 'item_brand', 'item_category', 'item_variant',
    'price', 'quantity', 'index', 'item_list_id', 'item_list_name', 'coupon', 'discount'
  ];

  // Event-level params GA4 accepts per GA4 event name (beyond currency/value/items). Keyed by the
  // mapped GA4 name. (upsell_purchase is handled separately in send() — flat params, no items.)
  var EXTRA = {
    purchase:            ['transaction_id', 'tax', 'shipping', 'coupon', 'affiliation'],
    begin_checkout:      ['coupon'],
    add_shipping_info:   ['shipping_tier', 'coupon'],
    add_payment_info:    ['payment_type', 'coupon'],
    view_item_list:      ['item_list_id', 'item_list_name'],
    select_item:         ['item_list_id', 'item_list_name'],
    view_search_results: ['search_term']
  };

  function mapItems(items) {
    return (items || []).map(function (it) {
      var out = {};
      for (var i = 0; i < ITEM_KEYS.length; i++) {
        var k = ITEM_KEYS[i];
        if (it[k] !== undefined && it[k] !== null && it[k] !== '') out[k] = it[k];
      }
      return out;
    });
  }

  function copy(from, to, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (from[k] !== undefined && from[k] !== null && from[k] !== '') to[k] = from[k];
    }
  }

  // Per-campaign event toggles (comma-separated dl_* or GA4 names from campaigns.json).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__ga4BlockedEvents);
  var allowedRaw = parseList(window.__ga4AllowedEvents);
  // allowlist: "" / absent → default main events; "all"/"*" → every mapped event; else the given subset.
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  window.NextForwarder.register({
    name: 'ga4',
    isActive: function () {
      return !!window.__ga4MeasurementId && typeof window.gtag === 'function';
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      // page_view (from dl_user_data) is not an ecommerce event — send it bare so gtag uses the
      // browser's page context (page_location/title/referrer) and no cart items/value leak onto it.
      if (name === 'page_view') { window.gtag('event', 'page_view'); return; }

      // upsell_purchase is a CUSTOM event, not a second `purchase`. GA4 only populates standard
      // item/Monetization reports for `purchase`, so an items[] on a custom event is ignored there.
      // Send FLAT custom params (value/currency/transaction_id + upsell_metadata) and no items. The
      // SDK already gives incremental value, a `{orderId}-US{n}` transaction_id, and affiliation:'Upsell'.
      if (name === 'upsell_purchase') {
        var m = evt.upsell_metadata || {};
        var up = {};
        if (ec.currency) up.currency = ec.currency;
        if (ec.value !== undefined && ec.value !== null) up.value = ec.value;
        if (ec.transaction_id) up.transaction_id = ec.transaction_id;
        if (ec.affiliation) up.affiliation = ec.affiliation; // 'Upsell'
        if (ec.coupon) up.coupon = ec.coupon;
        if (m.upsell_number !== undefined && m.upsell_number !== null) up.upsell_number = m.upsell_number;
        if (m.package_id) up.package_id = m.package_id;
        if (m.package_name) up.package_name = m.package_name;
        if (m.original_order_id) up.original_order_id = m.original_order_id;
        window.gtag('event', 'upsell_purchase', up);
        return;
      }

      var params = {};
      if (ec.currency) params.currency = ec.currency;
      if (ec.value !== undefined && ec.value !== null) params.value = ec.value;

      var items = mapItems(ec.items);
      if (items.length) params.items = items;

      // search_term lives on the envelope, not ecommerce, for dl_view_search_results
      if (evt.search_term && !ec.search_term) ec = Object.assign({ search_term: evt.search_term }, ec);

      copy(ec, params, EXTRA[name] || []);
      window.gtag('event', name, params);
    }
  });
})();
