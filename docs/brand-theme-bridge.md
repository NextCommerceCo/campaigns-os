# Brand Theme Bridge

Campaigns OS often receives campaigns midstream. A source design may come from
Figma, a hand-authored page, an AI export, a partially assembled page-kit repo,
or a developer who already cloned checkout/upsell templates and started editing.
The brand theme bridge is intentionally workflow-order neutral: it reads durable
source artifacts that exist now and records what can safely flow into commerce
pages.

## What v0 Does

`campaigns-os theme inspect` reads a Build Packet and looks for source-side
`:root` custom properties from:

- mapped HTML page inline `:root` blocks
- CSS files referenced by mapped HTML/frontmatter
- source-html manifest linked CSS assets
- conventional token paths such as `assets/css/tokens.css`,
  `assets/css/landing/tokens.css`, and `assets/css/presell/tokens.css`

It compares source tokens against known `figma-sections-export` scaffold
defaults, maps real brand values onto a local versioned next-core target-token
contract, and writes evidence into a theme report.

`campaigns-os theme generate` writes:

```text
.campaign-runtime/theme/theme-report.json
.campaign-runtime/theme/brand-theme.css
```

The generated CSS is v0 root-variable-only. It can override next-core custom
properties such as `--brand--color--primary` and
`--brand--color--cta-primary`, but it must not emit selectors, `data-next`
selectors, payment/package/cart selectors, JavaScript, or remote URL fetches.

### Foreground tokens are derived from background luminance

Foreground / on-color tokens — `--brand--color--text-inverse`,
`--brand--color--cta-foreground`, `--brand--color--primary-foreground`, and
`--brand--color--accent-foreground` — are **not** copied from a source
`--text-inverse` token (which scaffolds default to white). They are derived
from the WCAG relative luminance of the background each sits on, picking the
more legible of the configured dark/light choices. A light brand (yellow,
white, pastel) therefore gets dark foregrounds; a dark/saturated brand gets
white ones. This prevents the white-on-light-CTA bug — next-core's
`.button` / `.submit-button` render their label with
`color: var(--brand--color--text-inverse)`, so `text-inverse` pairs with the
CTA background first, then the primary background. Pairings live in the
`foreground_derivations` block of
`contracts/brand-theme-target-tokens.next-core.v0.json`; a derived foreground
that still falls below the contract's `min_contrast_ratio` is emitted with a
`theme.foreground.low_contrast` warning so the brand background can be
confirmed. Derived-foreground confidence scales with the achieved contrast
(`>= 7:1` high, `>= 4.5:1` medium, otherwise low).

One exception keeps the design's own CTA label. The declared CTA foreground is
read from the selected source in this order:

