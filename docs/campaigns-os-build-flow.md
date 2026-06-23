# Campaigns OS Build Flow

The happy path is intentionally tight:

1. Export a saved local CampaignSpec JSON from Campaign Map Builder, including Map ID and public route slug.
2. Run `campaigns-os start` with the CampaignSpec, prepared source files, target page-kit repo, and template family.
3. Treat doctor as the first gate. If it returns `collect-inputs`, stop and resolve the named blocker.
4. Run setup when doctor asks for setup; otherwise continue to assembly.
5. Assemble the page-kit campaign from starter-template contracts, not from copied demo commerce values.
6. Run page-kit build plus SDK/template lint and record results in the assembly report.
7. Run polish against the built campaign, then deploy a preview.
8. Install the package-owned Playwright browser with `npm run qa:install-browser`.
9. Run `campaigns-os qa resolve`, then `campaigns-os qa run --browser --test-order common` with the tested URL. QA runs publish to the QA portal by default (the QA tab records browser QA plus typed-card proof and the run prints its portal link); pass `--no-post-verdict` only for offline / dev / CI runs.
10. Treat test-order depth as the control: global test cards bypass the gateway and create no transactions, so no approval is needed. Localhost on any port is a Campaigns App Development domain (SDK allowed, analytics suppressed); non-localhost preview/production origins must still be allowlisted for the campaign API key so the SDK loads.
11. Promote, block, or iterate from the recorded build, polish, deploy, QA, and test-order evidence.

Pause only for missing inputs, doctor blockers, blocked deploys, out-of-scope runtime pages that block checkout proof, or merchant-specific uncertainty. The default path should not branch into external browser skills or hand-built backend order creation.

## Partial Builds

Partial builds are valid campaign work. A pass may build only new presell pages,
landing pages, upsells, downsells, or another bounded slice that sends traffic
to an existing downstream route. In the Build Packet, map pages being built with
`source_html.pages[].path` and mark intentionally untouched pages with
`source_html.pages[].skip_reason`.

For mapped pages, `source_html.pages[].path` is source provenance. Use
`source_html.pages[].page_kit` for the Page Kit target file, public route, CPK
`page_type`, and frontmatter projection.

`doctor` classifies that as `derived.scope.mode = "partial"`. Mapped pages are
route/visual-testable after deploy. Skipped checkout, upsell, downsell, or
receipt pages keep checkout launch readiness and test-order proof blocked until
those runtime pages are built or explicitly delegated to an existing downstream
URL.

## Commerce Ownership

- CampaignSpec/API own live campaign identity, routes, package refs, offer refs, shipping refs, payment support, tracking intent, footer links, and SEO values.
- Starter template contracts own the SDK attribute contract and protected runtime surfaces: checkout/cart/upsell/receipt/payment/address/totals/submit controls and their required data attributes.
- Designed source owns visual composition, content hierarchy, imagery, and page-level copy.

Packages identify sellable products or variants, and Offers own campaign price changes. Package Retail Price/Quantity fields may exist on older campaigns, but assembly should not introduce them for new tier pricing.

## Offer Application Surfaces

CampaignSpec may declare checkout-level offer application behavior through
`funnels[].pages[].exit_intent` and `funnels[].pages[].promo_code_input`.
Treat these fields as intent for runtime checkout surfaces, not as separate
pricing models:

- `exit_intent.offer_ref_id` points at the configured campaign Offer.
- `exit_intent.offer_code` is the voucher/promo code the runtime should apply
  when the shopper accepts the pop.
- `promo_code_input.offer_ref_id` points at the configured campaign Offer.
- `promo_code_input.offer_code` is the voucher/promo code the runtime should
  accept through the manual entry surface.
- optional `notes` fields are build/QA implementation notes. Durable popup
  copy, CTA labels, placeholders, success labels, and active labels belong to
  the source design or selected template, not the Spec.

Build should wire the selected starter-template checkout so the accepted offer
is applied through the Campaign Cart SDK/Campaigns API path. Do not hardcode
discount math, mutate static price literals, or treat the pop as an alternate
bundle model. After the code is active, bundle selectors, totals, order summary,
and discount rows should render from SDK/API state.

Code-specific presentation belongs in SDK conditionals, for example:

```html
<span data-next-show='cart.hasCoupon("FREESHIP")'>Free shipping applied</span>
```

