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
8. Run build/lint, then install the Campaigns OS Playwright browser once with `campaigns-os qa install-browser`.
9. Run `next-campaigns-polish`, serve the current build, and run the mandatory `campaigns-os polish capture` producer before marking Polish complete.
10. Deploy a preview.
11. Run `next-campaigns-qa` against the tested URL.
12. Record launch blockers and follow-up work.

The toolkit is contract-backed: starter templates describe which parts are reusable page structure, which parts are live commerce wiring, and which demo values must be replaced for a real campaign. That helps AI tools avoid common mistakes like carrying over sample package IDs, copying shipping options from the wrong template shape, or editing SDK-owned checkout surfaces as plain HTML.

## Quick Start

You do not need to clone this repository to use it. Requirements: Node
`>=20.19.0` and npm 10 or 11 (Node 22 ships npm 10). Three steps, in this
order:

1. **Orient before you run anything.** Read
   [`AGENTS.md`](AGENTS.md), `contracts/supported-surface.json`,
   `contracts/release-ledger.json` and `CHANGELOG.md` on GitHub at one commit,
   and keep that commit's sha. Orientation is a read of declarative data; it
   never executes toolkit code.
2. **Install the toolkit and its agent skills** from that same commit.
3. **Start a build** from that same commit.

```bash
PIN="<sha>"
TOOLKIT="$HOME/campaigns-os-toolkit/$PIN"
mkdir -p "$TOOLKIT"
npm install --prefix "$TOOLKIT" "github:NextCommerceCo/campaigns-os#$PIN"
export PATH="$TOOLKIT/node_modules/.bin:$PATH"
campaigns-os tooling status
campaigns-os install-skills --platform all
```

Repeat the `PIN`, `TOOLKIT`, and `PATH` lines in each new shell, or add them
to your shell profile. `PIN` is the commit you oriented on, so the code that
runs is the code whose contracts you read; each pin gets its own folder, so
two pins never overwrite each other. npm records the resolved commit in that
folder's `package-lock.json`, which is how `tooling status` can print
`Install mode: package install (node_modules), pinned at <version> @ <sha>`.
On a fresh profile that first `tooling status` exits 2 with `ATTENTION_REQUIRED`
and one action, the `install-skills` line — it is telling you the skills are
not installed yet, not that the install failed; run it again after
`install-skills` for `READY`. The install runs the package's own build step
(about 10 s), and the `export PATH` line is what makes the bare `campaigns-os
…` commands that `next` prints resolve. The QA browser is a one-time `campaigns-os qa install-browser`, which uses
the Playwright bundled with this package. A pin older than this command shows
`playwright install chromium` instead; that is equivalent only from the toolkit
folder's PATH, where `playwright` resolves to the bundled copy. Restart your agent session after
`install-skills`.

> **Heads up — `start` turns on run telemetry, and remit is ON by default.**
> The first `start` opens a run session in the target folder and, unless you
> opt out, the session's Run Record is remitted to the Campaigns telemetry
> endpoint with the packet's Campaigns API key. Opt out with
> `campaigns-os telemetry off`, `CAMPAIGNS_OS_TELEMETRY=off`, or `--no-remit`
> on the remitting command; capture stays local either way. The full note —
> endpoint, payload, what `off` changes, and `--no-run-session` — is in
> [docs/quickstart.md](docs/quickstart.md) above the first `start`; the
> contract is [Run Telemetry](docs/workflow-findings-sidecar.md).

```bash
# Start from a saved Campaign Map Builder map (or --spec <campaignspec.json> for a local export).
mkdir -p <campaign-folder>
campaigns-os start \
  --map-id <your-map-id> \
  --target <campaign-folder> \
  --source <your-page-html> \
  --template-family olympus
```

`--source` is always required: the folder of prepared HTML/CSS/assets for the
pages you are building, with a source manifest that carries desktop and mobile
screenshot proof for each designed page
([Design Source Package](docs/design-source-package.md)). Pages that use the
starter family's own design are declared, not omitted — see the template-stock
note below. `--target` must be a directory; with `--spec` a missing one is
refused (`Target repo is not a directory`), so the `mkdir -p` above is not
optional there.

`start` ends by running doctor, and doctor's first verdict on a fresh target is
normally `BLOCKED` with a list of what to supply — missing screenshot proof,
demo values to replace, a scaffold to run. That list is the intake checklist,
not a failed install. Everything after `start` is agent-driven: `campaigns-os
next --packet <campaign-folder>/campaign-runtime.build.json` names the skill
and the exact commands for the next stage, which is why `install-skills` comes
first.

