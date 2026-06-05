/**
 * ShippingCountriesShape — campaign.available_shipping_countries must be
 * either the literal string "all", an array of country codes, or absent.
 * Anything else (a single string, an object, a number) is malformed.
 *
 * Warning severity. Message text inherited verbatim from the pre-#110
 * validator at migration time.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

function isValidShape(countries: unknown): boolean {
  return countries == null || countries === 'all' || Array.isArray(countries)
}

export const ShippingCountriesShape: Rule = {
  id: 'ShippingCountriesShape',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const countries = spec.campaign?.available_shipping_countries
    if (isValidShape(countries)) return []
    return [
      {
        ruleId: 'ShippingCountriesShape',
        severity: 'warning',
        message: 'Shipping countries must be "all" or an array of country codes.',
        path: '/campaign/available_shipping_countries',
        data: { received: countries },
      },
    ]
  },
}
