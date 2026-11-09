/**
 * Dynamic shipping options from campaign API
 *
 * Renders the shipping method list from campaign data instead of hardcoding
 * options in the template. Place an empty container in your checkout and run
 * this after Next is ready.
 *
 * Template:
 *   <div data-next-component="shipping-form" class="form-section">
 *     <h1 class="form-section__title">Shipping Method</h1>
 *     <div id="next-shipping-options-container" class="shipping-selector" role="radiogroup" aria-label="Shipping method">
 *       <!-- Options injected here by script -->
 *     </div>
 *   </div>
 * For multi-step checkout, use class="next-shipping-options-container" so every step gets the list.
 *
 * Usage: Include this script after the Campaign Cart SDK. It runs on next:initialized
 *        (after campaign data is loaded). If the script loads late, call
 *        window.nextShippingOptions.render(window.next) manually.
 *
 * Detecting when the shipping method changes:
 *   window.next.on('shipping:method-changed', function (data) {
 *     console.log('Shipping method changed:', data.methodId, data.method);
 *     // data.methodId = ref_id (e.g. 1 or 2), data.method = { ref_id, code, price }
 *   });
 * Or read the current selection: window.next.getSelectedShippingMethod()
 */

(function () {
  var CONTAINER_ID = 'next-shipping-options-container';
  var CONTAINER_CLASS = 'next-shipping-options-container';

  function formatPriceFallback(amount) {
    if (amount === 0) return 'FREE';
    return '$' + Number(amount).toFixed(2);
  }

  function getContainers() {
    // Fill every element with this id (handles duplicate ids e.g. multi-step forms)
    var byId = document.querySelectorAll('[id="' + CONTAINER_ID + '"]');
    if (byId.length) return Array.prototype.slice.call(byId);
    return Array.prototype.slice.call(document.querySelectorAll('.' + CONTAINER_CLASS));
  }

  /**
   * Build one shipping option element (name and price from API; structure works with display enhancer).
   * @param {Object} method - { ref_id, code, price }
   * @param {string} formattedPrice - Already formatted (e.g. from sdk.formatPrice)
   * @param {boolean} isFirst - If true, this option gets the "checked" attribute
   * @param {string} idSuffix - Optional suffix so ids are unique when multiple containers exist (e.g. "_0")
   * @returns {HTMLElement}
   */
  function buildShippingOption(method, formattedPrice, isFirst, idSuffix) {
    var refId = method.ref_id;
    var id = 'shipping_method_' + refId + (idSuffix || '');

    var wrap = document.createElement('div');
    wrap.className = 'shipping-method';
    wrap.setAttribute('data-next-shipping-id', String(refId));

    var label = document.createElement('label');
    label.setAttribute('for', id);
    label.className = 'radio-select-shipping';

    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'shipping_method';
    input.id = id;
    input.value = String(refId);
    input.className = 'shipping-method__input';
    if (isFirst) input.checked = true;

    var left = document.createElement('div');
    left.className = 'shipping-method-rleft';
    var nameDiv = document.createElement('div');
    nameDiv.setAttribute('data-next-display', 'shipping.name');
    nameDiv.textContent = method.code || 'Shipping';
    left.appendChild(nameDiv);

    var priceWrap = document.createElement('div');
    priceWrap.className = 'shipping_price';
    var priceDiv = document.createElement('div');
    priceDiv.setAttribute('data-next-display', 'shipping.cost');
    priceDiv.textContent = formattedPrice;
    priceWrap.appendChild(priceDiv);

    label.appendChild(input);
    label.appendChild(left);
    label.appendChild(priceWrap);
    wrap.appendChild(label);
    return wrap;
  }

  /**
   * Render shipping options into the container(s) from the Next SDK.
   * Call after the SDK is ready (e.g. on next:initialized, or use window.next).
   *
   * @param {Object} sdk - Next SDK instance (e.g. window.next after next:initialized)
   */
  function renderShippingOptions(sdk) {
    var containers = getContainers();
    if (!containers.length) {
      console.warn('[Next] Dynamic shipping: no container #' + CONTAINER_ID + ' or .' + CONTAINER_CLASS + ' found');
      return;
    }

    // Snapshot so we are not affected if the store is updated during render
    var raw = sdk.getShippingMethods();
    var methods = raw && raw.length ? raw.slice(0) : [];
    if (methods.length === 0) {
      containers.forEach(function (container) {
        container.innerHTML = '<p class="shipping-empty">No shipping methods available.</p>';
      });
      return;
    }

    containers.forEach(function (container, containerIndex) {
      var idSuffix = containers.length > 1 ? '_' + containerIndex : '';
      container.innerHTML = '';
      methods.forEach(function (method, index) {
        var amount = parseFloat(method.price || '0', 10);
        var formatted = amount === 0 ? 'FREE' : formatPriceFallback(amount);
        var el = buildShippingOption(method, formatted, index === 0, idSuffix);
        container.appendChild(el);
      });
      container.dispatchEvent(new CustomEvent('next:shipping-options-rendered', {
        bubbles: true,
        detail: { count: methods.length }
      }));
    });

    // Sync selection to SDK (dynamic radios may not have the checkout enhancer's listener)
    bindShippingChangeToSdk(sdk);

    // Set the default (first) shipping method in the SDK so the step can advance
    // without the user having to manually change the selection.
    if (typeof sdk.setShippingMethod === 'function' && methods[0]) {
      sdk.setShippingMethod(methods[0].ref_id);
    }
  }

  function bindShippingChangeToSdk(sdk) {
    if (!sdk || typeof sdk.setShippingMethod !== 'function') return;
    var containers = getContainers();
    containers.forEach(function (container) {
      container.removeEventListener('change', container._nextShippingChange);
      container._nextShippingChange = function (e) {
        var input = e.target;
        if (input.name === 'shipping_method' && input.type === 'radio') {
          var methodId = parseInt(input.value, 10);
          if (!isNaN(methodId)) sdk.setShippingMethod(methodId);
        }
      };
      container.addEventListener('change', container._nextShippingChange);
    });
  }

  // Run after campaign data is loaded (next:ready fires when module loads, before campaign;
  // next:initialized fires after loadCampaignData and DOM enhance)
  function getSdk() {
    return window.next || (window.NextCommerce && window.NextCommerce.NextCommerce && window.NextCommerce.NextCommerce.getInstance && window.NextCommerce.NextCommerce.getInstance());
  }

  function tryRender() {
    var sdk = getSdk();
    if (sdk && typeof sdk.getShippingMethods === 'function') {
      renderShippingOptions(sdk);
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('next:initialized', tryRender);
    // If script loads after SDK has already initialized, next:initialized won't fire again
    if (document.readyState === 'complete') {
      setTimeout(tryRender, 0);
    }
  }

  // Expose for manual use (e.g. after your own Next.init())
  window.nextShippingOptions = {
    render: renderShippingOptions
  };
})();