### Other ways to run it

The toolkit folder above is the primary path. For one command without
installing anything, `npx --yes --package=github:NextCommerceCo/campaigns-os#<sha>
campaigns-os <command> …` runs the same pinned commit (the commands `next`
prints then need that prefix); to change the toolkit, use a checkout —
[docs/quickstart.md](docs/quickstart.md) covers both, with the npm 10/11
caveats. Every `npm run campaigns-os -- <command> …` example in this
repository is the checkout form; from the toolkit folder the same command is
`campaigns-os <command> …` with identical arguments.

From a checkout, the same first run uses the bundled example inputs:

```bash
npm install
npm run campaigns-os -- tooling status
npm run campaigns-os -- start \
  --spec examples/campaignspec.v42.basic.json \
  --source examples/source-html \
  --target examples/target-page-kit \
  --template-family olympus
```

If that first run stops at intake with `DESIGN_SOURCE_PACKAGE_NOT_READY`, the
source material arrived without desktop/mobile screenshot proof. Supply it
through `pages[].screenshots[]` in
`<source-root>/.campaigns-os/source-html-manifest.json` — or in a manifest
outside the source root named with `--design-manifest <path>`, when the source
tree is not yours to write — and follow
[Clearing `DESIGN_SOURCE_PACKAGE_NOT_READY`](docs/design-source-package.md#clearing-design_source_package_not_ready),
which also gives the recovery sequence for the package a blocked run left behind.

That path assumes the pages carry a standalone design of the merchant's. If they
are template stock instead — no bespoke design, the starter family *is* the
design — there is no screenshot to honestly supply. Declare those pages out of
source scope (a manifest `skip_reason` entry, or CampaignSpec
`build_scope.mode: "partial"`): intake records them as template stock, demands
no design source for them, and the build stage materialises each from the
locked family's own page. A family that publishes Template Reference proof
(today `apollo`) covers them with `template_baseline`; every other family
records an accepted Source Gap and intake lands at `ready_with_gaps`. See
[Template-stock pages: the family decides](docs/design-source-package.md#template-stock-pages-the-family-decides).

The command writes these target-repo artifacts:

- `campaign-runtime.build.json`
- `.campaign-runtime/build-context.json`
- `.campaign-runtime/assembly-report.json`
- `.campaign-runtime/doctor-output.json`
- `.campaign-runtime/qa-verdict.json` (after QA)
- `.campaign-runtime/agent-context/*`

Validate the standardized CI/readback set with:

```bash
npm run campaigns-os -- bundle check --packet <page-kit-repo>/campaign-runtime.build.json --json
```

Use `--require-qa` when the campaign claims QA is complete. See
[Migration sidecar bundle v0](docs/migration-sidecar-bundle.md).

Then ask your AI tool to continue from the emitted handoff. Fresh target repos usually start with `next-campaigns-os-setup`; existing campaign directories can move directly to `next-campaigns-build`.

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
npm run campaigns-os -- qa install-browser
npm run skills -- status
npm run campaigns-os -- prepare-build --spec <spec.json> --source <html-dir> --target <page-kit-repo> --template-family <family> --brief <campaign-build-brief.yaml>
npm run campaigns-os -- doctor --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- standardize --target <page-kit-repo-or-cpk-repo> --json
npm run campaigns-os -- theme inspect --packet <page-kit-repo>/campaign-runtime.build.json --json
npm run campaigns-os -- theme generate --packet <page-kit-repo>/campaign-runtime.build.json --json
npm run campaigns-os -- next setup --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next build --packet <page-kit-repo>/campaign-runtime.build.json
npm run qa:install-browser
npm run campaigns-os -- next polish --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- polish capture --packet <packet.json> --base-url <served-current-build-url>
npm run campaigns-os -- next qa --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- qa resolve --packet <packet.json>
npm run campaigns-os -- qa run --packet <packet.json> --base-url <preview-url> --browser --test-order common
npm run smoke:polish-capture
npm run campaigns-os -- findings add --stage overall --kind positive_signal --summary "..."
npm run campaigns-os -- findings harvest --packet <packet.json>
npm run campaigns-os -- findings export --summary
```

`qa run` automatically checks contract-governed authored price, recurring
cadence, and voucher claims against fresh `/api/price-preview` results for
commercial pages. It needs no private repo import or extra catalog flag; proven
mismatches are warn-severity pricing assertions in the normal verdict.

Run `tooling status` before a build session. It names the install mode — a
pinned package (`npx`, or a consumer's `node_modules`) or a git checkout — and
checks that the package metadata, CLI entrypoint, and installed Campaigns OS
skills agree. For a checkout it also reports branch, upstream, and ahead/behind;
for a package install the pinned commit is the freshness answer, and there is
no npm dist-tag to compare against. Neither mode makes agent skills current on
its own: when skills are stale, run `install-skills --platform all` through the
same prefix you ran `tooling status` with (the status output prints the exact
command) and restart local agent sessions.

Run `campaigns-os qa install-browser` (`npm run qa:install-browser` from a
checkout) once after install/update and before mandatory `polish capture` or
any QA command that uses `--browser` or `--test-order`. It installs the Chromium
binary used by the package-owned Playwright flow;
Campaigns OS proof should not depend on external browser skills. `polish
capture` must run against the served current build before Polish becomes
terminal, deploy begins, or QA starts.

`npm run smoke:polish-capture` is an optional real-Chromium package smoke. It
requires the installed browser and permission to open a loopback HTTP listener;
it is intentionally excluded from `npm run check` and CI.

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
- [Supported Surface](docs/supported-surface.md) — what downstream consumers may depend on, and the gate that enforces it
- [Brand Theme Bridge](docs/brand-theme-bridge.md)
- [CampaignSpec Authoring Examples](docs/campaignspec-authoring-examples.md)
- [Campaigns OS Build Flow](docs/campaigns-os-build-flow.md)
- [Campaign Standardization Report](docs/campaign-standardization-report.md)
- [Entry Points](docs/entry-points.md) — five intake shapes (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and which producer / manifest each one ships with
- [Source Adapters](docs/source-adapters.md)
- [Setup Profile Parity](docs/setup-profile-parity.md)
- [Developer Evaluation](docs/developer-evaluation.md)
- [QA And Test Orders](docs/qa-and-test-orders.md)
- [Legacy Migration Contract](docs/legacy-migration.md) — pure inventory, preview-plan, receipt, Offer request/readback, and token-free evidence helpers for bounded SDK 0.3.x shadow migrations
- [Template Family vs Figma-extraction vs Hybrid](docs/template-vs-extraction-decision.md) — when to mint a template family, when to extract a bespoke design, and when to do both
- [Small PR Review Path](docs/small-pr-review-path.md)
- [Run Telemetry](docs/workflow-findings-sidecar.md) — per-run Run Record (system signal + workflow findings) tagged by improvement surface; captured locally always, remitted to Next Commerce only with up-front opt-out consent
- [Versioning](docs/versioning.md)

## Status

Developer preview. Build output still needs the normal proof gates: build/lint evidence, polish plus package-owned page-load capture against the served current build, preview deploy or local dev URL, Playwright browser QA, and typed-card test-order proof via `--test-order common` (global test cards bypass the gateway and create no transactions; no approval needed — depth is the only control). Localhost on any port is a Campaigns App Development domain, so SDK calls are allowed and analytics are suppressed there; non-localhost preview/production origins still need SDK origin allowlist confirmation.

Launch readiness is separate from Campaigns OS proof. Before real shoppers see a campaign, confirm the production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration.

## Review standards

Two rules reviewers apply to every patch, beyond the gates in
`npm run check`:

- **A guard test includes the failing case.** A test that passes against the
  unfixed code guards nothing, so assert the behaviour that was broken and check
  that it fails without the fix. Prefer assertions against the parsed module or
  its output — call the function, read the value — over matching substrings of
  source text, which passes on a comment and breaks on a rename.
- **A `catch` branches on the condition it claims to handle.** Test
  `error.code` (or whatever specific condition the comment justifies), handle
  that case, and journal or rethrow everything else. A bare `catch` that
  swallows every error turns a typo, a permission failure, and an expected
  absence into the same silent success.

## Issue tracking

Work in this repo is tracked with GitHub Issues and coordinated on the
org-level **[Operations](https://github.com/orgs/NextCommerceCo/projects/10)**
Kanban board (Todo / In Progress / Done). New issues are added to the board
automatically by the `add-to-project` workflow.

Before starting work on an issue: check it is not assigned to someone else,
assign yourself (`gh issue edit <n> --add-assignee @me`), and move the card to
In Progress. Open PRs with `Closes #<n>`; when the issue closes on merge, the board's built-in "Item closed" automation moves the card to Done.
Contributors have a `/next-board` skill that wraps these board operations
(status, claim, move, create).
