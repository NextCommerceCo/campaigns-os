/* GENERATED from _shared/upsell/js/upsells.js — edit the source and run `npm run sync:shared`. Do not edit this copy. */
// Shared utilities for upsell templates (apollo). Self-initialising: the page needs no inline <script>.
//
//   initSwiperGalleries()    — media carousel (swiper-gallery.html) once Swiper + DOM are ready
//   initBundleQtyToggle()    — tier-pills / mv quantity buttons → click the matching hidden bundle card
//   initUpsellProxyActions() — data-upsell-proxy="add|skip" buttons OUTSIDE the SDK offer wrapper
//                              (upsell/closing-cta.html) forward to the real in-offer actions
//
// Quantity UX: tier-pills uses hidden per-tier bundle cards + initBundleQtyToggle() because
// data-next-upsell-quantity-toggle does not update bundle line items (see https://developers.nextcommerce.com/docs/campaigns/upsells).
// SDK 0.4.18+ native bundle quantity (data-next-bundle-qty-for) is what the stepper offer type uses.

/**
 * Bundle upsell qty toggle — wires [data-bundle-qty-btn] buttons to select
 * the matching hidden [data-next-bundle-card] inside a [data-next-bundle-selector].
 *
 * Markup contract (upsell/offer-controls.html / upsell/offer-selector.html):
 *   - Qty container: data-bundle-qty-for="<selectorId>" (on `.next-bundle-qty__row`)
 *   - Qty buttons:   data-bundle-qty-btn="<N>" (`.next-bundle-qty__btn`)
 *   - Bundle cards:  data-next-bundle-id="<selectorId>-<N>x"
 *
 * The bundle selector is hidden (display:none) and acts only as a state machine. Prices surface via
 * remote data-next-display="bundle.<selectorId>.*" outside the selector; the SDK re-renders them on
 * card selection with the new card's voucher-calculated price.
 *
 * NOTE: not data-next-upsell-quantity-toggle — that only works with the single-package upsell path.
 */
function initBundleQtyToggle() {
  document.querySelectorAll('[data-bundle-qty-for]').forEach(function(container) {
    if (container.dataset.qtyToggleReady) return;
    container.dataset.qtyToggleReady = '1';
    var selectorId = container.getAttribute('data-bundle-qty-for');
    var buttons = container.querySelectorAll('[data-bundle-qty-btn]');
    var selector = document.querySelector('[data-next-selector-id="' + selectorId + '"]');
    if (!selector) return;

    buttons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var qty = btn.getAttribute('data-bundle-qty-btn');
        var card = selector.querySelector('[data-next-bundle-id="' + selectorId + '-' + qty + 'x"]');
        if (!card) return;
        card.click();
        buttons.forEach(function(b) { b.classList.remove('next-selected'); });
        btn.classList.add('next-selected');
      });
    });
  });
}


/**
 * Proxy actions — a closing CTA / decline rendered OUTSIDE [data-next-upsell="offer"]
 * (upsell/closing-cta.html) forwards its click to the real SDK action inside the offer.
 * One SDK offer per page: the secondary CTA always adds exactly what the main offer shows
 * (selected tier, quantity, variants, vouchers) instead of a drifting second offer wrapper.
 */
function initUpsellProxyActions() {
  document.querySelectorAll('[data-upsell-proxy]').forEach(function(el) {
    if (el.dataset.proxyReady) return;
    el.dataset.proxyReady = '1';
    el.addEventListener('click', function(event) {
      event.preventDefault();
      var action = el.getAttribute('data-upsell-proxy');
      var target = document.querySelector('[data-next-upsell="offer"] [data-next-upsell-action="' + action + '"]');
      if (target) target.click();
    });
  });
}

// Swiper gallery: init after DOM + Swiper are ready (Swiper script is deferred)
// thumbsPerView — visible thumbnail slides (default 6); a per-gallery data-swiper-thumbs attribute
// (frontmatter swiper_thumbs_per_view) overrides it.
function initSwiperGalleries(thumbsPerView = 6) {
  if (typeof Swiper === 'undefined') return;
  document.querySelectorAll('[data-component="swiper"][data-variant="sw1"]').forEach((sliderComponent) => {
    if (sliderComponent.dataset.swiperReady) return;
    const sliderMain = sliderComponent.querySelector('[swiper="slider-main"]');
    const sliderThumbs = sliderComponent.querySelector('[swiper="slider-thumbs"]');
    const buttonNextEl = sliderComponent.querySelector('[swiper="next-button"]');
    const buttonPrevEl = sliderComponent.querySelector('[swiper="prev-button"]');
    if (!sliderMain || !sliderThumbs) return;
    sliderComponent.dataset.swiperReady = '1';
    const perView = parseInt(sliderComponent.dataset.swiperThumbs, 10) || thumbsPerView;
    const thumbsSwiper = new Swiper(sliderThumbs, {
      slidesPerView: perView,
      spaceBetween: 10,
      freeMode: false,
      watchSlidesProgress: true,
      watchOverflow: true,
      centerInsufficientSlides: true,
      breakpoints: {
        768: { slidesPerView: perView, spaceBetween: 10 },
        480: { slidesPerView: perView, spaceBetween: 8 },
      },
    });
    new Swiper(sliderMain, {
      slidesPerView: 1,
      spaceBetween: 0,
      navigation: { nextEl: buttonNextEl, prevEl: buttonPrevEl },
      thumbs: { swiper: thumbsSwiper },
    });
    sliderThumbs.querySelectorAll('.swiper-slide').forEach((slide, index) => {
      slide.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          thumbsSwiper.slideTo(index, 300);
        }
      });
    });
  });
}

// Self-init. Scripts load with `defer`, so DOMContentLoaded may or may not have fired yet.
(function () {
  function onReady() {
    initSwiperGalleries();
    initUpsellProxyActions();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
  // Hidden bundle cards exist at parse time, but wait for the SDK so the first programmatic click lands.
  window.addEventListener('next:initialized', function () { initBundleQtyToggle(); });
})();
