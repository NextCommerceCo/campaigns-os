import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  LegacyMigrationValidationError,
  buildLegacyOfferRequest,
  compareLegacyOfferReadback,
  compareLegacyPackageReadback,
  hashLegacyMigrationArtifact,
  normalizeLegacyMigrationInventory,
  parseLegacyMigrationInventory,
  parseLegacyProvisioningPlan,
  parseLegacyProvisioningReceipt,
  projectLegacyProvisioningReceipt,
  validateLegacyMigrationInventory,
  validateLegacyOfferIntent,
  validateLegacyProvisioningPlan,
  validateLegacyProvisioningReceipt,
} from "./legacy-migration.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(root, "contracts/fixtures/legacy-migration", name), "utf8"));
const schema = (name) => JSON.parse(readFileSync(join(root, "schemas", name), "utf8"));

test("valid inventory, plan, and receipt fixtures conform to their public schemas", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const inventorySchema = schema("campaigns-os-legacy-migration-inventory.v0.schema.json");
  ajv.addSchema(inventorySchema);
  for (const [schemaName, fixtureName] of [
    ["campaigns-os-legacy-migration-inventory.v0.schema.json", "valid-inventory.v0.json"],
    ["campaigns-os-legacy-provisioning-plan.v0.schema.json", "valid-plan.v0.json"],
    ["campaigns-os-legacy-provisioning-receipt.v0.schema.json", "receipt-with-offers.v0.json"],
  ]) {
    const validate = schemaName === "campaigns-os-legacy-migration-inventory.v0.schema.json"
      ? ajv.getSchema(inventorySchema.$id)
      : ajv.compile(schema(schemaName));
    assert.equal(validate(fixture(fixtureName)), true, JSON.stringify(validate.errors));
  }
});

