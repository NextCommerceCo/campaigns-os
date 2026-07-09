/**
 * Compiled-artifact smoke test (ADR-003).
 *
 * The per-rule suites import the .ts source; this one imports the BUILT bundle
 * at ../dist/index.js — the exact artifact the published `exports` subpath
 * (@nextcommerce/campaigns-os/campaign-spec) and the CLI doctor consume. It
 * proves `npm run build:spec` produced a working ESM module with the full
 * public surface, so a broken build fails CI instead of shipping. Requires the
 * build to have run first (npm run check does build:spec before check:spec).
 */
import { describe, test, expect } from './harness.ts'
import * as dist from '../dist/index.js'

describe('compiled dist bundle', () => {
  test('exposes the full public surface', () => {
    for (const name of [
      'normalize',
      'runRules',
      'validateSpec',
      'allRules',
      'fastRules',
      'specOnlyRules',
      'NormalizeError',
      'DL_EVENTS',
      'DL_EVENT_NAMES',
      'CAMPAIGN_CART_ANALYTICS_VOCABULARY_SDK_VERSION',
      'CAMPAIGN_CART_ANALYTICS_IDENTITY_MIN_SDK_VERSION',
    ]) {
      expect(typeof (dist as Record<string, unknown>)[name] !== 'undefined').toBe(true)
    }
  })

  test('validateSpec runs on the compiled bundle', () => {
    const violations = dist.validateSpec({})
    expect(Array.isArray(violations)).toBe(true)
    expect(violations.length).toBe(1)
    expect(violations[0].ruleId).toBe('Normalize')
  })

  test('allRules is a non-empty registry', () => {
    expect(dist.allRules.length > 0).toBe(true)
  })
})
