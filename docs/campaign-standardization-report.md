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
`capabilities` — the inspections that actually ran for that root, never a
standing list per kind. A `page_kit` root always lists
`page_kit_source_contract`, `sdk_version_policy` and
`campaign_cart_runtime_inventory`; it adds `checkout_field_contract` only
when its source inlines `data-next-checkout-field` / `os-checkout-field`
bindings, and `built_output_doctor` only once a built-output doctor result is
attached (so never under `--no-doctor`, never without a `_site`, never while
the built slug is unresolved). A `campaign_cart_app` root lists
`campaign_cart_runtime_inventory`, `sdk_loader_discovery`,
`sdk_version_policy`, `checkout_field_contract` and
`payment_interaction_risk`. Composition is capability-based rather than a
repository-type switch (see `campaign-ecosystem-standardization-design.md`).

Run it against a Page Kit root, a parent `*-cpk` repo, or any campaign
application checkout:

```bash
campaigns-os standardize --target /path/to/example-cpk --json
campaigns-os standardize --target /path/to/example-cpk --family olympus-mv-single-step --slug example --json
```

The command is spelled `standardize`. It had a second spelling,
`standardization-report`, which dispatched to the same code with the same
flags and the same output; that spelling was removed at supported surface
1.27.0 and now returns the unknown-command error, so a script still using it
must be retargeted at `standardize`. The report's own
`schema_version` is unaffected.

By default, the command prints markdown for operators. Use `--json` for agents
or dashboards. When a built `_site` exists, the built slug is resolved, and a
template family is explicit or can be found in `.campaign-runtime`, the
command also runs the existing `doctor --built` checks and folds those
findings into the report. Use `--no-doctor` to keep the run to source/runtime
inventory only.

The command is read-only: it never writes into the target repository, and a
test holds it to that (every file's size, mtime and content hash are identical
before and after a run that includes the built-output doctor).

### Flags

`standardize` accepts exactly `--target`, `--family` (alias
`--template-family`), `--slug`, `--sdk-support-policy`, `--field-contract`,
`--no-doctor`, `--json`, and the two flags every command accepts,
`--run-id` and `--lifecycle-journal`. Any other flag is refused before the
scan starts, with the known list in the message — including the
`--flag=value` spelling, which the parser would otherwise store as an unknown
key (`--no-doctor=maybe` used to run the doctor anyway). Values follow the
flag as the next argument.

### Exit codes

- `0` — the report was produced and `ok` is `true` (`status` is `ready` or
  `ready_with_warnings`).
- `1` — the command did not run: an unknown flag, a missing `--target`, or a
  missing or unparseable `--sdk-support-policy` / `--field-contract` file.
  Nothing is printed on stdout; stderr carries one named error.
- `2` — the report was produced and `ok` is `false` (`status` is
  `blocked`, including `campaign.root_not_found`).

### When `--slug` matters

The built-output scope is the directory under `_site/` whose pages the
built-output doctor inspects. It is resolved from, in order: `--slug`; the
single slug `_data/campaigns.json` declares; the `campaign.public_route_slug`
a `.campaign-runtime` packet names; and, only when none of those exists, the
`_site/` layout itself (one html-bearing directory, or root-level html). The
report records the choice as `built_output.slug` and `built_output.slug_source`
(`operator_flag`, `campaigns_json`, the packet's relative path, or
`site_layout`), and `identity.campaign_slug` / `identity.campaign_slug_source`
carry the same answer. Two outcomes replace a silent guess:

- `built_output.scope_unresolved` (operator readiness) — `_site/` holds more
  than one html-bearing directory and no slug source names one. This is the
  case that needs `--slug`; the finding lists `slug_candidates` and the
  doctor proof command carries a `--slug <slug>` placeholder.
- `built_output.slug_mismatch` (operator readiness) — the slug came from
  `campaigns.json` or a packet, but `_site/` has no directory for it. The
  built output belongs to some other campaign (a stale build, typically), so
  the doctor is skipped and the finding names the expected slug, its source,
  and the directories that are there. Rebuild, or pass `--slug` to inspect a
  different directory on purpose.

Whenever a slug was needed, the doctor proof command under `remediation`
carries it (`--slug <resolved>`), so the command the report hands back is the
one that reproduces its own result.

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

