# Intake Interview — Front-Door Design

**Date:** 2026-08-21
**Status:** Design for review, not yet built
**Evidence:** ON-2 operator feedback (`next-mind` deep-pass `friction-on-2` draft rows on-2-005..007) and a code survey of the current intake surface (2026-08-21)

## Problem

The first successful CLI command assumes the operator has already done four things off-tool, none of which any command checks: configured Campaigns App, exported a CampaignSpec from Map Builder, converted sources to page-kit-ready HTML, and chosen a template family. `start` demands `--spec|--map-id`, `--source`, `--target`, `--template-family` fully formed, and `tooling status` validates the checkout, not the commission. The ON-2 operator's feedback names the result precisely: unclear how to initiate, which repos need clones versus which are merely in the mix, where page-kit fits, what to provide in what order and format, and what the pipeline can work around versus expects.

Meanwhile the interview's payload already exists without an interviewer:

- `evaluateCampaignBuildBrief` (`src/build-brief.mjs:435-518`) emits 8 structured business questions with `options[]` and `blocking: true` — no code path ever asks them; in guided-draft mode they land in an artifact as warnings.
- The source-html intake drafts a manifest on ambiguous page mapping — an "explain what's missing" pattern already shipped.
- The findings journal schema includes `intake` and `start` stages — nothing emits into them, which is why ON-2's journal opened at polish.
- page-kit's `campaign-init` has a working @clack interactive flow — the estate's one real prompt loop, unreachable from campaigns-os.

The fix is one verb that holds the system's topology so the operator never has to.

## The verb

```
npm run campaigns-os -- intake [--target <dir>] [--non-interactive] [--json] [--answers <file>]
```

Zero required arguments. Interactive by default (@clack, matching `campaign-init`); `--non-interactive --answers` gives agents and CI byte-for-byte parity — the same interview as a data structure, which is what a P4 (agent-operated) run will drive. `start` and `prepare-build` keep their contracts, but every missing-input error gains one line: `Run: npm run campaigns-os -- intake`.

## Interview flow

Each ask follows one shape: **prompt → why it's needed → accepted formats → what happens if you skip it** (block / proceed-with-recorded-assumption / tool fills it and flags it). Never ask what can be detected; detect first, confirm second.

**Stage 0 — Environment.** Absorb `tooling status`, add what it doesn't check: Node >= 20.19, target repo present. No target repo → offer to run page-kit `campaign-init` (the flags exist: `--slug --api-key --ai-context --non-interactive`), which dissolves the "what does page-kit have to do with it" question — the operator never learns the boundary because the interview crosses it for them.

**Stage 1 — Commission.** Campaign name, merchant, and the spec: `--map-id` (fetched, cached — existing path), a local spec file, or neither. Neither → point at Map Builder with the edit URL and stop cleanly: planner-first means commerce is planned there, not improvised here.

**Stage 2 — Sources.** "What do you have?" The five documented entry points (`docs/entry-points.md`) become the answer enum: template-stock / Figma-driven / AI-generated / hand-authored / mixed. HTML dir → run manifest matching now, draft the manifest on ambiguity now (not at prepare-build). Figma → name the `figma-sections-export` handoff contract and its command. Nothing → template-stock is a valid answer, not a failure.

**Stage 3 — Commerce & brand.** Ask the Build Brief's 8 questions — finally. Prefill everything derivable from the spec and asset crawl; ask only what remains. Answers write a brief with a new mode, `interviewed`, which prepare-build treats like `prepared` (answered questions stop resurfacing as warnings).

**Stage 4 — Readiness report.** The interview's output artifact (`.campaign-runtime/intake-report.json` + terminal rendering):

- **Input contract table** — each input, its tier, its state, and the consequence.
- **Source tier grade** — see below.
- **Predicted output level** — what this commission can produce as graded.
- **The exact next command**, or the named blocks. Nothing else.

## The input contract (typed, not documented)

| Input | Tier | Missing ⇒ |
|---|---|---|
| CampaignSpec (map-id or file) | required | block, with the Map Builder URL |
| Campaigns API key | required | block (accepted via spec, flag, or `CAMPAIGNS_API_KEY`) |
| Target repo | synthesizable | interview runs `campaign-init` |
| Source HTML | degradable | template-stock path, recorded as adopted assumption |
| Source manifest | synthesizable | drafted from matching; ambiguity → confirm in-interview |
| Template family | synthesizable | recommended from certified catalog + spec hint; recorded as `template_lock.locked_by: "intake_recommendation"` |
| Store profile | degradable | proceeds; `page_kit.store_profile` checkpoint (#201 fix) judges it later |
| Brief answers | degradable | unanswered questions carry into the brief as today's guided-draft warnings |

## Instrumentation for free

Intake writes `stage: "intake"` findings to the workflow journal (schema-ready today) and stamps the **source tier** into the packet and build context:

- **T1 complete-reference** — manifest-governed HTML (ON-2's cell)
- **T2 partial-reference** — Figma-driven or mixed
- **T3 judgment-required** — template-stock or AI-generated

The tier remits through `/api/runs` with everything else, which makes every real commission self-classify on the source-quality axis with zero ceremony — and makes "better inputs ⇒ cleaner outputs" measurable: the tier is a recorded prediction; the QA verdict is its outcome.

## Acceptance

A fresh operator with an empty directory, a Map ID, and a Figma link reaches a graded readiness report **without asking a human anything**. Every block names its missing input and the action that supplies it. `--non-interactive --answers` produces an identical report. Negative control: an operator with nothing but a Map ID still exits with a valid report (T3, template-stock) — the interview must never manufacture a dead-end that `start` doesn't have.

Falsifier, per the ambient-instrumentation doctrine: if the next instrumented commission still produces friction rows of the on-2-005..007 classes (entry, topology, format, expects-vs-works-around), the interview failed regardless of how it demos.

## Out of scope

New source adapters (still `html_funnel` only), moving `campaign-init` into campaigns-os, Campaigns App configuration, a web version of the interview (Map Builder portal intake is a plausible later home; CLI first because the build is CLI), and any change to `start`/`prepare-build` semantics beyond the pointer line.

## Decisions for Devin

1. Verb name: `intake` (proposed) vs `begin`/`setup`.
2. May intake run `campaign-init` itself (proposed) or only print the command?
3. Brief-question posture at intake: all 8 asked (proposed, with prefill) or only the ones the spec can't answer?
4. Does the source tier appear in operator-facing output (proposed) or only in telemetry?
