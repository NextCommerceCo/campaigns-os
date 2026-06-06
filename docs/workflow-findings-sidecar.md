# Run Telemetry

Status: Design locked (eng review 2026-06-06) — schema-first build pending
Date: 2026-06-06

> Supersedes the v0 "Workflow Findings Sidecar" framing. The sidecar was
> local-only and never remitted; Run Telemetry keeps local capture but adds a
> consented, opt-out remit so each run can improve the product. Workflow
> Findings are now one channel inside a per-run Run Record. (Filename retained
> for now to avoid link churn; the surface is "Run Telemetry".)

## Purpose

Every Campaigns OS run produces signal about how the build went — what the
doctor flagged, which spec rules fired, which adapter decisions were taken, how
QA resolved, plus anything an operator or agent noticed. Today that signal is
discarded at the end of the run.

Run Telemetry captures that signal as a structured **Run Record** and, when the
operator has opted in, remits it to Next Commerce so the toolchain can improve
over time — better skills, tools, templates, and design sources. The goal is a
loop: a real run surfaces friction, the friction is analyzed, the fix ships, the
next run is smoother.

This is the "share usage data to improve the product" pattern, made explicit and
asked once, up front.

## What Changed From v0

The Workflow Findings Sidecar was deliberately local-only. Run Telemetry keeps
the local trail but changes the contribution model:

- **Capture is always local.** The Run Record is written regardless of consent.
- **Consent gates remit, not capture.** A single up-front opt-out decides only
  whether records are sent. Opt-outs lose nothing locally.
- **The unit is the Run Record, not a single finding.** Findings (manual and
  harvested) are one channel within it.

## The Run Record (manifest model)

The Run Record is a per-run **manifest**, not a giant unified artifact. It is
keyed by one canonical `run_id` and is written to:

```text
.campaign-runtime/run-records/<run_id>.json
```

It does **not** re-embed the full bodies of other artifacts (those have their
own schemas and evolve independently). Instead it carries:

- **Stable envelope** — `schema_version` (`campaigns-os-run-record/v0`),
  `run_id`, package version, the command that ran, an `argv` *shape* (flag names
  present, not raw values), `created_at`, consent state, and remit status.
- **Run identity** — `map_id`, `campaign_slug`, `template_family`,
  `entry_point_shape`. (Best-effort; missing identity never blocks capture.)
- **Source artifact refs** — for the Build Packet, Build Context, Assembly
  Report, doctor output, QA verdict, and findings journal: `{ path,
  schema_version, sha256 }`. References, not copies. This is what survives
  upstream schema drift.
- **Normalized observation arrays** — the extracted signal: doctor issue codes
  (error/warning/ready), `spec.validation` rule IDs that fired, adapter
  decisions, QA verdict disposition + gap classes, and the **finding IDs** for
  this run.
- **Findings snapshot** — this run's Workflow Findings (see channel below).

### Run identity

A single canonical `campaigns_os_run_id` is minted at the run boundary and
threaded through the run so every artifact and finding correlates. It is also
the **idempotency key**: re-running or retrying remit for the same `run_id` must
not double-count downstream (the endpoint upserts on `run_id`).

> **v0 scope cut.** Stage timings and repair-loop count are **deferred** — they
> are not reliably observable from current artifacts (statuses, not start/end
> timings; no repair-loop artifact). They return when command-lifecycle
> instrumentation lands. v0 does not claim signal it cannot measure.

### Validation

Hand-rolled validator + JSON Schema doc, matching the existing
`campaigns-os-workflow-finding` pair. **No AJV** (repo convention). The
validator checks the envelope + observation-array shapes; it does **not**
re-validate nested artifact bodies (those are referenced by hash, not embedded).

## Improvement-Surface Taxonomy

Each observation can map to the surface it should improve. Real signal is rarely
one surface, so the field is a list, not an enum:

- `surfaces: []` — any of `skill | cli | template | design-source | docs |
  spec-rule | platform`
- `primary_surface` — optional, the best single guess
- `surface_confidence` — optional

A best-effort tag travels with the signal; internal analysis refines and
clusters. This is the grown-up form of the v0 `suggested_owner` field.

## Consent

Consent is a **machine/user-level** setting (consent belongs to the operator,
not the campaign), resolved through one shared resolver that **every remitting
command calls** — not a one-time `start` prompt that later commands bypass.

- **Stored** at user level (e.g. `~/.config/campaigns-os/config.json`) with its
  own `schema_version`, the package name, the proxy/endpoint scope, a timestamp,
  and the value source.
- **Prompted once, up front** — the first interactive command that would remit
  asks plainly: "Campaigns OS can send build telemetry to Next Commerce to
  improve templates, tools, and guidance. Share telemetry from this machine?
  [Y/n] (change any time)."
- **`campaigns-os telemetry status | on | off`** — explicit control without
  hunting for the config file.
- **Env override** — `CAMPAIGNS_OS_TELEMETRY` accepts `1|true|on` /
  `0|false|off`; it beats the file (CI/automation). An **unknown** value
  fails closed (no remit) with a warning, never a silent guess.
- **Unknown + non-interactive** (no file, no env, no TTY) → **OFF**. Never remit
  without an explicit yes.

