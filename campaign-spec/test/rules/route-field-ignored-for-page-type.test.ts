/**
 * RouteFieldIgnoredForPageType — the diagnostic paired with the #234 carve-out.
 *
 * #234 stopped a stray `success_url` from outranking a non-checkout page's real
 * next step. That makes the field inert rather than dangerous, but an author who
 * wrote it still gets something other than what they typed, so this rule says so
 * out loud. RouteTargetResolves cannot: when both targets name real pages it has
 * nothing to complain about.
 *
 * The corpus assertion at the bottom is the gate's reachability proof — the rule
 * ships already quiet across every certified fixture and every rule fixture. It
 * is paired with positive tests proving it still bites on the exact shape from
 * the issue.
 */

import { describe, expect, test } from '../harness.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RouteFieldIgnoredForPageType } from '../../rules/route-field-ignored-for-page-type.ts'
import { normalize } from '../../normalize.ts'
import type { CampaignSpec } from '../../types.ts'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const specWith = (pages: unknown[]): CampaignSpec =>
  ({
    schema_version: '4.3',
    funnels: [{ id: 'f', name: 'F', hypothesis: 'route field meaning', weight: 100, pages }],
  }) as unknown as CampaignSpec

describe('RouteFieldIgnoredForPageType rule', () => {
  test('flags the issue shape: success_url on a select page that also has next_page', () => {
    // Verbatim from campaigns-os#234. Before the carve-out this wired `upsell`
    // and the shopper never reached payment; now it wires `checkout` and the
    // author is told the field they wrote did nothing.
    const violations = RouteFieldIgnoredForPageType.check(
      normalize(
        specWith([
          { id: 'select', type: 'select', next_page: 'checkout', success_url: 'upsell' },
          { id: 'checkout', type: 'checkout', success_url: 'upsell' },
          { id: 'upsell', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
          { id: 'receipt', type: 'thankyou' },
        ]),
      ),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warning')
    expect(violations[0].path).toBe('/funnels/0/pages/0/success_url')
    expect(violations[0].data?.pageId).toBe('select')
    expect(violations[0].data?.field).toBe('success_url')
    expect(violations[0].data?.target).toBe('upsell')
    // Naming where the shopper actually goes is what makes this actionable.
    expect(violations[0].data?.routedTo).toBe('checkout')
    expect(violations[0].message.includes('routes forward to "checkout"')).toBe(true)
  })

  test('says so when the ignored field leaves the page with no forward route', () => {
    // The other half of the story: telling an author their field is ignored,
    // without telling them the page now dead-ends, would be half a diagnosis.
    const violations = RouteFieldIgnoredForPageType.check(
      normalize(
        specWith([
          { id: 'select', type: 'select', success_url: 'upsell' },
          { id: 'checkout', type: 'checkout', success_url: 'receipt' },
          { id: 'upsell', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
          { id: 'receipt', type: 'thankyou' },
        ]),
      ),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.routedTo).toBe(null)
    expect(violations[0].message.includes('no forward route at all')).toBe(true)
  })

  test('quiet on a checkout — the one page type that does take payment', () => {
    expect(
      RouteFieldIgnoredForPageType.check(
        normalize(
          specWith([
            { id: 'checkout', type: 'checkout', success_url: 'upsell', next_page: 'upsell' },
            { id: 'upsell', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
            { id: 'receipt', type: 'thankyou' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('quiet on the fields that stayed type-agnostic', () => {
    // #234 narrowed success_url only. A rule that also grumbled about
    // next_page or on_accept would be re-imposing the page-type gate #230 removed.
    expect(
      RouteFieldIgnoredForPageType.check(
        normalize(
          specWith([
            { id: 'landing', type: 'landing', next_page: 'checkout' },
            { id: 'checkout', type: 'checkout', on_accept: 'receipt', next_page: 'receipt' },
            { id: 'receipt', type: 'thankyou', next_page: 'oto-2' },
            { id: 'oto-2', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('a declared-but-empty success_url is not a violation', () => {
    // An empty field carries no intent to correct, and warning about whitespace
    // is exactly the kind of noise that gets a rule switched off.
    expect(
      RouteFieldIgnoredForPageType.check(
        normalize(
          specWith([
            { id: 'select', type: 'select', success_url: '   ', next_page: 'checkout' },
            { id: 'checkout', type: 'checkout', success_url: 'receipt' },
            { id: 'receipt', type: 'thankyou' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('reachability: the rule is already quiet across every certified fixture', () => {
    // The precondition for shipping any new gate here. A first cut of
    // RouteTargetResolves in #233 fired on missing-thank-you-partial-scope, a
    // documented supported shape; the corpus caught it before it shipped.
    // Certified family fixtures only. campaign-spec/fixtures/ is a collection
    // of deliberate defect specimens — one of them now exercises this rule on
    // purpose (success-url-off-checkout), and the corpus contract test is where
    // that is pinned.
    const dir = join(root, 'contracts', 'fixtures', 'campaign-specs')
    const noisy: string[] = []
    let scanned = 0
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      const spec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CampaignSpec
      scanned += 1
      const violations = RouteFieldIgnoredForPageType.check(normalize(spec))
      if (violations.length) noisy.push(`${name}: ${violations.map((v) => v.path).join(', ')}`)
    }
    expect(noisy).toEqual([])
    // Guard the proof itself: a directory that silently matched nothing would
    // make the assertion above vacuously true.
    expect(scanned >= 10).toBe(true)
  })
})
