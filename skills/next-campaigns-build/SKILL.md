---
name: next-campaigns-build
version: 1.0.31
description: Assemble a NEXT campaign from a doctor-cleared Build Packet, CampaignSpec/API values, prepared HTML/assets, page-kit, and starter-template contracts.
---

Bundle revision: 1.51.0+skills.1
Run `npx --no-install campaigns-os tooling status --skills-revision 1.51.0+skills.1`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Next Campaigns Build

## Installed toolkit commands

Run from the campaign folder with an exact project-local devDependency and
committed lockfile. Orient on reviewed source before installation; check release
provenance or pin the full reviewed Git SHA. Preflight with `npx --no-install
campaigns-os tooling status --platform <claude|codex>` (tier `B`: its only write
is the command-lifecycle journal) and refresh bundled skills for the same
profile with `install-skills` (tier `B`: writes the shared skill directories;
nothing leaves the machine). Use the invocation printed by status and `next` to
avoid PATH shadowing.

In the instructions below, bare `campaigns-os …` means `npx --no-install
campaigns-os …` from that campaign folder. Keep `--no-install`: `campaigns-os`
is only the bin name of `@nextcommerce/campaigns-os`, so where no pinned copy is
installed a plain `npx` looks that name up on the registry and, with no terminal
to ask, installs what it finds. Global-only users substitute the global copy's
printed invocation for each `npx --no-install campaigns-os` example; toolkit
contributors translate to `npm run campaigns-os -- …` in the toolkit checkout.
Browser installation is `npx --no-install campaigns-os qa install-browser`, not
a campaign npm script. `tooling diagnose --packet <p> --json` (tier `none`:
read-only, and exempt from lifecycle capture) provides a redacted support export
without changing retained evidence.

The effect class in each parenthetical below is the declared row of
`contracts/effects.v1.json` (`none` < `B` writes < `A` sends < `C` destructive).
Read that file, not this text, when an exact path or endpoint matters.


## Recommended Build Loop

For campaign builds, follow **build → independent review → repair → verification**.
The main session owns the plan, integration, and final acceptance. Choose subagent
assignments and models for the task's required capabilities and the consequences
of failure, especially for SDK-owned commerce, payments, offers, and theme wiring.
Among suitable models, prefer cheaper ones for bounded implementation, inspection,
and repair.

Have a fresh reviewer inspect the result against the source material and actual
rendered or runtime evidence, without the builder's rationale. Keep one writer at
a time. Resolve concrete findings and rerun the relevant checks before declaring
completion. After two repair-and-verification rounds that leave the targeted
finding or failing required check unresolved, reassess the approach or surface
the blocker. Scale review depth to the task and preserve the existing checks and
approval boundaries. Carry review and verification through the existing Polish
and QA stages; assembly review does not replace them.

If delegation is unavailable or disallowed, perform a distinct self-review in the
current session and disclose that no independent agent reviewed the result.

## Inputs and Build Rules

Inputs:

- `campaign-runtime.build.json`
- `.campaign-runtime/build-context.json`
- `.campaign-runtime/assembly-report.json`
- local CampaignSpec JSON
- prepared HTML/assets source
- target page-kit repo
- starter-template commerce catalog

Build rules:

