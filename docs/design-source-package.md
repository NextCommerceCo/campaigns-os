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

## Clearing `DESIGN_SOURCE_PACKAGE_NOT_READY`

`prepare-build` and `start` block at intake when a renderable page has no
qualifying primary-design claim with linked `desktop` and `mobile`
`source_screenshot` proof. Doctor reports one
`DESIGN_SOURCE_PACKAGE_NOT_READY` error per blocking reason; the blocked
`capture-<surface>-<viewport>` Source TODOs are themselves blocking reasons, so a
four-page funnel with no proof reports twelve. `next` routes back to
`collect-inputs`. Nothing is wrong with the run: the package is coherent and
durable, and it is telling you that the source material arrived without visual
proof.

The input channel that supplies that proof is the source-html manifest at
`<source-root>/.campaigns-os/source-html-manifest.json`. Each `pages[]` entry may
carry a `screenshots[]` array; `prepare-build` reads it, alongside the
equivalent `screenshot_refs` and `source_screenshot_refs` keys, and normalizes
each record into the html_funnel contribution's `screenshot_refs`. This is the
only operator-authored channel that seeds source-screenshot proof (a producer's
`section_exports[].images` is the other, producer-authored path); the package
itself is not hand-edited, and there is no capture command.

The manifest is read only when the whole file is a valid `source-html-manifest/v0`
document: `schema_version` set to `"source-html-manifest/v0"` and a `pages[]`
array whose entries carry the active CampaignSpec `page_id` and exactly one of
the source-root-relative `path` or a `skip_reason` for a page that has no source
HTML by design (schema: `schemas/source-html-manifest.v0.schema.json`;
consumer mechanics: [Source HTML Manifest Auto-Population](build-packet.md#source-html-manifest-auto-population)).
A manifest that fails validation is reported as a doctor *warning*, not an error:
`prepare-build` falls back to filesystem matching and never reads `screenshots[]`,
so the run blocks again with nothing else changed. `node scripts/reference-ai-producer.mjs`
emits a valid envelope (page ids, paths, `source_hash`) from a folder of HTML
files; add the `screenshots[]` records to its output, or start from the complete
example below. (`context.source.manifest_draft` in the build context is populated
only when filename matching was ambiguous, and is `null` otherwise.)

### The record shape

One manifest page entry with its proof, inside the envelope the validator requires
(the mobile record is elided):

```json
{
  "schema_version": "source-html-manifest/v0",
  "pages": [
    {
      "page_id": "landing",
      "path": "landing.html",
      "source_hash": "<64 lowercase hex>",
      "screenshots": [
        {
          "id": "source-landing-desktop",
          "kind": "source_screenshot",
          "viewport": "desktop",
          "availability": "available",
          "path": ".campaigns-os/screenshots/landing-desktop.png",
          "sha256": "<64 lowercase hex>",
          "width": 1440,
          "height": 900,
          "device_profile": "desktop-1440x900",
          "browser": "playwright-chromium/151.0.7922.34",
          "captured_at": "2026-09-06T01:39:57.250Z"
        },
        { "viewport": "mobile", "path": ".campaigns-os/screenshots/landing-mobile.png" }
      ]
    }
  ]
}
```

Three fields decide whether a record counts toward the gate:

- `viewport` must be `desktop`, `mobile`, or `tablet`. A record without a
  recognized viewport is an asset, not proof, and is dropped.
- `availability` must be `available`, which means the record carries a `path` or
  a `url`. An `unavailable` record needs an `unavailable_reason`; it documents
  an absence and never satisfies a viewport.
- `kind` must be `source_screenshot`, which is the default when the field is
  omitted and the only kind that counts as proof. `unavailable_render` is
  accepted by the channel and retained, but it records an absence and never
  satisfies a viewport. Any other kind — `render_reference`, `export_reference` —
  is dropped for this channel rather than promoted.

You need one qualifying `desktop` record and one qualifying `mobile` record per
renderable page. `tablet` is optional in v0. A record that fails any of the three
tests produces no diagnostic: it is registered (or dropped) silently and the page
stays blocked, so check the three fields first when a rerun blocks again.

Everything else in the record is metadata that is retained but not required:
`id` (otherwise derived from the page surface, viewport, and a content digest),
`sha256` (64 lowercase hex, bare or `sha256:`-prefixed), `width`/`height` (positive integers, or a nested `dimensions` object),
`device_profile`, `scale_factor`, `browser`, `captured_at`, and `notes`. The
`source_ref_id` link that readiness requires is back-filled for you from the
page's own HTML source reference; you do not write it in the manifest.

Paths follow the manifest's own convention: relative to the source root passed
to `prepare-build`, not to the `.campaigns-os` directory. Keeping the PNGs
inside the source root — `.campaigns-os/screenshots/` is a good home — keeps the
manifest portable.

Editing the manifest changes its byte hash, which is part of the package's
provenance. Expect the recovery below to be required whenever you add or change
`screenshots[]`.

### What counts as source proof

A `source_screenshot` attests what the merchant's design actually looks like.
That means a **standalone HTML document**: a complete page that renders on its
own in a browser — its own `<html>`, its own stylesheets and assets, no build
step. Render it at a desktop and a mobile viewport and the capture is honest
evidence of the design you are asked to preserve.

A **prepared page-kit fragment** is not that. A file that carries page-kit
frontmatter and a bare body fragment (the shape of the quick-start fixtures
under `examples/source-html/`) has no standalone appearance; screenshotting it
captures frontmatter text and an unstyled fragment. It is a faithful capture of
a file and it is not proof of a design.

The gate cannot tell the two apart — see the negative controls below — so this
distinction is yours to hold. When the source is fragments, or when the design
exists only inside a tool you cannot render, the honest record is an
`unavailable_render` with an `unavailable_reason`, which documents the absence
in the package but **does not clear the gate**. What would clear it honestly is
an accepted screenshot-absence Source Gap or an approved waiver, described under
[Gaps, TODOs, waivers, and readiness](#gaps-todos-waivers-and-readiness); in
v0 neither has an operator-authored input channel (the manifest carries no gap
key, `checkpoint waive` registers no design-source gate, and the package is not
hand-edited). A source that cannot be captured honestly therefore stays blocked
at intake in v0. Hold there and escalate; do not attest a capture of something
that was never a page.

### Template-stock pages: the family decides

A third case is neither a standalone design nor an uncapturable one: the page
has no bespoke design at all, because the design *is* the starter template
family. There is nothing of the merchant's to screenshot, so a
`source_screenshot` would be a capture of stock the toolkit already ships.

`template_baseline` coverage is the honest route for such a page, and whether
an intake operator can reach it depends entirely on the family. It is emitted
only from a Template Reference carrying an `id`, `family`, `version`, a
`contract_path` or `artifact_path`, and linked `template_reference_screenshot`
records for desktop and mobile (see
[Template Reference behavior](#template-reference-behavior)) — and that proof is
published by the family's catalog entry, not authored by the operator.

**Families that publish complete Template Reference proof — today `apollo`
alone — have a supported intake path.** Declare each template-derived page out
of source scope and the rest follows automatically: the catalog's Template
Reference supplies the proof, synthesis emits `template_baseline` coverage for
those pages, and they stop demanding screenshots that do not honestly exist.
Two ways to declare it, both first-class:

- a per-page `skip_reason` entry in the source-html manifest — a `pages[]` entry
  carrying `page_id` and `skip_reason` and no `path` (a page entry takes exactly
  one of the two);
- `build_scope.mode: "partial"` on the CampaignSpec, when the whole scope is
  partial rather than a few named pages.

`src/partial-source-build.test.mjs` covers both declarations end to end against
`apollo`, including a clean re-run.

That path is a partial build, and it carries partial-build limits. Prepare
reaches `stages.prepare_build.status: "completed_partial"`, not `completed`; the
declared pages appear under `declared_out_of_scope` (with `declared_by`
recording which mechanism declared them) and under `derived.scope`; doctor
labels only the mapped routes as previewable; and checkout launch and
test-order proof stay blocked while runtime pages are out of scope. You get a
terminal, honest intake — not a fully proven campaign.

**Every other family has no operator channel.** Without a published Template
Reference there is no `template_baseline` to synthesize, the manifest carries no
key that declares "this page is template stock", the package is not hand-edited,
and `checkpoint waive` registers no design-source gate — so nothing the operator
can write clears `DESIGN_SOURCE_PACKAGE_NOT_READY` for the page.

Policy for v0: **that is deliberate, and no further operator channel is coming
in v0.** Where no applicable template proof exists, template-stock pages are
handled in the build stage, by `next-campaigns-build`, which owns the family
contracts and the template material. Do not attest a screenshot of stock
template output to get past intake, and do not read the recovery sequence below
as a path for this case — it is the recovery for a page that *does* have a
standalone design whose proof was missing the first time.

### Recovery after a blocked first run

A blocked run still emits the package, and `prepare-build` never refreshes a
package it did not just create. So a first run that blocked leaves a package
whose provenance names the *old* manifest, and simply rerunning with a new
manifest fails closed:

```
campaigns-os: Design Source Package at <target>/.campaign-runtime/input/design-source-package.json
is invalid, stale, or contradictory: [design_source_package.current_html_funnel_material_stale] … ;
[design_source_package.current_source_material_stale] … "…/source-html-manifest.json" is missing or
has stale kind, role, or byte hash. …
```

That refusal is the explicit reconciliation the ownership boundary requires. The
sanctioned sequence, from the source-preparation side:

```bash
# 1. capture the proof and write it into the manifest
#    <source-root>/.campaigns-os/source-html-manifest.json  →  pages[].screenshots[]

# 2. remove the package the blocked run emitted, so prepare-build re-synthesizes it
rm <page-kit-repository>/.campaign-runtime/input/design-source-package.json

# 3. rerun intake, from the Campaigns OS checkout (npm run resolves package.json
#    from the current directory; run from the source directory it fails with a
#    bare npm ENOENT)
npm run campaigns-os -- start \
  --spec <campaign-spec.json> \
  --source <prepared-html-directory> \
  --target <page-kit-repository> \
  --template-family <family>
```

Step 2 is only ever correct for a package emitted by a blocked run that no
downstream stage has consumed. Once Build or Polish has bound its evidence to a
package fingerprint, deleting it invalidates that evidence; reconcile through
the stage-freshness lanes instead.

After the rerun, `readiness.status` is `ready` (or `ready_with_gaps` /
`ready_with_waivers` when accepted gaps or active waivers exist), `blocking_reasons`
is empty, the `capture-*` TODOs are gone, and doctor advances to assembly.

### Negative controls: what the gate does not check

The package producer reads no files. It never opens the PNG at `path` and never
recomputes `sha256`; `sha256` is only checked for its spelling (64 lowercase hex,
bare or `sha256:`-prefixed) when present. A record pointing at a file that does not exist, and a record whose
`sha256` does not match its file, both clear the gate exactly as a real capture
does.

`screenshots[]` is therefore an **attestation**, not a verified artifact. The
toolkit takes your word that the capture is real, current, and of the thing it
names. Treat a wrong or absent file as what it is — a false claim about the
merchant's design that will surface as a mismatch during Polish, when there is
no honest evidence to compare against.

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
