import { describe, expect, test } from 'bun:test'
import { CampaignMetadata } from '../../rules/campaign-metadata.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('CampaignMetadata rule', () => {
  test('flags both missing payment_env_key and missing ref_id together', () => {
    const fixture = fixtureByName('missing-campaign-metadata')
    const violations = CampaignMetadata.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('flags only payment_env_key when ref_id is present', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      campaign: { ref_id: 42 },
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'campaign with ref_id but no payment_env_key',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = CampaignMetadata.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.missing).toBe('payment_env_key')
  })

  test('flags only ref_id when payment_env_key is present', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      campaign: { payment_env_key: 'key' },
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'campaign with payment_env_key but no ref_id',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    const violations = CampaignMetadata.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.missing).toBe('ref_id')
  })

  test('accepts ref_id of 0 (zero is a valid numeric id)', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      campaign: { ref_id: 0, payment_env_key: 'key' },
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'campaign with ref_id zero (still a number)',
          weight: 100,
          pages: [{ id: 'p', type: 'thankyou' }],
        },
      ],
    }
    expect(CampaignMetadata.check(normalize(spec))).toEqual([])
  })

  test('passes when both fields are present', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(CampaignMetadata.check(normalize(spec))).toEqual([])
  })
})
