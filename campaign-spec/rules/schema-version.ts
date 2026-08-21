/**
 * SchemaVersion — requires spec.schema_version and validates it against the
 * supported lineage matrix.
 *
 * The missing-value message text is inherited verbatim from the pre-#110
 * validator at migration time so the strangler swap was bit-for-bit invisible
 * to callers; the wording is now canonical. Membership validation against
 * SUPPORTED_SCHEMA_VERSIONS is the strict layer added on top: an unsupported
 * lineage errors here at authoring/export time instead of surfacing as
 * downstream shape drift.
 *
 * SUPPORTED_SCHEMA_VERSIONS must stay identical to the schema_version enum in
 * schemas/campaign-spec.v4.schema.json (and compatibility.json's campaign_spec
 * range). The rule stays pure (no filesystem), so the constant duplicates the
 * schema enum — the sync test in ../test/rules/schema-version.test.ts is the
 * drift gate, following the UnknownTopLevelFields pattern.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

/** Supported CampaignSpec lineage versions — keep in sync with the v4 JSON Schema enum. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = Object.freeze(['4.2', '4.3'])

export const SchemaVersion: Rule = {
  id: 'SchemaVersion',
  severity: 'error',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    if (!spec.schema_version) {
      return [
        {
          ruleId: 'SchemaVersion',
          severity: 'error',
          message: 'Missing schema_version',
          path: '/schema_version',
        },
      ]
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(spec.schema_version)) {
      return [
        {
          ruleId: 'SchemaVersion',
          severity: 'error',
          message:
            `Unsupported schema_version ${JSON.stringify(spec.schema_version)}. ` +
            `Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
          path: '/schema_version',
          data: {
            value: spec.schema_version,
            supported: [...SUPPORTED_SCHEMA_VERSIONS],
            check: 'schema-version-supported',
          },
        },
      ]
    }
    return []
  },
}
