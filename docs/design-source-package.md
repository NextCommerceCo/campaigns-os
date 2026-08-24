# Design Source Package v0

The Design Source Package is the durable, normalized creative/provenance input
that Build and Polish consume. It does not replace CampaignSpec commerce truth,
the Campaign Build Brief, Template Reference runtime proof, or Polish Evidence.
Those artifacts stay separate and join through stable Surface Identity and
fingerprints.

This guide documents the v0 implementation shipped by this repository. The
normative JSON shape is
[`schemas/campaign-design-source-package.v0.schema.json`](../schemas/campaign-design-source-package.v0.schema.json),
and the runtime validator and producer enforce additional cross-record and
current-input checks.

## Contract identity and compatibility

- Schema identity: `campaign-design-source-package/v0`.
- Schema file: `schemas/campaign-design-source-package.v0.schema.json`.
- Default target-repo path:
  `.campaign-runtime/input/design-source-package.json`.
- Current `prepare-build` producer: `source_kind: "html_funnel"`.
- Current source adapter remains visible in `packet.source_html`. During v0,
  `prepare-build` emits that compatibility block alongside the normalized
  package; the source-html manifest and page mappings seed the package but do
  not become it.

The package is strict at its top level. It contains `schema_version`,
`package_id`, `source_kind`, `generated_at`, `material_fingerprint`,
`surface_identity`, `contributions`, `source_gaps`, `source_todos`, `waivers`,
`divergences`, `proposed_exceptions`, `notes`, `readiness`, and `readback`.
Unknown top-level fields are rejected.

## Contributions and coverage

Each `contributions[]` record identifies one source contribution and records:

- `id`, `kind`, `trust`, and whether it is `renderable`;
- structured `provenance` and `presentation_intent`;
- `source_refs`, source-side `screenshot_refs`, and comparison-side
  `reference_refs`;
- optional `template_reference` proof; and
- `mappings` that join the contribution to Surface Identity.

The v0 contribution kinds are `html_funnel`, `figma_frames`, `figma_sections`,
`page_kit`, `static_source`, `template_stock`, `agency_source`, and `other`.
Trust is `native`, `structured`, `rendered`, or `opaque`.

Every contribution mapping uses exactly one `coverage_role`:

- `primary_design`
- `partial_design`
- `brand_tokens`
- `asset_source`
- `copy_source`
- `template_baseline`
- `reference_only`
- `fallback_legacy`

Mapping `confidence` is `high`, `medium`, `low`, or `unknown`. It describes
confidence in the source-to-surface relationship, not design quality or
approval. A page-level `primary_design` claim must be `high` or `medium` to
qualify for readiness.

## Surface Identity

`surface_identity[]` is the campaign-facing join catalog. Exactly one entry
must reserve this identity pair:

```json
{
  "id": "campaign",
  "kind": "campaign"
}
```

The `campaign` ID and `campaign` kind are reserved for each other; the other
fields are not required to be empty. Current synthesis sets `label: "Campaign"`,
adds the current campaign Map ID and route slug to `aliases` when present, and
records those values as `mappings.campaign_map_id` and
`mappings.campaign_slug`. Current-input validation refuses an existing package
that omits or changes either mapping when the corresponding current value is
available. Campaign scope is used for legitimate campaign-wide gaps, TODOs,
waivers, divergences, and exceptions.

Current synthesis also creates a `kind: "page"` Surface Identity for every
active CampaignSpec page or mapped source page. Stable, human-semantic
CampaignSpec page IDs are preferred; otherwise the producer derives an ID from
the normalized page role and order. Section and runtime-surface entries are
allowed, but `prepare-build` does not invent them.

Page Surface Identity keeps these namespaces distinct in `mappings`:

- `campaign_spec_page_id`
- `map_builder_label`
- `map_builder_custom_name`
- `public_route`
- `producer_page_type`
- `source_page_id`
- `source_path`
- `page_kit`

The `page_kit` projection contains `target_path`, `output_path`,
`public_route`, `page_type`, and optional `spec_route` and
`permalink_required`. These fields, public routes, producer IDs, and DOM or
runtime names are mappings or aliases; none replaces Surface Identity.

