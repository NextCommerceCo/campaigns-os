# Quickstart

This path is optimized for a developer using Claude Code or another AI coding tool with a prepared campaign design.

## Install CLI

Campaigns OS currently runs from the public toolkit repo:

```bash
git clone https://github.com/NextCommerceCo/campaigns-os.git
cd campaigns-os
npm install
npm run campaigns-os -- --help
```

When working from a local checkout, replace `campaigns-os ...` examples with
`npm run campaigns-os -- ...`. The package binary is `campaigns-os` when the
tool is installed or linked into your shell.

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

- Campaigns App setup with product/variant packages, Offer-based price tiers, shipping methods, payment methods, and an API key.
- Campaign Map exported as a local CampaignSpec JSON, including `campaign.store_url` for page-kit `campaigns.json`.
- Prepared HTML/CSS/assets for the campaign pages.
- A target `next-campaign-page-kit` repo or local directory.
- A starter template family decision, usually `olympus` unless `demeter` or `shop-single-step` better matches the campaign shape.

If the checkout should have an exit-intent offer or typed promo-code box,
configure it in Campaign Map Builder before export so the checkout page carries
the mapped `exit_intent.offer_ref_id` / `exit_intent.offer_code` or
`promo_code_input.offer_ref_id` / `promo_code_input.offer_code`.

Campaigns API keys are public, browser-side, domain-allowlisted keys. If your exported CampaignSpec includes `campaign.campaigns_api_key`, `doctor` uses it directly and does not require a `CAMPAIGNS_API_KEY` shell env var.

The Store Profile is operator-entered campaign metadata, not Campaigns API data. `doctor` requires `campaign.store_url`; `store_name`, `store_terms`, `store_privacy`, `store_contact`, `store_returns`, `store_shipping`, `store_phone`, and `store_phone_tel` are optional storefront/legal metadata used by templates when present.

Packages should identify products or variants, while Offers set the customer's final price. Do not create separate `1x` / `2x` / `3x` packages just to express tier pricing, and do not rely on package Retail Price/Quantity fields unless the campaign explicitly uses that older compatibility setup.

For synthetic or AI-generated evaluation campaigns, create or reuse a known test
store/API key before checkout work. A purely static source page can validate the
landing-page assembly path, but SDK checkout, package, shipping, payment, and
receipt surfaces need Campaigns App data; without it, checkout can remain in a
loading state. Record the test store/key choice in the Build Packet or
CampaignSpec so QA knows whether runtime checkout proof is expected or blocked.

For partial campaign work, map only the pages being built with
`source_html.pages[].path` and give intentionally untouched CampaignSpec pages a
clear `skip_reason`. Doctor will surface those pages under `derived.scope`,
label mapped routes as previewable, and keep checkout launch/test-order proof
blocked when runtime pages are out of scope.

## Prepare Raw HTML Source

`html_funnel` source files should be page-kit-ready source, not full browser
documents copied verbatim from an AI tool. This is not a wholesale Liquid
rewrite. Use Liquid only for page-kit helpers such as `campaign_link`,
`campaign_asset`, and `campaign_include`.

The conversion process used in prior builds is:

- Strip document-level wrappers: `<!doctype>`, `<html>`, `<head>`, and `<body>`.
- Add page frontmatter for title, layout, route/meta values, and any source mapping notes.
- Move shared CSS into the campaign asset tree or an include when it is reused; inline page-specific CSS only when the target page-kit style allows it.
- Move local images/fonts/assets into the campaign asset tree and root paths with `campaign_asset` when needed.
- Replace internal links/CTAs with CampaignSpec routes, usually via `campaign_link`.
- Keep source landing/presell composition and copy intact when it is a real design.
- Use starter-template SDK contracts for checkout, upsell, downsell, receipt, payment, totals, and submit controls.
- Run page-kit build and inspect `_site/<slug>/` before handing off to polish.

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
- starter-template/SDK lint from the target repo, for example `npm run lint:sdk`,
  `npm run lint:sdk:promoted`, or `npm run lint:sdk:ci` when those scripts are
  available. There is no separate `campaign-lint` package in the current flow.
- formal polish pass
- preview deploy
- Campaigns OS Playwright browser install
- Node/npm QA with Map ID and preview URL
- typed-card test-order proof when the deployed domain and sandbox card routing are confirmed

```bash
npm run qa:install-browser
npm run campaigns-os -- qa resolve --packet path/to/page-kit-repo/campaign-runtime.build.json
npm run campaigns-os -- qa run --packet path/to/page-kit-repo/campaign-runtime.build.json --base-url https://preview.example.com/campaign/ --browser
```

`npm run qa:install-browser` is a one-time local setup step after install/update.
It installs the Chromium binary used by the package-owned Playwright QA flow.
Run it before `--browser` or `--test-order`; the CLI will tell you to run it if
the browser binary is missing.
