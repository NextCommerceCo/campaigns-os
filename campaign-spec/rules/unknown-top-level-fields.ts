/**
 * UnknownTopLevelFields — reports top-level spec keys and campaign.* keys
 * that are not part of the known CampaignSpec v4 surface.
 *
 * Warning severity: unknown fields are legal (the schema is deliberately
 * permissive — schemas/campaign-spec.v4.schema.json keeps
 * additionalProperties open), but naming them surfaces dialect drift early
 * instead of letting a misspelled or legacy key ride along silently.
 * Rejection-at-export belongs to validation profiles in a later change.
 *
 * Skipped on purpose:
 *   - keys starting with "_" (builder/ops annotations: _provenance,
 *     _accept_label, ...);
 *   - keys ending with "_note" (real exports use *_note keys as inline
 *     annotations);
 *   - sdk_hints interiors (template-handoff vocabulary lives there; this
 *     rule only reads the top level and campaign.*).
 *
 * The known sets below MIRROR schemas/campaign-spec.v4.schema.json
 * (top-level `properties` and `$defs.campaign.properties`). Rules stay pure
 * and filesystem-free, so the sets are duplicated here; the sync test
 * (test/rules/unknown-top-level-fields.test.ts) asserts they match the
 * schema exactly — update both together.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const KNOWN_TOP_LEVEL_FIELDS: readonly string[] = [
  'schema_version',
  'builder_version',
  'generated_at',
  'campaign',
  'global_config',
  'runtime',
  'funnels',
  'funnel_pages',
  'shipping_methods',
  'offers',
  'spec_identity',
  'build_scope',
  'analytics',
  'slug',
  'map_id',
  'saved_at',
  'deployment',
  'draft',
  'draft_notes',
  'figma_url',
]

export const KNOWN_CAMPAIGN_FIELDS: readonly string[] = [
  'ref_id',
  'id',
  'name',
  'slug',
  'currency',
  'language',
  'payment_env_key',
  'campaigns_api_key',
  'available_payment_methods',
  'available_express_payment_methods',
  'available_currencies',
  'available_shipping_countries',
  'tracking',
  'preferred_template_family',
  'allowed_domains',
  'route_root',
  'store_url',
  'store_name',
  'store_contact',
  'store_terms',
  'store_shipping',
  'store_privacy',
  'store_returns',
  'store_phone',
  'store_phone_tel',
  'footer_links',
  'seo',
]

function skipKey(key: string): boolean {
  return key.startsWith('_') || key.endsWith('_note')
}

export const UnknownTopLevelFields: Rule = {
  id: 'UnknownTopLevelFields',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const knownTop = new Set(KNOWN_TOP_LEVEL_FIELDS)
    const knownCampaign = new Set(KNOWN_CAMPAIGN_FIELDS)

    for (const key of Object.keys(spec)) {
      if (skipKey(key) || knownTop.has(key)) continue
      violations.push({
        ruleId: 'UnknownTopLevelFields',
        severity: 'warning',
        message: `Unknown top-level field "${key}" — not part of the CampaignSpec v4 surface. Check for a typo or a legacy key; unknown fields are carried through but never read.`,
        path: `/${key}`,
        data: { scope: 'top-level', key },
      })
    }

    const campaign = spec.campaign
    if (campaign && typeof campaign === 'object' && !Array.isArray(campaign)) {
      for (const key of Object.keys(campaign)) {
        if (skipKey(key) || knownCampaign.has(key)) continue
        violations.push({
          ruleId: 'UnknownTopLevelFields',
          severity: 'warning',
          message: `Unknown campaign field "campaign.${key}" — not part of the CampaignSpec v4 surface. Check for a typo or a legacy key; unknown fields are carried through but never read.`,
          path: `/campaign/${key}`,
          data: { scope: 'campaign', key },
        })
      }
    }

    return violations
  },
}