1. the `color:` of the button rules whose `background` or `background-color`
   is the CTA background (the design's own pairing), only when they all agree
   on one colour; when they disagree, this step declares nothing and the next
   step applies;
2. a `:root` inverse/on-colour text token: the name needs a `text` or
   `foreground` part plus `inverse`, or `on` followed by `primary`, `cta`,
   `brand`, `accent` or `dark` (`--text-inverse` first, then for example
   `--text-color-inverse`, `--text-on-primary`, `--on-primary-text` or
   `--foreground-on-dark`). `--border-on-primary`, `--overlay-on-dark` and a
   bare `--on-primary` are not text and never qualify;
3. the `color:` of the other button rules that declare no background, only when
   they all agree on one colour.

A button rule is one whose every selector ends in a compound selector that is
the `button` element, `input[type=submit]`, or a class starting with
`btn`, `button` or `cta` or having a `cta` part (`.btn-primary`, `.button`,
`.cta`, `.hero-cta`). An attribute alone does not make a button:
`[type=submit]`, `div[type="submit"]` and `.order-summary[type=submit]` do not
qualify. Only the compound's own element, class and attribute
selectors count: the value inside an attribute selector and the arguments of
`:not()`, `:is()`, `:where()` and `:has()` are not read, so
`.btn-primary[data-x]` and `button:not(.order-summary)` qualify while
`.order-summary[data-target=".btn"]`, `.order-summary:not(.btn)` and
`.cart:has(.button)` do not. Any other pseudo-class or pseudo-element
(`:hover`, `:disabled`, `::before`) disqualifies the selector. Selectors such
as `.order-summary` or `.cart-count`, and `.btn .icon`, never qualify. When that
colour reaches at least 3:1 on the CTA background (WCAG AA for large text),
`--brand--color--text-inverse` and `--brand--color--cta-foreground` use it
(`derivation.method: declared-cta-foreground`). White on `#dd4249` is 4.24:1,
so a design that declares white CTA text keeps white, although black scores
higher there. A declared colour under 3:1 is ignored and the luminance pick
applies, so a white scaffold default on a yellow CTA still resolves dark. A
declared colour between 3:1 and the contract's `min_contrast_ratio` (4.5:1) is
used and reported with `theme.foreground.low_contrast`. With no declared CTA
foreground, the output is unchanged. Declarations inside CSS comments are not
read, so a commented-out token or rule never supplies a CTA or body text colour.

### Body text prefers the darkest declared text token

A declared text token is a `:root` custom property in the selected source whose
name has a `text` part and whose value is a solid colour. Names that carry
another job are not counted: inverse/on-colour labels (`text` or `foreground`
with `inverse` in any order, or `on` followed by `primary`, `cta`, `brand`,
`accent` or `dark`; `--text-on-light` is ordinary copy), `secondary`, `muted` or
`subtle` copy, link, status and state colours (`link`, `error`, `danger`,
`success`, `warning`, `info`, `highlight`, `accent`, `placeholder`, `disabled`,
`selection`), `cta`/`button`/`btn` labels, and text `shadow`, `border`,
`outline`, `stroke`, `bg` or `background` values. When the source has a solid
body background (`--surface-bg`), `--brand--color--text-primary` and
`--brand--color--foreground` take the darkest declared text token that is
darker than that background and reaches 4.5:1 on it
(`derivation.method: darkest-declared-text-token`, with the replaced value
recorded, or `null` when the source yielded no `--text-primary`). This applies
whether or not the source yields a `--text-primary` of its own. If no token
qualifies, the existing pick (or its absence) stands.

> **Contract change (PR #117):** `--text-inverse` and the three `*-foreground`
> targets are no longer entries under `source_mappings` — they moved to
> `foreground_derivations`. A source `--text-inverse` token (or anything that
> name-infers to one) is therefore no longer mapped directly; the foreground is
> always derived from the paired background's luminance. No fixtures or
> consumers keyed off the old mapping.

## Prepare-Build Behavior

`start` and `prepare-build` run theme discovery in `inspect_only` mode by
default. They write `context.theme` and
`.campaign-runtime/theme/theme-report.json`, but they do not write
`brand-theme.css` unless `--theme-policy auto` is explicitly set and the source
evidence is high-confidence and safe.

Policies:

| Policy | Behavior |
| --- | --- |
| `inspect_only` | Default. Discover/report only; no generated CSS. |
| `auto` | May write `brand-theme.css` only when confidence is high and no stale artifact risk exists. |
| `off` | Skip theme discovery. |

Existing `brand-theme.css` is not overwritten without `--force`. If the source
hash changes, source tokens disappear, or current confidence drops, Campaigns OS
marks the existing artifact stale and tells the operator to regenerate or skip.

## Theme Gate

Theme discovery used to be advisory: `theme inspect` could prove a brand layer
was generatable, doctor could surface `needs_review`, and an agent could still
carry the starter palette through polish, deploy, and a green QA verdict. The
theme gate makes the decision deterministic.

When `theme inspect` reports `can_generate: true` and the campaign ships
commerce pages (checkout/upsell/downsell/receipt), the gate **blocks**
`next polish`, `next deploy`, `next qa`, and `qa run` until one of:

- the brand layer is generated, linked and recorded as applied with
  `campaigns-os record theme --packet <p>` (`report.theme.status: applied`,
  `load_order: after-next-core`), or
- an explicit waiver is recorded:
  `campaigns-os theme waive --packet <p> --reason "<why>" --waived-by "<named human>"`
  (optionally `--expires-at <ISO>`; placeholders such as "operator" are refused), or
  `qa run --theme-waive "<reason>"` for a one-off run, or
- theme policy is `off` for the run.

"Ships commerce pages" is a question about the campaign, not about one build's
output. The gate reads the pages this build produced **and** the commerce pages
the campaign declares but this build left out of scope, so a partial build
cannot retire the gate on a funnel it simply did not assemble; `commerce_pages`
carries the union and `commerce_pages_out_of_scope` names the half this build
did not produce. On the QA path the declared funnel is unioned in the same way,
so a thin or stale `doctor-output.json` cannot self-retire a gate on a funnel
whose routes `qa resolve` lists in the same output. `theme_gate.scope_source`
records which sources contributed: `doctor_derived_scope`, `spec_topologies`,
or `doctor_derived_scope+spec_topologies`.

The gate result lives at `doctor.derived.theme_gate` and in every `next`
response's `gates` array, with `required_actions` carrying the exact commands.
A waiver does not silence QA: the palette-residue checks (`:style:*`, `:logo`,
`:payment-chrome:*`) still run and report residue as `warn` rows so the shipped
palette stays visible in the verdict; placeholder-text residue stays a blocker
regardless of the waiver.

Per-family expectations (required token overrides, starter defaults that count
as residue, CSS load order, QA selectors, pricing-surface modes, exit-pop
residue, and the family inventory matrix) live in
`contracts/template-brand-contract.<family>.v0.json`. Promoted families in the
commerce surface catalog must have one; doctor and QA treat a missing contract
as a blocker instead of silently skipping residue checks.
See `docs/template-family-contracts.md` for the current family inventory matrix.

## Build And Polish Handoff

Build agents should read `context.theme` before styling checkout, upsell,
downsell, or receipt pages.

If a fresh `brand-theme.css` exists:

1. Copy it into the campaign asset tree.
2. Add it to commerce page frontmatter styles after `next-core.css`.
3. Preserve SDK-owned runtime surfaces: `data-next-*`, package selectors,
   payment fields, totals, submit controls, receipt templates, route meta tags,
   and SDK JavaScript.
4. Rebuild, run `campaigns-os record build --packet <p>`, then
   `campaigns-os record theme --packet <p>`. It reads each built commerce
   page's stylesheet links and records `report.theme.status`, `css_path`,
   `commerce_pages`, `load_order` and evidence. It refuses, writing nothing,
   when a page that loads `next-core.css` does not load the brand layer after
   it, or when no built commerce page loads `next-core.css`.

### Where next-core.css belongs

`next-core.css` and the brand layer are needed only on pages where the
starter-template family's components render, because those components read
the `--brand--*` tokens. `next-core.css` also carries element resets (`li`,
`a`, headings, body letter-spacing) that restyle any markup on the page. On a
page whose upsell, downsell or receipt markup comes from the design rather
than from family components, loading it breaks that markup. Leave both
stylesheets off those pages and list them only in the frontmatter styles of
the pages that render family components, often just checkout.

`report.theme.commerce_pages` is the list of pages where the brand layer was
applied. `record theme` writes it from the built pages: every commerce page
that loads `next-core.css`, for example `commerce_pages: ["checkout"]`. A page
that loads neither stylesheet is left out and noted in the evidence. The theme gate does not compare this
list with the funnel. It passes on `report.theme.status: applied` with
`load_order: after-next-core`. The gate's own `commerce_pages` output is a
different field: every checkout, upsell, downsell, receipt or thank-you page
the campaign builds or declares. It decides whether the gate applies, not
which pages must load the brand layer. No check reads each built page's
stylesheet order, so the recorded list and the evidence are what a reviewer
sees.

Polish should verify token parity, load order after next-core, starter-logo
replacement when source assets expose a real brand mark, and SDK safety. If the
brand layer is repairable, record the first repair-loop defect.

## Future Designer-Source Contract

Mario's proposed direction belongs upstream of this v0 bridge: generate a
campaign design-system package before design work begins, with durable assets
such as `colors.css`, `typography.css`, fonts, logos, and candidate
`lp-tokens.json`, `checkout-tokens.json`, and `upsell-tokens.json` page-family
variables.

That is likely the right long-term source of truth, but v0 should not require
that package. The bridge must also work when Campaigns OS is invoked after Figma
export, after partial developer edits, or after checkout/upsell templates have
already been cloned.
