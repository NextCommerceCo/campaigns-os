# First Build Prompt

Please help me build or evaluate a NEXT Campaign from the CampaignSpec, prepared HTML/assets, starter-template contract catalog, and Campaigns OS Build Packet in this repo.

Start by reading:

- `campaign-runtime.build.json`
- `.campaign-runtime/build-context.json`
- `.campaign-runtime/assembly-report.json`
- `contracts/commerce-surface-catalog.json`

Then:

1. Confirm the public route slug and Map ID.
2. Confirm or challenge the selected template family.
3. Read `families[family].agentContract`.
4. Use `sharedFrontmatterVocabulary`.
5. Replace demo package, shipping, voucher, payment, tracking, footer, and SEO values from CampaignSpec/API.
6. If source HTML is AI-generated/exported standalone HTML, convert it to page-kit-ready markup first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes.
7. Preserve landing/presell source design when it is real source intent.
8. For checkout/upsell/downsell/receipt, use starter-template commerce surfaces as SDK contract references while preserving required runtime controls.
9. Copy starter-template families atomically with dependent pages, `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`; do not copy only checkout/receipt pages.
10. Run build and SDK/template lint checks.
11. Record evidence and hand off to polish.

Do not say this is full automated readiness. Build is only one gate before polish, deploy, and QA.
