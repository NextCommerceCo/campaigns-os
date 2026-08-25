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
  OFFER_BEARING_PAGE_TYPES,
  PAYMENT_BEARING_PAGE_TYPES,
  ROUTE_FIELDS,
  declineRouteTarget,
  forwardRouteTarget,
  hasForwardRoute,
  inapplicableForwardFields,
  outgoingEdgeIds,
} from '../routing.ts'
import type { Page, PageType } from '../types.ts'

const page = (fields: Record<string, unknown>): Page => ({ id: 'p', ...fields }) as Page

/**
 * Every authoring page type, so the type-sensitive properties below are
 * exercised across all of them rather than the one the author of a test
 * happened to pick.
 *
 * Built from an EXHAUSTIVE record rather than a plain array: `PageType[]`
 * accepts any subset, so a hand-listed array would silently stop covering a
 * newly added type while still type-checking. `satisfies Record<PageType, 1>`
 * makes adding a member to the union a compile error right here, which is what
 * forces the "does this type take payment?" decision to be made rather than
 * defaulted.
 */
const ALL_PAGE_TYPES = Object.keys({
  presell: 1,
  landing: 1,
  select: 1,
  checkout: 1,
  upsell: 1,
  downsell: 1,
  thankyou: 1,
} satisfies Record<PageType, 1>) as PageType[]

