// A stand-in for the campaign-cart SDK, just large enough to exercise the
// typed-card runner's cart entry step and empty-cart guard (campaigns-os#206).
// It is NOT the SDK: it reproduces four behaviours the runner depends on and
// nothing else.
//
//   1. `window.next.getCartCount()` and `window.nextDebug.stores.cart` — the
//      two cart reads the runner trusts.
//   2. `[data-next-action="add-to-cart"]` adds `data-next-package-id` to the
//      cart and navigates to `data-next-url`. A control with no package id
//      navigates without adding anything (the empty-cart fixture).
//   3. `?forcePackageId=<id>:<qty>` on arrival pre-loads the cart, and a
//      pre-selected `[data-next-selector-card]` on checkout is the default
//      selection.
//   4. The checkout submit posts `/api/v1/orders/` and lands on the receipt —
//      and, like the SDK, does nothing at all when the cart is empty. The
//      receipt reads the order back by ref_id.
//   5. Like the SDK, the submit also does nothing when the card number frame
//      holds fewer than 13 digits: a number that lost digits is refused
//      before anything is tokenized, so no order posts.
//   6. Multi-step checkout (campaigns-os#641): a swap-mode
//      `[data-next-bundle-card]` click replaces the cart with its package, a
//      `[data-next-action="checkout"]` control navigates to its
//      `data-next-url`, a `form[data-next-checkout-step]` submit navigates to
//      that step URL only when the fields named by
//      `data-fixture-step-requires` are filled (the SDK's step validation),
//      and `body[data-fixture-main-package]` fills an empty cart the way a
//      step page's main package does.
//
// The cart persists in localStorage so it survives the SDK-driven navigation.
(function () {
  var KEY = "qa-cart-entry:cart";
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function write(items) { localStorage.setItem(KEY, JSON.stringify(items)); }
  function add(packageId, quantity) {
    var items = read().filter(function (item) { return String(item.packageId) !== String(packageId); });
    items.push({ packageId: String(packageId), quantity: Number(quantity) || 1 });
    write(items);
  }
  if (document.body.hasAttribute("data-fixture-reset-cart")) write([]);

  var forced = new URLSearchParams(location.search).get("forcePackageId");
  if (forced) {
    var parts = forced.split(":");
    add(parts[0], parts[1] || 1);
  }

  // A checkout that selects for itself: the pre-selected card is the cart, the
  // way the SDK's selector applies its default selection on load.
  var preselected = document.querySelector("[data-next-bundle-selector] [data-next-selector-card].next-selected[data-next-package-id]");
  if (preselected && !read().length) add(preselected.getAttribute("data-next-package-id"), 1);

  var mainPackage = document.body.getAttribute("data-fixture-main-package");
  if (mainPackage && !read().length) add(mainPackage, 1);

  // A swap-mode bundle selector: the selected card IS the cart.
  var bundleDefault = document.querySelector('[data-next-bundle-selector] [data-next-bundle-card].next-selected[data-next-package-id]');
  if (bundleDefault && !read().length) add(bundleDefault.getAttribute("data-next-package-id"), 1);
  document.addEventListener("click", function (event) {
    var card = event.target.closest("[data-next-bundle-card][data-next-package-id]");
    if (!card) return;
    Array.prototype.forEach.call(card.parentNode.querySelectorAll("[data-next-bundle-card]"), function (other) {
      other.classList.toggle("next-selected", other === card);
    });
    write([{ packageId: card.getAttribute("data-next-package-id"), quantity: 1 }]);
  });
  document.addEventListener("click", function (event) {
    var control = event.target.closest('[data-next-action="checkout"]');
    if (!control) return;
    event.preventDefault();
    var next = control.getAttribute("data-next-url");
    if (next) location.href = next;
  });

  // Step forms: the SDK validates the step's fields, keeps the answers, and
  // navigates to the step URL. The fields the fixture marks required must be
  // filled or nothing happens, which is what a missing field looks like.
  var STEP_KEY = "qa-cart-entry:answers";
  var answers = {};
  try { answers = JSON.parse(sessionStorage.getItem(STEP_KEY) || "{}"); } catch (e) { answers = {}; }
  Array.prototype.forEach.call(document.querySelectorAll("[data-next-checkout-review]"), function (node) {
    node.textContent = answers[node.getAttribute("data-next-checkout-review")] || "";
  });
  Array.prototype.forEach.call(document.querySelectorAll("form[data-next-checkout-step]"), function (stepForm) {
    stepForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var required = (stepForm.getAttribute("data-fixture-step-requires") || "").split(",").filter(Boolean);
      var values = {};
      Array.prototype.forEach.call(stepForm.querySelectorAll("[data-next-checkout-field]"), function (field) {
        values[field.getAttribute("data-next-checkout-field")] = field.value;
      });
      for (var i = 0; i < required.length; i += 1) if (!values[required[i]]) return;
      Object.keys(values).forEach(function (key) { answers[key] = values[key]; });
      sessionStorage.setItem(STEP_KEY, JSON.stringify(answers));
      location.href = stepForm.getAttribute("data-next-checkout-step");
    });
  });

  // `getCartCount()` is the store's totalQuantity. `getCartData().cartLines`
  // is deliberately not provided: on the real SDK it is always [] and the
  // runner must never read it (campaign-cart#36).
  window.next = {
    getCartCount: function () {
      return read().reduce(function (sum, item) { return sum + (Number(item.quantity) || 0); }, 0);
    },
  };
  // The debugger's cart store, the only public place line items are readable.
  window.nextDebug = { stores: { cart: { getState: function () { return { items: read() }; } } } };

  document.addEventListener("click", function (event) {
    var control = event.target.closest('[data-next-action="add-to-cart"]');
    if (!control) return;
    event.preventDefault();
    var packageId = control.getAttribute("data-next-package-id");
    if (packageId) add(packageId, 1);
    var next = control.getAttribute("data-next-url");
    if (next) location.href = next;
  });

  var lines = document.querySelector("[data-next-cart-summary] [data-summary-lines]");
  if (lines) {
    read().forEach(function (item) {
      var row = document.createElement("div");
      row.setAttribute("data-next-package-id", item.packageId);
      row.textContent = "Package " + item.packageId + " x" + item.quantity;
      lines.appendChild(row);
    });
  }

  // The receipt reads the order back by ref_id, as the SDK does; the runner
  // treats that read-back as the authoritative proof of creation.
  var receipt = document.querySelector("[data-next-order-items]");
  var refId = new URLSearchParams(location.search).get("ref_id");
  if (receipt && refId) {
    fetch("/api/v1/orders/" + encodeURIComponent(refId) + "/").then(function (response) { return response.json(); }).then(function (order) {
      receipt.textContent = "";
      (order.lines || []).forEach(function (line) {
        var row = document.createElement("div");
        row.setAttribute("data-next-order-item", "");
        row.textContent = line.product_title + " x" + line.quantity;
        receipt.appendChild(row);
      });
      receipt.classList.add("order-has-items");
    });
  }

  function cardNumberDigits() {
    var frame = document.querySelector('iframe[id^="spreedly-number-frame"], iframe[id^="spreedly-hosted-number"]');
    var input = frame && frame.contentDocument && frame.contentDocument.querySelector("input");
    return input ? input.value.replace(/\D/g, "").length : null;
  }

  var form = document.querySelector("form[data-fixture-checkout]");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var items = read();
      if (!items.length) return; // the SDK posts nothing for an empty cart
      if (cardNumberDigits() !== null && cardNumberDigits() < 13) return; // nor for a short card number
      fetch("/api/v1/orders/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: items }),
      }).then(function (response) { return response.json(); }).then(function (order) {
        write([]);
        location.href = "/x/receipt/?ref_id=" + encodeURIComponent(order.ref_id);
      });
    });
  }
})();
