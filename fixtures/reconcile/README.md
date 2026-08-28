# Reconciliation fixtures

These are a **recorded Admin API contract run**, not hand-authored shapes. They exist because
the connector's response contracts were previously guessed, and every consumer inherited the
guess. Do not edit them to make a test pass — if a fixture is wrong, the wire changed, and the
matrix needs revising.

## What was transformed, and what was not

The recording came from a private test store. Identity was replaced before the fixtures entered
this public package; structure was not touched.

**Replaced:** store hostname, campaign and product display names, SKUs, media/CDN URLs, the
payment env key, and internal batch labels — all mapped to visibly synthetic equivalents.
The campaign `api_key` was already redacted at capture and never had a real value here.

**Byte-faithful to the wire:** envelope shapes, field names, field order, types, null-vs-empty
distinctions, numeric IDs (campaign, package, product, variant), price strings, error bodies,
and status codes.

That split is deliberate. The identity values carry no contract information, and the repo's
fixture doctrine keeps a public package from becoming a store of someone's real run data. The
structural values are the entire point and are preserved exactly.

## Files

| File | What it records |
| --- | --- |
| `desired-campaignspec.json` | The desired-state input: a real CampaignSpec v4.3 for the same campaign. |
| `observed-campaign-1602-retrieve.json` | Campaign settings readback. |
| `observed-campaign-1602-packages.json` | Package list — note the `{next, previous, results}` envelope. |
| `observed-campaigns-list-name-filter.json` | `?name=` filter response; the filter is substring, not exact. |
| `observed-gateway-groups-list.json` | Gateway groups; payment methods keyed `label` here and `name` on the campaign. |
| `observed-products-by-sku-tacslingbag.json` | Product lookup with variants nested inline — there is no variants endpoint. |
| `observed-error-404-campaign-not-found.json` | Routed 404: flat `{"detail": ...}`. |
| `observed-error-401-bad-token.json` | 401; the message does not distinguish absent from invalid credentials. |
| `observed-error-429-throttled.json` | Throttle body; the response carried `Retry-After: 1`. |

## Traps these fixtures encode

Three behaviours here will silently corrupt a comparator that assumes otherwise:

1. `interval` is `"month"` on all four packages even though `is_recurring` is `false`.
2. Package `prices` is an array keyed by currency, not a scalar.
3. The spec's checkout page references package 1 **three times**, at qty 1, 2 and 3 — a bundle
   picker, not duplicate rows. De-duplicating selection entries by `ref_id` silently drops two
   of the three options.
4. Package prices are **list prices**. Campaign offers (seven in this spec, including an
   always-on 50% on package 1) are applied downstream and are not carried by this source —
   Admin API Offers endpoints are in development, and offers are readable today from the
   storefront Campaign Retrieve API.
