import { describe, expect, test } from 'bun:test'
import { SdkVersion } from '../../rules/sdk-version.ts'
import { normalize } from '../../normalize.ts'
import type { CampaignSpec } from '../../types.ts'

function baseSpec(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    schema_version: '4.3',
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'sdk version testing',
        weight: 100,
        pages: [{ id: 'p', type: 'thankyou' }],
      },
    ],
    ...overrides,
  }
}

describe('SdkVersion rule', () => {
  test('passes when runtime.sdk_version is present', () => {
    const spec = baseSpec({ runtime: { sdk_version: '0.4.19' } })
    expect(SdkVersion.check(normalize(spec))).toEqual([])
  })

  test('passes when only global_config.sdk_version is present (legacy)', () => {
    const spec = baseSpec({ global_config: { sdk_version: '0.4.19' } })
    expect(SdkVersion.check(normalize(spec))).toEqual([])
  })

  test('flags when both locations are missing', () => {
    const spec = baseSpec()
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('SdkVersion')
    expect(violations[0].message).toBe('SDK version is required for spec export.')
  })
})
