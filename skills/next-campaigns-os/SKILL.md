---
name: next-campaigns-os
description: Coordinate Campaigns OS lifecycle workflows from CampaignSpec, Build Packet, starter-template contracts, stage reports, deploy evidence, and QA policy.
---

# Campaigns OS

Use this skill to orient a campaign build, run preflight, decide the next stage, and keep the lifecycle honest.

Workflow:

1. Confirm the campaign was configured in Campaigns App and exported from Campaign Map Builder as CampaignSpec v4.2 JSON.
2. Run `campaigns-os start` or `campaigns-os prepare-build` with a local CampaignSpec, prepared HTML/assets source, target page-kit repo, and explicit template family.
3. Run `campaigns-os doctor --packet <packet>`.
4. If doctor returns `collect-inputs`, stop and resolve the named blockers.
5. If doctor returns `assembly`, hand off with `campaigns-os next build --packet <packet>`.
6. After build, require polish, deploy, and QA stage evidence before launch discussion.

Rules:

- This is contract-backed guidance and preflight, not full automated readiness.
- CampaignSpec/API own live commerce values.
- Starter-template `agentContract` owns reusable commerce structure and protected SDK surfaces.
- Designed source owns visual composition and page-level content.
- Do not copy demo refs or unsupported optional surfaces into the target campaign.
