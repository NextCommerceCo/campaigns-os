# Campaign Standardization Report

Status: READY_WITH_WARNINGS
Target: samples/wundercool-cpk
Generated: 2026-07-06T15:50:56.353Z

## Summary
- Page Kit roots: 1
- Findings: 0 blocker(s), 1 warning(s), 3 operator-readiness item(s)
- Home recommendation: staged_split - Keep the read-only source/runtime scanner in public campaigns-os first; layer private repo discovery, issue creation, and merchant ops context in an internal campaign-ops wrapper.

## arcticclip

### Identity
- Status: READY_WITH_WARNINGS
- Slug(s): arcticclip
- SDK: 0.4.25
- Page Kit: next-campaign-page-kit ^0.1.1
- Template family: (unknown) (unknown)
- Campaigns OS artifacts: no
- Built _site: no

### Source Structure
- HTML files: 168; pages: 32; includes: 133; layouts: 3
- Helpers: campaign_asset=166, campaign_include=440, campaign_link=80
- Raw blocks: 0; document wrappers in pages: 0; hardcoded /assets refs: 0; unreadable files: 0
- Payment methods include: detected

### Runtime Contract
- data-next anchors: 640 occurrence(s), 52 unique attribute(s)
- Package refs: 76; shipping refs: 18
- Source manifest: missing

### Built Output
- Built pages: 0
- Doctor: skipped (no built _site found)

### Findings
- [warning] campaigns_os.artifacts_missing: No .campaign-runtime artifacts were found for this root.
- [operator_readiness] campaigns_os.source_manifest_missing: No source-html manifest was found; Figma/source producer provenance is not confirmed.
- [operator_readiness] built_output.site_missing: No built _site directory was found; built-output doctor was skipped.
- [operator_readiness] template_family.unknown: Template family is unknown; family-specific source and built-output checks remain tentative.

### Remediation
Safe agent repairs:
- none
Clarification needed:
- Find CampaignSpec/Map ID or source-html manifest before relying on provenance.
- Confirm the template family from CampaignSpec or Campaigns OS artifacts.
Product or merchant risks:
- none
Proof commands:
- campaigns-os standardize --target samples/wundercool-cpk/arcticclip --json
