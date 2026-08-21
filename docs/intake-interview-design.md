# Intake Interview — Front-Door Design

**Date:** 2026-08-21 · **Revision 2** (same day), incorporating the adversarial architecture review; all of its schema/ADR citations verified against the tree
**Status:** Design for review, not yet built
**Evidence:** ON-2 operator feedback (`next-mind` deep-pass `friction-on-2` draft rows on-2-005..007), code survey of the intake surface, architecture review (2026-08-21)

## Problem

The first successful CLI command assumes the operator has already done four things off-tool, none of which any command checks: configured Campaigns App, exported a CampaignSpec from Map Builder, converted sources to page-kit-ready HTML, and chosen a template family. `start` demands `--spec|--map-id`, `--source`, `--target`, `--template-family` fully formed, and `tooling status` validates the checkout, not the commission. The ON-2 operator's feedback names the result precisely: unclear how to initiate, which repos need clones versus which are merely in the mix, where page-kit fits, what to provide in what order and format, and what the pipeline can work around versus expects.

The interview's raw material already exists without an interviewer:

- `evaluateCampaignBuildBrief` (`src/build-brief.mjs:435-518`) defines up to eight conditional question classes with `options[]` — evaluated, never asked; in guided-draft mode they land in an artifact as warnings.
- ADR-0001's Design Source Package normalizes source provenance, Contribution Coverage, Surface Identity, Source Gaps/TODOs, and Source Readiness — the source model intake must feed, not duplicate.
- The findings journal schema includes `intake` and `start` stages — nothing emits into them, which is why ON-2's journal opened at polish.
- page-kit's `campaign-init` has a working @clack prompt loop, unreachable from campaigns-os.

The fix is one verb that **coordinates the existing modules** — CampaignSpec, Build Brief, Design Source Package, Readiness, Run Telemetry — so the operator never has to hold the topology. It introduces no parallel source truth and no readiness dialect.

## The verb

```
npm run campaigns-os -- intake [--target <dir>] [--non-interactive] [--json] [--answers <file>]
```

Zero required arguments. Architecturally one deep **Campaign Intake module** owns detection, answer application, readiness evaluation, and next-action generation; interactive @clack and non-interactive/JSON are thin adapters at the same seam. `--json` is prompt-free by definition. Interactive and non-interactive runs have **semantic parity** (same evaluation, same report content), not byte parity — timestamps and provenance legitimately differ. Cancellation and blocked outcomes get distinct exit codes. `start`/`prepare-build` semantics are untouched; their missing-input errors gain one pointer line: `Run: npm run campaigns-os -- intake`.

### Answers contract (non-interactive spine)

- A versioned answers document (`campaigns-os-intake-answers/v0`) with stable choice values per question class — `options[]` display strings are not the contract.
- Deterministic answer→Brief reduction: each choice value maps to a defined patch of nested Brief fields.
- Precedence: explicit CLI flag → answers file → detected fact → default.
- Unknown keys, stale answers (spec/source fingerprint mismatch), and missing answers each have defined behavior: unknown → error; stale → re-ask (interactive) or blocked (non-interactive); missing → question remains unresolved in the report.
- Spec and source material fingerprints are recorded so a resumed interview knows what its previous answers were about.

## Interview flow

Each ask follows one shape: **prompt → why it's needed → accepted formats → what happens if you skip it**. Never ask what can be detected; detect first, confirm second.

**Stage 0 — Environment.** Absorb `tooling status`, add Node >= 20.19 and target-repository resolution. Four target states, handled distinctly:

1. **Page-kit repo, campaign present** — resume posture; intake updates rather than scaffolds.
2. **Page-kit repo, no campaign** — the only state where intake may run `campaign-init`, and only after the spec, slug, and template family are confirmed (Stages 1–3) and the operator explicitly permits the mutation.
3. **Empty directory** — intake names the bootstrap steps (clone/create a page-kit repo, `npm install`) as `next_actions`; it does not fabricate a repository. `campaign-init` installs into an existing repo and cannot bootstrap one.
4. **Non-page-kit repository** — refuse with an explanation; never scaffold into a foreign tree.

**Stage 1 — Commission.** Campaign name, merchant, and the spec: `--map-id` (fetched, cached — existing path), a local spec file, or neither. Neither → point at Map Builder with the edit URL and stop cleanly: planner-first means commerce is planned there, not improvised here.

**Stage 2 — Sources → Design Source Package.** "What do you have?" — the entry-point question (template-stock / Figma-driven / AI-generated / hand-authored / mixed, per `docs/entry-points.md`) routes *detection only*; it is not a taxonomy in any artifact. The stage's output is a drafted or updated **Design Source Package** per ADR-0001: page-level Design Source Contributions, Contribution Coverage against active pages, Source Gaps and Source TODOs for what's missing. Existing HTML → manifest matching now, ambiguity confirmed in-interview. Figma link without semantic-export provenance → a **Source TODO naming the `figma-sections-export` handoff command**; intake never fabricates exporter provenance. Nothing → template-stock, recorded as a Template Reference-backed `template_baseline` contribution — a valid coverage role, not degraded HTML.

