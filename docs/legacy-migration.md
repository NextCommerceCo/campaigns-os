# Legacy migration contract

`@nextcommerce/campaigns-os/legacy-migration` is the portable contract for
planning a bounded Campaign Cart SDK 0.3.x to 0.4.x shadow-campaign migration.
It does not connect to a store or authorize a write.

The v0 contract includes three schemas:

- `campaigns-os-legacy-migration-inventory/v0` captures an exact source
  campaign, unit-product package identities, shipping methods, wire-ready
  Offer intents, and authorized-domain intents.
- `campaigns-os-legacy-provisioning-plan/v0` records the stable preview and its
  campaign/package/shipping operations. Offer rows remain keyed intents until
  package IDs exist at apply time.
- `campaigns-os-legacy-provisioning-receipt/v0` records resource IDs and
  readback evidence, including one `offer.create` row per applied intent.

## Safety boundary

The contract contains no Admin API token, authenticated transport, session,
write executor, audit-store implementation, receipt store, rollback, or delete
operation. Credential-like field names are rejected recursively. Execution is
owned by the connector and must retain read-before-write, explicit preview and
apply, read-after-write, audit, durable receipt, and stop-on-ambiguity rules.

Package rows identify exactly one product variant. Quantity tiers, vouchers,
and post-purchase pricing are Offers, never duplicate or quantity-shaped
packages. The upstream Offers API supports `all_packages`, but this migration
contract deliberately refuses it: a migration Offer must list stable package
keys and resolve those keys to IDs immediately before apply.

## Offer application

`buildLegacyOfferRequest(intent, packageIdByKey)` produces the documented
Offers create body. It refuses unresolved keys and emits `package_ids`; it does
not leak local `intent_key` or `package_keys` into the request.

The API read shape is not the write shape. Offer `package_ids` read back under
`condition.packages[]`, while package `price` reads back under `prices[]`.
`compareLegacyOfferReadback` and `compareLegacyPackageReadback` project those
known differences. If a field cannot be projected, they return
`unprojectable`; they never infer or guess a value. Package price comparison
therefore requires the campaign currency.

## Determinism and evidence

`normalizeLegacyMigrationInventory` sorts packages, shipping methods, Offers,
Offer package keys, and domains by their logical keys. Combined with
`stableCanonicalStringify` and `hashLegacyMigrationArtifact`, equivalent input
ordering yields the same digest.

`projectLegacyProvisioningReceipt` emits token-free build evidence: campaign,
package, shipping, and Offer IDs keyed by their stable identities, applied
Offer intent keys, plan hash, receipt hash, and applied timestamp. It omits
audit keys and raw readback payloads.
