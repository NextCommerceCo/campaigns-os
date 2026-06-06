# Run Telemetry

Status: Draft design
Date: 2026-06-06

> Supersedes the v0 "Workflow Findings Sidecar" framing. The sidecar was
> local-only and never remitted; Run Telemetry keeps local capture but adds a
> consented, opt-out remit so each run can improve the product. Workflow
> Findings are now one channel inside a per-run Run Record. (Filename retained
> for now to avoid link churn; the surface is "Run Telemetry".)

## Purpose

Every Campaigns OS run produces signal about how the build went — what the
doctor flagged, which spec rules fired, which adapter decisions were taken, how
QA resolved, how many repair loops it took, plus anything an operator or agent
noticed. Today that signal is discarded at the end of the run.

Run Telemetry captures that signal as a structured **Run Record** and, when the
operator has opted in, remits it to Next Commerce so the toolchain can improve
over time — better skills, tools, templates, and design sources. The goal is a
loop: a real run surfaces friction, the friction is analyzed, the fix ships, the
next run is smoother.

This is the "share usage data to improve the product" pattern, made explicit and
asked once, up front.

## What Changed From v0

The Workflow Findings Sidecar was deliberately local-only: capture findings on
disk, never phone home, contribute each item explicitly. Run Telemetry keeps the
local trail but changes the contribution model:

- **Capture is always local.** The Run Record is written regardless of consent;
  it is useful to the operator/agent on its own.
- **Consent gates remit, not capture.** One up-front opt-out (captured at
  `start`) decides only whether records are sent. Opt-outs lose nothing locally.
- **The unit is the Run Record, not a single finding.** Findings (manual and
  harvested) are one channel within it.

## The Run Record

The Run Record is the per-run telemetry artifact. It collects the structured
signal the system already produces, so it does not depend on anyone remembering
to write a finding. A versioned JSON schema ships in `schemas/`.

A Run Record carries:

- **Run identity** — `map_id`, `campaign_slug`, `target_repo`, `packet_path`,
  `assembly_report_path`, `qa_run_id`, `source_type`, `template_family`,
  `entry_point_shape`, timestamps. (May be partial; missing identity never
  blocks capture.)
- **System signal** — doctor status and codes (error / warning / ready), which
  `spec.validation` rules fired, adapter decisions taken, QA verdict disposition
  and gap classes, repair-loop count, stage transitions/timings, command exit
  statuses.
- **Findings channel** — Workflow Findings (manual + harvested) in the existing
  `campaigns-os-workflow-finding` shape, nested under the Run Record.
- **Improvement-surface tags** — see below.

The schema is strict about a small required core and permissive about optional
context. Validate before writing locally and before remitting.

## Improvement-Surface Taxonomy

For telemetry to improve a specific thing, each signal must be mappable to the
surface it should improve. The Run Record uses a small canonical taxonomy:

- `skill` — an agent skill / prompt (e.g. build, polish, qa)
- `cli` — a Campaigns OS command or its output
- `template` — a starter template / family contract
- `design-source` — a producer or design intake method (Figma, AI-generated, …)
- `docs` — guidance / documentation gaps
- `spec-rule` — the CampaignSpec rule registry
- `platform` — SDK / Campaigns API / runtime behavior

A signal may carry a best-effort surface tag; analysis (internal) refines and
clusters. This is the grown-up form of the v0 `suggested_owner` field.

## Consent

Consent is asked once, up front, at `start`, in plain language — for example:

```text
Campaigns OS can send build telemetry to Next Commerce to help improve
templates, tools, and guidance. Share telemetry from this machine? [Y/n]
(You can change this any time.)
```

- The choice is persisted to a local Campaigns OS config.
- It can be changed at any time (a CLI flag and a config edit both work).
- It gates **remit only**. With consent off, runs still write the local Run
  Record and `findings`/`export` still work.
