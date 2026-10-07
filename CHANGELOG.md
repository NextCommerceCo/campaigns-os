# Changelog

Notable supported-surface changes are recorded here.

## [1.54.0+agent.6] - 2026-10-07

### Fixed

Doctor now blocks receipt order lines hidden by a cart-state visibility condition, including when only the CampaignSpec identifies the receipt page. When the campaign API key comes directly from the Build Packet or CampaignSpec, or from the environment variable named by Build Packet `campaign.api_key_source`, doctor blocks built pages with a different key even if those pages agree with one another. A mismatch names each wrong key source and the pages using it, so the built keys can be replaced before test orders begin.

## [1.54.0+agent.5] - 2026-10-07

### Fixed

- `qa run --test-order` orders a multi-unit bundle card the way the checkout shows it. A starter bundle card declares its package and per-package quantity in `data-next-bundle-items` (`bundle-2x` is `[{"packageId":1,"quantity":2}]`), and the runner now reads them there:
  - `--select-package 1:2` finds the card whose items carry package 1 at quantity 2 even when no inner node repeats the package id. A card matches when any one of its declared items is that package at that quantity, so a kit card declaring `[{"packageId":1,"quantity":2},{"packageId":4,"quantity":1}]` is found by `4:1`; when a card declares the item alone as well, that card is preferred. Before, it failed `selected_bundle` with "no rendered card exposes that package or bundle identity".
  - `--cart 1:2` clicks that same card. Before, it clicked the first `[data-next-package-id="1"]`, which on the starter partial is the one-unit card's inner node, so the order carried one unit. Without `--select-package`, a `--cart` ref the selected card already carries at that quantity clicks nothing, and a ref that no bundle card declares is clicked as before. The cards are read again before each ref, so a card a selector renders after an earlier `--cart` click is found.
  - Beside `--select-package`, `--cart` never clicks another card in the selector group of the card `--select-package` chose, for bundle cards and plain package cards alike; a card in no `[data-next-bundle-selector]`, `[data-next-selector-id]` or `[data-next-cart-selector]` container counts as in that group, since its own wrapper does not say which cards it swaps with. A `--cart` ref that card carries is left as it is; a ref an order bump or a card in another selector group carries is applied through that control; any other ref is left unapplied and named in the `selected_bundle` detail (`--cart 3:1 not applied: only another card in the selector --select-package chose carries it`), and the order is reconciled against the card actually selected. Before, `--select-package 1:2 --cart 3:1` switched to the package-3 card while `selected_bundle` still reported the two-unit card, and `--select-package 1:2 --cart 1:2,2:1` reset the order to one unit.
  - The `browser-order-display-parity` row reconciles the order against the packages and quantities every selected bundle card declares, however many cards are selected. Before, it counted the card's `data-next-bundle-id` as a displayed package and resolved lines at one unit per package, so a correct two-unit order failed with "displayed but never charged: 1".
  - Without `--select-package`, the same row now fails when an explicit `--cart <ref:qty>` is not in the order at that quantity: the order carried another quantity, as when `--cart 1:2` produced a one-unit order, or no line for the package at all, as when `--cart 1:2,3:1` on a swap-mode selector kept only the `3:1` card. Its message names the requested and persisted units, or says the order carries no line for the package. A bare `--cart <ref>` is not judged. The row's message now also names `--select-package` quantity mismatches, which already failed the row but were not named in its message.
- Checkouts built from plain package cards (`[data-next-package-id]`, no bundle cards) are selected and reconciled as before, except that `--cart` beside `--select-package` no longer switches to another card in the chosen card's selector group, and without `--select-package` an explicit `--cart <ref:qty>` the order does not carry at that quantity fails the display-parity row.

## [1.54.0+agent.4] - 2026-10-07

### Fixed

`qa run` now calls `ready_with_exceptions` a passing proof, lists each exception once with its id and page (and severity when present), and tells the agent to report exceptions to the operator. `next` gives the same guidance when QA completed with exceptions while keeping the closeout action.

The completed-pipeline prompt and Build Packet guide now point to `record build` for repeated build work and distinguish local-serve recording from hosted deploy instructions. The starter-palette advisory prints the named-human argument required by a recorded `theme waive`, while help and QA guidance distinguish it from the one-run `--theme-waive` form. QA prompts, help, and guides ask once, up front, before typed-card test orders unless the operator already said they are fine for this campaign. Those orders leave real store records even though no transaction or money movement occurs. `ready` and `blocked` QA text keeps its existing finding format.

## [1.54.0+agent.3] - 2026-10-07

### Fixed

The `qa run --browser` primary-CTA row (`browser-primary-cta:<page>`) no longer fails `missing_route_cta` on checkout and upsell pages that Campaign Cart routes. Since 1.53.0 those pages are checked, but the check found a route only through a control's own link, and these pages have none: a checkout advances through the submit button of its `<form data-next-checkout="form">`, and an upsell through its `data-next-upsell-action="add"` and `"skip"` controls, which are `href="#"` links. So every SDK-routed checkout and upsell failed, the starter templates' own pages included, while the `route-link:*` rows and test orders passed on the same pages. QA now takes the route a page declares for these controls, from the same page fields the `route-link:*` rows read. On a checkout, the checkout form's submit button leads to the page's next route, whether it is `type="submit"` or has no `type` attribute, which submits the form just the same; express-checkout wallet buttons are not. On an upsell or downsell, the add control leads to the page's accept route and the skip control to its decline route, but only inside a `data-next-upsell` container: Campaign Cart binds upsell actions nowhere else, so an action outside one routes nothing. The control is checked as the primary CTA when that route is the page's next route, and its contrast, size and text are measured as before. On checkout, upsell and downsell pages these declared controls are the only controls a form can route. Any other form's `action`, for example a newsletter sign-up beside the checkout form, routes nothing there, even when it is the next route. So a page whose only route to the next page is such a form still fails `missing_route_cta`. On every other page a form's `action` is now the route of that form's own submit button only, and never inside the checkout form, which Campaign Cart submits itself. So bundle cards, wallet buttons and other controls inside a form no longer become CTA candidates because the form has an action; before, they did, and the row turned to `manual_review`. A page with no control leading to its next route still fails `missing_route_cta`.

QA now recognises `data-next-upsell-action="accept"` and `data-next-upsell-action="decline"` on upsell pages. Campaign Cart treats `accept` exactly like `add` and `decline` exactly like `skip`, but QA only looked for `add` and `skip`. So on a page written with `accept` / `decline`, the test-order upsell step failed with `Missing upsell control`, the `browser-upsell-control:<page>:accept` and `:decline` rows read `not found`, the primary-CTA row failed `missing_route_cta`, and the `route-link:<page>:accept` and `:decline` rows fell to `manual_review` when the route URL was not in the page's HTML. QA now takes either spelling everywhere it looks for an upsell control: the test-order upsell step and its timeout evidence, the upsell-page readiness wait, the rendered upsell-control rows, the primary-CTA route rule, and the static `route-link:*` rows, including the check for a `data-upsell-proxy` button, which forwards to the in-offer action with its own spelling; Polish readability's contrast check also takes either spelling for its `upsell_accept` and `upsell_decline` roles. Pages written with `add` / `skip` are checked as before, and when a page has neither spelling, QA's messages still name `add` and `skip`. Other values are still not upsell controls.

## [1.54.0+agent.2] - 2026-10-07

### Changed

Repository CI and contributor tooling only; the published package is unchanged. CI runs the unit and browser lanes as two shards each on separate runners, and a newer push to a pull request cancels that pull request's older run; pushes to `main` always finish. `npm run check:fast` runs the checks of CI's types and contracts lanes and the three PR-only release gates against `origin/main` in under a minute, and `npm run hooks:install` installs it as a pre-push hook for the clone and its worktrees (`docs/small-pr-review-path.md`).

## [1.54.0+agent.1] - 2026-10-07

### Changed

- When `start`, `prepare-build` or `build` refuses to overwrite a report that already carries stage evidence, the message now says that, if the brief or CampaignSpec changed, `record brief` or `record spec` binds it while keeping that evidence. Before, it offered only `--force`, which resets the recorded stages.
- README: the build steps and the `record` command list now include `record theme`, `record deploy` (bound to the build it probed), `record brief` and `record spec`. The SDK examples take `--target-sdk <x.y.z>` instead of 0.4.38. The `tooling status` note no longer says npm has no dist-tag, the Node floor reads 20.19.0 as in `engines`, and `--force` is described as moving completed records to stage history.
- `docs/quickstart.md`: a QA run against a local-address base URL keeps its verdict local by default, whatever the telemetry consent.

## [1.54.0] - 2026-10-07

Ships the same-surface changes 1.53.0+agent.1 through +agent.11 (+agent.6 and +agent.8 were never used), including the `qa run --test-order` fix for Campaign Cart SDK 0.4.41 card fields (+agent.5) and the starter catalog, SDK attribute index and support policy at 0.4.41 (+agent.10, +agent.11).

### Added

`campaigns-os sdk repin --target <repo> [--target-sdk <x.y.z>] [--apply] [--json]` updates the Campaign Cart SDK pins written into a static campaign repo's HTML, the `loader.js` and `campaign-cart.css` URLs that `standardize` already lists with path and line. It rewrites only a semver pin (`@vX.Y.Z` or `@X.Y.Z`) below the target version, and only the version part of the URL. `@latest`, `@main`, commit and prerelease refs, and pins already at or above the target, are listed and left alone. Without `--target-sdk` the target is the SDK support policy's `preferred_minimum`. By default it only previews, printing each path and line with the old and new URL. `--apply` writes the files and a change record at `.campaign-runtime/sdk-repin.json` with the files touched, the reference count and the from and to versions, which a Run Record can cite. A second run finds nothing to change and writes nothing. A repo with `_data/campaigns.json` is refused with exit 2, because page-kit owns that pin; use `page-kit sync` there. This replaces the hand-run `sed` step in the SDK bump for static repos.

### Changed

`qa run` no longer publishes a verdict to the QA portal by default when the base URL is a local address (`localhost` or any `*.localhost` name, any `127.x.x.x` address, `0.0.0.0`, `[::1]` or an IPv4-mapped loopback), whether the spec came from a saved Map or a local file. The verdict stays local, and the output names the destination plus `qa publish` and `--post-verdict`. Pass `--post-verdict` to publish a local-address run. `publish_decision.reason` reads `loopback_base_url` when this default applied. Runs against a remote base URL publish exactly as before. The `--post-verdict` help line now names the IPv4-mapped loopback too.

`record deploy` now stamps `stages.deploy.source_build_fingerprint` with the recorded build it probed. When a later `record build` records different output, a deploy stamped with the old build becomes `required` (`required_by` build, `required_for` qa), its old probe (`outputs` and `evidence`) leaves the live stage and the prior record is kept in `stages.deploy.history`, and `next` routes back to `record deploy` before QA. A rebuild with byte-identical output keeps the deploy current. A deploy recorded before this change carries no stamp and is kept as recorded. The Assembly Report schema describes the field.

The effects contract declares the `sdk repin` and `sdk repin --apply` rows, and its `record deploy` and `record build` rows say a deploy is stamped with the build it probed and owed again after a build of other output. On the eight `qa run` rows, the verdict send to `{proxy-base}/api/qa/verdicts` now names the local-address default in its condition, and the offline fixture no longer observes it because it serves the campaign from 127.0.0.1; `qa publish` proves that send.

## [1.53.0+agent.11] - 2026-10-07

### Changed

The bundled Campaign Cart SDK support policy records 0.4.41 as the latest known release (`provenance.latest_known_release`, was 0.4.38). With the starter catalog verified against 0.4.41 (1.53.0+agent.10), template freshness already took 0.4.41 as the current SDK, so no family's freshness changes; the policy now agrees with the catalog instead of naming a release three behind it, and "current SDK" is reported from the policy. `minimum_supported` (0.4.20) and `preferred_minimum` (0.4.30) are unchanged.

## [1.53.0+agent.10] - 2026-10-07

### Changed

- The vendored starter-template catalog is re-synced to campaign-cart-starter-templates `7833290` (was `2c61894`). Every certified family now records Campaign Cart SDK 0.4.41 verification evidence (`sdk-0.4.41-2026-10-06.5`, a `lint-sdk` pass), and the eight agent CampaignSpec fixtures pin `sdk_version` 0.4.41. Doctor's missing-SDK-pin message therefore names 0.4.41 as the version a family was verified against. The certified-family render fixtures are regenerated at the new pin: the loader moves to 0.4.41, and the checkout and receipt pages pick up the starters' SDK address blocks (`data-next-address`) and the savings badge drawn from the summary token. The payment-chrome `asset_pin` moves to the same commit; the five hashed assets are byte-identical there.
- The SDK attribute index (`src/sdk-attribute-index.mjs`) moves from v0.4.38 to v0.4.41. v0.4.41 removed the generated `docs/attribute-index.md` the old recipe read, and the SDK's hand-written attribute docs leave out names its source still reads. The list is now regenerated from the SDK source at the tag (every `data-next-*` string and `dataset.next*` property in non-test TypeScript), and that recipe is in the file. It keeps all 135 names of the v0.4.38 list and adds 14: the address block (`data-next-address`, `-lang`, `-api`, `-field`, `-row`, `-state`), `data-next-i18n`, `data-next-phone-e164`, `data-next-phone-country`, `data-next-bump-section`, `data-next-button-text`, and the variant option state (`data-next-variant-name`, `-value`, `data-next-unavailable`). `built_output.sdk_markup` no longer reports these as unknown, and its findings now name `sdk_attribute_index_version` 0.4.41. The checkout field names are unchanged at v0.4.41.
- The raw cart placeholder check (`built_output.cart_placeholders`) accepts pages pinned to 0.4.41: all ten renderer files it was generated from have the same git blob ids at v0.4.38 and v0.4.41. Before, every 0.4.41 page reported `unexercised` (`sdk_pin_unverified`).

## [1.53.0+agent.9] - 2026-10-06

### Fixed

The per-target lock now tells an ownerless lock apart from something at the lock path that is not a lock. When the wait ends on an ordinary file, a symbolic link, or a directory with no owner record that holds other entries, the refusal names what is there and says it is never removed automatically; before, it read as a busy or ownerless lock. An empty ownerless lock directory is still refused as before. The holder of a lock also clears the staging, recovery-staging and released directories that a crashed process or a failed release left beside the lock, but only those whose recorded owner process no longer exists; a sibling with a live or unreadable owner is left alone.

## [1.53.0+agent.7] - 2026-10-06

### Changed

`doctor --built --base-url <url>` now says that it checked the local built files only. The URL is not fetched: it fills `deploy.preview_url` in the minimal Build Packet. The output names `qa run --site <repo> --base-url <url> --family <family> --browser` as the command that loads the served pages, and `--json` carries `derived.base_url` with `fetched: false`. The checks themselves are unchanged.

## [1.53.0+agent.5] - 2026-10-06

### Fixed

- `qa run --test-order` types the test card on pages running Campaign Cart SDK 0.4.41. That release draws the card number and CVV with the fields NEXT's `payments.29next.com` script mounts, whose iframes are named `spreedly-hosted-number-…` and `spreedly-hosted-cvv-…`; the runner looked only for the `spreedly-number-frame-…` and `spreedly-cvv-frame-…` iframes of 0.4.40 and earlier, so on a 0.4.41 checkout it timed out before submitting. It now finds either, and nothing changes on pages pinned to 0.4.40 or earlier. A checkout carrying both kinds of card iframe, or two of either, fails at `card_fields_filled` with the iframe ids it found instead of typing into whichever comes first, and the step's evidence records which iframes it typed into.
- `qa run --test-order` no longer loses card digits typed before the card fields are ready. On SDK 0.4.41 the hosted number input appears before its script has loaded, and digits typed in that window are dropped. The SDK then refuses the shortened number without tokenizing, so the run timed out at `order_submitted` 45 seconds later with no order created. This happened about once in 33 live runs, usually when the card fields loaded slowly. The runner now waits up to 15 seconds for the checkout form to drop its `next-loading-spreedly` class (SDK 0.4.38 to 0.4.41 set it until the card fields are ready); if it is still there, `card_fields_filled` fails and says the card script never finished loading. It then reads the card number and CVV back, and retypes up to three attempts in all. If the fields still don't hold the card, `card_fields_filled` fails and names what the fields held, instead of the run timing out at submit.

## [1.53.0+agent.4] - 2026-10-06

### Fixed

- The checkout field-name checks now read the SDK version of the page they judge. `first_name` and `last_name` pass on Campaign Cart SDK 0.4.39 and later, and `phone_number` passes on 0.4.41 and later; `fname`, `lname` and `phone` still pass on every version. Earlier releases blocked `first_name` and `last_name` (`built_output.sdk_markup` `WRONG_FIELD_NAME`, and `checkout.unsupported_field_binding` in `standardize`) and flagged `phone_number` on every SDK, so a page written to the 0.4.41 field names failed doctor although the SDK maps them. Doctor reads the page's own exact loader pin, then the campaign's `sdk_version` in `_data/campaigns.json`. `standardize` reads the file's own loader pin, then the lowest exact pin the campaign declares (for a bundled `campaign-cart` dependency, an exact pin or the floor of a `^`, `~` or `>=` range). When neither gives an exact released version, the checks keep their earlier behaviour, because `fname`, `lname` and `phone` work on every version. Below a name's version the result is also unchanged, and the message names the version the name needs. Findings and bindings now record the SDK version they were judged against.

## [1.53.0+agent.3] - 2026-10-06

### Fixed

- `standardize` now judges a bundled `campaign-cart` dependency against the SDK support policy by the lowest version its `package.json` spec allows. Earlier releases took the version written in the spec, so `<0.4.39` was evaluated as 0.4.39 and `0.4.41 || 0.4.10` as 0.4.41, and both could pass the minimum although npm may install an older SDK. An exact pin or one `^`, `~` or `>=` range on a released version is evaluated by that version, as before. Any other spec gets no policy evaluation and raises the new warning `version.sdk_dependency_floor_unknown`. The lowest version is recorded as `sdk_loader.bundled_dependency.floor_version`.

## [1.53.0+agent.2] - 2026-10-05

### Changed

`next` now prints a short campaign intent summary, generated from the normalized Campaign Build Brief, in every result (`intent_summary` in JSON) and at the top of the setup, build, Polish and QA prompts. Each value is marked as set in the saved brief file, taken from the source, a generated default, or not stated; a value whose origin was not recorded, or that changed since it was recorded, says so. These marks are tamper evidence, not proof of who wrote a value. Values are shown as quoted data. The summary never shows a purpose or palette source that Campaigns OS inferred from page types or page names: unless the brief file states them, they read "not stated". The summary is output only: nothing reads it, and it cannot change prices or commerce behaviour. Bundled skills and the agent context files now tell agents to read the brief and the recorded assembly decisions.

The build stage prompt that `next` returns now tells the agent to save a changed Campaign Build Brief with `record brief` or a changed CampaignSpec with `record spec` before building on the change.

Bundled skills are at revision `1.53.0+skills.2`. The lifecycle skill saves brief answers with `record brief` and returns the single compact brief defined in `references/session-intake.md`, whose work-type field is now `Work:` beside a new `Campaign:` field. The build skill passes `--deviation-reason` to `record build` only on the operator's explicit decision, the Polish skill records a skipped Polish only on the operator's decision, and the Polish and QA skills say how to report a readability warning and offer repairs inside the brand palette.

### Migration

**Migration.** The agent context files changed, so `tooling setup` refuses until each existing campaign refreshes its installed copy. From the campaign folder:

1. `npm install --save-dev --save-exact @nextcommerce/campaigns-os@1.53.0`
2. `npx --no-install campaigns-os install-agent-context --target .` (overwrites all four files under `.campaign-runtime/agent-context/`; local edits there are lost)
3. Review and commit `git diff .campaign-runtime/agent-context/`
4. `npx --no-install campaigns-os tooling setup --target . --platform claude`
5. Restart the agent session so it loads the new skills and context.

Codex, Cursor and Copilot users run step 2 and reinstall skills with `install-skills --platform codex` (or `agents`).

## [1.53.0+agent.1] - 2026-10-05

### Added

