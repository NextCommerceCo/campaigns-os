# Quickstart

This path is optimized for a developer using Claude Code or another AI coding tool with a prepared campaign design.

## Inputs

You need:

- Campaigns App setup with packages, offers, shipping methods, payment methods, and an API key.
- Campaign Map exported as a local CampaignSpec JSON.
- Prepared HTML/CSS/assets for the campaign pages.
- A target `next-campaign-page-kit` repo or local directory.
- A starter template family decision, usually `olympus` for the shared dogfood path.

## Create The Packet

```bash
npm run campaigns-os -- start \
  --spec path/to/campaign-spec.json \
  --source path/to/designed-html \
  --target path/to/page-kit-repo \
  --template-family olympus
```

`start` creates the packet, context, report, doctor output, and target-repo agent context. It does not edit campaign pages, deploy, run QA, or place test orders.

## Continue In Your AI Tool

Run:

```bash
npm run campaigns-os -- next setup --packet path/to/page-kit-repo/campaign-runtime.build.json
```

If doctor says setup is not required, run:

```bash
npm run campaigns-os -- next build --packet path/to/page-kit-repo/campaign-runtime.build.json
```

Paste the generated handoff into your AI tool.

## Gates

Build is not launch readiness. A complete run still needs:

- page-kit build
- starter-template/SDK lint
- formal polish pass
- preview deploy
- Node/npm QA with Map ID and preview URL
- explicit test-order policy

```bash
npm run campaigns-os -- qa resolve --packet path/to/page-kit-repo/campaign-runtime.build.json
npm run campaigns-os -- qa run --packet path/to/page-kit-repo/campaign-runtime.build.json --base-url https://preview.example.com/campaign/
```
