# Build Packet

The Build Packet is the campaign assembly handoff. It wraps, but does not replace, the CampaignSpec.

It answers:

- Which CampaignSpec and Map ID are we building?
- Which public route slug and campaign directory are expected?
- Where are the prepared HTML/assets?
- Which target page-kit repo should be updated?
- Which starter template family is locked?
- Which commerce catalog/contract should the agent read?
- Which deploy target, SDK origin state, and QA proof depth apply?

The current schema is `schemas/campaign-runtime-build-packet.v0.schema.json`.

Page-kit also needs `campaign.store_url` for `_data/campaigns.json`. Additional Store Profile fields live under `campaign.store_*` as optional storefront/legal metadata because they are operator-entered, not Campaigns API data.

> **Where does the source HTML come from?** See [docs/entry-points.md](./entry-points.md) for the five recognized entry points (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and how each populates `source_html.pages[]` + `design_source`.

## Artifact Locations

By default `campaigns-os start` writes into the target repo:

```text
campaign-runtime.build.json
.campaign-runtime/build-context.json
.campaign-runtime/assembly-report.json
.campaign-runtime/doctor-output.json
.campaign-runtime/theme/theme-report.json
```

Commit durable packet/context/report artifacts when they represent a real build handoff. The Campaigns API key is a public, browser-side, domain-allowlisted key and may already be present in the local CampaignSpec as `campaign.campaigns_api_key`; do not duplicate it into the packet unless the spec is unavailable. Do not commit raw private API responses, backend secrets, or temporary media exports.

`campaigns-os start` / `campaigns-os prepare-build` writes packet, context, report, and generated doctor-output paths as relative paths by default, including sibling CampaignSpec/source directories such as `../campaign-source`. `campaigns-os doctor` and `validate-build-packet` continue to accept older absolute-path packets; use `campaigns-os doctor --strip-paths` when regenerating a commit-ready doctor output from an older packet. Committed handoff artifacts should not contain machine-local absolute paths unless no relative form is possible.

`start` / `prepare-build` also run the [Brand Theme Bridge](./brand-theme-bridge.md)
in `inspect_only` mode. The optional theme evidence lives in `context.theme`,
`report.theme`, and `.campaign-runtime/theme/theme-report.json`. The Build
Packet itself does not gain required theme fields in v0.

## Adapter And Proof Fields

Fresh packets now include `source_html.adapter_contract`. Build Context and
Assembly Report carry the same values as `adapter_decisions`, and build agents
should update the report as they complete work.

Required adapter decisions:

| Field | Purpose |
| --- | --- |
| `raw_html_conversion_status` | Whether prepared HTML has been converted into page-kit-ready source. |
| `source_asset_strategy` | How images/fonts/CSS/JS are moved and referenced. Prefer `pagekit_campaign_asset_root`. |
| `commerce_shell_adoption` | Whether checkout/upsell/downsell/receipt use a template-clone-first SDK surface. |
| `route_rewrite_policy` | How page links, CTAs, and SDK routing values were rewritten from CampaignSpec routes. |
| `template_files_copied` | Whether the selected template family was copied/verified as one atomic page-kit slice. |
| `config_script_strategy` | How campaign config scripts are loaded. |
| `wrapper_policy` | Whether document wrappers are stripped, preserved, or not required. |
| `frontmatter_policy` | How Page Kit YAML frontmatter is created or preserved. |
| `script_style_reference_policy` | How scripts/styles move into frontmatter, campaign assets, inline blocks, or passthrough. |
| `cta_rewrite_policy` | How CTA destinations are rewritten from CampaignSpec routes. |
| `layout_choice` | Which Page Kit layout strategy wraps the prepared source. |

Fresh build context also includes `source.asset_crawl`
(`source-asset-crawl/v0`). `prepare-build` scans the source HTML files and
referenced local CSS, then records each local image/font/CSS/JS asset ref with:

- `raw` and `normalized` source refs;
- `source_path` / `source_exists` resolution under the source root;
- `pagekit_asset_path` for the campaign asset-root ref to use during assembly;
- summarized warnings for raw `/assets/...` refs, missing local files, and
  refs that escape the source root.

Use this inventory before moving assets into Page Kit. It is deliberately a
context/report aid, not part of `source_html.pages[]` page binding.

`template_files_copied` is intentionally group-based rather than prose-only:
`pages`, `_includes`, `_layouts`, `assets/css`, `assets/js`, and
`frontmatter_vocabulary`. Doctor warns when an assembly-complete report still
shows `pending`/`partial` template copying or misses one of those groups. When
the status is `complete` or `verified_existing_slice`, `paths` must name
target-repo-relative proof paths and doctor verifies those paths exist.

Fresh packets also include `qa.proof_policy`, mirrored into
`report.proof_policy`. It records browser QA requirement, typed-card depth,
localhost Development-domain behavior, non-localhost SDK allowlist requirement,
order path depth, and operator approval state. Test cards still need no
permission gate; the explicit field prevents agents from re-litigating proof
depth in chat. Doctor checks the full field set in both packet and report
artifacts when present.

## CampaignSpec Retrieval (`--map-id`)

`campaigns-os start` / `campaigns-os prepare-build` accept the CampaignSpec via either of two routes:

| Flag | Source | When to use |
| --- | --- | --- |
| `--spec <path>` | Local JSON file | Offline work, CI runs against a fixture, or hand-edited spec drafts |
| `--map-id <id>` | Map Builder proxy (KV-backed) | Default agentic flow — KV is the source of truth, no file shuttling |

When `--map-id <id>` is set, the CLI fetches `GET <proxy>/api/spec/<id>` (default `<proxy>` is `https://campaign-map.nextcommerce.com`) and caches the response to `<target>/.campaign-runtime/fetched-specs/<id>.json`. The cached file is what downstream stages read, so the packet's `spec.local_path` always resolves to an on-disk artifact regardless of intake mode.

Retrieval behavior:

- **Re-fetch by default.** Every `start` / `prepare-build` invocation re-fetches from KV. KV is the source of truth; the cache file is a debug/inspection artifact, not a performance optimization.
- **`--cached-spec`** reuses the cache without a network call. Use for offline iteration or when the proxy is temporarily unreachable.
- **`--proxy-base <url>`** overrides the default origin. Use for staging environments or local Worker dev (`wrangler dev`).
- Failure modes (HTTP error, `{ok: false}` response, network timeout) surface as clean CLI errors before any packet is written.

The fetched spec is treated identically to a `--spec`-supplied local file from this point forward — same identity validation, same `prepareBuild` pipeline, same idempotency semantics. Re-running `start --map-id` on the same campaign re-fetches the spec, regenerates the packet, and re-runs doctor. If `design_source` was newly populated since the last run, the doctor's design_source-aware blocker logic surfaces it; if nothing changed, the run is a no-op as far as downstream stages are concerned.

## Source HTML Manifest Auto-Population

When the source HTML root carries a source-html manifest at `<source>/.campaigns-os/source-html-manifest.json` (schema `source-html-manifest/v0`, published at `schemas/source-html-manifest.v0.schema.json`), `campaigns-os prepare-build` reads it and uses its `pages[]` block to populate `packet.source_html.pages[]` directly — bypassing the legacy filesystem-name slug matching.

Behavior:

- The manifest is consumed only when it passes the `source-html-manifest/v0`
  validator. Unknown schema versions, missing `page_id`/`path`, or malformed
  `source_hash` values log a warning and fall back to filesystem matching so
  out-of-band tools cannot silently corrupt the packet. Doctor also validates a
  present manifest at the source root.
- The manifest's `page_id` must match an active CampaignSpec page id. Manifest entries with no matching spec page surface as a `MANIFEST_EXTRA_PAGE` prompt (analogous to the existing `MISSING_SOURCE_PAGE` prompt) so the operator reconciles either the spec or the manifest before build.
- Optional manifest `page_url` values must be unique after Page Kit route normalization. Duplicate values surface as `MANIFEST_DUPLICATE_PAGE_URL`; prepare-build keeps the first value for route fallback matching and asks the operator to deduplicate before build.
- Path values are relative to the source HTML root (`<source>`), not to the `.campaigns-os/` directory that contains the manifest. For example, use `checkout/index.html`, not `../checkout/index.html`.
- The build context records `source.manifest` with `schema_version`, `generator`, `generated_at`, and `page_count`, and the assembly decision log records evidence citing the manifest file.

When the manifest is absent, prepare-build's behavior is unchanged — pages are matched by filesystem name slug as before.

### Page Kit Target Projection

`source_html.pages[].path` is source provenance. It names the producer/source-root-relative HTML file that should be consumed; it is not necessarily the file path to write under the Page Kit campaign directory.

Fresh `prepare-build` output also writes `source_html.pages[].page_kit` for mapped pages. This block is the Page Kit target projection:

- `target_path` is the page file relative to `assembly.output_dir` (`checkout.html`, `receipt.html`, etc.).
- `output_path` is the same target file relative to `assembly.target_repo`.
- `public_route` is the rendered campaign-rooted route Page Kit should produce.
- `page_type` is the CPK runtime/analytics vocabulary (`product`, `checkout`, `upsell`, `receipt`), not the richer CampaignSpec or producer page type. CampaignSpec `select` pages project as CPK `checkout` because they are pre-checkout runtime selection surfaces.
- `frontmatter` names the Page Kit frontmatter fields the build should write or preserve.
- `permalink_required` is true when Page Kit's filename-derived route would not match `public_route`.

`page_map[].output_path` in the Build Context is the same Page Kit target path,
not `source_html.pages[].path` appended under `assembly.output_dir`. Build agents
should read `source_path` for producer provenance and `page_kit.output_path` for
the file to write.

CampaignSpec `page_url` and legacy `url` values are interpreted as Page Kit
routes during projection. That normalization strips `.html`/`index.html`,
removes query/fragment values, converts absolute preview URLs to their path, and
normalizes trailing slashes before deriving target files and frontmatter routes.

This prevents mixed-source manifests such as `checkout/index.html` from leaking producer folder structure into `src/<slug>/checkout/index.html`. Campaigns OS owns the Adapter from source/manifest/CampaignSpec into Page Kit shape; Page Kit remains the target.

`target_path` intentionally uses the terminal route segment (`checkout/step-1/`
projects to `step-1.html`). If two routes collapse to the same target filename,
prepare-build emits `PAGE_KIT_TARGET_CONFLICT`; change one CampaignSpec route
before build instead of letting an agent choose a destination.

### Per-page `source_hash` (Slice 6 drift detection)

Each `manifest.pages[]` entry MAY carry a `source_hash` field — the sha256 hex digest of the source HTML file's contents at the moment the producer wrote the manifest. When present, prepare-build threads the hash onto the matching `packet.source_html.pages[]` mapping. Doctor reads the packet mapping at validate time, computes the current on-disk sha256 of the same file, and warns (`source_html.pages.source_hash`) when they diverge.

Behavior:

- Optional on the producer side. Producers that don't emit `source_hash` (pre-Slice-6 manifests, template-stock, hand-authored) keep working; doctor's drift check is silent without a hash to compare.
- Warning severity only. A drift never blocks a build — the operator decides whether to re-run the producer to refresh the manifest or accept the local edits.
- The warning names the file path and includes both hashes (truncated to 12 chars) so the operator can confirm which file diverged without re-running the producer.

### Reference AI-generated producer

`scripts/reference-ai-producer.mjs` ships in this repo as the smallest possible producer reference. It walks a folder of HTML files (auto-discovery) or accepts explicit `--page page_id=path` mappings, computes sha256 per file, and emits the `source-html-manifest/v0` at the canonical location. Auto-discovery maps `landing.html` to `landing` and nested `checkout/index.html` to `checkout`; duplicate inferred page ids fail fast, so use explicit `--page` mappings for ambiguous layouts.

Usage:

```bash
node scripts/reference-ai-producer.mjs \
  --source <source-root> \
  --campaign-slug <slug> \
  [--generator <name@version>] \
  [--page landing=presell-a.html --page checkout=checkout/step.html]
```

Real AI agents (Claude, Codex, etc.) that produce campaign source HTML should adopt this manifest shape so doctor's design_source-aware error messages and Slice 6 drift detection work uniformly across producers. The script generates only the manifest; it does not write any HTML.

## Authoring-Time Hints (Template Family + Upsell Pattern)

The CampaignSpec carries two optional **hints** the build agent uses
as defaults. Both are hints, not contracts: CLI / operator overrides
always win.

**Campaign-level:** `campaign.preferred_template_family` declares
which starter family the campaign was authored against (one of
`olympus`, `limos`, `demeter`, `olympus-mv-single-step`,
`olympus-mv-two-step`, `shop-single-step`, `shop-three-step`). The
consumer (`preferredTemplateFamily()` in `src/cli.mjs`) reads this
at three spec locations and uses it as the default template family
when no `--template-family` CLI flag is given.

Resolution order:

1. `--template-family <family>` CLI flag (sets `template_lock.locked: true`).
2. `spec.spec_identity.preferred_template_family`.
3. `spec.campaign.preferred_template_family` (the canonical authoring location).
4. `spec.preferred_template_family` (legacy fallback).
5. `"undecided"`.

When the hint wins, `template_lock.locked` stays `false` — the family is set as the default but not locked, so a downstream stage (or a follow-up operator pass) can override without contradiction. `template_decision_notes` records the hint source. `template.candidates` in the build context lists the hint with `source: "CampaignSpec preferred_template_family"` for provenance.

**Per-page:** `Page.upsell_template_pattern` declares the UI variant
for an upsell page (one of `mv`, `bundle_tier_pills`,
`bundle_tier_cards`, `single`). Flows from the spec page onto
`packet.source_html.pages[].upsell_template_pattern` so the build
stage can pick the right partial without re-parsing the spec.

The field is per-page; only upsell pages should carry it. Upstream
spec validation warns when it's set on non-upsell pages, but the
consumer surfaces it verbatim and lets the build stage decide what
to do with it.

## Orchestration Loop (`campaigns-os next`)

`campaigns-os next` (no stage argument) is the agentic orchestration primitive. It reads the current packet, doctor, and assembly report state from disk and tells you which stage should run next. Each call re-reads state, so the loop is idempotent and recoverable across sessions / machines.

The motion:

```text
agent calls `next` → gets { stage, prompt, picked_reason } → does the work →
updates assembly report's stages.<name>.status → calls `next` again →
repeat until stage="done"
```

Stage order: `setup → build → polish → deploy → qa`. The picker walks this list and returns the first stage whose recorded status isn't terminal (`completed`, `completed_with_warnings`, `skipped`).

| Stage | Report key | Owner |
|---|---|---|
| setup | `stages.setup` | scaffold the page-kit campaign repo |
| build | `stages.assembly` | assemble the campaign (next-campaigns-build) |
| polish | `stages.polish` | source-design fidelity pass (next-campaigns-polish) |
| deploy | `stages.deploy` | ship `_site/` to Netlify / CF Pages / Vercel / etc. (out-of-band) |
| qa | `stages.qa` | spec-aware QA (next-campaigns-qa) |

The CLI stage name is `build` but the report keys the same stage as `assembly` — the picker handles the translation. Both names refer to the same lifecycle step.

Result shape (with `--json`):

```jsonc
{
  "ok": true,
  "status": "ready",
  "stage": "build",
  "picked_reason": "Stage \"assembly\" has status \"pending\"; run \"build\" next.",
  "prompt": "Use next-campaigns-build for this Campaigns OS handoff. ...",
  "errors": [],
  "warnings": [],
  "ready": [],
  "stage_blocked": false  // present only when the recorded status is "blocked"
}
```

Terminal states:

- **`stage: "doctor-blocked"`** — doctor returned errors. Resolve the blockers and re-run `campaigns-os doctor` to confirm before calling `next` again.
- **`stage: "done"`** — every stage is in a terminal status. Pipeline is complete. To re-run a specific stage, set its status back to `"pending"` in the assembly report and call `next` again.
- **`stage_blocked: true`** — the picker returned a stage whose recorded status is `blocked`. Don't run the prompt as-is; clear the blocker first.

The legacy form `campaigns-os next <stage>` (e.g. `next build`) still works and is the way to force a specific stage when you want to override the picker.

## Design Source-Aware Coverage Error

CampaignSpec pages may carry an optional `design_source` block on `Page` — a pointer to the design artifact (Figma file + per-breakpoint selection URLs) that supplies prepared HTML for that page. When doctor detects an active spec page with no source mapping, the `source_html.pages.coverage` error now carries a hint that points the operator at the design source:

- `design_source.type === "figma"` with `file_url`: doctor calls out the Figma file and the figma-sections-export handoff command (`npm run handoff -- <slug>`).
- `design_source` set without `file_url`: doctor flags the missing `file_url` so the spec can be corrected.
- `design_source` unset: doctor keeps the original generic coverage error.

The error code (`source_html.pages.coverage`) is unchanged so existing doctor consumers do not need to be updated; only the human-readable `message` and an optional `detail.design_source` payload are added.
