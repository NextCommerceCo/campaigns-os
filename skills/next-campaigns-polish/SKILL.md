---
name: next-campaigns-polish
version: 1.0.1
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
- **Brand-bleed (cloned-source de-brand) pass.** When a campaign is cloned from a proven sibling, the sibling's brand defaults ride along. Inspect the built pages and assets for residual cross-brand bleed and clear it before recording: (1) a residual promo/sale banner or coupon code/copy from the source campaign (including a baked-in *fake* code); (2) a prior-campaign / sibling favicon left in place; (3) scaffold or non-design fonts the design did not specify (e.g. starter `Plus Jakarta`); (4) hardcoded non-token colors — any brand color literal that should be a token, such as next-core's `#C670FE` "Most Popular" pill. Clear each from the prepared source / CampaignSpec and brand theme (tokens, not literals); flag — do not invent — anything the design genuinely doesn't supply. Treat surviving bleed as a polish blocker. This complements the favicon/logo and copy-residue checks above; it is the cross-brand contamination angle, not a duplicate.
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
- Before recording a terminal Polish status, serve the current build and run
  `campaigns-os polish capture --packet <packet> --base-url <served-build-url>`.
  The package captures every mapped route at fixed desktop/mobile viewports and
  attaches `stages.polish.evidence.visual_review.page_load`. Never hand-author,
  copy, or repair that object directly.
- Record polish as `completed`, `skipped`, or `blocked` in the assembly report.
  A nonzero capture result keeps Polish blocked until repair and recapture. The
  producer persists bounded incomplete evidence for diagnosis and does not mark
  the stage complete.

## Recording polish evidence

The polish gate (`campaigns-os next polish` / QA handoff) reads structured
evidence from `stages.polish.evidence`. The full accepted schema — stage-record
requirements, every required field's accepted shape, the favicon certification
shape and its escape semantics, the semantic text scans, and the blocker-code
ladder — is documented in `docs/polish-evidence.md`. That document is the
schema reference; this section is the recording guidance.

**All seven evidence fields are required** or the gate blocks with
`polish.evidence_incomplete`:

- `visual_review` — an **object with a `screenshots` array** (aliases:
  `screenshot_paths`, `paths`, `urls`) holding at least one non-empty
  path/URL string for the captured desktop+mobile evidence, plus the
  package-generated `page_load` object. A bare string or a screenshot-less
  object does NOT pass, no matter how real the review was.
- `brand_review` — object; must include the `favicon` attestation and the
  `brand_bleed` attestation (below).
- `checkout_review` — object; must include `field_labels` (aliases
  `initial_field_hints`, `visible_labels`) confirming legible initial field
  hints, and `bump_compare_price_rule` (alias `bump_compare_price`)
  confirming no equal/no-discount compare price renders.
- `template_residue_review` — non-empty; its `starter_favicon` entry accepts
  the same certification shape as `brand_review.favicon`.
- `commerce_flow_review` — non-empty string/array/object.
- `issues` — **must be an array**; `[]` is the canonical "no issues found".
- `commands` — non-empty array of the commands polish actually ran; never
  include build commands (that reads as self-certification).

The stage record itself must carry `performed_by: "next-campaigns-polish"`,
`source_build_fingerprint` equal to the current
`stages.assembly.build_fingerprint`, `completed_at`, and — when the report
fingerprints a Design Source Package — `source_package_material_fingerprint`.

The `polish.hidden_eager_media` checkpoint blocks on nonwaivable missing,
malformed, stale, integrity-invalid, route-mismatched, or incomplete package
capture evidence. A complete finding means one computed-hidden `video` or
`audio` element transferred strictly more than `1,048,576` bytes without an
exact ASCII-case-insensitive `preload="none"` or `preload="metadata"` content
attribute. Repair and recapture first. Only a complete real finding has an exact
named-human waiver lane:

```bash
campaigns-os checkpoint waive \
  --packet <packet> \
  --gate polish.hidden_eager_media \
  --reason "<why this exact finding is accepted>" \
  --waived-by "<named human>" \
  --review-condition "<specific re-evaluation trigger>"
```

The waiver remains visible and becomes inert when the build, slug, route plan,
fixed viewports, or finding state changes.

The favicon certification shape is authoritative (it skips the free-text leak
scan): `{ "byte_match": true }` or `status`/`result` one of `matched_source`,
`promoted_source`, `confirmed_non_template`, `no_source_candidate`. Free-text
favicon evidence is scanned for starter-leak phrasing and the literal
`images/favicon.png` path — certify structurally when you verified byte-level.

Record, alongside the favicon (`brand_review.favicon`) and order-bump
compare-price (`checkout_review.bump_compare_price_rule`) attestations the
gate already checks, a `brand_review.brand_bleed` attestation for the de-brand
pass above. Without it the gate blocks every completed polish run.

Write the cleared result as an object — `cleared: true` is the canonical,
unambiguous form (the gate accepts it directly and does not then scan the rest
of the object for residue):

```jsonc
"brand_review": {
  "favicon": { "byte_match": true, "status": "matched_source" },
  "brand_bleed": {
    "cleared": true,
    "promo_codes": "none",
    "favicon": "brand favicon",
    "fonts": "design fonts only",
    "colors": "tokenized"
  }
}
```

Field precedence is `brand_bleed`, then aliases `brand_bleed_review`, then
`debrand`. A confirming free-form string is also accepted (e.g. `"promo banner
stripped, design fonts only, colors tokenized, no prior favicon"`).

Pitfall: if you record bleed as a string (or omit `cleared: true`), the gate
runs a negative-text matcher over the value. Affirm clearance and do **not**
echo the offending tokens — phrasings like `cleared: false`, `not cleared`,
`bleed found`, `#C670FE`, `Plus Jakarta`, `prior-campaign`, or `promo code …
still present` all block, even when describing what you *removed*. State the
cleared outcome (`"de-brand pass complete, no residue"`), not the residue you
deleted. If bleed genuinely remains, record `cleared: false` (or `bleed_found:
true`) so the gate blocks until it is fixed — never paper over it.

Polish is not QA and does not certify launch readiness.
