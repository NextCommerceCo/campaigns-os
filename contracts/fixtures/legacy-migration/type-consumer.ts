import {
  buildLegacyOfferRequest,
  parseLegacyMigrationInventory,
  type LegacyMigrationInventoryV0,
  type LegacyOfferIntentV0,
  type LegacyOfferCreateRequestV0,
  type LegacyProvisioningReceiptV0,
  type LegacyProvisioningWriteV0,
  type LegacyReceiptProjection,
  type Sha256Digest,
} from "@nextcommerce/campaigns-os/legacy-migration";

declare const unknownInventory: unknown;
declare const offer: LegacyOfferIntentV0;
declare const receipt: LegacyProvisioningReceiptV0;
declare const benefit: LegacyOfferIntentV0["benefit"];
declare const digest: Sha256Digest;

const inventory: LegacyMigrationInventoryV0 = parseLegacyMigrationInventory(unknownInventory);
const request: LegacyOfferCreateRequestV0 = buildLegacyOfferRequest(offer, { unit: 123 });
const projection: Promise<LegacyReceiptProjection> = import("@nextcommerce/campaigns-os/legacy-migration")
  .then(({ projectLegacyProvisioningReceipt }) => projectLegacyProvisioningReceipt(receipt));
const packageWrite: LegacyProvisioningWriteV0 = {
  operation_id: "package:create:unit", action: "package.create", resource_key: "unit",
  upstream_ids: { campaign_id: 700, package_id: 701 },
};
const incompleteOfferWrite: LegacyProvisioningWriteV0 = {
  operation_id: "offer:create:tier", action: "offer.create", resource_key: "tier",
  // @ts-expect-error offer writes require a positive typed parent campaign ID.
  upstream_ids: { offer_id: 702 },
};
// @ts-expect-error offer writes require an intent key.
const offerWriteWithoutIntent: LegacyProvisioningWriteV0 = {
  operation_id: "offer:create:tier", action: "offer.create", resource_key: "tier",
  upstream_ids: { campaign_id: 700, offer_id: 702 },
};
// @ts-expect-error voucher intents require a code.
const voucherWithoutCode: LegacyOfferIntentV0 = { intent_key: "voucher", name: "Voucher", offer_type: "voucher", condition: { type: "any", all_packages: false, package_keys: ["unit"] }, benefit };
// @ts-expect-error any conditions cannot carry a numeric count value.
const anyWithCount: LegacyOfferIntentV0 = { intent_key: "any", name: "Any", offer_type: "offer", condition: { type: "any", value: 1, all_packages: false, package_keys: ["unit"] }, benefit };
// @ts-expect-error terminal receipts require applied_at and a numeric campaign_id.
const incompleteTerminalReceipt: LegacyProvisioningReceiptV0 = { schema_version: "campaigns-os-legacy-provisioning-receipt/v0", store: "store.example.com", migration_id: "migration", inventory_hash: digest, preview_hash: digest, state: "provisioned", created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z", campaign_id: null, writes: [] };

void inventory;
void request;
void projection;
void packageWrite;
void incompleteOfferWrite;
void offerWriteWithoutIntent;
void voucherWithoutCode;
void anyWithCount;
void incompleteTerminalReceipt;
