#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  normalizeLegacyMigrationInventory,
  validateLegacyMigrationInventory,
  validateLegacyProvisioningPlan,
  validateLegacyProvisioningReceipt,
  projectLegacyProvisioningReceipt,
} from "../src/legacy-migration.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const load = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const inventorySchema = load("schemas/campaigns-os-legacy-migration-inventory.v0.schema.json");
const planSchema = load("schemas/campaigns-os-legacy-provisioning-plan.v0.schema.json");
const receiptSchema = load("schemas/campaigns-os-legacy-provisioning-receipt.v0.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(inventorySchema);
const validateInventorySchema = ajv.getSchema(inventorySchema.$id);
const validatePlanSchema = ajv.compile(planSchema);
const validateReceiptSchema = ajv.compile(receiptSchema);

const valid = [
  ["contracts/fixtures/legacy-migration/valid-inventory.v0.json", validateInventorySchema, validateLegacyMigrationInventory],
  ["contracts/fixtures/legacy-migration/equivalent-ordering.v0.json", validateInventorySchema, validateLegacyMigrationInventory],
  ["contracts/fixtures/legacy-migration/valid-plan.v0.json", validatePlanSchema, validateLegacyProvisioningPlan],
  ["contracts/fixtures/legacy-migration/receipt-with-offers.v0.json", validateReceiptSchema, validateLegacyProvisioningReceipt],
];
for (const [path, schemaValidator, contractValidator] of valid) {
  const value = load(path);
  assert.equal(schemaValidator(value), true, `${path}: ${JSON.stringify(schemaValidator.errors)}`);
  assert.deepEqual(contractValidator(value), [], path);
}

for (const name of ["duplicate-keys.v0.json", "dangling-offer.v0.json", "forbidden-package-fields.v0.json", "credential-like-field.v0.json"]) {
  const value = load(`contracts/fixtures/legacy-migration/${name}`);
  assert.ok(validateLegacyMigrationInventory(value).length > 0, `${name}: expected contract rejection`);
}

assert.deepEqual(
  normalizeLegacyMigrationInventory(load("contracts/fixtures/legacy-migration/valid-inventory.v0.json")),
  normalizeLegacyMigrationInventory(load("contracts/fixtures/legacy-migration/equivalent-ordering.v0.json")),
  "equivalent input ordering must normalize identically",
);
const projection = await projectLegacyProvisioningReceipt(load("contracts/fixtures/legacy-migration/receipt-with-offers.v0.json"));
assert.deepEqual(projection, load("contracts/fixtures/legacy-migration/expected-receipt-projection.v0.json"));
assert.equal(/api_key|token|secret/i.test(JSON.stringify(projection)), false, "receipt projection must be credential-free");
execFileSync(process.execPath, [
  join(root, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--target", "ES2022", "--module", "esnext", "--moduleResolution", "bundler",
  join(root, "contracts/fixtures/legacy-migration/type-consumer.ts"),
], { stdio: "inherit" });
console.log("legacy migration contract check passed");
