// Bump personalization guard — stops clicks/keys inside a bump's
// .bump__personalization field from toggling the PackageToggle card. Ported for
// posterity: apollo doesn't enable bump personalization today, so this is a
// no-op (no .bump__personalization fields), but it's ready if it's turned on.
function guardBumpPersonalization() {
  document.querySelectorAll('[data-next-toggle-card] .bump__personalization').forEach(function (el) {
    ['click', 'mousedown', 'keydown'].forEach(function (evt) {
      el.addEventListener(evt, function (e) { e.stopPropagation(); });
    });
  });
}
if (document.readyState !== 'loading') guardBumpPersonalization();
else document.addEventListener('DOMContentLoaded', guardBumpPersonalization);

// Checkout reveal — show only bundles + "Add to Cart" first; reveal the
// rest of the form (shipping/payment/summary/submit) on click. Opt-in via the
// .checkout-form--reveal modifier (set by the checkout_reveal frontmatter flag).
(function initCheckoutReveal() {
  // Make the off-screen (but rendered, for Spreedly) content non-interactive
  // until revealed — keeps it out of tab order and the a11y tree.
  document.querySelectorAll('.checkout-form--reveal:not(.is-revealed) [data-checkout-reveal-panel]').forEach((reveal) => {
    reveal.setAttribute('inert', '');
  });
  document.querySelectorAll('[data-checkout-reveal-trigger]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = btn.closest('.checkout-form--reveal');
      if (!form) return;
      form.classList.add('is-revealed');
      const reveal = form.querySelector('[data-checkout-reveal-panel]');
      if (reveal) {
        reveal.removeAttribute('inert');
        reveal.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
})();

// Reviews slider — horizontal Swiper of review cards with a progress scrollbar.
// One instance per [data-component="reviews-swiper"]. observer/resizeObserver
// recalc dimensions when a responsive instance (hide-tablet-*) becomes visible.
(function initReviewsSliders() {
  if (typeof Swiper === 'undefined') return;
  document.querySelectorAll('[data-component="reviews-swiper"]').forEach((el) => {
    new Swiper(el, {
      slidesPerView: 'auto',
      spaceBetween: 16,
      grabCursor: true,
      observer: true,
      observeParents: true,
      resizeObserver: true,
      scrollbar: { el: el.querySelector('.swiper-scrollbar'), draggable: true },
    });
  });
})();

window.addEventListener('next:initialized', function() {

  // Image-only exit intent — replace with your own image URL
  // Coupon must exist on the campaign (Campaigns app → discount code offer, e.g. EXIT10)
  initExitIntentImage('https://placehold.co/600x400', async () => {
    await next.applyCoupon('EXIT10');
  });
});
