import { readFile } from "node:fs/promises";

const REQUIRED_STRING_FIELDS = Object.freeze([
  "schema_version",
  "campaign.name",
  "campaign.slug",
  "candidate_base_url",
  "sdk_version",
  "gtm_container_id",
  "api_key_env",
  "expected_analytics.purchase_event",
  "known_good_disposition",
]);

// Credential detection is TERM-based, not exact-name-based: keys are
// normalized (camelCase → snake_case, kebab → snake) and any credential term
// anywhere in the key rejects a literal string value — api_key, apiKey,
// vendor-api-key, client_secret, access_token, private_key, authPassword,
// credentials. `*_env` indirection keys are not exempt from scrutiny: they
// name an env var, so their value must LOOK like one (UPPER_SNAKE name),
// otherwise the "_env" suffix would smuggle an arbitrary literal through.
const CREDENTIAL_TERMS = /(^|_)(api_?key|secrets?|tokens?|passwords?|passwd|credentials?|private_?key|auth|authorizations?)(_|$)/;
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function isCredentialKey(key) {
  const normalized = normalizeKey(key);
  if (normalized.endsWith("_env")) return false;
  return CREDENTIAL_TERMS.test(normalized);
}

// A credential-term key ending in `_env` must reference an env var by name.
function isCredentialEnvKey(key) {
  const normalized = normalizeKey(key);
  return normalized.endsWith("_env") && CREDENTIAL_TERMS.test(normalized.slice(0, -"_env".length) + "_");
}
const KNOWN_DISPOSITIONS = new Set(["ready", "ready_with_exceptions", "blocked"]);

