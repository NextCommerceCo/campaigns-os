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

/**
 * Collect package SELECTION ENTRIES across funnel pages.
 *
 * A page may reference the same package ref_id more than once at different
 * quantities — that is how a bundle picker is expressed (1x / 2x / 3x of one
 * SKU, with campaign offers supplying the tier discounts). Entries are
 * therefore NOT de-duplicated by ref_id: collapsing them destroys the picker
 * and silently drops every option but the first.
 *
 * Many entries legitimately bind to one live package. Quantity belongs to the
 * entry, not to the package.
 */
export function collectSpecPackages(spec) {
  const entries = [];
  for (const funnel of array(spec?.funnels)) {
    for (const page of array(funnel?.pages)) {
      const pageId = page?.type ?? page?.label ?? "page";
      array(page?.packages).forEach((pkg, index) => {
        const ref = pkg?.ref_id ?? pkg?.package_id;
        if (!present(ref)) return;
        entries.push({
          ref_id: String(ref),
          qty: Number.isFinite(Number(pkg?.qty)) ? Number(pkg.qty) : 1,
          page_id: String(pageId),
          entry_index: index,
          spec: pkg,
        });
      });
    }
  }
  return entries;
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

  const entries = collectSpecPackages(spec);
  const packages = entries.map((entry) => ({
    ref_id: entry.ref_id,
    qty: entry.qty,
    page_id: entry.page_id,
    // Distinct identity for a selection entry; several may share a ref_id.
    selection_id: `${entry.page_id}#${entry.ref_id}x${entry.qty}`,
    spec_path: `funnels.*.pages.${entry.page_id}.packages[${entry.entry_index}]`,
    spec_package: entry.spec,
    asserted_fields: PACKAGE_FIELDS.filter((field) => {
      if (field === "is_recurring") return true; // absent means one-time, which is an assertion
      if (field === "price") return present(entry.spec?.price);
      return present(entry.spec?.[field]);
    }),
    authority: authorityForPath(provenance, "funnels.*.pages.*.packages.*.price"),
  }));

  // Distinct live packages the entries reference. Many-to-one is normal.
  const referencedPackageIds = [...new Set(entries.map((entry) => entry.ref_id))].sort(
    (a, b) => a.localeCompare(b, "en", { numeric: true }),
  );

  const offers = array(spec?.offers);
  const shippingMethods = array(spec?.shipping_methods);

  return {
    schema_version: RECONCILE_PLAN_SCHEMA_VERSION,
    campaign_ref_id: campaign?.ref_id ?? null,
    settings,
    not_asserted_settings: [...NOT_ASSERTED_SETTINGS],
    packages,
    referenced_package_ids: referencedPackageIds,
    selection_entry_count: entries.length,
    unsupported: {
      offers: {
        asserted_count: offers.length,
        observable: false,
        provenance: "Admin API Offers endpoints are in development; offers are readable today from the storefront Campaign Retrieve API, which is a different observation source than this reconciler consumes",
      },
      campaign_shipping_methods: {
        asserted_count: shippingMethods.length,
        observable: false,
        provenance: "shipping API is global and read-only, with no campaign association",
      },
    },
    // Admin package prices are list prices; offers are applied downstream and
    // are not part of this observation source.
    price_basis: "list",
    offers_asserted: offers.length > 0,
  };
}
