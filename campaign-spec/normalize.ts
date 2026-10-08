/**
 * normalize — the single phase that takes an authoring CampaignSpec and emits
 * the canonical v4.2 funnels[] shape that rules operate on.
 *
 * v4.2/v4.3 specs are upgraded to the v5 page vocabulary here (a `checkout`
 * that forwards to another `checkout` becomes `checkout_step`), so every rule
 * sees one vocabulary. Future authoring evolutions land here too.
 *
 * v4.1 (funnel_pages[]) is intentionally NOT supported — see
 * ../docs/adr/002-drop-v41-spec-support.md. Inputs without `funnels[]` fail
 * the structural assertion below.
 */

import type { CampaignSpec } from './types.ts'
import { upgradeCampaignSpec } from './checkout-flow.ts'

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

  // v4 → v5: retype each `checkout` that forwards to another `checkout` as
  // `checkout_step` (campaigns-os#641). Returns a copy; the input is untouched.
  return upgradeCampaignSpec(obj) as unknown as CampaignSpec
}
