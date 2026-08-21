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

  test('errors when both locations declare different versions', () => {
    const spec = baseSpec({
      global_config: { sdk_version: '0.4.19' },
      runtime: { sdk_version: '0.5.99' },
    })
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('error')
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

  test('errors on non-canonical, prerelease, padded, empty, and non-string values (checkpoint parity)', () => {
    const invalidCases: Array<[unknown, string]> = [
      ['', 'empty'],
      [' 0.4.37 ', 'padded'],
      ['v0.4.37', 'non-canonical'],
      ['0.4', 'non-canonical'],
      ['01.2.3', 'non-canonical'],
      ['0.4.37-beta.1', 'prerelease-or-build'],
      ['0.4.37+build.5', 'prerelease-or-build'],
      [37, 'non-string'],
      [null, 'non-string'],
    ]
    for (const [value, reason] of invalidCases) {
      const spec = baseSpec({
        global_config: { sdk_version: value as string },
      })
      const violations = SdkVersion.check(normalize(spec))
      expect(violations).toHaveLength(1)
      expect(violations[0].severity).toBe('error')
      expect(violations[0].path).toBe('/global_config/sdk_version')
      expect(violations[0].message).toContain('MAJOR.MINOR.PATCH')
      expect(violations[0].data?.reason).toBe(reason)
      expect(violations[0].data?.check).toBe('sdk-version-strict')
    }
  })

  test('errors on a malformed alias value with the path at the alias location', () => {
    const spec = baseSpec({ runtime: { sdk_version: '0.4.37-rc.1' } })
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('error')
    expect(violations[0].path).toBe('/runtime/sdk_version')
  })

  test('reports one violation per malformed location when both carry bad values', () => {
    const spec = baseSpec({
      global_config: { sdk_version: 'v1' },
      runtime: { sdk_version: '' },
    })
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(2)
    expect(violations[0].path).toBe('/global_config/sdk_version')
    expect(violations[1].path).toBe('/runtime/sdk_version')
    for (const violation of violations) expect(violation.severity).toBe('error')
  })

  test('malformed values report as malformed, not as a conflict', () => {
    const spec = baseSpec({
      global_config: { sdk_version: '0.4.37' },
      runtime: { sdk_version: '0.4.37-beta.1' },
    })
    const violations = SdkVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].path).toBe('/runtime/sdk_version')
    expect(violations[0].data?.check).toBe('sdk-version-strict')
  })
})
