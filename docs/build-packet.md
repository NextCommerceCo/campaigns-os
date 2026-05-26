# Build Packet

The Build Packet is the campaign assembly handoff. It wraps, but does not replace, the CampaignSpec.

It answers:

- Which CampaignSpec and Map ID are we building?
- Which public route slug and campaign directory are expected?
- Where are the prepared HTML/assets?
- Which target page-kit repo should be updated?
- Which starter template family is locked?
- Which commerce catalog/contract should the agent read?
- Which deploy target and QA policy apply?

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
```

Commit durable packet/context/report artifacts when they represent a real build handoff. The Campaigns API key is a public, browser-side, domain-allowlisted key and may already be present in the local CampaignSpec as `campaign.campaigns_api_key`; do not duplicate it into the packet unless the spec is unavailable. Do not commit raw private API responses, backend secrets, or temporary media exports.

`campaigns-os start` / `campaigns-os prepare-build` writes packet, context, report, and generated doctor-output paths as relative paths by default, including sibling CampaignSpec/source directories such as `../campaign-source`. `campaigns-os doctor` and `validate-build-packet` continue to accept older absolute-path packets; use `campaigns-os doctor --strip-paths` when regenerating a commit-ready doctor output from an older packet. Committed handoff artifacts should not contain machine-local absolute paths unless no relative form is possible.

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

When the source HTML root carries a source-html manifest at `<source>/.campaigns-os/source-html-manifest.json` (schema `source-html-manifest/v0`), `campaigns-os prepare-build` reads it and uses its `pages[]` block to populate `packet.source_html.pages[]` directly — bypassing the legacy filesystem-name slug matching.

Behavior:

- The manifest is consumed only when its `schema_version` is `source-html-manifest/v0`. Unknown schema versions log a warning and fall back to filesystem matching so out-of-band tools cannot silently corrupt the packet.
- The manifest's `page_id` must match an active CampaignSpec page id. Manifest entries with no matching spec page surface as a `MANIFEST_EXTRA_PAGE` prompt (analogous to the existing `MISSING_SOURCE_PAGE` prompt) so the operator reconciles either the spec or the manifest before build.
- Path values are relative to the manifest's location (which is always `<source>/.campaigns-os/source-html-manifest.json`, so effectively relative to the source root).
- The build context records `source.manifest` with `schema_version`, `generator`, `generated_at`, and `page_count`, and the assembly decision log records evidence citing the manifest file.

When the manifest is absent, prepare-build's behavior is unchanged — pages are matched by filesystem name slug as before.

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

## Design Source-Aware Coverage Error

CampaignSpec pages may carry an optional `design_source` block on `Page` — a pointer to the design artifact (Figma file + per-breakpoint selection URLs) that supplies prepared HTML for that page. When doctor detects an active spec page with no source mapping, the `source_html.pages.coverage` error now carries a hint that points the operator at the design source:

- `design_source.type === "figma"` with `file_url`: doctor calls out the Figma file and the figma-sections-export handoff command (`npm run handoff -- <slug>`).
- `design_source` set without `file_url`: doctor flags the missing `file_url` so the spec can be corrected.
- `design_source` unset: doctor keeps the original generic coverage error.

The error code (`source_html.pages.coverage`) is unchanged so existing doctor consumers do not need to be updated; only the human-readable `message` and an optional `detail.design_source` payload are added.