## Source and visual references

Source references have a stable `id`, a `kind`, and at least one of `path` or
`url`. Their kinds are `html_file`, `manifest`, `asset`, `url`, `export`,
`document`, and `other`. They may also carry a byte hash, role, media type, and
notes.

Visual references use shared viewport keys: `desktop`, `mobile`, and optional
`tablet`. Their kinds are:

- `source_screenshot`
- `template_reference_screenshot`
- `render_reference`
- `export_reference`
- `unavailable_render`

An available visual requires a path or URL. An unavailable visual requires an
`unavailable_reason`. Available source and Template Reference screenshots must
also link to a known source record with `source_ref_id`. Width, height, device
profile, scale factor, browser, and capture time are metadata; they do not
create additional viewport names.

A coverage mapping cites reference IDs through `source_refs`,
`screenshot_refs`, and `reference_refs`. Readiness counts only correctly typed,
linked proof. A render reference, a generic image asset, or an image without an
explicit viewport is not silently promoted to source-screenshot proof. An
`unavailable_render` documents an absence but does not satisfy an available
desktop/mobile proof requirement.

### Source screenshot behavior

Primary-design coverage is evaluated existentially per page, not independently
for every claim. To satisfy the page through `primary_design`, at least one
`high` or `medium` claim must qualify. A non-renderable contribution needs no
screenshot proof; a renderable one qualifies only with available, linked
`source_screenshot` proof for both `desktop` and `mobile`. Tablet is optional in
v0. Once one qualifying claim has the required proof, another incomplete claim
for the same page does not create a screenshot blocker or TODO.

If the page has one or more high/medium claims but none has the required proof,
synthesis selects the claim with the fewest missing standard viewports (then by
stable contribution/mapping ID order) and produces one blocking
`missing_source_screenshot` Source TODO per viewport missing from that claim.
An accepted screenshot-coverage Source Gap or active approved waiver supersedes
those TODOs.

Low or unknown primary coverage produces a blocking
`low_confidence_primary_design` TODO only when the page has no high/medium
primary claim and no accepted primary-coverage Source Gap or active approved
waiver. If there is no primary claim or coverage exception, an incomplete
selected Template Reference produces the specific TODO described below; a
complete proven `template_baseline` satisfies coverage, and otherwise the page
receives a blocking `missing_primary_design` TODO.

### Template Reference behavior

A template family name alone is not proof. `template_baseline` coverage is
emitted only when the contribution has a Template Reference with:

- an `id`, `family`, and `version`;
- a `contract_path` or `artifact_path`; and
- available, linked `template_reference_screenshot` records for the standard
  `desktop` and `mobile` viewports.

If family selection lacks the version/location linkage, synthesis emits a
blocking `missing_template_reference` TODO. If the Template Reference is linked
but a standard viewport is absent, it emits a blocking
`missing_template_viewport` TODO for that viewport. Until proof is complete,
the template contribution carries no `template_baseline` mapping; the producer
does not invent a reference or viewport capture.

## Gaps, TODOs, waivers, and readiness

The detailed records are authoritative. `readiness` and `readback` are generated
summaries and must agree with them.

- Source Gap kinds are `coverage_absence`, `screenshot_absence`,
  `reference_absence`, `source_limitation`, and `other`; statuses are
  `proposed`, `accepted`, and `resolved`. A proposed gap blocks. An accepted
  gap with the matching kind, scope, and `applies_to` target may satisfy the
  relevant absence and yield `ready_with_gaps`.
- Source TODOs are `pending`, `blocked`, `completed`, or `skipped`. Any
  non-completed TODO blocks unless an active approved waiver matches its record
  or affected surface. A skipped TODO without that waiver is invalid as well
  as blocking.
- Source TODO kinds are `missing_source_screenshot`,
  `missing_template_reference`, `missing_template_viewport`,
  `missing_primary_design`, `low_confidence_primary_design`,
  `unreadable_reference`, and `other`.
