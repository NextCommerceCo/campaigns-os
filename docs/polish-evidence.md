# Polish evidence schema (`stages.polish.evidence`)

This is the authoritative, docs-side description of what the polish gate
(`evaluatePolishGate` in `src/polish-gate.mjs`) accepts **today**. The gate is
evaluated by `campaigns-os next polish|deploy|qa`, by `qa run`, and by doctor;
a blocked gate surfaces as a `polish.*` error and stops QA handoff. Everything
below documents existing behavior — if this document and the code disagree, the
code wins and this file has drifted (a test in `src/polish-gate.test.mjs`
pins the required-field list and blocker codes to this file).

Two layers must both be satisfied:

1. **The stage record** — `stages.polish` on the Assembly Report
   (`.campaign-runtime/assembly-report.json`) with the freshness/identity
   fields below.
2. **The evidence block** — `stages.polish.evidence` (legacy fallback:
   `report.polish.evidence`) with the seven required categories, three of which
   also get semantic content checks.

## 1. Stage-record requirements

The gate only applies once assembly is complete
(`stages.assembly.status` starts with `completed`); before that it returns
`polish.not_applicable`.

| Field | Accepted locations | Requirement |
|---|---|---|
| `status` | `stages.polish.status` | Must start with `completed`. `blocked` → `polish.blocked`; anything else → `polish.evidence_missing`. |
| `performed_by` | `stages.polish.performed_by`, `stages.polish.command_identity`, `evidence.performed_by` | Must be exactly `next-campaigns-polish`. Anything else (including missing) → `polish.self_certified`. |
| `commands` | `stages.polish.commands` and/or `evidence.commands` | Must NOT mention a build command anywhere — a polish record that ran build is self-certification → `polish.self_certified`. The matcher is exactly the strings `next-campaigns-build` and `campaigns-os next build` (case-insensitive); other build tooling (e.g. page-kit's `campaign-build`) is not matched. |
| `source_build_fingerprint` | `stages.polish.source_build_fingerprint` or `evidence.source_build_fingerprint` | Required, and must equal the current build fingerprint (`stages.assembly.build_fingerprint`, falling back to `stages.assembly.artifact_fingerprint`, `report.build_fingerprint`, `report.artifact_fingerprint`). Missing → `polish.source_build_fingerprint_missing`; different → `polish.stale`. |
| `source_package_material_fingerprint` | `stages.polish.source_package_material_fingerprint` or `evidence.source_package_material_fingerprint` | Only enforced when the report carries a current Design Source Package material fingerprint (`design_source_package.material_fingerprint` or equivalents). Missing → `polish.source_package_material_fingerprint_missing`; different → `polish.source_package_stale`. |
| `completed_at` | `stages.polish.completed_at` or `evidence.completed_at` | Required non-empty timestamp string → else `polish.completed_at_missing`. |

Assembly itself must also be tied to the current Design Source Package when one
is fingerprinted: `stages.assembly.source_package_material_fingerprint` missing
→ `polish.assembly_source_package_fingerprint_missing`; different →
`polish.assembly_source_package_stale`. Both can be waived (see §5).

## 2. Required evidence categories

`stages.polish.evidence` must be an object containing **all seven** fields.
A missing or shape-invalid field produces `polish.evidence_incomplete` with a
per-field problem line.

| Field | Accepted shape (presence check) |
|---|---|
| `visual_review` | **Object** with a `screenshots` array (accepted aliases for the array key: `screenshot_paths`, `paths`, `urls`) containing at least one non-empty string. A bare string, an object without a screenshot array, or an empty array all fail. The gate's shape check accepts a single entry; the `next-campaigns-polish` responsibility bar is desktop **and** mobile captures of the key commerce anchors — record both. |
| `brand_review` | Non-empty object (semantic checks in §3 apply: `favicon`, `brand_bleed`). |
| `checkout_review` | Non-empty object (semantic checks in §3 apply: `field_labels`, `bump_compare_price_rule`). |
| `template_residue_review` | Non-empty object/array/string (semantic check on `starter_favicon` in §3). |
| `commerce_flow_review` | Non-empty string, non-empty array, or non-empty object. |
| `issues` | **Must be an array.** An empty array is the canonical "no issues found". A missing field, string, or object fails. |
| `commands` | Non-empty array with at least one string or object entry — the commands the polish pass actually ran. Must not include build commands (§1). |

For fields without a stricter rule above, "non-empty" means: array with ≥1
entry, object with ≥1 key, or non-empty string.

## 3. Semantic content checks

Three categories are read, not just presence-checked. The gate flattens every
string/number/boolean inside the value and pattern-matches the joined text —
so **affirm the cleared outcome; do not echo the residue tokens you removed**
(describing deleted residue reads as residue).

Everywhere free text is scanned, an explicit negative — `not found`,
`none found`, `not present`, `no starter …` / `no template …` — reads as
clean.

### 3.1 `brand_review.favicon` — the authoritative certification shape

A **structured certification record is authoritative** and skips the free-text
leak scan entirely:

```jsonc
"favicon": { "byte_match": true, "status": "matched_source" }
```

Accepted certification: `byte_match: true`, **or** `status` (alias `result`)
equal to one of:

- `matched_source` — built favicon byte-matches a prepared-source favicon
- `promoted_source` — a source favicon was promoted into the build
- `confirmed_non_template` — verified not the starter/template favicon
- `no_source_candidate` — the prepared source ships no favicon candidate
  (documented outcome, not a pass-by-omission)

Escape semantics: without a certifying record, the favicon value's free text is
scanned for starter-favicon leakage (`starter/template favicon
found|present|matched|leaked|retained|kept|remaining`, or the literal starter
path `images/favicon.png`). A certified record may safely *mention* the starter
path (e.g. "replaced assets/images/favicon.png"); free-text-only evidence may
not.

When the Build Brief sets `template_residue_policy.block_template_favicon:
true`, the favicon evidence must certify (structured record above, or free text
that affirms a source/brand match, a promoted source, a confirmed
non-template favicon, or "no source candidate"). In that mode
`byte_match: false` is an explicit block **even when an accepted `status` is
also present** — the two checks are independent, so when byte comparison is
inapplicable (e.g. `no_source_candidate`), omit `byte_match` rather than
recording `false`. The policy flag lives at
`report.build_brief.artifact.template_residue_policy.block_template_favicon`;
when it is absent or false, only the leak-text scan applies.

### 3.2 `template_residue_review.starter_favicon`

Same certification shape and same leak scan as §3.1: a certifying record
(`byte_match: true` / accepted `status`) is authoritative; otherwise the text
must not indicate starter-favicon leakage.

### 3.3 `checkout_review` structured fields

Two entries are required inside `checkout_review`:

- **`field_labels`** (aliases: `initial_field_hints`, `visible_labels`) —
  confirm the initial checkout field labels/placeholders/hints are legible.
  Missing → blocked. Text indicating `missing`, `absent`, `blank`,
  `unlabeled`, `placeholder-stripped`, or `not legible` → blocked.
- **`bump_compare_price_rule`** (alias: `bump_compare_price`) — confirm no
  order-bump renders an equal / no-discount compare (strike-through) price.
  Missing → blocked. `equal_compare_price_found: true` or
  `same_price_compare_rendered: true` → blocked, as does free text reporting an
  equal/duplicate/no-discount compare price. Negations like "no equal compare
  price found" read as clean.

### 3.4 `brand_review.brand_bleed` (cloned-source de-brand pass)

Field precedence: `brand_bleed`, then aliases `brand_bleed_review`, `debrand`.
The field must exist; the canonical cleared form is an object with
`cleared: true` (accepted directly, no further text scan). `cleared: false`,
`bleed_found: true`, or `residual_found: true` block. Free-text evidence is
scanned per residue kind (promo/sale code or copy, prior-campaign favicon,
scaffold/non-design fonts, hardcoded non-token colors) — see the
`next-campaigns-polish` skill for the full recording guidance and pitfalls.

## 4. Blocker-code ladder (evaluation order)

The gate returns the **first** failing code; fix in this order.

| Code | Meaning / fix |
|---|---|
| `polish.report_missing` | No assembly report where one is required. Run the pipeline stages first. |
| `polish.not_applicable` | Assembly not complete yet (not a block). |
| `polish.build_fingerprint_missing` | Build never recorded `stages.assembly.build_fingerprint`. Re-run build. |
| `polish.assembly_source_package_fingerprint_missing` | Assembly not tied to the current Design Source Package. Re-run build (or waive, §5). |
| `polish.assembly_source_package_stale` | Source package changed after build. Re-run build (or waive, §5). |
| `polish.evidence_missing` | No `stages.polish` stage, or status neither completed nor blocked. Run next-campaigns-polish. |
| `polish.blocked` | Polish itself recorded `status: blocked`. Resolve its blockers. |
| `polish.self_certified` | `performed_by` is not `next-campaigns-polish`, or the record mentions build commands. |
| `polish.source_build_fingerprint_missing` | Evidence not tied to any build fingerprint. |
| `polish.stale` | Evidence tied to an older build fingerprint. Re-run polish. |
| `polish.source_package_material_fingerprint_missing` | Evidence not tied to the current source package fingerprint. |
| `polish.source_package_stale` | Source package changed after polish. Re-run polish. |
| `polish.completed_at_missing` | No completion timestamp on stage or evidence. |
| `polish.evidence_incomplete` | One or more §2/§3 problems; the `problems` array names each. |
| `polish.evidence_current` (pass) / `polish.assembly_source_package_waived` (waived) | Gate satisfied. |

## 5. Source-package freshness waiver

The two assembly-freshness blocks (§1) accept a recorded waiver on the report
(`report.waivers[]`, `report.assembly_source_package_freshness_waiver`, or
`report.source_package_freshness_waiver`). A waiver is only honored when it has
ALL of: a non-empty `reason`; a matching `scope`
(`assembly_source_package_freshness`, `source_package_after_build`,
`source_package_stale_after_build`) **or** an `applies_to[]` entry naming one of
the fingerprint fields/blocker codes; attribution (`waived_by` or `owner`); a
timestamp (`waived_at` or `created_at`); and a bound (`expires_at` or
`review_condition`). Waived runs pass with status `waived`, never silently.

## 6. Complete passing example

```jsonc
"stages": {
  "assembly": { "status": "completed", "build_fingerprint": "sha256:1f0a…33ee" },
  "polish": {
    "stage": "polish",
    "status": "completed",
    "performed_by": "next-campaigns-polish",
    "source_build_fingerprint": "sha256:1f0a…33ee",
    "completed_at": "2026-08-02T17:40:00Z",
    "evidence": {
      "visual_review": {
        "screenshots": [
          ".campaign-runtime/polish/landing-desktop.png",
          ".campaign-runtime/polish/checkout-mobile.png"
        ],
        "notes": "desktop + mobile commerce anchors compared against prepared source"
      },
      "brand_review": {
        "favicon": { "byte_match": true, "status": "matched_source" },
        "brand_bleed": { "cleared": true, "promo_codes": "none", "fonts": "design fonts only", "colors": "tokenized" }
      },
      "checkout_review": {
        "field_labels": "initial card/email/address hints legible in native-looking controls",
        "bump_compare_price_rule": { "equal_compare_price_found": false, "note": "bump shows discounted vs compare price" }
      },
      "template_residue_review": {
        "starter_favicon": { "byte_match": true, "status": "matched_source" },
        "copy": "starter headings replaced from prepared source; placeholder scan clean"
      },
      "commerce_flow_review": "bundle selector single-select verified; express wallet mount present; upsell wiring untouched",
      "issues": [],
      "commands": ["campaigns-os next polish --packet campaign-runtime.build.json"]
    }
  }
}
```

If a Design Source Package fingerprint exists on the report, also record
`source_package_material_fingerprint` on the stage (or evidence) with the
current value.

Polish evidence certifies the polish pass only — it is not QA and does not
certify launch readiness (`docs/qa-and-test-orders.md` owns the QA proof
stack).
