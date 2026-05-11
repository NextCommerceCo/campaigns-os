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
- For `shop-three-step`, shipping methods are dynamic through `window.next.getShippingMethods()`; do not add static Olympus-style `shipping_methods` frontmatter.
- Run page-kit build and SDK/template lint available in the target repo.
- Update the assembly report with commands, evidence, warnings, blockers, and next owner.

Build does not replace polish or QA. Hand off to `next-campaigns-polish` when the campaign is runnable.
