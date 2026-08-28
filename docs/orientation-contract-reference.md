# Orientation contract reference

<!--
  GENERATED FILE — do not edit by hand.
  Source: scripts/generate-orientation-reference.mjs, from
    schemas/campaigns-os-tooling-orientation.v1.schema.json
    schemas/campaigns-os-release-ledger.v1.schema.json
    contracts/agent-relevant-change-policy.v1.json
    contracts/orientation-reason-codes.v1.json
    contracts/orientation-limits.v1.json
    contracts/supported-surface.json
  Regenerate: node ./scripts/generate-orientation-reference.mjs --write
  CI runs the same script with --check, so a stale copy of this file fails the build.
-->

This is the normative reference for `campaigns-os-tooling-orientation/v1`: every enum,
stable reason code, deterministic remedy, size bound, and terminal-outcome example a
consumer needs in order to orient on a Campaigns OS commit **without executing any
Campaigns OS code**. Start at [`AGENTS.md`](../AGENTS.md) for the reading order and the
supported-versus-internal boundary; this file is the field guide.

Schema id: `campaigns-os-tooling-orientation/v1`  
Ledger schema id: `campaigns-os-release-ledger/v1`  
Change policy version: `1.0.0`  
Reason-code vocabulary version: `1.0.0`  
Limits version: `1.0.0`  
Supported surface at generation time: `1.14.0`

## Terminal outcomes

Every orientation run ends on exactly one disposition. The eight below are the complete set;
an unknown value fails closed at the consumer.

| Disposition | Example envelope |
|---|---|
| `current` | [`contracts/fixtures/orientation/envelope/current.json`](../contracts/fixtures/orientation/envelope/current.json) |
| `orientation_available` | [`contracts/fixtures/orientation/envelope/orientation_available.json`](../contracts/fixtures/orientation/envelope/orientation_available.json) |
| `updated` | [`contracts/fixtures/orientation/envelope/updated.json`](../contracts/fixtures/orientation/envelope/updated.json) |
| `restart_required` | [`contracts/fixtures/orientation/envelope/restart_required.json`](../contracts/fixtures/orientation/envelope/restart_required.json) |
| `recovered_interrupted_update` | [`contracts/fixtures/orientation/envelope/recovered_interrupted_update.json`](../contracts/fixtures/orientation/envelope/recovered_interrupted_update.json) |
| `legacy_baseline` | [`contracts/fixtures/orientation/envelope/legacy_baseline.json`](../contracts/fixtures/orientation/envelope/legacy_baseline.json) |
| `freshness_unknown` | [`contracts/fixtures/orientation/envelope/freshness_unknown.json`](../contracts/fixtures/orientation/envelope/freshness_unknown.json) |
| `refused` | [`contracts/fixtures/orientation/envelope/refused.json`](../contracts/fixtures/orientation/envelope/refused.json) |

## Stable reason codes

Append-only vocabulary. Each code has one meaning, one deterministic remedy, and one owning
test id. `owner` says which repository's suite is obliged to exercise it: a `campaigns-os`
code is exercised by this repository's contract tests, a `campaigns-agent` code by the
consumer's parser tests.

