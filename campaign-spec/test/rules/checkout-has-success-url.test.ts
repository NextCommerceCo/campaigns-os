import { describe, expect, test } from '../harness.ts'
import { CheckoutHasSuccessUrl } from '../../rules/checkout-has-success-url.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

describe('CheckoutHasSuccessUrl rule', () => {
  test('flags when upsell exists but checkout success_url is missing', () => {
    const fixture = fixtureByName('checkout-missing-success-url')
    const violations = CheckoutHasSuccessUrl.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('silent when there is no upsell in the spec (rule precondition)', () => {
    // Checkout has no success_url and no upsell present — rule should stay quiet.
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'checkout-only without upsell, success_url not required',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'c' },
            { id: 'c', type: 'checkout' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(CheckoutHasSuccessUrl.check(normalize(spec))).toEqual([])
  })

  test('passes when checkout has success_url and upsell exists', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(CheckoutHasSuccessUrl.check(normalize(spec))).toEqual([])
  })

  /**
   * The narrowing. A checkout that routes through next_page has said exactly
   * where the shopper goes; warning at it told the author to rename a field
   * they had already filled in. Nine certified family fixtures do this.
   */
  test('silent when the checkout routes forward through next_page instead of success_url', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'checkout routes via next_page',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'c' },
            { id: 'c', type: 'checkout', next_page: 'u' },
            { id: 'u', type: 'upsell', on_accept: 'ty' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    expect(CheckoutHasSuccessUrl.check(normalize(spec))).toEqual([])
  })

  test('still fires when the checkout has no forward route at all — the real dead end', () => {
    const spec: CampaignSpec = {
      schema_version: '4.3',
      funnels: [
        {
          id: 'f',
          name: 'F',
          hypothesis: 'checkout strands the shopper',
          weight: 100,
          pages: [
            { id: 'l', type: 'landing', next_page: 'c' },
            { id: 'c', type: 'checkout' },
            { id: 'u', type: 'upsell', on_accept: 'ty' },
            { id: 'ty', type: 'thankyou' },
          ],
        },
      ],
    }
    const violations = CheckoutHasSuccessUrl.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
    expect(violations[0].data?.pageId).toBe('c')
    expect(violations[0].message).toContain('no forward route')
  })

  test('every certified fixture is now quiet — all twelve false alarms are gone', () => {
    // The corpus IS the proof here: before the narrowing this rule fired on
    // twelve pages across ten shipped fixtures whose checkouts route perfectly
    // well. The count is asserted, not just named in the title, so a corpus
    // change that alters it fails loudly rather than silently outdating this.
    const dir = join(root, 'contracts', 'fixtures', 'campaign-specs')
    const noisy: string[] = []
    // What the OLD rule flagged: a checkout with no success_url, regardless of
    // any other forward route it declared.
    const wouldHaveWarned: string[] = []
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const spec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CampaignSpec
      if (CheckoutHasSuccessUrl.check(normalize(spec)).length) noisy.push(name)
      for (const funnel of spec.funnels ?? []) {
        for (const page of funnel.pages ?? []) {
          if (page.type === 'checkout' && !page.success_url) wouldHaveWarned.push(`${name}:${page.id}`)
        }
      }
    }
    expect(noisy).toEqual([])
    expect(wouldHaveWarned.length).toBe(12)
    expect(new Set(wouldHaveWarned.map((entry) => entry.split(':')[0])).size).toBe(10)
  })
})
