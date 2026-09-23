---
name: next-campaigns-os
version: 1.0.23
description: Coordinate Campaigns OS lifecycle workflows from CampaignSpec, Build Packet, starter-template contracts, stage reports, deploy evidence, and QA proof depth.
---

Bundle revision: 1.41.2+skills.1
Run `npx --no-install campaigns-os tooling status --skills-revision 1.41.2+skills.1`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Campaigns OS

## Installed toolkit commands

Run from the campaign folder with an exact project-local devDependency and
committed lockfile. Orient on reviewed source before installation; check release
provenance or pin the full reviewed Git SHA. Preflight with `npx --no-install
campaigns-os tooling status --platform <claude|codex>` (tier `B`: its only write
is the command-lifecycle journal) and refresh bundled skills for the same
profile with `install-skills` (tier `B`: writes the shared skill directories;
nothing leaves the machine). Use the invocation printed by status and `next` to
avoid PATH shadowing.

In the instructions below, bare `campaigns-os …` means `npx --no-install
campaigns-os …` from that campaign folder. Keep `--no-install`: `campaigns-os`
is only the bin name of `@nextcommerce/campaigns-os`, so where no pinned copy is
installed a plain `npx` looks that name up on the registry and, with no terminal
to ask, installs what it finds. Global-only users substitute the global copy's
printed invocation for each `npx --no-install campaigns-os` example; toolkit
contributors translate to `npm run campaigns-os -- …` in the toolkit checkout.
Browser installation is `npx --no-install campaigns-os qa install-browser`, not
a campaign npm script. `tooling diagnose --packet <p> --json` (tier `none`:
read-only, and exempt from lifecycle capture) provides a redacted support export
without changing retained evidence.

The effect class in each parenthetical below is the declared row of
`contracts/effects.v1.json` (`none` < `B` writes < `A` sends < `C` destructive).
Read that file, not this text, when an exact path or endpoint matters.


Use this skill to orient a campaign build, run preflight, decide the next stage, and keep the lifecycle honest.

## Public Lifecycle Boundary

The public `campaigns-os` package owns portable workflow semantics: Build
Packet generation, Build Context, Assembly Report validation, doctor/readiness
decisions, public build/polish/QA guidance, and browser QA runner behavior.
It also owns CampaignSpec validation through the public
`@nextcommerce/campaigns-os/campaign-spec` subpath; Map Builder, the public
doctor, and agency tooling should consume that same rule registry instead of
vendoring or reimplementing spec rules.
Internal orchestration may wrap this workflow for the Map Builder,
issue-tracker projection, QA routing, dashboards, and promotion decisions,
but those wrappers should not redefine the public contract.

Workflow:

