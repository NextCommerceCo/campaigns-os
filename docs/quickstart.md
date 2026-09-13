# Quickstart

This path is optimized for a developer using Claude Code or another AI coding tool with a prepared campaign design.

## Install CLI

Campaigns OS currently runs from the public toolkit repo:

```bash
git clone https://github.com/NextCommerceCo/campaigns-os.git
cd campaigns-os
npm install
npm run campaigns-os -- --help
npm run campaigns-os -- tooling status
```

When working from a local checkout, replace `campaigns-os ...` examples with
`npm run campaigns-os -- ...`. The package binary is `campaigns-os` when the
tool is installed or linked into your shell.

`tooling status` is the preflight for "am I current?". It checks the local
package identity, git/upstream state, CLI entrypoint, and installed Campaigns OS
skills. Today the toolkit runs from a local/private checkout rather than a
public npm dist-tag, so a fresh git pull does not automatically refresh copied
agent skills.

## Install Skills

After installing or updating the CLI, refresh the Campaigns OS skills in Claude Code:

```bash
campaigns-os install-skills
```

By default, this syncs bundled `skills/*` directories from the installed package into `~/.claude/skills/<skill-name>/` and reports which skills were created, updated, or unchanged. Preview changes without writing files:

```bash
campaigns-os install-skills --dry-run
```

Use `--platform` for other local agent profiles:

```bash
campaigns-os install-skills --platform codex
campaigns-os install-skills --platform agents
campaigns-os install-skills --platform all --dry-run
```

If `tooling status` reports stale skills, run:

```bash
npm run campaigns-os -- install-skills --platform all
```

Restart local agent sessions after updating skills so the new instructions are
loaded.

From a local checkout, `./skills.sh status` previews every known local target
and `./skills.sh install codex` refreshes Codex skills. Use `--target <dir>` to
sync into another skills directory for testing or a managed profile.

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

The Store Profile is operator-entered campaign metadata, not Campaigns API data. Before the target is scaffolded, `doctor` requires only `campaign.store_url`; `store_name`, `store_terms`, `store_privacy`, `store_contact`, `store_returns`, `store_shipping`, `store_phone`, and `store_phone_tel` are optional storefront/legal metadata used by templates when present. Once the target's `campaigns.json` entry exists, `page_kit.store_profile` checks every one of those fields the CampaignSpec provides against the target: a field the spec carries that the target lacks, or carries with a different value, blocks (the spec is the authority; fix the target entry or the spec, then re-run `doctor`), a field present only in the target warns as `target_only` — unless the value is starter demo residue (a placeholder storefront URL or phone number), which blocks as `demo_residue` whatever the spec says — and a field absent from both is clean. So a spec that fills all nine fields makes all nine required after scaffold. A discrepancy the spec cannot yet resolve can be recorded with `campaigns-os checkpoint waive --gate page_kit.store_profile` (see [docs/build-packet.md](./build-packet.md), "Checkpoint waivers").

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

`source_html.pages[].path` is the source/provenance path. Use
`source_html.pages[].page_kit` for the Page Kit target file, public route, CPK
`page_type`, and frontmatter projection. This matters for mixed sources where a
producer path such as `checkout/index.html` should still target
`src/<slug>/checkout.html` unless the CampaignSpec route requires a permalink.

## Prepare Raw HTML Source

`html_funnel` source files should be page-kit-ready source, not full browser
documents copied verbatim from an AI tool. This is not a wholesale Liquid
rewrite. Use Liquid only for page-kit helpers such as `campaign_link`,
`campaign_asset`, and `campaign_include`.

The conversion process used in prior builds is:

- Strip document-level wrappers: `<!doctype>`, `<html>`, `<head>`, and `<body>`.
- Add page frontmatter for title, layout, route/meta values, and any source mapping notes.
- Move shared CSS into the campaign asset tree or an include when it is reused; inline page-specific CSS only when the target page-kit style allows it.
- Move local images/fonts/assets into the campaign asset tree and root paths with `campaign_asset` when needed. Page Kit publishes `src/<slug>/assets/config.js` as `/<slug>/config.js` and `src/<slug>/assets/products/foo.png` as `/<slug>/products/foo.png`; raw `/assets/...` paths from AI/exported HTML are source paths, not built campaign URLs.
- Check `context.source.asset_crawl` in `.campaign-runtime/build-context.json` before rewriting assets. `prepare-build` crawls source HTML plus referenced local CSS, records raw refs, resolved source files, missing/out-of-root assets, and `pagekit_asset_path` hints so assembly does not have to rediscover `/assets/...` path behavior page by page.
- Replace internal links/CTAs with CampaignSpec routes, usually via `campaign_link`.
- Keep source landing/presell composition and copy intact when it is a real design.
- Use starter-template SDK contracts for checkout, upsell, downsell, receipt, payment, totals, and submit controls.
- Run page-kit build and inspect `_site/<slug>/` before handing off to polish.

