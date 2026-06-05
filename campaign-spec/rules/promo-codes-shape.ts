/**
 * PromoCodesShape — validates per-funnel `promo_codes` rosters introduced
 * in Slice 4c.
 *
 * The starter templates' promo-banner.js / promo-timer.js ship with a
 * hardcoded `const sales = [...]` array (17 seasonal entries with demo
 * codes like SUMMER26, BF26, EXIT10). The build-side replacement step
 * regenerates this array from `funnels[].promo_codes` so each merchant
 * carries their own calendar in the spec rather than inheriting demo
 * defaults.
 *
 * Hint posture: warning severity, never blocks a build. The build
 * agent applies the replacement only when the spec carries a non-empty
 * roster; otherwise the template's demo sales array passes through
 * untouched.
 *
 * Validation surface:
 *   - empty id / code (the two required identity fields)
 *   - duplicate id within a funnel
 *   - duplicate code within a funnel (codes should be unique so the
 *     "first matching range wins" priority is deterministic)
 *   - starts_at / ends_at parse as a Date (non-ISO strings warn)
 *   - starts_at > ends_at (inverted range)
 *
 * The rule does NOT validate visual fields (title, emoji, colors, etc.)
 * beyond "if present, must be a string" — those are presentation copy
 * and the build renders whatever the author wrote.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.trim().length === 0) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
}

const VISUAL_STRING_FIELDS = [
  'title',
  'emoji',
  'offer1',
  'offer2',
  'top_bar_bg',
  'highlight_color',
  'banner_text',
  'banner_text_sec',
  'limited_time',
] as const

export const PromoCodesShape: Rule = {
  id: 'PromoCodesShape',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const codes = funnel.promo_codes
      if (codes === undefined) return

      const funnelLabel = funnel.name || funnel.id || `funnel ${funnelIdx}`

      if (!Array.isArray(codes)) {
        violations.push({
          ruleId: 'PromoCodesShape',
          severity: 'warning',
          message: `"${funnelLabel}" — promo_codes must be an array; got ${codes === null ? 'null' : typeof codes}.`,
          path: `/funnels/${funnelIdx}/promo_codes`,
          data: { funnelId: funnel.id, check: 'promo-codes-bad-shape' },
        })
        return
      }

      const seenIds = new Set<string>()
      const seenCodes = new Set<string>()

      codes.forEach((entry, entryIdx) => {
        const path = `/funnels/${funnelIdx}/promo_codes/${entryIdx}`

        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          violations.push({
            ruleId: 'PromoCodesShape',
            severity: 'warning',
            message: `"${funnelLabel}" — promo_codes[${entryIdx}] must be an object; got ${entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry}.`,
            path,
            data: { funnelId: funnel.id, index: entryIdx, check: 'promo-entry-bad-shape' },
          })
          return
        }

        const promo = entry as Record<string, unknown>

        if (!isNonEmptyString(promo.id)) {
          violations.push({
            ruleId: 'PromoCodesShape',
            severity: 'warning',
            message: `"${funnelLabel}" — promo_codes[${entryIdx}].id is required and must be a non-empty string.`,
            path: `${path}/id`,
            data: { funnelId: funnel.id, index: entryIdx, check: 'promo-id-missing' },
          })
        } else {
          if (seenIds.has(promo.id)) {
            violations.push({
              ruleId: 'PromoCodesShape',
              severity: 'warning',
              message: `"${funnelLabel}" — promo_codes[${entryIdx}].id "${promo.id}" duplicates an earlier entry; ids must be unique within a funnel.`,
              path: `${path}/id`,
              data: { funnelId: funnel.id, index: entryIdx, check: 'promo-id-duplicate', value: promo.id },
            })
          }
          seenIds.add(promo.id)
        }

        if (!isNonEmptyString(promo.code)) {
          violations.push({
            ruleId: 'PromoCodesShape',
            severity: 'warning',
            message: `"${funnelLabel}" — promo_codes[${entryIdx}].code is required and must be a non-empty string.`,
            path: `${path}/code`,
            data: { funnelId: funnel.id, index: entryIdx, check: 'promo-code-missing' },
          })
        } else {
          const codeUpper = promo.code.toUpperCase()
          if (seenCodes.has(codeUpper)) {
            violations.push({
              ruleId: 'PromoCodesShape',
              severity: 'warning',
              message: `"${funnelLabel}" — promo_codes[${entryIdx}].code "${promo.code}" duplicates an earlier entry (case-insensitive); ordering decides priority so duplicates are ambiguous.`,
              path: `${path}/code`,
              data: { funnelId: funnel.id, index: entryIdx, check: 'promo-code-duplicate', value: promo.code },
            })
          }
          seenCodes.add(codeUpper)
        }

        // Date validation: when present, must parse. Both fields are optional;
        // missing one is fine ("starts now" or "no end").
        const hasStarts = promo.starts_at !== undefined && promo.starts_at !== null && promo.starts_at !== ''
        const hasEnds = promo.ends_at !== undefined && promo.ends_at !== null && promo.ends_at !== ''
        const startsOk = !hasStarts || isValidDateString(promo.starts_at)
        const endsOk = !hasEnds || isValidDateString(promo.ends_at)

        if (hasStarts && !startsOk) {
          violations.push({
            ruleId: 'PromoCodesShape',
            severity: 'warning',
            message: `"${funnelLabel}" — promo_codes[${entryIdx}].starts_at "${promo.starts_at}" is not a valid ISO date string.`,
            path: `${path}/starts_at`,
            data: { funnelId: funnel.id, index: entryIdx, check: 'promo-starts-at-bad', value: promo.starts_at },
          })
        }
        if (hasEnds && !endsOk) {
          violations.push({
            ruleId: 'PromoCodesShape',
            severity: 'warning',
            message: `"${funnelLabel}" — promo_codes[${entryIdx}].ends_at "${promo.ends_at}" is not a valid ISO date string.`,
            path: `${path}/ends_at`,
            data: { funnelId: funnel.id, index: entryIdx, check: 'promo-ends-at-bad', value: promo.ends_at },
          })
        }
        if (hasStarts && hasEnds && startsOk && endsOk) {
          const startsAt = Date.parse(promo.starts_at as string)
          const endsAt = Date.parse(promo.ends_at as string)
          if (startsAt > endsAt) {
            violations.push({
              ruleId: 'PromoCodesShape',
              severity: 'warning',
              message: `"${funnelLabel}" — promo_codes[${entryIdx}] starts_at "${promo.starts_at}" is after ends_at "${promo.ends_at}"; swap the values or fix the range.`,
              path,
              data: { funnelId: funnel.id, index: entryIdx, check: 'promo-range-inverted', starts_at: promo.starts_at, ends_at: promo.ends_at },
            })
          }
        }

        // Visual presentation fields: if present, must be a string. We don't
        // narrow the values (e.g. color format), since author intent is
        // freeform copy / brand color choice.
        for (const field of VISUAL_STRING_FIELDS) {
          if (promo[field] === undefined) continue
          if (typeof promo[field] !== 'string') {
            violations.push({
              ruleId: 'PromoCodesShape',
              severity: 'warning',
              message: `"${funnelLabel}" — promo_codes[${entryIdx}].${field} must be a string; got ${typeof promo[field]}.`,
              path: `${path}/${field}`,
              data: { funnelId: funnel.id, index: entryIdx, field, check: 'promo-visual-bad-type' },
            })
          }
        }
      })
    })

    return violations
  },
}
