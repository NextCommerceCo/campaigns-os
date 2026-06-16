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
- Public families resolve from the default `public` starter-templates source. A **private** family (one whose source lives in an access-controlled repo, e.g. a certified family not present in the public picker) is scaffolded via page-kit's template-source mechanism (`next-campaign-page-kit` >= 0.2.0): add a named source to the target repo's `_data/template-sources.json` (a `git` source with the SSH `url` + optional `ref`, or a `local` source `path`), then `campaign-init --source <name> --template <slug>`. The source repo must expose a root `templates.json` catalog + `src/<slug>/` tree. page-kit holds no family→repo mapping; the source config lives in the (private) consuming repo, and this skill (plus the family's certified contract) is where that source is known.
- Install or reference `.campaign-runtime/agent-context` without overwriting existing root agent files.
- Record setup status in both `.campaign-runtime/build-context.json` (`scaffold.required`, `scaffold.mode`, handoff fields) and `.campaign-runtime/assembly-report.json` (`stages.setup`).
- Preserve existing Build Context `theme` inspection data and Assembly Report `theme` application data when setup is rerun against an existing campaign directory.
- Hand off to `next-campaigns-build`.

Do not wire checkout, upsell, receipt, payment, package, voucher, or shipping behavior in setup. Build owns that work after the template contract is locked.
