# Campaigns OS Agent Context

Use this context when working in a target campaign repo with Campaigns OS artifacts.

- Read `campaign-runtime.build.json` first.
- If `.campaign-runtime/build-context.json` or `.campaign-runtime/assembly-report.json` exists, read them before editing campaign files.
- Run `campaigns-os doctor --packet campaign-runtime.build.json` before build work.
- Respect the selected template family's `agentContract`.
- Replace demo refs from CampaignSpec/API; do not preserve starter sample IDs.
- Preserve Campaign Cart SDK-owned checkout, cart, upsell, receipt, payment, address, totals, and submit surfaces.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design; use starter-template commerce surfaces for checkout/upsell/receipt pages.
- Emit SDK routing meta tags as campaign-root paths such as `/campaign-slug/upsell/`.
- Default one-time `packages.prepurchase_*` bumps to fixed quantity unless the CampaignSpec explicitly requires package sync.
- Record spec-driven drops so polish does not reintroduce unsupported source elements.
- For `shop-three-step`, keep dynamic shipping via `window.next.getShippingMethods()` and do not add Olympus-style static `shipping_methods` frontmatter.
- Build hands off to polish; polish hands off to QA.
- This is not full automated readiness. QA remains a separate gate.
