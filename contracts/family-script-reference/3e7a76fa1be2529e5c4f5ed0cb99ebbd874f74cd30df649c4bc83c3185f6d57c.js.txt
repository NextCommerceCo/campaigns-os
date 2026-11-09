// Shared utilities for checkout templates

// ─── Swiper gallery ────────────────────────────────────────────────────────
// thumbsPerView — number of visible thumbnail slides (default 6)
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

// ─── Countdown timer ───────────────────────────────────────────────────────
// Auto-initialises on any element with [data-next-element="timer"]
document.querySelectorAll('[data-next-element="timer"]').forEach(timer => {
  let [minutes, seconds] = timer.textContent.split(':').map(Number);
  let total = minutes * 60 + seconds;
  setInterval(() => {
    if (total <= 0) return;
    total--;
    const m = Math.floor(total / 60);
    const s = total % 60;
    timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (total === 0) timer.style.color = '#ff4444';
    else if (total <= 60) timer.style.color = '#ff9800';
  }, 1000);
});

// ─── Exit intent — image only ───────────────────────────────────────────────
// Simplest approach: pass an image URL. Clicking the image fires action().
// Call inside a next:initialized event handler.
function initExitIntentImage(image, action) {
  window.next.exitIntent({
    image,
    action,
    showCloseButton: true,
    // overlayClosable: true,    // click overlay to close (default: true)
    // maxTriggers: 1,           // times to show per session (default: 1)
    // disableOnMobile: true,    // desktop only by default (default: true)
    // mobileScrollTrigger: false, // trigger on scroll-up on mobile (default: false)
  });
  // next.on('exit-intent:shown', (data) => {});
  // next.on('exit-intent:clicked', (data) => {}); // image clicked
  // next.on('exit-intent:dismissed', (data) => {});
}

// ─── Exit intent — template ─────────────────────────────────────────────────
// Richer approach: uses a <template data-template="name"> block in the HTML.
// Button actions are driven by data-exit-intent-action attributes in the template:
//   data-exit-intent-action="apply-coupon" + data-coupon-code="CODE"
//   data-exit-intent-action="close"
//   data-exit-intent-action="custom"  ← this is the only one that fires action()
// Call inside a next:initialized event handler.
function initExitIntentTemplate(templateName, action) {
  window.next.exitIntent({
    template: templateName,
    action,
    showCloseButton: true,
    // overlayClosable: true,
    // maxTriggers: 1,
    // disableOnMobile: true,
    // mobileScrollTrigger: false,
  });
  // next.on('exit-intent:shown', (data) => {});
  // next.on('exit-intent:action', (data) => {}); // data.action, data.couponCode
  // next.on('exit-intent:dismissed', (data) => {});
  // next.on('exit-intent:closed', (data) => {});
}

// ─── Next modal (generic component) ────────────────────────────────────────
// Auto-initialises on .next-page-modal__trigger / [data-next-modal-close] elements
(function () {
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(() => {
    const body = document.body;
    const defaultTarget = '#next-size-modal';

    function getTargetFromTrigger(el) {
      return (
        el.getAttribute('data-modal-target') ||
        el.getAttribute('href') ||
        defaultTarget
      );
    }

    function getFocusable(container) {
      return container.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
    }

    function openModal(modal) {
      if (!modal) return;
      modal.classList.add('next-page-modal--open');
      modal.setAttribute('aria-hidden', 'false');
      body.classList.add('next-page-modal-open');

      const focusables = getFocusable(modal);
      const focusTarget =
        modal.querySelector('.next-page-modal__close') || focusables[0];
      if (focusTarget) focusTarget.focus();

      function onKey(e) {
        if (e.key === 'Escape') {
          closeModal(modal);
        } else if (e.key === 'Tab') {
          const f = Array.from(getFocusable(modal));
          if (!f.length) return;
          const first = f[0];
          const last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }

      modal._nextModalKeyHandler = onKey;
      document.addEventListener('keydown', onKey);
    }

    function closeModal(modal) {
      if (!modal) return;
      modal.classList.remove('next-page-modal--open');
      modal.setAttribute('aria-hidden', 'true');
      body.classList.remove('next-page-modal-open');
      if (modal._nextModalKeyHandler) {
        document.removeEventListener('keydown', modal._nextModalKeyHandler);
        delete modal._nextModalKeyHandler;
      }
    }

    // Trigger buttons
    document.querySelectorAll('.next-page-modal__trigger').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const targetSel = getTargetFromTrigger(btn);
        const modal =
          document.querySelector(targetSel) ||
          document.querySelector(defaultTarget);
        openModal(modal);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          btn.click();
        }
      });
    });

    // Overlay and close buttons
    document.addEventListener('click', (e) => {
      const overlayClicked = e.target.matches(
        '.next-page-modal__overlay[data-next-modal-close]'
      );
      const closeBtn = e.target.closest('[data-next-modal-close]');
      if (!overlayClicked && !closeBtn) return;
      const modal =
        e.target.closest('.next-page-modal') ||
        document.querySelector(defaultTarget);
      closeModal(modal);
    });
  });
})();
