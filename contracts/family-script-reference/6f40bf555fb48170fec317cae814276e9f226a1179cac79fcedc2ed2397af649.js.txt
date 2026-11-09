/* GENERATED from _shared/analytics/js/triplewhale.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * triplewhale.adapter.js — Triple Whale adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Maps the SDK's dl_* stream to Triple Whale's page-side function-call API: TriplePixel(name, props).
 * Generic plumbing (hook, consent ordering, dedup, replay, _willRedirect, event toggles) lives in
 * next-forwarder-core.js — this file is pure TW mapping.
 *
 * Load order (all gated on campaign.triplewhale_name, on EVERY page incl. receipt/upsell):
 *   1. Triple Pixel headless base snippet (analytics-head.snippet.html) — defines window.TriplePixel
 *      + window.TriplePixelData; IS the pageload signal (TW has no page_view event)
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * TW specifics (differs from the pixel adapters):
 *   - Function-call API, not a dataLayer pixel. Purchase MUST be the function-call form
 *     TriplePixel('Purchase', {...}) (object form does not register on headless). Custom events take
 *     FLAT scalar props — no nested arrays (field-validated: nested lineItems on a custom event broke
 *     the Pixel Helper, despite TW docs showing nesting; keep UpsellPurchase flat).
 *   - No page_view mapping — the base snippet is the pageload signal (dl_user_data NOT mapped).
 *   - Upsell = Approach C: TriplePixel('custom','UpsellPurchase',{value,currency,orderId}).
 *   - Contact (identity) sends RAW email/phone via the core's onContact hook. Opt-in via
 *     triplewhale_contact_enabled (default off) — when off, onContact isn't attached, so the core's
 *     contact listeners never activate and NO PII is touched. Purchase carries no PII (identity comes
 *     from the Contact event + TW's session cookie). When on, this adapter registers with:
 *       contactRequiresMarketingConsent: false — TW is an ATTRIBUTION vendor: Contact ties the session to
 *       the order (on a shop-sync store, to the order TW ingests from Shopify). accepts_marketing is the
 *       newsletter opt-in, not a precondition of the prospect cart; gating Contact on it would cap the
 *       attribution match rate at the newsletter opt-in rate. acceptsMarketing is still passed.
 *       contactOnFieldEntry: true — Contact fires as soon as a valid checkout email / phone is entered,
 *       plus on prospect-cart creation (deduped per identifier per page load); the prospect cart alone
 *       waits for first + last name + a cart line and, in the default emailEntry mode, rarely carries
 *       phone. See README.
 *
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus(). QA with a REAL browser +
 * the TW Pixel Helper (it does not beacon in headless browsers).
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[triplewhale.adapter] next-forwarder-core.js must load first');
    return;
  }

  // dl_* event -> TW event name. TW has no view_item/begin_checkout/page_view standard events, so only
  // these three map; Contact fires as a side-channel (see maybeContact). dl_user_data NOT mapped
  // (the base snippet is the pageload signal).
  var MAP = {
    dl_add_to_cart:     'AddToCart',
    dl_purchase:        'Purchase',
    dl_upsell_purchase: 'UpsellPurchase'   // Approach C — sent as TriplePixel('custom','UpsellPurchase',…)
  };

  var CONTACT_ENABLED = /^(true|1|yes)$/i.test(window.__triplewhaleContact || '');

  function str(v) { return (v === undefined || v === null) ? v : String(v); }

  // Map SDK items to TW line items {i, q, v}. item id + quantity are required for TW cart/line items.
  function lineItems(items) {
    return (items || []).map(function (it) {
      return { i: str(it.item_id), q: it.quantity, v: str(it.item_variant_id || it.item_id) };
    });
  }

  // Toggles (comma-separated dl_* or TW names).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__triplewhaleBlockedEvents);
  var allowedRaw = parseList(window.__triplewhaleAllowedEvents);
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  var reg = {
    name: 'triplewhale',
    isActive: function () {
      return !!window.__triplewhaleName && typeof window.TriplePixel === 'function';
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      var TP = window.TriplePixel;

      if (name === 'AddToCart') {
        (ec.items || []).forEach(function (it) {
          if (it.item_id === undefined || it.item_id === null || it.quantity === undefined || it.quantity === null) return;
          TP('AddToCart', { item: str(it.item_id), q: it.quantity, v: str(it.item_variant_id || it.item_id) });
        });
        return;
      }

      if (name === 'Purchase') {
        // MUST be the function-call form (object form doesn't register on headless). No PII here —
        // identity comes from the Contact event (field entry / prospect cart) + TW's in-session cookie.
        TP('Purchase', { orderId: ec.transaction_id, value: ec.value, currency: ec.currency, lineItems: lineItems(ec.items) });
        return;
      }

      if (name === 'UpsellPurchase') {
        // Custom event — FLAT scalars only (NO lineItems). orderId is {orderId}-US{n}.
        TP('custom', 'UpsellPurchase', { value: ec.value, currency: ec.currency, orderId: ec.transaction_id });
        return;
      }
    }
  };

  // Identity: only opt in when enabled, so the core's contact listeners / PII path stay off otherwise.
  // Fires on field entry + prospect cart, NOT gated on accepts_marketing (attribution, see header);
  // the core dedupes per email/phone per page load.
  if (CONTACT_ENABLED) {
    reg.contactRequiresMarketingConsent = false;
    reg.contactOnFieldEntry = true;
    reg.onContact = function (c) {
      var p = {};
      if (c.email) p.email = c.email;
      if (c.phone) p.phone = c.phone;
      if (p.email || p.phone) window.TriplePixel('Contact', p);
    };
  }

  window.NextForwarder.register(reg);
})();