A promo-code box accepts a shopper-entered code and asks SDK/API to validate and
apply it; it does not own pricing truth. When `promo_code_input.enabled` is
declared, build should preserve or create the template/source promo-code surface,
wire it to the mapped `offer_code`, and record the implementation decision in
the assembly report.

## Assembly Rules

- Landing and presell pages should preserve prepared HTML when it is a real standalone design. Use page-kit passthrough structure, inject the SDK/config requirements, and repoint CTAs into the CampaignSpec flow.
- **Pre-checkout pages must ship the same SDK bootstrap as the checkout layout.** Presell and landing pages are SDK `page_type: product`; they need `config.js` (before the loader), the `campaign-cart@v{sdk_version}/dist/loader.js` module script, and the `next-funnel` + `next-page-type` meta tags — not just inert `data-next-*` attributes. Without the loader the SDK silently no-ops: `data-next-hide` conditional visibility (`param.banner` / `param.seen`), `utmTransfer` UTM/query carry-through to checkout (top-of-funnel ad attribution), and SDK analytics never fire. Treat `param.banner` / `param.seen` visibility and `utmTransfer` as standard pre-checkout wiring, not per-campaign discoveries. Doctor enforces this with `built_output.pre_checkout_sdk_bootstrap`.
- Checkout, upsell, downsell, and receipt pages should preserve starter-template SDK contracts while keeping the campaign/source visual language. Treat starter templates as the reference for required `data-next-*` controls and wiring, not as a mandate to carry their visual chrome into the final campaign.
- If source HTML declares SDK-owned zones such as `data-commerce-zone="checkout-form"` or `data-commerce-zone="order-summary"`, adopt the selected starter-template family shell for that runtime page. Do not build a custom checkout/upsell structure around a few borrowed includes; browser QA will check declared family structure where `agentContract.qaStructure` exists.
- If `context.theme` names a generated `brand-theme.css`, copy it into campaign assets and load it after `next-core.css` on checkout, upsell, downsell, and receipt pages. Generated brand-theme v0 is root-variable-only; do not use it as permission to edit SDK-owned selectors or runtime structure.
- Buy-more-save-more selectors should use selected quantity plus Offer-aware price displays. Do not swap in stale package-per-tier IDs unless the CampaignSpec explicitly represents an older campaign that still owns separate packages for each option.
- SDK routing meta tags should be emitted as campaign-root paths, for example `/campaign-slug/upsell/`, even when the CampaignSpec source value is slug-relative like `upsell/`.
- One-time prepurchase/order-bump packages outside the main bundle should default to fixed quantity and fixed line total display unless the spec explicitly requires syncing quantity with the main bundle.
- Checkout exit-intent pops and promo-code inputs are protected offer application surfaces. Preserve/apply the selected family's SDK coupon/voucher hooks; skin the shell and copy around them.
- Any source element dropped because the spec does not support it, such as PayPal when `available_payment_methods` excludes PayPal, should be recorded in the assembly report for polish.
- After page-kit build, doctor checks rendered local script references plus rendered package and shipping refs against the CampaignSpec. Missing built scripts, stale package IDs, stale shipping IDs, and unavailable package refs must be fixed or intentionally blocked before QA.
- Browser QA opens SDK-owned runtime pages once as a shopper and once with `?debugger=true`. The debugger pass should prove the Campaign Cart debugger overlay and selector controls mount without changing the normal checkout/test-order flow.
- Browser QA also checks template-family commerce structure when the family contract declares machine-checkable selectors. Missing required Limos checkout shell markers, for example, are treated as a warning-severity failure: the checkout may load, but it is not proven as a conformant Limos checkout.

## Synthetic Campaigns

For AI-generated or synthetic campaigns, the static source page can be used to
exercise the design-to-page-kit path, but SDK checkout still needs a Campaigns
App campaign, store URL, packages, shipping/payment configuration, and an SDK
origin that can load the campaign API key. Localhost on any port is available for
Development-domain SDK checks, but a non-localhost preview/production origin must
be allowlisted. If the evaluator has no natural merchant/store,
reuse a designated test store and record that choice. Otherwise mark checkout,
receipt, and test-order QA as blocked instead of debugging an SDK loading state
as if it were a page-kit build failure.

## Not Full Automation

This repo improves first-run success. It does not yet prove a campaign is live-ready.

Campaigns OS proof is not merchant launch readiness. Before launch, confirm the
production storefront URL, live payment methods, shipping markets, legal/support
URLs, analytics expectations, and merchant-side configuration.
