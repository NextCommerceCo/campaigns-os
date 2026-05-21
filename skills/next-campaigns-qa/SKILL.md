---
name: next-campaigns-qa
description: Run spec-aware QA from a Campaign Map ID and deployed campaign URL after build, polish, and deploy evidence exist, including Playwright typed-card test-order proof when requested.
---

# Next Campaigns QA

Use this after the campaign has a preview or production URL and the assembly report records build and polish status. The public v0 runner is Node/npm-based, with an owned Playwright browser pass:

```bash
npm run qa:install-browser
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url>
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url> --browser
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url> --browser --post-verdict
```

`npm run qa:install-browser` is part of the standard QA sequence. Run it once
after install/update before using `--browser` or `--test-order`; do not skip it
unless the local Playwright browser binary is already installed.

Inputs:

- Campaign Map ID from the Build Packet
- deployed base URL
- assembly report
- QA/test-order policy and sandbox routing confirmation

Rules:

- Use the public Node/npm `campaigns-os qa` commands for campaign QA runs.
- Keep QA in a tight sequence: install the Playwright browser, resolve topology, run browser QA, then run typed-card test-order proof when policy allows. Pause only for missing inputs, blocked policy, or merchant-specific uncertainty.
- Use `--browser` for rendered browser evidence. Browser QA must use the package-owned Playwright flow, not external agent/browser skills.
- Use `--post-verdict` whenever the user expects the QA tab/dashboard to list the run. A run with `posted: null` is local-only evidence under `qa-output/` and must not be reported as dashboard-visible.
- Browser QA must include checkout commerce geometry evidence, not just mount counts: express-wallet buttons rendered in the current browser, card/CVV hosted iframe host dimensions, iframe text-path height, and center alignment. Apple Pay is browser/device eligible, so record mounted wallet kinds instead of requiring Apple Pay in Chrome-only QA.
- `qa resolve` accepts either the deploy host or the campaign-root URL; when a Build Packet carries `campaign.public_route_slug`, the runner resolves page URLs under that slug.
- Routing meta tags must be checked in runtime form. `next-success-url`, `next-upsell-accept-url`, and `next-upsell-decline-url` should point at campaign-root paths such as `/campaign-slug/upsell/`, not source filenames or unrooted spec literals.
- Upsell accept/decline routes may be SDK-bound controls rather than static `<a href>` links. Treat rendered `data-next-upsell-action="add"` and `data-next-upsell-action="skip"` controls as valid route evidence, then prove the path in the browser walkthrough.
- When CampaignSpec declares checkout `exit_intent.enabled`, browser QA should trigger/open the pop, accept the mapped offer, and verify the code is active, totals/order summary reprice through SDK/API state, and `cart.hasCoupon("CODE")` presentation appears only after apply.
- When the deployed checkout includes a promo-code input, browser QA should enter a valid campaign voucher/promo code and verify active-code state, repricing, discount row rendering, and conditional presentation. Missing promo-code input is a blocker only when CampaignSpec, source design, or user instructions declared it.
- Test orders must exercise the deployed campaign through the Campaign Cart SDK, not a hand-built backend API request.
- Use the canonical Playwright typed-card path: fill customer/shipping fields, type sandbox card data into the active hosted payment iframes, and click the real checkout submit button.
- The legacy SDK test-mode event and direct API order path are diagnostic fallbacks only; do not use them as launch proof unless the operator explicitly asks for a diagnostic fallback.
- After the base checkout test order redirects to upsell, click the rendered SDK upsell accept/decline controls to prove the live upsell path. Do not fabricate upsell lines with a direct API call.
- Do not fire test orders unless the preview/production domain is allowed for the campaign API key and sandbox card routing is confirmed for that merchant.
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