| Reason code | Outcomes | Owner | Test id | Meaning | Remedy |
|---|---|---|---|---|---|
| `ahead_of_upstream` | `refused` | campaigns-agent | `TP-D4-ahead-of-upstream` | The checkout carries commits the upstream default branch does not, so its contracts are not a published generation. | Push or drop the local commits, or run against a managed generation at the published OID. |
| `already_current` | `current` | campaigns-agent | `TP-B3-already-current` | The verified target equals the active generation; nothing changed and no restart is required. | None. |
| `checkout_acquisition_failed` | `refused` | campaigns-agent | `TP-D1-acquisition-failed` | Managed acquisition did not complete: interrupted clone, remote validation failure, or a broken linked-worktree backpointer. Partial state is quarantined, never exposed as ready. | Rerun acquisition. If it fails repeatedly, inspect the quarantined partial named in the diagnostic and confirm remote reachability. |
| `checkout_already_exists` | `refused` | campaigns-agent | `TP-D1-checkout-already-exists` | The managed root reserved for acquisition appeared concurrently and is not an empty reservation this run owns. | Rerun so the existing root is validated as a managed store, or remove the unexpected directory after confirming it holds no needed state. |
| `checkout_missing` | `refused` | campaigns-agent | `TP-D1-checkout-missing` | No checkout exists at the configured location and the mode does not authorize acquiring one. | Supply the operator checkout at the configured path, or switch to managed mode so a generation can be acquired. |
| `checkout_mutation_not_authorized` | `refused` | campaigns-agent | `TP-D4-mutation-not-authorized` | The requested action would write to an operator-supplied checkout, which is always inspect-only. | Switch to managed mode, or perform the change yourself in the operator checkout. No flag grants this authority. |
| `detached_head` | `refused` | campaigns-agent | `TP-D4-detached-head` | The checkout's HEAD is detached, so there is no branch to compare against the expected branch. | Check out the expected branch, or declare the checkout managed so orientation supplies its own generation. |
| `dirty_checkout` | `refused` | campaigns-agent | `TP-D4-dirty-checkout` | The operator-supplied checkout has uncommitted worktree or index changes, so its bytes are not the bytes of any commit. | Commit or stash the local changes, or run against a managed generation. Orientation never writes to an operator checkout to clean it. |
| `diverged_history` | `refused` | campaigns-agent | `TP-D3-diverged-history` | The checkout and the upstream default branch have diverged; neither is an ancestor of the other. | Reconcile the branch with upstream by hand. Orientation refuses rather than choosing a side. |
| `evidence_budget_exceeded` | `refused` | campaigns-agent | `TP-F-evidence-budget-exceeded` | Bounded operator-state evidence storage would be exceeded by this run's records. | Let retention prune, or raise the evidence budget as a reviewed policy change. Orientation refuses rather than launching a session it cannot audit. |
| `fetch_failed` | `freshness_unknown`, `refused` | campaigns-agent | `TP-D2-fetch-failed` | The bounded freshness fetch did not complete: offline, DNS failure, timeout, or authentication failure. | Restore network access and rerun. The prior verified generation is left intact and no launch proceeds under strict-latest policy. |
| `git_environment_unsafe` | `refused` | campaigns-agent | `TP-D2-hostile-git-config` | Ambient Git configuration could change command behavior: hooks, aliases, pagers, credential prompts, external diff or merge helpers, or filesystem monitors. | Rerun through the supported launcher, which runs Git under an explicit environment and config allowlist. Do not disable the allowlist. |
| `history_incomplete` | `refused` | campaigns-agent | `TP-B2-shallow-history` | The reviewed baseline commit or an entry's introducing commit is not reachable in the available history, typically a shallow clone. | Deepen the clone to include the reviewed baseline, or adopt a newer reviewed baseline that is present. |
| `missing_upstream` | `refused` | campaigns-agent | `TP-D4-missing-upstream` | The checkout's current branch has no upstream tracking ref, so ahead/behind cannot be computed. | Set the branch upstream to the expected remote branch, or use managed mode. |
| `orientation_contract_missing` | `refused` | campaigns-agent | `TP-G-orientation-contract-missing` | The target commit predates campaigns-os-tooling-orientation/v1 and carries no orientation contract, and it is not the one reviewed legacy baseline. | Target a commit that ships the orientation contract, or declare the exact reviewed legacy baseline for the one-time attended migration path. |
| `orientation_in_progress` | `refused` | campaigns-agent | `TP-D3-orientation-in-progress` | Another process holds the orientation lock for this target. | Wait for the holder named in the diagnostic to finish, or clear a stale lock after confirming its owner process is gone. |
| `orientation_incomplete` | `refused` | campaigns-os | `A1-orientation-incomplete` | The target commit declares an agent-relevant change that no release-ledger entry covers, or a ledger entry that maps to no classified change and no reviewed amendment. The two-way release gate is not satisfied at that commit. | At the target commit, add the missing ledger change item, or add a reviewed amendment entry. The refusal names the uncovered path or the orphaned change identity. Never weaken the classifier to pass. |
| `orientation_rendered` | `orientation_available`, `updated`, `restart_required`, `legacy_baseline` | campaigns-agent | `TP-B3-orientation-rendered` | A complete orientation envelope was assembled and rendered without mutating anything. | None. Read the envelope's release_ledger and changelog groups to see what changed since the reviewed baseline. |
| `orientation_too_large` | `refused` | campaigns-os | `A1-orientation-too-large` | A declared limit in contracts/orientation-limits.v1.json was exceeded: source bytes, section count, section bytes, envelope bytes, or ledger entries. | Adopt a newer reviewed baseline so the window is smaller, or raise the limit as a reviewed policy change that advances limits_version and carries its own ledger entry. Orientation refuses; it never truncates. |
| `pointer_race` | `refused` | campaigns-agent | `TP-E2-pointer-race` | The active generation pointer changed between read and compare-and-swap. | Rerun. The transaction is safe to retry; the prior generation stays active until a swap succeeds. |
| `runtime_commit_mismatch` | `refused` | campaigns-agent | `TP-E2-runtime-commit-mismatch` | Source, skills, and command-line bytes in the candidate generation do not all resolve to one commit. | Discard the candidate generation and prepare a fresh one. A session is never bound to a mixed-commit generation. |
| `runtime_refresh_failed` | `refused` | campaigns-agent | `TP-E1-runtime-refresh-failed` | The declared preparation recipe ran and did not produce a verifiable generated runtime. | Read the recorded recipe output in the run evidence. The prior verified generation remains active and usable. |
| `runtime_refresh_required` | `restart_required`, `refused` | campaigns-agent | `TP-E1-runtime-refresh-required` | The generated runtime is absent or does not match its source fingerprint at the target commit. | Let the launcher prepare a fresh generation, which runs the declared preparation recipe in isolation. Never rebuild in place over an active generation. |
| `surface_incompatible` | `refused` | campaigns-agent | `TP-G-surface-incompatible` | The target supported-surface version falls outside the consumer's accepted supported_surface_range. | Upgrade the consumer to a build whose accepted range covers the target, or pin a reviewed baseline inside the current range. |
| `transaction_incomplete` | `refused` | campaigns-agent | `TP-E3-transaction-incomplete` | A prior promotion transaction was interrupted and its record cannot be reconciled to a safe terminal state. | Inspect the promotion record named in the diagnostic. The prior verified generation stays active; no partial generation is promoted. |
| `transaction_reconciled` | `recovered_interrupted_update` | campaigns-agent | `TP-E3-transaction-reconciled` | An interrupted promotion transaction was found and completed or rolled back deterministically on this run. | None. This is an informational terminal state; the reconciliation outcome is recorded in run evidence. |
| `wrong_remote` | `refused` | campaigns-agent | `TP-D2-wrong-remote` | The observed checkout's origin remote does not normalize to the expected owner/repository identity. | Point the checkout at the expected remote, or supply a checkout whose origin matches the manifest's remote_identity. The refusal names the expected identity. |

