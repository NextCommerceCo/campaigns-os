# QA And Test Orders

The public v0 QA runner is Node/npm-based and does not require access to a private runtime repo.

> **Commerce QA requires network; it cannot run in a no-outbound sandbox.** The SDK, product images, fonts, the Netlify preview, and the Playwright typed-card test order all need outbound network. A build environment without it can only validate markup/build/CSS — the commerce runtime and the typed-card test order (the Campaigns OS control) must be deferred to a deployed preview. Always run the QA runner against a `--base-url` preview/production origin (e.g. `npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url https://deploy-preview-7--your-site.netlify.app/ --browser --test-order common`); never report commerce-runtime QA as passed from an offline build.

## Polish capture prerequisite

Packet QA consumes package-owned page-load evidence; it never creates that
evidence. Install the package browser, serve the current built output, and run
the producer before marking Polish complete, deploying, or starting QA:

```bash
npm run qa:install-browser
npm run campaigns-os -- polish capture \
  --packet campaign-runtime.build.json \
  --base-url <served-current-build-url>
```

The operator-provided URL must serve the current build. Its value is not a
cryptographic attestation of the served bytes. See
[Polish evidence](./polish-evidence.md#durable-page_load-field-map) for the
generated field map, completeness rules, and attachment race boundary.

## Resolve

Use resolve before a full run:

```bash
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
```

Resolve reads the packet, loads the local CampaignSpec when available, derives deployed page URLs from the packet deploy URL or `--base-url`, probes the entry URLs it derived, and prints the funnel topology. It does not create a verdict.

### Route reachability

A route set derived from the packet is not evidence that the deployment serves
it. Resolve therefore probes the entry URLs it just printed — one `HEAD` per
entry URL, retried as `GET` only when a host answers `405`/`501` about the
method — and its status reports what was verified rather than what was derived:

| Status | Meaning |
| --- | --- |
| `blocked` | A checkpoint gate blocks. The routes are not probed. |
| `routes_unresolved` | The routes were probed and at least one did not resolve. `ok: false`. |
| `ready_unprobed` | There were routes to probe and none produced a response. `ok: true`. |
| `ready_with_exceptions` | Checkpoint warnings, over routes that resolved. |
| `ready` | Clean, over routes that resolved. |

The ladder is ordered by how much of the deployment the run actually verified,
which is why `ready_unprobed` outranks `ready_with_exceptions`: a checkpoint
warning is a named exception an operator can read, while an unprobed route set
means the deployment half was never checked. Checkpoint warnings stay fully
visible in `checkpoint_gates[]` at every rung.

`routes_unresolved` names the first URL that failed and suppresses the
`qa run --browser --test-order common` suggestion, because that command cannot
succeed against a route set that does not resolve. The `route_probe` block
carries the per-URL results and one of `route_probe.all_resolved`,
`route_probe.routes_unresolved`, `route_probe.unreachable`,
`route_probe.disabled`, or `route_probe.no_routes`.

Resolve appends `campaign.public_route_slug` unconditionally — the packet is
the authority on where a campaign is served, and no flag overrides it. When
every derived route is dead, one extra probe of the host without that slug
separates the two causes and says which it found:
`route_probe.route_root_mismatch` (the host serves the campaign under a
different route root, so correct `campaign.public_route_slug` or declare
`campaign.route_root` in the packet) or `route_probe.host_also_dead` (the
preview itself is down).

**Offline and CI.** An HTTP response saying `404` is evidence about the
deployment; a transport error is evidence about this machine's network. Only
the first fails the probe. A run with no outbound network degrades to
`ready_unprobed` and stays usable — no flag required. `--no-probe` exists for
hermetic runs that must make no outbound request at all, and
`--probe-timeout-ms` (default `5000`) bounds each probe. Probing is capped at
25 entry URLs; anything past the cap is reported as `skipped` rather than
silently dropped.

An empty Entry URL list keeps its own pre-existing guidance — a dead preview or
a missing `--base-url` — and reports `route_probe.no_routes` without moving the
status.

### Packet-local checkpoint preflight

Packet QA reads one local packet, CampaignSpec, target `_data/campaigns.json`
entry, and Assembly Report snapshot. It evaluates three registered checkpoints
from those objects: `page_kit.store_profile`, `page_kit.sdk_version`, and
`polish.hidden_eager_media`. The same packet/spec snapshot supplies runtime
identity and topology, while the same Assembly Report supplies checkpoint
decisions, theme/polish state, package-owned page-load evidence, and QA waiver
history. QA does not re-read those artifacts after the gates. A packet without
a valid local spec cannot fetch around the missing evidence. Packet QA always
uses `packet.spec.local_path`; combining `--packet` with `--spec` is rejected
before either artifact is read.

Any non-waived checkpoint blocker finalizes a blocked local verdict before HTTP,
Playwright, analytics capture, or typed-card orders run. All checkpoint
assertions remain visible when gates disagree, so waiving or correcting one
never suppresses another. Store Profile and SDK use the `api-metadata` family;
the hidden eager-media assertion uses `polish_gate`.

`qa resolve` remains a diagnostic command and always exits 0: it reports
`ok: false` and `status: blocked`, prints all three gates and their safe
repair/waiver projections, and suppresses the runtime
`qa run --browser --test-order common` suggestion until every checkpoint
blocker is clear. `routes_unresolved` behaves the same way — `ok: false`,
suggestion suppressed, exit 0.

The SDK gate reads the canonical `global_config.sdk_version` first and accepts
`runtime.sdk_version` as an alias. Pins must be released,
canonical `MAJOR.MINOR.PATCH` versions. Equal dual declarations are valid;
conflicting declarations, missing declarations, prereleases, empty values, and
non-string values are non-waivable blockers. Once both sides are valid, only an
exact expected/observed mismatch has a waiver lane.

The hidden eager-media gate reads only the recorded package capture; QA never
launches `campaigns-os polish capture` or another browser producer. Missing,
malformed, stale, integrity-invalid, route-mismatched, or incomplete page-load
evidence is nonwaivable and blocks before runtime. A complete finding for a
computed-hidden media element strictly over `1,048,576` bytes is waivable only
for its exact build, slug, route plan, fixed viewports, and finding state. A
packetless QA run has no packet-owned authority and reports this checkpoint as
not applicable.

A current exact checkpoint waiver remains attached to that gate's warning and
lets runtime QA proceed only when every other checkpoint is clear. The QA
disposition is `ready_with_exceptions`; waived is never clean. Doctor/`next` use
the checkpoint readiness term `ready_with_waivers`. Record a bounded decision
before QA with the relevant gate ID:

```bash
campaigns-os checkpoint waive \
  --packet campaign-runtime.build.json \
  --gate <page_kit.store_profile|page_kit.sdk_version|polish.hidden_eager_media> \
  --reason "<why>" \
  --waived-by "<named human>" \
  --review-condition "<specific re-evaluation trigger>"
```

Legacy source/theme/QA waiver commands and artifact lanes remain in place until
those gates are registered. Store Profile evidence includes only the governed
nine-field matrix plus status, normalized slug, relative target path,
fingerprint, and attribution. SDK evidence includes only strict expected and
observed versions, declaration source, status, subject, fingerprint, and the
same bounded attribution. Arbitrary target campaign configuration must not be
serialized into the verdict. Active waiver evidence is a fixed whitelist of
attribution/bound fields, and inactive waiver history is count-only; raw report
records and their unknown fields never enter resolve output or the verdict.

Use the printed `Entry URLs` for preview probes and proof notes. The campaign
root is only the URL-joining base; some funnels enter through a more specific
route such as `/shield/presell-running/`, and the root path may legitimately
404. Treat a root 404 as legitimate only when `qa resolve` prints at least one
Entry URL and the follow-up `qa run` records a passing `http:<page_id>` assertion
for that entry URL. If Entry URLs are empty, still point at a deleted preview, or
fail their own HTTP assertion, fix `--base-url` or the packet deploy URL before
continuing.

`--base-url` can be either the deploy host or the campaign root. If the Build Packet says `campaign.public_route_slug = "roadside-ready"`, both of these resolve pages under `/roadside-ready/`:

```bash
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json --base-url https://deploy-preview.example.netlify.app
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json --base-url https://deploy-preview.example.netlify.app/roadside-ready/
```

## Run

Install the package-owned Playwright browser once before Polish capture,
rendered QA, or test-order proof:

```bash
npm run qa:install-browser
```

This installs the Chromium binary used by `polish capture`, `--browser`, and
`--test-order`. It is part of the normal Campaigns OS proof path after `npm
install` or package updates. The QA flow must not depend on external browser
skills or local agent tooling.

`npm run smoke:polish-capture` is an optional real-browser package smoke after
that installation. It requires permission to bind a loopback HTTP listener and
is deliberately excluded from `npm run check` and CI.

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/
```

The runner fetches deployed pages, checks route availability, verifies CampaignSpec `sdk_hints.meta_tags`, writes a local verdict JSON under `qa-output/<map-id>/<run-id>.json`, and returns exit code `4` when the verdict is blocked.

### Automatic commercial parity

When the CampaignSpec has enabled pages with package rows, the same `qa run`
automatically plans calculate scenarios from the packet's raw CampaignSpec and
executes them through the existing proxy `POST /api/price-preview` contract.
The runner uses the established credential precedence: a direct packet
`campaign.campaigns_api_key`/`api_key`, then CampaignSpec key fields, then the
single trusted packet fallback `campaign.api_key_source = "env:CAMPAIGNS_API_KEY"`.
Other environment-variable names are rejected so an untrusted packet cannot
forward unrelated process credentials to an overridden proxy. The resolved value is supplied
only as the `X-Campaign-Key` request header and is never serialized into the verdict.
No private runtime import, commercial sidecar, duplicated price calculation, or
extra catalog flag is involved. Recurring package facts come from the authored
page rows carried into each portable descriptor.

The deployed source response is fetched once per distinct URL and shared by
the normal static checks and commercial extractor. Limits are deliberately
hard: 2 MiB per HTML response, 16 MiB of retained HTML across the run, 50,000 parsed elements, nesting depth 128, 500
claims per document, 256 claims across the run, 1 MiB per price-preview
response, 256 calculate scenarios, four concurrent proxy requests, and 20
seconds per request. A limit, missing key, malformed response,
or unavailable page records incomplete commercial evidence; it never invents
a mismatch. `commercial.status = "incomplete"` preserves the disposition
derived from the ordinary QA assertions; it does not create an exception by
itself. QA dispositions remain `ready`, `ready_with_exceptions`, or `blocked` —
`ready_with_waivers` is the doctor/`next` checkpoint-readiness term.

Only contract-governed claims are compared, and only against `Exact` normalized
truth. Proven differences emit warn-severity `pricing` assertions named
`price-claim-mismatch`, `cadence-disclosure-mismatch`, or
`voucher-not-applied`. Decorative, ambiguous, stale, unresolved, or malformed
claims remain silent. The verdict's top-level `commercial` section records
coverage, sanitized missing/unmatched/invalid capture evidence, proxy issues,
and findings; the same findings are serialized deterministically into the flat
`assertions` array consumed by existing QA tooling. A proven mismatch keeps the
verdict at `ready_with_exceptions` even when the flat assertion budget retains
the finding only under `verdict.commercial`.

### Committed verdict sidecar (`.campaign-runtime/qa-verdict.json`)

Packet-based `qa run` also writes a committed sidecar beside the Build Packet
at `.campaign-runtime/qa-verdict.json` — the artifact campaigns-agent's
readback consumes. It is written for every finalized disposition, blocked
included: the sidecar records what QA concluded, it is not a pass mark. A run
that dies before verdict finalization or fails local validation never touches
an existing sidecar. Packet-less runs (`--site`, raw map-id) have no packet
home and write no sidecar.

The sidecar is an allowlist **projection** of the full verdict, same schema
(`1.0`), stamped with its own `generated_at` at promotion time. Full verdicts
under `qa-output/` are gitignored because they carry live storefront URLs,
request evidence, and order references; the projection keeps identity,
disposition, per-assertion `id`/`family`/`page`/`status`/`severity`/
`blocked_by`, and trimmed exceptions, and empties every URL-bearing field. Do
not commit a full verdict, and do not hand-author the sidecar.

To backfill from an existing full verdict, name the exact source explicitly —
nothing is ever selected by mtime or "latest":

```bash
campaigns-os qa promote \
  --packet campaign-runtime.build.json \
  --verdict qa-output/<map-id>/<run-id>.json \
  --json
```

`qa promote` validates the source before writing, replaces the sidecar
atomically, refuses the destination sidecar as its own source, and leaves the
source verdict byte-identical.

### Verdict schema and trust semantics

The verdict shape is contracted as `campaigns-os-qa-verdict/v0`
([`schemas/campaigns-os-qa-verdict.v0.schema.json`](../schemas/campaigns-os-qa-verdict.v0.schema.json)),
with the committed sidecar projection's guarantees pinned separately in
[`schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json`](../schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json).
Both describe the same emitted `schema_version` literal `"1.0"` — one contract,
projected two ways, never a second lineage. The emitted literal predates the
slash-versioned naming convention and the portal receiver validates the same
literal, so changing it is a breaking shape change. Additions to v0 are
expected; consumers must tolerate unknown fields.

**Trust is stamped by the receiver, never by this CLI.** The QA portal
receiver accepts verdict posts publicly (after shape/size/rate checks) and
classifies each submission at ingest: a post carrying the ingest credential is
stored with `trusted: true` / `trust_level: "shared_secret"` / a `verified_at`
instant; a post without it — an **anonymous submission** — is stored with
`trusted: false` / `trust_level: "anonymous"` / `verified_at: null`. Those
three fields therefore appear only on records read back from the receiver;
verdicts this runner writes locally never carry them.

`trusted: false` means exactly this: **the record is shape-valid but
unattributed — anyone on the internet could have submitted it.** Schema
validity is not trust; a forged verdict passes every shape check by design.
Consequently:

- **Every downstream consumer of verdict readback MUST filter on `trusted` or
  segregate untrusted records** (render them in a visibly separate, untrusted
  lane — never mixed into launch evidence, QA history, or agent readback as
  peers of verified runs).
- Campaigns OS itself enforces this at its own readback chokepoints:
  `qa promote` (and any sidecar projection) refuses a source verdict stamped
  `trusted: false` — an untrusted record can never be laundered into the
  committed `.campaign-runtime/qa-verdict.json` — and `run-record`'s automatic
  QA-verdict inference excludes untrusted records from the run's QA evidence.
  The test suite carries a forged, shape-valid, untrusted verdict as a
  negative control for both.

Endpoint authentication and attribution hardening are deliberately separate
work that lands with the receiver's connection contract. This section
documents the semantics of the stamps the receiver already applies.

Add `--browser --test-order common` for the normal proof pass: first-party
Playwright browser checks plus the default typed-card order sample. If the
browser binary is missing, the CLI will prompt you to run
`npm run qa:install-browser`:

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --browser \
  --test-order common
```

The browser pass renders each live page in Chromium, captures browser console
errors, page errors, and failed requests, verifies rendered upsell controls, and
inspects checkout payment field mounts. For checkout pages with a locked
template family, it also runs `browser-commerce-structure` against any
machine-checkable `agentContract.qaStructure` selectors in the commerce surface
catalog. If the family contract is silent, the assertion returns
`manual_review`, not `pass`; if declared required structure is missing, it
soft-fails with warning severity so the verdict becomes `ready_with_exceptions`.
Promoted template families must also have
`contracts/template-brand-contract.<family>.v0.json`; QA emits a blocker if the
selected family is missing its brand/residue/pricing contract instead of
silently skipping starter-palette and pricing checks.
It is owned by this package through the `playwright` dependency; QA must not
rely on external browser skills or local agent tooling.

Fresh Build Packets record the proof contract in `qa.proof_policy`, and
Assembly Reports mirror it at `report.proof_policy`. The important fields are
`browser_qa_required`, `typed_card_depth`, `order_path_depth`,
`localhost_development_domain_allowed`,
`non_localhost_origin_allowlist_required`, and `operator_approval_state`.
Agents should update proof state in artifacts instead of renegotiating browser
QA or typed-card depth in chat.

Campaign Build Brief `qa_policy` is business expectation metadata, not a
direct runner gate. Normalized briefs mark it as
`documented_expectation`; the enforced proof contract remains
`qa.proof_policy` and `report.proof_policy`.

For SDK-owned runtime pages such as checkout, upsell, downsell, and receipt,
the browser pass also opens a separate instrumented view with `?debugger=true`
and verifies that the Campaign Cart debugger overlay and selector controls
mount. This debugger check is separate from the normal user-flow page load and
test-order path so shopper behavior is not altered by QA instrumentation.

Routing meta tags are evaluated in runtime-resolved form. If the spec carries `next-success-url: upsell/`, the deployed page should emit a campaign-root path such as `/roadside-ready/upsell/` so the SDK does not resolve the redirect from the site root.

Upsell accept/decline route checks accept rendered SDK controls as static evidence when there is no `<a href>`: `data-next-upsell-action="add"` for accept and `data-next-upsell-action="skip"` for decline. The browser walkthrough still needs to click the actual controls.

## Offer Application QA

When a checkout page declares `exit_intent.enabled`, QA should exercise the
accept path as a checkout runtime behavior:

- trigger or open the exit-intent surface in the rendered checkout
- accept the mapped offer
- verify the mapped code becomes active in cart state
- verify bundle selectors, totals, order summary, and discount rows reprice from
  SDK/API state
- verify any code-specific labels gated by `cart.hasCoupon("CODE")` render only
  after the code is active

When a checkout page declares `promo_code_input.enabled`, QA should enter the
mapped `offer_code` and verify the same active-code, repricing, discount row,
and conditional presentation evidence. Missing promo-code input is a blocker
when CampaignSpec, the source design, or the user explicitly declared it as part
of the build.

QA evidence redacts checkout request bodies and generated QA emails. Verdict artifacts
keep method, URL, response summaries, order refs, line-item summaries, and card last4,
but they should not contain full customer address/payment payloads.

QA runs **publish to the QA portal by default** — they appear in the Campaign Map
QA tab and the run picker, and the command prints the portal link. No flag needed.
Pass `--no-post-verdict` (or `--local-only`) for offline / dev / CI runs that should
stay local-only; publishing never fails the QA run if the portal is unreachable.

The default rides the telemetry consent seam: with consent off
(`CAMPAIGNS_OS_TELEMETRY=off` or `campaigns-os telemetry off`), a run whose spec
came from a **local file** (client projects, fixtures, local shakeouts) stays
local-only, and the output names the destination plus the opt-in
(`--post-verdict`, or `campaigns-os telemetry on`). Portal-managed campaigns —
spec resolved from the portal for the run — keep publish-by-default regardless
of consent: those verdicts are the QA tab's product surface, not telemetry.
Explicit flags always win in both directions.

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/
```

## Cart-state verification: do not trust `cartLines`

When QA needs to confirm the cart actually holds the expected items, **do not read
`next.getCartData().cartLines`**. That field is currently always an empty array
regardless of cart contents — `getCartData()` returns `cartStore.enrichedItems`,
which is initialized `[]` and never populated; the real line items live in the
store's `items` / `summary.lines`. See
[NextCommerceCo/campaign-cart#36](https://github.com/NextCommerceCo/campaign-cart/issues/36).
Verified live on deployed checkouts (SDK 0.4.18 and 0.4.24): a correctly committed
bundle shows populated internal `items` while `cartLines` stays `[]`. An assertion
like `cartLines.length > 0` therefore **silently passes on an empty array** — a
false-positive "cart populated" verdict.

Use the signals this runner already relies on instead:

- **Committed cart (truth):** the typed-card test-order order read-back — the
  persisted order's receipt line items (`/api/v1/orders` response). This is the
  proof path the test-order flow uses. For an in-page check, read the
  `cart:updated` event payload (`items` / `summary.lines`).
- **In-flight selection (pre-commit):** rendered DOM evidence —
  `[data-next-bundle-card]` selected state and visible prices — or the bundle
  selector's `_getSelectedBundleItems()`. Subtotal/totals reflect the previewed
  selection and are not proof that a line committed.

This is enforced by `scripts/check-cart-readiness-contract.mjs` (part of
`npm run check`), which fails if QA source reaches for `cartLines`. Relax or
retire that guard once #36 ships and `cartLines` is populated.

## Analytics correctness (inventory, then receipt Purchase)

Analytics correctness has two deliberately separate evidence phases in one QA
run:

1. The campaign-root visit inventories declared providers, containers, pixels,
   and other observable tags. It does not prove or disprove Purchase, even if a
   stray Purchase-shaped event appears there.
2. The existing canonical typed-card order run supplies Purchase evidence. For
   each planned order, the topology classifier must recognize the final URL as
   that plan's receipt, then the runner waits the full `--analytics-settle`
   window (default `5000` ms) within the order deadline and assesses only events
   and tag fires emitted by that final receipt document. It does not replay the
   browser path or place a second order.

A receipt qualifies when it emits Purchase through the dataLayer, outbound Meta
Purchase, or outbound GA4 Purchase. Purchase on checkout or an upsell cannot
satisfy a silent receipt; the whole checkout-to-receipt capture remains separate
and is used only by migration parity. Every planned receipt-qualified order must
emit an effective Purchase for a pass.

- A missing attempt or topology-unrecognized final page is
  `MANUAL_REVIEW`/`WARN`.
- A recognized receipt with no effective Purchase is `FAIL`/`BLOCKER`.
- A capture, unreadable-page, or settle-deadline error on a recognized receipt
  is an explicit, non-waivable `FAIL`/`BLOCKER`; it is never normalized to a
  zero-signal capture.
- The `analytics-correctness:purchase-fires` waiver applies only to a genuine
  recognized-receipt/no-signal failure. It is inert for passes, manual-review
  paths, and capture/settle errors.
- Analytics-off and legacy API-only order paths emit no receipt Purchase proof.

## Analytics parity (dataLayer / GTM)

The analytics-parity leg proves the live **dataLayer event stream + GTM/pixel
tag-fires** match after a migration cutover — the leg repo scans can't cover,
because runtime-injected GTM and remote `campaign.js` pushes are invisible to a
static scan. Migration doctrine: **no cutover on a non-zero analytics diff.**

It is opt-in. Supply a **baseline** (the legacy live funnel) and a **candidate**
(the migrated preview); the runner captures both with Playwright and diffs them:

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/thank-you/ \
  --analytics-candidate https://preview.example.com/campaign/thank-you/ \
  --analytics-baseline https://legacy.example.com/campaign/thank-you/
```

This receipt-to-receipt parity example names `--analytics-candidate`
explicitly. When that flag is omitted, the candidate is the campaign identity's
composed root (`public_route_slug` plus `route_root`), not the raw
`--base-url` value.

| Flag | Meaning |
|---|---|
| `--analytics-baseline <url>` | Legacy funnel URL to capture as the parity baseline (enables the leg) |
| `--analytics-candidate <url>` | Migrated URL to capture; defaults to the identity-composed campaign root |
| `--analytics-hosts a,b` | Extra host substrings to treat as analytics tag-fires (Everflow is built in) |
| `--analytics-settle <ms>` | Wait after analytics page loads and after a recognized typed-order receipt for async tags to fire (default 5000); receipt settling must fit inside the order deadline |

> The analytics legs drive a headless **Playwright** browser (like `--test-order`),
> so they need the package-owned browser installed (`npm run qa:install-browser`)
> and outbound network — they cannot run in a no-outbound sandbox.

Point both at the **thank-you / receipt page** for the highest-value `dl_purchase`
check, or drive the same offer through each funnel so client-fired values line up.

What the diff asserts (BLOCKER unless noted):
- `purchase-present` — candidate fires a purchase event.
- `purchase-value` / `purchase-currency` — match the baseline's **client-fired**
  value (compared client-vs-client; never vs a backend total, since tax is
  computed backend and is not in the client value on headless checkouts).
- `purchase-transaction-id` — present (not equal — different orders have different ids).
- `capi-dedup` — the Meta `Purchase` fire carries an `eventID` keyed on the order id.
- `carryover:<provider>:<id>` — **WARN** when a container/pixel that fired on the
  baseline (GTM, Meta, Everflow, GA4, …) is **absent on the candidate** — a likely
  attribution regression flagged for human review, not an auto-block.

For a real SDK 0.4 migration example that required typed-card post-purchase
traversal, persisted-order price verification, receipt-context analytics, and
independent order readback, see
[SDK 0.4 Migration Proof Case Study](sdk04-migration-proof-case-study.md).

## Parity capture (fixture-driven migration proof)

Parity capture codifies the migration **PARITY-QA** leg: one declared offer is
driven through the candidate funnel by a typed-card test order while analytics
are captured across the checkout and post-purchase navigation. The persisted
order and client event stream are then assessed against a versioned fixture
corpus.

Run the live candidate traversal with a fixture scenario. A legacy analytics
baseline is optional; add `--baseline` when the migration cell requires a
candidate-vs-baseline diff:

```bash
npm run campaigns-os -- qa parity \
  --fixture fixtures/parity/example-sdk04-offers.json \
  --scenario root-accessory-oto50 \
  --base-url https://preview.example.com/campaign/ \
  --baseline https://legacy.example.com/campaign/ \
  --no-post-verdict
```

Every live run writes
`qa-output/<campaign-slug>/<runId>.parity-bundle.json` beside the verdict. The
bundle contains the order readback, candidate analytics capture, and optional
baseline capture. Replay that exact evidence without Playwright:

```bash
npm run campaigns-os -- qa parity \
  --fixture fixtures/parity/example-sdk04-offers.json \
  --scenario root-accessory-oto50 \
  --parity-order-json qa-output/example-sdk04-offers/<runId>.parity-bundle.json \
  --no-post-verdict
```

The required negative control is a copy of the bundle doctored to restore the
dropped-voucher line total. It must fail the persisted-line blocker:

```bash
npm run campaigns-os -- qa parity \
  --fixture fixtures/parity/example-sdk04-offers.json \
  --scenario root-accessory-oto50 \
  --parity-order-json qa-output/example-sdk04-offers/<runId>.dropped-voucher.parity-bundle.json \
  --no-post-verdict
```

**A harness that cannot fail the bug it guards is not proven.** Preserve the
passing replay and the dropped-voucher failing replay as paired migration
evidence.

Fixture essentials:

- `scenarios` declares the selectable regression cases; live capture accepts a
  `funnel_offer` scenario.
- `checkout_path` and `upsell_route` bind the typed-card traversal to the exact
  candidate surfaces.
- `expected_order_readback.line_item.price_field` names the persisted field to
  assess; do not infer a different price field at runtime.
- `expected_purchase.value` may be `null`: the named client event must still
  carry a finite value, while the offer amount is proven by persisted-line
  readback.
- `analytics_contract` declares the expected providers and events so missing
  analytics gate at blocker severity instead of the no-contract INFO path.
- Credentials are never fixture data. Credential lint permits environment-name
  indirection such as `api_key_env: "QA_CAMPAIGNS_API_KEY"`; literal keys,
  tokens, passwords, and other credential values are rejected.
- `campaign.slug` is a single path-safe segment (`a-z`, `0-9`, dot, dash,
  underscore). It names the output subdirectory, so separators and `..` are
  rejected at load and the writer refuses any slug that would escape
  `--output-dir`.
- `baseline_url` is optional and must be an `http(s)` URL. A fixture-supplied
  baseline only receives `--auth-cookie` when it is same-origin with the
  candidate; name the baseline with `--baseline` to authorize sending the
  preview credential to another host.

## Test Orders

Test Orders use **global test cards** that work on any live store and integration.
They **bypass the payment gateway and create no transactions** (and no fulfillment),
so they are safe to run any time and need **no permission flags, packet policy,
merchant sandbox routing, or test-order approval** — you just pick a mode. They leave a small,
easy-to-clean footprint: Test orders are deletable in bulk, and the resulting
Customer record is reused (see the test email note below) rather than multiplied.

Canonical proof is typed-card, browser-driven checkout automation. The QA runner
opens the deployed campaign checkout with Playwright, selects the intended cart
with rendered campaign controls, fills the customer/shipping form, types the test
card into the active hosted payment iframes, and clicks the real checkout submit
button. A hand-built backend API order does not prove the deployed
checkout/upsell surfaces.

Order-creation proof is read-back tolerant: the live order-create network
observation is best-effort (a fast post-submit navigation can drop the capture),
so when the create request was missed but the page redirected with a `ref_id`
and the order read-back returns the persisted order, the path passes and the
verdict records an `order_create_observation` note — mirroring the
accepted-upsell rule. An observed create with a non-2xx status still fails.

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --test-order common
```

The default mode is **`common`** (also what bare `--test-order` runs): at most
four shapes from the selected checkout's declared topology — the checkout
baseline, first-offer `accept` and `decline` when `expected_next_url` reaches an
upsell/downsell, and the shortest declared path that actually reaches a
receipt/thank-you page. The receipt path is deduplicated when it is already
`accept` or `decline`; Campaigns OS never invents a receipt path from offer
count alone. This is the everyday QA sample.

Other modes: `checkout` (base order redirect only), `accept`/`decline` (click the
rendered control on the first upsell page), `both` (two fresh orders for those
first-page paths), explicit accept/decline paths such as `accept-decline-accept`
for a targeted matrix, and **`full`** — every actual terminal path found by
walking the selected checkout's `expected_next_url` and each reachable offer's
`expected_accept_url` / `expected_decline_url`. A branch stops at a receipt,
thank-you page, or genuine cross-origin handoff, so shortcut and uneven branches
keep their real lengths. The walk is deterministic and cycle-safe. `full`
refuses to start the browser if a reachable branch cycles, omits a route, points
at an undeclared same-origin page, or otherwise has no recognized terminal.
Use `full` when you explicitly want exhaustive topology proof. Bundle/quantity
and bump coverage come from `--cart` and `--select-package`, or spec-driven from
**`tiers`** (below).

At runtime, a planned path may stop early only after the browser reaches a
terminal URL recognized in that selected topology. Missing accept/decline
controls on an ordinary or unknown page remain blockers; they are not treated
as evidence that a receipt was reached. Cross-origin handoffs count as terminal
navigation, but not as Campaigns OS receipt rendering or persisted-receipt proof.

### Step-ladder evidence

Every typed-card path executes as an ordered ladder of named, individually timed
steps, and each step appends to the ladder the moment it finishes — a crash or
timeout still leaves the ladder up to the point of failure. Ladder entries carry
`step`, `status`, `started_at`, `duration_ms`, an optional human-readable
`detail`, and, where the step has something structured to say, an `evidence`
object. Evidence is resolved even when the step fails or times out, because the
failing path is the one worth reading.

Two steps write structured evidence today.

**`customer_fields_filled` — customer/address-field trace.** Each field is
recorded before its action runs and updated after, as
`{ field, action, status, optional, duration_ms }`. Statuses are `ok`,
`unusable` (an optional field that reported visible but would not accept input —
best-effort, not a failure), `failed`, and `pending`. `pending` is the useful
one: a step that hangs mid-field leaves that field pending, so the verdict names
the field instead of reporting an anonymous step timeout. The summary lifts the
first failed-or-pending field to `blocking_field` / `blocking_status`.

Coverage is `customer_and_address_fields` and the name is literal: this trace
covers the customer and shipping/billing fields reached through
`[data-next-checkout-field]`. It does **not** cover payment entry — the card
number and CVV are typed into cross-origin hosted iframes that no page-side
trace can observe.

Required field actions are bounded by the step budget, capped at Playwright's
own 30s default, so a caller-supplied budget only ever tightens the ceiling. A
stuck required field fails as that field rather than as an anonymous step
timeout; a slow-but-working funnel waits no longer than it did before.

**`cart_created` — cart-API observation.** The step reports what the cart API
actually returned: the most recent `POST /api/v1/carts/` response's `status`, an
`ok` flag, `line_count` when the response body exposes lines, `response_count`,
and the query-redacted `url`. Matching is anchored like the order-create
patterns, so a querystring still matches while `/api/v1/carts/calculate/`
repricing calls do not — a repricing call is not evidence that a cart was
created. A campaign whose checkout posts the order directly, with no cart call
at all, still records the step as `skipped` with that reason; a create that
responds non-2xx is reported as `ok: false` rather than hidden. A response body
whose line shape is unreadable omits `line_count` rather than reporting zero.

### Package/bundle card selection and coupons

Two flags target funnels the default-tier drive cannot prove:

- `--select-package <ref[:qty],...>` — **strict** package/bundle card selection.
  Each ref is matched against rendered selector/bundle cards
  (`[data-next-package-id]`, `[data-next-bundle-card][data-next-bundle-id]`) and
  clicked; when the selector exposes selected-state markers
  (`data-next-selected="true"` / `.next-selected`), the card must actually enter
  the selected state. A ref that matches no card, or a card that refuses
  selection, **fails the `selected_bundle` step** instead of silently driving
  the pre-selected default tier. Use this to traverse non-default tiers of a
  multi-tier selector (for example the 1x tier of a 3-tier funnel). `--cart`
  remains the best-effort variant.
- `--apply-coupon <code>` — types the code into the rendered coupon/promo input
  (`[data-next-checkout-field="coupon"]` and common fallbacks, revealing a
  collapsed "Have a coupon?" disclosure when needed) and clicks the apply
  control before card entry, as a new `coupon_applied` ladder step. Funnels
  with **no shopper-typable coupon surface** (the code is applied by page JS,
  e.g. an exit-intent overlay calling `window.next.applyCoupon("CODE")`) fall
  back to the SDK `applyCoupon` API — the step detail records that the
  shopper-facing trigger was not exercised, so verify that trigger separately.
  The apply mechanics never pass the proof on their own: the path passes only
  on **persisted-order read-back evidence**, checked in this order — the
  requested voucher code itemized on the order (authoritative); a positive
  discount total when no voucher entries exist (weak); or, on platforms that
  **net the voucher into line prices and itemize nothing** (no voucher keys,
  empty `discounts`, zero `total_discounts`), a line-price delta: the charged
  line total must sit below the campaign package list total captured from the
  campaign API during the run (weak, `basis: "line_price_delta"`; charged ==
  list fails as "coupon did not apply"). A mismatched voucher or no discount
  evidence on any basis fails the path.

### Spec-driven tier and coupon iteration (`--test-order tiers`)

`--select-package` and `--apply-coupon` are operator-passed and apply globally
to every path in a run, so exercising a multi-tier selector one flag at a time
takes one run per tier. **`--test-order tiers`** derives the order matrix from
the CampaignSpec instead:

- one strict-selection **checkout baseline per selector tier** the spec declares
  in the checkout page's `packages` (refs read from `ref_id`/`package_id`/`id`,
  deduplicated, in declaration order) — each tier goes through the same strict
  `--select-package` machinery, so a tier whose card is missing or refuses
  selection fails its path;
- plus one **checkout order per declared coupon code** — checkout
  `exit_intent.offer_code` and `promo_code_input.offer_code`, counted only when
  the surface has `enabled: true` (the same rule build/doctor use for offer
  surfaces), deduplicated case-insensitively across the two surfaces. Coupon
  orders run on the default tier selection and are proven by the same
  persisted-order read-back ladder as `--apply-coupon` (voucher itemization,
  then discount-total, then the `line_price_delta` weak-evidence basis for
  platforms that net vouchers into line prices; SDK `applyCoupon` fallback when
  no shopper-typable input exists).

Two variants cross tiers with path shapes in a single run:

- `tiers:common` — every declared tier × that checkout's common path shapes
  (checkout/accept/decline plus a deduplicated shortest real receipt path);
- `tiers:full` — every declared tier × that checkout's full set of actual
  terminal paths. This is single-run tier×path coverage; expect the expanded
  count to exceed the default `--max-test-orders` and raise the cap deliberately.

Coupon plans stay single checkout orders in every variant: coupon proof is
persisted-order read-back and does not need upsell traversal. Each planned
order is labeled in assertions and evidence as `checkout@tier:<ref>`,
`accept@tier:<ref>`, `checkout@coupon:<code>`, and the verdict records the
plan (tier ref or coupon code plus its declaring surface) on the order.

`tiers` is incompatible with explicit `--select-package`/`--apply-coupon`
(the mode derives them from the spec; combining would be ambiguous), and it
errors when the spec declares neither selector tiers nor an enabled offer
code — use `common`/`full` or the explicit flags there. Because tiers come
from the CampaignSpec, `tiers` needs a packet/spec-driven run; non-packet
`--site` runs have no declared tiers to iterate.

**Multi-funnel specs are covered in one run**: every funnel's checkout page
contributes plans, and each plan is driven against the checkout page that
declares its tier or coupon (strict-selecting a ref on a checkout that does
not render it would fail for the wrong reason). Plans from the primary (first)
checkout keep bare ids; other funnels' plans are qualified by page id —
`checkout@tier:8#checkout-b` — so the same ref or code declared on two
checkouts cannot collide, and `tiers:common`/`tiers:full` cross each funnel's
tiers with **that funnel's own isolated topology graph and terminals**. A non-primary checkout that
declares tiers/coupons but has no resolvable URL cannot be driven; the runner
prints a `[qa:test-order]` warning naming it instead of silently dropping the
declarations.

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --browser \
  --test-order tiers

# exhaustive tier×path proof, cap raised deliberately
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --browser \
  --test-order tiers:full --max-test-orders 15
```

`--max-test-orders` (default `6`) is an **accidental-flood guard, not a permission
gate**. A single checkout's `common` sample always stays under it, though tier
expansion can exceed it. If `full` expands past the cap, the command stops before
browser launch, prints the planned count, and names the exact
`--max-test-orders <count>` raise. For example, a linear three-offer graph has
eight terminal paths plus the checkout baseline, so it requires
`--max-test-orders 9`. No approval step is involved.

The default card is the Discover test card `6011 1111 1111 1117`, CVV `123`,
expiration `12/2030` (success path; `6011 0009 9013 9424` exercises 3DS). Override
with `--test-card`, `--test-cvv`, `--test-exp-month`, and `--test-exp-year`.

### Test customer email

All test orders should reuse **one** customer, because the Customer/user record
is not deletable — minting a fresh email per run litters the customer list. Set
the address with `--test-email <email>` or `CAMPAIGNS_OS_QA_TEST_EMAIL`. Prefer a
**real, monitored inbox** so the ESP delivers order/receipt notifications instead
of accumulating bounces to an unroutable address (this is why internal runs use a
shared real inbox rather than a synthetic one). When neither is set, the runner
falls back to a single stable synthetic address — still one reused customer, but
not deliverable.

The browser driver intentionally behaves like a user:

- package selection uses rendered `[data-next-package-id]` controls when
  `--cart <package-ref:qty,...>` is supplied (best-effort) or
  `--select-package <ref[:qty],...>` (strict — misses fail the path)
- coupon codes from `--apply-coupon` are typed into the rendered promo input and
  proven against the persisted-order voucher read-back
- checkout is advanced through the visible cart/checkout button
- address autocomplete is settled or closed before submit
- Spreedly card and CVV iframes are filled with sequential keystrokes
- the real submit button is clicked without fabricating SDK state

The intended QA order matrix is:

1. Checkout path with the target bundle/cart selected and typed card accepted.
2. Upsell-decline path by clicking the rendered SDK decline/skip control.
3. Upsell-accept path by clicking the rendered SDK accept/add control.
4. Receipt/order verification from the resulting `ref_id`, including line items,
   selected packages, quantities, shipping method, vouchers/promo codes, discounts,
   and upsell result.

For multi-market campaigns, add at least one non-default currency/country path
to the QA pass. Verify currency display, shipping method names and prices,
available payment methods, and market-specific copy such as delivery promises,
warehouse origin, carrier names, free-shipping claims, and manufacturing claims.
Doctor also warns on two adjacent copy risks before QA: hardcoded `$XX.XX`
amounts outside SDK-bound display regions for multi-currency/non-USD campaigns,
and hardcoded phone numbers that differ from CampaignSpec `campaign.store_phone`.
If a static claim is intentionally preserved, wrap it in an element with
`data-skip-market-lint="true"` and record why in the assembly report.

Test orders themselves need no allowlist or approval. A separate concern is the
**SDK origin allowlist**: the Campaign Cart SDK must be allowed to load on the
tested origin for the campaign API key, or runtime checks (and the live page
itself) may not initialize. Localhost on any port is globally available as a
Campaigns App **Development domain**; SDK calls are allowed there and Campaigns
analytics events are suppressed. Non-localhost preview/production origins still
need SDK origin allowlist confirmation. `qa policy set` records that origin
confirmation in the Build Packet:

```bash
npm run campaigns-os -- qa policy set \
  --packet campaign-runtime.build.json \
  --allowed-domains-confirmed true
```

The `--test-orders-allowed` / `--sandbox-test-card-confirmed` flags are still
accepted and persisted as informational metadata, but they no longer gate test
orders — those run from `--test-order <mode>` alone.

## Launch Readiness Note

Campaigns OS can prove the campaign build, SDK wiring, browser behavior, and
typed-card order paths. It does not prove the merchant is ready for real
shoppers. Before launch, confirm the production storefront URL, live payment
methods, shipping markets, legal/support URLs, analytics expectations, and
merchant-side configuration. Treat these as real-shopper readiness items, not
Campaigns OS build blockers.

The accepted-upsell path passes only after the browser clicks the rendered SDK
accept/add control, observes the order upsell API mutation, and the final order
evidence contains the selected upsell package. A pre-purchase bump line marked
`is_upsell` is not enough to satisfy accepted-upsell proof.

For launch-grade proof on funnels with a checkout bump and post-checkout offers,
use the declared topology instead of a single happy path:

1. Checkout-only with the base cart.
2. Checkout-only with the base cart plus bump when the bump is in scope.
3. Base cart through the checkout/first-action sample plus the shortest real
   receipt path (`--test-order common` covers up to four deduplicated shapes).
4. Base plus bump cart through the same sample matrix when bump behavior is
   launch-relevant.
5. Use `full` when you want every actual terminal path, raising the flood cap to
   the exact planned count when necessary.

Record order numbers, `ref_id` values, and expected line-item shapes in the
handoff. If the browser console shows an SDK module-load error but the SDK
fallback loads and checkout/order proof passes, keep it as platform warning
evidence for the Campaign Cart owner instead of patching campaign source around
it.

The older direct backend mode is available only as
`--legacy-api-test-order <accept|decline|both>`. It is diagnostic behavior, not
canonical launch proof, because it bypasses the deployed campaign page and the
SDK checkout/upsell surfaces.

## Non-packet QA against a built `_site/` (no Build Packet)

A `campaign-build`'d page-kit campaign produces a built `_site/` but no full
Build Packet. Doctor and QA can still run against it: scope (pages + funnel
types) is resolved from the built output, and the residue / placeholder-text /
demo-asset gates run against the chosen family's brand contract.

```bash
# Doctor a built campaign with no packet; optionally auto-emit a minimal packet.
npm run campaigns-os -- doctor --built ../my-campaign-repo --family arjuna --emit-packet

# QA a built, served campaign with no packet/spec.
npm run campaigns-os -- qa run --site ../my-campaign-repo --base-url http://localhost:8080 --family arjuna --browser
```

`--family` is required (the residue gates need the family's brand contract).
`--slug` selects the campaign when `_site/` holds more than one. With no theme
artifacts the theme gate resolves to `not_applicable` (non-blocking), so the
placeholder-text blocker and the other residue gates still run. The emitted
minimal packet is marked `_synthesized` — it points doctor/QA at the built
output and family, and is not a substitute for a real Build Packet.

**Trade-off — non-packet QA is narrower than packet-driven QA.** It runs the
built-output gates (residue, placeholder text, demo-asset, pricing-CSS, brand
contract) but **skips the CampaignSpec/source-HTML-driven checks** a packet
enables: page-coverage and route parity against the spec, SDK meta-tag
expectations, and commerce-ref validation. A doctor-clean non-packet run means
"the built output carries no template residue", **not** "the commerce wiring
matches a spec". Treat it as a residue/visual gate, not equivalent to a
packet-driven QA pass.
