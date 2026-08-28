# Campaign Reconciliation — Comparison Matrix v0

**Status:** v0, pending approval. Frozen and hashed into every report once approved.
**Scope:** what the reconciler compares between a CampaignSpec (desired state) and an Admin
API readback (observed state), how each field is normalized, and what verdict is produced when
a field is unasserted or unobservable.

This matrix is the contract. The reconciler asserts nothing that is not listed here, and every
row it evaluates appears in the report's coverage counts — including the rows it *cannot*
evaluate. A field that is silently skipped is the failure mode this document exists to prevent.

## Provenance of the observed column

Every "observed path" below was verified against a recorded contract run, not against
documentation. The fixtures under `fixtures/reconcile/` are that run, with store identity,
hostnames, SKUs, and media URLs replaced by synthetic equivalents; envelope shapes, field
names, types, IDs, and price strings are byte-faithful to the wire. Where this matrix and the
platform docs disagree, this matrix wins — it was measured.

Four observations from that run shape the rules below:

1. **Every collection is paginated.** `{next, previous, results}` — including
   `campaigns/{id}/packages/`, which was previously assumed to be a bare array.
2. **`interval` and `interval_count` are populated even when `is_recurring` is `false`.**
   All four one-time packages in the fixture report `interval: "month"`. Recurrence must be
   read from `is_recurring` alone.
3. **Payment-method item keys differ by resource.** The campaign resource returns
   `{code, name}`; the gateway-group resource returns `{code, label}`.
4. **Package price is pre-discount.** The Offers layer that changes the effective price is not
   exposed by the API at all. See "Price is pre-Offer" below — this is the most consequential
   limitation in the matrix.

## Verdict vocabulary (closed)

| Verdict | Meaning |
| --- | --- |
| `matched` | Asserted, observed, equal under the row's normalization rule. |
| `changed` | Asserted, observed, not equal. Carries both values and the exact field path. |
| `missing_live` | Asserted, observable in principle, absent from the response. |
| `extra_live` | Present live, not asserted by the spec, where the row treats extras as reportable. |
| `unresolved_binding` | A package/product reference could not be resolved to a live entity, so no field-level comparison was attempted. |
| `unsupported` | The API has no surface for this, so it can never be observed. **Never** `missing_live`. |
| `not_asserted` | Observable, but the spec cannot or does not express it. Reported, never judged. |

Campaign outcomes: `reconciled_no_asserted_differences`, `reconciled_with_differences`,
`inconclusive`. Partial or malformed input yields `inconclusive` — never `missing_live`, which
would imply a comparison that did not happen.

## Normalization rules (applied before comparison)

| Rule | Definition |
| --- | --- |
| `nfc_trim` | Unicode NFC, trim outer whitespace. No case folding — campaign names are case-significant. |
| `code_set` | Extract `code` from each item, drop the display key (`name` **or** `label`), compare as an order-insensitive set. Absorbs the resource-key asymmetry in observation 3. |
| `money` | Decimal string compared exactly as a string after stripping a leading `+` and normalizing to two decimal places. No float parsing at any point. |
| `currency_map` | Compare per currency code; a currency asserted but absent from `prices[]` is `missing_live` for that currency only, not for the package. |
| `null_empty_equiv` | `null`, `""`, and absent are one value **only** where the row says so. Everywhere else they are distinct. |
| `id_exact` | Integer identity, no coercion from string. |

Ordering is never significant except inside `prices[]`, which is keyed by currency rather than
position.

## Campaign settings rows

Desired paths are CampaignSpec pointers; observed paths are into
`fixtures/reconcile/observed-campaign-1602-retrieve.json`.

| Field | Desired path | Spec asserts? | Observed path | Normalization | Verdict when equal / unequal |
| --- | --- | --- | --- | --- | --- |
| name | `campaign.name` | yes | `name` | `nfc_trim` | `matched` / `changed` |
| currency | `campaign.currency` | yes | `currency` | `code_set` (singleton) | `matched` / `changed` |
| additional currencies | `campaign.available_currencies` minus default | yes | `additional_currencies` | `code_set` | `matched` / `changed` |
| language | `campaign.language` | yes | `language` | `nfc_trim` | `matched` / `changed` |
| shipping countries | `campaign.available_shipping_countries` | yes | `available_shipping_countries[].code` | `code_set` | `matched` / `changed` |
| payment methods | `campaign.available_payment_methods` | yes | `available_payment_methods[].code` | `code_set` | `matched` / `changed` |
| express payment methods | `campaign.available_express_payment_methods` | yes | `available_express_payment_methods[].code` | `code_set` | `matched` / `changed` |
| PayPal account | — | no | `paypal_account_id` | `null_empty_equiv` | `not_asserted` (reported) |
| statement descriptor | — | no | `statement_descriptor` | `null_empty_equiv` | `not_asserted` (reported) |
| payment gateway group | — | **no — inexpressible** | `payment_gateway_group_id` + `_name` | `id_exact` | **`not_asserted`, fixed row.** Observable and recorded as evidence; the spec has no field for it, so the reconciler never judges it. Expressing it is future spec work, deliberately not done here. |
| storefront API key | `campaign.campaigns_api_key` | yes | `api_key` | — | **Never compared, never emitted.** Redaction rule below. |

