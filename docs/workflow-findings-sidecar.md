# Workflow Findings Sidecar

Status: Draft design
Date: 2026-06-01

## Purpose

The Workflow Findings Sidecar gives Campaigns OS a lightweight Learning Trail.
It captures operator and agent observations about the workflow itself so the
toolchain can improve over time without turning campaign builds into a survey or
debug mode.

The sidecar exists because real Campaigns OS usage is messy. Operators may start
from a clean CampaignSpec and source export, or they may invoke Campaigns OS
midstream after tinkering with assets, page code, checkout wiring, or an existing
repo. The workflow should still push toward completeness and make the next proof
step visible.

## Core Signal

The most important early signal is that Spec-Driven Campaign Development works:
when the CampaignSpec is accurate, checkout and upsell integration have rails
and remain verifiable.

The sidecar should capture positive signals like this alongside friction,
missing prompts, blockers, docs gaps, and automation gaps. A learning system that
only records failures will miss what should be reinforced.

## Public And Internal Boundary

Public `campaigns-os` owns local Finding Capture:

- Workflow Finding records.
- Findings Journal validation.
- Tiny Prompts at natural stage boundaries.
- Local listing and export.

Internal campaign operations tooling owns aggregation and routing:

- clustering findings across runs;
- deriving trend reports;
- routing owner-specific follow-up;
- creating or updating Linear issues;
- internal dashboards or project summaries.

The public package must not require Linear access or NEXT internal context to
capture a finding.

## Non-Goals

- Do not replace the Build Packet.
- Do not replace the Assembly Report.
- Do not replace doctor output.
- Do not replace QA Verdicts.
- Do not auto-run QA or typed-card test orders.
- Do not upload findings automatically.
- Do not expose findings to shoppers, merchant-facing approval viewers, or live
  campaign pages.
- Do not record skipped Tiny Prompts as findings.

## Findings Journal

The primary public artifact is an append-only local journal:

```text
.campaign-runtime/workflow-findings.jsonl
```

Each line is one Workflow Finding. The journal preserves what was observed;
summaries, deduplication, owner classification, and routing are derived later by
internal aggregation.

## Workflow Finding v0

The public package should ship a JSON Schema for this record:

```text
schemas/campaigns-os-workflow-finding.v0.schema.json
```

The schema should be strict about the required core and permissive about optional
context fields. Validate each entry before appending it to the Findings Journal,
and validate structured JSON exports before output.

Required fields:

- `schema_version`
- `id`
- `created_at`
- `stage`
- `kind`
- `summary`

Recommended optional fields:

- `details`
- `expected`
- `actual`
- `severity`
- `artifact_paths`
- `command`
- `command_exit_status`
- `source_type`
- `template_family`
- `map_id`
- `campaign_slug`
- `target_repo`
- `packet_path`
- `assembly_report_path`
- `qa_run_id`
- `author_type`
- `evidence_quality`
- `suggested_owner`
- `safe_to_share`

`stage` should use the Observation Stage vocabulary:

- `overall`
- `intake`
- `start`
- `doctor`
- `setup`
- `build`
- `polish`
- `deploy`
- `qa`
- `test-order`
- `next`

`kind` should stay small:

- `positive_signal`
- `friction`
- `missing_prompt`
- `blocker`
- `docs_gap`
- `automation_gap`
- `idea`

`author_type` should make the signal source clear:

- `operator`
- `agent`
- `system`

`evidence_quality` should prevent weak-but-useful feedback from pretending to be
formal proof:

- `operator_report`
- `artifact_referenced`
- `artifact_attached`
- `system_observed`

## Tiny Prompts

Tiny Prompts are skippable one-line prompts at stage boundaries. They should
make the next expected proof step visible and optionally capture a Workflow
Finding.

Examples:

```text
Next expected proof: preview deploy, then browser QA.
Record workflow finding? [y/N]
```

```text
Local-only QA evidence created (--no-post-verdict). Omit that flag to publish to the QA portal.
Record workflow finding? [y/N]
```

If the operator skips the prompt, Campaigns OS records nothing.

## Expected Proof Steps

Campaigns OS should make expected proof steps visible without silently executing
them.

Examples:

- After `doctor`: explain whether inputs are ready or blocked.
- After `build`: point toward polish, deploy, and QA.
- After `polish`: point toward preview deploy and QA.
- After deploy evidence is recorded: point toward browser QA.
- When `next` returns `qa`: show the exact QA command.
- When build/polish evidence exists but no QA verdict exists: allow an agent or
  system finding as a Completeness Signal.

Browser QA and typed-card proof require a tested base URL. Localhost on any port
is a Campaigns App Development domain (SDK allowed, analytics suppressed);
non-localhost preview/production origins still need SDK origin allowlist
confirmation. Typed-card proof itself needs no permission gate — choose the
order depth (`common` by default, explicit path, or `full`) and keep
`--max-test-orders` as the accidental-flood guard.

## Contribution Boundary

Finding Contribution is explicit. The public sidecar captures locally by
default; it does not phone home.

Default export or submit payloads should include references and summaries:

- Workflow Finding entries;
- command names and exit status;
- artifact paths;
- hashes or run IDs;
- counts and classifications.

Default payloads should not include artifact contents:

- raw CampaignSpec JSON;
- source HTML;
- screenshots;
- full QA verdict bodies;
- full doctor output bodies;
- full Assembly Report bodies;
- API keys;
- merchant/customer copy.

Artifact contents require an explicit attachment choice.

## MVP Command Sketch

First public surface:

```bash
campaigns-os findings add \
  --stage overall \
  --kind positive_signal \
  --summary "Spec-driven dev kept checkout and upsell logic intact"

campaigns-os findings list

campaigns-os findings export --summary
```

`findings add` should be flags-first so agents and scripts can record findings
without prompts. When run without enough flags, it may fall back to a tiny
interactive prompt for only:

- stage;
- kind;
- summary;
- optional details.

Do not add editor mode in v0. Long-form editing can come later if real usage
shows the need.

`findings export --summary` should emit Markdown by default so operators can
paste a concise run summary into Linear, GitHub, Slack, or an agency handoff.
Structured JSON should be explicit:

```bash
campaigns-os findings export --json
```

The JSON export is for internal ingestion and automated aggregation.

Tiny Prompt support should call the same underlying Finding Capture path instead
of creating a separate prompt-only data model.

Deferred:

```bash
campaigns-os findings submit
```

Submission belongs behind the explicit Contribution Boundary and may be backed by
internal campaign operations ingestion later.

## Open Questions

None at this layer.

Internal aggregation should group by Observation Stage first and Finding Kind
second. `source_type`, `template_family`, and `suggested_owner` are filters or
routing aids, not the first clustering dimension.