1. Confirm the campaign was configured in Campaigns App and exported from Campaign Map Builder as current CampaignSpec JSON. Current authoring is v4.3+ while preserving the v4.2 `funnels[]` topology as the compatibility shape.
2. Run `campaigns-os start` or `campaigns-os prepare-build` (tier `A`: they write the
Build Packet, Build Context, assembly report, run session and `.gitignore` under
the target plus a Run Record under the working directory, and they contact the
Map and run endpoints) with a local CampaignSpec, prepared HTML/assets source, target page-kit repo, and explicit template family. The family must be certified (commerce catalog + brand contract; the CLI lists them on rejection) — an uncertified/custom family requires `--allow-uncertified-template "<reason>"` and forfeits deterministic assembly, residue QA, and pricing contracts. The entry point auto-opens the run session in the target repo; do not skip `campaigns-os run end` (tier `C`: it clears the active run session — a write that discards prior state — while assembling and remitting the Run Record) at the finish. If intake blocks with `DESIGN_SOURCE_PACKAGE_NOT_READY`, the source material carries no desktop/mobile screenshot proof: supply it through `pages[].screenshots[]` in `<source-root>/.campaigns-os/source-html-manifest.json` and follow "Clearing `DESIGN_SOURCE_PACKAGE_NOT_READY`" in `docs/design-source-package.md`, which also gives the recovery for the package a blocked run left behind.
3. Brand-theme discovery runs in inspect-only mode by default and records `context.theme`. When it proves a brand theme is generatable and the campaign ships commerce pages, the theme gate BLOCKS polish/deploy/QA until the brand layer is applied after `next-core.css` or explicitly waived (`campaigns-os theme waive --packet <p> --reason "<why>" --waived-by "<named human>"` — tier `C`: it overwrites the assembly report and doctor output, the same named-human rule as `checkpoint waive`). Run `campaigns-os theme generate` (tier `B`: writes the theme artifacts and doctor output under the target; `--force` is tier `C` because it overwrites an existing theme) and apply it during build; do not defer the decision.
4. Run `campaigns-os doctor --packet <packet>` (tier `none`: read-only inspection, exempt from lifecycle capture; `--write`, `--built` and `--built --emit-packet` are tier `B` and write doctor output or the emitted packet under the target).
5. Resolve the registered **Page Kit** checkpoints before runtime work. The CampaignSpec is the authority for the target's `_data/campaigns.json` entry, and the reconcile is a command, not a hand edit: `campaigns-os page-kit sync --packet <p>` (tier `B`: writes the target's `_data/campaigns.json` entry and doctor output, nothing off the machine; add `--dry-run`, tier `none` and read-only, to see the field-by-field diff first) writes the spec's `campaign.store_*` fields into the entry for the packet's route and seeds the released SDK pin (`global_config.sdk_version` is canonical, `runtime.sdk_version` an accepted alias) while the entry is still in scaffold state or behind the spec; it never moves a configured campaign's pin backwards (on an existing campaign the repo pin moves first and the Map is stale: run `campaigns-os spec derive --packet <p>` (tier `B`: writes the local CampaignSpec and doctor output), which writes the repo pin — and the page routes and analytics ids the repo carries — into the local CampaignSpec with a field-by-field diff, and add `--write-map` (tier `A`: the same local writes plus a read and a write against the Map endpoints) to record the pin in the saved Map's Build hints too (it reads the Map back and moves only the pin, forward or not at all; a Map pin ahead of the repo is refused as a warning), or re-save the Map by hand; a hand edit of the spec is never the answer for a derived field; the `campaign.store_*` fields are derived from the store itself with `spec derive --packet <p> --from-store <subdomain>` (tier `A`: it contacts the store's Admin API through the login gateway), using gateway credentials saved by `campaigns-os login --store <subdomain>` (tier `A`: it contacts the gateway and writes the credential file under your home directory) by default within the admitted owned-store private pilot; existing direct Admin callers must explicitly add `--store-token-source env:<VAR>` naming their existing environment variable (this warned break-glass path bypasses gateway custody; there is no implicit environment lookup or fallback after gateway failure; see `docs/gateway-login.md`), and a field the store cannot state is reported and left as it is, never emptied), and touches nothing else; doctor and `next` print it as the gate's `repair_target` action, and after it `page_kit.store_profile` and `page_kit.sdk_version` pass without a waiver. Starter demo residue (a demo storefront URL or phone) in that entry is never waivable and must be replaced this way. A `PARTIAL` status means a field could not be made spec-authoritative (a spec value of the wrong type or shape, the demo value itself in the spec, demo residue in a field the spec does not carry, a conflicting or non-released pin, or a gate under an active waiver); the warnings name the spec field to fix, then sync again. Missing/malformed Store Profile or SDK evidence, invalid types or semantic versions, and conflicting dual SDK declarations are not waivable. An exact valid mismatch may be accepted with named-human attribution and a bound: `campaigns-os checkpoint waive` (tier `C`: a waiver overwrites the assembly report and doctor output) `--packet <p> --gate <page_kit.store_profile|page_kit.sdk_version> --reason "<why>" --waived-by "<named human>" --review-condition "<trigger>"` (or `--expires-at <future ISO timestamp>`). The package-owned hidden eager-media checkpoint is produced and resolved during Polish in step 9.
6. On any doctor run that sees built output, resolve `built_output.upsell_selector_scope`. A `data-next-bundle-selector` on a page whose funnel role is `upsell` or `downsell` writes to the shopper's LIVE CART unless it carries `data-next-upsell-context`; loading the page then adds that package with no click, and it is charged at the next checkout without appearing in that checkout's rendered order summary. Being hidden does not help — the write happens at init. Fix it by adding `data-next-upsell-context` to the named selector, or by deleting a selector that exists only to display a price. This gate runs on EVERY doctor invocation, not only after assembly, because the defect it was written for was introduced by a later review round. If a cart-scoped selector on a post-purchase page is genuinely intended, record it: `campaigns-os checkpoint waive --packet <p> --gate built_output.upsell_selector_scope --reason "<why>" --waived-by "<named human>" --review-condition "<trigger>"`. On the same runs, resolve `built_output.campaign_identity`: every page must name the same campaign — one API key (`next-api-key` meta or the `config.js` / `window.nextConfig` `apiKey`), one `next-funnel`, and any `setAttribution({ funnel })` call agreeing with the tag of the page that makes it. A page copied from another funnel that still carries the other campaign's key, tag, or call binds and renders without complaint and puts the order on the wrong campaign. Each error names the two files and the two values; make the one-line edit it describes. Not waivable — there is no `checkpoint waive` lane for it. Parked `-backup-` / `-old-` copies are skipped and listed, not scanned. Also resolve `built_output.sdk_markup`: its blockers (`SWAP_WITH_ADD_TO_CART`, `CHECKOUT_NOT_FORM`, `WRONG_FIELD_NAME`, `MISSING_SELECTOR_ID_MATCH`) are markup the SDK binds and then silently no-ops or double-writes on — fix the markup the message names (it gives the SDK spelling for a wrong field name); its warnings (`DOUBLE_SELECTED`, `TEMPLATE_DOUBLE_BRACE`) are advisory. Neither is waivable. A `data-next-*` name the SDK does not read shows up as one advisory line naming the attribute index version, not a warning.
7. If doctor's `next` block says `doctor-blocked` or `prepare-build` (it names the same stage `campaigns-os next` would), stop and resolve the named blockers.
8. If doctor returns `build`, hand off with `campaigns-os next build --packet <packet>` (tier `A`, like every `next` form: additive writes under `.campaign-runtime/` plus a stage-progress POST once Run Telemetry consent is persisted; `--no-write` and `--no-remit` are each tier `B` and keep the invocation local) and follow `next-campaigns-build`'s recommended **build → independent review → repair → verification** loop.
9. After build, require polish and a preview deploy before QA. During Polish,
   install the package-owned browser once with `npx --no-install campaigns-os qa install-browser`,
   serve the current build, and run `campaigns-os polish capture --packet <p> --base-url <served-build-url>` (tier `A`: it writes the polish evidence and assembly report under the target and fetches the served build at `--base-url`) before recording a terminal Polish status.
   The package-owned producer attaches `visual_review.page_load`; never
   hand-author it. Nonwaivable incomplete evidence blocks. A complete hidden
   eager-media finding may receive an exact bound decision through
   `campaigns-os checkpoint waive --packet <p> --gate polish.hidden_eager_media ...`.
   Doctor/next report `ready_with_waivers`; QA
   retains each attributed exception as `ready_with_exceptions`, and one
   exception never suppresses another blocker.
10. Run the package-owned proof path in sequence: ensure `npx --no-install campaigns-os qa install-browser` has completed, run `campaigns-os qa resolve --packet <packet>` (tier `A`: it fetches `--base-url`; `--no-probe` is tier `B` and local), then `campaigns-os qa run --packet <packet> --base-url <url> --browser --test-order common` (tier `C`: it overwrites the stored verdict and assembly report, places real typed-card test orders against the campaign, and posts the verdict and progress; `--no-post-verdict` drops the verdict POST and `--no-remit` the Run Record remit, but both stay tier `C`).
11. Treat typed-card proof coverage as the control. Global test cards bypass the gateway and create no transactions, so no permission/approval is needed. `common` runs checkout, first-offer accept and decline, and a deduplicated shortest real receipt path when that adds coverage (at most four orders). `full` walks every actual terminal path in the selected checkout topology; cycles, missing routes, and reachable nonterminals block exhaustive proof before browser launch. The accidental-flood cap remains `6`, and an overflow names the exact explicit `--max-test-orders` raise. Localhost on any port is a Campaigns App Development domain for SDK QA with analytics suppressed; non-localhost preview/production origins still need SDK origin allowlist confirmation.
12. Discuss launch only from recorded build, polish, deploy, browser QA, and test-order evidence, or from explicit blockers.

## Session Intake

When a Campaigns OS session starts, classify the starting path before handing
off to setup, build, polish, QA, or promotion. The operator should separate:

- Intent: build, partial page update, existing campaign update, QA only, repair from verdict, design/source assembly, or promotion.
- Source truth: CampaignSpec/Map Builder export, Figma/design file, prepared HTML, existing campaign repo, deployed URL, or target deployment system.
- Runtime truth: Build Packet, Build Context, Assembly Report, doctor JSON, tested URL, API key source, and SDK origin allowlist state (localhost is already a Development domain; non-localhost origins still need confirmation).
- Change policy: what may change and what must be preserved, especially checkout, offer logic, routes, legal copy, and live campaign behavior.
- Proof depth: visual preview, doctor, browser QA, QA portal/local verdict policy, typed-card test-order depth, market coverage, and repair routing.

Return a compact brief before acting:

```text
Mode:
Intent:
Source truth:
Runtime truth:
Change policy:
Proof depth:
Next skill/command:
Missing inputs:
```

Use `references/session-intake.md` when the mode, allowed changes, or proof
depth is unclear. Ask only for fields needed by the selected starting path; a
QA-only session should not require design files, and a partial landing update
should not force full checkout/test-order depth unless commerce or routing can be
affected.

Rules:

- This is contract-backed guidance and preflight, not full automated readiness.
- Preserve CampaignSpec as the source of truth. Do not make CampaignSpec absorb source-export paths, target repo paths, template decisions, deploy status, or test-order depth; those belong in the Build Packet and stage reports.
- Treat `spec.validation` doctor findings as public CampaignSpec rule findings. When JSON output carries `detail.ruleId`, `detail.path`, and `detail.data`, use those fields for UI/repair routing instead of parsing message text.
- CampaignSpec/API own live commerce values.
- Treat checkout `exit_intent` and `promo_code_input` as optional CampaignSpec launch contracts. If present, build must wire the mapped offer surface and QA must exercise the accept/apply path.
- Keep offer application surfaces out of pricing logic: they validate/apply codes through SDK/API, while Campaigns API/SDK own repricing, totals, and discount rows.
- Starter-template `agentContract` owns reusable commerce structure and protected SDK surfaces.
- Promoted starter-template families must also have `contracts/template-brand-contract.<family>.v0.json` with family inventory, brand/residue, pricing, and exit-pop rules. Missing family contracts are gates, not advisory gaps.
- Designed source owns visual composition and page-level content.
- Brand-theme evidence is workflow-order neutral. Do not assume a Figma export came first; consume `context.theme` and `.campaign-runtime/theme/theme-report.json` when present. A truly missing/ungeneratable theme stays a warning, but a generatable-and-unapplied theme on a commerce-page campaign is a gate: apply it or waive it explicitly before polish/deploy/QA.
- Follow `campaigns-os next` literally. Every `next` response carries its applicable Store Profile, SDK, hidden eager-media, theme, and broad Polish gates plus `next_actions` with exact commands — execute those instead of improvising. With an active run session, pipeline-advancing commands that don't match the last `next` recommendation are recorded to `.campaign-runtime/agent-deviations.jsonl`; declare an intentional detour with `--deviation-reason "<why>"`.
- Close the loop: when `next` reports `done` (or QA has published its verdict and the PR is up), finish with `campaigns-os run end` (tier `C`; `--no-write` still clears the session file) so the Run Record is assembled and the run session clears. `campaigns-os run status` (tier `none`: read-only) shows incomplete stages and the exact next command at any point.
- Do not copy demo refs or unsupported optional surfaces into the target campaign.
- Use SDK conditionals such as `cart.hasCoupon("CODE")` for code-specific presentation; do not mutate visible prices from campaign-specific JavaScript.
- Build Packet, Build Context, and Assembly Report paths should be repo-relative when possible so handoff artifacts can be committed without machine-local absolute paths.
- Preserve Build Context `theme` inspection state and Assembly Report `theme` application state when present; they are public v0 contract fields and should not be dropped by wrappers, setup reruns, or repair passes.
- Store Profile fields are operator-entered storefront/legal metadata for page-kit `campaigns.json`; they do not come from the Campaigns API and should be collected in the CampaignSpec before build.
- Treat `campaigns-os checkpoint waive` as a staged generic registry, not a universal waiver command. This release registers Store Profile, the Page Kit SDK pin, `polish.hidden_eager_media`, and `built_output.upsell_selector_scope`. The broad Polish Source Freshness gate remains on its existing artifact handling, and theme/QA keep their existing `theme waive` / `qa waive` lanes until those gates are explicitly registered. A checkpoint waiver needs a named human, non-empty reason, and at least one future expiry or non-empty review condition; a waiver remains visible, applies only to its exact checkpoint state, and never turns the checkpoint into a clean pass. Hidden eager-media measurement completeness is never waivable.
- Keep the lifecycle in a tight sequence. Pause only for missing inputs, doctor blockers, deploy blockers, out-of-scope runtime pages, or merchant-specific uncertainty.
- `campaigns-os standardize` (tier `B`: it writes no artifact of its own, but the command-lifecycle journal append makes it a write) audits the campaign ecosystem read-only: it recognizes Page Kit roots and non-Page-Kit Campaign Cart applications (Vite/React/Express apps, static HTML funnels) via portable evidence, classifies each root (`implementation.kind`), validates checkout field bindings against the Campaign Cart field contract, and evaluates loader versions against the SDK support policy contract. Findings carry `confidence` (`static_contract`, `static_inference`, `runtime_proof_required`); treat `runtime_proof_required` findings as missing proof, never as confirmed defects, and route them to browser QA rather than static repair.
- Launch readiness is separate from Campaigns OS proof. Surface production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration as real-shopper readiness items, not Campaigns OS build blockers.
- Browser QA and test-order proof are owned by Campaigns OS through Playwright. Do not route the core QA path through external browser skills or hand-built backend orders.
