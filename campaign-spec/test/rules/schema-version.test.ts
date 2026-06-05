import { describe, expect, test } from 'bun:test'
import { SchemaVersion } from '../../rules/schema-version.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'

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
})
