/**
 * PackageCurrencyPrices — checks each page package's price in every currency
 * the campaign sells in (#714).
 *
 * A package row may carry `prices[]`: one `{ currency, price, price_retail?,
 * price_recurring? }` per currency the Campaigns App has a price for, read
 * from the Campaigns API (`GET /campaigns/?currency=<code>`). That read
 * returns only the packages priced in the requested currency, so a package
 * with no price in a listed currency is missing from the campaign for a
 * shopper paying in it.
 *
 *   1. `prices`, when present, is an array of entries, each with a
 *      three-letter upper-case ISO 4217 `currency` and a non-negative
 *      numeric `price`, and no currency twice.
 *   2. A row with `prices` has an entry for every currency in
 *      campaign.available_currencies and for campaign.currency.
 *
 * A row without `prices` is silent: older Maps and hand-written specs carry
 * the default currency's price only (`price`), and nothing is known about the
 * others. Every finding is a warning, since a missing price is fixed in the
 * Campaigns App, not in the spec.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { isCurrencyCode } from './campaign-currencies.ts'

function isPrice(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false
  if (typeof value === 'string' && value.trim() === '') return false
  const n = Number(value)
  return Number.isFinite(n) && n >= 0
}

// The currencies the campaign sells in: the valid listed codes and a valid
// default. Malformed codes are CampaignCurrencies' to report.
function sellingCurrencies(spec: CampaignSpec): string[] {
  const campaign = spec.campaign
  if (!campaign || typeof campaign !== 'object') return []
  const listed: unknown[] = Array.isArray(campaign.available_currencies) ? campaign.available_currencies : []
  return [...new Set([campaign.currency, ...listed].filter(isCurrencyCode))]
}

export const PackageCurrencyPrices: Rule = {
  id: 'PackageCurrencyPrices',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const selling = sellingCurrencies(spec)

    spec.funnels.forEach((funnel, funnelIdx) => {
      ;(funnel.pages ?? []).forEach((page, pageIdx) => {
        ;(page.packages ?? []).forEach((pkg, pkgIdx) => {
          const prices: unknown = pkg.prices
          if (prices === undefined || prices === null) return
          const path = `/funnels/${funnelIdx}/pages/${pageIdx}/packages/${pkgIdx}/prices`
          const name = pkg.name || pkg.ref_id
          const label = `"${page.label || page.id}" — Package "${name}"`
          if (!Array.isArray(prices)) {
            violations.push({
              ruleId: 'PackageCurrencyPrices',
              severity: 'warning',
              message: `${label}: prices must be an array of { currency, price } entries.`,
              path,
              data: { check: 'prices_shape', pageId: page.id, ref_id: pkg.ref_id, received: prices },
            })
            return
          }

          const seen = new Set<string>()
          prices.forEach((entry: unknown, index: number) => {
            const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null
            const currency = row?.currency
            if (!row || !isCurrencyCode(currency) || !isPrice(row.price)) {
              violations.push({
                ruleId: 'PackageCurrencyPrices',
                severity: 'warning',
                message: `${label}: prices[${index}] needs a three-letter upper-case ISO 4217 currency and a non-negative price.`,
                path: `${path}/${index}`,
                data: { check: 'price_entry_shape', pageId: page.id, ref_id: pkg.ref_id, received: entry },
              })
            } else if (seen.has(currency)) {
              violations.push({
                ruleId: 'PackageCurrencyPrices',
                severity: 'warning',
                message: `${label}: prices lists ${currency} more than once.`,
                path: `${path}/${index}`,
                data: { check: 'price_currency_repeated', pageId: page.id, ref_id: pkg.ref_id, currency },
              })
            }
            if (isCurrencyCode(currency)) seen.add(currency)
          })

          const missing = selling.filter((code) => !seen.has(code))
          if (missing.length > 0) {
            const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} or ${missing[missing.length - 1]}`
            violations.push({
              ruleId: 'PackageCurrencyPrices',
              severity: 'warning',
              message: `${label} has no ${list} price, so the campaign leaves it out in ${missing.length === 1 ? 'that currency' : 'those currencies'}. Add the price in the Campaigns App, then refresh the Map.`,
              path,
              data: { check: 'price_currency_missing', pageId: page.id, ref_id: pkg.ref_id, missing },
            })
          }
        })
      })
    })

    return violations
  },
}
