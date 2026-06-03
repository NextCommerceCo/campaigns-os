# Campaigns OS

Campaigns OS is the developer toolkit for agent-assisted campaign builds on [Next Commerce](https://nextcommerce.com), a full-stack ecommerce platform for direct-response brands. A *campaign* is a short, conversion-focused funnel — landing page, checkout, optional upsells/downsells, receipt — wired to live products, price tiers, shipping, and payments.

This toolkit gives campaign developers and AI coding tools a clear path for assembling one from prepared page files:

1. Configure the campaign in the Next Commerce dashboard (Campaigns App).
2. Create or review the Campaign Map in [Campaign Map Builder](https://campaign-map.nextcommerce.com).
3. Export a local CampaignSpec JSON.
4. Bring prepared HTML/CSS/assets for the campaign pages.
5. Create and doctor a Build Packet.
6. Hand off to `next-campaigns-build`.
7. Run build/lint, then `next-campaigns-polish`.
8. Deploy a preview.
9. Install the Campaigns OS Playwright browser once with `npm run qa:install-browser`, then run `next-campaigns-qa`.
10. Record launch blockers and follow-up work.

The toolkit is contract-backed: starter templates describe which parts are reusable page structure, which parts are live commerce wiring, and which demo values must be replaced for a real campaign. That helps AI tools avoid common mistakes like carrying over sample package IDs, copying shipping options from the wrong template shape, or editing SDK-owned checkout surfaces as plain HTML.

## Quick Start

Run these commands from a local checkout of the public toolkit repo
(`https://github.com/NextCommerceCo/campaigns-os`):

```bash
npm install
npm run campaigns-os -- start \
  --spec examples/campaignspec.v42.basic.json \
  --source examples/source-html \
  --target examples/target-page-kit \
  --template-family olympus
```

The command writes these target-repo artifacts:

- `campaign-runtime.build.json`
- `.campaign-runtime/build-context.json`
- `.campaign-runtime/assembly-report.json`
- `.campaign-runtime/doctor-output.json`
- `.campaign-runtime/agent-context/*`

Then ask your AI tool to continue from the emitted handoff. Fresh target repos usually start with `next-campaigns-setup`; existing campaign directories can move directly to `next-campaigns-build`.

## Source Files

The current source adapter is `html_funnel`: bring prepared HTML/CSS/assets for the campaign pages, plus a local exported CampaignSpec from Campaign Map Builder.

For raw AI-generated or exported static HTML, "prepared" means page-kit-ready
source, not a browser document dropped in unchanged and not a wholesale Liquid
rewrite. Page Kit source is HTML with YAML frontmatter and optional Liquid
helpers. Convert standalone HTML into the target page format first: remove outer
`<html>`, `<head>`, and `<body>` wrappers, add page frontmatter, move shared
CSS/assets into the campaign asset tree when useful, root links/assets with
`campaign_link` and `campaign_asset` when needed, and keep landing/presell
design markup separate from SDK-owned commerce controls.

## Important Commands

```bash
npm run campaigns-os -- install-skills --dry-run
npm run campaigns-os -- install-skills --platform codex --dry-run
npm run skills -- status
npm run campaigns-os -- prepare-build --spec <spec.json> --source <html-dir> --target <page-kit-repo> --template-family <family>
npm run campaigns-os -- doctor --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- theme inspect --packet <page-kit-repo>/campaign-runtime.build.json --json
npm run campaigns-os -- theme generate --packet <page-kit-repo>/campaign-runtime.build.json --json
npm run campaigns-os -- next setup --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next build --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next polish --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- next qa --packet <packet.json> --report <assembly-report.json>
npm run qa:install-browser
npm run campaigns-os -- qa resolve --packet <packet.json>
npm run campaigns-os -- qa run --packet <packet.json> --base-url <preview-url> --browser --test-order common
npm run campaigns-os -- findings add --stage overall --kind positive_signal --summary "..."
npm run campaigns-os -- findings export --summary
```

Run `npm run qa:install-browser` once after install/update and before any QA
command that uses `--browser` or `--test-order`. It installs the Chromium binary
used by the package-owned Playwright flow; Campaigns OS QA should not depend on
external browser skills.

## Template Contracts

The starter-template catalog snapshot lives in `contracts/commerce-surface-catalog.json`.

For each selected family, the agent must read:

- `families[family].agentContract`
- `sharedFrontmatterVocabulary`
- `frontmatter.demoOnlyValues`
- `frontmatter.replaceFromSpecOrApi`
- `frontmatter.removeWhenUnsupported`

Shipping is family-specific. Families whose contracts include `shipping_methods`
or `shipping_method` must source those refs from CampaignSpec/API. Families that
do not own explicit shipping frontmatter, including `shop-single-step`, should
not receive copied Olympus-style `shipping_methods` blocks. Special case:
`shop-three-step` uses dynamic shipping through `window.next.getShippingMethods()`.

When bootstrapping a family such as `demeter`, copy the family as an atomic
page-kit slice. Checkout/receipt pages depend on matching `_includes/`,
`_layouts/`, `assets/css/`, and `assets/js/`; copying only individual page files
is not a valid minimum file set.

## Docs

- [Quickstart](docs/quickstart.md)
- [Access Model](docs/access-model.md)
- [Build Packet](docs/build-packet.md)
- [Brand Theme Bridge](docs/brand-theme-bridge.md)
- [Campaigns OS Build Flow](docs/campaigns-os-build-flow.md)
- [Entry Points](docs/entry-points.md) — five intake shapes (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and which producer / manifest each one ships with
- [Source Adapters](docs/source-adapters.md)
- [Developer Evaluation](docs/developer-evaluation.md)
- [QA And Test Orders](docs/qa-and-test-orders.md)
- [Workflow Findings Sidecar](docs/workflow-findings-sidecar.md) — local-first capture of workflow signals (the Learning Trail), separate from the formal proof trail; never phones home
- [Versioning](docs/versioning.md)

## Status

Developer preview. Build output still needs the normal proof gates: build/lint evidence, polish, preview deploy or local dev URL, Playwright browser QA, and typed-card test-order proof via `--test-order common` (global test cards bypass the gateway and create no transactions; no approval needed — depth is the only control). Localhost on any port is a Campaigns App Development domain, so SDK calls are allowed and analytics are suppressed there; non-localhost preview/production origins still need SDK origin allowlist confirmation.

Launch readiness is separate from Campaigns OS proof. Before real shoppers see a campaign, confirm the production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration.
