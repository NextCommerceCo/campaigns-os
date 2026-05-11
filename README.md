# Campaigns OS

Campaigns OS is the public-safe toolkit for agent-assisted NEXT campaign builds.

It gives campaign developers and AI agents a clean front door for the current dogfood path:

1. Configure the campaign in Campaigns App.
2. Create or review the Campaign Map.
3. Export a local CampaignSpec JSON.
4. Bring prepared HTML/CSS/assets for the campaign pages.
5. Create and doctor a Build Packet.
6. Hand off to `next-campaigns-build`.
7. Run build/lint, then `next-campaigns-polish`.
8. Deploy a preview.
9. Run `next-campaigns-qa`.
10. Log friction and unresolved blockers.

This is not full automated readiness. It is a contract-backed flow that helps agents avoid common mistakes like carrying over demo package IDs, copying shipping options from the wrong starter template shape, or editing SDK-owned checkout surfaces as plain HTML.

## Quick Start

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

## Current Assumption

V0 assumes the developer brings prepared HTML/CSS/assets. The source adapter is `html_funnel`.

Future Figma-led assembly should be added as a separate source adapter or design-export stage that emits page-kit-native pages, partials, assets, and refs before the same packet, doctor, build, polish, deploy, and QA gates.

## Important Commands

```bash
npm run campaigns-os -- prepare-build --spec <spec.json> --source <html-dir> --target <page-kit-repo> --template-family <family>
npm run campaigns-os -- doctor --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next setup --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next build --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next polish --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- next qa --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- qa resolve --packet <packet.json>
npm run campaigns-os -- qa run --packet <packet.json> --base-url <preview-url>
```

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
- [Agentic Build Flow](docs/agentic-build-flow.md)
- [Source Adapters](docs/source-adapters.md)
- [Dogfooding](docs/dogfooding.md)
- [QA And Test Orders](docs/qa-and-test-orders.md)
- [Versioning](docs/versioning.md)

## Status

Dogfood alpha. Keep this repo public-safe, but do not treat it as a published SDK or package until the golden path has been tested by the first friendly developer cohort.
