# Polish evidence schema (`stages.polish.evidence`)

This is the authoritative, docs-side description of what the polish gate
(`evaluatePolishGate` in `src/polish-gate.mjs`) accepts **today**. The gate is
evaluated by `campaigns-os next polish|deploy|qa`, by `qa run`, and by doctor;
a blocked gate surfaces as a `polish.*` error and stops QA handoff. Everything
below documents existing behavior — if this document and the code disagree, the
code wins and this file has drifted (a test in `src/polish-gate.test.mjs`
pins the required-field list and blocker codes to this file).

Three layers must all be satisfied:

1. **The stage record** — `stages.polish` on the Assembly Report
   (`.campaign-runtime/assembly-report.json`) with the freshness/identity
   fields below.
2. **The evidence block** — `stages.polish.evidence` (legacy fallback:
   `report.polish.evidence`) with the seven required categories, three of which
   also get semantic content checks.
3. **Package-owned page-load evidence** —
   `stages.polish.evidence.visual_review.page_load`, produced only by
   `campaigns-os polish capture` from the current packet, report, served build,
   mapped routes, and fixed desktop/mobile viewports.

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
| `visual_review` | **Object** with a `screenshots` array (accepted aliases for the array key: `screenshot_paths`, `paths`, `urls`) containing at least one non-empty string, plus package-generated `page_load`. A bare string, an object without a screenshot array, or an empty array all fail. The gate's shape check accepts a single screenshot entry; the `next-campaigns-polish` responsibility bar is desktop **and** mobile captures of the key commerce anchors — record both. Never hand-author `page_load`. |
| `brand_review` | Non-empty object (semantic checks in §3 apply: `favicon`, `brand_bleed`). |
| `checkout_review` | Non-empty object (semantic checks in §3 apply: `field_labels`, `bump_compare_price_rule`). |
| `template_residue_review` | Non-empty object/array/string (semantic check on `starter_favicon` in §3). |
| `commerce_flow_review` | Non-empty string, non-empty array, or non-empty object. |
| `issues` | **Must be an array.** An empty array is the canonical "no issues found". A missing field, string, or object fails. |
| `commands` | Non-empty array with at least one string or object entry — the commands the polish pass actually ran. Must not include build commands (§1). |

For fields without a stricter rule above, "non-empty" means: array with ≥1
entry, object with ≥1 key, or non-empty string.

### 2.1 Package-owned page-load evidence

Install the package-owned Chromium runtime, serve the current build, then run
the producer before marking `stages.polish` complete, deploying, or starting
QA:

```bash
npm run qa:install-browser
campaigns-os polish capture \
  --packet campaign-runtime.build.json \
  --base-url http://127.0.0.1:4173
```

The command derives every mapped, non-skipped Page Kit route from the packet
and captures each at desktop `1440x1200` and mobile `390x844`. It re-reads the
packet and Assembly Report after the browser pass, refuses attachment if the
governing build, campaign, route plan, report identity, or existing `page_load`
changed before that final read, and otherwise merges only
`stages.polish.evidence.visual_review.page_load` onto the report it just read.
The temp-file-plus-rename write prevents readers from seeing torn JSON. This is
optimistic two-read conflict detection, not a lock, compare-and-swap, or true
no-clobber write: another writer can still change the report in the narrow
interval between the final read and rename. Keep one Assembly Report writer at
a time and retry from the newest report after a conflict. Screenshots and every
unrelated report field from the final read are preserved.

`--base-url` is the operator-provided location of the served current build. The
producer binds its evidence to the packet/report build fingerprint, campaign,
and deterministic route plan, but it does not cryptographically attest that the
bytes served at that URL came from that build. Point it at the current output;
do not reuse an older preview merely because its routes match. Incomplete
evidence is still persisted for diagnosis, returns a nonzero status, and never
marks Polish complete.

The optional real-browser smoke is separate from the workflow producer:

```bash
npm run smoke:polish-capture
```

Run it only after `npm run qa:install-browser` in an environment that permits a
loopback HTTP listener and Chromium. It is deliberately opt-in and is not part
of `npm run check` or CI.

### Durable `page_load` field map

The `page_load` object is generated by the package and must not be hand-authored,
copied between builds, or repaired in place. Its stable projection is:

