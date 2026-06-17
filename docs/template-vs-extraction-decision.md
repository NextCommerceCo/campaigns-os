# Decision rule: template family vs Figma-extraction vs hybrid

Not every design should become a template family. Picking the wrong base is
expensive: scaffolding a generic family and then hand-reconciling it to a
bespoke design burns turns and ships placeholders, while extracting a one-off
design that actually recurs throws away reuse you'd have banked.

Choose by **recurrence × operational-standardness** — how often you'll build
this *shape*, and whether its commerce surfaces are the standard SDK set.

## The rule

- **Promote to a template family** when the shape **recurs across merchants**
  (the agency reuses it) **and** its operational surfaces are the standard SDK
  set. Bank the operational inheritance + presentation opinions once; clones
  are cheap (`--source <agency> --template <family>` → a correct funnel from
  tokens + content alone).
- **Figma-extraction (no family)** when the design is **one-off / bespoke** —
  its presentation is single-use, so a family banks nothing. Use a certified
  base family's operational layer and extract this design's presentation from
  Figma directly.
- **Hybrid** when operational is standard but presentation is bespoke **and**
  you still want the Campaigns OS recognition/QA: a base family's operational
  layer + Figma-extracted presentation, registered as a one-off template entry
  so the contracts/QA gates still apply.

> **Rule of thumb:** if you'll build this shape **≥3 times, make it a family**;
> if it's **this merchant only, extract it**. The expensive part — the
> presentation — isn't saved by a family unless it recurs.

## Why the split works

A checkout is two layers with different rules:

- **Operational layer (the SDK contract)** — the `data-next-*` surfaces (bundle
  selector, payment, express, order bump, cart summary, upsells, receipt) and
  their JS. This is **commodity**: inherit it from a certified base family, do
  not re-author it. Assembly stays predictable and QA is shared.
- **Presentation layer (the family's identity)** — hero treatment, type, color,
  price presentation, social proof, promo display, selected-card style, layout.
  This is the **only** thing a new family actually authors.

A family is worth minting only when that presentation layer recurs. One bespoke
merchant design recurs zero times, so extract its presentation and graft it onto
the standard operational layer instead of forcing it into a generic shell.

## How this connects to the gates

Whichever path you choose, the determinism/style-stability gates are what make
the result hold its form (see [Template Family Contracts](./template-family-contracts.md)
and [QA and Test Orders](./qa-and-test-orders.md)):

- **No hardcoded brand values** in components — a token swap can't reshape
  structure (color-residue gate).
- **Text-residue gate** — QA fails (blocker) on literal placeholder copy
  (`Lorem`, `Placeholder`, `TODO`, `Product Name`) in rendered output, so a
  build can't silently ship template prose.
- **Demo-asset fidelity flag** — QA warns when the template's own demo assets
  (spacer SVGs, a benefit icon repeated across every benefit) survive into the
  build, so the agent re-skins rather than ships placeholders.
- **Non-packet QA** — a `campaign-build`'d page-kit campaign with no full Build
  Packet can still be doctored/QA'd from its built `_site/`
  (`campaigns-os doctor --built <repo> --family <family>`,
  `campaigns-os qa run --site <repo> --base-url <url> --family <family>`).

If applying the design to a family requires hand-reconciling *structure*, the
family isn't done — it's still a design, not a template. That signal (heavy
structural reconciliation on a single merchant) is itself evidence you're on the
extraction/hybrid path, not the family path.

## Source

Distilled from the campaigns-os template-from-wild-checkout runbook (§5 decision
rule, §1 two-layer model) and the ArcticClip-on-Arjuna build learnings (L6 loose
template-family fit, L7 packet-gated QA). Point to the principle there rather
than re-deriving it per build.
