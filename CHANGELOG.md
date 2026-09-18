# Changelog

Notable supported-surface changes are recorded here.

## [1.34.1] - 2026-09-18

### Fixed

- Playwright 1.63.0 and YAML 2.9.1 are validated with runtime recipe 1.0.2,
  whose install-script expectation reflects removal of fsevents. The v1
  contract retains exact agreement for additions and removals.
- CI runs independent TypeScript, unit, contract and required Chromium checks
  behind the existing `check` status. Missing Chromium fails browser proof.
  Installed-package checks exercise shared, conflicting and latest consumer
  Playwright versions using the package-owned browser installer and launcher.
- Unit tests are discovered automatically as the codebase grows. Dependabot
  groups minor/patch updates and leaves major API upgrades separate.

## [1.34.0] - 2026-09-17

### Added

- `campaigns-os sdk storage-check --target <git-root> --target-sdk <x.y.z>
  --manifest <SDK-manifest.json> --scope <dir,file> [--exclude <dir,file>]
  [--json]` checks Git-tracked campaign HTML and JavaScript before an SDK
  upgrade. The SDK-owned migration manifest supplies storage keys, verified
  release boundaries, and public replacements; the scanner carries no second
  registry. Explicit source scope and exclusions are recorded with file hashes.
  Inline scripts and local shared scripts are checked, with findings at their
  original source locations. Known incompatible accesses fail the check;
  unresolved code, unreadable sources, and unsupported target versions cannot
  produce a clean result. No merchant source, SDK pin, or lifecycle journal is
  written. The report identifies manifest bytes and available Git provenance.
- The new `sdk` CLI command and its reference are supported surface. This is
  source compatibility evidence only: order, browser, and analytics behavior
  still need their own proof. Supply the SDK manifest explicitly; the pending
  SDK contract change does not imply an existing released tag contains it.

## [1.33.0+agent.5] - 2026-09-17

### Changed

- The package is licensed under Apache-2.0. `package.json` `license` moves
  from `UNLICENSED` to `Apache-2.0`, and `LICENSE` (the Apache License 2.0
  text) and `NOTICE` (copyright Next Commerce Pte. Ltd.) are added and ship
  in the tarball, so the public npm release carries a usage grant, a patent
  grant and the trademark carve-out. `contracts/agent-relevant-change-policy
  .v1.json` classifies both files as repository metadata with no agent
  impact. Nothing else changed.

## [1.33.0+agent.4] - 2026-09-17

Same-surface: six static SDK markup checks join the built-output doctor
family beside `built_output.upsell_selector_scope`.

### Added

