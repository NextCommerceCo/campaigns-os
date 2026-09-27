// JavaScript extracted from templates\checkout\shop-three\billing.html

// Step URLs and redirect are set by the page (campaign context). If not set, guard uses fallbacks.
(function() {
  'use strict';
  // Get configuration from window (injected by billing.html with campaign_link URLs)
  var config = window.CHECKOUT_CONFIG || {};
  var currentStep = config.currentStep !== undefined ? config.currentStep : 3;
  var redirectUrl = config.redirectUrl || '/';
  var stepUrls = config.stepUrls || {};
  // If no step configured, don't guard this page
  if (!currentStep || currentStep === 1) {
    console.log('[CheckoutGuard] No guard needed for step 1 or unconfigured page');
    return;
  }
  try {
    // Try to get checkout store from sessionStorage. SDK 0.4.34+ scopes storage keys
    // per campaign (e.g. "next-checkout-store__of7f2o"), so fall back to a scan when
    // the unscoped legacy key is absent. Several campaigns on one origin each write
    // their own scoped store, so the scan must pick THIS campaign's scope: the SDK
    // records next_funnel_name__<scope> alongside each store, and the page carries
    // the same value in <meta name="next-funnel">.
    var storeData = sessionStorage.getItem('next-checkout-store');
    if (!storeData) {
      var storePrefix = 'next-checkout-store__';
      var funnelMeta = document.querySelector('meta[name="next-funnel"]');
      var funnelName = funnelMeta ? funnelMeta.getAttribute('content') : '';
      var scopes = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var key = sessionStorage.key(i);
        if (key && key.indexOf(storePrefix) === 0) {
          scopes.push(key.slice(storePrefix.length));
        }
      }
      for (var j = 0; j < scopes.length && !storeData; j++) {
        var scopeFunnel = sessionStorage.getItem('next_funnel_name__' + scopes[j])
          || localStorage.getItem('next_funnel_name__' + scopes[j]);
        if (funnelName && scopeFunnel === funnelName) {
          storeData = sessionStorage.getItem(storePrefix + scopes[j]);
        }
      }
      // A page that declares its funnel and finds no match must treat the scan
      // as empty (safe redirect to step 1) — never trust another campaign's
      // store. Only a page with no funnel signal may take the one unambiguous
      // candidate.
      if (!storeData && !funnelName && scopes.length === 1) {
        storeData = sessionStorage.getItem(storePrefix + scopes[0]);
      }
    }
    // If no store exists, redirect to first step
    if (!storeData) {
      console.warn('[CheckoutGuard] No checkout store found, redirecting to:', redirectUrl);
      window.location.replace(redirectUrl);
      return;
    }
    var store = JSON.parse(storeData);
    var completedStep = store.state && store.state.step ? store.state.step : 0;
    var formData = store.state && store.state.formData ? store.state.formData : {};
    console.log('[CheckoutGuard] Current page step:', currentStep, '| User completed step:', completedStep);
    console.log('[CheckoutGuard] Form data:', formData);
    // Hide phone review row if no phone was captured
    try {
      if (!formData.phone || (typeof formData.phone === 'string' && formData.phone.trim() === '')) {
        var phoneReviewEl = document.querySelector('[data-next-checkout-review="phone"]');
        if (phoneReviewEl) {
          var phoneRow = phoneReviewEl.closest('.checkout__form-row');
          if (phoneRow) {
            phoneRow.classList.add('hide');
          }
        }
      }
    } catch (e) {
      console.warn('[CheckoutGuard] Unable to hide phone review row:', e);
    }

    // Validate that previous steps have required data
    var hasRequiredData = true;
    var missingFields = [];
    var redirectToStep = 1; // Default to step 1
    // If trying to access step 2 or higher, validate step 1 data
    if (currentStep >= 2) {
      var step1Required = ['email', 'fname', 'lname', 'address1', 'city', 'country', 'postal'];
      step1Required.forEach(function(field) {
        if (!formData[field] || (typeof formData[field] === 'string' && formData[field].trim() === '')) {
          hasRequiredData = false;
          missingFields.push(field);
          redirectToStep = 1; // Missing step 1 data
        }
      });
    }
    // If trying to access step 3 or higher, validate step 2 data (shipping method)
    // Only check this if step 1 data is complete
    if (currentStep >= 3 && hasRequiredData) {
      var shippingMethod = store.state && store.state.shippingMethod;
      if (!shippingMethod) {
        hasRequiredData = false;
        missingFields.push('shippingMethod');
        redirectToStep = 2; // Missing step 2 data, redirect to step 2
      }
    }
    // If required data is missing, redirect to the appropriate step
    if (!hasRequiredData) {
      var targetUrl = stepUrls[redirectToStep] || redirectUrl;
      console.warn('[CheckoutGuard] Required data missing for previous steps:', missingFields);
      console.warn('[CheckoutGuard] Redirecting to step', redirectToStep, ':', targetUrl);
      window.location.replace(targetUrl);
      return;
    }
    // User hasn't completed previous step by step number
    if (completedStep < currentStep) {
      // Try to redirect to the last completed step + 1
      var targetStep = completedStep;
      var targetUrl = stepUrls[targetStep] || redirectUrl;
      console.warn('[CheckoutGuard] User at step', completedStep, 'but trying to access step', currentStep);
      console.warn('[CheckoutGuard] Redirecting to:', targetUrl);
      window.location.replace(targetUrl);
      return;
    }
    // If user has completed this step or beyond, allow them to stay
    console.log('[CheckoutGuard] Access granted - user has completed step', completedStep, 'with valid data');
  } catch (error) {
    // If any error occurs reading the store, redirect to safety
    console.error('[CheckoutGuard] Error checking store:', error);
    console.warn('[CheckoutGuard] Redirecting to:', redirectUrl);
    window.location.replace(redirectUrl);
  }
})();