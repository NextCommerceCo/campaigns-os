# Campaign reconciliation — what gets compared, and what doesn't

The reconciler takes a CampaignSpec (what the campaign is supposed to be) and an Admin API
readback (what it currently is), and reports the differences.

**The rules live in [`contracts/reconcile-comparison-matrix.v0.json`](../contracts/reconcile-comparison-matrix.v0.json).**
That file is the authority — field paths, normalization, verdicts, coverage rules — and
`scripts/check-reconcile-matrix.mjs` fails the build if the code and that file disagree. Every
report embeds the contract's sha256, so any verdict can be traced to the exact rules behind it.

This page explains the parts that are easy to get wrong. It defines nothing.

## Verdicts

`matched` · `changed` · `missing_live` · `extra_live` · `unresolved_binding` · `unsupported` ·
`not_asserted`

The two that carry weight are the last two, and they mean different things. **`unsupported`** is
"this source can't see it". **`not_asserted`** is "we're not claiming anything about it". Both
are *counted* rather than skipped, so a report can never present "nothing to report" and
"nothing was checked" as the same result.

A campaign comes out `reconciled_no_asserted_differences`, `reconciled_with_differences`, or
`inconclusive`. Partial or truncated input is always `inconclusive` — never differences, which
would imply a comparison that didn't happen.

## Four things about this API that will bite you

**1. Every collection is paginated.** `{next, previous, results}`, including
`campaigns/{id}/packages/`, which looks like it should be a bare array. Code that maps over the
response directly gets nothing.

**2. `interval` lies.** It's populated even when `is_recurring` is `false` — every one-time
package in the reference data reports `interval: "month"`. Read recurrence from `is_recurring`
alone, or you'll classify every package as monthly. The reconciler carries `interval` as
evidence and never compares it.

**3. Payment-method keys differ by resource.** The campaign returns `{code, name}`; gateway
groups return `{code, label}`. Same concept, different key. Both normalize to a set of codes.

**4. Prices are list prices.** Offers are applied downstream and this source doesn't carry
them — Admin API Offers endpoints are still in development, and offers are readable today from
the storefront Campaign Retrieve API. So a `matched` price verdict is a true statement about the
configured value and says nothing about what a customer is charged. Price rows carry
`basis: "list"` to keep that legible.

## Packages: the unit is a selection entry, not a package

A page can reference the same package more than once at different quantities. That's a bundle
picker — 1x / 2x / 3x of one SKU as three choices, with campaign offers supplying the tier
discounts. The reference campaign has six selection entries against four live packages, three of
them the same package at qty 1, 2, and 3.

So entries are **never de-duplicated by package ID**; doing that silently drops every picker
option but the first. Many entries pointing at one package is normal.

The two levels compare differently:

- **Per entry** — binding and quantity.
- **Per referenced package** — name, SKU, price, recurrence. Comparing these per entry would
  count one package's price three times.

**Quantity is spec-side.** It says how many units a picker option adds to the cart. It isn't a
property of the live package, and the Admin API is right not to expose one — so it's recorded,
not judged, and it doesn't count against coverage. (An earlier revision filed it as a missing
API field. That was a Map-level concept mistaken for a wire-level gap.)

## The campaign API key never appears in a report

It's dropped during normalization, before any value reaches a comparison or a serializer, so
nothing downstream can emit what it never received.

This is structural rather than a filter on purpose: the real key is a bare 40-character string
with no `cmp_pk_` prefix, so anything grepping for that prefix silently fails to match it.

## What isn't checked yet

- **Cursor pagination.** Every recorded response came back with `next: null`, so multi-page
  behaviour has never been observed. The reconciler reports `has_more` and goes `inconclusive`
  rather than assuming one page.
- **Whether `?sku=` is exact or substring.** A single-SKU recording can't tell. A multi-result
  response is treated as `unresolved_binding` rather than guessed at.
- **Offers and campaign shipping methods**, per above — both are asserted by the spec and
  counted as `unsupported` so the gap shows up as a number, not a footnote.
