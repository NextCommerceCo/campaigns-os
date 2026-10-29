# Campaigns OS Build Flow

The happy path is intentionally tight:

1. Use a saved Map export, or have the coding agent author a CampaignSpec from the brief and verified campaign values through the [local-spec entry](build-packet.md#local-spec-entry). Preserve its Map ID or stable `local_spec_id`, plus its public route slug.
2. Run `campaigns-os start` with the CampaignSpec, prepared source files, target page-kit repo, and template family.
3. Treat doctor as the first gate. If its `next` block says `doctor-blocked` or `prepare-build` (the same stage names `campaigns-os next` uses), stop and resolve the named blocker.
4. Run setup when doctor asks for setup; otherwise continue to assembly.
5. Assemble the page-kit campaign from starter-template contracts, not from copied demo commerce values.
6. Run page-kit build plus SDK/template lint and record results in the assembly report.
7. Install the package-owned Playwright browser with `npm run qa:install-browser`.
8. Run polish, serve the current built output, and run `campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>`. Do not mark Polish terminal or begin deploy/QA until this package-owned page-load evidence passes or has an exact finding waiver.
9. Deploy a preview.
10. Run `campaigns-os qa resolve --packet <packet>`, then `campaigns-os qa run --packet <packet> --browser --test-order common` with the tested URL. Saved-Map QA uses the existing consent and publication controls; pass `--no-post-verdict` to keep its verdict local. Local-spec QA always keeps verdicts and progress local, even with `--post-verdict`, and `qa publish` refuses local-spec packets. Run Telemetry retains its consent controls.
11. Global test cards bypass the gateway and create no transactions, but each test order leaves a real store order record. Unless the operator has already said test orders are fine for this campaign, ask once, up front, before placing test orders; then proceed. There is no permission flag; test-order depth controls coverage. Localhost on any port is a Campaigns App Development domain (SDK allowed, analytics suppressed); non-localhost preview/production origins must still be allowlisted for the campaign API key so the SDK loads.
12. Promote, block, or iterate from the recorded build, polish, deploy, QA, and test-order evidence.

Pause only for missing inputs, doctor blockers, blocked deploys, out-of-scope runtime pages that block checkout proof, or merchant-specific uncertainty. The default path should not branch into external browser skills or hand-built backend order creation.

## Live-campaign changes

Keep a standing pull-request check after launch: install locked dependencies
with `npm ci`, build the campaign site with
`CPK_ENV=development npx --no-install campaign-build` (the check does not read the build summary),
then run `npx --no-install campaigns-os doctor --packet <packet> --ci --no-live-refs`.
Run these from the Page Kit folder containing the pinned tools and committed
packet, local CampaignSpec, Build Context and Assembly Report. The site build
must produce `_site/<public_route_slug>/`; `campaigns-os build` prepares inputs
and does not build the site. Do not record a new build merely to clear the check.
Match the Assembly Report's build environment: the documented local-proof flow
uses `development`; set `CPK_ENV=production` when the recorded evidence reviewed
a production render instead. Environment differences also change fingerprints.

| CI status | Exit code | Meaning |
|---|---|---|
| `current` | `0` | Polish and QA both bind to the build on disk and neither is lifecycle-required, or the only owed stage is advisory Polish for a page-only change. |
| `owed` | `3` | Polish or QA binds to another build or is lifecycle-required; evidence is owed. For a page-only change only QA on the changed pages counts. |
| `unknown` | `4` | Output or assembly fingerprints are missing, a stage fingerprint is missing without a lifecycle requirement, output is unreadable, or inspection throws; debt cannot be determined. |
| `usage` | `2` | The packet is missing, unreadable or invalid JSON. |

Any owed stage returns 3; otherwise an unknown stage returns 4. Normal
doctor errors remain visible but do not determine the CI exit code. Without
`--ci`, doctor retains its usual inspection output and 0/2 result. `--json`
adds a `ci` object containing `status`, `exit_code`, `polish`, `qa`, and
`changes` when assessment completes. Without `--json`, every CI outcome prints
an escaped Markdown report, including a "could not evaluate" report for packet
usage errors (exit 2) or inspection failures (exit 4). Page changes are compared
with the retained assembly manifest, so the page list may be empty if that
manifest was already updated; old Polish/QA bindings still show debt.
Without a usable manifest, page changes are unknown, but matching stage
bindings remain current unless lifecycle-required, and differing bindings remain owed.
The check reads recorded fingerprints, not machine-local capture files.
Readback's `evidence_debt` uses the same assessment, showing an agent this debt
before it edits; its separate time-based staleness assessment is not the CI signal.

### What a change owes

Each owed stage carries `change`: what changed since the build that stage
last reviewed. It is read from the rebuilds `record build` keeps
(`stages.assembly.build_changes`) plus the drift on disk, so the changed pages
stay listed after `record build`. A change is one of two kinds:

- **Page-only.** Only the HTML of some pages changed (copy, image references,
  inline styling), and none of them is a checkout page or changed its commerce markup:
  `data-next-*` and other package, offer, shipping or upsell attributes,
  `next-*` meta tags (the upsell accept and decline routes among them),
  scripts, link targets or form actions. The campaign's own entry in
  `_data/campaigns.json` (SDK pin, analytics ids, store fields) is unchanged.
  It owes QA on the changed pages only: `qa.scope` is `pages` and
  `qa.owed_pages` lists them. Polish is advisory (`polish.advisory: true`): it
  is reported, and `next`, the CI check and the QA gate do not require it.
- **Commerce-affecting.** Anything else: a checkout page, commerce markup or
  the config entry changed, a page was added or removed (a route change), or a
  built file other than a page's HTML changed (a script, stylesheet or image
  file cannot be mapped to one page). It owes the full Polish and QA, as
  does a change that cannot be read (a record made before `record build`
  kept a commerce signature, or a rebuild history that no longer reaches the
  reviewed build). A Polish or QA requirement a brief or spec change made is
  always full.

