// Shapes doctor reports: the receiver and the key resolve statically.
(function () {
  var scope = document.querySelector('meta[name="next-funnel"]').getAttribute('content');
  sessionStorage.setItem('next_selected_currency__' + scope, 'EUR');
  var cached = localStorage.getItem('next-campaign-cache');
  window.fetch = function (input, init) {
    return Promise.resolve(input, init);
  };
  XMLHttpRequest.prototype.send = function () {};
  var cart = window.nextDebug.stores.cart.getState();
  next._selector._getSelectedBundleItems = function () { return cart; };
  return cached;
})();
