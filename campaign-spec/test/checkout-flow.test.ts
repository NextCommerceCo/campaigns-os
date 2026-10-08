import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from './harness.ts'
import {
  checkoutPathFrom,
  entryPages,
  forwardTargetPage,
  paymentPageFrom,
  paymentPagesForFunnel,
  resolveRouteTargetPage,
  upgradeCampaignSpec,
} from '../checkout-flow.ts'
import { normalize } from '../normalize.ts'
import { validateSpec } from '../index.ts'
import type { CampaignSpec, Page } from '../types.ts'

function contractFixture(name: string): CampaignSpec {
  const url = new URL(`../../contracts/fixtures/campaign-specs/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
}

function v4ThreeStep(): CampaignSpec {
  const spec = contractFixture('shop-three-step-dynamic-shipping')
  spec.schema_version = '4.3'
  for (const page of spec.funnels[0].pages ?? []) {
    if (page.type === 'checkout_step') page.type = 'checkout'
  }
  return spec
}

describe('upgradeCampaignSpec (v4 → v5 on read)', () => {
  test('a v4 checkout → checkout chain becomes checkout_step, billing stays checkout', () => {
    const v4 = v4ThreeStep()
    const upgraded = upgradeCampaignSpec(v4)
    expect(upgraded.schema_version).toBe('5.0')
    expect((upgraded.funnels[0].pages ?? []).map((p: Page) => `${p.id}:${p.type}`)).toEqual([
      'information:checkout_step',
      'shipping:checkout_step',
      'billing:checkout',
      'upsell-stepper:upsell',
      'receipt:thankyou',
    ])
  })

  test('matches the hand-upgraded v5 fixture exactly', () => {
    expect(upgradeCampaignSpec(v4ThreeStep())).toEqual(contractFixture('shop-three-step-dynamic-shipping'))
  })

  test('never mutates its input', () => {
    const v4 = v4ThreeStep()
    const before = JSON.stringify(v4)
    upgradeCampaignSpec(v4)
    normalize(v4)
    expect(JSON.stringify(v4)).toBe(before)
  })

  test('a v5 spec passes through untouched, even a checkout → checkout chain', () => {
    const v5 = { schema_version: '5.0', funnels: [{ id: 'f', pages: [
      { id: 'a', type: 'checkout', next_page: 'b' },
      { id: 'b', type: 'checkout', success_url: 'ty' },
      { id: 'ty', type: 'thankyou' },
    ] }] } as unknown as CampaignSpec
    expect(upgradeCampaignSpec(v5)).toBe(v5)
  })

  test('a v4 select → checkout two-step is unchanged apart from the version', () => {
    const v4 = contractFixture('olympus-mv-two-step-configurable')
    v4.schema_version = '4.3'
    const upgraded = upgradeCampaignSpec(v4)
    expect(upgraded.schema_version).toBe('5.0')
    expect(upgraded.funnels).toEqual(v4.funnels)
  })

  test('an unsupported or missing version is left for SchemaVersion to report', () => {
    const missing = { funnels: [] } as unknown as CampaignSpec
    expect(upgradeCampaignSpec(missing)).toBe(missing)
    const old = { schema_version: '4.1', funnels: [] } as unknown as CampaignSpec
    expect(upgradeCampaignSpec(old).schema_version).toBe('4.1')
  })

  test('the upgraded v4 three-step spec validates with no errors', () => {
    const errors = validateSpec(v4ThreeStep()).filter((v) => v.severity === 'error')
    expect(errors).toEqual([])
  })
})

describe('checkout paths', () => {
  test('route targets resolve by id, .html filename and page_url', () => {
    const pages = [
      { id: 'shipping', type: 'checkout_step', page_url: '/ship/' },
      { id: 'billing', type: 'checkout' },
    ] as Page[]
    expect(resolveRouteTargetPage(pages, 'shipping')?.id).toBe('shipping')
    expect(resolveRouteTargetPage(pages, 'shipping.html')?.id).toBe('shipping')
    expect(resolveRouteTargetPage(pages, '/ship/')?.id).toBe('shipping')
    expect(resolveRouteTargetPage(pages, 'https://example.com/billing')).toBe(null)
    expect(resolveRouteTargetPage(pages, '#billing')).toBe(null)
    expect(resolveRouteTargetPage(pages, 'nowhere')).toBe(null)
  })

  test('each of two parallel paths finds its own Checkout', () => {
    const spec = contractFixture('two-path-split-checkout')
    const funnel = spec.funnels[0]
    const pages = funnel.pages ?? []
    expect(entryPages(funnel).map((p) => p.id)).toEqual(['select', 'information'])
    expect(checkoutPathFrom(pages, pages.find((p) => p.id === 'select'))?.map((p) => p.id)).toEqual(['select', 'checkout'])
    expect(checkoutPathFrom(pages, pages.find((p) => p.id === 'information'))?.map((p) => p.id)).toEqual([
      'information',
      'shipping',
      'billing',
    ])
    expect(paymentPagesForFunnel(funnel).map((p) => p.id)).toEqual(['checkout', 'billing'])
    expect(validateSpec(spec).filter((v) => v.severity === 'error')).toEqual([])
  })

  test('the Checkout on the path is not the first page typed checkout', () => {
    const pages = [
      { id: 'other', type: 'checkout', success_url: 'ty' },
      { id: 'landing', type: 'landing', next_page: 'step' },
      { id: 'step', type: 'checkout_step', next_page: 'pay' },
      { id: 'pay', type: 'checkout', success_url: 'ty' },
      { id: 'ty', type: 'thankyou' },
    ] as Page[]
    expect(paymentPageFrom(pages, pages[1])?.id).toBe('pay')
    expect(forwardTargetPage(pages, pages[2])?.id).toBe('pay')
  })

  test('a walk that loops or reaches an offer first finds no Checkout', () => {
    const loop = [
      { id: 'a', type: 'checkout_step', next_page: 'b' },
      { id: 'b', type: 'checkout_step', next_page: 'a' },
    ] as Page[]
    expect(paymentPageFrom(loop, loop[0])).toBe(null)
    const skip = [
      { id: 'a', type: 'select', next_page: 'u' },
      { id: 'u', type: 'upsell', next_page: 'pay' },
      { id: 'pay', type: 'checkout' },
    ] as Page[]
    expect(paymentPageFrom(skip, skip[0])).toBe(null)
  })
})
