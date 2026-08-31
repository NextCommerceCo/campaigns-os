# Upsell selector scope — built-output regression fixture (#270)

A built `_site/` reproducing the defect in
[#270](https://github.com/NextCommerceCo/campaigns-os/issues/270): a
`data-next-bundle-selector` on an upsell page that carries no
`data-next-upsell-context`, so the SDK binds it to the shopper's **live cart**
instead of the post-purchase order. Loading the page adds that package to the
cart with no click, and it is charged at the next checkout without appearing in
that checkout's rendered order summary.

Everything here is synthetic. The markup shape — a hidden display-only selector
beside a visible upsell-scoped one, both on the same page — is the shape the
field instance had, because that is the shape a later review round produces when
it layers a correctly-scoped selector on top of an existing unscoped one and
leaves both.

| Page | Role | What it proves |
|---|---|---|
| `index.html` | landing | A cart-scoped selector before checkout is correct. The gate must not fire here. |
| `upsell-1/index.html` | upsell | The clean control: one selector, upsell-scoped. |
| `upsell-2/index.html` | upsell | The regression: two selectors, only one scoped. The gate must name `upsell-bundle-1x`. |
