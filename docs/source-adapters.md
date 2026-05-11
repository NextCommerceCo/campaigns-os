# Source Adapters

The current release uses `html_funnel`: prepared HTML/CSS/assets provided by the developer.

The adapter is deliberately explicit so the Build Packet, doctor, build, polish, deploy, and QA gates can reason about the source pages the same way every time.

## `html_funnel`

Input:

- local folder
- one or more `.html` pages
- assets referenced by those pages
- explicit or inferred page mapping to CampaignSpec pages

Checkout, cart, upsell, receipt, payment, totals, and submit behavior should remain governed by starter-template contracts and SDK wiring. Source files can carry page design, but live commerce behavior comes from the campaign setup and runtime surfaces.
