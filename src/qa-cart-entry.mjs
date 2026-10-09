// Cart entry for the typed-card runner (campaigns-os#206, runner half).
//
// A checkout page renders its customer form whether or not the SDK cart holds
// anything, so a runner that opens the checkout URL directly cannot tell a
// "select here" checkout (Demeter, Apollo, Olympus: the bundle cards live on
// the checkout page) from a "cart was filled upstream" checkout (the
// shop-single-step family: the landing page adds to the cart and hands off).
// On the second shape the ladder used to run every fill step green and then sit
// in `order_submitted` for the full step budget, because the SDK never posts an
// order for an empty cart and the captured request log had nothing to say.
//
// This module holds the browser-free half of the fix: resolving which page the
// funnel enters the cart from, the DOM probes (as evaluate() bodies) that
// decide whether a checkout carries its own selection surface, the SDK cart
// read used by the pre-submit guard, and the named failure codes the ladder
// reports instead of a timeout. The design half of #206 — authoritative entry
// metadata on the spec — is deliberately NOT decided here: entry is still
// inferred from topology, and the inference is recorded on the ladder step so a
// reader can see which page the runner chose and why.

import { OFFER_PAGE_TYPES, RECEIPT_PAGE_TYPES, canonicalHttpUrl } from "./qa-test-order-topology.mjs";

// Ladder step recorded before `opened_checkout`.
export const CART_ENTRY_STEP = "entered_via_landing";

// Named failure codes. Each one is a pre-submit failure by construction: the
// runner authored the refusal before any reservation and before any click, so
// the creation classifier reads them as `not_created`.
export const CART_ENTRY_CODES = Object.freeze({
  // Checkout carries no selection surface, and no landing/entry page could be
  // resolved from the funnel topology to fill the cart from.
  ENTRY_UNRESOLVED: "cart_entry_unresolved",
  // The resolved entry page rendered no add-to-cart control (or none matching
  // the requested --select-package ref).
  ENTRY_CONTROL_MISSING: "cart_entry_control_missing",
  // The control was clicked but the page never reached the checkout URL.
  ENTRY_NO_NAVIGATION: "cart_entry_no_navigation",
  // A select page's bundle slot shows an empty variant control (size,
  // colour) with no in-stock option to choose, so its Next would refuse.
  // Fired before the checkout control is clicked (campaigns-os#667).
  ENTRY_VARIANT_UNFILLED: "cart_entry_variant_unfilled",
  // The SDK cart held zero items at submit time. Fired before the budget
  // reservation and before the submit click.
  CART_EMPTY_BEFORE_SUBMIT: "cart_empty_before_submit",
});

// The SDK's own activation selector for its add-to-cart feature, and nothing
// else: the SDK instantiates the feature on `data-next-action="add-to-cart"`
// only, so any other attribute spelling is a control the SDK never wires. A
// page carrying one of those must read as "no cart-entry control", not as an
// entry the runner can click, or the ladder claims an activation the SDK
// does not have.
export const CART_ENTRY_CONTROL_SELECTOR = '[data-next-action="add-to-cart"]';

// The attribute an SDK cart-entry control (one matching
// CART_ENTRY_CONTROL_SELECTOR) navigates by: the SDK adds the package and then
// goes to `data-next-url` itself, so such a control carries no href. Only SDK
// controls get this reading — on any other element `data-next-url` has no
// navigation semantics and the href-shaped attributes stay authoritative
// (campaigns-os#321: the primary-CTA recogniser used to read href-shaped
// attributes only, so the SDK's own button on a landing page counted as "no
// CTA to the next route" while a plain cart-bypassing <a href> passed). The
// ladder's entry step and the primary-CTA assertion share this one rule.
export const CART_ENTRY_ROUTE_ATTRIBUTE = "data-next-url";