- Waivers are `proposed`, `approved`, `revoked`, or `expired`. An effective
  waiver must be approved, attributed, and bounded by a future `expires_at` or
  a non-empty `review_condition`.
- A proposed readiness-affecting divergence or proposed exception blocks.
  Non-readiness-affecting records remain visible without creating that blocker.

Design Source Package readiness uses only:

- `pending`
- `blocked`
- `ready`
- `ready_with_gaps`
- `ready_with_waivers`

There is no `ready_with_warnings` source-readiness state. Warning-like source
conditions must be represented as a concrete gap, TODO, divergence, proposed
exception, note, or waiver. Notes never clear a blocker.

The shared checkpoint vocabulary additionally includes `completed`,
`completed_with_warnings`, and `skipped`, but those are not valid values for
`design_source_package.readiness.status`.

The generated `readiness` record also carries `blocking_reasons`, total
`gap_count`, `todo_count`, and `waiver_count`, plus `generated_at`. The generated
`readback` has the fixed buckets `summary`, `included_sources`, `handled`,
`blockers`, `gaps`, `todos`, `waivers`, and `next_actions`. Validation rejects a
summary or readback that contradicts the authoritative records.

## Artifact references and fingerprints

The Build Packet, Build Context, and Assembly Report emitted by
`prepare-build` each carry the same four-field reference, never an embedded
package:

```json
{
  "path": ".campaign-runtime/input/design-source-package.json",
  "schema_version": "campaign-design-source-package/v0",
  "sha256": "sha256:<64 lowercase hex>",
  "material_fingerprint": "sha256:<64 lowercase hex>"
}
```

`path` is relative to the artifact containing the reference. With default
locations, the packet uses
`.campaign-runtime/input/design-source-package.json`, while the context and
report use `input/design-source-package.json`. A custom nested report receives
the corresponding artifact-relative path. Consumers must resolve each path
from its owning artifact instead of comparing the path strings directly.

The two hashes have different jobs:

- `sha256` hashes the exact package bytes on disk. Whitespace, key order,
  timestamps, notes, and every other serialized byte affect it. When an
  existing package is reused, the reference hashes those original bytes rather
  than a reserialization.
- `material_fingerprint` hashes canonical JSON for the explicit v0 material
  projection. It drives Build/Polish freshness and is not a whole-JSON hash.

### Exact v0 material projection

The material projection contains:

- top-level `schema_version` and `source_kind`;
- every Surface Identity's `id`, `kind`, `label`, aliases, and mappings,
  including the Page Kit projection;
- every contribution's identity, kind, trust, renderability, provenance,
  presentation intent, source references, source screenshot/comparison
  references, Template Reference, and coverage mappings;
- all Source Gaps and Source TODOs;
- approved waivers only; and
- divergences and proposed exceptions whose `readiness_affecting` value is
  `true`.

The projected fields are explicit:

| Record | Fields in the v0 projection |
| --- | --- |
| Surface Identity | `id`, `kind`, `label`, `aliases`, and `mappings`: `campaign_map_id`, `campaign_slug`, `campaign_spec_page_id`, `map_builder_label`, `map_builder_custom_name`, `public_route`, `producer_page_type`, `source_page_id`, `source_path`, `page_kit`, `parent_surface_id`, `dom_selector`, `runtime_surface`. |
| Contribution core | `id`, `kind`, `trust`, `renderable`. |
| Provenance | `source_type`, `adapter`, `producer`, `generator`, `generator_version`, `source_root`, `manifest_schema_version`, `manifest_path`, `manifest_sha256`, `producer_material_fingerprint`, `asset_crawl_schema_version`. |
| Presentation intent | `summary`, `composition`, `content_hierarchy`, `imagery`, `copy`, `brand`, `responsive_behavior`. |
| Source reference | `id`, `kind`, `path`, `url`, `sha256`, `role`, `media_type`. |
| Visual reference | `id`, `kind`, `viewport`, `availability`, `url`, `path`, `sha256`, `width`, `height`, `device_profile`, `scale_factor`, `browser`, `source_ref_id`, `unavailable_reason`. |
| Template Reference | `id`, `family`, `version`, `contract_path`, `artifact_path`, `sha256`, `standard_viewport_refs` using the visual projection above. |
| Coverage mapping | `id`, `surface_id`, `coverage_role`, `confidence`, `source_refs`, `screenshot_refs`, `reference_refs`, `template_reference_id`. |
| Source Gap | `id`, `kind`, `scope`, `applies_to`, `reason`, `status`, `attributed_by`, `attributed_at`, `evidence_refs`. |
| Source TODO | `id`, `kind`, `scope`, `applies_to`, `description`, `status`, `owner`, `required_viewports`, `source_ref_ids`. |
| Approved waiver | `id`, `scope`, `applies_to`, `reason`, `status`, `waived_by`, `waived_at`, `expires_at`, `review_condition`, `evidence_refs`. |
| Readiness-affecting divergence | `id`, `scope`, `applies_to`, `summary`, `status`, `recorded_stage`, `readiness_affecting`, `attributed_by`, `evidence_refs`. |
| Readiness-affecting exception | `id`, `scope`, `applies_to`, `reason`, `status`, `readiness_affecting`, `proposed_by`, `evidence_refs`. |

Record collections and set-like ID lists are normalized deterministically
before hashing, and nested SHA-256 values have one material identity whether
written bare or with the `sha256:` prefix.

Administrative examples that are not projected include:

- top-level `package_id` and `generated_at`;
- generated `readiness` and `readback` fields;
- top-level, contribution, mapping, source-reference, and visual-reference
  notes;
- visual `captured_at` alone; and
- JSON formatting, object-key order, record-collection order, and set-like
  string-list order where the projection sorts by ID/value.

Non-approved waivers and non-readiness-affecting divergences/exceptions are also
outside the v0 projection. Even when a derived field is non-material, stale or
invented `readiness` or `readback` still fails validation. A changed
administrative byte therefore requires a refreshed full `sha256` reference but
does not, by itself, make Build or Polish stale.

## `prepare-build`: emit, validate, or refuse

`prepare-build` treats the default package path as an ownership boundary.

When the package is missing, it synthesizes the current `html_funnel` package,
validates it, serializes it, and reports mode `emitted`. Synthesis uses current
active pages and page mappings, campaign Map ID and route slug, current source
file hashes, the source-html manifest and its exact byte hash when present, the
source asset crawl, and the source-side template-family input. A coherent but
blocked package is still emitted so its TODOs and blockers are durable.

When the package already exists, `prepare-build`:

1. reads and retains its exact bytes;
2. parses and validates its strict shape, material fingerprint, generated
   readiness, and generated readback;
3. validates current campaign and page identity/mappings;
4. validates current HTML source/provenance, required source refs and byte
   hashes, coverage mappings, and current template material; and
5. requires `source_kind: "html_funnel"`.

If all checks pass, the mode is `reused`: the package bytes and modification
time are untouched, and all three artifact references use the full hash of
those exact bytes. Harmless reformatting and administrative notes can therefore
be reused when the material fingerprint and derived summaries remain valid.

If any current campaign, active/mapped page, source material, manifest or crawl
provenance, coverage, template family/reference, material fingerprint,
readiness, or readback check fails, `prepare-build` refuses. It leaves the
existing package and packet/context/report/brief sidecars byte-identical. It
does not silently regenerate or overwrite the package; source preparation must
reconcile the package and its references explicitly before retrying.

Before writing any output, `prepare-build` also requires distinct paths for the
Build Packet, Build Context, Assembly Report, Doctor output, normalized Build
Brief, and fixed Design Source Package. Equal paths and filesystem aliases are
rejected, including symlinks, hard links, dangling leaf symlinks, and symlinked
parent directories.

This behavior is the implemented v0 compatibility boundary. It does not promise
that a separate future workflow command will generate, repair, approve, or
silently refresh the package.

## Lifecycle ownership and freshness

