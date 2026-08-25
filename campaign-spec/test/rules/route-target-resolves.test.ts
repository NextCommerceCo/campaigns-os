/**
 * RouteTargetResolves — the replacement signal for the coverage that narrowing
 * CheckoutHasSuccessUrl gave up.
 *
 * The corpus assertion at the bottom is the gate's reachability proof: this
 * rule ships already quiet across every certified fixture, so it cannot land as
 * a checkpoint that fires on our own shipped campaigns. It is paired with a
 * positive test proving it still bites on the exact defect that motivated it.
 */

import { describe, expect, test } from '../harness.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RouteTargetResolves } from '../../rules/route-target-resolves.ts'
import { normalize } from '../../normalize.ts'
import type { CampaignSpec } from '../../types.ts'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const specWith = (pages: unknown[]): CampaignSpec =>
  ({
    schema_version: '4.3',
    funnels: [{ id: 'f', name: 'F', hypothesis: 'routing targets', weight: 100, pages }],
  }) as unknown as CampaignSpec

describe('RouteTargetResolves rule', () => {
  test('flags a target naming no page in the funnel — the dead-link case', () => {
    // Verbatim shape of the defect: six certified fixtures declared
    // upsell-bundle-stepper.html on a checkout whose upsell is upsell-stepper.
    const violations = RouteTargetResolves.check(
      normalize(
        specWith([
          { id: 'checkout', type: 'checkout', next_page: 'upsell-bundle-stepper.html' },
          { id: 'upsell-stepper', type: 'upsell', on_accept: 'receipt' },
          { id: 'receipt', type: 'thankyou' },
        ]),
      ),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
    expect(violations[0].data?.field).toBe('next_page')
    expect(violations[0].data?.target).toBe('upsell-bundle-stepper.html')
    expect(violations[0].path).toBe('/funnels/0/pages/0/next_page')
  })

  test('never blocks a build — severity stays warning', () => {
    // A free-form journey must not be gated on this. Blocking would strand the
    // unconventional authors the routing work exists to support.
    expect(RouteTargetResolves.severity).toBe('warning')
  })

  test('the corpus dialect resolves: <page-id>.html matches its page', () => {
    expect(
      RouteTargetResolves.check(
        normalize(
          specWith([
            { id: 'checkout', type: 'checkout', next_page: 'upsell-stepper.html' },
            { id: 'upsell-stepper', type: 'upsell', on_accept: 'receipt' },
            { id: 'receipt', type: 'thankyou' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('every routing field is checked, not just next_page', () => {
    const violations = RouteTargetResolves.check(
      normalize(
        specWith([
          { id: 'chk', type: 'checkout', success_url: 'nope-a' },
          { id: 'up', type: 'upsell', on_accept: 'nope-b', on_decline: 'nope-c' },
          { id: 'ty', type: 'thankyou' },
        ]),
      ),
    )
    expect(violations.map((violation) => violation.data?.field).sort()).toEqual([
      'on_accept',
      'on_decline',
      'success_url',
    ])
  })

  test('deliberate off-graph destinations are never flagged', () => {
    // The resolver passes these through on purpose; they are not typos.
    expect(
      RouteTargetResolves.check(
        normalize(
          specWith([
            { id: 'a', type: 'landing', next_page: 'https://partner.example.com/offer' },
            { id: 'b', type: 'checkout', success_url: '#thanks' },
            // Rooted path: the partial-scope pattern ThankYouRequirement
            // documents, where traffic continues to an existing downstream
            // campaign. Flagging it would fire on a supported shape.
            { id: 'c', type: 'checkout', success_url: '/existing-campaign/receipt/' },
            { id: 'ty', type: 'thankyou' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('an empty or whitespace-only field is not a target', () => {
    expect(
      RouteTargetResolves.check(
        normalize(specWith([{ id: 'a', type: 'checkout', next_page: '   ' }, { id: 'ty', type: 'thankyou' }])),
      ),
    ).toEqual([])
  })

  test('padding does not defeat resolution', () => {
    expect(
      RouteTargetResolves.check(
        normalize(
          specWith([
            { id: 'chk', type: 'checkout', success_url: '  receipt  ' },
            { id: 'receipt', type: 'thankyou' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('reachability: the rule is already quiet across every certified fixture', () => {
    // The precondition for shipping any new gate here. A checkpoint that fires
    // on our own shipped campaigns is the failure mode, not the feature.
    const dir = join(root, 'contracts', 'fixtures', 'campaign-specs')
    const noisy: string[] = []
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      const spec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CampaignSpec
      const violations = RouteTargetResolves.check(normalize(spec))
      if (violations.length) noisy.push(`${name}: ${violations.map((v) => v.data?.target).join(', ')}`)
    }
    expect(noisy).toEqual([])
  })
})
