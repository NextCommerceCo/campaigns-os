import { describe, expect, test } from '../harness.ts'
import { CheckoutForwardTarget } from '../../rules/checkout-forward-target.ts'
import { PrePaymentForwardTarget } from '../../rules/pre-payment-forward-target.ts'
import { CheckoutStepReachesCheckout } from '../../rules/checkout-step-reaches-checkout.ts'
import { OneCheckoutPerPath } from '../../rules/one-checkout-per-path.ts'
import { RouteFieldIgnoredForPageType } from '../../rules/route-field-ignored-for-page-type.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec, Page, Rule } from '../../types.ts'

function only(rule: Rule, fixtureName: string) {
  const fixture = fixtureByName(fixtureName)
  return {
    actual: rule.check(normalize(fixture.spec)),
    expected: fixture.expected.violations.filter((v) => v.ruleId === rule.id),
  }
}

function spec(pages: Page[], extra: Record<string, unknown> = {}): CampaignSpec {
  return { schema_version: '5.0', ...extra, funnels: [{ id: 'f', pages }] } as unknown as CampaignSpec
}

const UPSELL = { id: 'up', type: 'upsell', on_accept: 'ty', on_decline: 'ty' } as Page
const THANKS = { id: 'ty', type: 'thankyou' } as Page

describe('CheckoutForwardTarget', () => {
  test('flags a Checkout forwarding to another Checkout (fixture)', () => {
    const { actual, expected } = only(CheckoutForwardTarget, 'checkout-forwards-to-checkout')
    expect(actual).toHaveLength(1)
    expect(actual).toEqual(expected)
  })

  test('passes a Checkout forwarding to an upsell, downsell or thank-you page', () => {
    for (const target of ['up', 'down', 'ty']) {
      const pages = [
        { id: 'pay', type: 'checkout', success_url: target },
        UPSELL,
        { id: 'down', type: 'downsell', on_accept: 'ty', on_decline: 'ty' },
        THANKS,
      ] as Page[]
      expect(CheckoutForwardTarget.check(spec(pages))).toEqual([])
    }
  })

  test('ignores an off-graph or unresolved target', () => {
    const pages = [{ id: 'pay', type: 'checkout', success_url: '/other-campaign/upsell/' }] as Page[]
    expect(CheckoutForwardTarget.check(spec(pages))).toEqual([])
  })

  test('flags a Checkout forwarding to a landing page', () => {
    const pages = [{ id: 'pay', type: 'checkout', next_page: 'l' }, { id: 'l', type: 'landing' }] as Page[]
    expect(CheckoutForwardTarget.check(spec(pages))[0]?.data?.targetType).toBe('landing')
  })
})

