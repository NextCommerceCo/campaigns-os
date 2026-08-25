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
 *
 * Precedence is not the whole answer: `success_url` also has to be a field the
 * page can satisfy at all. See PAYMENT_BEARING_PAGE_TYPES.
 */
export const FORWARD_ROUTE_FIELDS = Object.freeze([
  'on_accept',
  'success_url',
  'next_page',
] as const)

/** The decline branch. Separate because it is a second edge, not a fallback. */
export const DECLINE_ROUTE_FIELD = 'on_decline' as const

/**
 * Page types that take payment, and are therefore the only types that can
 * satisfy `success_url`.
 *
 * `success_url` means "where the shopper goes after payment succeeds". Only a
 * page that takes payment has a payment to succeed, so on any other type the
 * field names an event that cannot happen there. In practice it is a
 * copy-paste down from the checkout below it, and honouring it routes the
 * shopper straight past the step they were meant to reach: a `select` page
 * declaring `next_page: checkout` alongside `success_url: upsell` wired the
 * upsell and skipped payment entirely.
 *
 * This is NOT the page-type routing gate #230 removed. That gate DROPPED edges
 * an author had declared, on tables that disagreed about which fields a type
 * was allowed to use. `next_page` and `on_accept` stay type-agnostic — every
 * page may declare them and every declaration is honoured. The carve-out here
 * is about one field's MEANING: reading a payment-shaped field on a page with
 * no payment is not respecting the author's intent, it is inventing one.
 *
 * Membership is deliberately narrow. The three-step shop family types its
 * `information` / `shipping` / `billing` pages as `checkout`, so they are
 * already covered; no certified family carries a second payment-bearing type.
 * An `upsell` takes a one-click payment but expresses its post-purchase branch
 * through `on_accept`, which is not gated here — see #234 sub-decision 3.
 * Ratified on campaigns-os#234, 2026-08-25.
 */
export const PAYMENT_BEARING_PAGE_TYPES = Object.freeze(['checkout'] as const)

/**
 * Forward fields whose meaning depends on the page type, mapped to the types
 * that can satisfy them. A field absent from this table applies everywhere.
 * Kept as data so `forwardRouteTarget` and the diagnostic that reports an
 * ignored field read from ONE definition and cannot drift apart.
 */
const FORWARD_FIELD_REQUIRED_TYPES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    success_url: PAYMENT_BEARING_PAGE_TYPES,
  })

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

/**
 * Whether `field` carries a meaning this page can satisfy. Type-agnostic for
 * every field except the ones in FORWARD_FIELD_REQUIRED_TYPES.
 */
function fieldAppliesTo(page: Page | null | undefined, field: string): boolean {
  const required = FORWARD_FIELD_REQUIRED_TYPES[field]
  if (!required) return true
  const type = (page as Record<string, unknown> | null | undefined)?.type
  return typeof type === 'string' && required.includes(type)
}

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
 * in the direction that matters: a journey that routes its checkout through
 * `next_page`, or continues past a thank-you page into a second offer
 * sequence, is unusual but entirely legal, and the author has said exactly
 * what they meant. The one exception is `success_url`, which a page that takes
 * no payment cannot satisfy — see PAYMENT_BEARING_PAGE_TYPES.
 */
export function forwardRouteTarget(page: Page | null | undefined): string | null {
  for (const field of FORWARD_ROUTE_FIELDS) {
    if (!fieldAppliesTo(page, field)) continue
    const value = declared(page, field)
    if (value) return value
  }
  return null
}

/**
 * Forward fields this page declares with a real target but which its type
 * cannot satisfy, so routing skips them. Empty for almost every page; the
 * diagnostic that teaches authors about a stray `success_url` reads it, rather
 * than re-deriving the type rule and drifting from the resolver.
 */
export function inapplicableForwardFields(page: Page | null | undefined): string[] {
  return FORWARD_ROUTE_FIELDS.filter(
    (field) => !fieldAppliesTo(page, field) && declared(page, field) !== null,
  )
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
