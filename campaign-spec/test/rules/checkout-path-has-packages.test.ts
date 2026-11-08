import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from '../harness.ts'
import { CheckoutPathHasPackages } from '../../rules/checkout-path-has-packages.ts'
import { isMainCartPackage, sellsMainCartPackage } from '../../checkout-flow.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec, Page } from '../../types.ts'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

function spec(pages: Page[], extra: Record<string, unknown> = {}): CampaignSpec {
  return { schema_version: '5.0', ...extra, funnels: [{ id: 'f', pages }] } as unknown as CampaignSpec
}

const MAIN = { ref_id: 10, qty: 1 }
const UPSELL = { id: 'up', type: 'upsell', on_accept: 'ty', on_decline: 'ty', packages: [{ ref_id: 30, qty: 1, is_upsell: true }] } as Page
const THANKS = { id: 'ty', type: 'thankyou' } as Page

describe('main-cart entry contract', () => {
  test('an entry with neither is_upsell nor is_order_bump is main-cart', () => {
    expect(isMainCartPackage({ ref_id: 1 })).toBe(true)
    expect(isMainCartPackage({ ref_id: 1, is_upsell: false, is_order_bump: false })).toBe(true)
  })

  test('is_upsell or is_order_bump marks a bump; default_selected never changes the role', () => {
    expect(isMainCartPackage({ ref_id: 1, is_order_bump: true })).toBe(false)
    expect(isMainCartPackage({ ref_id: 1, is_upsell: true })).toBe(false)
    expect(isMainCartPackage({ ref_id: 1, is_upsell: true, default_selected: true })).toBe(false)
    expect(isMainCartPackage({ ref_id: 1, default_selected: true })).toBe(true)
    expect(isMainCartPackage({ ref_id: 1, default_selected: false })).toBe(true)
  })

  test('post-payment pages never sell the main cart', () => {
    for (const type of ['upsell', 'downsell', 'thankyou']) {
      expect(sellsMainCartPackage({ id: 'p', type, packages: [MAIN] } as unknown as Page)).toBe(false)
    }
    for (const type of ['presell', 'landing', 'select', 'checkout_step', 'checkout']) {
      expect(sellsMainCartPackage({ id: 'p', type, packages: [MAIN] } as unknown as Page)).toBe(true)
    }
  })
})

