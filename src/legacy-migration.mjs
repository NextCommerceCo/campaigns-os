export const LEGACY_MIGRATION_INVENTORY_VERSION = "campaigns-os-legacy-migration-inventory/v0";
export const LEGACY_PROVISIONING_PLAN_VERSION = "campaigns-os-legacy-provisioning-plan/v0";
export const LEGACY_PROVISIONING_RECEIPT_VERSION = "campaigns-os-legacy-provisioning-receipt/v0";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SDK_03_RE = /^0\.3\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MONEY_RE = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CREDENTIAL_KEY_RE = /(?:authorization|token|secret|privatekey|adminkey|apikey|accesskey|accesstoken|clientsecret|credential|password|cookie|session)/;
const OFFER_TYPES = new Set(["offer", "voucher"]);
const CONDITION_TYPES = new Set(["any", "count"]);
const BENEFIT_TYPES = new Set(["package_percentage", "shipping_percentage", "order_percentage"]);
const PRICE_ROUNDINGS = new Set(["0.00", "0.95", "0.97", "0.99"]);
const PLAN_OPERATION_ACTIONS = new Set(["campaign.create", "package.create", "shipping_method.create"]);
const RECEIPT_STATES = new Set(["applying", "provisioned", "awaiting_manual_configuration", "failed", "reconciliation_required"]);
const TERMINAL_RECEIPT_STATES = new Set(["provisioned", "awaiting_manual_configuration"]);
const PACKAGE_MERCHANDISING_FIELDS = new Set([
  "quantity", "qty", "tiers", "coupon", "offer_price", "post_purchase_price",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isMoneyString = (value) => typeof value === "string" && MONEY_RE.test(value);

function rejectUnknownKeys(value, allowed, path, issues) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key}: unknown field`);
}

export class LegacyMigrationValidationError extends Error {
  constructor(issues) {
    super(`Legacy migration contract validation failed: ${issues.join("; ")}`);
    this.name = "LegacyMigrationValidationError";
    this.issues = issues;
  }
}

export function stableCanonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableCanonicalStringify(value[key])}`).join(",")}}`;
}

export async function hashLegacyMigrationArtifact(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : stableCanonicalStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function findCredentialFields(value, path = "$", found = [], seen = new WeakSet(), allowPublicApiKey = false) {
  if (!value || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findCredentialFields(entry, `${path}[${index}]`, found, seen, allowPublicApiKey));
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (CREDENTIAL_KEY_RE.test(normalizedKey) && !(allowPublicApiKey && normalizedKey === "apikey")) found.push(entryPath);
    findCredentialFields(entry, entryPath, found, seen, allowPublicApiKey);
  }
  return found;
}

function validateKeyedRows(rows, field, keyName, issues) {
  if (!Array.isArray(rows)) {
    issues.push(`${field}: must be an array`);
    return new Set();
  }
  const keys = new Set();
  rows.forEach((row, index) => {
    const path = `${field}[${index}].${keyName}`;
    const key = row?.[keyName];
    if (!isNonEmptyString(key) || !ID_RE.test(key)) issues.push(`${path}: must be a path-safe 1-80 character key`);
    else if (keys.has(key)) issues.push(`${path}: duplicate logical key ${JSON.stringify(key)}`);
    else keys.add(key);
  });
  return keys;
}

export function validateLegacyOfferIntent(intent, { packageKeys } = {}) {
  const issues = [];
  if (!isObject(intent)) return ["offer: must be an object"];
  rejectUnknownKeys(intent, new Set(["intent_key", "name", "offer_type", "code", "condition", "benefit"]), "offer", issues);
  if (!isNonEmptyString(intent.intent_key) || !ID_RE.test(intent.intent_key))
    issues.push("offer.intent_key: must be a path-safe 1-80 character key");
  if (!isNonEmptyString(intent.name) || intent.name.length > 128) issues.push("offer.name: must be 1-128 characters");
  if (!OFFER_TYPES.has(intent.offer_type)) issues.push("offer.offer_type: must be offer or voucher");
  if (intent.offer_type === "voucher" && (!isNonEmptyString(intent.code) || intent.code.length > 64)) issues.push("offer.code: voucher offers require a code of 1-64 characters");
  if (intent.offer_type !== "voucher" && intent.code != null) issues.push("offer.code: only voucher offers may carry a code");

  const condition = intent.condition;
  if (!isObject(condition)) issues.push("offer.condition: must be an object");
  else {
    rejectUnknownKeys(condition, new Set(["type", "value", "all_packages", "package_keys"]), "offer.condition", issues);
    if (!CONDITION_TYPES.has(condition.type)) issues.push("offer.condition.type: must be any or count");
    if (condition.all_packages !== false) issues.push("offer.condition.all_packages: must be false; migration offers require explicit package keys");
    if (condition.type === "count" && !isPositiveInteger(condition.value))
      issues.push("offer.condition.value: count requires an integer >= 1");
    if (condition.type === "any" && condition.value != null)
      issues.push("offer.condition.value: any must omit value or use null");
    if (!Array.isArray(condition.package_keys) || condition.package_keys.length === 0)
      issues.push("offer.condition.package_keys: must contain at least one package key");
    else {
      const seen = new Set();
      for (const key of condition.package_keys) {
        if (!isNonEmptyString(key) || !ID_RE.test(key)) issues.push(`offer.condition.package_keys: invalid key ${JSON.stringify(key)}`);
        else if (seen.has(key)) issues.push(`offer.condition.package_keys: duplicate key ${JSON.stringify(key)}`);
        else seen.add(key);
        if (packageKeys && !packageKeys.has(key)) issues.push(`offer.condition.package_keys: unresolved package key ${JSON.stringify(key)}`);
      }
    }
  }

  const benefit = intent.benefit;
  if (!isObject(benefit)) issues.push("offer.benefit: must be an object");
  else {
    rejectUnknownKeys(benefit, new Set(["type", "value", "price_rounding"]), "offer.benefit", issues);
    if (!BENEFIT_TYPES.has(benefit.type))
      issues.push("offer.benefit.type: must be package_percentage, shipping_percentage, or order_percentage");
    if (!isMoneyString(benefit.value) || Number(benefit.value) <= 0 || Number(benefit.value) > 100)
      issues.push("offer.benefit.value: must be a decimal percentage in (0, 100]");
    if (benefit.price_rounding != null && !PRICE_ROUNDINGS.has(benefit.price_rounding))
      issues.push("offer.benefit.price_rounding: must be 0.00, 0.95, 0.97, 0.99, or null");
  }
  return issues;
}

export function validateLegacyMigrationInventory(input) {
  const issues = [];
  if (!isObject(input)) return ["inventory: must be an object"];
  rejectUnknownKeys(input, new Set(["schema_version", "migration_id", "source", "target"]), "$", issues);
  if (input.schema_version !== LEGACY_MIGRATION_INVENTORY_VERSION)
    issues.push(`schema_version: expected ${LEGACY_MIGRATION_INVENTORY_VERSION}`);
  if (!isNonEmptyString(input.migration_id) || !ID_RE.test(input.migration_id))
    issues.push("migration_id: must be a path-safe 1-80 character id");
  if (!isObject(input.source)) issues.push("source: must be an object");
  else {
    rejectUnknownKeys(input.source, new Set(["campaign_id", "sdk_version"]), "source", issues);
    if (!isPositiveInteger(input.source.campaign_id)) issues.push("source.campaign_id: must be a positive integer");
    if (!SDK_03_RE.test(String(input.source.sdk_version ?? ""))) issues.push("source.sdk_version: must be an exact 0.3.x version");
  }
  const target = input.target;
  if (!isObject(target)) issues.push("target: must be an object");
  else rejectUnknownKeys(target, new Set(["campaign", "packages", "shipping_methods", "offer_intents", "authorized_domains"]), "target", issues);
  const campaign = target?.campaign;
  if (!isObject(campaign)) issues.push("target.campaign: must be an object");
  else {
    rejectUnknownKeys(campaign, new Set(["name", "currency", "language", "payment_gateway_group_id", "additional_currencies", "available_payment_methods", "available_express_payment_methods", "available_shipping_countries", "statement_descriptor"]), "target.campaign", issues);
    for (const field of ["name", "currency", "language"])
      if (!isNonEmptyString(campaign[field])) issues.push(`target.campaign.${field}: required non-empty string`);
    if (isNonEmptyString(campaign.name) && campaign.name.length > 200) issues.push("target.campaign.name: must be at most 200 characters");
    if (isNonEmptyString(campaign.currency) && !/^[A-Za-z]{3}$/.test(campaign.currency)) issues.push("target.campaign.currency: must be a three-letter currency code");
    if (isNonEmptyString(campaign.language) && (campaign.language.length < 2 || campaign.language.length > 16)) issues.push("target.campaign.language: must be 2-16 characters");
    if (!isPositiveInteger(campaign.payment_gateway_group_id))
      issues.push("target.campaign.payment_gateway_group_id: must be a positive integer");
    for (const field of ["additional_currencies", "available_payment_methods", "available_express_payment_methods", "available_shipping_countries"])
      if (campaign[field] !== undefined && (!Array.isArray(campaign[field]) || campaign[field].some((value) => !isNonEmptyString(value))))
        issues.push(`target.campaign.${field}: must be an array of non-empty strings`);
    if (campaign.statement_descriptor !== undefined && (!isNonEmptyString(campaign.statement_descriptor) || campaign.statement_descriptor.length > 255))
      issues.push("target.campaign.statement_descriptor: must be 1-255 characters");
  }

  const packageKeys = validateKeyedRows(target?.packages, "target.packages", "package_key", issues);
  if (Array.isArray(target?.packages)) {
    if (target.packages.length === 0) issues.push("target.packages: must contain at least one unit-product package");
    target.packages.forEach((row, index) => {
      const path = `target.packages[${index}]`;
      if (!isObject(row)) return issues.push(`${path}: must be an object`);
      rejectUnknownKeys(row, new Set(["package_key", "name", "product_id", "product_variant_id", "price", "price_recurring", "interval", "interval_count", ...PACKAGE_MERCHANDISING_FIELDS]), path, issues);
      if (!isNonEmptyString(row.name) || row.name.length > 200) issues.push(`${path}.name: must be 1-200 characters`);
      if (!isPositiveInteger(row.product_id)) issues.push(`${path}.product_id: must be a positive integer`);
      if (!isPositiveInteger(row.product_variant_id)) issues.push(`${path}.product_variant_id: must be exactly one positive integer`);
      if (!isMoneyString(row.price)) issues.push(`${path}.price: must be a non-negative decimal string with at most two places`);
      if (row.price_recurring !== undefined && !isMoneyString(row.price_recurring)) issues.push(`${path}.price_recurring: must be a non-negative decimal string with at most two places`);
      if (row.interval !== undefined && !isNonEmptyString(row.interval)) issues.push(`${path}.interval: must be a non-empty string`);
      if (row.interval_count !== undefined && !isPositiveInteger(row.interval_count)) issues.push(`${path}.interval_count: must be a positive integer`);
      for (const key of Object.keys(row))
        if (PACKAGE_MERCHANDISING_FIELDS.has(key)) issues.push(`${path}.${key}: merchandising belongs in an Offer intent, not package identity`);
    });
  }

  validateKeyedRows(target?.shipping_methods, "target.shipping_methods", "shipping_key", issues);
  if (Array.isArray(target?.shipping_methods)) target.shipping_methods.forEach((row, index) => {
    const path = `target.shipping_methods[${index}]`;
    if (!isObject(row)) return issues.push(`${path}: must be an object`);
    rejectUnknownKeys(row, new Set(["shipping_key", "shipping_method", "price"]), path, issues);
    if (!isNonEmptyString(row.shipping_method)) issues.push(`${path}.shipping_method: required non-empty string`);
    if (!isMoneyString(row.price)) issues.push(`${path}.price: must be a non-negative decimal string with at most two places`);
  });

  validateKeyedRows(target?.offer_intents, "target.offer_intents", "intent_key", issues);
  if (Array.isArray(target?.offer_intents)) target.offer_intents.forEach((intent, index) => {
    for (const issue of validateLegacyOfferIntent(intent, { packageKeys }))
      issues.push(`target.offer_intents[${index}]: ${issue.replace(/^offer\./, "")}`);
  });

  if (!Array.isArray(target?.authorized_domains)) issues.push("target.authorized_domains: must be an array");
  else {
    const domains = new Set();
    target.authorized_domains.forEach((host, index) => {
      const normalized = typeof host === "string" ? host.toLowerCase() : "";
      if (!isNonEmptyString(host) || !HOST_RE.test(normalized))
        issues.push(`target.authorized_domains[${index}]: must be a hostname without scheme, port, or path`);
      else if (domains.has(normalized)) issues.push(`target.authorized_domains[${index}]: duplicate hostname`);
      else domains.add(normalized);
    });
  }

  for (const field of findCredentialFields(input)) issues.push(`${field}: credential fields are forbidden recursively`);
  return issues;
}

function optional(source, fields) {
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, structuredClone(source[field])]));
}

export function normalizeLegacyMigrationInventory(input) {
  const issues = validateLegacyMigrationInventory(input);
  if (issues.length) throw new LegacyMigrationValidationError(issues);
  const campaign = input.target.campaign;
  return {
    schema_version: LEGACY_MIGRATION_INVENTORY_VERSION,
    migration_id: input.migration_id,
    source: { campaign_id: Number(input.source.campaign_id), sdk_version: input.source.sdk_version },
    target: {
      campaign: {
        name: campaign.name.trim(), currency: campaign.currency.trim().toUpperCase(), language: campaign.language.trim().toLowerCase(),
        payment_gateway_group_id: Number(campaign.payment_gateway_group_id),
        ...optional(campaign, ["additional_currencies", "available_payment_methods", "available_express_payment_methods", "available_shipping_countries", "statement_descriptor"]),
      },
      packages: input.target.packages.map((row) => ({
        package_key: row.package_key, name: row.name.trim(), product_id: Number(row.product_id),
        product_variant_id: Number(row.product_variant_id), price: String(row.price),
        ...optional(row, ["price_recurring", "interval", "interval_count"]),
      })).sort((a, b) => a.package_key.localeCompare(b.package_key)),
      shipping_methods: input.target.shipping_methods.map((row) => ({
        shipping_key: row.shipping_key, shipping_method: row.shipping_method.trim(), price: String(row.price),
      })).sort((a, b) => a.shipping_key.localeCompare(b.shipping_key)),
      offer_intents: input.target.offer_intents.map((intent) => ({
        intent_key: intent.intent_key, name: intent.name.trim(), offer_type: intent.offer_type,
        ...(intent.code != null ? { code: intent.code.trim() } : {}),
        condition: {
          type: intent.condition.type,
          ...(intent.condition.type === "count" ? { value: intent.condition.value } : {}),
          all_packages: false,
          package_keys: [...intent.condition.package_keys].sort(),
        },
        benefit: {
          type: intent.benefit.type, value: String(intent.benefit.value),
          ...(intent.benefit.price_rounding != null ? { price_rounding: intent.benefit.price_rounding } : {}),
        },
      })).sort((a, b) => a.intent_key.localeCompare(b.intent_key)),
      authorized_domains: input.target.authorized_domains.map((host) => host.toLowerCase()).sort(),
    },
  };
}

export const parseLegacyMigrationInventory = normalizeLegacyMigrationInventory;

export function buildLegacyOfferRequest(intent, packageIdByKey) {
  const packageKeys = new Set(Object.keys(packageIdByKey ?? {}));
  const issues = validateLegacyOfferIntent(intent, { packageKeys });
  if (issues.length) throw new LegacyMigrationValidationError(issues);
  const packageIds = intent.condition.package_keys.map((key) => packageIdByKey[key]);
  if (packageIds.some((id) => !isPositiveInteger(id)))
    throw new LegacyMigrationValidationError(["offer.condition.package_keys: every resolved package ID must be a positive integer"]);
  const condition = { type: intent.condition.type, all_packages: false, package_ids: packageIds };
  if (intent.condition.type === "count") condition.value = intent.condition.value;
  const benefit = { type: intent.benefit.type, value: String(intent.benefit.value) };
  if (intent.benefit.price_rounding != null) benefit.price_rounding = intent.benefit.price_rounding;
  return {
    name: intent.name,
    offer_type: intent.offer_type,
    ...(intent.offer_type === "voucher" ? { code: intent.code } : {}),
    condition,
    benefit,
  };
}

function comparison(field, expected, actual, status, detail) {
  return { field, expected, actual, status, ...(detail ? { detail } : {}) };
}

function equivalentCountValue(expected, actual) {
  if (expected === actual) return true;
  return isPositiveInteger(expected)
    && typeof actual === "string"
    && /^[1-9]\d*\.0+$/.test(actual)
    && Number(actual) === expected;
}

export function compareLegacyOfferReadback(request, readback) {
  const checks = [
    comparison("name", request.name, readback?.name, request.name === readback?.name ? "match" : "mismatch"),
    comparison("offer_type", request.offer_type, readback?.offer_type, request.offer_type === readback?.offer_type ? "match" : "mismatch"),
  ];
  const actualPackageIds = Array.isArray(readback?.condition?.packages)
    ? readback.condition.packages.map((row) => row?.id).filter(isPositiveInteger).sort((a, b) => a - b)
    : null;
  const expectedPackageIds = [...request.condition.package_ids].sort((a, b) => a - b);
  checks.push(comparison(
    "condition.package_ids", expectedPackageIds, actualPackageIds,
    actualPackageIds === null ? "unprojectable" : stableCanonicalStringify(expectedPackageIds) === stableCanonicalStringify(actualPackageIds) ? "match" : "mismatch",
    actualPackageIds === null ? "readback.condition.packages[] is unavailable; package scope was not guessed" : undefined,
  ));
  checks.push(comparison("condition.all_packages", false, readback?.condition?.all_packages,
    readback?.condition?.all_packages === false ? "match" : "mismatch"));
  for (const field of ["type", "value"]) {
    const expected = request.condition[field];
    if (expected !== undefined) {
      const actual = readback?.condition?.[field];
      const matches = field === "value" && request.condition.type === "count"
        ? equivalentCountValue(expected, actual)
        : expected === actual;
      checks.push(comparison(`condition.${field}`, expected, actual, matches ? "match" : "mismatch"));
    }
  }
  for (const field of ["type", "value", "price_rounding"]) {
    const expected = request.benefit[field];
    if (expected !== undefined) checks.push(comparison(`benefit.${field}`, expected, readback?.benefit?.[field], String(expected) === String(readback?.benefit?.[field]) ? "match" : "mismatch"));
  }
  if (request.offer_type === "voucher") checks.push(comparison("code", request.code, readback?.code, request.code === readback?.code ? "match" : "mismatch"));
  return { ok: checks.every((check) => check.status === "match"), checks };
}

export function compareLegacyPackageReadback(request, readback, { currency } = {}) {
  const variantIds = request.product_variant_ids;
  const checks = [];
  const actualVariantId = readback?.product_variant_id;
  checks.push(comparison("product_variant_ids", variantIds, isPositiveInteger(actualVariantId) ? [actualVariantId] : null,
    !isPositiveInteger(actualVariantId) ? "unprojectable" : variantIds.length === 1 && variantIds[0] === actualVariantId ? "match" : "mismatch",
    !isPositiveInteger(actualVariantId) ? "readback.product_variant_id is unavailable; package identity was not guessed" : undefined));
  if (request.product_id !== undefined) checks.push(comparison("product_id", request.product_id, readback?.product_id,
    String(request.product_id) === String(readback?.product_id) ? "match" : "mismatch"));
  if (!currency) {
    checks.push(comparison("price", request.price, null, "unprojectable", "campaign currency is required to select a readback prices[] row; no currency was guessed"));
  } else {
    const priceRow = Array.isArray(readback?.prices) ? readback.prices.find((row) => row?.currency === currency) : undefined;
    checks.push(comparison("price", request.price, priceRow?.price ?? null,
      priceRow ? String(request.price) === String(priceRow.price) ? "match" : "mismatch" : "unprojectable",
      priceRow ? undefined : `readback.prices[] has no ${currency} row; price was not guessed`));
  }
  return { ok: checks.every((check) => check.status === "match"), checks };
}

export function validateLegacyProvisioningPlan(input) {
  const issues = [];
  if (!isObject(input)) return ["plan: must be an object"];
  rejectUnknownKeys(input, new Set(["schema_version", "store", "migration_id", "inventory_hash", "preview_hash", "source", "operations", "offer_intents", "authorized_domains"]), "$", issues);
  if (input.schema_version !== LEGACY_PROVISIONING_PLAN_VERSION) issues.push(`schema_version: expected ${LEGACY_PROVISIONING_PLAN_VERSION}`);
  if (!isNonEmptyString(input.store)) issues.push("store: required non-empty string");
  if (!isNonEmptyString(input.migration_id) || !ID_RE.test(input.migration_id)) issues.push("migration_id: must be a path-safe 1-80 character id");
  if (!isObject(input.source) || !isPositiveInteger(input.source.campaign_id) || !SDK_03_RE.test(String(input.source.sdk_version ?? "")))
    issues.push("source: requires a positive campaign_id and exact 0.3.x sdk_version");
  else rejectUnknownKeys(input.source, new Set(["campaign_id", "sdk_version"]), "source", issues);
  for (const field of ["inventory_hash", "preview_hash"])
    if (!SHA256_RE.test(String(input[field] ?? ""))) issues.push(`${field}: must be a sha256 digest`);
  validateKeyedRows(input.offer_intents, "offer_intents", "intent_key", issues);
  const packageKeys = new Set();
  const resourceKeys = new Set();
  if (!Array.isArray(input.operations)) issues.push("operations: must be an array");
  else {
    const operationIds = new Set();
    const dependencies = [];
    input.operations.forEach((operation, index) => {
      if (!isObject(operation)) return issues.push(`operations[${index}]: must be an object`);
      rejectUnknownKeys(operation, new Set(["operation_id", "action", "resource_key", "depends_on", "request"]), `operations[${index}]`, issues);
      if (!isNonEmptyString(operation.operation_id) || operationIds.has(operation.operation_id)) issues.push(`operations[${index}].operation_id: missing or duplicate`);
      else operationIds.add(operation.operation_id);
      if (!PLAN_OPERATION_ACTIONS.has(operation.action)) issues.push(`operations[${index}].action: unsupported action`);
      const resourceIdentity = `${operation.action}:${operation.resource_key}`;
      if (!isNonEmptyString(operation.resource_key) || resourceKeys.has(resourceIdentity)) issues.push(`operations[${index}].resource_key: missing or duplicate for ${operation.action}`);
      else resourceKeys.add(resourceIdentity);
      if (!isObject(operation.request)) issues.push(`operations[${index}].request: required object`);
      if (operation.depends_on !== undefined) {
        if (!isNonEmptyString(operation.depends_on)) issues.push(`operations[${index}].depends_on: must be a non-empty operation ID`);
        else dependencies.push([index, operation.depends_on]);
      }
      if (operation.action === "package.create" && isNonEmptyString(operation.resource_key)) packageKeys.add(operation.resource_key);
    });
    for (const [index, dependency] of dependencies)
      if (!operationIds.has(dependency)) issues.push(`operations[${index}].depends_on: unresolved operation ID ${JSON.stringify(dependency)}`);
  }
  if (Array.isArray(input.offer_intents)) input.offer_intents.forEach((intent, index) => {
    for (const issue of validateLegacyOfferIntent(intent, { packageKeys })) issues.push(`offer_intents[${index}]: ${issue.replace(/^offer\./, "")}`);
  });
  if (!Array.isArray(input.authorized_domains)) issues.push("authorized_domains: must be an array");
  else {
    const domains = new Set();
    input.authorized_domains.forEach((host, index) => {
      const normalized = typeof host === "string" ? host.toLowerCase() : "";
      if (!isNonEmptyString(host) || !HOST_RE.test(normalized)) issues.push(`authorized_domains[${index}]: invalid hostname`);
      else if (domains.has(normalized)) issues.push(`authorized_domains[${index}]: duplicate hostname`);
      else domains.add(normalized);
    });
  }
  for (const field of findCredentialFields(input)) issues.push(`${field}: credential fields are forbidden recursively`);
  return issues;
}

export function parseLegacyProvisioningPlan(input) {
  const issues = validateLegacyProvisioningPlan(input);
  if (issues.length) throw new LegacyMigrationValidationError(issues);
  return structuredClone(input);
}

export function validateLegacyProvisioningReceipt(input) {
  const issues = [];
  if (!isObject(input)) return ["receipt: must be an object"];
  rejectUnknownKeys(input, new Set(["schema_version", "store", "migration_id", "inventory_hash", "preview_hash", "state", "created_at", "updated_at", "applied_at", "campaign_id", "writes", "failure"]), "$", issues);
  if (input.schema_version !== LEGACY_PROVISIONING_RECEIPT_VERSION) issues.push(`schema_version: expected ${LEGACY_PROVISIONING_RECEIPT_VERSION}`);
  if (!isNonEmptyString(input.store)) issues.push("store: required non-empty string");
  if (!isNonEmptyString(input.migration_id) || !ID_RE.test(input.migration_id)) issues.push("migration_id: must be a path-safe 1-80 character id");
  if (!RECEIPT_STATES.has(input.state)) issues.push("state: unsupported receipt state");
  for (const field of ["inventory_hash", "preview_hash"])
    if (!SHA256_RE.test(String(input[field] ?? ""))) issues.push(`${field}: must be a sha256 digest`);
  for (const field of ["created_at", "updated_at"])
    if (!ISO_INSTANT_RE.test(String(input[field] ?? ""))) issues.push(`${field}: must be an ISO-8601 UTC instant`);
  if (input.applied_at !== undefined && !ISO_INSTANT_RE.test(String(input.applied_at))) issues.push("applied_at: must be an ISO-8601 UTC instant");
  if (!Object.hasOwn(input, "campaign_id")) issues.push("campaign_id: required receipt field");
  else if (input.campaign_id !== null && !isPositiveInteger(input.campaign_id)) issues.push("campaign_id: must be null or a positive integer");
  if (TERMINAL_RECEIPT_STATES.has(input.state)) {
    if (!isPositiveInteger(input.campaign_id)) issues.push("campaign_id: terminal receipt requires a positive integer campaign ID");
    if (!ISO_INSTANT_RE.test(String(input.applied_at ?? ""))) issues.push("applied_at: terminal receipt requires an explicit apply instant");
  }
  if (!Array.isArray(input.writes)) issues.push("writes: must be an array");
  else {
    const offerKeys = new Set();
    const operationIds = new Set();
    const resourceKeys = new Set();
    input.writes.forEach((row, index) => {
      if (!isObject(row)) return issues.push(`writes[${index}]: must be an object`);
      rejectUnknownKeys(row, new Set(["operation_id", "action", "resource_key", "intent_key", "upstream_ids", "readback", "audit_key"]), `writes[${index}]`, issues);
      if (!isNonEmptyString(row.operation_id) || operationIds.has(row.operation_id)) issues.push(`writes[${index}].operation_id: missing or duplicate`);
      else operationIds.add(row.operation_id);
      const resourceIdentity = `${row.action}:${row.resource_key}`;
      if (!isNonEmptyString(row.resource_key) || resourceKeys.has(resourceIdentity)) issues.push(`writes[${index}].resource_key: missing or duplicate for ${row.action}`);
      else resourceKeys.add(resourceIdentity);
      if (row.intent_key !== undefined && (!isNonEmptyString(row.intent_key) || !ID_RE.test(row.intent_key)))
        issues.push(`writes[${index}].intent_key: must be a path-safe 1-80 character key`);
      if (row.readback !== undefined && !isObject(row.readback)) issues.push(`writes[${index}].readback: must be an object`);
      if (row.audit_key !== undefined && !isNonEmptyString(row.audit_key)) issues.push(`writes[${index}].audit_key: must be a non-empty string`);
      if (!isObject(row.upstream_ids)) issues.push(`writes[${index}].upstream_ids: must be an object`);
      else {
        rejectUnknownKeys(row.upstream_ids, new Set(["campaign_id", "package_id", "shipping_method_id", "offer_id"]), `writes[${index}].upstream_ids`, issues);
        if (!isPositiveInteger(row.upstream_ids.campaign_id))
          issues.push(`writes[${index}].upstream_ids.campaign_id: every successful write requires its positive parent campaign ID`);
        else if (input.campaign_id !== null && row.upstream_ids.campaign_id !== input.campaign_id)
          issues.push(`writes[${index}].upstream_ids.campaign_id: must equal the receipt campaign_id`);
        for (const field of ["package_id", "shipping_method_id", "offer_id"])
          if (row.upstream_ids[field] !== undefined && row.upstream_ids[field] !== null && !isPositiveInteger(row.upstream_ids[field]))
            issues.push(`writes[${index}].upstream_ids.${field}: must be null or a positive integer`);
      }
      const idField = {
        "campaign.create": "campaign_id", "package.create": "package_id",
        "shipping_method.create": "shipping_method_id", "offer.create": "offer_id",
      }[row.action];
      if (!idField) issues.push(`writes[${index}].action: unsupported action`);
      else if (!isPositiveInteger(row.upstream_ids?.[idField])) issues.push(`writes[${index}].upstream_ids.${idField}: successful write requires a positive integer ID`);
      if (row.action !== "offer.create") return;
      if (!isNonEmptyString(row.intent_key) || !ID_RE.test(row.intent_key)) issues.push(`writes[${index}].intent_key: offer.create requires a path-safe 1-80 character intent key`);
      else if (offerKeys.has(row.intent_key)) issues.push(`writes[${index}].intent_key: duplicate applied Offer intent`);
      else offerKeys.add(row.intent_key);
    });
  }
  if (input.failure !== undefined && input.failure !== null && !isObject(input.failure)) issues.push("failure: must be an object or null");
  for (const field of findCredentialFields(input, "$", [], new WeakSet(), true)) issues.push(`${field}: private credential fields are forbidden recursively`);
  return issues;
}

export function parseLegacyProvisioningReceipt(input) {
  const issues = validateLegacyProvisioningReceipt(input);
  if (issues.length) throw new LegacyMigrationValidationError(issues);
  return structuredClone(input);
}

export async function projectLegacyProvisioningReceipt(receipt) {
  const parsed = parseLegacyProvisioningReceipt(receipt);
  if (!TERMINAL_RECEIPT_STATES.has(parsed.state) || !ISO_INSTANT_RE.test(String(parsed.applied_at ?? "")))
    throw new LegacyMigrationValidationError(["applied_at: a receipt must be terminal and carry an explicit apply instant before it can become build evidence"]);
  const receiptHash = await hashLegacyMigrationArtifact(parsed);
  const offerIntentKeys = parsed.writes
    .filter((row) => row.action === "offer.create")
    .map((row) => row.intent_key)
    .sort();
  return {
    campaign_id: parsed.campaign_id,
    package_ids: Object.fromEntries(parsed.writes
      .filter((row) => row.action === "package.create")
      .map((row) => [row.resource_key, row.upstream_ids.package_id])
      .sort(([a], [b]) => a.localeCompare(b))),
    shipping_method_ids: Object.fromEntries(parsed.writes
      .filter((row) => row.action === "shipping_method.create")
      .map((row) => [row.resource_key, row.upstream_ids.shipping_method_id])
      .sort(([a], [b]) => a.localeCompare(b))),
    offer_ids: Object.fromEntries(parsed.writes
      .filter((row) => row.action === "offer.create")
      .map((row) => [row.intent_key, row.upstream_ids.offer_id])
      .sort(([a], [b]) => a.localeCompare(b))),
    offer_intent_keys: offerIntentKeys,
    plan_hash: parsed.preview_hash,
    receipt_hash: receiptHash,
    applied_at: parsed.applied_at,
  };
}
