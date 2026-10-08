/**
 * checkout-flow — which page takes payment, and the pages that lead to it.
 *
 * From CampaignSpec v5 a page's `type` says which page takes payment
 * (campaigns-os#641). Three types carry the shopper into a payment:
 *
 *   | Type            | Checkout form | Places order | Forward field |
 *   |-----------------|---------------|--------------|---------------|
 *   | `select`        | no            | no           | `next_page`   |
 *   | `checkout_step` | yes           | no           | `next_page`   |
 *   | `checkout`      | yes           | yes          | `success_url` |
 *
 * All three render as SDK page type `checkout`. A campaign may hold several
 * Checkouts (one per split-test path); each path reaches exactly one.
 *
 * Every consumer that asks "which page on this path takes payment" asks here,
 * never "the first page typed checkout". The one place the payment page is
 * worked out from links rather than read from `type` is `upgradeCampaignSpec`,
 * which retypes a v4 spec on read.
 */

import type { CampaignSpec, Funnel, Page } from './types.ts'
import { forwardRouteTarget, outgoingEdgeIds } from './routing.ts'

/** The CampaignSpec lineage this module writes when it upgrades a v4 spec. */
export const CURRENT_SCHEMA_VERSION = '5.0' as const

/** The page that takes payment. */
export const PAYMENT_PAGE_TYPE = 'checkout' as const

/** A checkout form that collects details and moves on without placing an order. */
export const CHECKOUT_STEP_PAGE_TYPE = 'checkout_step' as const

/** Pages that lead into a Checkout without taking payment themselves. */
export const PRE_PAYMENT_PAGE_TYPES = Object.freeze(['select', 'checkout_step'] as const)

/**
 * Every page type the SDK renders as `checkout`: the pre-payment pages and the
 * Checkout itself. Payment-page features (exit intent, promo code input,
 * checkout theme gates) apply to all of them.
 */
export const CHECKOUT_FLOW_PAGE_TYPES = Object.freeze(['select', 'checkout_step', 'checkout'] as const)

/** Where a Checkout may send the shopper once payment succeeds. */
export const POST_PAYMENT_PAGE_TYPES = Object.freeze(['upsell', 'downsell', 'thankyou'] as const)

/** Post-purchase offer pages: reaching one means an order was already placed. */
export const POST_PURCHASE_OFFER_PAGE_TYPES = Object.freeze(['upsell', 'downsell'] as const)

function typeOf(page: Page | null | undefined): string {
  const type = (page as Record<string, unknown> | null | undefined)?.type
  return typeof type === 'string' ? type.trim().toLowerCase() : ''
}

export function isPaymentPage(page: Page | null | undefined): boolean {
  return typeOf(page) === PAYMENT_PAGE_TYPE
}

export function isCheckoutStepPage(page: Page | null | undefined): boolean {
  return typeOf(page) === CHECKOUT_STEP_PAGE_TYPE
}

export function isPrePaymentPage(page: Page | null | undefined): boolean {
  return (PRE_PAYMENT_PAGE_TYPES as readonly string[]).includes(typeOf(page))
}

export function isCheckoutFlowPage(page: Page | null | undefined): boolean {
  return (CHECKOUT_FLOW_PAGE_TYPES as readonly string[]).includes(typeOf(page))
}

/**
 * Strip surrounding slashes and a `.html` suffix so a route target, a page ID
 * and a `page_url` compare on equal terms. The corpus writes targets in all
 * three dialects (`shipping`, `shipping.html`, `/shipping/`). Case is kept, as
 * in RouteTargetResolves: intake's lookup is case-sensitive.
 */
function routeish(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed.toLowerCase().endsWith('.html') ? trimmed.slice(0, -'.html'.length) : trimmed
}

/**
 * The page a route target names within `pages`, or null when it names none
 * (an absolute URL, a fragment, a route outside this funnel, or a typo that
 * RouteTargetResolves reports). Page IDs win over `page_url` matches.
 */