describe('CheckoutPathHasPackages', () => {
  test('flags a Checkout reached with only bump rows on the path (fixture)', () => {
    const fixture = fixtureByName('checkout-path-missing-packages')
    const actual = CheckoutPathHasPackages.check(normalize(fixture.spec))
    expect(actual).toHaveLength(1)
    expect(actual).toEqual(fixture.expected.violations.filter((v) => v.ruleId === 'CheckoutPathHasPackages'))
  })

  test('passes a select page that carries the packages ahead of an empty Checkout (fixture)', () => {
    const fixture = fixtureByName('select-sells-checkout-empty')
    expect(CheckoutPathHasPackages.check(normalize(fixture.spec))).toEqual([])
  })

  test('passes a Checkout that carries its own main-cart entry', () => {
    const pages = [{ id: 'pay', type: 'checkout', success_url: 'up', packages: [MAIN, { ref_id: 17, is_order_bump: true }] }, UPSELL, THANKS] as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toEqual([])
  })

  test('passes a landing page with package cards ahead of an empty Checkout (shop-single-step shape)', () => {
    const pages = [
      { id: 'home', type: 'landing', next_page: 'pay', packages: [MAIN, { ref_id: 10, qty: 2 }] },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      THANKS,
    ] as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toEqual([])
  })

  test('passes when a checkout step sells ahead of the Checkout', () => {
    const pages = [
      { id: 'info', type: 'checkout_step', next_page: 'ship', packages: [MAIN] },
      { id: 'ship', type: 'checkout_step', next_page: 'billing' },
      { id: 'billing', type: 'checkout', success_url: 'ty' },
      THANKS,
    ] as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toEqual([])
  })

  test('flags a Checkout whose only entries are is_upsell bumps', () => {
    const pages = [
      { id: 'pay', type: 'checkout', success_url: 'up', packages: [{ ref_id: 17, is_upsell: true, default_selected: true }] },
      UPSELL,
      THANKS,
    ] as Page[]
    const [violation, ...rest] = CheckoutPathHasPackages.check(spec(pages))
    expect(rest).toHaveLength(0)
    expect(violation.severity).toBe('error')
    expect(violation.path).toBe('/funnels/0/pages/0')
    expect(violation.data).toEqual({ pageId: 'pay', entryPageId: 'pay', isPartialScope: false })
  })

  test('upsell packages after the Checkout do not count', () => {
    const pages = [{ id: 'l', type: 'landing', next_page: 'pay' }, { id: 'pay', type: 'checkout', success_url: 'up' }, UPSELL, THANKS] as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toHaveLength(1)
  })

  test('counts per path: only the entry whose path sells nothing is named', () => {
    const pages = [
      { id: 'a', type: 'select', is_entry: true, next_page: 'pay', packages: [MAIN] },
      { id: 'b', type: 'landing', is_entry: true, next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      THANKS,
    ] as Page[]
    const violations = CheckoutPathHasPackages.check(spec(pages))
    expect(violations.map((v) => v.data?.entryPageId)).toEqual(['b'])
  })

  test('reads routing, never page order or names', () => {
    // Declared out of journey order, with names that suggest the opposite
    // roles: the page called "checkout" is the landing, "landing" pays.
    const pages = [
      { id: 'landing', type: 'checkout', order: 1, success_url: 'ty' },
      THANKS,
      { id: 'checkout', type: 'presell', order: 3, next_page: 'landing', packages: [MAIN] },
    ] as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toEqual([])
  })

  test('follows the decline branch as well as the forward link', () => {
    const pages = [
      { id: 'pre', type: 'presell', next_page: 'sell', on_decline: 'pay' },
      { id: 'sell', type: 'landing', next_page: 'pay', packages: [MAIN] },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      THANKS,
    ] as Page[]
    const violations = CheckoutPathHasPackages.check(spec(pages))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.entryPageId).toBe('pre')
  })

  test('a disabled page sells nothing', () => {
    const pages = [
      { id: 'l', type: 'landing', next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      { id: 'old', type: 'landing', enabled: false, next_page: 'pay', packages: [MAIN] },
      THANKS,
    ] as unknown as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toHaveLength(1)
  })

  test('is a warning under build_scope.mode partial', () => {
    const pages = [{ id: 'pay', type: 'checkout', success_url: 'ty' }, THANKS] as Page[]
    const [violation] = CheckoutPathHasPackages.check(spec(pages, { build_scope: { mode: 'partial' } }))
    expect(violation.severity).toBe('warning')
    expect(violation.data?.isPartialScope).toBe(true)
  })

  test('says nothing about a funnel with no Checkout', () => {
    const pages = [{ id: 'l', type: 'landing', next_page: 'ty' }, THANKS] as Page[]
    expect(CheckoutPathHasPackages.check(spec(pages))).toEqual([])
  })
})

// Reachability proof (#206 acceptance 4, ON-2 failure mode #5): the rule
// passes the canonical CampaignSpec fixture of every certified family before
// it blocks anything. Certified = a catalog family with a brand contract, the
// same set src/doctor-certified-family-reachability.test.mjs reads.
describe('CheckoutPathHasPackages reachability on certified families', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'contracts', 'commerce-surface-catalog.json'), 'utf8'))
  const certified = Object.keys(catalog.families || {})
    .filter((family) => existsSync(join(root, 'contracts', `template-brand-contract.${family}.v0.json`)))
    .sort()

  test('the certified set is the one the catalog names', () => {
    expect(certified.length >= 8).toBe(true)
  })

  for (const family of certified) {
    const fixtures: string[] = catalog.families[family]?.agentContract?.fixtures ?? []
    test(`${family}: canonical fixture has zero findings`, () => {
      expect(fixtures.length >= 1).toBe(true)
      for (const relative of fixtures) {
        const canonical = JSON.parse(readFileSync(join(root, relative), 'utf8')) as CampaignSpec
        expect(CheckoutPathHasPackages.check(normalize(canonical))).toEqual([])
      }
    })
  }
})