## Size bounds

Declared in [`contracts/orientation-limits.v1.json`](../contracts/orientation-limits.v1.json). Exceeding any bound is a refusal with
reason code `orientation_too_large`. Orientation **never truncates** — a partial view of a
release is worse than a refusal, because the consumer cannot tell which part it is missing.

| Limit | Value | Unit | Applies to | Rationale |
|---|---|---|---|---|
| `max_source_bytes` | 1048576 | bytes | The total bytes of orientation source read from Git objects at the target OID: release ledger, changelog, supported surface, and orientation contract data files. | 1 MiB. Measured at surface 1.13.0 the whole set is about 22 KB, so this is roughly 45x current headroom while still bounding a single read to something a consumer can hold in memory and hash without streaming. |
| `max_section_count` | 64 | sections | The number of changelog sections an orientation window may reference between the reviewed baseline and the target commit. | 8 sections existed at surface 1.13.0 across roughly one month of releases. 64 covers several years of the same cadence in one window, while still refusing an unbounded full-history narrative loaded into model context. |
| `max_section_bytes` | 65536 | bytes | The bytes of any single changelog section body. | 64 KiB. The largest section at surface 1.13.0 was 3.9 KB, so this is about 16x headroom. A single section larger than this is a drafting error, not a release worth orienting on in one read. |
| `max_envelope_bytes` | 262144 | bytes | The serialized orientation envelope handed to the consumer. | 256 KiB. Roughly 64k tokens worst case, which keeps a full orientation read inside a model context budget with room for the session's own work. Deliberately smaller than max_source_bytes: the envelope is a selection of source, not a copy of it. |
| `max_ledger_entries` | 256 | entries | The number of release-ledger entries an orientation window may carry between the reviewed baseline and the target commit. | The ledger holds 1 entry at limits_version 1.0.0. 256 bounds the window without forcing an amendment-heavy history to be re-baselined early; a consumer that exceeds it should adopt a newer reviewed baseline rather than read further back. |

