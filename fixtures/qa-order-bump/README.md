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
| `aria-hidden-checkbox` | `#bump-switch` (package 6, `next-in-cart`) | no tick vocabulary; the only `aria-hidden` node is an always-rendered switch slider | no marker resolved, no disagreement claimed |

Before the fix, the first two resolved the `<input>` as the marker and the
third resolved the slider, so an accepted bump could never read checked.
