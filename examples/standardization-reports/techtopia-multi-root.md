# Campaign Standardization Report

Status: READY_WITH_WARNINGS
Target: samples/techtopia-cpk
Generated: 2026-07-06T15:50:56.391Z

## Summary
- Page Kit roots: 2
- Findings: 0 blocker(s), 6 warning(s), 6 operator-readiness item(s)
- Home recommendation: staged_split - Keep the read-only source/runtime scanner in public campaigns-os first; layer private repo discovery, issue creation, and merchant ops context in an internal campaign-ops wrapper.

## buzzdefense

### Identity
- Status: READY_WITH_WARNINGS
- Slug(s): buzzdefense
- SDK: 0.4.18
- Page Kit: next-campaign-page-kit ^0.1.0
- Template family: (unknown) (unknown)
- Campaigns OS artifacts: no
- Built _site: no

### Source Structure
- HTML files: 49; pages: 7; includes: 39; layouts: 3
- Helpers: campaign_asset=320, campaign_include=44, campaign_link=20
- Raw blocks: 0; document wrappers in pages: 0; hardcoded /assets refs: 0; unreadable files: 0
- Payment methods include: detected

### Runtime Contract
- data-next anchors: 648 occurrence(s), 54 unique attribute(s)
- Package refs: 85; shipping refs: 18
- Source manifest: missing

### Built Output
- Built pages: 0
- Doctor: skipped (no built _site found)

### Findings
- [warning] campaigns_os.artifacts_missing: No .campaign-runtime artifacts were found for this root.
- [operator_readiness] campaigns_os.source_manifest_missing: No source-html manifest was found; Figma/source producer provenance is not confirmed.
- [operator_readiness] built_output.site_missing: No built _site directory was found; built-output doctor was skipped.
- [warning] version.sdk_below_preferred_cutoff: Campaign Cart SDK 0.4.18 is below the preferred 0.4.20+ sample cutoff.
- [warning] version.page_kit_below_preferred_cutoff: Page Kit dependency ^0.1.0 is below the preferred 0.1.1+ sample cutoff.
- [operator_readiness] template_family.unknown: Template family is unknown; family-specific source and built-output checks remain tentative.

### Remediation
Safe agent repairs:
- none
Clarification needed:
- Find CampaignSpec/Map ID or source-html manifest before relying on provenance.
- Confirm the template family from CampaignSpec or Campaigns OS artifacts.
Product or merchant risks:
- Version bumps can affect SDK/Page Kit runtime behavior; confirm against campaign QA scope before changing.
Proof commands:
- campaigns-os standardize --target samples/techtopia-cpk/buzzdefense --json

## hydronozzle

### Identity
- Status: READY_WITH_WARNINGS
- Slug(s): hydronozzle
- SDK: 0.4.18
- Page Kit: next-campaign-page-kit ^0.0.9
- Template family: (unknown) (unknown)
- Campaigns OS artifacts: no
- Built _site: no

### Source Structure
- HTML files: 38; pages: 7; includes: 29; layouts: 2
- Helpers: campaign_asset=174, campaign_include=43, campaign_link=15
- Raw blocks: 0; document wrappers in pages: 0; hardcoded /assets refs: 0; unreadable files: 0
- Payment methods include: detected

### Runtime Contract
- data-next anchors: 584 occurrence(s), 53 unique attribute(s)
- Package refs: 72; shipping refs: 9
- Source manifest: missing

### Built Output
- Built pages: 0
- Doctor: skipped (no built _site found)

### Findings
- [warning] campaigns_os.artifacts_missing: No .campaign-runtime artifacts were found for this root.
- [operator_readiness] campaigns_os.source_manifest_missing: No source-html manifest was found; Figma/source producer provenance is not confirmed.
- [operator_readiness] built_output.site_missing: No built _site directory was found; built-output doctor was skipped.
- [warning] version.sdk_below_preferred_cutoff: Campaign Cart SDK 0.4.18 is below the preferred 0.4.20+ sample cutoff.
- [warning] version.page_kit_below_preferred_cutoff: Page Kit dependency ^0.0.9 is below the preferred 0.1.1+ sample cutoff.
- [operator_readiness] template_family.unknown: Template family is unknown; family-specific source and built-output checks remain tentative.

### Remediation
Safe agent repairs:
- none
Clarification needed:
- Find CampaignSpec/Map ID or source-html manifest before relying on provenance.
- Confirm the template family from CampaignSpec or Campaigns OS artifacts.
Product or merchant risks:
- Version bumps can affect SDK/Page Kit runtime behavior; confirm against campaign QA scope before changing.
Proof commands:
- campaigns-os standardize --target samples/techtopia-cpk/hydronozzle --json
