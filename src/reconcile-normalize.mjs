/**
 * Raw observed Admin API envelopes -> canonical observed state.
 *
 * Everything the wire does that the differ should not have to know about is
 * absorbed here: pagination envelopes, the {code,name} vs {code,label} key
 * asymmetry, the three shapes of available_shipping_countries, and the
 * prices[]-vs-scalar-price package asymmetry.
 *
 * Also the redaction boundary: `api_key` is dropped here, before any value
 * reaches a differ or a serializer, so no downstream code can emit it.
 *
 * Contract: docs/reconcile-comparison-matrix-v0.md
 */

export const RECONCILE_NORMALIZE_SCHEMA_VERSION = "campaigns-os-reconcile-normalize/v0";

/** Fields stripped from observed state and never carried forward. */
export const REDACTED_FIELDS = Object.freeze(["api_key"]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function nfcTrim(value) {
  if (value === undefined || value === null) return null;
  return String(value).normalize("NFC").trim();
}

/**
 * Money as an exact decimal string. Never parsed as a float: 0.1 + 0.2 has no
 * place anywhere near a price comparison.
 */
export function normalizeMoney(value) {
  if (!present(value)) return null;
  const raw = String(value).trim().replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  const cents = `${fraction}00`.slice(0, 2);
  return `${negative ? "-" : ""}${whole || "0"}.${cents}`;
}

/**
 * Extract comparable codes from any of the shapes this API and its specs use:
 * ["US"], [{code:"US",name:"United States"}], [{code,label}], "US,CA".
 * Returns a sorted, de-duplicated array so comparison is order-insensitive.
 */
export function normalizeCodeSet(value) {
  if (value === undefined || value === null) return [];
  const raw = typeof value === "string" ? value.split(",") : array(value);
  const codes = raw
    .map((item) => {
      if (item === null || item === undefined) return null;
      if (typeof item === "object") return item.code ?? item.value ?? null;
      return item;
    })
    .map((code) => nfcTrim(code))
    .filter((code) => present(code));
  return [...new Set(codes)].sort();
}

/** Unwrap `{next, previous, results}`; tolerate a bare array defensively. */
export function unwrapEnvelope(payload) {
  if (Array.isArray(payload)) {
    return { results: payload, paginated: false, has_more: false };
  }
  if (payload && Array.isArray(payload.results)) {
    return {
      results: payload.results,
      paginated: true,
      has_more: present(payload.next),
    };
  }
  return { results: [], paginated: false, has_more: false, malformed: true };
}

/** Campaign retrieve payload -> canonical settings. Drops redacted fields. */
export function normalizeCampaign(payload) {
  if (!payload || typeof payload !== "object") return null;
  const currency = nfcTrim(payload.currency);
  return {
    id: Number.isInteger(payload.id) ? payload.id : null,
    name: nfcTrim(payload.name),
    currency,
    additional_currencies: normalizeCodeSet(payload.additional_currencies),
    language: nfcTrim(payload.language),
    available_shipping_countries: normalizeCodeSet(payload.available_shipping_countries),
    available_payment_methods: normalizeCodeSet(payload.available_payment_methods),
    available_express_payment_methods: normalizeCodeSet(payload.available_express_payment_methods),
    // Observable, never judged — carried as evidence.
    paypal_account_id: payload.paypal_account_id ?? null,
    statement_descriptor: payload.statement_descriptor ?? null,
    payment_gateway_group: {
      id: payload.payment_gateway_group_id ?? null,
      name: nfcTrim(payload.payment_gateway_group_name),
    },
  };
}

/**
 * Package payload -> canonical package. `prices[]` is keyed by currency; a
 * scalar `price` is tolerated and lifted into the same shape.
 *
 * `interval`/`interval_count` are carried as evidence but deliberately kept out
 * of any comparable position: the API populates them even when is_recurring is
 * false, so comparing them reports every one-time package as monthly.
 */
export function normalizePackage(item) {
  if (!item || typeof item !== "object") return null;
  const prices = {};
  if (Array.isArray(item.prices)) {
    for (const entry of item.prices) {
      const code = nfcTrim(entry?.currency);
      if (!present(code)) continue;
      prices[code] = {
        price: normalizeMoney(entry?.price),
        price_recurring: normalizeMoney(entry?.price_recurring),
      };
    }
  } else if (present(item.price)) {
    prices["*"] = { price: normalizeMoney(item.price), price_recurring: null };
  }
  return {
    id: Number.isInteger(item.id) ? item.id : null,
    name: nfcTrim(item.name),
    prices,
    is_recurring: item.is_recurring === true,
    product_sku: nfcTrim(item.product_sku),
    product_variant_id: item.product_variant_id ?? null,
    product_id: item.product_id ?? null,
    evidence: {
      interval: item.interval ?? null,
      interval_count: item.interval_count ?? null,
    },
  };
}

/** Product payload -> variant ids by sku, for corroborating package bindings. */
export function normalizeProducts(payload) {
  const { results } = unwrapEnvelope(payload);
  const variants = [];
  for (const product of results) {
    for (const variant of array(product?.variants)) {
      variants.push({
        variant_id: variant?.id ?? null,
        product_id: product?.id ?? null,
        sku: nfcTrim(variant?.sku),
      });
    }
  }
  return { result_count: results.length, variants };
}

export function normalizeGatewayGroups(payload) {
  const { results } = unwrapEnvelope(payload);
  return results.map((group) => ({
    id: group?.id ?? null,
    name: nfcTrim(group?.name),
    available_currencies: normalizeCodeSet(group?.available_currencies),
    available_payment_methods: normalizeCodeSet(group?.available_payment_methods),
  }));
}

/**
 * Whole snapshot. `partial` is the honest signal that downstream must resolve to
 * `inconclusive` rather than reporting absences as differences.
 */
export function normalizeSnapshot({ campaign, packages, products, gatewayGroups } = {}) {
  const normalizedCampaign = normalizeCampaign(campaign);
  const packageEnvelope = unwrapEnvelope(packages);
  const normalizedPackages = packageEnvelope.results
    .map((item) => normalizePackage(item))
    .filter(Boolean)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  const missing = [];
  if (!normalizedCampaign) missing.push("campaign");
  if (packages === undefined || packageEnvelope.malformed) missing.push("packages");

  return {
    schema_version: RECONCILE_NORMALIZE_SCHEMA_VERSION,
    campaign: normalizedCampaign,
    packages: normalizedPackages,
    packages_have_more: packageEnvelope.has_more,
    products: products === undefined ? null : normalizeProducts(products),
    gateway_groups: gatewayGroups === undefined ? null : normalizeGatewayGroups(gatewayGroups),
    partial: missing.length > 0,
    missing_resources: missing,
  };
}
