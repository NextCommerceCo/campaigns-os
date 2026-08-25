/**
 * Schema conformance: every fixture in BOTH corpora must validate against
 * schemas/campaign-spec.v4.schema.json.
 *
 *   - contracts/fixtures/campaign-specs/*.json — the public agent-contract
 *     fixtures, re-authored to the real-export dialect. Zero exceptions.
 *   - campaign-spec/fixtures/*.json — the internal rule corpus. Some
 *     fixtures are DELIBERATELY malformed to exercise a specific rule;
 *     where the malformation is also a schema-shape violation the fixture
 *     is listed below with its reason, and the test asserts it really does
 *     fail (so the exception list cannot rot into a silent skip).
 *
 * The schema is deliberately permissive (additionalProperties open), so a
 * failure here means a fixture drifted from the typed KNOWN surface — either
 * fix the fixture, or (if real export data supports the new shape) loosen
 * the schema.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from './harness.ts'
import type { PageType } from '../types.ts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const schemaPath = join(root, 'schemas', 'campaign-spec.v4.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true })
const validate = ajv.compile(schema)

/**
 * Internal corpus fixtures that are deliberately malformed in ways that are
 * ALSO schema-shape violations (each exists to make a specific rule fire).
 * Every entry must actually fail schema validation — asserted below.
 */
const EXPECTED_SCHEMA_INVALID: Record<string, string> = {
  'analytics-contract-malformed.json':
    'deliberately mistyped analytics block (invalid mode enum, non-array blockedEvents) for the AnalyticsContractShape rule',
  'assembly-hints-malformed.json':
    'deliberately non-numeric upsell_mv_tiers.min for the AssemblyHintsShape rule',
  'bad-shipping-countries.json':
    'deliberately outside all three real available_shipping_countries shapes for the ShippingCountriesShape rule',
  'missing-schema-version.json':
    'deliberately missing the required schema_version for the SchemaVersion rule',
  'promo-codes-malformed.json':
    'deliberately mistyped promo_codes entries for the PromoCodesShape rule',
  'store-profile-malformed.json':
    'deliberately mistyped campaign store profile / allowed_domains for the StoreProfileShape rule',
  'variant-labels-malformed.json':
    'deliberately mistyped variant_labels for the VariantLabelsShape rule',
}

function jsonFixtures(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

function formatErrors(): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ')
}

describe('campaign-spec.v4 schema conformance', () => {
  const contractsDir = join(root, 'contracts', 'fixtures', 'campaign-specs')
  for (const name of jsonFixtures(contractsDir)) {
    test(`contracts fixture ${name} validates`, () => {
      const spec = JSON.parse(readFileSync(join(contractsDir, name), 'utf8'))
      const ok = validate(spec)
      expect(ok ? '' : formatErrors()).toBe('')
    })
  }

  const internalDir = join(root, 'campaign-spec', 'fixtures')
  for (const name of jsonFixtures(internalDir)) {
    const expectedInvalidReason = EXPECTED_SCHEMA_INVALID[name]
    if (expectedInvalidReason) {
      test(`internal fixture ${name} is schema-invalid on purpose (${expectedInvalidReason})`, () => {
        const spec = JSON.parse(readFileSync(join(internalDir, name), 'utf8'))
        expect(validate(spec)).toBe(false)
      })
    } else {
      test(`internal fixture ${name} validates`, () => {
        const spec = JSON.parse(readFileSync(join(internalDir, name), 'utf8'))
        const ok = validate(spec)
        expect(ok ? '' : formatErrors()).toBe('')
      })
    }
  }

  test('exception list only names fixtures that exist', () => {
    const names = new Set(jsonFixtures(internalDir))
    for (const name of Object.keys(EXPECTED_SCHEMA_INVALID)) {
      expect(names.has(name)).toBe(true)
    }
  })

  test('schema keeps the ratified frame: 4.2–4.3, funnels required, permissive elsewhere', () => {
    expect(schema.properties.schema_version.enum).toEqual(['4.2', '4.3'])
    expect(schema.required.sort()).toEqual(['funnels', 'schema_version'])
    expect(schema.additionalProperties).toBe(true)
  })

  /**
   * Page-type drift gate. The authoring PageType union in types.ts and this
   * enum are two statements of one fact, and #207 is what happens when they
   * disagree: contracts and CLI branches accumulated around a `select` page
   * type the union did not have, so the code was dead and the contract scoping
   * was inert — silently, for months.
   *
   * PageType is a compile-time union with no runtime representation, so the
   * union side is pinned by the type annotation on PAGE_TYPES below: adding a
   * member to the schema without adding it to the union (or vice versa) fails
   * to compile or fails here.
   */
  test('page-type enum matches the authoring PageType union exactly', () => {
    const PAGE_TYPES: PageType[] = [
      'presell',
      'landing',
      'select',
      'checkout',
      'upsell',
      'downsell',
      'thankyou',
    ]
    expect(schema.$defs.page.properties.type.enum).toEqual(PAGE_TYPES)
  })

  test("'receipt' is a projection, never an authoring page type", () => {
    // contractPageType() maps thankyou → receipt for contract scoping. That
    // projection must not leak back into the authoring enum.
    expect((schema.$defs.page.properties.type.enum as string[]).includes('receipt')).toBe(false)
  })
})
