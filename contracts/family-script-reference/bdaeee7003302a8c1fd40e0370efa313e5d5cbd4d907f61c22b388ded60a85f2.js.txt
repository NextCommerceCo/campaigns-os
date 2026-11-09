(function () {
  var STORAGE_KEY = 'countdown_end_' + location.pathname.replace(/\W+/g, '_');
  var DURATION_MS = 15 * 60 * 1000; // 15 minutes

  function getEndTime() {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      var t = parseInt(stored, 10);
      if (t > Date.now()) return t;
    }
    var end = Date.now() + DURATION_MS;
    localStorage.setItem(STORAGE_KEY, end.toString());
    return end;
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function tick() {
    var endTime = getEndTime();
    var remaining = Math.max(0, endTime - Date.now());
    var totalSec = Math.floor(remaining / 1000);
    var hrs = Math.floor(totalSec / 3600);
    var min = Math.floor((totalSec % 3600) / 60);
    var sec = totalSec % 60;

    document.querySelectorAll('[data-countdown-hrs]').forEach(function (el) {
      el.textContent = pad(hrs);
    });
    document.querySelectorAll('[data-countdown-min]').forEach(function (el) {
      el.textContent = pad(min);
    });
    document.querySelectorAll('[data-countdown-sec]').forEach(function (el) {
      el.textContent = pad(sec);
    });

    if (remaining > 0) {
      setTimeout(tick, 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
})();
