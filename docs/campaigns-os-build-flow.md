# Campaigns OS Build Flow

The happy path is intentionally tight:

1. Export a saved local CampaignSpec JSON from Campaign Map Builder, including Map ID and public route slug.
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

## Partial Builds

Partial builds are valid campaign work. A pass may build only new presell pages,
landing pages, upsells, downsells, or another bounded slice that sends traffic
to an existing downstream route. In the Build Packet, map pages being built with
`source_html.pages[].path` and mark intentionally untouched pages with
`source_html.pages[].skip_reason`.

`doctor` classifies that as `derived.scope.mode = "partial"`. Mapped pages are
route/visual-testable after deploy. Skipped checkout, upsell, downsell, or
receipt pages keep checkout launch readiness and test-order proof blocked until
those runtime pages are built or explicitly delegated to an existing downstream
URL.

## Commerce Ownership

- CampaignSpec/API own live campaign identity, routes, package refs, offer refs, shipping refs, payment support, tracking intent, footer links, and SEO values.
- Starter template contracts own the SDK attribute contract and protected runtime surfaces: checkout/cart/upsell/receipt/payment/address/totals/submit controls and their required data attributes.
- Designed source owns visual composition, content hierarchy, imagery, and page-level copy.

## Assembly Rules

- Landing and presell pages should preserve prepared HTML when it is a real standalone design. Use page-kit passthrough structure, inject the SDK/config requirements, and repoint CTAs into the CampaignSpec flow.
- Checkout, upsell, downsell, and receipt pages should preserve starter-template SDK contracts while keeping the campaign/source visual language. Treat starter templates as the reference for required `data-next-*` controls and wiring, not as a mandate to carry their visual chrome into the final campaign.
- SDK routing meta tags should be emitted as campaign-root paths, for example `/campaign-slug/upsell/`, even when the CampaignSpec source value is slug-relative like `upsell/`.
- One-time prepurchase/order-bump packages outside the main bundle should default to fixed quantity and fixed line total display unless the spec explicitly requires syncing quantity with the main bundle.
- Any source element dropped because the spec does not support it, such as PayPal when `available_payment_methods` excludes PayPal, should be recorded in the assembly report for polish.
- After page-kit build, doctor checks rendered local script references plus rendered package and shipping refs against the CampaignSpec. Missing built scripts, stale package IDs, stale shipping IDs, and unavailable package refs must be fixed or intentionally blocked before QA.

## Synthetic Campaigns

For AI-generated or synthetic campaigns, the static source page can be used to
exercise the design-to-page-kit path, but SDK checkout still needs a Campaigns
App campaign, store URL, packages, shipping/payment configuration, and a
domain-allowlisted API key. If the evaluator has no natural merchant/store,
reuse a designated test store and record that choice. Otherwise mark checkout,
receipt, and test-order QA as blocked instead of debugging an SDK loading state
as if it were a page-kit build failure.

## Not Full Automation

This repo improves first-run success. It does not yet prove a campaign is live-ready.
