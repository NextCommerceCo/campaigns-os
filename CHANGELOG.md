# Changelog

Notable supported-surface changes are recorded here.

## [1.10.0] - 2026-08-25

### Added

- Added `campaign-spec/routing.ts` and exported it from `./campaign-spec`:
  `forwardRouteTarget`, `declineRouteTarget`, `hasForwardRoute`,
  `outgoingEdgeIds`, and the field constants. This is the single source of
  truth for "where does this page go". Source intake, cycle detection, the
  CheckoutHasSuccessUrl rule and the QA topology extractor all consume it
  instead of keeping their own page-type tables, which had already drifted
  apart into three different answers.

- Added the `RouteTargetResolves` rule: every declared routing target must name
  a page in the same funnel. Warning severity, never blocking — absolute URLs,
  `#` fragments and rooted paths (the documented partial-scope pattern) are
  deliberate off-graph destinations and are not flagged. It ships already quiet
  across every certified fixture, which is the precondition for adding any gate
  here.

### Fixed

- Corrected six certified fixtures whose checkout declared
  `next_page: "upsell-bundle-stepper.html"` while their funnel's upsell is
  `upsell-stepper` — the target name was copied from the MV families, which do
  have that page. Nothing resolved those targets, so intake's route fallback
  emitted a confident link to a route nothing serves: apollo-tiered, arjuna,
  demeter, olympus-tiered, shop-single-step, and the three-step shop flow's
  `billing` page all sent the shopper to a 404 immediately after checkout. The
  page-kit frontmatter golden is regenerated accordingly.

### Changed

- Forward-link resolution is no longer a page-type switch anywhere. A page's
  next link comes from whichever routing field it declares, in
  specific-before-generic precedence (`on_accept`, `success_url`, `next_page`),
  and the decline link from `on_decline` wherever it appears. A campaign is a
  free-form headless journey; the previous type tables silently discarded any
  edge declared outside them. Twelve checkout-typed pages across ten certified
  fixtures — including every hand-off in the three-step shop flow — routed
  through `next_page` and built with no `next_url` at all.
- Cycle detection now follows the edges a page can actually traverse — its
  resolved forward link plus its decline branch — rather than a per-type edge
  table. It previously ignored `next_page` on a checkout, so once intake began
  wiring that edge a loop through it would have built as a live link while
  staying invisible to the rule that blocks on cycles. Shadowed forward fields
  are deliberately excluded: a page whose `success_url` wins at runtime and
  terminates cleanly must not be blocked by a stale, unreachable `next_page`.
- QA topology extraction resolves `expected_next_url` through the same
  resolver. It previously read `next_page || success_url` and ignored
  `on_accept`, a third precedence that could disagree with the built page.
- `CheckoutHasSuccessUrl` warns when a checkout has no forward route at all,
  instead of when it lacks `success_url` specifically. It was firing on twelve
  pages across ten shipped fixtures whose checkouts route correctly, telling
  authors to rename a field they had already filled in. Corpus warnings drop
  from 22 to 10. The message and the violation `path` now describe the
  page-level condition; the rule ID is unchanged for consumer stability.
- Bumped the supported surface to `1.10.0`. No hashed schema changed, so the
  gate does not owe a bump — but the new exports and the changed routing
  behaviour are consumer-visible, and downstream pins update against a version
  they can see move.

## [1.9.0] - 2026-08-25

### Added

- Added `select` to the authoring `PageType` union and the CampaignSpec v4
  JSON Schema page-type enum: the bundle-selection step of a two-step family,
  a template-owned commerce page that routes forward like a landing page
  (`next_page` / `success_url`) but carries SDK cart selection. Additive — every
  existing spec stays valid, and `schema_version` is unchanged because that
  field tracks the exporter's lineage (4.2/4.3), not this repo's schema edits.
  Map Builder exports may now legally emit `select`.
- Added a page-type drift gate pinning the JSON Schema enum to the authoring
  union, plus documentation of page IDs and page types as separate namespaces
  in `docs/template-family-contracts.md`.

### Changed

- Commerce residue checking now covers the selector step. `select` joins
  `RESIDUE_PAGE_TYPES`, which turns on logo and computed-style residue coverage
  the shipped brand contracts already declared for it — those `page_types`
  entries were inert while no spec-valid page could carry the type. A branded
  selector page passes; an unbranded one carrying the starter palette or the
  starter logo is now a blocker where it previously passed silently.
- Cycle detection traverses `select` pages. Without routing semantics a cycle
  through the selector step would have been invisible.
- Bumped the supported surface to `1.9.0` for the additive page-type enum. The
  package remains developer preview `0.1.0-alpha.0`.

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
