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
import {
  OFFER_BEARING_PAGE_TYPES,
  PAYMENT_BEARING_PAGE_TYPES,
  describeForwardField,
} from '../../routing.ts'
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

  test('quiet on next_page, which stayed type-agnostic', () => {
    // #234 narrowed the two fields that carry a page-shaped meaning, and
    // nothing else. A rule that also grumbled about `next_page` — the generic
    // "wherever this goes next" — would be re-imposing the page-type gate #230
    // removed, on the one field that gate was most wrong about.
    expect(
      RouteFieldIgnoredForPageType.check(
        normalize(
          specWith([
            { id: 'landing', type: 'landing', next_page: 'checkout' },
            { id: 'checkout', type: 'checkout', next_page: 'receipt' },
            { id: 'receipt', type: 'thankyou', next_page: 'oto-2' },
            { id: 'oto-2', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
          ]),
        ),
      ),
    ).toEqual([])
  })

  test('flags a stray on_accept, the same break one field over', () => {
    // `on_accept` outranks everything, so before #234 gated it a select page
    // carrying a copy-pasted on_accept wired the upsell and skipped payment —
    // exactly the reported bug, through the sibling field. Both pages here are
    // ineligible: the select has no offer, and the checkout's own success_url
    // was being shadowed by a field that means nothing on a checkout.
    const violations = RouteFieldIgnoredForPageType.check(
      normalize(
        specWith([
          { id: 'select', type: 'select', next_page: 'checkout', on_accept: 'upsell' },
          { id: 'checkout', type: 'checkout', success_url: 'upsell', on_accept: 'receipt' },
          { id: 'upsell', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
          { id: 'receipt', type: 'thankyou' },
        ]),
      ),
    )
    expect(violations).toHaveLength(2)

    expect(violations[0].path).toBe('/funnels/0/pages/0/on_accept')
    expect(violations[0].data?.routedTo).toBe('checkout')
    expect(violations[0].message.includes('accepting the offer on this page')).toBe(true)
    expect(violations[0].message.includes('"upsell" or "downsell"')).toBe(true)

    // The checkout keeps its own success_url now that on_accept cannot shadow it.
    expect(violations[1].path).toBe('/funnels/0/pages/1/on_accept')
    expect(violations[1].data?.routedTo).toBe('upsell')
  })

  test('quiet on an upsell and a downsell, which do present an offer', () => {
    expect(
      RouteFieldIgnoredForPageType.check(
        normalize(
          specWith([
            { id: 'checkout', type: 'checkout', success_url: 'upsell' },
            { id: 'upsell', type: 'upsell', on_accept: 'downsell', on_decline: 'downsell' },
            { id: 'downsell', type: 'downsell', on_accept: 'receipt', on_decline: 'receipt' },
            { id: 'receipt', type: 'thankyou' },
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

  test('a page with no usable type is told THAT, not told about payment', () => {
    // `type` is schema-required, so this page is malformed. It still reaches the
    // rule (normalize does not require the field, and the rule is tagged
    // spec-only/fast so it runs on malformed specs), and pointing that author at
    // payment semantics would name the wrong defect. Regression guard: the
    // message must never interpolate a raw `undefined` page type.
    const violations = RouteFieldIgnoredForPageType.check(
      normalize(
        specWith([
          { id: 'mystery', success_url: 'upsell' },
          { id: 'checkout', type: 'checkout', success_url: 'upsell' },
          { id: 'upsell', type: 'upsell', on_accept: 'receipt', on_decline: 'receipt' },
          { id: 'receipt', type: 'thankyou' },
        ]),
      ),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].message.includes('undefined')).toBe(false)
    expect(violations[0].message.includes('no valid "type"')).toBe(true)
    expect(violations[0].data?.routedTo).toBe(null)
  })

  test('the explanation is derived from routing.ts, not hand-written here', () => {
    // The rule's whole safety property is that it cannot claim a field is dead
    // while the resolver still uses it. That holds only while the message text
    // comes from describeForwardField — a hand-written checkout sentence would
    // silently become wrong the first time a second field joins the table.
    expect(describeForwardField('success_url')?.requiredTypes).toEqual([...PAYMENT_BEARING_PAGE_TYPES])
    expect(describeForwardField('on_accept')?.requiredTypes).toEqual([...OFFER_BEARING_PAGE_TYPES])
    // next_page carries no page-shaped meaning, so it has no applicability rule
    // at all — the table is the whole list of gated fields.
    expect(describeForwardField('next_page')).toBe(null)
    const applicability = describeForwardField('success_url')
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
    expect(violations[0].message.includes(applicability!.meaning)).toBe(true)
    for (const type of applicability!.requiredTypes) {
      expect(violations[0].message.includes(`"${type}"`)).toBe(true)
    }
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
