---
name: next-campaigns-os-setup
version: 2.1.0
description: Bootstrap or prepare a target page-kit campaign repo from a doctor-cleared Campaigns OS Build Packet before full build wiring. Formerly installed as next-campaigns-setup; renamed 2026-08 to stop colliding with the published NextCommerceCo/skills scaffolder of that name.
---

# Next Campaigns OS Setup

Use this skill when the Build Packet doctor says setup is required before assembly.

Responsibilities:

- Confirm the target repo exists and has or can install `next-campaign-page-kit`.
- Create the campaign output directory only through page-kit-compatible structure.
- When copying a selected starter template family, copy the family as an atomic page-kit slice: pages plus required `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`. Do not copy only `checkout.html` and `receipt.html`.
- Public families resolve from the default `public` starter-templates source. A **private** family (one whose source lives in an access-controlled repo, e.g. a certified family not present in the public picker) is scaffolded via page-kit's template-source mechanism (`next-campaign-page-kit` >= 0.2.0): add a named source to the target repo's `_data/template-sources.json` (a `git` source with the SSH `url` + optional `ref`, or a `local` source `path`), then `campaign-init --source <name> --template <slug>`. The source repo must expose a root `templates.json` catalog + `src/<slug>/` tree. page-kit holds no family→repo mapping; the source config lives in the (private) consuming repo, and this skill (plus the family's certified contract) is where that source is known.
- Install or reference `.campaign-runtime/agent-context` without overwriting existing root agent files.
- Install the Netlify preview-links workflow on every setup run (fresh and existing modes), so a pull request lists a deploy-preview URL for each campaign it changes. See "Netlify preview links" below.
- Record setup status in both `.campaign-runtime/build-context.json` (`scaffold.required`, `scaffold.mode`, handoff fields) and `.campaign-runtime/assembly-report.json` (`stages.setup`).
- Preserve existing Build Context `theme` inspection data and Assembly Report `theme` application data when setup is rerun against an existing campaign directory.
- Hand off to `next-campaigns-build`.

Do not wire checkout, upsell, receipt, payment, package, voucher, or shipping behavior in setup. Build owns that work after the template contract is locked.

## Netlify preview links

Campaign repos deliberately connect to Netlify by deploy key plus a direct GitHub webhook rather than the Netlify GitHub App, so Netlify never posts its deploy-preview URL back to a pull request. `references/netlify-preview-links.yml` closes that gap: it derives the changed campaigns from the PR diff and keeps one sticky comment listing `https://deploy-preview-{PR}--{site}.netlify.app/{slug}/` for each. This file is the canonical copy; the campaign template and the provisioning runbook render from it.

**Only install it in a Campaign Page Kit repo.** The slug-to-URL mapping the workflow depends on exists nowhere else. Before touching `.github/`, confirm all of:

- root `scripts/build.js` and `scripts/smoke-check.js`
- a `netlify.toml` publishing `_site`
- at least one top-level directory holding both `package.json` and `src/`

If any is missing, install nothing and record a `stages.setup.warnings` entry ("repo is not CPK-shaped; preview-links workflow not installed"). A legacy flat-root campaign repo must be left exactly as it is.

On a CPK repo, reconcile `.github/workflows/netlify-preview-links.yml` against the reference:

- Missing → install.
- Present, carries the `# managed-by: next-campaigns-os-setup netlify-preview-links` marker, differs from the reference → overwrite.
- Present without the marker → someone hand-wrote it. Leave it alone and record a `stages.setup.warnings` entry.

Substitute `__NETLIFY_SITE_NAME__` with the repo's Netlify site name, resolved in this order: `.netlify/state.json`, `netlify status`, then the Netlify API by repo linkage. Never guess it — the site name is the store name and does not always match the repo name. If it cannot be resolved, install with the placeholder intact and warn: the workflow detects its own unsubstituted state and exits without commenting, so an unresolved site name is inert rather than wrong.

Record the installed workflow path in `stages.setup.outputs`.

Gotchas:

- A push that adds or edits anything under `.github/workflows/` needs an SSH remote. The `gh` OAuth token used by most local sessions has no `workflow` scope and the push is rejected.
- The links only resolve where Netlify actually builds PR previews, which needs the deploy webhook (or App) present on the repo. The comment still posts without it; the URLs just 404.
- The comment posts as soon as the PR updates, ahead of the Netlify build, so a link can 404 for a minute.