// The route a candidate CTA leads to, as one pure rule shared by the
// primary-CTA recogniser (which runs it inside the page) and the unit tests
// (which run it against element-shaped objects). Self-contained on purpose:
// the browser half serialises this function's source into the page, so it
// may reference nothing outside its own body.
//
// An SDK cart-entry control (one matching `cartEntrySelector`) navigates by
// `cartEntryRouteAttribute` and nothing else: the SDK's click handler calls
// preventDefault() unconditionally, so its href never navigates, and it
// resolves the attribute against the origin (campaign-cart url-utils), not the
// document base. Without the attribute such a control adds to the cart and
// stays put — no route. A control matching one of `declaredRoutes` (each
// `{ selector, url }`, a route the page declares rather than one the control
// carries: the SDK checkout form's submit button and an upsell's accept /
// decline actions) goes to that url and nothing else, because the SDK
// handles the submission or the click itself, so an href="#" or the form's
// action never navigates. Anywhere else the SDK attribute has no navigation
// semantics: an HTML anchor's own resolved href (native, so a <base href> is
// honoured), then an href attribute, then `data-href`, then a wrapping form's
// action — for that form's submit button only, and never inside a form
// matching `checkoutFormSelector`: the SDK checkout form, which the SDK
// submits itself, or, on a checkout or upsell / downsell page, every form,
// since there the only form-borne route is the one in `declaredRoutes`. Only
// spellings with real navigation semantics count — an attribute the SDK does
// not declare is not a route.
export function cartEntryHrefFor(element, { cartEntrySelector, cartEntryRouteAttribute, declaredRoutes = [], checkoutFormSelector = null, origin, baseHref }) {
  if (!element || typeof element.getAttribute !== "function") return null;
  if (typeof element.matches === "function" && element.matches(cartEntrySelector)) {
    const sdkRoute = String(element.getAttribute(cartEntryRouteAttribute) || "").trim();
    if (!sdkRoute) return null;
    try {
      return new URL(sdkRoute, origin).href;
    } catch {
      // An unparseable route attribute is no route either; do not leak the
      // raw value into evidence as if it were one.
      return null;
    }
  }
  const declared = typeof element.matches === "function"
    ? (declaredRoutes || []).find((route) => route?.selector && element.matches(route.selector))
    : null;
  if (declared) {
    try {
      return new URL(declared.url, baseHref).href;
    } catch {
      return null;
    }
  }
  // An HTML anchor resolves its own href (an SVG <a> exposes an object, not a
  // string, and falls through to the attribute reading).
  const tag = String(element.tagName || "").toUpperCase();
  if (tag === "A" && typeof element.href === "string" && element.href) return element.href;
  // The reflected type, so a <button> with no type attribute submits too.
  const submits = (tag === "BUTTON" || tag === "INPUT") && String(element.type || "").toLowerCase() === "submit";
  const insideRoutelessForm = Boolean(checkoutFormSelector) && typeof element.closest === "function" && Boolean(element.closest(checkoutFormSelector));
  const attr = element.getAttribute("href")
    || element.getAttribute("data-href")
    || (submits && !insideRoutelessForm && typeof element.closest === "function" ? element.closest("form")?.getAttribute("action") : null);
  if (!attr) return null;
  try {
    return new URL(attr, baseHref).href;
  } catch {
    // Same rule as the SDK branch: an unparseable attribute is not a route,
    // and evidence `href` fields stay parseable URLs or null.
    return null;
  }
}

// A select page (campaigns-os#641) has no add-to-cart control: its swap-mode
// bundle selector writes the cart when a card is chosen, the SDK persists the
// cart between pages, and a checkout button or link moves on. The runner
// treats "bundle cards plus one of these" as a cart-entry control: the SDK's
// checkout action, or a plain link into the next page. Matched by this one
// selector so the chosen control replays with nth().
export const CART_ENTRY_CHECKOUT_BUTTON_SELECTOR = '[data-next-action="checkout"], a[href]';

// The bundle cards a select page renders, outside the cart summary.
export const CART_ENTRY_BUNDLE_CARD_SELECTOR = "[data-next-bundle-card]";

// Route-shaped spellings the runner used to consult and no longer does,
// because the SDK never declares them. They are not routes, but a page that
// carries one is reported so an operator can tell "the runner narrowed its
// vocabulary" from "the CTA was removed" when a missing-route verdict flips.
export const UNDECLARED_ROUTE_ATTRIBUTES = Object.freeze(["data-next-href", "data-next-checkout-action"]);

