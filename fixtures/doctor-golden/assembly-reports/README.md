# Saved Assembly Reports (pre-refactor, #730 milestone 1)

These are captures from `campaigns-os` at base `e1c5bc9c6dc2745d6f2bd54f37f89319ce7f915a`, before the doctor shared-input refactor in #730. `src/change-scope-v1-reports.test.mjs` regenerates the same sequence in a temp dir and compares the result with these files.

The fixture is the synthetic recorded campaign from `src/page-only-change.test.mjs`. The test drives the real `recordStageCommand` with a fixed clock (step N records at minute N of `2026-11-01T00:00Z`), so nothing in a capture is normalized. Each step runs on the state the previous step left:

| File | Step |
|---|---|
| `01-initial-record-build.json` | first `record build`; signature computed, no `build_changes` |
| `02-copy-only-landing.json` | landing copy edit: `page_only` |
| `03-css-asset-added.json` | `assets/site.css` added: `unmapped_file` |
| `04-checkout-copy-edit.json` | checkout copy edit: `checkout_page` |
| `05-upsell-package-ref.json` | upsell package ref 12 to 14: `commerce_markup_changed` |
| `06-config-and-output-change.json` | `_data/campaigns.json` entry and landing copy changed: `campaign_config_changed` |
| `07-unchanged-rebuild.json` | `record build` with no output change; `build_changes` kept |
| `08-pre-1-62-rebuild.json` | `commerce_signature` deleted, receipt copy edit, `record build`: pathless `commerce_signature_unavailable` |
| `09-record-baseline.json` | `record baseline` over that rebuild |
| `10-post-baseline-copy-only.json` | landing copy edit after the baseline: `page_only`, QA owes scope `pages` read from the baseline build |
| `11-second-baseline-refused.json` | a second `record baseline`: refused (one per funnel), report left byte for byte as it was |

Each file holds:

- `base_sha`, `step`, `description`, `recorded_at` and `record_command`
- `assembly_report`: the full `.campaign-runtime/assembly-report.json` after the step
- `evidence_debt_changes`: `assessEvidenceDebt(...).changes` after the step
- `change_since`: `changeSince` for four anchors: the seeded build, the previous step's build, Polish's `owed_since_build_fingerprint` and the QA evidence build
- `readback_evidence_debt`: `readback --json`'s `evidence_debt`
- `before_record`: the same change list and `changeSince` read after the edit but before the record. This is the drift that `classifyDrift` sees on disk.
- `refusal` (step 11 only): the refusal message `record baseline` throws.

The test compares each capture with its file as parsed values first, for a readable diff, and then byte for byte, so key order and formatting are part of what is pinned. It also checks after every step that `assembly-report.json` is written as two-space JSON with a trailing newline.

No temp-dir path appears in any capture. The test would replace one with `<fixture>`.

**Refactor PRs must not regenerate these files.** If output differs, the refactor has changed behavior. Regenerate only for a deliberate behavior change that has been reviewed, and read the diff. `UPDATE_GOLDEN` must be exactly `1`, and regeneration refuses uncommitted non-test changes under `src/`. The commit it runs on (`HEAD`) is written into each file's `base_sha`, and the test then fails until `BASE_SHA` in the test and the base named above are updated to match:

```sh
UPDATE_GOLDEN=1 node --test src/change-scope-v1-reports.test.mjs
```
