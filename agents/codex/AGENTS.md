# Campaigns OS Agent Context

Use this context when working in a target campaign repo with Campaigns OS artifacts.

- Read `campaign-runtime.build.json` first.
- If `.campaign-runtime/build-context.json` or `.campaign-runtime/assembly-report.json` exists, read them before editing campaign files.
- Run `campaigns-os doctor --packet campaign-runtime.build.json` before build work.
- Respect the selected template family's `agentContract`.
- Replace demo refs from CampaignSpec/API; do not preserve starter sample IDs.
- Preserve Campaign Cart SDK-owned checkout, cart, upsell, receipt, payment, address, totals, and submit surfaces.
- Prepared AI/exported HTML must be converted into page-kit-ready source first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design.
- For checkout/upsell/downsell/receipt, use starter-template commerce surfaces as SDK contract references: preserve required `data-next-*` controls and runtime wiring, but let the campaign/source own visual chrome, copy hierarchy, imagery, and brand layer.
- Copy a starter template family atomically with dependent pages, `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`; do not copy only checkout/receipt pages.
- Emit SDK routing meta tags as campaign-root paths such as `/campaign-slug/upsell/`.
- Default one-time `packages.prepurchase_*` bumps to fixed quantity unless the CampaignSpec explicitly requires package sync.
- Record spec-driven drops so polish does not reintroduce unsupported source elements.
- For `shop-three-step`, keep dynamic shipping via `window.next.getShippingMethods()` and do not add Olympus-style static `shipping_methods` frontmatter.
- Build hands off to polish; polish hands off to QA.
- QA uses the Campaigns OS Node/npm runner. Install the package-owned Playwright browser with `npm run qa:install-browser`, run `campaigns-os qa resolve`, then run `campaigns-os qa run --browser` against the deployed preview URL.
- Typed-card test-order proof, when policy allows, must use `campaigns-os qa run --test-order <checkout|decline|accept|both|full|explicit-path>` through the deployed checkout and rendered upsell controls. For deep funnels, prefer operator-approved explicit accept/decline samples unless exhaustive `full` is approved. Do not use external browser skills, the SDK test-mode event, or hand-built backend API orders as launch proof.
- This is not full automated readiness. QA remains a separate gate.
