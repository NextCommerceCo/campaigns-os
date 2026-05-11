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
6. Preserve SDK-owned checkout/cart/upsell/receipt/payment/address/totals/submit surfaces.
7. Run build and SDK/template lint checks.
8. Record evidence and hand off to polish.

Do not say this is full automated readiness. Build is only one gate before polish, deploy, and QA.