- Polish now measures text readability on every built page at desktop and mobile widths and reports warnings, review and coverage results in the QC handoff. QA's primary-CTA check and the theme generator use the same unrounded WCAG 2.x measurement. Results change on some campaigns: ratios in [4.495, 4.5), translucent text or backgrounds, and child text now warn; large bold text at 3:1 and Tailwind v4 `oklch()` colours are measured correctly; gradients, unreadable colours, and opacity, filters, blend modes or masks on surrounding elements become manual review instead of a contrast result. QA's primary-CTA check no longer skips pages by page type: every page with an expected next route is checked, every route-matching CTA is measured (not only the most readable one), each piece of text inside a CTA is compared with the requirement for its own size, and a CTA measured before its text, the SDK, stylesheets or fonts are ready is reported for manual review, never as a pass. The primary-CTA check also reports manual review, not a failure or a pass, when the page inspection itself errors (earlier releases reported a failure), when every route-matching CTA is disabled, and when a CTA's text includes text generated by CSS `::before` or `::after` (earlier releases reported a contrast pass or failure for both). `polish capture` on a campaign with no mapped pages now measures readability and exits successfully, printing the page-load message as a warning. Polish media weight and readability results now read as stale when the built output changed without a new `record build`.

## [1.53.0] - 2026-10-05

### Added

- Adds `record brief`, which saves Campaign Build Brief answers without re-running intake. A brief file is guided unless it sets `"brief_mode": "prepared"` (a campaign whose report already records a prepared brief stays prepared). An unchanged or reformatted save keeps all stage evidence and statuses. A material change marks build, Polish and QA (or QA alone for `qa_policy`) as owed again and keeps the last five superseded records per stage as history. `next` routes to the owed stage. Re-recording an unchanged build after an input change keeps the build owed unless the operator records a reason, including when a CampaignSpec change was never saved with `record spec`; an edit to the brief file is read only once it is saved with `record brief`. Intake now also refuses, without `--force`, to discard recorded waivers, warning accepts, stage history, an applied theme, or a recorded deploy target, preview URL, production URL, order-path depth or allowed-domains confirmation; with `--force`, it keeps stage history and archives the records it clears.
- Adds `record spec`, a non-destructive refresh after a CampaignSpec change. Superseded build, Polish and QA records move to stage history, and `next`, progress, readback and the Assembly Report status now report the owed stage instead of recommending QA. Spec material changes are detected for saved-Map and gateway packets too (against the fetched copy; remote currency is reported as unconfirmed). `spec derive` no longer rebinds report identity on its own; run `record spec` after it. Re-recording an unchanged build or replaying a Polish record after an input change no longer makes them current, whether or not the change was saved with `record spec`.

### Changed

- `spec derive --json` no longer carries the `rebound` field, because `spec derive` no longer rebinds report identity.
- A stage status outside the recognized list (`pending`, `blocked`, `required`, `completed`, `completed_with_warnings`, `completed_partial`, `skipped`) now reads as unknown and stops `next`, where earlier releases accepted any status beginning `completed` or `skipped`.
- The effects contract declares the `record brief` and `record spec` rows (tier C) and their `--dry-run` rows (tier none, with no lifecycle entry). It corrects the intake rows: `start`, `prepare-build` and `build` are refused without `--force` when the report carries stage evidence, stage history or operator decisions, and their `--force` forms archive completed build, Polish and QA records into stage history, which is kept. It also states that `record build` writes `input_change` and makes Polish and QA owed when it detects a brief or CampaignSpec change, and that `record polish`, `record theme` and `record deploy` are refused while an earlier stage is owed again.

### Migration

**Migration.** Build, Polish and QA records made before this release do not record which brief and CampaignSpec content they used, so they read as unconfirmed. After upgrading, `next` routes each in-flight campaign back to build once: re-record build and Polish, and run QA again for a new verdict. Hand-written brief files without `brief_mode` are now guided for new campaigns; add `"brief_mode": "prepared"` if you want open questions to block.

- Re-running `start`, `prepare-build` or `build` over a campaign with recorded waivers, warning accepts, stage history, an applied theme, or a recorded deploy target, preview URL, production URL, order-path depth or allowed-domains confirmation is now refused without `--force`. Save brief answers with `record brief` and a CampaignSpec change with `record spec` instead; pass `--force` only to clear that state on purpose.
- Scripts that read `rebound` from `spec derive --json` must stop: run `record spec` after `spec derive` to bind the new CampaignSpec content.

## [1.52.0+agent.1] - 2026-10-05

### Added

- Doctor now reports built-page smoke warnings: missing in-page anchor targets, missing favicon and Open Graph tags, unresolved `og:image`, the Tailwind CDN script in production builds, `cdn.29next.store` asset references, and loopback URLs.

## [1.52.0] - 2026-10-05

### Added

- QA now checks that configured store policy links are rendered and reachable, recording link presence and availability separately. QA now sends bounded header-only requests to the configured policy URLs; the effects contract declares them.

### Changed

- The effects contract now states that `qa run --browser` sends the header-only GET requests to the configured store policy URLs, rather than declaring them ahead of the check that sends them.

## [1.51.0+agent.4] - 2026-10-05

### Added

- QA now checks at runtime that declared content parameters hide their content, comparing fresh contexts with and without `?<name>=n`.

## [1.51.0+agent.3] - 2026-10-05

### Added

- QA browser test orders now report URL preservation and order attribution for synthetic tracking parameters as separate results. QA order evidence no longer stores query strings in `checkout_url`, `final_url` or request URLs.

## [1.51.0+agent.2] - 2026-10-05

### Added

- Polish capture now records image geometry and redirect chains, and reports origin and weight warnings for video and large images served from the page's own origin, plus oversized images.

### Changed

- `polish capture` now records media weight beside page load evidence in the Assembly Report, so `next` reads the image weight and oversize results of a fresh capture.

## [1.51.0+agent.1] - 2026-10-04

### Added

- Doctor now warns on SDK cart placeholders printed in live built HTML (`built_output.cart_placeholders`), ported from the public starter-template lint.

## [1.51.0] - 2026-10-04

### Added

- Adds `checkpoint accept`, which records an operator's accept of a measured warning next to the unchanged measurement, and a QC handoff section in `next` that lists open, review, lapsed, unexercised and excluded results. Accepts never change readiness, and `checkpoint waive` still refuses gates that are not blocked.
- The effects contract now declares bounded header-only GET requests to the store policy URLs a CampaignSpec configures, for `qa run --browser`, ahead of the check that sends them; QA does not send them yet.

## [1.50.0+agent.20] - 2026-10-04

### Changed

- `scripts/refresh-certified-family-fixtures.mjs` now sets `og_image` to
  `https://example.com/og-image.png` on each certified family's
  `_data/campaigns.json` entry before it renders, and records that in the
  fixture manifest as `render_inputs`. The starters leave `og:image` out until
  a campaign sets one, so without it every certified page would report a
  missing `og:image` to the coming built-output smoke checks. The value is on a
  reserved domain, so it is plainly synthetic, and doctor `--built` neither
  maps nor fetches it. The committed fixture tree is unchanged until the next
  regeneration.

## [1.50.0+agent.19] - 2026-10-03

### Fixed

- A campaign-identity finding (`funnel_drift`, `funnel_missing`,
  `api_key_drift`, `attribution_drift`) that names a built file no active
  CampaignSpec page builds to now says so, and lists the file on the finding as
  `stray_files`. The message says to remove the source file if there is one,
  delete the built file, and rebuild and record the build again. Before, a
  design `index.html` copied under `assets/` built as its own page and blocked
  as funnel drift, with the message telling the agent to retag a page it never
  meant to ship. The gate still blocks, because the file is still served.

## [1.50.0+agent.18] - 2026-10-03

### Fixed

- Commercial parity no longer warns `price-claim-mismatch` on a page that shows
  a voucher the normalized plan cannot price. An upsell priced by a live
  voucher showed the voucher price, and QA compared it with the list-price
  total. Those price claims now count as unresolved, as the page's voucher
  claims already did, so coverage reads incomplete instead.
- `browser-order-bump-state` reads a `✓` glyph marker as checked only when its
  text is painted. A tick that stays in the marker and is hidden with
  `color: transparent` read checked before, so a declined bump failed as
  misaligned.

## [1.50.0+agent.17] - 2026-10-03

### Fixed

- Three CampaignSpec validation messages that doctor and `start` print now say
  which field to change:
  - The missing-`payment_env_key` warning keeps "No campaign loaded — campaign
    key required for spec export." and adds that `campaign.payment_env_key` is
    empty, where its value comes from, and that a Campaigns API key in the spec
    does not fill it. Before, it printed next to doctor's "Campaigns API key
    available via the packet-local CampaignSpec" line and read as if the key
    were missing.
  - The missing SDK version error keeps "SDK version is required for spec
    export." and names `global_config.sdk_version` and the form it takes.
  - The missing `design_source.file_url` warning, for a page whose
    `design_source.type` is not `figma` or `ai-generated`, and doctor's
    matching no-source-mapping error, say that hand-written or template HTML
    leaves `design_source` off the page. Before, a plain HTML page with a
    `design_source` block was told only to add a design-tool URL.

## [1.50.0+agent.16] - 2026-10-03

### Fixed

- `prepare-build` (and `start`) no longer write an Assembly Report that fails
  its own schema. When the brand-theme write failed, each error was copied
  onto `theme.warnings[]` as `{ code, message, detail: error.detail || null }`.
  The schema's `themeIssue.detail` is an object, so an error with no detail
  (`theme.generate.not_ready`, `theme.generate.empty`) left `detail: null`.
  `record setup` and `record build` then refused the report with
  "Assembly Report theme.warnings.0.detail must be object". `detail` is now
  written only when the error carries an object. The schema is unchanged.

## [1.50.0+agent.15] - 2026-10-03

### Fixed

- `record setup|build|polish|theme|deploy` accept `--deviation-reason`, as
  every other command does. The deviation notice tells an agent that departs
  from `next` to "Declare intent with --deviation-reason". `record` checks its
  flags against a strict allowlist, which held only its own flags and the global
  `--run-id` and `--lifecycle-journal`, so it refused the flag as unknown on
  every stage. It is now a global flag there too. A bare `--deviation-reason`
  with no value is refused as before.

## [1.50.0+agent.14] - 2026-10-03

### Fixed

- QA's placeholder text-residue gate (`template-residue:<page>:placeholder-text`,
  and doctor's built-output warning) now also matches the starter templates'
  own icon-grid placeholders, `Benefit one`, `Benefit two`, `Benefit three` and
  `Benefit four`. The olympus checkouts ship them, and a campaign that kept
  them passed QA with no failures, because the shared-commerce term list held
  only `Lorem`, `lorem ipsum`, `Placeholder`, `TODO` and `Product Name`.
  - The terms live in `contracts/template-brand-contract.shared-commerce.v0.json`,
    so every family inherits them.
  - Matching is word-bounded, so "Benefit once" does not fire.
  - Doctor's next-step hint and `docs/template-family-contracts.md` list them.

## [1.50.0+agent.13] - 2026-10-03

### Fixed

- The source preparation check `source_html.prep.document_wrapper` reads a
  page's converted page-kit file once it exists at `page_kit.output_path`, not
  the design it was converted from. Wrappers are stripped during conversion,
  and the converted page is what page-kit builds. The check only ever read the
  mapped design, so a correctly stripped build still failed. To clear it,
  agents copied built pages over the design source (breaking the Design Source
  Package hashes) or recorded `preserve_document_wrappers` for pages they had
  stripped. A converted page that still carries wrappers is reported under its
  own path. Before conversion the design is checked as before. The frontmatter
  and source-link checks are unchanged. `docs/source-adapters.md` says so.

## [1.50.0+agent.12] - 2026-10-03

### Fixed

- `record deploy` follows `next` past a polish carried forward on the local
  preview. On a `local-serve` packet with a loopback preview, `next`'s stage
  picker skips a polish that was never recorded for this build (the
  local-preview policy carries it forward as a warning), so after
  `record build` it answers deploy. `record deploy` checked every earlier
  stage strictly and refused with "stages.polish.status is "required", so next
  answers polish", which contradicted `next`. Sessions hand-wrote a polish skip
  record to get past it. Both now read the same rule, from doctor's
  `polish_gate`. Polish stays owed on the report and QA still reports it.
  `record polish` and the waiver commands keep the strict gates.
  `docs/build-packet.md` names the exception.

## [1.50.0+agent.11] - 2026-10-03

### Added

- Doctor warns `spec.material_stale` when a local-spec campaign's CampaignSpec
  no longer has the material hash prepare-build bound on the Assembly Report
  (`identity.spec_material_hash`). `next` prints the warning with the rest of
  doctor's. QA already refused such a run ("Re-run prepare-build after a
  material revision"). Until now it was the only command that checked, so a
  spec edited after `start` was accepted by doctor, `next` and every `record`
  command, and the problem surfaced only after the build, polish and deploy
  stages had been recorded against the old spec. The warning names both hashes
  and says to re-run prepare-build from the edited spec.
  `docs/build-packet.md` says so.

## [1.50.0+agent.10] - 2026-10-03

### Fixed

- A checkout row marked `is_order_bump: true` is now read as an order bump.
  The CampaignSpec schema and the authoring guide mark a checkout add-on with
  that flag, and the certified fixtures use it alone, but the one bump
  predicate the toolkit shares read only `is_upsell`. Such a row was treated
  as a main package:
  - the QA tier planner made it a selector tier of its own;
  - `next` named no bump-cart QA command (`qa_run_bump`);
  - commercial-journey priced the bump into the representative checkout and
    planned no with/without-bump scenarios.

  Either flag now marks a bump, and a row carrying `is_upsell: true` behaves as
  before. On the certified fixtures, the five checkouts that declare a bump now
  plan only their real tiers, and their bumps get the bump-cart command.
- Messages that named a bump `(is_upsell)` now say
  `(is_order_bump or is_upsell)`: the tier planner's warning and refusal, the
  `next` bump-command description, the `qa run --help` text and the QA
  test-order notes. `docs/qa-and-test-orders.md` says the same.

## [1.50.0+agent.9] - 2026-10-03

### Added

- `record build --build-environment <development|production>` records the
  page-kit environment the built output was rendered in, on
  `stages.assembly.evidence.build_environment`. A later `record build` without
  the flag keeps the recorded value. Before this, local proof mode
  (`deploy.target: local-serve`) asked the agent to record the field, but no
  command wrote it, so it was hand-edited into the Assembly Report.
  - Under local-serve, `next` now names
    `record build --packet <packet> --build-environment development` in the
    build action and the build prompt.
  - Doctor's `local_proof.build_environment` warning, the parity messages and
    the local-proof rebuild hint name the same command.
  - `docs/build-packet.md` and `docs/qa-and-test-orders.md` describe it.

### Fixed

- A `record` refused for a value outside a schema enum now lists the values the
  schema allows and the value it got. For example,
  `adapter_decisions.wrapper_policy must be equal to one of the allowed values:
  "strip_document_wrappers", "preserve_document_wrappers", "not_required",
  "unknown" (got "strip")`; before, it stopped at "allowed values".
- Doctor's adapter-decision warning for an unknown value lists the allowed
  values too.

## [1.50.0+agent.8] - 2026-10-03

### Changed

