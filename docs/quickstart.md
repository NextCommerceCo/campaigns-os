# Quickstart

This path is optimized for a developer using Claude Code or another AI coding tool with a prepared campaign design.

## Install Skills

After installing or updating the CLI, refresh the Campaigns OS skills in Claude Code:

```bash
campaigns-os install-skills
```

By default, this syncs `skills/*/SKILL.md` from the installed package into `~/.claude/skills/<skill-name>/SKILL.md` and reports which skills were created, updated, or unchanged. Preview changes without writing files:

```bash
campaigns-os install-skills --dry-run
```

Use `--target <dir>` to sync into another skills directory for testing or a managed profile.

## Inputs

You need:

- Campaigns App setup with packages, offers, shipping methods, payment methods, and an API key.
- Campaign Map exported as a local CampaignSpec JSON, including Store Profile fields for page-kit `campaigns.json`.
- Prepared HTML/CSS/assets for the campaign pages.
- A target `next-campaign-page-kit` repo or local directory.
- A starter template family decision, usually `olympus` unless `demeter` or `shop-single-step` better matches the campaign shape.

Campaigns API keys are public, browser-side, domain-allowlisted keys. If your exported CampaignSpec includes `campaign.campaigns_api_key`, `doctor` uses it directly and does not require a `CAMPAIGNS_API_KEY` shell env var.

The Store Profile is operator-entered campaign metadata, not Campaigns API data. `doctor` expects `campaign.store_name`, `store_url`, `store_terms`, `store_privacy`, `store_contact`, `store_returns`, `store_shipping`, `store_phone`, and `store_phone_tel`.

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
- SDK-driven test-order proof when the deployed domain and `test_card` sandbox routing are confirmed

```bash
npm run campaigns-os -- qa resolve --packet path/to/page-kit-repo/campaign-runtime.build.json
npm run campaigns-os -- qa run --packet path/to/page-kit-repo/campaign-runtime.build.json --base-url https://preview.example.com/campaign/
```
