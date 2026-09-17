// The Campaign Cart SDK attribute index, vendored for the static SDK markup
// checks (#303).
//
// Source: docs/attribute-index.md in NextCommerceCo/campaign-cart at tag
// v0.4.38 (the SDK pin every certified starter family ships today), which is
// generated from the feature manifests. Only the data-next-* names are kept:
// the checks that read this list ask "does the SDK read this data-next-*
// attribute at all", and the SDK's other attribute families (data-item-*,
// data-package-*, plain data-*) are not what an agent kit misspells.
//
// This is a hardcoded copy and says so, rather than restating the SDK in
// prose that then drifts (the partner kit's mistake): the list is regenerated
// whole from the index at a named tag, never edited by hand.
//
//   git -C ../campaign-cart show v0.4.38:docs/attribute-index.md \
//     | grep -oE '`data-[a-z0-9-]+(\s*/\s*data-[a-z0-9-]+)*`' \
//     | tr -d '`' | tr '/' '\n' | tr -d ' ' | grep '^data-next-' | sort -u
//
// A name ending in "-" (data-next-class-) is a prefix the SDK reads with any
// suffix.

export const SDK_ATTRIBUTE_INDEX_VERSION = "0.4.38";

export const SDK_DATA_NEXT_ATTRIBUTES = Object.freeze([
  "data-next-accordion",
  "data-next-accordion-panel",
  "data-next-accordion-text",
  "data-next-accordion-trigger",
  "data-next-action",
  "data-next-active",
  "data-next-await",
  "data-next-bump",
  "data-next-bundle-card",
  "data-next-bundle-display",
  "data-next-bundle-id",
  "data-next-bundle-items",
  "data-next-bundle-name",
  "data-next-bundle-price",
  "data-next-bundle-qty-for",
  "data-next-bundle-selector",
  "data-next-bundle-selector-id",
  "data-next-bundle-slot-template",
  "data-next-bundle-slot-template-id",
  "data-next-bundle-slots",
  "data-next-bundle-slots-for",
  "data-next-bundle-template",
  "data-next-bundle-template-id",
  "data-next-bundle-vouchers",
  "data-next-bundles",
  "data-next-cart-item-id",
  "data-next-cart-items",
  "data-next-cart-selector",
  "data-next-cart-summary",
  "data-next-checkout",
  "data-next-checkout-field",
  "data-next-checkout-payment",
  "data-next-checkout-review",
  "data-next-checkout-step",
  "data-next-checkout-submit",
  "data-next-class-",
  "data-next-clear-cart",
  "data-next-component",
  "data-next-component-location",
  "data-next-confirm",
  "data-next-confirm-message",
  "data-next-coupon",
  "data-next-default-property",
  "data-next-discounts",
  "data-next-display",
  "data-next-enhancer",
  "data-next-error-for",
  "data-next-exclude-property",
  "data-next-express-checkout",
  "data-next-fallback",
  "data-next-format",
  "data-next-hide",
  "data-next-id",
  "data-next-in-cart",
  "data-next-include-shipping",
  "data-next-is-upsell",
  "data-next-item-properties",
  "data-next-loading",
  "data-next-max-quantity",
  "data-next-min-quantity",
  "data-next-multiply-quantity",
  "data-next-next-url",
  "data-next-order-items",
  "data-next-package",
  "data-next-package-id",
  "data-next-package-price",
  "data-next-package-selector",
  "data-next-package-selector-id",
  "data-next-package-sync",
  "data-next-package-template",
  "data-next-package-template-id",
  "data-next-package-toggle",
  "data-next-packages",
  "data-next-payment-form",
  "data-next-payment-method",
  "data-next-payment-state",
  "data-next-product-sync",
  "data-next-property",
  "data-next-property-container",
  "data-next-quantity",
  "data-next-quantity-decrease",
  "data-next-quantity-display",
  "data-next-quantity-increase",
  "data-next-quantity-selector-id",
  "data-next-quantity-text",
  "data-next-remove-item",
  "data-next-required",
  "data-next-scroll-target",
  "data-next-scroll-threshold",
  "data-next-sdk-loading",
  "data-next-selected",
  "data-next-selection-mode",
  "data-next-selector-card",
  "data-next-selector-id",
  "data-next-shipping-id",
  "data-next-show",
  "data-next-slot-index",
  "data-next-step-number",
  "data-next-timer",
  "data-next-timer-display",
  "data-next-timer-expired",
  "data-next-toggle",
  "data-next-toggle-card",
  "data-next-toggle-container",
  "data-next-toggle-display",
  "data-next-toggle-image",
  "data-next-toggle-price",
  "data-next-toggle-template",
  "data-next-toggle-template-id",
  "data-next-tooltip",
  "data-next-tooltip-class",
  "data-next-tooltip-delay",
  "data-next-tooltip-max-width",
  "data-next-tooltip-offset",
  "data-next-tooltip-placement",
  "data-next-tracking-tag",
  "data-next-upsell",
  "data-next-upsell-action",
  "data-next-upsell-action-for",
  "data-next-upsell-context",
  "data-next-upsell-item",
  "data-next-upsell-option",
  "data-next-upsell-quantity",
  "data-next-upsell-quantity-toggle",
  "data-next-upsell-section",
  "data-next-upsell-select",
  "data-next-upsell-selector",
  "data-next-url",
  "data-next-validate",
  "data-next-variant-code",
  "data-next-variant-option",
  "data-next-variant-option-template-id",
  "data-next-variant-options",
  "data-next-variant-selector-template-id",
  "data-next-variant-selectors",
]);

// The fixed data-next-checkout-field names, from the same tag. The SDK maps a
// field to the order by this value, so an unlisted name is a silent no-op: the
// input renders, the shopper fills it, nothing reaches the order. Sources at
// v0.4.38: src/features/checkout/README.md ("Standard field names"), the
// checkout-form enhancer and its validation/persistence tables, the hosted
// payment field slots (cc-number, cvv, cc-month/cc-year and their exp-*
// spellings), payment-method, and accepts_marketing. Billing fields are the
// same names behind a "billing-" prefix and the SDK passes any billing-*
// suffix through (billing-field-routing.ts), so the prefix is accepted with
// any suffix rather than enumerated.
export const SDK_CHECKOUT_FIELD_NAMES = Object.freeze([
  "email",
  "fname",
  "lname",
  "phone",
  "address1",
  "address2",
  "city",
  "province",
  "postal",
  "country",
  "payment-method",
  "accepts_marketing",
  "cc-number",
  "cc-month",
  "cc-year",
  "exp-month",
  "exp-year",
  "cvv",
  // Legacy spellings the README at v0.4.38 still lists.
  "card-number",
  "card-expiry",
  "card-cvv",
  "card-name",
]);

export const SDK_CHECKOUT_FIELD_PREFIXES = Object.freeze(["billing-"]);

const exact = new Set(SDK_DATA_NEXT_ATTRIBUTES.filter((name) => !name.endsWith("-")));
const prefixes = SDK_DATA_NEXT_ATTRIBUTES.filter((name) => name.endsWith("-"));

export function isIndexedSdkAttribute(name) {
  const value = String(name || "").toLowerCase();
  return exact.has(value) || prefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

export function isKnownCheckoutFieldName(value) {
  const name = String(value ?? "");
  return SDK_CHECKOUT_FIELD_NAMES.includes(name)
    || SDK_CHECKOUT_FIELD_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}
