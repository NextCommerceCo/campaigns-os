# Campaigns OS Build Flow

The happy path is intentionally tight:

1. Export a saved CampaignSpec from Campaign Map Builder, including Map ID and public route slug.
2. Run `campaigns-os start` with the CampaignSpec, prepared source files, target page-kit repo, and template family.
3. Treat doctor as the first gate. If it returns `collect-inputs`, stop and resolve the named blocker.
4. Run setup when doctor asks for setup; otherwise continue to assembly.
5. Assemble the page-kit campaign from starter-template contracts, not from copied demo commerce values.
6. Run page-kit build plus SDK/template lint and record results in the assembly report.
7. Run polish against the built campaign, then deploy a preview.
8. Install the package-owned Playwright browser with `npm run qa:install-browser`.
9. Run `campaigns-os qa resolve`, then `campaigns-os qa run --browser` with the preview URL.
10. When the deployed domain and sandbox card routing are confirmed, run typed-card `--test-order` proof through the rendered checkout and upsell controls.
11. Promote, block, or iterate from the recorded build, polish, deploy, QA, and test-order evidence.

Pause only for missing inputs, doctor blockers, blocked deploys, test-order policy gates, or merchant-specific uncertainty. The default path should not branch into external browser skills or hand-built backend order creation.

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
