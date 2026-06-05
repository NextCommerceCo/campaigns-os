/**
 * AssemblyHintsShape — validates the optional authoring-time build hints
 * introduced in Slice 4a and extended in Slice 4b:
 *
 *   1. campaign.preferred_template_family — which starter family the
 *      campaign was authored against. Already read by campaigns-os
 *      preferredTemplateFamily() (three locations); this rule blesses
 *      the convention and warns when the value isn't a recognized
 *      family.
 *   2. page.upsell_template_pattern — per-page UI variant hint
 *      (mv | bundle_tier_pills | bundle_tier_cards | single). Warns
 *      when set on a non-upsell page (meaningless) or when the value
 *      isn't recognized.
 *   3. page.upsell_mv_tiers — per-page MV tier range `{min, max}`
 *      declaring the inclusive quantity-tier subset to render. Warns
 *      when set on a non-upsell page, when shape is malformed (missing
 *      field, non-integer, non-positive), or when min > max.
 *
 * All three are HINTS, not contracts. The build agent uses them as
 * defaults; CLI/operator overrides win. Hence the warning severity
 * across the board — these never block a build, they just nudge
 * authoring quality.
 *
 * Doctrine note: template family is fundamentally a build-time
 * decision and CLI/operator overrides always win. Authoring-time
 * hints are allowed because designers / campaign owners often know
 * the answer at authoring time, and re-deciding at build was
 * repeated friction — hence warning severity, never a build blocker.
 *
 * Cross-field constraint enforcement (upsell_mv_tiers min <= max): the
 * JSON Schema (schemas/campaign-runtime-build-packet.v0.schema.json)
 * does NOT express this constraint — plain JSON Schema 2020-12 cannot
 * say "field A must be less than or equal to field B" without
 * $data-style extensions. Defense in depth lives at two layers
 * instead: this rule warns the author at authoring/QA time, and the
 * campaigns-os consumer's normalizedMvTiers() silently drops the field
 * when min > max so a half-state spec never reaches the build agent
 * through the packet. Both layers must stay aligned; loosening either
 * one is a contract change worth a coordinated PR.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const KNOWN_TEMPLATE_FAMILIES = new Set([
  'olympus',
  'limos',
  'demeter',
  'olympus-mv-single-step',
  'olympus-mv-two-step',
  'shop-single-step',
  'shop-three-step',
])

const KNOWN_UPSELL_PATTERNS = new Set([
  'mv',
  'bundle_tier_pills',
  'bundle_tier_cards',
  'single',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export const AssemblyHintsShape: Rule = {
  id: 'AssemblyHintsShape',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    // 1. Campaign-level template family hint.
    const templateFamily = spec.campaign?.preferred_template_family
    if (templateFamily !== undefined) {
      if (!isNonEmptyString(templateFamily)) {
        violations.push({
          ruleId: 'AssemblyHintsShape',
          severity: 'warning',
          message: 'campaign.preferred_template_family is set but empty; remove the field or set it to a known family.',
          path: '/campaign/preferred_template_family',
          data: { check: 'template-family-empty' },
        })
      } else if (!KNOWN_TEMPLATE_FAMILIES.has(templateFamily)) {
        violations.push({
          ruleId: 'AssemblyHintsShape',
          severity: 'warning',
          message: `campaign.preferred_template_family "${templateFamily}" is not in the known set (${[...KNOWN_TEMPLATE_FAMILIES].join(', ')}). The build agent will still try to use it as a hint, but consider correcting the value if this is a typo.`,
          path: '/campaign/preferred_template_family',
          data: { check: 'template-family-unknown', value: templateFamily },
        })
      }
    }

    // 2. Per-page upsell template pattern.
    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        const pattern = page.upsell_template_pattern
        if (pattern === undefined) return

        const path = `/funnels/${funnelIdx}/pages/${pageIdx}/upsell_template_pattern`
        const pageLabel = page.label || page.id || '(unnamed page)'

        if (!isNonEmptyString(pattern)) {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_template_pattern is set but empty; remove the field or pick one of: ${[...KNOWN_UPSELL_PATTERNS].join(', ')}.`,
            path,
            data: { pageId: page.id, check: 'pattern-empty' },
          })
          return
        }

        if (page.type !== 'upsell') {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_template_pattern is set on a non-upsell page (type=${page.type}). The hint is meaningful only on upsell pages; remove it or move it to an upsell page.`,
            path,
            data: { pageId: page.id, pageType: page.type, check: 'pattern-on-non-upsell' },
          })
        }

        if (!KNOWN_UPSELL_PATTERNS.has(pattern)) {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_template_pattern "${pattern}" is not in the known set (${[...KNOWN_UPSELL_PATTERNS].join(', ')}). Build will use it as a hint, but confirm the value matches a template-family variant.`,
            path,
            data: { pageId: page.id, check: 'pattern-unknown', value: pattern },
          })
        }
      })

      // 3. Per-page MV upsell tier range.
      pages.forEach((page, pageIdx) => {
        const tiers = page.upsell_mv_tiers
        if (tiers === undefined) return

        const path = `/funnels/${funnelIdx}/pages/${pageIdx}/upsell_mv_tiers`
        const pageLabel = page.label || page.id || '(unnamed page)'

        if (tiers === null || typeof tiers !== 'object' || Array.isArray(tiers)) {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_mv_tiers must be an object with numeric "min" and "max" fields; got ${Array.isArray(tiers) ? 'array' : typeof tiers}.`,
            path,
            data: { pageId: page.id, check: 'tiers-bad-shape' },
          })
          return
        }

        const tiersObj = tiers as { min?: unknown; max?: unknown }
        const hasMin = 'min' in tiersObj
        const hasMax = 'max' in tiersObj
        // Extract to local bindings so TS can narrow across the type-guard
        // calls below. Property accessors on a shared object don't carry
        // narrowing through subsequent reads, which is what forced the
        // earlier `as number` cast at the range check; local bindings fix
        // that and the cast goes away.
        const min: unknown = tiersObj.min
        const max: unknown = tiersObj.max

        if (page.type !== 'upsell') {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_mv_tiers is set on a non-upsell page (type=${page.type}). The hint is meaningful only on upsell pages; remove it or move it to an upsell page.`,
            path,
            data: { pageId: page.id, pageType: page.type, check: 'tiers-on-non-upsell' },
          })
        }

        if (!hasMin || !hasMax) {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_mv_tiers is missing ${!hasMin && !hasMax ? 'both "min" and "max"' : !hasMin ? '"min"' : '"max"'}; declare both as positive integers (e.g. {"min": 1, "max": 5}) or remove the field.`,
            path,
            data: { pageId: page.id, check: 'tiers-missing-field', hasMin, hasMax },
          })
          return
        }

        if (!isPositiveInteger(min) || !isPositiveInteger(max)) {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_mv_tiers requires positive integers for "min" and "max"; got min=${JSON.stringify(min)}, max=${JSON.stringify(max)}.`,
            path,
            data: { pageId: page.id, check: 'tiers-bad-type', min, max },
          })
          return
        }

        // min and max are narrowed to number here via the type guards above.
        if (min > max) {
          violations.push({
            ruleId: 'AssemblyHintsShape',
            severity: 'warning',
            message: `"${pageLabel}" — upsell_mv_tiers has min=${min} greater than max=${max}; swap the values or fix the range.`,
            path,
            data: { pageId: page.id, check: 'tiers-bad-range', min, max },
          })
        }
      })
    })

    return violations
  },
}
