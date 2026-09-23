# Quickstart

Read [activation, access, and evidence](activation-and-evidence.md) before
interpreting an installed toolkit, saved Map, demo, or preview as campaign proof.

This path is optimized for a developer using Claude Code or another AI coding tool with a prepared campaign design.

## Install without a clone

Requirements: Node `>=20.19.0` and npm 10 or 11 (Node 22 ships npm 10). The
primary way to run Campaigns OS is pinned as a devDependency of the campaign
folder — a page-kit project — and run through `npx --no-install campaigns-os …`
from that folder. Nothing is cloned, nothing goes on PATH, and the pin is
committed in `package.json`, so CI and the deploy host install the same package
bytes. `--no-install` is part of the command: `campaigns-os` is only the bin
name of `@nextcommerce/campaigns-os`, so in a folder without the pinned copy a
plain `npx campaigns-os` looks that name up on the registry and, with no
terminal to ask, installs what it finds. With the flag, npx fails instead.

Do the steps in this order:

1. **Orient.** Read [`AGENTS.md`](../AGENTS.md), `contracts/supported-surface.json`,
   `contracts/release-ledger.json` and `CHANGELOG.md` on GitHub at one commit.
   Follow its canonical reading order. That is a read of declarative data,
   not a run of toolkit code. Keep the commit sha.
2. **Pin the toolkit, preflight, and install skills** at the exact reviewed release version.
3. **Start** at the exact reviewed release version.

New campaign folder:

```bash
mkdir "<route>" && cd "<route>"
npm init -y && npm i next-campaign-page-kit
npx campaign-init --non-interactive --template <family> --slug "<route>" --name "<campaign name>"
```

Existing page-kit campaign: `cd` into it (its `package.json` declares
`next-campaign-page-kit`). Then, in the campaign folder:

```bash
npm install --save-dev --save-exact @nextcommerce/campaigns-os@1.37.3
npx --no-install campaigns-os tooling status --platform claude
```

`1.37.3` is an exact published example. Select the release you reviewed and
verify its tag/provenance against the source commit; do not use a floating
dist-tag. Commit both `package.json` and `package-lock.json`. An unreleased
reviewed commit may instead be pinned with
`npm install --save-dev --save-exact "github:NextCommerceCo/campaigns-os#<full-sha>"`.
The package install runs its own lifecycle build; it is separate from the
checkout-only runtime preparation recipe and makes no claim under that recipe.
Diagnostics and corrected global invocation rendering require 1.35.0 or later;
`demo` requires 1.37.0 or later.

For an optional visual walkthrough,
`npx --no-install campaigns-os demo --target ./apollo-sample`
writes an offline sample. Open the printed local
`landing/index.html` file. This offline sample has no live commerce or campaign
proof. Preserve sample edits and create a separate new Page Kit folder for the
real campaign. See [offline sample preview](demo-preview.md).

Global use is also supported, with an exact release:

```bash
npm install -g @nextcommerce/campaigns-os@1.37.3
campaigns-os tooling status --platform claude
campaigns-os install-skills --platform claude
```

Global Git-source installation is not the supported path: npm's nested build
can inherit global mode. Global registry installations ship without Chromium;
run `campaigns-os qa install-browser` once. If optional Playwright was omitted,
ordinary commands still work and browser commands explain the missing package.
When another install shadows the global binary, status prints an explicit
invocation of the inspected copy. In a campaign folder,
`npx --no-install campaigns-os` selects the project-local dependency ahead of
the global binary on PATH.

`tooling status` is the preflight for "am I current?". It names the install
mode and checks package identity, CLI entrypoint, and installed Campaigns OS
skills. It also reports local gateway login metadata across saved store bindings,
without a `--store` flag or a remote validity check. No credential values are
shown; unavailable storage is reported without guessing that the user is logged
out. See [gateway login](gateway-login.md).

- From a campaign folder it reports `Install mode: package install
  (node_modules), pinned at <version> @ <sha>`; git freshness is
  `not_applicable` because the pinned commit is the freshness answer, and
  there is no npm dist-tag to compare against. An npm release reports its version even when a source commit is not derivable.
  Commands are spelled `npx --no-install campaigns-os <command>`; if a
  different install of the toolkit is on PATH, it says so and points you back
  to `npx`.
- From a git checkout it reports `Install mode: git checkout at <path>` plus
  branch, upstream, ahead/behind, and whether the tree is dirty.

Exit code 2 from `tooling status` means attention is required — on a fresh
profile that is the not-yet-installed skills — and the output prints the exact
refresh command for the mode you ran it in. Pass the same `--platform` to
status that you install skills for; without it, status checks every agent
profile and stays at exit 2 until each is installed.

