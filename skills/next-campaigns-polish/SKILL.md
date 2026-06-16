---
name: next-campaigns-polish
description: Run the visual/runtime polish pass after build and before QA for a Campaigns OS campaign.
---

# Next Campaigns Polish

Use this after build has produced a runnable page-kit campaign.

Theme gate: `campaigns-os next polish` blocks when theme inspect found a
generatable brand theme that is not yet applied to commerce pages. Do not work
around the gate — apply the brand layer (`theme generate`, copy into campaign
assets, load after `next-core.css`, record `report.theme`) or record an
explicit waiver (`campaigns-os theme waive --packet <p> --reason "<why>"`).

Responsibilities:

- Compare prepared source design against built campaign pages.
- Scan the prepared source assets for brand marks such as `logo*.png`, `logo*.svg`, and obvious header/logo images before leaving starter-template logos in place.
- Scan **visible** rendered text inside the family's content/commerce surfaces (the selectors enumerated in `contracts/template-brand-contract.<family>.v0.json`) for placeholder/residue copy the build should have replaced — the *literal starter defaults*: lorem-ipsum, the unmodified starter headings (`Product Name` / `Package Title` / `Your headline`), `[VERIFY …]` author notes, `TODO` markers. Match the literal starter strings, not any authored copy that merely contains those words, and skip `<script>` / `<style>` / JSON-LD / `data-*` attributes. Treat a surviving literal starter default on a content/commerce surface as a polish blocker — replace it from the prepared source / CampaignSpec; do not draft substitute copy (if the design's authored copy is genuinely missing, flag it rather than invent it). This is *copy* residue, complementary to the computed-style / asset residue gated by `next-campaigns-qa` + the brand contract — not a duplicate of it.
- Flag template *defaults* left where they disagree with the prepared design — e.g. the same benefit icon repeated across a grid *when the design uses distinct icons*, or a guarantee badge/term that disagrees with the design — as polish defects, not just logos. Judge against the prepared source, not taste: copy or imagery the source/CampaignSpec does not supply (e.g. a placeholder testimonial name/quote/role) is residue; "looks generic" on its own is not.
- Read the assembly report decisions before polishing. Do not reintroduce source-HTML elements that build intentionally dropped because CampaignSpec/API did not support them, such as unavailable payment methods.
- Preserve existing `report.theme` data. If polish changes generated theme CSS, load order, commerce-page coverage, theme warnings, or the first repair-loop defect, update the Assembly Report `theme` block rather than leaving stale evidence.
- Patch only SDK-safe CSS, skin, layout, and content surfaces.
- Preserve checkout/cart/upsell/receipt runtime wiring.
- Capture desktop and mobile evidence for key commerce anchors.
- For checkout payment, capture zoomed evidence of the express-wallet mount and card fields after SDK readiness. Verify that the visible hosted card and CVV input paths are vertically centered inside native-looking controls; do not accept full-height Spreedly iframes, oversized blank fields, or placeholder text pinned to the top edge.
- Treat express wallet presence as browser/device eligible. Record which wallets mounted in the tested browser, but do not fail solely because Apple Pay is absent in a non-eligible browser. Fail or block when the express mount is empty despite supported wallets, or when mounted wallet buttons are visually malformed.
- For bundle selectors and order bumps, verify active/inactive visual state after interaction, mobile label wrapping, badge placement, and selected/unchecked state. A native hidden input state that disagrees with the SDK class state is a polish blocker. So is a selected/active visual driven by a *non-SDK static attribute the SDK never clears* — e.g. a hardcoded `data-selected="true"` left on the initial card. (The native `selected` attribute on `<option>`/custom selects *is* SDK/browser-managed, so do not flag that.) The selected style must follow the SDK-managed class (e.g. `.next-selected` — see the family's bundle-selector selectors in `contracts/template-brand-contract.<family>.v0.json`) so a single-select swap clears the previous selection. Verify by interaction that the previously-selected item deselects after another is picked — a selector that only ever paints "selected" on click is a blocker.
- For exit-intent pops and promo-code inputs, polish the wrapper/copy states without breaking SDK coupon/voucher apply hooks or `cart.hasCoupon("CODE")` conditional labels.
- If `report.theme` or `context.theme` exists, verify brand-theme load order after `next-core.css`, source-token parity for primary color/CTA/surface/text/font/radius when present, and SDK safety. When the brand layer is missing, stale, low-confidence, or unsafe to apply, record the first repair-loop defect or an explicit skipped reason.
- Record polish as `completed`, `skipped`, or `blocked` in the assembly report.

Polish is not QA and does not certify launch readiness.
