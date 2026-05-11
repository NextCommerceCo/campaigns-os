---
name: next-campaigns-qa
description: Run spec-aware QA from a Campaign Map ID and deployed campaign URL after build, polish, and deploy evidence exist.
---

# Next Campaigns QA

Use this after the campaign has a preview or production URL and the assembly report records build and polish status.

Inputs:

- Campaign Map ID from the Build Packet
- deployed base URL
- assembly report
- QA/test-order policy

Rules:

- Do not place backend test orders unless `test_orders_allowed=true` and `sandbox_test_card_confirmed=true`.
- Treat missing deploy URL, missing polish status, or unresolved doctor blockers as launch blockers.
- Report blockers, warnings, and residual risks.
- QA follows build and polish; it does not edit campaign code.
