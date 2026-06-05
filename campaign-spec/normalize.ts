/**
 * normalize — the single phase that takes an authoring CampaignSpec and emits
 * the canonical v4.2 funnels[] shape that rules operate on.
 *
 * Today this is near-empty: v4.3 already uses funnels[]. The phase exists so
 * future authoring evolutions have one place to land their migration.
 *
 * v4.1 (funnel_pages[]) is intentionally NOT supported — see
 * ../docs/adr/002-drop-v41-spec-support.md. Inputs without `funnels[]` fail
 * the structural assertion below.
 */

import type { CampaignSpec } from './types.ts'

/**
 * Thrown when input is structurally unrecognizable as a CampaignSpec.
 * Distinct from rule violations: a violation means "this spec is wrong";
 * a NormalizeError means "this isn't a spec at all (or it's an unsupported
 * legacy version)."
 */
export class NormalizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NormalizeError'
  }
}

export function normalize(input: unknown): CampaignSpec {
  if (input == null || typeof input !== 'object') {
    throw new NormalizeError('CampaignSpec must be an object.')
  }
  const obj = input as Record<string, unknown>

  // v4.1 detection: top-level funnel_pages without funnels[] means a legacy
  // spec. We reject explicitly to make the migration visible.
  if (!Array.isArray(obj.funnels) && Array.isArray(obj.funnel_pages)) {
    throw new NormalizeError(
      'CampaignSpec uses legacy v4.1 funnel_pages topology. v4.1 is not supported (ADR-002). ' +
        'Migrate the spec to v4.2+ funnels[] before validating.',
    )
  }

  if (!Array.isArray(obj.funnels)) {
    throw new NormalizeError(
      'CampaignSpec is missing funnels[]. Expected canonical v4.2+ topology.',
    )
  }

  // Future migrations (v5 → v4, etc.) land here. Today the shape is already
  // canonical, so pass through.
  return obj as unknown as CampaignSpec
}
