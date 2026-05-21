---
name: next-campaigns-polish
description: Run the visual/runtime polish pass after build and before QA for a Campaigns OS campaign.
---

# Next Campaigns Polish

Use this after build has produced a runnable page-kit campaign.

Responsibilities:

- Compare prepared source design against built campaign pages.
- Scan the prepared source assets for brand marks such as `logo*.png`, `logo*.svg`, and obvious header/logo images before leaving starter-template logos in place.
- Read the assembly report decisions before polishing. Do not reintroduce source-HTML elements that build intentionally dropped because CampaignSpec/API did not support them, such as unavailable payment methods.
- Patch only SDK-safe CSS, skin, layout, and content surfaces.
- Preserve checkout/cart/upsell/receipt runtime wiring.
- Capture desktop and mobile evidence for key commerce anchors.
- For checkout payment, capture zoomed evidence of the express-wallet mount and card fields after SDK readiness. Verify that the visible hosted card and CVV input paths are vertically centered inside native-looking controls; do not accept full-height Spreedly iframes, oversized blank fields, or placeholder text pinned to the top edge.
- Treat express wallet presence as browser/device eligible. Record which wallets mounted in the tested browser, but do not fail solely because Apple Pay is absent in a non-eligible browser. Fail or block when the express mount is empty despite supported wallets, or when mounted wallet buttons are visually malformed.
- For bundle selectors and order bumps, verify active/inactive visual state after interaction, mobile label wrapping, badge placement, and selected/unchecked state. A native hidden input state that disagrees with the SDK class state is a polish blocker.
- For exit-intent pops and promo-code inputs, polish the wrapper/copy states without breaking SDK coupon/voucher apply hooks or `cart.hasCoupon("CODE")` conditional labels.
- Record polish as `completed`, `skipped`, or `blocked` in the assembly report.

Polish is not QA and does not certify launch readiness.