Doctor checks this preparation deterministically: unstripped document wrappers
and leftover/broken frontmatter block with `source_html.prep.*` error codes,
and source-file internal links warn. See the "Source preparation check" section
in [docs/source-adapters.md](./source-adapters.md) for each code and its fix.
If the source is meant to stay a full browser document (raw HTML handed over
as-is, or pages whose `source_screenshot` proof must be of the standalone
document), do not strip it: record the decision instead with
`--wrapper-policy preserve_document_wrappers` on `start` / `prepare-build`, or
`wrapper_policy` in the source-html manifest, and the wrapper finding becomes a
warning that names the decision. Choose before capturing screenshots or
computing `source_hash`; the "Selecting the wrapper policy at intake" section of
[docs/source-adapters.md](./source-adapters.md) gives the order of operations.

## Create The Packet

> **Heads up — `start` turns on run telemetry, and remit is ON by default.**
> `start` (and `prepare-build`) opens an ambient Run Session in the target repo.
> When that session's Run Record is assembled — by a ready `qa run`, by
> `campaigns-os run end`, or by the automatic closeout of a stale session — it is
> **remitted to the canonical Next Commerce endpoint,
> `https://campaign-map.nextcommerce.com`**, without asking again.
>
> What is sent: the Run Record (the run's own system signal and workflow
> findings — stage timings, findings, tool/environment shape), plus the packet's
> Campaigns API key in the `X-Campaign-Key` header so the record lands in your
> tenant scope and you can read it back with `campaigns-os telemetry list
> --packet <json>`. Campaigns API keys are public, browser-side,
> domain-allowlisted keys by design, so this is attribution, not a secret.
>
> Why: those run records are what the toolkit learns from — they are how
> templates, gates, and guidance get fixed.
>
> Three ways out, any of which is enough:
>
> - `campaigns-os telemetry off` — machine-level, sticks.
> - `CAMPAIGNS_OS_TELEMETRY=off` — per shell or per CI job.
> - `--no-remit` on the remitting command (`qa run`, `run-record`, `run end`).
>
> Consent gates remit only. Capture is always local, so opting out costs you
> nothing locally: sessions, journals and Run Records are still written and
> the Run Record's `remit_state` reads `skipped`. Turning consent off at the
> machine or environment level (`telemetry off`, `CAMPAIGNS_OS_TELEMETRY=off`)
> also makes `qa run` default to a local-only verdict unless the campaign is
> portal-managed or `--post-verdict` is passed; `--no-remit` does not — it
> skips this command's remit only, and the verdict still publishes. To keep
> one verdict local, pass `--no-post-verdict` (or `--local-only`) to `qa run`.
> `--no-run-session` on `start` skips opening the session altogether. Full
> contract: [Run Telemetry](./workflow-findings-sidecar.md).

```bash
npm run campaigns-os -- start \
  --spec path/to/campaign-spec.json \
  --source path/to/designed-html \
  --target path/to/page-kit-repo \
  --template-family olympus
```

`start` creates the packet, context, report, doctor output, and target-repo agent context. It does not edit campaign pages, deploy, run QA, or place test orders.

It also runs brand-theme discovery in inspect-only mode. When source tokens are
available, the build context records `context.theme` and the target repo gets
`.campaign-runtime/theme/theme-report.json`. It does not write
`brand-theme.css` by default.

To inspect or generate the optional commerce-page brand bridge:

```bash
npm run campaigns-os -- theme inspect --packet path/to/page-kit-repo/campaign-runtime.build.json --json
npm run campaigns-os -- theme generate --packet path/to/page-kit-repo/campaign-runtime.build.json --json
```

Use `--theme-policy auto` on `start` / `prepare-build` only when you want
Campaigns OS to write `brand-theme.css` automatically from high-confidence
source tokens. Generated CSS is root-variable-only and must be loaded after
`next-core.css` on checkout, upsell, downsell, and receipt pages.

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
- Campaigns OS Playwright browser install
- formal polish pass against the served current build
- mandatory package-owned `polish capture` evidence before Polish becomes
  terminal or deploy/QA begins
- preview deploy
- Node/npm QA with Map ID and preview URL
- typed-card test-order proof via `--test-order common` (global test cards bypass the gateway; no permission/approval needed — depth is the only control)

```bash
npm run qa:install-browser
npm run campaigns-os -- polish capture --packet path/to/page-kit-repo/campaign-runtime.build.json --base-url <served-current-build-url>
npm run campaigns-os -- qa resolve --packet path/to/page-kit-repo/campaign-runtime.build.json
npm run campaigns-os -- qa run --packet path/to/page-kit-repo/campaign-runtime.build.json --base-url https://preview.example.com/campaign/ --browser --test-order common
```

`npm run qa:install-browser` is a one-time local setup step after install/update.
It installs the Chromium binary used by package-owned polish capture and QA.
Run it before `polish capture`, `--browser`, or `--test-order`; the CLI will tell
you to run it if the browser binary is missing. The capture producer must point
at the served current build and complete before Polish hands off to deploy/QA.

After the browser is installed, `npm run smoke:polish-capture` is an optional
real-Chromium package smoke. It needs permission to open a loopback HTTP
listener and is deliberately excluded from `npm run check` and CI.
