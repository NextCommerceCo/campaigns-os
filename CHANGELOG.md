# Changelog

Notable supported-surface changes are recorded here.

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
  this warning. To clear it, remove `data-next-is-upsell="true"` from the bump
  include in the campaign, unless the line really should be billed as an
  upsell. It is a warning, not a blocker.

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
