# Campaign Standardization Report

The Campaign Standardization Report is a read-only repo audit for modern CPK
campaigns. It inventories source structure, Campaign Cart SDK version, Page Kit
dependency version, Campaigns OS artifact presence, built output, and the next
safe remediation category without editing the target campaign repo.

Run it against either a Page Kit root or a parent `*-cpk` repo that may contain
one or more Page Kit roots:

```bash
campaigns-os standardize --target /path/to/example-cpk --json
campaigns-os standardization-report --target /path/to/example-cpk --family olympus-mv-single-step --slug example --json
```

By default, the command prints markdown for operators. Use `--json` for agents
or dashboards. When a built `_site` exists and a template family is explicit or
can be found in `.campaign-runtime`, the command also runs the existing
`doctor --built` checks and folds those findings into the report. Use
`--no-doctor` to keep the run to source/runtime inventory only.

## Schema

Top-level shape:

```json
{
  "schema_version": "campaign-standardization-report/v0",
  "generated_at": "2026-07-06T00:00:00.000Z",
  "target_repo": "/path/to/example-cpk",
  "status": "ready_with_warnings",
  "ok": true,
  "summary": {
    "root_count": 1,
    "blockers": 0,
    "warnings": 2,
    "operator_readiness": 1,
    "blocked_roots": 0,
    "warning_roots": 1,
    "ready_roots": 0
  },
  "roots": [],
  "errors": [],
  "recommendation": {
    "home": "staged_split",
    "summary": "Keep the read-only source/runtime scanner in public campaigns-os first; layer private repo discovery, issue creation, and merchant ops context in an internal campaign-ops wrapper."
  }
}
```

Each root contains these sections:

- `identity`: repo name, Page Kit root, slug inventory, SDK versions, Page Kit
  dependency, template family evidence, Campaigns OS artifact presence, and
  built-site presence.
- `source_structure`: HTML/page/include/layout counts, Liquid helper counts,
  raw blocks, document wrappers, hardcoded root asset refs, unreadable files,
  and payment-method include detection.
- `runtime_contract`: `data-next-*` anchor summary, checkout/upsell/receipt
  surface signals, package/shipping refs, source manifest presence, and
  `.campaign-runtime` inventory.
- `built_output`: built page inventory, slug-scope resolution state, and
  optional built-output doctor result.
- `findings`: normalized blocker, warning, and operator-readiness items with
  evidence and next action.
- `remediation`: safe agent repairs, clarification needed, product or merchant
  risks, and proof commands.

## Finding Taxonomy

`standardization_blocker` means an agent should not assume the repo is portable
or standard without repair. Current blockers include missing or invalid
`_data/campaigns.json`, Liquid raw blocks, and built-output doctor errors.

`standardization_warning` means the repo can be inspected but may drift from the
modern CPK contract. Current warnings include older SDK/Page Kit versions,
missing Campaigns OS artifacts, hardcoded `/assets/...` refs, page-level
document wrappers, unreadable source files, missing `campaign_asset`, missing
`data-next-*` anchors, and tentative payment-method include gaps.

`operator_readiness` means the repo may be technically inspectable but lacks
proof or business context. Current readiness items include missing built output,
unknown or tentative template family, missing source-html manifest, unresolved
built slug, and unknown production proof.

## Home Recommendation

Use a staged split:

- Put the read-only scanner, schema, markdown formatter, and built-output doctor
  integration in public `campaigns-os`.
- Put private repo discovery, sample-set selection, merchant launch context,
  issue creation, and workbench UI surfacing in an internal campaign-ops wrapper.

This keeps the portable contract close to the existing Campaigns OS doctor while
leaving private operational workflow outside the public package.

## First Follow-Up Backlog

- Add schema validation once the artifact shape settles across more repos.
- Add explicit template-family evidence from CampaignSpec and Build Packet when
  those artifacts are present.
- Replace crude payment-method include detection with family contract checks.
- Add optional `--output <path>` for durable JSON/markdown output.
- Add repo-set orchestration in an internal campaign-ops wrapper for private
  sample sets and follow-up generation.
- Add waiver support for intentional one-off template deviations.
