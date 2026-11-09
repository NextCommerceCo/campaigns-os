/* GENERATED from _shared/analytics/js/next-forwarder-core.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
/**
 * next-forwarder-core.js — shared plumbing for Route C (code-controlled) analytics forwarders.
 *
 * Registers the SDK's NextDataLayerTransformFn hook ONCE and fans every surviving event out to any
 * number of vendor adapters (GA4, TikTok, Snap, …). Owns the generic concerns so each adapter is
 * pure mapping:
 *   - consent ordering — runs the prior transformFn chain FIRST, forwards only what survives
 *   - redirect handling — skips events flagged _willRedirect (they fire pre-redirect AND replay
 *     post-redirect through the transformFn; forwarding only the replay prevents a cross-page
 *     double-fire and matches the SDK's own providers, which fire only after the redirect)
 *   - dedup — per-adapter, keyed on event_id (guards same-page-load duplicates)
 *   - replay — re-plays events already queued in NextDataLayer when an adapter registers late
 *   - event toggles — per-adapter allowedEvents (allowlist) + blockedEvents (denylist), both
 *     client-configurable per campaign and matched against the dl_* source name (precise) or the
 *     mapped vendor name (coarser). Allow-list is applied first, then block-list removes from it.
 *     Adapters that omit allowedEvents default to NextForwarder.DEFAULT_MAIN_EVENTS (main funnel +
 *     conversion; obscure events like login/sign_up off).
 *   - data quality — warns once/event when a value is sent without a currency (vendors drop it)
 *   - contact/identity — optional onContact hook for identity adapters (Triple Whale, Northbeam, ad-
 *     platform advanced matching). Fires when the SDK creates a prospect cart (next:prospect-cart-
 *     created) and, per adapter opt-in, as soon as a valid checkout email/phone is entered. Deduped
 *     per adapter per identifier. The accepts_marketing consent gate is PER ADAPTER (default on;
 *     attribution vendors turn it off — see the contact bridge below). Only active if an adapter opts
 *     in — non-identity adapters never touch PII.
 *   - debug — one switch (?nfdebug=true or localhost) + NextForwarder.getStatus()
 *
 * Load this BEFORE any adapter. Adapters call NextForwarder.register(adapter).
 *
 * Adapter contract:
 *   {
 *     name: 'ga4',
 *     isActive: function () -> boolean,          // is this vendor loaded/configured on the page?
 *     map: { dl_add_to_cart: 'add_to_cart', … }, // dl_* event -> vendor event name
 *     send: function (vendorName, ecommerce, event) -> void, // do the vendor call
 *     allowedEvents: ['dl_purchase', 'dl_add_to_cart'], // optional: ONLY these fire. Omitted/[] ->
 *                                                       //   DEFAULT_MAIN_EVENTS; explicit null -> all
 *     blockedEvents: ['dl_login', 'dl_sign_up'],        // optional: suppress these (applied after allow)
 *     onContact: function ({email?, phone?, acceptsMarketing?, source}) {}, // optional identity hook;
 *                                                       //   source = 'prospect' | 'field:<dom event>'
 *     contactRequiresMarketingConsent: true,            // optional (default true): skip onContact while an
 *                                                       //   accepts_marketing checkbox is present AND
 *                                                       //   unchecked. false = fire regardless (attribution
 *                                                       //   identity); acceptsMarketing is still passed
 *     contactOnFieldEntry: false                        // optional (default false): also fire onContact the
 *                                                       //   moment a valid checkout email/phone is entered
 *                                                       //   (no name/cart needed), deduped per identifier
 *   }
 */
