// Campaign Cart SDK 0.5 compatibility facts, for the checks that must
// tolerate a page pinned to 0.5.0 or later without changing how they judge a
// 0.4.x page.
//
// Source: NextCommerceCo/campaign-cart at tag v0.5.0:
//   docs/guides/migrating-from-0.4.md            (Removed, Deprecated)
//   docs/architecture/parity-0.4.md              (every 0.4.43 name)
//   docs/guides/attribute-reference/setup/loader-script.md, page-state.md
//   docs/guides/attribute-reference/inputs/data-next-field.md
//   src/checkout/form/names.ts                   (PAGE_FIELDS, V2_NAMES)
//
// 0.5 still reads the 0.4.x attributes, nextConfig keys and event names from
// a legacy layer, so a 0.4.x page keeps working on it. What 0.5 adds: the
// data-next-field / data-next-action="acceptUpsell" attribute set, a
// type="module" loader that names the campaign with data-campaign, and
// html[data-next-ready] / html[data-next-error] for page state (html.next-
// display-ready is still set). What it removes is REMOVED_IN_05 below.
//
// The vendored attribute index (sdk-attribute-index.mjs) and the SDK support
// policy stay at 0.4.x until the starter templates are verified on 0.5; this
// module is what lets a 0.5 pin pass meanwhile.

import { sdkVersionAtLeast } from "./sdk-attribute-index.mjs";

export const SDK_05 = "0.5.0";

// Whether `version` is an exact released SDK version at or after 0.5.0. A
// range, a prerelease, @latest or no version is not: such a page is judged
// as 0.4.x, as the version-gated field names are.
export function isSdk05(version) {
  return sdkVersionAtLeast(version, SDK_05);
}

// The 0.4.x checkout field name (data-next-checkout-field) to the API name
// 0.5 prefers. 0.5 maps both ways (names.ts PAGE_FIELDS), and its own
// data-next-address widget still writes the 0.4.x names.
export const SDK_05_API_FIELD_NAMES = Object.freeze({
  fname: "first_name",
  lname: "last_name",
  address1: "line1",
  address2: "line2",
  province: "state",
  postal: "postcode",
  phone: "phone_number",
});

// The data-next-field key for a 0.4.x name, where it differs from the API
// name: the card slots and the payment radios (names.ts V2_NAMES), and phone,
// whose documented data-next-field key is `phone` (toV2). 0.5 reads
// data-next-field="phone_number" as the phone too (fromV2 passes it through).
const SDK_05_FIELD_KEYS = Object.freeze({
  "cc-number": "card.number",
  cvv: "card.cvv",
  "cc-expiry": "card.expiry",
  "payment-method": "payment_method",
  phone: "phone",
});

// Every selector a 0.4.x checkout field name can appear under on a 0.4.x or
// 0.5 page: data-next-checkout-field with the 0.4.x name, and on 0.5 pages
// data-next-checkout-field with the API name and data-next-field with its
// key (and with the API name, where the key differs). A billing- name is
// matched by data-next-field only inside data-next-address="billing", where
// 0.5 reads an address key as billing.
// A data-next-field="…" selector matches nothing on a 0.4.x page. The API
// name on data-next-checkout-field can: a 0.4.x page that writes it before
// the SDK reads it fails doctor's WRONG_FIELD_NAME, which runs before QA.
export function checkoutFieldSelectors(name) {
  const value = String(name);
  const billing = value.startsWith("billing-");
  const base = billing ? value.slice("billing-".length) : value;
  const api = SDK_05_API_FIELD_NAMES[base] || null;
  const keys = unique([SDK_05_FIELD_KEYS[base] || api || base, ...(api ? [api] : [])]);
  const selectors = [`[data-next-checkout-field="${value}"]`];
  if (api) selectors.push(`[data-next-checkout-field="${billing ? `billing-${api}` : api}"]`);
  for (const key of keys) {
    selectors.push(billing ? `[data-next-address="billing"] [data-next-field="${key}"]` : `[data-next-field="${key}"]`);
  }
  return selectors;
}

function unique(values) {
  return [...new Set(values)];
}

export function checkoutFieldSelector(name) {
  return checkoutFieldSelectors(name).join(", ");
}

