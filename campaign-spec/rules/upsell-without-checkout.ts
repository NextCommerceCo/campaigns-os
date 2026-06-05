/**
 * UpsellWithoutCheckout — if the spec has upsell pages, it must also have a
 * checkout page. Otherwise nothing routes into the upsell flow.
 *
 * Severity downgrades to warning when build_scope.mode === 'partial', because
 * partial-upsell builds may legitimately ship a standalone upsell that an
 * existing downstream campaign routes into. Message text and severity rule
 * inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const UpsellWithoutCheckout: Rule = {
  id: 'UpsellWithoutCheckout',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    let hasUpsell = false
    let hasCheckout = false

    for (const funnel of spec.funnels) {
      for (const page of funnel.pages ?? []) {
        if (page.type === 'upsell') hasUpsell = true
        else if (page.type === 'checkout') hasCheckout = true
        if (hasUpsell && hasCheckout) return []
      }
    }

    if (!hasUpsell) return []
    if (hasCheckout) return []

    const isPartialScope = spec.build_scope?.mode === 'partial'

    return [
      {
        ruleId: 'UpsellWithoutCheckout',
        severity: isPartialScope ? 'warning' : 'error',
        message: isPartialScope
          ? 'Upsells are present without an active Checkout page. Valid for partial upsell builds when an existing checkout routes into this page.'
          : 'Upsells require an active Checkout page.',
        path: '/funnels',
        data: { isPartialScope },
      },
    ]
  },
}
