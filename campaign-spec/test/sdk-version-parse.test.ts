/**
 * Shared strict SDK-version parser.
 *
 * The acceptance predicate must stay IDENTICAL to what the Page Kit
 * SDK-version checkpoint shipped with (src/page-kit-sdk-version.mjs) — the
 * checkpoint now imports this parser, and the SdkVersion authoring rule uses
 * it too, so any drift here changes both gates at once.
 */
import { describe, expect, test } from './harness.ts'
import {
  RELEASED_SDK_VERSION_PATTERN,
  parseSdkVersion,
  isReleasedSdkVersion,
  describeSdkVersionRejection,
} from '../sdk-version-parse.ts'
import type { SdkVersionRejectionReason } from '../sdk-version-parse.ts'

describe('parseSdkVersion', () => {
  test('accepts canonical released MAJOR.MINOR.PATCH versions', () => {
    for (const value of ['0.0.0', '0.4.37', '1.0.0', '10.20.30', '0.10.0']) {
      const result = parseSdkVersion(value)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.version).toBe(value)
      expect(isReleasedSdkVersion(value)).toBe(true)
      expect(RELEASED_SDK_VERSION_PATTERN.test(value)).toBe(true)
    }
  })

  test('classifies every rejection the checkpoint enforces', () => {
    const cases: Array<[unknown, SdkVersionRejectionReason]> = [
      [37, 'non-string'],
      [null, 'non-string'],
      [undefined, 'non-string'],
      [{ version: '0.4.37' }, 'non-string'],
      [true, 'non-string'],
      ['', 'empty'],
      ['   ', 'empty'],
      [' 0.4.37 ', 'padded'],
      ['0.4.37\n', 'padded'],
      ['0.4.37-beta.1', 'prerelease-or-build'],
      ['0.4.37+build.5', 'prerelease-or-build'],
      ['0.4.37-rc.1+sha.abc', 'prerelease-or-build'],
      ['  0.4.37-beta.1  ', 'prerelease-or-build'],
      ['\t0.4.37+build\t', 'prerelease-or-build'],
      ['v0.4.37', 'non-canonical'],
      ['0.4', 'non-canonical'],
      ['0.4.', 'non-canonical'],
      ['01.2.3', 'non-canonical'],
      ['0.04.3', 'non-canonical'],
      ['0.4.3.7', 'non-canonical'],
      ['latest', 'non-canonical'],
      ['^0.4.37', 'non-canonical'],
    ]
    for (const [value, reason] of cases) {
      const result = parseSdkVersion(value)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe(reason)
      expect(isReleasedSdkVersion(value)).toBe(false)
    }
  })

  test('every rejection reason has a human-readable description', () => {
    const reasons: SdkVersionRejectionReason[] = [
      'non-string',
      'empty',
      'padded',
      'prerelease-or-build',
      'non-canonical',
    ]
    for (const reason of reasons) {
      const detail = describeSdkVersionRejection(reason)
      expect(typeof detail).toBe('string')
      expect(detail.length > 0).toBe(true)
    }
  })

  test('acceptance agrees with the checkpoint regex on every case', () => {
    const values: unknown[] = [
      '0.4.37', '1.2.3', '', ' 0.4.37 ', 'v0.4.37', '0.4', '01.2.3',
      '0.4.37-beta.1', '0.4.37+build', 'latest', '0.0.0', '10.0.1',
    ]
    for (const value of values) {
      const viaRegex = typeof value === 'string' && RELEASED_SDK_VERSION_PATTERN.test(value)
      expect(parseSdkVersion(value).ok).toBe(viaRegex)
    }
  })
})
