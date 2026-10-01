/* GENERATED from _shared/upsell/js/payment-logos.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
// payment-logos.js — reveal only the payment methods the campaign offers (payment-logos.html).
// Shared by checkout and upsell pages: add `js/payment-logos.js` to the page scripts wherever the partial
// is included. Uses the supported SDK call only (next.getCampaignData() on next:initialized); until then
// the row keeps its server-rendered state (the default card tiles + any forced logos).

/**
 * Each [data-payment-logo="<code>"] is shown when its code is in the campaign's
 * available_payment_methods + available_express_payment_methods (platform payment-source codes:
 * bankcard, paypal, apple_pay, google_pay, klarna, affirm, link, twint, bancontact, ideal, sepa_debit …).
 * Card brand tiles carry data-payment-logo="bankcard" plus data-card-brand="<platform card code>"; they follow
 * the bankcard method (the campaign payload carries no per-brand list — see payment-logos.html).
 * data-payment-force="show|hide" (frontmatter payment_flags.show_*) wins over the campaign.
 */
function initPaymentLogos() {
  var rows = document.querySelectorAll('[data-payment-logos]');
  if (!rows.length || !window.next || typeof window.next.getCampaignData !== 'function') return;
  var data = window.next.getCampaignData();
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

window.addEventListener('next:initialized', initPaymentLogos);
