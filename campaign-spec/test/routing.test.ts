/**
 * Unit tests for the shared outgoing-edge resolver.
 *
 * These pin the properties the rest of the codebase now depends on: the forward
 * precedence order, target normalization, and the edge set being exactly what
 * the runtime can traverse (forward plus decline) rather than every declared
 * field. All were previously encoded three times, in three page-type tables
 * that had already drifted apart.
 */

import { describe, expect, test } from './harness.ts'
import {
  DECLINE_ROUTE_FIELD,
  FORWARD_ROUTE_FIELDS,
  ROUTE_FIELDS,
  declineRouteTarget,
  forwardRouteTarget,
  hasForwardRoute,
  outgoingEdgeIds,
} from '../routing.ts'
import type { Page } from '../types.ts'

const page = (fields: Record<string, unknown>): Page => ({ id: 'p', ...fields }) as Page

describe('routing — shared outgoing-edge resolver', () => {
  test('forward precedence is specific-before-generic', () => {
    expect([...FORWARD_ROUTE_FIELDS]).toEqual(['on_accept', 'success_url', 'next_page'])
    expect(DECLINE_ROUTE_FIELD).toBe('on_decline')
    expect([...ROUTE_FIELDS]).toEqual(['on_accept', 'success_url', 'next_page', 'on_decline'])
  })

  test('forwardRouteTarget returns the first declared field in precedence order', () => {
    expect(forwardRouteTarget(page({ on_accept: 'a', success_url: 's', next_page: 'n' }))).toBe('a')
    expect(forwardRouteTarget(page({ success_url: 's', next_page: 'n' }))).toBe('s')
    expect(forwardRouteTarget(page({ next_page: 'n' }))).toBe('n')
  })

  test('forwardRouteTarget is type-agnostic — a checkout may route through next_page', () => {
    // The twelve-page case: nothing about the page type gates the answer.
    expect(forwardRouteTarget(page({ type: 'checkout', next_page: 'upsell.html' }))).toBe('upsell.html')
    // And a thank-you page may continue into a second sequence.
    expect(forwardRouteTarget(page({ type: 'thankyou', next_page: 'oto-2.html' }))).toBe('oto-2.html')
  })

  test('a declared-but-empty field is not an edge', () => {
    expect(forwardRouteTarget(page({ next_page: '' }))).toBe(null)
    expect(forwardRouteTarget(page({ next_page: '   ' }))).toBe(null)
    expect(forwardRouteTarget(page({ next_page: null }))).toBe(null)
    // Falling through an empty field to a populated one is the point of the loop.
    expect(forwardRouteTarget(page({ on_accept: '', next_page: 'n' }))).toBe('n')
  })

  test('missing pages are handled, not thrown at', () => {
    expect(forwardRouteTarget(null)).toBe(null)
    expect(forwardRouteTarget(undefined)).toBe(null)
    expect(outgoingEdgeIds(null)).toEqual([])
  })

  test('hasForwardRoute agrees with forwardRouteTarget', () => {
    expect(hasForwardRoute(page({ next_page: 'n' }))).toBe(true)
    expect(hasForwardRoute(page({ on_decline: 'd' }))).toBe(false)
    expect(hasForwardRoute(page({}))).toBe(false)
  })

  test('the decline branch is a second edge, never a forward fallback', () => {
    // A page whose ONLY routing field is on_decline has no forward link: the
    // decline branch must not be silently promoted into one.
    expect(forwardRouteTarget(page({ on_decline: 'd' }))).toBe(null)
    expect(declineRouteTarget(page({ on_decline: 'd' }))).toBe('d')
    expect(declineRouteTarget(page({ next_page: 'n' }))).toBe(null)
  })

  test('outgoingEdgeIds is the traversable edge set: forward plus decline', () => {
    // NOT every declared field. `success_url` and `next_page` below are shadowed
    // by the higher-precedence on_accept and can never be taken at runtime.
    expect(outgoingEdgeIds(page({ on_accept: 'a', success_url: 's', next_page: 'n', on_decline: 'd' })))
      .toEqual(['a', 'd'])
    // An upsell whose next_page duplicates on_accept yields one edge, not two —
    // this is the corpus's most common shape.
    expect(outgoingEdgeIds(page({ on_accept: 'x', next_page: 'x', on_decline: 'y' }))).toEqual(['x', 'y'])
    expect(outgoingEdgeIds(page({}))).toEqual([])
  })

  test('a shadowed forward field is not an edge — it can never be traversed', () => {
    // Regression: treating every declared field as an edge reported a
    // release-blocking cycle through an unused next_page on a page whose
    // success_url wins at runtime and terminates cleanly.
    expect(outgoingEdgeIds(page({ success_url: 'ty', next_page: 'self' }))).toEqual(['ty'])
    expect(outgoingEdgeIds(page({ on_accept: 'a', success_url: 'self' }))).toEqual(['a'])
  })

  test('route targets are normalized, so every consumer resolves the same string', () => {
    // Regression: returning the raw value while testing the trimmed one let
    // intake wire " landing " (it trims downstream) while cycle detection's
    // pageMap.get(" landing ") missed, hiding a real loop.
    expect(forwardRouteTarget(page({ next_page: '  landing  ' }))).toBe('landing')
    expect(declineRouteTarget(page({ on_decline: '\tdownsell\n' }))).toBe('downsell')
    // Padding must not split one edge into two.
    expect(outgoingEdgeIds(page({ on_accept: 'x', on_decline: ' x ' }))).toEqual(['x'])
  })

  test('every field combination: the edge set always contains the forward link', () => {
    // The invariant that keeps graph analysis from missing what wiring does.
    // Derived over the power set of ROUTE_FIELDS rather than a hand-listed few,
    // so adding a routing field cannot leave this silently unexercised.
    const fields = [...ROUTE_FIELDS]
    for (let mask = 0; mask < 1 << fields.length; mask += 1) {
      const shape: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        if (mask & (1 << index)) shape[field] = field
      })
      const forward = forwardRouteTarget(page(shape))
      if (forward === null) continue
      expect(outgoingEdgeIds(page(shape)).includes(forward)).toBe(true)
    }
  })
})