// Loads fixture data only. Runtime credentials remain an orchestrator concern:
// fixtures name an environment variable but may never carry its secret value.
export async function loadParityFixture(path) {
  let fixture;
  try {
    fixture = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load parity fixture: ${error.message}`, { cause: error });
  }

  const errors = validateParityFixture(fixture);
  if (errors.length) {
    throw new Error(`Invalid parity fixture:\n- ${errors.join("\n- ")}`);
  }
  return fixture;
}

export function validateParityFixture(fixture) {
  if (!isObject(fixture)) return ["fixture: must be an object"];

  const errors = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!nonEmptyString(valueAt(fixture, field))) {
      errors.push(`${field}: required non-empty string`);
    }
  }

  validateConstrainedStrings(fixture, errors);

  if (!isObject(fixture.campaign?.shadow_campaign_ids)) {
    errors.push("campaign.shadow_campaign_ids: required object");
  } else {
    for (const [name, id] of Object.entries(fixture.campaign.shadow_campaign_ids)) {
      if (!positiveInteger(id)) errors.push(`campaign.shadow_campaign_ids.${name}: must be a positive integer`);
    }
    if (Object.keys(fixture.campaign.shadow_campaign_ids).length === 0) {
      errors.push("campaign.shadow_campaign_ids: must contain at least one campaign id");
    }
  }

  validateCredentialFields(fixture, errors);
  if (nonEmptyString(fixture.api_key_env) && !/^[A-Z][A-Z0-9_]*$/.test(fixture.api_key_env)) {
    errors.push("api_key_env: must be an uppercase environment variable name");
  }

  if (!Array.isArray(fixture.voucher_codes) || fixture.voucher_codes.length === 0) {
    errors.push("voucher_codes: must be a non-empty array");
  } else if (fixture.voucher_codes.some((code) => !nonEmptyString(code))) {
    errors.push("voucher_codes: every value must be a non-empty string");
  }

  if (!Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
    errors.push("scenarios: must contain at least one scenario");
  } else {
    fixture.scenarios.forEach((scenario, index) => validateScenario(
      scenario,
      index,
      fixture.campaign?.shadow_campaign_ids,
      fixture.voucher_codes,
      errors,
    ));
  }

  validateExpectedAnalytics(fixture.expected_analytics, errors);
  validateAnalyticsContract(fixture.analytics_contract, errors);
  return errors;
}

function validateConstrainedStrings(fixture, errors) {
  if (nonEmptyString(fixture.schema_version) && fixture.schema_version !== "1") {
    errors.push("schema_version: unsupported version; expected 1");
  }
  if (nonEmptyString(fixture.candidate_base_url) && !isHttpUrl(fixture.candidate_base_url)) {
    errors.push("candidate_base_url: must be a valid http(s) URL");
  }
  if (nonEmptyString(fixture.sdk_version) && !/^\d+\.\d+\.\d+$/.test(fixture.sdk_version)) {
    errors.push("sdk_version: must match MAJOR.MINOR.PATCH");
  }
  if (nonEmptyString(fixture.gtm_container_id) && !/^GTM-[A-Z0-9]+$/.test(fixture.gtm_container_id)) {
    errors.push("gtm_container_id: must match GTM-[A-Z0-9]+");
  }
  if (nonEmptyString(fixture.known_good_disposition) && !KNOWN_DISPOSITIONS.has(fixture.known_good_disposition)) {
    errors.push("known_good_disposition: must be ready, ready_with_exceptions, or blocked");
  }
}

function validateCredentialFields(value, errors, path = "", visited = new WeakSet()) {
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateCredentialFields(entry, errors, `${path}[${index}]`, visited));
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path ? `${path}.${key}` : key;
    if (isCredentialKey(key) && typeof entry === "string" && entry.length > 0) {
      errors.push(`${entryPath}: literal values are forbidden; supply credentials at runtime via api_key_env or CLI`);
    } else if (isCredentialEnvKey(key) && entry !== null
      && !(typeof entry === "string" && ENV_VAR_NAME_PATTERN.test(entry))) {
      // Any non-name value on an _env key (number, object wrapper, empty or
      // literal string) is a smuggling vector, not indirection — reject it.
      errors.push(`${entryPath}: must name an environment variable (UPPER_SNAKE), not carry a literal value`);
    }
    validateCredentialFields(entry, errors, entryPath, visited);
  }
}

function validateScenario(scenario, index, shadowCampaignIds, voucherCodes, errors) {
  const prefix = `scenarios[${index}]`;
  if (!isObject(scenario)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  for (const field of ["scenario_id", "scenario_type", "shadow_campaign", "offer", "currency"]) {
    if (!nonEmptyString(scenario[field])) errors.push(`${prefix}.${field}: required non-empty string`);
  }
  if (!positiveInteger(scenario.shadow_campaign_id)) {
    errors.push(`${prefix}.shadow_campaign_id: must be a positive integer`);
  }
  if (nonEmptyString(scenario.shadow_campaign) && isObject(shadowCampaignIds)) {
    if (!Object.hasOwn(shadowCampaignIds, scenario.shadow_campaign)) {
      errors.push(`${prefix}.shadow_campaign: must reference campaign.shadow_campaign_ids`);
    } else if (scenario.shadow_campaign_id !== shadowCampaignIds[scenario.shadow_campaign]) {
      errors.push(`${prefix}.shadow_campaign_id: must match campaign.shadow_campaign_ids.${scenario.shadow_campaign}`);
    }
  }
  if (
    nonEmptyString(scenario.voucher_code)
    && Array.isArray(voucherCodes)
    && !voucherCodes.includes(scenario.voucher_code)
  ) {
    errors.push(`${prefix}.voucher_code: must be listed in voucher_codes`);
  }

  if (scenario.scenario_type === "funnel_offer") {
    validateFunnelOfferScenario(scenario, prefix, errors);
  } else if (scenario.scenario_type === "pricing_ladder") {
    validatePricingLadderScenario(scenario, prefix, errors);
  } else if (nonEmptyString(scenario.scenario_type)) {
    errors.push(`${prefix}.scenario_type: must be funnel_offer or pricing_ladder`);
  }
}

function validateFunnelOfferScenario(scenario, prefix, errors) {
  for (const field of ["funnel_path", "voucher_code"]) {
    if (!nonEmptyString(scenario[field])) errors.push(`${prefix}.${field}: required non-empty string`);
  }
  validateRelativePath(scenario.checkout_path, `${prefix}.checkout_path`, errors, { required: true });
  // The whole path must be a valid --test-order mode: "checkout" alone, or a
  // chain of accept/decline steps ("accept", "decline", "accept-decline-accept").
  // A partially-valid path ("accept-foo") must fail at load time, not later in
  // the live driver's testOrderPaths().
  const funnelSteps = String(scenario.funnel_path || "").split("-").filter(Boolean);
  const validFunnelPath = funnelSteps.length > 0 && (
    (funnelSteps.length === 1 && funnelSteps[0] === "checkout")
    || funnelSteps.every((step) => step === "accept" || step === "decline")
  );
  if (nonEmptyString(scenario.funnel_path) && !validFunnelPath) {
    errors.push(`${prefix}.funnel_path: must be "checkout" or a chain of accept/decline steps`);
  }
  const hasOfferStep = funnelSteps.some((step) => step === "accept" || step === "decline");
  if (hasOfferStep) {
    validateRelativePath(scenario.upsell_route, `${prefix}.upsell_route`, errors, { required: true });
  } else if (scenario.upsell_route !== undefined) {
    validateRelativePath(scenario.upsell_route, `${prefix}.upsell_route`, errors);
  }

  const lineItem = scenario.expected_order_readback?.line_item;
  if (!isObject(lineItem)) {
    errors.push(`${prefix}.expected_order_readback.line_item: required object`);
  } else {
    for (const field of ["title", "price_field"]) {
      if (!nonEmptyString(lineItem[field])) errors.push(`${prefix}.expected_order_readback.line_item.${field}: required non-empty string`);
    }
    if (!positiveInteger(lineItem.quantity)) {
      errors.push(`${prefix}.expected_order_readback.line_item.quantity: must be a positive integer`);
    }
    if (typeof lineItem.is_upsell !== "boolean") {
      errors.push(`${prefix}.expected_order_readback.line_item.is_upsell: must be a boolean`);
    }
    for (const field of ["base_unit_price", "base_subtotal", "expected_line_total"]) {
      validateMoney(lineItem[field], `${prefix}.expected_order_readback.line_item.${field}`, errors);
    }
    // Both fields are OPTIONAL corpus documentation, validated only when
    // present: `dropped_voucher_line_total` records the known-bad base price a
    // negative-control replay should carry (omitting it just means the corpus
    // doesn't document that scenario's regression amount — no assertion is
    // generated from it), and `discount_amount` records the offer math.
    for (const field of ["discount_amount", "dropped_voucher_line_total"]) {
      if (lineItem[field] !== undefined) validateMoney(lineItem[field], `${prefix}.expected_order_readback.line_item.${field}`, errors);
    }
  }

  const purchase = scenario.expected_purchase;
  if (!isObject(purchase)) {
    errors.push(`${prefix}.expected_purchase: required object`);
  } else {
    for (const field of ["event", "currency"]) {
      if (!nonEmptyString(purchase[field])) errors.push(`${prefix}.expected_purchase.${field}: required non-empty string`);
    }
    // null = "present with a finite client value" without pinning the amount
    // (an unpinned checkout cart cannot honestly pin the main-order value).
    if (purchase.value !== null) {
      validateMoney(purchase.value, `${prefix}.expected_purchase.value`, errors);
    }
  }
}

function validateRelativePath(value, path, errors, { required = false } = {}) {
  if (!nonEmptyString(value)) {
    if (required) errors.push(`${path}: required non-empty relative path`);
    return;
  }
  const route = value.trim();
  // Backslashes are rejected outright: WHATWG URL resolution normalizes
  // "\\evil.test\x" to "https://evil.test/x", which would silently escape the
  // candidate origin (and leak any configured auth headers to another host).
  if (/^[a-z][a-z\d+.-]*:/i.test(route) || route.startsWith("//") || route.startsWith("#") || route.startsWith("?") || route.includes("\\")) {
    errors.push(`${path}: must be a relative path`);
  }
}

function validatePricingLadderScenario(scenario, prefix, errors) {
  if (!Array.isArray(scenario.expected_pricing) || scenario.expected_pricing.length === 0) {
    errors.push(`${prefix}.expected_pricing: must be a non-empty array`);
    return;
  }
  scenario.expected_pricing.forEach((entry, index) => {
    const entryPrefix = `${prefix}.expected_pricing[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${entryPrefix}: must be an object`);
      return;
    }
    if (!positiveInteger(entry.quantity)) errors.push(`${entryPrefix}.quantity: must be a positive integer`);
    validateMoney(entry.expected_total, `${entryPrefix}.expected_total`, errors);
  });
}

function validateExpectedAnalytics(expected, errors) {
  if (!isObject(expected)) {
    errors.push("expected_analytics: required object");
    return;
  }
  if (typeof expected.purchase_expected !== "boolean") {
    errors.push("expected_analytics.purchase_expected: must be a boolean");
  }
  const gtm = expected.candidate_inventory?.gtm;
  if (!Array.isArray(gtm) || gtm.length === 0 || gtm.some((id) => !nonEmptyString(id))) {
    errors.push("expected_analytics.candidate_inventory.gtm: must be a non-empty string array");
  }
}

function validateAnalyticsContract(contract, errors) {
  if (contract === undefined) return;
  if (!isObject(contract)) {
    errors.push("analytics_contract: must be an object");
    return;
  }
  if (contract.providers !== undefined && !isObject(contract.providers)) {
    errors.push("analytics_contract.providers: must be an object");
  }
}

function validateMoney(value, path, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push(`${path}: must be a non-negative finite number`);
  }
}

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
