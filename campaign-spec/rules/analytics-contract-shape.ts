/**
 * AnalyticsContractShape — validates the optional top-level `analytics` block
 * when present. The block declares a campaign's analytics/attribution/param
 * contract so doctor + QA can validate against intent (cf. the Chamelo Shield
 * `?reviews=n`-has-no-handler QA finding and the Walla Sound Redtrack param
 * conflict — both are gaps that had no declared contract to check against).
 *
 * The block is fully OPTIONAL — a spec without `analytics` is silent (SDK
 * defaults apply, exactly as today). When `analytics` IS set, this rule catches
 * authoring drift before doctor/QA see it. Every check is `warning` severity:
 * authoring guidance, not a build blocker (matches DesignSourceShape).
 *
 * Checks:
 *   0. If `analytics` is present but not a plain object (a non-plain-object
 *      value: string, array, number, boolean, boxed primitive, class instance,
 *      etc.), warn once and stop — there is no contract shape to inspect.
 *      Genuinely-absent `analytics` stays silent (optional, non-gating).
 *   1. `mode`, if present, is one of auto | manual | disabled.
 *   2. Each provider: `blockedEvents` (when present) is a string[]; an enabled
 *      gtm provider should declare `containerId`, facebook `pixelId`, custom
 *      `endpoint` (warning — the id is what doctor/QA bind to).
 *   3. Each `out_of_band_pixels[]` entry has a non-empty `vendor`.
 *   4. Each `manual_events[]` entry has a non-empty `event`; if it names a
 *      `page`, that page id must exist; a purchase manual event SHOULD name a
 *      page (the first-upsell placement footgun — beacons lost in the
 *      checkout→upsell redirect when placed on checkout).
 *   5. Each `params.content[]` entry has a non-empty `name`; referenced `pages`
 *      must exist (a content param pointing at a missing page is the
 *      `?reviews=n`-with-no-handler gap, inverted).
 *   6. `params.tracking.click_id`, when present, declares both `inbound` and
 *      `maps_to` (half a mapping silently drops the affiliate click id).
 *   7. `params.tracking.preserve` / `utmTransfer.paramsToCopy`, when present,
 *      are string[].
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const VALID_MODES = new Set(['auto', 'manual', 'disabled'])
const PURCHASE_EVENT = /^(?:dl_)?purchase$/i

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function collectPageIds(spec: CampaignSpec): { pageIds: Set<string>; checkoutPageIds: Set<string> } {
  const pageIds = new Set<string>()
  const checkoutPageIds = new Set<string>()
  for (const funnel of spec.funnels ?? []) {
    for (const page of funnel.pages ?? []) {
      if (isNonEmptyString(page.id)) {
        pageIds.add(page.id)
        if (page.type === 'checkout') checkoutPageIds.add(page.id)
      }
    }
  }
  return { pageIds, checkoutPageIds }
}

export const AnalyticsContractShape: Rule = {
  id: 'AnalyticsContractShape',
  severity: 'warning',
  // Dual tag is intentional and matches every sibling pure-spec rule
  // (StoreProfileShape, DesignSourceShape, AssemblyHintsShape, …): the rule is
  // cheap enough for per-keystroke Map Builder (`fast`) AND needs no live
  // deployment (`spec-only`). `fastRules`/`specOnlyRules` are mutually-exclusive
  // FILTERED VIEWS of `allRules` (see rules/index.ts) — a validation pass runs
  // exactly one RuleSet, and `allRules` lists each rule once, so a dual-tagged
  // rule never double-runs. (Surfaced in a downstream consumer-PR review.)
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const analytics = spec.analytics
    // Genuinely-absent analytics stays silent: the block is OPTIONAL and
    // non-gating (SDK defaults apply). But a PRESENT-but-non-object value
    // (`analytics: "auto"`, an array, a primitive) is authoring drift the
    // author wants to hear about — warn, then stop (no shape to inspect).
    if (analytics === undefined || analytics === null) return violations
    // Reject any non-plain-object value: primitives, arrays, and boxed
    // primitives (new String("auto") passes `typeof === 'object'` but is not a
    // plain contract block). Only Object.prototype and null-prototype objects
    // are accepted as valid analytics blocks.
    const analyticsProto = typeof analytics === 'object' ? Object.getPrototypeOf(analytics as object) : null
    if (typeof analytics !== 'object' || Array.isArray(analytics) || (analyticsProto !== Object.prototype && analyticsProto !== null)) {
      const label = Array.isArray(analytics) ? 'an array' : typeof analytics !== 'object' ? typeof analytics : 'a non-plain object'
      violations.push({
        ruleId: 'AnalyticsContractShape',
        severity: 'warning',
        message: 'analytics must be an object (the analytics/attribution contract block); got ' + label + '.',
        path: '/analytics',
        data: { check: 'analytics-shape' },
      })
      return violations
    }

    const warn = (message: string, path: string, check: string, data: Record<string, unknown> = {}) => {
      violations.push({
        ruleId: 'AnalyticsContractShape',
        severity: 'warning',
        message,
        path,
        data: { check, ...data },
      })
    }

    // 1. mode
    if (analytics.mode !== undefined && !VALID_MODES.has(String(analytics.mode))) {
      warn(
        `analytics.mode "${String(analytics.mode)}" is not recognized; expected auto | manual | disabled.`,
        '/analytics/mode',
        'mode-invalid',
        { mode: analytics.mode },
      )
    }

    // 2. providers
    const providers = analytics.providers
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const [kind, provider] of Object.entries(providers)) {
        if (!provider || typeof provider !== 'object') continue
        const base = `/analytics/providers/${kind}`
        // Asymmetry accepted by design (downstream consumer-PR review): a
        // provider with `enabled:false` that still carries containerId/pixelId/
        // endpoint gets no signal. A disabled provider keeping its id is a
        // legitimate, common pattern (staged rollout, env-toggled, kept for
        // reference) — flagging it would be noise, and "off accidentally" is not
        // distinguishable from "off by design" at spec level. We only validate
        // ENABLED providers' binding ids; disabled providers are left alone.
        const enabled = provider.enabled !== false
        if (provider.blockedEvents !== undefined && !isStringArray(provider.blockedEvents)) {
          warn(`analytics.providers.${kind}.blockedEvents must be an array of event-name strings.`, `${base}/blockedEvents`, 'blocked-events-shape', { kind })
        }
        if (enabled && kind === 'gtm' && !isNonEmptyString(provider.containerId)) {
          warn(`analytics.providers.gtm is enabled but has no containerId (e.g. "GTM-…"); doctor/QA bind to it.`, `${base}/containerId`, 'gtm-container-missing', { kind })
        }
        if (enabled && kind === 'facebook' && !isNonEmptyString(provider.pixelId)) {
          warn(`analytics.providers.facebook is enabled but has no pixelId; doctor/QA bind to it.`, `${base}/pixelId`, 'facebook-pixel-missing', { kind })
        }
        if (enabled && kind === 'custom' && !isNonEmptyString(provider.endpoint)) {
          warn(`analytics.providers.custom is enabled but has no endpoint URL.`, `${base}/endpoint`, 'custom-endpoint-missing', { kind })
        }
      }
    }

    const { pageIds, checkoutPageIds } = collectPageIds(spec)

    // 3. out_of_band_pixels
    if (analytics.out_of_band_pixels !== undefined) {
      if (!Array.isArray(analytics.out_of_band_pixels)) {
        warn(`analytics.out_of_band_pixels must be an array.`, '/analytics/out_of_band_pixels', 'oob-not-array')
      } else {
        analytics.out_of_band_pixels.forEach((pixel, i) => {
          if (!pixel || typeof pixel !== 'object' || !isNonEmptyString(pixel.vendor)) {
            warn(`out_of_band_pixels[${i}] is missing a vendor (e.g. "everflow", "triplepixel").`, `/analytics/out_of_band_pixels/${i}/vendor`, 'oob-vendor-missing', { index: i })
          }
        })
      }
    }

    // 4. manual_events
    if (analytics.manual_events !== undefined) {
      if (!Array.isArray(analytics.manual_events)) {
        warn(`analytics.manual_events must be an array.`, '/analytics/manual_events', 'manual-events-not-array')
      } else {
        analytics.manual_events.forEach((evt, i) => {
          const base = `/analytics/manual_events/${i}`
          if (!evt || typeof evt !== 'object' || !isNonEmptyString(evt.event)) {
            warn(`manual_events[${i}] is missing an event name.`, `${base}/event`, 'manual-event-name-missing', { index: i })
            return
          }
          if (isNonEmptyString(evt.page) && !pageIds.has(evt.page)) {
            warn(`manual_events[${i}] (${evt.event}) names page "${evt.page}", which is not a page id in this spec.`, `${base}/page`, 'manual-event-page-unknown', { index: i, page: evt.page })
          }
          if (PURCHASE_EVENT.test(evt.event) && !isNonEmptyString(evt.page)) {
            warn(`manual_events[${i}] is a purchase fire but declares no page. Purchase beacons placed on checkout are lost in the checkout→upsell redirect — declare the page they live on (typically the first upsell).`, `${base}/page`, 'manual-purchase-page-missing', { index: i })
          }
          if (PURCHASE_EVENT.test(evt.event) && isNonEmptyString(evt.page) && checkoutPageIds.has(evt.page)) {
            warn(`manual_events[${i}] is a purchase fire on checkout page "${evt.page}". Purchase beacons on checkout are lost in the checkout→upsell redirect — move the fire to the first upsell page.`, `${base}/page`, 'manual-purchase-on-checkout', { index: i, page: evt.page })
          }
        })
      }
    }

    // 5 + 6. params
    const params = analytics.params
    if (params && typeof params === 'object') {
      const content = params.content
      if (content !== undefined) {
        if (!Array.isArray(content)) {
          warn(`analytics.params.content must be an array.`, '/analytics/params/content', 'content-not-array')
        } else {
          content.forEach((cp, i) => {
            const base = `/analytics/params/content/${i}`
            if (!cp || typeof cp !== 'object' || !isNonEmptyString(cp.name)) {
              warn(`params.content[${i}] is missing a param name.`, `${base}/name`, 'content-name-missing', { index: i })
              return
            }
            if (cp.pages !== undefined && !Array.isArray(cp.pages)) {
              warn(`params.content[${i}] (?${cp.name}) pages must be an array of page-id strings.`, `${base}/pages`, 'content-pages-shape', { index: i, name: cp.name })
            } else if (Array.isArray(cp.pages) && cp.pages.length === 0) {
              // Explicit empty array applies to no page — a silent no-op the
              // author almost certainly didn't intend. Omit `pages` to apply to
              // all pages, or list the ids to scope to.
              warn(`params.content[${i}] (?${cp.name}) has an empty pages array, so it applies to no page. Omit pages to apply to all pages, or list the page ids it should scope to.`, `${base}/pages`, 'content-pages-empty', { index: i, name: cp.name })
            } else {
              for (const pageRef of cp.pages ?? []) {
                if (!pageIds.has(pageRef)) {
                  warn(`params.content[${i}] (?${cp.name}) references page "${pageRef}", which is not a page id in this spec.`, `${base}/pages`, 'content-page-unknown', { index: i, name: cp.name, page: pageRef })
                }
              }
            }
          })
        }
      }
      const tracking = params.tracking
      if (tracking && typeof tracking === 'object') {
        if (tracking.preserve !== undefined && !isStringArray(tracking.preserve)) {
          warn(`analytics.params.tracking.preserve must be an array of param-name strings.`, '/analytics/params/tracking/preserve', 'preserve-shape')
        }
        const clickId = tracking.click_id
        if (clickId && typeof clickId === 'object') {
          if (!isNonEmptyString(clickId.inbound) || !isNonEmptyString(clickId.maps_to)) {
            warn(`analytics.params.tracking.click_id needs both "inbound" (the querystring param) and "maps_to" (the SDK attribution field); half a mapping silently drops the affiliate click id.`, '/analytics/params/tracking/click_id', 'click-id-incomplete')
          }
        }
      }
    }

    // 7. utmTransfer.paramsToCopy
    const utm = analytics.utmTransfer
    if (utm && typeof utm === 'object' && utm.paramsToCopy !== undefined && !isStringArray(utm.paramsToCopy)) {
      warn(`analytics.utmTransfer.paramsToCopy must be an array of param-name strings.`, '/analytics/utmTransfer/paramsToCopy', 'utm-params-shape')
    }

    return violations
  },
}
