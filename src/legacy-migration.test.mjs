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

test("normalization gives equivalent keyed-list ordering the same hash", async () => {
  const canonical = normalizeLegacyMigrationInventory(fixture("valid-inventory.v0.json"));
  const reordered = normalizeLegacyMigrationInventory(fixture("equivalent-ordering.v0.json"));
  assert.deepEqual(reordered, canonical);
  assert.equal(await hashLegacyMigrationArtifact(reordered), await hashLegacyMigrationArtifact(canonical));
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

test("Offer request builder resolves stable package keys and carries no local keys", () => {
  const intent = fixture("valid-inventory.v0.json").target.offer_intents[0];
  assert.deepEqual(buildLegacyOfferRequest(intent, { "widget-unit": 701 }), {
    name: "Widget - Buy 2 - 10%",
    offer_type: "offer",
    condition: { type: "count", all_packages: false, package_ids: [701], value: 2 },
    benefit: { type: "package_percentage", value: "10.00", price_rounding: "0.95" },
  });
  assert.throws(() => buildLegacyOfferRequest(intent, {}), /unresolved package key/);
});

test("Offer readback comparator projects write-only package_ids from condition.packages", () => {
  const intent = fixture("valid-inventory.v0.json").target.offer_intents[0];
  const request = buildLegacyOfferRequest(intent, { "widget-unit": 701 });
  const result = compareLegacyOfferReadback(request, {
    name: request.name, offer_type: "offer",
    condition: { type: "count", value: 2, all_packages: false, packages: [{ id: 701 }] },
    benefit: request.benefit,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.field === "condition.package_ids").status, "match");
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
  assert.equal(compareLegacyPackageReadback({ product_variant_ids: [10], price: "49.95" }, { product_variant_id: 10, prices: [{ currency: "USD", price: "49.95" }] }, { currency: "USD" }).ok, true);
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
});
