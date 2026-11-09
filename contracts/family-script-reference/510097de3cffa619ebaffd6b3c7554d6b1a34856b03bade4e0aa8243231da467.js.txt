/**
 * Bundle-slot variants (data-next-bundle-slots-for): the SDK first renders native <select>s so it
 * can own cart state. This file immediately replaces the *visible* UI with the same pattern as
 * olympus-mv-single-step checkout — a <button class="os-card__variant-dropdown-toggle"> plus
 * os-dropdown-menu / os-dropdown-item rows (swatches in the menu for color). You cannot put
 * swatches inside a real <select>’s dropdown; the button/menu approach matches the legacy template.
 *
 * Extend colors: assign window.BUNDLE_SLOT_COLOR_STYLES before next:initialized, or edit the
 * default map below (same key style as olympus-mv-single-step TierController: slug from label).
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
 *   Wraps SDK-injected native selects with the os-dropdown button UI (color swatch support).
 *   MutationObserver re-runs on slot re-render (qty card change → new slots injected).
 * ─────────────────────────────────────────────────────────────────────────────
 */
var BUNDLE_SLOT_COLOR_STYLES = {
  white: '#FFFFFF',
  gray: '#808080',
  grey: '#808080',
  black: '#000000',
};

function bundleSlotColorKey(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function setupBundleSlotVariantDropdowns() {
  var stage = document.getElementById('bundle-slots-stage');
  if (!stage) return;

  /** SDK 0.4.x uses data-next-variant-code + .next-slot-variant-select; older builds used data-variant-code. */
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

  function getColorSwatch(value) {
    var s = String(value || '').trim();
    if (!s) return '';
    var merged = Object.assign({}, BUNDLE_SLOT_COLOR_STYLES, window.BUNDLE_SLOT_COLOR_STYLES || {});
    var fromMap = merged[bundleSlotColorKey(s)];
    if (fromMap) return fromMap;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
    if (/^(rgb|hsla?)\(/i.test(s)) return s;
    return s;
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
      var col = getColorSwatch(text || selectEl.value);
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
        var labelText = (labelEl.textContent || '').trim() || 'Select ' + code + ':';
        var selectedOption = selectEl.options[selectEl.selectedIndex];
        var selectedText = selectedOption ? selectedOption.textContent : selectEl.value;

        var label = document.createElement('div');
        label.className = 'os-card__variant-label';
        label.textContent = labelText;

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
          var swatchColor = getColorSwatch(selectedText || selectEl.value);
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
            var optionColor = getColorSwatch(option.textContent || option.value);
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
        group.className = 'os-card__variant-group cc-full';
        group.append(label, dropdown);

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
    debounce = setTimeout(function () {
      renderVariantDropdowns();
    }, 0);
  });
  mo.observe(stage, { childList: true, subtree: true });

  function scheduleRender() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        renderVariantDropdowns();
      });
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


window.addEventListener('next:initialized', function () {
  setupBundleSlotVariantDropdowns(); // comment out to use barebones native <select> UI instead

  // Image-only exit intent — replace with your own image URL
  // Coupon must exist on the campaign (Campaigns app → discount code offer, e.g. EXIT10)
  initExitIntentImage('https://placehold.co/600x400', async () => {
    await next.applyCoupon('EXIT10');
  });
});

// SDK 0.4.27 — bump line-item personalization (PackageToggle property).
// The whole bump card is the PackageToggle click target, so a click/keypress inside the
// personalization field would otherwise toggle the bump on/off. The field is static HTML
// (present at DOM ready), so stop those events from bubbling up to the card.
function guardBumpPersonalization() {
  document.querySelectorAll('[data-next-toggle-card] .bump__personalization').forEach(function (el) {
    ['click', 'mousedown', 'keydown'].forEach(function (evt) {
      el.addEventListener(evt, function (e) { e.stopPropagation(); });
    });
  });
}
if (document.readyState !== 'loading') guardBumpPersonalization();
else document.addEventListener('DOMContentLoaded', guardBumpPersonalization);
