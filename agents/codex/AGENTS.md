# Campaigns OS Agent Context

Use this context when working in a target campaign repo with Campaigns OS artifacts.

- Read `campaign-runtime.build.json` first.
- If `.campaign-runtime/build-context.json` or `.campaign-runtime/assembly-report.json` exists, read them before editing campaign files.
- Run `campaigns-os doctor --packet campaign-runtime.build.json` before build work.
- Respect the selected template family's `agentContract`.
- Replace demo refs from CampaignSpec/API; do not preserve starter sample IDs.
- Preserve Campaign Cart SDK-owned checkout, cart, upsell, receipt, payment, address, totals, and submit surfaces.
- For `shop-three-step`, keep dynamic shipping via `window.next.getShippingMethods()` and do not add Olympus-style static `shipping_methods` frontmatter.
- Build hands off to polish; polish hands off to QA.
- This is not full automated readiness. QA remains a separate gate.
