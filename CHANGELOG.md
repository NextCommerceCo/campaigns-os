# Changelog

Notable supported-surface changes are recorded here.

## [1.13.0] - 2026-08-26

### Added

- **A partial-source build is declarable (#238).** Some active CampaignSpec
  pages carry prepared source HTML and the rest assemble from a certified
  template family — the ordinary shape of a designed campaign on a template
  family — and until now every escape from `MISSING_SOURCE_PAGE` was closed:
  manifest entries required a `path`, a hand-authored `skip_reason` was
  overwritten on the next `start`, removing the manifest destroyed the page
  binding and provenance, and `spec.build_scope.mode: "partial"` was read only
  to phrase a doctor warning. Two declarations now work, and both regenerate
  identically on every run because they derive from the spec and manifest
  rather than from packet state:

  - A source-html manifest page entry may carry `skip_reason` instead of
    `path` (exactly one of the two is required) to declare that page out of
    source scope with a per-page reason.
  - CampaignSpec `build_scope.mode: "partial"` declares the same thing as a
    blanket for active pages with no manifest entry and no `design_source`;
    the recorded reason carries `build_scope.reasons[]`.

  Declared pages land on the packet as `skip_reason` mappings — the shape
  doctor's scope summary already understands — and on the assembly report
  under `stages.prepare_build.declared_out_of_scope`, with one decision per
  page. `prepare_build` reaches `completed_partial` (terminal under the
  prefix-matching stage contract) and the ladder advances. A page that
  declares `design_source` still blocks without a per-page skip entry, and a
  missing page under full/undeclared scope blocks exactly as before.

  Two adjacent shape notes: doctor's `source_html.pages.coverage` error
  `detail` now always carries `page_id` (previously the detail was null for a
  page without `design_source`), and a CampaignSpec `build_scope.reasons`
  that is present but not an array surfaces as a `SOURCE_SCOPE_REASONS_IGNORED`
  assembly-report warning instead of being silently dropped.

### Fixed

- **Built-output checks honor the partial-scope declaration after assembly.**
  Once assembly recorded complete, `validateBuiltSdkMetaTags` pushed one
  `built_output.page_missing` error for every active spec page with meta
  hints and no built HTML, and `validateBuiltRouteDrift` escalated the same
  absent pages as route drift — never consulting the out-of-scope declaration
  prepare-build recorded, so a partial build's ladder re-blocked at doctor
  one gate after the declaration fixed prepare-build. Both checks now skip
  pages listed in `stages.prepare_build.declared_out_of_scope` on the
  recorded assembly report (the declaration authority — NOT the packet's
  skip mappings, which blocked pages carry too), record the skips in
  doctor's ready output, and keep the full error escalation for in-scope
  pages: a missing in-scope page still errors post-assembly exactly as
  before, and full-scope campaigns are untouched. A built page is verified
  regardless of declaration. `completed_partial` continues to count as
  assembly-complete for in-scope enforcement.

- **doctor and the stage ladder agree over one packet.** doctor computed its
  verdict from its own checks without consulting
  `stages.prepare_build.status`, so it could exit 0 and hand the operator a
  `next setup` command the ladder then refused with exit 2 — a green light
  pointing at a closed road. doctor now surfaces the recorded prepare-build
  gate (blocked status, or a terminal claim contradicted by retained blocking
  evidence) as errors, so exit 0 means the command doctor names will actually
  run. `start`'s embedded doctor inherits the same contract, so a `start`
  that leaves prepare-build blocked now exits 2 with the blockers printed
  instead of reporting ready.

## [1.12.0] - 2026-08-25

### Fixed

- **QA no longer passes a funnel whose page dead-ends.** Both consumers of
  `expected_next_url` skip on a falsy value — `if (!expectedUrl) continue` in
  the funnel-flow route-link loop, `if (!page?.expected_next_url) return false`
  in the primary-CTA check — which is correct for a page that terminates on
  purpose and silently wrong for a page that meant to continue. 1.11.0 made
  that state reachable: a page whose only forward field was `success_url` or
  `on_accept` off an eligible type now resolves to no forward link, source
  intake omits `next_url`, and the built page has nowhere to go. QA emitted
  **zero** assertions for it and the run came back clean.

  The QA topology now carries `ignored_forward_fields` — the forward fields the
  author declared that routing skipped — so QA can tell "terminates on purpose"
  apart from "meant to continue and lost its only edge", which a null
  `expected_next_url` cannot express on its own. A page in the second state
  emits `forward-route:<page>:resolves`, status `fail`, severity `blocker`.

  Deliberately narrow. A `thankyou` page declaring nothing stays quiet, and a
  rooted `success_url` handing off to an existing downstream route (the
  partial-scope pattern `ThankYouRequirement` documents) still passes. Proven
  quiet across every certified family fixture before shipping.

- **`expected_accept_url` respects the `on_accept` applicability rule.** The QA
  topology extractor read `page.on_accept` raw, which outlived its correctness
  when 1.11.0 gated the field: a `select` page's inert `on_accept` still
  produced an `expected_accept_url`, so QA looked for an accept link the built
  page correctly does not have and flagged a good build. It now reads
  `acceptRouteTarget`. An upsell's own accept branch is unaffected.

### Added

- Exported `applicableForwardFields` from `./campaign-spec`: the forward fields
  a page's TYPE can route from, declared or not. It answers "what should this
  author have set instead", which is a question about the page type rather than
  about the spec — filtering `FORWARD_ROUTE_FIELDS` against
  `inapplicableForwardFields` gets it wrong, since that list only names fields
  the author actually declared.

- Exported `acceptRouteTarget` and `ACCEPT_ROUTE_FIELD` from `./campaign-spec`.
  `acceptRouteTarget` answers "where does accepting this page's offer go" — a
  question only an offer page can be asked — and is gated by the same
  applicability table as the forward resolver, so a consumer cannot read the
  raw field and drift from routing the way the QA extractor did.

## [1.11.0] - 2026-08-25

### Changed

- **Behaviour change — rebuilding an unchanged spec can rewire a funnel.**
  The two forward-route fields that carry a page-shaped meaning now participate
  in precedence only where that meaning exists:

  - `success_url` ("where the shopper goes after payment succeeds") only on a
    page that takes payment, `type: "checkout"`.
  - `on_accept` ("where the shopper goes after accepting the offer on this
    page") only on a page that presents one, `type: "upsell"` or `"downsell"`.

  Anywhere else those fields are now inert and `next_page` wins. Previously
  precedence was type-blind, and because these two outrank `next_page` a page
  carrying a copy-pasted one routed the shopper past its real next step: a
  `select` page declaring `next_page: "checkout"` alongside
  `success_url: "upsell"` — or alongside `on_accept: "upsell"` — wired the
  upsell and skipped payment entirely. A checkout carrying a stray `on_accept`
  also shadowed its own `success_url`, skipping the whole upsell sequence after
  the order was placed.

  This is not a return of the page-type routing gates removed in 1.9.0/1.10.0.
  Those DROPPED edges an author had declared, on tables that disagreed about
  which fields a type may use. `next_page` — the generic "wherever this page
  goes next" — remains honoured on every page type without exception, and so
  does the `on_decline` branch. The carve-out is about what two fields MEAN.

  To find affected specs before upgrading: any page declaring a non-empty
  `success_url` whose `type` is not `checkout`, or a non-empty `on_accept` whose
  `type` is neither `upsell` nor `downsell`. Zero pages across the certified
  fixture corpus match, and the corpus golden regenerates byte-identical — but
  that corpus contains no instance of either shape, so it is not evidence about
  your specs. `RouteFieldIgnoredForPageType` (below) reports both on any spec
  you validate.

  `schema_version` stays `4.3` deliberately: the CampaignSpec version tracks the
  exporter's lineage rather than this repo's edits, the same exemption 1.9.0
  took. The field's SHAPE is unchanged; only which toolkit versions act on it
  differs, and that is what `surface_version` moving is for.

- `RouteTargetResolves` no longer reports a target carried by a field the page's
  type cannot satisfy. Routing skips such a field, so the built page does not
  link to that target and the rule's "would link to a route nothing serves"
  message was false. `RouteFieldIgnoredForPageType` owns that shape instead, so
  the two rules cannot tell an author opposite stories about the same field.

### Added

- Added the `RouteFieldIgnoredForPageType` rule: a page declaring a forward
  field its type cannot satisfy is told so, and told where the shopper actually
  goes instead (or that the page now has no forward route at all). Covers both
  gated fields, and reads the field's meaning and permitted types from
  `routing.ts` rather than restating them, so it cannot tell an author a field
  is dead while the resolver still uses it. Warning severity, never blocking. `RouteTargetResolves` catches this only when the
  target does not resolve; when both targets name real pages it has nothing to
  say. Ships already quiet across every certified fixture. Consumers that
  snapshot `validateSpec` output will see this new `ruleId` — new
  warning-severity rule IDs are additive, and consumers must tolerate unknown
  ones.

- Exported `PAYMENT_BEARING_PAGE_TYPES`, `OFFER_BEARING_PAGE_TYPES`,
  `inapplicableForwardFields` and `describeForwardField` from `./campaign-spec`,
  so an authoring UI can gray out an inert field and explain why using the same
  definition the resolver uses.

- The `success_url`, `on_accept` and `resolved_routing.success` descriptions in
  `schemas/campaign-spec.v4.schema.json` now state their applicability rules.

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
