/**
 * DownsellWithoutUpsell — flags specs with downsell pages but no upsell.
 * A downsell-only flow is unusual (downsells are typically reached from an
 * upsell decline path); warn rather than error so the operator can confirm
 * intent if it's deliberate.
 *
 * Warning severity (not error) — preserves legacy classification.
 * Message text preserved verbatim.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const DownsellWithoutUpsell: Rule = {
  id: 'DownsellWithoutUpsell',
  severity: 'warning',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    let hasDownsell = false
    let hasUpsell = false

    for (const funnel of spec.funnels) {
      for (const page of funnel.pages ?? []) {
        if (page.type === 'downsell') hasDownsell = true
        else if (page.type === 'upsell') hasUpsell = true
        if (hasDownsell && hasUpsell) return []
      }
    }

    if (!hasDownsell) return []
    if (hasUpsell) return []

    return [
      {
        ruleId: 'DownsellWithoutUpsell',
        severity: 'warning',
        message: 'Downsell pages present but no Upsell pages — intentional?',
        path: '/funnels',
      },
    ]
  },
}
