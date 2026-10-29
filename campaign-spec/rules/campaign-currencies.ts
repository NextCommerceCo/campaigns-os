/**
 * CampaignCurrencies — checks the campaign's default currency and its list of
 * selling currencies (#714).
 *
 *   1. campaign.currency, when set, is a three-letter upper-case ISO 4217
 *      code (error). A lower-case or made-up code can make Campaign Cart
 *      fall back to a cached USD campaign, so the page shows the wrong prices
 *      and nothing else complains.
 *   2. campaign.available_currencies, when set, is an array whose every entry
 *      is such a code (error). A `{ code, label }` object, the Campaigns API's
 *      shape, is reported with the code it should be written as: Map Builder
 *      writes code strings, and so should a hand-authored spec.
 *   3. campaign.currency is one of campaign.available_currencies when that
 *      list is non-empty (warning). An empty list states nothing and is
 *      silent, since Map Builder exports [] for a campaign with no list.
 *
 * The spec owns `campaign.available_currencies`: every currency the campaign
 * sells in, the default included. The Campaigns App API's
 * `additional_currencies` is the same list without the default; it is not a
 * CampaignSpec field, and this rule does not read it.
 *
 * An absent, null or empty currency is silent here: a missing default is a
 * draft state, not a malformed code.
 *
 * The ISO list is `Intl.supportedValuesOf('currency')`. A runtime without it
 * (very old browsers) gets the shape check only.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const CODE_SHAPE = /^[A-Z]{3}$/

let isoCodes: Set<string> | null | undefined

function knownIsoCodes(): Set<string> | null {
  if (isoCodes === undefined) {
    const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    isoCodes = typeof supportedValuesOf === 'function' ? new Set(supportedValuesOf('currency')) : null
  }
  return isoCodes
}

function isCurrencyCode(value: unknown): value is string {
  if (typeof value !== 'string' || !CODE_SHAPE.test(value)) return false
  const known = knownIsoCodes()
  return known === null || known.has(value)
}

// The code a malformed value most likely meant: the upper-cased string, or an
// object's `code`, when that is a valid code. Null when nothing obvious fits.
function suggestedCode(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { code?: unknown }).code
        : undefined
  if (typeof raw !== 'string') return null
  const candidate = raw.trim().toUpperCase()
  return isCurrencyCode(candidate) ? candidate : null
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? String(value)
}

function codeMessage(field: string, value: unknown): string {
  const suggestion = suggestedCode(value)
  const isObject = value !== null && typeof value === 'object'
  const base = isObject
    ? `${field} is an object; CampaignSpec lists currencies as three-letter ISO 4217 code strings.`
    : `${field} ${quoted(value)} is not a three-letter upper-case ISO 4217 currency code.`
  return suggestion ? `${base} Write it as "${suggestion}".` : base
}

export const CampaignCurrencies: Rule = {
  id: 'CampaignCurrencies',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const campaign = spec.campaign
    if (!campaign || typeof campaign !== 'object') return violations

    const currency: unknown = campaign.currency
    const currencyValid = !isAbsent(currency) && isCurrencyCode(currency)
    if (!isAbsent(currency) && !currencyValid) {
      violations.push({
        ruleId: 'CampaignCurrencies',
        severity: 'error',
        message: codeMessage('campaign.currency', currency),
        path: '/campaign/currency',
        data: { check: 'currency_code', received: currency, suggestion: suggestedCode(currency) },
      })
    }

    const available: unknown = campaign.available_currencies
    if (available === undefined || available === null) return violations
    if (!Array.isArray(available)) {
      violations.push({
        ruleId: 'CampaignCurrencies',
        severity: 'error',
        message: 'campaign.available_currencies must be an array of three-letter ISO 4217 currency codes, the default currency included.',
        path: '/campaign/available_currencies',
        data: { check: 'available_currencies_shape', received: available },
      })
      return violations
    }

    available.forEach((entry: unknown, index: number) => {
      if (isCurrencyCode(entry)) return
      violations.push({
        ruleId: 'CampaignCurrencies',
        severity: 'error',
        message: codeMessage(`campaign.available_currencies[${index}]`, entry),
        path: `/campaign/available_currencies/${index}`,
        data: { check: 'available_currency_code', received: entry, suggestion: suggestedCode(entry) },
      })
    })

    // Membership compares what each entry most likely means, so a list entry
    // already reported as "usd" does not also make "USD" read as missing.
    if (currencyValid && available.length > 0) {
      const listed = new Set(available.map((entry) => (isCurrencyCode(entry) ? entry : suggestedCode(entry))))
      if (!listed.has(currency as string)) {
        violations.push({
          ruleId: 'CampaignCurrencies',
          severity: 'warning',
          message: `campaign.currency "${currency}" is not in campaign.available_currencies. List every currency the campaign sells in, the default included, or change the default.`,
          path: '/campaign/available_currencies',
          data: { check: 'currency_not_available', currency, available },
        })
      }
    }

    return violations
  },
}
