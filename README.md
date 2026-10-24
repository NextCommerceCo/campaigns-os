# Campaigns OS

Campaigns OS is the toolkit for building campaigns on [Next Commerce](https://nextcommerce.com) with an AI coding agent. A campaign is a short direct-response funnel (landing page, checkout, optional upsells and downsells, receipt) that sells live products at live prices with real shipping and payment methods. The toolkit takes the campaign's configuration, the prepared page files and a starter template, and walks the agent from intake to a QA'd preview, recording evidence at every stage so a reviewer can see what was built and how it was proved.

It is published to npm as `@nextcommerce/campaigns-os` and installed as an exact dev dependency of the campaign folder, which is a Campaign Page Kit project. Nothing is cloned, and every command runs as `npx --no-install campaigns-os …` from that folder.

## What a build looks like

1. **Configure the campaign** in the Campaigns App in the Next Commerce dashboard: create the campaign, add an Offer for each price tier (the products an Offer selects become the campaign's packages), set shipping and payment methods, and note the campaign's API key.
2. **Describe it as a CampaignSpec.** Export the saved Map from [Campaign Map Builder](https://campaign-map.nextcommerce.com), or have the agent author a [local CampaignSpec](docs/build-packet.md#local-spec-entry) from the brief and the verified campaign values. The spec carries the Map ID or a stable `local_spec_id`, plus the public route slug.
3. **Bring the page files.** Prepared HTML, CSS and assets for the pages you are building go in a `source/` folder with a source manifest and desktop and mobile screenshot proof for each designed page (the [Design Source Package](docs/design-source-package.md)). Pages that use the starter template's own design are declared as template stock rather than left out. A [Campaign Build Brief](docs/campaign-build-brief.md) records the merchandising and presentation decisions.
4. **Run `start`.** It writes the Build Packet and the run artifacts into the campaign folder and finishes with doctor. Doctor's first verdict on a fresh folder is normally `BLOCKED` with a list of what to supply. That list is the intake checklist, not a failed install.
5. **Follow `next`.** After `start` and after every stage, run `next`. It names the stage, who owns it (a skill, or you for deploy) and the exact commands: setup, then build, then Polish (with `polish capture` against the served build), then deploy (`record deploy --base-url <route root>`), then QA (`qa run --browser --test-order common`). Each `record` command validates what it would write and refuses a stage `next` has not reached.
6. **Read the evidence.** Doctor output, the Assembly Report, the QA verdict and the Polish captures stay in the campaign folder under `.campaign-runtime/`. `readback` summarises them and reports whether Polish and QA still match the build on disk.

Where it can, the toolkit holds the agent to contracts rather than judgment. Each starter template family ships a contract saying which parts are reusable page structure, which are live commerce wiring, and which demo values must be replaced, and doctor checks the assembled pages against it. That is what stops an agent from carrying sample package IDs into a real checkout or editing SDK-owned checkout markup as plain HTML.

## Install

Requirements: Node 20.19 or later and npm 10 or 11. In a new campaign folder:

```bash
mkdir "<route>" && cd "<route>"
npm init -y && npm i --save-exact next-campaign-page-kit@0.3.0
npx campaign-init --non-interactive --template <family> --slug "<route>" --name "<campaign name>"
npm install --save-dev --save-exact @nextcommerce/campaigns-os@<version>
```

For an existing Page Kit campaign, skip the first three lines and run the last one in its folder. `<version>` is the exact release you reviewed. `npm view @nextcommerce/campaigns-os version` prints the newest, and [`CHANGELOG.md`](CHANGELOG.md) opens each release with a short summary of what changed and what to do. Pin the exact version and commit `package.json` and `package-lock.json`, so CI and the deploy host install the same bytes.

Then connect your coding agent. With Claude Code, one command installs the QA browser, the bundled skills and the project context, and keeps any existing pages and instructions:

```bash
npx --no-install campaigns-os tooling setup --target . --platform claude
```

Codex, Cursor and other agents take the separate steps, with `--platform codex`, `--platform agents` or `--platform all` for the profile your agent reads:

```bash
npx --no-install campaigns-os install-skills --platform codex
npx --no-install campaigns-os install-agent-context --target .
npx --no-install campaigns-os qa install-browser
```

Restart the agent afterwards, because a running session does not load skills installed after it started. `tooling status --platform claude` reports the install mode, the pinned version and whether the installed skills are current; on a fresh profile it exits 2 until the skills are installed, and prints the command that installs them.

Keep `--no-install` in every command. `campaigns-os` is only the bin name of `@nextcommerce/campaigns-os`, so in a folder without the pinned copy a plain `npx campaigns-os` would fetch whatever the registry returns; with the flag, npx stops with an error instead.

Before you install, orient. Read [`AGENTS.md`](AGENTS.md), `contracts/supported-surface.json`, `contracts/release-ledger.json` and `CHANGELOG.md` on GitHub at one commit, and check the release tag and npm provenance against that commit. Orientation is a read of declarative data and never runs toolkit code.

To see a built campaign before you have one, `npx --no-install campaigns-os demo --target ./apollo-sample` writes four inert sample pages; open the printed `landing/index.html`. It downloads nothing and creates no campaign evidence. See [offline sample preview](docs/demo-preview.md).

## Start a build

> **`start` turns on run telemetry, and remit is on by default.** The first `start` opens a run session in the campaign folder, and unless you opt out the session's Run Record is sent to the Campaigns telemetry endpoint with the packet's Campaigns API key. Opt out with `npx --no-install campaigns-os telemetry off`, `CAMPAIGNS_OS_TELEMETRY=off`, or `--no-remit` on the remitting command; capture stays local either way. The full note is in [docs/quickstart.md](docs/quickstart.md) above the first `start`, and the contract is [Run Telemetry](docs/workflow-findings-sidecar.md).

```bash
mkdir -p source
npx --no-install campaigns-os start --map-id <map-id> --target . --source ./source --template-family <family>
npx --no-install campaigns-os next --packet ./campaign-runtime.build.json --json
```

`--map-id <id>` starts from a Map saved in Campaign Map Builder; `--spec <campaignspec.json>` starts from a local export or an agent-authored spec instead. `--source` is required even when every page is template stock. `--template-family` names a certified starter family from `contracts/commerce-surface-catalog.json`, such as `olympus`, `apollo` or `demeter`. To prove the campaign on localhost before a hosted preview, add `--deploy-target local-serve`.

Then do what `next` prints. From here the build is agent-driven: the setup, build, Polish and QA stages each name their skill (`next-campaigns-os-setup`, `next-campaigns-build`, `next-campaigns-polish`, `next-campaigns-qa`) and their commands, already spelled for this install. The deploy stage is yours to run; `next` prints the `record deploy --base-url <route root>` command for it, a loopback URL for a local-serve target or an https URL for a hosted one. Two things doctor asks for on a fresh folder are worth knowing in advance. `page-kit sync --packet campaign-runtime.build.json` replaces the store profile and SDK pin that `campaign-init` seeded into `_data/campaigns.json` with the CampaignSpec's values. And every designed page needs its screenshot proof in the source manifest at `source/.campaigns-os/source-html-manifest.json`, or in a manifest named with `--design-manifest <path>`; [Clearing `DESIGN_SOURCE_PACKAGE_NOT_READY`](docs/design-source-package.md#clearing-design_source_package_not_ready) walks through it.

`start` writes these files into the campaign folder, among others that [declared command effects](docs/effects.md) lists in full:

- `campaign-runtime.build.json`, the Build Packet
- `.campaign-runtime/build-context.json`, `.campaign-runtime/assembly-report.json` and `.campaign-runtime/doctor-output.json`
- `.campaign-runtime/run-session.json`, the run session the telemetry note above describes
- `.campaign-runtime/input/*`, the normalised brief and Design Source Package
- `.campaign-runtime/qa-verdict.json`, after QA
- `.campaign-runtime/agent-context/*`

## Proof, test orders and launch

Build output is not launch readiness. A complete run has build and lint evidence, a Polish record backed by `polish capture` against the served build, a recorded deploy, a browser QA verdict, and typed-card test-order proof from `--test-order common`. Global test cards bypass the gateway and create no transactions, but each test order leaves a real store order record. Unless the operator has already said test orders are fine for this campaign, ask once, up front, before placing test orders; then proceed. There is no permission flag. Localhost on any port is a Campaigns App development domain, so the SDK runs and analytics are suppressed there; a hosted preview or production origin must be on the campaign API key's allowed domains.

Before real shoppers see a campaign, confirm the production storefront URL, live payment methods, shipping markets, legal and support URLs, analytics expectations and the merchant-side configuration. Those sit outside the toolkit's proof.

After launch, keep a standing pull-request check. `doctor --packet <packet> --ci --no-live-refs` reports whether Polish and QA still bind to the build on disk, and the [workflow example](https://github.com/NextCommerceCo/campaigns-os/blob/main/docs/examples/campaign-repo-evidence-check.yml) posts that report as a PR comment. See [live-campaign changes](docs/campaigns-os-build-flow.md#live-campaign-changes).

## Other ways to run it

A global install works too: `npm install -g @nextcommerce/campaigns-os@<version>`, then bare `campaigns-os …`. It ships without a browser, so run `campaigns-os qa install-browser` once. From a checkout of this repository, `npm install` and then `npm run campaigns-os -- <command> …`; every example in these docs that reads `npm run campaigns-os -- …` is the checkout form of `npx --no-install campaigns-os …` with the same arguments. The bundled example inputs let a checkout run a first intake:

```bash
npm install
npm run campaigns-os -- start \
  --spec examples/campaignspec.v42.basic.json \
  --source examples/source-html \
  --target examples/target-page-kit \
  --template-family olympus
```

## Docs

- [Quickstart](docs/quickstart.md) and [local setup with Claude Code](docs/local-setup.md)
- [Activation, access and evidence](docs/activation-and-evidence.md): what an install, a saved Map, a preview and a QA verdict each prove
- [Build flow](docs/campaigns-os-build-flow.md) and [Build Packet](docs/build-packet.md)
- [Entry points](docs/entry-points.md): template-stock, Figma-driven, AI-generated, hand-authored and mixed sources
- [Design Source Package](docs/design-source-package.md) and [source adapters](docs/source-adapters.md): preparing page HTML and its manifest
- [Campaign Build Brief](docs/campaign-build-brief.md) and [CampaignSpec authoring examples](docs/campaignspec-authoring-examples.md)
- [Brand theme bridge](docs/brand-theme-bridge.md): carrying the design's palette and fonts onto the commerce pages
- [Polish evidence](docs/polish-evidence.md), [QA and test orders](docs/qa-and-test-orders.md) and [readback](docs/readback.md)
- [Declared command effects](docs/effects.md): what every command writes and sends
- [SDK storage compatibility](docs/sdk-storage-compatibility.md) and [legacy migration](docs/legacy-migration.md), for moving an existing campaign to a newer Campaign Cart
- [Supported surface](docs/supported-surface.md), [versioning](docs/versioning.md) and the [release ledger guide](docs/release-ledger-authoring-guide.md): what you may depend on and how changes are recorded
- [Run Telemetry](docs/workflow-findings-sidecar.md)
- Repository-only: [developer evaluation](https://github.com/NextCommerceCo/campaigns-os/blob/main/docs/developer-evaluation.md), [template family versus Figma extraction](https://github.com/NextCommerceCo/campaigns-os/blob/main/docs/template-vs-extraction-decision.md), [small PR review path](https://github.com/NextCommerceCo/campaigns-os/blob/main/docs/small-pr-review-path.md) and [setup profile parity](https://github.com/NextCommerceCo/campaigns-os/blob/main/docs/setup-profile-parity.md)

`campaign-spec/` is the CampaignSpec validator: a normalize phase, a rule registry and a fixture corpus, compiled to plain ESM and exported as `@nextcommerce/campaigns-os/campaign-spec`, so other tools can run the same rules doctor runs. See [`campaign-spec/README.md`](campaign-spec/README.md).

## Contributing

Work is tracked in GitHub Issues and on the org's [Operations](https://github.com/orgs/NextCommerceCo/projects/10) board. Assign yourself before starting an issue, and open pull requests with `Closes #<n>`. `npm run check` runs every gate, and `npm run check:fast` runs the ones CI's types and contracts lanes run. Reviewers apply two rules beyond the gates: a guard test includes the failing case (assert the behaviour that was broken, and check that it fails without the fix), and a `catch` branches on the condition it claims to handle rather than swallowing every error. Releases are cut by pushing a `v<version>` tag that matches `package.json` on a commit on `main`; the publish workflow runs the full check and publishes the verified tarball with provenance.
