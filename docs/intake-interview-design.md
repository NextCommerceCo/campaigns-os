# Intake Interview — Front-Door Design

**Date:** 2026-08-21 · **Revision 3**, incorporating both adversarial architecture reviews (2026-08-21); all cited schema/ADR/code behavior verified against the tree
**Status:** Design for review — build-ready pending the one decision at the end
**Evidence:** ON-2 operator feedback (`next-mind` deep-pass `friction-on-2` draft rows on-2-005..007), code survey of the intake surface, architecture reviews rounds 1–2

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
  [--template-family <family>] [--answers <file>] [--non-interactive] [--json]
```

Zero required arguments; every flag is a precedence shortcut, not a prerequisite — anything not given by flag is accepted through prompts or the answers document. Architecturally, **Campaign Intake** is one deep module: a pure evaluator owns answer application, readiness evaluation, and next-action generation, while filesystem/network detection and mutation execution sit behind internal adapter seams; interactive @clack and non-interactive/JSON are presentation adapters at the same seam. `--json` is prompt-free by definition. Interactive and non-interactive runs have **semantic parity** (same evaluation, same checkpoint content), not byte parity. Cancellation and blocked outcomes get distinct exit codes. `start`/`prepare-build` keep their contracts; their missing-input errors gain one pointer line: `Run: npm run campaigns-os -- intake`.

Campaign Intake gets a stable domain definition in `CONTEXT.md`, explicitly distinguished from the existing **Source HTML Intake** (the html_funnel adapter) and the `intake` **Observation Stage** in the findings vocabulary.

### Answers contract (non-interactive spine)

- A versioned answers document (`campaigns-os-intake-answers/v0`) with stable choice values per question class — `options[]` display strings are not the contract.
- Deterministic answer→Brief reduction: each choice value maps to a defined patch of nested Brief fields.
- Precedence: explicit CLI flag → answers file → detected fact → default.
- Unknown keys → error; stale answers (spec/source fingerprint mismatch) → re-ask interactively, `blocked` non-interactively; missing answers → the question remains unresolved in the checkpoint.
- Spec and source material fingerprints are recorded so a resumed interview knows what its previous answers were about.

## The Intake Checkpoint artifact

The durable output — not a terminal projection. Schema `campaigns-os-intake-checkpoint/v0`, default path `.campaign-runtime/intake-checkpoint.json`, written on every intake exit including `blocked` and cancellation.

It **owns** intake-specific state: target-repository classification, answer fingerprints, unresolved question classes, template candidate + ack state, and planned mutations (e.g. a pending `campaign-init` delegation). It **references** CampaignSpec, Build Brief, and Design Source Package truth by path + fingerprint, duplicating none of it. Readback — terminal and `--json` alike — is generated from the artifact using the established buckets, exactly:

```
current_checkpoint · readiness_status · handled · blocked_by · known_gaps
proposed_exceptions · waivers · evidence_refs · next_actions
```

`readiness_status` uses the shared checkpoint vocabulary (`pending | blocked | ready | ready_with_gaps | ready_with_waivers | …`). Consumers: `intake` itself on resume, `prepare-build` (answers + package references, below), and `next`-style readback.

## Interview flow

Each ask follows one shape: **prompt → why it's needed → accepted formats → what happens if you skip it**. Never ask what can be detected; detect first, confirm second.

**Stage 0 — Environment.** Absorb `tooling status`, add Node >= 20.19 and target-repository resolution. Four target states, handled distinctly:

1. **Page-kit repo, campaign present** — resume posture; intake updates rather than scaffolds, under the overwrite rules below.
2. **Page-kit repo, no campaign** — the only state where intake may run `campaign-init`, and only after the spec, slug, and template family are confirmed (Stages 1–3) and the operator explicitly permits the mutation; the planned mutation is recorded in the checkpoint first.
3. **Empty directory** — intake names the bootstrap steps (clone/create a page-kit repo, `npm install`) as `next_actions`; it does not fabricate a repository.
4. **Non-page-kit repository** — refuse with an explanation; never scaffold into a foreign tree.

**Stage 1 — Commission.** Campaign name, merchant, and the spec: `--map-id` (fetched, cached — existing path), a local spec file, or neither. Neither → point at Map Builder with the edit URL and stop cleanly at a valid `blocked` checkpoint: planner-first means commerce is planned there, not improvised here. The spec's store profile is checked here — `campaign.store_url` missing or placeholder is already a doctor blocker, so intake surfaces it at the front door; target-side store-profile projection parity remains the downstream `page_kit.store_profile` checkpoint's job.

**Stage 2 — Sources → Design Source Package.** "What do you have?" The legacy entry points (template-stock / Figma-driven / AI-generated / hand-authored) are **presets that route detection**, not a closed taxonomy: existing page-kit pages, agency static source, and prebuilt packages are equally valid contributions per ADR-0001; "mixed" is derived from multiple contributions, never chosen as a category; and an unsupported/other route produces an actionable Source TODO rather than a refusal. The stage's output is a drafted or updated **Design Source Package**: page-level Design Source Contributions, Contribution Coverage against active pages, Source Gaps and Source TODOs for what's missing. Existing HTML → manifest matching now, ambiguity confirmed in-interview. Figma link without semantic-export provenance → a **Source TODO naming the `figma-sections-export` handoff command** — blocking source readiness unless waived, per ADR-0001; intake never fabricates exporter provenance. Nothing → template-stock, recorded as a Template Reference-backed `template_baseline` contribution — a valid coverage role, not degraded HTML.

**Stage 3 — Commerce & brand.** Evaluate every applicable Build Brief question class; **prompt only for the unresolved ones** (prefill from spec and asset crawl). Mode rule, resolving the prepared/guided-draft mechanics:

- **Complete interview** (no unresolved questions, no blocker gates) → write an ordinary **`prepared`** Brief with interview provenance in metadata.
- **Incomplete interview** → partial answers persist in the answers/checkpoint artifact, and intake produces a **hydrated `guided_draft`** — answered classes filled, unanswered ones carrying as guided-draft warnings exactly as today. A partially answered brief is never written as `prepared`, because prepared-mode unanswered questions are prepare-build blockers.
- **Never a third mode.**

This requires one scoped `prepare-build` integration: its brief evaluation accepts the checkpoint's answers reference, so answered classes do not resurface as questions or warnings.

Template family: intake computes a **candidate** with confidence; interactive confirmation or an explicit answers-file value produces `template_lock.locked_by: operator_ack` / `spec_hint_ack`. A recommendation alone never locks — the packet schema's own invariant.

**Stage 4 — Checkpoint.** Write the Intake Checkpoint artifact; render readback from it. Terminal output ends with exactly one thing: the next command, or the named blocks.

## Handoff into `prepare-build`

`prepare-build` **reuses and validates the intake-authored Design Source Package** (locality — regeneration would discard interview-confirmed mappings). If the package's material fingerprint is stale against current spec/source inputs, `prepare-build` refuses with a `re-run intake` next-action rather than silently regenerating. During ADR-0001's v0 compatibility window, the no-package legacy synthesis path remains for non-interviewed runs. The former "no `prepare-build` changes" boundary is amended to allow exactly this package/answers/reference consumption — without it, intake's principal artifacts disappear at the next command.

## Resume and overwrite authority

- Intake never silently overwrites operator-authored Brief decisions, producer-authored source manifests, or accepted Source Gaps and waivers; conflicts are surfaced as confirm-or-keep prompts (interactive) or `blocked_by` entries (non-interactive).
- A **material** Design Source Package change after Assembly evidence exists requires explicit confirmation, and downstream evidence tied to the old material fingerprint becomes visibly stale — ADR-0001's freshness model, not a new one.
- Re-running intake against unchanged fingerprints is idempotent: same checkpoint, no new mutations.

## The input contract (typed, verified against current behavior)

| Input | Class | Missing ⇒ |
|---|---|---|
| CampaignSpec (map-id or file) | required | `blocked`, with the Map Builder URL |
| CampaignSpec store profile (`campaign.store_url` real) | required | `blocked` (doctor blocks on it today; intake surfaces it first) |
| Target repository | required | bootstrap `next_actions` (state 3) or refusal (state 4) |
| Campaign scaffold in target | synthesizable | guarded `campaign-init` (state 2 only, post-confirmation, recorded as planned mutation) |
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
- The source-quality measurement lives in the domain's own vocabulary: Contribution Coverage, readiness status, and gap/TODO counts already classify every commission. **Adopted recommendation: the derived telemetry cohort is deferred** until intake has produced a few real Run Records — coverage, readiness, and gap/TODO counts are sufficient raw observations for v0.

## Acceptance

A fresh operator in a recognized page-kit repo, holding only a Map ID and a Figma link, reaches an Intake Checkpoint **without out-of-band help or invented answers**: spec fetched, Design Source Package drafted with the Figma contribution carrying its Source TODO, template candidate awaiting ack, unresolved Brief questions listed — a **valid `blocked` checkpoint whose `next_actions` are exact** (run the Figma export handoff; ack the family). With only a Map ID from a recognized repo, a confirmed Template Reference-backed family, and no remaining Source TODOs, the checkpoint is `ready_with_gaps` on the template-stock path. The same operator in an empty directory gets the named bootstrap steps, not a failure. `--non-interactive --answers` yields a semantically identical checkpoint. Negative control: intake must never manufacture a dead-end that `start` doesn't have.

Falsifier, per the ambient-instrumentation doctrine: if the next instrumented commission still produces friction rows of the on-2-005..007 classes (entry, topology, format, expects-vs-works-around), the interview failed regardless of how it demos.

## Build sequence

1. Land the Design Source Package emitter/schema where not yet complete (ADR-0001's contract is documented ahead of full implementation).
2. Pure Campaign Intake module (detection, versioned answers/reduction, readiness evaluation, next-action generation) **plus its public surface**: the `intake` command, answers schema, and checkpoint schema all register in `supported-surface` with hash updates and a `surface_version` bump — the DSP schema likewise when it lands in step 1. `CONTEXT.md` gains the Campaign Intake domain definition in the same slice.
3. Intake Checkpoint artifact + readback projection; scoped `prepare-build` integration (package reuse/validation, answers reference).
4. Interactive and JSON/non-interactive adapters at the module seam.
5. Guarded `campaign-init` delegation; then run-identity/telemetry wiring as its own versioned slice.
6. Tests: existing repo, empty directory, Figma-without-export (blocked, exact actions), ambiguous HTML, template confirmation vs. lock invariant, partial-interview → hydrated guided_draft round-trip, cancellation exit codes, resume with stale fingerprints, overwrite protection for operator-authored artifacts.

## Out of scope

New source adapters (still `html_funnel` only), moving `campaign-init` into campaigns-os, Campaigns App configuration, a web version of the interview (Map Builder portal intake is a plausible later home), changes to `start` semantics beyond the pointer line, and run-identity/telemetry surface changes beyond the versioned slice named above. `prepare-build` changes are limited to the scoped package/answers/reference consumption defined in "Handoff" — nothing else about its contract moves.

## Adopted decisions

Verb = `intake`. `campaign-init` runs only inside a recognized page-kit repo after explicit confirmation, recorded as a planned mutation first. Brief questions: evaluate all applicable classes, ask only unresolved; complete → `prepared`, partial → hydrated `guided_draft`, never a third mode. No source tier anywhere — Source Readiness and Contribution Coverage are the operator-facing truth. Derived telemetry cohort deferred until real Run Records exist.

## Remaining decision for Devin

Confirm the telemetry deferral (both reviews and this design recommend it), or pull the derived cohort into the v0 telemetry slice.
