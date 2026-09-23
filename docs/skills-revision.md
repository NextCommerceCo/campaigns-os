# Skills bundle revision

The skills Campaigns OS bundles (nine as of 1.40.0) are installed into shared agent skill
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
"bundle_revision": "1.41.0+skills.1"
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
Bundle revision: 1.41.0+skills.1
```

followed by one sentence telling the agent to run the check below at the start of
each task. This line is the value an agent has in hand: it comes from the text
the agent is actually reading, not from a file it would have to go and open.

## The check

```bash
campaigns-os tooling status --skills-revision 1.41.0+skills.1
```

The value is compared against the bundle revision of the **CLI the command runs
from** — the `skills.json` inside the installed package, not the working
directory, which in a campaign repo has no `skills.json` at all.

`--json` reports a bare status string alongside the detail:

```json
"revision_check": "match",
"skills_revision": {
  "status": "match",
  "requested": "1.41.0+skills.1",
  "spelling": "bundle",
  "on_disk": "1.41.0+skills.1",
  "on_disk_skill": null,
  "message": "match (1.41.0+skills.1)"
}
```

The text view prints one named line, as a header above the rest of the status:

```
Skills revision: match (1.41.0+skills.1)
Skills revision: mismatch: loaded 1.39.0+skills.1, on disk 1.41.0+skills.1 — start a fresh session
Skills revision: unchecked (on disk 1.41.0+skills.1)
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
campaigns-os tooling status --skills-revision next-campaigns-qa@1.3.4
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

## The pin check

The skills revision says which **text** an agent is reading. The pin says which
**executable** the project runs. ADR 0002 allows one executable per project,
and `tooling status` reports it on every run, alongside the revision check.

### Sources and precedence

1. **The project pin.** An entry for `@nextcommerce/campaigns-os` in
   `devDependencies` or `dependencies`. Only an exact version is a pin:
   `1.41.0`, and the forms npm reads as the same exact version, `=1.41.0` and
   `v1.41.0` (reported as `project_version: "1.41.0"`). A range or a tag
   (`^1.40.0`, `latest`, a git spec, an empty string) names no single
   executable, so it is reported under `range` and counts as no project pin.
   `peerDependencies` and `optionalDependencies` are never a pin: ADR 0002 puts
   the pin in `devDependencies`, and `dependencies` is read because it installs
   the same executable.

   The resolver starts at the nearest `package.json` above the working
   directory (or above the packet's target repository when `--packet` is
   given) and walks up toward the filesystem root. In each manifest it reads
   `devDependencies`, then `dependencies`; the **first exact spec wins** and
   ends the walk. A range or empty spec does not end it: it is remembered, and
   reported as `range` only if no exact spec turns up anywhere on the walk. So
   a range in `devDependencies` never hides an exact pin in `dependencies`,
   and a workspace package without an exact spec resolves its workspace root's
   pin. The walk enters an ancestor manifest only if that manifest names the
   package or declares `workspaces`, and it ends after a workspace root, so an
   unrelated `package.json` further up, even one with an exact pin, is never
   read.

   A `package.json` under a `node_modules` directory is an installed package,
   never the project: run from inside `node_modules` (for example
   `<project>/node_modules/@nextcommerce/campaigns-os`), the walk skips it and
   resolves the enclosing project, packet home included, as if the working
   directory were that project. A leading UTF-8 BOM is accepted, as npm
   accepts it. A nearest manifest that cannot be read or is not a JSON object,
   and an ancestor that cannot be read, end the walk with a warning naming the
   file.

   `pin.project_manifest` is the manifest the pin (or range) came from, or the
   nearest manifest when there is neither; `pin.project_key` is
   `"devDependencies"`, `"dependencies"` or `null`. The `Pin:` line
   (`pin.message`) names the key and manifest of every project version or
   range it quotes (`devDependencies in <project>/package.json`), the nearest
   manifest when it reports no project pin, and the packet file of every packet
   version it quotes (`campaigns_os_version in
   <project>/campaign-runtime.build.json`). Every action names the same
   manifest and key: a pin read from `dependencies` says `set
   dependencies[...]`.
2. **The packet's recorded kernel version.** The Build Packet's optional
   top-level `campaigns_os_version`, which `prepare-build` stamps with the
   version that prepared it. The field is a bare `x.y.z` version (a
   prerelease or build suffix allowed): the packet schema admits no `=` or `v`
   prefix, so a packet value such as `=1.41.0` is ignored with a warning. The
   packet read is the project's `campaign-runtime.build.json` beside that
   `package.json` (its contracted home), or the file `--packet <path>` names.
   A missing packet, or one written before the field existed, is no packet
   source.

