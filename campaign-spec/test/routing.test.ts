/**
 * Unit tests for the shared outgoing-edge resolver.
 *
 * These pin the two properties the rest of the codebase now depends on: the
 * forward precedence order, and the fact that the full edge set over-
 * approximates while the forward link does not. Both were previously encoded
 * three times, in three page-type tables that had already drifted apart.
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

  test('outgoingEdgeIds over-approximates: every declared field, deduplicated', () => {
    expect(outgoingEdgeIds(page({ on_accept: 'a', success_url: 's', next_page: 'n', on_decline: 'd' })))
      .toEqual(['a', 's', 'n', 'd'])
    // An upsell whose next_page duplicates on_accept yields one edge, not two —
    // this is the corpus's most common shape.
    expect(outgoingEdgeIds(page({ on_accept: 'x', next_page: 'x', on_decline: 'y' }))).toEqual(['x', 'y'])
    expect(outgoingEdgeIds(page({}))).toEqual([])
  })

  test('the full edge set is a superset of the forward link', () => {
    // The invariant that keeps a safety analysis from missing what wiring does:
    // whatever the forward link resolves to must appear in the edge set.
    const shapes = [
      { on_accept: 'a', success_url: 's', next_page: 'n', on_decline: 'd' },
      { success_url: 's', next_page: 'n' },
      { next_page: 'n' },
      { on_decline: 'd' },
      {},
    ]
    for (const shape of shapes) {
      const forward = forwardRouteTarget(page(shape))
      if (forward === null) continue
      expect(outgoingEdgeIds(page(shape)).includes(forward)).toBe(true)
    }
  })
})
