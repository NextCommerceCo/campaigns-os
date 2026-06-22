# Source HTML Assemble Slice Plan

This note scopes the first owned `campaigns-os assemble` slice for source-html-to-page-kit campaigns. It is intentionally narrower than a universal assembler: Campaigns OS should first own the deterministic adapter decisions that local scripts repeatedly reimplement, while leaving campaign-specific merchandising copy and unusual commerce choreography to the build agent until the contracts are richer.

## Current Local Glue

The Roadside eval adapter performed these reusable operations outside Campaigns OS:

- copied source assets into the page-kit campaign asset root;
- converted standalone source HTML into page-kit files with YAML frontmatter;
- stripped document wrappers and loaded a passthrough layout;
- rewrote page links, SDK meta, and CTAs to CampaignSpec/public-route paths;
- adopted starter-template commerce pages as the checkout/upsell/receipt baseline;
- patched CampaignSpec-derived package, shipping, next/decline, and payment-method frontmatter;
- copied/applied `brand-theme.css` after `next-core.css`;
- recorded adapter decisions, theme application, assembly stage status, and page-kit build summary paths.

## First Owned Slice

Add `campaigns-os assemble --packet <campaign-runtime.build.json> [--context <json>] [--report <json>] [--dry-run]`.

The first slice should own only deterministic, schema-backed work:

1. Validate that `packet.source_html.pages[].page_kit` exists for every mapped page.
2. For non-commerce source pages (`product` Page Kit type), write page-kit files from the mapped source HTML:
   - strip `<!doctype>`, `<html>`, `<head>`, and `<body>`;
   - preserve page-owned body markup;
   - add frontmatter from `page_kit.frontmatter`;
   - move local asset refs according to `context.source.asset_crawl`;
   - rewrite local page links/CTAs to `page_kit.public_route` values.
3. Verify or record the selected starter family slice for commerce pages without editing SDK-owned checkout/payment/totals/submit regions.
4. Copy an existing generated brand theme artifact into `src/<slug>/assets/css/brand-theme.css` and append it to commerce page `styles` after `next-core.css` when `report.theme.status` is ready to apply.
5. Update `packet.source_html.adapter_contract`, `context.adapter_decisions`, and `report.adapter_decisions` from `pending` to completed/not-required for the operations actually performed.
6. Record `stages.assembly.source_build_fingerprint` and `stages.assembly.source_package_material_fingerprint` when the Design Source Package fields are present.

## Deferred

Do not initially own these campaign-specific decisions:

- selecting package IDs, shipping method IDs, order bump content, or upsell tier copy;
- removing or adding payment providers beyond contract-guided warnings;
- force-package/product-selector strategy for two-step and single-step checkout variants;
- residue polishing beyond deterministic adapter residue created by the assembler;
- matrix generation across multiple template families.

## Tests For The Slice

- Fixture: one landing page plus checkout/receipt starter pages.
- Assert dry-run lists every target write and adapter decision transition.
- Assert assemble writes `src/<slug>/landing.html` with frontmatter and no document wrappers.
- Assert copied assets resolve under `src/<slug>/assets/*`.
- Assert report/context/packet carry consistent adapter decision completion and assembly fingerprints.
- Assert commerce pages are not modified unless the operation is theme-style insertion after `next-core.css`.

This slice would remove the source page projection and artifact-recording parts of the Roadside adapter. Roadside-specific package, shipping, product copy, payment-provider cleanup, and matrix variant orchestration would still remain local or agent-owned until separate CampaignSpec/template contracts cover them.
