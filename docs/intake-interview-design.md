# Intake Interview — Front-Door Design

**Date:** 2026-08-21 · **Revision 4**, incorporating adversarial architecture reviews rounds 1–3; all cited schema/ADR/code behavior verified against the tree
**Status:** Build-ready
**Evidence:** ON-2 operator feedback (`next-mind` deep-pass `friction-on-2` draft rows on-2-005..007), code survey of the intake surface, architecture reviews rounds 1–3

## Problem

The first successful CLI command assumes the operator has already done four things off-tool, none of which any command checks: configured Campaigns App, exported a CampaignSpec from Map Builder, converted sources to page-kit-ready HTML, and chosen a template family. `start` demands `--spec|--map-id`, `--source`, `--target`, `--template-family` fully formed, and `tooling status` validates the checkout, not the commission. The ON-2 operator's feedback names the result precisely: unclear how to initiate, which repos need clones versus which are merely in the mix, where page-kit fits, what to provide in what order and format, and what the pipeline can work around versus expects.

The interview's raw material already exists without an interviewer:

- `evaluateCampaignBuildBrief` (`src/build-brief.mjs`) defines up to eight conditional question classes with `options[]` — evaluated, never asked; in guided-draft mode they land in an artifact as warnings.
- ADR-0001's Design Source Package normalizes source provenance, Contribution Coverage, Surface Identity, Source Gaps/TODOs, and Source Readiness — the source model intake must feed, not duplicate.
- The findings journal schema includes `intake` and `start` stages — nothing emits into them, which is why ON-2's journal opened at polish.
- page-kit's `campaign-init` has a working @clack prompt loop, unreachable from campaigns-os.

The fix is one verb that **coordinates the existing modules** — CampaignSpec, Build Brief, Design Source Package, Readiness, Run Telemetry — so the operator never has to hold the topology. It introduces no parallel source truth and no readiness dialect.

## The verb

```
npm run campaigns-os -- intake \
  [--target <dir>] [--spec <json> | --map-id <id>] [--source <dir>] \
  [--template-family <family>] [--answers <file>] [--checkpoint-out <path>] \
  [--non-interactive] [--json]
```

Zero required arguments; every flag is a precedence shortcut, not a prerequisite — anything not given by flag is accepted through prompts or the answers document. Architecturally, **Campaign Intake** is a pure evaluation/reduction core plus detection and execution Adapters: the core owns answer application, readiness evaluation, and next-action generation; filesystem/network detection and mutation execution sit behind adapter seams; interactive @clack and non-interactive/JSON are presentation adapters at the same seam. `--json` is prompt-free by definition. Interactive and non-interactive runs have **semantic parity** (same evaluation, same checkpoint content), not byte parity. `start`/`prepare-build` keep their contracts; their missing-input errors gain one pointer line: `Run: npm run campaigns-os -- intake`.

Campaign Intake gets a stable domain definition in `CONTEXT.md`, explicitly distinguished from the existing **Source HTML Intake** (the html_funnel adapter) and the `intake` **Observation Stage** in the findings vocabulary.

## Public contracts

### Answers document — `campaigns-os-intake-answers/v0`

| Field | Shape |
|---|---|
| `schema_version` | const `"campaigns-os-intake-answers/v0"` |
| `spec_fingerprint` / `source_fingerprint` | string \| null — what the answers were about |
| `answers` | map of stable question ID → `{ choice, note?, answered_at }` |

`choice` is a **stable value from the question class's defined value set** — `options[]` display strings are not the contract. Stable question IDs are the eight Brief classes plus four intake-specific ones:

| Question ID | Reduces into |
|---|---|
| `page_design_authority` | `design_authority` per-page `source` |
| `brand_palette_cta` | `brand.commerce_palette_source`, `brand.primary_accent`, `brand.cta_style` |
| `variant_media_rules` | `media.sold_variants`, `media.allow_other_variant_colors` |
| `bundle_pricing_presentation` | `offer_presentation.bundle_cards`, `offer_presentation.post_purchase` |
| `promo_urgency_copy` | `promo_urgency` |
| `payment_methods_trust` | `commerce_surfaces.payment_methods_allowed`, `commerce_surfaces.hidden_payment_methods` |
| `canonical_display_names` | `canonical_display` |
| `regulated_claims` | the evaluator's regulated-claims fields/gates |
| `source_entry_route` | detection routing only (no Brief field) |
| `target_confirmation` | checkpoint `target` + planned mutations |
| `template_family_ack` | `template_lock` (`operator_ack` / `spec_hint_ack`) |
| `campaign_init_permission` | checkpoint `planned_mutations` |

