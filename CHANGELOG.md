# Changelog

Notable supported-surface changes are recorded here.

## [1.68.0+agent.7] - 2026-11-11

### Changed

- `standardize --slug <route>` audits only that route's source, lists the routes that share a file a finding sits in, and names the entry point to come back in through (#754).

## [1.68.0+agent.1] - 2026-11-10

### Changed

- The release-ledger authoring guide makes each new `+agent.N` section one line and leaves the summary to release sections (#751).

## [1.68.0] - 2026-11-10

This release rotates the release ledger and this changelog at a reviewed baseline for the second time, so the mandatory orientation reads have room to grow again. No limit changed and nothing else in the package changed. To take it, pin `@nextcommerce/campaigns-os@1.68.0` and refresh the installed skills to `1.68.0+skills.1`.

### Changed

- Ledger entries at sequences 125 through 257 (`RL-0125` through `RL-0264`; ids are not contiguous) moved byte-for-byte into `contracts/archive/release-ledger.2026-11-10.json`, keeping their `sequence`, `entry_sha256` and `changelog_sha256`. Every changelog section from `1.58.0+agent.7` down to `1.37.1` moved verbatim and in order into `contracts/archive/CHANGELOG.2026-11-10.md`, including the sections no ledger entry links. This file now ends at `1.59.0`, and the live ledger starts at sequence 258 (`RL-0268`). The 2026-09-30 archive pair is unchanged.
- `baseline_floor` in `contracts/release-ledger.json` lists the new archive pair after the first, and moves the floor to `RL-0264` (sequence 257), first kept entry `RL-0268`, recorded by `RL-0333`. A consumer whose reviewed baseline's newest ledger entry is older than sequence 257 refuses with `baseline_below_floor` and adopts a newer reviewed baseline; every commit from `1.59.0` on qualifies.
- The cut is the last one before `1.59.0`: later amendments tie the `1.59.0` to `1.61.0` entries together, so a cut inside them would split an amendment pair. Cutting there keeps a month of reviewed baselines valid.
- The supported surface names the two new archive files. The authoring guide records the rotation, and the generated orientation reference shows the new floor.
- Bundled skills advance to `1.68.0+skills.1`, each one patch higher. Only the bundle revision lines and each skill's `version:` line change.

## [1.67.0] - 2026-11-10

This release packages the sixteen `1.66.0+agent` sections below; the numbering skips `+agent.7`. For a campaign, what changes is Campaign Cart SDK 0.5 support in doctor and QA, three new doctor advisories that never block (one of them for 0.5 pages), QA waiting for the SDK to render, and a starter used as-is keeping its content. The #730 doctor work changes only how often doctor reads and parses: nothing doctor reports changes. Visual comparison scores from the optional pixelmatch move to v8 and are not comparable with v7 scores. To take it, pin `@nextcommerce/campaigns-os@1.67.0` and refresh the installed skills to `1.67.0+skills.1`.

### Added

- Publishes `1.66.0+agent.13`: campaigns pinned to Campaign Cart SDK 0.5.0 pass doctor and QA without false blockers. On a 0.5 page doctor warns `built_output.sdk_markup.removed_in_sdk_05` for each removed 0.4.x feature, browser QA blocks on `html[data-next-error]`, the `AnalyticsContractShape` rule warns about settings 0.5 ignores, `WRONG_FIELD_NAME` and browser QA accept the 0.5 names and markup, and `sdk repin` refuses a 0.4.x → 0.5 move the pages are not ready for. The `next-campaigns-sdk-bump` skill gains "Crossing to 0.5". The SDK support policy and the vendored attribute index stay at 0.4.43 (#742).
- Publishes `1.66.0+agent.8`: doctor advisory `built_output.family_script_divergence.diverged` compares a campaign's copies of family scripts with the family's own, from the bundled `contracts/family-script-reference.v0.json` (#729, #736).
- Publishes `1.66.0+agent.10`: doctor advisories under `built_output.script_observations.*` for campaign scripts that reach past the SDK's public surface: SDK-prefixed storage keys, a replaced `fetch` or `XMLHttpRequest`, `nextDebug`, and underscore members of the SDK globals (#729, #738).
- Publishes `1.66.0+agent.3`: goldens of doctor's output, commerce-signature vectors and `scripts/performance/doctor-cost.mjs`, the baselines the #730 work is held to (#732).

### Changed

- Publishes `1.66.0+agent.4`: a starter template used as-is keeps its pages, sections and copy, and the guided brief keeps the template's banner and timer by default (`template`) (F-197, #734).
- Publishes `1.66.0+agent.1`: the optional pixelmatch dependency moves from 7.2.0 to 8.0.0, so mismatch scores change for the same image pair (#715).
- Publishes the #730 doctor shared-input work. Nothing doctor reports changes in any of them:
  - `1.66.0+agent.5`: one bounded set of inputs per run (#733).
  - `1.66.0+agent.6`: the script syntax gate reads its script references through the run's shared inputs (#735).
  - `1.66.0+agent.9`: the campaign identity gate and the smoke checks' script reader read through the run's shared inputs (#737).
  - `1.66.0+agent.11`: the script syntax gate parses through the run's shared script programs (#741).
  - `1.66.0+agent.14`: the cart placeholder and smoke checks share one bounded parse per page (#743).
  - `1.66.0+agent.15`: each built page is parsed once for every check that reads its tree (#746).
  - `1.66.0+agent.16`: the evidence-debt pass reads the run's shared pages, and `doctor --ci` assesses evidence debt once (#747).
  - `1.66.0+agent.17`: the built-output validators take the check registry's context directly (#748).
- Publishes `1.66.0+agent.12`: the issue project automation pins `actions/add-to-project` v2.0.1 (#739).
- Bundled skills advance to `1.67.0+skills.1`, each one patch higher. Only the bundle revision lines and each skill's `version:` line change.

### Fixed

- Publishes `1.66.0+agent.2`: QA waits up to 15 s more for the SDK to finish rendering before it reads a page, so a slow SDK boot no longer reads as unmounted card fields, a missing CTA or a missing checkout select. Browser-load evidence gains `observation.sdk_display` and `sdk_display_ms` (#731).

## [1.66.0+agent.17] - 2026-11-10

### Changed

- **Doctor's built-output validators take the check registry's context directly (#730, milestone 4).** Nothing doctor reports changes. Sixteen built-output and gate checks (target root, fingerprint, pages, live-campaign refs, upsell selector scope, campaign identity, SDK markup, script syntax, family-script divergence, cart placeholders, smoke QC, SDK meta tags, build summary, route drift, content residue, proof attestation) were registered through a wrapper that unpacked the context into positional arguments. Each validator now takes the context object itself and is registered as is, so a check's inputs are named the same way at the registry and in the function. The exported ones (`validateBuiltOutputTargetRoot`, `validateBuildOutputFingerprint`, `validateCampaignIdentity`, `validateBuiltSdkMetaTags`, `validateBuiltRouteDrift`, `validateBuiltContentResidue`, `validateProofAttestation`) now take one context object instead of positional arguments, and each reads only the keys its own signature names: `validateCampaignIdentity` reads no `warnings` or `buildState`, and only it, `validateBuiltSdkMetaTags` and `validateBuiltRouteDrift` read `spec`. Spec, packet and source validators keep their signatures.

## [1.66.0+agent.16] - 2026-11-10

### Changed

- **Doctor's evidence-debt pass reads the run's shared pages, and `doctor --ci` assesses evidence debt once (#730, milestone 4).** Nothing doctor reports changes. Drift classification (which pages a rebuild changed, and whether the change touches commerce) read and parsed each changed page itself. It now reads page bytes through the run's input snapshot and takes the shared tree of the whole built page set when the checks already share one. Past the parse budget, or outside doctor (`record build`, readback, QA), it parses per use as before. A page past the nesting bound gets its own unbounded parse, so its classification is unchanged. `doctor --ci` assessed evidence debt during inspection and then again, from scratch, for the CI verdict. The CI verdict now reads the assessment inspection made from the same packet, report and built output. On a 16-page estate where every page changed since the recorded build, `doctor --ci` goes from 48 to 16 parses and runs 14% faster. On real-estate-a it reads 247 fewer files and runs 12% faster. On a 304-page estate where every page changed it goes from 2285 to 1981 parses and runs 7% faster. `record build`'s commerce signature still parses each page itself: it has to read the bytes as they are at record time.

## [1.66.0+agent.15] - 2026-11-10

### Changed

- **Doctor parses each built page once for every check that reads its tree (#730, milestone 4).** Nothing doctor reports changes. Doctor parsed each page up to six times: one tree for the upsell selector and SDK markup gates, a bounded tree for the cart placeholder and smoke checks, the script syntax gate's own tree, one parse in the live-campaign ref check and two in the CampaignSpec commerce-ref check. Within the nesting bound (512), the bounded parser builds the same tree as the others, with source locations the others ignore. So every check now reads the one bounded tree per page, shared only while the whole page set fits the parse budget (about 1.1 MiB of HTML). A page past the bound still reads `page_unreadable` in the cart placeholder and smoke checks. Every other check parses that page as it did before, unbounded, so it still sees every script and ref on it. A page set too large to share as bounded trees falls back to unbounded trees, shared up to about 2.1 MiB as before, and the script syntax gate then parses per use. The live-campaign ref and commerce-ref checks also read page bytes through the run's input snapshot. A certified family's `doctor --built` now parses a third as often (27 to 9 parses on olympus), with 11-15% lower peak RSS and 11-19% less wall time. A 304-page estate is too large to share and parses as before; its packet and CI runs read about 4% more files, because the commerce-ref check now reads the whole page set the live-campaign ref check reads.

## [1.66.0+agent.14] - 2026-11-10

### Changed

- **Doctor's cart placeholder and smoke checks share one bounded parse per built page (#730, milestone 4).** Nothing doctor reports changes. Both checks read the same built pages with the same nesting bound (512), and each parsed every page itself. The page inventory is now resolved once per run through the run's input snapshot. Each check still checks and reads its pages itself, taking the bytes from the snapshot while it holds them, so a failed read is never reused by the other check. Both checks get one bounded tree per page, so a 16-page estate parses each page once for these checks instead of twice. A page past the nesting bound reads `page_unreadable` in both checks, as before. The trees are shared only when the whole page set fits the parse budget, which the bounded trees share with the unbounded trees doctor's other gates already hold for the same pages (estimated at 56 and 30 times the HTML, about 0.74 MiB of HTML together). A larger set, such as a 304-page estate, still parses per check. The smoke checks also take the built-site scope from the run's snapshot instead of resolving it again.

## [1.66.0+agent.13] - 2026-11-09

### Added

- **Campaigns pinned to Campaign Cart SDK 0.5.0 pass doctor and QA without false blockers.** 0.5 keeps 0.4.x pages working through a legacy layer, and adds a `type="module"` loader that names the campaign with `data-campaign`, the API checkout field names, `data-next-field`, `data-next-action="acceptUpsell"` / `"skipUpsell"`, and `html[data-next-ready]` / `html[data-next-error]`. Every change below applies only to a page whose SDK is an exact release at or after 0.5.0 (its own loader pin, else the campaign's `sdk_version`), or matches markup a 0.4.x page never carries, so 0.4.x campaigns are judged as before. The vendored attribute index and the SDK support policy stay at 0.4.43 until the starter templates are verified on 0.5.
- **Doctor advisory `built_output.sdk_markup.removed_in_sdk_05`.** On a 0.5 page, each 0.4.x feature 0.5 removed warns once, naming what replaces it: `data-next-action="accept-upsell"`, `data-next-upsell-option` / `-select` / `-quantity`, `data-prospect-config`, `data-email-field`, `data-phone-field`, `data-min-phone-digits`, and in the page's inline or local scripts `googleMaps:`, `upsell:accepted`, `cart:package-swapped`, `order:redirect-missing` and `address:messages-loaded` listeners, `dl_package_swapped` and `next.fomo`. It never blocks.
- **Browser QA blocks on `html[data-next-error]`.** When 0.5 cannot start (`config`, `load`, `campaign`), the readiness wait stops at once, `observation.sdk_error` records the value, and `browser-sdk-error:<page>` fails as a blocker with the remedy.
- **CampaignSpec rule `AnalyticsContractShape`** warns (`blocked-events-ignored-sdk-05`, `custom-provider-ignored-sdk-05`) that `providers.*.blockedEvents` and `providers.custom` do nothing on a 0.5 pin, and points to `analytics.destinations` and `next.analytics.on('*', …)`.

### Changed

- **`WRONG_FIELD_NAME` accepts 0.5's field names.** `line1`, `line2`, `state` and `postcode` are accepted from 0.5.0, as version-gated names beside `first_name` and `last_name` (from 0.4.39) and `phone_number` (from 0.4.41), here and in `contracts/campaign-cart-checkout-field-contract.v0.json`. On a 0.5 page the hint for an unknown name is the 0.5 name (`zip` → `postcode`). The checkout contract scan reads `data-next-field` on a 0.5 page (`version_gated_binding_attributes`), with the card and payment keys as their own fields.
- **SDK markup's unknown-attribute note** counts the names 0.5 reads as known on a 0.5 page.
- **Campaign identity and QA key binding read `data-campaign`** (and identity reads `data-funnel`) from the Campaign Cart loader tag. QA binding reports it under the `meta` source kind.
- **Browser QA finds 0.5 markup.** The readiness wait, the contrast checks and the content-param reader accept `html[data-next-ready]`. The checkout form is `form[data-next-checkout="form"]` or bare `form[data-next-checkout]`. Checkout fields, the card and CVV mounts, the coupon input, the card radio and the same-as-shipping box also match `data-next-field` (and the API names on `data-next-checkout-field`), and the card expiry is typed into 0.5's single `card.expiry` input when the page has no month select. Upsell controls include `data-next-action="acceptUpsell"` / `"skipUpsell"`, and the checkout total includes `data-next-query="cart.total"`.
- **`sdk repin` refuses a 0.4.x → 0.5 move** (`refused_cross_minor`, exit 2, nothing written) while a loader `<script>` is not `type="module"` or a file references the 0.4 dist layout (`dist/index.js`, `dist/chunks/`), and lists each blocking line.
- **Skills.** `next-campaigns-sdk-bump` gains "Crossing to 0.5" (module loader, removed features, analytics, page state, lost open carts, and `scripts/migrate.mjs` only on built `_site` HTML) and a ready guard that works on 0.5. `next-campaigns-qa` accepts the 0.5 names. Bundle revision `1.66.0+skills.2`; each skill one patch higher.
- A comment in the analytics parity capture no longer says the SDK pushes to `ElevarDataLayer` on 0.5.

## [1.66.0+agent.12] - 2026-11-09

### Changed

- **Issue project automation updates its pinned action (#739).** `actions/add-to-project` moves from v2.0.0 to v2.0.1. An eligible issue already present in the project now skips successfully instead of failing when reopened. The collaborator gate, project destination and token permissions are unchanged. No campaign migration is required.

## [1.66.0+agent.11] - 2026-11-09

### Changed

- **Doctor's script syntax gate parses through the run's shared script programs (#730, milestone 3).** Nothing doctor reports changes. Each local script is now parsed once per run and mode, and the gate and the API/storage observations (#729) read the same program, where before each parsed it separately. The diagnostic is the same: same parser options, same source-free message, same line and column. A run whose scripts exceed the parse budget still parses per use.

## [1.66.0+agent.10] - 2026-11-09

### Added

- **Doctor warns about campaign scripts that reach past the SDK's public surface (#729, #730 milestone 3).** Advisory only: new warnings under `built_output.script_observations.*`, never a blocker, and no new gate, ready line or doctor check entry, so a campaign with nothing to observe reads exactly as before. Doctor reads each local script a built page loads, as a classic script or a module the way the browser does, and names the operation, file, line and column of a storage read, write or removal whose key starts with the SDK's `next-`/`next_` prefix (`sdk_prefixed_storage`), a replaced `fetch` or `XMLHttpRequest.prototype.open`/`send` (`network_global_replaced`), a reference to the SDK's `nextDebug` debugging global (`sdk_debug_surface`), and an underscore member reached from the SDK's `next` or `NextCommerce` global (`sdk_private_member`). A finding needs a verified receiver: a parameter or local variable named `sessionStorage`, `window` or `next` shadows the global unless it is a `const` or destructured alias of that global, and an underscore member on any other receiver is not reported. Among assignments, `=` and `&&=` replace `fetch` (the browser's is always defined, so `&&=` assigns over it); `||=` and `??=` never do and are not reported. In a classic script, assigning a top-level `var fetch` replaces it too, since that `var` is the global object's own property. `Object.defineProperty(window, 'fetch', …)` counts only when its written-out descriptor sets `value`, `get` or `set`. A script that parses but whose analysis does not finish gets one `built_output.script_observations.incomplete` warning instead of reading as clean, and the analysis walks the parse tree without recursion, so deeply chained valid code never stops doctor's report. Messages claim no SDK bypass or SDK ownership: a prefix or a fetch reassignment alone does not establish either. The certified shop-three-step family's billing script now shows three `sdk_prefixed_storage` warnings, for its reads of `next-checkout-store` and `next_funnel_name__<scope>`. This check parses each script once per run and mode, holding the programs on the run's input snapshot (whole set or none, within its parse budget); the script syntax gate still parses the same scripts separately, so each local script is parsed twice per run.

## [1.66.0+agent.9] - 2026-11-09

### Changed

- **Doctor's campaign identity gate and the smoke checks' script reader read through the run's shared inputs (#730, milestone 4).** Nothing doctor reports changes. The campaign identity gate shares the run's built-site scope and page bytes with the upsell selector-scope and SDK markup gates, so packet doctor resolves that scope once less, and it reads the local scripts its pages load through the run's snapshot, which the script syntax gate reads too. Which scripts it reads and how it resolves them are unchanged. The smoke checks' anchor script hint keeps its script cap, size cap, site-root containment and unread reasons, and takes the bytes of a script it may read from the same snapshot.

## [1.66.0+agent.8] - 2026-11-09

### Added

- **Doctor compares a campaign's copies of family scripts with the family's own (#729, #730 milestone 3).** An advisory: it never blocks. When the template family is known (the packet's decided family, or `--family` for `doctor --built`), each local script the built pages load is compared with the family's files. A copy identical to any family file reads as identical. Any other copy is a candidate for the family file at the same built path, or else the one family file with its name, and is diffed against it. An edited copy warns under `built_output.family_script_divergence.diverged` with its line counts and hunks, the family file's upstream path, and the reference used: the starter-templates commit and the SDK version the family pins there. A nomination never claims ancestry, because no build records it. `config.js` is generated configuration and is listed apart, never compared. The record is `derived.family_script_divergence`.
- **A bundled family script reference.** `contracts/family-script-reference.v0.json` holds the bytes, SHA-256, upstream path and SDK applicability of every certified public family's `js/` scripts at the commerce-surface catalog's pin, with one blob per distinct script. It ships in the npm package, and `check:pack` loads it from the packed tarball and verifies every blob. Private families are never bundled, and their comparison reads as unavailable. `npm run check:family-script-reference` fails when the reference is stale, and the catalog refresh workflow regenerates it.

## [1.66.0+agent.6] - 2026-11-09

### Changed

- **Doctor's script syntax gate reads its script references through the run's shared inputs (#730, milestone 3).** Nothing doctor reports changes. Each built page's `<script src>` references are resolved once per run: against the base in effect when the browser prepares each script, under the site root and then the campaign directory, as classic or module, with unclosed scripts and symlinks that leave the site root kept apart. The gate reads page and script bytes through the run's snapshot and shares the run's built-site scope with the upsell selector-scope and SDK markup gates, so packet doctor resolves that scope once less. A script it cannot read is still skipped as before, and missing, outside-site and unclosed scripts still warn.

## [1.66.0+agent.5] - 2026-11-09

### Changed

- **Doctor shares one bounded set of inputs per run (#730, milestone 2).** Nothing doctor reports changes. Within one run, the upsell selector-scope and SDK markup gates resolve the built-site scope once and read each built page once, and they share one HTML parse per page when the run's pages fit the parse budget. Every spec-page route lookup walks the campaign's source pages once per run instead of once per page per check. `doctor --built` now runs in the same read-only snapshot as packet doctor. What a run keeps is capped, and nested runs count against the same caps: 16 MiB of file bytes and their decoded text across 4,096 files (a file counts three times its size), 64 MiB of parsed pages (estimated at 30 times their source size, so pages share one parse while their HTML totals about 2.1 MiB), 256 shared collections, and four levels of nesting below the outermost run. Past a cap, an input is read or parsed each time it is used, as before. A page set too large for the parse budget is never partly kept, because keeping a few parsed pages slows every later parse. Everything a run keeps is dropped when it returns, so `record`'s inspection after its write reads fresh files.

## [1.66.0+agent.4] - 2026-11-08

### Changed

- **A starter template used as-is keeps its content (F-197).** Told to use a starter as-is, a build agent removed the landing page, the stock reviews, the guarantee, the as-seen-in logos, the countdown and the promo banner, and rewrote the upsell copy. The toolkit pointed it there: the brief summary said "template placeholders removed" and, with nothing to fill them, the guided draft set the promo banner and timer to `none`. As-is now means the template is the design: keep its pages, sections and copy, swap what CampaignSpec owns (product names and images, prices and discount figures, promo codes, store name and support details), fill literal placeholder text from the product, and leave anything that looks like demo content in place, listed in the handoff for the operator to decide.
- **The build prompt states that rule** for every page whose authority is the starter template, and for opted-in template-stock pages. Template-stock pages still need the operator's opt-in per page.
- **The guided brief keeps the template's banner and timer.** With no CampaignSpec surface to fill them, `promo_urgency.header_claim_source` and `promo_urgency.timer_label` default to the new value `template` instead of `none`. A promo code the campaign does not have is still emptied. Question `promo_urgency_copy` gains the option to keep them as the template has them; `none` still removes them. A brief that already sets `none` is unchanged.
- **The brief summary says "template placeholders blocked"** instead of "template placeholders removed", which is what the setting it reports, `template_residue_policy.block_placeholders`, means. Browser QA still blocks literal placeholder text.
- **The countdown keeps its one rule.** In a build with a brief payload, doctor still blocks a countdown rendered without `offer.urgency.verified` (`content_residue.unverified_urgency`); the build prompt and docs now say to blank its label there instead of keeping it.
- **docs/entry-points.md** gains "Using a starter template as-is"; docs/campaign-build-brief.md describes the new default.

## [1.66.0+agent.3] - 2026-11-08

### Added

- Pre-refactor characterization for the doctor shared-input work (#730, milestone 1). Nothing doctor reports changes. Goldens of doctor's current output now cover the built, packet and CI entry points: the certified families, the existing doctor fixtures, and pre-build, partial, capped, conflicting-role, waived and failing cases. Literal commerce-signature v1 vectors and saved Assembly Reports pin `buildCommerceSignature`, `classifyDrift` and the recorded build history byte for byte. `scripts/performance/doctor-cost.mjs` measures doctor's file reads, scope walks, parses and memory without changing source. These are compatibility baselines, so a later refactor that changes a golden is a regression to fix, not a file to regenerate.

## [1.66.0+agent.2] - 2026-11-08

### Fixed

- **QA waits for the SDK to finish rendering before it reads a page.** Network idle was the only wait, capped at 5 s. On a slow SDK boot, QA read a local checkout with its card iframes, its shipping country select and its upsell price block still unmounted. It reported 0 px card fields in `browser-payment-geometry`, `sdk_not_ready` or `missing_route_cta` in `browser-primary-cta`, and a test order blocked on `Missing checkout select: country` with no order placed. A rerun of the same files passed. Now a page that loads the SDK gets up to 15 s more to report ready, by the readiness rule of the contrast checks, both in the browser checks and in test-order page loads. The checkout card check also waits for the card iframe and for `next-loading-spreedly` to clear. Inside a test-order step the wait holds back two 5 s settle allowances of that step's remaining time and takes at most half of the rest. Browser-load evidence gains `observation.sdk_display` (`not_declared`, `ready`, `timeout` or `unreadable`) and `sdk_display_ms` (`docs/browser-observation.md`). A page that never reports ready is read after the cap, as before, and adds up to 15 s to its browser checks.

## [1.66.0+agent.1] - 2026-11-08

### Changed

- Upgrade the optional pixelmatch dependency from 7.2.0 to 8.0.0 (#715). Its color comparison now uses OKLab/HyAB instead of YIQ, so mismatch counts, percentages, heatmaps, and worst-section rankings may change for the same image pair. Review comparisons using the recorded dependency version; do not treat scores from v7 and v8 as directly comparable. Visual differences remain reviewer diagnostics and do not change Polish readiness.

## [1.66.0] - 2026-11-07

Funnels handed off before 1.62.0 can now reach small checks without a test order. To take it, pin `@nextcommerce/campaigns-os@1.66.0`. Nothing changes for a funnel unless a named person runs the new command.

### Added

- **`record baseline` (#716).** `campaigns-os record baseline --packet <packet> --accepted-by "<named person>" --reason "<why>"` accepts a handed-off funnel from before markup hashes as the starting point, one time per funnel. It tests nothing and places no orders. After it, a page-only change owes QA on that page alone, and a commerce-affecting change still owes the full Polish and QA. It refuses a funnel whose last QA was blocked, one where no QA ever completed, one whose records have markup hashes, and one where no full QA is owed.
- **The stage status `baseline_accepted`.** Polish and QA take it from `record baseline`. It ends the ladder, so `next` moves on, but it is never `completed` and never hands a campaign off. What those stages held moves to history, so its purchase proof stops counting. A passing `qa run --page` leaves QA at this status, and only a completed full QA ends it. Progress snapshots read it as `unknown`.
- **Reports say what it is.** Doctor warns `qa.baseline_accepted`, and `doctor --ci`, readback and `next` say QA rests on a baseline and no purchase has been tested since. `evidence_debt.qa` gains `baseline`, and the Assembly Report gains a top-level `commerce_baseline`, which keeps the status, warnings and skip reason of what it replaced.

## [1.65.0+agent.1] - 2026-11-07

Commercial parity now checks `package.price` as well as `bundle.*.price`. Starter upsells use `package.price`, so a funnel could pass every calculate scenario with no printed price compared. No pin change is needed to read verdicts; the behavior ships in the next release.

### Changed

- **`package.price` and `package.<ref>.price` are compared as rendered.** Under `qa run --browser`, each visible node the SDK has filled is compared with calculate's `unit_price` for that package's row on the page. The source holds a template placeholder (`$9.99` on a starter upsell), so the source text is never compared. A difference is the existing warn-only `price-claim-mismatch`. That includes a page printing `package.price`, the list price, beside a live offer.
- **What cannot be compared is named.** A run without `--browser`, a rendered page that showed none of the claims, a visible node the SDK never wrote, or a claim with no package id, no single exact row or unreadable text each writes a `commercial-parity:incomplete:<code>` warn row and never a mismatch. A run without `--browser` on a page with these claims now reads `incomplete`, so it stays at `ready_with_exceptions`.
- `verdict.commercial.package_price_claims` counts these claims, and they count toward `extracted_price_claims`, `compared_price_claims` and `unresolved_price_claims`. Journey rows from the `./commercial-journey` export carry `unit_price` when calculate sends it, and captures from `./commercial-parity` carry `package_price_claims`.

## [1.65.0] - 2026-11-07

A QA run whose commercial parity stopped short no longer reads as a clean result. Commercial status `incomplete` now keeps the verdict at `ready_with_exceptions` and names the cause and the fix in `exceptions[]`. It stays warn-only: nothing new blocks, and the exit code does not change. To take it, pin `@nextcommerce/campaigns-os@1.65.0` and refresh the installed skills to `1.65.0+skills.1`.

### Changed

- **Incomplete commercial coverage is an exception.** A spec with no `campaign.campaigns_api_key`, for example, used to run 0 of its calculate scenarios and could still report `ready`, with the gap visible only under `verdict.commercial`. The verdict is now `ready_with_exceptions`, with a warn row `commercial-parity:incomplete:missing_campaigns_api_key` whose `actual` says what was not compared and how to fix it.
  - A cause an earlier one already explains writes no second row, so a missing key does not also report every page as unpriced. Read the row for what to do: the set of codes is not a contract.
  - Not every cause has a repair. A store coupon, two bound prices on one page, a run in a currency other than the Map's and a funnel over the check's limits say what this run did not compare, and these runs stay at `ready_with_exceptions`.
  - The committed sidecar keeps the row's id, which names the cause. The verdict's `commercial` section gains `incomplete_reasons` with the same causes, and `qa run` prints them under its commercial line.
  - A run that was `ready` only because the gap was invisible now records its QA stage as `completed_with_warnings`, and its Run Record lists `pricing` among its gap classes. Both dispositions still end a run session.
- **A crash in the commercial check is reported the same way.** It used to leave status `not_run` and the verdict untouched, with a line on stderr. It now reads `incomplete` with the cause `commercial_runner_error`. Runs a gate blocks keep `not_run`, since those verdicts are already `blocked`.
- The verdict schema's `disposition` and `commercial.status` descriptions say the above, and it documents `commercial.incomplete_reasons`.

## [1.64.0] - 2026-11-07

Developers changing a live funnel from a fresh clone can now get going, and the reports say what they compared. To take it, pin `@nextcommerce/campaigns-os@1.64.0`, run `spec fetch` once on each repository set up from a saved Map, and commit the file it writes. These come from the first post-handoff trial on #716.

### Added

- **`spec fetch` (#716).** `campaigns-os spec fetch --packet <packet>` restores a saved-Map packet's CampaignSpec on a checkout that lacks it, by the same fetch intake makes. It never replaces a copy on disk, because that copy can hold `spec derive` edits the Map doesn't have, and it doesn't write the packet or the records. Its `bound` result says whether the copy matches the spec the records were made against. A doctor `spec.local_path` error for a missing Map copy now names the command.
- **`built_output.absent` doctor warning (#716).** When the build stage is complete and `_site/<route>/` isn't there, doctor says the records were not compared with this checkout, and `next` says so at `done`. A fresh clone used to read as finished however much source had moved.

### Changed

- **The fetched CampaignSpec is committed (#716).** `.campaign-runtime/fetched-specs/` leaves the managed `.gitignore` block, and an existing block loses the line on the next setup command or `spec fetch`. The committed records are bound to this file and `spec derive` writes into it, so another machine can't rebuild it from the Map once it has been derived.
- **`doctor --ci` names what it compared (#716).** Each owed stage's report line gives the build it last checked, with the date when QA completed. When the latest change alone is page-only but an earlier rebuild since that check wasn't, the report names that rebuild, so it no longer seems to contradict `record build`. `evidence_debt.<stage>.change` gains `commerce_rebuild`, and `evidence_debt.qa` gains `reviewed_at` when QA completed, each only when there is a value.
- **Clearer wording for a pre-1.62 build (#716).** `commerce_signature_unavailable` now reads as a build from before the markup hashes existed.

### Fixed

- **The docs on pre-1.62 records (#716).** They said such a change reads as `unknown` until `record build` records a signature. It reads as `commerce_affecting`, and `record build` doesn't clear it. Page-only changes start after one full QA on 1.62.0 or later, and the docs now say so.

## [1.63.0+agent.1] - 2026-11-02

The `PagePackage` type accepts `prices: null`, as the schemas and the `PackageCurrencyPrices` rule already did. No pin change is needed to read specs; TypeScript callers that pass `null` stop failing type checks on the next release.

### Fixed

- `PagePackage.prices` is typed `PackageCurrencyPrice[] | null`, like the package's other nullable fields. Schemas v4 and v5 allow `null`, and the rule treats it as absent, so a spec that validated could fail to type-check. (#714)
- The authoring guide's `prices[]` section says to refresh the Map after any price change: `spec derive` refreshes `price` and `price_retail` but not `prices[]`, so a default-currency change otherwise leaves `price` and that currency's `prices[]` entry disagreeing.

## [1.63.0] - 2026-10-31

CampaignSpec can carry a page package's price in each currency the campaign sells in, and validation warns when a package has no price in one of them. To take it, pin `@nextcommerce/campaigns-os@1.63.0` and refresh the installed skills to `1.63.0+skills.1`; the skill text changes only in its stated revision.

### Added

- **`prices[]` on a page package (#714).** A row in `funnels[].pages[].packages[]` may carry `prices: [{ currency, price, price_retail?, price_recurring? }]`, one entry per currency the Campaigns App prices the package in, read from the Campaigns API in that currency (`GET /campaigns/?currency=<code>`). `price` and `price_retail` stay the default currency's. The field is optional and additive in schemas v4 and v5 and in the `PagePackage` type (with `PackageCurrencyPrice`), and the authoring guide's Campaign Currencies section shows it.
- **`PackageCurrencyPrices` rule (#714).** A warning, tagged `fast` and `spec-only`, so `doctor` and Map Builder both run it. For a row that carries `prices[]`, it reports a currency in `campaign.available_currencies` or `campaign.currency` with no entry, since the Campaigns API leaves an unpriced package out of the campaign in that currency; an entry without an ISO 4217 `currency` and a non-negative decimal `price`, or with a malformed `price_retail` or `price_recurring`; and a currency listed twice. A row without `prices[]` (absent or null) is not checked, and malformed campaign currency codes stay with `CampaignCurrencies`.

## [1.62.0] - 2026-10-30

This release makes the path from a Map to a working campaign shorter to start and cheaper to maintain. CampaignSpec validation catches a checkout nothing sells into and malformed currencies, and it carries the starter templates' analytics vendors. One project can hold several funnels. After handoff, `spec derive` keeps the spec in step with the repo's pages and the live campaign. A change to some pages' copy owes QA on those pages only. `qa run --test-order` holds test purchases back from the analytics vendors it can intercept (all of the template vendors except Northbeam), and `qa run --currency` blocks when the currency did not take. To take it, pin `@nextcommerce/campaigns-os@1.62.0` and refresh the installed skills to `1.62.0+skills.1`.

### Changed

- **Several funnels in one project (#719).** The first funnel set up in a Page Kit project keeps `campaign-runtime.build.json` and `.campaign-runtime/`. Each later funnel gets `campaign-runtime-<route>.build.json` and keeps its Build Context, Assembly Report, doctor output, theme output, inputs, QA verdict sidecar and Run Records under `.campaign-runtime/funnels/<route>/`, which the packet records as `assembly.runtime_dir`. Every `--packet` command reads and writes that funnel's records.
  - `readback` without `--packet` refuses, naming each packet and its route, when the project holds more than one funnel. `tooling status` then reads no packet pin.
  - `prepare-build` no longer replaces another funnel's Build Packet, including one named with `--out`. `--force` replaces it on purpose: `prepare-build --out campaign-runtime.build.json --force` renames the route of a project's first funnel and keeps its records where they are. When a new route is set up beside an existing funnel, prepare-build prints a `Funnel:` line with the rename steps.
  - Two funnels set up at the same moment no longer collide: the run that waited for the target lock stops and asks to be run again.
  - Existing single-funnel projects read their records where they already are, with no setup rerun. The managed `.gitignore` block gains `.campaign-runtime/funnels/*/run-records/`.
- **`spec derive` after handoff (#721, #531).** A campaign is handed off once its deploy or its QA has completed. From then on derive adds a page the page tree builds that no spec page binds (id from the file name, type from its page-kit `page_type`; a checkout file with `next_step` is added as a `checkout_step` when it has a `step_number`, as a `checkout` that forwards to the Checkout in a v4 spec, and as a `select` page when it has none), removes a page whose built file is gone (matched by page id), and sets the routing on the edges that name those pages from the page files' `next_url` / `decline_url` / `next_step` frontmatter, rewriting the matching `sdk_hints.meta_tags` routing hint. A page file that is gone while a new file of the same page-kit `page_type` appears is read as a rename: neither change is applied and derive reports `page_renamed`, so the page's authored packages and offers are kept. Page order is reported as not derived, and so are an added page's packages (`page_packages_not_derived`): they are authored, and doctor blocks on `CheckoutPathHasPackages` or `UpsellHasPackages` until they are set.
  - Once the campaign is built, derive makes the same read-only `GET /api/campaign` doctor makes and refreshes the fields the spec mirrors from the Campaigns App: each page package's name, price, recurring price, product, variant and availability, the offer records, and each page's offer copies. Which packages and offers a page carries stays authored, and a price never comes from the repo. `--no-live-refs` sends nothing; `--proxy-base` names the proxy. The effects contract declares the read on both `spec derive` rows and advances its `contract_version` to 1.3.0, because an existing row's declared effect changed.
  - `record spec` binds a move of page routes: it re-projects every page's page-kit target in the packet and the Build Context and rewrites the Design Source Package's page surfaces and references. On a handed-off campaign it also binds a page added or removed, without intake. A respelling that projects to the same targets keeps the build, Polish and QA. A `record spec` that stopped part way is finished by the next one. It refuses a change that moves the route root or slug, leaves a routing hint stale, puts two pages on one target, or would rewrite a Design Source Package that prepare-build did not synthesize or that was edited since.
  - Doctor blocks when a routing hint (`next-success-url`, `next-upsell-accept-url`, `next-upsell-decline-url`) names a route its page no longer has (`spec.routing_hint_stale`). `spec derive` and `record spec` use the same check.
- **Small changes owe small checks (#720).** After launch, a change that touches only some pages' HTML and leaves checkout pages, commerce markup, routes, scripts and the campaign's Page Kit config entry alone owes QA on those pages only, and Polish is advisory for it. Any other change still owes the full Polish and QA. A page-only change extends only a review that completed and that no brief or spec change has made owed since.
  - `record build` keeps `stages.assembly.commerce_signature` (one hash per page over its commerce-bearing markup, plus the config entry) and `stages.assembly.build_changes`, each rebuild classified `page_only`, `commerce_affecting` or `unknown`.
  - Readback's `evidence_debt` gives each owed stage a `change` object; Polish gains `advisory`, QA gains `scope` and `owed_pages`, and `clean` ignores advisory Polish. `doctor --ci` names the change it found and what each stage owes.
  - New `qa run --packet <packet> --page <page_id>` (repeatable) checks only the named pages and places no test orders. It pays the page-only debt and keeps the purchase proof of the full run it extends. It refuses a commerce-affecting change, an unrecorded rebuild, a changed page left out, a last QA that did not complete, QA that a `qa_policy` or CampaignSpec change owes, and `--test-order` or `--vendor-beacons`.
- **Analytics vendors in the spec (#689).** The CampaignSpec types and both schemas add `analytics.vendors.<vendor>` for the starter templates' adapters (GA4, AppLovin Axon, Taboola, Triple Whale, TikTok, Northbeam, Snapchat, Pinterest) in the shape Map Builder saves: `enabled`, `id`, `platform`, `identityEnabled`, `allowedEvents`, `blockedEvents`. `AnalyticsContractShape` warns on an unknown vendor, an enabled vendor without an id, and event lists that are not arrays. `spec derive` copies each vendor's `_data/campaigns.json` id key (`ga4_id`, `triplewhale_name` and the rest) into `analytics.vendors.<vendor>.id` with the same empty-value and placeholder rules as GTM and Meta. The new advisory doctor check `page_kit.analytics_vendors` warns when the spec and `campaigns.json` disagree about a vendor or its id.
- **Test orders stay out of vendor reporting (#689).** `qa run --test-order` answers requests to the known beacon endpoints of GA4, Meta, TikTok, Snap, Pinterest, Taboola, Triple Whale and AppLovin Axon with a local empty response in every browser context it opens. Loader scripts still load, and those contexts block service workers. The new `browser-test-order:vendor-beacons` row records per vendor how many requests the page sent, whether one named a purchase, and the ids and events, and it lists configured vendors that sent nothing, that it cannot observe, or that are not intercepted (Northbeam, whose beacon host is unconfirmed). The row is evidence that the page sent them, never purchase proof, and it never blocks. `--vendor-beacons live` sends them to the vendors; it is refused without `--test-order`. `qa parity` orders are not intercepted.
- **`qa run --currency` checks the currency took (#713).** Each test order gets a `browser-order-currency:<path>` row that blocks when the order came out in another currency or recorded none. Commercial parity asks for expected totals in the run currency, and a calculate response in another currency is a `commercial-currency:<RUN>:<ANSWERED>` blocker. When the run currency is not the Map's, the fallback prices in the page source are left unresolved instead of compared. Runs without `--currency` are unchanged.
- **Polish layout conventions (#700).** At the mobile width, Polish warns (`layout.conventions`, acceptable with `checkpoint accept`) when a fixed or sticky CTA bar holds more than its one link or button (`floating_cta`), and when a purchase, accept or submit label is under 16px (`cta_label_size`). The thresholds live in a new `layout_conventions` block in the shared commerce brand contract. Readability records captured before this release show the check as not captured until the next `polish capture`.
- Skills: `next-campaigns-qa` covers default beacon interception, the `--currency` blockers and page-scoped QA; `next-campaigns-sdk-bump` the beacon default and the currency blockers; `next-campaigns-os` per-funnel records, `spec derive` after handoff and the page-only exception to full Polish and QA; `next-campaigns-os-setup` and `next-campaigns-build` setting up and building a later funnel; `next-campaigns-polish` the layout warnings. The QA and Polish skills read a later funnel's brief and report under its runtime directory. The installed agent context names the page-scoped QA path. Bundled skills advance to `1.62.0+skills.1`.

### Added

- **A checkout something sells into (#711, #206).** New CampaignSpec rule `CheckoutPathHasPackages`: every path from an entry page to a Checkout must pass a page with a main-cart package entry (one marked neither `is_upsell` nor `is_order_bump`). Bump rows alone, and packages on upsell, downsell or thank-you pages, do not count. Paths follow routing fields, never page order or names. It is an error, or a warning when `build_scope.mode` is `partial`, and doctor reports it as `spec.validation`. The main-cart entry contract is in `docs/template-family-contracts.md`.
- **Currency codes (#714).** New CampaignSpec rule `CampaignCurrencies`: `campaign.currency` and every `campaign.available_currencies` entry must be a three-letter upper-case ISO 4217 code (an error, with the code to write for a near miss such as `"usd"`). A default currency missing from a non-empty `available_currencies` is a warning. The schemas and authoring guide say the spec owns `available_currencies`, listing every currency including the default; the Campaigns App's `additional_currencies` is not a spec field.
- The CampaignSpec schemas and authoring guide say that on an upsell or downsell page every package row is that page's offer, never an order bump, whatever `is_upsell` says (#710). Campaigns OS already read it this way, and tests now hold it.

### Fixed

- Directory locks (#514): a command that finds the target lock or the progress allocation lock held by a live process of another Campaigns OS release refuses at once and names that process (`ELOCKFORMAT`), instead of racing it. Lock owner records carry `lock_format: 2`, so a holder from an earlier release is refused too; dead holders are still recovered. Two releases that start in the same instant are still not detected, so run one release against a target at a time. The holder also removes `.abandoned-<token>` directories left by an interrupted recovery, and an unreadable directory at the lock path is named as such.
- Every command refuses a `--flag=value` token, as it refuses any flag up front, and says to write the flag alone (an on/off flag) or `--flag value`; the message names the flag, never the value. Such a command does nothing first: the stale-session closeout that otherwise precedes argument refusal is skipped, as it is for a valued `--dry-run`, because the token's value (a `--packet`, `--target` or `--proxy-base`) is not read. Under `doctor --ci` the refusal is a usage error (`doctor.ci.usage`, exit 2). The shared parser read the token as an unknown key and dropped it, so `qa run --page=upsell1` ran a full QA and `--test-order=common` placed no orders. `standardize`, `page-kit sync` and `spec derive` already refused it as an unknown flag.
- 1.61.0 residuals (#707): the changed-page list survives `record build`; a reference refused for its location keeps its `location` on a stale-bound row; the readability reader passes an undefined `buildOutput` through unchanged.

## [1.61.0+agent.2] - 2026-10-29

The `next-campaigns-sdk-bump` skill (1.0.7) takes the findings from its third live run, the first on a static repository. Step 3 now has a table of known changes a bump can cross, and step 6 names the 3-D Secure test card. `sdk storage-check` no longer fails on large repositories, and its inventory error now says why. Refresh installed skills with `install-skills` to get it.

### Changed

The `next-campaigns-sdk-bump` skill (1.0.7, bundle `1.61.0+skills.2`) takes the third-run findings on campaigns-os#683:

- Step 3 has a table of known changes by version. 0.4.32: the checkout page no longer emits `order:completed` when it creates an order. The skill prefers the SDK's `dl_purchase`, which fires once per order; a capture that stays hand-wired moves to the first page after checkout, reads the order by the order's `?ref_id=`, and sends once per order, and step 6 reloads that page once with beacons blocked to prove it. 0.4.41: the card fields are Spreedly's hosted fields loaded by NEXT's payment script, so a page's own Spreedly `iframe-v1.min.js` tag, calls on the `Spreedly` global and CSS aimed at the v1 frame ids are removed or ported in the same commit as the pin move, after confirming the campaign has a payment key. 0.4.42 points at the `next:initialized` guard and 0.4.43 at the Shop Pay check. A page with a hand-written `modulepreload` list of SDK files rebuilds it from the target tag's `dist/` or removes it.
- Step 6 names the 3-D Secure test card from `docs/qa-and-test-orders.md`, links the platform's testing page, and asks the developer to confirm the gateway is in test mode before placing the order.
- Step 4 says that the old storage-check failure below means the pinned Campaigns OS is npm 1.61.0 or earlier, to update the pin, and not to run the check on a copied repository, which can lose tracked files.

### Fixed

- `sdk storage-check` lists only the tracked files under `--scope` (`git ls-files -- <scope>`), so a large repository no longer passes Node's 1 MiB default buffer. Before this, a repository with more than about 25,000 tracked paths stopped with `Cannot inventory tracked Git source files.` (#717)
- That error now reads `Cannot inventory tracked Git source files: <reason>`, with Git's first stderr line as the reason, or, when Git printed nothing, how it ended (its exit status, the signal that stopped it, or a spawn error code), or a request to narrow a scope whose list passes 256 MiB. `docs/sdk-storage-compatibility.md` says so.

## [1.61.0+agent.1] - 2026-10-24

### Changed

The vendored starter catalog is re-synced to campaign-cart-starter-templates `5711e22` (was `b38343e`). That range carries:
- campaign-cart-starter-templates#246: tiered offers use one shipping method plus a free-shipping card coupon, in place of a separate free-shipping method. The CampaignSpec fixtures follow.
- campaign-cart-starter-templates#248: the Apollo Template Reference is re-stamped `sdk-0.4.43-shipping-coupon-tiers-2026-10-23`.
- campaign-cart-starter-templates#250: the MV families' `removeWhenUnsupported` names `variant_slots[].vouchers` for the tier coupon, as the bundle families do, in place of the removed free-shipping row.
- #247, #249 and #251: recorded SDK 0.4.43 verification evidence.

The certified-family fixtures are regenerated at the pin with page-kit 0.3.0, which is what the starter repository now pins. They were last rendered at `3987b18` with page-kit 0.2.0. The payment-chrome `asset_pin` moves to `5711e22`. Its five images have the same bytes there, so no hash changed. Two test files no longer depend on starter data that moved: the live-campaign drift tests give their saved Map its own second shipping method, and the Apollo Template Reference test reads the expected stamp from the catalog. The two payment-chrome tests pass again because the pin moved. The SDK pin and the support policy do not change.

## [1.61.0] - 2026-10-23

This release gathers the whole 1.60.0 line into one installable version and adds two things of its own. Intake now records a declared design file as the authority for a page, and Polish reports element-level differences between the source render and the built page as warnings an operator can review. To take it, pin `@nextcommerce/campaigns-os@1.61.0`, refresh the installed skills to `1.61.0+skills.1`, and run `polish capture` again before the next completed Polish record. Doctor cannot open design files yet, so a recorded file reads `unexercised` rather than verified.

### Changed

- Publishes `1.60.0+agent.1`: `qa run --site` requests the campaign's pages under `/<slug>/` instead of joining each route straight onto `--base-url` (campaigns-os#683).
- Publishes `1.60.0+agent.2`: `analytics-correctness:tag:meta` passes when the declared Meta pixel initialises and tracks in the page even if no `facebook.com/tr` request is seen; a replaced `fbq` reads `unmeasured` (campaigns-os#686).
- Publishes `1.60.0+agent.3`: doctor's SDK markup check gains the `PAGE_TYPE_ATTRIBUTE` and `UPSELL_PAGE_TYPE_MISSING` advisories, because the SDK reads the page type only from `<meta name="next-page-type">` (campaigns-os#683).
- Publishes `1.60.0+agent.4`: the `next-campaigns-sdk-bump` skill takes the second-run findings on campaigns-os#683 (per-slug live status, the reload bar, the market pin, vendor beacon disclosure, up-front gate answers), and doctor's SDK attribute index moves to Campaign Cart v0.4.43.
- Publishes `1.60.0+agent.5`: `qa run`'s test customer and shipping address flags are documented and supported, and a non-USD `--currency` with no `--test-country` warns (campaigns-os#683).
- Publishes `1.60.0+agent.6`: `sdk storage-check` names an out-of-range `--target-sdk` up front and marks SDK prefix loops in its report (campaigns-os#683).
- Publishes `1.60.0+agent.7`: installed users receive the quickstart, access, source-adapter and CampaignSpec authoring guides, and the package check verifies documentation links and headings inside the installed package.
- Publishes `1.60.0+agent.8`: readback reports when a changed build requires Polish or QA again, and `doctor --ci` reports that evidence debt for campaign pull requests. Installed agent context describes revising a live campaign and renewing its evidence (campaigns-os#695, campaigns-os#699).
- Publishes `1.60.0+agent.9`: completed Polish requires current package captures, with a captured build screenshot for every planned route; source renders are captured beside them for comparison. The review handoff includes visual reference warnings and image differences for operator review; pixel scores do not decide fidelity (campaigns-os#696).
- Publishes `1.60.0+agent.10`: the brand theme carries the design source's fonts and button radius onto commerce pages. `theme generate` writes `brand-fonts.css` beside `brand-theme.css`, and `record theme` refuses a styled commerce page that doesn't load it (campaigns-os#703).
- Intake records a manifest `design_file` as the page's authority and its HTML export as derived from that file; a Figma spec `design_source` records that lineage only with figma-sections-export provenance that passes doctor's `source_html.producer_provenance` check without a waiver. This version cannot read design files, so `design.access` reports `unexercised` with `design_access_missing` for a recorded file and explains how to continue or compare the export and file by hand; a changed design file or conflicting declaration is listed for review; an absent declaration reports `design_reference_missing`, with recovery by restoring it or rerunning intake with `--force` to drop the recorded file (campaigns-os#697).
- Polish probes the source and built renders and reports element-level differences in geometry, typography, colour and copy as warnings an operator can review and accept; they never block Polish or change readiness (campaigns-os#697).
- The readback schema now describes the optional `evidence_debt` field, its `current`, `owed` and `unknown` stage statuses, reasons and changes against the retained assembly manifest. Any owed Polish or QA stage makes `clean` false; unknown debt still needs review when `clean` is true.
- Bundled skills advance to `1.61.0+skills.1`.

## [1.60.0+agent.10] - 2026-10-23

The generated brand theme now carries the design source's fonts and button radius onto the commerce pages, where before it carried only the colours. `theme generate` writes a second file, `brand-fonts.css`, beside `brand-theme.css`. Copy it into the campaign's `assets/css/` and load it on the same pages, because `record theme` refuses a styled commerce page that does not load it. A source that ships no font files of its own gets the same CSS as before.

### Changed

Brand theme carries the design source's type onto commerce pages, not only its colours:

- `theme inspect` / `theme generate` read the `@font-face` rules the source ships and the families its headings, body copy and buttons use, plus the button `border-radius`. `var()` references resolve through custom properties on `:root`, `html`, `body` and the class a stylesheet scopes itself under (the importer's `.cc-import`). They map to next-core's `--_text---font-family--heading`, `--_text---font-family--primary` and `--radius-size--buttons` (new `typography` block in `contracts/brand-theme-target-tokens.next-core.v0.json`). Each family is followed directly by the generic the source declared for it. A family is mapped only when the source ships a face for it; one that can't ship is a `theme.typography.face_unavailable` warning and is listed in the report's `typography.unavailable`. The radius takes `0` or one to four lengths or percentages, lists any other button radius in `typography.radius_rejected`, and is mapped only alongside a family, so a source without brand faces generates the same CSS as before.
- The font-family tokens are emitted in a `:root, body` block, because next-core re-declares them on `body` at its 991, 767 and 479px breakpoints and a `:root`-only value held on desktop alone. `validateGeneratedCss` accepts that block.
- `theme generate` writes `.campaign-runtime/theme/brand-fonts.css` beside `brand-theme.css`: only `@font-face` rules for the mapped families, always with `font-display: swap`, every format of a face kept, and URLs relative to `assets/css/`. Remote, `data:`, root-relative, missing, or outside-root face files (checked on real paths, so symlinks out are caught) are left out with `theme.typography.face_src_dropped`. The theme report gains `typography`, and `generated.fonts_css_path` names the file.
- `record theme` refuses a styled commerce page that doesn't load a copy of the generated `brand-fonts.css` (found through the Build Context's `theme.generated.fonts_css_path`) from inside the built site, identical to the generated file, naming the page. The theme gate's generate/apply actions, the build guidance, `docs/brand-theme-bridge.md`, and the build (1.0.50) and polish (1.1.50) skills say to copy and load it. Polish now checks font parity at a mobile width as well as desktop.
- The skills bundle revision advances to `1.60.0+skills.5`, and every bundled skill moves one patch version.

## [1.60.0+agent.9] - 2026-10-23

`polish capture` now takes its own screenshots of every mapped page and of its source HTML, at desktop and mobile widths, and compares the pairs section by section as a review aid. A completed Polish record needs those captures, so after upgrading run `polish capture` again before `record polish`; screenshot paths written by hand no longer count. The comparison is a diagnostic only. It never passes, fails or blocks anything, and older Polish records are read as before.

### Changed

`polish capture` now takes its own full-page captures of each mapped page and of the page's source HTML at desktop and mobile widths, verifies the source screenshots recorded in the Design Source Package, and compares compatible pairs section by section as a review diagnostic with a heatmap. `record polish` now requires these package captures for a completed Polish, including at least one rendered build cell with a captured actual shot for every planned route. Agent-written screenshot paths no longer satisfy the screenshot check for a new record, so run `polish capture` again after upgrading. Polish records written before this version are read as before. The source HTML render runs offline: it reaches only a local read-only server, and requests, WebSocket connections and host-name lookups to anything else are blocked. Source screenshots or pages that are the build's own output are reported as self-referential warnings. Width or pixel-ratio mismatches are reported as unsupported, never resized. The comparison never passes, fails or blocks anything. `pngjs` and `pixelmatch` are new optional dependencies; without them captures are still taken and the comparison is listed as unavailable. Capture images are kept out of the repository by a `.gitignore` inside each capture folder.

The Polish skill is 1.1.49, bundle `1.60.0+skills.4`.

## [1.60.0+agent.8] - 2026-10-23

Readback now tells you whether the Polish and QA records still match the build on disk, in a new `evidence_debt` field: `current`, `owed` or `unknown`. `doctor --ci` reports the same debt as Markdown or JSON for a pull request check, with an example workflow under `docs/examples/`, and exits 3 when a stage is owed. Before revising a live campaign, read readback and renew any owed stage; the installed agent context now describes that procedure.

### Added

Readback's additive `evidence_debt` field and text section show whether Polish and QA bind to the build on disk: `current`, `owed`, or `unknown`. Changed pages and other changed files are listed against the retained assembly manifest. An empty page list does not clear an owed stage. Missing or unreadable output or a missing assembly fingerprint leaves stage debt unknown. Otherwise a lifecycle-recorded `required` stage is owed (reason `stage_required_by_build`, `stage_required_by_brief`, or `stage_required_by_spec` from `required_by`, and `stage_required` for an absent or unrecognized source), even without a stage fingerprint; other missing stage fingerprints leave debt unknown. A missing or unusable manifest leaves only page changes unknown; matching stage bindings remain current unless required, and differing bindings remain owed. This build comparison is independent of readback's time-based staleness. Either owed stage makes `clean` false (campaigns-os#699).

`doctor --ci --packet <packet> --no-live-refs` reports the same evidence debt as Markdown for a PR comment, or under `ci` with `--json`. It exits 0 when both stages are current, 3 when either is owed, 4 when debt cannot be determined, and 2 when the packet is missing or unreadable. Other doctor findings remain visible without changing the CI exit code. The check does not renew evidence or deploy (campaigns-os#695).

The workflow example at `docs/examples/campaign-repo-evidence-check.yml` installs locked dependencies, builds the campaign, runs the check and posts or updates one PR comment. Evidence findings are report-only by default; set the repository Actions variable `CAMPAIGNS_OS_EVIDENCE_CHECK` to `fail` to enforce them. Install and build failures still fail normally and replace the comment with a fixed "build failed; evidence not evaluated" message when doctor did not run. A comment-permission failure leaves the report in the job log (campaigns-os#695).

### Changed

The installed agent context for all four supported harnesses gains a live-campaign revision section: read readback and `next` before editing, follow the Design Source Package, rebuild and record the build before capturing and recording Polish, run QA when owed, and show each changed page's design reference beside its preview in the PR. `install-agent-context --dry-run` previews each destination and its full content without writing files; `--json` carries the same preview (campaigns-os#699).

## [1.60.0+agent.7] - 2026-10-22

The npm package now ships the quickstart, access model, entry-point, source-adapter and CampaignSpec authoring guides, so links from the Build Packet and the README resolve inside an installed copy instead of pointing at files that are not there. The package check follows those links and their headings, so a guide missing from the package now fails the check. Runtime behaviour is unchanged.

### Fixed

The installed package now includes the existing quickstart, access model, entry-point, source-adapter and CampaignSpec authoring guides. Links from the Build Packet and README continue inside the package; repository-only evaluation, architecture and case-study references point to GitHub. The authoring guide links the shipped v5 schema and public multi-step examples, which remain repository test data.

The package check follows relative documentation links and checks destination headings against the extracted tarball, so a source-only guide or renamed anchor cannot leave installed users at a dead end. It ignores illustrative code and does not fetch external links. Runtime requirements and campaign behavior are unchanged.

## [1.60.0+agent.6] - 2026-10-22

`sdk storage-check` is clearer about two things. When the `--target-sdk` you ask about is outside the manifest's supported range, the report says so in its first line and the result stays `unknown`, so you know the scan did not speak for that version. Unknown findings inside a loop that scans storage keys by an SDK prefix are marked `[prefix loop: <prefix>]`, with one note explaining why they stay unknown. Exit codes and the commands you run are unchanged.

### Changed

`sdk storage-check` output, from Sam's findings on campaigns-os#683:

- When `--target-sdk` is outside the manifest's supported range, the human report's first line reads `checked against SDK <range>, not the requested target <x.y.z>`, the next line says the report does not speak for that target, and the count line repeats it. The result is still `unknown` and the exit status still 2. `--json` adds `targetCovered`.
- An unknown `dynamic-key`, `unsupported-storage-method` or `storage-object-escape` line inside a loop that matches the keys it reads from storage by a scoped SDK key's prefix (`k.indexOf('next-cart-state') === 0`, `k.startsWith(...)`) ends in `[prefix loop: <prefix>]`, and `--json` adds `prefixScan` to the finding. A key read from storage is a `k = sessionStorage.key(i)` variable, a for-of over `Object.keys(sessionStorage)` or for-in over `sessionStorage`, or the element parameter (the second for `reduce`) of a callback chained on `Object.keys(sessionStorage)`. Only the line where that key came from, or a line that reads that key by name, is marked; other storage use in the loop, such as passing `sessionStorage` to a function, is not. One note under the findings explains them: the loop survives the scope suffix, but on a shared origin the prefix also matches another campaign's copy, so the lines stay unknown. Where the manifest names a public store for the key, the note names it.

## [1.60.0+agent.5] - 2026-10-22

`qa run` has always accepted flags for the test customer and shipping address; they are now in `qa help` and the QA docs. Use `--test-country`, `--test-address1`, `--test-city`, `--test-province` and `--test-postal`, plus the name and phone flags, to place test orders against a non-US market; the default is a US address. A non-USD `--currency` with no `--test-country` now warns on stderr but still runs. A checkout with no province select for the chosen country still fails at that field, so those orders are placed by hand.

### Changed

`qa run`'s test customer and shipping address flags are now documented and supported (campaigns-os#683 review). The order runner has always read them; none was in the usage text or the QA docs. `--test-first-name`, `--test-last-name`, `--test-phone`, `--test-country`, `--test-address1`, `--test-city`, `--test-province` and `--test-postal` are listed in `qa help` with their defaults (a US address in Mountain View, CA), and `docs/qa-and-test-orders.md` gains a "Test customer and shipping address" section with a non-US example. The province select is a required step, so a checkout with no province select for the chosen country fails at that field; those orders are placed by hand.

A non-USD `--currency` on a `qa run` that places orders, with no `--test-country`, now prints a warning on stderr naming the address flags. The run is not refused. Only the missing flag is checked, since a currency such as EUR has many markets.

`qa run --site` lists `--currency <code>` in its usage line, and a test now proves it: the slug's entry page is fetched with `?currency=<CODE>` and the verdict records `evidence.currency` on that page's `http:` row.

The `next-campaigns-sdk-bump` skill (1.0.3, bundle `1.60.0+skills.3`) names the address flags in step 6 as the way to run non-US orders through the runner, with ordering by hand as the fallback.

## [1.60.0+agent.4] - 2026-10-22

The `next-campaigns-sdk-bump` skill (1.0.2) takes the findings from its second live run. It now reads each slug's live or retired status from the target's `CLAUDE.md` and asks when that is unclear, confirms the market before the first order, names the analytics vendors that will receive real purchase events from test orders, and asks its browser and install questions up front. Refresh installed skills with `install-skills` to get it. Doctor's SDK attribute index moves to Campaign Cart 0.4.43, which has the same `data-next-*` names as 0.4.42, so pages pinned to 0.4.43 pass the placeholder check.

### Changed

The `next-campaigns-sdk-bump` skill (1.0.2, bundle `1.60.0+skills.2`) takes the second-run findings on campaigns-os#683 and a review of them:

- Step 1 reads each slug's live or retired status from the target repository's `CLAUDE.md`, root first. A missing or unclear status is never read as live or retired: the skill lists those slugs and asks. Before any order, it shows the developer the live slugs and the orders planned on each, and orders only on the list they confirm.
- The reload bar in step 6 is one fresh load and five cached reloads of every SDK page, upsells included, with the counts in the hand-back. The receipt, and any page with a hand-wired purchase push or `order:completed` listener, is left out of the cached reloads, because upsell pages reload the order and can resend a real purchase on each load; purchase events are counted across the run.
- The first page carries `?currency=<main>&country=<main>`. The SDK picks the market by IP and never reads browser geolocation, so the geolocation step is gone. The skill says `?country=` needs `currencyBehavior: auto`, and that an unsupported value falls back without failing, so the shown market is confirmed before the first order. `qa run` takes `--currency <main>`, which pins only each funnel's entry page.
- `qa run`'s own test orders use a US shipping address by default, so for a non-US main market the orders are placed by hand, with both parameters on the first page of every new tab.
- Test orders send real purchase events to every analytics vendor the campaign configures unless beacons are blocked at the network, and `qa run` does not block them yet. The vendors, read from the slug's `_data/campaigns.json` ids and `config.js` on Page Kit or the page's inline config on a static funnel, are named in the test-order question, with a note that GTM-fired tags, hand-wired pixels and server-side conversions may also receive them, and again in the hand-back. `?ignore=true` is ruled out: it turns off the SDK's analytics, `dl_*` included, for the rest of the session.
- The install-browser, `--browser` and local-only answers are asked up front, so a no-packet bump does not skip the `qa run --browser` pass by default. `doctor --built` runs once per bumped slug and `qa run --site` once per live slug. `--family` must exactly match a template brand contract shipped in the package or a private family in `contracts/private-template-sources.json` (which needs its repository checked out or `PRIVATE_TEMPLATE_SOURCES_ROOT`), and `--slug` a key in `_data/campaigns.json`; otherwise the skill asks.
- Step 3 lists payment and express methods the range adds (0.4.43 adds Shop Pay), and step 6 starts and cancels each one the campaign offers.
- The skill asks before the first project-local install, pins a reviewed version whose bundle revision matches the skill, and says to expect and commit the `devDependencies` and `package-lock.json` change. In a static repo it never installs into the publish root. `tooling status` only reads the pin.

Doctor's SDK attribute index now names Campaign Cart v0.4.43 (`docs/build-packet.md` says so). Regenerated from the source at that tag, it has the same 149 `data-next-*` names as v0.4.42. The cart placeholder renderers are unchanged too, so pages pinned to 0.4.43 pass the placeholder check instead of reading unexercised.

## [1.60.0+agent.3] - 2026-10-21

Doctor now warns when a page sets `data-next-page-type` but has no `<meta name="next-page-type">`, and when an upsell page's meta is missing or is not `upsell`. The SDK reads the page type only from the meta tag, so without it an upsell page runs as a product page and records no upsell page view. Both are warnings and block nothing; add the meta tag the message names. `tooling status` also names which harnesses a skills refresh is for.

### Added

Doctor's SDK markup check gains two advisories about the page type (campaigns-os#683), on both `doctor --built` and packet doctor:

- `PAGE_TYPE_ATTRIBUTE`: a page sets `data-next-page-type` but has no `<meta name="next-page-type">`. The SDK never reads the attribute, so the page runs as the default `product` step, and an upsell page records no upsell page view. The message names the meta value to add, `upsell` on a page with an upsell offer, and never a page type the SDK does not have. Before, the attribute only appeared in the list of `data-next-*` names the SDK does not read.
- `UPSELL_PAGE_TYPE_MISSING`: a page with a `data-next-upsell` offer whose `next-page-type` meta is missing or is not `upsell`. The SDK records the upsell page view only from `<meta name="next-page-type" content="upsell">` and has no `downsell` page type, so reports showed the purchase with no upsell view before it.

Both are warnings; neither blocks. The certified templates raise neither.

### Changed

When `tooling status` asks for a skills refresh on some installed harnesses only, the action now names them (for example "for Codex and Shared agent skills; not needed in a session that uses another harness"), so a session in another harness does not take it as its own step (campaigns-os#683).

## [1.60.0+agent.2] - 2026-10-21

`qa run --browser` no longer fails a working Meta pixel. Headless Chromium can run `fbq('init')` and `fbq('track')` without ever sending the `facebook.com/tr` request, so QA now also watches the `fbq` calls in the page and passes the `analytics-correctness:tag:meta` row when the declared pixel initialises and tracks. If page code replaces `window.fbq` so QA cannot see the calls, the row fails as `unmeasured` instead of reporting a clean absence. A Meta Purchase still needs the real pixel request.

### Fixed

`analytics-correctness:tag:meta` now passes when the declared Meta pixel initialises and tracks in the page, even if the browser never requests `facebook.com/tr` (campaigns-os#686). Headless Chromium can run `fbq('init')` and `fbq('track')` with fbevents.js loaded and still send no pixel request, so `qa run --browser` blocked campaigns whose pixel works in real browsers. QA now also watches `fbq` calls in the page: a pixel id counts once it is initialised and a track call follows on the same page.

If page code replaces `window.fbq` so QA can no longer see its calls, and no matching pixel request was seen, the row still fails but now says `unmeasured` and carries `evidence.reason: fbq_observer_disarmed`, instead of reporting a clean absence.

These are unchanged:
- A pixel that initialises but never tracks, or a different pixel id, still fails the row.
- An in-page `fbq('track', 'Purchase')` is not a Meta Purchase fire and supplies no CAPI dedup key; both still need the pixel request.

## [1.60.0+agent.1] - 2026-10-20

`qa run --site` now requests a campaign's pages under `/<slug>/`, as the deployed site serves them. Before this fix it joined each route straight onto `--base-url`, so every page returned 404. If a site QA run on 1.60.0 showed nothing but 404s, run it again on this version. The flags are unchanged.

### Fixed

`qa run --site <repo> --base-url <site origin> --slug <slug>` now requests the campaign's pages under `/<slug>/` (campaigns-os#683). Before, it joined each page route straight onto `--base-url`, so it requested `/checkout/` rather than `/<slug>/checkout/` and every page returned 404. The slug is added the same way packet QA adds it: a base URL that already ends in the slug is used as given, and a slug found from the single campaign under `_site/` is added too.

## [1.60.0] - 2026-10-20

This release packages the ten `1.59.0+agent` sections below. The largest change for a campaign folder is next-campaign-page-kit 0.3.0: the first build on it can change the build fingerprint with no source change, so run `record build` again and expect Polish, deploy and QA to be owed. `install-skills` now also installs `next-campaigns-sdk-bump`, the procedure for moving a campaign to a later 0.4.x Campaign Cart, and that skill takes the lessons from its first live bump. Pin `@nextcommerce/campaigns-os@1.60.0` and refresh skills to `1.60.0+skills.1`.

### Changed

- Publishes `1.59.0+agent.4`: the build-flow doc and quickstart describe the Campaigns App's offer-first setup.
- Publishes `1.59.0+agent.5`: hosted all-template guidance names `record deploy --base-url <route root>` for both deploy targets.
- Publishes `1.59.0+agent.6`: the progress snapshot binds QA to its build through `qc_build_fingerprint`, and the polish gate reads the recorded build only from `stages.assembly.build_fingerprint` (campaigns-os#672).
- Publishes `1.59.0+agent.7`: `run status` always names `next` as the next command (campaigns-os#673).
- Publishes `1.59.0+agent.8`: Campaigns OS adopts next-campaign-page-kit 0.3.0, keeps 0.2.x targets working, and doctor reports page-kit's `assetWarnings`. The first 0.3.0 build can change the build fingerprint; run `record build` again.
- Publishes `1.59.0+agent.9`: the starter catalog is re-synced to campaign-cart-starter-templates `3987b18` (build-time promo banner, `next_step` prefetch).
- Publishes `1.59.0+agent.10` and `1.59.0+agent.11`: the Playwright 1.64.1 / acorn 8.19.0 lockfile bump and repository workflow action bumps (campaigns-os#675, campaigns-os#679).
- Publishes `1.59.0+agent.12`: `install-skills` installs `next-campaigns-sdk-bump`, the 0.4.x Campaign Cart bump procedure (campaigns-os#677).
- Publishes `1.59.0+agent.13`: a CampaignSpec-only change keeps the Polish review of the kept output (campaigns-os#668).
- The `next-campaigns-sdk-bump` skill takes the feedback from its first live bump (campaigns-os#683). When the release range removes a feature the campaign uses, the skill now looks for a documented replacement and stops to ask rather than deleting the call. It guards every `next:initialized` listener for cached reloads, which 0.4.42 no longer replays, and proves them on fresh and cached loads. It judges a legacy page by what drives its cart and checkout, not by the Campaigns analytics script the 0.4.x SDK loads itself, and it explains a storage manifest whose range stops below the target tag. It also names the QA portal post and `--local-only`, keeps `qa-output/` out of commits, mentions `qa install-browser`, and triggers on bump requests in repositories that have their own BUMP.md.
- Bundled skills advance to `1.60.0+skills.1`.

## [1.59.0+agent.13] - 2026-10-19

A CampaignSpec-only change no longer throws away a Polish review of pages it did not touch. When you re-record the build with `record build --deviation-reason` and the output is identical to what Polish reviewed, the completed Polish record is restored instead of staying owed. QA is still owed, because the spec changed. A presentation change or a different build still owes a new Polish.

### Fixed

A CampaignSpec-only change no longer throws away a Polish review of pages it did not change (campaigns-os#668). Before, `record build --deviation-reason` recorded the build, but Polish stayed owed after the re-intake (or `record spec`). The next `qa run` then stopped on `polish.evidence_missing`, and the agent had to retake the same screenshots and re-record the same findings.

Now `record build --deviation-reason` restores the Polish record that the change moved to history, stamped with the current inputs, when all of the following hold:
- the build records the exact output that Polish reviewed (same build fingerprint and source package);
- the record was a completed Polish;
- only the CampaignSpec changed, not the brief's presentation.

These are unchanged:
- QA stays owed, because the CampaignSpec changed.
- A presentation change, a different build, or a build recorded without the deviation reason still owes a new Polish.
- The build is still recorded with a warning and the operator's reason.

## [1.59.0+agent.12] - 2026-10-19

`install-skills` now installs a new skill, `next-campaigns-sdk-bump`: the procedure for moving a campaign from one 0.4.x Campaign Cart version to a later one, on page-kit and static repos. It finds every pin, reads the release diff against the campaign's code, runs `sdk storage-check` and doctor, and proves the bump on a preview with approved test orders. It stops at a 0.3.x pin or the legacy Campaigns script, because those are migration work. Run `install-skills` to get it; the bundle is `1.59.0+skills.4`.

### Added

`install-skills` now installs `next-campaigns-sdk-bump`, so an agent told "bump this campaign to SDK 0.4.x" has a shipped procedure to follow instead of one written into the ticket (campaigns-os#677). It covers a 0.4.x to later 0.4.x Campaign Cart bump on page-kit and static repos, and it stops at a 0.3.x pin or the legacy Campaigns script, because moving those is migration work. The steps:

- Find every pin: `_data/campaigns.json` and loaders that hard-code their version on page-kit repos, or `sdk repin` scoped to the funnel folder on static repos.
- Read the release diff against the campaign's own code, including where its purchase event comes from.
- Run `sdk storage-check` with the target tag's manifest.
- Run `doctor --built`, or `doctor --packet` when there is a Build Packet.
- Prove the bump on a preview, with the browser pinned to the store's main market and each test order approved.
- Hand back what is not proven, on the ticket or the pull request, never in the served tree.

It adds no write, send or order capability. Bundled skills advance to `1.59.0+skills.4`.

## [1.59.0+agent.11] - 2026-10-19

Repository CI workflows move to newer versions of three GitHub Actions. This changes nothing in the published package, and there is nothing to do.

### Changed

Repository workflows move `actions/create-github-app-token` from 3.2.0 to 3.3.0, `actions/upload-artifact` from 7.0.1 to 7.0.2 and `actions/download-artifact` from 8.0.1 to 8.0.2 (campaigns-os#679). This changes repository CI only, and the published package is unchanged.

## [1.59.0+agent.10] - 2026-10-19

The lockfile moves Playwright to 1.64.1 and acorn to 8.19.0, both inside the ranges `package.json` already declared, so a fresh install resolves the same versions. Playwright drives `qa run --browser` and `polish capture`; acorn parses page scripts for doctor's script-syntax check and now rejects one more malformed async arrow-function shape. There is nothing to do unless doctor newly reports a syntax error in a page script.

### Changed

The lockfile moves Playwright from 1.63.0 to 1.64.1 and acorn from 8.18.0 to 8.19.0 (campaigns-os#675). Both stay within the ranges `package.json` already declares, so an installed toolkit resolves the same versions on a fresh install. Playwright drives `qa run --browser` and polish capture. acorn parses page scripts for doctor's `built_output.script_syntax` check, and 8.19.0 now rejects additional subscripts before the arrow in async arrow functions.

## [1.59.0+agent.9] - 2026-10-19

The vendored starter-template catalog moves to campaign-cart-starter-templates `3987b18`. Step and select pages prefetch `next_step` instead of the post-payment URL, and the promo banner is rendered at build time from frontmatter, so the `<promo-banner>` web component and its layout shift are gone. The SDK pin stays 0.4.42 and the CampaignSpec fixtures do not change.

### Changed

The vendored starter catalog is re-synced to campaign-cart-starter-templates `3987b18` (was `d5ff501`). That range carries:
- campaign-cart-starter-templates#229: step and select pages prefetch `next_step` rather than the post-payment `next_url`.
- campaign-cart-starter-templates#234: every family renders the promo banner at build time from `promo_banner` frontmatter. The `<promo-banner>` web component and `promo-banner.js` are gone, along with the layout shift they caused.
- #228, #230, #235 and #237: the 5.0 multi-step fixture specs and recertified SDK 0.4.42 evidence. Each certified family now records `sdk-0.4.42-2026-10-16.2`.

The certified-family fixtures are regenerated at the pin with page-kit 0.2.0, which is what the starter repository still pins. The payment-chrome `asset_pin` moves to `3987b18`. Its five images have the same bytes there, so no hash changed. The SDK pin (0.4.42), the support policy and the CampaignSpec fixtures do not change.

## [1.59.0+agent.8] - 2026-10-19

Campaigns OS now works with next-campaign-page-kit 0.3.0 and keeps 0.2.x targets working. The setup docs pin `next-campaign-page-kit@0.3.0`, and doctor reads 0.3.0's new `assetWarnings`, so an `.html` file under a campaign's `assets/` that page-kit no longer builds is reported instead of 404ing silently on the built site. The first build on 0.3.0 can change the build fingerprint with unchanged source: run `record build` again afterwards and expect Polish, deploy and QA to be owed.

### Changed

Campaigns OS adopts next-campaign-page-kit 0.3.0 and keeps 0.2.x targets working. The new-folder installs in `docs/local-setup.md`, the quickstart and the README pin `next-campaign-page-kit@0.3.0`; the quickstart and README installed it unpinned, and `docs/local-setup.md` pinned 0.2.0. The example target declares page-kit as a runtime dependency at that pin.

Doctor's build summary check reads the top-level `assetWarnings` array that page-kit 0.3.0 adds to `campaign-build --json`. 0.3.0 neither builds nor copies `.html` files under a campaign's `assets/`, and lists each one there as `ASSET_IGNORED`, never in `pages[].warnings`. Doctor read only `pages`, so such a build printed "no build errors or shape warnings". Each entry for the campaign is now a non-blocking `built_output.build_asset_warning` naming the file, because a link or iframe to it 404s on the built site, and the ready line prints only when there are neither page nor asset warnings. The build prompt and the Campaign Build skill name `assetWarnings` and `ASSET_IGNORED`.

`spec derive` and doctor's built-page lookup follow the target's installed page-kit, read from `node_modules/next-campaign-page-kit/package.json`, when they discover source pages. On 0.3.0 and later they skip `.html` files under the campaign's top-level `assets/`, so a page is no longer bound to a file page-kit does not build. A target on 0.2.x, or with no readable install, keeps the 0.2.x rule. The stray-file text in `docs/build-packet.md` and in the campaign identity gate's message now says that unpruned `_site/` output and an `assets/` `index.html` built as a page are page-kit 0.2.x behaviour; the `stray_files` gate is unchanged. Bundled skills advance to `1.59.0+skills.3`.

### Migration

The first build on page-kit 0.3.0 can change the build fingerprint with unchanged source: 0.3.0 removes `_site/<slug>/` before it builds, so output left by earlier builds disappears, and it no longer copies `.html` files under `assets/` into `_site/`. Run `record build` again after that build and expect polish, deploy and QA to be owed again. That is the fingerprint doing its job.

## [1.59.0+agent.7] - 2026-10-15

`run status` now always points to `next` as the next command, so a finished-looking report no longer sends you to `run end` before `next` has reached done. `next` decides when the campaign is done and names `run end` itself. The output of `next` and doctor is otherwise unchanged.

### Fixed

`run status` now always names `next` as the next command: `progress.next_command` is `campaigns-os next --packet <packet> --json`. Before, once every stage status the Assembly Report records read completed or skipped, it named `run end` even when `next` had not reached done: after a CampaignSpec edit with no `record spec` (`next` answers build), on a report written before input stamps existed, and after a rebuild with no `record build`. `next` decides whether the campaign is done, and once it is, with a run session active, it names `run end` as a required action. `run status` stays read-only, and `progress.incomplete_stages` still lists the recorded statuses (campaigns-os#673).

### Changed

`next` returns a blocked or unavailable prepare-build gate's recovery-only answer from one branch, whether the stage was named or picked; `requested_stage` still appears only when a stage was named. Doctor's status, `next`'s status and doctor's `next` block read one readiness ladder (`blocked`, then `ready_with_waivers`, `ready_with_warnings`, `ready`), each over its own errors and warnings. The output of `next` and doctor is unchanged.

## [1.59.0+agent.6] - 2026-10-15

Two fixes to how the toolkit binds QA and Polish to a build. The progress snapshot now reads the QA record's `qc_build_fingerprint`, so a `qa run` without `--browser` no longer shows `qa.binding: unconfirmed` for a build it did test. The polish gate reads the recorded build only from `stages.assembly.build_fingerprint`, and a report that carries only a legacy fingerprint field now gets a clear `polish.build_fingerprint_missing` from doctor instead of contradictory messages. `npm run smoke:polish-capture` passes again.

### Fixed

The progress snapshot binds a QA record to its build through the field `next`, the QA gate and the Run Record already read: `stages.qa.evidence.qc_build_fingerprint`, falling back to `source_build_fingerprint`. It used to read only `source_build_fingerprint`, which QA writes only when the placeholder-text gate records an outcome. A `qa run` without `--browser`, or with that gate skipped, therefore showed `qa.binding: "unconfirmed"` and a qa stage row with `build_binding: "unconfirmed"` and no fingerprint, although QA was recorded for the current build. Records that bind no build, or a different one, still read `unconfirmed`.

The polish gate reads the recorded build only from `stages.assembly.build_fingerprint`. It no longer falls back to `stages.assembly.artifact_fingerprint`, a top-level `build_fingerprint` or a top-level `artifact_fingerprint`, which no toolkit version writes. A report carrying only one of those used to make doctor print "Build output fingerprint matches stages.assembly.build_fingerprint" and report `polish.evidence_missing`, while `record polish`, `record theme`, `record deploy` and `polish capture` refused the same report as having no recorded build. Doctor now reports `polish.build_fingerprint_missing` for it, as they do.

`npm run smoke:polish-capture` passes again. It wrote its page outside `_site/<slug>/` with a placeholder build fingerprint, which `polish capture` refuses; it now writes `_site/runtime-packet-demo/landing/` and records that tree's real fingerprint. A failed capture prints the underlying error after the smoke's failure message (campaigns-os#672).

## [1.59.0+agent.5] - 2026-10-15

The hosted preview path is now documented the way `next` has run it since 1.59.0: record the hosted deploy with `record deploy --base-url <route root>` before QA, for both deploy targets. The Polish skill, the Build Packet doc and the README no longer say a hosted preview URL satisfies the deploy stage on its own. A forced `next deploy` or `next qa` on a hosted packet whose preview URL is loopback or production now asks for `qa policy set --preview-url` first. Bundled skills advance to `1.59.0+skills.2`.

### Fixed

The hosted all-template guidance now matches what `next` has done since 1.59.0, where a hosted preview records its deploy with `record deploy` before QA. The Campaign Polish skill, `docs/build-packet.md` and the README no longer say that the hosted preview URL satisfies the deploy stage or that `record deploy` takes only a loopback route root; they name `record deploy --base-url <route root>` for both deploy targets and leave the order to `next`. A forced `next deploy` or `next qa` on an all-template hosted packet whose preview URL is loopback or the production page now prompts for `qa policy set --preview-url`, as its next actions and doctor already did and as an unset preview URL already did, instead of the generic deploy prompt or a QA command against that URL; the QA prompt then sends the agent to `next`, which records the deploy before QA. The done prompt names `record deploy` for both deploy targets in place of an instruction to record the hosted URL by hand. Bundled skills advance to `1.59.0+skills.2`.

## [1.59.0+agent.4] - 2026-10-14

The build-flow doc and the quickstart now describe campaign setup in the Campaigns App the way the dashboard does it: create the campaign, then add Offers on its Offers tab. Selecting store products in an Offer creates the campaign's products (packages in the API) at their store price, and the Packages tab is now called Products. Do not create separate `1x`, `2x` and `3x` packages for tier pricing. This is documentation only.

### Changed

The build-flow doc and the quickstart describe the Campaigns App's offer-first setup: Create Campaign, then Add Offer on the campaign's Offers tab. Selecting store products in an Offer creates one campaign product (a package in the API) per variant at its store price when the Offer is saved, and later Offers reuse it. The dashboard's Packages tab is now Products. The rule against separate `1x` / `2x` / `3x` packages for tier pricing is unchanged, and campaigns set up over the Admin API still create packages before Offers.

## [1.59.0] - 2026-10-09

This release publishes the 1.58.0 line and adds hosted deploy recording. `record deploy --base-url <https route root>` now works for a hosted preview: it requests every built page, requires HTTP 200, and checks that every script and stylesheet the pages load is byte-identical to the built output. The hosted all-template path no longer skips the deploy stage; `next` hands you `record deploy` and then QA. Pin `@nextcommerce/campaigns-os@1.59.0` and refresh skills to `1.59.0+skills.1`.

### Changed

- Publishes the untagged `1.58.0` change: multi-step checkout frontmatter follows the starter-template `next_step` contract (campaigns-os#641).
- Publishes `1.58.0+agent.2`: doctor warns `template_contract.select_step_missing` for a two-step family with no select page before checkout, and the phone scan skips comments and `<style>` content (campaigns-os#658, campaigns-os#660).
- Publishes `1.58.0+agent.3`: a stale build fingerprint names the extra, missing and changed files and flags sync conflict copies (campaigns-os#659).
- Publishes `1.58.0+agent.4`: QA verdicts separate planned order paths from retry attempts (campaigns-os#661).
- Publishes `1.58.0+agent.6`: QA cart entry chooses each slot's variant on a select page before Next (campaigns-os#667).
- Publishes `1.58.0+agent.7`: the starter catalog is re-synced to campaign-cart-starter-templates `d5ff501` (campaign-cart-starter-templates#223, SDK 0.4.42).
- Bundled skills advance to `1.59.0+skills.1`.

### Added

`record deploy` records a hosted deploy. On a packet whose `deploy.target` is not `local-serve` it takes an https `--base-url` naming the campaign's route root (plain http only on a loopback host), requests every built page there, and requires each to answer HTTP 200. It then requests every script and stylesheet the built pages load from that origin and compares each one's sha256 with the file in the built output, following redirects only within that origin and reading no more bytes than the built file holds; a missing, larger or different asset refuses the record, naming the URL and the built file. A `record build` of other output between the probe and the write refuses the record, on a `local-serve` packet too. A response with no readable body refuses as a transport failure, not as a byte mismatch. HTML is not compared, because hosts inject toolbars and other markup. A passing probe writes what the loopback path writes: `deploy.preview_url` on the packet, and `stages.deploy` completed with the URL in `outputs`, one evidence line per page and per matched asset, and the build fingerprint it probed, so a later `record build` of other output makes deploy owed again. `local-serve` packets keep the loopback-only rules. The hosted all-template preview no longer skips the deploy stage: `next` hands off `record deploy` for the recorded preview URL and then QA, and the hosted deploy prompt names `record deploy` in place of hand-editing `stages.deploy` (campaigns-os#657).
