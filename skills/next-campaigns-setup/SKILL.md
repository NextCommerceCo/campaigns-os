---
name: next-campaigns-setup
description: Bootstrap or prepare a target page-kit campaign repo from a doctor-cleared Campaigns OS Build Packet before full build wiring.
---

# Next Campaigns Setup

Use this skill when the Build Packet doctor says setup is required before assembly.

Responsibilities:

- Confirm the target repo exists and has or can install `next-campaign-page-kit`.
- Create the campaign output directory only through page-kit-compatible structure.
- When copying a selected starter template family, copy the family as an atomic page-kit slice: pages plus required `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`. Do not copy only `checkout.html` and `receipt.html`.
- Install or reference `.campaign-runtime/agent-context` without overwriting existing root agent files.
- Record setup status in both `.campaign-runtime/build-context.json` (`scaffold.required`, `scaffold.mode`, handoff fields) and `.campaign-runtime/assembly-report.json` (`stages.setup`).
- Hand off to `next-campaigns-build`.

Do not wire checkout, upsell, receipt, payment, package, voucher, or shipping behavior in setup. Build owns that work after the template contract is locked.
