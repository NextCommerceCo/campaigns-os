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
| `no-entry-resolvable` | (none; topology carries only the checkout) | cart display only | `cart_entry_unresolved` at the entry step, not a step timeout |

Served by `src/qa-cart-entry.browser.test.mjs` on a local port under `/x/`.
The checkout pages also render an order-bump toggle carrying
`data-next-package-id` inside the cart summary, so the fixtures prove that a
bump or a summary row is not mistaken for a main-cart selection surface.
