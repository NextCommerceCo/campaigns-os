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

Prepared mode is for veteran users, and a brief file selects it with `"brief_mode": "prepared"` (see [Brief mode](#brief-mode)). A complete brief should let the build proceed without business questions. If a prepared brief is incomplete or contradictory, doctor blocks with `build_brief.*` errors.

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

## Saving Answers

Save brief answers with `campaigns-os record brief --packet <packet>`. Copy the normalized draft to `campaign-build-brief.json` in the target repository, set the fields named in the open questions, and run `record brief`. You do not need to re-run `start` or `prepare-build`, and no stage evidence is cleared unless the saved answers change the brief's material content. `record brief` refuses a path that points at one of the files Campaigns OS writes itself, such as the normalized brief.

A brief is prepared, where every open question blocks, only when the file sets `"brief_mode": "prepared"`. A brief file without `brief_mode` is guided: questions you leave open remain warnings. One exception keeps existing campaigns as they were built: when the campaign's Assembly Report already records a prepared brief, a file without `brief_mode` stays prepared. Set `"brief_mode": "guided"` to make it guided.

Saving a brief whose content is unchanged keeps all stage evidence and statuses. Reformatting, reordering keys, writing a default value explicitly, or changing only `_meta` also keeps all stage evidence and statuses; the save may rewrite the brief files. When the presentation sections change (`campaign_intent`, `design_authority`, `brand`, `media`, `offer_presentation`, `promo_urgency`, `commerce_surfaces`, `canonical_display`, `template_residue_policy`, or any section you add), build, Polish and QA are owed again. When only `qa_policy` changes, QA alone is owed again. Setup and deploy records are kept. Each affected stage records when its inputs changed. Each replaced record is kept under the stage's `history`; the last five superseded records per stage are kept, and older ones are dropped. History is display only and is never used as current proof.

Recording build again over output that has not changed since the brief or CampaignSpec changed does not make the build current: `next` keeps asking for a build, because the change has not reached the pages. If the operator decides the change needs no change to the built pages, record build with `--deviation-reason "<the operator's reason>"`; the build is then recorded with a warning, and the reason is shown in `next` and the QC handoff. `--deviation-reason` is a general flag any caller can pass: Campaigns OS records the reason, but cannot tell whether the operator chose it. A CampaignSpec change that was never saved with `record spec` is recorded by the next `record build`, `record polish` or QA run, with the same effect; `record build` then also marks Polish and QA owed again. An edit to the brief file is not read until it is saved with `record brief`: until then the build reads the saved brief, and doctor warns `build_brief.input_unsaved`. The same applies after `prepare-build --force`, which now keeps stage history, archives the build, Polish and QA records it clears, and keeps the record that the inputs changed. Recording Polish again does not make it current until a new `polish capture` runs after the change. Recording Polish as skipped, with a skip reason, while it is owed is the operator's decision to skip it: the input change no longer makes Polish owed. The Polish gate still passes only a completed Polish, so `next` stays at Polish until one is recorded (see `docs/polish-evidence.md`).

A build, Polish or QA record that does not say which brief and CampaignSpec content it was made against counts as unconfirmed, not current. Records made by earlier releases are unconfirmed, so after upgrading, `next` routes back to build once; record build and Polish again and run QA again. These checks are tamper evidence, not proof: a record written by hand that copies the current values or removes the record of an input change, or a packet pointed at an older copy of the spec or brief, is not detected.

The fields that close each open question (doctor's `build_brief.guided_questions` warning names the open questions and their fields):

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

### Brief mode

The mode is decided in this order:

1. `"brief_mode": "prepared"` in the file: prepared.
2. `"brief_mode": "guided"` in the file: guided.
3. No `brief_mode`, and the campaign's Assembly Report on disk records a prepared brief: prepared.
4. No `brief_mode` otherwise, including the generated draft and every new hand-written file: guided.
5. Any other `brief_mode` value is the error `build_brief.brief_mode`, and the brief reads `invalid`.

The file's own `_meta` (including a copied draft's `_meta.mode`) is never read for the mode; the normalized brief records how the mode was decided in `_meta.mode_source` (`field`, `legacy_report` or `generated`). Input errors block in both modes. In guided mode, open questions and evaluation gates stay warnings.

### What a brief change makes owed

The brief's material content is the normalized brief without `_meta`, `status`, `questions`, `gates`, `confidence`, `schema_version`, `brief_mode` and `qa_policy.enforcement`, in two parts: `qa_policy`, and every other section (presentation).

| Stage | Presentation changed | `qa_policy` changed |
|---|---|---|
| `prepare_build` | brief blockers re-derived; other blockers kept | re-derived |
| `doctor` | recomputed on every read | recomputed on every read |
| `setup` | kept | kept |
| `assembly` | owed (`required`, `required_by: "brief"`) | kept |
| `polish` | owed (`required`, `required_by: "brief"`) | kept |
| `deploy` | kept | kept |
| `qa` | owed (`required`, `required_by: "brief"`) | owed |

Only completed records are made owed. A skipped stage stays skipped.

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