Reduction is deterministic: each choice value maps to a defined patch of the named fields. Unknown keys → error; stale answers (fingerprint mismatch) → re-ask interactively, `blocked` non-interactively; missing answers → the question remains unresolved.

### Intake Checkpoint — `campaigns-os-intake-checkpoint/v0`

The durable output, written on every intake exit including `blocked` and cancellation. Required fields:

| Field | Shape |
|---|---|
| `schema_version` | const `"campaigns-os-intake-checkpoint/v0"` |
| `current_checkpoint` | const `"intake"` |
| `readiness_status` | exactly `pending \| blocked \| ready \| ready_with_gaps \| ready_with_waivers` |
| `cancelled` | boolean — cancellation is `readiness_status: "pending"` + `cancelled: true` |
| `created_at` / `updated_at`, `spec_fingerprint` / `source_fingerprint` | identity + freshness |
| `target` | `{ path, classification: page_kit_campaign_present \| page_kit_no_campaign \| empty_directory \| foreign \| unresolved }` |
| `answers` | accepted answer **values**, same shape as the answers document — the durable owner of interview progress until a Brief is written |
| `unresolved_questions[]`, `template_candidate` (`{family, confidence, ack}`), `planned_mutations[]` | intake-specific state |
| `handled[]`, `blocked_by[]`, `known_gaps[]`, `proposed_exceptions[]`, `waivers[]`, `evidence_refs[]`, `next_actions[]` | the readback buckets; terminal and `--json` output are generated from them |

It references CampaignSpec, Build Brief, and Design Source Package truth by path + fingerprint, duplicating none of it. Consumers: `intake` on resume, `prepare-build` (answers + package references), `next`-style readback.

**Value ownership and precedence.** An operator-authored `prepared` Brief is authoritative — intake never rewrites it; conflicts surface as confirm-or-keep prompts (interactive) or `blocked_by` (non-interactive). Checkpoint-stored answers exist to hydrate generated drafts and fill missing fields. Full precedence when artifacts coexist: **operator-authored prepared Brief → explicit CLI flag → answers document → checkpoint-stored answers → detected fact → default.**

**Persistence rules (target safety).** Intake must never implicitly mutate a tree it just classified as unsafe:

- `page_kit_campaign_present` / `page_kit_no_campaign` → target-local `.campaign-runtime/intake-checkpoint.json`.
- `empty_directory`, `foreign`, `unresolved`, or cancellation before target resolution → stdout readback + user-level state at `~/.campaigns-os/intake/<commission-fingerprint>.json`; creating `.campaign-runtime/` in an empty directory is **not** authorized in v0.
- `--checkpoint-out <path>` overrides the location explicitly.
- On resume, user-level state keyed by commission fingerprint (spec identity + target path) migrates into the target-local checkpoint once the target becomes recognized.

**Exit codes.** `0` = ready / ready_with_gaps / ready_with_waivers · `2` = blocked (matching `tooling status`) · `130` = cancelled · `1` = internal error.

## Interview flow

Each ask follows one shape: **prompt → why it's needed → accepted formats → what happens if you skip it**. Never ask what can be detected; detect first, confirm second.

**Stage 0 — Environment.** Absorb `tooling status`, add Node >= 20.19 and target-repository resolution into the four classifications above. `campaign-init` may run only in `page_kit_no_campaign`, only after spec, slug, and template family are confirmed and the operator explicitly permits the mutation — recorded in `planned_mutations` first. Empty directory → bootstrap steps as `next_actions`; foreign repo → refusal with explanation.

**Stage 1 — Commission.** Campaign name, merchant, and the spec: `--map-id` (fetched, cached — existing path), a local spec file, or neither. Neither → point at Map Builder with the edit URL and stop cleanly at a valid `blocked` checkpoint: planner-first means commerce is planned there, not improvised here. Store profile is checked here **preserving doctor semantics**: missing required Store Profile fields → `blocked_by`; a placeholder/localhost `store_url` → `known_gaps` (it is deliberately a real-shopper warning, not a blocker — localhost is a valid QA origin). Target-side projection parity remains the downstream `page_kit.store_profile` checkpoint's job.