Everything the toolkit prints for you to run (`next`, gate remediations, the
browser-missing hints) is spelled for the install it came from: `npx
--no-install campaigns-os …` from a campaign folder (releases before 1.41.2
print it without `--no-install`; add the flag when you copy one), bare
`campaigns-os …` from a global installation whose binary matches PATH, and the
documented checkout translation below.

## Contributor / local checkout

To change the toolkit, run `npm run check`, or work against an unpushed commit,
use a checkout:

```bash
git clone https://github.com/NextCommerceCo/campaigns-os.git
cd campaigns-os
npm install
npm run campaigns-os -- --help
npm run campaigns-os -- tooling status
```

Every `npm run campaigns-os -- <command>` example in this repository is the
checkout form. From a campaign folder the same command is `npx --no-install
campaigns-os <command>`; the arguments are identical. `npm run
qa:install-browser`, a checkout script, is `npx --no-install campaigns-os qa
install-browser` from a campaign folder (`npx playwright install chromium` is
equivalent only when it resolves to the toolkit's own Playwright; prefer
`qa install-browser` on pins that have it). A fresh `git pull`
does not refresh copied agent skills in either mode; `tooling status` tells
you when they are stale.

## Install Skills

After installing or updating the CLI, refresh the Campaigns OS skills in Claude Code:

```bash
npx --no-install campaigns-os install-skills --platform claude
```

This syncs bundled `skills/*` directories from the installed package into `~/.claude/skills/<skill-name>/` (`--platform codex` writes `~/.codex/skills`), replacing same-name folders, and reports which skills were created, updated, or unchanged. Restart the agent afterwards. Preview changes without writing files:

```bash
npx --no-install campaigns-os install-skills --dry-run
```

Use `--platform` for other local agent profiles:

```bash
npx --no-install campaigns-os install-skills --platform codex
npx --no-install campaigns-os install-skills --platform agents
npx --no-install campaigns-os install-skills --platform all --dry-run
```

If `tooling status` reports stale skills, run the refresh command it prints —
it names each stale platform, through the same prefix — and restart local
agent sessions so the new instructions are loaded. The build after `start` is
agent-driven — `next` names the skill for each stage — so install skills before
the first `start`.

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

