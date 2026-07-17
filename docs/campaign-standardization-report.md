# Campaign Standardization Report

The Campaign Standardization Report is a read-only audit for campaign
repositories across the campaign ecosystem. It discovers campaign roots,
classifies each root's implementation, inventories source structure and
runtime contracts, validates checkout field bindings and SDK loader versions
against contracts, and names the next safe remediation category without
editing the target repo.

Two implementation kinds are recognized:

- `page_kit` — modern CPK roots (`_data/campaigns.json` or a
  `next-campaign-page-kit` dependency). Existing sections and finding codes
  are unchanged.
- `campaign_cart_app` — non-Page-Kit applications (Vite/React/Express apps,
  static HTML funnels) detected through portable Campaign Cart evidence: the
  loader script URL, `meta[name="next-campaign-id"]`, `window.nextConfig`, or
  a sufficient density of `data-next-*` anchors. Evidence is rolled up to the
  nearest `package.json` boundary; one strong signal (or ≥5 weak anchors)
  classifies the root. Directories already claimed as Page Kit roots are never
  double-claimed, nested application roots are scanned independently (a parent
  root never re-reports a nested root's files), and a parent repo may contain
  both kinds side by side. HTML comments are masked throughout, so
  commented-out loaders, bindings, or radios never produce evidence or
  findings.

Every root carries `implementation` (`kind`, `evidence`, `frameworks`) and
`capabilities` — the inspections that ran for that root. Composition is
capability-based rather than a repository-type switch (see
`campaign-ecosystem-standardization-design.md`).

Run it against a Page Kit root, a parent `*-cpk` repo, or any campaign
application checkout:

```bash
campaigns-os standardize --target /path/to/example-cpk --json
campaigns-os standardization-report --target /path/to/example-cpk --family olympus-mv-single-step --slug example --json
```

By default, the command prints markdown for operators. Use `--json` for agents
or dashboards. When a built `_site` exists and a template family is explicit or
can be found in `.campaign-runtime`, the command also runs the existing
`doctor --built` checks and folds those findings into the report. Use
`--no-doctor` to keep the run to source/runtime inventory only.

## Schema

Top-level shape:

```json
{
  "schema_version": "campaign-standardization-report/v0",
  "generated_at": "2026-07-06T00:00:00.000Z",
  "target_repo": "/path/to/example-cpk",
  "status": "ready_with_warnings",
  "ok": true,
  "summary": {
    "root_count": 1,
    "blockers": 0,
    "warnings": 2,
    "operator_readiness": 1,
    "blocked_roots": 0,
    "warning_roots": 1,
    "ready_roots": 0
  },
  "roots": [],
  "errors": [],
  "recommendation": {
    "home": "staged_split",
    "summary": "Keep the read-only source/runtime scanner in public campaigns-os first; layer private repo discovery, issue creation, and merchant ops context in an internal campaign-ops wrapper."
  }
}
```

### Campaign Cart application roots

`campaign_cart_app` roots contain: `implementation`, `capabilities`,
`identity` (campaign IDs, loader-discovered SDK versions, runtime artifact
presence), `sdk_loader` (each loader reference with path/line/URL/version),
`version_policy` (policy source + per-version evaluations, separate from
version discovery), `checkout_fields` (every
`data-next-checkout-field`/`os-checkout-field` binding classified as
`supported`, `stale_alias`, or `unknown` against
`contracts/campaign-cart-checkout-field-contract.v0.json`), `payment`
(SDK `payment_method` radios, hidden radios, custom triggers, synchronization
script evidence, and `proof_state`), `runtime_contract`, `findings`, and
`remediation`.

`sdk_loader.references` records pinned and unpinned loader refs alike
(`version` is null for `@latest`/branch/commit pins, which raise
`version.sdk_loader_unpinned` instead of a policy evaluation). Only URLs that
point at a loader/dist artifact count; incidental `campaign-cart@x.y.z`
strings elsewhere in source are ignored.

`payment.proof_state` is one of `runtime_proof_required` (custom-control
evidence found), `undetermined` (radios exist; static scanning cannot exclude
externally-styled custom controls), or `not_applicable` (no `payment_method`
radios). The scanner never affirms that behavioral proof is unnecessary when
payment radios exist.

Ecosystem findings carry a `confidence` field:

- `static_contract` — provable from source against a named contract (stale
  field aliases, SDK version below policy). Safe repair targets.
- `static_inference` — heuristic source evidence. Informs risk only.
- `runtime_proof_required` — behavior only a DOM/browser test can confirm
  (custom payment controls driving the real radios). Reported as *missing
  proof*, explicitly not a confirmed failure.

The SDK support policy lives in
`contracts/campaign-cart-sdk-support-policy.v0.json` and is injectable per run
via `createStandardizationReport({ sdkSupportPolicy })`; the field contract is
similarly injectable via `fieldContract`. "Latest" is never frozen into
scanner code.

When no root of either kind is detected, the report carries a single
`campaign.root_not_found` error (this replaced the earlier
`page_kit.root_not_found` code when ecosystem detection landed).

### Page Kit root sections

Each Page Kit root contains these sections:

- `identity`: repo name, Page Kit root, slug inventory, SDK versions, Page Kit
  dependency, template family evidence, Campaigns OS artifact presence, and
  built-site presence.
- `source_structure`: HTML/page/include/layout counts, Liquid helper counts,
  raw blocks, document wrappers, hardcoded root asset refs, unreadable files,
  and payment-method include detection.
- `runtime_contract`: `data-next-*` anchor summary, checkout/upsell/receipt
  surface signals, package/shipping refs, source manifest presence, and
  `.campaign-runtime` inventory.
- `built_output`: built page inventory, slug-scope resolution state, and
  optional built-output doctor result.
- `findings`: normalized blocker, warning, and operator-readiness items with
  evidence and next action.
- `remediation`: safe agent repairs, clarification needed, product or merchant
  risks, and proof commands.

## Finding Taxonomy

`standardization_blocker` means an agent should not assume the repo is portable
or standard without repair. Current blockers include missing or invalid
`_data/campaigns.json`, Liquid raw blocks, and built-output doctor errors.

`standardization_warning` means the repo can be inspected but may drift from the
modern CPK contract. Current warnings include older SDK/Page Kit versions,
missing Campaigns OS artifacts, hardcoded `/assets/...` refs, page-level
document wrappers, unreadable source files, missing `campaign_asset`, missing
`data-next-*` anchors, and tentative payment-method include gaps.

`operator_readiness` means the repo may be technically inspectable but lacks
proof or business context. Current readiness items include missing built output,
unknown or tentative template family, missing source-html manifest, unresolved
built slug, and unknown production proof.

## Home Recommendation

Use a staged split:

- Put the read-only scanner, schema, markdown formatter, and built-output doctor
  integration in public `campaigns-os`.
- Put private repo discovery, sample-set selection, merchant launch context,
  issue creation, and workbench UI surfacing in an internal campaign-ops wrapper.

This keeps the portable contract close to the existing Campaigns OS doctor while
leaving private operational workflow outside the public package.

## First Follow-Up Backlog

- Add schema validation once the artifact shape settles across more repos.
- Add explicit template-family evidence from CampaignSpec and Build Packet when
  those artifacts are present.
- Replace crude payment-method include detection with family contract checks.
- Add optional `--output <path>` for durable JSON/markdown output.
- Add repo-set orchestration in an internal campaign-ops wrapper for private
  sample sets and follow-up generation.
- Add waiver support for intentional one-off template deviations.

## Ecosystem Follow-Up Backlog

- Packetless `qa resolve/run` for existing funnels, keyed off the
  standardization report, to convert `runtime_proof_required` payment findings
  into behavioral proof (deterministic DOM test of custom controls driving
  `input[name="payment_method"]`).
- Deployed-URL-only assessment (no source checkout).
- Origin/environment diagnosis as operator readiness: SDK origin allowlist
  rejection (CORS) must be classified as merchant/environment configuration,
  never conflated with an application integration defect.
- Additional adapters: source-only exports, legacy CampaignsJS funnels,
  CampaignSpec/Build Packet cross-checking for campaigns that carry full
  Campaigns OS evidence.
- Unify the Page Kit `campaigns.json` SDK cutoff onto the SDK support policy
  contract (currently the legacy hardcoded cutoff is preserved for
  compatibility).
- Provenance refresh script for the field/policy contracts, mirroring the
  starter-template catalog refresh.
- Symlinked source directories are currently skipped (silent false negative)
  and large vendored files are read whole; add link-following policy and a
  file-size cap.
- CSS-aware hidden-control detection (external stylesheets are not scanned;
  `undetermined` proof state covers the gap honestly for now).