// The 0.5 upsell actions, on data-next-action. data-next-upsell-action
// ("add|skip", "accept|decline") is unchanged in 0.5.
export const SDK_05_UPSELL_ACTIONS = Object.freeze({ accept: "acceptUpsell", decline: "skipUpsell" });

// The checkout form selector: 0.4.x starters write data-next-checkout="form",
// 0.5 pages the bare attribute. Both SDKs bind any form[data-next-checkout].
export const CHECKOUT_FORM_SELECTOR = 'form[data-next-checkout="form"], form[data-next-checkout=""]';

// Page state 0.5 sets on <html>: data-next-ready once every value is written,
// data-next-error when the SDK cannot start.
export const SDK_05_READY_ATTRIBUTE = "data-next-ready";
export const SDK_05_ERROR_ATTRIBUTE = "data-next-error";
export const SDK_05_ERROR_VALUES = Object.freeze(["config", "load", "campaign"]);

// The data-next-* names the 0.5.0 source reads or writes, by the recipe that
// built SDK_DATA_NEXT_ATTRIBUTES, run at v0.5.0, less the deprecated widget
// names (accordion, timer, tooltip) the 0.4.x index already lists. A 0.5 page
// reads these on top of the 0.4.x names its legacy layer keeps.
export const SDK_05_DATA_NEXT_ATTRIBUTES = Object.freeze([
  "data-next-action", "data-next-active", "data-next-address", "data-next-address-field",
  "data-next-address-row", "data-next-address-state", "data-next-bundle-card", "data-next-bundle-display",
  "data-next-bundle-id", "data-next-bundle-items", "data-next-bundle-qty-for", "data-next-bundle-selector",
  "data-next-bundle-selector-id", "data-next-bundle-slot-template", "data-next-bundle-slot-template-id",
  "data-next-bundle-slots-for", "data-next-bundle-vouchers", "data-next-cart-items", "data-next-cart-summary",
  "data-next-checkout", "data-next-checkout-field", "data-next-checkout-review", "data-next-checkout-step",
  "data-next-checkout-submit", "data-next-clear-cart", "data-next-component", "data-next-component-location",
  "data-next-coupon", "data-next-default-property", "data-next-defer", "data-next-disabled", "data-next-discounts",
  "data-next-display", "data-next-each", "data-next-empty", "data-next-error-for",
  "data-next-exclude-property", "data-next-express", "data-next-express-checkout", "data-next-fallback",
  "data-next-field", "data-next-for", "data-next-format", "data-next-go", "data-next-hide", "data-next-i18n",
  "data-next-id", "data-next-in-cart", "data-next-invalid", "data-next-is-upsell", "data-next-item-properties",
  "data-next-items", "data-next-lead", "data-next-loading", "data-next-max-quantity", "data-next-min-quantity",
  "data-next-next-url", "data-next-option", "data-next-options", "data-next-order-items", "data-next-package-id",
  "data-next-package-sync", "data-next-payment", "data-next-payment-form", "data-next-payment-method",
  "data-next-payment-state", "data-next-phone-country", "data-next-phone-e164", "data-next-product-sync",
  "data-next-promotion", "data-next-promotion-creative", "data-next-promotion-name", "data-next-property",
  "data-next-quantity", "data-next-quantity-decrease", "data-next-quantity-display",
  "data-next-quantity-increase", "data-next-query", "data-next-ready", "data-next-remove-item", "data-next-replace",
  "data-next-required", "data-next-scroll-target", "data-next-scroll-threshold", "data-next-selected",
  "data-next-selection-mode", "data-next-selector", "data-next-selector-id", "data-next-shipping-id",
  "data-next-show", "data-next-slots", "data-next-step", "data-next-step-number", "data-next-toggle-card",
  "data-next-toggle-container", "data-next-toggle-display", "data-next-toggle-image", "data-next-upsell",
  "data-next-upsell-action", "data-next-upsell-context", "data-next-upsell-quantity-toggle", "data-next-url",
  "data-next-value", "data-next-value-raw", "data-next-variant", "data-next-variant-code",
  "data-next-variant-selectors", "data-next-vouchers",
]);

