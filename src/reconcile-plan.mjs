/**
 * CampaignSpec -> observation descriptors.
 *
 * Pure planning: decides WHAT must be observed and WHAT the spec actually
 * asserts, with no network access and no knowledge of how observation happens.
 * Transport lives outside this package.
 *
 * The authority axis is the spec's own `_provenance` (ops/api/derived/legacy).
 * We consume it rather than inventing a parallel ownership vocabulary — a field
 * declared ops-owned is authored by an operator and is not the API's to contradict.
 *
 * Contract: docs/reconcile-comparison-matrix-v0.md
 */

export const RECONCILE_PLAN_SCHEMA_VERSION = "campaigns-os-reconcile-plan/v0";

/** Settings rows the matrix evaluates, in report order. */
export const SETTINGS_FIELDS = Object.freeze([
  "name",
  "currency",
  "additional_currencies",
  "language",
  "available_shipping_countries",
  "available_payment_methods",
  "available_express_payment_methods",
]);

/** Observable but inexpressible in CampaignSpec -> always `not_asserted`. */
export const NOT_ASSERTED_SETTINGS = Object.freeze([
  "paypal_account_id",
  "statement_descriptor",
  "payment_gateway_group",
]);

/** Asserted (or assertable) but with no API surface -> always `unsupported`. */
export const UNSUPPORTED_RESOURCES = Object.freeze([
  "offers",
  "quantity_tier_pricing",
  "campaign_shipping_methods",
]);

/** Package fields compared once a binding resolves. */
export const PACKAGE_FIELDS = Object.freeze([
  "name",
  "price",
  "product_sku",
  "is_recurring",
]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/**
 * `_provenance` declares owned paths as glob-ish strings ("campaign.*",
 * "funnels.*.pages.*.packages.*.price"). Match a concrete dotted path against
 * one, treating `*` as a single-segment wildcard.
 */
function provenanceMatches(pattern, path) {
  const patternParts = String(pattern).split(".");
  const pathParts = String(path).split(".");
  if (patternParts.length > pathParts.length) return false;
  for (let index = 0; index < patternParts.length; index += 1) {
    if (patternParts[index] === "*") continue;
    if (patternParts[index] !== pathParts[index]) return false;
  }
  // A trailing wildcard-free pattern must match the whole path.
  return patternParts.length === pathParts.length
    || patternParts[patternParts.length - 1] === "*";
}

export function authorityForPath(provenance, path) {
  for (const axis of ["ops", "api", "derived", "legacy"]) {
    for (const pattern of array(provenance?.[axis])) {
      if (provenanceMatches(pattern, path)) return axis;
    }
  }
  return "unknown";
}

/** Collect distinct packages across all funnel pages, keyed by ref_id. */
export function collectSpecPackages(spec) {
  const byRef = new Map();
  for (const funnel of array(spec?.funnels)) {
    for (const page of array(funnel?.pages)) {
      for (const pkg of array(page?.packages)) {
        const ref = pkg?.ref_id ?? pkg?.package_id;
        if (!present(ref)) continue;
        const key = String(ref);
        if (!byRef.has(key)) byRef.set(key, pkg);
      }
    }
  }
  return [...byRef.entries()]
    .map(([ref_id, pkg]) => ({ ref_id, spec: pkg }))
    .sort((a, b) => a.ref_id.localeCompare(b.ref_id, "en", { numeric: true }));
}

/**
 * Build the observation plan. Returns descriptors only — never values fetched,
 * never a verdict.
 */
export function planReconciliation(spec) {
  const provenance = spec?._provenance ?? {};
  const campaign = spec?.campaign ?? {};

  const settings = SETTINGS_FIELDS.map((field) => {
    const specPath = field === "additional_currencies"
      ? "campaign.available_currencies"
      : `campaign.${field}`;
    return {
      field,
      spec_path: specPath,
      asserted: present(campaign?.[field])
        || (field === "additional_currencies" && Array.isArray(campaign?.available_currencies)),
      authority: authorityForPath(provenance, specPath),
    };
  });

  const packages = collectSpecPackages(spec).map(({ ref_id, spec: pkg }) => ({
    ref_id,
    spec_path: `funnels.*.pages.*.packages.${ref_id}`,
    asserted_fields: PACKAGE_FIELDS.filter((field) => {
      if (field === "is_recurring") return true; // absent means one-time, which is an assertion
      if (field === "price") return present(pkg?.price);
      return present(pkg?.[field]);
    }),
    // Asserted by the spec, unobservable on the wire. Recorded so coverage shows it.
    unobservable_fields: present(pkg?.qty) ? ["qty"] : [],
    authority: authorityForPath(provenance, "funnels.*.pages.*.packages.*.price"),
  }));

  const offers = array(spec?.offers);
  const shippingMethods = array(spec?.shipping_methods);

  return {
    schema_version: RECONCILE_PLAN_SCHEMA_VERSION,
    campaign_ref_id: campaign?.ref_id ?? null,
    settings,
    not_asserted_settings: [...NOT_ASSERTED_SETTINGS],
    packages,
    unsupported: {
      offers: {
        asserted_count: offers.length,
        observable: false,
        provenance: "no Offers surface on the Admin API (coming soon)",
      },
      quantity_tier_pricing: {
        // Tiers are expressed as offers with a count condition.
        asserted_count: offers.filter((offer) => offer?.condition?.type === "count").length,
        observable: false,
        provenance: "tier pricing is expressed via dashboard Offers, which have no API surface",
      },
      campaign_shipping_methods: {
        asserted_count: shippingMethods.length,
        observable: false,
        provenance: "shipping API is global and read-only, with no campaign association",
      },
    },
    // Any asserted offer means observed package prices are not effective prices.
    price_basis: "pre_offer",
    offers_affect_price: offers.length > 0,
  };
}
