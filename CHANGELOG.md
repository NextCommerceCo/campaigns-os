# Changelog

Notable supported-surface changes are recorded here.

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
||||||| 42ba452

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

## [1.26.0+agent.14] - 2026-09-13

### Fixed

- `shellToken` prints a falsy value as itself. It stringified `value || ""`, so
  a count or flag of `0`, `false` or `NaN` vanished from a printed command;
  only `null` and `undefined` now read as no value. Review follow-up on the
  shell-token test; the charset test pins the new cases.

### Changed

- The two campaign scanners drop an import left dead by the repo-scan
  consolidation. No behaviour change.

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
||||||| 2912d70

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
