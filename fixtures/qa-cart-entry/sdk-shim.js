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

  var form = document.querySelector("form[data-fixture-checkout]");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var items = read();
      if (!items.length) return; // the SDK posts nothing for an empty cart
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