Prepare owns source normalization and the three package references. It records
Design Source Package readiness blockers in both `report.blockers` and
`report.stages.prepare_build.blockers`, and sets the Prepare stage to
`completed` or `blocked`. Prepare leaves Assembly pending and does **not** write
`stages.assembly.source_package_material_fingerprint`.

Build owns consumption. Before Assembly is marked complete, Build records its
build fingerprint and copies the current
`report.design_source_package.material_fingerprint` to
`stages.assembly.source_package_material_fingerprint`.

Polish owns its distinct evidence. A current Polish record must match:

- the current Assembly build fingerprint through
  `stages.polish.source_build_fingerprint`; and
- the current Design Source Package material fingerprint through
  `stages.polish.source_package_material_fingerprint`.

If a current package exists but Assembly's source-package fingerprint is
missing or different, the Polish gate returns
`polish.assembly_source_package_fingerprint_missing` or
`polish.assembly_source_package_stale`, and `campaigns-os next` routes back to
Build. If Assembly is current but Polish's build or source-package fingerprint
is missing or stale, the route is back to Polish. A legacy report with no
current Design Source Package material fingerprint keeps build-only Polish
freshness and emits a warning.

The exceptional Assembly Source Freshness waiver lane remains explicit and
attributed. It can let Polish proceed despite missing/stale Assembly source
consumption, but Polish must still bind its own evidence to the current package;
the waiver is not a substitute for Polish Evidence.

Prepare blockers are coherent across the report. A terminal-looking
`stages.prepare_build.status` does not override `report.status: "blocked"`,
retained stage blockers, or retained top-level
`DESIGN_SOURCE_PACKAGE_NOT_READY` blockers.

For custom report locations, Build Context's `report_path` is the durable
pointer that packet-only `next` follows. Before any downstream stage is
selected, `next` verifies the context-to-packet pointer, report-to-packet and
report-to-context pointers, campaign Map ID and route slug, and the DSP
schema/hash/material/path binding across packet, context, and report. A missing
or foreign report, or any mismatched binding, fails closed at Prepare instead
of bypassing the earliest gate.

See [Polish evidence](./polish-evidence.md) for the full stage-evidence and
freshness gate.

## Inspect, validate, and test

This repository is a private package checkout. Invoke its CLI through the npm
script form: `npm run campaigns-os -- <cmd>`.

From the target repo root, inspect the default artifact and recompute its
exact-byte audit hash with Node:

```bash
node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  const path = ".campaign-runtime/input/design-source-package.json";
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes);
  console.log(JSON.stringify({
    path,
    schema_version: value.schema_version,
    readiness: value.readiness,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    material_fingerprint: value.material_fingerprint
  }, null, 2));
'
```

From this repository root, validate a target package's standalone runtime
contract:

```bash
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { validateDesignSourcePackage } from "./src/design-source-package.mjs";
  const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const result = validateDesignSourcePackage(value);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
' <page-kit-repository>/.campaign-runtime/input/design-source-package.json
```

The standalone validator does not know the current source directory or
CampaignSpec. Before downstream stage evidence exists, rerun the real producer
with the same current inputs to exercise current campaign/page/source/template
validation and exact-byte reuse:

```bash
npm run campaigns-os -- prepare-build \
  --spec <campaign-spec.json> \
  --source <prepared-html-directory> \
  --target <page-kit-repository> \
  --template-family <family> \
  --no-run-session \
  --json
```

`prepare-build` protects an Assembly Report that already contains downstream
stage evidence; do not use a destructive override merely to perform a check.
Use Doctor and `next` to inspect the cross-artifact and lifecycle gates:

```bash
npm run campaigns-os -- doctor --packet <page-kit-repository>/campaign-runtime.build.json
npm run campaigns-os -- next --packet <page-kit-repository>/campaign-runtime.build.json --json
```

Run the focused contract and negative-control suite from this repository:

```bash
node --test \
  src/design-source-package.test.mjs \
  src/design-source-package-prepare-build.test.mjs \
  src/design-source-package-polish.integration.test.mjs \
  src/polish-gate.test.mjs
npm run check
```