describe('PrePaymentForwardTarget', () => {
  test('flags a select page forwarding to an upsell (fixture)', () => {
    const { actual, expected } = only(PrePaymentForwardTarget, 'pre-payment-skips-checkout')
    expect(actual).toHaveLength(1)
    expect(actual).toEqual(expected)
  })

  test('flags a checkout_step forwarding to a thank-you page', () => {
    const pages = [{ id: 'info', type: 'checkout_step', next_page: 'ty' }, THANKS] as Page[]
    expect(PrePaymentForwardTarget.check(spec(pages))[0]?.data?.pageId).toBe('info')
  })

  test('passes select → checkout_step → checkout', () => {
    const pages = [
      { id: 'sel', type: 'select', next_page: 'info' },
      { id: 'info', type: 'checkout_step', next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      THANKS,
    ] as Page[]
    expect(PrePaymentForwardTarget.check(spec(pages))).toEqual([])
  })
})

describe('CheckoutStepReachesCheckout', () => {
  test('flags a step with no route onward (fixture)', () => {
    const { actual, expected } = only(CheckoutStepReachesCheckout, 'checkout-step-dead-end')
    expect(actual).toHaveLength(1)
    expect(actual).toEqual(expected)
  })

  test('flags steps that loop without reaching a Checkout', () => {
    const pages = [
      { id: 'a', type: 'checkout_step', next_page: 'b' },
      { id: 'b', type: 'checkout_step', next_page: 'a' },
    ] as Page[]
    expect(CheckoutStepReachesCheckout.check(spec(pages))).toHaveLength(2)
  })

  test('passes a chain of steps ending at a Checkout', () => {
    const pages = [
      { id: 'a', type: 'checkout_step', next_page: 'b.html' },
      { id: 'b', type: 'checkout_step', next_page: '/pay/' },
      { id: 'c', type: 'checkout', page_url: '/pay/', success_url: 'ty' },
      THANKS,
    ] as Page[]
    expect(CheckoutStepReachesCheckout.check(spec(pages))).toEqual([])
  })
})

describe('OneCheckoutPerPath', () => {
  test('flags a path that passes two Checkouts (fixture)', () => {
    const { actual, expected } = only(OneCheckoutPerPath, 'checkout-forwards-to-checkout')
    expect(actual).toHaveLength(1)
    expect(actual).toEqual(expected)
  })

  test('flags a path that reaches an upsell with no Checkout (fixture)', () => {
    const { actual, expected } = only(OneCheckoutPerPath, 'pre-payment-skips-checkout')
    expect(actual).toHaveLength(1)
    expect(actual).toEqual(expected)
  })

  test('downgrades the no-Checkout case to a warning in partial scope', () => {
    const pages = [
      { id: 'up', type: 'upsell', is_entry: true, on_accept: 'ty', on_decline: 'ty' },
      { id: 'l', type: 'landing', is_entry: true, next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      THANKS,
    ] as Page[]
    const violations = OneCheckoutPerPath.check(spec(pages, { build_scope: { mode: 'partial' } }))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
  })

  test('leaves a spec with no Checkout at all to UpsellWithoutCheckout', () => {
    const pages = [{ id: 'l', type: 'landing', next_page: 'up' }, UPSELL, THANKS] as Page[]
    expect(OneCheckoutPerPath.check(spec(pages))).toEqual([])
  })

  test('passes two parallel paths that each reach their own Checkout and share the upsell', () => {
    const pages = [
      { id: 'a', type: 'landing', is_entry: true, next_page: 'pay-a' },
      { id: 'pay-a', type: 'checkout', success_url: 'up' },
      { id: 'b', type: 'select', is_entry: true, next_page: 'step-b' },
      { id: 'step-b', type: 'checkout_step', next_page: 'pay-b' },
      { id: 'pay-b', type: 'checkout', success_url: 'up' },
      UPSELL,
      THANKS,
    ] as Page[]
    expect(OneCheckoutPerPath.check(spec(pages))).toEqual([])
  })

  test('names every entry page whose path misses the Checkout, not only the first', () => {
    const pages = [
      { id: 'a', type: 'landing', is_entry: true, next_page: 'up' },
      { id: 'b', type: 'select', is_entry: true, next_page: 'up' },
      { id: 'c', type: 'landing', is_entry: true, next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'up' },
      UPSELL,
      THANKS,
    ] as Page[]
    const violations = OneCheckoutPerPath.check(spec(pages))
    expect(violations.map((v) => `${v.data?.entryPageId}->${v.data?.pageId}`)).toEqual(['a->up', 'b->up'])
  })

  test('follows the decline branch too', () => {
    const pages = [
      { id: 'l', type: 'landing', is_entry: true, next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'up' },
      { id: 'up', type: 'upsell', on_accept: 'ty', on_decline: 'pay2' },
      { id: 'pay2', type: 'checkout', success_url: 'down' },
      { id: 'down', type: 'downsell', on_accept: 'ty', on_decline: 'ty' },
      THANKS,
    ] as Page[]
    const violations = OneCheckoutPerPath.check(spec(pages))
    expect(violations.map((v) => `${v.data?.pageId}:${v.data?.checkoutsPassed}`)).toEqual(['down:2'])
  })

  test('does not gate on page order or names', () => {
    const pages = [
      THANKS,
      UPSELL,
      { id: 'zzz-pay', type: 'checkout', order: 1, success_url: 'up' },
      { id: 'aaa-step', type: 'checkout_step', order: 9, is_entry: true, next_page: 'zzz-pay' },
    ] as Page[]
    expect(OneCheckoutPerPath.check(spec(pages))).toEqual([])
  })
})

describe('RouteFieldIgnoredForPageType on checkout_step', () => {
  test('warns on success_url and on_accept copied onto a step (fixture)', () => {
    const { actual, expected } = only(RouteFieldIgnoredForPageType, 'checkout-step-route-fields')
    expect(actual.map((v) => v.data?.field)).toEqual(['on_accept', 'success_url'])
    expect(actual).toEqual(expected)
  })
})
