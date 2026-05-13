# Campaigns OS

Campaigns OS is the developer toolkit for agent-assisted NEXT campaign builds.

It gives campaign developers and AI coding tools a clear path for assembling a campaign from prepared page files:

1. Configure the campaign in Campaigns App.
2. Create or review the Campaign Map.
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

Run these commands from a local checkout of this repo:

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

## Important Commands

```bash
npm run campaigns-os -- install-skills --dry-run
npm run campaigns-os -- prepare-build --spec <spec.json> --source <html-dir> --target <page-kit-repo> --template-family <family>
npm run campaigns-os -- doctor --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next setup --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next build --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next polish --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- next qa --packet <packet.json> --report <assembly-report.json>
npm run qa:install-browser
npm run campaigns-os -- qa resolve --packet <packet.json>
npm run campaigns-os -- qa run --packet <packet.json> --base-url <preview-url> --browser
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

Special case: `shop-three-step` uses dynamic shipping through `window.next.getShippingMethods()`. Do not blindly copy Olympus-style `shipping_methods` frontmatter into that family.

## Docs

- [Quickstart](docs/quickstart.md)
- [Access Model](docs/access-model.md)
- [Build Packet](docs/build-packet.md)
- [Campaigns OS Build Flow](docs/campaigns-os-build-flow.md)
- [Source Adapters](docs/source-adapters.md)
- [Developer Evaluation](docs/developer-evaluation.md)
- [QA And Test Orders](docs/qa-and-test-orders.md)
- [Versioning](docs/versioning.md)

## Status

Developer preview. Build output still needs the normal launch gates: build/lint evidence, polish, preview deploy, Playwright browser QA, and typed-card test-order proof when the deployed domain and sandbox card routing are confirmed.
