# Campaign Standardization Report

Status: READY_WITH_WARNINGS
Target: samples/uvbrite-cpk
Generated: 2026-07-06T15:50:50.819Z

## Summary
- Page Kit roots: 1
- Findings: 0 blocker(s), 1 warning(s), 0 operator-readiness item(s)
- Home recommendation: staged_split - Keep the read-only source/runtime scanner in public campaigns-os first; layer private repo discovery, issue creation, and merchant ops context in an internal campaign-ops wrapper.

## uvbrite-cpk (repo root)

### Identity
- Status: READY_WITH_WARNINGS
- Slug(s): beamplus
- SDK: 0.4.24
- Page Kit: next-campaign-page-kit ^0.0.9
- Template family: olympus-mv-single-step (operator_flag)
- Campaigns OS artifacts: yes
- Built _site: yes

### Source Structure
- HTML files: 54; pages: 9; includes: 43; layouts: 2
- Helpers: campaign_asset=324, campaign_include=67, campaign_link=18
- Raw blocks: 0; document wrappers in pages: 0; hardcoded /assets refs: 0; unreadable files: 0
- Payment methods include: detected

### Runtime Contract
- data-next anchors: 229 occurrence(s), 48 unique attribute(s)
- Package refs: 26; shipping refs: 8
- Source manifest: present

### Built Output
- Built pages: 9
- Doctor: skipped (--no-doctor was provided)

### Findings
- [warning] version.page_kit_below_preferred_cutoff: Page Kit dependency ^0.0.9 is below the preferred 0.1.1+ sample cutoff.

### Remediation
Safe agent repairs:
- none
Clarification needed:
- none
Product or merchant risks:
- Version bumps can affect SDK/Page Kit runtime behavior; confirm against campaign QA scope before changing.
Proof commands:
- campaigns-os standardize --target samples/uvbrite-cpk --json
- campaigns-os doctor --built samples/uvbrite-cpk --family olympus-mv-single-step --slug beamplus --json
