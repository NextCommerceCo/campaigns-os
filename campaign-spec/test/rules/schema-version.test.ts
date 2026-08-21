import { describe, expect, test } from '../harness.ts'
import { SchemaVersion, SUPPORTED_SCHEMA_VERSIONS } from '../../rules/schema-version.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'
import schema from '../../../schemas/campaign-spec.v4.schema.json' with { type: 'json' }

describe('SchemaVersion rule', () => {
  test('flags missing schema_version', () => {
    const fixture = fixtureByName('missing-schema-version')
    const violations = SchemaVersion.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('passes when schema_version is present', () => {
    const { spec } = fixtureByName('single-funnel-basic')
    expect(SchemaVersion.check(normalize(spec))).toEqual([])
  })

  test('passes every supported version in the matrix', () => {
    for (const version of SUPPORTED_SCHEMA_VERSIONS) {
      const spec = { schema_version: version, funnels: [] } as unknown as CampaignSpec
      expect(SchemaVersion.check(normalize(spec))).toEqual([])
    }
  })

  test('errors on an unsupported schema_version, naming the supported set', () => {
    const spec = { schema_version: '4.1', funnels: [] } as unknown as CampaignSpec
    const violations = SchemaVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('SchemaVersion')
    expect(violations[0].severity).toBe('error')
    expect(violations[0].path).toBe('/schema_version')
    expect(violations[0].message).toContain('"4.1"')
    expect(violations[0].message).toContain('4.2, 4.3')
    expect(violations[0].data).toEqual({
      value: '4.1',
      supported: ['4.2', '4.3'],
      check: 'schema-version-supported',
    })
  })

  test('errors on a future unsupported lineage', () => {
    const spec = { schema_version: '5.0', funnels: [] } as unknown as CampaignSpec
    const violations = SchemaVersion.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('schema-version-supported')
  })

  // The rule stays pure (no filesystem), so its supported matrix duplicates
  // the schema's schema_version enum. This is the drift gate: the two lists
  // must stay identical, updated together (the UnknownTopLevelFields pattern).
  test('supported matrix matches the schemas/campaign-spec.v4.schema.json enum', () => {
    const schemaEnum = (schema as {
      properties: { schema_version: { enum: string[] } }
    }).properties.schema_version.enum
    // Exact order, no sort: the constant and the schema enum must agree on
    // membership AND order (lexical sort would hide drift once '4.10' exists).
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([...schemaEnum])
  })
})
