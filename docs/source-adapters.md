# Source Adapters

V0 uses `html_funnel`: prepared HTML/CSS/assets provided by the developer.

The adapter is deliberately explicit so future design sources can enter the same downstream workflow without changing the Build Packet, doctor, build, polish, deploy, and QA gates.

## Current Adapter: `html_funnel`

Input:

- local folder
- one or more `.html` pages
- assets referenced by those pages
- explicit or inferred page mapping to CampaignSpec pages

## Future Adapter: Figma-Led Assembly

The realistic long-term path is:

```text
Figma file built on supported section conventions
  -> design export stage
  -> page-kit-native pages, partials, assets, and refs
  -> Campaigns OS packet/doctor/build/polish/QA
```

Checkout, cart, upsell, receipt, payment, totals, and submit behavior should remain governed by starter-template contracts and SDK wiring. Figma owns page design; it does not own live commerce behavior.

Do not add Figma-specific packet fields in v0.
