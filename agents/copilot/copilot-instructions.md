# Campaigns OS Instructions

When this repository contains Campaigns OS artifacts, use them as the build handoff:

- `campaign-runtime.build.json` defines the CampaignSpec, source adapter, target output, template family, deploy target, and QA policy.
- `.campaign-runtime/build-context.json` records page mappings and setup/build handoff details.
- `.campaign-runtime/assembly-report.json` records stage evidence and blockers.

Preserve Campaign Cart SDK-owned commerce surfaces. Replace starter demo refs from CampaignSpec/API. Do not claim launch readiness until build, polish, deploy, and QA evidence are recorded.
