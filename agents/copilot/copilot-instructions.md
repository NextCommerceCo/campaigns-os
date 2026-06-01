# Campaigns OS Instructions

When this repository contains Campaigns OS artifacts, use them as the build handoff:

- `campaign-runtime.build.json` defines the CampaignSpec, source adapter, target output, template family, deploy target, and QA policy.
- `.campaign-runtime/build-context.json` records page mappings and setup/build handoff details.
- `.campaign-runtime/assembly-report.json` records stage evidence and blockers.

Preserve Campaign Cart SDK-owned commerce surfaces. Replace starter demo refs from CampaignSpec/API. Prepared AI/exported HTML must be converted into page-kit-ready source first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes. Landing/presell pages can preserve source design; checkout/upsell/downsell/receipt should use starter-template commerce surfaces as SDK contract references while campaign/source owns visual chrome. Copy starter template families atomically with dependent pages, `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`; do not copy only checkout/receipt pages. Do not claim launch readiness until build, polish, deploy, and QA evidence are recorded.

QA must use the Campaigns OS Node/npm runner. Install the package-owned Playwright browser with `npm run qa:install-browser`, run `campaigns-os qa resolve`, then run `campaigns-os qa run --browser` against the deployed preview URL. Typed-card test-order proof must use `campaigns-os qa run --test-order <common|checkout|decline|accept|both|full|explicit-path>` through the deployed checkout and rendered upsell controls; global test cards bypass the gateway and create no transactions, so no permission/approval is needed — depth is the only control (`common` = default 3-5 shape sample, `full` = every permutation). Do not use external browser skills, SDK test-mode events, or direct backend orders as launch proof.