// Page types that, when they route into checkout, are preferred as the cart
// entry. `select` is a real page type since #228; `product` is what the
// shop-single-step landing declares; the rest are the entry-like types
// `deriveEntryUrls` already recognises.
// Pages that can only follow the checkout: the checkout itself plus the
// topology module's own offer and receipt sets, so the two never drift. A
// checkout_step is never a cart entry either: it is a form page of the
// checkout path itself (campaigns-os#641).
const POST_CHECKOUT_PAGE_TYPES = new Set(["checkout", "checkout_step", ...OFFER_PAGE_TYPES, ...RECEIPT_PAGE_TYPES]);
const PREFERRED_ENTRY_PAGE_TYPES = ["select", "landing", "product", "presell", "entry", "lander", "advertorial", "listicle", "review", "opt-in", "optin"];

export function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function isCartEntryCode(code) {
  return Object.values(CART_ENTRY_CODES).includes(code);
}

function pageTypeOf(page) {
  return String(page?.page_type || "").toLowerCase().trim();
}

function sameUrl(left, right) {
  const a = canonicalHttpUrl(left);
  const b = canonicalHttpUrl(right);
  return Boolean(a && b && a === b);
}

// Which page fills the cart before checkout. Resolution order:
//   1. a page (other than checkout) whose `expected_next_url` is the checkout,
//      preferring the entry-like page types above, then the lowest `order`;
//   2. the topology's first entry-like page, else its first page — the same
//      choice `deriveEntryUrls` makes for `entry_urls[0]` — restricted to
//      pages that sit BEFORE the checkout. A receipt or an offer page can
//      never be the cart entry, whatever the fallback order says.
// Returns null when nothing resolves; the caller turns that into a named
// failure only when the checkout also carries no selection surface.
export function resolveCartEntryPage(topologies = [], checkoutPage = null) {
  if (!checkoutPage?.url) return null;
  const list = Array.isArray(topologies) ? topologies : [];
  const owning = list.find((topology) => (topology?.pages || []).some((page) => page === checkoutPage || sameUrl(page?.url, checkoutPage.url)))
    || list[0]
    || null;
  const checkoutOrder = Number(checkoutPage.order);
  const pages = (owning?.pages || []).filter((page) => (
    page?.url
    && !sameUrl(page.url, checkoutPage.url)
    && !POST_CHECKOUT_PAGE_TYPES.has(pageTypeOf(page))
    && (!Number.isFinite(checkoutOrder) || !Number.isFinite(Number(page.order)) || Number(page.order) < checkoutOrder)
  ));
  if (!pages.length) return null;

  const rank = (page) => {
    const index = PREFERRED_ENTRY_PAGE_TYPES.indexOf(pageTypeOf(page));
    return index === -1 ? PREFERRED_ENTRY_PAGE_TYPES.length : index;
  };
  const byPreference = (left, right) => rank(left) - rank(right) || (Number(left.order) || 0) - (Number(right.order) || 0);

  const routesIntoCheckout = pages.filter((page) => sameUrl(page.expected_next_url, checkoutPage.url)).sort(byPreference);
  if (routesIntoCheckout.length) return describe(routesIntoCheckout[0], "routes_into_checkout");

  const entryLike = pages.filter((page) => PREFERRED_ENTRY_PAGE_TYPES.includes(pageTypeOf(page))).sort(byPreference);
  if (entryLike.length) return describe(entryLike[0], "entry_page_fallback");
  return describe(pages[0], "first_page_fallback");
}

function describe(page, resolution) {
  return {
    page_id: page.page_id || null,
    page_type: page.page_type || null,
    url: page.url,
    resolution,
  };
}

// evaluate() body: does this checkout carry a main-cart selection surface?
// Counted: bundle/cart selectors and package cards. Not counted: anything
// inside the rendered cart summary (it displays `cart.*`, it does not select),
// order-bump toggles (an add-on is not the main cart), upsell-context
// selectors, and <template> content the SDK has not rendered.
export function checkoutSelectionSurfaceScript() {
  return () => {
    const EXCLUDED_ANCESTORS = "[data-next-cart-summary], [data-next-toggle-card], [data-next-package-toggle], [data-next-bump], [data-next-upsell-context], [data-next-upsell], template";
    const candidates = Array.from(document.querySelectorAll("[data-next-bundle-selector], [data-next-cart-selector], [data-next-package-id]"));
    const counted = candidates.filter((element) => !element.closest(EXCLUDED_ANCESTORS));
    const kinds = {
      bundle_selector: counted.filter((element) => element.hasAttribute("data-next-bundle-selector")).length,
      cart_selector: counted.filter((element) => element.hasAttribute("data-next-cart-selector")).length,
      package_card: counted.filter((element) => element.hasAttribute("data-next-package-id")).length,
    };
    return { count: counted.length, kinds, excluded: candidates.length - counted.length };
  };
}

