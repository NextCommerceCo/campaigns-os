---
name: next-campaigns-build
description: Assemble a NEXT campaign from a doctor-cleared Build Packet, CampaignSpec/API values, prepared HTML/assets, page-kit, and starter-template contracts.
---

# Next Campaigns Build

Inputs:

- `campaign-runtime.build.json`
- `.campaign-runtime/build-context.json`
- `.campaign-runtime/assembly-report.json`
- local CampaignSpec JSON
- prepared HTML/assets source
- target page-kit repo
- starter-template commerce catalog

Build rules:

- Read `families[template_family].agentContract` before editing commerce surfaces.
- Use `sharedFrontmatterVocabulary` to identify values that come from CampaignSpec/API.
- Replace `frontmatter.demoOnlyValues`.
- Replace values named by `frontmatter.replaceFromSpecOrApi`.
- Remove unsupported surfaces named by `frontmatter.removeWhenUnsupported`.
- Preserve SDK-owned checkout/cart/upsell/receipt/payment/address/totals/submit surfaces.
- If `doctor` reports `derived.scope.mode = "partial"`, build only pages listed in `derived.scope.built_pages`. Do not invent or rebuild skipped checkout/upsell/downsell/receipt pages; carry their `skip_reason` into the assembly report and label the preview as route/visual-testable rather than full-funnel launch-ready.
- For `landing` and `presell` pages, prefer the prepared source HTML when `source_html.pages[].path` points at a real standalone page. Preserve the design/content through a passthrough page-kit layout, inject the SDK loader/config as needed, and repoint CTAs into the CampaignSpec flow. Treat `source_html.pages[].path` and `context.page_map[].source_path` as source provenance. Treat `source_html.pages[].page_kit`, `context.page_map[].page_kit`, and `context.page_map[].output_path` as the Page Kit target file, route, CPK `page_type`, and frontmatter projection.
- Prepared source HTML means page-kit-ready markup, not a wholesale Liquid rewrite. Standalone AI/exported HTML should keep page-owned body markup, remove document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only where page-kit needs campaign-rooted links/assets/includes.
- For `checkout`, `upsell`, `downsell`, and `receipt` pages, treat the selected starter-template commerce surface as the SDK contract reference: preserve required `data-next-*` controls, hidden fields, payment/address/totals/submit wiring, and `next_dont_touch` regions. The surrounding HTML wrapper, page composition, imagery, copy hierarchy, and brand layer are campaign/source-owned. Do not carry starter visual chrome forward when prepared source design should own that surface.
- Read `context.theme` and `.campaign-runtime/theme/theme-report.json` when present. If a fresh `brand-theme.css` artifact exists, copy it into the campaign asset tree and load it after `next-core.css` on checkout, upsell, downsell, and receipt pages. If policy is `inspect_only`, either run `campaigns-os theme generate` or record an explicit skipped reason before applying a new brand layer.
- Generated brand-theme v0 is root-variable-only. It may skin commerce pages through next-core custom properties, but it is not permission to edit SDK-owned selectors, package controls, payment fields, totals, submit controls, receipt templates, route meta tags, or SDK JavaScript.
- Payment, express checkout, bundle selectors, and order bumps must start from the selected family's canonical component DOM/classes, not from raw custom/source HTML with `data-next-*` added afterward. For payment specifically, preserve the family payment-method wrapper, hosted field classes, and iframe geometry assumptions (for example `input-flds spreedly-field` in shop-style templates). Skin these components with campaign tokens; do not rebuild Spreedly/card fields as arbitrary divs.
- When a checkout page declares `exit_intent.enabled`, wire the popup as an offer application surface: use `offer_ref_id`/`offer_code` from CampaignSpec, apply the code through the SDK/API coupon/voucher path, and render applied-state copy with SDK conditionals such as `cart.hasCoupon("FREESHIP")`.
- When a checkout page declares `promo_code_input.enabled`, wire the template/source promo-code surface to accept the mapped CampaignSpec `offer_code`, submit it through SDK/API, and let SDK/API reprice selectors, totals, and discount rows.
- Do not hardcode exit-pop or promo-code discount math, static post-discount prices, or campaign-specific JavaScript that mutates pricing display outside SDK-owned display regions.
- If setup/build needs starter-template files, copy the template family atomically with its dependent pages, `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`; copying only checkout/receipt pages is incomplete.
- Resolve SDK routing meta tags to deployed campaign-root paths, not spec literals. For example, `next-success-url: upsell/` in the spec should become `/<public_route_slug>/upsell/` in built HTML.
- If an order bump package comes from `packages.prepurchase_*` and is not one of the main `bundles[]`, default `package_sync=false` and `show_line_total_price=false` unless the CampaignSpec explicitly says the add-on quantity must sync with the main bundle.
- For two-step package-selection-before-checkout flows, use the selector page as the pre-checkout step, encode the selected cart with `forcePackageId`, preserve attribution/tracking params, and strip `forcePackageId` from the visible checkout URL after SDK initialization.
- Record intentional drops from source HTML in the assembly report, especially payment/provider changes such as "PayPal removed because CampaignSpec available_payment_methods excludes it." Polish must inherit these decisions.
- Preserve any existing Build Context `theme` inspection state and Assembly Report `theme` application state. If build applies, skips, or invalidates generated theme CSS, update `report.theme` rather than leaving stale evidence.
- After page-kit build, inspect rendered `_site` output: body exists, Campaign Cart runtime markers exist, `sdk_hints.meta_tags` rendered, route meta points at the campaign root, and copied funnel attribution/runtime baggage is gone.
- For `shop-three-step`, shipping methods are dynamic through `window.next.getShippingMethods()`; do not add static Olympus-style `shipping_methods` frontmatter.
- Run page-kit build and SDK/template lint available in the target repo.
- Update the assembly report with commands, evidence, warnings, blockers, and next owner. If a brand theme was applied, record `report.theme.status`, `css_path`, `commerce_pages`, `load_order=after-next-core`, evidence, and any first repair-loop defect.

Build does not replace polish or QA. Hand off to `next-campaigns-polish` when the campaign is runnable.