- The vendored commerce-surface catalog is re-synced to
  campaign-cart-starter-templates `02ffc61`, from `37a8d94`. That brings in
  three starter changes:
  - the single-offer upsell keeps a hidden in-offer skip, so its closing-card
    decline works in every family (#205);
  - `payment-methods.html` takes `method_order` and `default_method` (#202);
  - fresh SDK 0.4.40 verification evidence (#203).

  The upstream order-bump notes were consolidated, and the vendored copy
  follows them.
- `fixtures/certified-families/` is regenerated at the new pin. Every
  `upsell-single` fixture now carries the in-offer skip, so QA's static
  `route-link:<page>:decline` check, which fails a proxy decline with no
  target, passes on all eight families instead of failing on each.
- The shared commerce payment-chrome `asset_pin` moves to the new pin. The
  asset bytes are unchanged.

## [1.50.0+agent.7] - 2026-10-03

### Fixed

- `sdk storage-check` resolves Page Kit's `campaign_asset` script srcs. A
  page under `src/<slug>/` that loads `{{ 'js/checkout.js' | campaign_asset }}`
  is read as `src/<slug>/assets/js/checkout.js`, where Page Kit serves it from,
  and a page's frontmatter `scripts:` entries resolve the same way, since a
  layout's `{% for script in scripts %}` loop loads them through that filter.
  Until now every such tag read as a relative path that was never in scope and
  reported `shared-script-outside-scope`, so every Page Kit campaign came back
  `unknown` even when nothing was incompatible (#582). A resolved script left
  out of `--scope`, or excluded, is still reported, under its real path; a
  `campaign_asset` value the scan cannot resolve stays unknown.
  `docs/sdk-storage-compatibility.md` says so.

## [1.50.0+agent.6] - 2026-10-03

### Fixed

- QA no longer passes an upsell decline or accept that does nothing. Some
  upsell pages show a `data-upsell-proxy="skip"` (or `"add"`) button that
  forwards its click to the SDK's `data-next-upsell-action` inside the offer.
  When the offer has no such action, the static `route-link:<page>:decline`
  (or `:accept`) check used to pass on the decline URL in the page's meta tag,
  and only browser QA, after placing the order, found the control missing. The
  static check now fails as a blocker and says the proxy has nothing to
  forward to. The starter templates' single-offer upsell shipped this way in
  every family until the templates kept a hidden in-offer skip.
- Browser QA declines (and accepts) through the control a shopper sees. When
  the page's `data-next-upsell-action` is hidden and a visible
  `data-upsell-proxy` button forwards to it, QA clicks the proxy instead of
  failing with `Element is not visible` on the hidden action. A proxy with no
  in-offer action is still reported as a missing upsell control.

## [1.50.0+agent.5] - 2026-10-03

### Changed

- The agent context the toolkit installs (`agents/claude/CLAUDE.md`,
  `agents/codex/AGENTS.md`, `agents/cursor/campaigns-os.mdc`,
  `agents/copilot/copilot-instructions.md`) and the `next-campaigns-os` and
  `next-campaigns-qa` skills no longer say test orders need no permission or
  approval, or are safe to fire any time. They say `qa run` has no permission
  flag and coverage is its only control, and that test orders still land in
  the store as real orders (global test cards: no charge, no transaction) that
  someone may have to cancel. Unless the operator has already said test orders
  are fine for the campaign, the agent asks once, up front in its first turn
  with its other setup questions, so the answer covers the whole build and QA
  and neither stops for it later. The skill's session-intake reference says
  the same in its test-order proof policy.
- The QA skill follows an answer the operator already gave and does not pause
  QA to ask again. When nobody asked earlier, it asks once before the first
  test order.
- `qa run` is unchanged: it has no permission flag and none is added. Its
  help text and the docs are unchanged.
- Bundled skills carry revision `1.50.0+skills.2`, with each skill version
  advanced one patch.

## [1.50.0+agent.4] - 2026-10-02

### Changed

- At the QA stage, `next` lists a second QA command when the CampaignSpec's
  checkout declares an order bump (`is_upsell: true` rows). `qa_run_bump`,
  beside `qa_run`, is the same `qa run --browser --test-order common` with
  `--cart <base>:1,<bump>:1`, so its test orders carry the add-on and prove
  its charge. Until now `next` named only the default run. Its test orders
  never toggle a bump, because the tier planner skips bump rows by design and
  bump coverage comes from `--cart`, so a verdict could read ready with the
  add-on never ordered. The base is the first selector tier the checkout
  declares; a checkout that declares no tier gets the bump alone, and several
  declared bumps share one cart. The QA stage prompt and the human `next`
  output name the same command, and `docs/qa-and-test-orders.md` says so
  under its launch-grade proof list. The bump is read from the one checkout
  QA's test orders run on, the first enabled checkout across funnels, so a
  bump declared only on a later funnel's checkout gets no command. When the
  CampaignSpec does not parse, `next` warns
  (`next.order_bump_spec_unreadable`) instead of silently naming no bump
  command.
- A progress snapshot records `qa_run_bump` as `qa_run`. The snapshot's
  action vocabulary is unchanged, and a ready QA continuation does not read
  as blocked.
- The QA tier planner reads its bump and tier helpers from the
  commercial-journey module, where `next` reads them too. Tier planning is
  unchanged.

## [1.50.0+agent.3] - 2026-10-02

### Changed

- The Campaign Build Brief question `promo_urgency_copy` now asks only about
  the starter template's own promo placeholders: demo countdown timers, promo
  banners, placeholder voucher codes and exit-pop offers. It asks whether to
  fill them from the campaign's promo codes and offers or remove them. It no
  longer asks which promo, savings and urgency language is approved, which
  read as a request to approve the source design's own copy; that copy is the
  merchant's content and is built as designed.
- The question is asked only when the CampaignSpec maps a surface that fills
  those placeholders: a `funnels[].promo_codes` roster, or a checkout page's
  enabled `exit_intent` or `promo_code_input`. It used to be asked for any CampaignSpec
  key naming an offer, discount, timer or urgency, so the offer catalog,
  before-discount prices and design slot names all raised it. Without such a
  surface the guided draft sets `promo_urgency.header_claim_source` and
  `promo_urgency.timer_label` to `"none"` (the template's promo placeholders
  are removed). The draft used to set `timer_label` to "Limited-time offer".
- Doctor's `build_brief.guided_questions` warning names the brief fields that
  close each open question and says how to record the answers: copy the
  normalized draft to `campaign-build-brief.json` in the target repo, set the
  fields, and re-run `start` or `prepare-build`. It also says the re-run needs
  `--force`, which clears stage evidence, once a stage has recorded evidence.
  `build_brief.questions_unanswered` names the fields too. An answer given
  only in conversation was never recorded, so a later session asked again.
- `next`'s QA prompt compares the template's own promo placeholders and trust
  badges with the brief and says not to flag the source design's own proof,
  urgency or guarantee elements. It used to ask for promo/urgency copy and
  trust/guarantee claims to be compared. The build prompt names the template's
  promo placeholders where it named promo/urgency language.
- `docs/campaign-build-brief.md` rewords question 5 and adds "Answering The
  Questions", with the fields that close each question.

## [1.50.0+agent.2] - 2026-10-02

### Changed

- `docs/build-packet.md` says how to read a campaign's package, offer and
  shipping refs for a local CampaignSpec. Its new "Reading package, offer and
  shipping refs" section, under "Local-spec entry", gives the read doctor and
  QA already make against the live campaign: one GET of NEXT's proxy,
  `https://campaign-map.nextcommerce.com/api/campaign`, with the public
  Campaigns API key in the `X-Campaign-Key` header. It shows a `node` and a
  `curl` form, describes the envelope, and maps the campaign retrieve body's
  `id`, `packages[]`, `offers[]` and `shipping_methods[]` to
  `campaign.ref_id`, `funnels[].pages[].packages[]`, root `offers[]` and root
  `shipping_methods[]`. It also notes that the proxy refuses some default user
  agents, Python `urllib`'s and Perl `libwww-perl`'s among them. No command
  writes these refs, as before.
- With no saved gateway login, `tooling status` no longer only says to run
  `login`. Its warning says login is optional and only lets `spec derive
  --from-store` fill the Store Profile fields, and a second warning says
  package, offer and shipping refs never come from the gateway login and
  where the public-key read is documented. Both lines are under `warnings`,
  and the exit code is unchanged.

## [1.50.0+agent.1] - 2026-10-02

### Changed

- No command behaves differently. A comment in the QA browser module that
  explains how repeated package declarations become purchase multipliers
  named an internal store as its example; it now gives a neutral one (a 1x
  and a 2x package). Two QA test files swap the same name in a fixture SKU
  and a hosted-checkout URL for neutral placeholders, and the same fixture's
  product title becomes "Demo Bag". Comment and test fixtures only; every
  message and every exit code is unchanged.
- The private-string check adds that store name to its hashed list, so it
  cannot return.

## [1.50.0] - 2026-10-02

### Changed

- With `qa run --browser`, each page's `page-binding:<page_id>` row comes
  from the key the Campaign Cart SDK actually sent. The SDK sends the page's
  key as `Authorization` on every Campaigns API request. The browser pass
  reads that header on each page it loads, compares it with the expected key
  in memory and keeps only the outcome: `match` (pass) when every request
  carried the expected key, `mismatch` (blocker) when any carried another.
  The key itself is never recorded. The static read of a page's declarations
  could not resolve most real pages: the starter templates' `config.js` opens
  with `window.dataLayer = window.dataLayer || []` and
  `window.nextReady = window.nextReady || []`, which the static grammar treats
  as dynamic, so every starter page was left for manual review, and inline
  scripts, `async` scripts and scripts from other origins left other pages
  the same way. A page that sends no Campaigns API request, a run with no
  single expected key, and `qa run` without `--browser` keep the static read.
- The QA verdict schema's page-binding evidence accepts
  `observation: "sdk_request"` and the `sdk_request` source kind for that row.
  Nothing is removed, so every verdict that validated before still does.
  `docs/qa-and-test-orders.md` describes both observations.
- Ships the same-surface changes recorded since 1.49.0, each described in
  its own section below: the agent context spells every command
  `npx --no-install campaigns-os …` and carries the build skill's proof rule
  (`+agent.1`); and the install-mode module drops a stale comment, with no
  behavior change (`+agent.2`).
- Package and supported-surface version advance to 1.50.0 for the QA verdict
  schema hash. The local setup install command pins 1.50.0. Bundled skills
  carry revision `1.50.0+skills.1`, with each skill version advanced one
  patch. The skill text is unchanged.

## [1.49.0+agent.2] - 2026-10-02

### Changed

- No command behaves differently. The install-mode module drops a trailing
  comment that described `applyInvocationPrefix`, a function removed when
  commands began to be spelled with their prefix at the source (`cmd()` and
  `asInvocation` in the install-invocation module). Comment-only; every
  message and every exit code is unchanged.

## [1.49.0+agent.1] - 2026-10-02

### Changed

- The agent context that `install-agent-context` and `tooling setup` write
  (`agents/claude/CLAUDE.md`, `agents/codex/AGENTS.md`,
  `agents/copilot/copilot-instructions.md`, `agents/cursor/campaigns-os.mdc`)
  spells every command `npx --no-install campaigns-os …`, as the skills and
  `AGENTS.md` do. It said `campaigns-os readback .`, `campaigns-os qa run …`
  and so on, and fresh sessions ran them as written: "command not found"
  where nothing is installed globally, and an older global copy instead of
  the campaign's pinned one where something is. A test keeps bare commands
  out of the agent context.
- The agent context carries the build skill's proof rule: reproduce the
  source design's own proof and urgency elements as designed, and do not
  remove, soften or flag them. The rule was only in the build and polish
  skills, and sessions were still questioning or removing the merchant's
  proof.
- An installed copy keeps the old text until `install-agent-context`
  refreshes it.

## [1.49.0] - 2026-10-02

### Added

- `campaigns-os record theme --packet <p>` records an applied brand layer on
  the Assembly Report, where the theme gate previously sent the operator to
  edit `report.theme` by hand. It reads each built commerce page's stylesheet
  links in document order. A page that loads `next-core.css` must load
  `brand-theme.css` (or `checkout-brand.css`) after it, and that file must be
  in the built output. A page that loads neither renders the design's own
  markup and is left out, noted in the evidence. When every page passes and at
  least one loads the brand layer, it writes `report.theme`: status `applied`,
  `load_order` `after-next-core`, `css_path`, `commerce_pages` and one evidence
  line per page, and clears any earlier theme waiver. Otherwise it is refused,
  naming each page, and writes nothing. Build must be recorded for the current
  output first. `--dry-run` runs every check and writes nothing.
- `campaigns-os record deploy --packet <p> --base-url <url>` records a local
  preview (`deploy.target: local-serve`), where `next` previously sent the
  operator to edit the packet and `stages.deploy` by hand. The URL must be a
  loopback origin naming the campaign's route root. Every built page is
  requested under it and must answer 2xx. It then writes the packet's
  `deploy.preview_url` and `stages.deploy` completed, with the URL in
  `outputs` and one evidence line per page. It is refused, writing nothing,
  when any check fails, when polish is not recorded, when the built output
  changed since build was recorded, or while the theme gate is blocked. The
  requests stay on this machine. `--dry-run` runs every check, the requests
  included, and writes nothing.

### Changed

- The theme gate's apply and load-order actions, the starter-palette notice,
  the build prompt, the build and polish skills, `docs/brand-theme-bridge.md`
  and `docs/build-packet.md` name `record theme` where they described a hand
  edit of `report.theme`.
- `next`'s local-serve deploy action and deploy prompt,
  `docs/build-packet.md` and `docs/qa-and-test-orders.md` name `record deploy`
  where they described a hand edit of `deploy.preview_url` and
  `stages.deploy`.
- `contracts/effects.v1.json` declares `record theme`, `record deploy` and
  their `--dry-run` forms.
- The Build Packet schema's `assembly.template_family` accepts every family
  the commerce surface catalog and the private template sources name:
  `apollo`, `apollo-mv-single-step`, `arjuna` and `karna` join the enum, which
  had fallen behind both. Nothing is removed, so every packet that validated
  before still does.
- Package and supported-surface version advance to 1.49.0 for the effects
  contract and Build Packet schema hashes. The local setup install command pins 1.49.0. Bundled skills
  carry revision `1.49.0+skills.1`, with each skill version advanced one patch;
  the build and polish skills also name `record theme`.

## [1.48.0] - 2026-10-02

### Changed

- The supported surface advances to 1.48.0 and ships the same-surface
  changes recorded since 1.47.0, each described in its own section below:
  the local setup command starts with `npm init -y` (`+agent.1`); the
  `start`, `prepare-build` and `build` usage lines list
  `--deploy-target`, `--preview-url` and `--production-url` (`+agent.6`);
  doctor no longer scans built pages for proof and urgency copy
  (`+agent.7`); QA stops failing the checkout price check on a checkout whose
  cart is filled on an earlier page, and recognises the starter templates'
  SDK loader (`+agent.8`); `readback` shows `warn` and `manual_review` rows as
  themselves, and the agent context sends a resumed session to `readback`
  and `next` first (`+agent.9`); a test order refused as a duplicate says so
  (`+agent.10`); doctor's missing SDK pin message names the SDK the template
  family was verified against (`+agent.11`); the local preview carries
  missing polish and page-load evidence forward as warnings, so a campaign
  built from a starter template can reach a test order (`+agent.12`); and the
  vendored starter-template catalog is pinned to
  campaign-cart-starter-templates `37a8d94` (`+agent.13`).
- The bundled SDK support policy's `latest_known_release` returns to 0.4.38,
  the value 1.47.0 shipped; `+agent.11` had moved it to 0.4.40. The policy
  line only feeds template freshness, where the catalog's verification
  records already name 0.4.40 as the current SDK, so freshness results and
  doctor's missing SDK pin message are unchanged.
- Bundled skills carry revision `1.48.0+skills.1`, with each skill version
  advanced one patch, and the local setup install command pins the 1.48.0
  package. The skill text is unchanged.

## [1.47.0+agent.13] - 2026-10-02

### Changed

- The vendored starter-template catalog is re-synced to
  campaign-cart-starter-templates `37a8d94` (was `3793b1d`). That brings in
  the single-offer upsell copy priced outside the offer, order bumps that hide
  their savings line and badge when the package has no discount, the
  `is_upsell` wording for order reports, and refreshed template verification
  evidence for Campaign Cart SDK 0.4.40. The verified SDK and the SDK support
  policy are unchanged.
- `fixtures/certified-families` is regenerated at the new pin, and the shared
  commerce brand contract's payment-chrome `asset_pin` moves with it. The
  shipped asset bytes are unchanged.

## [1.47.0+agent.12] - 2026-10-01

### Changed

- On the local preview (a `local-serve` packet served from a loopback host),
  missing polish and page-load evidence no longer stops the loop before a
  typed-card order. One policy, `src/local-preview-policy.mjs`, carries
  forward `polish.evidence_missing` / `polish.report_missing`, a page-load
  checkpoint with no capture recorded, and the new
  `polish.hidden_eager_media.no_capturable_routes` (every mapped page is
  template stock). It also makes starter-template residue a warning when the
  theme gate finds nothing generatable. Doctor reports these as warnings,
  `next` moves past polish, and QA records `warn` rows, so the verdict is at
  best `ready_with_exceptions`. A campaign built from a starter template with
  no design can now reach a toolkit test order locally. Hosted preview and
  production packets, other checks, `record polish` and the waiver commands
  are unchanged. `docs/qa-and-test-orders.md` lists the carried-forward
  checks.
- An all-template-stock packet's page-load checkpoint now reports
  `polish.hidden_eager_media.no_capturable_routes` instead of the
  malformed-authority `capture_malformed`, and `polish capture` says why it
  has nothing to capture. It still blocks off the local preview, with one
  action: map a page to its design source, or prove on the local preview.

## [1.47.0+agent.11] - 2026-10-01

### Changed

- `doctor`'s `page_kit.sdk_version.spec_missing` now names the SDK the
  selected certified template family was last verified against (for
  example `The "apollo" template family was last verified against
  0.4.40.`), so the CampaignSpec pin is not chosen by searching docs. The
  bundled SDK support policy's `latest_known_release` moves from 0.4.38 to
  0.4.40, which the catalog's verification records already named.
- `source_html.prep.document_wrapper` names the two ways to record a
  standalone page as whole: `--wrapper-policy preserve_document_wrappers`
  on `start` or `prepare-build`, or `wrapper_policy` in the source-html
  manifest.
- `source_html.pages.source_hash` now says the hash it compares is the one
  intake recorded in the Build Packet, that re-running intake with
  `--force` refreshes it (and clears recorded stage evidence), and that
  editing the manifest alone does not. It no longer points at a producer
  script. `docs/build-packet.md` says the same, and that a revision made
  after build belongs under `src/<route>/`.

## [1.47.0+agent.10] - 2026-10-01

### Fixed

- A test order the platform refuses as a duplicate now says so. The order
  API puts the reason in `payment_details`, which QA's response capture
  dropped, so the `browser-test-order` row read only
  `order create rejected: HTTP 400`. The capture now keeps a string
  `payment_details` on an error response, and a duplicate-order refusal adds `duplicate_order`
  with the remedy: re-run with a different `--test-email-prefix` (or
  `--test-email`), or wait up to 30 minutes. `docs/qa-and-test-orders.md`
  explains what the platform matches on and why concurrent runs collide.

## [1.47.0+agent.9] - 2026-10-01

### Changed

- The agent context `install-agent-context` writes (`agents/claude/CLAUDE.md`,
  `agents/codex/AGENTS.md`, `agents/copilot/copilot-instructions.md`,
  `agents/cursor/campaigns-os.mdc`) now tells a session picking up an
  existing campaign to run `readback` and `next` before reading artifacts by
  hand. It also says the committed `.campaign-runtime/qa-verdict.json` keeps
  no order records or URLs, so its `browser-test-order:<path>` assertions are
  the typed-card proof. A resumed session had read the sidecar's empty
  `test_orders` as "no test orders" after five verified orders.
- The `campaign-run-evidence` skill says the same: the sidecar always
  empties `test_orders` and the URL fields, so an empty `test_orders` there
  says nothing about ordering. Bundled skills carry revision
  `1.47.0+skills.3`, with each skill version advanced two patches from
  `1.47.0+skills.1`.

### Fixed

- `readback` shows `warn` and `manual_review` assertions as the verdict
  statuses they are, with their severity, recorded `actual` and evidence
  problems (as it does for `fail` rows), instead of counting them as
  "unrecognized status".

## [1.47.0+agent.8] - 2026-10-01

### Fixed

- `qa run` no longer fails `pricing.checkout_price_visible` on a checkout
  whose cart is filled on an earlier page. When QA opens such a checkout
  directly, the SDK cart is empty and the page has no package selection of its
  own, so no price can show. The row is now `skipped` with that reason and
  records `cart_count` and `checkout_selection_surface`. The test order
  already enters that cart from the landing page. A checkout with its own
  package selection, or a filled cart, still fails when no price shows.
- The page-binding check recognises `campaign-cart@<tag>/dist/loader.js`, the
  SDK loader the starter templates use, and no longer tries to fetch it as a
  cross-origin config script. Starter-template pages now report
  `dynamic_unresolved` instead of `script_unavailable_or_limit`; they still
  need manual review, because the static reader cannot prove a binding on a
  page that runs other scripts.

## [1.47.0+agent.7] - 2026-10-01

### Removed

- `doctor` no longer scans built pages for proof and urgency copy. The
  `content_residue.anti_pattern` warning (review counts, "Verified Purchase"
  labels, stock and sell-out lines, expert and press mentions) is gone, and so
  is `content_residue.urgency_unattested`, which asked a campaign without a
  brief payload to confirm its countdown was real. That copy belongs to the
  merchant, and agents read the warnings as a reason to strip it from the
  merchant's own designs. Template demo residue, the needs-merchant-input
  marker, the discount-claim warnings and the brief-backed urgency and proof
  attestation gates are unchanged.

### Changed

- The `next-campaigns-build` and `next-campaigns-polish` skills now say to
  reproduce the source design's own proof and urgency elements (reviews,
  "Verified Purchase" labels, recent-purchase popups, stock counters,
  countdowns, guarantees) as designed, and not to record them as polish
  issues. `docs/campaign-build-brief.md` says the same. Bundled skills carry
  revision `1.47.0+skills.2`, with each skill version advanced one patch.

## [1.47.0+agent.6] - 2026-10-01

### Changed

- The usage lines for `start`, `prepare-build` and `build` now list
  `--deploy-target <target>`, `--preview-url <url>` and
  `--production-url <url>`. Intake has always written them to the Build
  Packet's `deploy` block (`deploy.target` defaults to `unknown`), and
  `docs/build-packet.md`, the README and the Start page already pass
  `--deploy-target local-serve` to `start`, but the help text left them out,
  so an agent checking that command against the help read it as
  unsupported. Behaviour is unchanged.

## [1.47.0+agent.1] - 2026-10-01

### Fixed

- The one-line setup command in `docs/local-setup.md` now starts with
  `npm init -y`. Without a `package.json` in the campaign folder, npm installs
  into the nearest parent folder that has a `package.json` or `node_modules`,
  so a campaign folder created inside another project added page-kit and the
  toolkit to that project instead of the campaign. The README and quickstart
  installs already started with `npm init -y`; a test now holds all three to
  it.

## [1.47.0] - 2026-10-01

### Changed

- `contracts/effects.v1.json`: the `--force` notes on `start`,
  `prepare-build` and `build` now say that `--force` also regenerates a stale
  Design Source Package that the intake synthesized itself (#506). That holds
  when the previous Assembly Report records origin `"synthesized"` and the
  package bytes still match it. An adopted or hand-edited package is never
  replaced. The declared writes already covered this path, so behaviour is
  unchanged; only the notes were incomplete.
- `compatibility.json` names the package version again. It still said 1.34.0
  (#486). A unit test now fails when it differs from `package.json`.
- Bundled skills carry revision `1.47.0+skills.1`, with each skill version
  advanced one patch, and the local setup install command pins the 1.47.0
  package. The skill text is unchanged.

## [1.46.0+agent.11] - 2026-10-01

### Changed

- `doctor`'s `built_output.script_syntax` gate groups missing-script warnings
  by the URL the browser resolves, not the raw src. Two spellings of one URL,
  such as `check&#9;out.js` and `checkout.js`, now give one
  `built_output.script_syntax.missing_script` warning instead of two. One src
  that names different files on pages in different folders still gives one
  warning per file.
- A `<script>` the page ends inside, with no `</script>`, is no longer parsed
  by doctor or QA: the browser never runs a script element whose end tag never
  arrives, so it can no longer block either. Doctor warns about it under the
  new `built_output.script_syntax.unclosed_script` code, one warning per page,
  because the page output is probably truncated.
- A script symlink under `_site` is read by following the link only while its
  real path stays inside the site root. A link whose target is outside the
  site root is not read. Doctor warns under the new
  `built_output.script_syntax.symlink_outside_site` code, naming the link, and
  does not block. The gate lists such links in `scripts_outside_site[]`. The
  rule is recorded in `docs/build-packet.md`.

## [1.46.0+agent.10] - 2026-10-01

### Fixed

- `qa run --test-order` now follows a redirected order upsell mutation. When
  the accept's POST to the order-upsells URL answered 307 or 308, the step
  took the redirect hop as the mutation's response and judged the upsell
  without the order body. It now waits for the redirect chain's final
  response and judges from that body. A late body is matched to the step by
  the request that started its redirect chain, so every hop of one redirected
  POST counts as the step's request and a body from another request still
  never does. A redirect whose chain has no final response is reported as no
  mutation response, not as answered.

## [1.46.0+agent.9] - 2026-10-01

### Fixed

- `qa run` analytics parity no longer blocks on `purchase-present` when the
  operator did not pass `--analytics-candidate`. The automatic candidate (the
  campaign root, or the first built entry) is not a receipt page, so a Purchase
  cannot fire there. When that candidate fires no Purchase, `purchase-present`
  is now `MANUAL_REVIEW`/`WARN`, and `evidence.page_mismatch` gives the reason
  (`receipt_baseline_non_receipt_candidate` or `candidate_not_receipt`), the
  candidate's source and its page type. An explicit `--analytics-candidate`,
  or a built entry whose topology page type is a receipt, still blocks on a
  missing Purchase. To compare Purchase, pass the candidate receipt with
  `--analytics-candidate`.

## [1.46.0+agent.8] - 2026-10-01

### Fixed

- The local setup command in `docs/local-setup.md` installed both the toolkit
  and `next-campaign-page-kit` with `--save-dev`. In an existing page-kit
  project that moved page-kit from `dependencies` to `devDependencies`, so
  builds that run `npm ci --omit=dev` or set `NODE_ENV=production` no longer
  installed it. The command now installs page-kit with `--save-exact` only and
  the toolkit with `--save-dev --save-exact`, so a project that declares
  page-kit under `dependencies` keeps it there. The README and quickstart
  page-kit installs also pin exactly.
- `tooling setup` now warns when the project declares page-kit only in
  `devDependencies`, and prints the command that moves it back. The warning
  appears in the text output and in a new `warnings` array in the `--json`
  result; setup still proceeds.

## [1.46.0+agent.7] - 2026-10-01

### Changed

- The vendored starter-template catalog is re-synced to
  campaign-cart-starter-templates `3793b1d` (was `11352c3`). That brings in the
  runtime-gated payment logos, the composable upsell pages, the `is_upsell`
  opt-out on every bump include, and template verification evidence for
  Campaign Cart SDK 0.4.40. Family certification freshness now reads 0.4.40 as
  the verified SDK. The SDK support policy (minimum and preferred versions) is
  unchanged.
- `fixtures/certified-families` is regenerated at the new pin, and the shared
  commerce brand contract's payment-chrome `asset_pin` moves with it. The
  shipped asset bytes are unchanged. The payment-chrome repair text now says
  to set `payment_flags.show_<method>: false` in the page frontmatter when a
  logo from the starter `payment-logos.html` row is flagged, instead of
  deleting markup. `upsell-payment-logos.svg` stays listed because the
  starter still renders it ungated under `payment_flags.style: flat` and on
  one select page.

## [1.46.0+agent.6] - 2026-10-01

### Fixed

- `sdk storage-check` accepts a Campaign Cart release manifest whose SDK
  version is above its supported range. Released manifests stamp their own
  release version but declare an earlier supported range (v0.4.40 declares
  0.4.38 only), and the check refused every one of them with "Manifest
  source SDK version must equal supported maximum". The target SDK is still
  judged against the declared range, so a target outside it reports unknown
  (`target-outside-manifest-range`). A manifest whose SDK version is below its
  supported maximum is still refused, because it cannot vouch for later
  releases. The report keeps recording the manifest's SDK version and range
  separately.

## [1.46.0+agent.5] - 2026-10-01

### Removed

- `doctor` no longer warns with `built_output.sdk_markup.checkout_bump_is_upsell`
  (added in `1.45.0+agent.5`). When a shopper selects an order bump on a
  checkout page, it is added as a line item on the checkout order. With
  `data-next-is-upsell="true"` that line is tagged as an upsell, so platform
  order reports show upsell items apart from the core items. That tagging is
  the intended default. The warning fired on every canonical starter checkout
  with a bump and told the user to remove the attribute, which would report
  the bump as a core item. Leave the attribute in place. A campaign that
  should not tag a bump as an upsell opts out by passing `is_upsell: false` to
  the bump include. Doctor reports no finding for the attribute either way.

## [1.46.0+agent.4] - 2026-10-01

### Changed

- The `next-campaigns-qa` and `next-campaigns-build` skills now say which
  checkout controls count as bound for `browser-commerce-structure`: a
  required field bound only on a `type="hidden"` input, a disabled control, a
  read-only input or read-only textarea, or a control with
  `aria-disabled="true"` does not count, and QA reports it in `fields_bound.missing`. This is the rule QA
  has applied since #540; the skills had not stated it. Bundled skills carry
  revision `1.46.0+skills.2`, with each skill version advanced one patch. No
  change to the CLI.

## [1.46.0+agent.3] - 2026-09-30

### Changed

- Comments, test fixtures, docs and example reports no longer name real
  merchants, partners or their products. Provenance comments now say "a
  production build" instead, the root-served route examples use the synthetic
  slug `rootfunnel`, and the three Campaign Standardization Report examples are
  renamed to `multi-root-repo.md`, `repo-root-campaign.md` and
  `subfolder-campaign.md` with synthetic repo and slug names. The doctor
  `analytics_contract.content_param_no_handler` message drops its build
  reference; its code, trigger and detail fields are unchanged.

## [1.46.0+agent.2] - 2026-09-30

### Fixed

- The effects test for `campaigns-os login` no longer contacts the real login
  gateway. The gateway host is hard-coded and now resolves on the public
  internet, so the case, which assumed the gateway was unreachable offline,
  sent a real device-authorization request on every run and failed the
  "no connection off this machine" check in CI. The harness now answers the
  DNS lookup for that one host with ENOTFOUND, so login takes its offline
  failure path. Any other off-machine connection still fails the case. No
  change to the CLI.

## [1.46.0+agent.1] - 2026-09-30

### Fixed

- The shared slot manifest now declares the upsell pages and keys that starter
  templates #184 and #187 added, so `check:slot-manifest` passes against the
  current templates and the next starter-catalog refresh will not fail on it.
  New pages: `upsell-single` and `upsell-vsl`. New keys on the three bundle
  upsell pages: `announcement_text`, `upsell_hero` and `upsell_layout`. Layout
  and header knobs are template-owned. The manifest may declare slots the
  pinned templates do not carry yet, so against the currently pinned templates
  this only adds notes.

## [1.46.0] - 2026-09-30

### Added

- `campaigns-os record setup`, `record build` and `record polish` record a
  stage's completion so agents no longer hand-edit
  `.campaign-runtime/build-context.json` or
  `.campaign-runtime/assembly-report.json` (#535). `record setup` sets
  `scaffold.required` to false and `stages.setup` to completed once the
  campaign output directory exists, so `next` moves on to build. `record build`
  stamps `stages.assembly.build_fingerprint` with the fingerprint doctor
  computes from `_site/<slug>/`, adds the Design Source Package material
  fingerprint when the report has one, and marks Polish required. Re-run it
  after every rebuild. `record polish --evidence <file>` reads the status, the
  seven evidence fields and an optional `repair_loop_defect` from a JSON file,
  binds them to the current build and keeps the captured `page_load`. The same
  file records a blocked Polish (`status: "blocked"` with `blockers`) or a
  skipped one (`status: "skipped"` with `skip_reason`).
- Each command validates what it would write against the existing Build
  Context and Assembly Report schemas and doctor's report checks. A completed
  `record polish` also requires that the polish gate would pass. Each command
  refuses a stage `next` has not reached: while `next` answers prepare-build,
  or while an earlier stage is not complete. On any failure the
  command exits non-zero, lists each problem by field (for example
  `repair_loop_defect` given as a string), and writes nothing. It also writes
  nothing when the Build Packet or report is missing, or when doctor cannot
  compute the build fingerprint. Each command also refuses a report bound to
  another packet or campaign, with the binding code `next` reports (for
  example `next.prepare_build.report_campaign_mismatch`). Everything a record
  depends on is re-read under the target lock: the packet is read first only
  to name the lock and re-checked under it, and the report the Build Context
  binds, the report itself and doctor's fingerprint are all read under the
  same lock as the write. Output that changes before the write is refused
  rather than recorded with the old fingerprint. `--dry-run` runs every check,
  takes no lock and writes nothing. Unknown flags are refused before anything
  is read.
- The commands are `record <stage>` rather than the `<stage> record` spelling
  #535 proposed: `build` is already the intake alias and ignores extra words,
  so `build record` already runs an intake. `build` and `polish` behave
  exactly as before.
- `next`, the setup, build and polish prompts, the bundled skills,
  `docs/build-packet.md` and `docs/polish-evidence.md` now name these commands
  instead of describing hand edits. `contracts/effects.v1.json` declares each
  command and its `--dry-run` form. Bundled skills carry revision
  `1.46.0+skills.1`, with each skill version advanced one patch, and the local
  setup install command pins the 1.46.0 package.

## [1.45.0+agent.6] - 2026-09-30

### Changed

- An explicit `""` (or whitespace-only string) in one of the eight optional
  Store Profile fields (`campaign.store_name`, `store_terms`, `store_privacy`,
  `store_contact`, `store_returns`, `store_shipping`, `store_phone`,
  `store_phone_tel`) now means the merchant has no such value (#535).
  `page-kit sync` blanks a recognised starter demo value in such a field (the
  placeholder storefront URLs and phone number; the starter's demo store name
  is not recognised and stays a `target_only` warning), where it previously
  left the demo value in place and reported it as not synced, and doctor
  offers `page-kit sync` as the repair for that demo residue. Doctor reads a
  blank or absent target field as `intentionally_empty`, a clean status named
  in the gate reason and the doctor line, including alongside `target_only`
  warnings. An absent or null field still means "not provided", and `""` in
  any other field carries no such meaning.
- `campaign.store_url` stays required. `store_url: ""` still raises doctor's
  `spec.store_profile` error, which now says an explicit `""` does not mark a
  required field as having none; sync still blanks the demo storefront URL
  with it, and the gate reason says the field is still required.
- A real, non-demo target value under a spec `""` is left as it is and still
  warns as `target_only`, so a spec `""` never wipes or newly blocks a value
  entered in the target. `page-kit sync` now says so: the field stays in
  `not_in_spec[]` and is also listed in a new `spec_empty_not_applied[]`,
  printed as `Spec "" not applied` rather than `Not in spec`. The
  `target_only` warning, and the repair text for a malformed target value
  under a spec `""`, say the `""` was not applied and the value must be
  removed by hand.
- The CampaignSpec validator no longer warns `store-phone-tel-empty` for
  `campaign.store_phone_tel: ""`, and no longer warns
  `store-phone-tel-bad-type` for `campaign.store_phone_tel: null` (null means
  not provided). Empty strings elsewhere keep their warnings.

## [1.45.0+agent.5] - 2026-09-30

### Added

- `doctor` warns with `built_output.sdk_markup.checkout_bump_is_upsell` when a
  checkout page carries `data-next-is-upsell="true"` on an order bump (#535).
  A checkout bump is a pre-purchase add-on, and the flag puts it on the
  initial order as an upsell line. The warning names the page and each flagged
  element. The page type is read from the page's live `next-page-type`
  meta, or from its route when that meta is absent, blank, inside a `<template>` or conflicting. Upsell,
  downsell and receipt pages, and bumps without the flag, get no warning. The
  flag comes from the bump include's markup, and several starter bump includes
  write it unconditionally, so a canonical starter checkout with a bump shows
  this warning. It was a warning, not a blocker. Its advice to remove
  `data-next-is-upsell="true"` was wrong: tagging a checkout bump line as an
  upsell is the intended default, so order reports show upsell items apart
  from core items, and removing the attribute would report the bump as a core
  item. The warning is retired in `1.46.0+agent.5`.

### Fixed

- `theme generate` keeps the CTA label colour the source declares (#535).
  When the source declares a CTA foreground that reaches 3:1 on the CTA
  background (WCAG AA for large text), `--brand--color--text-inverse` and
  `--brand--color--cta-foreground` use it instead of the higher-contrast
  black or white pick. The declared foreground is, in order: the one `color:`
  every button rule on the CTA background agrees on; a `:root` inverse or
  on-colour text token such as `--text-inverse`, `--text-color-inverse`,
  `--text-on-primary` or `--foreground-on-dark` (the name needs a `text` or
  `foreground` part, so `--border-on-primary` does not count); or the one
  colour every other button rule agrees on. A `;` or `:` inside quotes or
  parentheses, as in a `data:` URL in a `background` shorthand, no longer
  splits a button rule's declaration. The same inverse and on-colour names,
  and only those, are the source's inverse text token when the source is
  compared with scaffold defaults, so `--text-on-dark` now counts and
  `--border-on-primary` or a bare `--on-primary` no longer does. A button
  rule targets `button`, `input[type=submit]`, or a class starting with
  `btn`, `button` or `cta` or having a `cta` part. Only the selector's own element, class and attribute
  parts count, not the text inside an attribute value or inside `:not()`,
  `:is()`, `:where()` or `:has()`, and any other pseudo-class disqualifies
  it. So `button:not(.order-summary)` supplies the label, while
  `.order-summary`, `.cart-count`, `.order-summary[data-target=".btn"]`,
  `.cart:has(.button)`, `[type=submit]` and `div[type="submit"]` never do.
  A declared white label on `#dd4249`
  (4.24:1) now stays white where it used to become black. A declared colour
  under 3:1 is ignored.
  One under 4.5:1 is used and reported with `theme.foreground.low_contrast`,
  so the theme status reads `ready_with_warnings`. Sources that declare no CTA
  foreground generate the same CSS as before.
- `theme generate` takes body text from the darkest declared text token
  (#535). When a source declares `:root` text colour tokens and a body
  background, `--brand--color--text-primary` and
  `--brand--color--foreground` use the darkest one that is darker than the
  background and reaches 4.5:1 on it, instead of a lighter grey. This applies
  even when the source has no primary text token of its own. Inverse and
  on-colour label tokens such as `--text-color-inverse` or `--text-on-dark`
  are not body text, whatever the word order, and neither are link, status and
  state colours (names with `link`, `error`, `danger`, `success`, `warning`,
  `info`, `highlight`, `accent`, `placeholder`, `disabled` or `selection`).
  Sources with no qualifying token generate the same CSS as before.
- `theme generate` no longer reads declarations inside CSS comments. A
  commented-out token or rule used to count as a source colour, so it could
  set the CTA label or body text; now it is skipped. A comment inside a rule
  also no longer hides the declaration after it. Sources without comments
  generate the same CSS as before. An inline `<style>` source is hashed as
  before, so an existing `brand-theme.css` is not reported stale after
  upgrading.

### Changed

- `docs/brand-theme-bridge.md` says `next-core.css` and the brand layer belong
  only on pages where the template family's components render. It says its
  element resets break design-owned upsell, downsell and receipt markup, and
  how to record the scoped pages in `report.theme.commerce_pages`, which the
  theme gate does not compare with the funnel. It also documents the declared
  CTA foreground and body-text rules above.

## [1.45.0+agent.4] - 2026-09-30

### Changed

- Agent deviation telemetry (#535): `qa install-browser`, `qa policy set` and
  `qa resolve` no longer record a deviation when `next` recommended another
  stage. They install the QA browser, edit QA policy, and report the resolved QA
  targets, and produce no stage output. `qa run` and
  every other subcommand of a tracked command are still compared with the
  recommendation. A deviation recorded with `--deviation-reason` now prints one
  line confirming the reason instead of the warning that asks for one.
- `next` (#535): when the assembly report and the repository's artifacts
  disagree, the `divergence_inspect` action quotes each divergence inline
  (stage, ledger claim, artifact evidence) and says that `divergences[]` is
  part of `next --json` output and is not written to any file; the
  prepare-build recovery prompt quotes the same entries. Text output previously
  stated a count and pointed at a `divergences[]` it did not show. Quoted values
  that come from the report, packet or QA verdict files (a deploy URL, a
  verdict) are folded to one line, with control characters replaced, so they
  cannot split or restyle the text.
- Doctor's `source_html.pages.coverage` error (#535): for an unmapped page with
  a Figma `design_source`, it says the Figma provenance gate
  (`source_html.producer_provenance`) needs the exporter's handoff manifest at
  `<source-root>/.campaigns-os/source-html-manifest.json`, instead of implying
  the manifest is optional. For a page with no `design_source`, an
  `ai-generated` one or another producer type, it names that manifest path, the
  schema file, and a minimal page entry to write by hand, since no exporter is
  needed there. When any active page's `design_source` is Figma, that hint
  says the manifest must pass the Figma provenance gate instead.
- `install-skills` (#535) lists each `SKILL.md` it wrote under `Read now` and
  says to read them in the current session, since a running agent does not load
  skills installed after it started; `--json` adds `read_now[]`. It no longer
  tells the agent to restart. When nothing changed it says there is nothing new
  to read. The `tooling status` install and refresh actions and the
  `tooling diagnose` stale-skills recovery give the same instruction, with a
  restart only if the agent cannot read the files.
- QA browser (#535): on a page whose final URL, after any redirect, is a
  Netlify preview host (any `*.netlify.app` host, or a `deploy-preview-<n>` /
  `deploy-preview-<n>--<site>` subdomain of a custom domain),
  `browser-console-errors` ignores a "Failed to load resource" error for the
  Netlify deploy-preview drawer's loader script,
  `https://netlify-cdp-loader.netlify.app/netlify.js`. The same error for any
  other request, including any other path on a Netlify host, or on a page that
  ends on any other host, still counts.
- README and quickstart (#535) install with `@<version>` instead of a pinned
  1.37.3, and say where the current release is listed (npm `latest`,
  `contracts/release-ledger.json`, this changelog). Their source-preparation
  guidance leads with standalone HTML mockups: keep them whole and set
  `wrapper_policy: preserve_document_wrappers`, with a hand-written manifest
  for pages without a Figma `design_source`. After a skills refresh they say to
  read the listed `SKILL.md` files in the running session.
- Bundled skills carry revision `1.45.0+skills.4`, with each skill version
  advanced one patch. `next-campaigns-build` gives the standalone-HTML route
  beside the wrapper-stripping conversion.

## [1.45.0+agent.3] - 2026-09-30

### Changed

- `qa run --browser` no longer fails a checkout for missing template-family
  shell classes when the checkout works (#532). In
  `browser-commerce-structure:<page>`, family shell is a fixed list:
  `.checkout-wrapper`, `.checkout-layout__left`, `.checkout-layout__right`,
  `.checkout__layout`, `.checkout__column--left`, `.checkout__column--right`
  and the `[data-next-component="shipping-field-row"]` include marker. When
  family shell is all that is missing, the row reports status `warn` with
  severity `warn` if the checkout passes three behaviour checks: a
  `<form data-next-checkout="form">` exists; `email`, `fname`, `lname`,
  `country`, `address1`, `city`, `province` and `postal` are each an input,
  select or textarea carrying that `data-next-checkout-field` inside the form,
  not a `type="hidden"` input, a `readonly` input or textarea, or a control
  that is disabled or `aria-disabled="true"` (a field hidden until a country
  is chosen still counts); and a cart-summary total is visible with text. If
  any check fails, or no checkout form is found, the row stays status `fail`.
  Any other missing selector always fails, including an SDK selector
  (`[data-next-checkout="form"]`, `[os-checkout-payment]`,
  `[data-next-cart-summary]`, `[data-next-bundle-slots-for]`) and a class the
  list does not name, such as a hosted payment field class.
  Evidence gains `behaviour` (`status`, `checkout_form`, `fields_bound`,
  `total_visible`) and a `kind` of `family_shell` or `sdk_wiring` on each
  `checks[]` entry.
- `pricing.upsell_price_visible:<page>` and `pricing.checkout_price_visible`
  count a visible `[data-next-bundle-display*='price']` node as a price row,
  so an upsell priced only through the SDK's bundle display passes. Hidden or
  zero-size nodes still do not count, and a bundle-display node also needs
  text: an empty one no longer counts on the checkout bundle surface either,
  where the shared contract already listed that selector.
- The build and QA skills say the checkout wrapper and page composition are
  source-owned and that QA checks the checkout's behaviour, not family class
  names; `docs/qa-and-test-orders.md` and `docs/campaigns-os-build-flow.md`
  say the same. Bundled skills carry revision `1.45.0+skills.3`, with each
  skill version advanced one patch; the examples in `docs/skills-revision.md`
  name that revision.

## [1.45.0+agent.2] - 2026-09-30

### Added

- `checkpoint waive` registers a fifth gate, `source_html.producer_provenance`,
  waived one page at a time with `--page <page_id>` (#534). It is for a
  CampaignSpec page whose `design_source` is Figma but whose approved source
  is hand-written HTML, so no figma-sections-export provenance exists. The
  usual rules apply: a named human, a reason, and an expiry or review
  condition, and `--dry-run` writes nothing. `--page` must name an active page
  with a Figma design source; any other id is refused, and the refusal lists
  the pages that qualify. The `<gate>:<page_id>` form is refused with the
  `--page` spelling to use instead.

### Changed

- Doctor reports one `source_html.producer_provenance` checkpoint gate per
  Figma-typed page, and reports the Figma-export findings (the
  `source_html.producer_provenance*` codes, `source_html.files.partial` and
  `source_html.files.asset`) once per such page, naming it in
  `detail.page_id`. A waived page's findings are warnings carrying
  `waived: true`; an unwaived page's findings stay errors. When every blocker
  is waived, doctor and `next` report `ready_with_waivers`. An expired, stale
  or malformed waiver no longer applies. Manifest validation, wrapper-policy
  and source-preparation findings, page mappings and screenshot proof keep
  their severity.
- When the manifest's generator names figma-sections-export in any form (with
  or without an `@<version>`, in any case, with surrounding whitespace), the
  findings stay manifest-wide errors, each page's gate reports `blocked` with
  the code `source_html.producer_provenance.exporter_claim` and the repair
  action, and `checkpoint waive` refuses the gate. Such a generator also makes
  doctor check Figma provenance even when no page has a Figma design source;
  before, only the `figma-sections-export@<version>` spelling did.
- A waiver for a page that no longer has a Figma design source, or one under a
  manifest whose generator claims figma-sections-export, is reported as the
  warning `source_html.producer_provenance.waiver_inert`.
- `next` lists the per-page `source_html.producer_provenance` gates after
  `theme_gate` and `polish_gate`, so the progress snapshot, which keeps the
  first 16 gates, always carries the campaign-wide gates.
- `tooling diagnose` exports `source_html.producer_provenance`, its
  `.source_type`, `.screenshot_fallback_used`, `.semantic_section_count`,
  `.material_fingerprint`, `.section_exports` and `.waiver_inert` codes as
  their own reason ids; before, each exported as
  `diagnostic.unsupported_reason`.
- The missing-mapping error for a Figma-typed page now also names the
  hand-written HTML route and the `checkpoint waive` command.
  `docs/design-source-package.md` documents the route: a hand-written
  manifest, `wrapper_policy: preserve_document_wrappers` for full-document
  HTML, and the per-page waiver.
- Bundled skills carry revision `1.45.0+skills.2`, with each skill version
  advanced one patch. The lifecycle skill lists the new gate.

### Fixed

- `checkpoint waive` refuses each value-taking flag (`--packet`, `--gate`,
  `--page`, `--reason`, `--waived-by`, `--expires-at`, `--review-condition`,
  `--report`) when it is given without a value or with an empty one, naming
  the flag. Before, a bare `--review-condition` was recorded as the condition
  `true`, supplying a bound nobody wrote, and a bare `--report` was read as a
  report path named `true`.

## [1.45.0+agent.1] - 2026-09-30

### Changed

- `prepare-build`, `start` and `build` strip a host from the front of a route
  in a Map fetched with `--map-id` (#531). Some saved Maps stored `page_url`
  values such as `shop.example.com/route/upsell/` instead of `/route/upsell/`,
  and every URL built from them nested the host inside the campaign route, so
  polish capture failed on every page. Intake now keeps the rooted path, with
  any query and fragment, for each host-prefixed `page_url` and
  `next-success-url`, `next-upsell-accept-url` or `next-upsell-decline-url`
  meta tag value, before anything reads the spec. Once the Assembly Report is
  published, it writes the rooted values to the fetched copy under
  `.campaign-runtime/fetched-specs/`; the report's `evidence[]` records each
  change as `routing_meta.host_stripped` with the value the Map returned in
  `from`, and one line on stderr says so. The run first checks that the
  fetched copy can be rewritten (it is not a symlink) and stops before
  publishing the report if it cannot. If publishing fails, the copy is left
  as fetched. If the rewrite itself fails after the report is published, one
  line on stderr says the report records the stripped hosts but the cached
  spec was not rewritten, and the run fails. A spec with no host-prefixed
  value is handled exactly as before.
- A dotted first segment ending in a page or script extension (`html`, `htm`,
  `shtml`, `php`, `asp`, `aspx`, `jsp`, `cgi`), such as
  `index.php/checkout/`, is a route, not a host.
- A local `--spec` file and a copy reused with `--cached-spec` are never
  rewritten. If either holds a host-prefixed route, intake prints one line
  naming each value and its rooted form, saying the local file must be edited
  or, for `--cached-spec`, to run again without it so the Map is fetched and
  normalised, and doctor blocks until then.
- A `--map-id` fetch stops with an error, before fetching and without writing
  anything, when `.campaign-runtime/`, `fetched-specs/` or the cache file is a
  symlink. The cache file is always replaced by a new file rather than written
  in place, so a hard link to the old file keeps its bytes.
- Doctor blocks a route with a bare (`shop.example.com/...`) or
  protocol-relative (`//shop.example.com/...`) host in front of it with the
  new `routing_meta.host_prefixed` error, naming each value and its rooted
  form. An absolute `http(s)://` `page_url` or routing meta value is accepted
  as before. Such values no longer appear in the `routing_meta.runtime_root`
  warning; every other `runtime_root` finding keeps its warning and message.

## [1.45.0] - 2026-09-30

### Changed

- Package and supported-surface version advance to 1.45.0.
- `doctor --packet` checks every built page's shipping and package refs against
  the live campaign as well as the CampaignSpec (#533). When the packet's built
  `_site/<route>/` exists and a public Campaigns API key resolves (the packet,
  its local CampaignSpec, or the declared campaign-key env var), doctor makes
  one read-only `GET {proxy-base}/api/campaign` with the key in
  `X-Campaign-Key`, adding `?ref_id=<id>` when the CampaignSpec's
  `campaign.ref_id` names the campaign. No store or Admin credential is used
  and nothing is written. `doctor` accepts `--proxy-base <url>` (https, or
  loopback over http). `qa run` makes the same read when it has read at least
  one served page and a key resolves, and records the result in the verdict
  as `api-metadata` assertions with the same codes.
- The campaign is read from the proxy envelope's `data`: one campaign, or an
  array picked by `campaign.ref_id` or holding exactly one. A campaign not
  carrying the asked-for ref (`ref_id`, else `id`), or none, is `not_run`
  (`campaign_mismatch`).
- A page ref the live campaign does not serve is a blocker,
  `built_output.shipping_ref_live_missing` or
  `built_output.package_ref_live_missing`, even when the CampaignSpec lists no
  shipping methods. Doctor compares every built `.html` page in
  `_site/<route>/` but `404.html` and `_`/`.` directories, naming unlisted
  pages by path. CampaignSpec refs the live campaign lacks, or the reverse,
  are the separate warning `spec.campaign_drift`, which never softens a page
  blocker.
- A read that is not made or fails is `not_run` with a reason, never a pass,
  and never falls back to the CampaignSpec list. Doctor records it in
  `derived.live_campaign_refs`. No key, no built page and `--no-live-refs`
  (`disabled`) make no request and raise no warning. A failed read is the
  warning `built_output.live_refs_not_run`: no response, a non-2xx, a
  10-second timeout, an `ok: false` envelope or one with an `error` and no
  campaign (`proxy_error`), several campaigns and no `campaign.ref_id`
  (`ambiguous_campaign`), or a body that is not the envelope
  (`unexpected_body`). The reason quotes the proxy's error as one line, never
  the raw body. QA records a skipped `live-campaign-refs` assertion
  (`pages_eligible` under `--no-live-refs`) or a warn
  `built_output.live_refs_not_run` one.
- `doctor --no-live-refs` and `qa run --no-live-refs` skip only the live
  campaign read (`/api/campaign`); other declared sends are unchanged. Only
  `doctor` and `qa run` read; `start`, `prepare-build`, `build`,
  `theme waive`, `checkpoint`, `findings harvest`, `run-record`, `next` and
  the doctor refresh after `qa run` records the QA stage record `not_read`.
- An `api_key_source` env var whose name contains `ADMIN`, `TOKEN`, `SECRET`,
  `PASSWORD`, `PRIVATE` or `STORE` is refused for this read, with no request
  (`key_source_refused`).
- Page refs are read from the parsed HTML for the live check and the existing
  `built_output.shipping_ref` / `built_output.package_ref` check: any valid
  attribute syntax, entity-encoded values and `<template>` content are read;
  comments, `<noscript>` and visible text are not. Inline `packageId:` /
  `shippingId:` config is read from scripts and attribute values.
- `contracts/effects.v1.json` declares the `{proxy-base}/api/campaign` send on
  the `doctor`, `doctor --no-write`, `doctor --write` and five existing
  `qa run` rows; the first two leave `readOnlyHint` for tier A and still write
  nothing. `--no-live-refs` is an effect-changing flag, with rows without the
  read for `doctor` (read-only), `doctor --write` and `qa run` alone and with
  `--no-remit`, `--no-post-verdict`, `--test-order` or `--browser`.
  `docs/effects.md` says the same and describes the read.
- QA commercial parity warns `commercial_parity.recurring_claim_absent`,
  naming the package, when a page renders a subscription package (a recurring
  price and interval) with no readable recurring claim, and reports
  `incomplete` instead of passing.
- The bundled skills that cite doctor inspection cite it at tier `A`. The local
  setup install command pins 1.45.0. Bundled skills carry revision
  `1.45.0+skills.1`, each skill version advanced one patch.

## [1.44.0+agent.2] - 2026-09-30

### Changed

- `qa run --test-order common`, the default depth and what a bare
  `--test-order` runs, now runs every actual terminal path in the selected
  checkout topology when that count is at or under the flood cap
  (`--max-test-orders`, 6 by default). Above the cap it keeps the checkout,
  first-offer accept/decline and shortest-receipt sample, then adds the shortest
  path that clicks the decline on each offer or downsell page that no planned
  path declines yet, until the plan reaches the cap. Pages still left out are
  named on stderr and in the verdict. Before this change, `common` never
  reached a downsell's decline, so a broken decline link could pass QA (#530).
  A default run can now create up to 6 test orders, or up to an explicit
  `--max-test-orders`, where it created at most 4 before. Test cards create no
  transactions.
- Every browser test-order run whose funnels include offer pages now records a
  `browser-test-order:upsell-action-coverage` verdict row, read from the clicks
  the run's placed orders made, for the offer pages of every funnel in the run.
  A click counts only for the funnel whose order made it, and clicking only a
  page's accept does not count. The row is `pass` or `warn` only when coverage
  is certain: orders were placed, every funnel lists its pages, every offer
  page has its own absolute URL that no other page shares, every planned order
  matches exactly one funnel's checkout and page list, and every recorded
  click lands on a declared page of that order's funnel. Then it is `warn`
  naming each upsell or downsell page whose decline no order clicked, or
  `pass` when every decline was clicked. In every other case, including
  `--test-order off`, no placed order, a shared or missing URL, an unmatched
  plan or an undeclared click, it is `manual_review` naming the pages and the
  reason. A `warn` or `manual_review` row makes the verdict
  `ready_with_exceptions`, so a run that leaves a decline unproved, such as
  `--test-order accept` or `--test-order off`, no longer reads as `ready`.
- `--test-order full`, explicit paths, `tiers`, `tiers:common` and `tiers:full`
  plan the same orders as before.
- `qa help`, the per-platform agent instruction files under `agents/`, the
  next-campaigns-qa and next-campaigns-os skills (including the session intake
  reference) and the QA docs describe the new `common` depth and the coverage
  row, in place of the old at-most-four-orders sample. The skills bundle
  revision is now `1.44.0+skills.2`.

## [1.44.0+agent.1] - 2026-09-30

### Changed

- Doctor's `built_output.upsell_selector_scope` check lets a page's own
  `next-page-type` meta replace the route's upsell guess only when the meta
  is `checkout` and the guess comes only from `oto` or `one-time-offer` in
  the route (for example `/checkout-oto-1/` or `/oto-1/`), with no `upsell`
  or `downsell` word (#529). Any other meta (`product`, `receipt`, `landing`
  or anything else) leaves an oto page checked as an upsell, and a route with
  an explicit `upsell` or `downsell` word (for example `/upsell-1/`,
  `/checkout-downsell/`) keeps its role whatever its meta says. A meta copied
  from another page no longer lifts a post-purchase page out of the check.
  In 1.43.2+agent.4 any single live meta replaced the route guess.
- The 1.43.2+agent.4 notes said a `next-page-type` of `upsell` or `downsell`
  puts a page in scope beside a meta that says otherwise or when unquoted.
  The same holds when the meta name is upper-case, or the tag is commented
  out or inside `<template>`, `<script>` or `<noscript>`; those notes left
  these cases out. Such a page can block under
  `built_output.upsell_selector_scope` when it has a bundle selector without
  `data-next-upsell-context`; `doctor --built` has no waivers. Doctor finds
  these tags by scanning the page source, not only the live document, so a
  tag inside a comment, `<template>`, `<script>` or `<noscript>` counts too:
  delete the markup itself if the page is not post-purchase.

## [1.44.0] - 2026-09-30

### Changed

- The release ledger and this changelog are rotated at a reviewed baseline for
  the first time, so the mandatory orientation reads fit their declared limits
  again. No limit changed. Ledger entries `RL-0001` through `RL-0124` moved
  byte-for-byte into `contracts/archive/release-ledger.2026-09-30.json`. Every
  changelog section older than `1.37.0`, from `1.36.0+agent.1` down to `1.6.0`,
  moved verbatim and in order into `contracts/archive/CHANGELOG.2026-09-30.md`,
  including the sections no ledger entry links. This file now ends at `1.37.0`.
  Archived entries keep their `sequence`, `entry_sha256` and
  `changelog_sha256`, and each section hash verifies against the archive
  changelog.
- `contracts/release-ledger.json` declares the cut in a new top-level
  `baseline_floor` object: the archive files and their SHA-256, the last
  archived entry (`RL-0124`, sequence 124), the first kept entry (`RL-0125`),
  the entry that recorded the rotation (`RL-0190`), and the reason code to
  refuse with. Nothing is renumbered: the live ledger starts at sequence 125.
- The archive files are optional history reads. They are not part of
  `source_bytes`, `section_count` or `ledger_entries`; the mandatory reads and
  the measured files are unchanged.
- New reason code `baseline_below_floor`. A consumer whose reviewed baseline's
  newest ledger entry is older than the floor's last archived entry refuses,
  and the remedy is to adopt a newer reviewed baseline. Every commit at or after
  `RL-0125` qualifies.
- The ledger schema documents `baseline_floor` and the orientation schema lists
  the new reason code; both changes are additive. The authoring guide describes
  how to rotate next time, and the generated orientation reference gains a
  baseline rotation section. `AGENTS.md` notes the floor beside the reading
  order: the archive files are optional reads, and a baseline below the floor is
  refused with `baseline_below_floor`.
- The changelog structure check now checks this file and each archive
  changelog as well-formed changelogs on their own, and refuses a section that
  appears in more than one of them. Given a base, it also refuses a section
  present at base that is in none of them, so a section can no longer be
  deleted without a trace. It also requires this file and the archives, read
  newest first, to keep the base's section order with new sections only at the
  top of this file: every section here must be newer than every archived one,
  so a rotation archives one contiguous tail through the end of the file and an
  archived section cannot move back. The release-ledger gate's `--base` run
  applies the same rules.
- Package and supported-surface version advance to 1.44.0 for the two schema
  hashes and the two new named archive files. The local setup install command
  pins 1.44.0. Bundled skills carry revision `1.44.0+skills.1`, with each skill
  version advanced one patch; the lifecycle orientation skill also describes the
  floor.

## [1.43.3] - 2026-09-30

### Changed

- `contracts/effects.v1.json` now declares that `start`, `prepare-build` and
  `build` with `--map-id` (and no `--cached-spec`) write the fetched Map copy to
  `{target}/.campaign-runtime/fetched-specs/<map-id>.json`, replacing any
  earlier copy of that Map. All nine rows for those commands carry the write.
  The CLI has always written this file; only the declaration was missing.
- The effect test for those nine rows now runs them with `--map-id` under the
  `persisted_consent` condition, where a loopback receiver serves the spec. The
  Map Builder fetch to `{proxy-base}/api/spec/{map-id}` and the fetched copy are
  both observed there, so neither send nor write is declared without proof.
  `docs/effects.md` describes the fetch and no longer lists it as unreachable
  offline.
- Package and supported-surface version advance to 1.43.3 for the new effects
  contract hash, and ship every same-surface change recorded since 1.43.2
  (`1.43.2+agent.1` through `1.43.2+agent.4`). The local setup install command
  pins 1.43.3. Bundled skills carry revision `1.43.3+skills.1`, with each skill
  version advanced one patch.

## [1.43.2+agent.4] - 2026-09-30

### Fixed

- Doctor no longer flags `built_output.upsell_selector_scope` on a checkout
  page just because its route reads like an offer (for example
  `/checkout-oto-1/`). When a built page declares its role in its own
  `next-page-type` meta, doctor takes the role from that meta instead of
  guessing it from the route name, on `doctor --built` and the packet path
  alike (#529). Only a meta the browser actually reads counts: one that is
  commented out or sits inside `<template>`, `<script>` or `<noscript>`, a
  blank one, or two metas that disagree leave the route guess in place. Pages
  whose meta or declared type is `upsell` or `downsell` are still checked as
  before, and so are pages with no meta whose route reads as an upsell or
  downsell. A `next-page-type` of `upsell` or `downsell` anywhere in the page
  now puts it in scope even when another meta says otherwise or the value is
  unquoted.
- Doctor now blocks under `built_output.sdk_markup.orphaned_upsell_action`
  when an element carrying `data-next-upsell-action` has no ancestor carrying
  `data-next-upsell`. The SDK binds upsell actions only inside that container,
  so a "No thanks" link placed beside the offer container, not inside it,
  goes nowhere and the shopper cannot decline. The check runs on every page
  type, is not waivable, and passes on every certified starter family. The
  message names the page, the action value, and the fix: move the element
  inside its `data-next-upsell` container.

## [1.43.2+agent.3] - 2026-09-28

### Changed

- `campaigns-os login` asks the gateway for the `https://mcp.nextcommerce.com/mcp`
  resource and the `campaigns.read` capability, matching the gateway's move
  from `/campaigns` and `campaigns:read`. A login
  saved under the old resource is refused; sign in again. The gateway pilot is
  not live, so no working login is affected.

## [1.43.2+agent.2] - 2026-09-28

### Changed

- No command behaves differently. `docs/sdk-storage-compatibility.md` now takes
  the `sdk storage-check` manifest from a Campaign Cart release tag, v0.4.40 or
  later.

## [1.43.2+agent.1] - 2026-09-28

### Changed

- No command behaves differently. `docs/sdk-storage-compatibility.md` now says
  where the `sdk storage-check` manifest comes from: Campaign Cart's `main`
  branch, where the storage-migrations contract (campaign-cart #104, closing
  #102) merged on 2026-09-24. No released SDK tag carries the file yet, so the
  doc directs `--manifest` at an unmodified checkout of `main`. It previously
  described the contract as unpublished.

## [1.43.2] - 2026-09-28

### Changed

- Stabilization release. Package and supported-surface version advance to
  1.43.2 and ship every same-surface change recorded since 1.43.1
  (`1.43.1+agent.1` through `1.43.1+agent.23`). No command, message, or exit
  code changes in this release itself.
- `contracts/effects.v1.json` notes for the eight `--dry-run` invocations now
  say the command is declared `dryRun` in `src/invocation.mjs` instead of
  naming the removed `DRY_RUN_COMMANDS` set. The declared effects are
  unchanged.
- The local setup install command pins the 1.43.2 package. Bundled skills
  carry revision `1.43.2+skills.1`, with each skill version advanced one patch.

## [1.43.1+agent.23] - 2026-09-28

### Changed

- No command behaves differently. The comment in the doctor's `route_root`
  declaration check now uses a neutral placeholder for its near-miss route
  examples and states the canonical form (`"/"` or `"/<public_route_slug>/"`)
  outright. Comment-only; every message and every exit code is unchanged.

## [1.43.1+agent.22] - 2026-09-28

### Changed

- No command behaves differently. Follow-ups the 1.43.1+agent.21 review
  recorded: the filesystem path-identity helper the doctor's next-step picker
  and the Design Source Package publication share moved from `src/doctor/`
  to the shared helper module (one definition; the doctor module now imports
  it), stale comments in the publication module that still named
  `prepare-build` as the target-lock holder now name the publication entry
  that holds it, the Campaign Build Brief's private JSON clone (which maps a
  nullish brief to an empty object, unlike the shared clone) is renamed so it
  no longer shadows the shared helper, and the CLI drops three imports
  nothing used. Every message and every exit code is unchanged.

## [1.43.1+agent.21] - 2026-09-27

### Changed

- No command behaves differently. Design Source Package publication for
  `prepare-build`, `start` and `build` now has one owner instead of being
  restated inside `prepare-build`: the pending provenance record, the target
  lock's critical section, the output collision checks, the stage-evidence
  re-checks and the staged publication order. The on-disk names, the
  publication order, every message and every exit code are unchanged.

## [1.43.1+agent.20] - 2026-09-27

### Changed

- No command behaves differently. The doctor checks, the Build Packet and
  built-output inspection, and the next-step picker that `doctor` and `next`
  share now live under `src/doctor/` instead of inside the CLI module. Every
  check, its order, its messages and its exit codes are unchanged.
- `contracts/agent-relevant-change-policy.v1.json` classifies a change under
  `src/doctor/` as a CLI-surface change, so a later change there owes a
  release-ledger entry. The shared helper modules `src/install-invocation.mjs`,
  `src/cli-helpers.mjs` and `src/campaigns-api-key.mjs` are classified as
  implementation, so a change confined to them owes a CHANGELOG section but no
  release-ledger entry, even where a doctor message reads through them.
- The general helpers the CLI and the doctor share (the install-aware command
  spelling, small value and JSON-file helpers, and Campaigns API key
  resolution) moved to their own modules under `src/`. They are internal
  implementation, not package exports.
- The repository's tests and performance worker import the moved functions from
  their new modules.

## [1.43.1+agent.19] - 2026-09-27

### Changed

- No command behaves differently. The CLI's invocation policy now has one
  owner instead of being restated at each step: which commands run outside
  session recovery and lifecycle capture, where the stale run-session
  closeout runs before `start`, `prepare-build`, `build`, `run start` and
  `run end` and what suppresses it (`--no-write`, `--no-run-session`, and
  `--dry-run` on a command that implements it), which invocations append no
  lifecycle entry, which commands implement `--dry-run`, and when `qa run`
  ends its run session. Every declared effect, every argument refusal and its
  order, and the valued `--dry-run` and bare `run` behaviours are unchanged.
- The command list behind the did-you-mean suggestion for an unknown command
  now comes from that same declaration instead of being read out of the
  dispatch code's text. The list, its order and the suggestions are
  unchanged.

## [1.43.1+agent.18] - 2026-09-27

### Fixed

- `prepare-build` no longer loses track of a Design Source Package it
  synthesized when the run fails or is killed after publishing the package
  but before writing the Assembly Report that records it. Before the package
  goes out, the run writes a pending provenance record beside it
  (`.campaign-runtime/input/.design-source-package.json.pending-provenance.json`)
  with the sha256 of the bytes it is publishing, and removes it once the
  report is written. A retry that finds the record treats a package that
  still hashes to it as `origin: "synthesized"`, so a later `--force` after a
  manifest edit regenerates the package instead of refusing it as someone
  else's. A `--force` regeneration keeps the replaced package's hash in the
  record until the replacement is recorded, so a regeneration that fails or
  dies part way leaves the package on disk provable, and a run that adopts
  another writer's package instead of publishing drops its own candidate from
  the record. Just before the report is published the record is narrowed to
  the package the report records. Bytes changed since the failure, and a
  malformed record, are not vouched for. The record's path is reserved: no
  configurable output may point at it.
- The `manifest_sha256` the Design Source Package records is now the hash of
  the exact source-html manifest bytes source intake parsed. The file was
  read twice, once to parse and once to hash, so an edit between the two
  recorded a hash that did not describe the parsed manifest.
- With `--map-id`, `start`, `prepare-build` and `build` still fetch the Map
  first, but write the fetched spec to the shared
  `.campaign-runtime/fetched-specs/<map-id>.json` cache file only once they
  hold the per-target prepare-build lock. A run waiting for the lock could
  previously overwrite the cache with a newer revision while the lock holder
  was still recording it, so the holder recorded mappings from one revision
  beside hashes of the other. Argv-only intake refusals still happen before
  any spec read, fetch or cache write, and a failed fetch still writes
  nothing.
## [1.43.1+agent.17] - 2026-09-27

### Fixed

- The per-target lock that `prepare-build` holds, and the progress allocation
  lock, can no longer be held by two processes at once. A process suspended
  after creating the lock directory but before recording its owner used to
  lose the lock to a waiter after ten seconds, and then both ran. The lock
  directory and its owner record are now published together by one rename,
  each holder confirms its own token before entering, and release only ever
  removes a lock that still carries the holder's token. A lock directory with
  no owner record, which only an older release leaves, is never taken over:
  the command refuses it after about a second with a message naming the lock
  directory (for progress capture, the warning now names the affected
  `.allocation-lock`); remove it by hand once no campaigns-os process is
  working on the target. A waiter that loses the publishing rename to a
  holder that has already released now retries instead of failing. Do not run
  an older release against the same target at the same time.
- Commands that edit the Assembly Report (`doctor`, `qa run`, waivers, the
  polish merge and the other stage producers) now take the same per-target
  lock as `prepare-build` for their read-modify-write, so stage evidence can
  no longer land between `prepare-build`'s final stage-evidence check and its
  publication. A producer reached from inside `prepare-build`'s own run enters
  without waiting on itself. A waiver `--dry-run` preview writes nothing and
  takes no lock.
- `prepare-build` refuses a `--out`, `--context-out`, `--report-out`,
  `--doctor-out` or `--brief-out` path inside the lock directory
  (`.campaign-runtime/input/.design-source-package.json.lock`) or the
  staging and tomb directories the lock creates beside it (`.lock.staging-*`,
  `.lock.recovery-staging-*`, `.lock.released-*`, `.lock.abandoned-*`),
  including through a symlinked directory or a case-only alias. Such an output was written and then deleted with the lock, leaving
  the packet and context pointing at a missing file.
## [1.43.1+agent.16] - 2026-09-27

### Fixed

- QA's optional analytics comparison against a legacy funnel
  (`--analytics-baseline`) now measures a partial build's first built page
  when the campaign root is not part of the build or does not answer, the same
  way the analytics correctness check has since #493. It used to measure the
  campaign root only, which a partial build does not have. The comparison
  records which page it measured. When no built page answers, it is skipped
  if there was nothing to try, and blocks if every page it tried failed; in
  both cases the legacy funnel is not loaded. An explicit
  `--analytics-candidate` URL is still measured as given.
- A funnel entry whose URL differs from the campaign root only by its query
  string (for example `/campaign/?step=checkout`) is no longer treated as the
  root. On a partial build, the root counted as built and the entry was
  dropped as a duplicate, so the root's generic page was measured instead of
  that entry. The entry is now measured itself and marked `query_routed`.
  Step routing stays path-based in every certified family.
- `docs/qa-and-test-orders.md` now describes which page the analytics checks
  measure on a partial build, the `no_in_scope_page_captured` and
  `no_capture_page_answered` outcomes, how query strings affect page identity,
  and when a local-serve run turns a silent pixel into `manual_review`: a
  recorded development render and a page measured on localhost, with
  `data-layer-purchase` still blocking.
## [1.43.1+agent.15] - 2026-09-27

### Fixed

- The doctor `built_output.script_syntax` gate and the QA `script-parse`
  check now resolve each `<script src>` against the base in effect when the
  parser prepares that script at its end tag: the first HTML `<base href>` in
  tree order among those already parsed, or else the page. A `<base>` parsed
  after a script no longer moves it, whether it is async, deferred or a
  module, and parse order decides even when table foster parenting reorders
  the tree. An SVG `base` no longer counts, and the href is no longer trimmed
  of non-ASCII whitespace the URL parser keeps. Only HTML-namespace
  `<script>` elements are page scripts: an SVG `<script src>` is no longer
  read or parsed by doctor, and QA leaves a page with an SVG script dynamic
  instead of fetching it. Only an empty `src` is skipped, as the browser
  skips it; a `src` of other whitespace is resolved and read. QA recognises
  the Campaign Cart SDK by its URL as the parser reads it, so a tab or
  newline inside the attribute no longer makes the SDK look like an
  unavailable config script. A base
  the browser refuses (a `data:` or `javascript:` URL, or one that does not
  parse) now falls back to the page, as the HTML "set the frozen base URL"
  steps require, so the local script is read and a parse failure in it blocks
  instead of the script being listed as unresolved (#502).

### Changed

- A local script a built page loads that is not in the built output is now a
  doctor warning, `built_output.script_syntax.missing_script`, one per src
  naming the pages that load it. It was information on the gate only. It does
  not block. While a parse failure blocks the gate, the missing scripts stay
  on the gate's `warned[]` (#502).
- `fixtures/certified-families/` now carries every local script the rendered
  pages load (each family's `js/*.js` beside `config.js`), refreshed from the
  same templates commit. `scripts/refresh-certified-family-fixtures.mjs`
  copies them, resolved the way the gate resolves them, and fails when a
  referenced script is not in the render, or a copied file is a symlink or
  resolves outside the family's render. The reachability test reads the
  expected scripts from the HTML independently of the gate and requires the
  gate to read exactly that set on every certified family (#502).
## [1.43.1+agent.14] - 2026-09-27

### Fixed

- An accepted upsell whose mutation body loads late is now matched to the
  request its own click made, not to any response on the order-upsells URL.
  Every upsell step in a path posts to the same `/orders/<ref>/upsells/` URL,
  whether the steps share a page or sit on separate pages, so an earlier
  step's slow body could land while a later step waited for its own and be
  judged as the later step's evidence: failing it when that body lacked its
  line, or passing it on the earlier step's line. The runner keeps the
  Playwright request of each captured response and of each step's mutation
  and accepts a late body only when the two are the same request. A step
  whose own body never arrived and that no later read-back settled is
  unverified even when the stale lines on hand would have matched. The
  step's mutation watch also ignores any order-upsells response whose
  request started before the watch was armed at the click, so an earlier
  step's response that arrives late, after its own watch expired, is no
  longer taken as this step's.
- A test-order path whose only open question is an unverified accepted upsell
  is no longer `ok` on its result. The result carries `upsell_unverified`
  instead, the order's `verification.verified` is `false` (so the purchase
  proof summary no longer counts it in `orders_verified`; it still counts in
  `orders_created`), and the path is neither re-run (a second order) nor
  passed through read-only recovery (which cannot re-check an upsell). The
  `browser-test-order` assertion still reports it as `manual_review`. A path
  with an unverified upsell and another failure is recovered as before, but
  a recovery that clears the other failure leaves the upsell unverified: the
  result goes to `manual_review`, not `pass`, and the order stays unverified.
## [1.43.1+agent.13] - 2026-09-27

### Changed

- The lifecycle effects tests now prove that `start`, `prepare-build` and
  `build` refuse a bare, empty or whitespace `--template-family`,
  `--allow-uncertified-template`, `--theme-policy` or `--brief`, and an
  unsupported `--theme-policy`, before the CampaignSpec is looked at. The
  earlier refusal tests seeded a valid spec, so a check that ran after the
  spec was read would still have passed them. The new cases make the local
  `--spec` file and the `--cached-spec` cache file missing, a directory, or
  malformed JSON, and require the flag refusal with no journal entry, no fetch
  and an unchanged tree. The tree snapshot these tests compare now lists
  directories as well as files, so a refusal that only creates an empty
  directory is caught too. Tests only; CLI behavior is unchanged (#504).

## [1.43.1+agent.12] - 2026-09-26

### Fixed

- QA no longer blocks every local proof run on analytics. Under
  `deploy.target: local-serve` the build renders the development environment,
  which leaves out the vendor loaders on purpose, so a declared pixel could
  never fire on localhost. When the run is served from localhost and the build
  recorded `stages.assembly.evidence.build_environment: development`, the tag,
  out-of-band vendor and receipt Purchase (`purchase-fires`) checks that did
  not fire on a page measured on localhost are now `manual_review` with the
  reason `local_serve_development_render` instead of blockers. Each one says
  to re-run QA against the PR preview with `--base-url <preview-url>`, which
  is a production render and still gates them, and cites the recorded
  `page-kit parity` result when there is one. A production build, or a build
  with no recorded environment, keeps its blockers on localhost. The exception
  covers only pages measured on localhost: the tracking capture now records
  the page URL it settled on after redirects (`final_url`), and a capture that
  landed on another host, such as a built entry page whose URL is a production
  preview or a localhost root that redirects to production, keeps its
  blockers. So does a receipt Purchase check whose receipt page is not on
  localhost, judged both by the order's final URL and by the page URL read
  after the receipt's analytics settled (`receipt_document_url`), so a
  localhost receipt that redirects to a hosted page while analytics settle
  keeps its blocker, as does any check whose measured page was not recorded.
  So does a capture that failed: a `purchase-fires` failure that lists
  unmeasured receipts in `capture_error_plan_ids` still blocks, and a tracking
  capture whose page could not be read (for example, a page that reloaded
  while the capture read it) now fails as the analytics runner blocker instead
  of reading as a page where nothing fired. The data-layer Purchase
  check (`data-layer-purchase`) still blocks too: the SDK pushes `dl_purchase`
  in the development render as well.

## [1.43.1+agent.11] - 2026-09-26

### Fixed

- `start`, `prepare-build` and `build` now refuse a bare, empty or
  whitespace-only `--template-family`, `--allow-uncertified-template`,
  `--theme-policy` or `--brief`, and a `--theme-policy` other than
  `inspect_only`, `auto` or `off`, before reading the spec, fetching the Map or
  writing the spec cache. Before, these four were read only after the spec was
  resolved: a blank value was quietly ignored (or, for `--theme-policy`, fell
  back to `inspect_only`), and an unknown theme policy failed partway through
  intake and was journaled as a handler failure. A refused invocation writes
  no journal entry. Whether a named family is certified, and whether a named
  brief can be read, still depend on file content, so those failures are still
  journaled.
## [1.43.1+agent.10] - 2026-09-26

### Fixed

- Browser QA no longer hangs on an upsell accept when the page moves on before
  the upsell response body has loaded. The runner read that body with no time
  limit, and a page that redirected as soon as the response headers arrived
  could leave the read waiting forever. The read now gives up after a few
  seconds: the step still reports the response and its status, with no order
  body, and records that the read timed out. Checkout event capture keeps its
  unbounded read, since nothing waits on it: an order body that loads late
  still counts as order evidence.
- A slow but successful upsell accept is no longer failed as "no new upsell
  line". When the upsell body read times out on a successful response, the
  step waits up to 15 seconds, inside its own time budget, for the late body
  or an order read-back that shows the accepted line. If neither arrives, the
  upsell is reported as unverified and the test order goes to manual review,
  not to a blocker. A late body, or an order read-back captured after the
  click, that lacks the line still fails.
## [1.43.1+agent.9] - 2026-09-26

### Fixed

- Doctor no longer reports a build ready when a campaign script has a syntax
  error. Every doctor run that sees built output, `doctor --built` and the
  packet path alike, now parses each campaign-owned `.js` file a built page
  loads by a local `<script src>`, and blocks under
  `built_output.script_syntax.parse_failure` when one does not parse. The error
  names the file, line and column, for example a hand-edited checkout script
  left with one closing `});` too many. Remote scripts such as CDN URLs are not
  read, `type="module"` scripts are parsed as modules, and classic `nomodule`
  scripts are skipped. Script types are read as the browser reads them, trimmed
  of surrounding whitespace and case-insensitive, and a module script is parsed
  even when it carries `nomodule`, since the browser still runs it. Script paths resolve against the page's `<base href>` and are
  percent-decoded, as the browser loads them. The gate is not waivable and
  passes on every certified starter family.
- QA no longer reads a page script that does not parse as "dynamic". The
  credential binding treats its declarations as unavailable, and QA adds a
  `script-parse:<page_id>` blocker naming the script, line and column. Both
  report a fixed diagnostic category, never text from the script. QA
  classifies script types the same way doctor does.
## [1.43.1+agent.8] - 2026-09-26

### Fixed

- `prepare-build --force` (and `start --force` and `build --force`) now
  regenerates a stale Design Source Package that an earlier `prepare-build`
  synthesized, instead of refusing it. Previously, editing the source manifest
  after a first run left `.campaign-runtime/input/design-source-package.json`
  stale, and every rerun failed until the file was deleted by hand, with nothing
  in the output saying so. The Assembly Report now records the package's
  `origin` (`synthesized` or `adopted`), and a package counts as the producer's
  own only when that report says `synthesized` and the bytes on disk still match
  its hash. A package placed by an operator, edited by hand, or recorded by an
  older report is still refused, `--force` or not. Every refusal now names the
  file and the recovery: rerun with `--force` for the producer's own package,
  otherwise reconcile it or delete it and rerun.
- The manifest docs now say up front that a source-html manifest `pages[]`
  entry with both `path` and `skip_reason` is invalid.
## [1.43.1+agent.7] - 2026-09-26

### Fixed

- QA's analytics tracking check works on partial builds. It used to capture the
  campaign root (`/<slug>/`) even when the build starts deeper, such as at
  `checkout/`, so it read an empty page and failed every declared pixel as
  absent. On a partial build the root now counts as in scope only when a
  built, in-scope page is served there, so a host's directory index or
  generic fallback at the root is never measured. When the root is out of
  scope, answers with a non-2xx status, or fails to load (a navigation timeout
  or network error), the check captures the first built in-scope page, the same entry partial-scope QA starts from, and records the
  page it used and why on the `analytics-correctness:capture` evidence. If the
  build has no capturable page at all, the check is skipped with the reason
  `no_in_scope_page_captured`. If pages existed but none answered 2xx or
  loaded at all, the check fails as a blocker with the reason `no_capture_page_answered` and
  lists each attempt, because the declared vendors went unmeasured.

## [1.43.1+agent.6] - 2026-09-26

### Fixed

- Browser QA no longer misses the upsell accept on a control that pulses
  forever, such as a stock `pb-animate="pulse-upsell"` button. The runner used
  to wait about 30 seconds for the control to settle before scrolling to it and
  another 10 before forcing the click, so the upsell POST landed after its
  20-second watch had expired. That reported `api_response_seen: false` for an
  accept that had worked, and could time out deep accept paths. Controls are now
  scrolled into view without a settle wait, a control that animates forever is
  clicked straight away, and the watch starts at the click. Cart-entry,
  package-card, checkout-submit and text-matched clicks use the same bounded
  scroll.

## [1.43.1+agent.5] - 2026-09-26

### Fixed

- Payment-logo residue checks ignore starter `payment-logos.html` logos that
  are still `hidden`. The template hides each method's logo until the campaign
  offers it, so doctor and browser QA no longer flag PayPal or Klarna on pages
  built from the new templates. A logo left visible is still checked; when a
  page forces one on, doctor's warning points at the `payment_flags.show_<method>`
  frontmatter flag.

## [1.43.1+agent.4] - 2026-09-26

### Fixed

- Partial-build QA skips recorded, unbuilt out-of-scope pages with explicit
  `out_of_build_scope` evidence and starts at the first in-scope page. Built
  stock pages rejoin QA; missing in-scope pages still fail. Commercial checks
  share the same scope as HTTP and browser checks.
- Build handoffs keep skipped routes unbuilt by default. Materializing a stock
  stand-in requires explicit per-page operator opt-in, so upstream pages on
  another host are not replaced with placeholder copy.
## [1.43.1+agent.3] - 2026-09-26

### Fixed

- Legacy direct-API QA rejects missing or unusable carts and unknown test-order
  modes before resolving campaign inputs, without appending a lifecycle entry.
  Browser QA precedence and legacy API credential checks are unchanged.

## [1.43.1+agent.2] - 2026-09-26

### Fixed

- `run end --dry-run yes` now refuses the valued flag without closing a stale
  session first. No Run Record, lifecycle entry, remit, or session deletion
  occurs. Bare `--dry-run` and ordinary run closeout keep their existing behavior.

## [1.43.1+agent.1] - 2026-09-25

### Fixed

- Doctor recognizes numeric package, shipping and offer references exported by
  the Map, so declared commerce IDs no longer trigger false undeclared-package
  blockers or starter-demo warnings. Reference fallback fields now use the same
  string-or-finite-number rule; other types are ignored instead of stringified.

## [1.43.1] - 2026-09-24

### Fixed

- Restamp the local setup install command to the 1.43.1 package and check its
  documented toolkit pin against `package.json` during CI.
- In 1.42.1, `run end` journaled several inherited flag refusals that 1.41.x
  refused without a journal entry, including unknown `--surfaces` and valued
  `--dry-run`. `run end` and `run-record` now refuse bare, empty, or
  whitespace-only values for every value-taking inherited run-record flag
  before packet work. The agent token and elapsed-time flags keep their integer
  diagnostics; unknown `--surfaces` and valued `--dry-run` are refused. `run end`
  also refuses `--new-run` and `--run-id`, since the saved session fixes its run
  ID. `run-record` also refuses bare, empty, or whitespace-only `--run-id` and
  valued `--new-run`. These argv-only refusals append no lifecycle entry.
- `start`, `prepare-build`, and `build` refuse bare, empty, or whitespace-only
  values of `--spec`, `--map-id`, `--source`, `--target`, `--source-kind`,
  `--proxy-base`, `--wrapper-policy`, `--design-manifest`, and
  `--order-path-depth` before local spec reads, Map fetches, or cache writes on
  the `--spec`, `--map-id`, and `--map-id --cached-spec` paths.
- Internal stale-session and QA closeouts retain their prior handling of
  inherited flags. A bare, empty, or whitespace-only `--proxy-base` on a
  sweeping command still writes the stale session's Run Record. Terminal QA
  still auto-ends with a whitespace-only inherited `--context`, `--report`, or
  `--proxy-base`; a whitespace-only `--context` resolves as a literal relative
  path, so the default context file is not read. Bare or empty `--context` or
  `--report` still makes QA auto-end fail and leaves the session open. A bare
  or empty `--qa-verdict` still fails a Run Record closeout when inherited;
  QA auto-end supplies its own verdict path.
- Correct the 1.42.1 note: QA with a named packet yielding no Map ID after
  checkpoint preflight changed from a refusal to a journaled handler failure
  in that release; it did not *remain* journaled. A named packet now satisfies
  QA identity with a Map ID or a valid local-spec identity. If preflight yields
  neither or finds conflicting local and Map identities, QA journals a handler
  failure.

### Changed

- Package and supported-surface version advance to 1.43.1. Bundled skills
  carry revision `1.43.1+skills.1`, with each skill version advanced one patch.

## [1.43.0+agent.4] - 2026-09-24

### Fixed

- Run Record validation and its schema treat a null `local_spec_id` as absent,
  preserving saved-Map records and best-effort capture with partial identity.
  Non-null malformed or conflicting local IDs still fail before persistence.

## [1.43.0+agent.3] - 2026-09-24

### Fixed

- Invalid campaign identities cannot select prior doctor history, including
  when a malformed local ID would otherwise leave a Map-only or unfiltered
  lookup. Such findings retain unknown cause instead of borrowing evidence.
- Integrate the 1.42.1 argument-refusal fixes: local-spec packet QA remains
  supported, while identity failures discovered from packet content remain
  journaled handler failures. Advance bundled skill versions beyond 1.42.1.

## [1.43.0+agent.2] - 2026-09-24

### Fixed

- Evidence identity projection and Run Record writes reject malformed or
  conflicting local IDs instead of propagating them. Doctor keeps malformed
  input diagnosable with `spec.local_identity`; saved-Map errors retain their
  existing code and normalization. Local IDs remain exact canonical tokens.
- Declare the optional local progress identity inline without mutating the
  portable schema after construction.

## [1.43.0+agent.1] - 2026-09-24

### Fixed

- Entry-point and QA instructions distinguish saved-Map builds from local-spec
  builds, including local verdict storage, evidence identity and publication
  suppression. Bundled QA and evidence skills follow the same distinction.
- Page Kit sync and spec derivation retain the saved-Map mismatch diagnostic
  while refusing mismatched local identities before writes.

## [1.43.0] - 2026-09-24

### Added

- Agent-authored CampaignSpecs can use a stable `spec_identity.local_spec_id`
  instead of a saved Map. Preparation preserves that identity in packets and
  reports; doctor, polish, QA, progress, readback and run closeout distinguish it
  from both the public route and saved Map identity. Material hashes continue
  to bind each spec revision, including across fresh checkouts.
- Packet-based local QA writes full verdicts and committed sidecars with the
  local ID, refuses foreign or stale local reports, and never publishes them to
  the Map portal. `qa publish` refuses local-spec packets. Existing saved-Map
  workflows retain their identity and publication behavior.
- Local setup and intake instructions let the coding agent author the spec
  from prepared HTML, a brief and verified configured commerce. Existing
  certification, source, runtime, polish and checkout proof gates still apply.

## [1.42.1] - 2026-09-24

### Fixed

- `start`, `prepare-build`, and `build` now refuse missing or invalid argument
  values for source, target, source kind, wrapper policy, design-manifest value,
  and order-path depth before spec resolution or preparation. `run-record`
  refuses conflicting `--new-run`/`--run-id` and invalid agent token counts
  before reading its packet or journal. These argv-only refusals append no
  lifecycle entry.
- `qa run` and `qa resolve` refuse empty campaign selectors and selector flags
  without values before checkpoint or site reads. Built-site QA also refuses
  missing `--base-url` or `--family` before scanning the site. An unknown
  `next` stage refuses before the handler reads the packet or runs doctor,
  names the accepted stages (`setup`, `build`, `polish`, `deploy`, `qa`), and
  appends no lifecycle entry. The `next` help line now shows those stages.
- Three state-dependent decisions remain journaled handler failures: `polish
  capture` when `packet.assembly.target_repo` does not resolve to a local target
  repo; `run end` with no packet in argv or the saved session; and `qa run` or
  `qa resolve` with a named packet that yields no Map ID after checkpoint
  preflight. The polish check currently cannot fire through the CLI because
  the workspace resolver supplies a local path. Separately, a named design
  manifest that is missing, not a file, or invalid is a journaled handler
  failure. A nested run-record refusal during `run end` or QA auto-closeout
  stays within the closeout attempt, so it does not turn the invoking command's
  journal verdict into a refusal. The ambient run-session lookup may still
  read a named `--packet` before the handler runs.

### Changed

- Package and supported-surface version advance to 1.42.1. The bundled skills
  carry revision `1.42.1+skills.1`, with each skill version advanced one patch
  so an agent can detect instructions loaded from an older release.

## [1.42.0+agent.2] - 2026-09-24

### Fixed

- The effects guide names both `qa install-browser` and `tooling setup` as
  browser downloaders, matching the declared effects contract.

## [1.42.0+agent.1] - 2026-09-24

### Fixed

- Setup recovery preserves an existing project's dependency choices instead
  of recommending a fixed page-kit version. New projects use the install
  instructions bundled with the release.
- Setup explicitly confines managed destinations to the selected project;
  regression coverage proves files and dangling symlinks cannot stand in for
  context directories.
- Receipt-analytics deadline tests advance a controlled clock after entering
  the phase under test, avoiding a CI scheduling race between settle and capture.

## [1.42.0] - 2026-09-23

### Added

- `tooling setup --target <campaign-directory> --platform claude` composes the
  existing skill, project context and QA-browser installers after checking the
  selected project's exact toolkit pin and installed page-kit dependency.
  npm installs the dependencies first; setup runs from the project copy through
  `npx --no-install campaigns-os`. It preserves campaign pages and existing
  project instructions, appends the Claude context import once, and refuses
  conflicting pins, edited context and symlink destinations before writes.
  `--dry-run` writes nothing and downloads no browser. Browser-install failure
  reports an incomplete setup that can be rerun. Setup bypasses campaign-session
  recovery, gateway credential reads, lifecycle capture and telemetry.
- Bundled local-setup guide documents the initial npm install, context import,
  browser step and required agent restart. Setup reports `restart_required`;
  installation is not proof that an agent loaded the matching skill revision.

### Changed

- Skills bundle revision `1.42.0+skills.1`; each bundled skill version advances
  one patch so a session holding previous instructions must restart.
- Declared effects include setup and its read-only dry run. Offline effects
  tests cover every campaign-session/consent condition; browser archive download
  remains preflight-proved, alongside focused preservation and recovery tests.

## [1.41.2] - 2026-09-23

### Fixed

- Every command Campaigns OS prints for a project-local install is spelled
  `npx --no-install campaigns-os …`, and so is every command in the bundled
  skills, the README, `AGENTS.md` and the docs. 1.41.1 made this change only
  for the revision check in the skill header. `campaigns-os` is only the bin
  name of `@nextcommerce/campaigns-os`. In a folder where the package is not
  installed (another folder, or one where `npm install` has not run yet), a
  plain `npx campaigns-os …` looks the bin name up as a registry package and,
  with no terminal to ask, installs whatever it finds and runs it. With
  `--no-install`, npx runs the pinned copy or stops with an error.
  - For a `node_modules` install, `tooling status` reports
    `cli.invocation_prefix` as `npx --no-install campaigns-os` and
    `cli.invocation` as `npx --no-install campaigns-os <command>`.
  - Every command spelled with that prefix follows: `next` text and `--json`,
    doctor required actions, gate and checkpoint remediations, the
    skill-refresh and gateway login actions of `tooling status`, and the
    browser-missing hints.
  - The PATH warnings of `tooling status` and its action for a stale project
    pin name the same spelling.
  - A checkout, a global install and an npx cache keep their spellings.
  - Run-session deviation tracking reads the command word through the new
    prefix, and still through the old one in sessions recorded by earlier
    versions.

  Commands printed or documented by earlier releases lack the flag; add
  `--no-install` after `npx` when you reuse one.
- Skills bundle revision `1.41.2+skills.1`. Every skill's version advances by
  one patch.

## [1.41.1] - 2026-09-23

### Fixed

- `tooling status` without `--platform` or `--target` checks skill freshness
  only on the platform directories where Campaigns OS skills are installed. A
  directory counts when a skill sits under one of the bundled names or under a
  retired name when it is our own copy. Before this, a Claude Code only install (the
  documented path) was read as stale for Codex and the shared directory, so
  the revision check the skills ask for exited 2 and printed an action to
  install skills for every platform. Now:
  - A `Ready:` line names the skipped platforms.
  - The refresh action names each stale installed platform (`install-skills
    --platform claude`), or `--platform all` when all three are installed and
    stale.
  - When no platform has Campaigns OS skills, the action asks for an install
    on the harness in use (`install-skills --platform claude`, with `codex` and
    `agents` named as the alternatives)
    rather than on all three.
  - `--platform all` still checks every platform.
  - `--json` adds `skills.scope` (`requested`, `installed_platforms` or
    `no_platform_installed`) and `skills.not_installed_platforms`.
  - `tooling diagnose` forwards `--platform` only when one is given, and its
    export reports the unnamed scope as `platform: installed`.
  - The gateway login hint uses the printed invocation prefix.
- Every bundled skill header now tells the agent to run the check as `npx
  --no-install campaigns-os tooling status --skills-revision <revision>` from
  the campaign's Page Kit folder. There it runs the project's pinned copy, and
  it never installs one. The header change fixes two problems:
  - A bare `campaigns-os` resolves through PATH. On a machine with an older
    global install, a copy from before 1.40.0 answers instead. That copy
    ignores `--skills-revision`, prints no `Skills revision:` line, and lists
    an `install-skills --platform all` action. Following it replaces five of
    the nine bundled skills with older text. The revision comparison cannot
    see that result; only the pinned copy's freshness check reports it.
  - `campaigns-os` is only the bin name of `@nextcommerce/campaigns-os`.
    Outside a pinned folder, a plain `npx campaigns-os` looks the bin name up
    as a registry package, and with no terminal to ask, it would install
    whatever it found.

  The header also says that output with no `Skills revision:` line (no
  `revision_check` under `--json`) did not come from the pinned copy, and that
  none of its actions should be followed. `docs/skills-revision.md`, the
  README, the quickstart and `docs/diagnostics.md` describe the new
  behaviour.
- Refusals that happen before a command's first effect are tagged, so they
  write no lifecycle journal entry (campaigns-os#465). This covers:
  - `theme waive` without `--reason`, or with a waiver attribution it rejects
    (a missing or placeholder `--waived-by`, or a bad `--expires-at`).
  - `qa waive` without `--assertion`, with an assertion outside the waiver
    lane, or without `--reason`.
  - `qa policy set` with a removed flag, a string flag given no value, a
    non-boolean `--allowed-domains-confirmed`, or an unsupported
    `--order-path-depth`.

  Every other plain throw in `src/cli.mjs` and `src/qa-node.mjs` was reviewed
  against the rule in `docs/effects.md` and left as a journaled handler
  failure. Those throws follow a read of the target (spec, source, report,
  session state or built site), an effect, or a request, or they are internal
  defect checks. Each newly tagged site has a refusal-table row in
  `src/lifecycle-effects.test.mjs`. Each touched handler has a positive
  control: the same invocation, when it passes every refusal and then fails,
  still appends exactly one entry. No effects row changes.
- Skills bundle revision `1.41.1+skills.1`. Every skill's version advances by
  one patch.

## [1.41.0] - 2026-09-23

### Added

- `tooling status` reports the pin checks (ADR 0002, campaigns-os#466): one
  executable per project. The project pin — the first exact
  `@nextcommerce/campaigns-os` spec (`x.y.z`, `=x.y.z` or `vx.y.z`) in
  `devDependencies`, then `dependencies`, of each `package.json` walking up from
  the working directory, through manifests that name nothing, to the workspace
  root — comes first; a range counts only
  when no exact spec exists on that walk, and `peerDependencies` /
  `optionalDependencies` are never a pin. The Build Packet's recorded kernel
  version comes second (the project's `campaign-runtime.build.json`, or
  `--packet <path>`). `--json` carries `pin: { source, version, running,
  status, range, packet_version, packet_version_ignored, project_version,
  project_manifest, project_key, forced, message }` and the text view a `Pin:` line under the
  skills revision line. The line names, for every status, the key and manifest
  of each project version or range it quotes (`devDependencies in
  <project>/package.json`), the nearest manifest when there is no project pin,
  and the packet file of each packet version it quotes; every action names the
  manifest and key to change; a packet value with an `=` or `v` prefix is
  named as ignored (`packet_version_ignored`), not as absent. An installed
  package's own manifest (`node_modules/<name>` or `node_modules/@<scope>/<name>`)
  is never the project, so a run from inside an install resolves the enclosing
  project, while a project whose own path passes through a `node_modules`
  directory still resolves its own manifest; a leading BOM is accepted, and an
  unreadable or malformed ancestor manifest ends the walk with a warning.
  `pin.status` is `match`; `stale_pin` (the pin is not the
  running version); `conflicting_pin` (both sources present and different); or
  `unpinned` (neither present — a range or tag is not a pin and is reported
  under `range`). `stale_pin` and `conflicting_pin` exit 2 with an action
  naming the file to change; `unpinned` exits 0 and is always reported.
- `tooling status --force`: a bare flag that overrides `stale_pin` and
  `conflicting_pin`, so the command exits as the rest of the status dictates.
  The override is reported as `pin.forced: true` and recorded on the
  command-lifecycle journal entry through `argv_shape`. `--force true` is
  refused. Declared as its own row in `contracts/effects.v1.json`
  (`effects: tooling status --force`, 92 rows): it changes the exit status only
  and writes nothing the plain row does not.
- Build Packet: optional top-level `campaigns_os_version` (a bare `x.y.z` version) in
  `schemas/campaign-runtime-build-packet.v0.schema.json`, stamped by
  `prepare-build` with the version that prepared the packet. Additive: the
  packet schema stays `campaign-runtime-build-packet/v0`, and packets without
  the field stay valid (they are no packet pin source).

### Changed

- `docs/skills-revision.md`: the "Not yet built" section is replaced by the pin
  check as built — sources and precedence, the four statuses, exit codes,
  `--force`, and JSON and text output from real runs. The `tooling status` help
  line gains `[--packet <campaign-runtime.build.json>] [--force]`.
- `tooling status` refuses `--no-force` up front (`--force` is bare and off by
  default), journaling nothing, where the shared parser had let it pass as a
  no-op; and an empty or whitespace-only project spec is absent, never a
  `range`.
- Skills: `bundle_revision` moves to `1.41.0+skills.1` with the package
  version, and every bundled skill's `Bundle revision:` header and its
  `--skills-revision` instruction follow (each skill version patch-bumped).
- `contracts/supported-surface.json`: `surface_version` 1.41.0, with the
  sha256 of the hashed `contracts/effects.v1.json` and
  `schemas/campaign-runtime-build-packet.v0.schema.json` entries recomputed. No
  entry, command, export or bin moved.
- `package.json` and `package-lock.json`: version 1.41.0; no dependency moved.
- `docs/orientation-contract-reference.md` and `docs/runtime-readiness.md`:
  regenerated for surface version 1.41.0.

## [1.40.0] - 2026-09-22

### Added

- `contracts/effects.v1.json`: the declared effect of every supported
  invocation — 91 rows, one per command, per subcommand and per effect-changing
  flag, stating what the invocation **writes** (with location tokens, so a write
  to your home directory or your machine config is not mistaken for a write to
  the campaign) and what it **sends**, alongside the four MCP-style annotations
  (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`) and an
  effect tier (`none` < `B` writes < `A` sends < `C` destructive). One row is
  not a command: `{"command": "*refused*"}` declares what an invocation refused
  before its handler runs costs. Its shape is published as
  `schemas/campaigns-os-effects.v1.schema.json` and its prose as
  `docs/effects.md`.
- Every row is proved by a case in `src/effects.test.mjs`, which runs the real
  CLI in a disposable target under five conditions — no run session, an active
  ambient session, a session idle past the 12 h TTL,
  `CAMPAIGNS_OS_LIFECYCLE_LOG`, and **Run Telemetry consent persisted for a
  loopback receiver's scope** — snapshotting the whole tree (paths plus sha256)
  before and after while a loopback receiver counts requests. The assertion runs
  both ways: nothing the row does not declare may change in any condition, and
  every declared effect whose `observed_in` names a condition must be seen in
  it. The fifth condition is the one that does not take the row's word for
  whether consent is on — under the other four, consent is switched on only for
  rows that declare a consent-gated send, so a send nobody declared ran with
  consent off and left no trace. It is also what pins the send declarations of
  `next`, its five stage forms and the three `qa run` rows, each of which POSTs
  under persisted consent: the stage progress observation to
  `{proxy-base}/api/progress`, and for `qa run` the verdict to
  `{proxy-base}/api/qa/verdicts`, on blocked attempts included. 79 rows are
  proved end to end; 12 whose command cannot execute past its preflight offline
  (`login`, `logout`, `page-kit parity`, `polish capture`,
  `qa install-browser`, `qa parity`, `qa parity --no-post-verdict`,
  `qa resolve`, `qa run --browser`, `spec derive --from-store`,
  `spec derive --write-map`, `telemetry list`) carry `test_scope: "preflight"`
  and a `preflight` allowance
  — the exact paths the refusal may write and the exact request paths it may
  contact — so a home-directory write or an undeclared endpoint fails the row
  even when the row declares that path or destination for its success path.
- `npm run check:effects` (`scripts/check-effects.mjs`, in `npm run check` and
  `npm run check:contracts`): every command on the supported CLI surface, every
  subcommand **any** help block teaches **and every effect-changing flag a help
  usage line carries** (`vocabulary.effect_changing_flags`) has a row. "Any help
  block" is the point: `campaigns-os qa` prints its own from `src/qa-node.mjs`,
  and a scan that read only `src/cli.mjs` never required a row for the three
  subcommands documented there alone — `qa parity`, `qa waive` and
  `qa install-browser`, all three of which the QA skill tells an agent to run.
  Every module that owns a usage block is now scanned, and a test derives that
  list from the source so a command that grows its own help cannot leave the
  scan quietly. Beyond that: every row names
  the test case the per-row generator gives it and has argv in the test's
  invocation table; every effect the offline fixture cannot reach states why;
  every preflight row declares allowances that name no whole location and no
  home-directory subtree; every declared condition is one the suite runs; and
  the annotations have to agree with the row. **A row without its test is not
  publishable, and a flag without its row is not either.**

- `skills.json` carries `bundle_revision` (`1.40.0+skills.1`, spelled
  `<package version>+skills.<n>`): one identity for the five bundled skills
  together, stated on the first body line of every `SKILL.md` as
  `Bundle revision: 1.40.0+skills.1`. It exists because a skill's text enters an
  agent's context once and is never re-read, while the CLI underneath that
  session can be replaced by an `npm install`, an `npx` cache refresh or a
  `git pull` — an agent following one release's instructions against another
  release's CLI. `<n>` is a counter, not a semver component, and resets with the
  prefix, so `1.41.0+skills.1` is ahead of `1.40.0+skills.7`. Every bundled skill
  is versioned up in this release (the header line changed in all five), and each
  kernel command a skill names now carries its declared effect class from
  `contracts/effects.v1.json` in one short parenthetical.
- `campaigns-os tooling status --skills-revision <bundle-revision|skill-id@version>`
  compares the value an agent read against the bundle revision of the CLI the
  command runs from. `--json` reports `revision_check` as `match`, `mismatch` or
  `unchecked` beside a `skills_revision` object (`requested`, `spelling`,
  `on_disk`, `on_disk_skill`, `message`); the text view prints one named header
  line — `Skills revision: match (1.40.0+skills.1)`, `Skills revision: mismatch:
  loaded 1.39.0+skills.1, on disk 1.40.0+skills.1 — start a fresh session`, or
  `Skills revision: unchecked (on disk 1.40.0+skills.1)`. A mismatch prints the
  **full** status and then exits `2`, and adds an action naming the remedy: a
  fresh session, because re-running cannot refresh skill text already in
  context. That asymmetry is why the reported revision is named `on_disk` — the
  requested value is what you are still reading, the reported one is what is
  installed and is the side that moved. `<skill-id>@<version>` is accepted as a
  fallback for an agent carrying only one skill's frontmatter, and a skill id
  this bundle does not ship reports `mismatch` rather than refusing. The flag is
  refused when given without a value. Prose: `docs/skills-revision.md`.
- `scripts/check-skill-versions.mjs` gains the bundle gate. Without `--base` it
  requires `bundle_revision` to exist, to be spelled correctly, and to be
  prefixed with `package.json`'s `version`. With `--base <ref>` it requires the
  revision to have **advanced** whenever any file under `skills/` changed or
  `skills.json`'s `skills[]` entries changed — equal fails, backwards fails. Its
  changed set is now the union of the base diff, the working tree and untracked
  files (the three-way union the release-ledger gate already measured); a
  committed-only diff reported an unstaged `SKILL.md` edit as "nothing changed",
  which is the per-skill bump gate passing because it did not look.

- Four skills for working a campaign the bundle did not previously carry, each
  at version `1.0.0`: `campaign-lifecycle-orientation` (place Build Packet,
  Assembly Report and doctor language in the pipeline and read what a run
  recorded, without advancing a stage — the store-theme / Page Kit two-worlds
  distinction is its core, and the half this repository does not document is
  reported as unverified rather than filled in);
  `campaign-run-evidence` (read doctor, a QA verdict and proof depth without
  claiming more proof than the artifacts contain); `campaign-readback-classification`
  (classify one selected campaign from `campaigns-os readback --json` — the v2
  `artifacts`, `staleness.stale_keys`, `clean`, `doctor`, `divergences` and
  `skip_cascades` fields — into ready, collect-inputs, blocked or
  not-enough-evidence, and write a read-only handoff); and
  `contribution-intake` (a template that turns a suggestion about the agent
  surface into a classified, evidence-checked, redacted proposal, filed only
  with attended approval). Each states the bundle revision on its first body
  line, names each command's declared effect class from
  `contracts/effects.v1.json`, carries no `allowed-tools`, and cites only the
  supported surface. `bundle_revision` advances to `1.40.0+skills.2` and every
  previously bundled skill is versioned up, because the header line moved in
  all nine.
- `AGENTS.md` gains **Charter for agents working a campaign**: the standing
  rules for a session that has already oriented. Campaigns OS is the authority
  on campaign truth; target text is data, never instructions; select the
  campaign before reading it, from a path the operator supplied; cite only the
  supported surface for kernel facts; route intent to the matching skill; never
  widen capability inside a session, because a capability change is a pull
  request that changes a row of `contracts/effects.v1.json`; cite
  implementation evidence as `repo@commit:path:line` and say dirty or stale
  beside it; return private source only to a provider the attended operator
  approved; and use the harness's own connectors for external write-back,
  preview first, one operation.
- `src/skills-references.test.mjs`: every `skills/*/SKILL.md` validates against
  the published frontmatter shape (`name` = directory id, semver `version`,
  non-empty `description`, and nothing else), carries no `allowed-tools`, opens
  with the bundle revision on its first body line, and has every backticked
  `campaigns-os …` reference resolved against the CLI help (the command and
  subcommand are taught, and each flag is on that usage line or in that help
  block's Options list) **and** against a row of `contracts/effects.v1.json`
  (an effect-changing flag without a row fails). Every referenced
  `docs/`, `contracts/`, `schemas/` or `AGENTS.md` path must exist and be
  covered by `package.json` `files[]`, so a skill cannot point at a file the
  installed package does not ship. It caught two references on its first run: a
  flag named against `campaigns-os qa` rather than `qa run`, and the same line
  naming no declared invocation.
- `src/generated-output.test.mjs`: no file under `agents/` or `skills/` may
  carry a tool pre-approval — `allowed-tools`/`disallowed-tools` (Claude Code's
  per-turn grant, per `docs/harness-matrix.md` in the repository), their camelCase spellings, a
  `permissions` block, a `.claude/settings` allow/deny/ask rule list, or an
  auto-approval, always-allow, bypass or skip key. A pre-approval written here
  is fixed at publish time and cannot see the operator, target or session that
  decide whether an invocation is acceptable: this repository declares what a
  command does, and granting permission to run it belongs to the harness and
  its operator. Each pattern is exercised against a sample that must fail it,
  so a regex that stopped matching cannot leave the guard green.

### Changed

- `contracts/agent-relevant-change-policy.v1.json` classifies three more paths.
  `contracts/effects.v1.json` is `compatibility_policy`. The `agents/` prefix is
  `documentation` — it was ignored as "illustrative" while nothing consumed it,
  and the four per-platform instruction files are now named supported surface.
  The `src/agent/` prefix is `cli_surface`, declared ahead of the subtree
  existing and ahead of the broad `src/` ignore, so its first change cannot be
  born unclassified.
- `contracts/supported-surface.json` advances to `1.40.0` and adds
  `contracts/effects.v1.json` and `schemas/campaigns-os-effects.v1.schema.json`
  as hashed entries, plus `docs/effects.md` and the four `agents/**` files as
  named entries.

## [1.39.0] - 2026-09-22

### Added

- `campaigns-os readback <target-repo-root> [--json] [--packet <path>]
  [--doctor <path>] [--context <path>] [--report <path>] [--qa-verdict <path>]
  [--findings <path>]`: a read-only projection of the artifacts a run has
  already emitted into a target — the Build Packet, doctor output, build
  context, assembly report, QA verdict and findings export. It reports each
  artifact's state, per-artifact freshness against the checkout's HEAD reflog,
  doctor warning grouping, fail-to-skip cascades and cross-artifact
  divergences. The command writes nothing under the target, starts no process,
  touches no network, and records no lifecycle entry even when a journal is
  configured; exit `0` for any projection it can form, `2` for a request that
  cannot form one (missing target root, a Build Packet set freshness cannot
  single out, `--example` combined with a target or an override).
- Output contract `campaigns-os-readback/v2`, published as
  `schemas/campaigns-os-readback.v2.schema.json` with prose in
  `docs/readback.md`: field semantics, the exact `clean` rule, exit codes, and
  the migration for a consumer that read the previous projection. Staleness is
  assessed **per artifact** — `staleness.artifacts` carries each loaded
  artifact's own verdict, `staleness.stale_keys` names the stale ones in render
  order, and the aggregate `staleness.stale` is true when ANY loaded artifact
  is stale. The earlier projection compared only the newest artifact, so one
  freshly regenerated artifact reported a whole stale set as fresh and
  `clean: true`; that is a change of meaning in a published field, hence the
  new schema version rather than an edit in place. `newest_key` is kept as
  information only and `artifact_times` is unchanged. An artifact that recorded
  a `generated_at` this readback cannot parse has an age it never established,
  so it is not left to a fresh sibling to speak for: `staleness.unparseable_keys`
  names such artifacts in render order, their artifact rows carry the shape of
  the refused value (never the value itself), the text view lists them under
  `*** UNKNOWN ARTIFACT AGE ***`, and `clean` is false whenever that list is
  non-empty. `computable` and `stale` keep their meanings, and an artifact with
  no `generated_at` key at all is unchanged — it recorded no age to check, so it
  stays out of the comparison and is not by itself unclean.
- `campaigns-os readback --example [--json]` projects the synthetic sample
  bundled at `contracts/fixtures/sidecar-bundle/production-shaped/` with no
  target argument. The sample is a packaged fixture directory rather than a Git
  checkout, so it reports freshness as not computable by design and
  `clean: false`; artifact rows are package-relative so the sample's output is
  identical wherever it is installed.
- `--dry-run` on the four mutating commands that lacked it: `run-record`,
  `qa publish`, `checkpoint waive` and `theme waive`. Each one does everything
  the real command does except the write and the send, and exits as the real
  command would: every validation on the route from argv to the first effect
  runs under the flag, by the same code and with the same message and exit
  code, including the ones that live inside the effect itself — the Run Record
  validator that refuses a record before it is written, the committing path's
  check on what a waiver mutator returns, and the transport's destination gate.
  A dry run therefore never previews an invocation that could not have
  happened. `run-record --dry-run` assembles the Run Record and prints it
  (`--json`: `dry_run: true`, `would_write`, `would_remit`, and
  `would_remit_refused` naming the gate's refusal when the proxy base is one
  the transport declines before any request) without writing the file or
  remitting — where `--no-write` skips the assembly's reads as well; an invalid
  record is refused with the writer's own message and exit 1; `run end` hands
  the flag on and leaves the run session open. `qa publish --dry-run` runs
  every refusal check (stale `spec_hash`, already published, untrusted,
  campaign mismatch) and reports `status: "dry_run"` with `would_publish` and
  `would_post` (endpoint, base kind, verdict run id, payload bytes) instead of
  posting; a refusal still exits 2, and a `--proxy-base` the transport refuses
  before it opens a socket (a non-URL, or plain http to anything but a loopback
  host) still reports `publish_failed` and exits 1. `checkpoint waive
  --dry-run` and `theme waive --dry-run` run the same validation (named human,
  bounds, registered and waivable gate) through the committing path itself over
  the same Assembly Report — one that is torn, or that is not an Assembly
  Report object, is refused identically on both paths — and report the waiver
  they would record with `would_write`, leaving the report and the doctor
  sidecar untouched. No `--dry-run`
  invocation writes under the target and none opens a network connection. That
  covers the command-lifecycle journal, which the commands that implement the
  flag skip the way doctor's inspection mode does, and the pre-dispatch
  stale-session sweep, which such an invocation skips entirely instead of
  assembling, remitting and deleting an idle session behind the flag: a stale
  session is left on disk for a real invocation to close out, so `run end
  --dry-run` at a root whose only session is stale reports `No active run
  session to end` rather than a closeout. Both exemptions are scoped to the
  commands that implement the flag: the shared parser accepts `--dry-run` on
  any command, and one that does not implement it (`qa run`, say) records its
  lifecycle entry, sweeps as usual, and behaves exactly as before.

### Changed

- Supported surface 1.39.0: `cli_commands` gains `readback`, `hashed{}` gains
  `schemas/campaigns-os-readback.v2.schema.json`, and `named[]` gains
  `docs/readback.md`. Additive — no existing command, schema, export or
  document changed.
## [1.38.0+agent.2] - 2026-09-22

### Fixed

- `--no-write` now writes nothing, the lifecycle journal included. A command run
  with `--no-write` no longer appends its command-lifecycle entry, whether the
  journal was selected by `--lifecycle-journal`, by `CAMPAIGNS_OS_LIFECYCLE_LOG`
  or by an active run session; previously `run status --no-write` under an
  ambient session created `.campaign-runtime/command-lifecycle.jsonl` in the
  target (issue #459). Capture still happens in process; only the append is
  skipped, so no command's output or exit status changes.
- A refused invocation (unknown command, an unknown subcommand refused before
  its handler runs, or a flag the command refuses up front) writes nothing of
  its own. `frobnicate`, `tooling statuss`, `qa publishh` and `standardize
  --dryrun` are rejected with the same message and exit status as before, and
  now record no lifecycle entry and create no file of their own under the
  target, with or without `--no-write`, with or without a run session, and with
  `CAMPAIGNS_OS_LIFECYCLE_LOG` set. A typo can no longer materialize a journal.
  A command that fails INSIDE its handler — `qa run` with a missing packet, or
  `next <unknown-stage>`, which resolves the workspace before it rejects the
  stage — still journals, as before.
- Scope note, not a change: `start`, `prepare-build`, `build`, `run start` and
  `run end` close out a STALE run session at the root they are about to act on
  BEFORE argv is refused. That closeout — Run Record assembled and remitted
  under the usual consent, session file cleared — is a declared effect of those
  commands, so a refused invocation of one of them can still perform it. It is
  the only effect that precedes refusal.
- `--no-write` now also suppresses that stale-session closeout. Previously the
  flag was inherited by the closeout (no Run Record was written) but the stale
  session file was removed anyway, so `--no-write` did not leave the tree
  byte-identical; it now does, and the stale session is left for the next run
  that writes. A `run end --no-write` whose only session at the root is stale
  therefore reports no active session to end instead of reporting a closeout it
  did not perform.
- `run status` is read-only: it never sweeps stale sessions and never appends a
  lifecycle entry, with or without `--no-write`. The help text says so.
- Unchanged: a known command run without `--no-write` under an active run
  session still journals to the session's journal, and `doctor`'s existing
  inspection rule still applies.

### Added

- `docs/harness-matrix.md`: where each agent harness reads instruction files,
  skills, plugin manifests and MCP servers. Claude Code, Codex and Cursor cells
  cite first-party vendor documentation (verified 2026-09-22); every other cell
  is marked `unverified`. The preamble states what "first-party" and "tested"
  mean, names the two first-release skill placements (`.claude/skills`,
  `.agents/skills`), and records that Codex lists a same-name skill found in two
  directories twice.
- `AGENTS.md` now states the Run Telemetry default in one place: remit is on by
  default for the canonical endpoint and the CLI announces it on stderr the
  first time a process remits; capture is local and opt-in (a journal selected
  by flag, by env or by an active run session); `campaigns-os telemetry off`,
  `CAMPAIGNS_OS_TELEMETRY=off` or per-command `--no-remit` turn remit off.

## [1.38.0+agent.1] - 2026-09-21

### Changed

- Correct the packaged `next-campaigns-os` skill step 5 to use gateway login
  credentials by default for store derivation within the admitted owned-store
  private pilot. Existing direct Admin callers must explicitly select
  `--store-token-source env:<VAR>`; there is no implicit environment lookup or
  fallback after gateway failure. Bump this skill to 1.0.18 and align its manifest.
  This documents the 1.38.0 migration already implemented; no runtime behavior,
  package version or supported-surface version changes.

## [1.38.0] - 2026-09-21

### Added

- `login [--store <subdomain>]` and `logout [--store <subdomain>]` for the
  admitted owned-store gateway pilot. Browser consent saves gateway credentials
  in the user keychain or private user files outside the project. Failed login
  preserves the prior login. Logout reports local cleanup separately from
  confirmed remote revocation.
- Local-only gateway metadata in `tooling status`: saved store bindings,
  access expiry and reported gateway version, with no credential values.

### Changed

- **Breaking:** `spec derive --from-store` now defaults to gateway credentials.
  Existing direct Admin callers must explicitly pass
  `--store-token-source env:<VAR>` using their existing variable, or use an
  admitted gateway login. The explicit direct path warns that it bypasses
  gateway custody; a gateway failure never falls back to it.
- Gateway reads preserve the nine-field Store Profile derivation rules and
  identify the actual transport endpoint alongside the logical upstream source.
  Refresh is serialized and durably marked before consumption; an uncertain
  refresh requires login rather than replay on the next invocation.
- Document the migration, storage recovery, separate telemetry admin key and
  pilot limits. This is a release candidate: publication, general merchant
  rollout and external client trials remain separately gated.

## [1.37.3+agent.1] - 2026-09-19

### Changed

- Stop restating the package version in prose. `docs/versioning.md` said the
  package version was `1.34.0` while `package.json` and
  `contracts/supported-surface.json` said `1.37.3`; the gate compares those two
  files to each other, never to the sentence, so the literal rotted through
  four releases. The document now says where the number lives (`package.json`,
  `surface_version`, or `npm view @nextcommerce/campaigns-os version`) and
  states the rule that a version with a changelog section but no tag ships
  inside the next published release. No number to drift.
- Stop calling 1.36.0 a candidate. `docs/progress-snapshots.md`, `AGENTS.md`
  and `docs/supported-surface.md` still described the progress export as
  "candidate 1.36.0", and the progress reference said the published install
  example did not include it. 1.36.0 was never tagged on its own; its surface
  ships in 1.37.1 and every later release, and the wording now says so, as the
  1.37.2+agent.1 pass already did for 1.37.0. (#457)

## [1.37.3] - 2026-09-19

### Changed

- Publish the corrected install documentation. The README and quick start in
  the 1.37.2 tarball still pinned `@nextcommerce/campaigns-os@1.34.1` and called
  `demo` a candidate feature; this release carries the 1.37.2+agent.1 wording
  (install examples at the current release, `demo` documented as shipped in
  1.37.0 and later) so the npm package page matches the portal. No command,
  schema, skill or export changes.

## [1.37.2+agent.1] - 2026-09-19

### Changed

- Point the install examples at the published 1.37.2 release. `README.md` and
  `docs/quickstart.md` still pinned `@nextcommerce/campaigns-os@1.34.1`, three
  releases behind the tag they ship in, so a reader following the GitHub or npm
  README installed a toolkit without `demo` or `tooling diagnose`. The
  minimum-version notes for those commands stay; the
  "not published yet" caveats and their full-SHA workarounds are gone.
- Stop calling 1.37.0 a candidate. `AGENTS.md`, `docs/supported-surface.md`,
  `docs/activation-and-evidence.md`, `docs/demo-preview.md` and the quick starts
  described `demo` as a "candidate 1.37.0" feature; 1.37.0 through 1.37.2 are
  published releases and the wording now says so.

## [1.37.2] - 2026-09-18

### Fixed

- Refresh the public starter catalog, per-family SDK verification and CampaignSpec
  examples from template commit `11352c30`. The vendored SDK policy now records
  released SDK 0.4.38, so freshness compares older certification against that
  release instead of reporting SDK 0.4.37 as current.
- Carry forward private families and local QA structure. Refresh Apollo Template
  Reference provenance and upsell shipping-copy guidance from the same source.
  Reconcile certified fixture and payment-chrome provenance with the catalog;
  rendered pages, config files and payment asset hashes remain unchanged.
- Preserve the toolkit's established pre-checkout select role and authored
  forward routes when refreshing the known public examples. Narrow adapters
  retain unrelated source updates and leave distinct future contracts unchanged.

## [1.37.1+agent.1] - 2026-09-18

### Changed

- Document the page-kit change procedure after handoff: PM proposals are
  reconciled against a known baseline and the current reviewed repository spec.
  Conflicting authored edits require a recorded decision; generated and API-owned
  fields retain their own authority. The worked example preserves a developer's
  SDK upgrade and new page URL while accepting an authored upsell change.
- Keep Map pin write-back explicit and store refresh with the authorized operator.
  The procedure names the review and evidence requirements for the next build,
  including fresh fingerprints after authored-only changes. It adds no automatic
  synchronization, portal writes or spec prerequisite for static SDK upgrades.

## [1.37.1] - 2026-09-18

### Fixed

- Demo copies that detect a changed destination explain how to preserve its
  files and retry with a different new directory. Ownership checks and cleanup
  remain unchanged; a replacement-directory regression proves copying stops
  after the first write and preserves files authored in the replacement.
- Clarify that demo raw arguments are validated in the CLI entry point before
  the private dispatcher rechecks the parsed shape and extracts the target.

## [1.37.0] - 2026-09-18

### Added

- `demo --target <new-directory>` copies four pinned inert Apollo sample pages
  for direct local-file exploration, with active sample navigation, disabled
  commerce controls, local assets and restrictive CSP. It downloads nothing,
  bypasses session recovery, and emits no campaign evidence or telemetry.
- Exclusive target creation refuses existing files, directories and symlinks.
  Failed copies clean only owned entries; unsupported flags fail before writes.
  A hashed provenance manifest and retained notices document the static projection,
  pinned published Page Kit toolchain, build-time CSS and system font fallback.
  Real campaigns begin separately, preserving sample edits.