The packet is read from beside the nearest `package.json`, whichever manifest
the project pin came from. The **running** version is the `package.json` of the
CLI the command runs from.
When both sources are present and equal, `source` is `"project"`.

### The four statuses

| `pin.status` | When | Exit |
| --- | --- | --- |
| `match` | the pin (project first, packet second) is the running version | `0` (if the rest of the status is clean) |
| `stale_pin` | the pin is not the running version | `2`, with an action naming the file to change |
| `conflicting_pin` | the project pin and the packet version are both present and differ | `2`, with an action naming both files |
| `unpinned` | neither source is present (a range alone is not a pin) | `0` (if the rest of the status is clean), always reported |

`conflicting_pin` wins over `stale_pin`: two sources that disagree are reported
as a disagreement even when one of them is the running version.

### `--force`

`--force` overrides `stale_pin` and `conflicting_pin`: the command then exits as
the rest of the status dictates, the pin line and `pin.message` say
`(overridden by --force)`, `pin.forced` is `true`, and a warning replaces the
action. `forced` is `true` only when the flag overrode something; on `match` or
`unpinned` it stays `false`. The override is recorded on the command-lifecycle
journal entry: `--force` appears in its `argv_shape` whenever a journal is
selected (an active run session, `--lifecycle-journal`, or
`CAMPAIGNS_OS_LIFECYCLE_LOG`). It is a bare flag. `--force true` is refused before
anything is inspected, and a refused invocation writes no journal entry.

```bash
campaigns-os tooling status --json
campaigns-os tooling status --packet ./campaign-runtime.build.json --force
```

### Output

Taken from real runs of a 1.41.0 install inside a fixture project. `--json`
carries the full object:

```json
"pin": {
  "source": "project",
  "version": "1.41.0",
  "running": "1.41.0",
  "status": "conflicting_pin",
  "range": null,
  "packet_version": "1.40.0",
  "project_version": "1.41.0",
  "project_manifest": "<project>/package.json",
  "project_key": "devDependencies",
  "forced": false,
  "message": "conflicting_pin — project pins 1.41.0 (devDependencies in <project>/package.json), packet records 1.40.0 (campaigns_os_version in <project>/campaign-runtime.build.json)"
}
```

```json
"pin": {
  "source": null,
  "version": null,
  "running": "1.41.0",
  "status": "unpinned",
  "range": "^1.40.0",
  "packet_version": null,
  "project_version": null,
  "project_manifest": "<project>/package.json",
  "project_key": "devDependencies",
  "forced": false,
  "message": "unpinned (project range ^1.40.0 (devDependencies in <project>/package.json) is not an exact version; no packet version)"
}
```

The text view prints one named line under the skills revision line, naming
where each version it quotes was read:

```
Pin: match (1.41.0 — devDependencies in <project>/package.json)
Pin: match (1.41.0 — dependencies in <project>/package.json)
Pin: match (1.41.0 — campaigns_os_version in <project>/campaign-runtime.build.json)
Pin: stale_pin — project pins 1.40.0 (devDependencies in <project>/package.json), running 1.41.0
Pin: stale_pin — packet records 1.40.0 (campaigns_os_version in <project>/campaign-runtime.build.json), running 1.41.0
Pin: stale_pin — project pins 1.40.0 (devDependencies in <project>/package.json), running 1.41.0 (overridden by --force)
Pin: conflicting_pin — project pins 1.41.0 (devDependencies in <project>/package.json), packet records 1.40.0 (campaigns_os_version in <project>/campaign-runtime.build.json)
Pin: unpinned (no project pin in <project>/package.json; no packet version)
Pin: unpinned (no project pin in <project>/package.json; no campaigns_os_version in <project>/campaign-runtime.build.json)
Pin: unpinned (project range ^1.40.0 (devDependencies in <project>/package.json) is not an exact version; no packet version)
```

and, for a blocking status, an action such as:

```
- Align the project pin: set devDependencies["@nextcommerce/campaigns-os"] in <project>/package.json to 1.40.0, or re-run prepare-build with 1.41.0 so <project>/campaign-runtime.build.json records it. Pass --force to proceed anyway (recorded).
```

Branch on `pin.status`, not on the exit code: `tooling status` exits `2` for the
other reasons above as well.

This document is an entry in
[`contracts/supported-surface.json`](../contracts/supported-surface.json)
`named[]` as of 1.40.0: it ships in the npm pack, the CLI help points at it,
and a consumer may depend on it at this path.