export function resolveRouteTargetPage(pages: readonly Page[], target: string | null | undefined): Page | null {
  if (typeof target !== 'string' || !target.trim()) return null
  const raw = target.trim()
  if (raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  const key = routeish(raw)
  if (!key) return null
  for (const page of pages) {
    if (page?.id === raw || (typeof page?.id === 'string' && routeish(page.id) === key)) return page
  }
  for (const page of pages) {
    const route = page?.page_url
    if (typeof route === 'string' && route.trim() && routeish(route) === key) return page
  }
  return null
}

/** The page this page's forward link resolves to, within `pages`. */
export function forwardTargetPage(pages: readonly Page[], page: Page | null | undefined): Page | null {
  return resolveRouteTargetPage(pages, forwardRouteTarget(page))
}

function enabledPages(funnel: Funnel | null | undefined): Page[] {
  return (funnel?.pages ?? []).filter(
    (page) => page && (page as Record<string, unknown>).enabled !== false,
  )
}

/**
 * The pages from `start` forward to the Checkout that takes payment, both
 * included, following each page's forward link. Null when the walk leaves the
 * funnel, loops, ends, or meets a post-payment page before any Checkout.
 *
 * `start` may itself be the Checkout (the path is then that page alone).
 */
export function checkoutPathFrom(pages: readonly Page[], start: Page | null | undefined): Page[] | null {
  const path: Page[] = []
  const seen = new Set<Page>()
  let page: Page | null | undefined = start
  while (page && !seen.has(page)) {
    seen.add(page)
    path.push(page)
    if (isPaymentPage(page)) return path
    if ((POST_PAYMENT_PAGE_TYPES as readonly string[]).includes(typeOf(page))) return null
    page = forwardTargetPage(pages, page)
  }
  return null
}

/** The Checkout reached by walking forward from `start`, or null. */
export function paymentPageFrom(pages: readonly Page[], start: Page | null | undefined): Page | null {
  const path = checkoutPathFrom(pages, start)
  return path ? path[path.length - 1] : null
}

/**
 * The funnel's entry pages: those flagged `is_entry`, or when none is flagged,
 * those no other page routes to apart from orphaned upsell, downsell and
 * thank-you pages (falling back to the lowest `order` when that leaves none). Order and names are never consulted beyond that
 * last-resort tie-break.
 */
export function entryPages(funnel: Funnel | null | undefined): Page[] {
  const pages = enabledPages(funnel)
  const flagged = pages.filter((page) => page.is_entry === true)
  if (flagged.length) return flagged
  const targeted = new Set<Page>()
  for (const page of pages) {
    for (const target of outgoingEdgeIds(page)) {
      const hit = resolveRouteTargetPage(pages, target)
      if (hit && hit !== page) targeted.add(hit)
    }
  }
  // A post-payment page nothing routes to is an orphan, not where a shopper
  // starts: no unflagged journey begins on an upsell or a receipt.
  const roots = pages.filter(
    (page) => !targeted.has(page) && !(POST_PAYMENT_PAGE_TYPES as readonly string[]).includes(typeOf(page)),
  )
  if (roots.length) return roots
  const first = [...pages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]
  return first ? [first] : []
}

/**
 * The Checkout on the path through `page`'s funnel that starts at an entry
 * page, for callers that hold a funnel rather than a starting page. When the
 * funnel has several entry paths with different Checkouts, returns the first
 * entry's; use `paymentPagesForFunnel` to see all of them.
 */
export function paymentPageForFunnel(funnel: Funnel | null | undefined): Page | null {
  return paymentPagesForFunnel(funnel)[0] ?? null
}

/** Every distinct Checkout reached from the funnel's entry pages, in entry order. */
export function paymentPagesForFunnel(funnel: Funnel | null | undefined): Page[] {
  const pages = enabledPages(funnel)
  const out: Page[] = []
  for (const entry of entryPages(funnel)) {
    const checkout = paymentPageFrom(pages, entry)
    if (checkout && !out.includes(checkout)) out.push(checkout)
  }
  // A funnel whose entry is a landing page that links into checkout through a
  // CTA (no forward field) still has a Checkout; fall back to every Checkout
  // the funnel declares so a lookup never reports "none" for a real one.
  if (!out.length) for (const page of pages) if (isPaymentPage(page)) out.push(page)
  return out
}

/**
 * Upgrade a CampaignSpec to the v5 page vocabulary. Returns a new object; the
 * input is never mutated, so callers that hash or persist the raw bytes keep
 * the bytes they read.
 *
 * v5 specs pass through unchanged. For any other lineage, each `checkout` page
 * whose resolved forward target is also a `checkout` is retyped
 * `checkout_step` — the v4 `checkout → checkout` chain was the only way to say
 * "this form moves on without taking payment". A supported v4 `schema_version`
 * becomes `5.0`; a missing or unsupported one is left for SchemaVersion to
 * report.
 */
export function upgradeCampaignSpec<T>(input: T): T {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return input
  const spec = input as unknown as CampaignSpec & Record<string, unknown>
  const version = typeof spec.schema_version === 'string' ? spec.schema_version.trim() : ''
  if (version.startsWith('5.') || version === '5') return input
  if (!Array.isArray(spec.funnels)) return input

  let changed = false
  const funnels = spec.funnels.map((funnel) => {
    if (!funnel || !Array.isArray(funnel.pages)) return funnel
    const pages = funnel.pages
    const retype = new Set<Page>()
    for (const page of pages) {
      if (!isPaymentPage(page)) continue
      if (isPaymentPage(forwardTargetPage(pages, page))) retype.add(page)
    }
    if (!retype.size) return funnel
    changed = true
    return {
      ...funnel,
      pages: pages.map((page) => (retype.has(page) ? { ...page, type: CHECKOUT_STEP_PAGE_TYPE } : page)),
    }
  })

  const upgradeVersion = version === '4.2' || version === '4.3'
  if (!changed && !upgradeVersion) return input
  const out: Record<string, unknown> = { ...spec, funnels }
  if (upgradeVersion) out.schema_version = CURRENT_SCHEMA_VERSION
  return out as unknown as T
}
