/* GENERATED from _shared/analytics/js/snapchat.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * snapchat.adapter.js — Snapchat Pixel adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Maps the SDK's dl_* stream to Snapchat events via window.snaptr('track', '<EVENT>', {...}).
 * Generic plumbing (hook, consent ordering, dedup, replay, _willRedirect, toggles, onContact) lives in
 * next-forwarder-core.js — this file is pure Snapchat mapping.
 *
 * Load order (all gated on campaign.snap_pixel_id, on EVERY page incl. receipt/upsell):
 *   1. Snap base pixel (analytics-head.snippet.html) — defines window.snaptr, fires PAGE_VIEW,
 *      sets window.__snapPixelId
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * Snapchat specifics:
 *   - Events are UPPERCASE; purchase value field is `price` (NOT `value`); currency + transaction_id
 *     required for ROAS. `price` = ec.value (product revenue, v0.4.28) — aligns with NEXT's official
 *     Snapchat transformer + our GA4/TikTok convention (for total-paid ROAS instead, add tax+shipping).
 *   - Base snaptr('track','PAGE_VIEW') owns the pageview → dl_user_data NOT mapped (like Taboola/TikTok).
 *   - Upsell = Approach B: dl_upsell_purchase → PURCHASE with a distinct transaction_id (`{orderId}-US{n}`)
 *     → upsell revenue counts toward Snap's PURCHASE optimization; count inflates (Snap is ad-optimization).
 *   - Advanced Matching (user_email/phone) is init-time; opt-in via snap_advanced_matching_enabled → the
 *     core onContact hook re-inits with the email. Default off = zero PII. See README for the init-timing caveat.
 *     Keeps the core's DEFAULT contact gate (contactRequiresMarketingConsent true, prospect-cart source
 *     only): Snap advanced matching is marketing use — it builds the ad platform's identity graph and
 *     audiences — so it stays behind the accepts_marketing checkbox. Attribution vendors (Northbeam,
 *     Triple Whale) opt out of that gate; see next-forwarder-core.js.
 *
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus(). QA with Snap Pixel Helper.
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[snapchat.adapter] next-forwarder-core.js must load first');
    return;
  }

  // dl_* -> Snapchat UPPERCASE event. Snap's 9 standard events: PAGE_VIEW, VIEW_CONTENT, ADD_CART,
  // START_CHECKOUT, ADD_BILLING, PURCHASE, SIGN_UP, SEARCH, SAVE. No dl_user_data (base PAGE_VIEW owns
  // pageview). No Snap standard event for subscribe / view_item_list / select_item / view_cart /
  // remove_from_cart / login → not mapped. (dl_subscribe: Snap has NO SUBSCRIBE standard event.)
  var MAP = {
    dl_view_item:            'VIEW_CONTENT',
    dl_add_to_cart:          'ADD_CART',
    dl_begin_checkout:       'START_CHECKOUT',
    dl_add_payment_info:     'ADD_BILLING',
    dl_purchase:             'PURCHASE',
    dl_upsell_purchase:      'PURCHASE',       // Approach B — distinct transaction_id keeps it separate
    dl_view_search_results:  'SEARCH',
    dl_sign_up:              'SIGN_UP'
  };

  var AM_ENABLED = /^(true|1|yes)$/i.test(window.__snapAdvancedMatching || '');

  function str(v) { return (v === undefined || v === null) ? v : String(v); }

  function itemIds(items) {
    var ids = [];
    (items || []).forEach(function (it) {
      if (it.item_id !== undefined && it.item_id !== null && it.item_id !== '') ids.push(str(it.item_id));
    });
    return ids;
  }

  // Toggles (comma-separated dl_* or Snap names).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__snapBlockedEvents);
  var allowedRaw = parseList(window.__snapAllowedEvents);
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  var reg = {
    name: 'snapchat',
    isActive: function () {
      return !!window.__snapPixelId && typeof window.snaptr === 'function';
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      var p = {};
      if (ec.currency) p.currency = ec.currency;
      if (ec.value !== undefined && ec.value !== null) p.price = ec.value; // incremental for upsell
      var items = ec.items || [];
      var ids = itemIds(items);
      if (ids.length) p.item_ids = ids;
      if (items.length) p.number_items = items.length;
      if (items[0] && items[0].item_category) p.item_category = items[0].item_category;
      if (name === 'PURCHASE' && ec.transaction_id) p.transaction_id = ec.transaction_id;
      if (name === 'SEARCH' && evt.search_term) p.search_string = evt.search_term;
      window.snaptr('track', name, p);
    }
  };

  // Advanced Matching (opt-in): re-init with user_email/phone on the core's onContact (prospect-cart
  // source, default accepts_marketing gate — see header). Snap links the browser via its _scid cookie, so the later PURCHASE benefits. NOTE:
  // Snap Advanced Matching is init-scoped — verify snaptr re-init sets it (see README caveat).
  if (AM_ENABLED) {
    reg.onContact = function (c) {
      var u = {};
      if (c.email) u.user_email = c.email;
      if (c.phone) u.user_phone_number = c.phone;
      if (u.user_email || u.user_phone_number) window.snaptr('init', window.__snapPixelId, u);
    };
  }

  window.NextForwarder.register(reg);
})();
