# Release-ledger authoring guide

Every agent-relevant change to this repository gets one entry in
`contracts/release-ledger.json`. This is how you write one, and what CI will do
to you if you do not.

If you are an agent reading this repository rather than changing it, you want
[`AGENTS.md`](../AGENTS.md) and
[`docs/orientation-contract-reference.md`](orientation-contract-reference.md)
instead.

## Why a ledger as well as a changelog

`CHANGELOG.md` is keyed to the supported-surface version. That misses a whole
class of change that a downstream agent very much cares about: a renamed CLI
flag, a rewritten contract doc, a new or reworded skill, a changed
generated-runtime input, a widened compatibility statement. None of those need
touch a hashed file, so none of them move `surface_version`, so an agent reading
only the changelog concludes nothing happened.

The ledger records those. The changelog stays the human narrative, and each
ledger entry links to exactly one changelog section so the two can never tell
different stories.

## What counts as agent-relevant

One definition, one file: `contracts/agent-relevant-change-policy.v1.json`. The
classifier, the gate, the generated reference, and every test read it. There is
no second copy to keep in sync, and you should not make one.

It defines ten semantic classes — `schema`, `hashed_surface`, `named_surface`,
`cli_surface`, `skill`, `package_export`, `compatibility_policy`,
`documentation`, `workflow`, `generated_runtime` — and classifies a changed path
in a fixed, total order:

1. **Self-referential exemptions.** `contracts/release-ledger.json` and
   `CHANGELOG.md`. Recording a change is not itself a recorded change.
2. **Explicit rules.** Ordered, first match wins.
3. **Derived from the supported surface.** Every path in `hashed{}` or `named[]`
   is agent-relevant by construction. This pass runs *before* the ignore list on
   purpose: a path you just added to the supported surface must never be
   swallowed by a broad ignore prefix like `docs/` or `contracts/`.
4. **Ignored, with a stated reason.** "No agent impact" is an assertion someone
   wrote down, not an omission someone forgot.
5. **Unclassified — an error.** A path matching nothing fails the gate. The
   classifier fails closed, which means adding a new top-level file makes you
   say what it is.

## Writing an entry

```jsonc
{
  "id": "RL-0007",              // never reused, never renumbered
  "sequence": 7,                // exactly one more than the last entry
  "date": "2026-09-01",         // not earlier than the last entry
  "kind": "release",            // or "amendment"
  "surface_version": "1.15.0",  // null for a same-surface change
  "changelog_section": "1.15.0",
  "changelog_sha256": "<sha256 of that section body>",
  "agent_impact": "What a consumer must do differently. 'None.' is fine — but write it.",
  "compatibility": "compatible | additive | breaking",
  "migration": "The exact action, or \"none\". A breaking entry may not say none.",
  "changes": [
    {
      "class": "named_surface",
      "path": "docs/build-packet.md",
      "surface_entry": "docs/build-packet.md",
      "summary": "One sentence, written for a consumer."
    }
  ],
  "entry_sha256": "<sha256 of this entry with entry_sha256 removed>"
}
```

Two hashes, two jobs. `changelog_sha256` catches a changelog section edited
after the fact. `entry_sha256` catches a historical entry edited in place, even
in a squashed history where the diff is gone.

Computing them:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parseChangelogSections, entryHash } from "./scripts/orientation-contract.mjs";
const section = parseChangelogSections(readFileSync("CHANGELOG.md", "utf8"))
  .find((s) => s.section_id === "1.15.0");
