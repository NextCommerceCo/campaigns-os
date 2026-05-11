# Agentic Build Flow

The intended flow is:

1. Agent selects or confirms a starter template family.
2. Agent reads `families[family].agentContract`.
3. Agent uses `sharedFrontmatterVocabulary`.
4. Agent replaces demo refs from CampaignSpec/API.
5. Agent preserves protected SDK commerce surfaces.
6. Agent runs page-kit build and SDK/template lint.
7. Agent hands off to polish.
8. QA follows after deploy.

The doctor and checkpoint wrappers exist because agents take shortcuts under ambiguity. If the packet is blocked, stop and resolve the named blocker instead of improvising.

## Commerce Ownership

- CampaignSpec/API own live campaign identity, routes, package refs, offer refs, shipping refs, payment support, tracking intent, footer links, and SEO values.
- Starter template contracts own reusable commerce structure and protected SDK runtime surfaces.
- Designed source owns visual composition, content hierarchy, imagery, and page-level copy.

## Not Full Automation

This repo improves first-run success. It does not yet prove a campaign is live-ready.
