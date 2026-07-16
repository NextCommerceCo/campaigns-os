# QA And Test Orders

The public v0 QA runner is Node/npm-based and does not require access to a private runtime repo.

> **Commerce QA requires network; it cannot run in a no-outbound sandbox.** The SDK, product images, fonts, the Netlify preview, and the Playwright typed-card test order all need outbound network. A build environment without it can only validate markup/build/CSS — the commerce runtime and the typed-card test order (the Campaigns OS control) must be deferred to a deployed preview. Always run the QA runner against a `--base-url` preview/production origin (e.g. `npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url https://deploy-preview-7--your-site.netlify.app/ --browser --test-order common`); never report commerce-runtime QA as passed from an offline build.

## Resolve

Use resolve before a full run:

```bash
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
```

Resolve reads the packet, loads the local CampaignSpec when available, derives deployed page URLs from the packet deploy URL or `--base-url`, and prints the funnel topology. It does not create a verdict.

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

Install the package-owned Playwright browser once before rendered QA or
test-order proof:

```bash
npm run qa:install-browser
```

This installs the Chromium binary used by `--browser` and `--test-order`. It is
part of the normal Campaigns OS QA path after `npm install` or package updates.
The QA flow must not depend on external browser skills or local agent tooling.

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/
```

The runner fetches deployed pages, checks route availability, verifies CampaignSpec `sdk_hints.meta_tags`, writes a local verdict JSON under `qa-output/<map-id>/<run-id>.json`, and returns exit code `4` when the verdict is blocked.

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
  --analytics-baseline https://legacy.example.com/campaign/thank-you/
```

| Flag | Meaning |
|---|---|
| `--analytics-baseline <url>` | Legacy funnel URL to capture as the parity baseline (enables the leg) |
| `--analytics-candidate <url>` | Migrated URL to capture; defaults to `--base-url` |
| `--analytics-hosts a,b` | Extra host substrings to treat as analytics tag-fires (Everflow is built in) |
| `--analytics-settle <ms>` | Wait after load for async tags to fire (default 5000) |

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

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --test-order common
```

The default mode is **`common`** (also what bare `--test-order` runs): a sensible
3-5 shape sample — the checkout baseline, plus first-upsell `accept` and `decline`
when the funnel has post-checkout offers, plus one deeper mixed path when there
are two or more offers. This is the everyday QA depth.

Other modes: `checkout` (base order redirect only), `accept`/`decline` (click the
rendered control on the first upsell page), `both` (two fresh orders for those
first-page paths), explicit accept/decline paths such as `accept-decline-accept`
for a targeted matrix, and **`full`** — every accept/decline permutation derived
from the funnel's sequential upsell/downsell depth (a two-offer funnel = 4 paths,
a five-offer funnel = 32 paths plus the checkout baseline). Use `full` when you
explicitly want exhaustive proof. Bundle/quantity and bump coverage come from
`--cart`.

`--max-test-orders` (default `6`) is an **accidental-flood guard, not a permission
gate**. `common` always stays under it; if `full` expands past it, the command
stops and prints the planned count so you can choose a smaller matrix or raise the
cap. No approval step is involved.

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
  `--cart <package-ref:qty,...>` is supplied
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

For launch-grade proof on funnels with a checkout bump and sequential upsells,
use a topology-depth matrix instead of a single happy path:

1. Checkout-only with the base cart.
2. Checkout-only with the base cart plus bump when the bump is in scope.
3. Base cart through a sample matrix, for example all-decline, all-accept, and
   one or two mixed accept/decline paths (`--test-order common` covers the
   typical 3-5 of these automatically).
4. Base plus bump cart through the same sample matrix when bump behavior is
   launch-relevant.
5. Use `full` when you want exhaustive proof for the full generated order count.

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
