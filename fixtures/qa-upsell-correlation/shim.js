// A stand-in for the campaign-cart SDK on the checkout only, just large
// enough to drive the typed-card runner to the first upsell step
// (campaigns-os#505). It is NOT the SDK: the pre-selected card is the cart,
// the cart reads the runner trusts answer from it, and the submit posts
// /api/v1/orders/ and lands on the first upsell page.
(function () {
  var items = [];
  var preselected = document.querySelector("[data-next-bundle-selector] [data-next-selector-card].next-selected[data-next-package-id]");
  if (preselected) items.push({ packageId: preselected.getAttribute("data-next-package-id"), quantity: 1 });
  window.next = {
    getCartCount: function () {
      return items.reduce(function (sum, item) { return sum + item.quantity; }, 0);
    },
  };
  window.nextDebug = { stores: { cart: { getState: function () { return { items: items }; } } } };

  var form = document.querySelector("form[data-fixture-checkout]");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      fetch("/api/v1/orders/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: items }),
      }).then(function (response) { return response.json(); }).then(function (order) {
        location.href = "/x/upsell-a/?ref_id=" + encodeURIComponent(order.ref_id);
      });
    });
  }
})();
