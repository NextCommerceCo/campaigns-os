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
| `schemas/*.schema.json` (all 7) | The portable runtime contract: Build Packet, Build Context, Assembly Report, Run Record, Workflow Finding, Build Brief, Source-HTML Manifest. | Hashed. Any content change requires updating the recorded hash **and** bumping `surface_version` in the same PR. A shape change that alters meaning gets a new schema-version const — one version identifier must never cover two shapes (the 2026-08 assembly-report drift is the incident this rule encodes). Additions to a `v0` schema are expected; consumers must tolerate unknown fields. |
| CLI commands: `start`, `prepare-build`, `build`, `checkpoint`, `doctor`, `standardize`, `standardization-report`, `qa`, `findings`, `run-record`, `run` | Scriptable entry points (this is the argv surface Campaigns Agent's remit fixture pins). `checkpoint` is a staged registry: `checkpoint waive` currently accepts only `page_kit.store_profile`; SDK/polish gates may register later, while legacy source/theme/QA waiver lanes remain separate. | May gain subcommands, registered gates, and flags freely. Renaming or removing one fails the gate. Do not infer support for an unregistered checkpoint from the top-level command. |
| `bin/campaigns-os.mjs` (`campaigns-os`) | The CLI entry itself. | Declared in `package.json` `bin`; the gate fails if it disappears. |
| Package export `./campaign-spec` | The versioned campaign-spec rule registry, consumed as `@nextcommerce/campaigns-os` (pinned by consumers' lockfiles; lockstep policy — ADR-003 in the ops repo). | Behavior-guarded from the consumer side by their contract tests; the export path itself is gated here. |
| Contract docs: `CONTEXT.md`, `docs/campaigns-os-build-flow.md`, `docs/build-packet.md`, `docs/campaign-build-brief.md`, `docs/campaign-standardization-report.md`, `docs/brand-theme-bridge.md`, `docs/qa-and-test-orders.md`, `docs/versioning.md`, `docs/workflow-findings-sidecar.md`, this file | Named entry points consumers pin for context. | Content evolves freely; the path must keep existing. |
| `skills.json` + `skills/` + `skills.sh` | Versioned skill packages and their installer. | Governed by `check-skill-versions.mjs` (parity + bump gate + reserved external names). `skills.json` ships in the npm pack as of surface 1.0.0. |
| `compatibility.json` | The published compatibility statement. | Named; must keep existing. |

Everything on this list must also **ship in the npm tarball** — the gate checks
`package.json` `files[]` coverage, so "supported" can never mean "absent from
the package a consumer installs."

## What is NOT supported

- `src/**` — including files downstream context spines currently read
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
   enforces this; parity runs in every `npm run check`).
3. Breaking a consumer-visible shape? New schema-version const, and say so in
   the PR body — downstream pins (Campaigns Agent context spine, ops-repo
   `public-contracts.manifest.json`) update on their own cadence against a
   version they can see move.
