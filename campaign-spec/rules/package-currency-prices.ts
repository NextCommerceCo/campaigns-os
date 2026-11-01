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
 * A row without `prices` (absent or null) is silent: older Maps and
 * hand-written specs carry the default currency's price only (`price`), and
 * nothing is known about the others. Every finding is a warning, since a
 * missing price is fixed in the Campaigns App, not in the spec.
 *
 * The selling currencies are the spec's own `campaign.currency` and
 * `campaign.available_currencies`. The Campaigns App API's
 * `additional_currencies` is not a CampaignSpec field (CampaignCurrencies), so
 * it is not read here either.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'
import { isCurrencyCode } from './campaign-currencies.ts'

// A non-negative amount: a finite number, or a plain decimal string ("49.99").
// Hex, binary and exponent strings ("0x10", "1e3") are not prices.
function isPrice(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
}

// An optional amount: absent, null, or a price.
function isOptionalPrice(value: unknown): boolean {
  return value === undefined || value === null || isPrice(value)
}

// What is wrong with one prices[] entry, or null when it is well formed.
function entryDefect(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not a { currency, price } object'
  const row = entry as Record<string, unknown>
  const defects: string[] = []
  if (!isCurrencyCode(row.currency)) defects.push('a three-letter upper-case ISO 4217 currency')
  if (!isPrice(row.price)) defects.push('a non-negative decimal price')
  for (const field of ['price_retail', 'price_recurring'] as const) {
    if (!isOptionalPrice(row[field])) defects.push(`a non-negative decimal ${field} (or none)`)
  }
  return defects.length ? `needs ${defects.join(' and ')}` : null
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
            const currency = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).currency : undefined
            const defect = entryDefect(entry)
            // A malformed entry with a valid currency still counts that
            // currency as listed: the entry's own finding names the fix, and a
            // second "has no EUR price" finding would report it twice.
            if (defect) {
              violations.push({
                ruleId: 'PackageCurrencyPrices',
                severity: 'warning',
                message: `${label}: prices[${index}] ${defect}.`,
                path: `${path}/${index}`,
                data: { check: 'price_entry_shape', pageId: page.id, ref_id: pkg.ref_id, received: entry },
              })
            } else if (isCurrencyCode(currency) && seen.has(currency)) {
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
