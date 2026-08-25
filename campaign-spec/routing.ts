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
 * Everything that asks "where does this page go" now asks here, and every
 * caller models the SAME traversable edges — the forward link the page resolves
 * to, plus its decline branch. They differ only in how many of those they need:
 *
 *   forwardRouteTarget() — the ONE forward link, for wiring (build output, QA
 *                          expectations), which emits a single next URL.
 *   outgoingEdgeIds()    — forward plus decline, for graph analysis (cycle
 *                          detection), which must consider both branches.
 *
 * An earlier revision had outgoingEdgeIds return every DECLARED field on the
 * theory that a safety analysis should over-approximate. That was wrong, and
 * cost real correctness: a page whose `success_url` wins at runtime and
 * terminates cleanly was reported as a release-blocking cycle through an unused,
 * shadowed `next_page`. The runtime can only ever take the forward link or the
 * decline branch, so following a field neither of them selects does not find
 * extra bugs — it invents them. Accuracy is the safety property here, not
 * breadth.
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

/**
 * Every field that can carry a route, for consumers that need to enumerate them
 * (validation, tooling). This is NOT the edge set: which of these a page can
 * actually traverse is decided by forwardRouteTarget/declineRouteTarget, since
 * a lower-precedence forward field is shadowed and never taken.
 */
export const ROUTE_FIELDS = Object.freeze([
  ...FORWARD_ROUTE_FIELDS,
  DECLINE_ROUTE_FIELD,
] as const)

function declared(page: Page | null | undefined, field: string): string | null {
  const value = (page as Record<string, unknown> | null | undefined)?.[field]
  if (typeof value !== 'string') return null
  // Return the NORMALIZED value. Returning the raw one tested trimmed but
  // handed back untrimmed made `success_url: " landing "` wire a live link
  // (intake trims downstream) while cycle detection's pageMap.get(" landing ")
  // missed — reopening the exact blind spot this module exists to close.
  return value.trim() || null
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
 * The distinct edges this page can actually traverse: its forward link and its
 * decline branch, deduplicated, forward first. Shadowed forward fields are
 * excluded on purpose — see the module note.
 */
export function outgoingEdgeIds(page: Page | null | undefined): string[] {
  const ids: string[] = []
  for (const value of [forwardRouteTarget(page), declineRouteTarget(page)]) {
    if (value && !ids.includes(value)) ids.push(value)
  }
  return ids
}
