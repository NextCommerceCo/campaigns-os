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

// Field names a later SDK added, each with the first version that maps it.
// They are the orders API's own names, which the SDK reads as another
// spelling of its older one (src/utils/checkout-field-names.ts, SDK_NAME):
// first_name and last_name from v0.4.39 (v0.4.40 is the same SDK), and
// phone_number from v0.4.41, whose data-attributes reference ("Field names")
// makes these the names to write and says fname/lname/phone still work. The
// older names stay in SDK_CHECKOUT_FIELD_NAMES and are valid on every
// version. A page whose SDK version is unknown is judged as an earlier SDK:
// the older name works on every version, so asking for it is always safe,
// and accepting the newer name there could pass a field that never reaches
// the order. Kept in step with version_gated_aliases in
// contracts/campaign-cart-checkout-field-contract.v0.json (a test holds the
// two equal).
export const SDK_CHECKOUT_FIELD_NAMES_SINCE = Object.freeze({
  first_name: Object.freeze({ since: "0.4.39", sdk_name: "fname" }),
  last_name: Object.freeze({ since: "0.4.39", sdk_name: "lname" }),
  phone_number: Object.freeze({ since: "0.4.41", sdk_name: "phone" }),
});

const EXACT_SDK_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

// Whether `version` is an exact released SDK version at or after `since`.
// Anything else (null, a range, a prerelease, @latest) is not: a prerelease
// sorts before its release, so 0.4.39-beta.1 does not carry 0.4.39's names.
export function sdkVersionAtLeast(version, since) {
  const have = EXACT_SDK_VERSION.exec(String(version ?? "").trim());
  const need = EXACT_SDK_VERSION.exec(String(since ?? "").trim());
  if (!have || !need) return false;
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(have[index]) - Number(need[index]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

// The version-gated entry for a field name, billing- prefix included
// ("billing-first_name" → first_name's entry), or null.
export function checkoutFieldNameSince(value) {
  let name = String(value ?? "");
  const prefix = SDK_CHECKOUT_FIELD_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (prefix) name = name.slice(prefix.length);
  if (!Object.hasOwn(SDK_CHECKOUT_FIELD_NAMES_SINCE, name)) return null;
  const entry = SDK_CHECKOUT_FIELD_NAMES_SINCE[name];
  return { name, since: entry.since, sdk_name: `${prefix || ""}${entry.sdk_name}` };
}

const exact = new Set(SDK_DATA_NEXT_ATTRIBUTES.filter((name) => !name.endsWith("-")));
const prefixes = SDK_DATA_NEXT_ATTRIBUTES.filter((name) => name.endsWith("-"));

export function isIndexedSdkAttribute(name) {
  const value = String(name || "").toLowerCase();
  return exact.has(value) || prefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

// Whether the SDK maps `value`. `sdkVersion` is the page's exact SDK
// version; without one, a version-gated name is not known (see
// SDK_CHECKOUT_FIELD_NAMES_SINCE).
export function isKnownCheckoutFieldName(value, sdkVersion = null) {
  const name = String(value ?? "");
  if (SDK_CHECKOUT_FIELD_NAMES.includes(name)
    || SDK_CHECKOUT_FIELD_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length)) return true;
  const gated = checkoutFieldNameSince(name);
  return Boolean(gated) && sdkVersionAtLeast(sdkVersion, gated.since);
}

// The Campaign Cart template placeholders, for the raw cart placeholder check
// (built_output.cart_placeholders). Generated from the SDK renderers at the
// same tag as the attribute index above, v0.4.38:
//
//   src/features/cart/cart-summary/cart-summary.renderer.ts:46-83 (bare vars)
//   src/features/cart/cart-summary/cart-summary.line-renderer.ts:150-173,
//     228-240,256-314 ({item.*} and its {line.*} alias, {property.*},
//     {discount.*})
//   src/features/cart/package-selector/package-selector.renderer.ts:26
//     ({package.<any key>})
//   src/features/cart/bundle-selector/bundle-selector.renderer.ts:37-42
//     ({bundle.<any key>})
//   src/features/cart/package-toggle/package-toggle.enhancer.ts:59-65
//     ({toggle.<any key>})
//   src/features/cart/quantity-control/quantity-control.renderer.ts:69-70
//     ({quantity}, {step})
//   src/features/cart/remove-item/remove-item.renderer.ts:26 ({quantity})
//   src/features/display/quantity-text/quantity-text.enhancer.ts:124,149
//     ({qty...} and {singular|plural})
//
// Every namespaced renderer replaces any `{<namespace>.<key>}` in its
// template (item.property.<key> and the package, bundle and toggle keys are
// open-ended; an unmapped key renders empty), so the namespace alone makes a
// token known. `{tax}` is not a cart-summary var at this tag. Regenerate the
// lists whole from the renderers when the index pin advances; never edit them
// by hand.
export const SDK_TEMPLATE_PLACEHOLDERS = Object.freeze({
  cart_summary_vars: Object.freeze([
    "subtotal",
    "total",
    "shipping",
    "shippingName",
    "shippingCode",
    "shippingOriginal",
    "shippingDiscountAmount",
    "shippingDiscountPercentage",
    "totalDiscount",
    "totalDiscountPercentage",
    "discounts",
    "currency",
    "isCalculating",
    "isEmpty",
    "itemCount",
    "totalQuantity",
    "isFreeShipping",
    "hasShippingDiscount",
    "hasDiscounts",
  ]),
  namespaces: Object.freeze(["item", "line", "discount", "property", "package", "bundle", "toggle"]),
  // Tokens the SDK substitutes in live markup, and the elements that own them.
  live_tokens: Object.freeze(["quantity", "step", "qty"]),
  // [data-next-quantity="increase|decrease|set"]: {quantity} and {step}.
  quantity_control: Object.freeze({ attribute: "data-next-quantity", values: Object.freeze(["increase", "decrease", "set"]), tokens: Object.freeze(["quantity", "step"]) }),
  // [data-next-remove-item]: {quantity} only.
  remove_item: Object.freeze({ attribute: "data-next-remove-item", tokens: Object.freeze(["quantity"]) }),
  // [data-next-quantity-text]: {qty...} and the singular/plural form.
  // `qty_forms` is the renderer's own {qty} pattern (quantity-text.enhancer.ts:
  // 124, /\{qty([*+\-]?\d*)\}/): {qty}, {qty*2}, {qty+1}, {qty-1}.
  quantity_text: Object.freeze({ attribute: "data-next-quantity-text", tokens: Object.freeze(["qty"]), qty_forms: "qty[*+\\-]?\\d*" }),
  // Item lists whose innerHTML the SDK uses as the row template or replaces
  // (cart-item-list.enhancer.ts:21-35, order-item-list.enhancer.ts:26-36).
  item_list_containers: Object.freeze(["data-next-cart-items", "data-next-order-items"]),
  item_template_selector: "data-item-template-selector",
  item_template: "data-item-template",
});

// The SDK versions whose renderer files above were verified unchanged from
// v0.4.38 (git blob ids equal at v0.4.38, v0.4.39 and v0.4.40). A page whose
// loader pins another version cannot pass the placeholder check.
export const SDK_TEMPLATE_PLACEHOLDERS_VERIFIED_PINS = Object.freeze(["0.4.38", "0.4.39", "0.4.40"]);
