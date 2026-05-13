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
- For `landing` and `presell` pages, prefer the prepared source HTML when `source_html.pages[].path` points at a real standalone page. Preserve the design/content through a passthrough page-kit layout, inject the SDK loader/config as needed, and repoint CTAs into the CampaignSpec flow.
- For `checkout`, `upsell`, `downsell`, and `receipt` pages, start from the selected starter-template commerce surface and swap only campaign-owned values/content; do not rebuild protected SDK controls from source HTML.
- Resolve SDK routing meta tags to deployed campaign-root paths, not spec literals. For example, `next-success-url: upsell/` in the spec should become `/<public_route_slug>/upsell/` in built HTML.
- If an order bump package comes from `packages.prepurchase_*` and is not one of the main `bundles[]`, default `package_sync=false` and `show_line_total_price=false` unless the CampaignSpec explicitly says the add-on quantity must sync with the main bundle.
- For two-step package-selection-before-checkout flows, use the selector page as the pre-checkout step, encode the selected cart with `forcePackageId`, preserve attribution/tracking params, and strip `forcePackageId` from the visible checkout URL after SDK initialization.
- Record intentional drops from source HTML in the assembly report, especially payment/provider changes such as "PayPal removed because CampaignSpec available_payment_methods excludes it." Polish must inherit these decisions.
- After page-kit build, inspect rendered `_site` output: body exists, Campaign Cart runtime markers exist, `sdk_hints.meta_tags` rendered, route meta points at the campaign root, and copied funnel attribution/runtime baggage is gone.
- For `shop-three-step`, shipping methods are dynamic through `window.next.getShippingMethods()`; do not add static Olympus-style `shipping_methods` frontmatter.
- Run page-kit build and SDK/template lint available in the target repo.
- Update the assembly report with commands, evidence, warnings, blockers, and next owner.

Build does not replace polish or QA. Hand off to `next-campaigns-polish` when the campaign is runnable.
