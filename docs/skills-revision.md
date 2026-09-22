# Skills bundle revision

The five skills Campaigns OS bundles are installed into shared agent skill
directories and then **read into an agent's context once**, at the start of a
task. They are not re-read afterwards. The CLI underneath that session, however,
can be replaced at any moment — an `npm install` in the campaign folder, an
`npx` cache refresh, a `git pull` in a toolkit checkout.

That is the drift this document is about: an agent following instructions from
one release while calling a CLI from another. Nothing in the per-skill versions
catches it, because the agent has no reason to look at them and no way to notice
that the copy on disk moved.

## The identity

`skills.json` carries one top-level field:

```json
"bundle_revision": "1.40.0+skills.1"
```

The spelling is `<package version>+skills.<n>`:

- the **prefix** is this package's `version`, so a revision names the release its
  skills ship with (`check-skill-versions.mjs` fails if the two disagree);
- `<n>` is a plain counter, not a semver component. It says "this is the *n*th
  skill-text revision published against that package version" and it **resets
  with the prefix**. `1.41.0+skills.1` is therefore ahead of `1.40.0+skills.7`.

It is one identity for the bundle as a whole, on purpose. Per-skill versions
still exist and still gate per-skill changes, but an agent that loaded one skill
cannot reconcile five versions; it can quote back one string.

## The header line

The first body line of every bundled `SKILL.md`, immediately after the
frontmatter, is exactly:

```
Bundle revision: 1.40.0+skills.1
```

followed by one sentence telling the agent to run the check below at the start of
each task. This line is the value an agent has in hand: it comes from the text
the agent is actually reading, not from a file it would have to go and open.

## The check

```bash
campaigns-os tooling status --skills-revision 1.40.0+skills.1
```

The value is compared against the bundle revision of the **CLI the command runs
from** — the `skills.json` inside the installed package, not the working
directory, which in a campaign repo has no `skills.json` at all.

`--json` reports a bare status string alongside the detail:

```json
"revision_check": "match",
"skills_revision": {
  "status": "match",
  "requested": "1.40.0+skills.1",
  "spelling": "bundle",
  "on_disk": "1.40.0+skills.1",
  "on_disk_skill": null,
  "message": "match (1.40.0+skills.1)"
}
```

The text view prints one named line, as a header above the rest of the status:

```
Skills revision: match (1.40.0+skills.1)
Skills revision: mismatch: loaded 1.39.0+skills.1, on disk 1.40.0+skills.1 — start a fresh session
Skills revision: unchecked (on disk 1.40.0+skills.1)
```

`unchecked` is the state when the flag is absent. It is not an error — an
operator running preflight by hand has no revision to offer — and the on-disk
revision is reported anyway, so the run still says what is installed.

## Why the reported revision is named "on disk"

Because the two sides of the comparison are not symmetric, and naming them
symmetrically would hide the remedy.

The requested value is text **already in context**. Re-running the command
cannot change it; nothing can, short of a new session. The reported value is
what is **installed right now**, and it is the side that moved. So the field is
`on_disk`, the mismatch line says "on disk", and the remedy is not "update
something" but "start a fresh session" — a fresh session is what re-reads the
skill text.

This also explains why a mismatch is not merely a warning. A session that keeps
going is following instructions for a CLI that is no longer there.

## Fallback spelling

An agent that carries only the frontmatter of the single skill it loaded can
pass that instead:

```bash
campaigns-os tooling status --skills-revision next-campaigns-qa@1.3.3
```

The version is checked against that skill's entry in the manifest, and the
bundle revision is still reported beside it. A skill id this bundle does not
ship reports `mismatch`, not a refusal: an agent quoting a skill that is not here
is reading text from some other bundle, which is the condition the flag exists to
catch.

## Exit codes

| Outcome | Exit |
| --- | --- |
| `match` (and the rest of the status is clean) | `0` |
| `unchecked` (and the rest of the status is clean) | `0` |
| `mismatch` | `2`, after the full status has printed |
| `--skills-revision` given with no value | refused, non-zero, nothing inspected |

A mismatch prints the whole status first and sets the exit code afterwards: the
revision line is a header on the report, never a replacement for it. It also
adds an explicit action naming the fresh session, so a reader of `actions[]`
sees the remedy without parsing the header.

`tooling status` exits `2` for other reasons too (skills needing a refresh, a
checkout behind its upstream). Branch on `revision_check`, not on the exit code,
when you need to know which one happened.

## The gate

`scripts/check-skill-versions.mjs` enforces both halves:

- **without `--base`** (this runs inside `npm run check`): `bundle_revision`
  exists, is spelled correctly, and its prefix is `package.json`'s `version`.
- **with `--base <ref>`**: if any file under `skills/` changed since the base, or
  if `skills.json`'s `skills[]` entries changed, `bundle_revision` must have
  **advanced** — a newer prefix, or the same prefix with a higher counter. Equal
  fails, and so does backwards.

The changed set is the union of what changed since the base, what is in the
working tree, and what is untracked, the same three-way union the release-ledger
gate measures. A committed-only diff answers the wrong question for a bump gate:
an unstaged `SKILL.md` edit is exactly the state a local run is asked about.

The failure this produces is the point of the whole mechanism: skill text moved,
the identity an agent quotes back did not, and a stale agent would have been told
it was current.

## Not yet built

This document is an entry in
[`contracts/supported-surface.json`](../contracts/supported-surface.json)
`named[]` as of 1.40.0: it ships in the npm pack, the CLI help points at it,
and a consumer may depend on it at this path.

`tooling status` resolves no project-level skills-revision pin today, so it
cannot distinguish "this project pins no revision" (`unpinned`) from "the project
pin and the loaded revision disagree" (`conflicting_pin`). Both would need a pin
to read first. Until there is one, the command reports only what it can observe:
the value it was given and the bundle on disk.
