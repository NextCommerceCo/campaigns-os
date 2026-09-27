/**
 * upsells-mv.js — MV upsell: bundle slot variant dropdowns + qty toggle.
 *
 * Replaces the legacy UpsellController / per-package-id mapping approach (SDK 0.3.x)
 * with data-next-bundle-selector + data-next-bundle-slots-for (SDK 0.4.10).
 *
 * VARIANT SELECTOR APPROACHES
 * ─────────────────────────────────────────────────────────────────────────────
 * Barebones (no JS needed):
 *   The SDK injects native <select> elements into [data-next-variant-selectors]
 *   inside each slot — no JavaScript required. CSS in next-core.css scoped to
 *   #bundle-slots-stage styles .next-slot-variant-field / .next-slot-variant-select.
 *   To use: comment out setupBundleSlotVariantDropdowns() call below.
 *
 * Custom os-dropdown UI (active — setupBundleSlotVariantDropdowns):
 *   Wraps SDK-injected native selects with the os-dropdown button UI (color swatch
 *   support). MutationObserver re-runs on slot re-render (qty card change → new
 *   slots injected). Extend color swatch map by setting:
 *   window.BUNDLE_SLOT_COLOR_STYLES = { 'navy': '#001f5b', … } before next:initialized.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * initBundleQtyToggle():
 *   Wires data-bundle-qty-btn buttons to click matching hidden data-next-bundle-card.
 *   On card click, SDK re-fetches voucher-adjusted price + re-renders remote
 *   bundle.upsell-bundle.* display values and slot count.
 */

var BUNDLE_SLOT_COLOR_STYLES = {
  white: '#FFFFFF',
  gray: '#808080',
  grey: '#808080',
  black: '#000000',
};

