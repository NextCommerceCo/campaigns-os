# Supported surface

This repo stopped being an implementation the day other tooling started building
on it. Campaigns Agent pins schemas, contract docs, and a CLI argv surface;
the private ops repo vendors the runtime schemas behind a byte-parity gate;
page-kit campaign repos consume the artifacts the CLI emits. This document — and
its machine twin, [`contracts/supported-surface.json`](../contracts/supported-surface.json),
enforced by `scripts/check-supported-surface.mjs` in `npm run check` and CI —
names exactly what those consumers may depend on. If it is not listed, it is
implementation detail, however stable it looks.

## What is supported

| Surface | Contract | Change discipline |
|---|---|---|
| `schemas/*.schema.json` (all 9) | The portable contract catalog: CampaignSpec, Design Source Package, Build Packet, Build Context, Assembly Report, Run Record, Workflow Finding, Build Brief, and Source-HTML Manifest. | Hashed. Any content change requires updating the recorded hash **and** bumping `surface_version` in the same PR. A shape change that alters meaning gets a new schema-version const — one version identifier must never cover two shapes (the 2026-08 assembly-report drift is the incident this rule encodes). Additions to a `v0` schema are expected; consumers must tolerate unknown fields. |
| CLI commands: `start`, `prepare-build`, `build`, `polish`, `checkpoint`, `doctor`, `standardize`, `standardization-report`, `qa`, `findings`, `run-record`, `run` | Scriptable entry points (this is the argv surface Campaigns Agent's remit fixture pins). `polish capture` owns page-load evidence production. `checkpoint waive` currently accepts three registered gates: `page_kit.store_profile`, `page_kit.sdk_version`, and `polish.hidden_eager_media`. Within Polish, only the broader Source Freshness waiver remains on its existing report lane; theme and QA decisions also retain their existing lanes. | Additive commands bump `surface_version` in the same PR. Subcommands, registered gates, and flags may grow freely beneath a listed command. Renaming or removing one fails the gate. Do not infer support for an unregistered checkpoint from the top-level command. |
| `bin/campaigns-os.mjs` (`campaigns-os`) | The CLI entry itself. | Declared in `package.json` `bin`; the gate fails if it disappears. |
| Package export `./campaign-spec` | The versioned campaign-spec rule registry, consumed as `@nextcommerce/campaigns-os` (pinned by consumers' lockfiles; lockstep policy — ADR-003 in the ops repo). | Behavior-guarded from the consumer side by their contract tests; the export path itself is gated here. |
| Package exports `./commercial-journey` and `./commercial-parity` | Portable scenario planning, response normalization, contract-governed source extraction, Exact-only parity comparison, and deterministic QA assertion serialization. These modules own no network transport and do not calculate prices locally. | Consumers execute descriptors through a supported calculate transport, then pass captured envelopes into the pure normalizer. Existing export paths are gated and may not be renamed or removed without a breaking surface change. |
| Package exports `./reconcile-plan`, `./reconcile-normalize`, `./reconcile-diff` | Campaign reconciliation: CampaignSpec to observation descriptors, raw Admin API envelopes to canonical observed state, and exact-only comparison producing a closed-vocabulary verdict matrix. Pure functions with no network transport and no credential handling. The normalizer is also the redaction boundary — the campaign `api_key` is dropped there, so no downstream code can emit it. | Comparison rules are versioned in `docs/reconcile-comparison-matrix-v0.md` and hashed into every report. Rows the Admin API cannot observe (package quantity, Offers, campaign shipping methods) are classed `unsupported` and counted, never dropped. Package prices are pre-Offer; a `matched` price verdict describes the configured value, not what a customer is charged. |
| Schema `schemas/campaign-reconcile-report.v0.schema.json` | The reconciliation report envelope: outcome, coverage counts, verdict rows, and spec/snapshot/matrix hashes. | Hashed entry — changes require a `surface_version` bump in the same change. |
| Contract docs: `CONTEXT.md`, `docs/campaigns-os-build-flow.md`, `docs/build-packet.md`, `docs/design-source-package.md`, `docs/campaign-build-brief.md`, `docs/campaign-standardization-report.md`, `docs/brand-theme-bridge.md`, `docs/qa-and-test-orders.md`, `docs/versioning.md`, `docs/workflow-findings-sidecar.md`, this file | Named entry points consumers pin for context. | Content evolves freely; the path must keep existing. |
| `skills.json` + `skills/` + `skills.sh` | Versioned skill packages and their installer. | Governed by `check-skill-versions.mjs` (parity + bump gate + reserved external names). `skills.json` ships in the npm pack as of surface 1.0.0. |
| `compatibility.json` | The published compatibility statement. | Named; must keep existing. |

Everything on this list must also **ship in the npm tarball** — the gate checks
`package.json` `files[]` coverage, so "supported" can never mean "absent from
the package a consumer installs."

## What is NOT supported

- `src/**` except the files reached through the explicit
  `./commercial-journey` and `./commercial-parity` package exports — including
  files downstream context spines currently read
  (`src/cli.mjs`, `src/qa-*.mjs`, `src/doctor-check-registry.mjs`, …). Reading
  them for context is fine; importing or pinning behavior from them is not.
  Doctor issue **codes** are contract-adjacent but currently governed by the
  ops-repo ADR-003 parity baseline, not this manifest.
- `scripts/**` — repo checkers, including this gate's own implementation.
- `examples/**`, `prompts/**`, `agents/**` — illustrative, regenerated at will.
- `contracts/**` other than `supported-surface.json` and
  `reserved-skill-names.json` — internal build/QA contract data.
- CLI output text, log lines, and human-facing handoff strings. Machine-readable
  artifact fields are governed by their schemas, not by prose.

## Changing the surface

1. Make the change and update `contracts/supported-surface.json` (hash and/or
   entries) in the same PR.
2. Bump `surface_version` when any hashed file changed (the `--base` gate in CI
   enforces this; parity runs in every `npm run check`). Also bump it when the
   manifest adds a `cli_commands`, `package_exports`, or `bin` entry: those are
   additive public-surface expansions even though the gate cannot yet derive
   the owed bump automatically.
3. Breaking a consumer-visible shape? New schema-version const, and say so in
   the PR body — downstream pins (Campaigns Agent context spine, ops-repo
   `public-contracts.manifest.json`) update on their own cadence against a
   version they can see move.