**Stage 2 — Sources → Design Source Package.** "What do you have?" The legacy entry points (template-stock / Figma-driven / AI-generated / hand-authored) are **presets that route detection**, not a closed taxonomy: existing page-kit pages, agency static source, and prebuilt packages are equally valid contributions per ADR-0001; "mixed" is derived from multiple contributions, never chosen; an unsupported/other route produces an actionable Source TODO. The stage's output is a drafted or updated **Design Source Package**: contributions, Contribution Coverage against active pages, Source Gaps and Source TODOs. Existing HTML → manifest matching now, ambiguity confirmed in-interview. Figma link without semantic-export provenance → a Source TODO naming the `figma-sections-export` handoff command — blocking source readiness unless waived; intake never fabricates exporter provenance. Nothing → template-stock as a Template Reference-backed `template_baseline` contribution.

**Source handoff rule (v0).** `prepare-build` still requires a physical source root and the `html_funnel` adapter, so: every contribution that reaches `prepare-build` in v0 must **resolve to an html_funnel source root via its producer** — Figma through the export handoff, agency static and AI/hand-authored HTML as the directory they are; `template_baseline` needs no source root (existing path). Contribution classes that cannot project in v0 — prebuilt packages, existing page-kit pages as the primary design source — are accepted and classified by intake but yield a `blocked` checkpoint whose Source TODO names the manual path. Making the Design Source Package authoritative so `prepare-build` derives or bypasses the legacy `source_html` checks is the named v1 evolution, not a v0 behavior. Intake must never emit an artifact the next command rejects.

**Stage 3 — Commerce & brand.** Evaluate every applicable Build Brief question class; **prompt only for the unresolved ones** (prefill from spec and asset crawl). Mode rule:

- **Complete interview** (no unresolved questions, no blocker gates) → write an ordinary **`prepared`** Brief with interview provenance in metadata.
- **Incomplete interview** → answer values persist in the checkpoint, and intake produces a **hydrated `guided_draft`** — answered classes filled, unanswered ones warning exactly as today. A partially answered brief is never written as `prepared` (prepared-mode unanswered questions are prepare-build blockers).
- **Never a third mode.**

One scoped `prepare-build` integration: its brief evaluation accepts the checkpoint's answers reference, so answered classes do not resurface.

Template family: intake computes a **candidate** with confidence; confirmation produces `template_lock.locked_by: operator_ack` / `spec_hint_ack` — a recommendation alone never locks (packet schema invariant). A confirmed family maps to `campaign-init` mechanics via the commerce-surface catalog: public families resolve through page-kit's builtin GitHub template source under the family's template slug; private families require a `_data/template-sources.json` registration and `campaign-init --source <name>` — when that registration is absent, intake adds it to `next_actions` rather than attempting it.

**Stage 4 — Checkpoint.** Write the Intake Checkpoint per the persistence rules; render readback from it. Terminal output ends with exactly one thing: the next command, or the named blocks.

## Handoff into `prepare-build`

`prepare-build` **reuses and validates the intake-authored Design Source Package** (locality — regeneration would discard interview-confirmed mappings). If the package's material fingerprint is stale against current spec/source inputs, `prepare-build` refuses with a `re-run intake` next-action rather than silently regenerating. During ADR-0001's v0 compatibility window, the no-package legacy synthesis path remains for non-interviewed runs. The former "no `prepare-build` changes" boundary is amended to allow exactly this package/answers/reference consumption — without it, intake's principal artifacts disappear at the next command.

## Resume and overwrite authority

- Intake never silently overwrites operator-authored Brief decisions, producer-authored source manifests, or accepted Source Gaps and waivers; conflicts are confirm-or-keep prompts (interactive) or `blocked_by` entries (non-interactive).
- A **material** Design Source Package change after Assembly evidence exists requires explicit confirmation, and downstream evidence tied to the old material fingerprint becomes visibly stale — ADR-0001's freshness model, not a new one.
- Re-running intake against unchanged fingerprints is idempotent: same checkpoint, no new mutations.

## The input contract (typed, verified against current behavior)

| Input | Class | Missing ⇒ |
|---|---|---|
| CampaignSpec (map-id or file) | required | `blocked`, with the Map Builder URL |
| CampaignSpec Store Profile required fields | required | `blocked_by` (doctor blocker today) |
| Non-placeholder `campaign.store_url` | degradable | `known_gaps` (doctor warning today — real-shopper readiness, not a build block) |
| Target repository | required | bootstrap `next_actions` (empty) or refusal (foreign) |
| Campaign scaffold in target | synthesizable | guarded `campaign-init` (`page_kit_no_campaign` only, post-confirmation, recorded as planned mutation) |
| Campaigns API key | degradable | warning; API-side package/shipping/offer confirmation deferred (current resolver behavior, unchanged) |
| Source HTML / design source | degradable | Template Reference-backed `template_baseline` coverage, or Source Gaps/TODOs per contribution |
| Source manifest | synthesizable | drafted from matching; ambiguity confirmed in-interview |
| Template family | synthesizable candidate | recommended, **never locked**, until operator/spec ack |
| Figma export provenance | required for Figma-driven coverage | Source TODO naming the export command; blocks source readiness unless waived |
| Target store-profile parity | out of intake | owned by the `page_kit.store_profile` checkpoint downstream |
| Brief answers | degradable | unresolved questions → hydrated `guided_draft`, warnings as today |

