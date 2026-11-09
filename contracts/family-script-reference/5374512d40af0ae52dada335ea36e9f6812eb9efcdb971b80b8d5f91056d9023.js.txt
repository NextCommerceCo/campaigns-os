/* ──────────────────────────────────────────────────────────────────────────
 * variant-picker-fixture.js — OFFLINE SLOT-RENDER FIXTURE (visual QA only)
 *
 * B1 remediation (Shield retro): the hand-built picker only rendered with the live
 * SDK + API, so in a no-network sandbox it was blank and all visual QA was blind.
 * This fixture stubs a minimal `window.next` with mock package data so the picker
 * renders slots — with images and prices — entirely offline, and dispatches
 * `next:initialized` so variant-picker.js layers the mock data on exactly as it
 * would the real API.
 *
 * SAFE BY DEFAULT — installs ONLY when BOTH are true:
 *   • explicitly enabled: window.NEXT_VP_FIXTURE === true  OR  URL has ?vp-fixture=1
 *   • the real SDK is absent: window.next is not yet defined
 * So it never shadows the live SDK in production. In a real no-network env the CDN
 * loader can't run → window.next stays undefined → the fixture provides the data.
 * When the network IS up, the real loader sets window.next and the fixture stands
 * down (precedence: live API > fixture > template swatch).
 *
 * The mock package data mirrors #vp-config: one package per declared variant, each
 * with the declared swatch image (so the API-image path is exercised) plus demo prices.
 * NOT for production — load it only on the reference/QA page.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  var enabled = (typeof window.NEXT_VP_FIXTURE !== 'undefined' && window.NEXT_VP_FIXTURE) ||
    /[?&]vp-fixture=1\b/.test(window.location.search);
  if (!enabled) return;

  function install() {
    if (window.next) return; // real SDK present — stand down

    var cfgEl = document.getElementById('vp-config');
    if (!cfgEl) return;
    var CFG;
    try { CFG = JSON.parse(cfgEl.textContent); } catch (e) { return; }

    var packages = CFG.packages || {};   // { variantValue: packageId }
    var images = CFG.images || {};       // { variantValue: src }

    // Build mock package records keyed by packageId.
    var DEMO_PRICE = 29.99;
    var DEMO_RETAIL = 49.99;
    var pkgById = {};
    Object.keys(packages).forEach(function (value) {
      var id = packages[value];
      pkgById[id] = {
        ref_id: id,
        name: 'Demo ' + value,
        price: DEMO_PRICE.toFixed(2),
        price_retail: DEMO_RETAIL.toFixed(2),
        image: images[value] || ''
      };
    });

    // Minimal cart so getCartLine() resolves an image + unit price per package.
    var cartLines = [];
    function rebuildCart(items) {
      cartLines = (items || []).map(function (it) {
        var p = pkgById[it.packageId] || {};
        return {
          packageId: it.packageId,
          quantity: it.quantity,
          name: p.name,
          image: p.image,
          unitPrice: '$' + DEMO_PRICE.toFixed(2),
          originalUnitPrice: '$' + DEMO_RETAIL.toFixed(2)
        };
      });
    }

    window.next = {
      __fixture: true,
      getPackage: function (id) { return pkgById[id] || null; },
      getCartData: function () { return { cartLines: cartLines, items: cartLines }; },
      swapCart: function (items) { rebuildCart(items); return Promise.resolve(); },
      clearCart: function () { cartLines = []; return Promise.resolve(); },
      // Merge by packageId so the fixture cart mirrors the real SDK shape (one
      // line per package). variant-picker.js uses swapCart by default; addItem is
      // the no-swapCart fallback path.
      addItem: function (item) {
        var merged = cartLines.map(function (l) { return { packageId: l.packageId, quantity: l.quantity }; });
        var existing = merged.filter(function (l) { return l.packageId === item.packageId; })[0];
        if (existing) { existing.quantity += item.quantity; }
        else { merged.push({ packageId: item.packageId, quantity: item.quantity }); }
        rebuildCart(merged);
        return Promise.resolve();
      }
    };

    // Seed package.<id>.price reference spans the SDK would normally fill.
    document.querySelectorAll('[data-vp-price-for]').forEach(function (el) {
      el.textContent = '$' + DEMO_PRICE.toFixed(2);
    });

    // Let variant-picker.js sync exactly as it would against the real API.
    window.dispatchEvent(new Event('next:initialized'));
    console.info('[variant-picker] offline fixture active — mock SDK package data installed.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
