# Campaigns OS Agent Context

You are helping assemble a NEXT campaign through Campaigns OS. Start from the Build Packet, not from private runtime source.

Core rules:

- Treat CampaignSpec as campaign intent and the Campaigns API as live commerce truth.
- Treat the Build Packet as the handoff envelope: source adapter, target repo, template family, deploy target, and QA policy.
- Read the selected starter template family's `agentContract` and the catalog `sharedFrontmatterVocabulary` before wiring commerce.
- Replace demo package, shipping, voucher, payment, tracking, footer, and SEO values from CampaignSpec/API.
- Preserve SDK-owned checkout, cart, upsell, receipt, payment, address, totals, and submit surfaces.
- Prepared AI/exported HTML must be converted into page-kit-ready source first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design.
- For checkout/upsell/downsell/receipt, use starter-template commerce surfaces as SDK contract references: preserve required `data-next-*` controls and runtime wiring, but let the campaign/source own visual chrome, copy hierarchy, imagery, and brand layer.
- Copy a starter template family atomically with dependent pages, `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`; do not copy only checkout/receipt pages.
- Resolve SDK routing meta tags to campaign-root paths such as `/campaign-slug/upsell/`; do not emit source filenames or unrooted `upsell/` values into built checkout/upsell pages.
- Default one-time `packages.prepurchase_*` order bumps to fixed quantity rather than syncing with the main bundle unless the spec explicitly requires sync.
- Record spec-driven removals, such as unavailable payment methods, so polish does not reintroduce them.
- Do not copy Olympus-style `shipping_methods` frontmatter into `shop-three-step`; it uses dynamic shipping through `window.next.getShippingMethods()`.
- Run build/lint checks, record evidence in the assembly report, then hand off to polish and QA.
- QA uses the Campaigns OS Node/npm runner: install the package-owned Playwright browser with `npm run qa:install-browser`, run `campaigns-os qa resolve --packet campaign-runtime.build.json`, then run `campaigns-os qa run --packet campaign-runtime.build.json --base-url <preview-url> --browser`.
- Test-order proof must use the canonical Playwright typed-card path through the deployed checkout: select the rendered cart, fill customer/shipping fields, type the sandbox card into active hosted payment iframes, click the real submit button, then click rendered SDK upsell accept/decline controls and verify receipt/order evidence.
- Do not use external browser skills, the SDK test-mode event, or hand-built backend API orders as launch proof. Those are diagnostic fallbacks only when explicitly requested.
- Do not fire SDK test orders unless the deployed domain is allowlisted for the campaign API key and `test_card` sandbox routing is confirmed for the merchant.

Current source adapter: prepared HTML/assets (`html_funnel`).
