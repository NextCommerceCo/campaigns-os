# Entry Points

A CampaignSpec is the destination contract. Source HTML is the input
that gets composed against it. **Where source HTML comes from is the
entry point.** Different campaigns enter the build pipeline from
different shapes:

| Entry point | `design_source` on spec | Source-HTML manifest | What it looks like |
| --- | --- | --- | --- |
| Template-stock | unset | absent | Spec + filesystem of starter-template pages. No design overlay. |
| Figma-driven | `type: "figma"` | emitted by `figma-sections-export` | Spec + source HTML produced by the Figma exporter. |
| AI-generated | `type: "ai-generated"` | emitted by the producing agent | Spec + source HTML written by an LLM/agent. |
| Hand-authored | unset | absent | Spec + source HTML hand-written by a designer/dev. Same shape as template-stock from the consumer's view. |
| Mixed | per-page | one manifest enumerating every page | Spec + source HTML composed from multiple producers (figma export for landing, template stock for checkout, etc.). |

The build pipeline (`prepare-build` → doctor → setup → build → polish
→ deploy → QA) is **identical across all five entry points**. The
only thing that varies is how the source HTML arrives and how
`design_source` / the manifest get populated. Doctor reads both, the
rest of the pipeline reads the packet doctor produced.

This doc explains how each entry point is recognized, what
populates each input, and what the operator does for that path. The
[Source HTML Manifest Auto-Population](./build-packet.md#source-html-manifest-auto-population)
section in `build-packet.md` covers the manifest consumer
mechanics; this doc names which entry point produces which input.

## Template-stock

The campaign is being scaffolded against a starter template
(e.g. `olympus-mv-single-step`) with **no design overlay yet**. Spec
values fill the template's placeholders. Source HTML is whatever the
template family ships, possibly with light brand tweaks.

- **CampaignSpec:** every page is present but `design_source` is
  unset on every page.
- **Source HTML:** the starter template's `src/` folder copied into
  the target repo. Filenames match standard page-type conventions
  (`landing.html`, `checkout.html`, `upsell.html`, `receipt.html`).
- **Manifest:** absent.
- **`prepare-build` behavior:** falls back to filesystem matching
  (slug-based filename → CampaignSpec page mapping).
- **Doctor behavior:** any page with no source mapping fires the
  generic `source_html.pages.coverage` error (no Figma-specific hint
  because `design_source` is unset).
- **When to use:** initial scaffold, A/B variant testing on top of
  an existing template, no-design-yet builds where the team will add
  design later.
- **Realistic example:** Sam's nanosocks scaffold pass — clone
  `olympus-mv-single-step`, fill spec, ship. Design overlay comes in
  a separate later pass.

## Figma-driven

Design lives in Figma. `figma-sections-export` produces source HTML
plus a manifest at handoff.

- **CampaignSpec:** the pages that need design carry
  `design_source.type === "figma"` with `file_url` plus
  `breakpoints.{desktop, tablet, mobile}` per page.
- **Source HTML:** `figma-sections-export` writes
  `<campaign>/landing.html`, `<campaign>/_includes/landing/*.html`,
  and/or `<campaign>/presell.html` into the source root.
- **Manifest:** `<source>/.campaigns-os/source-html-manifest.json`
  with `generator: "figma-sections-export@<version>"`. Lists the
  pages produced.
- **`prepare-build` behavior:** reads the manifest, populates
  `packet.source_html.pages[]` directly from it (bypasses filesystem
  matching).
- **Doctor behavior:** any spec page with `design_source` but no
  source mapping fires a design_source-aware error naming the
  Figma file and recommending
  `npm run handoff -- <slug>` in figma-sections-export.
- **When to use:** designer authors in Figma, ships the export at
  handoff, build picks up automatically.

## AI-generated

An LLM or agent (Claude, Codex, etc.) writes the source HTML
directly. The contract is the same as figma-driven from the
consumer's view: a manifest at the agreed location with the agreed
schema.

- **CampaignSpec:** pages that were AI-produced carry
  `design_source.type === "ai-generated"` so doctor can produce a
  matching error message ("AI run hasn't completed" vs "designer
  hasn't exported").
- **Source HTML:** written by the AI agent into the source root,
  with the same page-kit-ready conversion conventions documented in
  [`source-adapters.md`](./source-adapters.md).
- **Manifest:** same shape as the figma-driven case
  (`source-html-manifest/v0`), with `generator: "<agent>@<version>"`.
- **`prepare-build` behavior:** identical to figma-driven —
  consumer doesn't care about provenance.
- **Doctor behavior:** when an AI-marked page has no source
  mapping, the design_source-aware error variant for `ai-generated`
  fires (recommends re-running the AI agent rather than re-exporting
  from Figma).
- **When to use:** AI-generated landing/presell while
  checkout/upsell stay on template stock. Pre-existing static HTML
  pipelines that emit the manifest at handoff.

## Hand-authored

Designer or developer hand-writes the HTML directly. From the
consumer's view this is shaped identically to template-stock: spec
without `design_source`, no manifest, files on disk.

- **CampaignSpec:** `design_source` unset on the hand-authored
  pages.
- **Source HTML:** the designer/dev places `.html` files in the
  source root (any name; filesystem matching uses page-type slugs).
- **Manifest:** absent.
- **`prepare-build` behavior:** filesystem matching, same as
  template-stock.
- **Doctor behavior:** generic coverage error for missing pages.
- **When to use:** one-off campaigns, presell article pages with
  bespoke layouts, demos.

## Mixed

A single campaign with **per-page** entry points. Landing from
Figma export, checkout from template stock, presell from an AI run.
Per-page granularity is already in the schema (`design_source` is
per-page; `source_html.pages[]` is per-page).

- **CampaignSpec:** each page carries its own (or no)
  `design_source`. There's no campaign-level "entry point" field —
  per-page is the unit.
- **Source HTML:** one source root, with files placed by whichever
  producer owns that page. Recommend per-page subdirectories
  (`landing/`, `checkout/`, `presell/`) when producers don't
  coordinate filenames.
- **Manifest:** one combined manifest at the source root listing
  every page, with each entry's `path` pointing at its producer's
  output location. Different producers write to different
  subdirectories; the manifest unifies them. Manifest paths are
  relative to the source root (`checkout/index.html`), and the
  reference producer only auto-derives nested `index.html` files from
  their parent directory. Use explicit `--page page_id=path` mappings
  when multiple files would infer the same page id.
- **`prepare-build` behavior:** when a manifest is present it
  governs every mapping — including pages whose path points into a
  template-stock subdirectory. Operators with mixed sources should
  always write a manifest rather than relying on filesystem
  fallback (which is all-or-nothing).
- **Doctor behavior:** per-page error variants fire based on each
  page's `design_source.type`. A figma-marked landing page with no
  manifest entry gets the Figma error; a template-stock checkout
  page (no `design_source`) gets the generic error.
- **When to use:** the realistic case for most live campaigns once
  the design-Figma + template-stock-commerce-surfaces split is
  routine.

## Out of the consumer's hands

The build pipeline doesn't care which agent wrote the source HTML;
it only cares that the contract (filesystem location, manifest
shape, `design_source` shape) is honored. New entry points (Penpot,
Sketch, plain Markdown converters, etc.) slot in by:

1. Adding a `design_source.type` value (open-string, accepted today).
2. Emitting source HTML at the source root.
3. Emitting a `source-html-manifest/v0` manifest if the entry point
   wants doctor's manifest-aware code path; otherwise relying on
   filesystem fallback like template-stock and hand-authored.

No campaigns-os code change is required to add a new entry point if
the producer honors the existing contracts. Doctor's error wording
gets an additional `design_source.type` variant when a new entry
point ships, but that's a polish step, not a gate.
