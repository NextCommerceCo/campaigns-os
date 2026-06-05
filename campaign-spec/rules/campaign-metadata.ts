/**
 * CampaignMetadata — bundles two campaign-level metadata warnings:
 *   1. Missing payment_env_key — required for spec export
 *   2. Missing ref_id — needed for multi-campaign API disambiguation
 *
 * Both are warning severity. Bundled into one rule because they share a
 * domain (campaign metadata completeness) and no caller has expressed
 * a need to subset them. If that need shows up, split into
 * CampaignPaymentKey and CampaignRefId.
 *
 * Message text inherited verbatim from the pre-#110 validator at migration time.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const CampaignMetadata: Rule = {
  id: 'CampaignMetadata',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const campaign = spec.campaign ?? {}

    if (!campaign.payment_env_key) {
      violations.push({
        ruleId: 'CampaignMetadata',
        severity: 'warning',
        message: 'No campaign loaded — campaign key required for spec export.',
        path: '/campaign/payment_env_key',
        data: { missing: 'payment_env_key' },
      })
    }

    if (campaign.ref_id == null) {
      violations.push({
        ruleId: 'CampaignMetadata',
        severity: 'warning',
        message:
          'Campaign has no numeric ref_id; API refresh cannot disambiguate multi-campaign responses.',
        path: '/campaign/ref_id',
        data: { missing: 'ref_id' },
      })
    }

    return violations
  },
}
