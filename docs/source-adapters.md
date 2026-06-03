# Source Adapters

The current release uses `html_funnel`: prepared HTML/CSS/assets provided by the developer.

The adapter is deliberately explicit so the Build Packet, doctor, build, polish, deploy, and QA gates can reason about the source pages the same way every time.

> **Where does the source HTML come from?** That's the entry-point question, covered in a separate doc: [docs/entry-points.md](./entry-points.md) names the five recognized shapes (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and explains how each populates the inputs this adapter consumes.

## `html_funnel`

Input:

- local folder
- one or more `.html` pages
- assets referenced by those pages
- explicit or inferred page mapping to CampaignSpec pages

The `.html` files should be prepared for page-kit ingestion. This does not mean
"rewrite everything into Liquid." Page Kit source files are HTML files with
optional YAML frontmatter and optional Liquid filters/includes. Liquid is only
needed where the page must call page-kit helpers such as `campaign_link`,
`campaign_asset`, or `campaign_include`.

Raw AI-generated HTML normally needs this conversion pass before build:

1. Keep the page-owned body markup that represents the design intent.
2. Remove document wrappers such as `<!doctype>`, `<html>`, `<head>`, and `<body>` so the page can be wrapped by the campaign layout.
3. Add YAML frontmatter for `title`, `page_type`, route/permalink or `next_url`, and any `styles`/`scripts`.
4. Move reusable `<style>` blocks into `src/<slug>/assets/css/...` and reference them from frontmatter; keep tiny page-specific styles inline only when that matches the target campaign style.
5. Move referenced images/fonts/assets into the campaign asset tree and use `campaign_asset` when paths need to be campaign-rooted.
6. Replace internal page links and CTA destinations with CampaignSpec-derived routes, usually through `campaign_link`.
7. For checkout, upsell, downsell, receipt, payment, totals, and submit controls, preserve or recreate the starter-template SDK contract rather than trusting raw source commerce markup.
8. Run page-kit build and inspect `_site/<slug>/` for a complete body, expected meta tags, campaign-rooted links, and SDK runtime markers.

A single-file static landing page is a good source artifact, but it is not
automatically a complete page-kit page.

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
layouts, CSS, or JavaScript unresolved.
