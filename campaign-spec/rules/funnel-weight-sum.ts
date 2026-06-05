/**
 * FunnelWeightSum — flags funnel weight problems.
 *
 * Two failure modes, both emitted under the same rule id:
 *   1. Per-funnel weight outside [0, 100] or non-finite.
 *      → Violation at /funnels/<idx>/weight, severity error.
 *   2. Aggregate sum of valid weights != 100 (± 0.01 tolerance for float input
 *      like 33.33 + 33.33 + 33.34).
 *      → Violation at /funnels, severity error.
 *
 * Tags: fast, structure, spec-only. Cheap enough for per-keystroke Map
 * Builder contexts (Decision: this is the "fast" rule shape we promised).
 *
 * NOTE: This rule could be split into FunnelWeightRange (per-funnel) and
 * FunnelWeightSum (aggregate) for finer composition. Kept fused for now —
 * the two checks share traversal and tend to fire together; splitting is
 * cheap to do later when a caller actually needs to subset.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const SUM_TOLERANCE = 0.01
const EXPECTED_SUM = 100

function toFiniteWeight(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

export const FunnelWeightSum: Rule = {
  id: 'FunnelWeightSum',
  severity: 'error',
  tags: ['fast', 'structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    let sum = 0
    let anyInRange = false

    spec.funnels.forEach((funnel, idx) => {
      const weight = toFiniteWeight(funnel.weight)
      if (weight == null || weight < 0 || weight > EXPECTED_SUM) {
        // Message text is the canonical wording, inherited from the pre-#110
        // validator at migration time. Caller tests across the repo match on
        // this substring; improvements land in a follow-up when needed.
        violations.push({
          ruleId: 'FunnelWeightSum',
          severity: 'error',
          message:
            `Funnel "${funnel.id ?? '(unnamed)'}" — weight must be a number in [0, 100] (got ${funnel.weight}).`,
          path: `/funnels/${idx}/weight`,
          data: { funnelId: funnel.id, weight: funnel.weight },
        })
        return
      }
      anyInRange = true
      sum += weight
    })

    // If no funnels had a valid weight, the sum check would be meaningless;
    // the per-funnel violations carry the signal.
    if (spec.funnels.length > 0 && anyInRange) {
      if (Math.abs(sum - EXPECTED_SUM) > SUM_TOLERANCE) {
        violations.push({
          ruleId: 'FunnelWeightSum',
          severity: 'error',
          message: `Funnel weights must sum to 100 (got ${sum}).`,
          path: '/funnels',
          data: { sum, expected: EXPECTED_SUM, tolerance: SUM_TOLERANCE },
        })
      }
    }

    return violations
  },
}
