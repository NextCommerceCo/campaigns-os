/**
 * Corpus contract test.
 *
 * For every fixture: runRules(normalize(spec), allRules) must equal
 * expected.violations exactly. This is the test that catches drift in any
 * rule's behaviour — failures point at exactly which fixture diffed and
 * which rule's output changed.
 *
 * If a rule's output legitimately changes, regenerate the expected/<name>.expected.json
 * to match (and review the diff carefully).
 */

import { describe, expect, test } from 'bun:test'
import { normalize, runRules, allRules } from '../index.ts'
import { corpus } from '../fixtures/index.ts'

describe('corpus contract', () => {
  for (const fixture of corpus) {
    test(`${fixture.name} matches expected violations`, () => {
      const actual = runRules(normalize(fixture.spec), allRules)
      expect(actual).toEqual(fixture.expected.violations)
    })
  }
})