function bundleSlotColorKey(token) {
  return String(token || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function getUpsellColorSwatch(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  var merged = Object.assign({}, BUNDLE_SLOT_COLOR_STYLES, window.BUNDLE_SLOT_COLOR_STYLES || {});
  var fromMap = merged[bundleSlotColorKey(s)];
  if (fromMap) return fromMap;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
  if (/^(rgb|hsla?)\(/i.test(s)) return s;
  return s;
}

function setupBundleSlotVariantDropdowns() {
  var stage = document.getElementById('bundle-slots-stage');
  if (!stage) return;

  function variantSelectInField(field) {
    return field.querySelector(
      'select[data-next-variant-code], select[data-variant-code], select.next-slot-variant-select'
    );
  }

  function variantCodeFromSelect(selectEl) {
    return (
      selectEl.getAttribute('data-next-variant-code') ||
      selectEl.getAttribute('data-variant-code') ||
      ''
    );
  }

  function isVariantSlotSelect(el) {
    if (!el || el.nodeName !== 'SELECT') return false;
    return (
      el.hasAttribute('data-next-variant-code') ||
      el.hasAttribute('data-variant-code') ||
      el.classList.contains('next-slot-variant-select')
    );
  }

  function refreshVariantFieldUI(field, selectEl) {
    var dropdown = field.querySelector('os-dropdown.os-variant-dropdown');
    if (!dropdown || !selectEl) return;
    var code = variantCodeFromSelect(selectEl).toLowerCase();
    var opt = selectEl.selectedOptions[0];
    var text = opt ? String(opt.textContent || '').trim() : '';
    var toggle = dropdown.querySelector('.os-card__variant-dropdown-toggle');
    var toggleName = toggle && toggle.querySelector('.os-card__variant-toggle-name');
    if (toggleName) toggleName.textContent = text || selectEl.value;
    var swatch = toggle && toggle.querySelector('.os-card__option-swatch');
    if (swatch && code === 'color') {
      var col = getUpsellColorSwatch(text || selectEl.value);
      swatch.style.backgroundColor = col || '';
    }
    dropdown.setAttribute('value', selectEl.value);
    var menu = dropdown.querySelector('[os-element="dropdown-menu"]');
    if (menu) {
      menu.querySelectorAll('os-dropdown-item.os-card__variant-dropdown-item').forEach(function (item) {
        var v = item.getAttribute('value');
        item.classList.toggle('selected', v === selectEl.value);
      });
    }
  }

  function renderVariantDropdowns(scopeRoot) {
    var root = scopeRoot || stage;
    root.querySelectorAll('[data-next-variant-selectors]').forEach(function (variantRoot) {
      variantRoot.querySelectorAll('.next-slot-variant-field').forEach(function (field) {
        if (field.querySelector('os-dropdown.os-variant-dropdown')) return;

        var labelEl = field.querySelector('label.next-slot-variant-label, .next-slot-variant-label');
        var selectEl = variantSelectInField(field);
        if (!labelEl || !selectEl) return;

        var code = variantCodeFromSelect(selectEl);
        var selectedOption = selectEl.options[selectEl.selectedIndex];
        var selectedText = selectedOption ? selectedOption.textContent : selectEl.value;

        var dropdown = document.createElement('os-dropdown');
        dropdown.className = 'os-variant-dropdown';
        dropdown.setAttribute('next-variant-option', code);
        dropdown.setAttribute('value', selectEl.value);

        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'os-card__variant-dropdown-toggle';
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-haspopup', 'listbox');

        var toggleOption = document.createElement('div');
        toggleOption.className = 'os-card__toggle-option';
        var toggleInfo = document.createElement('div');
        toggleInfo.className = 'os-card__variant-toggle-info';

        if (code.toLowerCase() === 'color') {
          var swatch = document.createElement('div');
          swatch.className = 'os-card__option-swatch';
          swatch.setAttribute('data-swatch', 'color');
          var swatchColor = getUpsellColorSwatch(selectedText || selectEl.value);
          if (swatchColor) swatch.style.backgroundColor = swatchColor;
          toggleInfo.appendChild(swatch);
        }

        var toggleName = document.createElement('div');
        toggleName.className = 'os-card__variant-toggle-name';
        toggleName.textContent = selectedText || selectEl.value;
        toggleInfo.appendChild(toggleName);
        toggleOption.appendChild(toggleInfo);

        var icon = document.createElement('div');
        icon.className = 'os-card__variant-dropdown-icon';
        icon.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">' +
          '<path d="M11.9999 13.1714L16.9497 8.22168L18.3639 9.63589L11.9999 15.9999L5.63599 9.63589L7.0502 8.22168L11.9999 13.1714Z"></path>' +
          '</svg>';

        button.append(toggleOption, icon);

        var menu = document.createElement('os-dropdown-menu');
        menu.setAttribute('os-element', 'dropdown-menu');
        menu.className = 'os-card__variant-dropdown-menu-v2';

        Array.from(selectEl.options).forEach(function (option) {
          var item = document.createElement('os-dropdown-item');
          item.setAttribute('value', option.value);
          item.className =
            'os-card__variant-dropdown-item' + (option.selected ? ' selected' : '');
          if (option.disabled) item.setAttribute('disabled', '');

          var itemToggle = document.createElement('div');
          itemToggle.className = 'os-card__toggle-option';
          var itemInfo = document.createElement('div');
          itemInfo.className = 'os-card__variant-toggle-info';

          if (code.toLowerCase() === 'color') {
            var itemSwatch = document.createElement('div');
            itemSwatch.className = 'os-card__option-swatch';
            var optionColor = getUpsellColorSwatch(option.textContent || option.value);
            if (optionColor) itemSwatch.style.backgroundColor = optionColor;
            itemInfo.appendChild(itemSwatch);
          }

          var itemName = document.createElement('div');
          itemName.className = 'os-card__variant-toggle-name';
          itemName.textContent = option.textContent || option.value;
          itemInfo.appendChild(itemName);
          itemToggle.appendChild(itemInfo);
          item.appendChild(itemToggle);
          menu.appendChild(item);
        });

        dropdown.append(button, menu);

        var group = document.createElement('div');
        group.className = 'os-card__variant-dropdown-wrapper';
        group.setAttribute('os-component', 'variant-dropdown');
        group.append(dropdown);

        field.replaceChildren();
        field.append(group, selectEl);
        selectEl.style.display = 'none';
      });
    });
  }

  function closeAllMenus() {
    stage.querySelectorAll('[os-element="dropdown-menu"].show').forEach(function (openMenu) {
      openMenu.classList.remove('show');
    });
    stage.querySelectorAll('.os-card__variant-dropdown-toggle').forEach(function (t) {
      t.classList.remove('active');
      t.setAttribute('aria-expanded', 'false');
    });
    stage.querySelectorAll('os-dropdown.os-variant-dropdown[open]').forEach(function (dd) {
      dd.removeAttribute('open');
    });
  }

  stage.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !isVariantSlotSelect(t)) return;
    var field = t.closest('.next-slot-variant-field');
    if (field && field.querySelector('os-dropdown.os-variant-dropdown')) refreshVariantFieldUI(field, t);
  });

  stage.addEventListener('click', function (e) {
    var toggle = e.target.closest('.os-card__variant-dropdown-toggle');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      var dropdown = toggle.closest('os-dropdown');
      if (!dropdown) return;
      var menu = dropdown.querySelector('[os-element="dropdown-menu"]');
      if (!menu) return;
      var isOpen = menu.classList.contains('show');
      closeAllMenus();
      if (!isOpen) {
        menu.classList.add('show');
        toggle.classList.add('active');
        toggle.setAttribute('aria-expanded', 'true');
        dropdown.setAttribute('open', '');
      }
      return;
    }

    var menuItem = e.target.closest('os-dropdown-item.os-card__variant-dropdown-item');
    if (menuItem && !menuItem.hasAttribute('disabled')) {
      e.preventDefault();
      e.stopPropagation();
      var dropdown = menuItem.closest('os-dropdown');
      if (!dropdown) return;
      var field = dropdown.closest('.next-slot-variant-field');
      var extSelect = field && variantSelectInField(field);
      if (!extSelect) return;

      extSelect.value = menuItem.getAttribute('value') || '';
      extSelect.dispatchEvent(new Event('change', { bubbles: true }));

      var menu = dropdown.querySelector('[os-element="dropdown-menu"]');
      var toggleEl = dropdown.querySelector('.os-card__variant-dropdown-toggle');
      if (menu) menu.classList.remove('show');
      if (toggleEl) {
        toggleEl.classList.remove('active');
        toggleEl.setAttribute('aria-expanded', 'false');
      }
      dropdown.removeAttribute('open');
    }
  });

  document.addEventListener('click', function (e) {
    if (!stage.contains(e.target)) closeAllMenus();
  });

  var debounce;
  var mo = new MutationObserver(function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () { renderVariantDropdowns(); }, 0);
  });
  mo.observe(stage, { childList: true, subtree: true });

  function scheduleRender() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { renderVariantDropdowns(); });
    });
  }

  scheduleRender();

  if (window.next && typeof window.next.on === 'function') {
    window.next.on('bundle:selection-changed', function () {
      scheduleRender();
      setTimeout(scheduleRender, 250);
      setTimeout(scheduleRender, 500);
    });
  }
}

