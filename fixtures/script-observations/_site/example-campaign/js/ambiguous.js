// Shapes doctor does not report: nothing here verifies an SDK receiver or key.
(function () {
  var selector = document.querySelector('[data-next-bundle-selector]');
  selector._getSelectedBundleItems = function () { return []; };
  var sdk = window.next;
  sdk._cart = null;
  var key = window.campaignKey;
  sessionStorage.setItem(key, '1');
  localStorage.setItem('timer_end', String(Date.now()));
  localStorage.getItem(['next', 'order'].join('-'));
  var api = { fetch: null };
  api.fetch = function () {};
})();
