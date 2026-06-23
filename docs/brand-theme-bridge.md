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
confirmed.

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

- the brand layer is generated and recorded as applied
  (`report.theme.status: applied`, `load_order: after-next-core`), or
- an explicit waiver is recorded:
  `campaigns-os theme waive --packet <p> --reason "<why>"`, or
  `qa run --theme-waive "<reason>"` for a one-off run, or
- theme policy is `off` for the run.

The gate result lives at `doctor.derived.theme_gate` and in every `next`
response's `gates` array, with `required_actions` carrying the exact commands.
A waiver does not silence QA: template-residue checks still run at warn
severity so the shipped palette stays visible in the verdict.

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
4. Record `report.theme.status`, `css_path`, `commerce_pages`, `load_order`,
   and evidence.

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
