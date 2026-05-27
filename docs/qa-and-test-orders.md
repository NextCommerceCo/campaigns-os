# QA And Test Orders

The public v0 QA runner is Node/npm-based and does not require access to a private runtime repo.

## Resolve

Use resolve before a full run:

```bash
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
```

Resolve reads the packet, loads the local CampaignSpec when available, derives deployed page URLs from the packet deploy URL or `--base-url`, and prints the funnel topology. It does not create a verdict.

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

Add `--browser` to run the first-party Playwright browser pass after the Node
checks. If the browser binary is missing, the CLI will prompt you to run
`npm run qa:install-browser`:

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --browser
```

The browser pass renders each live page in Chromium, captures browser console
errors, page errors, and failed requests, verifies rendered upsell controls, and
inspects checkout payment field mounts. It is owned by this package through the
`playwright` dependency; QA must not rely on external browser skills or local
agent tooling.

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

Add `--post-verdict` when the operator expects the QA tab/dashboard to list the
run. Runs without `--post-verdict` are local-only and will not appear in the QA
dashboard run picker:

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --post-verdict
```

## Test Orders

Canonical test-order proof is typed-card, browser-driven checkout automation. The
QA runner opens the deployed campaign checkout with Playwright, selects the
intended cart with rendered campaign controls, fills the customer/shipping form,
types the sandbox card into the active hosted payment iframes, and clicks the
real checkout submit button. A hand-built backend API order does not prove the
deployed checkout/upsell surfaces.

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --test-order checkout \
  --allow-test-orders \
  --sandbox-test-card-confirmed \
  --post-verdict
```

Supported modes are `checkout`, `decline`, `accept`, `both`, `full`, and explicit
accept/decline paths such as `accept-decline`, `accept-accept-decline`, or
`decline-decline-accept`. `checkout` stops after the base order redirect.
`decline` and `accept` click the rendered controls on the first upsell page.
`both` creates two fresh checkout orders for those first-page paths. `full`
derives the number of sequential upsell/downsell pages from the resolved funnel
topology and creates fresh checkout orders for every accept/decline combination.
For example, a two-offer funnel creates four paths, while a five-offer funnel
creates 32 paths plus the checkout baseline.

To prevent accidental order floods, browser test orders default to
`--max-test-orders 6`. If `full` expands beyond that cap, the command stops and
prints the generated order count. Choose explicit accept/decline paths for a
smaller sample matrix, or rerun with a larger `--max-test-orders` only after the
operator approves that order count.

The default card is the Discover sandbox card `6011 1111 1111 1117`, CVV `123`,
expiration `12/2030`. Override with `--test-card`, `--test-cvv`,
`--test-exp-month`, and `--test-exp-year` when a merchant/gateway requires a
different sandbox card.

Browser test orders can reuse a shared safe inbox with `--test-email <email>` or
`CAMPAIGNS_OS_QA_TEST_EMAIL` so repeated QA does not create a new customer/user
record for every run.

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

Only fire test orders when the campaign preview/production domain is allowlisted
for the campaign API key and the operator-approved order count/path depth is clear.
Test orders are QA evidence; they are not deleted as part of the automated flow.

Use `qa policy set` to record those confirmations in the Build Packet without
editing JSON by hand:

```bash
npm run campaigns-os -- qa policy set \
  --packet campaign-runtime.build.json \
  --test-orders-allowed true \
  --sandbox-test-card-confirmed true \
  --allowed-domains-confirmed true
```

The accepted-upsell path passes only after the browser clicks the rendered SDK
accept/add control, observes the order upsell API mutation, and the final order
evidence contains the selected upsell package. A pre-purchase bump line marked
`is_upsell` is not enough to satisfy accepted-upsell proof.

For launch-grade proof on funnels with a checkout bump and sequential upsells,
use a topology-depth matrix instead of a single happy path:

1. Checkout-only with the base cart.
2. Checkout-only with the base cart plus bump when the bump is in scope.
3. Base cart through an operator-approved sample matrix, for example all-decline,
   all-accept, and one or two mixed accept/decline paths.
4. Base plus bump cart through the same sample matrix when bump behavior is
   launch-relevant.
5. Use `full` only when the operator explicitly wants exhaustive proof for the
   generated order count.

Record order numbers, `ref_id` values, and expected line-item shapes in the
handoff. If the browser console shows an SDK module-load error but the SDK
fallback loads and checkout/order proof passes, keep it as platform warning
evidence for the Campaign Cart owner instead of patching campaign source around
it.

The older direct backend mode is available only as
`--legacy-api-test-order <accept|decline|both>`. It is diagnostic behavior, not
canonical launch proof, because it bypasses the deployed campaign page and the
SDK checkout/upsell surfaces.
