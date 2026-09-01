# Source Adapters

The current release uses `html_funnel`: prepared HTML/CSS/assets provided by the developer.

The adapter is deliberately explicit so the Build Packet, doctor, build, polish, deploy, and QA gates can reason about the source pages the same way every time.

> **Where does the source HTML come from?** That's the entry-point question, covered in a separate doc: [docs/entry-points.md](./entry-points.md) names the five recognized shapes (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and explains how each populates the inputs this adapter consumes.

Source adapter inputs are compatibility contracts, not the final design-source
contract. `prepare-build` may translate them into Design Source Contributions in
the public Design Source Package while keeping the existing source-html manifest
available for current producers.

## `html_funnel`

Input:

- local folder
- one or more `.html` pages
- assets referenced by those pages
- explicit or inferred page mapping to CampaignSpec pages
- Page Kit target projection in `source_html.pages[].page_kit` after
  `prepare-build`

When no source-html manifest exists, `prepare-build` may infer page mappings
from filenames. If more than one HTML file can satisfy the same active
CampaignSpec page, or if every matching file was already assigned to a sibling
page, Campaigns OS blocks `prepare_build`, records
`context.source.ambiguous_candidates`, and drafts
`context.source.manifest_draft`. Copy that draft to
`.campaigns-os/source-html-manifest.json`, choose the intended candidate path for
each ambiguous page, and rerun `start`/`prepare-build`. The fallback matcher
should not silently choose among ambiguous source or asset-mirror pages.

The `.html` files should be prepared for page-kit ingestion. This does not mean
"rewrite everything into Liquid." Page Kit source files are HTML files with
optional YAML frontmatter and optional Liquid filters/includes. Liquid is only
needed where the page must call page-kit helpers such as `campaign_link`,
`campaign_asset`, or `campaign_include`.

`source_html.pages[].path` is the source file path relative to the source root.
For mixed producers it may point at `figma-export/landing.html` or
`checkout/index.html`. Build agents should use the sibling `page_kit` block for
the target Page Kit file, route, CPK `page_type`, and frontmatter projection.

## Adapter Decisions

`prepare-build` records the reusable conversion contract in three places:

- `packet.source_html.adapter_contract`
- `context.adapter_decisions`
- `report.adapter_decisions`

These fields are intentionally machine-readable so doctor can name unfinished
work instead of relying on chat history:

- `raw_html_conversion_status`: wrapper stripping, frontmatter, asset moves,
  script/style refs, CTA rewrites, route policy, and layout choice are still
  `pending` until build records `completed` or `not_required`.
- `source_asset_strategy`: page-kit campaigns should normally use
  `pagekit_campaign_asset_root`, where `src/<slug>/assets/*` publishes as
  `/<slug>/*`.
- `commerce_shell_adoption`: runtime commerce pages should be
  `template_clone_first_verified` or `sdk_surfaces_preserved` before a completed
  build handoff. `custom_html_experimental` is a doctor blocker on runtime
  pages.
- `route_rewrite_policy`: record whether CampaignSpec routes and CTAs were
  rewritten through campaign-aware routes/helpers.
- `template_files_copied`: records the selected template family as an atomic
  slice. A complete/verified slice covers `pages`, `_includes`, `_layouts`,
  `assets/css`, `assets/js`, and `frontmatter_vocabulary`; its `paths` are
  target-repo-relative proof paths that doctor checks once assembly is complete.
- `config_script_strategy`: records how campaign config scripts load
  (`campaign_asset`, `frontmatter_script`, `inline`, or `not_required`).
- `wrapper_policy`: records whether document wrappers were stripped, preserved,
  or not required.
- `frontmatter_policy`: records whether Page Kit YAML frontmatter was created,
  preserved, or intentionally not required.
- `script_style_reference_policy`: records whether scripts/styles were moved to
  frontmatter, campaign assets, inline blocks, or raw passthrough.
- `cta_rewrite_policy`: records how CTA destinations were rewritten from
  CampaignSpec routes.
- `layout_choice`: records the Page Kit layout strategy used for the prepared
  source.

Raw AI-generated HTML normally needs this conversion pass before build:

