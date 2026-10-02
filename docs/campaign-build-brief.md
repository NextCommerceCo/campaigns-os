# Campaign Build Brief

The Campaign Build Brief is the merchandising and design-presentation truth for a Campaigns OS build.

CampaignSpec remains the operational truth: packages, offers, shipping, routing, SDK hints, payment/runtime values, and API identity. The Build Brief answers business-owned presentation questions that agents should not infer silently: page authority, palette and CTA treatment, product media rules, pricing display, promo language, payment/trust surfaces, canonical names, residue policy, and QA expectations.

## Artifact Locations

Campaigns OS accepts YAML or JSON:

```bash
campaigns-os prepare-build \
  --source ./design-export \
  --spec ./campaign-spec.json \
  --target ./merchant-campaign \
  --template-family olympus \
  --brief ./campaign-build-brief.yaml
```

`campaigns-os build` is an intake alias for the same flow plus doctor.

If `--brief` is omitted, `prepare-build` looks for:

- `campaign-build-brief.yaml`
- `campaign-build-brief.yml`
- `campaign-build-brief.json`

It checks the source root first, then the target repo. If none exists, Campaigns OS writes a guided draft to:

```text
.campaign-runtime/input/campaign-build-brief.normalized.json
```

The Build Packet, Build Context, and Assembly Report all reference that normalized artifact so it survives handoff, compaction, rebuilds, polish, and QA.

## Modes

Prepared mode is for veteran users. A complete brief should let the build proceed without business questions. If a supplied brief is incomplete or contradictory, doctor blocks with `build_brief.*` errors.

Guided mode is for new or partial inputs. Campaigns OS drafts a brief from CampaignSpec, page mappings, template family, source assets, and available runtime hints. It records only high-impact unresolved questions as warnings so existing builds still run while the business uncertainty is visible.

## High-Impact Questions

Guided questions are intentionally short and business-readable. They prioritize:

1. Which source controls each page?
2. Which palette/CTA style should commerce pages use?
3. Which product variants/colors are actually sold?
4. How should bundle pricing be presented?
5. Should the starter template's own promo placeholders (demo countdown timers, promo banners, placeholder voucher codes, exit-pop offers) be filled from the campaign's promo codes and offers, or removed?
6. Which payment methods/trust badges may appear?
7. Are runtime/catalog names allowed to override provided display names?
8. Are there regulated claims or forbidden copy areas?

The CLI avoids SDK/page-kit jargon in questions. The implementation can resolve SDK attributes, responsive CSS, asset paths, routing, template copying, and QA reruns. Business choices should come from the brief or be escalated.

Question 5 is asked only when the CampaignSpec maps a surface that fills the template's promo placeholders: a `funnels[].promo_codes` roster, or a checkout page's enabled `exit_intent` or `promo_code_input`. It never asks for approval of the source design's own promo, proof or urgency copy, which is built as designed (see below). Without such a surface the guided draft sets `header_claim_source` and `timer_label` to `"none"`: the template's promo placeholders are removed.

## Answering The Questions

An answer counts only once it is in a brief file that `start` or `prepare-build` reads. The guided draft is regenerated on every run, so an answer given in conversation, or typed into the normalized draft, does not stick.

