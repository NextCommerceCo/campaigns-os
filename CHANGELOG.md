# Changelog

Notable supported-surface changes are recorded here.

## [1.8.0] - 2026-08-24

### Added

- Added supported `./commercial-journey` and `./commercial-parity` package
  exports for portable calculate-scenario planning, normalization,
  contract-governed authored-claim extraction, and Exact-only mismatch
  serialization.
- Added automatic commercial parity to canonical `campaigns-os qa run`.
  Authored HTML is fetched once per URL with hard byte/node/depth limits;
  calculate descriptors use the existing `/api/price-preview` proxy, and the
  three ratified mismatch classes enter the verdict as warn-severity pricing
  assertions plus a `commercial` evidence section.

### Changed

- Bumped the supported surface to `1.8.0` for the two additive package
  exports. The package remains developer preview `0.1.0-alpha.0`.

## [1.7.0] - 2026-08-24

### Added

- Added the optional Build Packet `generated_at` freshness contract. New
  `prepare-build` packets stamp an ISO-8601 UTC instant, and downstream
  readback uses it for staleness and multi-packet selection instead of file
  mtime. Legacy packets remain schema-valid but must be regenerated at the
  current commit to satisfy fresh-artifact readback.
- Finalized packet-based `qa run` now writes the committable
  `.campaign-runtime/qa-verdict.json` allowlist projection for every
  disposition, including blocked runs. Operators can explicitly backfill it
  from one named full verdict with `campaigns-os qa promote --packet ...
  --verdict ...`; promotion validates the source before atomically replacing
  the sidecar and never selects a verdict by mtime or "latest."

### Changed

- Bumped the supported surface to `1.7.0` for the additive Build Packet
  freshness field. The package remains developer preview `0.1.0-alpha.0`.

## [1.6.0] - 2026-08-23

### Added

- Added the strict `campaign-design-source-package/v0` schema and normalized
  Design Source Package artifact for creative provenance, Surface Identity,
  contribution coverage, source references, gaps, TODOs, waivers, readiness,
  and readback.
- Added desktop/mobile source-screenshot TODO generation for renderable primary
  design and linked Template Reference proof requirements for template-baseline
  coverage.
- Added four-field artifact references (`path`, `schema_version`, exact-byte
  `sha256`, and projected `material_fingerprint`) to the Build Packet, Build
  Context, and Assembly Report.
- Added focused schema, producer, lifecycle, and Polish freshness tests,
  including negative controls for forged readiness, whole-JSON and underscoped
  fingerprints, current-input drift, stale bindings, and output aliases.

### Changed

- `prepare-build` now synthesizes a missing package from current source-html
  inputs while preserving the v0 `source_html` compatibility handoff. An
  existing package is validated against current campaign, page, source, and
  template material and reused byte-for-byte or refused without silent
  regeneration.
- Build records the current Design Source Package material fingerprint it
  consumed; Polish freshness now requires both that source-package fingerprint
  and the current build fingerprint. Missing or stale Assembly consumption
  returns the lifecycle to Build before Polish.
- Registered the Design Source Package schema and its durable consumer guide in
  supported surface `1.6.0`.
