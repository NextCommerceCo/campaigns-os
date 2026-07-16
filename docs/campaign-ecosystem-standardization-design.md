# Campaign Ecosystem Standardization — Design Note (v0 slice)

`campaigns-os standardize` was a Page-Kit-only scanner: root discovery required
`_data/campaigns.json` or a `next-campaign-page-kit` dependency, so a real
Vite/Express funnel using Campaign Cart reported `status: "blocked"`,
`root_count: 0`, `page_kit.root_not_found` — identically before and after a
checkout repair that changed the SDK pin, checkout field bindings, and payment
control wiring. This note records the extensibility design for the first
non-Page-Kit slice.

## Campaign shapes

Supported after this slice:

- **Campaign Page Kit repositories** (existing behavior, unchanged findings).
- **Parent repositories containing one or more Page Kit roots** (existing).
- **Campaign Cart applications** — any repository whose HTML source carries
  portable Campaign Cart evidence (loader script, `window.nextConfig` /
  `meta[name="next-campaign-id"]`, `data-next-*` runtime anchors), including
  Vite/React/Express apps and static HTML funnels. New.

Known but unsupported (explicit follow-up backlog):

- Built-output-only or deployed-URL-only assessments (no source checkout).
- Source-only campaign exports without runtime wiring.
- Packetless browser QA (`qa resolve/run` without a Build Packet).
- Origin/environment diagnosis (SDK origin allowlist vs application defect).
- Campaigns with full CampaignSpec + Build Packet evidence get no extra
  cross-checking yet beyond the existing `.campaign-runtime` inventory.

## Adapter/capability boundaries

The pipeline stays: **discovery → classification → capability detection →
inspection → findings**. Composition is capability-based, not a repo-type
switch:

1. **Root discovery** finds candidate campaign roots two ways: the existing
   Page Kit detector, and portable Campaign Cart evidence collection (per-file
   signals rolled up to the nearest `package.json` boundary). A directory
   already claimed as a Page Kit root is never double-claimed.
2. **Classification** records `implementation.kind`
   (`page_kit` | `campaign_cart_app`) *with the evidence list that justified
   it*. Classification is descriptive; it never gates a capability by itself.
3. **Capability detection** decides which inspections run for a root based on
   evidence present (e.g. `checkout_field_contract` runs wherever
   `data-next-checkout-field` / `os-checkout-field` bindings exist — including
   future Page Kit roots that inline checkout markup; `built_output_doctor`
   requires a Page Kit `_site`). A campaign may use Page Kit for some surfaces
   and custom application code for others; capabilities make that additive.
4. **Contract inspection** validates against injectable contracts rather than
   hardcoded literals:
   - `contracts/campaign-cart-checkout-field-contract.v0.json` — canonical
     `data-next-checkout-field` keys, accepted aliases, and known stale
     aliases with their canonical replacements (`state` → `province`,
     `postal_code`/`zip` → `postal`), provenance-stamped against the
     campaign-cart SDK source.
   - `contracts/campaign-cart-sdk-support-policy.v0.json` — version policy
     (minimum supported / preferred minimum) separate from version
     *discovery*. The policy is data, replaceable per run
     (`createStandardizationReport({ sdkSupportPolicy })`), so "latest" is
     never frozen into scanner code.
5. **Runtime/behavioral surfaces** are reported as interaction-risk items that
   require proof, never as static failure claims (see Evidence confidence).

## Evidence confidence

Every ecosystem finding carries a `confidence` field:

- `static_contract` — provable from source against a named contract
  (unsupported checkout field key, SDK version below policy). Safe to treat as
  a repair target.
- `static_inference` — heuristic source evidence (custom payment triggers
  detected, synchronization script present). Informs risk, never asserts
  breakage.
- `runtime_proof_required` — behavior that only a DOM/browser test can
  confirm (custom payment controls actually driving
  `input[name="payment_method"]`). Reported as *missing proof*, explicitly
  distinct from a confirmed failure.

## What belongs where

- **Static standardization (this scanner):** root discovery, classification,
  loader/SDK version discovery + policy, field-contract validation, surface
  and `data-next-*` inventory, interaction-risk flags, artifact presence.
- **Doctor:** Build Packet/assembly-state validation and built-output checks
  for Page Kit roots (unchanged).
- **Browser QA:** behavioral proof — payment control synchronization, prospect
  cart creation, typed-card orders. Packetless QA for existing funnels is a
  follow-up, not this PR.
- **Operator readiness:** origin allowlist state, storefront/legal URLs, live
  payment methods — merchant/environment configuration, never conflated with
  application defects.

## Harness relationship

Any practitioner harness or agent layer built over Campaigns OS remains a
projection over its artifacts, never a competing orchestrator or source of
truth. This slice strengthens the deterministic core such a layer projects:
the standardization report becomes the campaign-ecosystem intake artifact
(classification + evidence + confidence), so workflows like candidate intake
and warning triage can consume report JSON instead of re-deriving judgment.
Nothing here adds orchestration, run identity, or routing — those stay out of
the scanner and out of any wrapper's claimed scope alike.

## Staged roadmap

1. **(this PR)** Campaign Cart application detection + checkout field
   contract + SDK support policy + payment interaction-risk classification.
2. Packetless `qa resolve/run` for existing funnels (behavioral payment proof,
   prospect-cart probe) keyed off the standardization report.
3. Deployed-URL-only assessment (fetch + built-output inspection without a
   checkout), origin-allowlist diagnosis as an operator-readiness capability.
4. Additional adapters: source-only exports, CampaignSpec/Build Packet
   cross-checking, legacy CampaignsJS funnels (migration detectors already
   exist in ops tooling and could inform a capability here).
5. Contract registry maturation: field/policy contracts versioned with
   provenance refresh scripts, like the starter-template catalog.

## Compatibility

- Page Kit root reports keep their existing sections and finding codes; each
  root additionally carries `implementation` and `capabilities` (additive).
- The no-root error becomes `campaign.root_not_found` (message names both
  recognized shapes). The prior `page_kit.root_not_found` code appeared only
  when nothing was detected at all; the rename is explicit, documented, and
  tested. Schema stays `campaign-standardization-report/v0` (additive fields;
  one error-code rename).
