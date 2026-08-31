# Versioning

This repo uses independent compatibility versions:

- package version: `0.1.0-alpha.0`
- Build Packet: `campaign-runtime-build-packet/v0`
- Build Context: `campaign-runtime-build-context/v0`
- Assembly Report: `campaign-runtime-assembly-report/v0`
- Design Source Package: `campaign-design-source-package/v0`
- Workflow Finding: `campaigns-os-workflow-finding/v0`
- QA Verdict: `campaigns-os-qa-verdict/v0` (JSON Schema:
  `schemas/campaigns-os-qa-verdict.v0.schema.json`; the emitted
  `schema_version` field is the literal `"1.0"` — it predates the
  slash-versioned naming and the portal receiver validates that same literal,
  so the emitted value cannot change without a breaking shape change)
- QA Verdict sidecar projection: same `"1.0"` literal, projection guarantees in
  `schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json` (one contract, two
  schema files — the sidecar is an allowlist projection, never a second lineage)
- CampaignSpec: `4.2`–`4.3` (JSON Schema: `schemas/campaign-spec.v4.schema.json`)
- starter-template agent contract: `1`
- commerce surface catalog: `2`
- Tooling Orientation: `campaigns-os-tooling-orientation/v1`
- Release Ledger: `campaigns-os-release-ledger/v1`
- agent-relevant change policy: `1.0.0` (`contracts/agent-relevant-change-policy.v1.json`)
- orientation reason-code vocabulary: `1.0.0` (`contracts/orientation-reason-codes.v1.json`)
- orientation limits: `1.0.0` (`contracts/orientation-limits.v1.json`)

The orientation line is separate from the supported-surface line on purpose: a
consumer needs to know about an agent-relevant change even when
`surface_version` did not move. `contracts/release-ledger.json` records those,
`CHANGELOG.md` narrates them, and the two are checked against each other in both
directions. Reason codes and semantic classes are append-only vocabularies —
renaming or removing one is a breaking change. Raising a limit advances
`limits_version` and owes its own ledger entry.

Breaking packet semantics should create a new packet schema version. Non-breaking doctor warnings can ship in package patch/minor releases during developer preview.
