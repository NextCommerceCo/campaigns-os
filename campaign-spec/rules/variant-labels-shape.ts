/**
 * VariantLabelsShape — validates per-page `variant_labels` introduced in
 * Slice 4e.
 *
 * Multi-variant upsell templates (olympus-mv-single-step tier-cards, etc.)
 * render columns for product attributes like size, color, flavor. The
 * starter HTML often assumes two columns; single-attribute products
 * (size-only, color-only) ship with empty second columns.
 *
 * Author-time hint: declare `{primary: "Size"}` on the upsell page and
 * the build drops the second column; declare `{primary: "Size",
 * secondary: "Color"}` and both columns render with the spec-declared
 * labels. CLI/operator overrides at build time still win.
 *
 * Validation surface:
 *   - set on non-upsell page (placement warning, mirrors the
 *     pattern-on-non-upsell check in AssemblyHintsShape)
 *   - bad outer shape (array, null, scalar)
 *   - missing/empty primary
 *   - non-string primary or secondary
 *
 * Pattern reference: AssemblyHintsShape.upsell_template_pattern is the
 * canonical 4a per-page hint check this rule mirrors. Slice 4b
 * (upsell_mv_tiers) ships without a dedicated shape rule today — its
 * shape is enforced consumer-side in campaigns-os normalizedMvTiers().
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export const VariantLabelsShape: Rule = {
  id: 'VariantLabelsShape',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        const labels = page.variant_labels
        if (labels === undefined) return

        const path = `/funnels/${funnelIdx}/pages/${pageIdx}/variant_labels`
        const pageLabel = page.label || page.id || '(unnamed page)'

        if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
          violations.push({
            ruleId: 'VariantLabelsShape',
            severity: 'warning',
            message: `"${pageLabel}" — variant_labels must be an object with a "primary" string field; got ${Array.isArray(labels) ? 'array' : typeof labels}.`,
            path,
            data: { pageId: page.id, check: 'labels-bad-shape' },
          })
          return
        }

        const labelsObj = labels as { primary?: unknown; secondary?: unknown }

        if (page.type !== 'upsell') {
          violations.push({
            ruleId: 'VariantLabelsShape',
            severity: 'warning',
            message: `"${pageLabel}" — variant_labels is set on a non-upsell page (type=${page.type}). The hint is meaningful only on upsell pages; remove it or move it to an upsell page.`,
            path,
            data: { pageId: page.id, pageType: page.type, check: 'labels-on-non-upsell' },
          })
        }

        if (!isNonEmptyString(labelsObj.primary)) {
          violations.push({
            ruleId: 'VariantLabelsShape',
            severity: 'warning',
            message: `"${pageLabel}" — variant_labels.primary is required and must be a non-empty string (e.g. "Size").`,
            path: `${path}/primary`,
            data: { pageId: page.id, check: 'labels-primary-missing' },
          })
        }

        if (labelsObj.secondary !== undefined && labelsObj.secondary !== null && !isNonEmptyString(labelsObj.secondary)) {
          violations.push({
            ruleId: 'VariantLabelsShape',
            severity: 'warning',
            message: `"${pageLabel}" — variant_labels.secondary must be a non-empty string when set (omit the field for single-attribute products); got ${JSON.stringify(labelsObj.secondary)}.`,
            path: `${path}/secondary`,
            data: { pageId: page.id, check: 'labels-secondary-bad-type', value: labelsObj.secondary },
          })
        }
      })
    })

    return violations
  },
}