test("Offer percentage schema and runtime both enforce the range (0, 100]", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const inventorySchema = schema("campaigns-os-legacy-migration-inventory.v0.schema.json");
  const validate = ajv.compile(inventorySchema);
  for (const value of ["0.01", "10", "99.99", "100", "100.00"]) {
    const inventory = fixture("valid-inventory.v0.json");
    inventory.target.offer_intents[0].benefit.value = value;
    assert.equal(validate(inventory), true, `${value}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(validateLegacyMigrationInventory(inventory), [], value);
  }
  for (const value of ["0", "0.00", "100.01", "250.00"]) {
    const inventory = fixture("valid-inventory.v0.json");
    inventory.target.offer_intents[0].benefit.value = value;
    assert.equal(validate(inventory), false, value);
    assert.ok(validateLegacyMigrationInventory(inventory).some((issue) => issue.includes("benefit.value")), value);
  }
});

test("normalization gives equivalent keyed-list ordering the same hash", async () => {
  const canonical = normalizeLegacyMigrationInventory(fixture("valid-inventory.v0.json"));
  const reordered = normalizeLegacyMigrationInventory(fixture("equivalent-ordering.v0.json"));
  assert.deepEqual(reordered, canonical);
  assert.equal(await hashLegacyMigrationArtifact(reordered), await hashLegacyMigrationArtifact(canonical));
  assert.equal(await hashLegacyMigrationArtifact("portable-artifact"), await hashLegacyMigrationArtifact("portable-artifact"));
});

test("inventory validation refuses duplicate keys, dangling Offers, package merchandising, and credentials", () => {
  for (const [name, fragment] of [
    ["duplicate-keys.v0.json", "duplicate logical key"],
    ["dangling-offer.v0.json", "unresolved package key"],
    ["forbidden-package-fields.v0.json", "merchandising belongs"],
    ["credential-like-field.v0.json", "credential fields are forbidden"],
  ]) assert.ok(validateLegacyMigrationInventory(fixture(name)).some((issue) => issue.includes(fragment)), name);
});

test("parser rejects unsupported SDK family and all_packages even though the upstream API supports it", () => {
  const value = fixture("valid-inventory.v0.json");
  value.source.sdk_version = "0.4.1";
  value.target.offer_intents[0].condition.all_packages = true;
  assert.throws(() => parseLegacyMigrationInventory(value), LegacyMigrationValidationError);
});

test("named Offer validator owns every public wire invariant", () => {
  const base = fixture("valid-inventory.v0.json").target.offer_intents[0];
  const rejects = [
    [(offer) => { offer.offer_type = "other"; }, "offer_type"],
    [(offer) => { offer.offer_type = "voucher"; delete offer.code; }, "require a code"],
    [(offer) => { offer.condition.type = "count"; offer.condition.value = 0; }, "integer >= 1"],
    [(offer) => { offer.condition.type = "some"; }, "must be any or count"],
    [(offer) => { offer.benefit.type = "fixed"; }, "package_percentage"],
    [(offer) => { offer.benefit.price_rounding = "0.50"; }, "0.00, 0.95, 0.97, 0.99"],
  ];
  for (const [mutate, fragment] of rejects) {
    const offer = structuredClone(base);
    mutate(offer);
    assert.ok(validateLegacyOfferIntent(offer, { packageKeys: new Set(["widget-unit"]) }).some((issue) => issue.includes(fragment)), fragment);
  }
  for (const benefitType of ["package_percentage", "shipping_percentage", "order_percentage"]) {
    const offer = structuredClone(base);
    offer.benefit.type = benefitType;
    assert.deepEqual(validateLegacyOfferIntent(offer, { packageKeys: new Set(["widget-unit"]) }), []);
  }
});

test("inventory validator rejects malformed container, campaign, package, shipping, and domain boundaries", () => {
  assert.deepEqual(validateLegacyMigrationInventory(null), ["inventory: must be an object"]);

  const value = fixture("valid-inventory.v0.json");
  value.unexpected = true;
  value.schema_version = "wrong";
  value.migration_id = "Not Path Safe";
  value.source = { campaign_id: 0, sdk_version: "0.4.0", unexpected: true };
  value.target.unexpected = true;
  Object.assign(value.target.campaign, {
    name: "x".repeat(201), currency: "US", language: "x".repeat(17), payment_gateway_group_id: 0,
    additional_currencies: [""], statement_descriptor: "x".repeat(256), unexpected: true,
  });
  Object.assign(value.target.packages[0], {
    name: "", product_id: 0, product_variant_id: 0, price: 10,
    interval: "", interval_count: 0, unexpected: true,
  });
  value.target.shipping_methods[0] = { shipping_key: "standard", shipping_method: "", price: 5, unexpected: true };
  value.target.authorized_domains = ["https://bad.example", "TRY.EXAMPLE.COM", "try.example.com"];

  const issues = validateLegacyMigrationInventory(value).join("\n");
  for (const fragment of [
    "$.unexpected: unknown field", "schema_version: expected", "migration_id", "source.unexpected",
    "source.campaign_id", "source.sdk_version", "target.unexpected", "target.campaign.unexpected",
    "target.campaign.name", "target.campaign.currency", "target.campaign.language", "payment_gateway_group_id",
    "additional_currencies", "statement_descriptor", "target.packages[0].unexpected", "target.packages[0].name",
    "product_id", "product_variant_id", "target.packages[0].price", "interval", "interval_count",
    "target.shipping_methods[0].unexpected", "shipping_method", "authorized_domains[0]", "duplicate hostname",
  ]) assert.match(issues, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), fragment);
});

test("Offer request builder resolves stable package keys and carries no local keys", () => {
  const intent = fixture("valid-inventory.v0.json").target.offer_intents[0];
  assert.deepEqual(buildLegacyOfferRequest(intent, { "widget-unit": 701 }), {
    name: "Widget - Buy 2 - 10%",
    offer_type: "offer",
    condition: { type: "count", all_packages: false, package_ids: [701], value: 2 },
    benefit: { type: "package_percentage", value: "10.00", price_rounding: "0.95" },
  });
  assert.throws(() => buildLegacyOfferRequest(intent, {}), /unresolved package key/);

  const voucher = fixture("valid-inventory.v0.json").target.offer_intents[1];
  assert.deepEqual(buildLegacyOfferRequest(voucher, { "widget-upsell": 702 }), {
    name: "Widget Refill - 25%",
    offer_type: "voucher",
    code: "WIDGETREFILL25",
    condition: { type: "any", all_packages: false, package_ids: [702] },
    benefit: { type: "package_percentage", value: "25.00" },
  });
  assert.throws(() => buildLegacyOfferRequest(voucher, { "widget-upsell": 0 }), /positive integer/);
});

test("Offer readback comparator projects write-only package_ids from condition.packages", () => {
  const intent = fixture("valid-inventory.v0.json").target.offer_intents[0];
  const request = buildLegacyOfferRequest(intent, { "widget-unit": 701 });
  for (const value of [2, "2.0", "2.00"]) {
    const result = compareLegacyOfferReadback(request, {
      name: request.name, offer_type: "offer",
      condition: { type: "count", value, all_packages: false, packages: [{ id: 701 }] },
      benefit: request.benefit,
    });
    assert.equal(result.ok, true, String(value));
    assert.equal(result.checks.find((check) => check.field === "condition.package_ids").status, "match");
    assert.equal(result.checks.find((check) => check.field === "condition.value").status, "match");
  }

  for (const value of ["2", "3.00", "2.50", "02.00", "2e0", 2.5]) {
    const result = compareLegacyOfferReadback(request, {
      name: request.name, offer_type: "offer",
      condition: { type: "count", value, all_packages: false, packages: [{ id: 701 }] },
      benefit: request.benefit,
    });
    assert.equal(result.checks.find((check) => check.field === "condition.value").status, "mismatch", String(value));
  }
});

test("comparators mark unprojectable API fields instead of guessing", () => {
  const offer = compareLegacyOfferReadback({
    name: "A", offer_type: "offer", condition: { type: "any", all_packages: false, package_ids: [1] },
    benefit: { type: "order_percentage", value: "10.00" },
  }, { name: "A", offer_type: "offer", condition: { type: "any", all_packages: false }, benefit: { type: "order_percentage", value: "10.00" } });
  assert.equal(offer.checks.find((check) => check.field === "condition.package_ids").status, "unprojectable");
  assert.equal(offer.ok, false);

  const pkg = compareLegacyPackageReadback({ product_variant_ids: [10], price: "49.95" }, { product_variant_id: 10, prices: [{ currency: "USD", price: "49.95" }] });
  assert.equal(pkg.checks.find((check) => check.field === "price").status, "unprojectable");
  const missingPackage = compareLegacyPackageReadback({ product_variant_ids: [10], price: "49.95" }, {}, { currency: "USD" });
  assert.equal(missingPackage.checks.find((check) => check.field === "product_variant_ids").status, "unprojectable");
  assert.equal(compareLegacyPackageReadback({ product_variant_ids: [10], price: "49.95" }, { product_variant_id: 10, prices: [{ currency: "USD", price: "49.95" }] }, { currency: "USD" }).ok, true);
});

test("comparators report mismatches without collapsing them into unprojectable fields", () => {
  const offer = compareLegacyOfferReadback({
    name: "Expected", offer_type: "voucher", code: "SAVE10",
    condition: { type: "count", value: 2, all_packages: false, package_ids: [2, 1] },
    benefit: { type: "package_percentage", value: "10.00", price_rounding: "0.95" },
  }, {
    name: "Actual", offer_type: "offer", code: "WRONG",
    condition: { type: "count", value: 3, all_packages: true, packages: [{ id: 1 }, { id: 3 }, { id: null }] },
    benefit: { type: "order_percentage", value: "5.00", price_rounding: "0.99" },
  });
  assert.equal(offer.ok, false);
  assert.equal(offer.checks.some((check) => check.status === "unprojectable"), false);
  for (const field of ["name", "offer_type", "condition.package_ids", "condition.value", "condition.all_packages", "benefit.type", "benefit.value", "benefit.price_rounding", "code"])
    assert.equal(offer.checks.find((check) => check.field === field).status, "mismatch", field);

  const pkg = compareLegacyPackageReadback(
    { product_variant_ids: [10, 11], product_id: 20, price: "49.95" },
    { product_variant_id: 10, product_id: 21, prices: [{ currency: "USD", price: "39.95" }] },
    { currency: "USD" },
  );
  assert.equal(pkg.ok, false);
  assert.ok(pkg.checks.every((check) => check.status === "mismatch"));
  assert.equal(compareLegacyPackageReadback(
    { product_variant_ids: [10], price: "49.95" },
    { product_variant_id: 10, prices: [{ currency: "EUR", price: "49.95" }] },
    { currency: "USD" },
  ).checks.find((check) => check.field === "price").status, "unprojectable");
});

test("receipt validator and schema require every write to retain its parent campaign ID", () => {
  const receipt = fixture("receipt-with-offers.v0.json");
  delete receipt.writes[1].upstream_ids.campaign_id;
  assert.ok(validateLegacyProvisioningReceipt(receipt).some((issue) => issue.includes("upstream_ids.campaign_id")));

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  assert.equal(ajv.compile(schema("campaigns-os-legacy-provisioning-receipt.v0.schema.json"))(receipt), false);
});

test("runtime parsers reject schema-invalid boundary types and dangling dependencies", () => {
  const inventory = fixture("valid-inventory.v0.json");
  inventory.target.campaign.language = "e";
  inventory.target.packages[0].price_recurring = 10;
  inventory.target.offer_intents[0].benefit.value = 10;
  assert.ok(validateLegacyMigrationInventory(inventory).some((issue) => issue.includes("language")));
  assert.ok(validateLegacyMigrationInventory(inventory).some((issue) => issue.includes("price_recurring")));
  assert.ok(validateLegacyMigrationInventory(inventory).some((issue) => issue.includes("benefit.value")));

  const plan = fixture("valid-plan.v0.json");
  plan.operations[0].request = null;
  plan.operations[1].depends_on = "missing:operation";
  plan.operations[1].request.dashboard_session = "must-never-cross-the-contract";
  const planIssues = validateLegacyProvisioningPlan(plan);
  assert.ok(planIssues.some((issue) => issue.includes("request: required object")));
  assert.ok(planIssues.some((issue) => issue.includes("unresolved operation ID")));
  assert.ok(planIssues.some((issue) => issue.includes("credential fields are forbidden")));

  const receipt = fixture("receipt-with-offers.v0.json");
  receipt.state = "applying";
  receipt.campaign_id = "bad";
  receipt.writes[0].readback = [];
  receipt.writes[0].audit_key = "";
  receipt.failure = "bad";
  const receiptIssues = validateLegacyProvisioningReceipt(receipt);
  for (const fragment of ["campaign_id: must be null or", "readback: must be an object", "audit_key: must be a non-empty string", "failure: must be an object or null"])
    assert.ok(receiptIssues.some((issue) => issue.includes(fragment)), fragment);
});

test("plan validator rejects invalid top-level, operation identity, action, dependency, Offer, and domain branches", () => {
  assert.deepEqual(validateLegacyProvisioningPlan([]), ["plan: must be an object"]);
  const plan = fixture("valid-plan.v0.json");
  plan.unexpected = true;
  plan.schema_version = "wrong";
  plan.store = "";
  plan.migration_id = "Not Path Safe";
  plan.inventory_hash = "bad";
  plan.preview_hash = "bad";
  plan.source = { campaign_id: 0, sdk_version: "0.4.0" };
  plan.operations.push(structuredClone(plan.operations[1]));
  plan.operations[2].request = [];
  plan.operations[2].depends_on = "";
  plan.operations[2].resource_key = "";
  plan.operations[1].action = "offer.create";
  plan.offer_intents[0].condition.package_keys = ["missing-package"];
  plan.authorized_domains = ["https://bad.example", "TRY.EXAMPLE.COM", "try.example.com"];
  const issues = validateLegacyProvisioningPlan(plan).join("\n");
  for (const fragment of [
    "$.unexpected", "schema_version", "store", "migration_id", "inventory_hash", "preview_hash", "source",
    "operation_id: missing or duplicate", "action: unsupported action", "resource_key: missing or duplicate",
    "request: required object", "depends_on: must be a non-empty operation ID", "unresolved package key",
    "invalid hostname", "duplicate hostname",
  ]) assert.ok(issues.includes(fragment), fragment);
  assert.throws(() => parseLegacyProvisioningPlan(plan), LegacyMigrationValidationError);
});

test("receipt validation refuses ambiguous projection identities and private credentials", async () => {
  const wrongParent = fixture("receipt-with-offers.v0.json");
  wrongParent.writes[1].upstream_ids.campaign_id = 999;
  assert.ok(validateLegacyProvisioningReceipt(wrongParent).some((issue) => issue.includes("must equal the receipt campaign_id")));

  const duplicate = fixture("receipt-with-offers.v0.json");
  const duplicatePackage = structuredClone(duplicate.writes[1]);
  duplicatePackage.operation_id = "package:create:widget-unit:again";
  duplicatePackage.upstream_ids.package_id = 999;
  duplicate.writes.push(duplicatePackage);
  assert.ok(validateLegacyProvisioningReceipt(duplicate).some((issue) => issue.includes("resource_key: missing or duplicate")));
  await assert.rejects(() => projectLegacyProvisioningReceipt(duplicate), LegacyMigrationValidationError);

  const secret = fixture("receipt-with-offers.v0.json");
  secret.writes[0].readback.admin_api_token = "must-never-cross-the-contract";
  assert.ok(validateLegacyProvisioningReceipt(secret).some((issue) => issue.includes("private credential fields are forbidden")));
  assert.deepEqual(validateLegacyProvisioningReceipt(fixture("receipt-with-offers.v0.json")), []);

  const applying = fixture("receipt-with-offers.v0.json");
  applying.state = "applying";
  applying.campaign_id = null;
  delete applying.applied_at;
  assert.deepEqual(validateLegacyProvisioningReceipt(applying), []);
});

test("receipt validator covers state, timestamps, write actions, IDs, offer identities, and shipping projection", async () => {
  assert.deepEqual(validateLegacyProvisioningReceipt("bad"), ["receipt: must be an object"]);
  const invalid = fixture("receipt-with-offers.v0.json");
  invalid.unexpected = true;
  invalid.schema_version = "wrong";
  invalid.store = "";
  invalid.migration_id = "Not Path Safe";
  invalid.inventory_hash = "bad";
  invalid.preview_hash = "bad";
  invalid.state = "unknown";
  invalid.created_at = "bad";
  invalid.updated_at = "bad";
  invalid.applied_at = null;
  delete invalid.campaign_id;
  invalid.writes[0] = null;
  invalid.writes[1].operation_id = invalid.writes[2].operation_id;
  invalid.writes[1].resource_key = "";
  invalid.writes[1].action = "unknown.create";
  invalid.writes[1].upstream_ids = { campaign_id: 700, package_id: 0, extra_id: 1 };
  const duplicateOffer = structuredClone(invalid.writes[2]);
  duplicateOffer.operation_id = "offer:create:again";
  duplicateOffer.resource_key = "widget-two-pack-again";
  duplicateOffer.intent_key = "widget-two-pack";
  const invalidOffer = structuredClone(invalid.writes[2]);
  invalidOffer.operation_id = "offer:create:invalid";
  invalidOffer.resource_key = "invalid-offer";
  invalidOffer.intent_key = "";
  invalid.writes.push(duplicateOffer, invalidOffer);
  const issues = validateLegacyProvisioningReceipt(invalid).join("\n");
  for (const fragment of [
    "$.unexpected", "schema_version", "store", "migration_id", "inventory_hash", "preview_hash", "state",
    "created_at", "updated_at", "applied_at", "campaign_id: required", "writes[0]: must be an object",
    "operation_id: missing or duplicate", "resource_key: missing or duplicate", "upstream_ids.extra_id",
    "package_id: must be null or a positive integer", "action: unsupported action", "intent_key",
    "duplicate applied Offer intent",
  ]) assert.ok(issues.includes(fragment), fragment);

  const receipt = fixture("receipt-with-offers.v0.json");
  receipt.state = "awaiting_manual_configuration";
  receipt.writes.push({
    operation_id: "shipping_method:create:standard", action: "shipping_method.create", resource_key: "standard",
    upstream_ids: { campaign_id: 700, shipping_method_id: 703 },
  });
  assert.deepEqual(validateLegacyProvisioningReceipt(receipt), []);
  const projection = await projectLegacyProvisioningReceipt(receipt);
  assert.deepEqual(projection.shipping_method_ids, { standard: 703 });
});

test("plan and receipt parsers preserve portable records and receipt projection is token-free", async () => {
  assert.deepEqual(parseLegacyProvisioningPlan(fixture("valid-plan.v0.json")), fixture("valid-plan.v0.json"));
  const receipt = parseLegacyProvisioningReceipt(fixture("receipt-with-offers.v0.json"));
  assert.match(JSON.stringify(receipt), /api_key/);
  const projection = await projectLegacyProvisioningReceipt(receipt);
  assert.deepEqual(projection, fixture("expected-receipt-projection.v0.json"));
  assert.deepEqual(projection.offer_ids, { "widget-two-pack": 702 });
  assert.deepEqual(projection.offer_intent_keys, ["widget-two-pack"]);
  assert.equal(projection.plan_hash, receipt.preview_hash);
  assert.match(projection.receipt_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(projection).includes("audit-"), false);
  assert.equal(/api_key|token|secret/i.test(JSON.stringify(projection)), false);

  const applying = structuredClone(receipt);
  applying.state = "applying";
  await assert.rejects(() => projectLegacyProvisioningReceipt(applying), /must be terminal/);
});
