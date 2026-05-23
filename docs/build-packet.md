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

## Source HTML Manifest Auto-Population

When the source HTML root carries a [source-html manifest](https://github.com/Sellmore-Co/figma-sections-export/blob/main/docs/source-html-manifest.md) at `<source>/.campaigns-os/source-html-manifest.json`, `campaigns-os prepare-build` reads it and uses its `pages[]` block to populate `packet.source_html.pages[]` directly — bypassing the legacy filesystem-name slug matching.

Behavior:

- The manifest is consumed only when its `schema_version` is `source-html-manifest/v0`. Unknown schema versions log a warning and fall back to filesystem matching so out-of-band tools cannot silently corrupt the packet.
- The manifest's `page_id` must match an active CampaignSpec page id. Manifest entries with no matching spec page surface as a `MANIFEST_EXTRA_PAGE` prompt (analogous to the existing `MISSING_SOURCE_PAGE` prompt) so the operator reconciles either the spec or the manifest before build.
- Path values are relative to the manifest's location (which is always `<source>/.campaigns-os/source-html-manifest.json`, so effectively relative to the source root).
- The build context records `source.manifest` with `schema_version`, `generator`, `generated_at`, and `page_count`, and the assembly decision log records evidence citing the manifest file.

When the manifest is absent, prepare-build's behavior is unchanged — pages are matched by filesystem name slug as before.

## Design Source-Aware Coverage Error

CampaignSpec pages may carry an optional `design_source` block (see `next-campaigns-ops` CampaignSpec `Page.design_source`). When doctor detects an active spec page with no source mapping, the `source_html.pages.coverage` error now carries a hint that points the operator at the design source:

- `design_source.type === "figma"` with `file_url`: doctor calls out the Figma file and the figma-sections-export handoff command (`npm run handoff -- <slug>`).
- `design_source` set without `file_url`: doctor flags the missing `file_url` so the spec can be corrected.
- `design_source` unset: doctor keeps the original generic coverage error.

The error code (`source_html.pages.coverage`) is unchanged so existing doctor consumers do not need to be updated; only the human-readable `message` and an optional `detail.design_source` payload are added.
