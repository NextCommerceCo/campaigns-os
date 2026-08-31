# Changelog

Notable supported-surface changes are recorded here.

## [1.16.0] - 2026-08-31

### Added

- **The runtime-readiness recipe is published as an enforced contract** (#248).
  Orientation answers whether a commit is safe to work against; nothing answered
  how that commit becomes a runtime you can actually use, so the commands, the
  accepted tool versions, and the network a preparation is allowed to touch
  lived in a build plan rather than in anything a consumer could read or a check
  could enforce. `contracts/runtime-recipe.campaigns-os-node-v1.json` is now the
  single authority for all of it — the exact argv of both steps, the accepted
  Node and npm ranges, per-step network policy, the enumerated input set, the
  seven mandatory output checks, and the enforced bounds — validated by
  `schemas/campaigns-os-runtime-recipe.v1.schema.json`. This repository publishes
  the recipe as data; the consumer bootstrap executes it. Nothing here executes a
  recipe step, and no implementation module became a consumer dependency.

  Enforcement is fail-closed and matches the orientation limits precedent: an
  unrecognized recipe kind, revision, or safety-critical enum is refused rather
  than interpreted, and a check that cannot be performed counts as failed rather
  than skipped. Both the recipe and its schema are registered as **hashed**
  supported-surface entries, deliberately unlike the orientation policy contracts
  beside them, which are named. A reason-code vocabulary grows additively and can
  live behind a named entry; a recipe cannot, because the rule the recipe itself
  states is that any change to its commands, network policy, tool versions,
  inputs, or output verification is an agent-relevant release event. Only a
  hashed entry makes such a change require `surface_version` to advance in the
  same change.

  Two things the contract records that a plausible reading gets wrong:

  - **The input set is not the compiler config's `include` globs.** Two compiled
    root modules enter transitively through imports and appear in no glob, so a
    fingerprint derived from the globs would cover 36 of the 38 compiled sources
    and still look correct. The contract enumerates all 38 explicitly, and the
    gate compares them against the compiler's *resolved* file list rather than
    against a glob string.
  - **`campaign-spec/dist` is a build output, never a committed artifact.** It is
    untracked and git-ignored; the copy in a published tarball exists only
    because packing runs `prepare`. No baseline for its contents can exist here,
    so verification is self-consistency — inventory, internal hash stability,
    entry-module import, type entry, and input fingerprint — not comparison
    against a hash published in this repository.

  Also stated plainly, because "runtime ready" invites the wrong reading:
  suppressing lifecycle scripts is what makes the install safe, and it is also
  what suppresses the browser download. A prepared generation can build and
  type-check but **cannot run browser QA**.

  Bounds ship with the measurement beside them so a number is not mistaken for
  physics: install 180s against about 3.2s measured, build 90s against about
  0.8s, the whole preparation transaction 450s against about 4s, and two new
  output bounds the performance budget did not carry — 16 MiB and 4,096 files
  against a measured 240,359 bytes across 76 files, so a runaway build is a typed
  refusal rather than a filled disk. They are deliberately generous: they have to
  hold on a cold cache, a congested network, and loaded CI, not just on a warm
  laptop.

  `docs/runtime-readiness.md` and every fixture under
  `contracts/fixtures/runtime-recipe/` are generated from the contract
  (`npm run generate:runtime-docs`), so a stale copy fails CI rather than
  misleading a reader. Each reject fixture is a single-mutation copy of the
  accepted recipe, so a refusal is always attributable to one change. The
  existing hostile-target fixture gained a second invariant rather than a
  parallel tree: preparing it must run the recipe's own two steps and no
  lifecycle script reachable from them, proved against a real packed dependency,
  with a control that fails if the tripwires could never have fired in the first
  place.

## [1.16.0+agent.1] - 2026-08-31

### Added

- **QA asserts declared checkout offer surfaces, and reconciles a typed-card
  order against what the checkout displayed** (#271, #272). Two real defects on
  one proof build collected a 130-pass verdict between them, for the same
  reason: neither had a check, and the absence of a check reads as a pass.

  That build declared `exit_intent` with a mapped offer code, shipped no
  exit-intent markup at all — only a dangling stylesheet link for the component
  it never included — and no assertion of any kind was emitted about it. The QA
  contract already said browser QA drives that surface; nothing did. Browser QA
  now emits `browser-exit-intent-surface:<page>` and
  `browser-promo-code-surface:<page>` for every checkout page whose CampaignSpec
  declares the surface with `enabled: true`:

  - declared and absent is `FAIL`/`BLOCKER` — the spec promises the shopper an
    offer the built page cannot deliver;
  - declared, present, and carrying the declared `offer_code` is `PASS`;
  - declared and present but not provably wired to that code — or a coupon input
    sitting behind an unopened "Have a coupon?" disclosure — is
    `MANUAL_REVIEW`/`WARN`, because a static page read cannot call it broken;
  - and a browser collector that threw mid-read is `SKIPPED` with the cause, not
    a blocker. The collector did not find nothing, it could not look, and
    reporting that as an absent surface would reintroduce one level up the exact
    silent failure these assertions exist to remove.

  Presence is a DOM-tree question, not a visibility one: the collector walks
  `<template>` content as well as the live document, since a correctly built
  exit-intent pop lives nowhere else until it fires. Scanning only the document
  would report a wired pop as missing.

  The same build also charged a package that appeared nowhere on the checkout: a
  cold visit to a later offer page left it in the cart, the rendered summary
  showed one line, and the persisted order carried two `is_upsell: false` lines.
  The `pricing` family read price surfaces and `browser-test-order` proved the
  journey completed; nothing joined them, so nothing could see a package the page
  never advertised. Typed-card runs now reconcile the two:

  - `browser-order-display-parity:<plan>` fails as a blocker naming any
    `is_upsell: false` line whose package the checkout never rendered as
    selected, and any displayed package that was never charged;
  - `browser-order-total-parity:<plan>` fails as a blocker when the order's
    pre-upsell total disagrees with the displayed summary total.

  Both read the order-create response the accepted-upsell proof already fetches,
  so this is a comparison rather than a new fetch, and both run against the
  pre-upsell read-back — after an accept the persisted lines legitimately carry
  product the checkout never displayed.

  Three deliberate limits, so the new blockers cannot manufacture false ones.
  The rendered order summary is the display authority, and it counts only when
  **every** row exposes its package id: partial `data-package-id` coverage
  reports `SKIPPED` with the reason rather than calling legitimately displayed
  packages stray. Selected bundle cards and active toggles widen only the
  charged-but-not-displayed direction, never the reverse. And an order line with
  no campaign-package equivalent — bonus, gift, trial — is reported as
  unresolved rather than counted as a stray charge, the same tolerance the
  line-price delta already applies.

  A `SKIPPED` here is missing coverage with a stated cause, not a pass. That is
  the whole point of the change, so read it that way: a checkout that exposes no
  `[data-next-display="cart.total"]` surface says so in the verdict instead of
  quietly proving nothing.

  Both assertion sets reuse the existing `browser-runtime` and
  `browser-test-order` families, so the verdict schema, the family vocabulary,
  and the portal allowlist are untouched. Reconciliation failures are their own
  named assertions rather than extra reasons for `browser-test-order` to fail —
  the order was created, and collapsing "created" with "matches what was shown"
  is how a mismatch ends up described as a checkout failure. Both carry blocker
  severity, so an affected verdict still blocks.

  `next-campaigns-qa` 1.0.3 → 1.1.0 records the new assertion ids and their
  severities.

## [1.15.0+agent.3] - 2026-08-31

### Fixed

- **Post-merge review fixes for the #266/#267 review findings.**
  - The certified-template gate in `start`/`prepare-build` now prints the
    certification-freshness line for ANY decided family present on the
    vendored catalog — including a family whose certification was waived via
    `--allow-uncertified-template`. The waived path is labeled
    (`certification waived — `) so it can never be mistaken for the
    certified-gate line; doctor's freshness warning behavior is unchanged.
  - The doctor source-preparation check now detects an UNTERMINATED embedded
    frontmatter block — content followed by an opening `---` fence whose
    frontmatter-key lines run to EOF with no closing fence — as a third
    `source_html.prep.frontmatter_residue` variant
    (`unterminated_embedded_block`, severity error). Previously this exact
    docs-promised case fell through both the leading-fence and
    closed-embedded-block detectors.
  - `renderTemplateFreshness` is now total over any input: a null/undefined
    assessment (or missing fields) renders the unknown-state line instead of
    interpolating `undefined`, and a malformed `verified_at` omits the date
    parenthetical instead of surfacing garbage like `(2026-13-45)` in
    operator output.
  - `standardize`/`standardization-report` no longer swallows a
    commerce-catalog resolution failure silently: freshness still degrades to
    null (the report keeps generating), but a one-shot
    `[standardize] freshness suppressed: <reason>` warn per run says why the
    `template_certification_freshness` field is missing.

## [1.15.0+agent.2] - 2026-08-31

### Added

- **Doctor now gates page-kit-ready source with a deterministic preparation
  check** (#262). The source-preparation steps the docs describe — strip
  document wrappers, keep frontmatter as one closed leading block, route
  internal links through CampaignSpec routes — were tacit knowledge that
  `start` accepted unprepared source past silently. A new
  `source_html.preparation` slot in the Doctor Check Registry classifies the
  common failures on every mapped source page: `source_html.prep.document_wrapper`
  and `source_html.prep.frontmatter_residue` block as doctor errors
  (status `blocked`, `next.stage: "collect-inputs"`), and
  `source_html.prep.internal_link_unrooted` warns because CTA rewrites are
  sanctioned build-stage work recorded under `cta_rewrite_policy`. A recorded
  `wrapper_policy: "preserve_document_wrappers"` adapter decision downgrades
  the wrapper finding to a warning. Each code carries a docs pointer
  (docs/source-adapters.md "Source preparation check"); asset-path rooting
  stays owned by the existing `source_asset.*` crawl codes. No CLI argv or
  schema change; doctor issue codes are not surface-pinned, so
  `surface_version` does not move.

## [1.15.0+agent.1] - 2026-08-31

### Added

- **Template certification freshness is now exposed to operators** (#263).
  Certified never said *when*: a family's certification evidence is captured
  against a specific Campaign Cart SDK release, and the CLI surfaced only the
  boolean. Now the vendored commerce surface catalog snapshot carries a
  per-family `verification` block (last-verified SDK version, timestamp,
  evidence key) — copied by the refresh script from the starter repository's
  `template-verification.json` at the same pinned `_synced_from_sha` commit as
  the rest of the snapshot — and the operator surfaces read it:
  - the certified-template gate in `start`/`prepare-build` prints the accepted
    family's last-verified SDK and its delta from the current SDK;
  - `doctor` reports current freshness under `ready` and raises an
    `assembly.template_certification.freshness` warning when the verification
    is stale or unrecorded;
  - `standardize`/`standardization-report` adds a
    `Certification freshness:` line (and
    `identity.template_certification_freshness`) per Page Kit root.

  "Current SDK" is defined from vendored data only: the newest released SDK
  the contracts record — the semver maximum over the SDK support policy's
  `provenance.latest_known_release` and every verification record on the
  catalog snapshot. No live fetches; no new data source. Freshness is
  exposure, not a new gate: nothing that built before is blocked now. Doctrine
  stated in `docs/template-family-contracts.md`: an older evidence record is
  not current certification.

## [1.15.0] - 2026-08-31

### Added

- **The QA Verdict and its committed sidecar are schema'd, and trust semantics
  are documented (#260).** The verdict was the only lifecycle artifact without
  a schema file: its shape lived in `src/qa-node.mjs` — classified unsupported
  by the surface contract — while the receiving Worker re-validated the same
  shape from a hand-maintained copy, so every readback consumer was pinning an
  unversioned contract.

  - **`schemas/campaigns-os-qa-verdict.v0.schema.json`** — the full verdict
    `qa run` writes under `qa-output/` and publishes to the QA portal,
    derived from the emitting code and validated against real emitted
    verdicts. The emitted `schema_version` field stays the literal `"1.0"`
    (it predates the slash-versioned naming and the receiver validates the
    same literal); the contract identity is `campaigns-os-qa-verdict/v0`.
    Additive tolerance is explicit: consumers must accept unknown fields.
  - **`schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json`** — the
    committed `.campaign-runtime/qa-verdict.json` allowlist projection. Same
    `"1.0"` literal (one contract, never a second lineage); the schema pins
    what the projection additionally guarantees — `generated_at`, emptied
    URL-bearing fields, the per-assertion allowlist, and the absence of
    receiver trust stamps.
  - **Trust semantics are documented** in `docs/qa-and-test-orders.md`:
    `trusted`/`trust_level`/`verified_at` are stamped server-side by the QA
    verdict receiver, never emitted by this CLI; `trusted: false` marks an
    anonymous submission — shape-valid but unattributed — and every
    downstream consumer must filter on it or segregate such records. Shape
    validity is not trust.
  - **The readback tooling now enforces that segregation** at its two
    chokepoints: `qa promote` (and any sidecar projection) refuses a source
    verdict stamped `trusted: false`, and `run-record`'s automatic QA-verdict
    inference excludes untrusted records. A forged, shape-valid, untrusted
    verdict rides the test suite as a permanent negative control: it passes
    schema validation and is still refused/excluded.

  Endpoint authentication and attribution are deliberately untouched — they
  land with the receiver's connection contract. No endpoint behavior changed.
  The supported surface grew by the two schemas; nothing was renamed or
  removed.

## [1.14.0] - 2026-08-28

### Added

- **An agent can now orient on a commit of this repo without running any of
  it.** Until now the only machine-readable statement about "what changed" was
  `surface_version`, and the only narrative was this file — both keyed to the
  supported surface. That misses the changes a downstream agent actually trips
  over: a renamed CLI flag, a rewritten contract doc, a reworded skill, a
  changed generated-runtime input, a widened compatibility statement. None of
  those need touch a hashed file, so none of them moved the version, so an agent
  reading only the changelog concluded that nothing happened.

  Four things ship together to close that:

  - **`campaigns-os-tooling-orientation/v1`** — the envelope a consumer
    assembles from Git objects at one resolved commit. Ten semantic groups,
    eight terminal outcomes, and a stable reason-code vocabulary with one
    documented meaning and one deterministic remedy per code. Integrity,
    freshness, compatibility, runtime readiness, and orientation stay
    independent axes rather than collapsing into a single boolean.
  - **An append-only release ledger** (`contracts/release-ledger.json`,
    `campaigns-os-release-ledger/v1`). One entry per accepted release or
    reviewed amendment, one change item per agent-relevant semantic change,
    same-surface changes included. Entries carry no commit identifier — an entry
    cannot name the commit that contains it without being rewritten afterwards,
    so a consumer derives the introducing commit from history instead.
  - **A two-way release gate** (`scripts/check-release-ledger.mjs`). Every
    agent-relevant changed path has exactly one ledger change item; every ledger
    change item maps to a classified change or an explicit reviewed amendment; a
    surface-version change owes exactly one entry and one changelog section; and
    historical entries are byte-identical to their recorded hashes. The meaning
    of "agent-relevant" lives in exactly one place,
    `contracts/agent-relevant-change-policy.v1.json`, which the classifier, the
    gate, the generated reference, and every test read. The classifier fails
    closed: a changed path that matches no rule, no supported-surface entry, and
    no stated ignore is an error.
  - **Bounded reads** (`contracts/orientation-limits.v1.json`). Source bytes,
    section count, section bytes, envelope bytes, and ledger entries all have
    declared limits. Exceeding one is a refusal with `orientation_too_large`.
    Nothing is ever silently truncated: a partial view of a release is worse
    than no view, because the reader cannot tell which part is missing.

  `AGENTS.md` is the entry point — canonical reading order, the supported
  versus internal boundary, mixed-version rules, and the no-execution rule.
  `docs/orientation-contract-reference.md` is generated from the contract
  fixtures rather than hand-written, so staleness is a CI failure;
  `docs/release-ledger-authoring-guide.md` covers authoring.

  Consumer fixtures ship too: one validated envelope per terminal outcome under
  `contracts/fixtures/orientation/envelope/`, and a hostile target under
  `contracts/fixtures/orientation/hostile-target/` carrying Git hooks, an
  executable file, and npm lifecycle scripts. Every path the hostile target's
  own manifest declares exists in its tree, and its hashed entry records that
  file's real digest, so a conforming read completes rather than refusing on
  integrity: it produces a normal envelope and executes none of the tripwires.
  The hit-counter assertion belongs to the consumer's parser suite; this release
  ships the fixture it runs against.

  One rule is worth stating on its own because producer and consumer do not
  upgrade atomically: **unknown additive fields inside a recognized v1 schema
  are accepted and preserved without interpretation.** Required fields, known
  types, schema IDs, and safety-critical enums still fail closed. An additive
  field cannot grant authority or change the meaning of a known field; a change
  that does either requires a new schema ID.

  Nothing here changes build, polish, QA, or CLI behavior. The supported surface
  grew by two schemas and twenty-seven named entries; nothing was renamed or
  removed.

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
