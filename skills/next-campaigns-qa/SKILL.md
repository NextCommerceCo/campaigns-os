---
name: next-campaigns-qa
description: Run spec-aware QA from a Campaign Map ID and tested campaign URL after build, polish, and deploy/local evidence exist, including Playwright typed-card test-order proof.
---

# Next Campaigns QA

Use this after the campaign has a preview or production URL and the assembly report records build and polish status. The public v0 runner is Node/npm-based, with an owned Playwright browser pass:

```bash
npm run qa:install-browser
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url>
# Fixture-driven migration parity proof. Publishes to the QA portal by default.
npm run campaigns-os -- qa parity --fixture <parity-fixture.json> --scenario <scenario-id> --base-url <preview-url>
# Browser QA + typed-card proof. Publishes to the QA portal by default and prints the portal link.
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url> --browser --test-order common
# Offline / dev / CI only: keep the verdict local
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url> --browser --test-order common --no-post-verdict
```

`npm run qa:install-browser` is part of the standard QA sequence. Run it once
after install/update before using `--browser` or `--test-order`; do not skip it
unless the local Playwright browser binary is already installed.

Inputs:

- Campaign Map ID from the Build Packet
- tested base URL (localhost dev URL, preview URL, or production URL)
- assembly report
- Test-order depth choice (`common` default vs explicit paths vs `full`) and SDK origin state (localhost is a Development domain; non-localhost origins need allowlist confirmation so the SDK loads)

Rules:

- Use the public Node/npm `campaigns-os qa` commands for campaign QA runs.
- Use `qa parity` for migration cells that carry a parity fixture; select the fixture scenario and drive that offer through the candidate funnel.
- Parity capture blocking proof is the voucher-adjusted persisted line from typed-card order readback. Browser totals and client state do not replace the persisted-line voucher guard.
- Read client purchase values per event. A whole-cart `dl_purchase` must not mask or supply an offer-level upsell purchase expectation.
- Live `qa parity` runs publish to the QA portal by default like other QA runs. Pass `--no-post-verdict` for dev, replay, negative-control, and other local proof runs.
- Theme gate: `qa run` refuses to run when a generatable brand theme is not applied to commerce pages and no waiver exists. Apply the brand layer or record a waiver (`campaigns-os theme waive` / `qa run --theme-waive "<reason>"`); do not bypass the gate another way. A waived run still reports template-residue findings at warn severity.
- Template residue is a QA dimension, not advice: promoted starter families must have a brand/residue/pricing contract (`contracts/template-brand-contract.<family>.v0.json`). Browser QA inspects computed styles on commerce surfaces and fails pages that still render starter defaults (`#3c7dff`/`#0a265c`, starter `next-logo.png`, paypal/klarna chrome absent from the spec).
- Pricing visibility is a blocker: an upsell/downsell offer with zero visible price rows fails QA. Pricing surfaces render via template pricing modes (`full_price`, `compare_at_current`, `unit_price_plus_total`, `savings_badge_amount`, `code_discounted_post_checkout`), never via campaign CSS `display:none` on price wrappers.
- Exit-pop widgets are governed offer surfaces. If the selected family ships or copies a default exit-pop and CampaignSpec has no checkout `exit_intent` or `promo_code_input`, QA/doctor must report it as residue; strip it or wire the mapped offer/code through the SDK coupon path.
- Typed-card runs emit a per-step ladder (`[qa:test-order] step=... status=...`) with bounded per-step and per-path timeouts, and always produce a verdict — a hung or crashed path is a blocked verdict with the step ladder as evidence, not a silent exit. Read the last completed step before re-running.
- Keep QA in a tight sequence: install the Playwright browser, resolve topology, run browser QA plus typed-card proof with `--test-order common` by default. Test orders need no permission step. Pause only for missing inputs, out-of-scope runtime pages that block checkout proof, or merchant-specific uncertainty.
- Use `--browser` for rendered browser evidence. Browser QA must use the package-owned Playwright flow, not external agent/browser skills.
- QA runs publish to the QA portal by default, so the QA tab/dashboard carries the full audit log and the run prints its portal link — report that link as the run reference. Pass `--no-post-verdict` (or `--local-only`) only for offline / dev / CI runs; those stay local-only under `qa-output/` and must not be reported as dashboard-visible.
- Browser QA must include checkout commerce geometry evidence, not just mount counts: express-wallet buttons rendered in the current browser, card/CVV hosted iframe host dimensions, iframe text-path height, and center alignment. Apple Pay is browser/device eligible, so record mounted wallet kinds instead of requiring Apple Pay in Chrome-only QA.
- `qa resolve` accepts either the deploy host or the campaign-root URL; when a Build Packet carries `campaign.public_route_slug`, the runner resolves page URLs under that slug.
- Routing meta tags must be checked in runtime form. `next-success-url`, `next-upsell-accept-url`, and `next-upsell-decline-url` should point at campaign-root paths such as `/campaign-slug/upsell/`, not source filenames or unrooted spec literals.
- Upsell accept/decline routes may be SDK-bound controls rather than static `<a href>` links. Treat rendered `data-next-upsell-action="add"` and `data-next-upsell-action="skip"` controls as valid route evidence, then prove the path in the browser walkthrough.
- When CampaignSpec declares checkout `exit_intent.enabled`, browser QA should trigger/open the pop, accept the mapped offer, and verify the code is active, totals/order summary reprice through SDK/API state, and `cart.hasCoupon("CODE")` presentation appears only after apply.
- When CampaignSpec declares checkout `promo_code_input.enabled`, browser QA should enter the mapped `offer_code` and verify active-code state, repricing, discount row rendering, and conditional presentation. Missing promo-code input is a blocker when CampaignSpec, source design, or user instructions declared it.
- Test orders must exercise the tested campaign through the Campaign Cart SDK, not a hand-built backend API request.
- Use the canonical Playwright typed-card path: fill customer/shipping fields, type sandbox card data into the active hosted payment iframes, and click the real checkout submit button.
- Use a shared safe inbox for typed-card test-order customer email when the operator provides one. Reusing one safe inbox keeps customer/user lists clean while still allowing notification delivery.
- The legacy SDK test-mode event and direct API order path are diagnostic fallbacks only; do not use them as launch proof unless the operator explicitly asks for a diagnostic fallback.
- Do not use `next.getCartData().cartLines` as cart-populated proof. That field currently stays empty; use typed-card order read-back for committed cart truth, the `cart:updated` payload `items` / `summary.lines` for in-page cart state, and rendered bundle DOM evidence for pre-commit selection.
- After the base checkout test order redirects to upsell, click the rendered SDK upsell accept/decline controls to prove the live upsell path. Do not fabricate upsell lines with a direct API call.
- Valid test-order modes are `common`, `checkout`, `accept`, `decline`, `both`, `full`, `off`, and explicit accept/decline paths such as `accept-decline-accept`.
- Browser test orders default to a max-order cap (an accidental-flood guard, not a permission gate). If `full` expands past it, choose explicit sample paths or rerun with a larger `--max-test-orders`.
- For multi-offer funnels, `--test-order common` covers the typical checkout-plus-accept/decline sample automatically. Use exhaustive `full` when you want every generated permutation.
- Accepted-upsell proof is valid only when the browser observes the order upsell API mutation and the final order evidence contains the selected upsell package. A checkout bump line marked `is_upsell` is not accepted-upsell proof.
- Test orders are safe to fire any time: global test cards bypass the gateway, create no transactions, and need no merchant-specific sandbox routing confirmation. Localhost on any port is globally available as a Campaigns App Development domain and suppresses Campaigns analytics; non-localhost preview/production origins must be allowlisted for the campaign API key so the SDK loads — that is about SDK initialization, not test-order permission.
- Launch readiness is separate from Campaigns OS proof. If QA passes on local/preview, still surface production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration as real-shopper readiness items before launch.
- For multi-market campaigns, verify at least one non-default currency/country path: currency display, shipping method names/prices, available payment methods, and market-specific copy.
- Treat missing deploy URL, missing polish status, or unresolved doctor blockers as launch blockers.
- Report blockers, warnings, and residual risks.
- QA follows build and polish; it does not edit campaign code.

Canonical test-order flow:

1. Open the deployed checkout URL in the package-owned Playwright browser session.
2. Select the intended bundle/cart using the rendered campaign controls.
3. Fill the checkout fields with QA customer/address data.
4. Type the sandbox card into the active hosted payment iframes and click the real checkout submit button.
5. Wait for the SDK to create the test order and redirect with `ref_id`.
6. On upsell pages, click the actual accept or decline button for the target path.
7. Verify receipt/order evidence and summarize order number, `ref_id`, selected cart, active vouchers/promo codes, discounts, upsell path, and line-item result.

Do not use `campaigns-os qa --legacy-api-test-order` as the canonical proof path. It bypasses the deployed campaign page and the SDK checkout/upsell surfaces; keep it only as a diagnostic fallback when explicitly requested.
