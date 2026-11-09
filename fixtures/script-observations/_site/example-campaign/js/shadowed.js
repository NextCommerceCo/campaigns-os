// Every global here is shadowed by a local binding, so none is the browser's or the SDK's.
(function (window, sessionStorage, next, nextDebug) {
  sessionStorage.setItem('next-order', '{}');
  window.fetch = function () {};
  next._cart = null;
  return nextDebug.stores;
})(window, sessionStorage, window.next, {});
function storeOf(localStorage) {
  return localStorage.getItem('next-checkout-store');
}
