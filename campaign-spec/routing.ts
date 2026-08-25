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
 *
 * One narrowing sits on top of that (#234): a field whose meaning the page's
 * type cannot satisfy is not an edge either. `success_url` means "after
 * payment" and `on_accept` means "after accepting this page's offer"; a page
 * with no payment and no offer can satisfy neither, and honouring a
 * copy-pasted one routed real shoppers past the checkout. This is NOT the
 * page-type gate #230 removed — that dropped edges the author declared on
 * tables that disagreed about which fields a type may use. `next_page` stays
 * honoured on every page type. The carve-out is about what two fields MEAN.
 */

import type { Page } from './types.ts'

/**
 * Forward-route fields in specific-before-generic precedence. `on_accept` and
 * `success_url` each name a particular branch (upsell accept, order success);
 * `next_page` is the generic "wherever this page goes next", so it loses to
 * either. Order is load-bearing — `forwardRouteTarget` returns the first match
 * — and is pinned by test, not only by this comment.
 *
 * Precedence is not the whole answer. `on_accept` and `success_url` each carry
 * a meaning only some page types can satisfy, and a field its page cannot
 * satisfy is skipped before precedence is consulted at all. `next_page` is the
 * generic one and stays honoured everywhere. See FORWARD_FIELD_APPLICABILITY.
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
 * through `on_accept`, which has its own applicability rule below.
 * Ratified on campaigns-os#234, 2026-08-25.
 */
export const PAYMENT_BEARING_PAGE_TYPES = Object.freeze(['checkout'] as const)

/**
 * Page types that present an offer the shopper can accept or decline, and are
 * therefore the only types that can satisfy `on_accept`.
 *
 * Same reasoning as PAYMENT_BEARING_PAGE_TYPES, one field over. `on_accept`
 * means "where the shopper goes after accepting the offer on this page". A
 * page that presents no offer has no acceptance to branch on, so the field
 * names an event that cannot happen there.
 *
 * This is not a hypothetical tidy-up. `on_accept` sits at the TOP of
 * FORWARD_ROUTE_FIELDS, so before this rule existed a `select` or `landing`
 * page declaring `next_page: "checkout"` alongside a copy-pasted
 * `on_accept: "upsell"` wired the upsell and routed the shopper straight past
 * payment — the identical break #234 fixed for `success_url`, reachable
 * through the sibling field at higher precedence. Gating one field closed the
 * reported instance; gating both closes the class.
 *
 * `downsell` is included because UpsellRoutingComplete already requires
 * `on_accept` and `on_decline` on exactly `upsell` and `downsell`; leaving
 * `downsell` out would make routing reject a field another rule demands.
 */
export const OFFER_BEARING_PAGE_TYPES = Object.freeze(['upsell', 'downsell'] as const)

/**
 * A forward field whose meaning only some page types can satisfy: the types
 * that can, plus the plain-English meaning that explains why.
 */
export interface ForwardFieldApplicability {
  /** Page types that can satisfy the field. */
  readonly requiredTypes: readonly string[]
  /** What the field means, phrased to complete "it means ...". */
  readonly meaning: string
}

/**
 * Forward fields whose meaning depends on the page type. A field absent from
 * this table applies everywhere.
 *
 * The `meaning` string lives HERE, beside the types, and not in the rule that
 * reports an ignored field. A rule that hand-wrote its own explanation would
 * be a second derivation of this table: correct today, and quietly wrong the
 * first time a second field or a second payment-bearing type joins it.
 */
const FORWARD_FIELD_APPLICABILITY: Readonly<Record<string, ForwardFieldApplicability>> =
  Object.freeze({
    on_accept: Object.freeze({
      requiredTypes: OFFER_BEARING_PAGE_TYPES,
      meaning: 'where the shopper goes after accepting the offer on this page',
    }),
    success_url: Object.freeze({
      requiredTypes: PAYMENT_BEARING_PAGE_TYPES,
      meaning: 'where the shopper goes after payment succeeds',
    }),
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
 * every field except the ones in FORWARD_FIELD_APPLICABILITY.
 */
function fieldAppliesTo(page: Page | null | undefined, field: string): boolean {
  const rule = FORWARD_FIELD_APPLICABILITY[field]
  if (!rule) return true
  const type = (page as Record<string, unknown> | null | undefined)?.type
  if (typeof type !== 'string') return false
  // Trimmed and case-folded on purpose. This is the first thing that ever let
  // `page.type` decide an edge, and normalize() does not touch that field, so
  // an exact match would let `type: "Checkout"` silently drop a real checkout's
  // success_url — the precise failure this module exists to prevent. Compare
  // with RouteTargetResolves, which deliberately does NOT fold case: there
  // folding would PASS a target the build then fails to resolve, so leniency
  // hides a break. Here leniency prevents one.
  return rule.requiredTypes.includes(type.trim().toLowerCase())
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
 * what they meant. `next_page` is honoured on every page type without
 * exception. `on_accept` and `success_url` are honoured only where they mean
 * something — see FORWARD_FIELD_APPLICABILITY.
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
 * What `field` means and which page types can satisfy it, or null when the
 * field applies everywhere. Exported so a diagnostic can explain WHY a field
 * was skipped without hand-writing a second copy of the rule it reports on.
 */
export function describeForwardField(field: string): ForwardFieldApplicability | null {
  return FORWARD_FIELD_APPLICABILITY[field] ?? null
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

/**
 * True when the page RESOLVES to a forward link. Not the same as declaring a
 * forward field: a field the page's type cannot satisfy does not count, so a
 * `select` page carrying only `success_url` reports false. CheckoutHasSuccessUrl
 * reads this, and "can the shopper continue" is the question it means to ask.
 */
export function hasForwardRoute(page: Page | null | undefined): boolean {
  return forwardRouteTarget(page) !== null
}

/**
 * The distinct edges this page can actually traverse: its forward link and its
 * decline branch, deduplicated, forward first. Two kinds of declared field are
 * excluded on purpose: one shadowed by a higher-precedence field (see the
 * module note), and one whose page type cannot satisfy it (see
 * PAYMENT_BEARING_PAGE_TYPES). Neither can be taken at runtime, so following
 * either would invent a cycle rather than find one.
 */
export function outgoingEdgeIds(page: Page | null | undefined): string[] {
  const ids: string[] = []
  for (const value of [forwardRouteTarget(page), declineRouteTarget(page)]) {
    if (value && !ids.includes(value)) ids.push(value)
  }
  return ids
}