## Instrumentation (scoped work, not free)

- Intake appends `stage: "intake"` findings **only for genuine friction and missing prompts** — ordinary missing commission inputs belong in `blocked_by`, Source Gaps, or Source TODOs, not the findings journal.
- When Campaign Run Identity begins is an open design item: run sessions currently start at `start`/`prepare-build`. Moving the start to intake and adding an intake observation to the run-record schema are versioned public-surface changes with their own slice.
- The source-quality measurement lives in the domain's own vocabulary: Contribution Coverage, readiness status, and gap/TODO counts classify every commission. **The derived telemetry cohort is deferred until intake has produced real Run Records** — coverage, readiness, and gap/TODO counts are the v0 raw observations.

## Acceptance

A fresh operator in a recognized page-kit repo, holding only a Map ID and a Figma link, reaches an Intake Checkpoint **without out-of-band help or invented answers**: spec fetched, Design Source Package drafted with the Figma contribution carrying its Source TODO, template candidate awaiting ack, unresolved Brief questions listed — a **valid `blocked` checkpoint whose `next_actions` are exact** (run the Figma export handoff; ack the family). With only a Map ID from a recognized repo, a confirmed Template Reference-backed family, and no remaining Source TODOs, the checkpoint is `ready_with_gaps` on the template-stock path. The same operator in an empty directory gets the named bootstrap steps and a user-level checkpoint, not a failure and not a mutated directory. `--non-interactive --answers` yields a semantically identical checkpoint. Negative control: intake must never manufacture a dead-end that `start` doesn't have.

Falsifier, per the ambient-instrumentation doctrine: if the next instrumented commission still produces friction rows of the on-2-005..007 classes (entry, topology, format, expects-vs-works-around), the interview failed regardless of how it demos.

## Build sequence

1. Land the Design Source Package emitter/schema where not yet complete (ADR-0001's contract is documented ahead of full implementation).
2. Campaign Intake core (pure evaluation/reduction) with detection adapters, **plus its public surface**: the `intake` command, answers schema, and checkpoint schema register in `supported-surface` with hash updates and a `surface_version` bump — the DSP schema likewise when it lands in step 1. `CONTEXT.md` gains the Campaign Intake domain definition in the same slice.
3. Intake Checkpoint persistence rules + readback projection; scoped `prepare-build` integration (package reuse/validation, answers reference).
4. Interactive and JSON/non-interactive presentation adapters at the core seam.
5. Guarded `campaign-init` delegation (execution adapter); then run-identity/telemetry wiring as its own versioned slice.
6. Tests: existing repo, empty directory (user-level checkpoint, no mutation), foreign repo refusal, Figma-without-export (blocked, exact actions), non-projectable contribution (prebuilt package → blocked + manual path), ambiguous HTML, template confirmation vs. lock invariant, private-family source registration in next_actions, partial-interview → hydrated guided_draft round-trip, operator-Brief precedence, cancellation exit codes, resume with stale fingerprints and user-level→target-local migration, overwrite protection.

## Out of scope

New source adapters (still `html_funnel` only; DSP-authoritative `prepare-build` is v1), moving `campaign-init` into campaigns-os, Campaigns App configuration, a web version of the interview (Map Builder portal intake is a plausible later home), changes to `start` semantics beyond the pointer line, and run-identity/telemetry surface changes beyond the versioned slice named above. `prepare-build` changes are limited to the scoped package/answers/reference consumption defined in "Handoff" — nothing else about its contract moves.

## Adopted decisions

Verb = `intake`. `campaign-init` runs only inside a recognized page-kit repo after explicit confirmation, recorded as a planned mutation first. Brief questions: evaluate all applicable classes, ask only unresolved; complete → `prepared`, partial → hydrated `guided_draft`, never a third mode; operator-authored Brief always authoritative. No source tier anywhere — Source Readiness and Contribution Coverage are the operator-facing truth. Derived telemetry cohort deferred until real Run Records exist. v0 source handoff = producer-projected `html_funnel` roots; DSP-authoritative `prepare-build` is v1.