The PR comment opens with the kind it found and what that owes, for example
"Change found: page-only. It owes QA on `upsell1`; Polish is advisory." A
commerce-affecting change names its reasons.

Copy the [workflow example](https://github.com/NextCommerceCo/campaigns-os/blob/main/docs/examples/campaign-repo-evidence-check.yml) into the
campaign repository and adjust the packet path. It posts or updates one PR
comment using the fixed `<!-- campaign-evidence-check -->` marker. Evidence
reports use stdout only; stderr stays in the job log. If the command produces
no stdout, the comment points to the job log with a fixed fallback message.
If install or build fails before doctor runs, the comment is updated with
"Campaign build failed; evidence not evaluated. See the job log."
Evidence findings are **report-only by default**. Opt in to failing on a nonzero doctor
exit by setting the repository Actions variable
`CAMPAIGNS_OS_EVIDENCE_CHECK` to `fail`. Install/build failures still fail normally.
Fork pull requests may lack comment-write permission; comment failures are
nonfatal and the report remains in the job log. The example uses `pull_request`
and does not run untrusted code with `pull_request_target` privileges.

To repay a page-only change, rebuild, run `record build`, then run
`qa run --packet <packet> --page <page_id>` against that build, repeating
`--page` for each changed page the report names. A page-scoped run checks only
those pages and places no test orders; the QA stage it records keeps the
purchase proof of the full run it extends. It refuses, before checking
anything, when the output on disk is not the recorded build, when the change
is commerce-affecting, or when a changed page is left out. Running Polish for
a page-only change is optional.

To repay fingerprint-drift debt for any other change, rebuild and record the output, re-run `polish capture` against
that served build, record Polish with `record polish --evidence <evidence.json>`,
then run `qa run` to record QA for the current build. For lifecycle-required
stages with matching build bindings, re-run the required stages against the
existing build: `polish capture` and `record polish` when Polish is owed, and
`qa run` when QA is owed. The CI report names each owed stage's cause and
selects the remedy accordingly. The workflow only inspects;
it does not renew evidence or deploy.

## Partial Builds

Partial builds are valid campaign work. A pass may build only new presell pages,
landing pages, upsells, downsells, or another bounded slice that sends traffic
to an existing downstream route. In the Build Packet, map pages being built with
`source_html.pages[].path` and mark intentionally untouched pages with
`source_html.pages[].skip_reason`.

For mapped pages, `source_html.pages[].path` is source provenance. Use
`source_html.pages[].page_kit` for the Page Kit target file, public route, CPK
`page_type`, and frontmatter projection.

`doctor` classifies that as `derived.scope.mode = "partial"`. Mapped pages are
route/visual-testable after deploy. Skipped checkout, upsell, downsell, or
receipt pages keep checkout launch readiness and test-order proof blocked until
those runtime pages are built or explicitly delegated to an existing downstream
URL.

## Commerce Ownership

- CampaignSpec/API own live campaign identity, routes, package refs, offer refs, shipping refs, payment support, tracking intent, footer links, and SEO values.
- Starter template contracts own the SDK attribute contract and protected runtime surfaces: checkout/cart/upsell/receipt/payment/address/totals/submit controls and their required data attributes.
- Designed source owns visual composition, content hierarchy, imagery, and page-level copy.

Packages identify sellable products or variants, and Offers own campaign price changes. The Campaigns App dashboard calls packages **Products** and creates one per variant when an Offer that selects it is saved, so a campaign set up there has one package per variant and a separate Offer for each Buy 1/2/3 tier. Package Retail Price/Quantity fields and multi-unit packages exist on older campaigns that have the legacy **Enable Package Retail Price & Quantity** setting on (see the "Older Campaigns" section of [Campaign Products](https://docs.nextcommerce.com/docs/apps/campaigns-app/build-campaign-packages)), but assembly should not introduce them for new tier pricing.

## Offer Application Surfaces

CampaignSpec may declare checkout-level offer application behavior through
`funnels[].pages[].exit_intent` and `funnels[].pages[].promo_code_input`.
Treat these fields as intent for runtime checkout surfaces, not as separate
pricing models:

- `exit_intent.offer_ref_id` points at the configured campaign Offer.
- `exit_intent.offer_code` is the voucher/promo code the runtime should apply
  when the shopper accepts the pop.
- `promo_code_input.offer_ref_id` points at the configured campaign Offer.
- `promo_code_input.offer_code` is the voucher/promo code the runtime should
  accept through the manual entry surface.
- optional `notes` fields are build/QA implementation notes. Durable popup
  copy, CTA labels, placeholders, success labels, and active labels belong to
  the source design or selected template, not the Spec.

Build should wire the selected starter-template checkout so the accepted offer
is applied through the Campaign Cart SDK/Campaigns API path. Do not hardcode
discount math, mutate static price literals, or treat the pop as an alternate
bundle model. After the code is active, bundle selectors, totals, order summary,
and discount rows should render from SDK/API state.

Code-specific presentation belongs in SDK conditionals, for example:

```html
<span data-next-show='cart.hasCoupon("FREESHIP")'>Free shipping applied</span>
```

A promo-code box accepts a shopper-entered code and asks SDK/API to validate and
apply it; it does not own pricing truth. When `promo_code_input.enabled` is
declared, build should preserve or create the template/source promo-code surface,
wire it to the mapped `offer_code`, and record the implementation decision in
the assembly report.

## Assembly Rules

- Landing and presell pages should preserve prepared HTML when it is a real standalone design. Use page-kit passthrough structure, inject the SDK/config requirements, and repoint CTAs into the CampaignSpec flow.
- **Pre-checkout pages must ship the same SDK bootstrap as the checkout layout.** Presell and landing pages are SDK `page_type: product`; they need `config.js` (before the loader), the `campaign-cart@v{sdk_version}/dist/loader.js` module script, and the `next-funnel` + `next-page-type` meta tags — not just inert `data-next-*` attributes. Without the loader the SDK silently no-ops: `data-next-hide` conditional visibility (`param.banner` / `param.seen`), `utmTransfer` UTM/query carry-through to checkout (top-of-funnel ad attribution), and SDK analytics never fire. Treat `param.banner` / `param.seen` visibility and `utmTransfer` as standard pre-checkout wiring, not per-campaign discoveries. Doctor enforces this with `built_output.pre_checkout_sdk_bootstrap`.
- **Every page names the same campaign.** A page borrowed from another funnel (a copied upsell or receipt) must not keep the other campaign's `next-api-key` / `config.js` API key, `next-funnel` meta, or `setAttribution({ funnel })` call; the SDK reads these per page and reconciles nothing, so the order lands on or attributes to the wrong campaign with no visible error. Doctor blocks this, unwaivably, with `built_output.campaign_identity` (one error per drift, naming both files and both values).
- **SDK markup must do what it says.** `data-next-checkout` goes on the `<form>`; `data-next-checkout-field` values are the SDK's fixed names (`fname`, `lname`, `postal` — never `firstName`, `lastName`, `zip`); an `add-to-cart` button linked by `data-next-selector-id` needs a selector with that id and that selector in `select` mode (swap mode plus the button writes the cart twice); every `data-next-upsell-action` sits inside its `data-next-upsell` container, on any page type; one default-selected card per selector; single-brace tokens inside SDK templates; the page type in `<meta name="next-page-type">` (`upsell` on every upsell offer page), never only in a `data-next-page-type` attribute. Doctor enforces the first five as blockers and the last three as warnings under `built_output.sdk_markup` (codes `SWAP_WITH_ADD_TO_CART`, `CHECKOUT_NOT_FORM`, `WRONG_FIELD_NAME`, `MISSING_SELECTOR_ID_MATCH`, `ORPHANED_UPSELL_ACTION`, `DOUBLE_SELECTED`, `TEMPLATE_DOUBLE_BRACE`, `PAGE_TYPE_ATTRIBUTE`, `UPSELL_PAGE_TYPE_MISSING`).
- **Campaign scripts must parse.** A hand-edited script with a stray or missing bracket throws a `SyntaxError` on every page that loads it, and nothing in it runs. Doctor parses every campaign-owned `.js` file a built page loads by a local `<script src>` and blocks, unwaivably, with `built_output.script_syntax.parse_failure`, naming the file, line and column.
- Checkout, upsell, downsell, and receipt pages should preserve starter-template SDK contracts while keeping the campaign/source visual language. Treat starter templates as the reference for required `data-next-*` controls and wiring, not as a mandate to carry their visual chrome into the final campaign.
- If source HTML declares SDK-owned zones such as `data-commerce-zone="checkout-form"` or `data-commerce-zone="order-summary"`, keep the selected starter-template family's SDK wiring for that zone (the checkout form, bound fields, payment submit and cart summary). The wrapper and page composition around it stay source-owned; do not add family class names to the campaign's own layout to satisfy QA.
- If `context.theme` names a generated `brand-theme.css`, copy it into campaign assets and load it after `next-core.css` on checkout, upsell, downsell, and receipt pages. When `context.theme.generated.fonts_css_path` names a `brand-fonts.css`, copy it beside the brand layer and load it on the same pages, so headings and body copy use the design's faces (`record theme` refuses a styled page that skips it). Generated brand-theme v0 is root-variable-only; do not use it as permission to edit SDK-owned selectors or runtime structure.
- Buy-more-save-more selectors should use selected quantity plus Offer-aware price displays. Do not swap in stale package-per-tier IDs unless the CampaignSpec explicitly represents an older campaign that still owns separate packages for each option.
- SDK routing meta tags should be emitted as campaign-root paths, for example `/campaign-slug/upsell/`, even when the CampaignSpec source value is slug-relative like `upsell/`.
- One-time prepurchase/order-bump packages outside the main bundle should default to fixed quantity and fixed line total display unless the spec explicitly requires syncing quantity with the main bundle.
- Checkout exit-intent pops and promo-code inputs are protected offer application surfaces. Preserve/apply the selected family's SDK coupon/voucher hooks; skin the shell and copy around them.
- Any source element dropped because the spec does not support it, such as PayPal when `available_payment_methods` excludes PayPal, should be recorded in the assembly report for polish.
- After page-kit build, doctor checks rendered local script references plus rendered package and shipping refs against the CampaignSpec. Missing built scripts, stale package IDs, stale shipping IDs, and unavailable package refs must be fixed or intentionally blocked before QA.
- Browser QA opens SDK-owned runtime pages once as a shopper and once with `?debugger=true`. The debugger pass should prove the Campaign Cart debugger overlay and selector controls mount without changing the normal checkout/test-order flow.
- Browser QA also checks template-family commerce structure when the family contract declares machine-checkable selectors. It checks what the checkout does, not family class names: a missing family shell selector (a wrapper or column class, or the shipping field row marker) is a warning when the checkout form, its bound fields and a visible total all pass, and a failure when any of them does not. A missing SDK selector is always a warning-severity failure. See [QA and test orders](qa-and-test-orders.md).

## Synthetic Campaigns

For AI-generated or synthetic campaigns, the static source page can be used to
exercise the design-to-page-kit path, but SDK checkout still needs a Campaigns
App campaign, store URL, packages, shipping/payment configuration, and an SDK
origin that can load the campaign API key. Localhost on any port is available for
Development-domain SDK checks, but a non-localhost preview/production origin must
be allowlisted. If the evaluator has no natural merchant/store,
reuse a designated test store and record that choice. Otherwise mark checkout,
receipt, and test-order QA as blocked instead of debugging an SDK loading state
as if it were a page-kit build failure.

## Not Full Automation

This repo improves first-run success. It does not yet prove a campaign is live-ready.

Campaigns OS proof is not merchant launch readiness. Before launch, confirm the
production storefront URL, live payment methods, shipping markets, legal/support
URLs, analytics expectations, and merchant-side configuration.
