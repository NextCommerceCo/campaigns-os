# Campaigns OS Build Flow

The intended flow is:

1. Agent selects or confirms a starter template family.
2. Agent reads `families[family].agentContract`.
3. Agent uses `sharedFrontmatterVocabulary`.
4. Agent replaces demo refs from CampaignSpec/API.
5. Agent preserves protected SDK commerce surfaces.
6. Agent runs page-kit build and SDK/template lint.
7. Agent hands off to polish.
8. QA follows after deploy through the Node/npm `campaigns-os qa` runner.

The doctor and checkpoint wrappers exist because agents take shortcuts under ambiguity. If the packet is blocked, stop and resolve the named blocker instead of improvising.

## Commerce Ownership

- CampaignSpec/API own live campaign identity, routes, package refs, offer refs, shipping refs, payment support, tracking intent, footer links, and SEO values.
- Starter template contracts own reusable commerce structure and protected SDK runtime surfaces.
- Designed source owns visual composition, content hierarchy, imagery, and page-level copy.

## Assembly Rules

- Landing and presell pages should preserve prepared HTML when it is a real standalone design. Use page-kit passthrough structure, inject the SDK/config requirements, and repoint CTAs into the CampaignSpec flow.
- Checkout, upsell, downsell, and receipt pages should preserve the starter-template commerce surfaces and swap campaign-owned values instead of copying source commerce markup.
- SDK routing meta tags should be emitted as campaign-root paths, for example `/campaign-slug/upsell/`, even when the CampaignSpec source value is slug-relative like `upsell/`.
- One-time prepurchase/order-bump packages outside the main bundle should default to fixed quantity and fixed line total display unless the spec explicitly requires syncing quantity with the main bundle.
- Any source element dropped because the spec does not support it, such as PayPal when `available_payment_methods` excludes PayPal, should be recorded in the assembly report for polish.

## Not Full Automation

This repo improves first-run success. It does not yet prove a campaign is live-ready.
