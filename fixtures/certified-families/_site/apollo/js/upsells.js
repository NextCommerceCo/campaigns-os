// Shared utilities for upsell templates
//
// Quantity UX: upsell-bundle-tier-pills.html uses hidden per-tier bundle cards + initBundleQtyToggle()
// because data-next-upsell-quantity-toggle does not update bundle line items (see https://developers.nextcommerce.com/docs/campaigns/upsells).
// SDK 0.4.18+ native bundle quantity (data-next-bundle-qty-for) is demonstrated on upsell-bundle-stepper.html
// (one card + multiplier). Keep this helper for upsell-bundle-tier-pills tier picking.

/**
 * Bundle upsell qty toggle — wires [data-bundle-qty-btn] buttons to select
 * the matching hidden [data-next-bundle-card] inside a [data-next-bundle-selector].
 *
 * Markup contract:
 *   - Qty container: data-bundle-qty-for="<selectorId>" (typically on `.next-bundle-qty__row`)
 *   - Qty buttons:   data-bundle-qty-btn="<N>" (use `.next-bundle-qty__btn` — next-core.css)
 *   - Bundle cards:  data-next-bundle-id="<selectorId>-<N>x"
 *
 * The bundle selector is hidden from view (display:none) and acts only as a
 * state machine. Prices are shown via remote data-next-display="bundle.<selectorId>.*"
 * outside the selector. On card selection the SDK re-renders remote display values,
 * reflecting the new card's voucher-calculated price for that quantity.
 *
 * NOTE: This does NOT use data-next-upsell-quantity-toggle — that attribute only
 * works with the single-package upsell path and does not update bundle items.
 */
function initBundleQtyToggle() {
  document.querySelectorAll('[data-bundle-qty-for]').forEach(function(container) {
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

// Swiper gallery: init after DOM + Swiper are ready (Swiper script is deferred)
// thumbsPerView — number of visible thumbnail slides (default 6, use 5 for portrait-ratio layouts)
function initSwiperGalleries(thumbsPerView = 6) {
  if (typeof Swiper === 'undefined') return;
  document.querySelectorAll('[data-component="swiper"][data-variant="sw1"]').forEach((sliderComponent) => {
    const sliderMain = sliderComponent.querySelector('[swiper="slider-main"]');
    const sliderThumbs = sliderComponent.querySelector('[swiper="slider-thumbs"]');
    const buttonNextEl = sliderComponent.querySelector('[swiper="next-button"]');
    const buttonPrevEl = sliderComponent.querySelector('[swiper="prev-button"]');
    if (!sliderMain || !sliderThumbs) return;
    const thumbsSwiper = new Swiper(sliderThumbs, {
      slidesPerView: thumbsPerView,
      spaceBetween: 10,
      freeMode: false,
      watchSlidesProgress: true,
      watchOverflow: true,
      centerInsufficientSlides: true,
      breakpoints: {
        768: { slidesPerView: thumbsPerView, spaceBetween: 10 },
        480: { slidesPerView: thumbsPerView, spaceBetween: 8 },
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
