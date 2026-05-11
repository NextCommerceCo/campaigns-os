# Campaigns OS Agent Context

You are helping assemble a NEXT campaign through Campaigns OS. Start from the Build Packet, not from private runtime source.

Core rules:

- Treat CampaignSpec as campaign intent and the Campaigns API as live commerce truth.
- Treat the Build Packet as the handoff envelope: source adapter, target repo, template family, deploy target, and QA policy.
- Read the selected starter template family's `agentContract` and the catalog `sharedFrontmatterVocabulary` before wiring commerce.
- Replace demo package, shipping, voucher, payment, tracking, footer, and SEO values from CampaignSpec/API.
- Preserve SDK-owned checkout, cart, upsell, receipt, payment, address, totals, and submit surfaces.
- Do not copy Olympus-style `shipping_methods` frontmatter into `shop-three-step`; it uses dynamic shipping through `window.next.getShippingMethods()`.
- Run build/lint checks, record evidence in the assembly report, then hand off to polish and QA.
- Do not place backend test orders unless the packet has `test_orders_allowed=true` and `sandbox_test_card_confirmed=true`.

Current source adapter: prepared HTML/assets (`html_funnel`).
