import { describe, expect, test } from '../harness.ts'
import {
  UnknownTopLevelFields,
  KNOWN_TOP_LEVEL_FIELDS,
  KNOWN_CAMPAIGN_FIELDS,
} from '../../rules/unknown-top-level-fields.ts'
import { normalize } from '../../normalize.ts'
import type { CampaignSpec } from '../../types.ts'
import schema from '../../../schemas/campaign-spec.v4.schema.json' with { type: 'json' }

function baseSpec(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    schema_version: '4.3',
    global_config: { sdk_version: '0.4.37' },
    campaign: {
      ref_id: 7,
      slug: 'unknown-fields-testing',
      payment_env_key: 'test_key',
    },
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'unknown top-level field testing',
        weight: 100,
        pages: [{ id: 'p', type: 'thankyou' }],
      },
    ],
    ...overrides,
  }
}

describe('UnknownTopLevelFields rule', () => {
  test('passes on a spec that only uses known fields', () => {
    expect(UnknownTopLevelFields.check(normalize(baseSpec()))).toEqual([])
  })

  test('flags an unknown top-level key with its path', () => {
    const spec = baseSpec({ funel_pages: [] } as Partial<CampaignSpec>)
    const violations = UnknownTopLevelFields.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('UnknownTopLevelFields')
    expect(violations[0].severity).toBe('warning')
    expect(violations[0].path).toBe('/funel_pages')
    expect(violations[0].data?.scope).toBe('top-level')
  })

  test('flags an unknown campaign.* key with its path', () => {
    const spec = baseSpec()
    ;(spec.campaign as Record<string, unknown>).store_fone = '555-0100'
    const violations = UnknownTopLevelFields.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].path).toBe('/campaign/store_fone')
    expect(violations[0].data?.scope).toBe('campaign')
  })

  test('skips underscore-prefixed and *_note annotation keys', () => {
    const spec = baseSpec({
      _provenance: { ops: [] },
      routing_note: 'annotation, not surface',
    } as Partial<CampaignSpec>)
    ;(spec.campaign as Record<string, unknown>)._internal = true
    ;(spec.campaign as Record<string, unknown>).tracking_note = 'annotation'
    expect(UnknownTopLevelFields.check(normalize(spec))).toEqual([])
  })

  test('reports one violation per unknown key', () => {
    const spec = baseSpec({ alpha: 1, beta: 2 } as Partial<CampaignSpec>)
    const violations = UnknownTopLevelFields.check(normalize(spec))
    expect(violations).toHaveLength(2)
  })

  // The rule stays pure (no filesystem), so its known sets duplicate the
  // schema's property names. This is the drift gate: the two lists must
  // stay identical, updated together.
  test('known top-level set matches schemas/campaign-spec.v4.schema.json', () => {
    const schemaTopLevel = Object.keys(
      (schema as { properties: Record<string, unknown> }).properties,
    ).filter((key) => !key.startsWith('_'))
    expect([...KNOWN_TOP_LEVEL_FIELDS].sort()).toEqual(schemaTopLevel.sort())
  })

  test('known campaign set matches the schema campaign definition', () => {
    const campaignDef = (schema as {
      $defs: { campaign: { properties: Record<string, unknown> } }
    }).$defs.campaign.properties
    expect([...KNOWN_CAMPAIGN_FIELDS].sort()).toEqual(Object.keys(campaignDef).sort())
  })
})