console.log("changelog_sha256:", section.body_sha256);
'
```

Then add the entry with that `changelog_sha256`, and compute `entry_sha256` the
same way with `entryHash(entry)`.

### Same-surface changes

Set `surface_version` to `null` and link a changelog section identified as
`<current-version>+agent.<n>` — for example `1.14.0+agent.1`. It sorts at the
same version, so nobody reads it as a release that did not happen, and it gives
the entry a real section to point at.

### Path-less change items

A CLI flag has no file of its own. Record it with `"path": null` and name the
affected `surface_entry` (the command). The gate still requires that some
classified path of the same class changed in the range, so a flag change cannot
be recorded without the bytes actually moving somewhere.

### Amendments

Historical entries are never edited. When an entry turns out to be wrong or
incomplete, append a correction:

```jsonc
{
  "id": "RL-0008",
  "sequence": 8,
  "kind": "amendment",
  "amends": "RL-0007",
  "amendment_reason": "RL-0007 was recorded as compatible; it removed a documented guarantee.",
  "surface_version": null,
  "changelog_section": "1.15.0+agent.1",
  "compatibility": "breaking",
  "migration": "Stop relying on the removed guarantee; see docs/build-packet.md.",
  "agent_impact": "Treat the 1.15.0 packet doc change as breaking, not compatible.",
  "changes": [ /* … */ ]
}
```

An amendment is the only entry kind whose change items may map to no changed
path in its own range, because it corrects meaning rather than moving bytes.

## Running the gate

```bash
node ./scripts/check-release-ledger.mjs                    # structure, hashes, limits
node ./scripts/check-release-ledger.mjs --base origin/main # the two-way gate
```

Without `--base` the checker validates the ledger as it stands. The completeness
gate needs a comparison point, so pass `--base` in CI and before you open a PR.
`npm run check` runs the structural half.

## What passes and what fails

The authoritative matrix is data, not prose:
`contracts/fixtures/orientation/release-gate/cases.json`. Every case there is a
test in `scripts/check-release-ledger.test.mjs`. Add a case and you have added a
test.

Passes:

- A hashed schema changed, `surface_version` advanced, one entry claims it.
- A named contract doc changed with no surface bump, one entry with
  `surface_version: null` and a `+agent.N` changelog section.
- A CLI flag, a skill, a workflow, or the compatibility statement changed, same
  shape.
- Several changes in one entry, each path covered by exactly one change item.
- An amendment that maps to no changed path.

Fails:

- An agent-relevant path with no change item — the failure the gate exists for.
- A change item naming a path that did not change and is not an amendment.
- A change item claiming an implementation path the policy excludes.
- A duplicate entry id, or one entry recording the same `(class, path,
  surface_entry)` identity twice. Identity is unique WITHIN an entry, not across
  the ledger: a path is touched by many releases over a repository's life, and
  each of those is a real change that must be recordable. Recording one change
  twice inside a single range is caught by the coverage rule instead — a path
  covered by more than one change item fails.
- A sequence gap, or a date earlier than the previous entry.
- A `breaking` entry whose migration is `none`, or a blank `agent_impact`.
- A missing changelog section, a duplicate section identifier, or a stale
  `changelog_sha256`.
- A stale `entry_sha256`.
- Any commit-shaped property on an entry — see below.
- A rewritten or deleted historical entry.
- Two entries claiming the same `surface_version`.
- A changed path the policy has never seen.
- A supported-surface bump that no new entry claims.
- A path-less change item with no classified change of its class in the range.
- An amendment with no `amends`, an `amends` naming no earlier entry, or no
  `amendment_reason`; or a non-amendment carrying either field.

Only entries NEW in the comparison range are classified against the current
policy and supported surface. A historical entry was written under the policy in
force at the time and the ledger is append-only, so re-judging it under a
tightened policy would fail a document nobody is permitted to edit. Everything
else — shape, ordering, sequence, hashes, changelog correspondence — applies to
every entry.

## Entries carry no commit

An entry cannot name the commit containing it without being rewritten after that
commit exists. The schema rejects any commit-shaped property, and the checker
says so by name rather than reporting a generic "unexpected property".

A consumer derives the introducing commit from history at the target OID:
oldest-first over the commits touching the ledger, crediting each entry id to the
first commit whose ledger blob contains it. Merge commits are handled by that
walk without a special case.

The walk covers the FULL history ending at the target, with history
simplification disabled (`git rev-list --full-history --reverse --topo-order
<oid> -- contracts/release-ledger.json`). A walk that starts at some base loses
every entry introduced before it; a simplified walk can drop the side-branch
commit that actually introduced an entry. `AGENTS.md` states both properties for
consumers.

## Size bounds

`contracts/orientation-limits.v1.json` bounds what a consumer reads: source
bytes, section count, section bytes, envelope bytes, ledger entries. Exceeding
one is a refusal with `orientation_too_large`, never a truncation. So is a
measurement that is absent or non-finite: a bound nobody measured is a bound
nobody enforced.

Every bound is a whole-artifact guardrail — the complete changelog and the
complete ledger at the target commit, not a baseline-to-target window. That is
the conservative direction, since a window is always a subset of the whole. Two
of them (section count, ledger entries) grow monotonically; when one is reached
the answer is baseline rotation, described in the contract's `_growth_note`, not
a quiet raise.

Raising a limit is a reviewed policy change: advance `limits_version`, and the
change owes its own ledger entry like anything else.
