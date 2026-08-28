# Campaigns OS — agent entry point

You are probably an agent, or the tooling in front of one, trying to answer a
single question: **is it safe to work against this commit of Campaigns OS, and
what changed since the commit I last reviewed?**

This file is the canonical answer. It tells you what to read, in what order,
which paths you may depend on, and how to orient without running anything from
this repository.

## The rule that shapes everything else

**Do not execute Campaigns OS code to decide whether to trust Campaigns OS.**

A target cannot supply its own trust decision. Everything you need to orient is
declarative data, readable straight out of Git objects at a resolved commit:
JSON contracts, a release ledger, a changelog, and JSON Schemas. No install, no
build, no checkout hooks, no CLI invocation. Reading a blob is safe; running a
script the target controls is not, however harmless the script looks.

`contracts/fixtures/orientation/hostile-target/` exists so you can prove your
reader honors this. It is a miniature target carrying Git hooks, an executable
script, and npm lifecycle scripts, each of which records a hit and exits 0. A
conforming orientation read of it produces a normal envelope and zero hits.

## Canonical reading order

Read these at one immutable commit OID. Resolve the OID once and use it for
every read, so nothing shifts under you mid-orientation.

| # | Path | What it answers |
|---|---|---|
| 1 | `contracts/supported-surface.json` | What may I depend on, and at what surface version? |
| 2 | `contracts/release-ledger.json` | What agent-relevant changes happened, in order? |
| 3 | `CHANGELOG.md` | The human narrative each ledger entry links to, one-to-one. |
| 4 | `contracts/orientation-limits.v1.json` | How much am I allowed to read before refusing? |
| 5 | `contracts/orientation-reason-codes.v1.json` | What may I report, and what is the remedy for each? |
| 6 | `schemas/campaigns-os-tooling-orientation.v1.schema.json` | The envelope shape I must produce. |
| 7 | `schemas/campaigns-os-release-ledger.v1.schema.json` | The ledger shape I am reading. |
| 8 | `contracts/agent-relevant-change-policy.v1.json` | What this repository counts as agent-relevant, and why a path was excluded. |
| 9 | `docs/orientation-contract-reference.md` | Every enum, reason code, remedy, bound, and a worked example per terminal outcome. |

Apply the limits from step 4 **before** you finish assembling. Exceeding one is
a refusal with reason code `orientation_too_large`. Never truncate: a partial
view of a release is worse than no view, because you cannot tell which part you
are missing.

## Supported versus internal

`contracts/supported-surface.json` is the machine authority and
[`docs/supported-surface.md`](docs/supported-surface.md) is its prose twin.

- **Supported** — the `hashed{}` map, the `named[]` list, `cli_commands`,
  `package_exports`, and `bin`. You may pin these, verify their bytes, and build
  behavior on them. A change here is versioned, and it is loud.
- **Internal** — everything else: `src/**`, `scripts/**`, `examples/**`,
  `prompts/**`, `agents/**`, and `contracts/**` other than the entries the
  manifest names. Read them for context if you like. Never depend on them. A
  consumer manifest that pins an internal path is invalid, and it will break
  without notice or ceremony.

The orientation artifacts you consume are all on the supported surface: the
ledger, the three contract files, both schemas, the changelog, this file, the
generated reference, the authoring guide, and the fixtures under
`contracts/fixtures/orientation/envelope/` and
`contracts/fixtures/orientation/hostile-target/`.

Anything under `contracts/fixtures/` that the manifest does *not* name is this
repository's own test data. It is not yours to depend on.

## Releases are recorded twice, deliberately

`CHANGELOG.md` alone is not enough for you. It moves when the surface version
moves, and a great many changes that matter to an agent — a renamed CLI flag, a
rewritten contract doc, a new skill, a changed runtime input — leave the surface
version untouched.

So every agent-relevant change also gets a **release-ledger** entry, and the two
are checked against each other in both directions by
`scripts/check-release-ledger.mjs`:

1. Every agent-relevant changed path has exactly one ledger change item.
2. Every ledger change item maps to a classified change, or belongs to an
   explicit reviewed amendment.
3. A supported-surface version change owes exactly one entry and one changelog
   section.
4. History is append-only. A correction ships as a new amendment entry;
   rewriting an old one fails CI.

Authoring rules and worked pass/fail examples:
[`docs/release-ledger-authoring-guide.md`](docs/release-ledger-authoring-guide.md).

### Ledger entries carry no commit, on purpose

An entry cannot name the commit that contains it without being rewritten after
that commit exists, which is exactly the after-the-fact editing the append-only
rule forbids. The schema rejects any commit-shaped property.

Derive the introducing commit yourself, from history at the target OID: walk the
commits that touched `contracts/release-ledger.json` oldest-first and credit each
entry id to the first commit whose ledger blob contains it. Merge commits need
no special case. If an entry arrived on a side branch, that commit is credited;
if it was first assembled while resolving a merge, the merge commit is. Both are
the truthful answer.

## Mixed versions and the legacy boundary

You and this repository are not upgraded at the same moment, so decide
explicitly rather than optimistically.

- **Unknown orientation schema id** — fail closed. Do not attempt a partial
  parse of a contract you do not understand.
- **Unknown additive fields inside `campaigns-os-tooling-orientation/v1`** —
  accept and ignore. `v1` is allowed to grow.
- **Unknown enum value in a safety-critical position** (a disposition, a reason
  code, a compatibility result) — fail closed. Silently coercing an unrecognized
  refusal into a success is the worst available outcome.
- **A commit with no orientation contract** — that commit predates this contract.
  Report `orientation_contract_missing` and refuse, unless it is the exact
  baseline your operator reviewed, in which case report `legacy_baseline` and
  proceed only against the checkout that was already verified. Never fabricate a
  `surface_version` for a commit that predates supported surfaces.
- **Target surface outside your accepted range** — `surface_incompatible`.
  Upgrade yourself, or pin a reviewed baseline inside your range.

## The axes are independent

Report integrity, freshness, compatibility, runtime readiness, and orientation
separately. Collapsing them into one boolean is how a session ends up bound to a
checkout that is source-current and runtime-stale, or contract-compatible and
three releases behind.

The envelope keeps them apart by construction: `repository` and `request` carry
integrity, `freshness` carries currency, `surface` carries compatibility,
`runtime` carries generated-artifact readiness, and `release_ledger` plus
`changelog` carry orientation. `outcome` is the single terminal disposition you
reached, not a summary that overwrites the axes.

## Generated runtime

This repository builds `campaign-spec/dist` through its ordinary Node dependency
and build flow. Source freshness is **not** runtime readiness: a checkout can be
at the right commit with absent or stale generated output.

The `runtime` group is where you report that. Preparation happens in a fresh,
not-yet-active generation and never in place over a generation something is
already using. The declarative preparation recipe contract is a separate change
and is not published yet; until it is, `runtime.recipe_id` is `null` and you
determine readiness from the source fingerprint and the generated state.

## Human entry points

- [`README.md`](README.md) — what this toolkit is.
- [`CONTEXT.md`](CONTEXT.md) — the build flow in one page.
- [`docs/supported-surface.md`](docs/supported-surface.md) — the compatibility
  promise, in prose.
- [`docs/versioning.md`](docs/versioning.md) — the independent version lines.
