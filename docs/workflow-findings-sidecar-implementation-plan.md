# Implement Workflow Findings Sidecar v0

Status: Ready for implementation
Date: 2026-06-01
Primary design: [Workflow Findings Sidecar](./workflow-findings-sidecar.md)
Glossary: [Campaigns OS Context](../CONTEXT.md)

## Linear-Ready Ticket

Title: Implement Campaigns OS Workflow Findings Sidecar v0

Team: Campaigns OS

Purpose:
Add a lightweight, local-first sidecar to public `campaigns-os` so operators and
agents can capture structured Workflow Findings without requiring Linear access,
NEXT internal context, or a heavy debug mode.

Why this matters now:
Brett's Vitae Charm run produced two important signals: accurate CampaignSpec
data made checkout/upsell integration flow smoothly, and QA was not obvious as
the next expected proof step. Round 2 dogfood should make these signals cheap to
capture across internal and future agency operators.

## Scope

Implement the public-package MVP only:

- JSON Schema for Workflow Finding v0.
- Append-only local Findings Journal under `.campaign-runtime/`.
- `campaigns-os findings add`.
- `campaigns-os findings list`.
- `campaigns-os findings export --summary`.
- `campaigns-os findings export --json`.
- Tiny Prompt copy at the clearest existing stage boundaries where it can be
  added without making commands interactive by surprise.
- Tests and docs for the v0 surface.

Out of scope:

- `campaigns-os findings submit`.
- Linear issue creation or updates.
- Internal aggregation dashboards.
- Automatic uploads or telemetry.
- Artifact-content attachment.
- Editor mode.
- Auto-running browser QA or typed-card test orders.
- Replacing Assembly Report, doctor output, or QA Verdicts.

## Implementation Notes

### 1. Schema

Add:

```text
schemas/campaigns-os-workflow-finding.v0.schema.json
```

Required fields:

- `schema_version`
- `id`
- `created_at`
- `stage`
- `kind`
- `summary`

Enums:

- `schema_version`: `campaigns-os-workflow-finding/v0`
- `stage`: `overall`, `intake`, `start`, `doctor`, `setup`, `build`,
  `polish`, `deploy`, `qa`, `test-order`, `next`
- `kind`: `positive_signal`, `friction`, `missing_prompt`, `blocker`,
  `docs_gap`, `automation_gap`, `idea`
- `author_type`: `operator`, `agent`, `system`
- `evidence_quality`: `operator_report`, `artifact_referenced`,
  `artifact_attached`, `system_observed`

Keep optional fields permissive:

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
- `suggested_owner`
- `safe_to_share`

### 2. CLI Surface

Extend `src/cli.mjs` command dispatch with:

```bash
campaigns-os findings add
campaigns-os findings list
campaigns-os findings export --summary
campaigns-os findings export --json
```

`findings add` should be flags-first:

```bash
campaigns-os findings add \
  --stage overall \
  --kind positive_signal \
  --summary "Spec-driven dev kept checkout and upsell logic intact"
```

When required flags are missing and stdout is interactive, use a tiny fallback
prompt for only:

- stage;
- kind;
- summary;
- optional details.

When required fields are missing and the command is non-interactive, fail with a
clear message that names the missing flags.

### 3. Journal Location

Default journal path:

```text
<target-or-cwd>/.campaign-runtime/workflow-findings.jsonl
```

The command should support an explicit override for tests and unusual runs:

```bash
--journal <path>
```

If no `--journal` is provided, prefer:

1. packet-adjacent target repo when `--packet <path>` is supplied;
2. current working directory otherwise.

Create `.campaign-runtime/` as needed.

### 4. Entry Shape

Generated values:

- `id`: stable unique local ID, e.g. `wf_<timestamp>_<random>`.
- `created_at`: current ISO timestamp.
- `schema_version`: `campaigns-os-workflow-finding/v0`.
- `author_type`: default `operator` for manual CLI adds.
- `evidence_quality`: default `operator_report` unless evidence flags imply
  `artifact_referenced`.

Append exactly one JSON object per line. Do not rewrite existing entries.

### 5. List And Export

`findings list`:

- reads the journal;
- prints a concise table or bullet list by default;
- supports `--json`.

`findings export --summary`:

- emits Markdown by default;
- groups by Observation Stage first and Finding Kind second;
- includes counts and short summaries;
- includes artifact paths/run IDs as references only.

`findings export --json`:

- emits structured JSON for internal ingestion;
- validates entries before output;
- does not include artifact contents.

### 6. Tiny Prompts

Add Tiny Prompt copy only where it does not unexpectedly block or survey the
operator.

Recommended v0 placements:

- `doctor` text output: show the next expected proof/setup/build step, and point
  to `findings add` for confusing blockers.
- `next` text output: when the selected stage is `qa`, show the exact QA command
  and mention that missing QA after build/polish is a Workflow Finding, not a
  build failure.
- `qa run` text output: if `--post-verdict` was not used, keep the existing
  local-only warning and add a one-line `findings add` suggestion.

Do not add interactive prompts to `--json` output. JSON mode must stay
machine-readable.

### 7. Tests

Extend `scripts/check-fixtures.mjs` or add focused node tests so `npm run check`
covers:

- schema accepts a minimal valid finding;
- schema rejects missing required fields;
- `findings add` appends one JSONL entry;
- repeated `findings add` preserves append-only behavior;
- `findings list --json` reads entries;
- `findings export --summary` emits Markdown grouped by stage/kind;
- `findings export --json` emits valid structured JSON;
- missing required flags fail clearly in non-interactive mode;
- `--json` command outputs remain parseable and contain no Tiny Prompt prose.

Also run:

```bash
npm run check
```

### 8. Docs

Update:

- `README.md` with a short Workflow Findings Sidecar mention.
- `docs/workflow-findings-sidecar.md` if implementation details differ from the
  design.
- `docs/versioning.md` with the new schema name.

Do not expand public docs into internal aggregation or Linear routing details.

## Acceptance Criteria

- A Campaigns OS operator can record a positive signal from Brett's Vitae
  Charm-style run using one CLI command.
- A non-interactive agent can record an observed missing-QA Completeness Signal
  without prompting.
- The Findings Journal is append-only JSONL under `.campaign-runtime/`.
- Markdown export is pasteable into Linear/GitHub/Slack.
- JSON export is suitable for future internal campaign operations ingestion.
- Commands do not require Linear access or NEXT internal credentials.
- No finding is uploaded automatically.
- Skipped Tiny Prompts are not recorded.
- `npm run check` passes.

## Suggested First Test Commands

```bash
npm run campaigns-os -- findings add \
  --journal /tmp/campaigns-os-findings.jsonl \
  --stage overall \
  --kind positive_signal \
  --summary "Spec-driven dev kept checkout and upsell logic intact"

npm run campaigns-os -- findings list \
  --journal /tmp/campaigns-os-findings.jsonl

npm run campaigns-os -- findings export --summary \
  --journal /tmp/campaigns-os-findings.jsonl

npm run campaigns-os -- findings export --json \
  --journal /tmp/campaigns-os-findings.jsonl
```

## Follow-Up Ticket Trigger

Create a separate internal operations issue only after v0 public capture exists
and at least three real runs produce journals. The follow-up should ingest
exported JSON, group by Observation Stage and Finding Kind, and propose issue
batches without changing the public package boundary.