1. Copy `.campaign-runtime/input/campaign-build-brief.normalized.json` to `campaign-build-brief.json` in the target repo. A brief file replaces the guided draft whole, so starting from the copy keeps the fields the draft already filled; any question the file leaves open blocks as a prepared brief.
2. Set the fields that close each open question:

   | Question | Fields |
   |---|---|
   | `page_design_authority` | `design_authority.<page_id>.source` for each page named in the question |
   | `brand_palette_cta` | `brand.commerce_palette_source`, `brand.cta_style` |
   | `variant_media_rules` | `media.sold_variants`, `media.allow_other_variant_colors` |
   | `bundle_pricing_presentation` | `offer_presentation.bundle_cards.primary_price` |
   | `promo_urgency_copy` | `promo_urgency.header_claim_source` (`campaign_offers` or `none`), `promo_urgency.timer_label` (the template timer's label, or `none`) |
   | `payment_methods_trust` | `commerce_surfaces.payment_methods_allowed` |
   | `canonical_display_names` | `canonical_display.product_name_source` |
   | `regulated_claims` | one of `campaign_intent.compliance.approved_benefit_language`, `.forbidden_claims`, `.approved_claims`, `.copy_rules` |

3. Re-run `start` or `prepare-build` with the same arguments. The file is found in the target repo automatically, or pass `--brief <file>`. Doctor's `build_brief.guided_questions` warning names the open questions and their fields.

Re-running regenerates the Assembly Report. Before any stage has recorded evidence, that costs nothing. Once a stage has recorded evidence (setup, build, polish or later), the re-run is refused unless you pass `--force`, which resets those stages and clears their evidence. Answer the questions right after `start`.

## Risky Defaults

Doctor blocks or asks when a prepared brief leaves high-impact questions unanswered, forbids alternate variant colors without naming sold variants, or contains direct contradictions such as the same payment method being both allowed and hidden.

Doctor warns when generated guided drafts still need answers, a brief allows payment methods not observed in CampaignSpec, or a brief does not explicitly block promo/template placeholders.

Existing template residue, theme, pricing, and built-output checks continue to run. The brief gives those checks business intent instead of replacing them.

## The Merchant's Own Claims Are Not Reviewed

Proof and urgency content the merchant supplies is the merchant's
responsibility, not Campaigns OS's: reviews and testimonials, ratings and
counts, "Verified Purchase" labels, recent-purchase popups, stock counters,
countdowns, guarantees and press mentions. The doctor does not scan for it and
QA does not assert on it. When the prepared source design carries these
elements, the build reproduces them as designed. The starter templates ship
without some of them; that is not a reason to drop the source's.

What the doctor does scan built output for is template residue: the starter
templates' own demo strings and bracket-style stubs
(`content_residue.demo_residue`, a warning). It also warns on promo copy
claiming a discount above the CampaignSpec maximum
(`template_contract.discount_claim_residue`, or
`template_contract.discount_claim_unverified` when the spec sets no maximum),
because that copy disagrees with the campaign's own pricing. Nothing downstream
blocks on either.

Two content checks do block: the needs-merchant-input marker
(`content_residue.needs_merchant_input`), and, on a brief-backed build only,
starter countdown chrome the brief payload does not verify
(`content_residue.unverified_urgency`). Use the brief to record which claims
are approved and which language is forbidden (see the high-impact questions
above).

## QA Policy Scope

`qa_policy` records business expectations for the proof pass, such as desktop/mobile screenshots, checkout flow coverage, post-purchase coverage, visible-placeholder handling, and runtime-data comparison. It is not the doctor/QA enforcement contract by itself.

Normalized briefs include `qa_policy.enforcement.status: documented_expectation` so consumers do not mistake these fields for direct gates. Doctor and QA enforce the Build Packet `qa.proof_policy` and Assembly Report `report.proof_policy` contract, which names browser QA, typed-card depth, SDK origin allowlist state, order path depth, and operator approval state.

## Generic Scenarios

Single-variant gadget:

- One physical product, one sold color.
- Landing page owns the palette.
- Checkout inherits landing CTA style.
- Carousel avoids alternate colors.
- Bundle cards emphasize unit price and simple savings badges.

Multi-variant apparel:

- Product has several colors/sizes.
- Variant selector is allowed.
- Media may show multiple colors only when the selected-variant workflow supports it.
- Product imagery must not imply unavailable sizes/colors.

Consumable subscription:

- One-time and subscribe-and-save offers may coexist.
- Pricing separates first-order savings from subscription terms.
- Promo timers avoid false urgency when the offer is evergreen.

Home goods bundle:

- Main product plus accessories.
- Bundle cards emphasize included items, not only percentage savings.
- Lifestyle images can show room scenes, but the product must remain inspectable.

Digital or service add-on:

- Physical variant imagery is not required.
- OTO copy emphasizes scope, duration, and support terms.
- Shipping copy is hidden.

Health/wellness product:

- Claims require stricter copy boundaries.
- The brief should list forbidden claims and approved benefit language.
- QA should flag unapproved medical or guaranteed-outcome wording.

High-compliance financial or regulated offer:

- Promo and urgency copy defaults conservative.
- Trust badges and claims must be source-backed.
- Savings, guarantees, or scarcity language requires explicit approval.