/**
 * Bundle upsell qty toggle — wires [data-bundle-qty-btn] buttons to click the
 * matching hidden [data-next-bundle-card] inside a [data-next-bundle-selector].
 *
 * Markup contract:
 *   Qty container: data-bundle-qty-for="<selectorId>" (typically `.next-bundle-qty__row`)
 *   Qty buttons:   data-bundle-qty-btn="<N>" (`.next-bundle-qty__btn` — next-core.css)
 *   Bundle cards:  data-next-bundle-id="<selectorId>-<N>x"
 *
 * On card click the SDK re-fetches voucher-calculated price, updates remote
 * bundle.<selectorId>.* display values, and re-renders configurable slots.
 */
function initBundleQtyToggle() {
  document.querySelectorAll('[data-bundle-qty-for]').forEach(function (container) {
    var selectorId = container.getAttribute('data-bundle-qty-for');
    var buttons = container.querySelectorAll('[data-bundle-qty-btn]');
    var selector = document.querySelector('[data-next-selector-id="' + selectorId + '"]');
    if (!selector) return;
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var qty = btn.getAttribute('data-bundle-qty-btn');
        var card = selector.querySelector('[data-next-bundle-id="' + selectorId + '-' + qty + 'x"]');
        if (!card) return;
        card.click();
        buttons.forEach(function (b) { b.classList.remove('next-selected'); });
        btn.classList.add('next-selected');
      });
    });
  });
}

window.addEventListener('next:initialized', function () {
  setupBundleSlotVariantDropdowns(); // comment out to use barebones native <select> UI instead
  initBundleQtyToggle();
});