describe('routing — shared outgoing-edge resolver', () => {
  test('forward precedence is specific-before-generic', () => {
    expect([...FORWARD_ROUTE_FIELDS]).toEqual(['on_accept', 'success_url', 'next_page'])
    expect(DECLINE_ROUTE_FIELD).toBe('on_decline')
    expect([...ROUTE_FIELDS]).toEqual(['on_accept', 'success_url', 'next_page', 'on_decline'])
  })

  test('forwardRouteTarget returns the first declared field in precedence order', () => {
    // Each assertion uses a page type that can actually satisfy the field under
    // test, so the ordering claim is about precedence and not about the type
    // carve-out. No single page type satisfies both `on_accept` and
    // `success_url` — an upsell takes payment but branches on acceptance, a
    // checkout takes payment with no offer to accept — so the head-to-head
    // between them is asserted through the field list itself.
    expect([...FORWARD_ROUTE_FIELDS]).toEqual(['on_accept', 'success_url', 'next_page'])
    expect(forwardRouteTarget(page({ type: 'upsell', on_accept: 'a', next_page: 'n' }))).toBe('a')
    expect(forwardRouteTarget(page({ type: 'checkout', success_url: 's', next_page: 'n' }))).toBe('s')
    expect(forwardRouteTarget(page({ type: 'checkout', next_page: 'n' }))).toBe('n')
  })

  test('next_page stays type-agnostic on every page type', () => {
    // The twelve-page case: nothing about the page type gates this answer.
    expect(forwardRouteTarget(page({ type: 'checkout', next_page: 'upsell.html' }))).toBe('upsell.html')
    // And a thank-you page may continue into a second sequence.
    expect(forwardRouteTarget(page({ type: 'thankyou', next_page: 'oto-2.html' }))).toBe('oto-2.html')
    // #234 narrowed the two fields that carry a page-shaped meaning. `next_page`
    // is the generic "wherever this goes next" and must never lose an edge —
    // that is the #230 principle the carve-out is not allowed to erode. Same
    // for the decline branch, which is not a forward field at all.
    for (const type of ALL_PAGE_TYPES) {
      expect(forwardRouteTarget(page({ type, next_page: 'n' }))).toBe('n')
      expect(declineRouteTarget(page({ type, on_decline: 'd' }))).toBe('d')
    }
  })

  test('on_accept only routes from a page that presents an offer', () => {
    // campaigns-os#234, second field. `on_accept` sits at the TOP of the
    // precedence list, so before this rule a `select` page carrying a
    // copy-pasted on_accept outranked its own `next_page: checkout` and wired
    // the shopper past payment — the identical break the success_url carve-out
    // fixed, reachable one field over.
    expect(OFFER_BEARING_PAGE_TYPES).toEqual(['upsell', 'downsell'])

    const select = page({ type: 'select', next_page: 'checkout', on_accept: 'upsell' })
    expect(forwardRouteTarget(select)).toBe('checkout')
    expect(outgoingEdgeIds(select)).toEqual(['checkout'])

    // A checkout's own success_url is no longer shadowed by a stray on_accept.
    const checkout = page({ type: 'checkout', success_url: 'upsell', on_accept: 'thankyou' })
    expect(forwardRouteTarget(checkout)).toBe('upsell')

    for (const type of ALL_PAGE_TYPES) {
      const hasOffer = (OFFER_BEARING_PAGE_TYPES as readonly string[]).includes(type)
      expect(forwardRouteTarget(page({ type, on_accept: 'a', next_page: 'n' })))
        .toBe(hasOffer ? 'a' : 'n')
      expect(forwardRouteTarget(page({ type, on_accept: 'a' }))).toBe(hasOffer ? 'a' : null)
      expect(hasForwardRoute(page({ type, on_accept: 'a' }))).toBe(hasOffer)
    }
  })

  test('no page type can satisfy both gated fields, and neither gate leaks', () => {
    // The two carve-outs are independent: an upsell takes a one-click payment
    // but expresses its branch through on_accept, and a checkout takes payment
    // with no offer to accept. Pinning this stops a future edit from quietly
    // merging the two type sets into one "commerce pages" list.
    for (const type of ALL_PAGE_TYPES) {
      const takesPayment = (PAYMENT_BEARING_PAGE_TYPES as readonly string[]).includes(type)
      const hasOffer = (OFFER_BEARING_PAGE_TYPES as readonly string[]).includes(type)
      expect(takesPayment && hasOffer).toBe(false)
    }
    expect(forwardRouteTarget(page({ type: 'upsell', on_accept: 'a', success_url: 's' }))).toBe('a')
    expect(forwardRouteTarget(page({ type: 'upsell', success_url: 's', next_page: 'n' }))).toBe('n')
  })

  test('success_url only routes from a page that takes payment', () => {
    // campaigns-os#234. `success_url` means "after payment succeeds"; a page
    // that takes no payment has no such event, and the field is almost always
    // copied down from the checkout below it. Honouring it on a selector step
    // wired the shopper past the checkout entirely.
    expect(PAYMENT_BEARING_PAGE_TYPES).toEqual(['checkout'])

    // The exact break from the issue, both directions.
    const select = page({ type: 'select', next_page: 'checkout', success_url: 'upsell' })
    expect(forwardRouteTarget(select)).toBe('checkout')
    expect(outgoingEdgeIds(select)).toEqual(['checkout'])

    const checkout = page({ type: 'checkout', next_page: 'checkout', success_url: 'upsell' })
    expect(forwardRouteTarget(checkout)).toBe('upsell')
    expect(outgoingEdgeIds(checkout)).toEqual(['upsell'])

    for (const type of ALL_PAGE_TYPES) {
      const takesPayment = (PAYMENT_BEARING_PAGE_TYPES as readonly string[]).includes(type)
      expect(forwardRouteTarget(page({ type, success_url: 's', next_page: 'n' })))
        .toBe(takesPayment ? 's' : 'n')
      // With success_url alone, a non-payment page has NO forward route at all
      // — the field is inert, never quietly promoted or demoted to next_page.
      expect(forwardRouteTarget(page({ type, success_url: 's' })))
        .toBe(takesPayment ? 's' : null)
      expect(hasForwardRoute(page({ type, success_url: 's' }))).toBe(takesPayment)
      expect(outgoingEdgeIds(page({ type, success_url: 's', on_decline: 'd' })))
        .toEqual(takesPayment ? ['s', 'd'] : ['d'])
    }
  })

  test('a page with no type cannot satisfy a gated field either', () => {
    // `type` is schema-required, so an untyped page is malformed. Falling back
    // to "honour it" would make the malformed case the permissive one — the
    // shape most likely to be a hand-edit or a partial export.
    expect(forwardRouteTarget(page({ success_url: 's', next_page: 'n' }))).toBe('n')
    expect(forwardRouteTarget(page({ type: 42, success_url: 's', next_page: 'n' }))).toBe('n')
    expect(forwardRouteTarget(page({ on_accept: 'a', next_page: 'n' }))).toBe('n')
  })

  test('inapplicableForwardFields reports exactly what routing skipped', () => {
    // The diagnostic reads this instead of re-deriving the type rule, so it
    // cannot tell an author a field is ignored while the resolver still uses it.
    expect(inapplicableForwardFields(page({ type: 'select', success_url: 'u', next_page: 'c' })))
      .toEqual(['success_url'])
    expect(inapplicableForwardFields(page({ type: 'checkout', success_url: 'u' }))).toEqual([])
    // Both gated fields on one ineligible page, reported in precedence order.
    expect(inapplicableForwardFields(page({ type: 'landing', on_accept: 'a', success_url: 'u', next_page: 'c' })))
      .toEqual(['on_accept', 'success_url'])
    expect(inapplicableForwardFields(page({ type: 'upsell', on_accept: 'a' }))).toEqual([])
    // Declared-but-empty is not a skipped field, it is no field.
    expect(inapplicableForwardFields(page({ type: 'select', success_url: '   ' }))).toEqual([])
    expect(inapplicableForwardFields(page({ type: 'select', next_page: 'c' }))).toEqual([])
    expect(inapplicableForwardFields(null)).toEqual([])
  })

  test('a declared-but-empty field is not an edge', () => {
    expect(forwardRouteTarget(page({ next_page: '' }))).toBe(null)
    expect(forwardRouteTarget(page({ next_page: '   ' }))).toBe(null)
    expect(forwardRouteTarget(page({ next_page: null }))).toBe(null)
    // Falling through an empty field to a populated one is the point of the loop.
    expect(forwardRouteTarget(page({ type: 'upsell', on_accept: '', next_page: 'n' }))).toBe('n')
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
    expect(outgoingEdgeIds(page({ type: 'upsell', on_accept: 'a', success_url: 's', next_page: 'n', on_decline: 'd' })))
      .toEqual(['a', 'd'])
    // An upsell whose next_page duplicates on_accept yields one edge, not two —
    // this is the corpus's most common shape.
    expect(outgoingEdgeIds(page({ type: 'upsell', on_accept: 'x', next_page: 'x', on_decline: 'y' }))).toEqual(['x', 'y'])
    expect(outgoingEdgeIds(page({}))).toEqual([])
  })

  test('a shadowed forward field is not an edge — it can never be traversed', () => {
    // Regression: treating every declared field as an edge reported a
    // release-blocking cycle through an unused next_page on a page whose
    // success_url wins at runtime and terminates cleanly.
    expect(outgoingEdgeIds(page({ type: 'checkout', success_url: 'ty', next_page: 'self' }))).toEqual(['ty'])
    expect(outgoingEdgeIds(page({ type: 'upsell', on_accept: 'a', next_page: 'self' }))).toEqual(['a'])
  })

  test('route targets are normalized, so every consumer resolves the same string', () => {
    // Regression: returning the raw value while testing the trimmed one let
    // intake wire " landing " (it trims downstream) while cycle detection's
    // pageMap.get(" landing ") missed, hiding a real loop.
    expect(forwardRouteTarget(page({ next_page: '  landing  ' }))).toBe('landing')
    expect(declineRouteTarget(page({ on_decline: '\tdownsell\n' }))).toBe('downsell')
    // Padding must not split one edge into two.
    expect(outgoingEdgeIds(page({ type: 'upsell', on_accept: 'x', on_decline: ' x ' }))).toEqual(['x'])
  })

  test('every field combination on every page type: wiring and graph analysis agree', () => {
    // The invariant that keeps graph analysis from missing — or inventing —
    // what wiring does. Derived over the power set of ROUTE_FIELDS crossed
    // with every page type, rather than a hand-listed few, so neither adding a
    // routing field nor adding a page type can leave this silently
    // unexercised. Since #234 the page type is part of the answer, so a
    // combination test that fixed one type would miss the carve-out entirely.
    //
    // The assertions are properties, not a restatement of the implementation:
    // the edge set is ordered forward-first, deduplicated, drawn from nothing
    // but the two branches the runtime can take, and every member is a value
    // the page actually declares through a field its type can satisfy.
    const fields = [...ROUTE_FIELDS]
    for (const type of [...ALL_PAGE_TYPES, undefined]) {
      for (let mask = 0; mask < 1 << fields.length; mask += 1) {
        const shape: Record<string, unknown> = type === undefined ? {} : { type }
        fields.forEach((field, index) => {
          // Distinct target per field, so a swap between two fields shows up as
          // a different edge rather than hiding behind a shared value.
          if (mask & (1 << index)) shape[field] = `to-${field}`
        })
        const subject = page(shape)
        const forward = forwardRouteTarget(subject)
        const decline = declineRouteTarget(subject)
        const edges = outgoingEdgeIds(subject)
        const label = `${type ?? 'untyped'}/${mask}`

        // hasForwardRoute never disagrees with the link it reports.
        expect(`${label}:${hasForwardRoute(subject)}`).toBe(`${label}:${forward !== null}`)
        // Forward first, and present whenever there is one.
        expect(`${label}:${edges[0] ?? null}`).toBe(`${label}:${forward ?? decline ?? null}`)
        if (forward !== null) expect(`${label}:${edges.includes(forward)}`).toBe(`${label}:true`)
        if (decline !== null) expect(`${label}:${edges.includes(decline)}`).toBe(`${label}:true`)
        // Nothing else is ever an edge — no shadowed field, no field the page
        // type cannot satisfy, no invented target.
        const branches = new Set([forward, decline].filter((v) => v !== null))
        expect(`${label}:${edges.every((id) => branches.has(id))}`).toBe(`${label}:true`)
        expect(`${label}:${edges.length}`).toBe(`${label}:${branches.size}`)
        // And every field routing skipped is genuinely absent from the graph,
        // unless a live field happens to name the same page.
        for (const skipped of inapplicableForwardFields(subject)) {
          expect(`${label}:${edges.includes(`to-${skipped}`)}`).toBe(`${label}:false`)
        }
      }
    }
  })
})