The Store Profile is campaign metadata entered by the operator or derived from the store with `spec derive --from-store` (see "Create The Packet" below), not Campaigns API data. Before the target is scaffolded, `doctor` requires only `campaign.store_url`; `store_name`, `store_terms`, `store_privacy`, `store_contact`, `store_returns`, `store_shipping`, `store_phone`, and `store_phone_tel` are optional storefront/legal metadata used by templates when present. Once the target's `campaigns.json` entry exists, `page_kit.store_profile` checks every one of those fields the CampaignSpec provides against the target: a field the spec carries that the target lacks, or carries with a different value, blocks (the spec is the authority; run `npx --no-install campaigns-os page-kit sync --packet <campaign-runtime.build.json>` to write the spec's values into the target entry, or fix the spec, then re-run `doctor`), a field present only in the target warns as `target_only` — unless the value is starter demo residue (a placeholder storefront URL or phone number), which blocks as `demo_residue` whatever the spec says — and a field absent from both is clean. So a spec that fills all nine fields makes all nine required after scaffold. A discrepancy the spec cannot yet resolve can be recorded with `campaigns-os checkpoint waive --packet <campaign-runtime.build.json> --gate page_kit.store_profile --reason "<why>" --waived-by "<named human>" --review-condition "<trigger>"` (or `--expires-at <ISO timestamp>` instead of the review condition; see [docs/build-packet.md](./build-packet.md), "Page Kit Store Profile checkpoint").

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
> - `npx --no-install campaigns-os telemetry off` — machine-level, sticks.
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
mkdir -p source
npx --no-install campaigns-os start --map-id <map-id> --target . --source ./source --template-family <family>
```

`--map-id <id>` starts from a map saved in Campaign Map Builder (add
`--proxy-base <origin>` when the map was saved on a non-production map store);
`--spec <campaignspec.json>` starts from a locally exported CampaignSpec
instead. One of the two is required. `--target .` is the campaign folder, the
page-kit project that pins the toolkit; with `--spec` it must already be a
directory (`Target repo is not a directory` otherwise). `--source` is always
required: the folder of prepared HTML/CSS/assets for the pages you are
building, with a source manifest carrying desktop and mobile screenshot proof
for each designed page — see [Design Source Package](./design-source-package.md).
It must exist even when every page is template stock; those pages are declared
out of source scope (manifest `skip_reason`, or CampaignSpec
`build_scope.mode: "partial"`), never left out of `--source`.

`start` creates the packet, context, report, doctor output, and target-repo agent context. It does not edit campaign pages, deploy, run QA, or place test orders.

`start` finishes by running doctor, and on a fresh target doctor's first verdict
is normally `BLOCKED` with a list of what to supply — missing screenshot proof,
demo values to replace, a scaffold to run. That list is the intake checklist,
not a failed install; work through it and re-run. The demo values are the
store profile and SDK pin `campaign-init` seeded into `_data/campaigns.json`
after a fresh scaffold; doctor's required actions print the command that
replaces them from the CampaignSpec — `npx --no-install campaigns-os page-kit
sync --packet campaign-runtime.build.json` (`--dry-run` to see the diff first)
— and after it `page_kit.store_profile` and `page_kit.sdk_version` pass without a waiver.

The other direction exists too. Once the campaign is configured, the repo is
the authority for the SDK pin, the page routes and the analytics ids, and
`npx --no-install campaigns-os spec derive --packet campaign-runtime.build.json` writes
those into the local CampaignSpec with a field-by-field diff (`--dry-run`
first). After a bump in `_data/campaigns.json`, that is the one command that
brings the spec back in line; doctor's `page_kit.sdk_version.repo_newer`
warning names it. Add `--write-map` and the pin is also recorded in the saved
Map's Build hints field, so the Map and its next export stop reading stale.
The store profile (`campaign.store_*`) comes from the store
itself: the 1.38.0 candidate uses gateway login for `--from-store <subdomain>`
within the admitted owned-store private pilot. Existing direct callers must add
`--store-token-source env:<VAR>` explicitly; there is no implicit environment
fallback. See [gateway login and migration](gateway-login.md). A successful read
writes the available store name,
primary domain, phone and policy-page URLs into the spec too, for `page-kit
sync` to carry into the repo.

It also runs brand-theme discovery in inspect-only mode. When source tokens are
available, the build context records `context.theme` and the target repo gets
`.campaign-runtime/theme/theme-report.json`. It does not write
`brand-theme.css` by default.

To inspect or generate the optional commerce-page brand bridge:

```bash
npx --no-install campaigns-os theme inspect --packet ./campaign-runtime.build.json --json
npx --no-install campaigns-os theme generate --packet ./campaign-runtime.build.json --json
```

Use `--theme-policy auto` on `start` / `prepare-build` only when you want
Campaigns OS to write `brand-theme.css` automatically from high-confidence
source tokens. Generated CSS is root-variable-only and must be loaded after
`next-core.css` on checkout, upsell, downsell, and receipt pages.

## Continue In Your AI Tool

Run `next` after `start` and after every stage, and do what it prints — the
commands are already spelled for this install:

```bash
npx --no-install campaigns-os next --packet ./campaign-runtime.build.json --json
```

When it names the setup stage, that is:

```bash
npx --no-install campaigns-os next setup --packet ./campaign-runtime.build.json
```

If doctor says setup is not required, run:

```bash
npx --no-install campaigns-os next build --packet ./campaign-runtime.build.json
```

Paste the generated handoff into your AI tool. From here the build is
agent-driven: each `next` names the Campaigns OS skill for the stage
(`next-campaigns-os-setup`, `next-campaigns-build`, `next-campaigns-polish`,
`next-campaigns-qa`) and the exact commands, which is why the skills are
installed before the first `start`.

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
- preview deploy, or a local serve of the built `_site/` output with the packet's
  `deploy.target` set to `local-serve` (`qa policy set --deploy-target local-serve
  --preview-url http://localhost:<port>/<slug>/`); localhost on any port is a
  Development domain, so no SDK origin allowlist entry is needed there
- Node/npm QA with Map ID and preview URL
- typed-card test-order proof via `--test-order common` (global test cards bypass the gateway; no permission/approval needed — depth is the only control)

```bash
npx --no-install campaigns-os qa install-browser
npx --no-install campaigns-os polish capture --packet ./campaign-runtime.build.json --base-url <served-current-build-url>
npx --no-install campaigns-os qa resolve --packet ./campaign-runtime.build.json
npx --no-install campaigns-os qa run --packet ./campaign-runtime.build.json --base-url https://preview.example.com/campaign/ --browser --test-order common
```

`npx --no-install campaigns-os qa install-browser` (`npm run qa:install-browser` from a checkout; `npx playwright install chromium` only when it resolves to the toolkit's Playwright)
is a one-time local setup step after install/update. It installs the Chromium
binary used by package-owned polish capture and QA.
Run it before `polish capture`, `--browser`, or `--test-order`; the CLI will tell
you to run it if the browser binary is missing. The capture producer must point
at the served current build and complete before Polish hands off to deploy/QA.

After the browser is installed, `npm run smoke:polish-capture` is an optional
real-Chromium package smoke. It needs permission to open a loopback HTTP
listener and is deliberately excluded from `npm run check` and CI.