- Doctor check `built_output.sdk_markup` (#303), registered in the
  built-output check registry and reached from both doctor entry points on
  every invocation. Six shapes of `data-next-*` markup the Campaign Cart SDK
  binds without complaint and then silently no-ops or double-writes on; the
  codes are a partner kit's lint codes so the vocabularies line up, and each
  issue is `built_output.sdk_markup.<code lower-cased>` with a message that
  leads with the code. Blockers, not waivable: `SWAP_WITH_ADD_TO_CART` (a
  bundle selector in swap mode — explicit or the SDK default — with an
  `add-to-cart` button linked by `data-next-selector-id`; upsell-context
  selectors exempt), `CHECKOUT_NOT_FORM` (`data-next-checkout` off a
  `<form>`), `WRONG_FIELD_NAME` (`data-next-checkout-field` outside the SDK's
  fixed names; the message names the SDK spelling for `firstName`,
  `lastName`, `zip` and friends), `MISSING_SELECTOR_ID_MATCH` (an
  `add-to-cart` link to a selector id no element carries). Warnings:
  `DOUBLE_SELECTED` (two `data-next-selected="true"` cards in one selector),
  `TEMPLATE_DOUBLE_BRACE` (`{{` inside an SDK-owned `<template>`).
  Information: `data-next-*` names outside the SDK attribute index are
  collected on the gate as `unknown_attributes[]` and printed as one advisory
  ready line, never a warning, because the certified templates carry their
  own `data-next-*` hooks. Parsed with parse5 (containment is real, not
  regex-approximated) and SDK template content is scanned. The field-name
  set and the attribute index are vendored whole from the SDK at a named tag
  (`src/sdk-attribute-index.mjs`, v0.4.38) rather than restated in prose.
  Gate evidence at `derived.checkpoint_gates[]` (`findings[]`, `warned[]`,
  `unknown_attributes[]`, `pages_scanned`, `sdk_attribute_index_version`);
  id in `derived.doctor_checks`. Fixtures: `fixtures/sdk-markup/<code>/{bad,good}`.
  Proven to pass with no advisory on every certified family's canonical
  render (`src/doctor-certified-family-reachability.test.mjs`).

### Changed

- `docs/build-packet.md` gains a "Built-output SDK markup gate" section;
  `docs/campaigns-os-build-flow.md` adds the SDK-markup assembly rule; skill
  `next-campaigns-os` 1.0.15 -> 1.0.16 extends step 6.

## [1.33.0+agent.3] - 2026-09-17

### Added

- `campaigns-os spec derive --from-store <subdomain> [--store-token-source
  env:<VAR>]` derives the nine `campaign.store_*` Store Profile fields from
  the store itself (#432 slice 2), the store → spec half of a direction
  `page-kit sync` completes spec → repo. It is opt-in: the default `spec
  derive` run is unchanged and still touches no network. `<subdomain>` is the
  store's `<store>.29next.store` subdomain; the Admin API read token comes
  from the environment only, `<SUBDOMAIN>_ADMIN_TOKEN` by default (dashes as
  underscores) or the variable `--store-token-source env:<VAR>` names, is
  sent as a bearer (scopes `store:read` and `content:read`), and never
  appears in the output (the result names the variable; a value that is not
  one line of printable ASCII is refused unsent, and a transport error that
  quotes a header is redacted). `GET /store/` (API version `2024-04-01`)
  gives `store_name` (`name`), `store_url` (`https://<primary_domain>`),
  `store_phone` (`contact_address.phone_number`, verbatim) and
  `store_phone_tel` (the same phone as a `tel:` URI, only for one plain
  number: an extension or vanity word leaves it not derived); `GET /pages/`
  (API version `unstable`, cursors followed under the store's own pages
  endpoint only, at most ten requests, one shared 45 s budget) gives
  `store_terms`, `store_privacy`, `store_contact`, `store_returns` and
  `store_shipping` as `https://<primary_domain>/<slug>/` from the one
  storefront page that carries the policy: a conventional slug
  (`privacy-policy`, `shipping-returns`, …) binds first, else the wider
  match by slug or title words (a page may carry two policies). Rows join the same `before -> after` diff with their
  store source, in the Store Profile's field order; values are compared
  NFC-normalized and trimmed as `page-kit sync` compares them, plus derive's
  own leniency that URL fields compare without a trailing slash; every
  value passes the Store Profile shape rule first (the demo store's URL or
  phone, a non-http(s) URL, a malformed `tel:` or a control character is
  `target_invalid`). A field the store cannot state is reported and the
  spec's value is left as it is, never emptied: `store_field_missing`,
  `store_domain_missing`, `store_page_not_found`, `store_page_ambiguous`,
  `store_pages_unavailable`, `store_pages_truncated`. A primary domain that
  is not the host the spec's `store_url` named warns
  `spec.derive.store_domain_changed` (a stale spec, or the wrong store). The
  result gains a `store` block and the text output a `Store:` line; after a
  store field is written, `next` is `page-kit sync` then doctor. A store that
  cannot be read is a refusal with nothing written, exit 2:
  `spec.derive.store_credential_missing`, `store_credential_invalid`,
  `store_unauthorized` (401/403), `store_not_found` (404),
  `store_unreachable`, `store_response_invalid`; local preconditions are
  checked before the store is contacted, a packet swapped for another
  campaign's during the read is refused (`packet_changed_underneath`), and
  malformed store flags (`--store-token-source` without `--from-store`, a
  subdomain that is a URL, a token on the command line) are rejected before
  anything is read. `SPEC_DERIVE_FIELDS` in `src/spec-derive.mjs` now
  admits `campaign.store_*`; `src/spec-derive-store.mjs` is new. Skill
  `next-campaigns-os` 1.0.15 names the flag. No command, exit code or
  existing flag changed.

## [1.33.0+agent.2] - 2026-09-17

### Added

- `campaigns-os spec derive --packet <packet> --write-map [--dry-run]
  [--proxy-base <url>]` records the derived SDK pin in the saved Map's Build
  hints field (Campaign Cart SDK version), the repo → Map write-back #413
  named as the end state and #415 asked for. The local derive already brings
  the exported spec back in line after a bump; the Map itself stayed at the old
  pin until someone re-saved Build hints by hand, so every fresh export and
  everyone opening the Map read stale. After the local write, the Map named by
  the packet's `spec.map_id` is read back (`GET /api/spec/<map-id>`) and
  re-stated with exactly the pin fields moved (`global_config.sdk_version`,
  and `runtime.sdk_version` only when the Map already declares the alias):
  every other field is the Map's own read-back, never the local spec, so an
  authored field is not rewritten from a local copy and the routes or
  analytics ids derive wrote locally do not travel. The `PUT
  /api/maps/<map-id>` carries the packet's Campaigns API key (packet, local
  spec or declared env source, the same resolution the remit rail uses) as
  `X-Campaign-Key` and the Map's `spec_hash` as `X-Spec-Hash`, so a save that
  landed in between is a 409, not an overwrite. The proxy base is the canonical
  `https://campaign-map.nextcommerce.com` unless `--proxy-base` names another;
  it goes through the same TLS gate as every credential-bearing request
  (https, or a loopback host over http with the clear-text warning). The
  direction of authority is the gate's: the write goes forward or not at all.
  The result's new `map` object (and one text line) reports `written` (Map
  pin absent or behind the repo; `map.spec_identity.before` / `.after` carry
  the Map's `spec_hash` and `saved_at`), `unchanged` (already the repo pin),
  `would_write` (`--dry-run` reads the Map and sends nothing), `refused`
  (warning, exit 0, the local derive stands: `ahead`, a Map pin newer than
  the repo pin — never moved backwards; `pin_unreadable`, a pin the rule
  cannot order), `skipped` (the pin was not derived, `pin_<not_derived
  reason>`, or the local derive was blocked; nothing read or sent) or `failed`
  (error, exit 2, the local derive stands: `key_missing`, `key_mismatch` 403,
  `not_found` 404, `changed_underneath` 409, `rejected` 400/422,
  `proxy_base_insecure`, `network_error`, `http_error`, `response_invalid`),
  as `spec.derive.map_<reason>` warnings and errors. A write is traceable from
  the campaign's own record: one line on the Assembly Report's `evidence[]`
  (`Map write-back: global_config.sdk_version <before> -> <after> on Map <id>
  at <time> via spec derive --write-map (Map spec_hash <before> -> <after>)`,
  `map.recorded: "assembly_report"`), the retained doctor sidecar marked stale
  by `spec derive --write-map`, and the lifecycle journal entry the Run Record
  embeds; a missing report leaves a `spec.derive.map_not_recorded` warning
  carrying the same line, and a report that took the line while the doctor
  stamp failed leaves `spec.derive.map_doctor_sidecar_not_marked` instead,
  and one that could not be read back after the failure leaves
  `spec.derive.map_recorded_status_unknown` (`map.recorded: "unknown"`)
  rather than a claim either way; a 403 on the Map read is `key_mismatch`,
  as on the write.
  `--write-map` is a bare flag (a valued one is
  rejected), `--proxy-base` needs a URL and is refused without `--write-map`,
  and without the flag nothing is read from or sent to the Map. The result
  document gains `write_map` and `map` (null without the flag). The
  `page_kit.sdk_version.repo_newer` gate reason and its `refresh_spec` action
  description name the flag; the action's command is unchanged.
  The errors `fetchSpecByMapId` throws (`src/spec-fetch.mjs`) now carry `kind`
  (`network` | `http` | `invalid_json` | `not_ok`) and `status` as fields, so
  the write-back routes a 404 on the field rather than on the message.
  `docs/build-packet.md` gains "Recording the pin in the Map (`--write-map`)";
  README, `docs/quickstart.md` and `docs/supported-surface.md` name the flag.
  Skill `next-campaigns-os` 1.0.13 → 1.0.14: step 5 names `--write-map`
  beside the local derive and the hand re-save.

## [1.33.0+agent.1] - 2026-09-17

Same-surface: a new built-output doctor gate, plus the reachability fixture
tree every static built-output gate now has to pass on.

### Added

- Doctor check `built_output.campaign_identity` (#301), registered in the
  built-output check registry beside `built_output.upsell_selector_scope` and
  reached from both doctor entry points (the packet path and `doctor --built`)
  on every invocation. It fails a built campaign whose pages disagree about
  which campaign they belong to. The SDK reads three identity signals per page
  and reconciles nothing across pages: the API key
  (`<meta name="next-api-key">` beats `window.nextConfig.apiKey`, inline or in
  the `config.js` the page loads by `<script src>`; the legacy
  `nextCampaign.config({ apiKey })` spelling is read too), the `next-funnel`
  meta, and any `setAttribution({ funnel })` call. One error per finding, each
  naming the two files and the two values so the repair is a one-line edit:
  `built_output.campaign_identity.api_key_drift` (any two observed keys differ,
  from any source on any page, including a page whose meta and `config.js`
  disagree), `.funnel_drift` (`next-funnel` differs across pages),
  `.funnel_missing` (once any page carries the tag, a page declares
  `next-page-type` but no `next-funnel`; a campaign tagging no page at all is
  consistent),
  and `.attribution_drift` (a `setAttribution` funnel disagrees with the
  calling page's tag, or with the campaign's tag when that page has none).
  Not waivable: `checkpoint waive` does not register it, the gate's only
  required action is the edit. Pages whose route carries a `-backup-` or
  `-old-` segment are parked copies, skipped and listed as `pages_skipped`.
  Presence is not asserted: no key anywhere, or no `setAttribution` anywhere,
  passes on the funnel tag alone. The gate lands at
  `derived.checkpoint_gates[]` with `status pass | blocked | not_applicable`,
  `identity { api_key, api_key_source, funnel }`, `findings[]`,
  `pages_scanned`, `pages_skipped`, and in `derived.doctor_checks`. Fixtures:
  `fixtures/campaign-identity/` (clean, key drift, attribution drift).
- `fixtures/certified-families/`: the rendered `*.html` + `config.js` of every
  certified starter family, regenerated by
  `scripts/refresh-certified-family-fixtures.mjs` from the templates repo at
  the commit the manifest names, so the reachability bar from the #206 ON-2
  closeout is executable in CI: a static built-output gate ships with proof it
  passes on real pages from every certified family before it may block
  anything (`src/doctor-certified-family-reachability.test.mjs`, which now
  vouches for `built_output.upsell_selector_scope` and
  `built_output.campaign_identity`). Rendered from templates main
  `11352c3` rather than the catalog pin `a7cc8be`: at the pin every family's
  hidden upsell display selectors still lack `data-next-upsell-context`
  (templates PR #153 fixed that on 2026-09-01), so the selector-scope gate
  correctly blocks there; the manifest records the reason and the test prints
  a diagnostic until the catalog is re-synced.

### Changed

- `docs/build-packet.md` gains a "Built-output campaign identity gate" section;
  `docs/campaigns-os-build-flow.md` adds the every-page-names-the-same-campaign
  assembly rule beside the pre-checkout bootstrap rule; skill
  `next-campaigns-os` 1.0.12 -> 1.0.13 extends step 6 with the identity gate.
## [1.33.0] - 2026-09-17

Additive: the Run Record schema gains an optional `qa_verdict_publish` block,
and `qa` gains a `publish` subcommand that posts an already-stored verdict.

### Added

- `campaigns-os qa publish --packet <campaign-runtime.build.json> [--verdict
  <full-verdict.json>] [--republish] [--proxy-base <url>] [--json]` posts an
  already-stored QA verdict to the QA portal through the rail `qa run` uses,
  without re-running QA and therefore without placing an order (#328: "local
  first, publish when clean" was a full rerun that placed the whole typed-card
  order set a second time). Without `--verdict`, the committed
  `.campaign-runtime/qa-verdict.json` names the run and that run's full
  verdict under `<target-repo>/qa-output/<map-id>/<run-id>.json` is preferred;
  when only the projection is on disk it is what goes out and the result says
  so (`source_kind: sidecar_projection`). Before anything is sent the command
  refuses, exit `2`, with a named `refusal.code`: `spec_hash_mismatch` (the
  verdict's `spec_hash` is not the packet's current spec — one comparator, the
  normalising one from #416, so a `sha256:` prefix or case difference is not a
  mismatch; the result carries both hashes and the remedy is `qa run`),
  `spec_hash_absent`, `already_published` (the run's Run Record records this
  verdict's `run_id` as published; `--republish` overrides), `verdict_untrusted`
  (`trusted: false`, the `qa promote` chokepoint), `campaign_mismatch`,
  `verdict_missing` / `verdict_unreadable` / `verdict_invalid`, and
  `order_flags_refused` (`--test-order`, `--browser`, `--max-order-creations`,
  `--max-test-orders`, `--legacy-api-test-order`, `--select-package`,
  `--apply-coupon` have no meaning here and are refused by name rather than
  ignored). The post is classified by HTTP status the way a remit is (#397):
  `stored`, `already_stored` (409, an ok), `ok_unparsed_ack`, `refused`,
  `transport_error`; the last two exit `1` with the local verdict untouched;
  `0` prints the portal link. The result carries `orders_placed: 0` by
  construction. The outcome is stamped on the Run Record whose `qa_verdict`
  artifact references the verdict under the packet's campaign (by digest, by
  the `<run-id>.json` name, or by an existing block for the run id); a stored
  `ok` is never downgraded by a failed `--republish`; with no such record the
  publish still happens and the output says the outcome is unrecorded.
- Run Record (`campaigns-os-run-record/v0`): optional `qa_verdict_publish`
  block — `verdict_run_id` (the verdict's own run id, the publish idempotency
  key), `publisher` (`qa run` | `qa publish`), `attempted`, `ok`, `error`,
  `endpoint`, `state` (`skipped` | `ok` | `failed`), `result` (the
  `remit_result` vocabulary), `base_kind` (`canonical` | `loopback` |
  `proxy`), `published_at`. Additive; `additionalProperties` unchanged.
  `qa run` now builds the block from its own publish (or its
  `--no-post-verdict` skip) and hands it to the run session through the QA
  attempt, so `run end` and the QA auto-end write it on the record; a
  `run-record` re-emit carries a prior `ok` forward over a later attempt that
  did not land. Records written before this field carry no block.

### Changed

- `qa run` publishes through the same classified rail: its `--json` result
  gains `publish` (`attempted`, `ok`, `error`, `endpoint`, `result`,
  `http_status`, `base_kind`) and `qa_verdict_publish` (the record block);
  `posted`, `post_error`, `publish_skipped`, `publish_decision` and
  `dashboard_url` are unchanged. A 409 from the portal, previously a
  `post_error`, is now an ok publish (`already_stored`) with the portal link.
- `qa --help` lists `qa publish`, `--verdict` for both `promote` and
  `publish`, and `--republish`; the `--no-post-verdict` line points at
  `qa publish`. The top-level usage lists the command.

### Docs

- `docs/qa-and-test-orders.md`: new "Publish a stored verdict (`qa publish`)"
  section under Run — the two-command local-then-publish flow, verdict source
  resolution, the refusal table, outcome classification and exit codes, and
  the Run Record block.
- `docs/workflow-findings-sidecar.md`: Remit Channel names the
  `qa_verdict_publish` block, who writes it, and the never-downgrade rule.
- `docs/supported-surface.md`: the schema row records the 1.33.0 additive Run
  Record block; the CLI row names `qa publish`.
## [1.32.0+agent.1] - 2026-09-17

### Fixed

- `analytics-correctness:purchase-fires` judges the outbound Purchase against
  the whole post-checkout journey of the typed-card order, not the receipt
  document alone (#392). The SDK raises `dl_purchase`, and the Meta/GA4
  Purchase it drives, on the first page opened with `?ref_id=` that fetches
  the order — the upsell page on a funnel that has one — and then remembers
  the transaction id so the receipt does not report it again, so the
  receipt-only reading was a structural false negative (`absent`) on every
  funnel with an offer between checkout and receipt, and the only way through
  was the waiver lane #198 was written to avoid. The receipt stays the
  qualification point: a plan still needs a topology-recognized receipt, the
  same settle window, and the same capture-error and waiver semantics; only
  the capture the Purchase is read from widened. Each `evidence.receipts[]`
  entry now also carries `scope` (`journey`; `receipt` for an envelope that
  holds only the receipt document, which is judged exactly as before; `null`
  on an unmeasured entry), the receipt document's own `receipt_signals`
  (journey scope only, `null` otherwise), and `fired_on` (`receipt` or
  `earlier-page`, `null` when nothing fired), so a reader can tell which
  document fired. The assertion
  id, and so `qa waive --assertion analytics-correctness:purchase-fires`, is
  unchanged. `docs/qa-and-test-orders.md` and the `next-campaigns-qa` skill
  (1.3.0 → 1.3.1) no longer describe the receipt-only rule.

## [1.32.0] - 2026-09-17

Additive: the retained doctor sidecar names the command that wrote it.

### Added

- `.campaign-runtime/doctor-output.json` carries `generated_by`, the
  campaigns-os command that persisted it, beside `generated_at` (#312).
  Every producer stamps its own name: `doctor` (from `doctor --write`),
  `next`, `start`, `build`, and `qa run` (the QA stage refresh). The stamp
  is threaded from the command that knows its name, never inferred from
  argv at the write, and a producer that gives no name is refused rather
  than written anonymously — the same discipline `stale_marked_by` already
  applies to a stale stamp. `schemas/campaigns-os-doctor-output.v0.schema.json`
  gains the optional `generated_by` string (schema id unchanged; a sidecar
  written before this release carries no producer and still validates), and
  the production-shaped fixture bundle carries it. A consumer that reads the
  sidecar can now attribute it before deciding whether it is stale, current,
  or someone else's.

### Changed

- `standardize` is documented as what it has always been: read-only. #312
  reported it writing `doctor-output.json`; the repro copied an example
  target with `cp -R`, which copies gitignored files, and that checkout's
  example carried a sidecar from an earlier `doctor` run. The read-only
  proof in `docs/campaign-standardization-report.md` now covers that shape
  (a target already holding a sidecar, with and without a built `_site`,
  with and without `--no-doctor`) and says what `--no-doctor` actually
  skips: the built-output doctor pass inside the report, not a write, since
  there is none. `docs/qa-and-test-orders.md` and
  `docs/migration-sidecar-bundle.md` name the four producers by the names
  they stamp; the intake producer is `start`/`build` (`prepare-build` runs
  no doctor).

## [1.31.0] - 2026-09-17

Additive: one new CLI command, `spec`, joins the supported argv surface.

### Added

- `campaigns-os spec derive --packet <campaign-runtime.build.json> [--dry-run]
  [--json] [--report <json>]` writes the fields the target repo already states
  into the packet's local CampaignSpec (`spec.local_path`). Every spec field
  has a class (#432): authored (offers, funnel shape, copy intent), mirrored
  (Campaigns API data) or derived (the repo or the store already states it).
  Derived fields are generated, never typed, and this is the generator for
  the repo-derived ones, so doctor compares generated against generated
  instead of refereeing a hand-typed value against the repo. Repo-derived
  fields only, no network: `global_config.sdk_version` (and the
  `runtime.sdk_version` alias when the spec declares it, so the two never
  conflict) from `_data/campaigns.json[public_route_slug].sdk_version`; each
  active page's `page_url` from the page tree under `assembly.output_dir`
  (default `src/<public_route_slug>/`) — page-kit's own rule: by the
  file's basename alone, `checkout.html` → `checkout/` wherever it sits,
  `index.html` → the entry route (a nested `index.html` collides with the
  root and is not read), and a frontmatter `permalink`, which page-kit
  serves verbatim, is accepted only in the `/<slug>/<route>/` form
  prepare-build writes (`permalink: false`/`null`/`~`, a trailing comment
  and a BOM read as page-kit's frontmatter reader reads them) — mirrored into `funnel_pages[].page_url` when that
  legacy block exists; `analytics.providers.gtm.containerId` from `gtm_id`
  and `analytics.providers.facebook.pixelId` from `fb_pixel_id`. A page is
  bound to one file by the packet's own projection first
  (`source_html.pages[].page_kit.target_path`), else by a file whose route,
  terminal segment or filename matches the page; routes are compared in
  normalized page-kit form so a spelling difference is not a change, and a
  permalink in any other spelling (no slug prefix, another prefix, `.html`,
  `..`, a control character) is refused as `target_invalid` naming the URL
  page-kit would serve, rather than written. It
  prints a field-by-field `before -> after` diff with each value's repo
  source and writes nothing else: not the store profile (store-derived, the
  second slice), no authored or mirrored field, not the packet, not the repo.
  A derived field the spec carries with a different, authored-looking value
  is overwritten and the diff line shows it; a block the spec lacks is
  created (`global_config`, `analytics.providers.gtm` as `{ enabled: true,
  containerId }`); an array element is never invented. What the repo cannot
  state lands in `not_derived[]` with a reason and makes the status
  `partial` (exit 0; the rest is written): `scaffold_seed` (the entry still
  carries the starter demo store profile, so its pin is the starter's seed
  and `page-kit sync` seeds the pin from the spec in that state),
  `target_missing` / `target_invalid` (no `sdk_version`, or not a released
  `MAJOR.MINOR.PATCH`; an analytics id that is not a GTM container id or a
  digits-only pixel id), `waived` (an active named-human
  `page_kit.sdk_version` waiver covers the pair; the spec stays as the waiver
  accepted it), `page_tree_missing` / `page_file_not_found` /
  `page_file_ambiguous`, `entry_route_undeclared` (the page binds to the
  top-level `index.html`, the entry route, but is not flagged `is_entry`;
  doctor honours an empty `page_url` only on the entry page, so the flag is
  asked for rather than the route written), `spec_container_invalid` (the
  spec's `global_config`, `runtime`, `analytics`, `analytics.providers` or
  `analytics.providers.<p>` is not an object, reported by the plan so a dry
  run and a real run agree),
  `spec_ahead` (any released pin the spec declares, canonical or alias, is
  ahead of the repo pin: that is the state doctor blocks on with `page-kit
  sync` as its repair, per #413, and only one command may own it, so derive
  never moves a spec pin backwards), `waivers_unknown` (the Assembly Report
  could not be read, so a named-human pin waiver cannot be ruled out; the
  pin waits, routes and ids still derive), `page_id_duplicate`, and
  `target_empty` (the entry's id is empty while the spec declares one; an
  empty repo value never deletes a spec id). A placeholder id
  (`GTM-XXXXXXX`, a run of one digit) is `target_invalid`: writing it would
  declare an analytics contract QA then blocks on. A derived field the entry
  does not carry at all is listed in `not_in_target[]` and left alone. A
  routing hint (`sdk_hints.meta_tags.next-success-url`,
  `next-upsell-accept-url`, `next-upsell-decline-url`) that names a page
  whose derived route it no longer matches is reported as
  `spec.derive.routing_hint_stale` on every run until the Map is re-saved;
  hints are a Map projection the editor regenerates and are not rewritten.
  Routes are compared the way prepare-build projects them (normalized, slug
  prefix stripped), so a spelling that already resolves to the tree's route
  is not rewritten and a value nested differently from the tree is. After a write, the Build Context's `spec.hash` /
  `spec.material_hash` and the Assembly Report's `identity.spec_hash` /
  `identity.spec_material_hash` are re-bound to the new spec when they were
  bound to the one replaced and name that spec file (`rebound` on the result;
  QA's verdict and the bundle check correlate against the material hash),
  and a sidecar already carrying another identity, or naming another
  packet's spec, is left alone with a `spec.derive.identity_not_rebound`
  warning naming prepare-build; a derived
  route change also warns `spec.derive.projection_stale`, because the
  packet's page-kit projection and the Build Context page map were prepared
  from the old routes and prepare-build regenerates them; a provider block
  derive creates warns `spec.derive.analytics_block_created`, since the spec
  then declares a contract QA gates on. `--dry-run` carries the same
  `file_reformatted`, `projection_stale` and `build_stale` warnings, phrased
  as what a write would do. Write
  discipline is `page-kit sync`'s: one read serves the plan and the write;
  the file is edited in place and re-serialized with its own top-level
  indentation, line ending and trailing newline (`spec.derive.file_reformatted`
  when the round trip would not reproduce the file byte for byte); staged
  through a temp file created with the spec's own mode bits and renamed over
  it, after re-reading the spec and refusing (`spec.derive.spec_changed_underneath`,
  exit 2, nothing written) when it changed since the single read; written
  only at the path the spec resolves to, which must lie inside the spec's
  own directory or the target repo (`spec.derive.spec_escapes_boundary`
  otherwise, so a symlinked `spec.local_path` cannot redirect the write); a
  page file's frontmatter is read with CRLF normalized; the retained doctor
  sidecar is marked stale after a write (`spec.derive.doctor_sidecar_not_marked`
  if that fails) and a terminal build gets a `spec.derive.build_stale`
  warning with the rebuild in `next`. `--dry-run` prints the same diff and
  writes nothing; unknown flags and a valued `--dry-run` are rejected; the
  Assembly Report is read the way doctor reads it (Build Context binding,
  default sidecar, or `--report`; unreadable is `spec.derive.report_unreadable`).
  Exit 0 with status `derived` | `dry_run` | `unchanged` | `partial`; exit 2
  with status `blocked`, a `spec.derive.*` error and nothing written when the
  packet cannot be read or is not an object (`packet_invalid`), the route slug
  is absent (`route_slug_missing`), `spec.local_path` is absent, not a file or unreadable
  (`spec_missing`), the spec is not valid JSON or not an object
  (`spec_invalid`), the spec identifies another campaign by
  `spec_identity.public_route_slug` (else `campaign.slug`/`id`) or
  `spec_identity.map_id` (`spec_identity_mismatch`), or the target entry is
  unavailable (`entry_missing` with `detail.target_status`; scaffold first),
  the page tree cannot be read (`page_tree_unreadable`), or the write itself
  fails (`write_failed`). A bare `--report` is rejected.
  `--json` emits `{ ok, action: "spec derive", status, packet_path,
  public_route_slug, target_repo, campaigns_path, page_tree, spec_path,
  report_path, dry_run, written, changes[] { field, path, before, after,
  source, page_id? }, unchanged[], not_derived[] { field, reason, detail,
  page_id? }, not_in_target[], stale_hints[], rebound { build_context,
  assembly_report }, errors[], warnings[], next }`. The command is not pipeline-advancing and never records a
  deviation. `contracts/supported-surface.json` `cli_commands` gains `spec`
  and `surface_version` moves 1.30.0 → 1.31.0 (`package.json` and
  `compatibility.json` follow); `docs/supported-surface.md`,
  `docs/build-packet.md` (a new "Deriving the spec from the repo" section
  under the SDK version checkpoint), the README and `docs/quickstart.md`
  first-verdict paragraphs, and the regenerated orientation reference and
  runtime-readiness guide name the command.

### Changed

- The `page_kit.sdk_version` gate's `repo_newer` advisory (#413, shipped in
  1.29.0+agent.1) names the derive step. Gate semantics are unchanged: a
  configured campaign whose repo pin is newer than the spec's and released
  still passes with the `page_kit.sdk_version.repo_newer` warning, the repo
  behind the spec or a scaffold's seeded pin still blocks with `page-kit
  sync` as the repair, and an unreleased target pin still blocks unwaivably.
  What moved is the advisory action: `advisory_actions[0]` (`refresh_spec`)
  is now `kind: "command"` with `command: "campaigns-os spec derive --packet
  <packet>"` (was `kind: "edit"`, `command: null`), and its description and
  the gate's `reason` name spec derive alongside re-saving the Map's Build
  hints. QA's `page_kit.sdk_version` warn assertion projects the same gate
  and is otherwise unchanged. The scaffold-state rule both directions share
  (an entry still carrying the starter demo store profile) is one function,
  `entryInScaffoldState`, in `src/page-kit-sdk-version.mjs`: `page-kit sync`
  seeds the pin while it holds, `spec derive` refuses to copy the seed while
  it holds.
- Skill `next-campaigns-os` 1.0.11 → 1.0.12: step 5 tells the agent that a
  configured campaign whose repo pin moved first is brought back in line by
  `campaigns-os spec derive --packet <p>` (routes and analytics ids included),
  or by re-saving the Map, and never by a hand edit of a derived spec field.

## [1.30.0+agent.2] - 2026-09-17

### Changed

- Packet-mode `doctor` now inspects by default. It reports current blockers and
  keeps the same exit status without rewriting the retained doctor sidecar,
  Assembly Report, or active run journal. Pass `--write` to record a new doctor
  result; `--no-write` takes precedence. Callers that previously relied on the
  implicit write must add `--write`, including when using `--doctor-out`.
  Build, QA, and `next` retain their existing evidence-producing behavior.
  Readback of a delivered campaign can therefore diagnose stale local output
  without replacing the original delivery evidence.

## [1.30.0+agent.1] - 2026-09-16

### Changed

- The package is publishable to the npm registry as `@nextcommerce/campaigns-os`
  and installable globally (`npm install -g @nextcommerce/campaigns-os`).
  `private: true` is gone, `publishConfig.access` is `public` with provenance,
  `repository`/`homepage`/`bugs` are declared, and `package.json` `version` is
  `1.30.0`: it now equals `surface_version` (the supported-surface release the
  CHANGELOG is keyed to) instead of the `0.1.0-alpha.0` developer-preview
  literal it had carried since the first commit; `check:supported-surface`
  fails a surface bump that forgets `package.json`. `compatibility.json` and
  `docs/versioning.md` say the same. `.github/workflows/publish.yml` publishes
  on a `v<version>` tag push: an unprivileged job checks the tag against
  `package.json` and `surface_version`, requires the commit to be on `main`,
  runs the full `npm run check` and packs; a second job in the `npm-publish`
  environment, holding the only OIDC grant and installing nothing, publishes
  that exact tarball via npm trusted publishing (prereleases under the `next`
  dist-tag; an already-published version is a no-op). Actions are SHA-pinned.
  No export, command, flag, schema or exit code changed; a consumer pinned to
  a git sha is unaffected.
- `playwright` moved from `dependencies` to `optionalDependencies`. Every
  install still gets it by default (registry, global, and git-sha pins alike),
  the Chromium binary stays a one-time `campaigns-os qa install-browser`, and
  an install that omitted it (`--omit=optional`, or a failed optional install)
  no longer fails at import: `polish capture`, `qa run` and `qa install-browser`
  share one recovery hint, exported from `src/browser-launch.mjs`, naming the
  install command for the place campaigns-os is installed. Only a genuinely
  absent package (`ERR_MODULE_NOT_FOUND`) takes that branch; a present but
  broken Playwright surfaces its own error, and polish capture now carries the
  original error like QA does. Playwright remains the only supported browser
  driver.
- QA verdicts identify their producing runtime from `package.json` (now
  `campaigns-os-node-qa@1.30.0`) instead of a literal that had stayed at
  `0.1.0-alpha.0`.
- The tarball ships only what an installed consumer reads: `src/*.test.mjs`,
  `examples/`, `scripts/`, the non-surface `docs/` pages and the check-script
  fixtures under `contracts/fixtures/` (`campaign-specs`, `expected`,
  `legacy-migration`, `template-residue`) are excluded (556 -> 298 files,
  8.4 MB -> 4.7 MB unpacked). Every path in `contracts/supported-surface.json`
  still ships, plus `docs/polish-evidence.md` (referenced by the polish skill);
  the docs are listed by exact path in `files[]`, and `check:pack` asserts both
  the surface's presence and the exclusions against the extracted tarball.

## [1.30.0] - 2026-09-16

### Added

- The QA verdict records the order's data layer (#325). Every typed-card
  path that places an order now records what `window.NextDataLayer` said
  about that order across every page the path visited after checkout, on the
  order as `test_orders[].data_layer`, judged by one assertion per path,
  `analytics-correctness:data-layer-purchase:<path>`: exactly one
  `dl_purchase`, whose `ecommerce.transaction_id` is the placed order's number
  or ref id. One matching event passes; none is a blocker (`absent`); more
  than one is a blocker (`duplicate` — the #302 rule: a funnel that reports
  the purchase twice double-counts revenue and fails the same as one with
  none, whether both pushes are on one page or the dedupe failed across
  pages); one event naming another order, or none, is a blocker
  (`mismatch`); one event with no recorded order reference to match is
  `manual_review` (`order_ref_unknown`); a layer that could not be hooked or
  read is a blocker recorded as `measured: false` with null counts
  (`unmeasured`), never a zero reading. The reading is the whole
  post-checkout journey, not a snapshot of the terminal document, because the
  SDK raises `dl_purchase` on the first `?ref_id=` page that fetches the
  order back (the upsell page on a funnel with one) and dedupes it on every
  later page including the receipt — the first end-to-end run of a
  receipt-only reading came back `absent` on a correctly reporting funnel.
  The runner's data-layer hook (the one the analytics leg already uses) is
  now attached for every typed-card order; the runner waits for the event
  within `--analytics-settle` and the order deadline, then one second of
  grace so a second push can land before the count, and records a
  per-document breakdown in evidence. It counts the SDK's own array only (a
  GTM adapter's re-push to `window.dataLayer` is not a duplicate), never
  counts `dl_upsell_purchase`, needs no CampaignSpec analytics block, and is
  not re-taken on a recovery pass. This is the current-SDK bump lane's
  acceptance signal, which until now lived only in a separate read-only
  browser probe and a hand-authored evidence file outside the harness's own
  record. `schemas/campaigns-os-qa-verdict.v0.schema.json` gains the optional
  `data_layer` object on `testOrder` (additive; `surface_version` 1.29.0 →
  1.30.0). `docs/qa-and-test-orders.md` documents the reading and its six
  outcomes under Test Orders.

## [1.29.0+agent.15] - 2026-09-16

### Fixed

- The public `./commercial-journey` export no longer reaches `node:crypto`
  (#328). The spec-hash comparators it uses (`normalizeSpecHash`,
  `specHashesMatch`, `specHashOf`) moved out of `src/spec-identity.mjs` — whose
  `specMaterialHash` needs `node:crypto` — into a dependency-free leaf,
  `src/spec-hash.mjs`; `src/spec-identity.mjs` re-exports them, so its
  existing importers are unchanged. A browser-targeted bundle (esbuild, Vite)
  that imports `@nextcommerce/campaigns-os/commercial-journey` builds again
  without a `node:crypto` alias or shim; the static import graph of
  `./commercial-journey`, `./commercial-parity` and `./text-safety` is now
  guarded by a test that fails naming the first file and `node:` specifier it
  reaches. `src/spec-hash.mjs` is not a new package export; the supported
  surface is unchanged.

## [1.29.0+agent.13] - 2026-09-16

### Added

- Local proof mode for `deploy.target: local-serve` (#326): the build stage
  now renders page-kit in the development environment. `next build` emits a
  `build_local_proof` action carrying the exact command
  (`CPK_ENV=development npx campaign-build --json >
  .campaign-runtime/page-kit-build-summary.json`) and the build prompt says
  to record `stages.assembly.evidence.build_environment: "development"` on
  the Assembly Report (a free-form stage field; no schema change). The render
  goes into `_site/` — where polish capture, `qa run` and every
  `built_output.*` doctor check already look — so the served development
  build is what is proven. Starter templates gate every vendor loader on the
  environment; a production build's protocol-relative loaders (`//host/...`)
  fail over a plain-HTTP local serve and void polish capture, while the SDK's
  `dl_*` events still fire in development. Hosted targets build production
  exactly as before.
- `campaigns-os page-kit parity --packet <packet> [--report <json>] [--json]`
  proves the pin on the production output before commit. It renders the
  current source in development and production through the target's own
  page-kit into temp directories (nothing under the target is written except
  the result) and asserts, per page, that the served `_site/` is byte-
  identical to the current development render, that the page set and route
  slugs agree, and that the Campaign Cart loader pin and `next-api-key` meta
  are the same in the proven output and the production render (and match
  `_data/campaigns.json[<slug>].sdk_version` when readable). "Environment-
  gated" is derived from the rendered output — the diff between the two
  renders of one source — not from a vendor list; the pass line reads
  `Parity: <n> page(s) identical to the current development render;
  production differs only in environment-gated output (<lines> line(s);
  loaders: <hosts>); Campaign Cart pin <version>.` with one row per page. A
  failure names the first non-gated difference by kind
  (`sdk_pin_mismatch`, `sdk_pin_drift`, `sdk_loader_missing`,
  `proven_output_is_production`, `proven_output_stale`, `page_not_in_source`,
  `page_not_proven`, `page_only_in_production`,
  `page_missing_in_production`), route, path and line, exits 2, and is
  recorded on `stages.assembly.evidence.local_proof.production_parity` all
  the same. Every page must agree on the Campaign Cart pin, a missing loader
  included; CRLF renders compare and number like LF ones. A pass that could
  not be recorded on the report reports `status: record_failed` with
  `local_proof.parity.report_not_written` and exits 2, so the command and
  doctor never disagree. A packet whose target is not `local-serve` is refused
  (`local_proof.parity.not_local_serve`); a target without
  `next-campaign-page-kit` installed reports `local_proof.parity.unavailable`.
- Doctor rows under `local-serve` once assembly is terminal:
  `local_proof.build_environment` warns when the completed build is not
  recorded as a development render (naming the rebuild command), and
  `local_proof.production_parity` is a ready line on a recorded pass
  (`Local proof production parity: PASS — …`), an error naming the first
  non-gated difference on a recorded fail, and a warning while unrecorded or
  recorded for a different `stages.assembly.build_fingerprint`. `next build`
  under `local-serve` also emits a `build_production_parity` action with the
  parity command.

### Changed

- A polish capture over plain HTTP whose resource ledger shows a failed
  cross-origin `http:` dependency — the signature of a protocol-relative
  vendor loader from a production build served locally — now names the
  repair. The recorded `polish.hidden_eager_media` checkpoint's first
  required action becomes `polish.hidden_eager_media.local_proof_rebuild`
  (`The served build is a production build over plain HTTP: … Rebuild in
  local proof mode — `CPK_ENV=development npx campaign-build --json > …`
  — … serve the development output, and recapture.`), ahead of the recapture
  action; `polish capture`'s text output prints it as a `Required action:`
  line. The same failure off an `https:` origin, a same-origin `http:`
  failure, or a failed `https:` dependency keeps the plain recapture action.
- Hard rule, stated in every surface that could suggest otherwise (the
  rebuild action, the build prompt and action, the doctor rows, `--help`,
  and the docs): the toolkit never proposes editing a generated include
  (`analytics-head.html`, `analytics-body.html`, or any `_includes/` file
  marked GENERATED) to make a local capture pass. A test scans every
  source module for text that pairs an edit verb with a generated include
  outside that rule.
- `--help` documents `page-kit parity` and a `Local proof mode:` note;
  `docs/qa-and-test-orders.md` gains a "Local proof mode" section (build in
  development → serve → prove → production parity → commit → PR preview as
  the second check), `docs/build-packet.md`'s deploy-target section and
  `docs/polish-evidence.md`'s `capture_incomplete` row describe the same
  path.

## [1.29.0+agent.12] - 2026-09-16

### Fixed

- Browser QA's payment-chrome residue check tells an untouched starter strip
  from one edited in place by the served bytes, not by whether the SVG's
  markup names the method. The shared-commerce brand contract now records the
  sha256 of each `default_residue.payment_chrome.assets[]` file as the
  starter ships it (`payment_chrome.asset_sha256`, pinned to a
  starter-templates commit in `asset_pin.sha`); the runner hashes the raw
  bytes the page serves and, when they match, reports residue with the
  starter assets listed first and tagged inline
  (`residue found: upsell-payment-logos.svg [starter], .payment-method__icon--paypal-logo`,
  evidence `starter_assets`).
  Before, the shipped `upsell-payment-logos.svg` — whose PayPal wordmark is
  bare path data with no text, title, label or id naming the method — read as
  `edited in place ... no longer carries paypal chrome` and landed on
  `manual_review` on a page that had never been polished, and an actually
  edited strip was indistinguishable from it. Different bytes that no longer
  name the method are still `manual_review`; different bytes that still name
  it, and any asset that cannot be read, are still residue.
- Loading a brand contract fails (`payment_chrome_hash_missing` /
  `payment_chrome_hash_invalid`, naming the asset) when
  `payment_chrome.assets[]` lists an asset with no `asset_sha256` entry or the
  entry is not a 64-char hex digest, so a typo cannot quietly send that asset
  back to the markup test. A contract with no `asset_sha256` map at all still
  loads and uses the markup test for every asset.
- `check-template-doctrine` verifies `payment_chrome.asset_sha256` against the
  pinned starter-templates checkout and requires `asset_pin.sha` to be the
  catalog's `_synced_from_sha`, so the recorded hashes cannot drift from the
  bytes the starters ship. The family listing skips the same directories the
  partials walk does (`node_modules`, `_site`, hidden), and the pass line
  counts the hashes and families verified.
- The residue unit tests run against the starter's own chrome assets
  (committed under `contracts/fixtures/template-residue/`) instead of a
  synthetic strip that carried an `id="paypal-logo"` the real file does not.

## [1.29.0+agent.11] - 2026-09-16

### Changed

- The typed-card runner loads the checkout once per order path, not twice.
  The `entered_via_landing` selector probe's load is the checkout's only load
  on a path: when the probe finds a selection surface, `opened_checkout` now
  records `already on checkout from the selector probe; not re-opened` instead
  of loading the same URL again; on a landing-entry family the probe load is
  followed by the landing page and the SDK's own navigation, nothing else.
  Every load boots the SDK and fires its page-view events into the capture the
  analytics-correctness leg and the receipt capture read, so the second load
  was counted as the campaign's own traffic.
- A multi-path plan (`tiers:*`, several coupons) probes each checkout URL once
  per run and reuses the answer on the later paths. The step evidence carries
  `selection_surface_probe: loaded` on the path that ran the probe and
  `reused` on the rest; a reused answer on a selector family opens the
  checkout once in `opened_checkout`, and on a landing-entry family goes
  straight to the landing page. A probe whose page-side read failed is tagged
  `selection_surface_probe: failed` with `selection_surface_probe_error`, is
  never read as an empty checkout, and is not remembered.
- `docs/qa-and-test-orders.md` names the selector probe and its single load.

## [1.29.0+agent.10] - 2026-09-16

### Added

- `stages.assembly.build_fingerprint` now has an algorithm, and a command
  computes it. `computeBuildFingerprint(outputDir)` (`src/built-site-scope.mjs`,
  `sha256-manifest/v1`) hashes the built OUTPUT: every file under
  `_site/<public_route_slug>/`, root-relative `/`-separated paths sorted by
  code point, one `<path>\n<sha256>\n` pair per file, `sha256:` over that
  manifest. Identical output at any path on any machine yields one value; one
  changed byte, an added or removed file, or a toolkit/template upgrade that
  renders different bytes from identical source yields another. Nothing is
  excluded by default (Page Kit writes only rendered HTML and copied assets
  into `_site/`; its timestamped build summary lives outside the root).
  Until now the value was an opaque sha256-shaped string the operator typed,
  and every freshness comparison between build, polish and QA reduced to
  string equality on it. Algorithm paragraph: `docs/build-packet.md`.
- Doctor check `built_output.fingerprint` (built-output phase) recomputes the
  value on every run and publishes it at `derived.build_output_fingerprint`
  (`value`, `file_count`, `algorithm`, `root`, `recorded`, `status`
  pass/stale/missing) — the field build copies onto
  `stages.assembly.build_fingerprint` after page-kit build and the value an
  operator checks by hand. Pass prints the ready line `Build output
  fingerprint matches stages.assembly.build_fingerprint (<n> file(s) under
  _site/<slug>/)`; no recorded value is the warning
  `built_output.fingerprint_missing` carrying the value to record; a recorded
  value the output no longer matches is `built_output.fingerprint_stale`
  (`recorded <sha>, current <sha>`), an error once assembly is complete and a
  warning while the build is still in progress. The build prompt names the
  field instead of leaving the value to the agent.

### Changed

- The polish gate, QA and `polish capture` compare against the recomputed
  output fingerprint, not the recorded string. `evaluatePolishGate` takes
  `currentOutputFingerprint`; doctor and QA supply it from `_site/<slug>/`, and
  when the output has drifted from `stages.assembly.build_fingerprint` the
  gate is the new code `polish.output_drift` with `current_output_fingerprint`
  and a `rerun_build` action ahead of `run_polish`, even when
  `source_build_fingerprint` still equals the recorded value (`polish.stale`
  stays the code for evidence stamped against an older recorded build).
  `polish capture` refuses by name in three cases — no built route root
  (`built output root _site/<slug>/ is missing under the target repo`), an
  output the walk cannot read (`could not be read to fingerprint it (<code>:
  …)`), and drift (`built output under _site/<slug>/ no longer matches
  stages.assembly.build_fingerprint (recorded …, current …)`) — never an
  uncaught filesystem error and never a null binding; its capture binding
  carries `assembly.output_fingerprint`, so an output that changes during the
  browser pass fails the unchanged-binding check after it. Symbolic links
  inside the output are never build output: the walk skips them.

## [1.29.0+agent.9] - 2026-09-16

### Changed

- `bundle check` now reads the doctor sidecar's own verdict. A
  `.campaign-runtime/doctor-output.json` recording a blocked run (`status:
  blocked` or `ok: false`) emits `bundle.doctor_output.blocked` — a warning by
  default, because the sidecars still agree with each other and the contract,
  and an error under `--require-qa`, because a QA-complete handoff cannot ride
  a doctor that refused the build (the command then exits 2). Before, the only
  doctor condition checked was `stale: true`, so a bundle whose doctor said the
  campaign cannot proceed returned `ok: true, errors: []` even with
  `--require-qa`. The remedy names `campaigns-os doctor --packet
  campaign-runtime.build.json --strip-paths`.
- `bundle.qa_verdict.blocked` is now emitted whenever the QA verdict on disk
  has `disposition: blocked`: a warning by default, an error under
  `--require-qa` (before, it appeared only under `--require-qa`). `stage_blocked`
  keeps its published meaning (a required QA verdict is blocked) and is not
  widened for the doctor case; the JSON shape is unchanged and a ready doctor
  with a ready verdict produces byte-identical output.
- The text report prints a `Readiness:` line directly under `Status:` —
  `Readiness: BLOCKED (doctor run is blocked)`, `Readiness: BLOCKED (QA verdict
  is blocked)`, or `Readiness: no doctor or QA block recorded by the sidecars
  present` — so `Status: CONFORMANT` is never read as readiness. The line is
  text-only; `--json` carries the same answer in the two blocked findings.
- README and `docs/migration-sidecar-bundle.md` now say plainly that
  `conformant` means the sidecars agree with each other and the contract and
  says nothing about whether doctor or QA passed; read the warnings for that.

## [1.29.0+agent.8] - 2026-09-16

### Changed

- Doctor no longer requires the two CampaignSpec `sdk_hints.meta_tags` keys
  the Campaign Cart SDK does not read, `next-currency` and
  `next-predictive-address`, from the built page. Until now a spec that still
  carried them (older Map exports do; the Map Builder stopped emitting both)
  failed `validateBuiltSdkMetaTags` with `sdk_hints.meta_tags.missing` on every
  page, while QA marked the same tags `present but ignored by Campaign Cart`,
  so the spec, doctor and QA disagreed about the same two keys on every such
  campaign. Doctor now emits one advisory warning per page,
  `sdk_hints.meta_tags.ignored_by_sdk`, naming the key(s) and the reason
  (`Campaign Cart does not read a next-currency meta tag; remove it from the
  Map's page hints. ...`), whether or not the tag rendered and before `_site/`
  exists; the keys never appear in the pre-build `CampaignSpec expects SDK
  meta tags (...)` list. Detail carries `{ page_id, tags }`. The fix is an
  edit to the Map's page hints, not to the build.
- QA's `meta:<page>:<tag>` row for those two keys is now `status: warn`
  (severity `warn`) instead of `manual_review`: there is nothing for a human
  to review. Its `actual` and `evidence.note` are unchanged in shape and the
  note text now comes from the one shared list.
- New leaf module `src/sdk-meta-tags.mjs` exports `SDK_IGNORED_META_TAGS`
  (`{ tag: { expected, actual, note } }`), `sdkIgnoredMetaTag(name)` and
  `describeSdkIgnoredMetaTags(names)`; doctor and QA both import it, so the
  two surfaces read one list. Implementation, not supported surface.

## [1.29.0+agent.7] - 2026-09-16

### Fixed

- The Assembly Report's top-level `status`, `next` and `blockers` are derived
  from its `stages` on every write of the report instead of being written once
  by prepare-build and carried forward. Until now a campaign that had run the
  whole ladder still read `status: "prepared"`, `next.stage: "setup"` and
  `blockers: []` beside a `stages.qa` recorded `completed_with_warnings` or
  `blocked`, so a reader of the top level saw a campaign that had not started.
  `status` is now `blocked` while any recorded stage is blocked, `completed`
  only once every recorded stage — `prepare_build` and `doctor` included, not
  just the ladder — is terminal, and `prepared` otherwise, so a report whose
  doctor never recorded an outcome (`prepare-build --no-doctor`) reads
  `prepared` with `next.stage: "doctor"` even after the whole ladder has run;
  `blockers` is the union of the `blockers[]` of the stages currently blocked,
  so a blocker cleared by a re-run leaves the top level with its stage; a
  doctor recorded blocked and later passed reads `prepared` again.

### Changed

- The report's `next` block uses the `next <stage>` vocabulary the doctor
  sidecar and `campaigns-os next` already use: `next.stage` is the first
  non-terminal stage in ladder order (`setup`, `build`, `polish`, `deploy`,
  `qa`, then `done`), `prepare-build` / `doctor-blocked` when that gate is
  blocked, `doctor` when the ladder is exhausted but doctor never recorded an
  outcome (a pending doctor does not hold the ladder mid-run, exactly as the
  picker does not walk it, but it does hold `done`), `next.owner` is the
  owning skill (`next-campaigns-os-setup`,
  `next-campaigns-build`, `next-campaigns-polish`, `next-campaigns-qa`,
  `next-campaigns-os`), and `next.blocked: true` is present when the named
  stage is the one holding the ladder. A reader that branched on
  `next.stage === "assembly"` reads `"build"`, and on `"collect-inputs"`
  reads `"prepare-build"`. The report's `next` is the ledger's own position;
  `campaigns-os next` still folds in live gates (doctor findings,
  purchase-proof coverage, the polish gate) and stays the authority for what
  runs next.
- `next` and doctor no longer call a terminal `stages.prepare_build` beside
  `status: "blocked"` a contradiction when another stage (QA, doctor) is the
  one blocked; the `report.status=blocked` contradiction now fires only when
  no recorded stage is blocked, which after this change can only be a report
  written before the summary was derived or hand-edited since.
- `commitAssemblyReport` refuses with a `TypeError` a mutator that returns
  anything other than a report object, `null` or `undefined`, instead of
  writing whatever came back.
- A report written before this change heals on its next commit (the first
  stage record or operator edit rewrites the summary once); after that an
  unchanged re-record still leaves the file's bytes alone.
- `docs/build-packet.md` documents the derived summary under the
  orchestration loop.

## [1.29.0+agent.6] - 2026-09-16

### Fixed

- Doctor's `template_contract.placeholder_text_residue` check scans the
  visible text of each built page (tags, attribute values, `<script>` and
  `<style>` bodies and comments stripped; `alt` text kept), the same surface
  the browser residue gate reads. A checkout page whose only "Placeholder" is
  an `<input placeholder="…">` hint no longer warns `built output still
  contains literal template placeholder text (Placeholder)` while QA's gate
  passes the same page; rendered "Lorem ipsum" still warns, and the
  `file:line` in the warning now points at the rendered text.

### Changed

- `qa run` records the placeholder-text gate outcome on the Assembly Report's
  `stages.qa.evidence` (`gates.placeholder_text_residue` with
  `status`/`pages_checked`/`pages_failed`, beside the
  `source_build_fingerprint` the verdict judged). A gate that did not run is
  absent, never `pass`.
- While `stages.assembly.build_fingerprint` still equals that recorded
  fingerprint and the gate passed, doctor reports any remaining static hit as
  the ready line `… but the browser residue gate passed on this build; QA's
  rendered-text verdict stands` instead of the warning, and `next` no longer
  prints the `Replace literal template placeholder text …` action. A rebuild
  or a failed gate brings the warning and the action back.

## [1.29.0+agent.5] - 2026-09-16

### Added

- `--order-path-depth <off|common|full>` sets `qa.proof_policy.order_path_depth`,
  which until now had no setter: `prepare-build`/`start`/`build` seed the
  packet with it (default still `common`), and `qa policy set
  --order-path-depth <depth>` changes it later. One accepted-values set,
  matched case-insensitively and stored lower-case (`Off` writes `off`); a
  bare flag or any other value is refused before anything is written
  (`qa policy set: unsupported --order-path-depth "tiers". Accepted values:
  off, common, full.`). `qa policy set` also refreshes the assembly report's
  `proof_policy.order_path_depth` mirror through the same ledger write every
  other report edit uses (the doctor sidecar is stamped stale), reports it in
  `changed[]` as `report.proof_policy.order_path_depth` and in a new
  `report_mirror` object, and re-states the packet's value into a lagging
  mirror even when the packet already holds it. The `policy` snapshot gains
  `qa.order_path_depth`. With `off` on both sides a `qa run --test-order off`
  pass reaches `next: done`.

### Changed

- Doctor warns `qa.proof_policy.order_path_depth_drift` (advisory, never a
  blocker) when the packet's declared depth and the report's mirror disagree —
  the state a hand-edited packet leaves behind, which `next` reads as unknown
  coverage and could not clear. The warning, the coverage `reason` and the
  `next` `purchase_proof_unknown` action carry one text naming the one
  command that reconciles them (`qa policy set --packet <packet>
  --order-path-depth <packet value>`; the placeholder `<off|common|full>` when
  the packet holds a value the setter refuses), and that `next` action is now
  `kind: command` with the runnable command instead of a manual step reading
  "Reconcile the packet and the report before treating either depth as
  proved." `docs/qa-and-test-orders.md` and `docs/build-packet.md` describe
  the setter and the drift warning.

## [1.29.0+agent.4] - 2026-09-16

### Changed

- `run-record` with no `--run-id` and no active run session re-emits the most
  recent Run Record for this packet's campaign under that record's `run_id`
  instead of minting a new one (#328). `run end` clears the session, so every
  run-record after close minted — the closeout action `next` prints at stage
  `done`, the command a session-ending `qa run` prints, and any re-emit after
  fixing a sidecar each filed a second Run Record for a run that already had
  one. Resolution is now `--run-id` > the active session > the newest record
  on disk whose `identity.map_id` and `identity.campaign_slug` match the packet
  (the same match closeout recognition uses) > a fresh id; a record whose remit
  landed stays final and is left as written, exactly as an explicit `--run-id`
  over it already did. The `--json` summary carries `run_id_source`
  (`explicit` | `session` | `latest_record` | `minted`) and the text output
  prints `Run ID: <id> (<source>)`; a `latest_record` run first prints `Run ID
  <id> is the most recent Run Record for this campaign; re-emitting it in
  place. Pass --new-run to start a new run under a fresh id, or --list to see
  every record for this packet.` The source rides the command's envelope only;
  the Run Record schema is unchanged.
- New `run-record --new-run` mints a fresh `run_id` regardless of what is on
  disk (refused beside `--run-id`: `--new-run and --run-id are exclusive`).
  `next` puts it on the required `run_record_closeout` command when the record
  it judged `stale_predates_evidence` or `outdated_artifacts` is the newest
  one for the campaign, since the plain command would now re-emit that record
  in place; the description names the superseded id. With no matching record
  (`no_record`, `foreign_campaign`) the plain command is printed and mints on
  its own.
- New `run-record --list` prints, newest first, every Run Record on disk for
  this packet's campaign — `run_id`, `created_at`, `remit_state`,
  `remit_result`, `remit_endpoint`, `record_path` — then the id a plain run
  would use and its source, and assembles, writes and sends nothing, like
  `--no-write` (`list: true`, `written: false`, `remit.sent: false` in
  `--json`; the text output ends `List only (--list). No record written, no
  remit.`).

## [1.29.0+agent.3] - 2026-09-16

### Changed

- `prepare-build` records `assembly.commerce_catalog.path: null` when the
  catalog in use is the toolkit's own `contracts/commerce-surface-catalog.json`
  (the default), instead of a packet-relative path that climbs into whichever
  checkout ran the command (`../../../campaigns-os/contracts/…`). The catalog
  ships with the toolkit, so a null path resolves to the running toolkit's
  copy on every machine and under `npx campaigns-os` (#324). An explicit
  `--commerce-catalog <path>` is still recorded relative to the packet.
- Doctor and `qa run` read a null `assembly.commerce_catalog.path` as the
  running toolkit's catalog. A recorded path that does not exist but whose
  file name is `commerce-surface-catalog.json` (a packet prepared before this
  change, moved to another machine) also resolves to the running toolkit's
  catalog: doctor no longer blocks with
  `[assembly.commerce_catalog.path] Commerce catalog is required but not found.`
  and instead prints the ready line `Commerce catalog resolved to the running
  toolkit's copy; the packet's recorded path <path> does not exist here (it
  names the checkout that ran prepare-build). Re-run prepare-build to clear
  the machine-local path.` A dead path with any other file name still blocks.
- `docs/build-packet.md` gains a Commerce Catalog section describing the three
  path states (null, operator path, stale machine-local path) and
  `examples/build-packet.basic.json` carries `path: null`.

## [1.29.0+agent.2] - 2026-09-16

### Changed

- Spec-hash identity is compared one way everywhere (#328): `src/spec-identity.mjs`
  now owns `normalizeSpecHash` (trim, lower-case, strip one leading `sha256:`,
  empty to `null`), `specHashesMatch` (both sides present and equal after
  normalisation; two missing hashes never match) and `specHashOf` (the
  `spec_hash` / `spec_identity.spec_hash` lookup). The Commercial Journey
  `deriveState` freshness check, the sidecar-bundle `spec_hash` and
  `spec_material_hash` identity checks, and the Commercial Journey and QA
  parity report `spec_hash` fields all go through it. A calculation whose
  `spec_hash` differs from the Map's only by prefix, hex case or surrounding
  whitespace is now `Exact` instead of `Stale`, and a sidecar bundle whose
  producers spell the same hash differently no longer reports
  `bundle.identity.spec_hash_mismatch` / `spec_material_hash_mismatch`. Other
  identity fields (`map_id`, slugs, paths) keep their exact compare. The
  module stays internal this release; a package export lands with the next
  supported-surface bump.

## [1.29.0+agent.1] - 2026-09-16

### Changed

- The `page_kit.sdk_version` checkpoint has a direction of authority (#413):
  the repo pin (`_data/campaigns.json[<route>].sdk_version`) is the version
  the funnel serves and the CampaignSpec's `global_config.sdk_version` is a
  build hint. A configured campaign whose repo pin is newer than the spec's
  (both canonical released versions, the starter demo store profile gone
  from the entry — the same decision `page-kit sync` uses to refuse moving
  the pin backwards) no longer blocks doctor, `next` or QA. Doctor passes the
  gate with a `page_kit.sdk_version.repo_newer` warning and the ready line
  `Target campaigns.json SDK version <repo> is what ships; the CampaignSpec
  pin <spec> is a stale build hint.`; the gate object carries `status: pass`,
  that code, the fingerprinted expected/observed state, `required_actions:
  []` and a new `advisory_actions: [{ id: "refresh_spec", kind: "edit" }]`
  telling the operator to re-save the Map's Build hints field (Campaign Cart
  SDK version) to the repo pin. `next` at doctor-blocked no longer emits
  `checkpoint.page_kit.sdk_version.*` actions for this state, and QA's
  `page_kit.sdk_version` assertion projects it as `warn` (severity `warn`)
  instead of a blocker `fail`, so a version bump proven on the repo runs
  through QA with one edit, build, prove. Until now this state blocked with
  an edit action and a waiver lane, so every bump on a spec-driven campaign
  was two edits in two tools or a named-human waiver. The waiver lane stays
  for the blocked mismatch (target behind the spec, or the scaffold's seeded
  pin beside the demo store profile — still repaired by `page-kit sync`), a
  non-released target pin still blocks non-waivably, and the spec-side
  blockers (missing, invalid, conflicting declarations) are unchanged.
  `finding-cause` classifies the new code as `upstream_drift` beside the
  blocking form. `page-kit sync`'s `target_newer` detail now says doctor
  reports the state as a warning. `docs/build-packet.md` documents the
  direction and the four outcomes; `docs/qa-and-test-orders.md` lists the
  code under `upstream_drift`. Writing the repo pin back to the Map after a
  bump (the end state that removes the warning) needs a Map Builder write API
  and stays on #413.

## [1.29.0] - 2026-09-15

Additive: one new CLI command, `page-kit`, joins the supported argv surface.

### Added

- `campaigns-os page-kit sync --packet <campaign-runtime.build.json> [--dry-run]
  [--json]` reconciles the target's `_data/campaigns.json` entry from the
  CampaignSpec. A fresh page-kit scaffold (`npx campaign-init …`) seeds the
  route's entry with the starter family's demo store profile (a
  `demo.29next.com` storefront and legal links, the demo phone) and the
  family's SDK pin; because `src/<route>/` then exists the toolkit marks setup
  skipped, and doctor blocks on `page_kit.store_profile` (demo residue, which
  is unwaivable by design) and `page_kit.sdk_version`. Until now the only
  recovery was step 5 of the orchestration skill telling an agent to edit the
  file by hand from prose. Now the spec is applied by a command: it writes the
  nine Store Profile fields the spec carries (`campaign.store_name`,
  `store_url`, `store_terms`, `store_privacy`, `store_contact`,
  `store_returns`, `store_shipping`, `store_phone`, `store_phone_tel`,
  normalized the way the gate compares them; a target that differs only in
  surrounding whitespace or Unicode normalization already passes and is
  reported unchanged) into the entry for the packet's
  `campaign.public_route_slug`, and **seeds** `sdk_version`
  (`global_config.sdk_version`, else the `runtime.sdk_version` alias,
  resolved by the same `resolveSpecSdkPin` rule the gate uses): the pin is
  written while the entry is still in scaffold state (the starter demo store
  profile is still in it) or when the target pin is older than the spec's; a
  configured campaign whose pin is newer than the spec's is never moved
  backwards (on an existing campaign the repo pin moves first and the
  Map/spec is stale until re-saved, so spec → repo would undo the bump) and
  lands in `not_synced[]` with reason `target_newer`, naming both versions
  and pointing at re-saving the Map or the `page_kit.sdk_version` waiver.
  It prints a field-by-field `before -> after`
  diff with each value's spec source, and touches nothing else: a governed
  field the spec does not carry is left as it is (doctor's `target_only`
  warning still applies), non-governed keys keep their values and order,
  other routes are untouched, and no other file is written. The file is
  edited in place, re-serialized with its own top-level indentation, line
  ending (CRLF kept) and trailing newline, staged through a temp file and
  rename with the original permission bits, and written only at the path
  `_data/campaigns.json` resolves to inside the target repo; when the round
  trip would not have reproduced the file byte for byte (a minified file,
  mixed indentation) a `page_kit.sync.file_reformatted` warning says so,
  because the printed diff covers only the governed fields. `--dry-run`
  prints the same diff and writes nothing; `--dry-run <value>` is rejected
  rather than silently becoming a write. Exit 0 on success and on a no-op
  re-run (`Status: UNCHANGED`); exit 2 with a `page_kit.sync.*` error and
  nothing written when the packet cannot be read or is not an object
  (`packet_invalid`), the packet has no route slug (`route_slug_missing`),
  the spec is absent, unreadable or not an object (`spec_missing`,
  `spec_invalid`), the spec identifies another campaign
  (`spec_identity_mismatch`: `spec_identity.public_route_slug`, else
  `campaign.slug`/`id`, disagreeing with the packet's route, or
  `spec_identity.map_id` disagreeing with the packet's `spec.map_id`), the
  target entry is unavailable (`entry_missing` with the loader status
  `target_repo_missing`, `file_missing`, `entry_missing`, `invalid_json`,
  `root_not_object`, `entry_not_object`), or the resolved file lies outside
  the target repo through a symlink (`target_escapes_repo`). The spec is the
  authority, but the target is made authoritative only from a usable spec
  value: a non-released or conflicting pin (`spec_invalid`, `spec_conflict`),
  a field of the wrong type (`spec_invalid_type`), a URL field that is not an
  http(s) URL (`not_http_url`), a `store_phone_tel` that is not a `tel:` URI
  of digits, spaces, dashes, parens and dots (`not_tel_uri`), a value with
  control characters (`control_characters`), the starter demo value itself
  in the spec (`demo_residue`), and starter demo residue in a field the spec
  does not carry (`demo_residue_not_in_spec`) are never written; each lands
  in `not_synced[]` with its reason and a `page_kit.sync.<field>_not_synced`
  warning naming the spec field to fix, and the run's status is `partial`
  (exit 0: the writes that could happen did; doctor will still block).
  `store_contact` may also be a `mailto:` address. A gate under an active
  named-human checkpoint waiver is a human decision sync does not reverse:
  its fields land in `not_synced[]` with reason `waived` naming
  `waived_by`, and the target stays as the waiver accepted it. Sync reads the
  Assembly Report doctor would (the one the Build Context binds, else the
  default sidecar, or `--report <path>`); a report it cannot read is a
  `page_kit.sync.report_unreadable` warning. Unknown flags are rejected
  (`Unknown flag for page-kit sync: --dryrun. … Known flags: --packet,
  --dry-run, --json, --report`) rather than ignored. A write marks the
  retained doctor snapshot stale (a failure to do so is a
  `page_kit.sync.doctor_sidecar_not_marked` warning, never a lost result),
  and when the report records a terminal build a `page_kit.sync.build_stale`
  warning says `_site/` was rendered from the old entry and `next` points at
  the rebuild.
  `--json` emits the result document (`action`, `status` `synced | dry_run |
  unchanged | partial | blocked`, `written`, `changes[]`, `unchanged[]`,
  `not_in_spec[]`, `not_synced[]`, `errors[]`, `warnings[]`, `next`). The
  command is not pipeline-advancing, so it never records a deviation.

### Changed

- Doctor and `next` name `page-kit sync` as the recovery for the two page-kit
  gates. The `repair_target` action of `page_kit.store_profile` and
  `page_kit.sdk_version` was `kind: "edit"` with `command: null` and a
  description telling the operator to update the file; it is now `kind:
  "command"` with `command: "campaigns-os page-kit sync --packet <packet>"`,
  so doctor's `Required actions:` block, `next`'s `next_actions[]` at
  `doctor-blocked` (ids `checkpoint.page_kit.store_profile.repair_target` and
  `checkpoint.page_kit.sdk_version.repair_target`), and the emitted
  `required_actions[].command` all print the pasteable command with the real
  packet path, spelled for the install it came from (`npx campaigns-os
  page-kit sync …` from a campaign folder). For `page_kit.sdk_version` this
  covers the `target_missing`, `target_invalid`, and mismatch states where
  sync would write (the target pin is behind the spec's, or the entry is
  still in scaffold state); a configured campaign whose pin is newer than
  the spec's keeps an edit action (re-save the Map to the repo pin, or
  record the waiver). For
  `page_kit.store_profile` it covers every blocker the target can be made
  authoritative for (`demo_residue`, `target_missing`, `mismatch`,
  `target_invalid_type`, each with a usable spec value: present, an http(s)
  URL for URL fields, a `tel:` URI for `store_phone_tel`, no control
  characters, and not the demo value itself). Any other blocker keeps an edit
  action naming the spec field and the reason (`spec_invalid_type`,
  `not_http_url`, `not_tel_uri`, `control_characters`, `demo_residue`,
  `missing`), since sync cannot repair the spec and would otherwise be
  recommended for a state it cannot end; a target-side defect the spec does
  not carry (a demo or malformed target value with no spec field behind it)
  is described as a target edit, with adding the field to the spec and
  syncing as the alternative. The QA runner's browser-skipped notice renders
  gate actions through the same install-prefix rule doctor and `next` use
  (the `--packet <packet>` placeholder stays: the verdict is a public artifact
  that never carries a local path). The
  `doctor-blocked` checkpoint actions in `next` are now also passed through
  the install-prefix helper, like every other printed command since
  1.28.0+agent.1.
- Skill `next-campaigns-os` 1.0.10 → 1.0.11: step 5 no longer tells the agent
  to correct `_data/campaigns.json` by hand; it names `page-kit sync`
  (`--dry-run` first), what a `PARTIAL` status means, and that demo residue
  is replaced this way.
- `contracts/supported-surface.json` `cli_commands` gains `page-kit`;
  `docs/supported-surface.md` names it and its one subcommand.
  `docs/build-packet.md` documents the command under the Page Kit Store
  Profile checkpoint and points the SDK-version checkpoint at it. The README
  and `docs/quickstart.md` "first verdict is BLOCKED" paragraphs say the demo
  values are the scaffold-seeded profile and pin and name the command that
  replaces them. `docs/orientation-contract-reference.md` and
  `docs/runtime-readiness.md` are regenerated for surface `1.29.0`.

## [1.28.0+agent.1] - 2026-09-15

### Added

- `tooling status` recognises a package install as a supported install mode.
  Until now the command assumed a git checkout: run from a campaign folder
  that pins the toolkit as a devDependency, an `npx` cache, or any other
  `node_modules` it reported `Git freshness unavailable: git rev-parse
  failed` with the raw git error, told the operator to use `npm run
  campaigns-os -- ...`, and described the package as a private checkout. Now
  the result carries an `install` block — `mode` (`checkout`, `npx_cache`,
  `node_modules`, `package_directory`), `mode_label`, `location`, and `pinned`
  (`version`, `commit`, `resolved`, `spec`) — and a `ready` line, `Install
  mode: package install (node_modules), pinned at <version> @ <sha12>` or
  `Install mode: git checkout at <path>`. The pinned commit is derived from
  what npm recorded at install time (`gitHead` in package.json, else the
  resolved git URL for the package in any enclosing install root's
  `node_modules/.package-lock.json` or `package-lock.json`, so a nested
  dependency keeps its pin); when none is recorded the line says `pinned
  commit not derivable` and a warning asks the operator to compare the
  package version by hand. In package mode the `git` block is `status:
  not_applicable` (its `head` is the pinned commit, and no git warning is
  emitted) and `package.registry.status` is `not_applicable_package_install`.
  `cli.invocation` and the new `cli.invocation_prefix` name the form that runs
  this copy where the operator is: `npm run campaigns-os -- <command>` from a
  checkout (unchanged), `npx --yes github:NextCommerceCo/campaigns-os#<sha12>
  <command>` from an npx cache, and `npx campaigns-os <command>` from a
  consumer `node_modules` install — always, since `npx` itself puts
  `node_modules/.bin` (the new `cli.bin_dir`) on PATH for the duration of a
  command, so a match seen there says nothing about the operator's shell.
  `cli.global_binary` gains `resolves_to` and
  `matches_local_bin`; its `status` is `found_other_install` when the
  `campaigns-os` first on PATH is a different install, and the consumer-mode
  warning for that case, or for no binary on PATH, points back to `npx
  campaigns-os <command>` from the folder that pins the toolkit — no PATH
  edit. The skill-refresh action uses the same prefix. A package directory
  that happens to sit inside someone else's git repository (a consumer
  project, a dotfiles-managed home) is a package install, not a checkout: only
  a root that is the top level of its own worktree is reported as a checkout,
  so the enclosing repository's branch is never presented as the toolkit's.
  The checkout branch of the logic is unchanged apart from the additive fields.
- Every command the toolkit produces for an operator or agent to copy is
  spelled, at the point it is produced, for the install it comes from: `npx
  campaigns-os <command>` from a consumer install, `npx --yes <spec>
  <command>` from an npx cache, bare from a checkout. That covers `next` (text
  and `--json`: `next_actions[].command`, gate `required_actions[].command`
  as they are emitted, the prompt and the tiny prompt), doctor's required
  actions and tiny prompt, checkpoint/theme/polish remediation text, the
  prepare-build summary, the run-session and run-record closeout commands, QA
  handoff and closeout commands, the `qa install-browser` notes, and the
  browser-missing errors from `polish capture` and `qa run --browser` (`Run
  \`npx campaigns-os qa install-browser\`, then …` from a consumer install;
  `Run \`npm run qa:install-browser\` from the checkout (or
  \`campaigns-os qa install-browser\`), then …` from a checkout). Result
  payloads are never rewritten after the fact: a path, a quoted argument or
  a data value that contains the words `campaigns-os build` is left exactly as
  it is, and gate registries keep the canonical bare spelling for internal
  bookkeeping (deviation tracking reads the command word through any of the
  prefixes).
- The build context records the intake as it was passed, in a new additive
  `intake` block: `spec_source` (`local` | `remote` | `cache`), `spec_path`
  (for a local spec), `map_id`, `proxy_base`, `source_root`, `target_repo`,
  `template_family`, `brief_path`, `design_manifest_path`,
  `allow_uncertified_template`, `wrapper_policy` and `packet_path` — paths
  target-relative like the rest of the context. `next` replays it in the
  `rerun_prepare_build` action: a local spec is replayed as `--spec` (printed
  even when the file is gone, with a note to restore it), a fetched map as
  `--map-id` plus `--proxy-base` when the store was not the default, and the
  optional flags come back verbatim; every path is emitted absolute and
  shell-quoted so the line runs from any working directory. A packet from
  before `intake` existed falls back to the packet's own fields — the map id
  is replayed, `--proxy-base` is inferred from `spec.spec_url`, and the action
  description says the optional flags could not be replayed. The Build
  Packet schema is unchanged (its `spec` block is closed; the context's root
  is open).
- `tooling status` diagnostics: a PATH executable that is an npm cmd-shim
  (`%~dp0`) or a pnpm/yarn shell wrapper is resolved to the script it execs
  before it is compared with this install's own binary, and only
  `<cache>/_npx/<hash>/node_modules/…` counts as the npx cache — a project
  that merely has `_npx` in its path is a `node_modules` install.
- `campaigns-os qa install-browser`: the one-time Playwright Chromium install,
  runnable from any install mode. It drives the Playwright CLI bundled with
  this package (`install chromium`), so the browser matches the Playwright the
  QA and polish producers load; plain output is `Status:`, `Command:` and the
  note (`Exit code:` on failure), and `--json` keeps stdout as the result
  document (`status: installed` or `install_failed` with `exit_code`) with the
  child's download progress routed to stderr. `npm run qa:install-browser`
  still exists as the checkout script and does the same thing. The commands
  `next` prints at the QA stage, the polish handoff prompt, the QA handoff
  prompt, and the `polish.hidden_eager_media.install_browser` gate action now
  name `qa install-browser`. Because the gate action now starts with
  `campaigns-os qa`, `qa` counts as an expected command during a polish stage
  whose browser is missing.
- The CLI accepts a leading `campaigns-os` token as its own program name.
  `npx --yes <git-spec> campaigns-os <command>` and `npx --yes -p <git-spec>
  campaigns-os <command>` both pass the literal `campaigns-os` through to the
  binary, which used to fail with `Unknown command: campaigns-os`; it is now
  dropped before dispatch for every command.
- The `next` recovery prompt for a blocked prepare-build stage names the flags
  a rerun needs: "with the same `--spec`/`--map-id`, `--source`, `--target` and
  `--template-family` as the original run", and its `rerun_prepare_build`
  action is now that complete line, built from the packet's recorded inputs:
  `--map-id <spec.map_id>` (or `--spec <spec.local_path>` when there is no map
  id), `--source <source_html.root>`, `--target <assembly.target_repo>`,
  `--template-family <assembly.template_family>`, plus `--proxy-base <origin>`
  when `spec.spec_url` is not on the default map store. It used to print
  `campaigns-os start --map-id <id>` alone, which `start` refuses. An input
  the packet does not record is printed as an explicit placeholder
  (`<source-dir>`, `<target-dir>`, `<family>`), never dropped. Doctor's coverage error for a
  Figma-designed page with no source mapping now says "supply the source-html
  manifest for the page (see docs/design-source-package.md) — the exporter
  that produced the design emits it" instead of naming a private
  `npm run handoff` script.
- `AGENTS.md` states that the runtime recipe covers checkout preparation and
  that the toolkit pinned as a devDependency of the campaign folder (run
  through `npx campaigns-os …`) is the supported way to run it without a
  checkout, under the same pin discipline; a recipe kind for package installs
  is not published yet. README Quick Start and `docs/quickstart.md` make that
  the primary path — page-kit bootstrap (`npm init -y && npm i
  next-campaign-page-kit && npx campaign-init --non-interactive …`), then `npm
  i -D "github:NextCommerceCo/campaigns-os#<sha>"`, then `npx campaigns-os
  tooling status` / `install-skills` / `start` / `next` — in the order orient
  (read the contracts at one commit) → `install-skills` → `start`, with
  `--map-id <id>` beside `--spec`, and the clone path under "Contributor /
  local checkout". `CONTEXT.md` and `docs/entry-points.md` replace two named
  people and one named merchant in worked examples with anonymous operators.

## [1.28.0] - 2026-09-14

Breaking: two required Build Packet fields are removed. See the migration in
release-ledger entry `surface_version: 1.28.0`.

### Removed

- The Build Packet fields `qa.test_orders_allowed` and
  `qa.sandbox_test_card_confirmed`, and the `qa policy set` flags
  `--test-orders-allowed` / `--sandbox-test-card-confirmed` that set them. The
  permission gate on test orders was retired long ago (typed-card test orders
  use global test cards, create no transactions, and run from `--test-order
  <mode>` alone), but the schema kept both fields `required`, doctor kept
  demanding they be booleans, `prepare-build`/`start` kept writing `false`, and
  `qa policy set` kept setting values nothing read — so a packet pinned by a
  Run Record said `test_orders_allowed: false` beside a notes string calling
  the flag informational. Now: the packet schema neither requires nor lists
  them; `prepare-build`/`start` and the synthesized built-site packet write a
  `qa` block without them (the `test_order_policy_notes` sentence "These flags
  are informational, not a permission gate." becomes "There is no permission
  flag: depth is the only control."); doctor no longer emits
  `qa.test_orders_allowed must be boolean.` / `qa.sandbox_test_card_confirmed
  must be boolean.` and instead warns once, `qa.removed_policy_fields`, when a
  packet still carries either field, naming it and asking for it to be
  deleted (a 1.27.0 packet is otherwise accepted unchanged); `qa policy set`
  refuses the two flags with `--test-orders-allowed was removed in supported
  surface 1.28.0 …` and writes nothing, and its `--json` `policy` echo no
  longer has a `qa` block. `--allowed-domains-confirmed`, `--deploy-target`,
  `--preview-url` and `--production-url` are unchanged.

### Added

- `local-serve` as a `deploy.target` value in the Build Packet schema and in
  doctor's known-target set, for the localhost QA path the docs already
  describe. Before, the enum had no value for a locally served build, so an
  operator either lied with `unknown` or hit `deploy.target: Unknown deploy
  target "localhost"` (exit 2, `doctor-blocked`). Under `local-serve` doctor
  skips the `campaign.allowed_domains_confirmed` warning, prints `Deploy target
  is local-serve: serve the built _site/ locally and record the localhost URL
  on deploy.preview_url; …` until a URL is recorded, prints `Deploy target is
  local-serve and the deploy URL <url> is localhost: …` once it is, accepts a
  loopback host (`127.0.0.1`, `[::1]`) with a ready line that names the
  `http://localhost:<port>/` fallback should the SDK refuse the numeric host,
  and warns `deploy.local_serve_url` when the recorded URL is neither.
  `next` at the deploy stage emits the action `Serve the built _site/ output
  locally as the origin root (deploy.target is local-serve), then record the
  localhost URL on deploy.preview_url …` and a serve-locally handoff prompt
  instead of the ship-to-host one; both name `_site/` as the directory to
  serve, and for a root-served campaign (`campaign.route_root: "/"`) add that
  pages are served at site-root paths while assets keep the `/<slug>/` prefix,
  so `_site/` needs the rewrite of root-level page routes onto
  `/<slug>/<route>` that the production host applies — a plain directory serve
  of `_site/<slug>/` would 404 every asset. The QA stage is unchanged. `qa
  policy set --deploy-target local-serve` records it.
- Doctor reports a missing, null, or non-object `qa` block as the error `qa
  must be an object.` — the schema requires it, and the removed boolean checks
  were the only thing that used to trip on that shape.
- Run Record fields `remit_result` and `remit_base_kind` (both optional,
  nullable): the classification of what the receiver answered (`stored`,
  `already_stored`, `ok_unparsed_ack`, `refused`, `transport_error`) and the
  remit base as a kind (`canonical`, `loopback`, `proxy`), which until now
  travelled only in the `run-record --json` summary. `run-record` writes them
  on every record it stamps (null when no send was attempted), carries them
  forward with a prior outcome under `--no-remit` or consent off, and the copy
  POSTed to the receiver states `remit_result: "stored"` and its base kind
  beside `remit_state: "ok"`. The validator rejects any other value.

## [1.27.0+agent.34] - 2026-09-14

### Changed

- `qa run --apply-coupon` clicks the Campaign Cart SDK's own apply control,
  `[data-next-coupon="apply"]`, when the checkout renders one. The explicit
  locator used to name three attribute spellings the SDK never activates on
  (`[data-next-coupon-apply]`, `[data-next-action="apply-coupon"]`,
  `[data-next-checkout-action="apply-coupon"]`) and not the one it does; a
  page carrying one of those still reaches the same fallbacks as before (a
  visible "Apply" control in the form, else Enter in the input). The SDK
  control is clicked only when it is visible and the click lands; a hidden
  or unclickable one falls through to those same fallbacks instead of the
  step recording `clicked explicit apply control` for a click that never
  applied the code. The coupon
  input list likewise reads the SDK's `input[data-next-coupon="input"]`
  instead of the undeclared `[data-next-coupon-input]`; the
  `browser-promo-code-surface` assertion and the "no coupon/promo input found
  (looked for …)" refusal list the new spelling.
- `browser-primary-cta` no longer treats `[data-next-checkout-action]` as a
  candidate CTA or `data-next-href` as a route: neither is an attribute the
  SDK declares. A control spelled that way is a candidate only through its own
  clickable shape (`<a href>`, `<button>`, `role="button"`), and routes only
  by `href`, `data-href` or a wrapping form's `action`; an attribute that
  does not parse as a URL is no route on either branch, so every
  `candidates[].href` in the evidence is a resolved URL or `null`. The route
  rule is now the pure `cartEntryHrefFor` in `src/qa-cart-entry.mjs`, run
  inside the page as a serialised script and unit-tested without a browser
  (a test evaluates the exact serialised text in a fresh context, so a
  module-scope reference leaking into it fails CI instead of the page).
- `browser-primary-cta` evidence carries `ignored_attributes`: the
  route-shaped spellings seen and not consulted (`data-next-href`,
  `data-next-checkout-action`, and `data-next-url` on an element that is not
  an SDK cart-entry control), per listed candidate and as a page-level union
  over every visible CTA-shaped element — including one the candidate rows
  drop for having neither text nor route, and any past the eight-row cap, so
  the union may name a spelling no listed row shows. Every verdict on a page
  spelled that way, passing or failing, appends `(page carries route-shaped
  attributes the runner does not consult: data-next-href)` to its `actual`,
  so a verdict that flipped after this narrowing is distinguishable from a
  CTA that was removed and a passing page still shows the spelling to
  re-spell.
- `docs/qa-and-test-orders.md` names the coupon selector vocabulary the
  runner actually reads.

### Removed

- The `repeated_icon` half of the `demo_assets` family contract: the parser
  field, the in-page icon collector and the `repeatedIconSrcs` counter. No
  shipped family contract declares the key, so the branch could never fire;
  `demo_assets.assets` is the whole vocabulary and a contract that declares
  only `repeated_icon` now yields no demo-asset check. The
  `template-residue:<page>:demo-asset` assertion's evidence carries
  `named_hits` and `page_url` only (the always-empty `repeated_icons` key is
  gone) and its `actual` text is unchanged for named hits.

## [1.27.0+agent.33] - 2026-09-14

### Added

- `start`, `prepare-build`, and `build` accept `--design-manifest <path>`: the
  source-html manifest (`source-html-manifest/v0`) is read from that file
  instead of `<source>/.campaigns-os/source-html-manifest.json`, so a source
  root nobody can write to still gets its screenshot proof and its skip
  declarations from a file the operator owns. `pages[].path` and
  `files[].path` stay relative to `--source`. The Design Source Package records
  the file it read at `contributions[html-funnel].provenance.manifest_path`
  (relative to the package), and doctor validates that same file on every
  later run — the `Source-html manifest source-html-manifest/v0 validated`
  ready line and the Figma provenance gate now follow the recorded manifest.
  A bare `--design-manifest`, a path that is not a file, or a manifest that
  fails validation is an error before anything is written (`Design manifest
  does not exist or is not a file: <path>`, `--design-manifest needs a value`,
  `Source-html manifest at <path> failed source-html-manifest/v0 validation:
  ...`), not the warning-plus-filesystem-fallback the default path gets. The
  flag was previously accepted and ignored. The `DESIGN_SOURCE_PACKAGE_NOT_READY`
  remedy text now names the flag.

### Changed

- A page declared out of source scope (a source-html manifest `skip_reason`
  entry, or CampaignSpec `build_scope.mode: "partial"`) is template stock, on
  every family. Its assembly-report decision `dec_page_scope_<page>` carries
  `template_stock: true` and `template_family` (the family the packet locks),
  and its text reads `recorded CampaignSpec page "<id>" as template stock,
  declared out of source scope (...); the build stage materialises the page
  from the locked <family> family's stock page, and intake demands no design
  source for it`. On a family without published Template Reference proof
  (every certified family but `apollo`) the Design Source Package used to
  block with `Page surface "<id>" lacks non-low primary_design, proven
  template_baseline, an accepted Source Gap, or an approved waiver.` and
  `Source TODO "link-<id>-template-reference" is blocked.` — a TODO no
  operator channel could clear. It now records an accepted `coverage_absence`
  Source Gap for the page (`template-stock-<surface>`, scope
  `primary_design_coverage`, `attributed_by: "prepare-build"`, reason
  `Page surface "<id>" is template stock from the <family> family: it has no
  design source of its own, and the build stage materialises it from that
  family's stock page.`), emits no `link-*`/`capture-*` TODO for it, and
  reaches `readiness.status: "ready_with_gaps"` with
  `stages.prepare_build.status: "completed_partial"` and no
  `DESIGN_SOURCE_PACKAGE_NOT_READY` blocker. `apollo`'s `template_baseline`
  path is unchanged. The `next build` prompt gains a `Template-stock pages`
  line naming each such page and the family to materialise it from, a
  pre-checkout `select` step first (it seeds the cart the runtime pages read).
- Doctor treats a materialised template-stock page as built. Before the build
  it stays out of scope (`derived.scope.out_of_scope_pages[]` entries now carry
  `template_stock: true` and `template_family`), the skip warning reads
  `CampaignSpec page "<id>" is template stock and not built yet: <reason> The
  build stage materialises it from the <family> family's own page; it joins
  the previewable routes once its built HTML exists.` instead of `... is out of
  scope for this partial build: <reason>`, and `scope.runtime_qa_blocked`
  still fires for a runtime page. Once the page's built HTML exists at its
  route under `_site/<slug>/`, it moves into `derived.scope.built_pages` (with
  `template_stock: true`, `template_family`, `source_path: null`) and
  `previewable_routes`, `scope.partial_build` / `scope.runtime_qa_blocked` no
  longer name it (a funnel whose only declared pages are materialised reads
  `derived.scope.mode: "full"`), and the ready list adds `Template-stock
  page(s) materialised by the build stage: <id> (<family>)`. A CampaignSpec
  `build_scope.mode: "partial"` declaration is discharged the same way once
  every page it took out of scope is built — its `reasons` no longer keep
  `scope.runtime_qa_blocked` alive on their own. A declared page the build
  leaves unbuilt, and a skip entry recorded before this change (no
  `template_stock` marker on its decision), are unchanged: not listed on the
  build prompt, not counted as built. `polish capture` still plans from the
  packet's mapped pages, so a materialised stock page stays outside the polish
  capture plan (`route_scope: "selected"`) and its hidden-eager-media
  checkpoint; browser QA covers its route from the CampaignSpec topology.
- The `next-campaigns-build` skill (1.0.2) materialises template-stock pages
  from the locked family's own page of that role instead of reading every
  out-of-scope page as "do not build"; pages without the marker keep the
  partial-build rule.
- The Design Source Package builds on the family the packet locks
  (`--template-family` first, then the CampaignSpec `preferred_template_family`
  hint), not the hint first. The `template-baseline` contribution's
  `presentation_intent` and the `link-<page>-template-reference` TODO name that
  family: a packet locked to `olympus-mv-two-step` over a `demeter` hint used
  to say `Link demeter family/version to a Template Reference artifact ...`
  and now says `Link olympus-mv-two-step family/version ...`. Consequences:
  changing the hint under a stable `--template-family` no longer reads as
  `current_template_material_stale` drift, and a package emitted before this
  change under a hint that differs from the flag is reported stale on the next
  run — remove it per "Recovery after a blocked first run" and rerun.
- Help text documents `--design-manifest` and the template-stock route;
  docs/design-source-package.md "Template-stock pages: the family decides"
  describes the declared route for every family and retires the "no operator
  channel" / attest-the-stock-page reading; README, docs/build-packet.md, and
  docs/entry-points.md name the flag.

## [1.27.0+agent.32] - 2026-09-14

### Fixed

- Standalone `doctor` records its stage outcome into the Assembly Report the
  Build Context binds. On a `prepare-build --report-out` campaign, the context's
  `report_path` points at the bound report and `doctor`'s inspection reads it
  (`derived.assembly_report_path`), but the stage write-back resolved the
  default `<target repo>/.campaign-runtime/assembly-report.json` instead and,
  finding it was not the report it had read, wrote only the sidecar — so the
  bound report's `stages.doctor` stayed whatever `start` / `prepare-build`
  last wrote, and `next`'s ledger reads, the Run Record's `assembly_report`
  attestation and the re-record rule all judged a doctor stage no later run
  refreshed. The write-back now targets the report the inspection read: the
  one `--report` names, else the bound one, else the default; the default
  report is left untouched when a binding exists. A bound report whose
  `identity` is not this packet's (another campaign's map id or route slug)
  is still refused, and the sidecar is refreshed either way, so a doctor run
  never restates its outcome into another run's evidence. `--no-write`
  unchanged.

## [1.27.0+agent.31] - 2026-09-14

### Added

- `telemetry on --proxy-base <url>` records machine-level consent scoped to
  that receiver instead of the canonical NEXT endpoint, the non-interactive
  way to consent to a loopback or staging receiver. `telemetry on` wrote
  `telemetry.scope` as the canonical endpoint unconditionally, so a file grant
  could never cover a non-canonical `--proxy-base`: `run-record --proxy-base
  http://127.0.0.1:4399` with the file on printed `Consent: off (default)` /
  `Remit: skipped (consent off).`, and the only working route was
  `CAMPAIGNS_OS_TELEMETRY=on`, which skips scope checking. The base must be
  https or a loopback host (the remit rail's rule); anything else is refused
  before the file is written. The output names the scope (`Scope:
  http://127.0.0.1:4399`) and, for a non-canonical grant, says the canonical
  endpoint is OFF until `campaigns-os telemetry on` is run again; `--json`
  carries `scope` and `scope_canonical`. `telemetry off` takes no
  `--proxy-base` — an OFF choice applies to every endpoint — and refuses it
  with `telemetry off: --proxy-base is not accepted; turning telemetry off
  applies to every endpoint. To grant one endpoint instead, run: campaigns-os
  telemetry on --proxy-base <url>`; the OFF record it writes carries
  `scope: null` (text: `Scope: every endpoint (an OFF choice is not
  scoped)`), so `telemetry status` prints no `Scope:` row for an OFF file.
  On every `telemetry` subcommand a `--proxy-base` flag written without a
  URL (`--proxy-base --json`, or an empty value) exits 1 with `telemetry
  <sub>: --proxy-base needs a URL (https, or a loopback host); nothing was
  written.` instead of being read as no flag and granting or checking the
  canonical endpoint.
- `telemetry status` prints the stored scope (`Scope: <url>`) and the endpoint
  it was checked against (`Checked endpoint: <url>` — the canonical endpoint,
  or `--proxy-base <url>` when given), and on a mismatch says `Scope mismatch
  — the stored grant is for <stored>, so remit to <checked> is OFF. Consent to
  it with: campaigns-os telemetry on [--proxy-base <checked>]`; `--json`
  carries `scope`, `checked_endpoint`, `scope_mismatch`. `--proxy-base` is
  gated by the same transport rule as `telemetry on` (https or a loopback
  host); a base a remit would refuse is refused here too, with the same
  message, instead of being reported as an unresolvable endpoint. Under
  `CAMPAIGNS_OS_TELEMETRY=on` the state line names the endpoint the override
  bypasses scope checking for: `Telemetry: on (source: env) —
  CAMPAIGNS_OS_TELEMETRY bypasses scope checking for <url>`.

### Changed

- The scope-mismatch warning names the command that grants the requested
  endpoint: `... treating telemetry as OFF for this endpoint. To consent to it
  on this machine, run: campaigns-os telemetry on --proxy-base <url>` (was
  `... until this endpoint is confirmed.`, which named nothing). `run-record`'s
  `Consent:` line carries the same: `Consent: off (default) — file consent is
  scoped to <stored>, not <requested>; consent to this endpoint with: ...`.
- `CAMPAIGNS_OS_TELEMETRY=on` keeps working for every endpoint, and a remit to
  a non-canonical `--proxy-base` under it now warns
  `CAMPAIGNS_OS_TELEMETRY=on bypasses consent scope checking: remitting to
  <url> because the env override is set, not because this endpoint was
  consented to. To consent to it on this machine instead, run: campaigns-os
  telemetry on --proxy-base <url>`; the canonical endpoint and `off` stay
  silent.
- `help` lists `--proxy-base <url>` on `run end` (it was already forwarded to
  `run-record`, so a session close could be remitted to a named receiver, but
  the help line omitted it) and on `telemetry status|on`; `telemetry off` is
  listed on its own line without it.
- `writeConsentConfig(state, { proxyBase })` throws `Telemetry consent scope
  is not a URL: <base>` for a named base that does not normalize, for both
  states, instead of storing `scope: null` (on ON, a grant that matches no
  endpoint; on OFF, a silently dropped typo). An OFF record is always written
  with `scope: null`, whatever base the caller passed.
- The grant command printed on a scope mismatch single-quotes an endpoint
  that carries shell-special characters (`--proxy-base 'http://[::1]:4399'`
  for the IPv6 loopback, whose brackets glob in zsh) so the pasted line hands
  the shell one argument; `http://127.0.0.1:4399` and https URLs are
  unchanged.

## [1.27.0+agent.30] - 2026-09-14

### Changed

- Packet-less `qa run --map-id <id>` fetches the CampaignSpec through the one reader `start`/`prepare-build --map-id` already use (`src/spec-fetch.mjs`): a 200 body of `{ ok: false, error }` is refused as `Spec fetch returned ok=false: <error> (<url>)` and a non-JSON body as `Spec fetch returned invalid JSON: …`, instead of being handed to the QA runner as the spec and failing later inside spec normalisation with an unrelated message.
- One "is this the same file" rule (`src/fs-identity.mjs`) behind run-session binding, the Build Context → Assembly Report binding, `doctor`'s write-back target check and the Run Record artifact refs. A path that does not exist yet is canonicalised through its nearest existing ancestor, so a packet or sidecar reached through a symlinked checkout and the same path reached directly are one path whether or not it is on disk. `doctor --strip-paths` (and `start`'s generated doctor output) rebase every path onto the output base by that rule, so a target reached through a symlink keeps `./…` relative paths even when a recorded sidecar path was written by its real path.
- A Build Context, QA verdict, Assembly Report or packet that is on disk but cannot be read (a permission failure, a directory where the file should be) is no longer treated as absent: `resolveCampaignWorkspace`, QA verdict discovery and the QA runner's sidecar reads rethrow such errors with their code (`EISDIR`, `EACCES`, …) and treat only a missing path (`ENOENT`/`ENOTDIR`) or malformed JSON as "nothing there". Before, an unreadable context silently bound the default Assembly Report, so a `--report-out` campaign's QA outcome could be recorded into a report `next` never reads.
- An invalid polish producer deadline configuration is refused by the shared deadline racer as `Campaigns OS polish capture received an invalid deadline configuration.` (was `… received an invalid producer deadline configuration.`); a finite non-integer `timeoutMs` is accepted like every other deadline (every caller passes a bounded safe integer).

### Removed

- The QA runner's private spec fetch, the CLI's `canonicalExistingPath`, run-session's `canonicalPath`, campaign-workspace's `samePath`, the polish producer wrapper's own argument validation, a duplicated comment in the doctor next-step picker, and the copies of `optionalString` / `isPlainObject` / the slug normaliser in `stage-ledger` and `qa-verdict-discovery` (they import `src/repo-scan.mjs` and `src/route-identity.mjs`). Five identifiers no module imports lose their `export` keyword: `deadlineTimeoutError`, `canonicalize`, `largestResourceProjection`, `PRODUCER_FAILURE_PROBLEM_CODES`, `PRODUCER_STAGE_HISTORY_LIMIT`.

## [1.27.0+agent.29] - 2026-09-14

### Fixed

- `qa resolve` and `qa run` print a blocked gate's remediation the way
  `doctor` prints the same gate: when the checkpoint gates were evaluated on
  a report other than the target repo's default
  `.campaign-runtime/assembly-report.json` (`--report`, or a Build Context
  `report_path` binding), every packet-scoped `checkpoint waive` /
  `theme waive` line under `Required actions:` now ends with
  `--report <that path>`, so the pasted command acts on the report QA read
  instead of on a default sidecar that may not exist. The payload carries
  the same path as `report_path` (present only when it is not that default,
  like doctor's `derived.assembly_report_path`); a default-report campaign's
  text and JSON are unchanged. The rule that picks the report to name is one
  function, `explicitReportPath` in `src/campaign-workspace.mjs`.
- `theme waive`, `checkpoint waive`, `polish capture` and `qa waive` fail by
  name on a torn or hand-edited Assembly Report: `Assembly Report at <path>
  is not valid JSON: <parser message>` in place of a bare `SyntaxError:
  Unexpected end of JSON input` that named no file. The torn bytes are left
  on disk, no waiver or merge is written, and the doctor sidecar is neither
  stamped stale nor refreshed. A read failure (permissions, a directory at
  the path) still propagates as itself; only the parse is renamed.
- `singleLineDetail` (`./text-safety`) never fabricates a lone ellipsis: a
  `max` of one, zero or below now returns the first character (`"a"` for
  `"abc"`) where it returned `"…"`, so the cut is bare at a width the
  ellipsis cannot fit. Documented alongside the two behaviours the 1.27.0
  move added without a note: a non-finite `max` (NaN) means the default
  `ADVISORY_DETAIL_MAX` (300) rather than the whole string, and `max` floors
  at one. The result never exceeds `max` characters for any `max >= 1`. The
  module's header comment is one sentence again.

## [1.27.0+agent.28] - 2026-09-14

### Changed

- `qa run --browser` names the upsell price-visibility row per page:
  `pricing.upsell_price_visible:<page_id>` (was the bare
  `pricing.upsell_price_visible`, emitted once per upsell page so a funnel
  with two upsells carried two rows under one id). The id now carries the
  page the way `template-residue:<page>:*` and `meta:<page>:*` already do;
  `family`, `page`, `status`, `severity` and `evidence` are unchanged, and
  the checkout row keeps its id (`pricing.checkout_price_visible`). A
  consumer keying on the old literal id must match the prefix.
- `pricing.checkout_price_visible` also accepts a visible cart-summary total
  (`[data-next-display="cart.total"]`,
  `[data-next-cart-summary] .order-totals__value--total` — the selectors the
  order-total parity check reads at submit) as a price surface. A checkout
  whose cart is seeded upstream, or one entered directly before any
  selection, renders no bundle price row and was failing with `actual: "0
  visible price row(s)"` while the same run's parity row proved a total was
  displayed. `expected` now reads `at least one visible checkout bundle price
  row or a visible cart-summary total`, `actual` reads `<n> visible price
  row(s); <m> visible cart-summary total(s)`, and `evidence` gains
  `total_selectors[]` and `total_visible_count`; the row still fails (warn
  severity) only when neither surface is visible. A contract that declares
  no `checkout_bundle.price_row_selectors` at all still gets the row (it was
  skipped outright): only the bundle count is skipped, the cart-summary
  total is still read. The total fields appear in `evidence` only when that
  surface was read, so an absent key means the check did not run, never an
  empty result.

### Fixed

- Palette residue found under a recorded, unexpired theme waiver (or a gate
  that does not apply) reports `status: warn`, not `status: fail` with
  `severity: warn`. `template-residue:<page>:style:*`,
  `template-residue:<page>:logo` and
  `template-residue:<page>:payment-chrome:*` were the only warn-severity rows
  in the verdict that read `fail`, so a waived build showed the unwaived
  shape next to the `warn` a missing selector already reports, and the
  waiver notice's "downgrades those rows to warn" did not describe the
  output. The disposition is unchanged: a waived exception still lands on
  `ready_with_exceptions`, never plain `ready`, and placeholder-text residue
  stays a blocker the waiver does not soften.

## [1.27.0+agent.27] - 2026-09-14

### Fixed

- `npm run check` writes nothing into the checkout. The fixtures in
  `scripts/check-fixtures.mjs` that ran `doctor`, `next build` and `qa resolve`
  against `examples/build-packet.basic.json` in place, or pointed a packet's
  `assembly.target_repo` at `examples/target-page-kit`, and the one test in
  `src/doctor-required-actions.test.mjs` that ran `doctor` on that packet, now
  stage a copy of the example layout (packet, spec, source, target, catalog)
  under a temp dir, so
  `examples/target-page-kit/.campaign-runtime/doctor-output.json` (gitignored,
  rewritten on every run, and readable as prior state by a later doctor run
  there) is no longer left behind. `scripts/check-fixtures.test.mjs` runs the
  fixture check and fails when any file under `examples/` is added, removed or
  changed, or when that sidecar exists.
- `check-pack.mjs --skip-prepare` refuses to pack when the working tree has no
  `campaign-spec/dist` (`campaign-spec/dist/index.js missing from the working
  tree; --skip-prepare packs the build the pipeline already made`) instead of
  letting npm rebuild it on the way, and asserts the packed `dist/index.js` and
  `dist/index.d.ts` are byte-identical to the working tree's. npm before 11
  runs the prepare script during `npm pack` regardless of `--ignore-scripts`;
  that second `build:spec` is now reported (`pack check note: npm <version>
  re-ran the prepare script during npm pack despite --ignore-scripts …`) rather
  than hidden. On npm 11+ `npm run check` compiles once.
- `check-template-doctrine.mjs` validates the starter-template partials at the
  catalog's `_synced_from_sha`, the commit CI checks out, instead of whatever
  commit the sibling checkout happens to be on. A sibling on another commit, or
  at the pin with local edits or untracked files under its `src/`, is read at
  the pin through `git archive` (its working tree is untouched; the
  pass output gains `templates: read at _synced_from_sha=<sha> from the
  sibling checkout (its HEAD <sha> differs; working tree untouched)`). A
  sibling that does not have the pinned commit is still scanned, with
  `check-template-doctrine: WARNING: validating the sibling checkout … NOT the
  catalog pin … A green result here is not evidence for the CI gate.` on
  stderr naming the fetch command. `STARTER_TEMPLATES_PATH` is used as given.

### Changed

- `npm run check` calls the named `check:*` scripts instead of inlining their
  commands, so a named script and the pipeline step it stands for cannot
  drift. `check:tests` (the `node --test` suite), `check:slot-manifest` and
  `check:supported-surface` are new names for steps that had none; the step
  order is unchanged and `build:spec` is the one explicit build.
- `docs/small-pr-review-path.md` documents the three PR-only `--base` gates
  (`check-skill-versions`, `check-supported-surface`, `check-release-ledger`)
  and how to run them locally against `origin/main`.

## [1.27.0+agent.26] - 2026-09-14

### Fixed

- `CHANGELOG.md` carried two stray diff3 base-marker lines (`## [1.27.0+agent.25] - 2026-09-14

## [1.27.0+agent.25] - 2026-09-14

### Changed

- `standardize` judges a Page Kit root's SDK versions by the SDK support
  policy, the same contract a Campaign Cart application root is judged by.
  A `page_kit` root read its `_data/campaigns.json` `sdk_version` values
  against a scanner constant (`0.4.20`, reported as
  `version.sdk_below_preferred_cutoff` "below the preferred 0.4.20+ sample
  cutoff"), so `--sdk-support-policy` was accepted, validated, and then had
  no effect on such a root: a policy with `minimum_supported: 0.4.35`
  produced output byte-identical to the default. Every discovered version now
  goes through one evaluation: below `minimum_supported` is the blocker
  `version.sdk_below_minimum_supported`, below `preferred_minimum` the
  warning `version.sdk_below_preferred_policy`, each naming the policy source
  (`... (policy: contracts/campaign-cart-sdk-support-policy.v0.json)`), and
  the root carries a `version_policy` block (`source`, `minimum_supported`,
  `preferred_minimum`, `evaluations[]` with `source: "campaigns_json"`),
  printed in markdown as `- Version policy: min 0.4.20, preferred 0.4.30
  (contracts/campaign-cart-sdk-support-policy.v0.json)`. Under the bundled
  policy this changes default output: an SDK below `0.4.20` is now a blocker
  (`status: blocked`, exit 2) where it was a warning, and an SDK in
  `0.4.20`–`0.4.29` gains the preferred-minimum warning it did not have.
  `version.sdk_below_preferred_cutoff` is gone; the Page Kit dependency
  cutoff (`version.page_kit_below_preferred_cutoff`, `0.1.1`) is unchanged
  and documented as the scanner constant it is. A `--sdk-support-policy`
  override also feeds the certification-freshness assessment, which read the
  bundled policy regardless.
- `--field-contract` reaches Page Kit roots too. A Page Kit root whose
  source inlines checkout bindings (the attributes the contract's
  `binding_attributes` names; bundled `data-next-checkout-field` /
  `os-checkout-field`) now gets the same `checkout_fields` block and the same
  `checkout.unsupported_field_binding` / `checkout.unknown_field_binding`
  findings as an application root, judged by the bundled field contract or
  the override; a root with no such bindings is unchanged and has no
  `checkout_fields` key.
- The built-output scope no longer depends on the shape of `_site/` alone.
  With no `--slug`, a `_site/` holding the campaign's directory beside a
  stale one reported `Built _site: unresolved`, `Doctor: skipped (Multiple
  campaign slugs under .../_site; pass --slug to choose one.)` and the
  `built_output.scope_unresolved` finding — while `identity.campaign_slug`
  already named the campaign from `_data/campaigns.json`. The slug is now
  resolved in order from `--slug`, the single slug `campaigns.json`
  declares, the `campaign.public_route_slug` the `.campaign-runtime` packets
  name (only when every packet that names one agrees), and only then the
  `_site/` layout; that run now reports
  `Built _site: yes`, `- Built slug: demo (campaigns_json)`, `Doctor:
  ready` and no scope finding. The choice is recorded as
  `built_output.slug` / `built_output.slug_source` (`operator_flag`,
  `campaigns_json`, the packet's relative path, or `site_layout`) and as
  `identity.campaign_slug` / `identity.campaign_slug_source`; a new
  `- Built slug:` line precedes `- Built pages:` in markdown.
  `built_output.scope_unresolved` remains for the case that genuinely needs
  `--slug` — several built directories and no slug source — and its
  `next_action` now says so.
- A derived slug with no built directory is a named mismatch, not a silent
  scope. When `campaigns.json` (or a packet) names `demo` and `_site/` holds
  only `stale-old/`, the scope resolver used to fall through to the one
  directory it found and the doctor certified `stale-old` as `ready`, with
  the proof command `doctor --built ... --slug stale-old`. The report now
  says `Built _site: unresolved`, `- Built slug: demo not found (built
  directories: stale-old)`, `Doctor: skipped (built _site has no demo/
  directory for campaign slug demo (from campaigns_json); built directories:
  stale-old)`, and the operator-readiness finding
  `built_output.slug_mismatch` with evidence `{ expected_slug, slug_source,
  slug_candidates }`, so the root is `ready_with_warnings` rather than
  `ready`. Root-level html beside the campaign directory no longer collapses
  the scope to the site root either: with a known slug the campaign
  directory is inspected. When `_site/<slug>/` exists but holds no HTML
  pages, the finding says `Built _site/demo/ exists but holds no HTML pages
  ...` with evidence `slug_directory_present: true` (markdown `- Built slug:
  demo has no HTML pages (...)`), not that the directory is missing. An
  explicit `--slug` naming a missing directory keeps the existing
  `built_output.scope_unresolved` shape. A site-root layout renders its
  source like every other case: `- Built slug: site root (site_layout)`.
- The doctor proof command under `remediation.proof_commands` carries
  `--slug` whenever scope needed one: `--slug demo` when a slug was
  resolved (derived slugs included), and a `--slug <slug>` placeholder when
  the scope is unresolved among several built directories — the command the
  report handed back for that case used to omit the flag and exit 2 with the
  same ambiguity when run.
- `capabilities[]` lists the inspections that ran. A Page Kit root listed
  `built_output_doctor` unconditionally — on roots with no `_site`, under
  `--no-doctor`, and while the built slug was unresolved. It now appears only
  once a doctor result is attached, and `checkout_field_contract` only when
  bindings were inspected; `page_kit_source_contract`, `sdk_version_policy`
  and `campaign_cart_runtime_inventory` are listed as before. Application
  roots are unchanged.
- `standardize` refuses unknown flags. The parser stores any `--token` as a
  key, so `--bogus` ran the report as if nothing had been typed and
  `--no-doctor=maybe` (stored as the key `no-doctor=maybe`) ran the doctor
  anyway, exit 0, stderr empty. Both now exit 1 with nothing on stdout and
  one line on stderr: `campaigns-os: Unknown flag for standardize: --bogus.
  Known flags: --target, --family, --template-family, --slug,
  --sdk-support-policy, --field-contract, --no-doctor, --json, --run-id,
  --lifecycle-journal.`; the `--flag=value` spelling adds `A flag takes its
  value as the next argument (--flag value), not --flag=value.` Other commands
  parse as they did.
- `docs/campaign-standardization-report.md` now states the exit codes (0
  produced and `ok`, 1 did not run, 2 produced and `blocked`), the flag list,
  the slug-resolution order and when `--slug` is required, that both
  contracts apply to both root kinds (the policy applies-to statement sits
  beside the override paragraph rather than in the backlog), the bundled
  cutoffs (`0.4.20` / `0.4.30` from the policy contract, `0.1.1` Page Kit
  dependency from the scanner) and the read-only guarantee, which a test now
  holds: a run that includes the built-output doctor leaves every file in
  the target identical in size, mtime and content. `docs/entry-points.md`
  names `standardize` as the entry point for an existing campaign
  repository.

## [1.27.0+agent.24] - 2026-09-14

### Fixed

- `--test-order tiers` (and `tiers:common` / `tiers:full`) no longer counts an
  order bump as a selector tier. The tier planner turned every checkout
  `packages[]` row with a ref into a tier and read no bump marker, so a
  three-tier checkout that also declares a bump row marked `is_upsell: true`
  planned four tiers: `tiers:common` on a two-upsell funnel expanded to 16
  orders (20 for `tiers:full`, 4 for bare `tiers`), the flood guard named
  `--max-test-orders 16` as the raise, and the four `*@tier:<bump-ref>` plans
  would have failed strict selection by name (no rendered card carries the
  bump ref). The planner now reads the same `is_upsell` predicate the
  commercial-journey planner already uses for bump rows (`isBumpRow`, one
  predicate, exported from `commercial-journey`), so the same checkout plans
  12 / 15 / 3 orders and the guard names `--max-test-orders 12`. A run whose
  checkout declares bump rows prints one `[qa:test-order]` line naming the
  bump ref(s) it left out; bump coverage stays with `--cart`.

### Changed

- `--select-package <ref[:qty],...>` now narrows a tiers run to the listed
  declared tiers instead of being refused. Identities match the tier's own
  strict-selection value (`1` or `1:1` is ref 1 at quantity one, `1:2` the
  two-unit multiplier); coupon plans are not tiers and are still planned.
  Every listed identity must be a declared tier: any that is not is refused
  by name, listing the declared tiers and any bump refs the spec excludes
  from them (`--select-package 7: is not a selector tier the CampaignSpec
  declares (declared tiers: 1, 1:2, 1:3; order bump ref(s) excluded from
  tiers: 2)`), so a partly declared list never runs the matched tiers and
  skips the rest. Naming a bump ref itself gets the reason (`2 is an order
  bump (is_upsell), an add-on to a selected tier, not a tier; bump coverage
  comes from --cart`) rather than reading as an unknown ref. Naming only a
  tier that a secondary funnel's URL-less checkout declares is refused by
  cause (`names a tier declared only on checkout page "checkout-b", which
  has no resolvable URL — nothing this run can drive`), not with the generic
  "found nothing to iterate". Each `ref[:qty]` segment is trimmed, a blank
  qty slot is quantity one, and a third `:` segment is malformed rather than
  silently dropped. `--apply-coupon` with a tiers mode is still refused, with
  the message now naming only that flag.
- A refused `--max-test-orders` cap lists the planned paths. The message cut
  the preview at eight ids and hid the rest behind `...`, so the plans that
  most needed a look (the tail) were the ones an operator could not see;
  `Planned paths:` now lists up to 40 ids and, past that, counts the rest
  (`and 4 more (first 40 of 44 listed; narrow with --select-package
  <ref[:qty]> to list one tier's paths)`), so nothing is cut without saying
  how much and how to see it.
- The doctor packet's `qa.test_order_policy_notes`, the `next`-stage QA
  hand-off text and `qa run --help` describe the tiers modes: what a tier is,
  that bump rows are not tiers, and that `--select-package` narrows a tiers
  run. `docs/qa-and-test-orders.md` says the same in its tiers section.

## [1.27.0+agent.23] - 2026-09-14

### Changed

- One attribution rule for both waive commands. `theme waive` now requires
  `--waived-by "<named human>"` and refuses the placeholders `checkpoint
  waive` already refused (`operator`, `ci`, `agent`, `claude code`, ...); the
  default attribution `operator` is gone. `--expires-at <ISO>` is accepted by
  `theme waive`, validated the same way (canonical timestamp, later than
  `waived_at`), recorded on `report.theme.waiver.expires_at`, and honoured by
  the theme gate: at or after that instant the gate stops reporting `waived`
  and asks for a fresh decision. The gate's `waive_theme` action command and
  the docs/skills that quote it carry `--waived-by "<named human>"`. The
  validator is one function, `validateWaiverAttribution` in
  `src/checkpoint-waiver.mjs`; `createCheckpointWaiver` calls it and its
  messages are unchanged.
- Both waive commands print a real status. Text output of a successful
  `theme waive` / `checkpoint waive` was `Status: UNKNOWN` in every state; it
  is now doctor's verdict on the report the waiver was just written to
  (`Status: READY_WITH_WAIVERS`, or `BLOCKED` when other gates still hold),
  followed by `Waived: <gate> by <who>[ until <expires_at>]` and `Next stage:
  <stage> (<reason>)`. The `--json` success shape gains `status`, `next_stage`
  and `next_stage_reason`; `theme waive --json` also gains `gate:
  "theme_gate"`.
- `--json` refusals return an envelope. A refused `theme waive --json` or
  `checkpoint waive --json` (placeholder human, missing bound, past expiry,
  unknown or unwaivable gate, gate not blocked) used to exit 1 with an empty
  stdout and a line on stderr. It now writes `{ ok: false, error, gate,
  registered_gates[] }` to stdout, keeps the stderr line, and exits 1.
  Without `--json` nothing changes.
- The unknown-gate refusal names the registry: `Unknown checkpoint gate "x";
  registered gates: page_kit.sdk_version, page_kit.store_profile,
  built_output.upsell_selector_scope, polish.hidden_eager_media.`
  `docs/build-packet.md` lists the same four gates (it listed three).
- Starter demo residue is not waivable. When any `page_kit.store_profile`
  discrepancy is `demo_residue` (a `demo.29next.com` URL or the demo phone
  number still in `_data/campaigns.json`), doctor reports the gate with
  `waivable: false`, appends `Starter demo residue in <fields> is not
  waivable; replace the demo value(s).` to its reason, and offers no
  `waive_checkpoint` action; `checkpoint waive --gate page_kit.store_profile`
  refuses with the residue fields and the target entry to repair. Spec
  mismatches and missing target values stay waivable as before.
- `next` text files each blocked gate's actions under its own heading.
  Checkpoint repair/waive commands were listed under "Theme gate is BLOCKING
  this stage" whenever the theme gate happened to be blocked too, and were
  not printed at all otherwise. Now every blocked gate that produced actions
  gets `Checkpoint gate <id> is BLOCKING this stage. Resolve it with:` (or
  the theme / polish / prepare-build heading) over its own actions, the
  rechecks follow under `Then:`, and the block prints whether or not the
  theme gate is blocked. A stage with no blocked gate prints nothing, as
  before.
- `next --json` carries no `--packet <packet>` placeholder. The checkpoint
  and polish gate objects copied from doctor into `gates[]`, and into
  `errors[]`/`warnings[]` `detail.checkpoint_gate`, now have the packet
  substituted into their `required_actions[].command`, the way
  `next_actions[]` already did. `doctor --json` and the doctor sidecar keep
  the template.

## [1.27.0+agent.22] - 2026-09-14

### Fixed

- Doctor's `spec.store_profile.payment_methods_default_on` warning now reads
  the built checkout. The check compared the CampaignSpec's
  `available_payment_methods` / `available_express_payment_methods` against
  the four methods a starter-template checkout renders by default (paypal,
  klarna, apple_pay, google_pay) and warned whenever one was absent — before
  a build, after a build that shipped none of them, and after every rebuild,
  clearing only when the spec added the method. Once the spec's checkout
  page exists under `_site/<public_route_slug>/`, doctor now scans that
  rendered page for each unsupported method's markup — the SDK-owned
  `data-next-payment-method="<method>"` attribute the payment-methods
  include renders, the template family's `payment_chrome` class selectors
  and its method-named chrome assets, the same markers browser QA's
  template-residue gate keys on — and stays silent when none shipped,
  adding the ready note `Built checkout carries no paypal, klarna
  payment-method markup (_site/<slug>/checkout/index.html); left to browser
  QA: shared chrome asset upsell-payment-logos.svg`. The clause after the
  semicolon names what a static scan cannot attribute — the family's shared
  chrome assets that name no method, and any compound selectors — so the
  note is never read as "nothing left for browser QA to check"; it is
  omitted when the contract leaves no such gap. When the markup did ship,
  the warning keeps its code but states the built evidence:
  `Built checkout still renders paypal, which the CampaignSpec does not list
  …: _site/<slug>/checkout/index.html: paypal
  (data-next-payment-method="paypal", .payment-method__icon--paypal-logo,
  paypal-logo.svg)`, with `detail.basis: "built_output"`, one
  `detail.pages[]` entry per page and method carrying the markers found,
  and `detail.static_scan_gaps { compound_selectors[], shared_assets[] }`.
  Severity is unchanged (a warning; the QA residue gate is the blocker).
- The pre-build repair text is now correct for the starter-template
  families. Every family's checkout page calls
  `{% campaign_include 'payment-methods.html' %}` with no arguments and the
  include defaults `show_<method>` to true, so there were never `show_*`
  arguments to remove. The warning now says to pass
  `show_paypal=false show_klarna=false` (the absent methods) on that include
  call in the named family's checkout page, quotes the resulting include
  call, and carries `detail.basis: "spec_only"`, `detail.methods[]`,
  `detail.template_family` and a `detail.repair` object
  (`owner`, `action`, `include_call`). The old message was
  `… remove the show_* arg(s) from the checkout payment-methods include …`.
- The per-method partition of a family's `default_residue.payment_chrome`
  (selectors and assets, shared chrome counting for every method) now lives
  once in `src/template-brand-contract.mjs` as `paymentChromeArtifacts`;
  browser QA's `methodPaymentArtifacts` delegates to it, the new static
  matcher `paymentMethodMarkupMatches(html, method, chrome)` is what doctor
  reads the built checkout with, and `paymentMethodStaticScanGaps(chrome,
  method)` names the compound selectors and shared assets that matcher
  leaves to browser QA. Browser QA's residue assertions are unchanged.

## [1.27.0+agent.21] - 2026-09-14

### Fixed

- `qa run` now compares against the previous run when that run's QA verdict
  lives outside the packet directory. Whenever `assembly.target_repo` is not
  the packet's own directory, `qa run` writes the full verdict under
  `<target repo>/qa-output/<identifier>/` and the Run Record, relativizing
  against the packet directory, references it only as `external:qa_verdict`
  plus the file's digest. The cause classifier treated that reference as no
  reference: every finding on the second run was `unknown` with
  `cause_reason: prior_run_without_qa_verdict`, and the report said
  `Previous run <id> exists but references no QA verdict`, which was false.
  The classifier now resolves an external reference by its recorded digest
  under the target repo's `qa-output/`, so the second run reports
  `Comparison basis` as `prior_run` and labels carried-over findings
  `pre_existing` — the same result a packet at the target root already got.
- The committed `<packet dir>/.campaign-runtime/qa-verdict.json` sidecar is
  deliberately not a stand-in when that full verdict is gone: it is a
  projection, so its digest cannot match, and the Run Record stores no
  verdict run id to tie it to the referenced attempt, so any looser rule
  could compare against a projection of a different attempt and report a
  reintroduced finding as pre-existing.
- New `cause_reason` / `comparison` value `prior_run_verdict_unlocated`: the
  previous Run Record references a verdict as `external:qa_verdict` and no
  verdict matching that reference could be located under the target repo's
  `qa-output/` (nothing there hashes to the recorded digest, the reference
  carries no digest, or no target repo was known to search). Its report line
  says so, and is worded to be true in all three cases. `prior_run_without_qa_verdict` now means exactly what it
  says — the record carries no `qa_verdict` artifact reference at all — and
  `prior_run_verdict_unreadable` keeps its meaning for a by-path reference
  whose file is missing or unparseable. `docs/qa-and-test-orders.md` lists
  the four reasons.
- `annotateQaAssertionCauses` / `loadPriorQaVerdict` accept `targetRepo`;
  `qa run` passes the packet's resolved target repo. Doctor cause labels,
  which read the record's own observations, are unchanged.

## [1.27.0+agent.20] - 2026-09-14

### Changed

- `run start --packet <p>` opens the session in the packet's target repo
  (`assembly.target_repo` resolved from the packet's directory, else that
  directory) from any cwd, the root the auto-opener behind `start` /
  `prepare-build` already uses. It used to open the session at cwd and only
  remember the packet, so a session started from the toolkit or an unrelated
  project was found from that directory alone: `run status` at the target
  said `No active run session.`, and `run end --packet <p>` from the starting
  directory was refused with `Conflicting active run session: cwd selects
  <run_id>, but packet <p> has no matching active target session`. Now
  `run status` at the target reports it and `run end --packet <p>` closes it
  from anywhere; `Lifecycle journal:` and `session_path` name the target.
- The managed `.gitignore` block `run start --packet` writes goes to that
  target repo, not to cwd. An unrelated starting directory no longer gains a
  `.gitignore` (or a `.campaign-runtime/`) it did not have.
- The stale-session sweep for `run start` / `run end` runs at the same root:
  the `--packet`'s target repo when given, cwd otherwise. A stale session in
  the target is closed out by `run end --packet <p>` from any cwd and
  reported as `Stale run session <run_id> closed out …`, where before the
  command failed with `No active run session to end.`
- Bare `run start` / `run end` (no `--packet`) are unchanged: cwd. A
  `--packet` that is not written yet roots on its own directory and still
  prints the `does not exist yet` warning.
- A `--packet` that exists but cannot be parsed is refused by `run start` /
  `run end` with `--packet <p> could not be read as a build packet (<parse
  error>); the run session roots on its assembly.target_repo. Fix or re-point
  the packet, then retry.` (exit 1, nothing opened anywhere); a path that is
  not a readable file (a directory, no permission) is refused the same way
  as `could not be read (<OS error>)`. It used to open
  the session silently on the packet's directory, where no later command run
  by that packet would find it once it parsed again and named another target.
- The session records the packet in canonical form (symlinks resolved, the
  form the root is derived from), so the Run Record `run end` assembles lands
  beside the real packet rather than in a link's directory.
- `run start --packet <p>` text output advertises a close that works from
  where it was run: `Finish with: campaigns-os run end --packet <p>` (before:
  `Finish with: campaigns-os run end`, which from a cwd other than the target
  fails with `No active run session to end.`), and the auto-log line names
  the session's directory and the `--packet` form instead of `this project`.

## [1.27.0+agent.19] - 2026-09-14

### Fixed

- A remit answered **409** by the receiver is read as `already_stored` — the
  receiver holds this `run_id`, which is what the send was for — and the Run
  Record stays `remit_state: "ok"`. It used to be stamped `failed` with
  `Remit POST failed: 409 Conflict {"error":"run_record_conflict"}`, and the
  `run_record_remit_recovery` action `next` then printed re-sent the same
  record into the same 409 on every run. A 2xx whose body is not JSON is
  `ok` with `remit_error` `Remit POST <status>: acknowledged with a body that
  is not JSON: <excerpt>` (it used to be `failed` with a bare `Unexpected
  token` parse error). Any other non-2xx is `failed` with `Remit POST
  <status>: <statusText> <body>`. `run-record --json` gains a `remit` object
  beside the record — `result` (`stored`, `already_stored`,
  `ok_unparsed_ack`, `refused`, `transport_error` for this run's send,
  `not_contacted` for a record already `ok` on disk, or null when nothing was
  sent), `http_status`, `base_kind` (`canonical`, `loopback`, `proxy` — never
  the host), `sent`, `preserved` — and the text `Remit:` line ends with
  `[base: <kind>]` and names the 409 / non-JSON cases.
- A re-run of `run-record` under a `run_id` whose record is already remitted
  — an explicit `--run-id`, `run end` on a session re-opened under that id,
  or the recovery action — no longer rewrites that record. It used to replace
  `run-records/<run_id>.json` with this invocation's outcome unconditionally,
  so a re-run into a 409 turned a durable `ok` into `failed`, and a `--no-remit`
  re-run turned it into `skipped`. Now the record on disk is read first: an
  `ok` record is left exactly as written and nothing is sent (`written:
  false`, `remit.result: "not_contacted"`, `remit.sent: false`; text: `Run
  Record already closed and remitted for run <id>; left as written.` and
  `Remit: ok (already stored at the receiver for this run id; not re-sent)`).
  Only a file that passes the Run Record validator counts as that prior; one
  that merely says `remit_state: "ok"` is replaced like a corrupt file.
  A prior `failed` or `pending` send is retried when the run may send, and
  carried forward unchanged when it may not (`--no-remit`, consent off):
  `remit.preserved: true`, text `Remit: not attempted this run; the prior
  outcome for this run id is kept (failed: …)`. A `--no-write` run is
  unchanged: it reads nothing, writes nothing, sends nothing.
- The body the receiver stores now carries the outcome of the send it is
  receiving: `remit_state: "ok"`, `remit_attempted: true`, `remit_ok: true`,
  `remit_endpoint: "/api/runs"`. It used to be the pre-flight snapshot —
  `remit_state: "pending"`, `remit_attempted: false`, `remit_endpoint: null` —
  so every stored record said its own remit had not happened. The local file
  still carries `pending` only between its first write and the answer.
- `telemetry list` exits non-zero on a 2xx whose body carries no `runs[]`
  (`telemetry list: 200 OK from <url> is not a Run Record listing (no runs[]
  in the body): {"raw":"<html>…`). It used to print `showing 0 of 0 returned`
  / `"count": 0` and exit 0 for a maintenance page.
- The `run_record_remit_recovery` action's text says that a send the receiver
  already holds resolves to ok and that a remitted record is left as written.
- Docs: `docs/workflow-findings-sidecar.md` (Remit Channel: Durable status,
  re-runs, the stored copy, `telemetry list`; Closeout recognition: the
  recovery command's premise).

## [1.27.0+agent.18] - 2026-09-14

### Fixed

- A Run Record auto-ended after a session-ending `qa run` no longer lists
  `qa run`'s flags as its own. The three ways a run session closes — `run
  end`, the auto-end after a `ready` or `ready_with_exceptions` verdict, and
  the stale-session sweep — each built run-record's argv for themselves, and
  the auto-end did so by spreading the QA command's argv, so its record's
  `argv_shape` carried `--base-url` and `--no-post-verdict` under `command:
  "run-record"`. The session now closes by one path that hands run-record
  only the flags it reads (`--context`, `--report`, `--qa-verdict`,
  `--journal`, the surface and agent-usage flags, `--no-remit`, `--no-write`,
  `--proxy-base`, `--json`) beside the session's own `--packet`, `--run-id`
  and `--lifecycle-journal`; an auto-ended record's `argv_shape` is now
  `["--json", "--lifecycle-journal", "--packet", "--qa-verdict", "--run-id"]`
  for a `--json` run. `run end` and the sweep produce what they did. On the
  opening side, `run start` and the auto-start behind `start`/`prepare-build`
  write the session through one opener, and "is this session bound to this
  packet" has one answer where `--packet` selection (which refuses) and the
  auto-start (which stands off) each had a spelling; messages are unchanged.
  `run start`, `run status` and `run end` return their result and the
  dispatcher prints it — text and JSON output are byte-identical.

## [1.27.0+agent.17] - 2026-09-14

### Fixed

- One commit step for every edit to the Assembly Report. Six commands edit
  the report and then keep the retained doctor sidecar honest about it —
  `qa run`'s stage record, `doctor`'s stage write-back, `theme waive`,
  `checkpoint waive`, `qa waive` and `polish capture` — and each spelled the
  step for itself: load, bind, mutate, write, then either refresh the doctor
  sidecar or stamp it stale. That left two write disciplines and two
  freshness rules in six places. `doctor` wrote its sidecar in place while
  `next` and the QA stage replaced theirs atomically, and `qa waive` wrote
  the report itself in place while every other editor replaced it, so a
  reader racing either command could see a torn file — for the sidecar, the
  one artifact whose freshness contract a torn write breaks outright. The
  step now lives once, as `commitAssemblyReport(workspace, mutate,
  {refreshDoctor | staleReason})` in `src/stage-ledger.mjs`, on the campaign
  workspace the resolver returns: the report is read from the path the
  workspace binds, the mutation returns what to write (or nothing, to leave
  the file's bytes and every digest of them alone), the write is tmp +
  rename, and exactly one doctor-freshness strategy is named. A producer
  (`stage: "doctor" | "qa"`) restates its outcome only into this campaign's
  report and skips a write that would move nothing but its timestamps — the
  re-record rule `doctor` gained in 1.26.0+agent.3 now covers the QA stage
  too, where it changes nothing in practice because every run restates a new
  `verdict_run_id`. Both in-place writes are atomic; the QA stage refresh,
  the waivers' stale stamps, the polish evidence merge and every command's
  output are unchanged. `writeJsonAtomic` is exported from
  `src/doctor-sidecar.mjs`, and `assemblyReportMatchesPacket` moves to
  `src/stage-ledger.mjs`.

## [1.27.0+agent.16] - 2026-09-14

### Fixed

- One launcher for the package-owned Playwright Chromium. Polish capture and
  browser QA each imported `playwright` lazily, launched Chromium headless
  unless `--headed`, and recognised a missing browser executable by the same
  regular expression over Playwright's install wording — the import, the
  launch and the detection written twice, so a change to Playwright's wording
  would have to be found in both. The launch now lives once in
  `src/browser-launch.mjs` (`launchPackageChromium`), which imports, launches
  and detects, and asks the caller for the two error messages through
  `onMissing(kind, error)` — each surface keeps naming its own rerun command.
  Polish capture runs the launcher inside its bounded startup deadline as
  before; browser QA calls it directly. No output changes: the polish
  `POLISH_BROWSER_UNAVAILABLE` error and both QA messages are word-for-word
  what they were.

## [1.27.0+agent.15] - 2026-09-14

### Changed

- One derivation per polish capture invariant. The page-load validator
  re-derived twenty-two statements the capture producer makes about itself
  (ledger order, largest resource, metric sums, source-reference order,
  fetched-resource attribution and totals, unresolvable and unattributed
  media, the document, collection, producer and networkidle statuses, the
  problem counts a ledger implies) with its own copies of the producer's
  code, and answered with one bit: `capture_shape_invalid`. The producer's
  derivations are now exported from `src/polish-capture.mjs` and the
  validator is an ordered table of shape rules that recomputes each stated
  value with the same function, so the two cannot drift apart. The table is
  exported as `POLISH_CAPTURE_SHAPE_RULES`, `captureShapeViolation(capture)`
  names the first rule a capture breaks, and a `measurement.incomplete[]`
  entry whose codes include `capture_shape_invalid` now also carries that
  name as `shape_violation`. Every other output is unchanged: captures,
  page-load evidence for captures whose shape holds, checkpoint results and
  the QA verdict's measurement projection (which lists a fixed field set)
  produce what they did.

## [1.27.0+agent.14] - 2026-09-14

### Fixed

- One response record between the polish browser collector and the capture
  aggregator. The CDP collector built its `responses[]` records inline — a
  single response, a redirect chain with hops numbered from zero, and two
  in-band problem sentinels — and the aggregator re-parsed them as if they
  might have come from anywhere: it re-checked that hops were contiguous from
  zero, that every record carried a request identity and that no two records
  shared one, accepted a second, flat spelling of a redirect chain, and read
  cache evidence from six field names when the collector writes three. There
  is one producer, so those checks could only ever fail on hand-built test
  records, and the three problem codes they produced
  (`redirect_chain_invalid`, `request_identity_invalid`,
  `duplicate_request_identity`) were vocabulary no capture could carry. The
  record now lives once in `src/polish-capture.mjs` as exported constructors
  (`singleResponseRecord`, `redirectChainRecord`, `captureProblemRecord`) and
  readers (`responseRecordResponses`, `responseRecordFromCache`,
  `captureProblemRecordCode`, with `POLISH_RESPONSE_CACHE_FLAGS` and
  `POLISH_CAPTURE_SENTINEL_PROBLEM_CODES`); the collector emits through them
  and the aggregator reads through them without re-validation. The three
  unreachable problem codes are gone from `POLISH_CAPTURE_PROBLEM_CODES`, and
  the record is documented in `docs/polish-evidence.md`. No output changes:
  the collector's wire form is byte-identical and a capture built from the
  same collector output is byte-identical. One reading tightens: a record
  spelt `from_cache`, `from_memory_cache` or `served_from_cache` — which the
  collector never writes — is no longer counted as cache-served.

## [1.27.0+agent.13] - 2026-09-14

### Changed

- One hidden eager-media checkpoint evaluation per `polish capture`. The
  capture producer (`capturePolishPageLoad`) evaluated the checkpoint against
  the report it was handed at start and returned it beside the evidence, and
  the command discarded that result: it re-reads the report after the browser
  pass and evaluates the checkpoint on the merged report it persists, which is
  the evaluation that decides the exit status, the `checkpoint` field and any
  waiver. The producer now returns `{ plan, page_load }` only; its tests
  evaluate the recorded checkpoint explicitly through
  `evaluateRecordedHiddenEagerMediaCheckpoint` on the merged report, the same
  path the command uses. No output changes: `polish capture` (text and
  `--json`), the persisted `page_load` evidence and the doctor sidecar are
  byte-identical.

## [1.27.0+agent.12] - 2026-09-14

### Fixed

- One deadline racer. The polish producer deadline, the QA runner's step
  timeout, its diagnostic settle and its analytics-window bound, the remit
  transport's request timeout and the commercial parity loader's request
  budget each raced an operation against `setTimeout` for themselves — six
  wrappers of one mechanism, differing only in the error they reject with
  and in whether a timeout resolves to a fallback. The race now lives once as
  `runWithDeadline` in `src/deadline.mjs` (timer always cleared, timeout
  settled before best-effort cleanup runs, owner abort signal, optional
  unref, caller-shaped timeout error) and the six sites are projections of
  it; `polish-deadline.mjs` keeps its constants and error constructors and
  delegates the race. No output changes for polish capture, the QA step
  ladder, the analytics window or remit: the same codes, messages and
  settle shapes are produced. One guard tightens: the commercial parity
  loader only aborted its request's signal at the budget and waited for the
  fetch to notice, so a fetch that ignored its signal held the run open
  past the budget; the budget now rejects with the same `page_fetch_timeout`
  / `price_preview_timeout` codes whether or not the fetch honours the abort
  (the recorded `error` text names the deadline instead of the abort
  reason).

## [1.27.0+agent.11] - 2026-09-14

### Fixed

- One HTTP(S) origin parser for polish evidence. The capture producer, the
  capture validator (its origin-field rule and its cross-origin warning
  attribution), the `polish capture` text renderer, the browser adapter's
  cookie-origin check and the analytics parity capture's baseline credential
  guard each parsed "the origin of this URL, or null" for themselves — five
  copies of one rule with the scheme test and the length cap drifting between
  them. The rule now lives once as `captureOrigin` in `src/polish-capture.mjs`
  and the five callers are projections of it. No output changes: a capture's
  `document_response` origins, the validator's `failed_origins`, the
  checkpoint and the rendered text are byte-identical for the same input. One
  guard tightens: the parity capture treated two non-HTTP URLs as same-origin
  (both carry the URL standard's opaque origin), so a fixture-supplied
  non-HTTP baseline beside a non-HTTP candidate carried the preview
  credential; only an HTTP(S) origin can now be "the same", and the credential
  is withheld as it is for any other cross-origin baseline.

## [1.27.0+agent.10] - 2026-09-14

### Fixed

- One walk over a campaign's local QA verdicts. `next`'s ledger-divergence
  check, `run-record`'s verdict inference and the run-record closeout each
  walked `qa-output/<map_id|slug>/*.json` for themselves — three read walks
  with their own filter, their own copy of the identity rule (a verdict is
  this campaign's when its `campaign_slug` is the map id or the public route
  slug) and their own spelling of the directory, one of them without the slug
  normalisation the writer applies. The walk now lives once in
  `src/qa-verdict-discovery.mjs`, listing every candidate — the paths the
  Assembly Report's qa stage records and every verdict under each root's
  `qa-output/<identifier>/` — with its source, identity match, trust and
  (on request) digest, and the three readers are projections of it: the
  repo-relative list of this campaign's verdicts, the best trusted candidate
  by identity score and time, and the digests of the recorded paths. No
  output changes: `next --json` (including `divergences[]`), `run-record`'s
  inferred verdict and the closeout assessment produce what they did.

## [1.27.0+agent.9] - 2026-09-14

### Fixed

- `campaigns-os doctor` reads the Campaigns API key through the same
  resolver the remit rails use. Doctor kept a resolver of its own after the
  remit half gained its shape gate in 1.26.0+agent.22, and it called any
  non-empty value present, so a key the remit rail refused on shape (a quoted
  key, a pasted JSON blob) read as available in the doctor report and its
  sidecar. Doctor's view is now a projection of `resolveCampaignsApiKeySource`
  — the same sources in the same order, the same gate, the same wording — and
  a refused value is reported under a new warning code,
  `campaign.api_key_rejected`, naming the refused source (the packet field,
  the CampaignSpec field, or the env var) and never the value, with the source
  and refusal kind on `detail`. A key that is simply not configured is still
  reported under `campaign.api_key_source` with the same explanations as
  before. One ready-line wording follows the resolver: a key sourced from the
  CampaignSpec now reads `available via the packet-local CampaignSpec
  campaign.campaigns_api_key` rather than `via CampaignSpec
  campaign.campaigns_api_key`. Consolidating onto that gate surfaced a bug in
  it: the env-name rule anchored `^[A-Z]` before looking for `CAMPAIGN`, so
  the documented default `env:CAMPAIGNS_API_KEY` (and `CAMPAIGN_KEY`) was
  refused by name on the remit rails since 1.26.0+agent.22. The rule now
  requires the leading letter by lookahead and accepts a name that starts
  with `CAMPAIGN`; a foreign secret (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`)
  is still refused by name. `docs/workflow-findings-sidecar.md` carries the
  corrected rule and doctor's two codes.

## [1.27.0+agent.8] - 2026-09-14

### Fixed

- The template family's brand contract is resolved once per doctor run. It
  was resolved four times — by the commerce-catalog check, by the pricing
  CSS scan, by the built-output doctor, and by `next`'s palette advisories,
  which projected the same resolution into a state and error code — so one
  `next` loaded the contract three times, and a standard packet whose
  contract exists but cannot be read carried the same
  `template_contract.brand_contract` finding twice in one doctor run: an
  error from the catalog check and a warning from the pricing scan. Doctor
  now resolves it once, records the outcome on `derived.brand_contract`
  (`state` — `no_family`, `no_contract`, `no_palette_checks`, `inspected` or
  `defect` — with `family`, and for a defect the loader's `code` and a
  one-line `detail`), and reports a defect once, from whichever check comes
  first, at that check's severity. `next` reads doctor's record instead of
  resolving again. On a packet with a readable contract nothing else
  changes: doctor's text report and `next`'s output are byte-identical, and
  `doctor --json` differs only by the new field.

## [1.27.0+agent.7] - 2026-09-14

### Fixed

- One projection of a gate into an issue. `doctor` turned its theme, polish
  and polish-checkpoint gates into findings in three inline blocks, and
  `next` turned the same three gates into `next.<stage>.<code>` errors in
  three more functions — six spellings of the same rule — while "doctor's
  only errors are the polish gates" was decided by the `polish.` prefix of
  the error codes in three places, so an error merely spelled like a polish
  code would have counted and a polish-gate error under another code would
  not. The projection now lives in one function (`gateIssue`), used by both
  commands, and the polish decision reads the gate each issue carries on its
  `detail`. No output changes: `doctor --json` and its text report, and
  `next --json` and its text report (stage-less, `polish`, `qa`), were diffed
  against the previous release on a fixture with both polish gates blocked
  and are identical apart from the timestamp.

## [1.27.0+agent.6] - 2026-09-14

### Fixed

- `campaigns-os next` and the doctor sidecar it writes can no longer disagree
  about the prepare-build gate. `next` evaluated the gate itself, called
  doctor (which evaluated it again and picked the next stage), then picked
  the next stage a second time with its own gate. The two evaluations
  differed on one input: `next` told doctor there was no Build Context when
  the file was merely missing, and doctor only checked the context/report
  binding when a context was present — so with `build-context.json` absent,
  `next` blocked on `next.prepare_build.context_missing` while the
  `doctor-output.json` it had just written named a ladder stage. Doctor now
  stores the gate on `derived.prepare_build_gate` beside the other gates
  (`null` when the packet is not gated) and checks the binding whether or not
  a context was found — an absent context is a binding failure for a packet
  that declares a Design Source Package, exactly as `next` treats it — and
  `next` passes the operator's `--context` / `--report` through, lets doctor
  derive the defaults, and consumes doctor's gate and stage pick: one
  evaluation, one pick. `doctor.next` also gains `stage_blocked`, the
  picker's own verdict on the picked stage, which `next` reports as its
  `stage_blocked`. Two consequences for `doctor --json` on a packet that
  declares a Design Source Package: with no Build Context readable, its
  `next` block now says `prepare-build` with the `context_missing` binding
  issue instead of a ladder stage, and `derived.prepare_build_gate` is new.
  `next --json` output is unchanged.

## [1.27.0+agent.5] - 2026-09-14

### Fixed

- One action vocabulary and one rendering rule for a checkpoint gate's
  `required_actions[]`. A gate publishes each action as `{ id, kind, command,
  description }`, and four renderers turned that into text for themselves —
  the human `doctor` report, `next`'s action list (twice) and the `qa resolve`
  printer — four spellings of the `--packet <packet>` substitution, one of
  them without the guard that keeps a `$&` or `$1` inside the packet path
  literal. The polish checkpoint's five recorded actions were declared in the
  polish producer and one of them copied byte for byte into the polish gate,
  which the producer imports and so could not import from. They now live once
  in `src/gate-actions.mjs`, with `substitutePacket` and
  `requiredActionText` (the runnable command with the packet substituted, else
  the manual description, carrying `--report` into packet-scoped commands as
  the doctor report has since 1.26.0+agent.23); the producer, the gate,
  doctor, `next` and the QA runner all read them from there. The doctor text
  report is now one walker returning its lines (`resultTextLines`, with
  `doctorTinyPromptLines` for the prompt beneath it), and the `qa resolve`
  checkpoint and theme-gate blocks likewise (`checkpointGateLines`,
  `themeGateLines`), so every line an operator reads is assertable without a
  subprocess; the printers print exactly those lines. Text output is
  unchanged byte for byte — `doctor`, `qa resolve` and `next` were diffed
  against the previous release on a blocked-gate fixture — with one exception:
  the `checkpoint` usage error's "Registered gates:" list is now derived from
  the checkpoint registry instead of a hand-maintained string, so it reads in
  registry order (`page_kit.sdk_version, page_kit.store_profile,
  built_output.upsell_selector_scope, polish.hidden_eager_media`).

## [1.27.0+agent.4] - 2026-09-14

### Fixed

- Every stage now derives a packet's sidecar paths from one place,
  `src/campaign-workspace.mjs`: the target repo (`packet.assembly.target_repo`
  resolved against the packet's directory, else that directory), the default
  `.campaign-runtime/` locations of the Build Context, Assembly Report and
  doctor output, the `qa-output/` directory, and whether to follow the Build
  Context's `report_path` binding. Eleven sites across the CLI and the QA
  runner spelled that for themselves — two of them as partial resolvers — and
  agreed on everything except two cases that only show when a packet is kept
  outside its target (`prepare-build --out`) or its report is not the default
  sidecar (`prepare-build --report-out`). First, standalone `campaigns-os
  doctor` wrote `doctor-output.json` beside the packet while `prepare-build`,
  `next` and the QA stage refresh wrote it under the target repo, so such a
  campaign carried two sidecars that disagreed and the stale stamp `theme
  waive` and `qa policy set` apply never found the one doctor wrote. Doctor
  now writes it under the target repo like every other producer
  (`--doctor-out` still wins). Second, the QA stage record written after `qa
  run`, and the QA runner's own read of the Assembly Report, never followed
  the `report_path` the Build Context records and `next` follows, so a
  `--report-out` campaign's QA outcome was recorded nowhere — the default
  report does not exist — while `next` kept reading a report whose QA stage
  never completed. `qa run`, `qa waive` and the QA stage record now follow the
  binding, so the report `next` reads is the one QA writes into; the runner's
  own reads of the doctor output, Build Context and Assembly Report for the
  theme gate, polish gate and recorded QA waivers resolve the same way, so a
  packet kept outside its target reads the doctor scope doctor actually
  refreshed rather than a stale copy beside the packet. A context binds a
  report only for the packet it names: `prepare-build` writes `packet_path`
  beside `report_path`, and a pointer from a context naming another packet
  (two packets of one campaign sharing a target repo) is not followed. `theme
  waive`, `checkpoint waive`, `polish capture`, `findings harvest`,
  `run-record` and `run status` act on the default location as before, and
  doctor's own stage write-back still refuses to restate its outcome into a
  report it did not inspect. `docs/build-packet.md` states the rule.

## [1.27.0+agent.3] - 2026-09-14

### Fixed

- One implementation of the route-identity helpers. A campaign's route
  identity is `public_route_slug` (the `_site/<slug>/` build directory) and
  `route_root` (where the funnel is served: `"/"` for a root-served campaign,
  otherwise `"/<slug>/"`), and the small functions that read, tidy and compare
  those two values were copied into four modules — `isAbsoluteHttpUrl` three
  times, `stripPublicRoutePrefix` three times, `normalizePageKitRoute` and
  `runtimeRelativeRouteForSpecValue` twice, `normalizePublicRouteSlug` four
  times plus two inline spellings — because the QA runner cannot import
  `src/cli.mjs`. They now live once in the leaf `src/route-identity.mjs` and
  every module imports them. The copies had drifted into two acceptance rules
  for a declared `route_root`: doctor read the packet exactly (`"/"` or
  `"/<slug>/"`, the shape the packet schema accepts) while `qa run` read it
  leniently (any spelling of the slug), so a hand-edited packet declaring
  `"/<slug>"` without its trailing slash was a doctor blocker
  (`campaign.route_root`) and a silent QA pass. Both now read the packet by
  one exact rule, and the CampaignSpec by one intake rule (the lenient
  spellings `prepare-build` canonicalises): QA still audits the slug-prefixed
  default for such a packet, exactly as before, but treats the declaration as
  ignored — the same verdict doctor gives — rather than honouring it. No
  doctor output, JSON or text, changes; no QA verdict field changes;
  `docs/build-packet.md` states that QA reads `route_root` by doctor's rule.

## [1.27.0+agent.2] - 2026-09-13

### Added

- `singleLineFragment(value, fallback)` on the `./text-safety` package export,
  beside `singleLineField` and `singleLineDetail`. It is the flattener for a
  value folded into a sentence rather than printed as its own field — a
  gate's repair command or manual instruction quoted in a notice: line breaks
  and tabs become spaces, runs of whitespace collapse, the ends are trimmed,
  and every other control character becomes U+FFFD, with no Markdown escaping
  and no length cap, so a command stays pasteable. This is the folding step
  `singleLineDetail` already performed inside itself; `singleLineDetail` is
  now built on it and its output is unchanged byte for byte.

### Fixed

- The QA runner's browser-skipped notice (`Browser QA was requested with
  --browser but no browser launched ... The gate's required actions clear
  it: ...`) flattens each quoted `required_actions[]` command through that
  shared function instead of a private copy inside the runner whose comment
  said the CLI's helper was not importable from there (it has been since the
  helpers moved to `src/text-safety.mjs` at 1.27.0). One visible difference
  on hostile input only: an ANSI escape or other non-whitespace control
  character inside a published command is now replaced with U+FFFD, the
  reading every other CLI notice gives it, rather than folded into a space.
  Line breaks and tabs inside a command still read as one space, as before.
  `docs/supported-surface.md` describes the third function beside the two.

## [1.27.0+agent.1] - 2026-09-13

### Fixed

- The typed-card runner's cart-entry vocabulary is now exactly the SDK's
  activation selector for its add-to-cart feature,
  `[data-next-action="add-to-cart"]`. `CART_ENTRY_CONTROL_SELECTOR` also
  listed `[data-next-checkout-action="add-to-cart"]` and
  `[data-next-add-to-cart]`, two attribute spellings the SDK never
  instantiates the feature on, so a landing page whose only "add to cart"
  control carried one of them read as a cart entry: the ladder's
  `entered_via_landing` step clicked it, nothing was added, the SDK made no
  hand-off, and the step failed with `cart_entry_no_navigation` only after
  waiting out the full navigation budget. The primary-CTA assertion read the
  same constant and honoured the element's `data-next-url` as if the SDK
  would navigate by it. Both consumers share the one constant, so both now
  see such a control for what it is — a plain button — and the step fails by
  name with `cart_entry_control_missing` before any click, the way a page
  with no control at all already did. `docs/qa-and-test-orders.md` stops
  naming the two spellings. Pages that carry the SDK's own control, or a
  `?forcePackageId=` link into the checkout, are unaffected; a page that
  relied on one of the removed spellings being clicked was never going to
  reach the checkout through it.

## [1.27.0] - 2026-09-13

### Added

- A `./text-safety` package export, so a consumer rendering a toolkit-derived
  value into its own single-line notice can flatten it the way the CLI does
  instead of reimplementing the escape set. It publishes the two functions that
  already did that work inside `src/cli.mjs`: `singleLineField(value,
  fallback)` replaces every C0, DEL and C1 character with U+FFFD — replaced,
  never dropped, so a mangled run id or target path stays visibly mangled
  rather than silently shortening the line it lands in — and
  `singleLineDetail(detail, max)` adds what a quoted loader message needs on
  top of that: line breaks become spaces rather than replacement characters (a
  newline inside a quoted JSON fragment is a word boundary, and U+FFFD there
  reads as mojibake), runs of whitespace collapse, Markdown that could restyle
  the rest of a rendered bullet is backslash-escaped, and the result is cut to
  `max` characters (default 300) with a trailing ellipsis. An empty detail
  reports `(no detail reported)`. The functions moved to a new leaf module,
  `src/text-safety.mjs`, with no change to either behaviour; the CLI imports
  them from there and every existing notice reads as before.

### Removed

- The `standardization-report` CLI command, a second spelling of `standardize`
  that dispatched to the same code with the same flags, the same output and the
  same exit codes. Two supported names for one command is surface a consumer
  has to reconcile for nothing, and the shorter name is the documented one, so
  the redundant spelling is gone rather than kept for symmetry.
  `campaigns-os standardization-report` now returns the standard
  unknown-command error and points at `campaigns-os --help`, mirroring how the
  `validate-build-packet` alias of `doctor` was removed in 1.25.0+agent.7.
  `standardize` itself is untouched, including
  `--sdk-support-policy`/`--field-contract`, the `--no-doctor` behaviour, and
  the report's own `campaign-standardization-report/v0` `schema_version`. A
  caller still using the old spelling retargets it at `standardize` and
  changes nothing else. This removes a supported command, which is why
  `surface_version` advances to 1.27.0 and the ledger entry is breaking.

## [1.26.0+agent.23] - 2026-09-13

### Fixed

- The human `campaigns-os doctor` report now prints each checkpoint gate's
  `required_actions[]`, so the remediation is on the surface an operator
  actually reads. `doctor --json` has always carried the exact repair command
  (or manual step) and the waiver command for every gate that still owes work,
  and docs/build-packet.md documents them, but the text report printed only the
  finding: an operator whose target page-kit pinned a newer campaign-cart SDK
  than the CampaignSpec saw `Target SDK version ... does not match the
  CampaignSpec pin ...` and no way forward, and had to re-run with `--json` or
  read the docs to learn that a one-field pin repair or a recorded waiver
  clears it. The report gains a `Required actions:` block below `Errors:` and
  `Warnings:` and above `Next:`, one `- [<gate id>] <command or description>`
  line per action, covering the same gate set `next` aggregates (the three
  registered checkpoint gates plus the polish checkpoint gate); `--packet
  <packet>` is substituted with the packet the run read, as the QA resolve
  printer already does. A run whose Assembly Report is not the packet-inferred
  default (`--report`, or a context `report_path` binding) also gets
  `--report <inspected report>` appended to the packet-scoped commands, so the
  remediation acts on the report the inspection read rather than on
  `.campaign-runtime/assembly-report.json`, which `checkpoint waive` and
  `polish capture` would otherwise resolve. A report whose gates are all clear
  prints nothing extra, so clean runs are unchanged. `--json` output is byte-for-byte
  unchanged — this is text-only, like the existing tiny prompts — so no
  machine reader needs to adapt.

## [1.26.0+agent.22] - 2026-09-13

### Fixed

- Credentials on the telemetry rails are now shape-checked and their
  destination vetted before a socket is opened. Two holes closed. First,
  `--proxy-base` only ever had a transport rule on `telemetry list`; the remit
  rail and the QA verdict publish took whatever origin they were given, so
  `--proxy-base http://some-proxy.example` put `X-Campaign-Key` on the wire in
  the clear. Every credential-bearing request now goes through one gate
  (`assertSecureProxyBase` in `src/remit.mjs`): `https:` passes; a loopback
  host (`localhost`, `127.0.0.1`, `[::1]`) may be plain http for a local
  receiver and prints one stderr warning per request that the credential
  travels in clear; any other plain-http base — and any base that is not a URL
  — is refused before the request, so nothing is sent. A remit or publish
  aimed at a plain-http remote proxy therefore now fails rather than leaking;
  on the remit rail that failure stays non-fatal and lands in `remit_error`,
  as an unreachable receiver always has. The ops admin key keeps its stricter
  rule on top (canonical scope, loopback, or an explicit
  `--trust-proxy-base`). Point a plain-http staging proxy at `--proxy-base`
  and only the credential-free spec fetch still works; give it TLS, or run it
  on loopback, to keep remit and publish.
- Second, a campaign key that was present but malformed — a quoted key, a
  pasted JSON blob, a URL, a value with whitespace — was silently discarded
  and reported as if no key had been configured at all, so an operator whose
  `api_key_source` env var held the wrong thing was told to go add one. The
  resolver now separates "absent" from "refused" and names the refused
  **source** (the env var, the packet field, or the CampaignSpec) while never
  printing the value. `telemetry list --packet` fails fast on such a value and
  makes no request. `run-record` warns on stderr and says "the declared
  Campaigns API key was refused on shape" instead of "no Campaigns API key
  found", then attempts the send without a tenant scope — the remit rail is
  non-fatal by contract, so a bad credential must not fail the run it is
  reporting. The warning belongs to a send: under consent-off or `--no-remit`
  the key is never read and nothing is said about it. A malformed key in the
  packet also no longer falls through to a different source: an explicit value
  that fails the shape gate is refused where it was declared. `api_key_source`
  keeps its existing restriction to variable names that name a campaign key,
  and now says so by name when it refuses one, without reading that
  variable's value.

## [1.26.0+agent.21] - 2026-09-13

### Fixed

- `qa run --browser` behind a blocked gate now says that the browser pass did
  not happen. A blocked checkpoint, polish, or theme gate finalizes the verdict
  before any page is rendered, which is the point of the gate — but the
  resulting verdict was byte-identical to the same run without the flag (no
  `browser-runtime` assertions, `tested_urls: []`) and stderr was empty, so an
  operator who asked for browser QA got none and had nothing telling them so.
  Such a run now stamps the verdict with
  `browser: { requested: true, status: "skipped_gate_blocked", blocked_by:
  [<gate codes>], reason }` and prints that reason once on stderr, naming the
  gate that blocked and what clears it. That repair guidance is quoted from the
  blocking gate's own `required_actions` rather than written at the notice, so
  it cannot send an operator into a second blocked run — a
  `polish.assembly_source_package_stale` blocker asks for a fresh Build, not
  another Polish, and a waive command appears only for a state its gate
  actually lets an operator waive. The gate decision, the assertion set and the
  exit code are unchanged: a blocked verdict still exits `4`. A reader adapts by treating the field as additive
  and present only for that case — its absence means the verdict makes no claim
  about a browser pass, not that one ran, so keep reading `browser-runtime`
  assertions and `tested_urls` for that. The field is not in the committed
  sidecar's allowlist projection, and `--json` runs receive the stamp in the
  emitted verdict instead of the stderr line. `docs/qa-and-test-orders.md`
  states the behaviour.

## [1.26.0+agent.20] - 2026-09-13

### Fixed

- `campaigns-os validate-assembly-report` now fails an Assembly Report that
  declares a Design Source Package material fingerprint but records no
  `stages.assembly.source_package_material_fingerprint`. The ladder already
  refused that report: `doctor` and `next` blocked on the polish gate's
  `polish.assembly_source_package_fingerprint_missing` and routed back to
  Build, while the standalone validator called the same file valid, so an
  operator or agent validating a hand-authored report got a green answer and
  then hit a hard stop one command later. The condition is no longer written
  twice: the gate and the validator both read
  `assemblySourcePackageFingerprintMissing()` in `src/polish-gate.mjs`, which
  keeps the existing carve-outs intact — a report whose Assembly is still
  pending (the shape `prepare-build` and `start` emit, which records the
  package fingerprint before any build has consumed it) or that has no build
  fingerprint yet is outside the finding, a report with no design source
  package at all is untouched, and an active Source Freshness Waiver still
  passes. The new error codes are
  `stages.assembly.source_package_material_fingerprint` and, for a waiver
  record whose `expires_at` does not parse, the malformed-record condition the
  gate blocks on as `polish.waiver_expires_at_invalid`,
  `stages.assembly.waiver_expires_at_invalid`. The validator stops at a
  malformed waiver record the way the gate does, so that report carries that
  one error and the freshness question waits until the record is repaired. A
  report that previously validated clean may now fail; record the fingerprint Build
  consumed (or a structured waiver in `waivers[]`) exactly as the polish gate
  already required. `doctor` output is unchanged: it reports this finding from
  its polish gate as before, and does not list it twice. `polish capture`'s
  report check is unchanged too: it is a shape check, and the polish gate
  reports source freshness on the way out.

## [1.26.0+agent.19] - 2026-09-13

### Changed

- A polish capture warning now names the resource roles whose failures were
  demoted to it. `cross_origin_request_failed` exists because a failed
  cross-origin request in a beacon-class role (`ping`, `fetch`, `xhr`,
  `other`, `preflight`) says nothing about what the page renders, so it is
  recorded without making the capture incomplete. That demotion is a
  trade-off, not a fact about the page, and the warning entry did not say
  which roles it had been applied to: an operator reading
  `measurement.warnings[]` could see the failing origins but not whether a
  stale tracking `ping` had been forgiven or a `fetch` the page may have
  depended on. Each warning entry now carries `resource_types[]` — sorted,
  unique, drawn from the beacon allowlist, so at most five values — and
  `campaigns-os polish` prints the same list as `Resource types:` in its
  `Capture warnings (not blocking)` block. The beacon allowlist itself is
  unchanged, so nothing that blocked before is forgiven now and nothing that
  warned before blocks; `measurement.status`, the problem codes, the resource
  ledger and the checkpoint verdict are untouched. A consumer that compared a
  warning entry against a fixed key set should accept the new key; one that
  only reads fields it names needs no change. `docs/polish-evidence.md`
  records the field and why the roles are named.
- Page-load evidence recorded before this change whose `measurement` carries a
  capture warning no longer equals the projection this module recomputes from
  its own captures, so `evaluateHiddenEagerMediaCheckpoint` (the recorded-
  checkpoint path doctor and the QA gate read) blocks it as
  `polish.hidden_eager_media.capture_malformed` until the route is recaptured.
  Re-run `campaigns-os polish` for such a report; evidence with no warning is
  unaffected. The absent field is deliberately not normalised away: the
  recorded measurement has to equal the projection for a hand-edited
  measurement to be catchable, and accepting a warning that does not name the
  roles it forgave would re-open the gap this change closes.

## [1.26.0+agent.18] - 2026-09-13

### Fixed

- A source-html manifest `pages[].screenshots[]` record that fails one of the
  three field tests is now reported per record instead of disappearing. The
  package build dropped a record whose `viewport` was unrecognized, whose
  `kind` was not a source-screenshot kind, or that pointed at no evidence
  (no `path`, no `url`, no `unavailable_reason`), and said nothing: a
  hand-authored manifest with a typo in one record lost that screenshot, the
  page stayed blocked for missing desktop/mobile proof, and neither `start`
  nor `doctor` mentioned the record the operator had written. Manifest
  validation now emits one warning per unusable record, naming the record
  (`manifest.pages[i].screenshots[j]`), its `page_id`, and the field that
  failed, on the same channel as the `wrapper_policy` warning: `start`,
  `prepare-build` and `build` print it, and `doctor` carries it as a
  `source_html.manifest` warning. The schema is unchanged and the manifest is
  still accepted and used as written — optional proof with a typo is not a
  reason to fall back to filesystem matching — so the only change a reader
  adapts to is the extra warning text and, in `doctor --json`, the extra
  `warnings[]` entries under an existing code. The accept/reject test now
  lives in one place beside the package builder, so the warning cannot drift
  from the behaviour it describes.

## [1.26.0+agent.17] - 2026-09-13

### Changed

- `start`, `prepare-build` and `build` now say which template family won when
  the `--template-family` flag and the CampaignSpec
  `preferred_template_family` hint disagree. The precedence itself is
  unchanged and was always documented — the flag beats the hint — but it
  resolved in silence, so an operator whose spec hinted one certified family
  and whose flag named another got a packet built on the flag with nothing on
  stderr and nothing on the assembly report to show the hint had been
  discarded; the packet read as agreement with the spec. A disagreement now
  prints one stderr line naming both values and the channel each came from,
  and adds a `prepare_build` warning with code
  `TEMPLATE_FAMILY_HINT_OVERRIDDEN` to the assembly report's `warnings[]`,
  beside the existing `SOURCE_SCOPE_PARTIAL` and
  `AMBIGUOUS_SOURCE_HTML_CANDIDATES` entries. A flag that repeats the hint is
  agreement, not an override, and stays quiet, as does a hint with no flag.
  Nothing about the packet changes and no gate is added: the warning is
  advisory, exit codes are unaffected, and an agent that ignores unknown
  warning codes keeps working. A reader that wants the spec hint to win should
  drop the flag; a reader that wants the disagreement gone should update the
  spec. docs/build-packet.md "Authoring-Time Hints" documents both the
  precedence and the notice.

## [1.26.0+agent.16] - 2026-09-13

### Changed

- The `browser-order-bump-state` marker vocabulary now lives in one list, and
  the stylesheet-rule walk no longer reads a dimmed marker as a hidden one.
  Two exported constants held the same four marker selectors — the ordered
  family list and the container list a nested tick's wrapper is matched
  against — so a family added to one and not the other would resolve a marker
  and then judge it by the wrong box; `ORDER_BUMP_MARKER_CONTAINERS` is now
  derived from `ORDER_BUMP_MARKER_FAMILIES` rather than repeating it (order is
  immaterial to a container list, which is joined into a single `closest()`
  query). Separately, one `opacity <= 0.5` threshold served both the rendered
  read and the rule walk, which are asking different questions: the rendered
  read asks whether a buyer can see the marker, and half opacity or less is
  too faint to read a tick off; the rule walk asks whether a rule removes the
  marker from rendering, which is the display-toggled family's signature. A
  rule dimming a marker to `opacity: 0.4` leaves it on screen, so counting it
  reported a correctly declined bump as misaligned. The rule walk now requires
  an exact `opacity: 0`; the rendered read keeps its threshold. The
  accepted-state fill is now the documented `ORDER_BUMP_ACCEPTED_FILL_COLOR`
  constant, passed through the probe input instead of sitting inline as a bare
  colour literal, and the fixture README records both sides of the new rule
  threshold. No evidence field changed name or meaning, so nothing a reader of
  the order-bump evidence consumes needs adapting; a page that dims a state
  marker without hiding it now reads `unresolved` where it used to read
  `display_toggled`, which is the false misalignment going away.

## [1.26.0+agent.15] - 2026-09-13

### Changed

- Five documentation gaps that each cost an operator or a contributor a wrong
  conclusion are now written down. `docs/qa-and-test-orders.md` states that a
  checkpoint gate's `status` is the blocking axis alone: `page_kit.store_profile`
  reports `status: pass` with `code: page_kit.store_profile.target_only` when the
  target declares a governed field the CampaignSpec leaves empty, and `qa resolve`
  decides `ready` against `warning_fields[]` rather than `status`, so a reader who
  treated `pass` as clean was reading the wrong field.
  `docs/release-ledger-authoring-guide.md` and the generated
  `docs/orientation-contract-reference.md` separate `sequence` from `id`:
  `sequence` is the entry's position in `entries[]` and the authoritative order,
  `id` is an immutable label that is never renumbered, and the two diverge
  legitimately once concurrent pull requests restamp on merge — as they already do
  in this ledger. The authoring guide also records the norm for a fix that lives
  entirely in policy-ignored paths (`src/` other than `src/cli.mjs`, `scripts/`,
  tests): a same-surface CHANGELOG section and no ledger entry, because the gate
  refuses a change item that maps to no classified path, while any `src/cli.mjs`
  change is `cli_surface` and owes one.
  `docs/design-source-package.md` documents the read-only source root: intake
  only ever reads under the source root and writes its artifacts under the target
  repository, and `screenshots[]` records may carry a `url` instead of a `path`,
  so the gate clears from a writable target repo with no work copy of the source
  and no capture bytes in the source tree — with the fixed manifest path and the
  packet-relative `source_html.root` as the two mechanics to plan around. Finally,
  `README.md` gains a "Review standards" section stating the two review rules
  contributors kept rediscovering: a guard test includes the failing case and
  prefers parsed-module assertions to source-substring matching, and a `catch`
  branches on the condition it claims to handle instead of swallowing every
  error. No behaviour changed; no command, schema, or artifact moved.

## [1.26.0+agent.14] - 2026-09-13

### Fixed

- `shellToken` prints a falsy value as itself. It stringified `value || ""`, so
  a count or flag of `0`, `false` or `NaN` vanished from a printed command;
  only `null` and `undefined` now read as no value. Review follow-up on the
  shell-token test; the charset test pins the new cases.

### Changed

- The two campaign scanners drop an import left dead by the repo-scan
  consolidation. No behaviour change.

## [1.26.0+agent.13] - 2026-09-13

### Changed

- Internal consolidation, no output change. The repository-scan helpers the
  two campaign scanners (`campaign-ecosystem.mjs`, `standardization-report.mjs`)
  each carried — the file walk, the skip rule, the version compare and
  extract, and the small string helpers (`normalizeString`, `relPath`,
  `rootId`, `unique`, `escapeRegExp`) — now live once in `src/repo-scan.mjs`;
  each scanner keeps only its own skip-directory set and passes it in. The
  build-brief extractor's `escapeRegExp` copy is folded in too (the `cli.mjs`
  copy stays: it stringifies `null` differently and its callers rely on that).
  `standardize` output over the example target is byte-identical before and
  after, timestamps aside.

## [1.26.0+agent.12] - 2026-09-13

### Changed

- Internal consolidation, no output change. The cause block the `doctor` and
  `qa run` human reports print (summary line, then the comparison-basis line
  when no comparison happened) is one function, `formatCauseReportLines`,
  instead of the same three lines written in each command; the doctor
  fingerprint used for the prior-run comparison is computed by
  `doctorIssueFingerprint` at both sites instead of once as a function and
  once as a string literal; and `formatCauseSummaryLine` drops a `priorRunId`
  option that both callers passed with the value the function already read
  from the summary. Eight `finding-cause.mjs` symbols with no importer outside
  the module are no longer exported; none is on the supported surface.

### Removed

- `assemblySourcePackageFreshnessWaiver` from `src/polish-gate.mjs`: a
  three-line alias over `assessAssemblySourcePackageFreshnessWaivers(...).active`
  with no caller in `src/` or `scripts/`. Not on the supported surface.

## [1.26.0+agent.11] - 2026-09-13

### Changed

- Doctor's `next` block is now a projection of the `next` command's own stage
  picker, so the two can no longer disagree about which stage comes next.
  Doctor carried a second decider with its own vocabulary (`collect-inputs`,
  `assembly`, `complete`) and its own gating: it knew neither the
  prepare-build gate nor purchase proof, so it could report `complete` while
  `next` said `qa` on the same packet; it listed the stage it recommended
  inside its own `blocked_stages`; and it omitted `command` on some branches.
  `next.stage` now uses the picker's names (`prepare-build`, `doctor-blocked`,
  `setup`, `build`, `polish`, `deploy`, `qa`, `done`), `reason` is the picker's
  reason, `command` is always present (the stage-less `campaigns-os next`
  for `prepare-build` and `done`, since neither is a `next <stage>`
  argument), and `blocked_stages` lists only the stages behind the picked
  one. `owner`, `default_skill`, `status` and the
  code-to-action `actions[]` strings are unchanged in meaning. Readers keyed
  on `collect-inputs` should key on `doctor-blocked` / `prepare-build`; on
  `assembly`, `build`; on `complete`, `done`. The `next-campaigns-os` skill
  (1.0.9) and the build-flow, design-source-package and source-adapters docs
  say so. `doctor --packet <p> --context <c>` (or `--report` alone) keeps
  its inspection contract — the sidecar it was not given stays off — so its
  `next` block decides over the artifacts it checked and its `reason` says
  which; the ladder decision over the bound report is `campaigns-os next`'s.

## [1.26.0+agent.10] - 2026-09-13

### Removed

Recorded late. These left the tree in 1.25.0+agent.9–13 (2026-09-12) with no
changelog entry. None was on the supported surface (`package_exports` lists
subpaths, not symbols), so no consumer contract moved and no ledger entry is
owed; they are listed so a reader who imported one by deep path knows why it
is gone.

- `scripts/assembly-inject.mjs` — an orphaned prototype with no references
  (159 lines).
- `src/lifecycle.mjs`: `lifecycleForRunRecord`, `selectLifecycleForRun`,
  `resolveLifecycleJournalPath` — the off-embed trio superseded by
  `aggregateLifecycleForRun` and the run-session journal resolution in
  `src/cli.mjs`.
- `src/qa-node.mjs`: `shouldPublishVerdict` — superseded by
  `decidePublishVerdict`; and the `shellToken` re-export — import it from
  `src/shell-token.mjs`.
- `src/theme-gate.mjs`: `commercePagesFromScope`; `src/design-source-package.mjs`:
  `serializeAndHashDesignSourcePackage` — zero callers.

### Changed

- Docs only. `docs/quickstart.md` § Inputs says what the Store Profile gate
  requires after the target is scaffolded (every field the CampaignSpec
  provides must be present and identical in the target; target-only fields
  warn, demo residue blocks; `checkpoint waive --gate page_kit.store_profile`
  records an exception),
  where it used to say only `store_url` is required. The source-preparation
  paragraph now names the `preserve_document_wrappers` route where the wrapper
  gate is hit, and `docs/source-adapters.md` gains an "Order of operations"
  paragraph (decide the policy before capturing screenshots or computing
  `source_hash`; what a later strip invalidates). The run-telemetry note says
  what `off` changes downstream (`remit_state: skipped`; machine/environment
  consent off makes `qa run` default to local-only, `--no-remit` does not),
  and the README's copy of it is now a short pointer to the
  quickstart instead of a verbatim duplicate. `docs/qa-and-test-orders.md`
  adds `schema_version` to the `cause_summary` field list (the code always
  emits it) and a paragraph on `spec_hash` (the material hash, pairs with
  `identity.spec_material_hash`) and `campaign_ref_id` (copied from the spec's
  `campaign.ref_id`, shared by specs exported from one platform campaign).

## [1.26.0+agent.9] - 2026-09-13

### Changed

- `src/cli.mjs` no longer re-exports `orderRunRecordFileNames` and
  `readRunRecordsForTarget`; both live in `src/run-record.mjs`, which was
  already the only implementation and the module the QA runner imports them
  from. Neither name is on the supported surface (`package_exports` lists
  subpaths, not these symbols), so this removes an internal shim only; the
  one in-repo importer (a test) now imports from `src/run-record.mjs`.

## [1.26.0+agent.8] - 2026-09-13

### Fixed

- The doctor ready line for a passing theme gate states the fact the gate
  passed on. The gate passes on two different facts — a brand layer applied
  after `next-core.css` (`theme_gate.applied`), or no generatable brand theme
  at all (`theme_gate.nothing_generatable`) — and `ready[]` printed the first
  sentence for both, so a token-less campaign read "brand layer applied" three
  lines after "Brand theme context missing". The line now carries the gate's
  own reason. Gate codes, statuses and reasons are unchanged.

## [1.26.0+agent.7] - 2026-09-13

### Fixed

- The doctor `Next:` block no longer orders a document-wrapper strip that the
  run's accepted `preserve_document_wrappers` adapter decision makes wrong.
  The source-preparation action fired on any source-preparation code in
  errors or warnings and always listed all three repairs, so a run whose
  `source_html.prep.document_wrapper` finding had been downgraded to a warning
  by the recorded wrapper policy still told the operator to strip wrappers,
  while the warning beside it said the decision was accepted; following the
  block literally undid what cleared the gate. The action now names only the
  repairs the findings ask for, and offers the wrapper strip only when the
  wrapper finding is an error. Codes, severities and the warning text are
  unchanged.

## [1.26.0+agent.6] - 2026-09-13

### Fixed

- A repeated `start` / `prepare-build` / `build` against a target whose run
  session is already open now joins that session, so its lifecycle entry
  lands in the same journal. Those commands take a `--target`, not a
  `--packet`, so the ambient session lookup could only find a session by
  cwd; a re-run from anywhere else resolved no session, the auto-start
  declined to open a second one, and the entry was never written. A journal
  therefore held the first blocked intake and none of the retries, including
  the one that produced the packet every later stage used, and the Run
  Record's `repair_loop_count` and stage timings read low. Adoption requires
  the open session to be bound to this packet or to none; a session bound to
  a different packet is left alone as before. `--no-run-session` still skips
  the session entirely. (A `doctor` that runs after `run-record` is minted is
  recorded in the journal but not in that record, which is the record's
  cut-off working as designed, not a missing entry.)

## [1.26.0+agent.5] - 2026-09-13

### Fixed

- A blocked polish gate's QA verdict evidence now carries the same fields the
  doctor's `derived.polish_gate` carries. The blocked branch of the verdict
  projection built a hand-picked subset (`reason`, `build_fingerprint`,
  `source_build_fingerprint`, `performed_by`, `problems`, `required_actions`,
  `scope_source`), so on `polish.assembly_source_package_fingerprint_missing`
  and `polish.assembly_source_package_stale` the verdict dropped the
  `source_package_material_fingerprint` and
  `assembly_source_package_material_fingerprint` the reason names, showed
  `source_build_fingerprint: null` beside it, and omitted the `waiver` and
  `expired_waiver` the other branches carry. The blocked branch now uses the
  shared evidence object plus `reason`, `problems` and `required_actions`;
  `expired_waiver` joins the shared set. Gate codes, reasons and required
  actions are unchanged: `polish.assembly_source_package_fingerprint_missing`
  (assembly not tied to the current Design Source Package, re-run Build) and
  `polish.evidence_missing` (no Polish stage, run Polish) are different
  conditions with different next actions and stay distinct.

## [1.26.0+agent.4] - 2026-09-13

### Changed

- `qa run` writes the full verdict beside the campaign, not beside the caller.
  The local verdict directory defaulted to `qa-output/` under the current
  working directory, so a run started from anywhere but the target repo left
  the verdict where nothing would find it; the Run Record, which reads verdicts
  back from `<target-repo>/qa-output/<slug>/` by convention, then recorded
  `external:qa_verdict` with no path at all. The default is now `qa-output/`
  under the packet's target repo (`assembly.target_repo`, else the packet's
  directory); `--output-dir` still wins, and a packet-less run (`--site`, raw
  map-id) keeps the current-directory default. Because full verdicts carry
  live storefront URLs and order references, `qa-output/` joins the managed
  ignore block `start`, `prepare-build`, `install-agent-context` and
  `run start` write into the target's `.gitignore`. A target whose block predates
  the entry gains it on the next of those commands (the block stays the
  operator's to edit otherwise; an entry placed elsewhere in the file counts);
  the committed form remains
  the `.campaign-runtime/qa-verdict.json` projection, which is unchanged. The
  `external:<kind>` sentinel on an out-of-root artifact is deliberate and stays.

## [1.26.0+agent.3] - 2026-09-13

### Fixed

- A Run Record's `assembly_report` sha256 no longer goes stale on the next
  `doctor` run. `run-record` digests the Assembly Report at mint, but every
  `campaigns-os doctor` against a matching packet rewrote the report with a
  fresh `stages.doctor.checked_at` even when it found exactly what the report
  already said, so the record's attestation broke seconds after it was minted
  in any workflow where `doctor` runs after `run-record` (the packet and
  QA-verdict digests kept verifying because nothing rewrites those). `doctor`
  now compares its restated outcome with the report on disk, ignoring only
  the doctor stage's own `checked_at` / `completed_at`, and leaves the file's
  bytes alone when nothing else moved; a changed outcome (a blocker cleared,
  a warning added, a different command or output path) still rewrites, and
  `doctor-output.json` is refreshed on every run as before. The helper is
  exported from the stage ledger as `producerStageOutcomeUnchanged` for the QA
  producer to adopt.

## [1.26.0+agent.2] - 2026-09-13

### Fixed

- The QA verdict now says which route and viewport failed a polish capture and
  on which problem code. A `polish.hidden_eager_media.capture_incomplete`
  block was built from the code, reason and subject alone, so the per-cell
  `measurement.incomplete[]` the checkpoint had just recomputed was discarded
  one layer before the verdict projector could read it; the verdict carried
  the full `routes` list, `state: { findings: [] }` and nothing else, and a
  reader had to open the assembly report to learn which of the cells failed.
  The blocked checkpoint now carries `measurement` (the recomputed `status`,
  counts, and the `missing[]`, `duplicate[]`, `unexpected[]` and
  `incomplete[]` cells with their `problem_codes[]`), and the verdict's
  `polish.hidden_eager_media` assertion projects it as `evidence.measurement`
  with path-only routes, the closed viewport vocabulary and the closed
  problem-code vocabulary, bounded by one 256-cell budget across the four
  lists (the full supported capture matrix) with any excess, and any record
  outside the closed vocabularies, counted in `omitted_cell_count` and per
  list in `omitted_cell_count_by_list`; counts are always integers. Other block codes carry
  `measurement: null`. No
  schema, problem code or verdict field outside that assertion's evidence
  changes.

## [1.26.0+agent.1] - 2026-09-13

### Fixed

- `polish capture` no longer blocks on a `data:`, `blob:` or `about:` response.
  The response aggregator treated every non-http(s) response URL as
  `resource_url_unresolvable`, which makes the route's capture incomplete and
  raises `polish.hidden_eager_media.capture_incomplete` — the unwaivable block
  built for browser crashes and missing routes. A page with a `<video controls>`
  element or an inline `data:` image produces several such responses on every
  load, so the block reproduced on every capture of that route, the repair
  instruction (fix an unresolvable resource URL) pointed at nothing an operator
  could change, and `checkpoint waive` refused it by design. A non-http(s)
  response is not a network resource: nothing was transferred and there is
  nothing to attribute to the resource ledger. It is now counted under
  `response_collection.unattributed_response_count` (evidence) and raises no
  problem; `resource_url_unresolvable` is reserved for a malformed or over-long
  URL and for a non-http(s) load that failed (a revoked `blob:` URL behind a
  script or image is still a dependency the page could not load). The browser
  collector records a non-http(s) response URL as its scheme
  alone (`data:`), so a long inline image is neither persisted nor misreported
  as `url_length_overflow`. Capture shape, problem-code vocabulary and the
  measurement invariants are unchanged; a capture blocked this way needs a fresh
  `polish capture`, which it needed anyway.

## [1.26.0] - 2026-09-12

### Added

- An intake channel for the document-wrapper policy. `preserve_document_wrappers`
  was documented as a choice but could only be selected by editing the Build
  Packet the build stage writes, so whoever hands over raw HTML source had no way
  to pick it and `source_html.prep.document_wrapper` blocked them at intake. Two
  channels now select it, in the adapter contract's existing vocabulary
  (`strip_document_wrappers`, `preserve_document_wrappers`, `not_required`,
  `unknown`): an optional top-level `wrapper_policy` key in the
  `source-html-manifest/v0` document, and a `--wrapper-policy` flag on
  `prepare-build` (and on `start` / `build`, which run the same prepare step).
  `prepare-build` seeds `source_html.adapter_contract.wrapper_policy` from the
  resolved value, so a selected `preserve_document_wrappers` reports the wrappers
  as a warning instead of blocking assembly.

  Precedence follows the template-family rule — the flag wins over the declared
  manifest key, and with neither the default stays `strip_document_wrappers`, so
  a run that passes neither behaves exactly as before. A flag value outside the
  vocabulary fails the run, before anything is written. A manifest value outside
  it does not invalidate the manifest: the key is ignored with a warning naming
  it, the value, and the accepted values, and `pages[]`, `producer_provenance`,
  and `files[]` are used as written. A non-default selection prints the value
  and the channel that set it on stderr.

## [1.25.0+agent.16] - 2026-09-12

### Fixed

- `browser-order-bump-state` resolves a bump toggle's rendered state marker
  instead of the toggle's own `aria-hidden` checkbox input (campaigns-os#323).
  The marker selector list ended in a bare `[aria-hidden]`, and
  `querySelector` returns document order rather than selector order, so on any
  toggle whose visually hidden `<input type="checkbox" aria-hidden="true">`
  precedes its tick, the input *was* the marker. An input has no `::after`, no
  glyph and no fill, so `markerChecked` could never read true: every accepted
  bump reported misaligned, the assertion failed at warn severity on every
  run, and no bump run could read clean. The same clause also matched purely
  decorative nodes, such as a switch variant's always-rendered slider, whose
  rendering says nothing about the toggle's state.

  The marker vocabulary is now the four families that mean "this is the tick"
  (`.bump-check`, `[data-next-toggle-check]`, `[os-component="check"]`,
  `.checkbox__icon`), tried in order so a generic match cannot outrank a
  specific one by appearing earlier in the document; form controls and
  `[hidden]` subtrees can never be a marker.

  A rendered marker is then read for a positive state signal, and the signals
  are alternatives, because the families express state differently. A marker
  whose `::after` carries content belongs to the pseudo-element family and its
  state is whether that pseudo-element renders — never whether its box does,
  since the box renders in both states. Otherwise a check glyph in the marker,
  or the accepted fill colour, reads as checked, as before. New alongside
  those: a marker that the page's own CSS hides when unchecked
  (`[data-next-toggle-card] [os-component="check"] { display: none }`, restored
  to `display: flex` on the active or in-cart card) *is* the tick, so its own
  rendering is the state — and that is settled by testing the page's style
  rules against the element, not assumed from the family name, so a persistent
  box that nothing hides can never be read that way. Only rules that currently
  apply count as evidence: a `@media print` or unsupported `@supports` block,
  a stylesheet whose media attribute does not match, and a disabled sheet are
  all skipped, since none of them describes what the buyer sees. An `@container`
  block is skipped too, for a different reason — no browser API evaluates a
  container query for an arbitrary element — so a tick hidden only inside one
  reads as unresolved rather than being guessed at. And because an
  absolutely positioned tick can render while its host box measures zero, a
  zero-sized marker is checked for a rendered `::after` before its size is
  allowed to disqualify it.

  A rendered marker carrying no signal at all is reported as unresolved rather
  than guessed at, and read like an absent marker: the toggle falls back to its
  input and active state instead of being reported as a disagreement. The same
  applies to a toggle with no marker vocabulary, such as a switch variant whose
  only `aria-hidden` node is its always-rendered slider.

  The verdict payload records how the toggle was read, so an operator looking at
  a misaligned bump can see which element the harness picked and what it made of
  it. `markerResolved` keeps its meaning — whether a marker element was found —
  and the new `markerReadable` says whether that marker's state could actually
  be read; only `markerAgrees` depends on the second. `markerSignal` names the
  reading: `pseudo`, `glyph`, `fill` or `display_toggled` when a state vocabulary
  was recognised, `not_rendered` when the marker is on the page but hidden,
  `unresolved` when it renders but carries no state signal, and null only when
  no marker was found at all. `markerFamily` and `markerTag` record which
  selector matched and what it matched.

  The probe moves to `src/qa-order-bump.mjs` as an `evaluate()` body, the
  shape `qa-cart-entry.mjs` already uses, so the real-browser proof over
  `fixtures/qa-order-bump/` drives the same function the QA runner does.

## [1.25.0+agent.15] - 2026-09-12

### Added

- `docs/qa-and-test-orders.md` gains "What a published anonymous record is":
  because the public runner carries no ingest credential, a published verdict
  or remitted Run Record is stored `trusted: false` / anonymous, and such a
  record is an **unverified submitted claim** — it records what the submitter
  reported, not that a run happened or that its artifacts reflect real
  observations. The receiver accepts posts publicly after shape, size, and rate
  checks and verifies nothing it is told; a fabricated verdict passes every
  schema check, as the standing negative control in
  `src/qa-verdict-schema.test.mjs` demonstrates. Any launch decision therefore
  needs independent execution evidence — the run's own attributed local
  artifacts — and campaigns-os#329 tracks the attributed-publishing credential
  path. The trust stamps, the readback chokepoints, and every gate are
  unchanged; this is documentation of behaviour that already ships.

## [1.25.0+agent.14] - 2026-09-12

### Changed

- `docs/design-source-package.md` states what happens to a page that is
  template stock rather than a standalone design, and makes the answer
  family-dependent. `template_baseline` coverage is the honest route, and the
  proof behind it is published by the family's catalog entry. A family carrying
  a complete Template Reference — today `apollo` alone — has a supported intake
  path: declare the template-derived pages out of source scope (a per-page
  `skip_reason` manifest entry, or `build_scope.mode: "partial"`) and synthesis
  emits `template_baseline` coverage for them. That path is a partial build and
  carries partial-build limits: `prepare_build` ends `completed_partial`, the
  pages are recorded under `declared_out_of_scope` and `derived.scope`, only
  mapped routes are previewable, and checkout launch and test-order proof stay
  blocked. For every other family there is no `template_baseline` to synthesize
  and no operator channel at all; policy: none is coming in v0, and those pages
  are build-stage work handled by `next-campaigns-build`. The README Quick
  Start's `DESIGN_SOURCE_PACKAGE_NOT_READY` note now says the same, so the
  example neither promises screenshots as the universal way through nor hides
  the `apollo` path. No gate, code, or schema changes.

## [1.25.0+agent.13] - 2026-09-12

### Changed

- Policy: fabricated social proof and over-maximum discount copy stay doctor
  warnings, and the docs now say so plainly. `docs/campaign-build-brief.md`
  gains a "Content Claims Are Reviewed, Not Enforced" section naming what is
  warning-only (every content anti-pattern under the `content_residue.anti_pattern`
  warning code — finding ids `invented_counts`, `verified_buyer_chrome`,
  `byline_persona`, `borrowed_authority`, `press_marquee`, `science_theater` —
  plus `template_contract.discount_claim_residue` /
  `discount_claim_unverified`), stating that nothing downstream reads them — no
  blocker, no `blocked_stages` entry, no QA assertion, no order gate — and that
  responsibility for the claims sits with the operator and the client. The
  `content_residue.anti_pattern` warning text no longer says "Detection fails
  closed", which read as though something later in the ladder would stop the
  build; it now says it is a review warning that nothing blocks on. Severity,
  finding ids, detection, and every other message are unchanged.

## [1.25.0+agent.12] - 2026-09-12

### Added

- Every QA and doctor finding now carries a cause class, so a run can say
  whether the change under test caused what it surfaced. `cause` is one of
  `caused_by_change`, `pre_existing`, `test_environment`, `upstream_drift`, or
  `unknown`, and `cause_reason` carries a short machine-readable reason. Both
  are additive and optional: output emitted before this carries neither, and
  absence is not a claim that nothing was caused by the change.
  The classification is mechanical and uses only what the toolkit already
  records. The previous run is found through the existing Run Record discovery
  — the most recent record under the Build Packet's
  `.campaign-runtime/run-records/` whose `identity.map_id` matches, and only
  the first match, so nothing is ever compared against a non-adjacent run. QA
  findings are compared against that record's LAST `qa_verdict` artifact: a run
  that needed repair and re-test carries one reference per attempt in session
  order, and the first is typically the blocked attempt, so comparing against it
  would report a defect fixed before that run closed and reintroduced now as
  pre-existing. Doctor findings compare against the record's
  `observations.doctor` code lists, which every Run Record already carries. The fingerprint is the identity each artifact already uses:
  `family | id | page` for a QA assertion (no URL, so a local run and a
  published run compare like for like) and the `code` for a doctor issue.
  Same fingerprint and same status is `pre_existing`; absent, or present with a
  different status, is `caused_by_change`. Two classes are decided from the
  finding alone and win outright: the runner's own environment outcomes (the
  order-creation budget safety stop, a `<leg>:runner` capture failure) are
  `test_environment`, and an already-detected SDK-pin disagreement
  (`page_kit.sdk_version`, `.waived`, `.spec_conflict`) is `upstream_drift`.
  Anything that cannot be classified from recorded data is `unknown` with the
  reason stated — including every finding of a first run on a campaign, which
  has nothing to compare against.
  The labels ride the full verdict, the derived exceptions, the committed QA
  verdict sidecar, and every doctor result; `cause_summary`
  (`{surface, total, counts, prior_run_id, comparison}`, plus
  `prior_qa_attempt_run_id` on the QA side) rides the verdict and the doctor
  output. `prior_run_id` is the previous Run Record's id on both surfaces so
  the two agree on which run was compared, and the QA summary names the final
  attempt within that record it actually read. A report that could not compare
  says which of the four reasons applied and names the record when one exists,
  rather than telling an operator who already has a prior record to wait for a
  second run. Doctor classification is applied where the doctor result is
  produced, not in one command, so all four producers that persist
  `.campaign-runtime/doctor-output.json` (`doctor`, `next`, `prepare-build` /
  `start`, and the QA stage refresh) leave the labels on the retained artifact
  — running QA after doctor no longer strips them back out. Non-packet doctor
  (`--built` / `--site`) has no Run Record home and is not annotated. The human
  reports lead with a one-line tally and tag each finding. Passing assertions
  carry no cause — a pass has no cause to explain.

### Changed

- `readRunRecordsForTarget` and `orderRunRecordFileNames` moved from
  `src/cli.mjs` to `src/run-record.mjs`, where the records directory constant
  already lives, and are re-exported from `src/cli.mjs` unchanged. One
  implementation, now reachable from the QA runner, which cannot import the
  CLI. No behaviour change.

## [1.25.0+agent.11] - 2026-09-12

### Added

- `campaigns-os next` now says, from the build stage onward, that a campaign
  with no brand tokens will block browser QA on the starter palette. The theme
  gate passes such a campaign (`theme_gate.nothing_generatable`: nothing could
  be generated, so nothing is applied) while QA reads that same pass as "a
  brand layer is in place" and runs the template-residue checks at blocker
  severity — so `qa run` blocks on `template-residue:<page>:style:*` rows for
  the starter call-to-action colour. Both halves are unchanged and deliberate;
  what was missing was that nothing in between said so, so the decision got
  made after a blocked verdict instead of before one. `next` now carries a
  non-required `theme_gate.starter_palette_blocks_qa` entry in `next_actions[]`
  at the `build`, `polish`, `deploy` and `qa` stages naming both lanes that
  clear it — `campaigns-os theme waive` (downgrades the rows to warn) or a
  hand-authored `brand-theme.css` loaded after `next-core.css` — and the
  non-JSON tiny prompt prints the same warning. No severity changed, nothing is
  auto-waived, and a waived or applied gate emits nothing.
- The warning is scoped to campaigns QA would actually block. It is emitted
  only when the packet's `assembly.template_family` resolves to a brand
  contract that carries both forbidden computed colors and commerce selectors
  to inspect them on — the same predicate the browser runner uses, now shared
  as `paletteResidueStyleChecks` / `contractHasPaletteResidueChecks` in
  `template-brand-contract.mjs` rather than derived twice. A `custom` or
  `undecided` family, or any family the catalog carries no contract for, emits
  no `template-residue:*:style:*` rows at all, so those campaigns are not told
  to clear a block that will never happen.
- A second non-required action, `theme_gate.brand_contract_unreadable`, at the
  same four stages, when the family's brand contract exists but fails to load
  (`parse_error`, `schema_mismatch`, `extends_cycle`,
  `extends_missing_parent`, `family_mismatch`). It names the family and the
  error code and says browser QA rejects such a contract outright as a
  `template-brand-contract:<family>` blocker that no waiver clears. A defect is
  distinct from a family that resolves to no contract, and it is reported
  regardless of the theme gate's outcome, because QA rejects the contract
  whether or not the campaign has brand tokens. `next` still never throws over
  a defective contract. Every value interpolated into that description is
  bounded before it is printed or serialized: the family must match the
  lowercase template-family slug (or it reads `unknown-family`), the code must
  be one of the loader's own (or `unknown`), and the loader detail is folded to
  one trimmed line with control characters stripped, Markdown escaped, and
  length capped. The repair path names
  `contracts/template-brand-contract.<family>.v0.json` only when that file is
  on disk, and otherwise says the private fragment supplying it.

## [1.25.0+agent.10] - 2026-09-12

### Fixed

- The `run-record` closeout `qa run` prints as `Required next:` now carries
  `--no-remit` whenever the attempt does not end the run session — a **blocked**
  verdict, or any disposition this version does not recognise. Remit is a plain POST with no
  replace verb, and the receiver keeps one record per `run_id`: a second POST
  for an id it already holds comes back `409 run_record_conflict`. A blocked
  verdict keeps the run session open, so the printed command inherited that
  session's `run_id` — and executed exactly as printed it published the interim
  record, leaving the session's own close (the record carrying every QA attempt
  and the aggregated lifecycle) refused at the door. The run that mattered ended
  `remit_state: failed` locally while the canonical side kept the earlier,
  thinner record. The session now owns the one accepted send for its id.
  A session-ending verdict is unchanged: it auto-ends the session in the same
  process, before the printed command can run, so that command mints its own
  `run_id` and remits — as it does with no session at all. Which dispositions
  end a session is now one exported set (`SESSION_ENDING_DISPOSITIONS`) read by
  both the auto-end and the closeout, enumerated rather than excluded: an
  unrecognised disposition keeps the session open on both sides instead of
  letting them disagree about who owns the `run_id`.
- When a session's auto-end assembles its record but the remit does not close,
  the auto-end now says so and names the local record to keep. It deliberately
  does not print a re-send command: `run-record --run-id <id>` reassembles the
  record from current disk state rather than reloading the one already written,
  and a session's QA attempt references survive only on the session, which the
  auto-end has cleared. On a run repaired across several QA attempts that
  command therefore replaces the stored record with a thinner one and sends
  that. The same caveat is now stated beside the `run_record_remit_recovery`
  action in the remit docs. Re-sending a persisted record is not implemented.
- The comments and docs describing the remit endpoint as upserting on `run_id`
  are corrected to what it does. Idempotency is enforced by refusal, not
  replacement: a send that never landed can be retried (which is what the
  `run_record_remit_recovery` action does), a send that landed cannot be
  revised.

## [1.25.0+agent.9] - 2026-09-12

### Fixed

- A `qa run` that spends its `--max-order-creations` budget no longer reports
  the stopped path as a blocker, and no longer finalizes `blocked`. The
  budget-stop assertion was emitted with `status: fail` and
  `severity: blocker` — byte-identical to a checkout the runner watched fail —
  so `computeDisposition` turned any budgeted run whose budget ran out before
  the last planned path into `blocked` (exit code `4`), and the only thing
  separating a deliberate safety stop from a broken checkout was the assertion
  text and an `evidence.order_creation_budget` key that no disposition code
  read. Nothing is submitted for a budget-stopped path, so it is now recorded
  as `manual_review` at `warn` severity, the vocabulary this runner already
  uses for a hosted-checkout redirect: a path a human decides, not one the
  runner proved either way. Such a run finalizes `ready_with_exceptions`, and
  the unexercised path rides in `exceptions[]` so it can never be mistaken for
  a clean `ready`. The assertion text and the `order_creation_budget` evidence
  are unchanged, and a genuine order-creation failure is still a blocker that
  blocks.

## [1.25.0+agent.8] - 2026-09-12

### Fixed

- `browser-primary-cta` recognises the Campaign Cart SDK's own add-to-cart
  control as a route CTA (campaigns-os#321). A `<button
  data-next-action="add-to-cart" data-next-url="/…/checkout/">` carries no
  `href`, so the recogniser read it as "no CTA to the next route" while a
  plain `<a href="/checkout/">` that bypasses the SDK cart passed — the
  incentive was backwards. The primary-CTA assertion and the typed-card
  ladder's `entered_via_landing` step now share one cart-entry vocabulary
  (`CART_ENTRY_CONTROL_SELECTOR`, `CART_ENTRY_ROUTE_ATTRIBUTE` in
  `qa-cart-entry.mjs`): on an SDK cart-entry control, `data-next-url` is the
  route — resolved against the origin as the SDK does, and absent means no
  route, since the SDK never lets such a control navigate by `href`; on any
  other element the attribute has no navigation meaning and the anchor's own
  browser-resolved `href` (so a `<base href>` is honoured) stays
  authoritative. `advanceToCheckoutForm` locates through the same selector
  instead of its own copy. Readability and size checks are unchanged.

## [1.25.0+agent.7] - 2026-09-12

### Removed

- The undocumented `validate-build-packet` alias of `doctor`. It was never on
  the supported surface (`docs/supported-surface.md` records it as unsupported),
  had no skill, doc, fixture, or test reference, and `doctor` is the only
  spelling the guides teach. Invoking it now gets the did-you-mean error every
  unknown command gets. Known consumer: the private ops repo's `campaign-os`
  shim and skill delegate the alias verbatim; retarget those to `doctor`
  before bumping that repo's campaigns-os pin past this release.

### Changed

- `start`, `build`, and `prepare-build` share one dispatch body parameterised
  by mode (`start` = prepare + doctor + agent context, `build` = prepare +
  doctor, `prepare-build` = prepare only); `standardize` and
  `standardization-report` share one branch. Behaviour, flags, output, and
  the known-command list are unchanged — the three intake bodies were
  byte-identical except for the two booleans.
- Internal dead code removed on the strength of the 2026-09-12 architecture
  review: the orphaned `packageCardSelectors` composer in the QA runner (its
  only caller left in #307; best-effort `--cart` selection now composes its
  selector through the same `packageCardClickSelector` the strict path uses),
  seven alias re-exports in `design-source-package.mjs`, dead status enums in
  `qa-route-probe`, `theme-gate`, `run-record-closeout`, and
  `qa-analytics-parity`, the unused `commercialPageIds` helper in
  `qa-commercial-parity`, and an unused import in the CLI. Three
  polish-toolkit constants and one helper that nothing imported are no longer
  exported, and `polish-node` now compares the browser-unavailable error
  against the exported `POLISH_BROWSER_UNAVAILABLE_ERROR_CODE` instead of a
  string literal. None of these is on the supported surface.

## [1.25.0+agent.6] - 2026-09-11

### Added

- The typed-card runner gains a cart entry step, `entered_via_landing`, as the
  first rung of the ladder (campaigns-os#206, runner half). A checkout that
  carries its own package selection surface skips the step and runs exactly the
  ladder it always ran. A checkout that carries none — the `shop-single-step`
  shape, where the landing page fills the cart and the checkout only displays
  it — is entered through the funnel's landing/entry page: the runner resolves
  it from the same topology the ladder already uses, clicks the SDK add-to-cart
  control (or the `?forcePackageId=` checkout link the certified template
  renders), honours `--select-package` strictly, and waits for the SDK to land
  on the checkout URL rather than opening it itself. The step records the
  landing URL, the control text and kind, the package id, and how the entry
  page was resolved. Its failures are named — `cart_entry_unresolved`,
  `cart_entry_control_missing`, `cart_entry_no_navigation` — and fail inside
  the step budget instead of as a 45 s timeout. Until now the runner could not
  place an order on this family by construction.
- An empty-cart guard on `order_submitted`. Immediately before the creation
  reservation and the submit click, the runner reads the SDK cart
  (`window.next` first, `window.nextDebug.stores.cart` second, the observed
  cart-API response third) and refuses a zero-item cart with
  `cart_empty_before_submit`. No click is made and no creation slot is
  reserved, so the failure classifies as `not_created` under the #316 budget
  semantics and keeps its bounded re-run. An unreadable cart is not treated as
  empty. There is no flag to skip the guard.
- `docs/qa-and-test-orders.md` documents both, the evidence each step carries,
  and the four failure codes.

## [1.25.0+agent.5] - 2026-09-11

### Changed

- `polish capture` attributes a failed request before judging it. A
  `Network.loadingFailed` used to flip the whole response collection to
  `failed`, which made every route and viewport `capture_incomplete` — the
  nonwaivable block built for browser crashes and missing routes — even when
  the only failure was a cross-origin analytics beacon in the merchant's tag
  container that has nothing to do with hidden media. A failure is now
  classified by the failing resource's origin relative to the final document
  and by its role. `cross_origin_request_failed` covers a cross-origin request
  in a beacon-class role, an explicit allowlist of `ping`, `fetch`, `xhr`,
  `other`, and `preflight`; it is recorded on the resource ledger and surfaced
  as a warning, and the capture stays complete so the checkpoint is evaluated
  on its merits. `dependency_request_failed` covers everything else — the
  document response, any first-party resource, and any cross-origin resource
  outside the allowlist (`script`, `stylesheet`, `image`, `font`, `media`, and
  also `texttrack`, `manifest`, `eventsource`, `cspviolationreport`,
  `prefetch`, `signedexchange`, `websocket`, or an unresolved type); it still
  fails the collection and still blocks unwaivably. `request_failed` is
  retired in favour of the two attributed codes.
- A failed request is no longer also counted as `transfer_size_unavailable`
  or in the ledger entry's `unmeasured_request_count`: a request that never got
  a response has no transfer size by definition, and attributing the failure
  once is the whole point.
- Page-load evidence gains `measurement.warnings[]`: one entry per complete
  capture that carries a warning-class problem, with the route, viewport, the
  warning `problem_codes[]`, the bounded sorted `failed_origins[]`, and the full
  `failed_origin_count`. `polish capture` text output prints these under
  `Capture warnings (not blocking):` with the safe origins and a
  `shown of total` count whenever the printed list is shorter, so an operator can
  see a failing merchant pixel without opening the assembly report. Warnings
  never change `measurement.status`.
- The ledger-tied shape invariants keep both attributed counts honest: each is
  recomputed from the resource ledger's `failed_request_count`,
  `cross_origin_request_count`, and resolved `resource_type`, and a capture
  that declares its collection complete over a ledger-recorded dependency
  failure is `capture_shape_invalid`. A capture cannot self-declare a
  first-party or dependency failure as a cross-origin warning.
- `docs/polish-evidence.md` documents the attribution rule, the warning class,
  and the `measurement.warnings[]` projection.

## [1.25.0+agent.4] - 2026-09-11

### Changed

- `next-campaigns-build` recommends **build → independent review → repair →
  verification** as the normal campaign build shape. The director selects models
  by required capability and consequences of failure, then prefers cheaper
  suitable models for bounded work. Review uses source material and rendered or
  runtime evidence. Two repair-and-verification rounds that leave the targeted
  finding or failing required check unresolved trigger reassessment or surfacing
  the blocker. The loop preserves the existing Polish and QA stages. If delegation
  is unavailable or disallowed, the fallback is an in-session self-review with
  disclosure that no independent agent reviewed the result.
- `next-campaigns-os` points to the loop at the build handoff. Skill versions
  advance to `next-campaigns-build` 1.0.1 and `next-campaigns-os` 1.0.8.

## [1.25.0+agent.3] - 2026-09-11

### Changed

- A failed typed-card path is no longer re-run unconditionally. The runner now
  classifies what the attempt did to the store first — `not_created`, `created`,
  or `ambiguous` — and only `not_created` earns the bounded one-per-path re-run.
  A failure that happened *after* the order was created, which a receipt whose
  line items never became buyer-visible is the common case of, used to open a
  fresh page, refill the form and click submit again: it bought the same thing
  twice for a failure the buyer had already paid for. That path now gets a
  read-only recovery pass instead — reload the receipt the order already
  produced, re-read the persisted order, re-check the buyer-visible receipt
  surface and the voucher read-back. It clicks nothing, applies nothing and
  submits nothing, because re-driving an upsell or re-applying a coupon would
  mutate the order under inspection. An upsell-action failure therefore cannot
  be cleared by recovery and is reported as having survived it.
- Anything the runner cannot prove was not created is `ambiguous` and is never
  resubmitted: a ref id whose read-back is unusable, a submit whose create
  outcome never arrived, a create that failed at the network level after it was
  sent, and — the one that reads as a clean rejection but is not — a 4xx that
  follows an earlier 2xx on the same endpoint, which the "most recent response
  decides" rule reports as `order create rejected` while an order exists. Those
  paths stop and name the operator check (look for an existing order against the
  run's QA email or the observed ref id) rather than risking a duplicate
  purchase. A hosted-checkout `manual_review` is still never re-run.
- Passing after recovery stays distinguishable from passing first time, which is
  the property the retry it replaces established. The assertion carries
  `evidence.order_creation` — classification, reason, action, and two counts
  that are not the same number: `submissions_reserved`, the platform-side
  creation slots charged to this path — reserved before a submit click, or
  charged for a hosted-checkout redirect where no submit click happens — which
  stand whether or not the create that followed succeeded; and
  `orders_confirmed_created`, the creates the platform was observed to accept. A spent slot with no confirmed order is
  the ambiguous case, not an order to reconcile, and reporting only the first
  would let it be read as one. It also carries `evidence.recovery` with the
  original failure, the checks that were re-run, and whether it cleared.
- Whether an order create succeeded is decided from the whole event log, counted
  once while the runner still holds it. The copy that travels in the evidence
  payload keeps the last 20 entries per stream, and on a multi-offer path the
  upsell and cart traffic that follows a successful create evicts that create
  from the retained window — so a decision read from the truncated copy would
  see a bare rejection, call the path `not_created`, and submit again against a
  store that already holds the order. The create the platform accepted also
  supplies the ref id the operator check names, even when the failed order row
  carries none.
- A re-run is bounded twice over: once per path per run, and never with a
  creation slot a still-unrun planned path needs. Under the default budget a
  path whose submit was *rejected* has already spent its own slot, so it is not
  re-run and its assertion records why under
  `evidence.order_creation.rerun_skipped`; raising `--max-order-creations` buys
  those re-runs back. A re-run that stops on the budget never becomes the
  deciding result — it proved nothing, and reporting it would erase the real
  failure and claim nothing was submitted about a path that did submit.
- The recovery pass may only clear a failure on evidence it actually re-read. A
  persisted-order read-back that fails, or never happens, is itself a remaining
  failure, and the receipt-rendering and voucher checks are recorded as not
  re-assessed rather than re-decided against the original attempt's numbers. It
  also re-checks the coupon from the plan being recovered rather than from the
  run-level flags, because `--test-order tiers` refuses a run-level
  `--apply-coupon` and carries each coupon on its plan.

### Added

- `qa run --max-order-creations <n>` bounds the number of **real order
  creations** in a run and defaults to the planned path count.
  `--max-test-orders` never bounded purchases: it caps planned paths before the
  browser launches, and its own error text used to concede that "the worst case
  is twice this many real orders". The new budget is reserved immediately before
  each submit click rather than reconciled afterwards, so an exhausted budget
  stops the path instead of being discovered by counting orders. It is built per
  run, so two runs against two targets cannot spend each other's budget. A
  budget stop carries its own assertion text and its own
  `order_creation_budget` evidence: it is a safety stop the runner chose, and a
  supervisor must not read it as a broken checkout. The value is validated on
  the budget itself, so every path that can create a real order is covered —
  `qa run` and `qa parity` alike, and any caller added later: a non-numeric,
  fractional, negative, or zero `--max-order-creations` is refused with an error
  naming the flag, rather than falling through to the default budget while the
  operator believes the run is capped.

### Fixed

- The read-only recovery pass recognizes a persisted-order read-back whether or
  not the server sends a trailing slash, and whether or not the URL carries a
  querystring — the same shapes the canonical order patterns already admit.
  Against a server that omits the slash the pass previously saw no read-back at
  all, recorded every check as not re-assessed, and could therefore never clear
  a blocker it had in fact re-verified. All three read-back call sites now share
  one named pattern instead of three hand-rolled copies.
- A hosted-checkout `manual_review` charges the creation budget unconditionally.
  The charge was skipped whenever the submit seam had already reserved a slot,
  so a redirect that followed a reservation went uncounted even though the
  platform may have created an order behind it — an exception the documented
  "a manual review charges the budget" never admitted.

## [1.25.0+agent.2] - 2026-09-11

### Fixed

- `next` now reads `.campaign-runtime/run-records/` and stops demanding a Run
  Record that already exists. At stage `done` it emitted a required
  `run_record_closeout` unconditionally, because nothing in the CLI had ever read
  that directory — a shadow-campaign validation run ended with a record already
  assembled, closed and remitted, and was still told to make one. A record
  satisfies closeout only when its identity matches the packet, it is not older
  than the report's doctor/QA evidence, it references the QA verdict the report
  currently points at, and its remit closed (`ok`, or `skipped` for the
  consent-off / `--no-remit` local-only path). Missing, foreign-campaign, stale,
  and outdated records still get the required closeout; a failed or unfinished
  remit gets a distinct `run_record_remit_recovery` action that re-runs
  `run-record` against the existing `run_id` rather than minting a second record.
  Any doubt — an unreadable record, an unrecognized remit state — emits the
  closeout. An ambient run session still wins, exactly as before.
- The QA producer now owns `stages.qa.verdict_run_id` and `stages.qa.evidence`.
  Only the canonical fields refreshed before, so a stage could carry a passing
  status and current output links beside a previous run's id and an
  `evidence.remaining_blocker` describing an already-fixed bug. The previous pair
  is preserved, not deleted: it moves into a bounded `history[]` on the same
  stage with its own original status and timestamp, and a stage that had no
  `checked_at` yields a history entry with none. Unrelated extension fields
  (`waivers`, and anything written out-of-repo) pass through verbatim.

### Added

- Each QA run records a counts-only purchase-proof summary on
  `stages.qa.purchase_proof` (declared order-path and typed-card depth, order
  paths executed, orders created, orders verified, all-test-mode). No order id,
  ref id, email or URL is in it — this artifact is committed and rides into the
  readback bundle, where the verdict's own order arrays are emptied. `next` now
  refuses `done` when the packet declares an order-path depth and the summary
  records zero executed paths, so a `--test-order off` diagnostic can no longer
  be presented as common-depth purchase proof. An **absent** summary — every
  report written before this — is unknown, not unmet: it produces a non-required
  advisory and never un-finishes an existing campaign. A declared depth of `off`
  keeps intentional no-order diagnostics unchanged.

- Purchase-proof coverage now reports `unknown` when the build packet and the
  assembly report disagree about the declared order-path depth, instead of
  silently preferring the packet. A corrupted or stale mirror of the depth can no
  longer decide the gate from one side alone.
- The run-records scan reads a campaign's full history rather than the newest 50
  file names, and orders run ids by their parsed timestamp rather than
  lexicographically. An older matching record no longer reads as "no record", and
  ordering no longer depends on every run id having the same digit count. Reads
  stay bounded and a malformed record is still ignored rather than fatal.

All fields are additive under the assembly-report stage definition, which already
permits additional properties. No schema changed and no surface version moved.

## [1.25.0+agent.1] - 2026-09-10

### Added

- `start`, `prepare-build`, `install-agent-context`, and `run start` write a
  managed ignore block into the target's `.gitignore` for the machine-local
  half of `.campaign-runtime/` — `run-session.json`, `command-lifecycle.jsonl`,
  `agent-deviations.jsonl`, `workflow-findings.jsonl`, `run-records/`,
  `fetched-specs/`, `polish-evidence/`, `evidence/`, `*.log`, `*.tmp`. Written
  once, keyed on a marker line, list editable beneath it. The readback bundle
  (`build-context`, `assembly-report`, `doctor-output`, `qa-verdict`),
  `input/`, `theme/`, `agent-context/`, and `setup-handoff.json` are
  deliberately not ignored: they are the campaign's committed handoff. Three
  campaign repositories were found carrying another machine's session file,
  journals, and deviation logs; nothing had ever written the rule.

## [1.25.0] - 2026-09-10

### Added

- The partner entry path is now on the supported surface: `next`, `theme`,
  `tooling`, `install-skills`, `install-agent-context`,
  `validate-assembly-report`, and `telemetry` join `cli_commands`. The public
  guides already instruct `install-skills`, `tooling status`, and
  `next --packet` as the first steps; until now those three carried the weakest
  compatibility promise in the repo. `validate-build-packet` stays an
  undocumented alias of `doctor` and is not promoted.
- Run Records stamp toolkit provenance: `surface_version` (from
  `contracts/supported-surface.json`) and `toolkit_commit` (package.json
  `gitHead` on git-dependency installs, else the checkout HEAD). Both nullable;
  every record to date carries `package_version: 0.1.0-alpha.0`, so this is the
  first version signal a consumer can segment on.

### Changed

- `check-supported-surface.mjs --base` now owes a `surface_version` bump when
  `cli_commands` membership changes, not only when hashed or named entries do.
  `checkpoint` (a9e1022) landed on the surface with no bump under the old rule.

## [1.24.0+agent.1] - 2026-09-10

### Fixed

- Run Telemetry remit now sends the packet's Campaigns API key as
  `X-Campaign-Key`, so the receiver stamps the tenant hash its scoped listing
  joins on. Since the receiver tenant-scoped `GET /api/runs` (2026-08-31),
  every record this CLI remitted was stored but invisible to every tenant scope.
- Stale run sessions (idle past 12 hours) are closed out instead of abandoned:
  `start`, `prepare-build`, `build` (at `--target`) and `run start` / `run end`
  (at cwd) assemble the stale session's Run Record and remit it under consent
  before opening a new session. Sessions previously only auto-closed on a ready
  `qa run`, so most real runs left no record at all.
- `telemetry status` no longer says "defaults OFF" when consent is unresolved;
  it distinguishes the default-on canonical endpoint from a malformed config or
  scope mismatch, where remit really is off.

### Added

- `campaigns-os telemetry list` reads stored Run Records back: `--packet` for
  the tenant scope (via the packet's campaign key), otherwise cross-tenant via
  the ops admin key in `CAMPAIGN_OPS_ADMIN_KEY` (or `--admin-key-env <VAR>`).
  `run status` reports a stale session file; `run end` reports a closeout.

## [1.24.0] - 2026-09-10

### Added

- Run Records now distinguish summed active command time (`duration_ms`) from
  the full elapsed run span (`wall_clock_duration_ms`).

### Changed

- Explicit Build Packets select the matching run session from the target repo,
  toolkit, or another project directory, while simultaneous campaign sessions
  fail closed on conflicts. Blocked QA attempts keep the session open for
  repair; final closeout references every attempt.
- `doctor` and `qa run` now own their matching Assembly Report stage status,
  current evidence paths, and producer timestamps. They never infer historical
  completion from artifact presence.

## [1.23.0] - 2026-09-10

### Fixed

- Fresh intake and QA projection now agree on one canonical CampaignSpec
  material identity without changing the existing raw-byte integrity hashes.
  Safe `./` repository-relative packet spellings normalize consistently, while
  traversal, absolute paths, URIs, foreign QA/spec material, and mixed producer
  generations fail closed. Stored pre-material bundles retain an explicit
  strict exact-hash compatibility path.
- `bundle check --require-qa` rejects a shape-valid QA sidecar whose disposition
  is still `blocked` and emits `stage_blocked: true`, so consumers cannot mistake
  coherent evidence for a completed handoff.

## [1.22.0+agent.1] - 2026-09-10

### Fixed

- Spec-driven checkout proof now keeps repeated quantities for the same package
  reference as distinct purchase cases. Strict selection requires an exact,
  unambiguous rendered package composition and verifies that the chosen card
  entered its selected state before checkout can continue.
- Persisted-order reconciliation now distinguishes a package's unit composition
  from its purchase multiplier, rejects quantity drift, and prefers requested or
  rendered package identity when duplicate SKUs would otherwise be ambiguous.
  Total parity also reads the maintained Demeter order-summary total; an absent
  total remains skipped rather than passing.
- Voucher proof is unchanged: a line-price delta remains explicitly weak
  evidence when the persisted order exposes no authoritative voucher identifier.

## [1.22.0] - 2026-09-09

### Added

- Added the supported `@nextcommerce/campaigns-os/legacy-migration` subpath and
  strict v0 inventory, preview-plan, and receipt schemas for bounded Campaign
  Cart SDK 0.3.x shadow migrations. The pure helpers normalize keyed rows for
  stable hashes, reject credentials and package merchandising, build Offers
  create bodies from resolved package keys, compare canonical Offer/package
  readback shapes, and project token-free receipt evidence.
- Offer intents ship in v0. Migration Offers must name explicit package keys;
  `all_packages` is refused even though the upstream API supports it, so a
  migration cannot silently capture packages added later.

### Changed

- Bumped the supported surface to `1.22.0` for the additive package and schema
  exports. Authenticated transport, preview/apply execution, audit and receipt
  persistence, sessions, deletes, and rollback remain connector-owned.

## [1.21.0] - 2026-09-08

### Added

- Canonical page QA compares bounded static Campaign Cart credential declarations with expected configuration. Evidence is credential-free and explicitly does not establish runtime execution or a unique Campaign App ID. Conflicting, dynamic, unavailable and missing declarations require review; a proven credential mismatch blocks. The verdict schema types the additive page-binding evidence.

## [1.20.0+agent.1] - 2026-09-06

### Changed

- A payment-chrome asset edited in place no longer reads as residue. The brand contract keys `default_residue.payment_chrome` on the referenced asset basename, so stripping the unsupported marks from inside a shared strip such as `upsell-payment-logos.svg` left the reference in place and the page still reported chrome it no longer carried. On 2026-09-06 that produced four blockers against two cleaned assets and the repair loop's remedy deleted a cards-only trust strip that was correct. The runner now fetches a referenced `.svg` and, when the served bytes no longer mention the method, records `manual_review` instead of a blocker — the verdict lands on `ready_with_exceptions` and no autonomous repair is dispatched. Anything it cannot read into stays residue: a raster, an asset with no resolvable URL, a failed or non-OK fetch, and any page where the chrome is still visibly rendered. The polish skill and `docs/polish-evidence.md` now state the rule the check is a safety net for — remove or rename a contract-listed chrome asset, never edit one in place.
- A typed-card test-order path that fails is re-run once before it is recorded. On 2026-09-06 `browser-test-order:accept` failed in 2 of 5 browser runs, each time on a build whose adjacent run passed the same path, and the supervisor counted the miss as a new issue and reported no progress after a repair that had worked. The retry is bounded by construction — one per path per run, never for a pass or a `manual_review` — and the retry decides the assertion. Both attempts are recorded in `test_orders[]`, and `evidence.retry` names the first attempt's error and ref id whichever way the retry went, so a path that passed on retry is never indistinguishable from one that passed first time and a failure that reproduces still blocks. This places a second real order on the store for a failing path: `--max-test-orders` bounds planned paths, so the worst case is twice that many real orders, and the cap's own error message now says so.

## [1.20.0] - 2026-09-06

### Added

- The source-html manifest schema declares `pages[].screenshots[]` (with the `screenshot_refs` and `source_screenshot_refs` aliases), the operator channel that supplies desktop and mobile source-screenshot proof to the Design Source Package and clears `DESIGN_SOURCE_PACKAGE_NOT_READY`. `prepare-build` already read it; no schema, doc, README, prompt, skill, or CLI message named it, so a first run that blocked at intake had no documented way forward. `docs/design-source-package.md` gains the operator section "Clearing `DESIGN_SOURCE_PACKAGE_NOT_READY`" (manifest envelope, record shape and the fields the gate reads, what counts as source proof, recovery after a blocked first run, and what the gate does not verify), and the README Quick Start, `prompts/first-build.md`, and the `next-campaigns-os` skill point at it from the intake step. The runtime manifest validator does not read `screenshots[]`, so no manifest is newly refused at runtime; against the published schema the record fields are now typed, and the producer stays more tolerant than the schema (it drops or nulls malformed values instead of failing).

### Changed

- The doctor `DESIGN_SOURCE_PACKAGE_NOT_READY` blocker names the remedy on the two reasons screenshot proof resolves (the missing-proof claim and its blocked `capture-*` TODOs): the manifest `pages[].screenshots[]` channel, the package to remove before rerunning when no downstream stage has consumed it, and the documentation section. Gate evaluation, readiness rules, waiver semantics, and the source matcher are unchanged.

## [1.19.0+agent.6] - 2026-09-05

### Changed

- FunnelHypothesisLength measures both bounds on the trimmed hypothesis, so padding can neither rescue a short value nor sink a long one. Absence detection already trimmed; this aligns the length the rule reports with the value the Map Builder saves (campaigns-os#294 follow-up).

## [1.19.0+agent.5] - 2026-09-05

### Changed

- CampaignSpec `funnels[].hypothesis` is required only when a spec has two or more funnels. A single-funnel spec may omit it; when the field is present the 10 to 500 character bound still applies at any funnel count. The schema already typed the field as optional, so only the FunnelHypothesisLength rule moves. A one-path map no longer needs placeholder text to pass the doctor (#294).

## [1.19.0+agent.4] - 2026-09-05

### Changed

- CI installs without lifecycle scripts and lets the check pipeline compile the working tree once. The final pack check reuses that build; standalone check:pack still runs prepare and compiles fresh output. Missing generated output remains a packing failure.

## [1.19.0+agent.3] - 2026-09-05

### Changed

- CampaignSpec cycle detection reuses fully explored acyclic nodes across starting pages within one check. It preserves cyclic-path traversal, routing precedence, diagnostic order, and freshness between checks.

## [1.19.0+agent.2] - 2026-09-05

### Changed

- CLI dispatch loads the QA implementation only for QA commands. Shell argument quoting remains shared, with the existing QA-module export preserved. Help, doctor, and other commands avoid loading the QA browser stack.

## [1.19.0+agent.1] - 2026-09-05

### Changed

- Doctor and standalone market-copy scans reuse HTML bytes and SHA-256 digests within one invocation. Each new doctor starts a fresh snapshot; failed reads are retried normally. Check ordering and findings remain unchanged.

## [1.19.0] - 2026-09-03

### Added

- **Migration CI and Campaigns Agent now share one strict JSON sidecar-bundle
  contract** (#249). The root `campaign-runtime.build.json`, Build Context,
  Assembly Report, Doctor Output, and projected QA Verdict have canonical paths,
  required/lifecycle-required status, schema identities, freshness fields, and
  cross-artifact identity checks. Packet selection remains based on the root
  packet's `generated_at`, never filesystem mtime.

  `campaigns-os bundle check` validates the base bundle; `--require-qa` makes
  the committed QA projection mandatory after QA. It emits exact file digests
  plus a material digest that ignores only contract-declared timestamps and run
  IDs, so a headless rerun over the same substantive evidence is byte-stable at
  the material layer. Markdown reports and migration-specific scripts may
  coexist but never substitute for missing JSON truth.

  Doctor Output now carries the explicit
  `campaigns-os-doctor-output/v0` schema identity and a producer timestamp. The
  CI recipe preserves authored packet/context/report state, refreshes doctor at
  one checked-out commit, and promotes historical QA only from one explicitly
  named full verdict. A supported production-shaped fixture lets Campaigns
  Agent prove deterministic and real-checkout consumption without a private
  dependency in this repository.

## [1.18.0] - 2026-09-02

### Added

- **Release-ledger digests are now independently reproducible from the
  supported surface** (#264). The generated orientation reference normatively
  specifies the exact `entry_sha256` canonical JSON bytes and the precise
  `changelog_sha256` section boundary, whitespace, and UTF-8 rules. Consumers
  no longer need to reverse-engineer those rules from unsupported `scripts/**`
  implementation.

  A supported generated self-check vector ships the input entry and changelog,
  their canonical byte strings, and both expected SHA-256 digests. The same
  generator now validates the synthetic input entry against the ledger schema,
  and the contract test reproduces the vector and reference together, so either
  artifact drifting from the validator fails CI. The vector uses a reserved
  example identity, labels its shape with `fixture_version`, and makes numeric
  edge behavior and the changelog input's trailing spaces explicit.

## [1.17.0+agent.1] - 2026-09-02

### Fixed

- **CampaignSpec validation no longer warns that a certified Apollo template
  family is unknown** (#280). The authoring-hint rule had a hand-maintained
  family set that predated `apollo` and `apollo-mv-single-step`, while still
  carrying the private-source `limos` and `arjuna` names. A correct Apollo
  CampaignSpec therefore produced a `spec.validation` warning immediately
  beside doctor's certification-ready messages.

  The rule and `TemplateFamilyHint` type now consume one shared list matching
  the eight families in the vendored commerce-surface catalog. Apollo hints
  pass without warning, private-source names no longer masquerade as catalog
  families, and a synchronization test fails if a future catalog refresh adds
  or removes a certified family without updating the hint vocabulary. Unknown
  strings remain valid hints and still warn rather than block.

## [1.17.0] - 2026-09-01

### Changed

- **The runtime recipe's network policy says precisely what it enforces.** No field
  changed: the install step is still `policy: allowlist` against
  `registry.npmjs.org`, the build step is still `policy: deny`, the cache is still
  consumer-owned, and inherited proxy, credential, and npmrc configuration are still
  refused. What changed is the description around them. "Allowlist" was reasonably
  read as a host-level network sandbox; it is a package-manager configuration bound,
  honoured by pinning the registry a package manager resolves from and owning its
  configuration, and it cannot stop a process from opening a socket elsewhere. What
  bounds that is the other half of the recipe — `--ignore-scripts` on both steps means
  no third-party dependency code runs during preparation at all, so the only programs
  executing are the package manager and the compiler.

  The contract now states the guarantee it actually makes, notes that the lockfile
  integrity digests remain the independent second bound, and records that a consumer
  adding a real network sandbox strengthens the policy without changing a field — while
  a consumer treating the declared hosts as advisory violates it. `recipe_revision`
  advances to `1.0.1`; a v1 consumer executes any `1.x` revision, so nothing needs to
  change to keep accepting this document.

  **No argv changed.** `steps[].args` is byte-identical to 1.16.0 — still
  `ci --ignore-scripts --no-audit --fund=false` and `run --ignore-scripts build:spec`.
  The network policy was always something the consumer enforces through the process
  environment it constructs for each step, not something the enumerated commands carry,
  and the corrected prose now says so at `network._note` and in both per-step
  rationales. Carrying the registry pin in argv instead would change the recipe's
  commands, which is a new recipe *kind* rather than a revision — a legitimate future
  design, not something this release does quietly.

## [1.16.0+agent.4] - 2026-09-01

### Added

- **The private-string guard forbids internal issue-tracker IDs** (`SELL-<n>`,
  `NEXTON-<n>`). `scripts/check-private-strings.mjs` already scanned the shipped
  package for internal names and hosts, but opaque tracker IDs were not on the
  list, so they could reach a public consumer through code comments and help
  text. The words "Linear" and "dogfood" stay allowed — the boundary docs
  reference them deliberately ("does not require Linear access") — and only the
  IDs themselves are forbidden.

  Adding the pattern immediately surfaced seven pre-existing leaks: an internal
  tracker-ID prefix on defect-slot comments in `src/cli.mjs` (six) and
  `src/doctor-demo-ref.test.mjs` (one). The prefix is removed and the `R2-Bx`
  slot label kept, so each comment still records which Round 2 defect it came
  from without carrying the internal ID.

  No behavior change: every edit outside the guard list is a code comment. No
  command, flag, output, or exit code moves.

## [1.16.0+agent.3] - 2026-08-31

### Added

- **QA asserts declared checkout offer surfaces, and reconciles a typed-card
  order against what the checkout displayed** (#271, #272). Two real defects on
  one proof build collected a 130-pass verdict between them, for the same
  reason: neither had a check, and the absence of a check reads as a pass.

  That build declared `exit_intent` with a mapped offer code, shipped no
  exit-intent markup at all — only a dangling stylesheet link for the component
  it never included — and no assertion of any kind was emitted about it. The QA
  contract already said browser QA drives that surface; nothing did. Browser QA
  now emits `browser-exit-intent-surface:<page>` and
  `browser-promo-code-surface:<page>` for every checkout page whose CampaignSpec
  declares the surface with `enabled: true`:

  - declared and absent is `FAIL`/`BLOCKER` — the spec promises the shopper an
    offer the built page cannot deliver;
  - declared, present, and carrying the declared `offer_code` is `PASS`;
  - declared and present but not provably wired to that code — or a coupon input
    sitting behind an unopened "Have a coupon?" disclosure — is
    `MANUAL_REVIEW`/`WARN`, because a static page read cannot call it broken;
  - and a browser collector that threw mid-read is `SKIPPED` with the cause, not
    a blocker. The collector did not find nothing, it could not look, and
    reporting that as an absent surface would reintroduce one level up the exact
    silent failure these assertions exist to remove.

  Presence is a DOM-tree question, not a visibility one: the collector walks
  `<template>` content as well as the live document, since a correctly built
  exit-intent pop lives nowhere else until it fires. Scanning only the document
  would report a wired pop as missing.

  The same build also charged a package that appeared nowhere on the checkout: a
  cold visit to a later offer page left it in the cart, the rendered summary
  showed one line, and the persisted order carried two `is_upsell: false` lines.
  The `pricing` family read price surfaces and `browser-test-order` proved the
  journey completed; nothing joined them, so nothing could see a package the page
  never advertised. Typed-card runs now reconcile the two:

  - `browser-order-display-parity:<plan>` fails as a blocker naming any
    `is_upsell: false` line whose package the checkout never rendered as
    selected, and any displayed package that was never charged;
  - `browser-order-total-parity:<plan>` fails as a blocker when the order's
    pre-upsell total disagrees with the displayed summary total.

  Both read the order-create response the accepted-upsell proof already fetches,
  so this is a comparison rather than a new fetch, and both run against the
  pre-upsell read-back — after an accept the persisted lines legitimately carry
  product the checkout never displayed.

  Three deliberate limits, so the new blockers cannot manufacture false ones.
  The rendered order summary is the display authority, and it counts only when
  **every** row exposes its package id: partial `data-package-id` coverage
  reports `SKIPPED` with the reason rather than calling legitimately displayed
  packages stray. Selected bundle cards and active toggles widen only the
  charged-but-not-displayed direction, never the reverse. And an order line with
  no campaign-package equivalent — bonus, gift, trial — is reported as
  unresolved rather than counted as a stray charge, the same tolerance the
  line-price delta already applies.

  A `SKIPPED` here is missing coverage with a stated cause, not a pass. That is
  the whole point of the change, so read it that way: a checkout that exposes no
  `[data-next-display="cart.total"]` surface says so in the verdict instead of
  quietly proving nothing.

  Both assertion sets reuse the existing `browser-runtime` and
  `browser-test-order` families, so the verdict schema, the family vocabulary,
  and the portal allowlist are untouched. Reconciliation failures are their own
  named assertions rather than extra reasons for `browser-test-order` to fail —
  the order was created, and collapsing "created" with "matches what was shown"
  is how a mismatch ends up described as a checkout failure. Both carry blocker
  severity, so an affected verdict still blocks.

  `next-campaigns-qa` 1.0.3 → 1.1.0 records the new assertion ids and their
  severities.

## [1.16.0+agent.2] - 2026-08-31

### Fixed

- **`qa resolve` now probes the routes it derives, and reports what it
  verified rather than what it derived** (#273). Resolve composed every entry
  URL from the packet's `campaign.public_route_slug` and reported `Status:
  ready` without ever asking the deployment whether those URLs existed. Pointed
  at a host serving the same campaign under a different route root it printed
  nine entry URLs and `ready`; all nine were 404. The three checkpoints below
  the route list also said `pass`, because they read the packet rather than the
  deployment, and the printed next command — `qa run --browser --test-order
  common` — could not have succeeded. The existing operator guidance ("empty
  Entry URLs mean a dead preview or a wrong `--base-url`") did not cover it,
  because the URLs were non-empty and all wrong.

  Resolve now sends one `HEAD` per derived entry URL (retried as `GET` only
  when a host answers `405`/`501` about the method) and gains two terminal
  statuses. `routes_unresolved` reports `ok: false`, names the first URL that
  failed, and suppresses the `qa run` suggestion. `ready_unprobed` is the
  degraded state for a run that could not probe at all. The status ladder —
  `blocked`, `routes_unresolved`, `ready_unprobed`, `ready_with_exceptions`,
  `ready` — is ordered by how much of the deployment the run actually verified,
  which is why an unprobed route set outranks a named checkpoint warning; the
  warnings stay fully visible in `checkpoint_gates[]` at every rung. A
  `route_probe` block carries per-URL results and one of
  `route_probe.all_resolved`, `route_probe.routes_unresolved`,
  `route_probe.unreachable`, `route_probe.disabled`, or
  `route_probe.no_routes`.

  Adding a network probe to a command that was pure means deciding what offline
  means. An HTTP response saying `404` is evidence about the deployment; a
  transport error is evidence about this machine's network. Only the first
  fails the probe. A run with no outbound network degrades to `ready_unprobed`
  and stays usable with no flag, so resolve remains runnable offline and in CI;
  `--no-probe` exists for hermetic runs that must make no outbound request at
  all, and `--probe-timeout-ms` (default `5000`) bounds each probe. Probing is
  capped at 25 entry URLs, with the remainder reported as `skipped` rather than
  silently dropped, and a blocked checkpoint spends no network at all. Resolve
  stays a diagnostic command and still exits 0 on every status.

  Resolve still appends `public_route_slug` unconditionally — the packet is the
  authority on where a campaign is served, and that is deliberate — so the fix
  is to make the failure legible rather than to add an override. When every
  derived route is dead, one extra probe of the host without that slug
  distinguishes `route_probe.route_root_mismatch` (correct
  `campaign.public_route_slug`, or declare `campaign.route_root`, in the
  packet) from `route_probe.host_also_dead` (the preview itself is down).

- **The theme gate no longer retires itself on a campaign that ships commerce
  pages** (#274). The same `qa resolve` invocation listed a checkout, five
  upsells, and a thank-you page and then reported `not_applicable
  (theme_gate.no_commerce_pages) — Campaign ships no commerce pages`, two
  outputs an operator cannot reconcile. The gate classified from
  `scope.built_pages` alone, so a partial build — which parks declared pages in
  `out_of_scope_pages` — emptied the commerce scope and made the gate's answer
  depend on build scope, the one input it must not key off. A silently
  self-retiring gate is worse than a failing one, and this is the case the gate
  exists for.

  "Ships commerce pages" is now a question about the campaign, not about one
  build's output. `commercePagesFromScope` reads the built pages and the
  declared-but-out-of-scope commerce pages, and the gate result gains
  `commerce_pages_out_of_scope` so an operator can still see which half this
  build did not produce. On the QA path the declared funnel from the spec
  topologies is unioned into the doctor-derived scope rather than being
  discarded whenever any doctor output exists, so a thin or stale
  `doctor-output.json` cannot retire a gate on a funnel whose routes the same
  command lists; `theme_gate.scope_source` now also reports
  `doctor_derived_scope+spec_topologies`. A campaign that genuinely ships no
  commerce page still reports `theme_gate.no_commerce_pages`.

## [1.16.0+agent.1] - 2026-08-31

### Added

- **A bundle selector that sells into the live cart from an upsell page is now a
  blocker** (#270). A `data-next-bundle-selector` binds to one of two baskets,
  and two container attributes decide which. `data-next-upsell-context` binds it
  to the post-purchase order. Without that attribute the selector belongs to the
  shopper's live cart, and `data-next-selection-mode` — which defaults to `swap`
  when absent — decides whether it writes there. On a page whose funnel role is
  `upsell` or `downsell` the second combination is a charge: the SDK's
  bundle-selector runs a cart sync at init, that sync picks a default card and
  applies it in swap mode, and the shopper is billed at the next checkout for a
  package they never chose and which the checkout's rendered order summary never
  shows.

  Nothing objected to this before. The SDK binds the selector without complaint
  because the markup is valid, doctor had no assertion about selector scope, and
  QA had nothing to compare against. It cost a real test order before anyone
  noticed, and it was found by reading an order's line items, not by anything the
  toolkit said.

  `built_output.upsell_selector_scope` is a static check over built HTML —
  no browser, no test order — reachable from both doctor entry points: the packet
  path and `doctor --built`, which is how a page-kit `campaign-build` campaign
  with no hand-authored packet gets inspected. It names the offending
  `data-next-selector-id` and states what the selector will do, because the
  defining property of this defect is that nothing else shows it. A page counts
  as post-purchase from its declared type or from its own `next-page-type` meta;
  either is enough, since disagreement between them is a reason to look harder
  rather than to skip.

  Three decisions worth stating, because each one had a plausible alternative:

  - **It runs on every doctor invocation, not at assembly.** The instance that
    prompted this was introduced by a later human review round, which layered a
    correctly-scoped selector on top of an existing unscoped one and left both.
    A gate that fired only at first assembly would have watched the defect arrive
    and said nothing. For the same reason it blocks whenever the built page
    exists, rather than softening to a warning until the assembly stage is
    recorded terminal the way the neighbouring per-page structure checks do:
    built markup that charges a shopper is not a state that becomes true later.
  - **It is a blocker with a waiver, not a bare blocker.** Registered as the
    fourth `campaigns-os checkpoint waive` gate. The alternative to an escape
    hatch is not a stricter gate; it is a dropped one, the first time a build has
    a cart-scoped selector on a post-purchase page for a reason nobody
    anticipated. A waiver keeps that decision named, bounded, and recorded in the
    assembly report, and it binds to the exact set of offending selectors — a
    second unscoped selector is a state nobody waived, and the waiver goes inert.
  - **`data-next-selection-mode="select"` clears the blocker and raises a warning
    instead.** Every cart write in the SDK's bundle selector is gated on swap
    mode, at init and on click alike, so such a selector provably cannot produce
    the charge. Blocking it would make the gate's own message false about the
    markup it was pointing at. It is not silent either: the selector still prices
    without upsell pricing, which is worth seeing.

  One finding this immediately produces, recorded here because it is larger than
  the gate: **every one of the eight certified template families** — `apollo`,
  `apollo-mv-single-step`, `demeter`, `olympus`, `olympus-mv-single-step`,
  `olympus-mv-two-step`, `shop-single-step`, `shop-three-step` — ships a hidden
  display-only bundle selector carrying neither attribute, across 19 upsell
  offer includes. It is one pattern repeated, not eight separate mistakes: the
  selector is deliberately placed outside `[data-next-upsell="offer"]` so the
  accept button resolves the right sibling, and that placement is correct while
  the missing scope is not. So this gate blocks campaigns built from any
  certified family until the templates carry `data-next-upsell-context` (or at
  minimum `data-next-selection-mode="select"`) on the display selector. The
  repair is upstream in `campaign-cart-starter-templates`, not here.

## [1.16.0] - 2026-08-31

### Added

- **The runtime-readiness recipe is published as an enforced contract** (#248).
  Orientation answers whether a commit is safe to work against; nothing answered
  how that commit becomes a runtime you can actually use, so the commands, the
  accepted tool versions, and the network a preparation is allowed to touch
  lived in a build plan rather than in anything a consumer could read or a check
  could enforce. `contracts/runtime-recipe.campaigns-os-node-v1.json` is now the
  single authority for all of it — the exact argv of both steps, the accepted
  Node and npm ranges, per-step network policy, the enumerated input set, the
  seven mandatory output checks, and the enforced bounds — validated by
  `schemas/campaigns-os-runtime-recipe.v1.schema.json`. This repository publishes
  the recipe as data; the consumer bootstrap executes it. Nothing here executes a
  recipe step, and no implementation module became a consumer dependency.

  Enforcement is fail-closed and matches the orientation limits precedent: an
  unrecognized recipe kind, revision, or safety-critical enum is refused rather
  than interpreted, and a check that cannot be performed counts as failed rather
  than skipped. Both the recipe and its schema are registered as **hashed**
  supported-surface entries, deliberately unlike the orientation policy contracts
  beside them, which are named. A reason-code vocabulary grows additively and can
  live behind a named entry; a recipe cannot, because the rule the recipe itself
  states is that any change to its commands, network policy, tool versions,
  inputs, or output verification is an agent-relevant release event. Only a
  hashed entry makes such a change require `surface_version` to advance in the
  same change.

  Two things the contract records that a plausible reading gets wrong:

  - **The input set is not the compiler config's `include` globs.** Two compiled
    root modules enter transitively through imports and appear in no glob, so a
    fingerprint derived from the globs would cover 36 of the 38 compiled sources
    and still look correct. The contract enumerates all 38 explicitly, and the
    gate compares them against the compiler's *resolved* file list rather than
    against a glob string.
  - **`campaign-spec/dist` is a build output, never a committed artifact.** It is
    untracked and git-ignored; the copy in a published tarball exists only
    because packing runs `prepare`. No baseline for its contents can exist here,
    so verification is self-consistency — inventory, internal hash stability,
    entry-module import, type entry, and input fingerprint — not comparison
    against a hash published in this repository.

  Also stated plainly, because "runtime ready" invites the wrong reading:
  suppressing lifecycle scripts is what makes the install safe, and it is also
  what suppresses the browser download. A prepared generation can build and
  type-check but **cannot run browser QA**.

  Bounds ship with the measurement beside them so a number is not mistaken for
  physics: install 180s against about 3.2s measured, build 90s against about
  0.8s, the whole preparation transaction 450s against about 4s, and two new
  output bounds the performance budget did not carry — 16 MiB and 4,096 files
  against a measured 240,359 bytes across 76 files, so a runaway build is a typed
  refusal rather than a filled disk. They are deliberately generous: they have to
  hold on a cold cache, a congested network, and loaded CI, not just on a warm
  laptop.

  `docs/runtime-readiness.md` and every fixture under
  `contracts/fixtures/runtime-recipe/` are generated from the contract
  (`npm run generate:runtime-docs`), so a stale copy fails CI rather than
  misleading a reader. Each reject fixture is a single-mutation copy of the
  accepted recipe, so a refusal is always attributable to one change. The
  existing hostile-target fixture gained a second invariant rather than a
  parallel tree: preparing it must run the recipe's own two steps and no
  lifecycle script reachable from them, proved against a real packed dependency,
  with a control that fails if the tripwires could never have fired in the first
  place.

## [1.15.0+agent.3] - 2026-08-31

### Fixed

- **Post-merge review fixes for the #266/#267 review findings.**
  - The certified-template gate in `start`/`prepare-build` now prints the
    certification-freshness line for ANY decided family present on the
    vendored catalog — including a family whose certification was waived via
    `--allow-uncertified-template`. The waived path is labeled
    (`certification waived — `) so it can never be mistaken for the
    certified-gate line; doctor's freshness warning behavior is unchanged.
  - The doctor source-preparation check now detects an UNTERMINATED embedded
    frontmatter block — content followed by an opening `---` fence whose
    frontmatter-key lines run to EOF with no closing fence — as a third
    `source_html.prep.frontmatter_residue` variant
    (`unterminated_embedded_block`, severity error). Previously this exact
    docs-promised case fell through both the leading-fence and
    closed-embedded-block detectors.
  - `renderTemplateFreshness` is now total over any input: a null/undefined
    assessment (or missing fields) renders the unknown-state line instead of
    interpolating `undefined`, and a malformed `verified_at` omits the date
    parenthetical instead of surfacing garbage like `(2026-13-45)` in
    operator output.
  - `standardize`/`standardization-report` no longer swallows a
    commerce-catalog resolution failure silently: freshness still degrades to
    null (the report keeps generating), but a one-shot
    `[standardize] freshness suppressed: <reason>` warn per run says why the
    `template_certification_freshness` field is missing.

## [1.15.0+agent.2] - 2026-08-31

### Added

- **Doctor now gates page-kit-ready source with a deterministic preparation
  check** (#262). The source-preparation steps the docs describe — strip
  document wrappers, keep frontmatter as one closed leading block, route
  internal links through CampaignSpec routes — were tacit knowledge that
  `start` accepted unprepared source past silently. A new
  `source_html.preparation` slot in the Doctor Check Registry classifies the
  common failures on every mapped source page: `source_html.prep.document_wrapper`
  and `source_html.prep.frontmatter_residue` block as doctor errors
  (status `blocked`, `next.stage: "collect-inputs"`), and
  `source_html.prep.internal_link_unrooted` warns because CTA rewrites are
  sanctioned build-stage work recorded under `cta_rewrite_policy`. A recorded
  `wrapper_policy: "preserve_document_wrappers"` adapter decision downgrades
  the wrapper finding to a warning. Each code carries a docs pointer
  (docs/source-adapters.md "Source preparation check"); asset-path rooting
  stays owned by the existing `source_asset.*` crawl codes. No CLI argv or
  schema change; doctor issue codes are not surface-pinned, so
  `surface_version` does not move.

## [1.15.0+agent.1] - 2026-08-31

### Added

- **Template certification freshness is now exposed to operators** (#263).
  Certified never said *when*: a family's certification evidence is captured
  against a specific Campaign Cart SDK release, and the CLI surfaced only the
  boolean. Now the vendored commerce surface catalog snapshot carries a
  per-family `verification` block (last-verified SDK version, timestamp,
  evidence key) — copied by the refresh script from the starter repository's
  `template-verification.json` at the same pinned `_synced_from_sha` commit as
  the rest of the snapshot — and the operator surfaces read it:
  - the certified-template gate in `start`/`prepare-build` prints the accepted
    family's last-verified SDK and its delta from the current SDK;
  - `doctor` reports current freshness under `ready` and raises an
    `assembly.template_certification.freshness` warning when the verification
    is stale or unrecorded;
  - `standardize`/`standardization-report` adds a
    `Certification freshness:` line (and
    `identity.template_certification_freshness`) per Page Kit root.

  "Current SDK" is defined from vendored data only: the newest released SDK
  the contracts record — the semver maximum over the SDK support policy's
  `provenance.latest_known_release` and every verification record on the
  catalog snapshot. No live fetches; no new data source. Freshness is
  exposure, not a new gate: nothing that built before is blocked now. Doctrine
  stated in `docs/template-family-contracts.md`: an older evidence record is
  not current certification.

## [1.15.0] - 2026-08-31

### Added

- **The QA Verdict and its committed sidecar are schema'd, and trust semantics
  are documented (#260).** The verdict was the only lifecycle artifact without
  a schema file: its shape lived in `src/qa-node.mjs` — classified unsupported
  by the surface contract — while the receiving Worker re-validated the same
  shape from a hand-maintained copy, so every readback consumer was pinning an
  unversioned contract.

  - **`schemas/campaigns-os-qa-verdict.v0.schema.json`** — the full verdict
    `qa run` writes under `qa-output/` and publishes to the QA portal,
    derived from the emitting code and validated against real emitted
    verdicts. The emitted `schema_version` field stays the literal `"1.0"`
    (it predates the slash-versioned naming and the receiver validates the
    same literal); the contract identity is `campaigns-os-qa-verdict/v0`.
    Additive tolerance is explicit: consumers must accept unknown fields.
  - **`schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json`** — the
    committed `.campaign-runtime/qa-verdict.json` allowlist projection. Same
    `"1.0"` literal (one contract, never a second lineage); the schema pins
    what the projection additionally guarantees — `generated_at`, emptied
    URL-bearing fields, the per-assertion allowlist, and the absence of
    receiver trust stamps.
  - **Trust semantics are documented** in `docs/qa-and-test-orders.md`:
    `trusted`/`trust_level`/`verified_at` are stamped server-side by the QA
    verdict receiver, never emitted by this CLI; `trusted: false` marks an
    anonymous submission — shape-valid but unattributed — and every
    downstream consumer must filter on it or segregate such records. Shape
    validity is not trust.
  - **The readback tooling now enforces that segregation** at its two
    chokepoints: `qa promote` (and any sidecar projection) refuses a source
    verdict stamped `trusted: false`, and `run-record`'s automatic QA-verdict
    inference excludes untrusted records. A forged, shape-valid, untrusted
    verdict rides the test suite as a permanent negative control: it passes
    schema validation and is still refused/excluded.

  Endpoint authentication and attribution are deliberately untouched — they
  land with the receiver's connection contract. No endpoint behavior changed.
  The supported surface grew by the two schemas; nothing was renamed or
  removed.

## [1.14.0] - 2026-08-28

### Added

- **An agent can now orient on a commit of this repo without running any of
  it.** Until now the only machine-readable statement about "what changed" was
  `surface_version`, and the only narrative was this file — both keyed to the
  supported surface. That misses the changes a downstream agent actually trips
  over: a renamed CLI flag, a rewritten contract doc, a reworded skill, a
  changed generated-runtime input, a widened compatibility statement. None of
  those need touch a hashed file, so none of them moved the version, so an agent
  reading only the changelog concluded that nothing happened.

  Four things ship together to close that:

  - **`campaigns-os-tooling-orientation/v1`** — the envelope a consumer
    assembles from Git objects at one resolved commit. Ten semantic groups,
    eight terminal outcomes, and a stable reason-code vocabulary with one
    documented meaning and one deterministic remedy per code. Integrity,
    freshness, compatibility, runtime readiness, and orientation stay
    independent axes rather than collapsing into a single boolean.
  - **An append-only release ledger** (`contracts/release-ledger.json`,
    `campaigns-os-release-ledger/v1`). One entry per accepted release or
    reviewed amendment, one change item per agent-relevant semantic change,
    same-surface changes included. Entries carry no commit identifier — an entry
    cannot name the commit that contains it without being rewritten afterwards,
    so a consumer derives the introducing commit from history instead.
  - **A two-way release gate** (`scripts/check-release-ledger.mjs`). Every
    agent-relevant changed path has exactly one ledger change item; every ledger
    change item maps to a classified change or an explicit reviewed amendment; a
    surface-version change owes exactly one entry and one changelog section; and
    historical entries are byte-identical to their recorded hashes. The meaning
    of "agent-relevant" lives in exactly one place,
    `contracts/agent-relevant-change-policy.v1.json`, which the classifier, the
    gate, the generated reference, and every test read. The classifier fails
    closed: a changed path that matches no rule, no supported-surface entry, and
    no stated ignore is an error.
  - **Bounded reads** (`contracts/orientation-limits.v1.json`). Source bytes,
    section count, section bytes, envelope bytes, and ledger entries all have
    declared limits. Exceeding one is a refusal with `orientation_too_large`.
    Nothing is ever silently truncated: a partial view of a release is worse
    than no view, because the reader cannot tell which part is missing.

  `AGENTS.md` is the entry point — canonical reading order, the supported
  versus internal boundary, mixed-version rules, and the no-execution rule.
  `docs/orientation-contract-reference.md` is generated from the contract
  fixtures rather than hand-written, so staleness is a CI failure;
  `docs/release-ledger-authoring-guide.md` covers authoring.

  Consumer fixtures ship too: one validated envelope per terminal outcome under
  `contracts/fixtures/orientation/envelope/`, and a hostile target under
  `contracts/fixtures/orientation/hostile-target/` carrying Git hooks, an
  executable file, and npm lifecycle scripts. Every path the hostile target's
  own manifest declares exists in its tree, and its hashed entry records that
  file's real digest, so a conforming read completes rather than refusing on
  integrity: it produces a normal envelope and executes none of the tripwires.
  The hit-counter assertion belongs to the consumer's parser suite; this release
  ships the fixture it runs against.

  One rule is worth stating on its own because producer and consumer do not
  upgrade atomically: **unknown additive fields inside a recognized v1 schema
  are accepted and preserved without interpretation.** Required fields, known
  types, schema IDs, and safety-critical enums still fail closed. An additive
  field cannot grant authority or change the meaning of a known field; a change
  that does either requires a new schema ID.

  Nothing here changes build, polish, QA, or CLI behavior. The supported surface
  grew by two schemas and twenty-seven named entries; nothing was renamed or
  removed.

## [1.13.0] - 2026-08-26

### Added

- **A partial-source build is declarable (#238).** Some active CampaignSpec
  pages carry prepared source HTML and the rest assemble from a certified
  template family — the ordinary shape of a designed campaign on a template
  family — and until now every escape from `MISSING_SOURCE_PAGE` was closed:
  manifest entries required a `path`, a hand-authored `skip_reason` was
  overwritten on the next `start`, removing the manifest destroyed the page
  binding and provenance, and `spec.build_scope.mode: "partial"` was read only
  to phrase a doctor warning. Two declarations now work, and both regenerate
  identically on every run because they derive from the spec and manifest
  rather than from packet state:

  - A source-html manifest page entry may carry `skip_reason` instead of
    `path` (exactly one of the two is required) to declare that page out of
    source scope with a per-page reason.
  - CampaignSpec `build_scope.mode: "partial"` declares the same thing as a
    blanket for active pages with no manifest entry and no `design_source`;
    the recorded reason carries `build_scope.reasons[]`.

  Declared pages land on the packet as `skip_reason` mappings — the shape
  doctor's scope summary already understands — and on the assembly report
  under `stages.prepare_build.declared_out_of_scope`, with one decision per
  page. `prepare_build` reaches `completed_partial` (terminal under the
  prefix-matching stage contract) and the ladder advances. A page that
  declares `design_source` still blocks without a per-page skip entry, and a
  missing page under full/undeclared scope blocks exactly as before.

  Two adjacent shape notes: doctor's `source_html.pages.coverage` error
  `detail` now always carries `page_id` (previously the detail was null for a
  page without `design_source`), and a CampaignSpec `build_scope.reasons`
  that is present but not an array surfaces as a `SOURCE_SCOPE_REASONS_IGNORED`
  assembly-report warning instead of being silently dropped.

### Fixed

- **Built-output checks honor the partial-scope declaration after assembly.**
  Once assembly recorded complete, `validateBuiltSdkMetaTags` pushed one
  `built_output.page_missing` error for every active spec page with meta
  hints and no built HTML, and `validateBuiltRouteDrift` escalated the same
  absent pages as route drift — never consulting the out-of-scope declaration
  prepare-build recorded, so a partial build's ladder re-blocked at doctor
  one gate after the declaration fixed prepare-build. Both checks now skip
  pages listed in `stages.prepare_build.declared_out_of_scope` on the
  recorded assembly report (the declaration authority — NOT the packet's
  skip mappings, which blocked pages carry too), record the skips in
  doctor's ready output, and keep the full error escalation for in-scope
  pages: a missing in-scope page still errors post-assembly exactly as
  before, and full-scope campaigns are untouched. A built page is verified
  regardless of declaration. `completed_partial` continues to count as
  assembly-complete for in-scope enforcement.

- **doctor and the stage ladder agree over one packet.** doctor computed its
  verdict from its own checks without consulting
  `stages.prepare_build.status`, so it could exit 0 and hand the operator a
  `next setup` command the ladder then refused with exit 2 — a green light
  pointing at a closed road. doctor now surfaces the recorded prepare-build
  gate (blocked status, or a terminal claim contradicted by retained blocking
  evidence) as errors, so exit 0 means the command doctor names will actually
  run. `start`'s embedded doctor inherits the same contract, so a `start`
  that leaves prepare-build blocked now exits 2 with the blockers printed
  instead of reporting ready.

## [1.12.0] - 2026-08-25

### Fixed

- **QA no longer passes a funnel whose page dead-ends.** Both consumers of
  `expected_next_url` skip on a falsy value — `if (!expectedUrl) continue` in
  the funnel-flow route-link loop, `if (!page?.expected_next_url) return false`
  in the primary-CTA check — which is correct for a page that terminates on
  purpose and silently wrong for a page that meant to continue. 1.11.0 made
  that state reachable: a page whose only forward field was `success_url` or
  `on_accept` off an eligible type now resolves to no forward link, source
  intake omits `next_url`, and the built page has nowhere to go. QA emitted
  **zero** assertions for it and the run came back clean.

  The QA topology now carries `ignored_forward_fields` — the forward fields the
  author declared that routing skipped — so QA can tell "terminates on purpose"
  apart from "meant to continue and lost its only edge", which a null
  `expected_next_url` cannot express on its own. A page in the second state
  emits `forward-route:<page>:resolves`, status `fail`, severity `blocker`.

  Deliberately narrow. A `thankyou` page declaring nothing stays quiet, and a
  rooted `success_url` handing off to an existing downstream route (the
  partial-scope pattern `ThankYouRequirement` documents) still passes. Proven
  quiet across every certified family fixture before shipping.

- **`expected_accept_url` respects the `on_accept` applicability rule.** The QA
  topology extractor read `page.on_accept` raw, which outlived its correctness
  when 1.11.0 gated the field: a `select` page's inert `on_accept` still
  produced an `expected_accept_url`, so QA looked for an accept link the built
  page correctly does not have and flagged a good build. It now reads
  `acceptRouteTarget`. An upsell's own accept branch is unaffected.

### Added

- Exported `applicableForwardFields` from `./campaign-spec`: the forward fields
  a page's TYPE can route from, declared or not. It answers "what should this
  author have set instead", which is a question about the page type rather than
  about the spec — filtering `FORWARD_ROUTE_FIELDS` against
  `inapplicableForwardFields` gets it wrong, since that list only names fields
  the author actually declared.

- Exported `acceptRouteTarget` and `ACCEPT_ROUTE_FIELD` from `./campaign-spec`.
  `acceptRouteTarget` answers "where does accepting this page's offer go" — a
  question only an offer page can be asked — and is gated by the same
  applicability table as the forward resolver, so a consumer cannot read the
  raw field and drift from routing the way the QA extractor did.

## [1.11.0] - 2026-08-25

### Changed

- **Behaviour change — rebuilding an unchanged spec can rewire a funnel.**
  The two forward-route fields that carry a page-shaped meaning now participate
  in precedence only where that meaning exists:

  - `success_url` ("where the shopper goes after payment succeeds") only on a
    page that takes payment, `type: "checkout"`.
  - `on_accept` ("where the shopper goes after accepting the offer on this
    page") only on a page that presents one, `type: "upsell"` or `"downsell"`.

  Anywhere else those fields are now inert and `next_page` wins. Previously
  precedence was type-blind, and because these two outrank `next_page` a page
  carrying a copy-pasted one routed the shopper past its real next step: a
  `select` page declaring `next_page: "checkout"` alongside
  `success_url: "upsell"` — or alongside `on_accept: "upsell"` — wired the
  upsell and skipped payment entirely. A checkout carrying a stray `on_accept`
  also shadowed its own `success_url`, skipping the whole upsell sequence after
  the order was placed.

  This is not a return of the page-type routing gates removed in 1.9.0/1.10.0.
  Those DROPPED edges an author had declared, on tables that disagreed about
  which fields a type may use. `next_page` — the generic "wherever this page
  goes next" — remains honoured on every page type without exception, and so
  does the `on_decline` branch. The carve-out is about what two fields MEAN.

  To find affected specs before upgrading: any page declaring a non-empty
  `success_url` whose `type` is not `checkout`, or a non-empty `on_accept` whose
  `type` is neither `upsell` nor `downsell`. Zero pages across the certified
  fixture corpus match, and the corpus golden regenerates byte-identical — but
  that corpus contains no instance of either shape, so it is not evidence about
  your specs. `RouteFieldIgnoredForPageType` (below) reports both on any spec
  you validate.

  `schema_version` stays `4.3` deliberately: the CampaignSpec version tracks the
  exporter's lineage rather than this repo's edits, the same exemption 1.9.0
  took. The field's SHAPE is unchanged; only which toolkit versions act on it
  differs, and that is what `surface_version` moving is for.

- `RouteTargetResolves` no longer reports a target carried by a field the page's
  type cannot satisfy. Routing skips such a field, so the built page does not
  link to that target and the rule's "would link to a route nothing serves"
  message was false. `RouteFieldIgnoredForPageType` owns that shape instead, so
  the two rules cannot tell an author opposite stories about the same field.

### Added

- Added the `RouteFieldIgnoredForPageType` rule: a page declaring a forward
  field its type cannot satisfy is told so, and told where the shopper actually
  goes instead (or that the page now has no forward route at all). Covers both
  gated fields, and reads the field's meaning and permitted types from
  `routing.ts` rather than restating them, so it cannot tell an author a field
  is dead while the resolver still uses it. Warning severity, never blocking. `RouteTargetResolves` catches this only when the
  target does not resolve; when both targets name real pages it has nothing to
  say. Ships already quiet across every certified fixture. Consumers that
  snapshot `validateSpec` output will see this new `ruleId` — new
  warning-severity rule IDs are additive, and consumers must tolerate unknown
  ones.

- Exported `PAYMENT_BEARING_PAGE_TYPES`, `OFFER_BEARING_PAGE_TYPES`,
  `inapplicableForwardFields` and `describeForwardField` from `./campaign-spec`,
  so an authoring UI can gray out an inert field and explain why using the same
  definition the resolver uses.

- The `success_url`, `on_accept` and `resolved_routing.success` descriptions in
  `schemas/campaign-spec.v4.schema.json` now state their applicability rules.

## [1.10.0] - 2026-08-25

### Added

- Added `campaign-spec/routing.ts` and exported it from `./campaign-spec`:
  `forwardRouteTarget`, `declineRouteTarget`, `hasForwardRoute`,
  `outgoingEdgeIds`, and the field constants. This is the single source of
  truth for "where does this page go". Source intake, cycle detection, the
  CheckoutHasSuccessUrl rule and the QA topology extractor all consume it
  instead of keeping their own page-type tables, which had already drifted
  apart into three different answers.

- Added the `RouteTargetResolves` rule: every declared routing target must name
  a page in the same funnel. Warning severity, never blocking — absolute URLs,
  `#` fragments and rooted paths (the documented partial-scope pattern) are
  deliberate off-graph destinations and are not flagged. It ships already quiet
  across every certified fixture, which is the precondition for adding any gate
  here.

### Fixed

- Corrected six certified fixtures whose checkout declared
  `next_page: "upsell-bundle-stepper.html"` while their funnel's upsell is
  `upsell-stepper` — the target name was copied from the MV families, which do
  have that page. Nothing resolved those targets, so intake's route fallback
  emitted a confident link to a route nothing serves: apollo-tiered, arjuna,
  demeter, olympus-tiered, shop-single-step, and the three-step shop flow's
  `billing` page all sent the shopper to a 404 immediately after checkout. The
  page-kit frontmatter golden is regenerated accordingly.

### Changed

- Forward-link resolution is no longer a page-type switch anywhere. A page's
  next link comes from whichever routing field it declares, in
  specific-before-generic precedence (`on_accept`, `success_url`, `next_page`),
  and the decline link from `on_decline` wherever it appears. A campaign is a
  free-form headless journey; the previous type tables silently discarded any
  edge declared outside them. Twelve checkout-typed pages across ten certified
  fixtures — including every hand-off in the three-step shop flow — routed
  through `next_page` and built with no `next_url` at all.
- Cycle detection now follows the edges a page can actually traverse — its
  resolved forward link plus its decline branch — rather than a per-type edge
  table. It previously ignored `next_page` on a checkout, so once intake began
  wiring that edge a loop through it would have built as a live link while
  staying invisible to the rule that blocks on cycles. Shadowed forward fields
  are deliberately excluded: a page whose `success_url` wins at runtime and
  terminates cleanly must not be blocked by a stale, unreachable `next_page`.
- QA topology extraction resolves `expected_next_url` through the same
  resolver. It previously read `next_page || success_url` and ignored
  `on_accept`, a third precedence that could disagree with the built page.
- `CheckoutHasSuccessUrl` warns when a checkout has no forward route at all,
  instead of when it lacks `success_url` specifically. It was firing on twelve
  pages across ten shipped fixtures whose checkouts route correctly, telling
  authors to rename a field they had already filled in. Corpus warnings drop
  from 22 to 10. The message and the violation `path` now describe the
  page-level condition; the rule ID is unchanged for consumer stability.
- Bumped the supported surface to `1.10.0`. No hashed schema changed, so the
  gate does not owe a bump — but the new exports and the changed routing
  behaviour are consumer-visible, and downstream pins update against a version
  they can see move.

## [1.9.0] - 2026-08-25

### Added

- Added `select` to the authoring `PageType` union and the CampaignSpec v4
  JSON Schema page-type enum: the bundle-selection step of a two-step family,
  a template-owned commerce page that routes forward like a landing page
  (`next_page` / `success_url`) but carries SDK cart selection. Additive — every
  existing spec stays valid, and `schema_version` is unchanged because that
  field tracks the exporter's lineage (4.2/4.3), not this repo's schema edits.
  Map Builder exports may now legally emit `select`.
- Added a page-type drift gate pinning the JSON Schema enum to the authoring
  union, plus documentation of page IDs and page types as separate namespaces
  in `docs/template-family-contracts.md`.

### Changed

- Commerce residue checking now covers the selector step. `select` joins
  `RESIDUE_PAGE_TYPES`, which turns on logo and computed-style residue coverage
  the shipped brand contracts already declared for it — those `page_types`
  entries were inert while no spec-valid page could carry the type. A branded
  selector page passes; an unbranded one carrying the starter palette or the
  starter logo is now a blocker where it previously passed silently.
- Cycle detection traverses `select` pages. Without routing semantics a cycle
  through the selector step would have been invisible.
- Bumped the supported surface to `1.9.0` for the additive page-type enum. The
  package remains developer preview `0.1.0-alpha.0`.

## [1.8.0] - 2026-08-24

### Added

- Added supported `./commercial-journey` and `./commercial-parity` package
  exports for portable calculate-scenario planning, normalization,
  contract-governed authored-claim extraction, and Exact-only mismatch
  serialization.
- Added automatic commercial parity to canonical `campaigns-os qa run`.
  Authored HTML is fetched once per URL with hard byte/node/depth limits;
  calculate descriptors use the existing `/api/price-preview` proxy, and the
  three ratified mismatch classes enter the verdict as warn-severity pricing
  assertions plus a `commercial` evidence section.

### Changed

- Bumped the supported surface to `1.8.0` for the two additive package
  exports. The package remains developer preview `0.1.0-alpha.0`.

## [1.7.0] - 2026-08-24

### Added

- Added the optional Build Packet `generated_at` freshness contract. New
  `prepare-build` packets stamp an ISO-8601 UTC instant, and downstream
  readback uses it for staleness and multi-packet selection instead of file
  mtime. Legacy packets remain schema-valid but must be regenerated at the
  current commit to satisfy fresh-artifact readback.
- Finalized packet-based `qa run` now writes the committable
  `.campaign-runtime/qa-verdict.json` allowlist projection for every
  disposition, including blocked runs. Operators can explicitly backfill it
  from one named full verdict with `campaigns-os qa promote --packet ...
  --verdict ...`; promotion validates the source before atomically replacing
  the sidecar and never selects a verdict by mtime or "latest."

### Changed

- Bumped the supported surface to `1.7.0` for the additive Build Packet
  freshness field. The package remains developer preview `0.1.0-alpha.0`.

## [1.6.0] - 2026-08-23

### Added

- Added the strict `campaign-design-source-package/v0` schema and normalized
  Design Source Package artifact for creative provenance, Surface Identity,
  contribution coverage, source references, gaps, TODOs, waivers, readiness,
  and readback.
- Added desktop/mobile source-screenshot TODO generation for renderable primary
  design and linked Template Reference proof requirements for template-baseline
  coverage.
- Added four-field artifact references (`path`, `schema_version`, exact-byte
  `sha256`, and projected `material_fingerprint`) to the Build Packet, Build
  Context, and Assembly Report.
- Added focused schema, producer, lifecycle, and Polish freshness tests,
  including negative controls for forged readiness, whole-JSON and underscoped
  fingerprints, current-input drift, stale bindings, and output aliases.

### Changed

- `prepare-build` now synthesizes a missing package from current source-html
  inputs while preserving the v0 `source_html` compatibility handoff. An
  existing package is validated against current campaign, page, source, and
  template material and reused byte-for-byte or refused without silent
  regeneration.
- Build records the current Design Source Package material fingerprint it
  consumed; Polish freshness now requires both that source-package fingerprint
  and the current build fingerprint. Missing or stale Assembly consumption
  returns the lifecycle to Build before Polish.
- Registered the Design Source Package schema and its durable consumer guide in
  supported surface `1.6.0`.