(function () {
  'use strict';

  if (window.NextForwarder) return; // already loaded

  var MAX_SEEN = 500;
  var adapters = [];
  var hookInstalled = false;
  var userTransform = null; // a consent/redaction transform installed before or after us (runs first)

  // Default allowlist for adapters that don't specify one: the main funnel + conversion events.
  // Obscure events (login, sign_up, subscribe, search, view_cart, remove_from_cart, item lists) are
  // OFF by default — enable per campaign via <vendor>_allowed_events. Keyed by dl_* source name.
  var DEFAULT_MAIN_EVENTS = [
    'dl_user_data',        // page_view
    'dl_view_item', 'dl_add_to_cart', 'dl_begin_checkout',
    'dl_add_shipping_info', 'dl_add_payment_info',
    'dl_purchase', 'dl_upsell_purchase'
  ];

  var DEBUG =
    /[?&]nfdebug=true/.test(window.location.search) ||
    /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[NextForwarder]'].concat([].slice.call(arguments)));
  }

  // Data-quality checks that are true for every value-based vendor, warned once per event_id.
  var warned = {};
  function preprocess(evt) {
    if (!evt || !evt.event || !evt.event_id || warned[evt.event_id]) return;
    var ec = evt.ecommerce;
    if (ec && ec.value !== undefined && ec.value !== null && !ec.currency) {
      warned[evt.event_id] = true;
      if (window.console && window.console.warn) {
        console.warn('[NextForwarder] "' + evt.event + '" has a value but no currency — GA4 and ' +
          'other vendors drop the monetary value without an ISO-4217 currency. event_id=' + evt.event_id);
      }
    }
  }

  // ---- contact / identity bridge (opt-in via adapter.onContact) -----------------------
  // For adapters that resolve identity (Triple Whale, Northbeam, TikTok/Snap/Pinterest advanced
  // matching). Only active if an adapter opts in with onContact, so non-identity adapters
  // (GA4/Axon/Taboola) never touch PII. Two sources feed it:
  //
  //   1. PROSPECT CART — every contact adapter. The SDK's `next:prospect-cart-created` DOM event
  //      (ProspectCartEnhancer: a valid email and/or phone per data-trigger-on, PLUS first + last name,
  //      PLUS items in cart; emitted once per session). We reuse the SDK's field detection, validation
  //      and debounce rather than re-scraping fields.
  //   2. FIELD ENTRY — opt-in per adapter (contactOnFieldEntry). A valid email or phone typed into the
  //      checkout field, the moment it validates: no name, no cart. This is what attribution vendors
  //      ask for (Northbeam: "identify on every email input") — the prospect cart is late (waits for
  //      both names + a cart line) and, under a phone-only or email-only trigger, never carries the
  //      other identifier at all. An attribution join needs an identifier, not a cart.
  //
  // Both sources dedupe PER ADAPTER PER IDENTIFIER (email / phone value, this page load): the same email
  // arriving from a field blur and then again from the prospect event fires each adapter once.
  //
  // Consent is PER ADAPTER — contactRequiresMarketingConsent (default true). When the page has an
  // accepts_marketing checkbox and it is unchecked, adapters on the default skip the contact. That
  // checkbox is the NEWSLETTER opt-in: the SDK only records it on the prospect cart, creation never
  // depends on it (campaign-cart prospect-cart/cart-creation.ts). Ad-platform advanced matching
  // (TikTok/Snap/Pinterest) is marketing use and stays behind it. Attribution vendors (Northbeam,
  // Triple Whale) set it to false: they join a backend order — e.g. the Shopify Connector order on a
  // Shop Sync store — to the browser session by email, so gating identify on the newsletter box caps
  // the attribution match rate at the newsletter opt-in rate. acceptsMarketing is always passed in the
  // contact object so an adapter can still decide what to send.
  //
  // No contact at all if the prospect enhancer is disabled AND no adapter opted into field entry.
  var contactAdapters = [];
  var prospectHooked = false;
  var fieldHooked = false;
  var EMAIL_SEL = '[data-next-checkout-field="email"], [os-checkout-field="email"]';
  var PHONE_SEL = '[data-next-checkout-field="phone"], [os-checkout-field="phone"], input[type="tel"]';
  var AM_SEL = '[data-next-checkout-field="accepts_marketing"], [os-checkout-field="accepts_marketing"]';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MIN_PHONE_DIGITS = 7; // mirrors the SDK's prospect threshold (MIN_PROSPECT_PHONE_DIGITS)

  function fieldVal(sel) { var el = document.querySelector(sel); return (el && el.value) ? el.value.trim() : ''; }

  function itiFor(el) {
    return el && (el.iti || (window.intlTelInput && window.intlTelInput.getInstance && window.intlTelInput.getInstance(el)));
  }

  // Phone must be E.164 (+<country><number>) or Triple Whale-style identity joins against the order/feed
  // silently fail. Three sources, by what is on the field — no SDK version is read:
  //   1. data-next-phone-e164 on the input (SDK >= 0.4.41, NextCommerceCo/campaign-cart#108). The SDK
  //      writes it only while the parsed number is valid and removes it otherwise, so it is never stale.
  //   2. An intl-tel-input instance (SDK <= 0.4.38 put one on the field): its getNumber().
  //   3. Neither (SDK 0.4.39 / 0.4.40: the field shows the country's national mask, "(415) 555-2671",
  //      and the E.164 is not exposed): only a number the shopper typed with its own "+" is used.
  // Anything else returns '' — field entry then sends no phone, and the prospect-cart source delivers
  // the SDK's own E.164. Never guesses a dial code.
  var E164_ATTR = 'data-next-phone-e164';

  function phoneVal(el) {
    el = el || document.querySelector(PHONE_SEL);
    if (!el) return '';
    var attr = el.getAttribute(E164_ATTR);
    if (attr) return attr;
    var iti = itiFor(el);
    if (iti && typeof iti.getNumber === 'function') {
      try { var e164 = iti.getNumber(); if (e164) return e164; } catch (err) {}
    }
    var raw = el.value ? el.value.trim() : '';
    return raw.charAt(0) === '+' ? '+' + raw.replace(/\D/g, '') : '';
  }

  // Is the field's current value a usable phone? The SDK's own verdict when it exposes one (the E.164
  // attribute is present only for a valid number; intl-tel-input's isValidNumber()), else the SDK's
  // prospect digit-count threshold.
  function validPhone(el) {
    var raw = (el && el.value) ? el.value.trim() : '';
    if (!raw) return false;
    if (el.getAttribute(E164_ATTR)) return true;
    var iti = itiFor(el);
    if (iti && typeof iti.isValidNumber === 'function') {
      try { return !!iti.isValidNumber(); } catch (err) {}
    }
    return raw.replace(/\D/g, '').length >= MIN_PHONE_DIGITS;
  }

  function marketingConsent() { var am = document.querySelector(AM_SEL); return am ? !!am.checked : undefined; }

  // Fan a contact out to the identity adapters. fieldEntry=true restricts it to adapters that opted
  // into contactOnFieldEntry. Per-adapter consent check, then per-adapter identifier dedup (an adapter
  // that was blocked by consent is NOT marked seen, so it still gets the contact if consent is granted
  // before a later source fires).
  function dispatchContact(contact, fieldEntry) {
    if (!contact.email && !contact.phone) return;
    contact.acceptsMarketing = marketingConsent();
    var keys = [];
    if (contact.email) keys.push('email:' + contact.email.toLowerCase());
    if (contact.phone) keys.push('phone:' + contact.phone.replace(/\D/g, ''));
    for (var i = 0; i < contactAdapters.length; i++) {
      var a = contactAdapters[i];
      if (fieldEntry && !a.contactOnFieldEntry) continue;
      if (a.contactRequiresMarketingConsent !== false && contact.acceptsMarketing === false) {
        log(a.name, 'contact blocked: accepts_marketing unchecked', contact.source); continue;
      }
      var fresh = false, k;
      for (k = 0; k < keys.length; k++) if (!a._contactSeen[keys[k]]) fresh = true;
      if (!fresh) { log(a.name, 'contact dup dropped', contact.source); continue; }
      for (k = 0; k < keys.length; k++) a._contactSeen[keys[k]] = true;
      try { a.onContact(contact); a._contacts++; log(a.name, 'contact', contact.source); }
      catch (err) { log(a.name, 'onContact error', err); }
    }
  }

  function onProspectCartCreated(e) {
    var d = (e && e.detail) || {}, pc = d.prospectCart || {}, cart = d.cart || {};
    var email = pc.email || cart.email || fieldVal(EMAIL_SEL);
    var phone = pc.phone || cart.phone || phoneVal(); // SDK E.164 preferred; field fallback is E.164-or-nothing (phoneVal)
    dispatchContact({ email: email || undefined, phone: phone || undefined, source: 'prospect' }, false);
  }

  function installProspectHook() {
    if (prospectHooked || typeof document === 'undefined') return;
    prospectHooked = true;
    document.addEventListener('next:prospect-cart-created', onProspectCartCreated);
  }

  // Field-entry source. Delegated capture-phase listeners (blur doesn't bubble; the checkout form may
  // render after this script), debounced so a typed address fires once it becomes valid; change/blur
  // also cover autofill and paste. Prefilled values (bfcache, SDK-restored checkout state) are picked up
  // at DOMContentLoaded and again after the SDK initialises.
  var fieldTimers = {}; // one debounce per field kind — a quick email→phone move must not cancel the email
  function captureField(el, source) {
    if (!el) return;
    if (el.matches(EMAIL_SEL)) {
      var email = (el.value || '').trim();
      if (EMAIL_RE.test(email)) dispatchContact({ email: email, source: source }, true);
    } else if (el.matches(PHONE_SEL)) {
      if (validPhone(el)) dispatchContact({ phone: phoneVal(el), source: source }, true);
    }
  }
  function onFieldEvent(e) {
    var el = e && e.target;
    if (!el || typeof el.matches !== 'function' || !(el.matches(EMAIL_SEL) || el.matches(PHONE_SEL))) return;
    var key = el.matches(EMAIL_SEL) ? 'email' : 'phone';
    clearTimeout(fieldTimers[key]);
    fieldTimers[key] = setTimeout(function () { captureField(el, 'field:' + e.type); }, 400);
  }
  function capturePrefilled() {
    var els = document.querySelectorAll(EMAIL_SEL + ', ' + PHONE_SEL);
    for (var i = 0; i < els.length; i++) captureField(els[i], 'field:prefilled');
  }
  function installFieldHook() {
    if (fieldHooked || typeof document === 'undefined') return;
    fieldHooked = true;
    ['change', 'blur', 'input'].forEach(function (t) { document.addEventListener(t, onFieldEvent, true); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', capturePrefilled);
    else capturePrefilled();
    // SDK-restored values: re-scan after init. Always listen (window.next existing does not mean init has
    // finished), and ALSO scan now if the SDK object is already present in case the event has passed (late
    // adapter registration). Per-identifier dedup swallows any duplicate.
    document.addEventListener('next:initialized', function () { setTimeout(capturePrefilled, 0); });
    if (window.next) setTimeout(capturePrefilled, 0);
  }

  function processForAdapter(adapter, evt) {
    if (!evt || !evt.event) return;
    // Redirect-queued events (e.g. dl_purchase, dl_upsell_purchase) fire on the checkout page with
    // this flag, BEFORE the SDK queues them across the redirect. The transformFn runs at push()
    // time — before the SDK's willRedirect check — so we'd see the event here (pre-redirect) AND
    // again when it replays on the receipt page (flag stripped), double-firing across two page
    // loads that in-memory dedup can't span. Skip it now; forward the post-redirect replay instead.
    // This matches the SDK's own providers, which are notified only after the willRedirect return.
    // NB: skip BEFORE the dedup-add below, or page 1 would mark the id seen and suppress page 2.
    if (evt._willRedirect) return;
    try {
      if (!adapter.isActive()) return;
      var name = adapter.map[evt.event];
      if (!name) return; // this adapter doesn't map this event

      // Per-adapter allowlist: if set, ONLY listed events fire (source dl_* name or vendor name).
      if (adapter._allowed && !(adapter._allowed[evt.event] || adapter._allowed[name])) {
        log(adapter.name, 'not in allowlist', evt.event); return;
      }
      // Then the denylist removes from whatever survived the allowlist.
      if (adapter._blocked && (adapter._blocked[evt.event] || adapter._blocked[name])) {
        log(adapter.name, 'blocked', evt.event); return;
      }

      var id = evt.event_id;
      if (id) {
        if (adapter._seenSet[id]) { log(adapter.name, 'dup dropped', evt.event, id); return; }
        adapter._seenSet[id] = true;
        adapter._seen.push(id);
        if (adapter._seen.length > MAX_SEEN) delete adapter._seenSet[adapter._seen.shift()];
      }

      adapter.send(name, evt.ecommerce || {}, evt);
      adapter._count++;
      log(adapter.name, 'sent', name);
    } catch (e) {
      log(adapter.name, 'error', e); // never break the data layer
    }
  }

  // The forwarding transform: run any user/consent transform FIRST, forward survivors to adapters,
  // and return the (possibly transformed) event so NextDataLayer stays consistent.
  function forwarderTransform(evt) {
    var kept = userTransform ? userTransform(evt) : evt;
    if (kept) {
      preprocess(kept);
      for (var i = 0; i < adapters.length; i++) processForAdapter(adapters[i], kept);
    }
    return kept; // MUST return so NextDataLayer stays consistent
  }

  // Re-forward everything already queued in NextDataLayer (idempotent: per-adapter event_id dedup).
  // Only needed on the fallback path below; the accessor keeps the hook live so the common path
  // never loses an event.
  function replayQueued() {
    (window.NextDataLayer || []).forEach(function (evt) {
      preprocess(evt);
      for (var i = 0; i < adapters.length; i++) processForAdapter(adapters[i], evt);
    });
  }

  function installHook() {
    if (hookInstalled) return;
    hookInstalled = true;

    // Capture a transform installed before us (consent/redaction) — it keeps running first.
    var existing = window.NextDataLayerTransformFn;
    if (typeof existing === 'function' && existing !== forwarderTransform) userTransform = existing;

    // ⚠️ The SDK's NextAnalytics constructor does `window.NextDataLayerTransformFn = null` at init
    // (campaign-cart src/utils/analytics/index.ts, v0.4.30+). This file loads in <head> BEFORE the
    // SDK module executes, so a PLAIN ASSIGNMENT here is always wiped and no event reaches the
    // adapters (Route C forwards zero events, deterministically). Define the global as an ACCESSOR
    // instead: reads always return the forwarding wrapper (so DataLayerManager.push always invokes
    // us), and writes land in the user-transform slot — so the SDK's null reset, a config.transformFn,
    // setTransformFunction(), and any later consent script keep their documented behaviour; they just
    // can't evict forwarding. Writing null / a non-function clears only the user chain (mirrors what
    // the SDK's reset intends). configurable:true = deliberate escape hatch for a future redefine.
    try {
      Object.defineProperty(window, 'NextDataLayerTransformFn', {
        configurable: true,
        get: function () { return forwarderTransform; },
        set: function (fn) {
          userTransform = (typeof fn === 'function' && fn !== forwarderTransform) ? fn : null;
        }
      });
    } catch (e) {
      // Fallback if the property is somehow non-definable: assign now, then re-assert after SDK init
      // and replay anything pushed in the gap. next:initialized is the SDK's documented init event.
      window.NextDataLayerTransformFn = forwarderTransform;
      document.addEventListener('next:initialized', function () {
        var cur = window.NextDataLayerTransformFn;
        if (cur !== forwarderTransform) {
          if (typeof cur === 'function') userTransform = cur;
          window.NextDataLayerTransformFn = forwarderTransform;
          replayQueued();
        }
      });
    }
  }

  window.NextForwarder = {
    DEFAULT_MAIN_EVENTS: DEFAULT_MAIN_EVENTS,
    EMAIL_RE: EMAIL_RE, // the field-entry email shape; adapters re-validating prospect emails should use it
    register: function (adapter) {
      if (!adapter || !adapter.name || typeof adapter.send !== 'function' ||
          typeof adapter.isActive !== 'function' || !adapter.map) {
        log('ignored invalid adapter', adapter && adapter.name);
        return this;
      }
      adapter._seen = [];
      adapter._seenSet = {};
      adapter._count = 0;
      adapter._contacts = 0;
      adapter._contactSeen = {};
      if (typeof adapter.onContact === 'function') {
        contactAdapters.push(adapter);
        installProspectHook();
        if (adapter.contactOnFieldEntry) installFieldHook();
      }
      // Quiet by default, enforced HERE: an adapter that OMITS allowedEvents (or passes an empty
      // list) gets DEFAULT_MAIN_EVENTS — the core owns the documented default instead of trusting
      // every adapter to re-implement the fallback. Pass null explicitly to forward every mapped
      // event. (The shipped adapters parse <vendor>_allowed_events themselves and always set this
      // property, so their behavior is unchanged.)
      var allowedList = adapter.allowedEvents;
      if (allowedList === undefined || (allowedList && !allowedList.length)) allowedList = DEFAULT_MAIN_EVENTS;
      adapter._allowed = null;
      if (allowedList && allowedList.length) {
        adapter._allowed = {};
        for (var a2 = 0; a2 < allowedList.length; a2++) adapter._allowed[allowedList[a2]] = true;
      }
      adapter._blocked = null;
      if (adapter.blockedEvents && adapter.blockedEvents.length) {
        adapter._blocked = {};
        for (var b = 0; b < adapter.blockedEvents.length; b++) adapter._blocked[adapter.blockedEvents[b]] = true;
      }
      adapters.push(adapter);
      installHook();
      // Replay events already queued before this adapter registered. NextDataLayer only holds
      // events that survived the consent chain, so replaying it is consent-safe. Per-adapter
      // dedup means a late-registering adapter still receives the full backlog.
      (window.NextDataLayer || []).forEach(function (evt) { preprocess(evt); processForAdapter(adapter, evt); });
      log('registered', adapter.name, '| replayed', (window.NextDataLayer || []).length, 'queued events');
      return this;
    },
    getStatus: function () {
      return adapters.map(function (a) {
        return {
          name: a.name, active: a.isActive(), sent: a._count, contacts: a._contacts,
          allowed: a._allowed ? Object.keys(a._allowed) : 'all', blocked: a.blockedEvents || [],
          contact: typeof a.onContact === 'function'
            ? { requiresMarketingConsent: a.contactRequiresMarketingConsent !== false, onFieldEntry: !!a.contactOnFieldEntry }
            : null
        };
      });
    },
    setDebug: function (on) { DEBUG = !!on; }
  };
})();