**Stage 3 — Commerce & brand.** Evaluate every applicable Build Brief question class; **prompt only for the unresolved ones** (prefill from spec and asset crawl). Answers write an ordinary **`prepared`** Build Brief with interview provenance in metadata — no new mode, no schema churn. Template family: intake computes a **candidate** with confidence; interactive confirmation or an explicit answers-file value produces `template_lock.locked_by: operator_ack` / `spec_hint_ack`. A recommendation alone never locks — the packet schema's own invariant.

**Stage 4 — Intake Readiness Checkpoint.** Not a bespoke report: a formal checkpoint using the shared status vocabulary (`pending | blocked | ready | ready_with_gaps | ready_with_waivers | …`) and the Campaign Readiness Readback buckets — `handled`, `blocked_by`, `known_gaps`, `waivers`, `evidence`, `next_actions`. It references the CampaignSpec, Build Brief, and Design Source Package by path + fingerprint; it duplicates none of their truth. Terminal rendering ends with exactly one thing: the next command, or the named blocks.

## The input contract (typed, verified against current behavior)

| Input | Class | Missing ⇒ |
|---|---|---|
| CampaignSpec (map-id or file) | required | block, with the Map Builder URL |
| Target repository | required | bootstrap `next_actions` (state 3) or refusal (state 4) |
| Campaign scaffold in target | synthesizable | guarded `campaign-init` (state 2 only, post-confirmation) |
| Campaigns API key | degradable | warning; API-side package/shipping/offer confirmation deferred (`src/cli.mjs:4260` behavior, unchanged) |
| Source HTML / design source | degradable | Template Reference-backed `template_baseline` coverage, or Source Gaps/TODOs per contribution |
| Source manifest | synthesizable | drafted from matching; ambiguity confirmed in-interview |
| Template family | synthesizable candidate | recommended, **never locked**, until operator/spec ack |
| Figma export provenance | required for Figma-driven coverage | Source TODO naming the export command |
| Store profile parity | out of intake | owned by the `page_kit.store_profile` checkpoint downstream |
| Brief answers | degradable | unresolved questions carry in the brief exactly as guided-draft does today |

## Instrumentation (scoped work, not free)

- Intake appends `stage: "intake"` findings **only for genuine friction and missing prompts** — ordinary missing commission inputs belong in `blocked_by`, Source Gaps, or Source TODOs, not the findings journal.
- When Campaign Run Identity begins is an open design item: run sessions currently start at `start`/`prepare-build`. Moving the start to intake, adding an intake observation to the run-record schema, and any source-cohort field are **versioned public-surface changes** with their own slice — the run-record schema has no intake artifact kind today.
- The source-quality measurement survives in the domain's own vocabulary: Contribution Coverage, readiness status, and gap/TODO counts already classify every commission. A derived telemetry cohort, if wanted, is computed downstream from those fields and is never labeled "source quality."

## Acceptance

A fresh operator in an existing page-kit repo, holding only a Map ID and a Figma link, reaches an Intake Readiness Checkpoint **without asking a human anything**: spec fetched, Design Source Package drafted with the Figma contribution carrying a Source TODO for the export handoff, template candidate awaiting ack, unresolved Brief questions listed, `next_actions` exact. The same operator in an empty directory gets the named bootstrap steps, not a failure. `--non-interactive --answers` yields a semantically identical checkpoint. Negative control: an operator with nothing but a Map ID still exits `ready_with_gaps` on the template-stock path — intake must never manufacture a dead-end that `start` doesn't have.

Falsifier, per the ambient-instrumentation doctrine: if the next instrumented commission still produces friction rows of the on-2-005..007 classes (entry, topology, format, expects-vs-works-around), the interview failed regardless of how it demos.

## Build sequence

1. Land the Design Source Package emitter/schema where not yet complete (ADR-0001's contract is documented ahead of full implementation).
2. Pure Campaign Intake module: detection, versioned answers/reduction, readiness evaluation, next-action generation.
3. Formal Intake Checkpoint + readback projection.
4. Interactive and JSON/non-interactive adapters at the module seam.
5. Guarded `campaign-init` delegation; then telemetry/public-surface wiring as its own versioned slice.
6. Tests: existing repo, empty directory, Figma-without-export, ambiguous HTML, template confirmation vs. lock invariant, cancellation exit codes, resume with stale fingerprints, overwrite protection.

## Out of scope

New source adapters (still `html_funnel` only), moving `campaign-init` into campaigns-os, Campaigns App configuration, a web version of the interview (Map Builder portal intake is a plausible later home), any change to `start`/`prepare-build` semantics beyond the pointer line, and run-identity/telemetry surface changes beyond the versioned slice named above.

## Adopted decisions (from the 2026-08-21 review)

Verb = `intake`. `campaign-init` runs only inside a recognized page-kit repo after explicit confirmation. Brief questions: evaluate all applicable classes, ask only unresolved. No source tier in operator output or packet/context — Source Readiness and Contribution Coverage are the operator-facing truth.

## Remaining decision for Devin

Whether the derived telemetry cohort (computed from coverage/gap/readiness fields, for the inputs→outcomes curve) is in the v0 telemetry slice or deferred until intake itself proves out.
