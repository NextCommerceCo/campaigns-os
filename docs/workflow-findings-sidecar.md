# Run Telemetry

Status: Implemented v0 — Run Records, consent/remit, packet-associated ambient sessions, QA repair-loop closeout, lifecycle timing, and repair-loop aggregation are live.
Date: 2026-06-08

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
- **Consent gates remit, not capture.** A machine-level opt-out decides only
  whether records are sent (default ON for the canonical NEXT endpoint,
  announced at remit time). Opt-outs lose nothing locally.
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
  Report, Page Kit build summary, QA verdict, and findings journal: `{ path,
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

Stage timings and repair-loop count are captured from the command lifecycle
journal when a run session or explicit lifecycle journal is active. They remain
best-effort signal: telemetry records the commands Campaigns OS can observe, not
every thought, browser click, or external editor action in an agent session.

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
- **No file, no env** → **ON for the canonical NEXT endpoint only**, announced
  at remit time with the endpoint and the opt-out command. A non-canonical
  `--proxy-base` (staging, self-hosted) stays **OFF** until explicitly
  consented, and a malformed config file resolves **OFF** — the default never
  overrides an unreadable prior choice.

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
  selected warnings, and report blockers; `--write` appends them. Under an
  active run session, written findings inherit the session `run_id`; explicit
  `--run-id` still wins. Harvested system findings default to
  `safe_to_share: false` because raw doctor/report messages can contain
  merchant URLs, source-copy snippets, or local artifact references. An operator
  or redaction pass must approve sharing.
- **`findings add`** — flags-first manual capture for operators and agents.
  Under an active run session, new findings inherit the session `run_id`;
  explicit `--run-id` still wins.
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
  reruns do not double-count. Endpoint: `/api/runs` (implemented; receives at the
  canonical remit scope).
- **Durable status** — the local Run Record records `remit_attempted`,
  `remit_ok`, and `error` so a dropped send is visible, not silent. No
  background retry daemon.
- **Tenant-scoped** — the remit sends the packet's Campaigns API key (packet,
  then the packet-local CampaignSpec, then the declared `env:` source) as the
  `X-Campaign-Key` header. The receiver hashes it server-side into
  `campaign_key_hash`, which its tenant-scoped `GET /api/runs` joins on. A
  record remitted without the header is stored but reachable only through the
  cross-tenant admin listing or by known `run_id` — every record this CLI
  remitted before 2026-09-10 is in that state. The key never enters the record.
- **Readable back** — `campaigns-os telemetry list --packet <json>` lists the
  tenant scope; `campaigns-os telemetry list` with `CAMPAIGN_OPS_ADMIN_KEY` set
  (or `--admin-key-env <VAR>`) lists cross-tenant, unscoped records included.

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

## Implementation Sequence

The core implementation is landed. This sequence is retained as an orientation
map for the code paths and tests that own each slice.

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

`findings add` / `harvest` / `export` remain local-first and become the findings
channel of the Run Record.

## Run Sessions (ambient capture)

Operators (and the agents driving them) should not have to thread `--run-id` /
`--lifecycle-journal` on every command. A **run session** makes capture ambient:

- `campaigns-os run start [--packet <p>]` mints one `run_id`, picks the
  lifecycle journal, and writes `.campaign-runtime/run-session.json`.
- Every command then auto-discovers that session (walking up from cwd) and
  shares its `run_id` + journal **with no per-command flags**. Findings commands
  also inherit the active `run_id` when writing findings. Explicit `--run-id` /
  `--lifecycle-journal` still wins; `CAMPAIGNS_OS_TELEMETRY` consent still gates
  remit.
- Each `campaigns-os qa run` records its full local verdict path on the active
  session. A blocked verdict keeps that session open for repair and another QA
  attempt. A ready or ready-with-exceptions verdict auto-assembles the
  aggregated Run Record with references to every attempt, then clears the
  session. Pass `--no-remit` to skip remit for that local Run Record.
- An explicit absolute `--packet` associates commands and `run status` with the
  target campaign session even from the toolkit or another project directory.
  If cwd and packet resolve to different active sessions, the command fails
  with both run IDs instead of silently cross-writing lifecycle evidence.
- `campaigns-os run end` remains the manual close path for non-QA or interrupted
  sessions. `run status` reports the active session.
- Sessions older than 12 hours are treated as stale and are not auto-discovered,
  so a later work session does not inherit an old `run_id` or lifecycle journal.
  A stale session is closed out, not abandoned: the next `start`,
  `prepare-build`, or `build` at that `--target`, or `run start` / `run end` at
  cwd, assembles its Run Record from the lifecycle journal (remit under the
  usual consent) and removes the file before opening a new session. A stale
  session whose packet is gone is cleared with a stderr note and no record.
  `run status` reports a stale file but never sweeps it.

The session file is transient, machine-local, and lives under the
scrubber-ignored `.campaign-runtime/`.

## Closeout recognition (`next` reads the records it demands)

Nothing in the CLI used to read `.campaign-runtime/run-records/`, so `next` at
stage `done` demanded a Run Record unconditionally — including for runs that had
already assembled, closed, and remitted one. `next` now reads that directory and
decides whether a **matching, current, successfully closed** record exists for
the packet it was called with.

The reading is deliberately conservative. Records are machine-local (they are in
the managed `.gitignore` block), so an absent directory is the normal case and
never an error; the scan is bounded and wrapped, and a slow, unreadable, or
corrupt records directory can never fail or stall orchestration. **Any doubt
emits the closeout.** A false demand costs one idempotent command; false silence
loses the run's durable record.

A record satisfies closeout only when all of these hold:

1. **Identity** — its `identity.map_id` and `identity.campaign_slug` equal the
   packet's `spec.map_id` and `campaign.public_route_slug`. Both sides must
   assert an identity; a record that names neither is not evidence about this
   campaign.
2. **Currency** — its `created_at` is not earlier than the newest `checked_at` /
   `completed_at` on the report's `doctor` and `qa` stages. An older report that
   carries no such timestamps contributes no floor rather than a fabricated one.
3. **Artifacts** — when the report's `qa` stage points at a QA verdict, one of
   the record's `qa_verdict` artifact references must carry that verdict's
   current SHA-256. (A record may reference several verdicts: a session retains
   each blocked repair attempt alongside the one that passed.) Verdict identity
   only — the assembly report's own hash drifts the instant a producer writes a
   stage, so including it would make every record instantly outdated.
4. **Closure** — `remit_state` is `ok`, or `skipped`. **`skipped` counts as
   closed**: it is the consent-off / `--no-remit` / local-only path, a deliberate
   non-remit rather than a failure.

The newest matching record decides, so an older good record can never mask a
newer broken one.

### Reason codes

| Code | `next` emits |
|---|---|
| `satisfied` | a non-required `run_record_present` action naming the record and its path |
| `no_record` | the required `run_record_closeout` |
| `foreign_campaign` | the required `run_record_closeout` |
| `stale_predates_evidence` | the required `run_record_closeout` |
| `outdated_artifacts` | the required `run_record_closeout` |
| `remit_failed` | the required `run_record_remit_recovery` |
| `remit_incomplete` | the required `run_record_remit_recovery` |

A failed or never-finished remit is **not** a missing record, and must not be
answered by minting a second one — that would fork the run's identity. Because
remit is idempotent on `run_id`, recovery re-runs `run-record` against the record
already on disk:

```bash
campaigns-os run-record --packet <packet> --run-id <existing-run-id> --json
```

An active run session still wins: with an ambient session open, `done` emits the
required `run end` exactly as before, satisfied or not.

`campaigns-os qa run`'s own closeout action is unchanged. It fires while the
record for that verdict cannot exist yet, so it is correctly unconditional.

### Latest QA identity cannot disagree with latest QA status

The QA producer owns `stages.qa.verdict_run_id`, `stages.qa.evidence`, and
`stages.qa.purchase_proof`. Before this, only the canonical fields
(status/outputs/timestamps) refreshed, and hand-authored extension fields
survived untouched — so a stage could carry a passing status and today's output
links beside a previous run's id and an `evidence.remaining_blocker` describing
a bug that had since been fixed.

Prior evidence is **preserved, not deleted**: the previous `verdict_run_id` /
`evidence` pair moves into a bounded `history[]` on the same stage, oldest first,
carrying its **own original status and `checked_at`**. A stage that had no
`checked_at` yields a history entry with no `checked_at` — an absent timestamp
stays absent rather than being stamped with now, because manufactured provenance
is worse than the stale field it replaces. Re-recording the same verdict does not
grow history. `evidence` has two schema-legal shapes, object and array, and both
archive — an array of operator notes is preserved as history rather than dropped
on the next producer write. Every other extension field on the stage (`waivers`,
and anything an out-of-repo consumer writes) passes through a producer write
verbatim.

These fields are additive under the assembly-report stage definition, which
already permits additional properties; no schema and no surface version moved.

## Deferred (not v0)

- Command-lifecycle instrumentation — **landed (T6).** A `withCommandLifecycle`
  wrapper times every command and captures its command name, argv shape, and
  exit status. Persistence is active when an explicit `--lifecycle-journal` /
  env `CAMPAIGNS_OS_LIFECYCLE_LOG`, or an ambient run session, is present;
  entries append to `.campaign-runtime/command-lifecycle.jsonl`.
- Stage timings and repair-loop count — **landed.** `run-record` aggregates the
  whole lifecycle journal for a `run_id` (Tier 1): each command invocation
  becomes a `lifecycle.stages[]` entry (with per-stage `exit_status`),
  `repair_loop_count` counts command re-runs, and run-level `duration_ms` sums
  active command time instead of idle wall-clock gaps between invocations;
  `wall_clock_duration_ms` reports that full outer span separately.
  `started_at` / `completed_at` preserve the observed bounds. Heavy
  commands mark their own sub-phases (Tier 2), which aggregate into
  `command:phase` stages. The cross-command `run_id` is threaded automatically
  by the run session (Tier 3), so these fields populate with real data from a
  normal "talk to your agent and build" flow — no manual flag bookkeeping.
- Internal ingestion / clustering / surface-mapping — internal tooling
  (ADR-019), not this package.

## Open Questions

- Final envelope field list + exact observation-array shapes (resolved when the
  schema is authored against current packet / report / verdict artifacts).
- `/api/runs` payload envelope + upsert semantics (aligned with the QA verdict
  publishing rails).
