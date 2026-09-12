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
  // The SDK cart held zero items at submit time. Fired before the budget
  // reservation and before the submit click.
  CART_EMPTY_BEFORE_SUBMIT: "cart_empty_before_submit",
});

export const CART_ENTRY_CONTROL_SELECTOR =
  '[data-next-action="add-to-cart"], [data-next-checkout-action="add-to-cart"], [data-next-add-to-cart]';

// Page types that, when they route into checkout, are preferred as the cart
// entry. `select` is a real page type since #228; `product` is what the
// shop-single-step landing declares; the rest are the entry-like types
// `deriveEntryUrls` already recognises.
// Pages that can only follow the checkout: the checkout itself plus the
// topology module's own offer and receipt sets, so the two never drift.
const POST_CHECKOUT_PAGE_TYPES = new Set(["checkout", ...OFFER_PAGE_TYPES, ...RECEIPT_PAGE_TYPES]);
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

// evaluate() body: the cart-entry controls the entry page renders. Two kinds:
//   add_to_cart   the SDK action controls (CART_ENTRY_CONTROL_SELECTOR); the
//                 SDK adds the package and navigates via data-next-url;
//   checkout_link a plain link into the checkout URL carrying
//                 `?forcePackageId=`, which the SDK reads on the checkout page
//                 to pre-load the cart. This is what the certified
//                 shop-single-step landing renders today.
// Each control reports its visibility, text, and the package id it carries
// (own attribute, nearest card, or the forcePackageId ref), so the caller can
// prefer a visible SDK control and honour --select-package in one round trip.
export function cartEntryControlsScript() {
  return ({ selector, checkoutUrl }) => {
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
    return [...actions, ...links];
  };
}

// Pick the control to click. A requested --select-package ref must match the
// control's package id (strict, like selectPackageCard); otherwise the first
// visible SDK control wins, then the first visible checkout link, and a hidden
// control is only used when nothing is visible.
export function chooseCartEntryControl(controls = [], requested = []) {
  const list = Array.isArray(controls) ? controls : [];
  if (!list.length) return { control: null, reason: "no add-to-cart control or forcePackageId checkout link rendered on the entry page" };
  const wanted = Array.isArray(requested) ? requested.filter((item) => item?.packageId) : [];
  if (wanted.length > 1) {
    return {
      control: null,
      reason: `--select-package requested ${wanted.length} refs, but a landing-page entry can select at most one package before the SDK navigates to checkout`,
    };
  }
  const byRef = wanted.length
    ? list.filter((control) => String(control.package_id) === String(wanted[0].packageId))
    : list;
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