Consent gates **remit only**. With consent off, runs still write the local Run
Record and `findings`/`export` still work. No run is ever blocked on telemetry,
and telemetry is never shown to shoppers or merchant-facing approval viewers.

## Data Boundary

Run Telemetry carries the run's structure and identity, not raw artifact bodies,
and applies light minimization to identifying-but-non-essential fields.

Included:

- run identity (`map_id`, `campaign_slug`, `template_family`) — these are the
  join keys that make the telemetry useful;
- structural signal (doctor codes, spec-rule IDs, adapter decisions, QA
  disposition, finding IDs);
- artifact refs (`path`, `schema_version`, `sha256`), counts, classifications.

Minimized / excluded:

- **Absolute local paths** → relativized or hashed (no contributor filesystem
  layout). **OS username** → omitted.
- **Raw artifact bodies** → never (full CampaignSpec JSON, source HTML,
  full QA verdict / doctor / report bodies). Excluded for **size and noise** —
  the value is the structured signal, not raw dumps.

This is minimization, not a security allowlist: campaigns-os runs use a fixed
synthetic test customer and a publishable client-side API key, so there is no
secret/PII exposure to defend against. The path/username scrub is hygiene for a
public package any agency may run.

## Capture Surfaces

The Run Record is assembled from several local inputs, all correlated by
`run_id`:

- **System signal** — extracted from this run's doctor output, Assembly Report,
  and QA verdict (reusing the same artifact readers `findings harvest` uses).
- **`findings harvest`** — proposes Workflow Findings from doctor blockers,
  selected warnings, and report blockers; `--write` appends them.
- **`findings add`** — flags-first manual capture for operators and agents.
- **Tiny Prompts** — skippable one-line stage-boundary prompts. Skipped prompts
  record nothing.

The findings journal stays `.campaign-runtime/workflow-findings.jsonl`, append-
only and the **single writer** for findings. New findings carry an optional
`run_id` (backward-compatible schema addition) so the Run Record's snapshot of
"this run's findings" is exact rather than inferred from timestamps.

## Remit Channel

Remit reuses the QA-verdict publishing rails. Extract one shared helper rather
than duplicate the fetch/try-catch:

```text
remit(path, payload, proxyBase)   // mirrors qa-node.mjs postVerdict
```

- **Consent-gated** — only sends when the resolver says yes.
- **Non-fatal** — a failed POST never blocks or fails the run (mirrors "never
  fail the run if publish is unreachable").
- **Idempotent** — payload carries `run_id`; the endpoint upserts so retries /
  reruns do not double-count. Proposed endpoint: `/api/runs`.
- **Durable status** — the local Run Record records `remit_attempted`,
  `remit_ok`, and `error` so a dropped send is visible, not silent. No
  background retry daemon.

The public package only emits and remits; it does not cluster, route, summarize
across runs, or create issues.

## Public / Internal Boundary

- **Public `campaigns-os`** owns: the Run Record schema, local capture, the
  consent resolver, and the remit channel. Capturing or opting out must never
  require internal Next Commerce access.
- **Internal tooling** owns: ingestion, clustering, surface-mapping, trend
  analysis, and turning the backlog into improvement candidates. The loop closes
  through normal development — the system does not edit itself.

## Non-Goals

- Do not replace the Build Packet, Assembly Report, doctor output, or QA
  Verdicts — the Run Record references the proof trail, it is not the proof
  trail.
- Do not auto-run QA or typed-card test orders.
- Do not edit skills, templates, or rules automatically (no auto-codegen).
- Do not ship raw artifact bodies, absolute local paths, or OS usernames.
- Do not block a build on telemetry, and do not expose telemetry to shoppers or
  merchant-facing approval viewers.
- Do not record skipped Tiny Prompts.
- Do not add a background retry daemon for failed remit.

## Build Order

1. **Run Record schema** (`campaigns-os-run-record/v0`): envelope + canonical
   `run_id` + artifact-ref shape + normalized observation arrays + `surfaces[]`
   taxonomy. Add optional `run_id` to the Workflow Finding schema.
2. **Run identity + local capture**: mint/thread `run_id`; assemble the manifest
   in `src/run-record.mjs` from existing artifact readers + `readJournal`;
   write `.campaign-runtime/run-records/<run_id>.json`. cli.mjs stays thin
   dispatch.
3. **Consent resolver + `telemetry` command**: user-level config, env override
   with fail-closed parsing, shared resolver called by every remitting command.
4. **Remit**: shared `remit()` helper, consent-gated, non-fatal, idempotent on
   `run_id`, with local remit status.

`findings add` / `harvest` / `export` keep working unchanged and become the
findings channel of the Run Record.

## Deferred (not v0)

- Stage timings and repair-loop count — need command-lifecycle instrumentation
  first (see scope cut above).
- Internal ingestion / clustering / surface-mapping — internal tooling
  (ADR-019), not this package.

## Open Questions

- Final envelope field list + exact observation-array shapes (resolved when the
  schema is authored against current packet / report / verdict artifacts).
- `/api/runs` payload envelope + upsert semantics (aligned with the QA verdict
  publishing rails).