const exact05 = new Set(SDK_05_DATA_NEXT_ATTRIBUTES.filter((name) => !name.endsWith("-")));
const prefixes05 = SDK_05_DATA_NEXT_ATTRIBUTES.filter((name) => name.endsWith("-"));

export function isSdk05Attribute(name) {
  const value = String(name || "").toLowerCase();
  return exact05.has(value) || prefixes05.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

// What 0.5 removed (migrating-from-0.4.md, "Removed"), each with how a built
// page shows it and what replaces it. `markup` entries are read from element
// attributes; `script` entries from the page's inline and campaign-owned
// script text.
export const REMOVED_IN_05 = Object.freeze([
  Object.freeze({ id: "accept_upsell_action", kind: "markup", attribute: "data-next-action", value: "accept-upsell",
    label: 'data-next-action="accept-upsell"', remedy: 'Use data-next-upsell-action="add" inside the offer, or data-next-action="acceptUpsell".' }),
  Object.freeze({ id: "upsell_option", kind: "markup", attribute: "data-next-upsell-option",
    label: "data-next-upsell-option", remedy: "Put a bundle selector with data-next-upsell-context inside the offer." }),
  Object.freeze({ id: "upsell_select", kind: "markup", attribute: "data-next-upsell-select",
    label: "data-next-upsell-select", remedy: "Put a bundle selector with data-next-upsell-context inside the offer." }),
  Object.freeze({ id: "upsell_quantity", kind: "markup", attribute: "data-next-upsell-quantity",
    label: "data-next-upsell-quantity", remedy: "Put a bundle selector with data-next-upsell-context inside the offer, or data-next-quantity on the offer." }),
  Object.freeze({ id: "prospect_config", kind: "markup", attribute: "data-prospect-config",
    label: "data-prospect-config", remedy: "Set data-next-lead on the checkout form; mark inputs with data-next-checkout-field." }),
  Object.freeze({ id: "email_field", kind: "markup", attribute: "data-email-field",
    label: "data-email-field", remedy: 'Mark the input with data-next-checkout-field="email" and set data-next-lead on the form.' }),
  Object.freeze({ id: "phone_field", kind: "markup", attribute: "data-phone-field",
    label: "data-phone-field", remedy: 'Mark the input with data-next-checkout-field="phone" and set data-next-lead on the form.' }),
  Object.freeze({ id: "min_phone_digits", kind: "markup", attribute: "data-min-phone-digits",
    label: "data-min-phone-digits", remedy: "Remove it: the address service checks the phone." }),
  Object.freeze({ id: "google_maps", kind: "script", pattern: /\bgoogleMaps\s*:/,
    label: "nextConfig.googleMaps", remedy: "Remove it: 0.5 has no Google address autocomplete (addressConfig.enableAutocomplete is the NextCommerce one)." }),
  Object.freeze({ id: "upsell_accepted_event", kind: "script", pattern: /\.on\(\s*(["'`])upsell:accepted\1/,
    label: "a next.on('upsell:accepted') listener", remedy: "Listen for upsell:added." }),
  Object.freeze({ id: "package_swapped_event", kind: "script", pattern: /\.on\(\s*(["'`])cart:package-swapped\1/,
    label: "a next.on('cart:package-swapped') listener", remedy: "Remove the listener." }),
  Object.freeze({ id: "redirect_missing_event", kind: "script", pattern: /\.on\(\s*(["'`])order:redirect-missing\1/,
    label: "a next.on('order:redirect-missing') listener", remedy: "Remove the listener." }),
  Object.freeze({ id: "address_messages_event", kind: "script", pattern: /\.on\(\s*(["'`])address:messages-loaded\1/,
    label: "a next.on('address:messages-loaded') listener", remedy: "Remove the listener." }),
  Object.freeze({ id: "package_swapped_data_layer", kind: "script", pattern: /(["'`])dl_package_swapped\1/,
    label: "the dl_package_swapped event", remedy: "A bundle change now sends dl_remove_from_cart and dl_add_to_cart; read those." }),
  Object.freeze({ id: "fomo", kind: "script", pattern: /\bnext\s*\.\s*fomo\b/,
    label: "next.fomo()", remedy: "Remove the call: FOMO left the SDK in 0.4.37." }),
]);