- No run is ever blocked on telemetry, and telemetry is never shown to shoppers
  or merchant-facing approval viewers.

## Data Boundary

Run Telemetry carries the run's structure and identity, not its secrets or its
raw contents.

Included:

- run identity and structural signal (codes, rule IDs, decisions, verdict
  disposition, counts, timings);
- Workflow Finding entries, command names and exit status;
- artifact paths, hashes, run IDs, counts and classifications.

Never included:

- API keys or credentials;
- customer / personal data;
- full artifact bodies — raw CampaignSpec JSON, source HTML, screenshots, full
  QA verdict / doctor / Assembly Report bodies.

Artifact contents only ever travel by an explicit, separate attachment choice —
never as part of routine remit. The patterns are the signal; the raw bodies and
secrets are pure risk and stay out.

## Capture Surfaces

The Run Record is assembled from several inputs, all local:

- **System signal** — collected automatically from each run's doctor output,
  Assembly Report, and QA verdict when present.
- **`findings harvest`** — proposes Workflow Findings from doctor blockers,
  selected warnings, and report blockers; `--write` appends them.
- **`findings add`** — flags-first manual capture for operators and agents.
- **Tiny Prompts** — skippable one-line prompts at stage boundaries that surface
  the next expected proof step and optionally capture a finding. Skipped prompts
  record nothing.

The local journal remains `.campaign-runtime/workflow-findings.jsonl` for the
findings channel; the assembled Run Record is written alongside it.

## Remit Channel

When consent is on, the Run Record is remitted to the Next Commerce portal over
the same transport as QA verdicts (a POST to the proxy/portal). The public
package only emits and remits — it does not cluster, route, summarize across
runs, or create issues. Remit failures are non-fatal: the local Run Record is
the source of truth and a failed send never blocks a build.

## Public / Internal Boundary

- **Public `campaigns-os`** owns: the Run Record schema, local capture, the
  up-front consent, and the remit channel. Capturing or opting out must never
  require internal Next Commerce access.
- **Internal tooling** owns: ingestion, clustering, surface-mapping, trend
  analysis, and turning the backlog into improvement candidates (spec rules,
  template fixes, skill edits, issues). The loop closes through normal
  development informed by that backlog — the system does not edit itself.

## Non-Goals

- Do not replace the Build Packet, Assembly Report, doctor output, or QA
  Verdicts — the Run Record references the proof trail, it is not the proof
  trail.
- Do not auto-run QA or typed-card test orders.
- Do not edit skills, templates, or rules automatically (no auto-codegen).
- Do not ship secrets, customer data, or raw artifact bodies.
- Do not block a build on telemetry, and do not expose telemetry to shoppers or
  merchant-facing approval viewers.
- Do not record skipped Tiny Prompts.

## Workflow Finding Shape

The findings channel keeps the existing record shape
(`schemas/campaigns-os-workflow-finding.v0.schema.json`): required core
`schema_version`, `id`, `created_at`, `stage`, `kind`, `summary`; the
`stage` / `kind` / `author_type` / `evidence_quality` vocabularies; and optional
context fields. `evidence_quality` still keeps weak-but-useful operator signal
from masquerading as formal proof.

## Build Order

1. **Run Record schema** (versioned) with the improvement-surface taxonomy, and
   the findings channel nested.
2. **Local always-on capture** — assemble and write the Run Record each run.
3. **Up-front consent** at `start`, persisted, opt-out honored everywhere remit
   could occur.
4. **Remit channel** to the portal, consent-gated, non-fatal.

`findings add` / `findings harvest` / `findings export` keep working unchanged
until the Run Record schema lands; they become the findings channel of the Run
Record rather than a separate surface.

## Open Questions

- Exact Run Record field list and schema version name (resolved when the schema
  is authored against the current packet / report / verdict artifacts).
- Remit endpoint path and payload envelope (aligned with the QA verdict
  publishing rails).
