# Campaigns OS

Campaigns OS is the developer toolkit for agent-assisted campaign builds on [Next Commerce](https://nextcommerce.com), a full-stack ecommerce platform for direct-response brands. A *campaign* is a short, conversion-focused funnel — landing page, checkout, optional upsells/downsells, receipt — wired to live products, price tiers, shipping, and payments.

This toolkit gives campaign developers and AI coding tools a clear path for assembling one from prepared page files:

1. Configure the campaign in the Next Commerce dashboard (Campaigns App).
2. Use the current saved Map in [Campaign Map Builder](https://campaign-map.nextcommerce.com), or have the coding agent author a [local CampaignSpec](docs/build-packet.md#local-spec-entry) from the brief and verified campaign values.
3. Keep the CampaignSpec JSON with its saved Map ID or stable `local_spec_id`, plus its public route slug.
4. Bring prepared HTML/CSS/assets for the campaign pages.
5. Provide or generate a [Campaign Build Brief](./docs/campaign-build-brief.md) for merchandising/design presentation decisions.
6. Create and doctor a Build Packet.
7. Hand off to `next-campaigns-build`.
8. Run build/lint and record the build with `campaigns-os record build`, then install the Campaigns OS Playwright browser once with `campaigns-os qa install-browser`.
9. Run `next-campaigns-polish`, serve the current build, run the mandatory `campaigns-os polish capture` producer, then record Polish with `campaigns-os record polish --evidence <file>`.
10. Deploy a preview. For a local preview (`--deploy-target local-serve`), serve the current build and record it with `campaigns-os record deploy --base-url <loopback route root>`; a later `record build` of different output makes the deploy owed again. `record deploy` takes only a loopback route root; for a hosted preview, deploy through your host and follow `next` for what to record.
11. Run `next-campaigns-qa` against the tested URL.
12. Record launch blockers and follow-up work.

The toolkit is contract-backed: starter templates describe which parts are reusable page structure, which parts are live commerce wiring, and which demo values must be replaced for a real campaign. That helps AI tools avoid common mistakes like carrying over sample package IDs, copying shipping options from the wrong template shape, or editing SDK-owned checkout surfaces as plain HTML.

See [activation, access, and evidence](docs/activation-and-evidence.md) for what
installation, a saved Map, preview observation, and recorded QA each establish.

## Quick Start

You do not need to clone this repository to use it. The toolkit is pinned as a
devDependency of the campaign folder (a page-kit project) and runs through
`npx --no-install campaigns-os …` from that folder — the pin is committed in
`package.json` and the lockfile, so CI and the deploy host install the same
package bytes. Keep `--no-install`: `campaigns-os` is only the bin name of
`@nextcommerce/campaigns-os`, so in a folder without the pinned copy a plain
`npx campaigns-os` looks that name up on the registry and, with no terminal to
ask, installs what it finds; with the flag, npx stops with an error instead.
Requirements: Node `>=20.19.0` and npm 10 or 11 (Node 22 ships npm 10). Three
steps, in this order:

1. **Orient before you run anything.** Read
   [`AGENTS.md`](AGENTS.md), `contracts/supported-surface.json`,
   `contracts/release-ledger.json` and `CHANGELOG.md` on GitHub at one commit,
   using the canonical reading order in `AGENTS.md`, and keep that commit's sha. Orientation is a read of declarative data; it
   never executes toolkit code.
2. **Pin the reviewed release and install its agent skills.** Check the release tag/provenance against the reviewed source commit.
3. **Start a real campaign build** from that installation.

```bash
mkdir "<route>" && cd "<route>"
npm init -y && npm i --save-exact next-campaign-page-kit
npx campaign-init --non-interactive --template <family> --slug "<route>" --name "<campaign name>"
npm install --save-dev --save-exact @nextcommerce/campaigns-os@<version>
npx --no-install campaigns-os tooling status --platform claude
npx --no-install campaigns-os install-skills --platform claude
mkdir -p source
```

With Claude Code, [local setup](docs/local-setup.md) replaces the last two
lines with one: `npx --no-install campaigns-os tooling setup --target .
--platform claude` installs the QA browser, the skills and the project
context, and keeps existing pages and instructions. It does not scaffold
pages; the agent chooses the template at intake. Codex, Cursor and other
agents keep the separate steps: `install-skills --platform codex` (or
`--platform agents`), `install-agent-context --target .` and
`qa install-browser`.

The toolkit is also published to npm as `@nextcommerce/campaigns-os`, so the
CLI can be installed once, globally, instead of pinned per campaign:

```bash
npm install -g @nextcommerce/campaigns-os@<version>
campaigns-os tooling status --platform claude
campaigns-os install-skills --platform claude
```

A global install ships without a browser. Polish capture and QA need the
Playwright Chromium: run `campaigns-os qa install-browser` once. Playwright
itself is an optional dependency, installed by default; an install that
omitted it (`--omit=optional`) is told exactly that by the commands that need
it, and every other command runs without it.
Releases are cut by pushing a `v<version>` tag that matches `package.json`
and `surface_version` on a commit on `main`; `.github/workflows/publish.yml`
runs the full check in an unprivileged job and publishes the verified tarball
with provenance from a second, environment-gated job.

For an existing page-kit campaign, skip the first three lines and `cd` into it
(its `package.json` already declares `next-campaign-page-kit`). `<version>` is
the exact release you reviewed. The newest published release is npm's `latest`
(`npm view @nextcommerce/campaigns-os version`), and
`contracts/release-ledger.json` and `CHANGELOG.md` list every release. Pin the
exact version, never a floating dist-tag, for a reproducible build. Commit `package.json` and `package-lock.json`.
`tooling diagnose` requires 1.35.0 or later and `demo` requires 1.37.0 or later.
A Git source pin remains supported when using an unreleased reviewed commit:
`npm install --save-dev --save-exact "github:NextCommerceCo/campaigns-os#<full-sha>"`.

For a visual sample, run
`npx --no-install campaigns-os demo --target ./apollo-sample` (1.37.0 or later).
It copies four inert Apollo pages; open the printed
`landing/index.html` directly. It downloads nothing and creates no campaign
evidence. Keep sample edits and start a real campaign in a separate new Page Kit
folder. See [offline sample preview](docs/demo-preview.md).
The lockfile records the resolved source and integrity; `tooling status` reports
install mode, package version, and a source commit when derivable. It does not
check registry currency or establish trust. On a fresh profile, preflight exits
2 with `ATTENTION_REQUIRED` until that profile's skills are installed. Run
`tooling status --platform claude` again after `install-skills` for `READY`;
use `--platform codex` for a Codex-only profile. Without `--platform`, status
checks every supported agent profile.
`install-skills` writes `~/.claude/skills` (`--platform codex` writes
`~/.codex/skills`), replacing same-name folders, and lists each `SKILL.md` it
wrote under `Read now`. A running agent does not load skills installed after it
started, so read those files now in the same session; a new session loads them
on its own.
Run commands from the campaign folder: `npx` selects its local installation
even when another global copy is on PATH. A global-only installation prints
bare commands when its binary matches PATH, or an explicit `node` invocation
when another install shadows it.
Prepared page HTML goes in `./source`, which must exist even when every page is
template stock. To update, review the new release source and install its exact version again.

> **Heads up — `start` turns on run telemetry, and remit is ON by default.**
> The first `start` opens a run session in the target folder and, unless you
> opt out, the session's Run Record is remitted to the Campaigns telemetry
> endpoint with the packet's Campaigns API key. Opt out with
> `npx --no-install campaigns-os telemetry off`, `CAMPAIGNS_OS_TELEMETRY=off`, or
> `--no-remit` on the remitting command; capture stays local either way. The
> full note — endpoint, payload, what `off` changes, and `--no-run-session` —
> is in [docs/quickstart.md](docs/quickstart.md) above the first `start`; the
> contract is [Run Telemetry](docs/workflow-findings-sidecar.md).

```bash
npx --no-install campaigns-os start --map-id <map-id> --target . --source ./source --template-family <family>
npx --no-install campaigns-os next --packet ./campaign-runtime.build.json --json
```

`--map-id <id>` starts from a map saved in Campaign Map Builder (add
`--proxy-base <origin>` when the map was saved on a non-production map store);
`--spec <campaignspec.json>` starts from a local export or an agent-authored
[local spec](docs/build-packet.md#local-spec-entry) instead. Local-spec identity
requires a reviewed 1.43.0-or-later release. To prove the campaign on
localhost before a preview deploy, add `--deploy-target local-serve` (and
`--preview-url http://localhost:<port>/`); `qa policy set --deploy-target <target>`
changes it later. `--source` is
always required: the folder of prepared HTML/CSS/assets for the pages you are
building, with a source manifest that carries desktop and mobile screenshot
proof for each designed page
([Design Source Package](docs/design-source-package.md)). Pages that use the
starter family's own design are declared, not omitted — see the template-stock
note below.

`start` ends by running doctor, and doctor's first verdict on a fresh target is
normally `BLOCKED` with a list of what to supply — missing screenshot proof,
demo values to replace, a scaffold to run. That list is the intake checklist,
not a failed install. The demo values are the store profile and SDK pin
`campaign-init` seeded into `_data/campaigns.json`; doctor prints the one
command that replaces them from the CampaignSpec, `npx --no-install
campaigns-os page-kit sync --packet campaign-runtime.build.json`, and after it
both page-kit gates pass. The reverse write exists for a configured campaign:
`npx --no-install campaigns-os spec derive --packet
campaign-runtime.build.json` copies what the repo already
states (the SDK pin, page routes, analytics ids) into the local CampaignSpec,
and with `--write-map` records the pin in the saved Map's Build hints too, so
a bump in the repo is one edit followed by a derive rather than a hand edit
in two tools; with `--from-store <subdomain>` and the store's Admin API read
token in the environment it derives the store profile from the store as well.
Map write-back stays explicit and pin-only.

For changes after handoff, follow the
[spec review procedure](docs/build-packet.md#changing-a-campaign-after-handoff):
apply the PM's authored changes to the current repository spec, preserve derived
fields, and resolve competing edits before the next build.

Everything after `start` is agent-driven: after `start`
and after every stage, run `next` and do what it prints — it names the skill
and the exact commands for the next stage, already spelled `npx --no-install
campaigns-os …` for this install, which is why `install-skills` comes first.
Releases before 1.41.2 print the same commands without `--no-install`; add it
when you copy one. The browser for polish capture and QA is a one-time
`npx --no-install campaigns-os qa install-browser`, which installs the browser
for the Playwright this toolkit bundles. A pin older than that command shows
`npx playwright install chromium` instead; that is equivalent only when `npx playwright` resolves to the toolkit's Playwright
(a campaign that depends on its own Playwright version gets that one's
browser instead), so prefer `qa install-browser` on pins that have it.

### Other ways to run it

The pinned devDependency above is the primary path. To change the toolkit, use
a checkout ([docs/quickstart.md](docs/quickstart.md)): every `npm run
campaigns-os -- <command> …` example in this repository is that checkout form,
and from a campaign folder the same command is
`npx --no-install campaigns-os <command> …` with identical arguments (`npm run
qa:install-browser` is the checkout's `qa install-browser`).

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
no design source for them, and leaves them unbuilt unless the operator opts in
per page to materializing the locked family's stock. A family that publishes Template Reference proof
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

Use `--require-qa` when the campaign claims QA is complete. `status: conformant`
means the sidecars agree with each other and the contract; it says nothing about
whether doctor or QA passed. Read the warnings for that (a blocked doctor run
emits `bundle.doctor_output.blocked`, a blocked QA verdict
`bundle.qa_verdict.blocked`). See
[Migration sidecar bundle v0](docs/migration-sidecar-bundle.md).

Then ask your AI tool to continue from the emitted handoff. Fresh target repos usually start with `next-campaigns-os-setup`; existing campaign directories can move directly to `next-campaigns-build`.

## Source Files

The current source adapter is `html_funnel`: bring prepared HTML/CSS/assets for the campaign pages, plus a CampaignSpec exported from Campaign Map Builder or authored by the coding agent through the [local-spec entry](docs/build-packet.md#local-spec-entry).

Standalone HTML mockups: keep them whole and set
`wrapper_policy: preserve_document_wrappers` in the source-html manifest at
`<source>/.campaigns-os/source-html-manifest.json` (or pass
`--wrapper-policy preserve_document_wrappers` to `start`). Source screenshot
proof must be of the standalone document, so a page kept whole needs no
conversion; doctor reports its document wrappers as a warning that names the
decision. For pages without a Figma `design_source`, no exporter is required:
a hand-written manifest is enough (when any active page's `design_source` is
Figma, the manifest must pass the Figma provenance gate, which needs the
exporter's handoff manifest), for example
`{"schema_version": "source-html-manifest/v0", "wrapper_policy": "preserve_document_wrappers", "pages": [{"page_id": "landing", "path": "landing.html"}]}`
(schema: `schemas/source-html-manifest.v0.schema.json`; see
[Selecting the wrapper policy at intake](docs/source-adapters.md#selecting-the-wrapper-policy-at-intake)).

Otherwise, for raw AI-generated or exported static HTML, "prepared" means
page-kit-ready source, not a browser document dropped in unchanged and not a
wholesale Liquid rewrite. Page Kit source is HTML with YAML frontmatter and
optional Liquid helpers. Convert standalone HTML into the target page format
first: remove outer
`<html>`, `<head>`, and `<body>` wrappers, add page frontmatter, move shared
CSS/assets into the campaign asset tree when useful, root links/assets with
`campaign_link` and `campaign_asset` when needed, and keep landing/presell
design markup separate from SDK-owned commerce controls.

## Important Commands

Before an SDK bump, scan explicitly scoped tracked merchant HTML/JS with [SDK storage compatibility](docs/sdk-storage-compatibility.md). The SDK-generated manifest is supplied separately; a clean result covers static source compatibility only.

```bash
npm run campaigns-os -- tooling status
npm run campaigns-os -- tooling setup --target <page-kit-repo> --platform claude --dry-run --json
npm run campaigns-os -- install-skills --dry-run
npm run campaigns-os -- install-skills --platform codex --dry-run
npm run campaigns-os -- install-agent-context --target <page-kit-repo> --dry-run
npm run campaigns-os -- qa install-browser
npm run skills -- status
npm run campaigns-os -- prepare-build --spec <spec.json> --source <html-dir> --target <page-kit-repo> --template-family <family> --brief <campaign-build-brief.yaml>
npm run campaigns-os -- doctor --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- page-kit sync --packet <page-kit-repo>/campaign-runtime.build.json --dry-run
npm run campaigns-os -- checkpoint waive --packet <packet.json> --gate source_html.producer_provenance --page <page_id> --reason "<why>" --waived-by "<named human>" --review-condition "<trigger>" --dry-run
npm run campaigns-os -- sdk storage-check --target <campaign-git-root> --target-sdk <x.y.z> --manifest <sdk-storage-manifest.json> --scope <campaign,shared> --json
npm run campaigns-os -- sdk repin --target <static-campaign-repo> --target-sdk <x.y.z>
npm run campaigns-os -- standardize --target <page-kit-repo-or-cpk-repo> --json
npm run campaigns-os -- theme inspect --packet <page-kit-repo>/campaign-runtime.build.json --json
npm run campaigns-os -- theme generate --packet <page-kit-repo>/campaign-runtime.build.json --json
npm run campaigns-os -- next setup --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- next build --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- record setup --packet <page-kit-repo>/campaign-runtime.build.json
npm run campaigns-os -- record build --packet <page-kit-repo>/campaign-runtime.build.json
npm run qa:install-browser
npm run campaigns-os -- next polish --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- polish capture --packet <packet.json> --base-url <served-current-build-url>
npm run campaigns-os -- record polish --packet <packet.json> --evidence <polish-evidence.json>
npm run campaigns-os -- record theme --packet <packet.json>
npm run campaigns-os -- record deploy --packet <packet.json> --base-url <loopback-route-root>
npm run campaigns-os -- record brief --packet <packet.json> --brief <campaign-build-brief.yaml>
npm run campaigns-os -- record spec --packet <packet.json>
npm run campaigns-os -- next qa --packet <packet.json> --report <assembly-report.json>
npm run campaigns-os -- qa resolve --packet <packet.json>
npm run campaigns-os -- qa run --packet <packet.json> --base-url <preview-url> --browser --test-order common
npm run smoke:polish-capture
npm run campaigns-os -- findings add --stage overall --kind positive_signal --summary "..."
npm run campaigns-os -- findings harvest --packet <packet.json>
npm run campaigns-os -- findings export --summary
```

Doctor inspects without changing the retained Assembly Report or doctor sidecar.
A stale local `_site` still fails the current inspection; it does not rewrite
the proof of an earlier delivered build. Use `doctor --packet <packet> --write`
only when deliberately recording a new doctor stage. `--no-write` overrides
`--write`. A custom `--doctor-out <path>` also requires `--write`; naming an
output path alone does not create or refresh the file. Build/QA producer
commands continue to record their own stages.

Record a stage's completion with `record setup`, `record build` (after every
rebuild), `record polish --evidence <file>`, `record theme` (once the brand layer
is linked) and, for a local preview, `record deploy --base-url <loopback route
root>`, rather than hand-editing `.campaign-runtime/build-context.json` or
`.campaign-runtime/assembly-report.json`. A recorded deploy is bound to the
build it probed, so a later `record build` of different output makes it owed
again. When the brief or the CampaignSpec changes after stages are recorded, save
it with `record brief` or `record spec`: an unchanged or reformatted save keeps
every stage, a material change moves the superseded build, Polish and QA records
to stage history instead of discarding them, and `next` names the stage that is
owed again. Re-running
`start` or `prepare-build` over recorded stages is refused without `--force`.
Each `record` command validates what it would write, refuses a stage `next` has
not reached, and writes nothing on failure; `--dry-run` runs the checks without
writing. See
[Build Packet](docs/build-packet.md) and [Polish evidence](docs/polish-evidence.md).

Do not use `prepare-build --force` merely to refresh a catalog path: doctor
already resolves the running toolkit's catalog, and `--force` resets the recorded stages (completed build, Polish and QA records move to stage history).


`qa run` automatically checks contract-governed authored price, recurring
cadence, and voucher claims against fresh `/api/price-preview` results for
commercial pages. It needs no private repo import or extra catalog flag; proven
mismatches are warn-severity pricing assertions in the normal verdict.

Run `tooling status` before a build session. It names the install mode — a
pinned package (`npx`, or a consumer's `node_modules`) or a git checkout — and
checks that the package metadata, CLI entrypoint, and installed Campaigns OS
skills agree. For a checkout it also reports branch, upstream, and ahead/behind;
for a package install the pinned version is the freshness answer, and the
status does not compare it with npm's `latest` dist-tag. Neither mode makes agent skills current on
its own: when skills are stale, run the refresh command the status output
prints (it names each stale platform, through the same prefix you ran
`tooling status` with), then read the `SKILL.md` files it lists under `Read now`
in the running session (new sessions load them on their own). Without `--platform`,
status checks only the platforms where Campaigns OS skills are installed.

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
them on `engines.node` (>=20.19.0) with no type-stripping or build step of their own.
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
- [Run-Artifact Readback](docs/readback.md) — `campaigns-os readback`: a read-only projection of one run's emitted artifacts, with per-artifact freshness against the checkout and a versioned JSON contract to gate on
- [Declared Command Effects](docs/effects.md) — what every supported invocation writes and sends, one row per command and effect-changing flag, each row proved by a test that runs the real CLI in a disposable target
- [Legacy Migration Contract](docs/legacy-migration.md) — pure inventory, preview-plan, receipt, Offer request/readback, and token-free evidence helpers for bounded SDK 0.3.x shadow migrations
- [Template Family vs Figma-extraction vs Hybrid](docs/template-vs-extraction-decision.md) — when to mint a template family, when to extract a bespoke design, and when to do both
- [Small PR Review Path](docs/small-pr-review-path.md)
- [Run Telemetry](docs/workflow-findings-sidecar.md) — per-run Run Record (system signal + workflow findings) tagged by improvement surface; captured locally always, remitted to Next Commerce only with up-front opt-out consent
- [Versioning](docs/versioning.md)
- [ADR 0002: One shipping path](docs/adr/0002-one-shipping-path-campaigns-agent-fold.md) — decides that the agent surface (skills, charter, declared effects, readback) lives in this repository; Campaigns Agent folds in

## Status

Developer preview. Build output still needs the normal proof gates: build/lint evidence, polish plus package-owned page-load capture against the served current build, preview deploy or local dev URL, Playwright browser QA, and typed-card test-order proof via `--test-order common`. Global test cards bypass the gateway and create no transactions, but each test order leaves a real store order record. Unless the operator has already said test orders are fine for this campaign, ask once, up front, before placing test orders; then proceed. There is no permission flag. Localhost on any port is a Campaigns App Development domain, so SDK calls are allowed and analytics are suppressed there; non-localhost preview/production origins still need SDK origin allowlist confirmation.

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
