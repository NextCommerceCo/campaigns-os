import {
  buildLegacyOfferRequest,
  parseLegacyMigrationInventory,
  type LegacyMigrationInventoryV0,
  type LegacyOfferIntentV0,
  type LegacyOfferCreateRequestV0,
  type LegacyProvisioningReceiptV0,
  type LegacyReceiptProjection,
} from "@nextcommerce/campaigns-os/legacy-migration";

declare const unknownInventory: unknown;
declare const offer: LegacyOfferIntentV0;
declare const receipt: LegacyProvisioningReceiptV0;

const inventory: LegacyMigrationInventoryV0 = parseLegacyMigrationInventory(unknownInventory);
const request: LegacyOfferCreateRequestV0 = buildLegacyOfferRequest(offer, { unit: 123 });
const projection: Promise<LegacyReceiptProjection> = import("@nextcommerce/campaigns-os/legacy-migration")
  .then(({ projectLegacyProvisioningReceipt }) => projectLegacyProvisioningReceipt(receipt));

void inventory;
void request;
void projection;
