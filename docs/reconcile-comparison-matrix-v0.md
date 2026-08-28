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
4. **Package price is a list price.** Offers are applied downstream and are not part of this
   observation source. See "Offers are out of scope for this source" below.

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

### A selection entry is the unit, not a package

A page may reference the same package `ref_id` more than once at different quantities. That is
how a bundle picker is expressed — 1x / 2x / 3x of one SKU as three choices, with campaign
offers supplying the tier discounts. In the reference spec the checkout page carries six
selection entries against four live packages, three of them ref_id 1 at qty 1, 2, and 3.

**Entries are never de-duplicated by `ref_id`.** Collapsing them destroys the picker and
silently drops every option but the first. Many entries binding to one live package is normal
and expected, not a duplicate to be cleaned up.

The two levels are compared differently:

- **Entry level** (`selection[page#refxqty]`) — binding and quantity, once per entry.
- **Package level** (`package[ref]`) — name, SKU, price, recurrence, once per referenced live
  package. Comparing these per entry would triple-count one package's price.

### Quantity is spec-side, not an API gap

Quantity belongs to the selection entry: how many units this picker option adds. It is **not**
a property of the live package, and the Admin API is correct not to expose one. It is recorded
as asserted structure with verdict `not_asserted` — reported, never judged, and never counted
as missing coverage. An earlier revision of this matrix wrongly filed it as an unsupported API
field; that conflated a Map-level concept with a wire-level gap.

| Field | Level | Desired path | Spec asserts? | Observed path | Normalization | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| binding | entry | `…packages[].ref_id` | yes | `results[].id` | `id_exact` | `matched` / `unresolved_binding` |
| qty | entry | `…packages[].qty` | yes | — | — | `not_asserted` (spec-side selection structure) |
| name | package | `…packages[].name` | yes | `results[].name` | `nfc_trim` | `matched` / `changed` |
| price | package | `…packages[].price` | yes | `results[].prices[]` by `currency` | `money` + `currency_map` | `matched` / `changed` / `missing_live` |
| product SKU | package | `…packages[].product_sku` | yes | `results[].product_sku` | `nfc_trim` | `matched` / `changed` |
| recurrence | package | `…packages[].is_recurring` (absent ⇒ one-time) | yes | `results[].is_recurring` | boolean | `matched` / `changed` |
| product variant | package | — | no | `results[].product_variant_id` | `id_exact` | `not_asserted`; corroborates against `variants[].id` |
| interval | package | — | no | `results[].interval` | — | **Never compared.** Populated even when `is_recurring` is false; comparing it reports every one-time package as monthly. Evidence only. |

A live package referenced by no selection entry is `extra_live`. A spec entry whose `ref_id`
resolves to no live package yields one `unresolved_binding` row and **no** package-level rows —
six field failures for one missing package buries the finding.

## Resource-level rows

### Offers are out of scope for this observation source

The reference spec asserts seven offers, including the always-on "Buy 1 Get 50%" that sets
package 1's effective price. This reconciler does not evaluate them, for one reason only:
**Admin API Offers endpoints are still in development.** Offers are readable today from the
storefront Campaign Retrieve API — a different observation source than this reconciler consumes.

So `unsupported` here means "not available from *this* source *yet*", not "unknowable". When
the Admin endpoints land, offers become ordinary comparable rows and this section shrinks to a
normal matrix entry. Nothing in the design should work around their absence, and no verdict
should be reconstructed from price arithmetic in the meantime.

The practical consequence is bounded and worth stating once rather than threading through every
row: **package prices here are list prices.** What a customer is charged depends on the offer
layer this source does not carry. Price rows are labelled `basis: "list"` so that is legible on
the report, and the asserted-offer count is reported so the scope limit is a number rather than
a footnote.

| Resource | Spec asserts? | Observable from this source? | Verdict | Note |
| --- | --- | --- | --- | --- |
| Offers | yes — 7 in the reference spec | not yet | `unsupported` | Admin endpoints in development; readable today via storefront Campaign Retrieve. |
| Campaign shipping methods | yes — 2 in the reference spec | no | `unsupported` | Shipping API is global and read-only, with no campaign association. |
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