1. Keep the page-owned body markup that represents the design intent.
2. Remove document wrappers such as `<!doctype>`, `<html>`, `<head>`, and `<body>` so the page can be wrapped by the campaign layout.
3. Add YAML frontmatter for `title`, the `page_kit.frontmatter.page_type`, route/permalink or `next_url`, and any `styles`/`scripts`.
4. Move reusable `<style>` blocks into `src/<slug>/assets/css/...` and reference them from frontmatter; keep tiny page-specific styles inline only when that matches the target campaign style.
5. Move referenced images/fonts/assets into the campaign asset tree and use `campaign_asset` when paths need to be campaign-rooted. Page Kit copies `src/<slug>/assets/*` to the campaign root in built output: `src/<slug>/assets/config.js` renders as `/<slug>/config.js`, and `src/<slug>/assets/products/foo.png` renders as `/<slug>/products/foo.png`. Do not leave raw `/assets/...` or `/<slug>/assets/...` references in rendered pages unless that nested `assets/` directory exists intentionally.
6. Replace internal page links and CTA destinations with CampaignSpec-derived routes, usually through `campaign_link`.
7. For checkout, upsell, downsell, receipt, payment, totals, and submit controls, preserve or recreate the starter-template SDK contract rather than trusting raw source commerce markup.
8. Run page-kit build and inspect `_site/<slug>/` for a complete body, expected meta tags, campaign-rooted links, and SDK runtime markers.

A single-file static landing page is a good source artifact, but it is not
automatically a complete page-kit page.

## Source preparation check

The preparation steps above used to be tacit knowledge; the doctor now checks
them deterministically (#262). The check runs as the `source_html.preparation`
slot in the Doctor Check Registry (phase `source`) on every mapped
`source_html.pages[].path` file, so `start` and `build` — which embed doctor —
gate on it before assembly, and a plain `campaigns-os doctor` re-checks the
current files after source edits. Blocking findings are doctor **errors**: they
set status `blocked` and `next.stage: "collect-inputs"` like any other
unprepared input. The check is scoped to the certified template families'
page-kit ingestion expectations; it is not a general HTML linter.

| Code | Severity | Meaning and fix |
| --- | --- | --- |
| `source_html.prep.document_wrapper` | error (warning under a recorded `wrapper_policy: "preserve_document_wrappers"`) | A mapped source page is still a full browser document. Strip `<!doctype>`, `<html>`, `<head>`, and `<body>` so the campaign layout can wrap the page (conversion step 2; [docs/quickstart.md](./quickstart.md) "Prepare Raw HTML Source"), or record `preserve_document_wrappers` as an explicit adapter decision. |
| `source_html.prep.frontmatter_residue` | error | Leftover or broken YAML frontmatter: a leading `---` fence that never closes, or a frontmatter block (page-kit keys such as `page_type:`, `next_url:`) embedded below content where page-kit would render it literally. Keep exactly one closed frontmatter block at the very top of the file, or none when the packet's `page_kit.frontmatter` projection supplies it (conversion step 3). |
| `source_html.prep.internal_link_unrooted` | warning | An internal link/CTA still targets a source file (`checkout.html`) instead of a CampaignSpec-derived route. Replace it, usually via `campaign_link` (conversion step 6). Warning rather than error because CTA rewrites are sanctioned build-stage work recorded under `cta_rewrite_policy`; the adapter gates own the completed-assembly block. |

Asset-path rooting (raw `/assets/...` references, missing or out-of-root
files) stays owned by the prepare-build source asset crawl and its
`source_asset.*` codes (conversion step 5); the preparation check does not
duplicate them.

Known-unprepared and prepared reference fixtures live at
`fixtures/source-prep/`; `src/source-prep.test.mjs` and
`src/doctor-source-prep.test.mjs` pin each code and the pass path.

Wedge relevance: the Stage 0 wedge run protocol (#259) includes this check —
wedge runs treat a `source_html.prep.*` blocker as a classified workflow
signal at the source-preparation handoff, not founder-interpretation territory.

Checkout, cart, upsell, receipt, payment, totals, and submit behavior should remain governed by starter-template contracts and SDK wiring. Source files can carry page design, but live commerce behavior comes from the campaign setup and runtime surfaces.

If a source page marks a region as SDK-owned, for example with
`data-commerce-zone="checkout-form"` or comments like `SDK-OWNED: ... provided
by the limos checkout commerce surface`, treat that as an instruction to adopt
the selected starter-template family shell for that runtime surface. It is not
permission to invent a custom checkout shell and paste only borrowed partials
inside it. `prepare-build` records these regions in the Build Context, and
doctor warns until the build path has a clear shell-adoption decision.

Template families are not single-file dependencies. If setup copies a starter
family into a target campaign, copy the matching pages together with their
family `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/` dependencies.
Copying only `checkout.html` and `receipt.html` can leave Liquid includes,
layouts, CSS, or JavaScript unresolved. Record the copied or verified target
paths in `template_files_copied.paths`; a completed report with missing paths is
not doctor-clean.