## Semantic change classes

Defined once in [`contracts/agent-relevant-change-policy.v1.json`](../contracts/agent-relevant-change-policy.v1.json). Every agent-relevant change is recorded
under exactly one of these, and the classifier fails closed on a path that matches nothing.

| Class | Description |
|---|---|
| `schema` | A JSON Schema in schemas/ that a consumer validates artifacts against. |
| `hashed_surface` | A path recorded in contracts/supported-surface.json hashed{}; its bytes are pinned and a change owes a surface_version advance. |
| `named_surface` | A path recorded in contracts/supported-surface.json named[]; content may evolve but the path must keep existing. |
| `cli_surface` | A CLI command, subcommand, or flag reachable from the supported argv surface. |
| `skill` | A versioned skill package or its installer. |
| `package_export` | package.json exports, bin, files, engines, or the dependency/script set a consumer installs. |
| `compatibility_policy` | The published compatibility statement, the supported-surface manifest, or the documents that define surface discipline. |
| `documentation` | Agent-facing documentation of record: the agent entry point, contract references, and authoring guides. |
| `workflow` | A repository workflow or workflow contract that produces or gates a supported artifact. |
| `generated_runtime` | Sources or lockfiles for the generated runtime a consumer must prepare before use. |

Classifier evaluation order:

> Evaluation order is fixed and total: self_referential_exemptions -> rules -> derived_from_supported_surface -> ignored -> unclassified (an error). First match wins within each ordered list. match.kind is one of exact | prefix. A rule may carry match_suffix (the path must also end with it) and exclude[] (matches that make the rule NOT apply, so a narrower path falls through to a later rule or to ignored). The derived pass runs BEFORE ignored so that a path newly added to the supported surface can never be swallowed by a broad ignore prefix; that is the fail-closed direction.

## Schema enum inventory

Every enumerated value in both schemas, listed exactly once. A value that appears here and
nowhere in the schemas, or in the schemas and not here, is a generation failure.

### `schemas/campaigns-os-tooling-orientation.v1.schema.json`

| Location | Values |
|---|---|
| `properties.request.properties.checkout_mode` | `managed`, `operator_supplied` |
| `properties.request.properties.mutation_policy` | `observe_only`, `managed_update` |
| `properties.repository.properties.graph_relation` | `identical`, `behind`, `ahead`, `diverged`, `unknown` |
| `properties.freshness.properties.state` | `current`, `available`, `updated`, `unknown`, `refused` |
| `properties.surface.properties.compatibility_result` | `compatible`, `incompatible`, `unknown` |
| `properties.release_ledger.properties.entries.items.properties.kind` | `release`, `amendment` |
| `properties.release_ledger.properties.entries.items.properties.compatibility` | `compatible`, `additive`, `breaking` |
| `properties.runtime.properties.generated_state` | `absent`, `stale`, `fresh`, `corrupt`, `unknown` |
| `properties.runtime.properties.refresh_action` | `none`, `prepare_new_generation`, `refused` |
| `properties.transaction.properties.state` | `none`, `requested`, `intent_recorded`, `finalized`, `reconciled`, `failed` |
| `properties.limits.properties.exceeded.items` | `max_source_bytes`, `max_section_count`, `max_section_bytes`, `max_envelope_bytes`, `max_ledger_entries` |
| `$defs.baseline.properties.kind` | `legacy_commit`, `supported_surface` |
| `$defs.change_class` | `schema`, `hashed_surface`, `named_surface`, `cli_surface`, `skill`, `package_export`, `compatibility_policy`, `documentation`, `workflow`, `generated_runtime` |
| `$defs.disposition` | `current`, `orientation_available`, `updated`, `restart_required`, `recovered_interrupted_update`, `legacy_baseline`, `freshness_unknown`, `refused` |
| `$defs.reason_code` | `already_current`, `ahead_of_upstream`, `checkout_acquisition_failed`, `checkout_already_exists`, `checkout_missing`, `checkout_mutation_not_authorized`, `detached_head`, `dirty_checkout`, `diverged_history`, `evidence_budget_exceeded`, `fetch_failed`, `git_environment_unsafe`, `history_incomplete`, `missing_upstream`, `orientation_contract_missing`, `orientation_in_progress`, `orientation_incomplete`, `orientation_rendered`, `orientation_too_large`, `pointer_race`, `runtime_commit_mismatch`, `runtime_refresh_failed`, `runtime_refresh_required`, `surface_incompatible`, `transaction_incomplete`, `transaction_reconciled`, `wrong_remote` |

