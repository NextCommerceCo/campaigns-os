# qa-order-bump fixtures

Static checkout markup for the `browser-order-bump-state` marker resolution
(campaigns-os#323). Not a funnel: `src/qa-order-bump.browser.test.mjs` loads
the page into Chromium and runs the probe over it. No SDK, no server, no
orders — the defect is a DOM-resolution one and turns on document order,
computed `display`, and the shared checkout CSS that shows and hides the tick
by the card's state class.

| Fixture | Toggle | Shape | Expected reading |
|---|---|---|---|
| `aria-hidden-checkbox` | `#bump-active` (package 4, `next-in-cart`) | visually hidden `input[type=checkbox][aria-hidden]` **before** a rendered `[os-component="check"]` tick | marker is the tick `<div>`, `markerChecked` true, aligned |
| `aria-hidden-checkbox` | `#bump-inactive` (package 5) | same markup, declined; the tick is `display: none` | marker is the tick, `markerChecked` false, aligned |
| `aria-hidden-checkbox` | `#bump-switch` (package 6, `next-in-cart`) | no tick vocabulary; the only `aria-hidden` node is an always-rendered switch slider | `markerSignal` null — no marker found, no disagreement claimed |
| `aria-hidden-checkbox` | `#bump-pseudo-inactive` (package 7) | persistent `.bump-check` box, tick in its `::after`, declined so the `::after` is hidden | `markerSignal` `pseudo`, `markerChecked` false — the box renders but says nothing |
| `aria-hidden-checkbox` | `#bump-pseudo-active` (package 8, `next-in-cart`) | same family, accepted, `::after` revealed | `markerSignal` `pseudo`, `markerChecked` true |
| `aria-hidden-checkbox` | `#bump-print-rule` (package 9) | visible persistent marker, declined; hidden only by `@media print` and an `@supports` block for a feature no browser has | `markerSignal` `unresolved` — found and rendered, but neither rule applies on screen, so nothing says which state it is in |
| `aria-hidden-checkbox` | `#bump-floating-pseudo` (package 10, `next-in-cart`) | empty `0 x 0` host span; the tick is an absolutely positioned `::after` | `markerSignal` `pseudo`, `markerChecked` true — the host's size is not the tick's |

Before the fix, the first two resolved the `<input>` as the marker and the
third resolved the slider, so an accepted bump could never read checked. The
next two are the other direction: a box whose visibility is read as its state
fails a correctly declined bump, so the two families have to be told apart
rather than collapsed. The last two pin the two ways that family test can be
fooled — a hiding rule that does not apply on screen, and a host box whose size
is not the tick's.

## Reading the evidence

`markerResolved` is whether a marker element was found; `markerReadable` is
whether its state could be read. They differ exactly when `markerSignal` is
`unresolved`. Only `markerReadable` gates the alignment check, so a marker the
harness cannot interpret goes quiet instead of claiming a disagreement.

| `markerSignal` | Means |
|---|---|
| `pseudo` / `glyph` / `fill` / `display_toggled` | a state vocabulary was recognised and read |
| `not_rendered` | the marker is on the page but hidden, so it reads unchecked |
| `unresolved` | the marker renders but carries no state signal |
| null | no marker element was found at all |
