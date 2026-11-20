/* GENERATED from _shared/upsell/js/payment-logos.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
// payment-logos.js — reveal only the payment methods the campaign offers (payment-logos.html).
// Shared by checkout and upsell pages: add `js/payment-logos.js` to the page scripts wherever the partial
// is included. Uses the supported SDK call only (next.getCampaignData() once the SDK is up, queued on
// window.nextReady); until then the row keeps its server-rendered state (the default card tiles + any forced logos).

/**
 * Each [data-payment-logo="<code>"] is shown when its code is in the campaign's
 * available_payment_methods + available_express_payment_methods (platform payment-source codes:
 * bankcard, paypal, apple_pay, google_pay, klarna, affirm, link, shop_pay, twint, bancontact, ideal, sepa_debit …).
 * Card brand tiles carry data-payment-logo="bankcard" plus data-card-brand="<platform card code>"; they follow
 * the bankcard method (the campaign payload carries no per-brand list — see payment-logos.html).
 * data-payment-force="show|hide" (frontmatter payment_flags.show_*) wins over the campaign.
 */
function initPaymentLogos(sdk) {
  // A queued nextReady callback runs before the SDK assigns window.next, so prefer the instance it passes.
  var nextApi = sdk || window.next;
  var rows = document.querySelectorAll('[data-payment-logos]');
  if (!rows.length || !nextApi || typeof nextApi.getCampaignData !== 'function') return;
  var data = nextApi.getCampaignData();
  if (!data) return;
  var offered = {};
  [].concat(data.available_payment_methods || [], data.available_express_payment_methods || []).forEach(function(m) {
    var code = typeof m === 'string' ? m : (m && m.code);
    if (code) offered[code] = true;
  });
  rows.forEach(function(row) {
    row.querySelectorAll('[data-payment-logo]').forEach(function(img) {
      var force = img.getAttribute('data-payment-force');
      var show = force === 'show' ? true : force === 'hide' ? false : !!offered[img.getAttribute('data-payment-logo')];
      if (show && img.hasAttribute('data-card-brand') && img.getAttribute('data-card-default') !== 'true' && force !== 'show') show = false;
      img.hidden = !show;
    });
    row.dataset.paymentLogosReady = 'live';
  });
}

// window.nextReady, not a next:initialized listener: a deferred script can run after the SDK booted, when the
// event is gone. nextReady runs the callback once, from the queue at boot or immediately if the SDK is already up.
window.nextReady = window.nextReady || [];
window.nextReady.push(function (sdk) { initPaymentLogos(sdk); });
