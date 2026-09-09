export type Sha256Digest = `sha256:${string}`;
export type LegacyMigrationAction = "campaign.create" | "package.create" | "shipping_method.create" | "offer.create";
export type LegacyMigrationReceiptState = "applying" | "provisioned" | "awaiting_manual_configuration" | "failed" | "reconciliation_required";

export interface LegacyOfferIntentV0 {
  intent_key: string;
  name: string;
  offer_type: "offer" | "voucher";
  code?: string;
  condition: { type: "any" | "count"; value?: number | null; all_packages: false; package_keys: string[] };
  benefit: { type: "package_percentage" | "shipping_percentage" | "order_percentage"; value: string; price_rounding?: "0.00" | "0.95" | "0.97" | "0.99" | null };
}

export interface LegacyOfferCreateRequestV0 {
  name: string;
  offer_type: "offer" | "voucher";
  code?: string;
  condition: { type: "any" | "count"; value?: number; all_packages: false; package_ids: number[] };
  benefit: { type: LegacyOfferIntentV0["benefit"]["type"]; value: string; price_rounding?: NonNullable<LegacyOfferIntentV0["benefit"]["price_rounding"]> };
}

export interface LegacyOfferReadbackV0 {
  name?: string; offer_type?: string; code?: string;
  condition?: { type?: string; value?: number | null; all_packages?: boolean; packages?: Array<{ id?: number }> };
  benefit?: { type?: string; value?: string | number; price_rounding?: string | null };
}

export interface LegacyPackageCreateRequestV0 { product_id?: number; product_variant_ids: number[]; price: string }
export interface LegacyPackageReadbackV0 { product_id?: number; product_variant_id?: number; prices?: Array<{ currency?: string; price?: string | number }> }

export interface LegacyMigrationInventoryV0 {
  schema_version: "campaigns-os-legacy-migration-inventory/v0";
  migration_id: string;
  source: { campaign_id: number; sdk_version: string };
  target: {
    campaign: {
      name: string; currency: string; language: string; payment_gateway_group_id: number;
      additional_currencies?: string[]; available_payment_methods?: string[];
      available_express_payment_methods?: string[]; available_shipping_countries?: string[];
      statement_descriptor?: string;
    };
    packages: Array<{
      package_key: string; name: string; product_id: number; product_variant_id: number; price: string;
      price_recurring?: string; interval?: string; interval_count?: number;
    }>;
    shipping_methods: Array<{ shipping_key: string; shipping_method: string; price: string }>;
    offer_intents: LegacyOfferIntentV0[];
    authorized_domains: string[];
  };
}

export interface LegacyProvisioningOperationV0 {
  operation_id: string; action: Exclude<LegacyMigrationAction, "offer.create">;
  resource_key: string; depends_on?: string; request: Record<string, unknown>;
}

export interface LegacyProvisioningPlanV0 {
  schema_version: "campaigns-os-legacy-provisioning-plan/v0";
  store: string; migration_id: string; inventory_hash: Sha256Digest; preview_hash: Sha256Digest;
  source: LegacyMigrationInventoryV0["source"];
  operations: LegacyProvisioningOperationV0[];
  offer_intents: LegacyOfferIntentV0[];
  authorized_domains: string[];
}

export interface LegacyProvisioningWriteV0 {
  operation_id: string; action: LegacyMigrationAction; resource_key: string; intent_key?: string;
  upstream_ids: { campaign_id: number | null; package_id?: number | null; shipping_method_id?: number | null; offer_id?: number | null };
  readback?: Record<string, unknown>; audit_key?: string;
}

export interface LegacyProvisioningReceiptV0 {
  schema_version: "campaigns-os-legacy-provisioning-receipt/v0";
  store: string; migration_id: string; inventory_hash: Sha256Digest; preview_hash: Sha256Digest;
  state: LegacyMigrationReceiptState; created_at: string; updated_at: string; applied_at?: string;
  campaign_id: number | null; writes: LegacyProvisioningWriteV0[];
  failure?: Record<string, unknown> | null;
}

export interface LegacyReadbackCheck { field: string; expected: unknown; actual: unknown; status: "match" | "mismatch" | "unprojectable"; detail?: string }
export interface LegacyReadbackComparison { ok: boolean; checks: LegacyReadbackCheck[] }
export interface LegacyReceiptProjection { campaign_id: number; package_ids: Record<string, number>; shipping_method_ids: Record<string, number>; offer_ids: Record<string, number>; offer_intent_keys: string[]; plan_hash: Sha256Digest; receipt_hash: Sha256Digest; applied_at: string }

export class LegacyMigrationValidationError extends Error { issues: string[]; constructor(issues: string[]) }
export const LEGACY_MIGRATION_INVENTORY_VERSION: LegacyMigrationInventoryV0["schema_version"];
export const LEGACY_PROVISIONING_PLAN_VERSION: LegacyProvisioningPlanV0["schema_version"];
export const LEGACY_PROVISIONING_RECEIPT_VERSION: LegacyProvisioningReceiptV0["schema_version"];
export function stableCanonicalStringify(value: unknown): string;
export function hashLegacyMigrationArtifact(value: unknown): Promise<Sha256Digest>;
export function validateLegacyOfferIntent(intent: unknown, options?: { packageKeys?: Set<string> }): string[];
export function validateLegacyMigrationInventory(input: unknown): string[];
export function normalizeLegacyMigrationInventory(input: unknown): LegacyMigrationInventoryV0;
export function parseLegacyMigrationInventory(input: unknown): LegacyMigrationInventoryV0;
export function buildLegacyOfferRequest(intent: LegacyOfferIntentV0, packageIdByKey: Record<string, number>): LegacyOfferCreateRequestV0;
export function compareLegacyOfferReadback(request: LegacyOfferCreateRequestV0, readback: LegacyOfferReadbackV0): LegacyReadbackComparison;
export function compareLegacyPackageReadback(request: LegacyPackageCreateRequestV0, readback: LegacyPackageReadbackV0, options?: { currency?: string }): LegacyReadbackComparison;
export function validateLegacyProvisioningPlan(input: unknown): string[];
export function parseLegacyProvisioningPlan(input: unknown): LegacyProvisioningPlanV0;
export function validateLegacyProvisioningReceipt(input: unknown): string[];
export function parseLegacyProvisioningReceipt(input: unknown): LegacyProvisioningReceiptV0;
export function projectLegacyProvisioningReceipt(receipt: LegacyProvisioningReceiptV0): Promise<LegacyReceiptProjection>;