- Read `families[template_family].agentContract` before editing commerce surfaces.
- Use `sharedFrontmatterVocabulary` to identify values that come from CampaignSpec/API.
- Replace `frontmatter.demoOnlyValues`.
- Replace values named by `frontmatter.replaceFromSpecOrApi`.
- Remove unsupported surfaces named by `frontmatter.removeWhenUnsupported`.
- Preserve SDK-owned checkout/cart/upsell/receipt/payment/address/totals/submit surfaces.
- If `doctor` (tier `A`: inspection that writes nothing, plus one read-only live campaign request once the site is built and a public campaign key resolves; `--write` is also tier `A` and writes doctor output; `--built` is tier `B`) reports `derived.scope.mode = "partial"`, build the pages listed in `derived.scope.built_pages` from their prepared source. Keep every out-of-scope route unbuilt by default, including pages marked `template_stock: true`; never publish placeholder presell/landing pages that remain on another host. Materialize a stock page only with explicit per-page operator opt-in (including a required pre-checkout `select` stand-in). For opted-in pages use the locked family's own page for that role with its dependent `_includes/`, `_layouts/`, and assets, wire it from CampaignSpec, and build a required select step first. Do not attest stock screenshots as design source. Built stock pages rejoin preview QA once their HTML exists. Carry remaining `skip_reason` declarations into the report and label the preview route/visual-testable rather than full-funnel launch-ready.
- For `landing` and `presell` pages, prefer the prepared source HTML when `source_html.pages[].path` points at a real standalone page. Preserve the design/content through a passthrough page-kit layout, inject the SDK loader/config as needed, and repoint CTAs into the CampaignSpec flow. Treat `source_html.pages[].path` and `context.page_map[].source_path` as source provenance. Treat `source_html.pages[].page_kit`, `context.page_map[].page_kit`, and `context.page_map[].output_path` as the Page Kit target file, route, CPK `page_type`, and frontmatter projection.
- Reproduce the source design's own proof and urgency elements as designed: reviews and testimonials, ratings, "Verified Purchase" labels, recent-purchase popups, stock counters, countdowns and guarantees. They are the merchant's content and the merchant's responsibility; Campaigns OS does not review them, so do not remove, soften or flag them. The starter templates shipping without some of these elements is not a reason to drop the source's.
- Prepared source HTML means page-kit-ready markup, not a wholesale Liquid rewrite. Standalone HTML mockups that are meant to stay whole (their `source_screenshot` proof is of the full document) keep their document wrappers: the source-html manifest records `wrapper_policy: preserve_document_wrappers` (or `--wrapper-policy preserve_document_wrappers` on `start` / `prepare-build`), and doctor reports the wrappers as a warning. Otherwise, standalone AI/exported HTML should keep page-owned body markup, remove document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only where page-kit needs campaign-rooted links/assets/includes.
- For `checkout`, `upsell`, `downsell`, and `receipt` pages, treat the selected starter-template commerce surface as the SDK contract reference: preserve required `data-next-*` controls, hidden fields, payment/address/totals/submit wiring, and `next_dont_touch` regions. The surrounding HTML wrapper, page composition, imagery, copy hierarchy, and brand layer are campaign/source-owned. Do not carry starter visual chrome forward when prepared source design should own that surface. QA checks what the checkout does, not family class names: do not add family shell classes (`.checkout-wrapper`, `.checkout-layout__left/right`) to the campaign's own grid or swap source-owned field markup for family includes to satisfy QA. Keep the checkout working instead: a `<form data-next-checkout="form">`, the contact and shipping fields bound with `data-next-checkout-field` inside it, and a visible cart total. A required field bound only on a `type="hidden"` input, a disabled control, a read-only input or read-only textarea, or a control with `aria-disabled="true"` does not count as bound: QA reports it in `fields_bound.missing`.
- Read `context.theme` and `.campaign-runtime/theme/theme-report.json` when present. If a fresh `brand-theme.css` artifact exists, copy it into the campaign asset tree and load it after `next-core.css` on checkout, upsell, downsell, and receipt pages. If policy is `inspect_only`, either run `campaigns-os theme generate` (tier `B`: writes the theme artifacts and doctor output under the target; `--force` is tier `C`) or record an explicit skipped reason before applying a new brand layer.
- Generated brand-theme v0 is root-variable-only. It may skin commerce pages through next-core custom properties, but it is not permission to edit SDK-owned selectors, package controls, payment fields, totals, submit controls, receipt templates, route meta tags, or SDK JavaScript.
- Payment, express checkout, bundle selectors, and order bumps must start from the selected family's canonical component DOM/classes, not from raw custom/source HTML with `data-next-*` added afterward. For payment specifically, preserve the family payment-method wrapper, hosted field classes, and iframe geometry assumptions (for example `input-flds spreedly-field` in shop-style templates). Skin these components with campaign tokens; do not rebuild Spreedly/card fields as arbitrary divs.
- When a checkout page declares `exit_intent.enabled`, wire the popup as an offer application surface: use `offer_ref_id`/`offer_code` from CampaignSpec, apply the code through the SDK/API coupon/voucher path, and render applied-state copy with SDK conditionals such as `cart.hasCoupon("FREESHIP")`.
- When a checkout page declares `promo_code_input.enabled`, wire the template/source promo-code surface to accept the mapped CampaignSpec `offer_code`, submit it through SDK/API, and let SDK/API reprice selectors, totals, and discount rows.
- When the selected family includes or copies a default exit-pop but CampaignSpec has no checkout `exit_intent` or `promo_code_input`, strip the widget during build; do not leave blank modals or default coupon-code controls in output.
- Do not hardcode exit-pop or promo-code discount math, static post-discount prices, or campaign-specific JavaScript that mutates pricing display outside SDK-owned display regions.
- If setup/build needs starter-template files, copy the template family atomically with its dependent pages, `_includes/`, `_layouts/`, `assets/css/`, and `assets/js/`; copying only checkout/receipt pages is incomplete.
- Resolve SDK routing meta tags to deployed campaign-root paths, not spec literals. For example, `next-success-url: upsell/` in the spec should become `/<public_route_slug>/upsell/` in built HTML.
- If an order bump package comes from `packages.prepurchase_*` and is not one of the main `bundles[]`, default `package_sync=false` and `show_line_total_price=false` unless the CampaignSpec explicitly says the add-on quantity must sync with the main bundle.
- For two-step package-selection-before-checkout flows, use the selector page as the pre-checkout step, encode the selected cart with `forcePackageId`, preserve attribution/tracking params, and strip `forcePackageId` from the visible checkout URL after SDK initialization.
- Record intentional drops from source HTML in the assembly report, especially payment/provider changes such as "PayPal removed because CampaignSpec available_payment_methods excludes it." Polish must inherit these decisions.
- Preserve any existing Build Context `theme` inspection state and Assembly Report `theme` application state. If build applies, skips, or invalidates generated theme CSS, update `report.theme` rather than leaving stale evidence.
- After page-kit build, inspect rendered `_site` output: body exists, Campaign Cart runtime markers exist, `sdk_hints.meta_tags` rendered, route meta points at the campaign root, and copied funnel attribution/runtime baggage is gone.
- For `shop-three-step`, shipping methods are dynamic through `window.next.getShippingMethods()`; do not add static Olympus-style `shipping_methods` frontmatter.
- Run page-kit build and SDK/template lint available in the target repo.
- Record build with `campaigns-os record build --packet <packet>` after every page-kit build (tier `C`: it overwrites `stages.assembly` and, when the output changed, resets `stages.polish` to `required` in the assembly report, and stamps the doctor output stale; `--dry-run` is tier `none`). It stamps `stages.assembly.build_fingerprint` with the fingerprint doctor computes from `_site/<slug>/` and the Design Source Package material fingerprint when the report has one. Never type or copy these fields by hand.
- Capture the machine-readable build summary as an artifact: `npx campaign-build --json > .campaign-runtime/page-kit-build-summary.json` (requires `next-campaign-page-kit` >= 0.1.4). Doctor's `built_output.build_summary` check verifies per-page build status and Page Kit shape warnings (`NESTED_NO_PERMALINK`, `DUPLICATE_OUTPUT`, `MISSING_FRONTMATTER`, `LAYOUT_NOT_FOUND`, `NO_CAMPAIGN`) from this artifact. If the installed page-kit predates `--json`, record that in the assembly report instead of skipping silently.
- Update the assembly report with commands, evidence, warnings, blockers, and next owner. If a brand theme was applied, run `campaigns-os record theme --packet <p>` (tier `C`) after `record build`: it reads each built commerce page's stylesheet links and records `report.theme` (status applied, `load_order=after-next-core`, `css_path`, `commerce_pages`, evidence). It refuses, writing nothing, when a page that loads `next-core.css` does not load the brand layer after it. Don't hand-edit `report.theme`; a first repair-loop defect goes through `record polish`.

Build does not replace polish or QA. Hand off to `next-campaigns-polish` when the campaign is runnable.
