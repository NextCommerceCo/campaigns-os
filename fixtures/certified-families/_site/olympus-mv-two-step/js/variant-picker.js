/* ──────────────────────────────────────────────────────────────────────────
 * variant-picker.js — reference MV bundle picker (olympus-mv)
 *
 * Renders per-unit variant slots into the SDK data-next-bundle-slots-for stage,
 * rebuilds data-next-bundle-items when the quantity tier or a slot variant changes,
 * keeps the dropdown swatches in sync, and sources the slot image with a documented
 * precedence: live API getPackageImage(packageId) > declared template swatch.
 *
 * B1 remediation (Shield retro) — three properties this file guarantees:
 *   1. NO hardcoded image map. The value->packageId and value->image maps both come
 *      from #vp-config (emitted once by variant-picker.html from the `variants`
 *      frontmatter). There is no second map to drift out of sync.
 *   2. OFFLINE-SAFE. Slots paint on DOMContentLoaded from the declared images/prices —
 *      rendering does NOT wait for `next:initialized`, so the picker is never blank in
 *      a no-network env. Live data (prices, API images) is layered on when/if the SDK
 *      initialises (real loader OR variant-picker-fixture.js).
 *   3. Layout via .os-card__variant-group.cc-row (next-core) — see variant-picker.css.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  // ── Config (single declared source — no hardcoded map) ─────────────────────
  var cfgEl = document.getElementById('vp-config');
  if (!cfgEl) return;
  var CFG;
  try { CFG = JSON.parse(cfgEl.textContent); } catch (e) { return; }

  var SELECTOR_ID = CFG.selectorId || 'vp-main';
  var PACKAGES    = CFG.packages || {};          // { variantValue: packageId }
  var IMAGES      = CFG.images || {};            // { variantValue: templateSwatchSrc }
  var DEFAULT     = { cs: CFG.defaultVariant || Object.keys(PACKAGES)[0] };

  var slots     = [];
  var activeQty = 1;
  var booted    = false;
  var isSyncing = false;
  var cartApplySeq = 0;
  var cartApplyPromise = Promise.resolve();
  var unitPrices = {};                           // { variantValue: priceString }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function pkgId(slot) { return PACKAGES[(slot || DEFAULT).cs]; }

  function buildItems(qty) {
    var map = {};
    for (var i = 0; i < qty; i++) {
      var id = pkgId(slots[i] || DEFAULT);
      if (!id) continue;
      map[id] = (map[id] || 0) + 1;
    }
    return Object.keys(map).map(function (k) {
      return { packageId: parseInt(k, 10), quantity: map[k] };
    });
  }

  function formatMoneyLike(template, value) {
    var amount = Number(value);
    if (!isFinite(amount)) return template || '—';
    var source = template || '$0.00';
    var prefix = (source.match(/^[^\d-]+/) || [''])[0];
    var suffix = (source.match(/[^\d.,]+$/) || [''])[0];
    return prefix + amount.toFixed(2) + suffix;
  }

  function parseMoney(value) {
    if (!value) return null;
    var normalized = String(value).replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    var amount = parseFloat(normalized);
    return isFinite(amount) ? amount : null;
  }

  function priceValue(value, fallbackTemplate) {
    if (value === null || typeof value === 'undefined' || value === '') return '';
    if (typeof value === 'number') return formatMoneyLike(fallbackTemplate, value);
    return String(value);
  }

  function selectedDiscountPercent() {
    var active = document.querySelector('[data-vp-selector] [data-next-bundle-card][data-next-selected="true"]') ||
      document.querySelector('[data-next-bundle-card][data-next-selected="true"]');
    var source = active || document;
    var el = source.querySelector('[data-next-bundle-display="discountPercentage"], [data-next-display="bundle.' + SELECTOR_ID + '.discountPercentage"]');
    var match = el && el.textContent ? el.textContent.match(/-?\d+(\.\d+)?/) : null;
    return match ? parseFloat(match[0]) : 0;
  }

  function estimatedDiscountPrice(basePrice) {
    var amount = parseMoney(basePrice);
    var percent = selectedDiscountPercent();
    if (amount === null || !percent) return basePrice || '—';
    return formatMoneyLike(basePrice, amount * (1 - percent / 100));
  }

  function getCartLine(packageId) {
    if (!window.next || typeof window.next.getCartData !== 'function') return null;
    var data = window.next.getCartData();
    var lines = (data && (data.cartLines || data.items)) || [];
    for (var i = 0; i < lines.length; i++) {
      if (Number(lines[i].packageId) === Number(packageId)) return lines[i];
    }
    return null;
  }

  function imageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.url || value.src || value.original || value.large || value.medium || value.small || '';
  }

  // IMAGE PRECEDENCE: live API (cart line, then package) > (null → caller uses template swatch).
  function getPackageImage(packageId) {
    var line = getCartLine(packageId);
    var lineImage = imageUrl(line && line.image) ||
      imageUrl(line && line.imageUrl) ||
      imageUrl(line && line.image_url) ||
      imageUrl(line && line.thumbnail) ||
      imageUrl(line && line.package && line.package.image) ||
      imageUrl(line && line.product && line.product.image);
    if (lineImage) {
      return { src: lineImage, alt: (line && (line.name || line.packageName || line.title)) || '' };
    }
    if (window.next && typeof window.next.getPackage === 'function') {
      var pkg = window.next.getPackage(packageId);
      var packageImage = imageUrl(pkg && pkg.image) ||
        imageUrl(pkg && pkg.imageUrl) ||
        imageUrl(pkg && pkg.image_url) ||
        imageUrl(pkg && pkg.thumbnail);
      if (packageImage) {
        return { src: packageImage, alt: (pkg && (pkg.name || pkg.title)) || '' };
      }
    }
    return null;
  }

  // ── Cart application (guarded — no-ops cleanly with no SDK) ─────────────────
  function applyCart() {
    if (!window.next) return Promise.resolve();
    var seq = ++cartApplySeq;
    var items = buildItems(activeQty);
    cartApplyPromise = cartApplyPromise.catch(function () {}).then(async function () {
      if (seq !== cartApplySeq) return;
      if (typeof window.next.swapCart === 'function') {
        await window.next.swapCart(items);
        updateAllSlotPrices();
        updateAllSlotImages();
        return;
      }
      if (typeof window.next.clearCart === 'function') {
        await window.next.clearCart();
      } else if (window.next.cart && typeof window.next.cart.clear === 'function') {
        await window.next.cart.clear();
      } else {
        return;
      }
      if (seq !== cartApplySeq) return;
      for (var i = 0; i < items.length; i++) {
        if (typeof window.next.addItem === 'function') {
          await window.next.addItem({ packageId: items[i].packageId, quantity: items[i].quantity });
        } else if (window.next.cart && typeof window.next.cart.addPackage === 'function') {
          await window.next.cart.addPackage(items[i].packageId, items[i].quantity);
        }
      }
      updateAllSlotPrices();
      updateAllSlotImages();
    }).catch(function (err) {
      console.warn('[variant-picker] Unable to apply cart selection', err);
    });
    return cartApplyPromise;
  }

  function updateBundleAttrs() {
    var selector = document.querySelector('[data-next-bundle-selector]');
    if (!selector) return;
    selector.querySelectorAll('[data-next-bundle-card]').forEach(function (card) {
      var bid = card.getAttribute('data-next-bundle-id') || '';
      var q = parseInt(bid.replace(/\D/g, ''), 10);
      if (!isNaN(q)) card.setAttribute('data-next-bundle-items', JSON.stringify(buildItems(q)));
    });
  }

  function syncBundleCards() {
    updateBundleAttrs();
    var selector = document.querySelector('[data-next-bundle-selector]');
    if (!selector) return;
    var active = selector.querySelector('[data-next-bundle-id="buy' + activeQty + '"]');
    if (active) {
      isSyncing = true;
      active.click();
      isSyncing = false;
    }
    applyCart();
  }

  // ── Dropdown helpers ────────────────────────────────────────────────────────
  function closeAllDropdowns(exceptMenu) {
    document.querySelectorAll('#vp-slot-stage [os-element="dropdown-menu"].show').forEach(function (m) {
      if (m !== exceptMenu) {
        m.classList.remove('show');
        var toggle = m.closest('os-dropdown') && m.closest('os-dropdown').querySelector('.os-card__variant-dropdown-toggle');
        if (toggle) { toggle.classList.remove('active'); toggle.setAttribute('aria-expanded', 'false'); }
      }
    });
  }

  function setDropdownValue(dropdownEl, value) {
    dropdownEl.setAttribute('value', value);
    var name = dropdownEl.querySelector('.os-card__variant-toggle-name');
    var item = dropdownEl.querySelector('os-dropdown-item[value="' + value + '"]');
    if (name && item) {
      name.textContent = item.querySelector('.os-card__variant-toggle-name').textContent;
      var toggleSwatch = dropdownEl.querySelector('.os-card__variant-dropdown-toggle .vp-color-swatch');
      var itemSwatch = item.querySelector('.vp-color-swatch');
      if (toggleSwatch && itemSwatch) { toggleSwatch.src = itemSwatch.src; toggleSwatch.alt = itemSwatch.alt; }
    }
    dropdownEl.querySelectorAll('os-dropdown-item').forEach(function (el) {
      el.classList.toggle('selected', el.getAttribute('value') === value);
    });
  }

  // ── Slot image (API > template swatch) ──────────────────────────────────────
  function updateSlotImage(slotEl) {
    if (!slotEl) return;
    var idx = parseInt(slotEl.getAttribute('data-vp-slot-idx'), 10);
    var slot = slots[idx] || DEFAULT;
    var apiImage = getPackageImage(pkgId(slot));        // precedence: live API first
    var templateSrc = IMAGES[slot.cs];                  // declared swatch fallback
    var slotImg = slotEl.querySelector('.vp-slot__img');
    if (!slotImg) return;
    if (apiImage && apiImage.src) {
      slotImg.src = apiImage.src;
      slotImg.alt = apiImage.alt || '';
    } else if (templateSrc) {
      slotImg.src = templateSrc;
    }
  }

  function updateAllSlotImages() {
    document.querySelectorAll('#vp-slot-stage .vp-slot').forEach(updateSlotImage);
  }

  // ── Slot price ───────────────────────────────────────────────────────────────
  function updateSlotPrice(slotEl) {
    if (!slotEl) return;
    var idx = parseInt(slotEl.getAttribute('data-vp-slot-idx'), 10);
    var slot = slots[idx] || DEFAULT;
    var basePrice = unitPrices[slot.cs] || '—';
    var line = getCartLine(pkgId(slot));
    var original = priceValue(line && line.originalUnitPrice, basePrice) || basePrice;
    var current = priceValue(line && line.unitPrice, basePrice) || estimatedDiscountPrice(basePrice);
    var originalEl = slotEl.querySelector('.vp-slot__price-original');
    var discountEl = slotEl.querySelector('.vp-slot__price-discount');
    if (originalEl) originalEl.textContent = original;
    if (discountEl) discountEl.textContent = current;
  }

  function updateAllSlotPrices() {
    document.querySelectorAll('#vp-slot-stage .vp-slot').forEach(updateSlotPrice);
  }

  // ── Slot rendering (offline-safe — runs without the SDK) ────────────────────
  function renderSlots() {
    var stage = document.getElementById('vp-slot-stage');
    var tpl = document.getElementById('vp-slot-tpl');
    var heading = document.getElementById('vp-slot-heading');
    if (!stage || !tpl) return;

    while (slots.length < activeQty) slots.push({ cs: DEFAULT.cs });

    if (heading && heading.dataset.vpBase === undefined) heading.dataset.vpBase = heading.textContent;
    if (heading) {
      heading.textContent = activeQty > 1
        ? heading.dataset.vpBase + ' — ' + activeQty + ' units'
        : heading.dataset.vpBase;
    }

    var raw = tpl.innerHTML;
    stage.innerHTML = '';

    for (var i = 0; i < activeQty; i++) {
      (function (idx) {
        var html = raw.replace(/\{UNIT\}/g, idx + 1);
        var temp = document.createElement('div');
        temp.innerHTML = html;
        var el = temp.querySelector('.vp-slot');
        el.setAttribute('data-vp-slot-idx', idx);

        updateSlotPrice(el);
        stage.appendChild(el);

        // Apply saved state after insertion so os-dropdown connectedCallback runs first.
        var csDd = el.querySelector('[data-vp-dropdown="cs"]');
        if (csDd) setDropdownValue(csDd, slots[idx].cs);
        updateSlotImage(el);

        // Direct item listeners — os-dropdown may stop propagation, so document
        // delegation can't be relied on for item selection.
        el.querySelectorAll('os-dropdown-item.os-card__variant-dropdown-item').forEach(function (item) {
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            if (item.hasAttribute('disabled')) return;
            var dropdown = item.closest('os-dropdown');
            if (!dropdown) return;
            var val = item.getAttribute('value');
            if (!slots[idx]) slots[idx] = { cs: DEFAULT.cs };
            setDropdownValue(dropdown, val);
            closeAllDropdowns();
            slots[idx].cs = val;
            updateBundleAttrs();
            updateSlotImage(el);
            updateSlotPrice(el);
            applyCart().then(updateAllSlotPrices);
          }, true);
        });
      })(i);
    }
  }

  // ── Event handling ────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (isSyncing) return;

    var qtyCard = e.target.closest('[data-next-bundle-card]');
    if (qtyCard && qtyCard.closest('[data-vp-selector]')) {
      var bid = qtyCard.getAttribute('data-next-bundle-id') || '';
      var q = parseInt(bid.replace(/\D/g, ''), 10);
      if (!isNaN(q) && q !== activeQty) {
        activeQty = q;
        renderSlots();
        syncBundleCards();
        updateAllSlotPrices();
      }
      return;
    }

    var toggle = e.target.closest('.os-card__variant-dropdown-toggle');
    if (toggle) {
      var dropdown = toggle.closest('os-dropdown');
      if (!dropdown || !dropdown.closest('#vp-slot-stage')) return;
      var menu = dropdown.querySelector('[os-element="dropdown-menu"]');
      var isOpen = menu && menu.classList.contains('show');
      closeAllDropdowns();
      if (!isOpen && menu) {
        menu.classList.add('show');
        toggle.classList.add('active');
        toggle.setAttribute('aria-expanded', 'true');
      }
      return;
    }

    if (!e.target.closest('os-dropdown')) closeAllDropdowns();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAllDropdowns();
  });

  // ── Boot ────────────────────────────────────────────────────────────────────
  function cachePrices() {
    document.querySelectorAll('[data-vp-price-for]').forEach(function (el) {
      var txt = el.textContent.trim();
      if (txt) unitPrices[el.getAttribute('data-vp-price-for')] = txt;
    });
  }

  // First paint — offline-safe, does not wait for the SDK. Idempotent (booted guard).
  function boot() {
    if (booted) return;
    booted = true;
    var selectedCard = document.querySelector('[data-vp-selector] [data-next-bundle-card][data-next-selected="true"]');
    if (selectedCard) {
      var bid = selectedCard.getAttribute('data-next-bundle-id') || '';
      var q = parseInt(bid.replace(/\D/g, ''), 10);
      if (!isNaN(q)) activeQty = q;
    }
    slots = [];
    cachePrices();
    renderSlots();
    updateBundleAttrs();
    if (window.next) applyCart();
  }

  // Layer live (or fixture) SDK data onto the already-painted slots. applyCart()
  // refreshes prices + images internally once the cart resolves, so there is no
  // trailing updateAllSlotPrices() to re-run the same loop.
  function layerInitData() {
    cachePrices();
    updateAllSlotPrices();
    updateAllSlotImages();
    if (window.next) applyCart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // next:initialized can fire before OR after boot(): boot() first guarantees the
  // slots exist (no-op once painted), then layerInitData() applies the live data
  // regardless of ordering. The listener is attached at IIFE-eval (before
  // DOMContentLoaded), so a fixture/SDK dispatch on DOMContentLoaded is not missed.
  window.addEventListener('next:initialized', function () {
    boot();
    layerInitData();
  });
})();
