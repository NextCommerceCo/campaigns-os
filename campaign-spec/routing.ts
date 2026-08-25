/**
 * routing — the single source of truth for a page's outgoing edges.
 *
 * A campaign is a free-form headless shopping journey. It usually runs
 * landing → checkout → upsells → receipt, but nothing requires that, and the
 * routing fields a page declares are the author's statement of where the
 * shopper goes next. Before this module those fields were interpreted by three
 * independent page-type tables — source intake, cycle detection, and the QA
 * topology extractor — which disagreed with each other and silently discarded
 * any edge declared outside their own table.
 *
 * Everything that asks "where does this page go" now asks here. The two
 * questions callers actually have are deliberately separate functions, because
 * they have opposite failure costs:
 *
 *   outgoingEdgeIds()   — EVERY declared edge. For safety analyses (cycle
 *                         detection), where a missed edge is a missed
 *                         release-blocking cycle, so over-approximating is
 *                         correct.
 *   forwardRouteTarget() — the ONE forward link. For wiring (build output, QA
 *                         expectations), where over-approximating would invent
 *                         a route the author never declared.
 *
 * That difference is the whole reason two functions exist rather than one; it
 * is not an accident to be tidied away later. What must never differ again is
 * the *field set* they read, which is why it lives here once.
 */

import type { Page } from './types.ts'

/**
 * Forward-route fields in specific-before-generic precedence. `on_accept` and
 * `success_url` each name a particular branch (upsell accept, order success);
 * `next_page` is the generic "wherever this page goes next", so it loses to
 * either. Order is load-bearing — `forwardRouteTarget` returns the first match
 * — and is pinned by test, not only by this comment.
 */
export const FORWARD_ROUTE_FIELDS = Object.freeze([
  'on_accept',
  'success_url',
  'next_page',
] as const)

/** The decline branch. Separate because it is a second edge, not a fallback. */
export const DECLINE_ROUTE_FIELD = 'on_decline' as const

/** Every field that can carry an outgoing edge, in no particular precedence. */
export const ROUTE_FIELDS = Object.freeze([
  ...FORWARD_ROUTE_FIELDS,
  DECLINE_ROUTE_FIELD,
] as const)

function declared(page: Page | null | undefined, field: string): string | null {
  const value = (page as Record<string, unknown> | null | undefined)?.[field]
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * The single forward link, or null when the page declares none. Type-agnostic
 * by design: a journey that routes its checkout through `next_page`, or
 * continues past a thank-you page into a second offer sequence, is unusual but
 * entirely legal, and the author has said exactly what they meant.
 */
export function forwardRouteTarget(page: Page | null | undefined): string | null {
  for (const field of FORWARD_ROUTE_FIELDS) {
    const value = declared(page, field)
    if (value) return value
  }
  return null
}

/** The decline-branch target, wherever it is declared. */
export function declineRouteTarget(page: Page | null | undefined): string | null {
  return declared(page, DECLINE_ROUTE_FIELD)
}

/** True when the page declares any forward route at all. */
export function hasForwardRoute(page: Page | null | undefined): boolean {
  return forwardRouteTarget(page) !== null
}

/**
 * Every distinct outgoing edge this page declares, deduplicated and in
 * ROUTE_FIELDS order. Over-approximating on purpose — see the module note.
 */
export function outgoingEdgeIds(page: Page | null | undefined): string[] {
  const ids: string[] = []
  for (const field of ROUTE_FIELDS) {
    const value = declared(page, field)
    if (value && !ids.includes(value)) ids.push(value)
  }
  return ids
}