### `schemas/campaigns-os-release-ledger.v1.schema.json`

| Location | Values |
|---|---|
| `$defs.entry.properties.kind` | `release`, `amendment` |
| `$defs.entry.properties.compatibility` | `compatible`, `additive`, `breaking` |
| `$defs.change.properties.class` | `schema`, `hashed_surface`, `named_surface`, `cli_surface`, `skill`, `package_export`, `compatibility_policy`, `documentation`, `workflow`, `generated_runtime` |

## Supported CLI commands

The argv surface declared in [`contracts/supported-surface.json`](../contracts/supported-surface.json). Every command listed here
resolves in the CLI dispatch; the contract test asserts that against the real dispatch table,
so a renamed command fails here as well as at the supported-surface gate.

- `campaigns-os start`
- `campaigns-os prepare-build`
- `campaigns-os build`
- `campaigns-os polish`
- `campaigns-os checkpoint`
- `campaigns-os doctor`
- `campaigns-os standardize`
- `campaigns-os standardization-report`
- `campaigns-os qa`
- `campaigns-os findings`
- `campaigns-os run-record`
- `campaigns-os run`

## Terminal outcome examples

Generated from the same fixtures the contract tests validate, so an example can never drift
from the schema it claims to satisfy.

### `current`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "observe_only",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "1111111111111111111111111111111111111111",
    "commit_after": "1111111111111111111111111111111111111111"
  },
  "freshness": {
    "state": "current",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 420
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": "1.13.0",
    "current_version": "1.13.0",
    "compatibility_result": "compatible",
    "compatibility_rule": "target surface_version is inside the consumer's accepted_surface_range",
    "transitions": []
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": []
  },
  "changelog": {
    "sections": []
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "fresh",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "none",
    "ready": true
  },
  "transaction": {
    "state": "none",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "1111111111111111111111111111111111111111",
    "commit_observed": "1111111111111111111111111111111111111111",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "current",
    "reason_code": "already_current",
    "active_generation_changed": false,
    "fresh_exec_required": false,
    "next_actions": [
      "proceed"
    ]
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `orientation_available`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "observe_only",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "1111111111111111111111111111111111111111",
    "commit_after": "1111111111111111111111111111111111111111"
  },
  "freshness": {
    "state": "available",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 610
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": "1.14.0",
    "current_version": "1.13.0",
    "compatibility_result": "compatible",
    "compatibility_rule": "target surface_version is inside the consumer's accepted_surface_range",
    "transitions": [
      {
        "from": "1.13.0",
        "to": "1.14.0"
      }
    ]
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": [
      {
        "id": "RL-0001",
        "sequence": 1,
        "date": "2026-08-28",
        "kind": "release",
        "surface_version": "1.14.0",
        "changelog_section": "1.14.0",
        "changelog_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "compatibility": "additive",
        "migration": "none",
        "affected_surface_entries": [
          "contracts/release-ledger.json"
        ],
        "changes": [
          {
            "class": "named_surface",
            "path": "contracts/release-ledger.json",
            "surface_entry": "contracts/release-ledger.json",
            "summary": "The append-only agent-relevant release ledger was introduced."
          }
        ],
        "entry_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "introducing_commit": "2222222222222222222222222222222222222222"
      }
    ]
  },
  "changelog": {
    "sections": [
      {
        "section_id": "1.14.0",
        "date": "2026-08-28",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "migration_action": "none",
        "body_markdown": "## [1.14.0] - 2026-08-28\n\n### Added\n\n- The orientation contract and the agent-relevant release ledger.",
        "body_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
      }
    ]
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "fresh",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "none",
    "ready": true
  },
  "transaction": {
    "state": "none",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "1111111111111111111111111111111111111111",
    "commit_observed": "1111111111111111111111111111111111111111",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "orientation_available",
    "reason_code": "orientation_rendered",
    "active_generation_changed": false,
    "fresh_exec_required": false,
    "next_actions": [
      "review the release ledger",
      "request a managed update"
    ]
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `updated`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "managed_update",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "2222222222222222222222222222222222222222",
    "commit_after": "2222222222222222222222222222222222222222"
  },
  "freshness": {
    "state": "updated",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 610
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": "1.14.0",
    "current_version": "1.13.0",
    "compatibility_result": "compatible",
    "compatibility_rule": "target surface_version is inside the consumer's accepted_surface_range",
    "transitions": [
      {
        "from": "1.13.0",
        "to": "1.14.0"
      }
    ]
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": [
      {
        "id": "RL-0001",
        "sequence": 1,
        "date": "2026-08-28",
        "kind": "release",
        "surface_version": "1.14.0",
        "changelog_section": "1.14.0",
        "changelog_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "compatibility": "additive",
        "migration": "none",
        "affected_surface_entries": [
          "contracts/release-ledger.json"
        ],
        "changes": [
          {
            "class": "named_surface",
            "path": "contracts/release-ledger.json",
            "surface_entry": "contracts/release-ledger.json",
            "summary": "The append-only agent-relevant release ledger was introduced."
          }
        ],
        "entry_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "introducing_commit": "2222222222222222222222222222222222222222"
      }
    ]
  },
  "changelog": {
    "sections": [
      {
        "section_id": "1.14.0",
        "date": "2026-08-28",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "migration_action": "none",
        "body_markdown": "## [1.14.0] - 2026-08-28\n\n### Added\n\n- The orientation contract and the agent-relevant release ledger.",
        "body_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
      }
    ]
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "fresh",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "none",
    "ready": true
  },
  "transaction": {
    "state": "finalized",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "2222222222222222222222222222222222222222",
    "commit_observed": "2222222222222222222222222222222222222222",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "updated",
    "reason_code": "orientation_rendered",
    "active_generation_changed": true,
    "fresh_exec_required": true,
    "next_actions": [
      "start a fresh session against the promoted generation"
    ]
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `restart_required`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "observe_only",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "1111111111111111111111111111111111111111",
    "commit_after": "1111111111111111111111111111111111111111"
  },
  "freshness": {
    "state": "available",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 610
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": "1.14.0",
    "current_version": "1.13.0",
    "compatibility_result": "compatible",
    "compatibility_rule": "target surface_version is inside the consumer's accepted_surface_range",
    "transitions": [
      {
        "from": "1.13.0",
        "to": "1.14.0"
      }
    ]
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": [
      {
        "id": "RL-0001",
        "sequence": 1,
        "date": "2026-08-28",
        "kind": "release",
        "surface_version": "1.14.0",
        "changelog_section": "1.14.0",
        "changelog_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "compatibility": "additive",
        "migration": "none",
        "affected_surface_entries": [
          "contracts/release-ledger.json"
        ],
        "changes": [
          {
            "class": "named_surface",
            "path": "contracts/release-ledger.json",
            "surface_entry": "contracts/release-ledger.json",
            "summary": "The append-only agent-relevant release ledger was introduced."
          }
        ],
        "entry_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "introducing_commit": "2222222222222222222222222222222222222222"
      }
    ]
  },
  "changelog": {
    "sections": [
      {
        "section_id": "1.14.0",
        "date": "2026-08-28",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "migration_action": "none",
        "body_markdown": "## [1.14.0] - 2026-08-28\n\n### Added\n\n- The orientation contract and the agent-relevant release ledger.",
        "body_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
      }
    ]
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "stale",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "prepare_new_generation",
    "ready": false,
    "reason_code": "runtime_refresh_required"
  },
  "transaction": {
    "state": "none",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "1111111111111111111111111111111111111111",
    "commit_observed": "1111111111111111111111111111111111111111",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "restart_required",
    "reason_code": "runtime_refresh_required",
    "active_generation_changed": false,
    "fresh_exec_required": true,
    "next_actions": [
      "prepare a new generation",
      "start a fresh session"
    ]
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `recovered_interrupted_update`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "managed_update",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "2222222222222222222222222222222222222222",
    "commit_after": "2222222222222222222222222222222222222222"
  },
  "freshness": {
    "state": "updated",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 610
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": "1.14.0",
    "current_version": "1.13.0",
    "compatibility_result": "compatible",
    "compatibility_rule": "target surface_version is inside the consumer's accepted_surface_range",
    "transitions": [
      {
        "from": "1.13.0",
        "to": "1.14.0"
      }
    ]
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": [
      {
        "id": "RL-0001",
        "sequence": 1,
        "date": "2026-08-28",
        "kind": "release",
        "surface_version": "1.14.0",
        "changelog_section": "1.14.0",
        "changelog_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "compatibility": "additive",
        "migration": "none",
        "affected_surface_entries": [
          "contracts/release-ledger.json"
        ],
        "changes": [
          {
            "class": "named_surface",
            "path": "contracts/release-ledger.json",
            "surface_entry": "contracts/release-ledger.json",
            "summary": "The append-only agent-relevant release ledger was introduced."
          }
        ],
        "entry_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "introducing_commit": "2222222222222222222222222222222222222222"
      }
    ]
  },
  "changelog": {
    "sections": [
      {
        "section_id": "1.14.0",
        "date": "2026-08-28",
        "agent_impact": "A consumer may now read the orientation contract and release ledger from Git objects.",
        "migration_action": "none",
        "body_markdown": "## [1.14.0] - 2026-08-28\n\n### Added\n\n- The orientation contract and the agent-relevant release ledger.",
        "body_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
      }
    ]
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "fresh",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "none",
    "ready": true
  },
  "transaction": {
    "state": "reconciled",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "2222222222222222222222222222222222222222",
    "commit_observed": "2222222222222222222222222222222222222222",
    "recovered_interrupted_update": true,
    "reason_code": "transaction_reconciled"
  },
  "outcome": {
    "disposition": "recovered_interrupted_update",
    "reason_code": "transaction_reconciled",
    "active_generation_changed": true,
    "fresh_exec_required": true,
    "next_actions": [
      "start a fresh session against the reconciled generation"
    ]
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `legacy_baseline`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "operator_supplied",
    "mutation_policy": "observe_only",
    "baseline": {
      "kind": "legacy_commit",
      "commit": "1111111111111111111111111111111111111111"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "1111111111111111111111111111111111111111",
    "commit_after": "1111111111111111111111111111111111111111"
  },
  "freshness": {
    "state": "current",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 420
    }
  },
  "surface": {
    "reviewed_version": null,
    "target_version": null,
    "current_version": null,
    "compatibility_result": "unknown",
    "compatibility_rule": "the reviewed baseline predates supported surfaces; no version is fabricated for it",
    "transitions": []
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": []
  },
  "changelog": {
    "sections": []
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": null,
    "generated_state": "unknown",
    "emitter_commit": null,
    "refresh_action": "none",
    "ready": false
  },
  "transaction": {
    "state": "none",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "1111111111111111111111111111111111111111",
    "commit_observed": "1111111111111111111111111111111111111111",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "legacy_baseline",
    "reason_code": "orientation_rendered",
    "active_generation_changed": false,
    "fresh_exec_required": false,
    "next_actions": [
      "launch only the already verified operator-supplied checkout",
      "adopt a supported-surface baseline"
    ]
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `freshness_unknown`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "observe_only",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "unknown",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": null,
    "commit_after": "1111111111111111111111111111111111111111"
  },
  "freshness": {
    "state": "unknown",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": false,
      "duration_ms": 30000,
      "reason_code": "fetch_failed"
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": null,
    "current_version": "1.13.0",
    "compatibility_result": "unknown",
    "compatibility_rule": "no target was observed, so compatibility is not decidable",
    "transitions": []
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": []
  },
  "changelog": {
    "sections": []
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "fresh",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "none",
    "ready": true
  },
  "transaction": {
    "state": "none",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "1111111111111111111111111111111111111111",
    "commit_observed": "1111111111111111111111111111111111111111",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "freshness_unknown",
    "reason_code": "fetch_failed",
    "active_generation_changed": false,
    "fresh_exec_required": false,
    "next_actions": [
      "restore network access and rerun"
    ],
    "refusal_remedy": "Restore network access and rerun. The prior verified generation is left intact and no launch proceeds under strict-latest policy."
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 22024,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    }
  }
}
```

### `refused`

```json
{
  "schema_version": "campaigns-os-tooling-orientation/v1",
  "request": {
    "run_id": "run-example-0001",
    "checkout_mode": "managed",
    "mutation_policy": "observe_only",
    "baseline": {
      "kind": "supported_surface",
      "commit": "1111111111111111111111111111111111111111",
      "surface_version": "1.13.0"
    },
    "accepted_orientation_schemas": [
      "campaigns-os-tooling-orientation/v1"
    ],
    "accepted_surface_range": ">=1.13.0 <2.0.0",
    "manifest_sha256": "3333333333333333333333333333333333333333333333333333333333333333"
  },
  "repository": {
    "owner": "NextCommerceCo",
    "repository": "campaigns-os",
    "branch": "main",
    "upstream": "origin/main",
    "clean": true,
    "shallow": false,
    "graph_relation": "identical",
    "common_git_identity": "managed-store-0001",
    "worktree_identity": "generation-0001",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_fetched": "1111111111111111111111111111111111111111",
    "commit_after": "1111111111111111111111111111111111111111"
  },
  "freshness": {
    "state": "refused",
    "observed_at": "2026-08-28T00:00:00Z",
    "fetch_result": {
      "attempted": true,
      "succeeded": true,
      "duration_ms": 610
    }
  },
  "surface": {
    "reviewed_version": "1.13.0",
    "target_version": "1.13.0",
    "current_version": "1.13.0",
    "compatibility_result": "compatible",
    "compatibility_rule": "target surface_version is inside the consumer's accepted_surface_range",
    "transitions": []
  },
  "release_ledger": {
    "ledger_schema_version": "campaigns-os-release-ledger/v1",
    "entries": []
  },
  "changelog": {
    "sections": []
  },
  "runtime": {
    "recipe_id": null,
    "source_fingerprint": "3333333333333333333333333333333333333333333333333333333333333333",
    "generated_state": "fresh",
    "emitter_commit": "1111111111111111111111111111111111111111",
    "refresh_action": "none",
    "ready": true
  },
  "transaction": {
    "state": "none",
    "commit_before": "1111111111111111111111111111111111111111",
    "commit_target": "1111111111111111111111111111111111111111",
    "commit_observed": "1111111111111111111111111111111111111111",
    "recovered_interrupted_update": false
  },
  "outcome": {
    "disposition": "refused",
    "reason_code": "orientation_too_large",
    "active_generation_changed": false,
    "fresh_exec_required": false,
    "next_actions": [
      "adopt a newer reviewed baseline",
      "raise the limit as a reviewed policy change"
    ],
    "refusal_remedy": "Adopt a newer reviewed baseline so the window is smaller, or raise the limit as a reviewed policy change that advances limits_version and carries its own ledger entry. Orientation refuses; it never truncates."
  },
  "limits": {
    "limits_version": "1.0.0",
    "max_source_bytes": 1048576,
    "max_section_count": 64,
    "max_section_bytes": 65536,
    "max_envelope_bytes": 262144,
    "max_ledger_entries": 256,
    "applied": {
      "source_bytes": 1048577,
      "section_count": 8,
      "max_observed_section_bytes": 3903,
      "envelope_bytes": 4096,
      "ledger_entries": 1
    },
    "exceeded": [
      "max_source_bytes"
    ]
  }
}
```
