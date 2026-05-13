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
6. After build, require polish and a preview deploy before QA.
7. Run the package-owned browser QA path in sequence: `npm run qa:install-browser`, `campaigns-os qa resolve --packet <packet>`, then `campaigns-os qa run --packet <packet> --base-url <url> --browser`.
8. When the deployed domain and sandbox card routing are confirmed, run typed-card `--test-order` proof through the rendered checkout/upsell flow.
9. Discuss launch only from recorded build, polish, deploy, browser QA, and test-order evidence, or from explicit blockers.

Rules:

- This is contract-backed guidance and preflight, not full automated readiness.
- CampaignSpec/API own live commerce values.
- Starter-template `agentContract` owns reusable commerce structure and protected SDK surfaces.
- Designed source owns visual composition and page-level content.
- Do not copy demo refs or unsupported optional surfaces into the target campaign.
- Build Packet, context, and assembly-report paths should be repo-relative when possible so handoff artifacts can be committed without machine-local absolute paths.
- Store Profile fields are operator-entered storefront/legal metadata for page-kit `campaigns.json`; they do not come from the Campaigns API and should be collected in the CampaignSpec before build.
- Keep the lifecycle in a tight sequence. Pause only for missing inputs, doctor blockers, deploy blockers, test-order policy gates, or merchant-specific uncertainty.
- Browser QA and test-order proof are owned by Campaigns OS through Playwright. Do not route the core QA path through external browser skills or hand-built backend orders.
