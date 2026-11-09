/* GENERATED from _shared/analytics/js/taboola.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * taboola.adapter.js — Taboola pixel adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Maps the SDK's dl_* stream to Taboola events via window._tfa.push({notify:'event', name, id, …}).
 * Generic plumbing (hook, consent ordering, dedup, replay, _willRedirect, event toggles) lives in
 * next-forwarder-core.js — this file is pure Taboola mapping.
 *
 * Load order (all gated on campaign.taboola_account_id, on EVERY page incl. receipt/upsell):
 *   1. Taboola base pixel (analytics-head.snippet.html) — inits window._tfa, fires page_view,
 *      loads tfa.js, sets window.__taboolaAccountId
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * Taboola specifics:
 *   - Supports CUSTOM event names → upsells are a distinct `upsell_purchase` event (Approach C, clean
 *     count), like GA4 — NOT another purchase.
 *   - The base pixel already fires `page_view`, so `dl_user_data` is intentionally NOT mapped here
 *     (mapping it would double-count page_view). This differs from GA4/Axon on purpose.
 *   - Identifier is a numeric account id, included as `id` on every push.
 * Hashed-email enhanced matching is NOT sent — see README (needs hashing+consent).
 *
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus().
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[taboola.adapter] next-forwarder-core.js must load first');
    return;
  }

  // dl_* event -> Taboola event `name`. page_view is owned by the base pixel (see header) — not mapped.
  var MAP = {
    dl_view_item:            'view_content',
    dl_add_to_cart:          'add_to_cart',
    dl_begin_checkout:       'start_checkout',
    dl_add_payment_info:     'add_payment_info',
    dl_view_search_results:  'search',
    dl_subscribe:            'subscribe',
    dl_purchase:             'make_purchase',
    dl_upsell_purchase:      'upsell_purchase',       // Approach C — Taboola supports custom names
    dl_sign_up:              'complete_registration'
  };

  // Conversion events that carry an order id (for attribution + Taboola-side dedup).
  var ORDER_EVENTS = { make_purchase: true, upsell_purchase: true };

  function totalQty(items) {
    var q = 0, has = false;
    (items || []).forEach(function (it) {
      if (it.quantity !== undefined && it.quantity !== null) { q += Number(it.quantity) || 0; has = true; }
    });
    return has ? q : undefined;
  }

  // Per-campaign event toggles (comma-separated dl_* or Taboola names from campaigns.json).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__taboolaBlockedEvents);
  var allowedRaw = parseList(window.__taboolaAllowedEvents);
  // allowlist: "" / absent → default main events; "all"/"*" → every mapped event; else the given subset.
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  window.NextForwarder.register({
    name: 'taboola',
    isActive: function () {
      return !!window.__taboolaAccountId && !!window._tfa;
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      // Read the id live (numeric, matching the base pixel's `id`) rather than a load-time capture.
      var e = { notify: 'event', name: name, id: window.__taboolaAccountId };
      if (ec.value !== undefined && ec.value !== null) e.revenue = ec.value; // incremental for upsell
      if (ec.currency) e.currency = ec.currency;
      if (ORDER_EVENTS[name] && ec.transaction_id) e.orderid = ec.transaction_id; // {orderId}-US{n} for upsell
      if (name === 'make_purchase') {
        var q = totalQty(ec.items);
        if (q !== undefined) e.quantity = q;
      }
      window._tfa.push(e);
    }
  });
})();
