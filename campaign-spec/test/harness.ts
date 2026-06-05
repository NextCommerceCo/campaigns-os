/**
 * node:test harness shim for the campaign-spec suite (ADR-003).
 *
 * The suite was authored against bun:test. This thin adapter re-exports
 * node:test's describe/test/it and a minimal `expect` mapping the exact five
 * matchers the suite uses (toBe, toEqual, toContain, toHaveLength, toBeDefined)
 * onto node:assert/strict — so the public package tests on plain `node --test`
 * with no bun dependency and no rewritten assertions.
 *
 * Fidelity note: bun/jest `toEqual` ignores `undefined`-valued keys, but
 * node's `deepStrictEqual` treats `{a:1}` and `{a:1,b:undefined}` as different.
 * `stripUndefined` normalizes both sides first so `toEqual` keeps bun semantics
 * for the plain Violation/data structures the rules emit.
 */
import { describe, test, it } from 'node:test'
import assert from 'node:assert/strict'

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val !== undefined) out[key] = stripUndefined(val)
    }
    return out
  }
  return value
}

export function expect(actual: any) {
  return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) =>
      assert.deepStrictEqual(stripUndefined(actual), stripUndefined(expected)),
    toContain: (expected: unknown) =>
      assert.ok(
        Array.isArray(actual) ? actual.includes(expected) : String(actual).includes(expected as string),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`,
      ),
    toHaveLength: (length: number) => assert.strictEqual(actual?.length, length),
    toBeDefined: () => assert.notStrictEqual(actual, undefined),
  }
}

export { describe, test, it }
