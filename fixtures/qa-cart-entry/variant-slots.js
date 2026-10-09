// Bundle-slot variant selects for the select-variant-slots fixtures
// (campaigns-os#667), shaped like the campaign-cart SDK's rendering inside
// [data-next-variant-selectors]: a .next-slot-variant-field per slot carrying
// data-next-bundle-id / data-next-slot-index / data-next-variant-code, and a
// native select.next-slot-variant-select. Like the olympus-mv-two-step
// starter, the native select is hidden behind a visible stand-in toggle.
//
// Body attributes pick the case:
//   data-fixture-slots="2"            slots rendered for the selected card
//   data-fixture-prefill="M"          each select starts on this value (the
//                                     stock SDK pre-selects the slot package's
//                                     own variant); otherwise a placeholder
//   data-fixture-out-of-stock-slot="2" every size in that slot is disabled
//   data-fixture-dropdown              wrap each field in a visible os-dropdown
//                                     (toggle + os-dropdown-item rows), the
//                                     native select hidden; Next then also
//                                     refuses until every field had a row
//                                     clicked, tracked in a page-level object,
//                                     even when the row equals the pre-filled
//                                     value (a native change does not count)
//   data-fixture-menu-delay="600"      the menu shows that many ms after the
//                                     toggle click ("never": it never shows)
//   data-fixture-rerender-on-toggle    the toggle click rebuilds the rows in
//                                     reverse order, so a row index planned
//                                     before the click is stale
//
// A size choice puts that size's package in the cart, one line per slot. The
// Next control ([data-next-action="checkout"]) refuses, before the shim's
// navigation handler sees the click, while any slot has no size.
(function () {
  var KEY = "qa-cart-entry:cart";
  var body = document.body;
  var slots = Number(body.getAttribute("data-fixture-slots") || 2);
  var prefill = body.getAttribute("data-fixture-prefill") || "";
  var outOfStockSlot = Number(body.getAttribute("data-fixture-out-of-stock-slot") || 0);
  var SIZES = [
    { value: "S", packageId: "20", inStock: false },
    { value: "M", packageId: "21", inStock: true },
    { value: "L", packageId: "22", inStock: true },
  ];
  var dropdown = body.hasAttribute("data-fixture-dropdown");
  var menuDelay = body.getAttribute("data-fixture-menu-delay") || "";
  var rerenderOnToggle = body.hasAttribute("data-fixture-rerender-on-toggle");
  var picks = {};
  window.fixtureVariantPicks = picks;
  var stage = document.getElementById("bundle-slots-stage");

  function writeCart() {
    var counts = {};
    Array.prototype.forEach.call(stage.querySelectorAll("select.next-slot-variant-select"), function (select) {
      var size = SIZES.filter(function (entry) { return entry.value === select.value; })[0];
      if (size) counts[size.packageId] = (counts[size.packageId] || 0) + 1;
    });
    localStorage.setItem(KEY, JSON.stringify(Object.keys(counts).map(function (packageId) {
      return { packageId: packageId, quantity: counts[packageId] };
    })));
  }

  for (var index = 0; index < slots; index += 1) {
    var slot = document.createElement("div");
    slot.className = "next-slot";
    var selectors = document.createElement("div");
    selectors.setAttribute("data-next-variant-selectors", "");
    var field = document.createElement("div");
    field.className = "next-slot-variant-field";
    field.setAttribute("data-next-variant-code", "size");
    field.setAttribute("data-next-variant-name", "Size");
    field.setAttribute("data-next-bundle-id", "pairs");
    field.setAttribute("data-next-slot-index", String(index));
    var label = document.createElement("label");
    label.className = "next-slot-variant-label";
    label.textContent = "Select Size:";
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "variant-toggle";
    var select = document.createElement("select");
    select.className = "next-slot-variant-select";
    select.setAttribute("data-next-variant-code", "size");
    select.style.display = "none";
    if (!prefill) {
      var placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose size";
      select.appendChild(placeholder);
    }
    SIZES.forEach(function (size) {
      var option = document.createElement("option");
      option.value = size.value;
      option.textContent = size.value;
      if (!size.inStock || outOfStockSlot === index + 1) option.disabled = true;
      if (size.value === prefill) option.selected = true;
      select.appendChild(option);
    });
    toggle.textContent = select.value || "Choose size";
    select.addEventListener("change", (function (button, control) {
      return function () { if (!dropdown) button.textContent = control.value || "Choose size"; writeCart(); };
    })(toggle, select));
    if (dropdown) {
      toggle = buildDropdown(field, select, index);
      toggle.parentNode.insertBefore(label, toggle);
      field.appendChild(select);
    } else {
      field.append(label, toggle, select);
    }
    selectors.appendChild(field);
    slot.appendChild(selectors);
    stage.appendChild(slot);
  }
  writeCart();

  // The dropdown UI: the toggle shows a placeholder until a row is clicked,
  // the menu shows on toggle, and a row click records the pick, then sets the
  // native select and dispatches change.
  // A row is unavailable by the same rules the runner reads.
  function rowUnavailable(row) {
    return row.hasAttribute("disabled") || row.getAttribute("aria-disabled") === "true" ||
      row.classList.contains("next-oos") || row.classList.contains("next-variant-unavailable") ||
      row.getAttribute("data-available") === "false";
  }

  function buildDropdown(field, select, index) {
    var box = document.createElement("os-dropdown");
    box.className = "os-variant-dropdown";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "os-card__variant-dropdown-toggle is-placeholder";
    button.textContent = "Size";
    var menu = document.createElement("os-dropdown-menu");
    function renderRows(reversed) {
      menu.replaceChildren();
      var options = Array.prototype.slice.call(select.options);
      if (reversed) options.reverse();
      options.forEach(function (option) {
        var row = document.createElement("os-dropdown-item");
        row.className = "os-card__variant-dropdown-item";
        row.setAttribute("value", option.value);
        row.textContent = option.textContent;
        if (option.disabled) row.setAttribute("disabled", "");
        menu.appendChild(row);
      });
    }
    renderRows(false);
    menu.addEventListener("click", function (event) {
      var row = event.target.closest("os-dropdown-item");
      if (!row || rowUnavailable(row)) return;
      picks[index] = row.getAttribute("value");
      button.textContent = row.getAttribute("value");
      button.classList.remove("is-placeholder");
      menu.classList.remove("show");
      select.value = row.getAttribute("value");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    button.addEventListener("click", function () {
      if (menuDelay === "never") return;
      if (rerenderOnToggle) renderRows(true);
      if (menuDelay) setTimeout(function () { menu.classList.add("show"); }, Number(menuDelay));
      else menu.classList.toggle("show");
    });
    box.append(button, menu);
    field.appendChild(box);
    return box;
  }

  document.addEventListener("click", function (event) {
    if (!event.target.closest('[data-next-action="checkout"]')) return;
    var empty = Array.prototype.some.call(stage.querySelectorAll("select.next-slot-variant-select"), function (select, index) {
      return !select.value || (dropdown && !picks[index]);
    });
    if (empty) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
})();
