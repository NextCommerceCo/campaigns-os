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

Page-kit also needs Store Profile fields for `_data/campaigns.json`. These live in the local CampaignSpec under `campaign.store_*` because they are operator-entered storefront/legal metadata, not Campaigns API data.

## Artifact Locations

By default `campaigns-os start` writes into the target repo:

```text
campaign-runtime.build.json
.campaign-runtime/build-context.json
.campaign-runtime/assembly-report.json
.campaign-runtime/doctor-output.json
```

Commit durable packet/context/report artifacts when they represent a real build handoff. The Campaigns API key is a public, browser-side, domain-allowlisted key and may already be present in the local CampaignSpec as `campaign.campaigns_api_key`; do not duplicate it into the packet unless the spec is unavailable. Do not commit raw private API responses, backend secrets, or temporary media exports.
