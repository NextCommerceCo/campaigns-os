---
name: next-campaigns-os-setup
version: 2.0.2
description: Bootstrap or prepare a target page-kit campaign repo from a doctor-cleared Campaigns OS Build Packet before full build wiring. Formerly installed as next-campaigns-setup; renamed 2026-08 to stop colliding with the published NextCommerceCo/skills scaffolder of that name.
---

Bundle revision: 1.40.0+skills.1
Run `campaigns-os tooling status --skills-revision 1.40.0+skills.1` at the start of each
task and start a fresh session if it reports `mismatch`, because this text is
already in your context and is never re-read while the CLI on disk can move
under it.

# Next Campaigns OS Setup

## Installed toolkit commands

Run from the campaign folder with an exact project-local devDependency and
committed lockfile. Orient on reviewed source before installation; check release
provenance or pin the full reviewed Git SHA. Preflight with `npx campaigns-os
tooling status --platform <claude|codex>` (tier `B`: its only write is the
command-lifecycle journal) and refresh bundled skills for the same profile with
`install-skills` (tier `B`: writes the shared skill directories; nothing leaves
the machine). Use the invocation printed by status and `next` to avoid PATH shadowing.

In the instructions below, bare `campaigns-os …` means `npx campaigns-os …`
from that campaign folder. Global-only users substitute the global copy's printed invocation for
each `npx campaigns-os` example; toolkit contributors translate to `npm run campaigns-os -- …` in
the toolkit checkout. Browser installation is `npx campaigns-os qa
install-browser`, not a campaign npm script. `tooling diagnose --packet <p>
--json` (tier `none`: read-only, and exempt from lifecycle capture) provides a
redacted support export without changing retained evidence.

The effect class in each parenthetical below is the declared row of
`contracts/effects.v1.json` (`none` < `B` writes < `A` sends < `C` destructive).
Read that file, not this text, when an exact path or endpoint matters.


Use this skill when the Build Packet doctor (tier `none`: read-only inspection) says setup is required before assembly. Setup follows `campaigns-os start` or `campaigns-os prepare-build` (tier `A`: they write the Build Packet, Build Context, assembly report and run session under the target and contact the Map and run endpoints).

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
