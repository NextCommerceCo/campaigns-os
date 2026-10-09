# qa-cart-entry fixtures

Two-page funnels for the typed-card runner's cart entry step and empty-cart
guard (campaigns-os#206). `sdk-shim.js` stands in for the campaign-cart SDK:
it reproduces only the cart read, the add-to-cart navigation, the
`forcePackageId` pre-load, and the submit that posts nothing for an empty cart.

| Fixture | Landing | Checkout | Expected ladder |
|---|---|---|---|
| `landing-entry` | `[data-next-action="add-to-cart"][data-next-package-id="1"][data-next-url="/x/checkout/"]` | cart display only | `entered_via_landing` ok, `order_submitted` ok with a non-empty cart |
| `landing-link-entry` | no SDK control; a `?forcePackageId=1:1` link into the checkout, behind an anchor decoy and a hidden duplicate | cart display only | `entered_via_landing` ok with `control_kind: checkout_link`, the visible link clicked, cart pre-loaded on arrival |
| `primary-cta-conflicts` | landing only (no checkout): a relative anchor under `<base href="/x/">`, a plain anchor carrying a decoy `data-next-url`, an SDK add-to-cart control with a stray `href`, one without `data-next-url`, and one with an origin-relative `data-next-url` | — | not a ladder fixture: `inspectPrimaryCta` must resolve the relative anchor natively, ignore the decoy, take the SDK control's `data-next-url`, give the attribute-less SDK control no route, and resolve a relative `data-next-url` against the origin as the SDK does (campaigns-os#321) |
| `checkout-selector` | a plain link | `[data-next-bundle-selector]` with a pre-selected card | `entered_via_landing` skipped; the rest of the ladder is unchanged |
| `landing-entry-empty-cart` | add-to-cart control with **no** package id | cart display only | `entered_via_landing` ok, then `cart_empty_before_submit` — no submit click, no reservation |
| `landing-unwired-controls` | two buttons carrying `data-next-url` and a package id under attribute spellings the SDK never activates on (`data-next-add-to-cart`, `data-next-checkout-action="add-to-cart"`); no SDK control, no `forcePackageId` link | cart display only | `cart_entry_control_missing` at the entry step, not a click followed by a navigation timeout; `inspectPrimaryCta` gives neither button a route |
| `no-entry-resolvable` | (none; topology carries only the checkout) | cart display only | `cart_entry_unresolved` at the entry step, not a step timeout |
| `select-bundle-entry` | a `select` page (campaigns-os#641): a swap-mode `[data-next-bundle-selector]` with a pre-selected `[data-next-bundle-card]` and a `[data-next-action="checkout"]` button; no add-to-cart control | cart display only | `entered_via_landing` ok with `control_kind: checkout_button`; with `--select-package 2` the runner clicks that bundle card first |
| `select-variants-reveal` | `select-bundle-entry` with the checkout button hidden in a second step that a `[data-next-action="select-variants"]` control reveals, as the olympus-mv-two-step select page does | cart display only | the runner clicks the reveal control once, then the checkout button; `entered_via_landing` ok |
| `select-variant-slots` | `select-variants-reveal` plus two bundle slots, each with an empty size select (placeholder first, `S` out of stock) inside `[data-next-variant-selectors]` / `.next-slot-variant-field`, rendered by `variant-slots.js`; the native select is hidden behind a stand-in toggle as the starter does, and Next refuses while any slot is empty (campaigns-os#667) | cart display only | the runner picks `M` in each slot (`variant_selections` with `via: "select"`), the cart holds package 21 x2, `entered_via_landing` ok |
| `select-variant-slots-out-of-stock` | `select-variant-slots` with every size in slot 2 disabled | cart display only | `cart_entry_variant_unfilled` naming slot 2, before Next is clicked |
| `select-variant-slots-prefilled` | `select-variant-slots` with every select pre-filled to `M`, as the stock SDK renders it | cart display only | nothing chosen, no `variant_selections`, `entered_via_landing` ok |
| `select-variant-dropdowns` | `select-variant-slots` with each select pre-filled to `L` and wrapped in a visible `os-dropdown` (toggle showing a placeholder, `os-dropdown-item` rows, menu shown on toggle); a row click records the pick in a page-level object, then sets the select and dispatches `change`, and Next refuses until every field had a row clicked, so a native `change` alone does not count | cart display only | the runner clicks the toggle and the `L` row in each slot (`variant_selections` with `via: "dropdown"`), the cart stays package 22 x2, `entered_via_landing` ok |
| `three-step-checkout` | (none; the path starts on its first `checkout_step`) | step pages (`information`, `shipping`) whose forms carry `data-next-checkout-step`, then the Checkout (`billing`) | `entered_via_landing` skipped, one `checkout_step_submitted` rung per step landing on its declared next page, the order placed from `billing` |

Served by `src/qa-cart-entry.browser.test.mjs` on a local port under `/x/`.
The checkout pages also render an order-bump toggle carrying
`data-next-package-id` inside the cart summary, so the fixtures prove that a
bump or a summary row is not mistaken for a main-cart selection surface.
