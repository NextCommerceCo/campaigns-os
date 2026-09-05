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

  /**
   * The regression this rule almost shipped. Source intake wires a checkout's
   * next_page — twelve pages across ten certified fixtures route that way —
   * while getNextIds followed only success_url on a checkout. The loop below
   * therefore BUILT as a live link while staying invisible to the rule that
   * blocks on cycles. Edges now come from the shared resolver, which reads
   * every declared routing field regardless of page type.
   */
  test('a loop through a checkout next_page is caught, not just through success_url', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'checkout loops back via next_page',
          weight: 100,
          pages: [
            { id: 'landing', type: 'landing', next_page: 'checkout' },
            { id: 'checkout', type: 'checkout', next_page: 'landing' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('error')
    expect(violations[0].data?.cycle).toEqual(['landing', 'checkout', 'landing'])
  })

  test('a traversable edge is followed whatever the page type carries it', () => {
    // A thank-you page that continues into a second offer sequence is unusual
    // and entirely legal; the old terminal-by-type table could not see it, so a
    // sequence routing back INTO the receipt looked clean.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'post-receipt continuation loops',
          weight: 100,
          pages: [
            { id: 'chk', type: 'checkout', success_url: 'ty' },
            { id: 'ty', type: 'thankyou', next_page: 'chk' },
          ],
        },
      ],
    }
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.cycle).toEqual(['chk', 'ty', 'chk'])
  })

  test('a select page routes forward like a landing page, so cycles through it are caught', () => {
    // The two-step shape: select → checkout → thankyou, with the selector step
    // looping back. If 'select' had no outgoing edges in getNextIds, this cycle
    // would be invisible — which is the whole reason the type needs routing
    // semantics rather than just enum membership.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'two-step selector cycle',
          weight: 100,
          pages: [
            { id: 'select', type: 'select', label: 'Select bundle', next_page: 'chk' },
            { id: 'chk', type: 'checkout', label: 'Checkout', success_url: 'select' },
            { id: 'ty', type: 'thankyou', label: 'Thank You' },
          ],
        },
      ],
    }
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('error')
    expect(violations[0].data?.cycle).toEqual(['select', 'chk', 'select'])
  })

  test('a clean two-step funnel through a select page emits no violations', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'two-step clean',
          weight: 100,
          pages: [
            { id: 'select', type: 'select', label: 'Select bundle', next_page: 'chk' },
            { id: 'chk', type: 'checkout', label: 'Checkout', success_url: 'ty' },
            { id: 'ty', type: 'thankyou', label: 'Thank You' },
          ],
        },
      ],
    }
    expect(CycleDetection.check(normalize(spec))).toEqual([])
  })

  test('a shadowed forward field does not manufacture a cycle', () => {
    // Regression: cycle detection briefly followed EVERY declared field, so a
    // checkout whose success_url wins at runtime and terminates cleanly was
    // reported as a release-blocking cycle through an unused next_page.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'stale shadowed field',
          weight: 100,
          pages: [
            { id: 'chk', type: 'checkout', success_url: 'ty', next_page: 'chk' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(CycleDetection.check(normalize(spec))).toEqual([])
  })

  test('a padded route target still resolves, so the loop is still seen', () => {
    // Regression: an untrimmed target missed the page map, hiding a real loop.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'padded target',
          weight: 100,
          pages: [
            { id: 'landing', type: 'landing', next_page: 'checkout' },
            { id: 'checkout', type: 'checkout', next_page: '  landing  ' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = CycleDetection.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.cycle).toEqual(['landing', 'checkout', 'landing'])
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

  test('acyclic chain traversal grows linearly and cache does not survive a check', () => {
    function chain(count: number) {
      let reads = 0
      const pages = Array.from({ length: count }, (_, index) => ({
        id: `p${index}`, type: 'landing' as const,
        get next_page() { reads++; return index + 1 < count ? `p${index + 1}` : undefined },
      }))
      const spec: CampaignSpec = { schema_version: '4.3', funnels: [{ id: 'f', pages }] }
      expect(CycleDetection.check(spec)).toEqual([])
      return reads
    }
    const small = chain(100)
    const large = chain(200)
    // Doubling the chain must not more than double routing reads.
    expect(large <= small * 2).toBe(true)

    const spec: CampaignSpec = { schema_version: '4.3', funnels: [{ id: 'f', pages: [
      { id: 'a', type: 'landing', next_page: 'b' },
      { id: 'b', type: 'landing' },
    ] }] }
    expect(CycleDetection.check(spec)).toEqual([])
    spec.funnels[0].pages![1].next_page = 'a'
    expect(CycleDetection.check(spec)[0].data?.cycle).toEqual(['a', 'b', 'a'])
  })

  test('an explored acyclic branch cannot hide a later decline cycle', () => {
    const spec: CampaignSpec = { schema_version: '4.3', funnels: [{ id: 'f', pages: [
      { id: 'safe', type: 'landing', next_page: 'receipt' },
      { id: 'receipt', type: 'thankyou' },
      { id: 'offer', type: 'upsell', on_accept: 'safe', on_decline: 'loop' },
      { id: 'loop', type: 'landing', next_page: 'offer' },
    ] }] }
    const violations = CycleDetection.check(spec)
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.cycle).toEqual(['offer', 'loop', 'offer'])
    expect(violations[0].path).toBe('/funnels/0/pages/2')
  })
})