| Path | Meaning |
|---|---|
| `schema_version`, `performed_by`, `threshold_bytes` | Page-load format, package producer identity, and the `1,048,576`-byte finding threshold. |
| `subject.build_fingerprint`, `subject.campaign_slug` | Build and campaign authority copied from the current packet/report pair. |
| `subject.route_scope`, `subject.routes[]`, `subject.viewports[]` | Deterministic mapped-route scope (`all` or `selected`), normalized routes, and fixed `desktop` / `mobile` viewport keys. |
| `measurement.status` | `complete` only when the subject is valid and every expected route/viewport has exactly one complete capture. |
| `measurement.expected_capture_count`, `measurement.captured_count` | Planned and recorded capture totals. |
| `measurement.missing[]`, `measurement.duplicate[]`, `measurement.unexpected[]`, `measurement.incomplete[]` | Route/viewport coverage defects. Each incomplete entry carries its sorted `problem_codes[]`. |
| `captures[]` | One deterministic package projection per route and viewport; see the per-capture map below. |
| `findings[]` | Observed hidden eager-media findings. Each records `code`, route, viewport, tag and element index, bounded `sources[]` / `resource_ids[]` with their full counts, a fingerprint over the complete resource-identity set, transferred and threshold bytes, preload state, and `hidden_by[]`. |

Each `captures[]` entry has this shape:

| Path | Meaning |
|---|---|
| `schema_version`, `performed_by` | Route-capture format and package producer identity. |
| `subject.build_fingerprint`, `subject.campaign_slug`, `subject.requested_route`, `subject.final_document_route`, `subject.viewport` | Exact authority and navigation binding for this observation. A final-route mismatch is incomplete evidence. |
| `measurement_status`, `producer_status` | Overall completeness and whether the browser producer itself completed. |
| `response_collection.status`, `observed_response_count`, `unattributed_response_count` | CDP response-collection outcome and bounded counts. |
| `document_response.status`, `document_response.url`, `document_response.resource_id`, `document_response.http_status`, `document_response.mime_type` | Safe final main-document projection. Completeness requires exactly one root final-document response with HTTP `200` and HTML or XHTML MIME. |
| `document_response.context_fingerprint`, `document_response.capture_origin`, `document_response.final_origin`, `document_response.origin_matches_capture` | Hashed browser document context and same-origin redirect binding. Raw frame/loader IDs are never persisted. |
| `metrics.total_transferred_bytes`, `metrics.request_count`, `metrics.largest_resource` | Totals over retained ledger entries; `largest_resource` carries only resource ID, redacted URL, type, bytes, and request count. |
| `metrics.cross_origin_request_count`, `metrics.cache_request_count`, `metrics.service_worker_request_count` | Counts used to expose cross-origin traffic and completeness-invalidating cache/service-worker observations. |
| `networkidle.status`, `networkidle.duration_ms` | `settled`, `timeout`, or `invalid`. Duration starts immediately before navigation and ends when network-idle settles or times out; it is evidence timing, not a performance SLA. |
| `media_collection.status` and count fields | `observed_element_count`, `failed_element_count`, `omitted_element_count`, `source_overflow_element_count`, and `ancestor_overflow_element_count` explain complete, partial, or failed DOM measurement. |
| `media[]` source fields | `tag_name`, `element_index`, `current_src`, `src_attribute`, `source_src_attributes[]`, `observed_source_urls[]`, and normalized `source_references[]` retain the initial and post-network-idle source history needed for resource attribution. |
| `media[]` state and transfer fields | `preload_attribute`, `preload_defers_fetch`, `hidden_at_load`, `hidden_by[]`, `zero_size_at_load`, `fetched_bytes`, `fetched_request_count`, and bounded `fetched_resources[]`. Zero-size geometry is evidence only, not hidden-state proof. |
| `resource_ledger.limit`, `total_resource_count`, `omitted_resource_count`, `omitted_request_count` | Ledger bound and explicit overflow totals. Any omission makes the capture incomplete. |
| `resource_ledger.entries[]` | Safe URL/resource identity, type and type status, transferred/request/unmeasured/failed/partial/cross-origin/cache/service-worker counts, HTTP statuses, and match-resource IDs. Queries, fragments, credentials, headers, cookies, bodies, and raw protocol records are excluded. |
| `problems[]` | Sorted `{ code, count }` completeness defects. Any entry forces `measurement_status: "incomplete"`. |
| `integrity.schema_version`, `algorithm`, `association_fingerprint`, `projection_fingerprint` | Versioned SHA-256 tamper-evidence for the deterministic projection and media/resource joins. These checks detect accidental or partial mutation; they are not a keyed signature. |

