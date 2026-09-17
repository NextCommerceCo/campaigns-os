# SDK markup — built-output fixtures (#303)

One `bad/` and one `good/` built `_site/` tree per static SDK markup check
under `built_output.sdk_markup`. Everything here is synthetic. The names keep
the lint codes a partner Campaign Cart kit used, so the two vocabularies line
up; the doctor issue code is the same name lower-cased under the gate id.

| Tree | Severity | `bad/` | `good/` |
|---|---|---|---|
| `swap-with-add-to-cart` | blocks | selector in `swap` mode with an `add-to-cart` button linked by `data-next-selector-id` — both write the cart | same pair with `data-next-selection-mode="select"` |
| `checkout-not-form` | blocks | `data-next-checkout` on a `<div>` — never submits | on the `<form>` |
| `wrong-field-name` | blocks | `firstName`, `lastName`, `zip` — never reach the order | `fname`, `lname`, `postal`, plus a `billing-` field and `accepts_marketing` |
| `missing-selector-id-match` | blocks | `add-to-cart` linked to a selector id that is on no element | the selector carries the id |
| `double-selected` | warns | two `data-next-selected="true"` cards in one selector | one per selector, across two selectors |
| `template-double-brace` | warns | `{{item.name}}` inside the cart-summary `<template>` | single-brace tokens; a non-SDK template may use `{{` freely |

The reachability proof (every check passes on every certified family's real
rendered output) is in `fixtures/certified-families/` and
`src/doctor-certified-family-reachability.test.mjs`.
