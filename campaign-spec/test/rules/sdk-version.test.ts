import { describe, expect, test } from '../harness.ts'
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
  test('passes when global_config.sdk_version is present (canonical)', () => {
    const spec = baseSpec({ global_config: { sdk_version: '0.4.19' } })
    expect(SdkVersion.check(normalize(spec))).toEqual([])
  })

  test('passes when only runtime.sdk_version is present (accepted alias)', () => {
    const spec = baseSpec({ runtime: { sdk_version: '0.4.19' } })
    expect(SdkVersion.check(normalize(spec))).toEqual([])
  })

  test('passes when both locations agree (redundant alias, as real drafts do)', () => {
    const spec = baseSpec({
      global_config: { sdk_version: '0.4.34' },
      runtime: { sdk_version: '0.4.34' },
    })
    expect(SdkVersion.check(normalize(spec))).toEqual([])
  })

  test('warns when both locations declare different versions', () => {
    const spec = baseSpec({
      global_config: { sdk_version: '0.4.19' },
      runtime: { sdk_version: '0.5.99' },
    })
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
    expect(violations[0].path).toBe('/runtime/sdk_version')
    expect(violations[0].data).toEqual({
      global_config: '0.4.19',
      runtime: '0.5.99',
      check: 'sdk-version-conflict',
    })
  })

  test('flags when both locations are missing, pointing at the canonical home', () => {
    const spec = baseSpec()
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('SdkVersion')
    expect(violations[0].message).toBe('SDK version is required for spec export.')
    expect(violations[0].path).toBe('/global_config/sdk_version')
  })
})
