# Run-artifact readback — `campaigns-os readback`

`campaigns-os readback <target-repo-root>` projects a read-only view of the
artifacts a Campaigns OS run has already emitted into a target: the Build
Packet, the doctor output sidecar, the build context, the assembly report, a QA
verdict, and a findings export when present. It reads each of those files at
most once, plus two fixed Git metadata files (the nearest `.git` entry at the
target or an ancestor, and that Git directory's `logs/HEAD` reflog) for the
freshness comparison.

The safety contract is the point of the command. The readback **writes nothing**
under the target — not even a lifecycle journal entry, which every other command
records when `--lifecycle-journal` or `CAMPAIGNS_OS_LIFECYCLE_LOG` is set — and
it **starts no process** and **touches no network**. A command declared
read-only that leaves a journal entry behind is not read-only, so `readback` is
exempted from lifecycle capture the way doctor inspection is.

For the same reason the readback resolves **no run session** and sweeps no stale
one. Its `--packet` names the Build Packet to *project*, not a Build Packet to
act on, so an active run session — here, at the target, or bound to some other
packet entirely — never changes what this command reads or what it exits with.
That also keeps every read bounded: the only reader of a `--packet` file is the
readback's own 32 MiB-bounded one, which refuses an oversized packet as an
`unreadable` artifact row rather than loading it.

Campaigns OS remains the lifecycle and verdict authority. The readback never
reinterprets a verdict and never proposes remediation. Where it adds anything
beyond the artifacts' own words — the contract-static warning labels, the
fail-to-skip cascade provenance, the staleness assessment — both output modes
mark that content as the readback's own projection layer.

```
campaigns-os readback <target-repo-root> [--json]
                      [--packet <path>] [--doctor <path>] [--context <path>]
                      [--report <path>] [--qa-verdict <path>] [--findings <path>]
campaigns-os readback --example [--json]
```

The default output is the rendered human view. `--json` emits the same
projection as one `campaigns-os-readback/v2` object on stdout so a caller can
gate on it; `schemas/campaigns-os-readback.v2.schema.json` is that object's
shape, and this document is its prose twin. The two modes share one computation
path: the JSON serializes what the text view already computes and adds no
interpretation the text view does not also carry.

## Exit codes

- `0` — any projection the readback could form. An artifact that is missing,
  unreadable, or of an unrecognized shape is a **state the readback reports**,
  not an error: a run whose doctor output is truncated still gets a projection
  saying so.
- `2` — a caller request that cannot form a projection at all: a target root
  that is not an existing directory, a Build Packet set whose freshness does not
  identify one packet to project (see `packet_selection`), `--example` combined
  with a target or a path override, or a missing/duplicated target argument. The
  reason goes to stderr in one line and no projection is written to stdout.

## `--example`

`campaigns-os readback --example` projects the synthetic sample bundled with the
package at `contracts/fixtures/sidecar-bundle/production-shaped/`, in text or
with `--json`. It takes no target and no path override; combining it with either
exits `2`. Nothing is written and nothing is copied.

The sample is a packaged fixture directory, not a Git checkout, so there is no
HEAD movement to compare its artifacts against. `--example` says so explicitly
rather than searching upward for whatever repository the package happens to be
installed inside: `staleness.computable` is `false`, `head_time` is `null`, and
`head_detail` reads *"the bundled sample is a packaged fixture directory, not a
Git checkout: freshness is not computable for it by design"*. Because `clean`
requires a computable comparison, the sample is `clean: false` — correctly, and
for exactly the reason the second corollary under [`clean`](#clean) describes.
Artifact rows report package-relative paths for the same reason: a sample whose
output differs on every machine is not a sample anyone can check.

Its output, verbatim:

```
CAMPAIGNS OS RUN-ARTIFACT READBACK
A read-only projection of this run's emitted artifacts. Campaigns OS
remains the lifecycle and verdict authority; content marked as the
readback's own projection layer is interpretation added by this view,
not by Campaigns OS. This readback proposes no remediation.

STALENESS  [the readback's own projection layer: EACH loaded artifact's generated_at versus the checkout's HEAD reflog]
  not computable: the bundled sample is a packaged fixture directory, not a Git checkout: freshness is not computable for it by design.
  Treat artifact age as unknown; check the artifacts' generated_at values
  against repository history before reading this view as current.

ARTIFACTS
  build packet     contracts/fixtures/sidecar-bundle/production-shaped/campaign-runtime.build.json
                   loaded — generated_at 2026-08-24T00:00:00.000Z
  doctor output    contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/doctor-output.json
                   loaded — generated_at 2026-08-24T00:01:00.000Z
  build context    contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/build-context.json
                   loaded — generated_at 2026-08-24T00:00:00.000Z
  assembly report  contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/assembly-report.json
                   loaded — generated_at 2026-08-24T00:00:00.000Z
  QA verdict       contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/qa-verdict.json
                   loaded — generated_at 2026-08-24T00:04:00.000Z
  findings export  contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/findings-export.json
                   absent

RUN IDENTITY
  map_id = runtime-packet-demo-k9x2  [build packet]
  public_route_slug = runtime-packet-demo  [build packet]
  template_family = olympus  [build packet]
  qa run_id = MSRBUNDLEFIXTURE000000000000  [QA verdict]

STAGES  [assembly report; report status: prepared]
  prepare_build  completed
  doctor         pending
  setup          pending
  assembly       pending
  polish         pending
  deploy         pending
  qa             pending

BUILD CONTEXT  [build context; source adapter: html_funnel, status: prepared]

DOCTOR  [doctor output; status: ready_with_warnings]
  warnings (1) — the contract-static / repo-observed labels are the readback's own projection layer, not doctor's
  repo-observed (1) — repo-observed: reflects this repository, spec, or build as doctor saw it
    deploy.preview_url — Preview URL is not recorded yet.
  doctor's recorded next stage: deploy

QA VERDICT  [QA verdict; disposition: ready — Campaigns OS is the verdict authority]
  assertions: 0 fail, 1 pass, 0 skipped
  pass  http:checkout  (family funnel-flow)
```

## The JSON contract

```json
{
  "schema_version": "campaigns-os-readback/v2",
  "artifacts": [{ "key": "packet", "path": "...", "state": "loaded", "detail": "" }],
  "packet_selection": {
    "mode": "discovered",
    "signal": "generated_at",
    "selected": "campaign-runtime-second.build.json",
    "candidates_considered": ["campaign-runtime.build.json", "campaign-runtime-second.build.json"],
    "rejected": [{ "path": "campaign-runtime-old.build.json", "reason": "invalid JSON: ..." }]
  },
  "staleness": {
    "computable": true,
    "stale": true,
    "stale_keys": ["report"],
    "unparseable_keys": [],
    "artifacts": {
      "doctor": { "generated_at": "2026-09-01T12:00:00Z", "stale": false },
      "report": { "generated_at": "2026-06-23T00:00:00Z", "stale": true }
    },
    "newest_key": "doctor",
    "head_time": "2026-08-06T07:06:40Z",
    "head_detail": "",
    "artifact_times": { "doctor": "2026-09-01T12:00:00Z", "report": "2026-06-23T00:00:00Z" }
  },
  "doctor": {
    "present": true,
    "status": "ready_with_warnings",
    "error_count": 0,
    "warning_count": 2,
    "warning_groups": { "contract-static": [], "repo-observed": [] }
  },
  "skip_cascades": [{ "blocked_by": "polish.evidence_incomplete", "families": ["meta-tags"] }],
  "divergences": [{ "stage": "polish", "assertion_ids": ["polish.evidence_incomplete"] }],
  "clean": false
}
```

### `schema_version`

Always the literal `campaigns-os-readback/v2`. A consumer should refuse a
payload whose `schema_version` it does not recognize rather than reading the
fields it happens to know.

### `artifacts`

One record per artifact the readback projected, in the fixed render order
(`packet`, `doctor`, `context`, `report`, `qa_verdict`, `findings`), restricted
to the keys the caller asked for. Each record carries:

- `key` — the artifact key;
- `path` — the path the readback read, as resolved from the target root, a
  `--<artifact>` override, or — for `packet` — Build Packet discovery
  (`packet_selection` records which);
- `state` — one of `loaded`, `absent`, `unreadable`, `unrecognized`;
- `detail` — the readback's explanation for a non-`loaded` state; the empty
  string for `loaded` and `absent`. One exception: a `loaded` artifact named in
  [`staleness.unparseable_keys`](#staleness) carries the *shape* of the
  `generated_at` value that did not parse (`generated_at is a 12-character
  string that is not an ISO-8601 instant, so this artifact's age could not be
  compared against the checkout`), so a consumer reading `artifacts` alone can
  see that this artifact's age was never established. The value itself is not
  reproduced: a hand-edited or foreign artifact can carry an arbitrarily long
  string there.

The artifact's own parsed contents are deliberately not included. A consumer
that wants an artifact's payload should read that artifact directly; this
projection would otherwise become an unversioned mirror of every upstream
Campaigns OS schema.

Reads are bounded: 32 MiB for an artifact, 64 KiB for each Git metadata file. A
file past its bound is refused as `unreadable`, never truncated — a half-read
artifact would project as malformed JSON and read as the run's fault rather than
the readback's.

A leading UTF-8 byte order mark is **not** stripped, so a BOM-prefixed artifact
is `unreadable` with an invalid-JSON detail. That is what the Python readback
this command ports reports for the same bytes — it decodes as plain UTF-8, which
keeps the mark, and `json.loads` refuses it — and it matters beyond one artifact
row: a Build Packet the readback cannot parse is not a discovery candidate, so
the mark cannot decide which packet a run projects.

### `packet_selection`

How the projected Build Packet was chosen. A target repository can hold more
than one root-level packet — a suffixed packet beside the default-named one is
how a second campaign run leaves its record — so without `--packet` the readback
discovers the candidates (`campaign-runtime.build.json` plus
`campaign-runtime-*.build.json` at the root) and selects the uniquely freshest.

- `mode` — `explicit` when the caller passed `--packet`; `default` when the
  chosen packet is the default-named `campaign-runtime.build.json` (including a
  target with no packet at all, where the default path is still the path
  reported `absent`); `discovered` when freshness selected a suffixed packet.
- `signal` — what decided it: `explicit`, `sole_candidate`, `generated_at`, or
  `none` (no valid candidate to choose between).
- `selected` — the file name discovery chose, or `null` when no discovery chose
  one. The full path is the `packet` row's `path` in `artifacts`.
- `candidates_considered` — the valid candidates discovery compared, default
  first then name order. Empty for `explicit` mode, where no discovery runs.
- `rejected` — candidates discovery skipped, as `{"path", "reason"}` records.
  Root-level files matching the packet naming land here when they did not parse
  as JSON, were not an object, or did not declare a recognized packet
  `schema_version`. When no valid root candidate exists, a packet sitting only
  at `.campaign-runtime/campaign-runtime.build.json` is also recorded here: that
  sidecar location is not a discovery candidate (the contracted home is the
  repository root, and auto-selecting the sidecar would paper over that
  mismatch), and the reason tells the caller to pass `--packet` to project it.

**Freshness is the packet's own `generated_at`, never the file's modification
time.** An mtime is rewritten by a clone, a checkout, or a copy without any run
having recorded anything, while `generated_at` is what the emitting run wrote
down; using it keeps selection a pure function of file contents, so two callers
reading the same packets always select the same one. When `generated_at` cannot
single out one packet — two candidates share the newest value, or any candidate
carries no parseable value — the readback does not choose. It names the
candidates on stderr, says `--packet` is required, and exits `2`. No JSON object
is emitted in that case.

Values are compared at **microsecond precision** — the precision Python's
`datetime.fromisoformat` keeps, and the precision the Python readback this
command ports compared at; a seventh or later fractional digit is truncated, not
rounded. Two packets whose `generated_at` differ only below the millisecond are
therefore two instants and not a tie, even though both render identically at the
second precision every projected view displays.

**"Parseable" means exactly what `datetime.fromisoformat` accepts**, here and in
the staleness comparison, because that is the function the Python readback this
command ports used — specifically what CPython's C accelerator accepts, which is
the implementation that runs. A fraction may be any number of digits — the ones
past the sixth are dropped, not rounded — `,` separates it as readily as `.`, and
it may follow the hours or the minutes as readily as the seconds (`T10.5`,
`T10:00.5`). The character between the date and the time is never checked, only
counted, and it is one Unicode character, so an astral one separates a date from
a time like any other; a separator with no time behind it (`2026-09-22T`) is
malformed, while a bare date with no separator at all (`2026-09-22`) is that
day's midnight.

A UTC offset may be `Z`, `±HH`, `±HHMM`, `±HH:MM`, `±HHMMSS` or `±HH:MM:SS`, with
a fraction of its own, and its magnitude must stay strictly under 24 hours; an
offset such as `+25:00` is not a large shift but an unreadable value, which makes
the packet carrying it an unknown candidate and the run a refusal. An offset
whose **whole-second** part is zero is UTC and its fraction is discarded, so
`+00:00:00.5` names the same instant `Z` does; an offset with a non-zero
whole-second part keeps its fraction (`+00:00:01.5` shifts by a second and a
half). A value with no offset at all is read as UTC.

An unparseable `generated_at` is never guessed at. In this selection it makes the
packet an unknown candidate, which is a refusal; in the staleness comparison it
keeps the artifact out of the map, neither fresh nor stale.

`packet_selection` is `null` only if a programmatic caller builds a payload
without a selection record; the CLI always supplies one.

### `staleness`

Whether the artifacts describe the checkout as it is now, assessed **per
artifact** against the last recorded HEAD movement. The reflog's last entry
advances on commit, checkout, pull, and reset alike; any of those can invalidate
a previously emitted artifact, so "HEAD last moved" is deliberately the coarsest
local signal, not "last commit authored". Instants are ISO-8601 UTC at second
precision with a `Z` suffix, rendered by the same formatter the text view uses;
the comparison behind them runs at microsecond precision, as packet selection's
does. The reflog records whole seconds, so that added precision cannot change
this verdict either way — it matters only where two artifacts are ordered
against each other.

- `computable` — true when at least one loaded artifact carried a parseable
  `generated_at` **and** the checkout's HEAD reflog was readable;
- `stale` — true when **any** loaded artifact's `generated_at` predates the last
  recorded HEAD movement. Always `false` when `computable` is false; absence of
  the signal is not evidence of freshness;
- `stale_keys` — the stale artifact keys, in the fixed render order;
- `unparseable_keys` — the loaded artifacts that **recorded** a `generated_at`
  this readback could not parse, in the fixed render order. Their age was never
  established, so they are neither fresh nor stale, they are absent from
  `artifacts` and `artifact_times`, and `clean` is `false` while this list is
  non-empty (condition 3 under [`clean`](#clean)). Each one's artifact row
  carries the shape of the refused value in its `detail`. This list does not
  change `computable` or `stale`, which keep their meanings: a set whose only
  comparable artifact is fresh still reports `stale: false`, and the unknown age
  is reported here rather than by widening a field that answers a different
  question;
- `artifacts` — every loaded artifact that carried a parseable `generated_at`,
  keyed by artifact key, each as `{"generated_at", "stale"}`. An artifact with
  no parseable `generated_at` is neither fresh nor stale: it is absent from this
  map, and if it is the only artifact the assessment is not computable. Where it
  recorded a `generated_at` that did not parse, `unparseable_keys` names it;
- `newest_key` — the artifact key holding the newest `generated_at`, or `null`
  when not computable. **Information only**: it no longer decides the aggregate;
- `head_time` — the last recorded HEAD movement, or `null` when the reflog gave
  no usable time;
- `head_detail` — why `head_time` is `null`; the empty string when it is not;
- `artifact_times` — every loaded artifact's parseable `generated_at`, keyed by
  artifact key. Carried unchanged for consumers that already read it.

Two kinds of missing age are deliberately kept apart, because they say different
things about the run:

- an artifact that **recorded** a `generated_at` this readback could not parse
  claimed an age the readback failed to establish. It is named in
  `unparseable_keys`, its artifact row says so, the text view lists it under
  *UNKNOWN ARTIFACT AGE*, and `clean` is `false`. The parser is a port of
  CPython's `datetime.fromisoformat`, so this is what a hand-edited, foreign or
  corrupt artifact reaches — exactly the case the readback exists to inspect;
- an artifact with **no `generated_at` key at all** recorded no age, so there is
  no claim about its currency to check. It is simply absent from the comparison,
  it is not named in `unparseable_keys`, and it does not by itself make the
  projection unclean. (If no other artifact carries a parseable `generated_at`,
  the comparison is not computable and `clean` is `false` for that reason
  instead.)

`staleness` is `null` only if a programmatic caller builds a payload without an
assessment; the CLI always supplies one.

### `doctor`

- `present` — whether a doctor output loaded. When false, `status` is `null` and
  both counts are `0`: those zeros record an absence, not an observation.
- `status` — doctor's own status string, unreinterpreted.
- `error_count` — the length of doctor's `errors` list (`0` when the field is
  missing or not a list).
- `warning_count` — the total number of object-shaped warnings grouped below.
- `warning_groups` — the readback's own two-way grouping of doctor warnings,
  carrying each warning as doctor wrote it:
  - `contract-static` — codes under the `frontmatter.*` prefixes. These restate
    the template family's shared frontmatter contract and repeat verbatim on
    every doctor pass while that contract is in force. Their persistence does
    not mean a flagged value is still unfixed, and their disappearance is not
    how a fix is confirmed. **A gate must not treat these as repository state.**
  - `repo-observed` — every other code: not in the contract-static table, so its
    message reflects this repository, spec, or build as doctor saw it.

  The labels are the readback's projection layer, not doctor's own vocabulary.

### `skip_cascades`

Skipped QA assertions grouped by the failure that blocked them, derived from
each skipped assertion's `evidence.blocked_by`. One record per distinct blocker,
in first-seen order:

- `blocked_by` — the recorded blocking assertion, or the literal
  `(no blocked_by recorded)` when the verdict named none;
- `families` — the skipped assertions' families, falling back to the assertion
  id and then to `(unnamed)`.

Empty when no QA verdict loaded or none of its assertions were skipped. This
grouping is the readback's own projection layer.

### `divergences`

Where two artifacts record different states for the same stage: the assembly
report calls a stage `completed` while the QA verdict fails an assertion whose
id is namespaced to that stage. One record per stage, in the order the failures
were seen:

- `stage` — the stage name;
- `assertion_ids` — the failing QA assertion ids attributed to it.

The readback reports the disagreement and does not adjudicate it; both records
stand as written. Empty when no verdict loaded, no assertion failed, or no
failure lines up with a completed stage. This too is the readback's own layer.

## `clean`

`clean` is true if and only if **all five** of the following hold:

1. **Every artifact the readback found is loaded and recognized.** Formally: no
   artifact is in state `unreadable` or `unrecognized`. An `absent` artifact
   does not by itself make the projection unclean — a run that emitted no
   findings export or no QA verdict has not thereby failed, and the readback
   does not decide which artifacts a run owes. An artifact that exists but
   cannot be read, or whose schema is not recognized, always makes it unclean,
   because the readback cannot see what that artifact says.
2. **Staleness is computable and no loaded artifact is stale.** Both halves are
   required. An uncomputable comparison is not clean: the readback cannot show
   that the artifacts describe the current checkout, and an unknown age must
   never read as a fresh one. Since `stale` is now the any-artifact aggregate, a
   target with one stale artifact and five fresh ones is not clean.
3. **No loaded artifact recorded a `generated_at` the readback could not
   parse.** Formally: `staleness.unparseable_keys` is empty. Such an artifact
   leaves the comparison — it is neither fresh nor stale — so without this
   condition a fresh sibling carried the aggregate and an artifact whose
   currency was never established shipped inside a `clean: true` payload. That
   is the same "an unknown age must never read as a fresh one" rule as condition
   2, applied per artifact rather than to the comparison as a whole. An artifact
   that recorded **no** `generated_at` at all is not covered by this condition:
   it made no claim about its age, so there is nothing here that the readback
   failed to check.
4. **`divergences` is empty.**
5. **`doctor.error_count` is zero.**

Doctor warnings — of either group — do not affect `clean`. Neither does a
blocked QA verdict, a blocked assembly report, or a non-empty `skip_cascades`.

### What `clean` does and does not mean

`clean` is a statement about the readback's own view, not a verdict on the
campaign. It means: the readback read every artifact that was there, understood
all of them, can show — for every artifact that recorded an age — that none of
them is older than the checkout, found no contradiction between them, and saw no
doctor error. Campaigns OS remains the
lifecycle and verdict authority; the readback never reinterprets a verdict.

The practical consequence for a caller: `clean: true` says the artifacts are
trustworthy enough to read, not that the run succeeded. A run whose QA verdict
is `blocked` can be `clean: true`, and correctly so — the readback saw exactly
what Campaigns OS recorded, including the block. A gate that wants "the campaign
passed" must read the QA verdict itself; `clean` is the precondition that makes
reading it meaningful.

Two corollaries worth stating because they surprise people:

- A target with no artifacts at all is never `clean: true`. Every artifact is
  `absent`, so condition 1 passes, but no artifact carries a `generated_at`,
  staleness is not computable, and condition 2 fails.
- A target whose artifacts are fine but which is not a Git checkout is never
  `clean: true`, for the same reason: staleness has no HEAD movement to compare
  against. The bundled `--example` sample is exactly this case.
- A target carrying one artifact whose recorded `generated_at` the readback
  cannot parse is never `clean: true`, even when every artifact it *can* read is
  newer than the checkout and `stale` is `false`: condition 3 fails, and
  `unparseable_keys` names the artifact. An artifact that recorded no
  `generated_at` at all does not trip that condition — it is the absence of a
  claim, not an unverified one.

## What changed from v1 (and why the version moved)

The readback began life outside this repository, emitting
`campaigns-agent-readback/v1`. This command is that module's port into the
kernel, and it carries one behaviour fix — assessed per artifact — together with
the `clean` rule that keeps an artifact of unknown age from riding along on a
fresh sibling.

**v1 assessed staleness from the newest artifact only.** It found the loaded
artifact with the latest `generated_at` and compared that one instant against
HEAD. The consequence: re-running any single stage refreshed one artifact, and
every older sibling — an assembly report from three HEAD movements ago, a QA
verdict from before the last merge — was reported as part of a fresh set.
`stale: false` and `clean: true` were both reachable for a target whose assembly
report predated the checkout it claimed to describe, which is the exact
condition the field exists to surface.

**v2 assesses every loaded artifact.** Each artifact with a parseable
`generated_at` gets its own `stale` verdict in `staleness.artifacts`,
`stale_keys` names the stale ones in render order, the aggregate `staleness.stale`
is true when any of them is stale, and the text view names each stale artifact
rather than only the newest one. `newest_key` is kept but demoted to
information; `artifact_times` is kept unchanged.

**v2 also refuses to call an unknown age a fresh one.** Assessing every artifact
left one way for the old answer to survive: an artifact whose recorded
`generated_at` does not parse leaves the comparison entirely, so with a fresh
sibling beside it the aggregate found nothing stale and the projection reported
`clean: true` — for a set containing an artifact whose currency was never
established. v2 adds `staleness.unparseable_keys`, which names those artifacts
in render order; their artifact rows carry the shape of the value that did not
parse, the text view lists them under *UNKNOWN ARTIFACT AGE*, and `clean` is
`false` whenever the list is non-empty. `computable` and `stale` are unchanged —
the unknown age is reported in its own field rather than folded into one that
answers a different question — and an artifact carrying no `generated_at` key at
all keeps its previous behaviour: out of the comparison, and not by itself
unclean.

That is a change of meaning in a published field — a `stale` a consumer already
gates on now answers a different question — and `docs/versioning.md` makes that
a breaking change to a machine-readable contract requiring a new schema version
rather than a silent edit. Hence `campaigns-os-readback/v2`. Everything else in
the payload keeps its v1 field names and meanings; `unparseable_keys` is a new
field, and `clean` — already v2's own flag — states the rule above.

Migration for a consumer already reading the v1 payload:

- Accept `campaigns-os-readback/v2` instead of `campaigns-agent-readback/v1`.
- Nothing else needs to change to keep working: `stale` is still a boolean in
  the same place, and it is now true strictly more often (it is true whenever v1
  said true, plus the cases v1 missed). A gate that refused stale artifacts
  refuses strictly more of them; a gate that relied on the v1 answer to pass was
  relying on the defect.
- To report *which* artifacts are stale rather than only that some are, read
  `stale_keys` or `artifacts`.
- A gate that reads `clean` needs no change either, and now refuses one more
  case: a set containing an artifact whose recorded age the readback could not
  parse. To report which artifact that is, read `unparseable_keys`.

## Related

- [`schemas/campaigns-os-readback.v2.schema.json`](../schemas/campaigns-os-readback.v2.schema.json) — the payload's shape.
- [`docs/supported-surface.md`](supported-surface.md) — what this command's surface commitment means.
- [`docs/versioning.md`](versioning.md) — why a changed field meaning takes a new schema version.