export function summarizeSelectionSurface(surface) {
  const kinds = surface?.kinds || {};
  const parts = Object.entries(kinds).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`);
  return parts.length ? parts.join(", ") : "none";
}

// evaluate() body: the cart-entry controls the entry page renders. Three kinds:
//   add_to_cart     the SDK action controls (CART_ENTRY_CONTROL_SELECTOR); the
//                   SDK adds the package and navigates via data-next-url;
//   checkout_link   a plain link into the checkout URL carrying
//                   `?forcePackageId=`, which the SDK reads on the checkout
//                   page to pre-load the cart. This is what the certified
//                   shop-single-step landing renders today;
//   checkout_button on a page with bundle cards only: the SDK checkout action
//                   or a plain link into the checkout URL. The selected card
//                   is the cart; `bundle_package_ids` lists what the cards
//                   carry so --select-package can name one (campaigns-os#641).
// Each control reports its visibility, text, and the package id it carries
// (own attribute, nearest card, or the forcePackageId ref), so the caller can
// prefer a visible SDK control and honour --select-package in one round trip.
export function cartEntryControlsScript() {
  return ({ selector, checkoutUrl, checkoutButtonSelector = null, bundleCardSelector = null }) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const canonical = (value) => {
      try {
        const url = new URL(value, document.baseURI);
        url.search = "";
        url.hash = "";
        url.pathname = url.pathname.replace(/\/index\.html$/i, "/").replace(/\/+$/, "") || "/";
        return url.toString();
      } catch {
        return null;
      }
    };
    const label = (element) => clean(element.textContent).slice(0, 80) || clean(element.getAttribute("aria-label")) || clean(element.getAttribute("value")) || null;
    const readPackageId = (element) => {
      const own = element.getAttribute("data-next-package-id");
      if (own && own.trim()) return own.trim();
      const card = element.closest("[data-next-package-id]");
      return card ? clean(card.getAttribute("data-next-package-id")) || null : null;
    };
    const readQuantity = (value) => {
      const parsed = Number.parseInt(String(value || "").trim(), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    };
    // `index` is the control's position among the elements its own locator
    // matches (the SDK-control selector, or every `a[href]`), so the caller
    // can replay it with nth() instead of rebuilding a selector from the
    // attribute value.
    const actions = Array.from(document.querySelectorAll(selector)).map((element, index) => ({
      kind: "add_to_cart",
      index,
      visible: isVisible(element),
      text: label(element),
      package_id: readPackageId(element),
      quantity: readQuantity(element.getAttribute("data-next-quantity")),
      next_url: clean(element.getAttribute("data-next-url")) || null,
      tag: element.tagName.toLowerCase(),
    }));
    const checkout = canonical(checkoutUrl);
    const links = checkout
      ? Array.from(document.querySelectorAll("a[href]")).flatMap((element, index) => {
        const href = element.getAttribute("href");
        if (canonical(href) !== checkout) return [];
        let forced = null;
        try {
          forced = new URL(href, document.baseURI).searchParams.get("forcePackageId");
        } catch {
          forced = null;
        }
        if (!forced) return [];
        const [ref, qty] = forced.split(",")[0].split(":");
        return [{
          kind: "checkout_link",
          index,
          visible: isVisible(element),
          text: label(element),
          package_id: clean(ref) || null,
          quantity: readQuantity(qty),
          next_url: href,
          tag: "a",
        }];
      })
      : [];
    const cards = Array.from(document.querySelectorAll(bundleCardSelector || "[data-next-bundle-card]"))
      .filter((card) => !card.closest("[data-next-cart-summary], [data-next-upsell-context], [data-next-upsell], template"));
    const bundlePackageIds = [...new Set(cards.flatMap((card) => {
      const own = clean(card.getAttribute("data-next-package-id"));
      const nested = Array.from(card.querySelectorAll("[data-next-package-id]")).map((node) => clean(node.getAttribute("data-next-package-id")));
      return [own, ...nested].filter(Boolean);
    }))];
    const buttons = cards.length && checkoutButtonSelector
      ? Array.from(document.querySelectorAll(checkoutButtonSelector)).flatMap((element, index) => {
        const isAction = element.getAttribute("data-next-action") === "checkout";
        if (!isAction) {
          const href = element.getAttribute("href");
          if (!checkout || canonical(href) !== checkout) return [];
          try {
            if (new URL(href, document.baseURI).searchParams.get("forcePackageId")) return [];
          } catch {
            return [];
          }
        }
        return [{
          kind: "checkout_button",
          index,
          visible: isVisible(element),
          text: label(element),
          package_id: null,
          bundle_package_ids: bundlePackageIds,
          quantity: 1,
          next_url: isAction ? null : element.getAttribute("href"),
          tag: element.tagName.toLowerCase(),
        }];
      })
      : [];
    return [...actions, ...links, ...buttons];
  };
}

// Pick the control to click. A requested --select-package ref must match the
// control's package id (strict, like selectPackageCard); otherwise the first
// visible SDK control wins, then the first visible checkout link, and a hidden
// control is only used when nothing is visible.
export function chooseCartEntryControl(controls = [], requested = []) {
  const list = Array.isArray(controls) ? controls : [];
  if (!list.length) return { control: null, reason: "no add-to-cart control, forcePackageId checkout link, or bundle cards with a checkout button rendered on the entry page" };
  const wanted = Array.isArray(requested) ? requested.filter((item) => item?.packageId) : [];
  if (wanted.length > 1) {
    return {
      control: null,
      reason: `--select-package requested ${wanted.length} refs, but a landing-page entry can select at most one package before the SDK navigates to checkout`,
    };
  }
  // A select page's checkout button carries no package of its own: the
  // requested package is the bundle card the runner clicks before it. Used
  // only when no add-to-cart control or forcePackageId link carries the ref.
  const buttons = list.filter((control) => control.kind === "checkout_button");
  const carriers = list.filter((control) => control.kind !== "checkout_button");
  const byRef = wanted.length
    ? carriers.filter((control) => String(control.package_id) === String(wanted[0].packageId))
    : carriers;
  if (!byRef.length && buttons.length) {
    const pick = (pool) => pool.find((control) => control.visible) || pool[0];
    if (!wanted.length) return { control: pick(buttons), reason: null };
    const withCard = buttons.filter((control) => (control.bundle_package_ids || []).map(String).includes(String(wanted[0].packageId)));
    if (withCard.length) return { control: pick(withCard), select_card: wanted[0], reason: null };
    return {
      control: null,
      reason: `--select-package ${wanted[0].packageId}: no bundle card on the entry page carries package ${wanted[0].packageId} (rendered: ${[...new Set(buttons.flatMap((control) => control.bundle_package_ids || []))].join(", ") || "(none)"})`,
    };
  }
  if (!byRef.length) {
    return {
      control: null,
      reason: `--select-package ${wanted[0].packageId}: no cart-entry control on the entry page carries package ${wanted[0].packageId} (rendered: ${list.map((control) => control.package_id || "(none)").join(", ")})`,
    };
  }
  // An explicit quantity is a claim about what the click adds. The control
  // states its own quantity (data-next-quantity, or the forcePackageId
  // `ref:qty`), so a request the control cannot satisfy is refused rather
  // than silently downgraded to whatever the control adds.
  const pool = wanted.length && wanted[0].quantityExplicit
    ? byRef.filter((control) => Number(control.quantity ?? 1) === Number(wanted[0].quantity))
    : byRef;
  if (!pool.length) {
    return {
      control: null,
      reason: `--select-package ${wanted[0].packageId}:${wanted[0].quantity}: the entry-page control(s) for package ${wanted[0].packageId} add quantity ${[...new Set(byRef.map((control) => control.quantity ?? 1))].join("/")}, not ${wanted[0].quantity}`,
    };
  }
  const byKind = (kind) => pool.filter((control) => control.kind === kind);
  const ordered = [...byKind("add_to_cart"), ...byKind("checkout_link")];
  return { control: ordered.find((control) => control.visible) || ordered[0], reason: null };
}

// evaluate() body: the SDK cart as the page sees it. Reads the public API
// first — `window.next.getCartCount()` is installed on every SDK page and
// returns the store's `totalQuantity` — and the debugger's cart store second
// (`window.nextDebug.stores.cart`, present with `?debugger=true`), which is
// the only public place the line items and their package ids are readable.
// The variant controls a select page renders per bundle slot: the
// campaign-cart SDK injects a native select into each slot's
// [data-next-variant-selectors] (inside a .next-slot-variant-field). The
// olympus-mv-two-step starter, and pages built from it, hide that select behind
// a visible os-dropdown (a toggle button plus os-dropdown-item rows carrying
// `value`); a row click is what sets the select and dispatches `change`.
export const SLOT_VARIANT_SELECT_SELECTOR = "[data-next-variant-selectors] select, .next-slot-variant-field select";
export const SLOT_VARIANT_FIELD_SELECTOR = ".next-slot-variant-field";
export const SLOT_VARIANT_DROPDOWN_TOGGLE_SELECTOR = "os-dropdown .os-card__variant-dropdown-toggle";
export const SLOT_VARIANT_DROPDOWN_ROW_SELECTOR = "os-dropdown os-dropdown-item";

export const slotVariantKey = ({ bundle_id: bundleId, slot, variant_code: code } = {}) => `${bundleId ?? ""}|${slot}|${code ?? ""}`;

// evaluate() body: the next slot variant action, one per call because a
// choice can re-render its slot. In document order over the visible slot
// variant selects (a select counts as visible when it or its field is):
//   - a field showing a dropdown UI whose key is not in `picked` gets a pick:
//     the row matching the select's current value when that row is in stock
//     (so the cart stays what the SDK chose), else the first in-stock row. The
//     caller clicks the toggle and the row like a shopper, because a page may
//     count a field as chosen only when a row was clicked. Pre-filled selects
//     are picked too. Returned as { pick } with the field's index among
//     SLOT_VARIANT_FIELD_SELECTOR matches and the row's index among the
//     field's SLOT_VARIANT_DROPDOWN_ROW_SELECTOR matches;
//   - a select with no dropdown UI is filled here only when it is empty, with
//     its first in-stock option and input + change dispatched ({ filled });
//     a pre-filled one is left alone.
// In stock: enabled, not hidden, non-empty value; for a row also not
// [disabled], aria-disabled, .next-oos, .next-variant-unavailable or
// data-available="false", and its native option not disabled. Nothing to
// choose returns { unfillable } naming the slot; nothing left returns
// { done: true }.
export function slotVariantStepScript() {
  return ({ selector, fieldSelector, toggleSelector, rowSelector, picked = [] }) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const holderOf = (select) => select.closest(fieldSelector) || select.closest("[data-next-variant-selectors]");
    const visible = Array.from(new Set(document.querySelectorAll(selector)))
      .filter((select) => !select.disabled && (isVisible(select) || isVisible(holderOf(select))));
    const slotRoots = Array.from(new Set(visible.map((select) => select.closest("[data-next-variant-selectors]") || holderOf(select))));
    const fields = Array.from(document.querySelectorAll(fieldSelector));
    const describe = (select) => {
      const field = select.closest(fieldSelector);
      const index = Number.parseInt(field?.getAttribute("data-next-slot-index") ?? "", 10);
      const root = select.closest("[data-next-variant-selectors]") || holderOf(select);
      return {
        bundle_id: clean(field?.getAttribute("data-next-bundle-id")) || null,
        slot: Number.isFinite(index) ? index + 1 : slotRoots.indexOf(root) + 1,
        variant_code: clean(select.getAttribute("data-next-variant-code") || select.getAttribute("data-variant-code") || field?.getAttribute("data-next-variant-code") || select.name) || null,
      };
    };
    const keyOf = (info) => `${info.bundle_id ?? ""}|${info.slot}|${info.variant_code ?? ""}`;
    const optionInStock = (option) => !option.disabled && !option.hidden && clean(option.value) !== "";
    for (const select of visible) {
      const info = describe(select);
      const field = select.closest(fieldSelector);
      const toggle = field ? Array.from(field.querySelectorAll(toggleSelector)).find(isVisible) : null;
      if (toggle) {
        if (picked.includes(keyOf(info))) continue;
        const rows = Array.from(field.querySelectorAll(rowSelector));
        const rowInStock = (row) => {
          const value = clean(row.getAttribute("value"));
          if (!value || row.hidden || row.hasAttribute("disabled") || row.getAttribute("aria-disabled") === "true") return false;
          if (row.classList.contains("next-oos") || row.classList.contains("next-variant-unavailable") || row.getAttribute("data-available") === "false") return false;
          const option = Array.from(select.options).find((candidate) => candidate.value === row.getAttribute("value"));
          return !option || optionInStock(option);
        };
        const current = clean(select.value);
        const row = rows.find((candidate) => current && candidate.getAttribute("value") === select.value && rowInStock(candidate)) || rows.find(rowInStock);
        if (!row) return { unfillable: { ...info, options: rows.length, via: "dropdown" } };
        return { pick: { ...info, value: row.getAttribute("value"), field_index: fields.indexOf(field), row_index: rows.indexOf(row) } };
      }
      if (clean(select.value) !== "") continue;
      const option = Array.from(select.options).find(optionInStock);
      if (!option) return { unfillable: { ...info, options: select.options.length, via: "select" } };
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: { ...info, value: option.value } };
    }
    return { done: true };
  };
}

export function slotVariantLabel({ bundle_id: bundleId, slot, variant_code: code } = {}) {
  return `slot ${slot}${bundleId ? ` (bundle "${bundleId}")` : ""}${code ? ` ${code}` : " variant"}`;
}

// The enriched line list on `getCartData()` is deliberately NOT read: it is
// always empty on the shipped SDK (campaign-cart#36; see the cart-state
// verification section of docs/qa-and-test-orders.md), so it would call every
// cart empty. Reports `readable: false` when neither source is present so the
// guard can say "could not read" instead of guessing.
export function sdkCartSnapshotScript() {
  return () => {
    const asArray = (value) => (Array.isArray(value) ? value : []);
    const packageIds = (items) => asArray(items).map((item) => item?.packageId ?? item?.package_id ?? null).filter((id) => id !== null && id !== undefined).map(String);
    let debugItems = null;
    try {
      const store = window.nextDebug?.stores?.cart;
      const state = typeof store?.getState === "function" ? store.getState() : store;
      if (state && Array.isArray(state.items)) debugItems = state.items;
    } catch {
      debugItems = null;
    }
    try {
      const sdk = window.next;
      if (sdk && typeof sdk.getCartCount === "function") {
        const count = Number(sdk.getCartCount());
        return {
          readable: true,
          source: "window.next",
          count: Number.isFinite(count) ? count : 0,
          line_count: debugItems ? debugItems.length : null,
          package_ids: packageIds(debugItems),
        };
      }
    } catch {
      // Fall through to the debug store alone.
    }
    if (debugItems) {
      return {
        readable: true,
        source: "nextDebug.stores.cart",
        count: debugItems.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0),
        line_count: debugItems.length,
        package_ids: packageIds(debugItems),
      };
    }
    return { readable: false, source: null, count: null, line_count: null, package_ids: [] };
  };
}

// The guard's decision. `cartApi` is the cart-create observation
// (`cartCreationEvidence`) — the third source the guard may fall back to when
// the page exposes no SDK global at all.
export function assessCartBeforeSubmit(snapshot, cartApi = null) {
  if (snapshot?.readable) {
    // Decided on the unit count alone: `totalQuantity` is the store's own
    // number, and the line list is only present under the debugger.
    const empty = Number(snapshot.count) === 0;
    return { empty, source: snapshot.source, count: snapshot.count, line_count: snapshot.line_count ?? null, package_ids: snapshot.package_ids || [] };
  }
  if (cartApi && typeof cartApi.line_count === "number") {
    return { empty: cartApi.line_count === 0, source: "cart_api_response", count: null, line_count: cartApi.line_count, package_ids: [] };
  }
  return { empty: false, source: null, count: null, line_count: null, package_ids: [], unreadable: true };
}

export function cartEmptyMessage(assessment) {
  return `SDK cart holds 0 item(s) at submit time (read from ${assessment.source}); the checkout would never post an order, so the submit click was not made`;
}