Both contracts apply to both root kinds. The SDK support policy judges every
discovered SDK version — a `campaign_cart_app` root's loader pins and bundled
dependency, and a `page_kit` root's `_data/campaigns.json` `sdk_version`
values — with one rule: below `minimum_supported` is the blocker
`version.sdk_below_minimum_supported`, below `preferred_minimum` is the
warning `version.sdk_below_preferred_policy`, and each message names the
policy source. Every root records the policy it was judged by under
`version_policy` (`source`, `minimum_supported`, `preferred_minimum`,
`evaluations[]` with a `source` of `loader`, `bundled_dependency` or
`campaigns_json` per version), and the markdown prints it as
`Version policy: min X, preferred Y (source)`. The bundled policy is
`0.4.20` minimum / `0.4.30` preferred. The Page Kit dependency cutoff is
separate: `version.page_kit_below_preferred_cutoff` fires below `0.1.1`, a
constant in the scanner, because the policy contract has no Page Kit field.
The checkout field contract runs wherever inline checkout bindings exist; a
Page Kit root that inlines them gets the same `checkout_fields` block and the
same `checkout.unsupported_field_binding` / `checkout.unknown_field_binding`
findings as an application root.

Both are also injectable from the CLI: pass
`--sdk-support-policy <path-to-json>` and/or `--field-contract <path-to-json>`
to `standardize`. Each file is read and JSON-parsed
(a missing or unparseable file is a clear, named error) and overrides the
bundled contract for that run, for every root the run discovers:

```bash
campaigns-os standardize --target /path/to/example-cpk \
  --sdk-support-policy ./my-sdk-policy.json \
  --field-contract ./my-field-contract.json --json
```

When no root of either kind is detected, the report carries a single
`campaign.root_not_found` error (this replaced the earlier
`page_kit.root_not_found` code when ecosystem detection landed).

### Page Kit root sections

Each Page Kit root contains these sections:

- `identity`: repo name, Page Kit root, slug inventory, SDK versions, Page Kit
  dependency, template family evidence, certification freshness for that
  family, Campaigns OS artifact presence, and built-site presence.
  `template_certification_freshness` states the SDK version the family was
  last verified against and the current SDK recorded by the vendored
  contracts (the commerce surface catalog snapshot's per-family
  `verification` blocks plus the SDK support policy) — an older evidence
  record is not current certification. Families with no verification record
  on the snapshot report freshness as unknown rather than inventing one.
- `source_structure`: HTML/page/include/layout counts, Liquid helper counts,
  raw blocks, document wrappers, hardcoded root asset refs, unreadable files,
  and payment-method include detection.
- `runtime_contract`: `data-next-*` anchor summary, checkout/upsell/receipt
  surface signals, package/shipping refs, source manifest presence, and
  `.campaign-runtime` inventory.
- `version_policy`: the SDK support policy the root was judged by and its
  per-version evaluations (see above).
- `checkout_fields`: present only when the root inlines checkout bindings;
  the same shape as on application roots.
- `built_output`: built page inventory, the resolved slug and its source,
  slug-scope resolution state (`slug_candidates` when unresolved), and
  optional built-output doctor result.
- `findings`: normalized blocker, warning, and operator-readiness items with
  evidence and next action.
- `remediation`: safe agent repairs, clarification needed, product or merchant
  risks, and proof commands.

## Finding Taxonomy

`standardization_blocker` means an agent should not assume the repo is portable
or standard without repair. Current blockers include missing or invalid
`_data/campaigns.json`, an SDK below the policy's minimum supported version,
stale checkout field aliases, Liquid raw blocks, and built-output doctor
errors.

`standardization_warning` means the repo can be inspected but may drift from the
modern CPK contract. Current warnings include an SDK below the policy's
preferred minimum, a Page Kit dependency below `0.1.1`, missing Campaigns OS
artifacts, hardcoded `/assets/...` refs, page-level
document wrappers, unreadable source files, missing `campaign_asset`, missing
`data-next-*` anchors, and tentative payment-method include gaps.

`operator_readiness` means the repo may be technically inspectable but lacks
proof or business context. Current readiness items include missing built output,
unknown or tentative template family, missing source-html manifest, unresolved
built slug, a built slug with no matching built directory, and unknown
production proof.

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
- Provenance refresh script for the field/policy contracts, mirroring the
  starter-template catalog refresh.
- Symlinked source directories are currently skipped (silent false negative)
  and large vendored files are read whole; add link-following policy and a
  file-size cap.
- CSS-aware hidden-control detection (external stylesheets are not scanned;
  `undetermined` proof state covers the gap honestly for now).
