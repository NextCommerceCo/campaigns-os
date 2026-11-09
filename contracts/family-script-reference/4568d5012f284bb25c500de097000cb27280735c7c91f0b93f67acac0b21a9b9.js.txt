/* GENERATED from _shared/analytics/js/pinterest.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * pinterest.adapter.js — Pinterest Tag adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Maps the SDK's dl_* stream to Pinterest events via window.pintrk('track', '<event>', {...}).
 * Generic plumbing (hook, consent ordering, dedup, replay, _willRedirect, toggles, onContact) lives in
 * next-forwarder-core.js — this file is pure Pinterest mapping.
 *
 * Load order (all gated on campaign.pinterest_tag_id, on EVERY page incl. receipt/upsell):
 *   1. Pinterest tag base (analytics-head.snippet.html) — defines window.pintrk, fires pintrk('page'),
 *      sets window.__pinterestTagId
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * Pinterest specifics:
 *   - Events are LOWERCASE and conversion-focused: addtocart, checkout, signup, lead, search. There is
 *     NO product-view / begin_checkout / add_payment_info standard event (those dl_* are not mapped).
 *   - Base pintrk('page') owns the pageview → dl_user_data NOT mapped (like Taboola/TikTok/Snap).
 *   - `checkout` params: value, currency, order_quantity, line_items[{product_id, product_name,
 *     product_price, product_quantity, product_category, product_variant_id}], event_id (dedup).
 *     value = ec.value (product revenue, v0.4.28) — ad-pixel convention (add tax+shipping for total-paid).
 *   - Upsell = Approach B: dl_upsell_purchase → checkout with a distinct event_id (`{orderId}-US{n}`) →
 *     revenue counts toward Pinterest's checkout optimization; count inflates.
 *   - Enhanced Match (em) is load-time; opt-in via pinterest_enhanced_match_enabled → the core onContact
 *     hook re-loads with the email. Default off = zero PII. See README (hashing + init-timing caveats).
 *     Keeps the core's DEFAULT contact gate (contactRequiresMarketingConsent true, prospect-cart source
 *     only): Pinterest Enhanced Match is marketing use — it builds the ad platform's identity graph and
 *     audiences — so it stays behind the accepts_marketing checkbox. Attribution vendors (Northbeam,
 *     Triple Whale) opt out of that gate; see next-forwarder-core.js.
 *
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus(). QA with Pinterest Tag Helper.
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[pinterest.adapter] next-forwarder-core.js must load first');
    return;
  }

  // dl_* -> Pinterest lowercase event. No dl_user_data (base pintrk('page') owns pageview). No Pinterest
  // standard event for view_item / begin_checkout / add_payment_info / view_cart / etc.
  var MAP = {
    dl_add_to_cart:          'addtocart',
    dl_purchase:             'checkout',
    dl_upsell_purchase:      'checkout',       // Approach B — distinct event_id keeps it separate
    dl_view_search_results:  'search',
    dl_sign_up:              'signup',
    dl_subscribe:            'lead'
  };

  var EM_ENABLED = /^(true|1|yes)$/i.test(window.__pinterestEnhancedMatch || '');

  function str(v) { return (v === undefined || v === null) ? v : String(v); }

  function lineItems(items) {
    return (items || []).map(function (it) {
      var li = {};
      if (it.item_product_id || it.item_id) li.product_id = str(it.item_product_id || it.item_id);
      if (it.item_name) li.product_name = it.item_name;
      if (it.price !== undefined && it.price !== null) li.product_price = it.price;
      if (it.quantity !== undefined && it.quantity !== null) li.product_quantity = it.quantity;
      if (it.item_category) li.product_category = it.item_category;
      if (it.item_variant_id) li.product_variant_id = str(it.item_variant_id);
      return li;
    });
  }

  function totalQty(items) {
    var q = 0, has = false;
    (items || []).forEach(function (it) {
      if (it.quantity !== undefined && it.quantity !== null) { q += Number(it.quantity) || 0; has = true; }
    });
    return has ? q : undefined;
  }

  // Toggles (comma-separated dl_* or Pinterest names).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__pinterestBlockedEvents);
  var allowedRaw = parseList(window.__pinterestAllowedEvents);
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  var reg = {
    name: 'pinterest',
    isActive: function () {
      return !!window.__pinterestTagId && typeof window.pintrk === 'function';
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      var p = {};
      if (ec.currency) p.currency = ec.currency;
      if (ec.value !== undefined && ec.value !== null) p.value = ec.value; // incremental for upsell
      var q = totalQty(ec.items);
      if (q !== undefined) p.order_quantity = q;
      var li = lineItems(ec.items);
      if (li.length) p.line_items = li;
      if (name === 'checkout') {
        if (evt.event_id) p.event_id = evt.event_id;              // dedup key (tag ↔ Conversions API)
        if (ec.transaction_id) p.order_id = ec.transaction_id;    // orderId / {orderId}-US{n}
      }
      if (name === 'search' && evt.search_term) p.search_query = evt.search_term;
      window.pintrk('track', name, p);
    }
  };

  // Enhanced Match (opt-in): re-load with em on the core's onContact (prospect-cart source, default
  // accepts_marketing gate — see header).
  // `em` accepts a RAW email — the Pinterest JS hashes it client-side (no pre-hashing needed).
  // ⚠️ UNVERIFIED: docs show `em` only in the INITIAL load(); calling load() again to set it may be a
  // no-op. Email isn't known at page-load, so this re-loads at checkout — TEST it applies (see README).
  if (EM_ENABLED) {
    reg.onContact = function (c) {
      if (c.email) window.pintrk('load', window.__pinterestTagId, { em: c.email });
    };
  }

  window.NextForwarder.register(reg);
})();
