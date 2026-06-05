/**
 * ShippingMethodsPresent — warn when the spec declares no shipping methods.
 * Missing/undefined or empty array both fire; matches legacy behaviour.
 *
 * Warning severity (not error) — the campaign can still ship technically,
 * the warning surfaces that the operator hasn't chosen methods yet.
 * Message text inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const ShippingMethodsPresent: Rule = {
  id: 'ShippingMethodsPresent',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const methods = spec.shipping_methods ?? []
    if (methods.length > 0) return []
    return [
      {
        ruleId: 'ShippingMethodsPresent',
        severity: 'warning',
        message: 'No shipping methods selected.',
        path: '/shipping_methods',
      },
    ]
  },
}
