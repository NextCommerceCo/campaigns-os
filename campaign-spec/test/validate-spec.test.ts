/**
 * validateSpec — convenience entry point.
 *
 * Tests the wrapper: normalize → runRules(allRules), with NormalizeError
 * surfaced as a single error-severity Violation rather than thrown. Used by
 * callers that want a single one-shot validation call without composing
 * their own preset (spec-compiler's `validateSpec` wraps this; everyone
 * else uses `runRules(normalize(spec), <preset>)`).
 */

import { describe, expect, test } from 'bun:test'
import { validateSpec } from '../index.ts'

describe('validateSpec (backwards-compat wrapper)', () => {
  test('non-object input surfaces a Normalize violation', () => {
    const violations = validateSpec(null)
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('Normalize')
    expect(violations[0].severity).toBe('error')
  })

  test('v4.1 spec (funnel_pages only) is rejected with explicit guidance', () => {
    const v41 = {
      schema_version: '4.1',
      funnel_pages: [{ id: 'p1', type: 'landing' }],
    }
    const violations = validateSpec(v41)
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('Normalize')
    expect(violations[0].message).toContain('v4.1')
    expect(violations[0].message).toContain('ADR-002')
  })

  test('missing funnels[] surfaces a Normalize violation', () => {
    const violations = validateSpec({ schema_version: '4.3' })
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('Normalize')
    expect(violations[0].message).toContain('funnels')
  })

  test('valid spec passes through and runs all rules', () => {
    const spec = {
      schema_version: '4.3',
      runtime: { sdk_version: '0.4.0' },
      campaign: { ref_id: 1, payment_env_key: 'test_key' },
      shipping_methods: [{ ref_id: 'ship-standard' }],
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'minimal valid spec for validateSpec wrapper test',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'ty' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = validateSpec(spec)
    expect(violations).toEqual([])
  })
})