**`available_shipping_countries` has three shapes in the wild** — a bare code array in the spec,
an array of `{code, name}` objects live, and a comma-joined string in some legacy specs. All
three collapse to a code set before comparison; the normalizer owns this, not the differ.

## Package rows

Binding runs first. A package is bound by `ref_id` → live package `id` (`id_exact`). If a
spec package has no live counterpart the whole package yields one `unresolved_binding` row and
**no field-level rows** — reporting six field mismatches for one missing package is noise that
buries the actual finding.

| Field | Desired path | Spec asserts? | Observed path | Normalization | Verdict |
| --- | --- | --- | --- | --- | --- |
| binding | `funnels[].pages[].packages[].ref_id` | yes | `results[].id` | `id_exact` | `matched` / `unresolved_binding` |
| name | `…packages[].name` | yes | `results[].name` | `nfc_trim` | `matched` / `changed` |
| price (per currency) | `…packages[].price` | yes | `results[].prices[]` keyed by `currency` | `money` + `currency_map` | `matched` / `changed` / `missing_live` per currency |
| product SKU | `…packages[].product_sku` | yes | `results[].product_sku` | `nfc_trim` | `matched` / `changed` |
| product variant binding | — | no (not expressible) | `results[].product_variant_id` | `id_exact` | `not_asserted`; corroborates against `variants[].id` in the product fixture |
| recurrence | `…packages[].is_recurring` (absent ⇒ one-time) | yes | `results[].is_recurring` | boolean | `matched` / `changed` |
| interval | — | no | `results[].interval`, `interval_count` | — | **Never compared.** Populated even when `is_recurring` is false (observation 2); comparing it would report every one-time package as monthly. Carried as evidence only. |
| quantity | `…packages[].qty` | yes | — | — | **`unsupported`, fixed row.** See below. |

### Quantity is asserted and unobservable

The spec asserts `qty` per package. The package payload has no quantity field of any kind.
This is `unsupported`, never `missing_live` — the value is not absent from a surface that could
have carried it; the surface does not exist.

**Quantity must not be inferred from price.** Dividing package price by variant unit price
recovers a *discount* ratio, not a quantity, because of the Offers layer described next. That
inference produces confident wrong answers and is explicitly forbidden.

### Price is pre-Offer — the load-bearing limitation

Package prices are **pre-discount**. The Offers layer that determines what a customer actually
pays is not exposed by the Admin API ("coming soon"), so the reconciler cannot compute or verify
an effective price.

This is more dangerous than the quantity gap, because quantity is *visibly* absent while price
is present and compares cleanly. In the reference fixture, package 1 is `79.98` in both spec and
live — a clean `matched` — while the effective price is `39.99`, set by an always-on 50% offer
the API cannot see. A reader who takes `matched` on price to mean "the customer is charged this"
is wrong, and nothing in the payload corrects them.

Therefore: **every price row carries `basis: "pre_offer"`**, and the report's campaign outcome
is annotated whenever any offer is asserted. Coverage counts must show the asserted-offer count
so the gap is a number on the report, not a footnote in this file.

## Resource-level rows

| Resource | Spec asserts? | Observable? | Verdict | Note |
| --- | --- | --- | --- | --- |
| Offers | **yes — 7 in the reference spec** | no | **`unsupported`, fixed row** | Provenance: no Offers surface, "coming soon". Asserted-but-unobservable; count appears in coverage. |
| Quantity-tier pricing (offer tiers) | yes, via `offers[]` | no | **`unsupported`, fixed row** | Expressed as offers with `condition.type: "count"`. **Never `missing_live`.** |
| Campaign shipping methods | yes — 2 in the reference spec | no | **`unsupported`, fixed row** | The shipping API is global and read-only with no campaign association. |
| Tracking / analytics config | no (`status: "unknown"`) | no | `not_asserted` | |
| Store profile fields | no (empty in spec) | n/a | `not_asserted` | Not part of the Admin campaign surface. |

## Redaction

`api_key` is never compared, never logged, and never written to a report at any tier. Two facts
make this non-optional: the observed value is a **bare 40-character alphanumeric string with no
prefix**, so any filter keyed on a `cmp_pk_` prefix silently fails to match it; and the full
report tier is written to disk. The reconciler drops the field at normalization, before any
value reaches a differ or a serializer, so no downstream code can emit what it never received.

## Report tiers

Two tiers, following the established verdict/sidecar split: a full report (gitignored, carries
observed values) and an allowlist-projected sidecar (committable, carries verdicts, counts, and
hashes but no observed values). Every report embeds `sha256:` canonical-JSON hashes of the spec,
the snapshot, and this matrix, so a verdict can always be traced to the contract that produced it.

## Coverage accounting

`coverage_complete` is true only when every row in this matrix was evaluated or explicitly
classified. Rows classed `unsupported` or `not_asserted` **do not** reduce coverage — they are
accounted, not skipped — but they are counted separately so a report can never present
"nothing to report" and "nothing was checked" as the same result.

## Open items carried into the next revision

- Cursor pagination is untested: every fixture returned `next: null`. A campaign with enough
  packages to paginate has not been observed, and the normalizer currently assumes a single page.
- `?sku=` may be exact or substring; a one-SKU fixture cannot distinguish. Product corroboration
  treats a multi-result response as `unresolved_binding` rather than guessing.
- Expressing payment gateway group in the spec is future work; until then that row stays
  `not_asserted` by construction rather than by choice.
