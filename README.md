# Campaigns OS

Campaigns OS is the developer toolkit for agent-assisted campaign builds on [Next Commerce](https://nextcommerce.com), a full-stack ecommerce platform for direct-response brands. A *campaign* is a short, conversion-focused funnel — landing page, checkout, optional upsells/downsells, receipt — wired to live products, price tiers, shipping, and payments.

This toolkit gives campaign developers and AI coding tools a clear path for assembling one from prepared page files:

1. Configure the campaign in the Next Commerce dashboard (Campaigns App).
2. Create or review the Campaign Map in [Campaign Map Builder](https://campaign-map.nextcommerce.com).
3. Export a local CampaignSpec JSON.
4. Bring prepared HTML/CSS/assets for the campaign pages.
5. Provide or generate a [Campaign Build Brief](./docs/campaign-build-brief.md) for merchandising/design presentation decisions.
6. Create and doctor a Build Packet.
7. Hand off to `next-campaigns-build`.
8. Run build/lint, then `next-campaigns-polish`.
9. Deploy a preview.
10. Install the Campaigns OS Playwright browser once with `npm run qa:install-browser`, then run `next-campaigns-qa`.
11. Record launch blockers and follow-up work.

The toolkit is contract-backed: starter templates describe which parts are reusable page structure, which parts are live commerce wiring, and which demo values must be replaced for a real campaign. That helps AI tools avoid common mistakes like carrying over sample package IDs, copying shipping options from the wrong template shape, or editing SDK-owned checkout surfaces as plain HTML.

## Quick Start

Run these commands from a local checkout of the public toolkit repo
(`https://github.com/NextCommerceCo/campaigns-os`):

```bash
npm install
npm run campaigns-os -- tooling status
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
npm run campaigns-os -- tooling status
npm run campaigns-os -- install-skills --dry-run
npm run campaigns-os -- install-skills --platform codex --dry-run
npm run skills -- status
npm run campaigns-os -- prepare-build --spec <spec.json> --source <html-dir> --target <page-kit-repo> --template-family <family> --brief <campaign-build-brief.yaml>
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
npm run campaigns-os -- findings harvest --packet <packet.json>
npm run campaigns-os -- findings export --summary
```

Run `tooling status` before a build session to verify the local checkout,
package metadata, CLI entrypoint, and installed Campaigns OS skills agree. The
package is currently private/local-checkout based, so npm does not
automatically make agent skills current; when skills are stale, run
`npm run campaigns-os -- install-skills --platform all` and restart local agent
sessions.

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

## Spec Validation

`campaign-spec/` is the single, public source of truth for CampaignSpec
validation: a `normalize` phase, a composable rule registry, and a fixture
corpus. The `doctor` runs these rules during spec validation (emitted under the
`spec.validation` code, complementary to its packet/build-aware spec checks), and
any campaign authoring UI (such as a Map Builder bundle) can import the same
registry — so a spec rule is authored once and reaches internal teams and
third-party agencies alike. The rules are authored in TypeScript with no heavy
dependencies and compiled to plain ESM (`npm run build:spec`, on `prepare`) and a
stable subpath export `@nextcommerce/campaigns-os/campaign-spec`, so consumers run
them on `engines.node` (>=20) with no type-stripping or build step of their own.
See [`campaign-spec/README.md`](campaign-spec/README.md).

## Docs

- [Quickstart](docs/quickstart.md)
- [Access Model](docs/access-model.md)
- [Build Packet](docs/build-packet.md)
- [Brand Theme Bridge](docs/brand-theme-bridge.md)
- [CampaignSpec Authoring Examples](docs/campaignspec-authoring-examples.md)
- [Campaigns OS Build Flow](docs/campaigns-os-build-flow.md)
- [Entry Points](docs/entry-points.md) — five intake shapes (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and which producer / manifest each one ships with
- [Source Adapters](docs/source-adapters.md)
- [Setup Profile Parity](docs/setup-profile-parity.md)
- [Developer Evaluation](docs/developer-evaluation.md)
- [QA And Test Orders](docs/qa-and-test-orders.md)
- [Template Family vs Figma-extraction vs Hybrid](docs/template-vs-extraction-decision.md) — when to mint a template family, when to extract a bespoke design, and when to do both
- [Small PR Review Path](docs/small-pr-review-path.md)
- [Run Telemetry](docs/workflow-findings-sidecar.md) — per-run Run Record (system signal + workflow findings) tagged by improvement surface; captured locally always, remitted to Next Commerce only with up-front opt-out consent
- [Versioning](docs/versioning.md)

## Status

Developer preview. Build output still needs the normal proof gates: build/lint evidence, polish, preview deploy or local dev URL, Playwright browser QA, and typed-card test-order proof via `--test-order common` (global test cards bypass the gateway and create no transactions; no approval needed — depth is the only control). Localhost on any port is a Campaigns App Development domain, so SDK calls are allowed and analytics are suppressed there; non-localhost preview/production origins still need SDK origin allowlist confirmation.

Launch readiness is separate from Campaigns OS proof. Before real shoppers see a campaign, confirm the production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration.
