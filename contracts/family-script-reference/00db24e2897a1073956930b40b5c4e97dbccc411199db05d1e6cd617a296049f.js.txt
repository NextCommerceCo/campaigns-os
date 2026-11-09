/* GENERATED from _shared/analytics/js/northbeam.adapter.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * northbeam.adapter.js — Northbeam adapter for next-forwarder-core.js (Route C, no GTM).
 *
 * Northbeam is a marketing ATTRIBUTION platform: it attributes purchases to traffic sources. Its
 * client API is purchase + pageview + identity + custom goals — NOT a funnel-event API. So this adapter
 * maps ONLY purchase + upsell; the base pixel owns the pageview. (Funnel events like add_to_cart would
 * be Northbeam custom goals — fireCustomGoal — only if the merchant configures those goals; not mapped
 * here by default.)
 *
 * Load order (all gated on campaign.northbeam_client_id, on EVERY page incl. receipt/upsell):
 *   1. Northbeam base pixel (analytics-head.snippet.html) — defines window.Northbeam, auto-fires the
 *      pageview (trackPageViewInitial), sets window.__northbeamClientId
 *   2. next-forwarder-core.js
 *   3. this file
 *
 * Requires campaign-cart SDK >= v0.4.28. NOTE: v0.4.28 dl_purchase.value is PRODUCT REVENUE only, and
 * Northbeam's `totalPrice` = final paid (GRAND TOTAL). So totalPrice is reconstructed as
 * value + tax + shipping (shippingPrice/taxPrice sent separately). (Older merchant GTM tags set
 * totalPrice = ecommerce.value, which was correct pre-v0.4.28 when value was the grand total.)
 *
 * Upsell = Approach B: dl_upsell_purchase → another firePurchaseEvent with a distinct id
 * (`{orderId}-US{n}`) + incremental total → upsell revenue attributed; count inflates. If a Northbeam
 * Orders API feed exists, the id must match an order_id in it (see README).
 *
 * Identity (Northbeam.identify email) is opt-in via northbeam_identity_enabled → the core onContact hook.
 * Default off = zero PII. When on, this adapter registers with:
 *   - contactRequiresMarketingConsent: false — Northbeam is an ATTRIBUTION vendor: identify joins the
 *     backend order to the browser session by email. The accepts_marketing checkbox is the newsletter
 *     opt-in (the SDK only records it on the prospect cart; cart creation never depends on it), so gating
 *     identify on it would cap the attribution match rate at the newsletter opt-in rate. Marketing consent
 *     and attribution identity are separate decisions; the core still passes acceptsMarketing here.
 *   - contactOnFieldEntry: true — identify fires the moment a valid email is entered in the checkout
 *     field (Northbeam's own guidance: "identify on every email input"), not only on the prospect cart,
 *     which also waits for first + last name and a cart line. Deduped per email per page load.
 *
 * ⚠️ Shop Sync stores (checkout on NEXT, orders pushed into Shopify): set
 *   northbeam_blocked_events: "dl_purchase, dl_upsell_purchase"
 * and rely on identity. Northbeam ingests the order through its Shopify Connector, which is the order of
 * record; the funnel purchase carries the NEXT order id and can never match the Shopify order's checkout
 * token, so a pixel purchase only creates an unmatched / double-counted order. Attribution then rides
 * entirely on identify(email) matching the order email (see README). Mirrors the Triple Whale shop-sync
 * note (triplewhale_blocked_events).
 *
 * Debug: ?nfdebug=true or localhost, then window.NextForwarder.getStatus().
 */
(function () {
  'use strict';

  if (!window.NextForwarder) {
    if (window.console) console.warn('[northbeam.adapter] next-forwarder-core.js must load first');
    return;
  }

  // Both purchase events call firePurchaseEvent; the ecommerce payload (id/value) distinguishes them.
  // No dl_user_data (base owns pageview). No funnel events (Northbeam is purchase/pageview attribution).
  var MAP = {
    dl_purchase:        'purchase',
    dl_upsell_purchase: 'purchase'   // Approach B — distinct id ({orderId}-US{n})
  };

  var IDENTITY_ENABLED = /^(true|1|yes)$/i.test(window.__northbeamIdentity || '');

  function num(v) { return typeof v === 'number' ? v : (parseFloat(v) || 0); }
  function str(v) { return (v === undefined || v === null) ? v : String(v); }

  function lineItems(items) {
    return (items || []).map(function (it) {
      return {
        productId: str(it.item_product_id || it.item_id),
        variantId: str(it.item_variant_id || it.item_id),
        productName: it.item_name,
        variantName: it.item_variant || it.item_name,
        price: it.price,
        quantity: it.quantity
      };
    });
  }

  // Toggles (comma-separated dl_* or Northbeam names).
  function parseList(raw) {
    return (raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var blocked = parseList(window.__northbeamBlockedEvents);
  var allowedRaw = parseList(window.__northbeamAllowedEvents);
  var allowed = (allowedRaw.length === 1 && (allowedRaw[0] === 'all' || allowedRaw[0] === '*'))
    ? null
    : (allowedRaw.length ? allowedRaw : window.NextForwarder.DEFAULT_MAIN_EVENTS);

  var reg = {
    name: 'northbeam',
    isActive: function () {
      return !!window.__northbeamClientId && !!(window.Northbeam && window.Northbeam.firePurchaseEvent);
    },
    map: MAP,
    allowedEvents: allowed,
    blockedEvents: blocked,
    send: function (name, ec, evt) {
      // Northbeam totalPrice = grand total (final paid). v0.4.28 value = product revenue → reconstruct.
      var p = {
        id: ec.transaction_id,
        totalPrice: num(ec.value) + num(ec.tax) + num(ec.shipping),
        currency: ec.currency
      };
      if (ec.shipping !== undefined && ec.shipping !== null) p.shippingPrice = num(ec.shipping);
      if (ec.tax !== undefined && ec.tax !== null) p.taxPrice = num(ec.tax);
      if (ec.coupon) p.coupons = ec.coupon;
      var up = evt.user_properties || {};
      if (up.customer_id) p.customerId = str(up.customer_id);
      var items = lineItems(ec.items);
      if (items.length) p.lineItems = items;
      window.Northbeam.firePurchaseEvent(p);
    }
  };

  // Identity (opt-in): Northbeam.identify('email', <email>) on the core's onContact — on field entry AND
  // on prospect-cart creation, NOT gated on accepts_marketing (attribution, see header). Signature
  // confirmed from the real GTM tag. Email-only (Northbeam is email-centric). Re-validates with the core's
  // EMAIL_RE (the prospect-cart source is SDK-validated; the field-entry source already passed this regex).
  if (IDENTITY_ENABLED) {
    reg.contactRequiresMarketingConsent = false;
    reg.contactOnFieldEntry = true;
    reg.onContact = function (c) {
      if (c.email && window.NextForwarder.EMAIL_RE.test(c.email)) window.Northbeam.identify('email', c.email);
    };
  }

  window.NextForwarder.register(reg);
})();
