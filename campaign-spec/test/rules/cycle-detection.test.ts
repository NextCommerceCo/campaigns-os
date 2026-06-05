/**
 * Per-rule unit tests for CycleDetection.
 *
 * Loads focused fixtures from the corpus and asserts the rule's output
 * against the corresponding expected/. Tight scope: only the cycle rule,
 * only the cycle-relevant fixtures.
 */

import { describe, expect, test } from '../harness.ts'
import { CycleDetection } from '../../rules/cycle-detection.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

describe('CycleDetection rule', () => {
  test('clean linear funnel emits no violations', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toEqual([])
  })

  test('upsell ↔ downsell cycle is reported once at the entry page', () => {
    const fixture = fixtureByName('two-funnel-with-cycle')
    const violations = CycleDetection.check(normalize(fixture.spec))

    expect(violations).toEqual(fixture.expected.violations)
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('CycleDetection')
    expect(violations[0].severity).toBe('error')
    expect(violations[0].path).toBe('/funnels/1/pages/2')
    expect(violations[0].data?.entryPageId).toBe('upsell-variant')
  })

  test('self-loop is reported as release-blocking error', () => {
    // Inline minimal spec with a self-loop on a landing page.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'self-loop demo',
          weight: 100,
          pages: [
            {
              id: 'looper',
              type: 'landing',
              label: 'Looper',
              next_page: 'looper',
            },
            { id: 'ty', type: 'thankyou', label: 'Thank You' },
          ],
        },
      ],
    }
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('error')
    expect(violations[0].data?.cycle).toEqual(['looper', 'looper'])
  })

  test('DAG convergence (two paths into the same page) is not a cycle', () => {
    // Both landing and an alt landing route to the same checkout. Not a cycle.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'convergence demo',
          weight: 100,
          pages: [
            { id: 'l1', type: 'landing', label: 'Landing 1', next_page: 'chk' },
            { id: 'l2', type: 'landing', label: 'Landing 2', next_page: 'chk' },
            { id: 'chk', type: 'checkout', label: 'Checkout', success_url: 'ty' },
            { id: 'ty', type: 'thankyou', label: 'Thank You' },
          ],
        },
      ],
    }
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toEqual([])
  })
})
