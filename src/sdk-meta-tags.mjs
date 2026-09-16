// The one list of CampaignSpec `sdk_hints.meta_tags` keys the Campaign Cart
// SDK does not read. Doctor (validateBuiltSdkMetaTags) and QA
// (unsupportedSdkMetaHint) both consume it, so a tag can never be "required"
// by one and "ignored" by the other: the SDK is the authority, and a spec that
// still lists one of these keys carries a stale Map page hint, not a missing
// rendered tag.
//
// Verified against the SDK source: it reads next-api-key, next-page-type,
// next-success-url, next-upsell-accept-url, next-upsell-decline-url,
// next-failure-url, next-clear-cart, next-debug and the like. It reads
// neither key below. The Map Builder export stopped emitting both; older
// specs still carry them.

export const SDK_IGNORED_META_TAGS = Object.freeze({
  "next-currency": Object.freeze({
    expected: "Campaign Cart currency from the currency URL parameter, remembered session choice, or SDK default",
    actual: "No page-level currency override to verify",
    note: "Campaign Cart does not read a next-currency meta tag; remove it from the Map's page hints. Currency behavior is optional and must be verified through the documented URL/session/default flow.",
  }),
  "next-predictive-address": Object.freeze({
    expected: "window.nextConfig.addressConfig.enableAutocomplete",
    actual: "Autocomplete config requires browser/config review",
    note: "Campaign Cart does not read a next-predictive-address meta tag; remove it from the Map's page hints. Predictive address is optional and configured through window.nextConfig.addressConfig.enableAutocomplete.",
  }),
});

// Meta names reach the consumers from spec-declared keys and from parsed HTML
// whose `name` value is not trimmed; normalize case and surrounding
// whitespace so a stray-space tag matches the intended entry.
export function normalizeSdkMetaName(name) {
  return String(name || "").trim().toLowerCase();
}

// The map entry for an SDK-ignored meta tag, or null for a tag the SDK reads.
export function sdkIgnoredMetaTag(name) {
  const normalized = normalizeSdkMetaName(name);
  return Object.hasOwn(SDK_IGNORED_META_TAGS, normalized) ? SDK_IGNORED_META_TAGS[normalized] : null;
}

// One doctor-facing line for a set of ignored tags listed on a page: names each
// tag with its note so the operator reads the reason without opening QA.
export function describeSdkIgnoredMetaTags(names) {
  return [...new Set(names.map(normalizeSdkMetaName))]
    .filter((name) => Object.hasOwn(SDK_IGNORED_META_TAGS, name))
    .map((name) => `"${name}" (${SDK_IGNORED_META_TAGS[name].note})`)
    .join("; ");
}
