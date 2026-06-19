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
5. What promo/savings/urgency language is approved?
6. Which payment methods/trust badges may appear?
7. Are runtime/catalog names allowed to override provided display names?
8. Are there regulated claims or forbidden copy areas?

The CLI avoids SDK/page-kit jargon in questions. The implementation can resolve SDK attributes, responsive CSS, asset paths, routing, template copying, and QA reruns. Business choices should come from the brief or be escalated.

## Risky Defaults

Doctor blocks or asks when a prepared brief leaves high-impact questions unanswered, forbids alternate variant colors without naming sold variants, or contains direct contradictions such as the same payment method being both allowed and hidden.

Doctor warns when generated guided drafts still need answers, a brief allows payment methods not observed in CampaignSpec, or a brief does not explicitly block promo/template placeholders.

Existing template residue, theme, pricing, and built-output checks continue to run. The brief gives those checks business intent instead of replacing them.

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
