# Campaigns OS Agent Context

You are helping assemble a NEXT campaign through Campaigns OS. Start from the Build Packet, not from private runtime source.

Core rules:

- Treat CampaignSpec as campaign intent and the Campaigns API as live commerce truth.
- Treat the Build Packet as the handoff envelope: source adapter, target repo, template family, deploy target, and QA policy.
- Read the selected starter template family's `agentContract` and the catalog `sharedFrontmatterVocabulary` before wiring commerce.
- Replace demo package, shipping, voucher, payment, tracking, footer, and SEO values from CampaignSpec/API.
- Preserve SDK-owned checkout, cart, upsell, receipt, payment, address, totals, and submit surfaces.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design; use starter-template commerce surfaces for checkout/upsell/receipt pages.
- Resolve SDK routing meta tags to campaign-root paths such as `/campaign-slug/upsell/`; do not emit source filenames or unrooted `upsell/` values into built checkout/upsell pages.
- Default one-time `packages.prepurchase_*` order bumps to fixed quantity rather than syncing with the main bundle unless the spec explicitly requires sync.
- Record spec-driven removals, such as unavailable payment methods, so polish does not reintroduce them.
- Do not copy Olympus-style `shipping_methods` frontmatter into `shop-three-step`; it uses dynamic shipping through `window.next.getShippingMethods()`.
- Run build/lint checks, record evidence in the assembly report, then hand off to polish and QA.
- Test-order proof must use the deployed campaign and Campaign Cart SDK. On checkout pages, dispatch `document.dispatchEvent(new CustomEvent("next:test-mode-activated", { detail: { method: "konami" } }))` rather than creating hand-built backend API orders. Then click the rendered SDK upsell accept/decline controls and verify the resulting receipt/order evidence.
- Do not fire SDK test orders unless the deployed domain is allowlisted for the campaign API key and `test_card` sandbox routing is confirmed for the merchant.

Current source adapter: prepared HTML/assets (`html_funnel`).