Transfer accounting retains the greater of the terminal CDP encoded length and
the cumulative `Network.dataReceived` encoded-byte count. A slow, failed, or
unfinished transfer can therefore contribute an observed lower bound even when
the terminal measurement is unavailable. The associated collection/failure
problem still makes the capture incomplete; findings may remain visible for
diagnosis, but incomplete measurement cannot pass or be waived.

Bounds are part of the evidence semantics: at most 128 packet route mappings,
4,096 response records, 2,048 resource-ledger entries, 512 media elements, 32
child-source attributes and 32 observed source-history URLs per element, 64
ancestor styles per element, and 8,192 characters per captured URL. A
route-plan overflow aborts before capture. Other overflow is recorded through
counts/sentinels and a problem code, then blocks as incomplete rather than
silently truncating into a pass.

The owned checkpoint is `polish.hidden_eager_media`. A finding requires one
computed-hidden `video` or `audio` element whose aggregate transferred bytes are
strictly greater than `1,048,576`. `display:none` or `visibility:hidden` on the
element or an ancestor counts as hidden. Zero-size geometry is evidence only.
Exact ASCII-case-insensitive `preload="none"` and `preload="metadata"` defer the
finding; surrounding whitespace does not. Visible media and media exactly at
the threshold pass this checkpoint.

Measurement completeness is nonwaivable. Missing/malformed evidence, a stale
build/campaign/route/viewport binding, final-document route mismatch, integrity
mismatch, unfinished or failed transfers, cache/service-worker observations,
unjoinable media sources, and resource-ledger contradictions all block until a
fresh capture succeeds. URLs in persisted resources and findings drop query,
fragment, credentials, headers, cookies, bodies, and raw CDP/DOM records.

Only a complete real finding is waivable. The decision binds the current build,
slug, route scope, routes, fixed viewports, and stable finding state:

```bash
campaigns-os checkpoint waive \
  --packet campaign-runtime.build.json \
  --gate polish.hidden_eager_media \
  --reason "<why this exact finding is accepted>" \
  --waived-by "<named human>" \
  --review-condition "<specific re-evaluation trigger>"
```

Changing the finding, build, slug, routes, or viewports makes the decision
inert. An active decision stays visible as `waived` / `ready_with_waivers`; it
never becomes a clean pass.

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
| `polish.waiver_expires_at_invalid` | A source freshness waiver has an unparseable `expires_at`. Fix or remove the waiver record (§5). |
| `polish.evidence_missing` | No `stages.polish` stage, or status neither completed nor blocked. Run next-campaigns-polish. |
| `polish.blocked` | Polish itself recorded `status: blocked`. Resolve its blockers. |
| `polish.self_certified` | `performed_by` is not `next-campaigns-polish`, or the record mentions build commands. |
| `polish.source_build_fingerprint_missing` | Evidence not tied to any build fingerprint. |
| `polish.stale` | Evidence tied to an older build fingerprint. Re-run polish. |
| `polish.source_package_material_fingerprint_missing` | Evidence not tied to the current source package fingerprint. |
| `polish.source_package_stale` | Source package changed after polish. Re-run polish. |
| `polish.completed_at_missing` | No completion timestamp on stage or evidence. |
| `polish.evidence_incomplete` | One or more §2/§3 problems; the `problems` array names each. |
| `polish.hidden_eager_media.capture_malformed` | Package capture is missing/malformed, or packet/report authority is inconsistent. Repair authority when named, then capture again. |
| `polish.hidden_eager_media.capture_stale` | Page-load evidence is bound to a different build, campaign, route scope, route set, or viewport set. Recapture. |
| `polish.hidden_eager_media.capture_incomplete` | One or more required route/viewport measurements failed completeness. Repair the named capture problem and recapture; this is not waivable. |
| `polish.hidden_eager_media` | Complete evidence contains hidden eager media strictly above the threshold. Repair and recapture, or record an exact named-human checkpoint waiver. |
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
`review_condition`). When `expires_at` is present it must be a parseable
timestamp (ISO 8601): an unparseable value blocks the gate with
`polish.waiver_expires_at_invalid`, and an expiry at or before the evaluation
instant means the waiver is **not** honored (the boundary is inclusive — do
not record the current run timestamp as `expires_at`; give the waiver real
headroom). An expired waiver means the freshness block fires as if no waiver
were recorded
(the verdict names the expired waiver so a fresh one can be recorded
deliberately). Waived runs pass with status `waived`, never silently.

## 6. Complete passing example

The hand-authored portion below is completed first. Run `campaigns-os polish
capture` to attach the versioned `visual_review.page_load` object; that package
artifact is intentionally not reproduced as editable JSON here.

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
